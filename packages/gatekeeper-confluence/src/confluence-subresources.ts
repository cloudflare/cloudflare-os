// The subresources Confluence reads report (see ObservationDescription.subresources), and how an
// observer's own account answers whether it can read them.
//
// Every ID leads with the Confluence Cloud site the resource lives on, `site/<cloudId>`. For a
// space or content ID that prefix is the resource's identity, not a further requirement: it asks
// only whether the space or content can be retrieved, as the legacy tracker's checks did. Spaces are
// spelled as the reads that reveal them spell them, a numeric space ID from a listing or
// `getSpace()` and a key for a space binding's own space, and content by its Confluence ID.
// Confluence is one product, so the IDs carry no namespace (see formatSubresourceId).

import type { KvTtlCache } from "@gadgets/gatekeeper-kit/cache";
import { mapLimit } from "@gadgets/gatekeeper-kit/observers";
import { formatSubresourceId, parseSubresourceId } from "@gadgets/gatekeeper-kit/subresource-ids";
import {
  ConfluenceApiError,
  getAccessibleResources,
  type AccessibleResource,
  type ConfluenceApi,
} from "./confluence-api";
import type { ConfluenceObservedSet } from "./confluence-observers";

const SITE_FRAGMENT = "site";
const SPACE_FRAGMENT = "space";
const CONTENT_FRAGMENT = "content";

/**
 * A Confluence resource a read can depend on: a site (`site/<cloudId>`), a space on it
 * (`site/<cloudId>/space/<spaceIdOrKey>`), or a page or blog post on it
 * (`site/<cloudId>/content/<contentId>`).
 */
export type ConfluenceSubresource =
  | { kind: "site"; cloudId: string }
  | { kind: "space"; cloudId: string; space: string }
  | { kind: "content"; cloudId: string; contentId: string };

/**
 * The subresource ID of `resource`.
 * @throws Error when an identifier is empty, or `resource` is content a Gadget has staged but
 * Confluence has not created (a `~` ID, see contentSets), which no verifier can look up.
 */
export function formatConfluenceSubresource(resource: ConfluenceSubresource): string {
  const site = { name: SITE_FRAGMENT, id: resource.cloudId };
  switch (resource.kind) {
    case "site":
      return formatSubresourceId({ fragments: [site] });
    case "space":
      return formatSubresourceId({ fragments: [site, { name: SPACE_FRAGMENT, id: resource.space }] });
    case "content":
      if (resource.contentId.startsWith("~")) {
        throw new Error("Content that has not been created in Confluence has no subresource ID.");
      }
      return formatSubresourceId({ fragments: [site, { name: CONTENT_FRAGMENT, id: resource.contentId }] });
  }
}

/**
 * The resource a {@link formatConfluenceSubresource} ID names.
 * @throws Error for any other ID, including one spelled another way.
 */
export function parseConfluenceSubresource(subresource: string): ConfluenceSubresource {
  const { namespace, fragments } = parseSubresourceId(subresource);
  const site = fragments[0];
  const resource = fragments[1];
  if (namespace === undefined && site?.name === SITE_FRAGMENT) {
    if (fragments.length === 1) return { kind: "site", cloudId: site.id };
    if (fragments.length === 2 && resource?.name === SPACE_FRAGMENT) {
      return { kind: "space", cloudId: site.id, space: resource.id };
    }
    if (fragments.length === 2 && resource?.name === CONTENT_FRAGMENT && !resource.id.startsWith("~")) {
      return { kind: "content", cloudId: site.id, contentId: resource.id };
    }
  }
  throw new Error("Not a Confluence subresource.");
}

/**
 * The subresource ID of a resource on site `cloudId` that the legacy tracker records as `set`, so
 * a read reports exactly what it revealed under that protocol.
 */
export function observedSetSubresource(cloudId: string, set: ConfluenceObservedSet): string {
  const separator = set.indexOf(":");
  const id = set.slice(separator + 1);
  return set.slice(0, separator) === SPACE_FRAGMENT
    ? formatConfluenceSubresource({ kind: "space", cloudId, space: id })
    : formatConfluenceSubresource({ kind: "content", cloudId, contentId: id });
}

// How long an account reuses an answer about its own access to a Confluence resource, counted from
// when it started asking Atlassian. Confluence doesn't say when access changes: a revoked
// permission is noticed only once the answer that allowed it expires, while a denial is kept
// briefly so that a new grant is noticed soon.
const ACCESS_ALLOWED_TTL_MS = 15 * 60_000;
const ACCESS_DENIED_TTL_MS = 15_000;

// The most spaces and content items one check retrieves at once: enough that a long check doesn't
// take a request's latency per item, few enough that it doesn't trip Atlassian's rate limit.
const ACCESS_CHECK_CONCURRENCY = 4;

/** The reads that retrieve a space or content item, which answer whether it is visible. */
type ResourceApi = Pick<ConfluenceApi, "getSpaceById" | "getSpaceByKey" | "getContentById">;

