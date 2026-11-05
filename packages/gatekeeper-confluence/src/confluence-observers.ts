// Observer verification for Confluence bindings.
//
// Confluence permissions are not purely hierarchical: access to a site does not imply access to
// every space, access to a space does not imply access to every page, and a child page can be more
// restricted than its parent. All three binding granularities therefore use strategy C. Reads
// report the binding's site, space, or content plus each narrower space and content item they
// reveal as subresources (see confluence-subresources.ts), which the Workshop checks through
// verifyObserverAccess().
//
// Before reads reported subresources, a binding verified its coarse baseline (site, space, or
// content) when an observer joined, and ConfluenceObserverTracker remembered the narrower spaces
// and content reads revealed. That tracker now guards only legacy history: the sets reads recorded
// before they reported subresources, or that a read still running that code records. Reads no
// longer feed it, so addObserver() verifies each observer against the baseline and that history
// alone, through the verifier's has*Access methods, which reuse no answers.

import type { GatekeeperUserVerifier } from "@gadgets/workshop-shared/gatekeeper";
import {
  ConfluenceApi,
  ConfluenceApiError,
  getAccessibleResources,
  type AccessibleResource,
} from "./confluence-api";

/**
 * Private RPC surface minted from a collaborator's connected Confluence account.
 *
 * The Workshop treats a verifier as opaque and only returns it to the same vendor that minted it,
 * so Confluence gatekeepers may call these non-standard methods. Every method runs with the
 * prospective observer's OAuth credentials, never the binding owner's credentials.
 */
export interface ConfluenceVerifierApi extends GatekeeperUserVerifier {
  /** Whether the observer's token currently lists the requested Confluence Cloud site. */
  hasSiteAccess(cloudId: string): Promise<boolean>;

  /** Whether the observer can retrieve a space from the requested site by numeric ID or key. */
  hasSpaceAccess(cloudId: string, spaceIdOrKey: string): Promise<boolean>;

  /** Whether the observer can retrieve a page or blog post from the requested site. */
  hasContentAccess(cloudId: string, contentId: string): Promise<boolean>;

  /**
   * Whether the observer can read each Confluence subresource (see confluence-subresources.ts), in
   * order, reusing recent answers (see UserAccount.checkSubresourceAccess). Throws for an ID it
   * can't check, or when access can't be determined (credentials that can't be obtained or
   * refreshed, a rate limit, an outage).
   */
  checkSubresourceAccess(subresources: string[]): Promise<boolean[]>;
}

// The legacy verifier methods receive only the three read operations needed to answer ACL
// questions. Keeping this structural type small also makes the access semantics easy to unit-test.
type AccessApi = Pick<ConfluenceApi, "getSpaceById" | "getSpaceByKey" | "getContentById">;

/**
 * Implements the legacy Confluence access checks behind addObserver() independently of the
 * WorkerEntrypoint wrapper.
 *
 * The injected token/API factories ensure every lookup uses the observer's account and make the
 * status handling testable without constructing a Cloudflare worker context. Checks are live: in
 * particular, site access does not trust the sites cached when the account was connected.
 */
export class ConfluenceAccessChecker {
  readonly #getToken: () => Promise<string>;
  readonly #getResources: (token: string) => Promise<AccessibleResource[]>;
  readonly #makeApi: (cloudId: string) => AccessApi;

  /**
   * Creates an access checker backed by one connected account.
   *
   * `makeApi` must construct an API client using the same account as `getToken`.
   * `getResources` is injectable only so the OAuth endpoint can be tested without network access.
   */
  constructor(
    getToken: () => Promise<string>,
    makeApi: (cloudId: string) => AccessApi,
    getResources: (token: string) => Promise<AccessibleResource[]> = getAccessibleResources,
  ) {
    this.#getToken = getToken;
    this.#makeApi = makeApi;
    this.#getResources = getResources;
  }

  /** Checks current site membership through Atlassian's live accessible-resources endpoint. */
  async hasSiteAccess(cloudId: string): Promise<boolean> {
    return this.#check(async () =>
      (await this.#getResources(await this.#getToken())).some(resource => resource.id === cloudId));
  }

  /**
   * Checks that a space can be retrieved from the specified site.
   *
   * Confluence resource URLs may identify a space by key or numeric ID, so the verifier preserves
   * the same interpretation used by the gatekeeper's public session API.
   */
  async hasSpaceAccess(cloudId: string, spaceIdOrKey: string): Promise<boolean> {
    return this.#check(async () => {
      const api = this.#makeApi(cloudId);
      if (/^\d+$/.test(spaceIdOrKey)) await api.getSpaceById(spaceIdOrKey);
      else await api.getSpaceByKey(spaceIdOrKey);
      return true;
    });
  }

  /** Checks that either the page or blog-post endpoint can retrieve a content ID. */
  async hasContentAccess(cloudId: string, contentId: string): Promise<boolean> {
    return this.#check(async () => {
      await this.#makeApi(cloudId).getContentById(contentId);
      return true;
    });
  }

  // Permission denial, missing resources, and invalid/revoked observer credentials all mean the
  // observer cannot be admitted. Operational failures are rethrown: silently converting a 5xx or
  // network outage to "no access" would hide a broken verifier and produce misleading denials.
  async #check(check: () => Promise<boolean>): Promise<boolean> {
    try {
      return await check();
    } catch (error) {
      if (error instanceof ConfluenceApiError &&
          (error.status === 401 || error.status === 403 || error.status === 404)) {
        return false;
      }
      throw error;
    }
  }
}

