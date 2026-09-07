/**
 * The conformance consumer: a gatekeeper assembled from the kit's leaves against `FakeProvider`.
 *
 * Its job is to be the first thing that composes them, so a contract that only breaks in assembly
 * breaks here rather than in the first real port. Everything a real gatekeeper would own -- grant
 * shape, error classification, action presentation, ACL oracle -- is written out rather than
 * abstracted, because the point is to show what a consumer must write.
 */

import { DurableObject, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type { ActionDescription, ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";
import {
  ActionOutcomeUnknownError,
  ActionJournal,
  defineActions,
  type TaggedAction,
} from "../../../src/actions";
import { KvTtlCache } from "../../../src/cache";
import { advanceToOAuth, claimOAuth, putInitiation } from "../../../src/connect-handshake";
import {
  CredentialCoordinator,
  CredentialSource,
  type CredentialRead,
  type RejectionVerdict,
} from "../../../src/credentials";
import { TokenCursor } from "../../../src/cursors";
import { ObservationGate, trackedSetObservers } from "../../../src/observers";
import {
  FakeProvider,
  ProviderAuthError,
  ProviderTimeoutError,
  type Grant,
  type Project,
  type PublicGrant,
} from "./provider";

/** One provider per test run, reached by both the account and its resources. */
export const provider = new FakeProvider();

/** Every observation the gate sent, in order. */
export const observations: ObservationDescription[] = [];

/** Every action staged, as `[id, description]`. */
export const submissions: [number, ActionDescription][] = [];

/** Commit ids advertised through the gate's git cache. */
export const advertised: string[] = [];

// Provisional ids the agent can name before the provider has minted a real one.
const resolvedRefs = new Map<string, string>();

/** Resets shared state between tests, since these module instances outlive one. */
export function resetProvider(): void {
  provider.controls.rejectCredentials = false;
  provider.controls.grantDead = false;
  provider.controls.timeoutAfterCreate = false;
  provider.principal = "user-a";
  provider.revoked.clear();
  provider.projects.clear();
  provider.access.clear();
  observations.length = 0;
  submissions.length = 0;
  advertised.length = 0;
  resolvedRefs.clear();
}

/** The slice of `GitCache` this consumer touches. */
type GitCacheStub = { advertiseCommit(oid: string): Promise<void> };

class FixtureGitCache extends RpcTarget {
  async advertiseCommit(oid: string): Promise<void> {
    advertised.push(oid);
  }
}

/**
 * Stands in for the overseer's approval queue. A `WorkerEntrypoint`, not a plain object: a bare
 * object's methods cross an RPC boundary as call-scoped stubs that are disposed when that call
 * returns, so a gate built from one is dead by its first use.
 */
export class FixtureQueue extends WorkerEntrypoint {
  async authorizeObservation(description: ObservationDescription): Promise<void> {
    observations.push(description);
  }

  async submitAction(action: number, description: ActionDescription): Promise<void> {
    submissions.push([action, description]);
  }

  /** The git cache a gatekeeper returning commit ids must advertise through. */
  async getGitCache(): Promise<GitCacheStub> {
    return new FixtureGitCache();
  }
}

/** Actions this gatekeeper can be asked to take. */
type Actions = {
  createProject: { ref: string; name: string; spaceId: string };
  renameProject: { target: string; name: string };
};

const actions = defineActions<ConformanceResource, Actions>({
  createProject: {
    kind: { tag: "create-project", label: "Create a project" },
    delivery: "continue-with-simulation",
    // Non-idempotent at the provider, so a lost activation must not replay it.
    claimBeforeApply: true,
    describe: payload => ({
      title: `Create project "${payload.name}"`,
      description: `Creates **${payload.name}** in space ${payload.spaceId}.`,
      implementsRevert: false,
    }),
    provides: payload => [payload.ref],
    apply: async (payload, host) => {
      const id = await host.createProject(payload.name, payload.spaceId);
      resolvedRefs.set(payload.ref, id);
    },
  },
  renameProject: {
    kind: { tag: "rename-project", label: "Rename a project" },
    delivery: "continue-with-simulation",
    describe: payload => ({
      title: `Rename ${payload.target}`,
      description: `Renames ${payload.target} to **${payload.name}**.`,
      // The kit cannot check this claim, so the fixture must not make one it has no handler for.
      implementsRevert: false,
    }),
    dependsOn: payload => [payload.target],
    apply: async (payload, host) => {
      await host.renameProject(resolvedRefs.get(payload.target) ?? payload.target, payload.name);
    },
  },
}, {
  isResolvedReference: ref => resolvedRefs.has(ref),
});

/**
 * The account Durable Object. Owns credentials and the connect handshake, and is the only holder of
 * refresh material.
 */
export class ConformanceAccount extends DurableObject {
  readonly #creds = new CredentialCoordinator<Grant>(this.ctx.storage.kv, {
    expiresAt: grant => grant.expiresAt,
    // Rotation is per-token here, so revoking a fenced-out mint cannot kill the winner.
    discardMint: grant => void provider.revoked.add(grant.refreshToken),
    vendorId: "conformance",
  });

  /** @returns The nonce a connect link carries. */
  beginConnect(): string {
    const nonce = crypto.randomUUID();
    putInitiation(this.ctx.storage.kv, nonce, Date.now());
    return nonce;
  }

  /**
   * Advances to the provider redirect, capturing the connection this attempt started under.
   * @param initiationNonce Nonce from the connect link.
   * @returns The OAuth nonce, or `null` when the attempt is stale.
   */
  beginOAuth(initiationNonce: string): string | null {
    return advanceToOAuth(this.ctx.storage.kv, initiationNonce, Date.now(),
      { startedUnder: this.#creds.connectionGeneration() });
  }

  /**
   * Completes the callback. The claim is irrevocable, so the exchange happens after it and the
   * write is fenced on the generation the attempt started under.
   * @param oauthNonce Nonce the provider returned.
   * @returns Whether the connection was stored.
   */
  async completeConnect(oauthNonce: string): Promise<boolean> {
    const claim = claimOAuth<{ startedUnder: string }>(this.ctx.storage.kv, oauthNonce, Date.now());
    if (claim === null) return false;
    // The exchange is the async window this consumer must fence itself.
    const grant = await Promise.resolve(provider.mint());
    if (this.#creds.connectionGeneration() !== claim.startedUnder) {
      // A revoke or newer reconnect won while we were exchanging; this mint is ours to dispose.
      provider.revoked.add(grant.refreshToken);
      return false;
    }
    this.#creds.connect(grant);
    return true;
  }

  /** Disconnects, as a user revoke does. */
  disconnect(): void {
    this.#creds.clear();
  }

  /** @returns The credential triple, with refresh material projected out. */
  async getCredentials(): Promise<{ creds: PublicGrant } & CredentialRead> {
    const { creds, identity, generation } = await this.#creds.snapshot(grant => this.#refresh(grant));
    const { refreshToken: _refreshToken, ...publicGrant } = creds;
    return { creds: publicGrant, identity, generation };
  }

  /**
   * Adjudicates a rejection the resource saw.
   * @param identity Credential identity that was rejected.
   * @returns The account's verdict.
   */
  reportCredentialsRejected(identity: string): Promise<RejectionVerdict> {
    return this.#creds.adjudicateRejection(identity, {
      refresh: grant => this.#refresh(grant),
      notify: async () => {},
    });
  }

  /**
   * Refreshes at the provider. The response omits unchanged fields, so the stored record is merged
   * rather than replaced -- without this the *next* refresh fails.
   * @param current The stored grant.
   * @returns The complete replacement record.
   */
  async #refresh(current: Grant): Promise<Grant> {
    const response = await Promise.resolve(provider.refresh(current));
    return { ...current, ...response, refreshToken: response.refreshToken ?? current.refreshToken };
  }
}