/** The observer's connected account, as {@link checkConfluenceSubresourceAccess} asks it. */
export type ConfluenceAccessAccount = {
  /** A current access token, refreshed if near expiry; throws when none can be obtained. */
  getToken(): Promise<string>;
  /** Refreshes the credentials and returns the new access token; throws when they can't be. */
  refresh(): Promise<string>;
  /** A client for site `cloudId` that sends `token` and, on a 401, refreshes once. */
  api(cloudId: string, token: string): ResourceApi;
};

/**
 * Whether `account` can read each Confluence subresource, in order, reusing answers in `cache`: an
 * allowed answer for up to 15 minutes and a denial for up to 15 seconds. Every ID is parsed before
 * anything is asked. Sites are answered together, from one live listing of the account's
 * accessible resources (never the sites recorded at connect time); spaces and content are retrieved
 * a few at a time. Only Atlassian refusing (403) or not finding (404) a resource, or not listing its
 * site, is a denial. Anything else, including credentials that can't be obtained or refreshed, a
 * rate limit or an outage, throws, and is never reused.
 * @throws Error for an ID that is not a Confluence subresource, or when access can't be determined.
 */
export async function checkConfluenceSubresourceAccess(
  cache: KvTtlCache, account: ConfluenceAccessAccount, subresources: string[],
): Promise<boolean[]> {
  const parsed = subresources.map(parseConfluenceSubresource);
  const ttl = (allowed: boolean) => allowed ? ACCESS_ALLOWED_TTL_MS : ACCESS_DENIED_TTL_MS;
  // Listed at most once per check, and only if some answer needs it, so a long check asks once.
  let listing: Promise<Set<string>> | undefined;
  const accessibleSites = () => listing ??= listAccessibleSites(account);

  const answers = new Map<string, boolean>();
  const sites = [...new Set(subresources.filter((_, index) => parsed[index].kind === "site"))];
  if (sites.length > 0) {
    const verdicts = await cache.cachedMany(sites, ttl, async missing => {
      const listed = await accessibleSites();
      return missing.map(subresource => listed.has(parseConfluenceSubresource(subresource).cloudId));
    });
    sites.forEach((subresource, index) => answers.set(subresource, verdicts[index]));
  }
  // Atlassian answers for one space or content item per request, so each is cached on its own,
  // and a failure keeps what the requests already made learned. A few at a time, so a long check
  // neither waits on each request in turn nor trips Atlassian's rate limit.
  const retrieved = new Map<string, Exclude<ConfluenceSubresource, { kind: "site" }>>();
  parsed.forEach((resource, index) => {
    if (resource.kind !== "site") retrieved.set(subresources[index], resource);
  });
  const verdicts = await mapLimit([...retrieved], ACCESS_CHECK_CONCURRENCY, ([subresource, resource]) =>
    cache.cached(subresource, ttl, () => canRetrieve(account, resource, accessibleSites)));
  [...retrieved.keys()].forEach((subresource, index) => answers.set(subresource, verdicts[index]));
  return subresources.map(subresource => answers.get(subresource)!);
}

/** Whether Atlassian retrieves a space or content item for `account`. */
async function canRetrieve(
  account: ConfluenceAccessAccount, resource: Exclude<ConfluenceSubresource, { kind: "site" }>,
  accessibleSites: () => Promise<Set<string>>,
): Promise<boolean> {
  // Asked for outside the probe, so credentials that can't be obtained throw instead of reading as
  // whatever status the failed token request carried.
  const api = account.api(resource.cloudId, await account.getToken());
  try {
    if (resource.kind === "content") await api.getContentById(resource.contentId, { body: false });
    else if (/^\d+$/.test(resource.space)) await api.getSpaceById(resource.space);
    else await api.getSpaceByKey(resource.space);
    return true;
  } catch (error) {
    if (!(error instanceof ConfluenceApiError)) throw error;
    if (error.status === 403 || error.status === 404) return false;
    // Atlassian refuses a token on a site it holds no grant for with the same 401 as a token it no
    // longer accepts, and the client's refresh swallows a failure into that 401. Only a live listing
    // that leaves the site out tells the first apart; listing with credentials that fail throws.
    if (error.status === 401 && !(await accessibleSites()).has(resource.cloudId)) return false;
    throw error;
  }
}

/** The cloud IDs of the Confluence sites `account` can access now, asked of Atlassian. */
async function listAccessibleSites(account: ConfluenceAccessAccount): Promise<Set<string>> {
  const token = await account.getToken();
  let resources: AccessibleResource[];
  try {
    resources = await getAccessibleResources(token);
  } catch (error) {
    // A token Atlassian no longer accepts says nothing about access: refresh it, once, and let a
    // refresh that fails, or a refreshed token refused again, throw.
    if (!(error instanceof ConfluenceApiError && error.status === 401)) throw error;
    resources = await getAccessibleResources(await account.refresh());
  }
  return new Set(resources.map(resource => resource.id));
}