/**
 * A resource revealed by an observation whose ACL must be checked independently.
 *
 * The prefix is part of the legacy tracker's persisted key. It prevents a numeric space ID and
 * content ID from colliding and tells the tracker which verifier method to call after restoring the
 * key. Reads still name what they reveal this way, and report it as the matching subresource (see
 * observedSetSubresource).
 */
export type ConfluenceObservedSet = `space:${string}` | `content:${string}`;

// Minimal structural view of DurableObjectStorage.kv used by the tracker. The tracker owns keys
// under `observer:` and `observed:`; pending-action/cache keys in the same DO use other prefixes.
type ObserverKv = {
  put<T>(key: string, value: T): void;
  delete(key: string): void;
  list<T>(options: { prefix: string }): Iterable<[string, T]>;
};

type ObservedSetState = true | "pending" | "observed";

/**
 * The legacy strategy-C state of one Confluence gatekeeper DO, kept for history recorded before
 * reads reported subresources.
 *
 * Storage contains two kinds of records:
 *
 * - `observed:space:<id>` / `observed:content:<id>` state (`true`, `"pending"`, or `"observed"`)
 *   for every independently protected resource an old read observed or began to observe.
 * - `observer:<opaque-id>` persistent verifier stubs for collaborators that passed all checks.
 *
 * The binding's baseline check is intentionally outside this class because it differs by DO type.
 * Site, space, and content gatekeepers perform that check first, then call addObserver() here to
 * validate historical sets and retain the verifier, as a Worker version still running the old
 * reads expects to find it.
 */
export class ConfluenceObserverTracker {
  readonly #kv: ObserverKv;
  readonly #cloudId: string;

  /** Creates a tracker over one gatekeeper DO's durable storage and bound Confluence site. */
  constructor(kv: ObserverKv, cloudId: string) {
    this.#kv = kv;
    this.#cloudId = cloudId;
  }

  /**
   * Verifies a prospective observer against every resource observed in the past, then remembers
   * their verifier, which reads still running the legacy code check newly revealed sets against.
   *
   * The caller must already have checked the binding baseline. The verifier is written only after
   * all historical checks pass, so a rejected collaborator can never participate in forward
   * exclusion. Sets marked while this awaits are checked too.
   */
  async addObserver(id: string, verifier: Fetcher<ConfluenceVerifierApi>): Promise<void> {
    const checked = new Set<ConfluenceObservedSet>();
    while (true) {
      const sets = this.#listTrackedSets().filter(setId => !checked.has(setId));
      if (sets.length === 0) {
        this.#kv.put(this.#observerKey(id), verifier);
        return;
      }
      const access = await Promise.all(sets.map(setId => this.#hasSetAccess(verifier, setId)));
      if (access.some(hasAccess => !hasAccess)) {
        throw new Error(
          "This collaborator does not have access to Confluence data this workspace has read, so they " +
          "cannot be allowed to observe it.");
      }
      for (const setId of sets) checked.add(setId);
    }
  }

  /** Forgets an observer's verifier. Deleting an absent key makes this operation idempotent. */
  removeObserver(id: string): void {
    this.#kv.delete(this.#observerKey(id));
  }

  // Centralize the persisted key format so writes and deletes cannot drift apart.
  #observerKey(id: string): string { return `observer:${id}`; }

  /** Restores every typed observed-set ID from the DO's marker keys. */
  #listTrackedSets(): ConfluenceObservedSet[] {
    const prefix = "observed:";
    return [...this.#kv.list<ObservedSetState>({ prefix })]
      .map(([key]) => key.slice(prefix.length) as ConfluenceObservedSet);
  }

  /** Dispatches a typed set to the matching live ACL check on the observer's verifier. */
  #hasSetAccess(
    verifier: Fetcher<ConfluenceVerifierApi>, setId: ConfluenceObservedSet,
  ): Promise<boolean> {
    const separator = setId.indexOf(":");
    const kind = setId.slice(0, separator);
    const resourceId = setId.slice(separator + 1);
    return kind === "space"
      ? verifier.hasSpaceAccess(this.#cloudId, resourceId)
      : verifier.hasContentAccess(this.#cloudId, resourceId);
  }
}

/**
 * Converts Confluence content IDs to typed observed sets, omitting unresolved provisional IDs.
 *
 * A `~` ID names content staged by this Gadget but not yet created in Confluence. Its simulated
 * data came from the Gadget itself, and there is no external ACL or real ID for a verifier to test.
 */
export function contentSets(ids: string[]): ConfluenceObservedSet[] {
  return ids.filter(id => !id.startsWith("~"))
    .map((id): ConfluenceObservedSet => `content:${id}`);
}

/** Converts Confluence's stable numeric space IDs to collision-safe observed-set keys. */
export function spaceSets(ids: string[]): ConfluenceObservedSet[] {
  return ids.map((id): ConfluenceObservedSet => `space:${id}`);
}