/** What the conformance suite drives; a real gatekeeper would expose this over RPC. */
export class ConformanceResource extends DurableObject {
  #account?: DurableObjectStub<ConformanceAccount>;

  readonly #creds = new CredentialSource<PublicGrant>({
    account: () => this.#requireAccount(),
    isAuthError: error => error instanceof ProviderAuthError,
    expiredMessage: "Reconnect the conformance account.",
    vendorId: "conformance",
  });

  readonly #observers = trackedSetObservers<{ user: string }>({
    kv: this.ctx.storage.kv,
    hasSetAccess: async (verifier, spaceIds) =>
      spaceIds.map(spaceId => provider.hasAccess(verifier.user, spaceId)),
  });

  // Named, so it cannot collide with another cache over this same storage.
  readonly #cache = KvTtlCache.partitionedBy(this.ctx.storage.kv, this.#creds, { name: "projects" });

  readonly #journal = new ActionJournal<TaggedAction<Actions>>(this.ctx.storage.kv, {
    namespace: "projects",
  });

  #gate?: ObservationGate;

  /**
   * Binds the account this resource answers for and opens its queue capability.
   * @param account The account Durable Object.
   */
  bind(account: DurableObjectStub<ConformanceAccount>): void {
    this.#account = account;
    // The gate owns this stub for the resource's lifetime, as a session's `queue.dup()` would.
    this.#gate = new ObservationGate(this.ctx.exports.FixtureQueue({}) as never, this.#observers);
  }

  #requireAccount(): DurableObjectStub<ConformanceAccount> {
    if (!this.#account) throw new Error("resource is not bound");
    return this.#account;
  }

  #requireGate(): ObservationGate {
    if (!this.#gate) throw new Error("resource is not bound");
    return this.#gate;
  }

  /**
   * Admits a collaborator, which verifies their access to every space read so far.
   * @param id Collaborator id.
   * @param user Provider-side user the collaborator maps to.
   */
  addObserver(id: string, user: string): Promise<void> {
    return this.#observers.addObserver(id, { user } as never);
  }

  /** @returns Every project, paged, with each page authorized before it is returned. */
  listProjects(): TokenCursor<Project> {
    const gate = this.#requireGate();
    return new TokenCursor<Project>({
      pageSize: 2,
      remotePageSize: 2,
      fetchPage: token => this.#creds.run(
        async creds => provider.listProjects(creds, token),
        { replayable: true }),
      authorizePage: (projects, { terminal }) => projects.length === 0
        ? gate.authorize(
          {
            title: "Projects",
            description: terminal ? "Listed projects; there were none." : "Scanned an empty window.",
          },
          { kind: "baseline" })
        : gate.authorize(
          { title: "Projects", description: `Read ${projects.length} projects.` },
          { kind: "sets", ids: [...new Set(projects.map(project => project.spaceId))] }),
    });
  }

  /**
   * Searches projects, cached under the live connection fence.
   * @param query Name substring.
   * @returns Matching projects.
   */
  async searchProjects(query: string): Promise<Project[]> {
    const matches = await this.#cache.cached(`search:${query}`, 60_000,
      () => this.#creds.run(async creds => provider.searchProjects(creds, query),
        { replayable: true }));
    await this.#requireGate().authorize(
      { title: "Search", description: `Searched projects for "${query}".` },
      matches.length === 0
        ? { kind: "baseline" }
        : { kind: "sets", ids: [...new Set(matches.map(project => project.spaceId))] });
    return matches;
  }

  /**
   * Advertises a commit through the gate, the way a git-backed gatekeeper must. Reaching the cache
   * through the gate is what keeps the raw queue stub out of session code.
   * @param oid Commit id to advertise.
   */
  async advertiseHead(oid: string): Promise<void> {
    using cache = await this.#requireGate().getGitCache();
    await cache.advertiseCommit(oid);
  }

  /**
   * Stages an action pinned to the connection it was prepared under.
   * @param name Project name.
   * @param spaceId Owning space.
   * @returns The staged action id.
   */
  async submitFenced(name: string, spaceId: string): Promise<number> {
    // The fence rides the read this operation ran under, never a shared accessor.
    const fence = await this.#creds.read();
    return actions.bind(this.#journal, this).submit(
      this.#requireGate().actions, "createProject",
      { ref: `~${name}`, name, spaceId }, { fence });
  }

  /**
   * Applies an action under the account's current connection.
   * @param id Action id.
   */
  async applyFenced(id: number): Promise<void> {
    const { generation } = await this.#creds.read();
    await actions.bind(this.#journal, this).apply(id, { generation });
  }

  /**
   * Allocates one action in each of two journals over this same storage.
   * @returns Each journal's allocated id and what the other can see of it.
   */
  isolation(): { ids: [number, number]; names: [string?, string?] } {
    const journalFor = (namespace: string) =>
      new ActionJournal<TaggedAction<Actions>>(this.ctx.storage.kv, { namespace });
    const staged = (name: string) =>
      ({ kind: "createProject", payload: { ref: `~${name}`, name, spaceId: "s" } }) as
        TaggedAction<Actions>;
    const left = journalFor("left");
    const right = journalFor("right");
    const leftId = left.allocate(staged("left-project"));
    const rightId = right.allocate(staged("right-project"));
    // Reading each id back through its own journal: ids collide, so only the payload distinguishes
    // whose record it is. A shared keyspace would have the second write clobber the first.
    const leftRecord = left.get(leftId)?.action;
    const rightRecord = right.get(rightId)?.action;
    return {
      ids: [leftId, rightId],
      names: [
        leftRecord?.kind === "createProject" ? leftRecord.payload.name : undefined,
        rightRecord?.kind === "createProject" ? rightRecord.payload.name : undefined,
      ],
    };
  }

  /**
   * Creates a project at the provider, classifying an ambiguous outcome honestly.
   * @param name Project name.
   * @param spaceId Owning space.
   * @returns The new project id.
   */
  async createProject(name: string, spaceId: string): Promise<string> {
    return this.#creds.run(async creds => {
      try {
        return provider.createProject(creds, name, spaceId);
      } catch (error) {
        // The provider was reached, so the effect may have landed: never say it did not.
        if (error instanceof ProviderTimeoutError) {
          throw new ActionOutcomeUnknownError(
            "The provider timed out creating this project; check before submitting it again.");
        }
        throw error;
      }
    });
  }

  /**
   * Renames a project.
   * @param id Provider project id.
   * @param name New name.
   */
  async renameProject(id: string, name: string): Promise<void> {
    await this.#creds.run(async creds => provider.renameProject(creds, id, name));
  }

  /**
   * Stages an action, the way a session method does. The bound set stays inside the resource: a
   * gatekeeper exposes RPC methods, not its journal or its queue stub.
   * @param kind Declared action kind.
   * @param payload Action payload.
   * @returns The staged action id.
   */
  submit<K extends keyof Actions>(kind: K, payload: Actions[K]): Promise<number> {
    return actions.bind(this.#journal, this)
      .submit(this.#requireGate().actions, kind, payload);
  }

  /**
   * Applies a staged action.
   * @param id Action id.
   */
  async apply(id: number): Promise<void> {
    await actions.bind(this.#journal, this).apply(id);
  }

  /**
   * Reads one journal record's state, flattened so it can cross the RPC boundary.
   * @param id Action id.
   * @returns The record's state and outcome classification, or `undefined` when it is gone.
   */
  record(id: number): { state: string; outcome?: string; error?: string } | undefined {
    const stored = this.#journal.get(id);
    return stored && {
      state: stored.state,
      ...(stored.state === "failed" && stored.outcome ? { outcome: stored.outcome } : {}),
      ...(stored.state === "failed" ? { error: stored.error } : {}),
    };
  }
}
