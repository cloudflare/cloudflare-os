/**
 * The conformance consumer: a gatekeeper assembled from the kit's leaves against `FakeProvider`.
 *
 * Its job is to be the first thing that composes them, so a contract that only breaks in assembly
 * breaks here rather than in the first real port. Everything a real gatekeeper would own -- grant
 * shape, error classification, action presentation, ACL oracle -- is written out rather than
 * abstracted, because the point is to show what a consumer must write.
 */

import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type {
  ActionDescription,
  GitCache,
  ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  ActionApplyError,
  ActionOutcomeUnknownError,
  ActionJournal,
  defineActions,
  type TaggedAction,
} from "../../../src/actions";
import type { ActionFence } from "../../../src/action-journal";
import { KvTtlCache } from "../../../src/cache";
import { advanceToOAuth, claimOAuth, putInitiation } from "../../../src/connect-handshake";
import {
  CredentialCoordinator,
  CredentialSource,
  CredentialsExpiredError,
  isConnectionSuperseded,
  type CredentialRead,
  type RejectionVerdict,
} from "../../../src/credentials";
import { TokenCursor } from "../../../src/cursors";
import { ProvisionalIds } from "../../../src/simulation";
import { ObservationGate, trackedCollectionObservers } from "../../../src/observers";
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

/** Refuses the next observation, as the overseer does on a policy refusal. */
export const overseer = { refuseNext: false };

/** Resets shared state between tests, since these module instances outlive one. */
export function resetProvider(): void {
  provider.controls.rejectCredentials = false;
  provider.controls.grantDead = false;
  provider.controls.timeoutAfterCreate = false;
  provider.principal = "user-a";
  provider.listCalls = 0;
  provider.revoked.clear();
  provider.projects.clear();
  provider.access.clear();
  observations.length = 0;
  submissions.length = 0;
  advertised.length = 0;
  overseer.refuseNext = false;
}

/** Deliberately partial: this consumer only advertises commits. */
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
export class FixtureQueue extends RpcTarget {
  async authorizeObservation(description: ObservationDescription): Promise<void> {
    if (overseer.refuseNext) {
      overseer.refuseNext = false;
      throw new Error("the overseer refused this observation");
    }
    observations.push(description);
  }

  async submitAction(action: number, description: ActionDescription): Promise<void> {
    submissions.push([action, description]);
  }

  /** The git cache a gatekeeper returning commit ids must advertise through. */
  async getGitCache(): Promise<GitCache> {
    return new FixtureGitCache() as unknown as GitCache;
  }
}

/** Actions this gatekeeper can be asked to take. */
type Actions = {
  createProject: { ref: string; name: string; spaceId: string };
  renameProject: { target: string; name: string };
};

/**
 * Closes the window apply's entry check cannot: a reconnect landing between that check and the
 * provider call. Terminal, and `ActionApplyError` rather than a bare throw: this runs before the
 * provider is reached, so no effect landed and retrying under a fence that can never match again
 * would leave the action pending for good.
 * @param fence The action's captured authority, absent for an unfenced action.
 * @param read The credential read this provider call runs under.
 */
function requireActionFence(fence: ActionFence | undefined, read: CredentialRead): void {
  if (fence && fence.generation !== read.generation) {
    throw new ActionApplyError(
      "This action was approved under a connection that has since been replaced. "
      + "Reject it and submit it again.");
  }
}

/**
 * Refuses a walk whose continuation token belongs to a connection the account has moved past.
 * @param opened The read the walk opened under.
 * @param read The credential read this page runs under.
 */
function requireWalkFence(opened: CredentialRead, read: CredentialRead): void {
  if (opened.generation !== read.generation) {
    throw new Error("This walk was started under a connection that has since been replaced.");
  }
}

/**
 * What the action handlers may do. Deliberately not the Durable Object: exporting provider
 * mutators on the DO would let any stub holder bypass the staged-approval path entirely.
 */
type ProviderHost = {
  createProject(name: string, spaceId: string, fence?: ActionFence): Promise<string>;
  renameProject(id: string, name: string, fence?: ActionFence): Promise<void>;
  refs: ProvisionalIds<string>;
};

const actions = defineActions<ProviderHost, Actions>({
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
    apply: async (payload, host, { fence }) => {
      const id = await host.createProject(payload.name, payload.spaceId, fence);
      host.refs.bind(payload.ref, id);
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
    apply: async (payload, host, { fence }) => {
      // Resolved, never defaulted: apply already refused an unresolved reference, so a
      // provisional string reaching the provider would be a kit bug rather than a fallback.
      await host.renameProject(host.refs.requireResolved(payload.target), payload.name, fence);
    },
  },
}, {
  // Both kinds name a project in one provider account, so neither means anything under another
  // connection. Declaring it here is what makes `submit` refuse a call that forgot the fence.
  fence: "authority",
  isResolvedReference: (host, ref) => host.refs.isResolved(ref),
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
  async completeConnect(oauthNonce: string, revokeDuringExchange = false): Promise<boolean> {
    const claim = claimOAuth<{ startedUnder: string }>(this.ctx.storage.kv, oauthNonce, Date.now());
    if (claim === null) return false;
    // The exchange is the window `claimOAuth` cannot cover; `ifGeneration` fences it.
    const grant = await Promise.resolve(provider.mint());
    // A revoke landing inside that window, which is the case the fence exists for.
    if (revokeDuringExchange) this.#creds.clear();
    try {
      this.#creds.connect(grant, { ifGeneration: claim.startedUnder });
    } catch (error) {
      if (!isConnectionSuperseded(error)) throw error;
      // The mint was never stored, so disposing of it is ours to do. Safe here because this
      // provider revokes per token; a grant-wide revocation would kill the winning connection.
      provider.revoked.add(grant.refreshToken);
      return false;
    }
    return true;
  }

  /** @returns Whether credentials are stored, so a test can see which write won. */
  isConnected(): boolean {
    return this.#creds.stored() !== undefined;
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
    let response;
    try {
      response = await Promise.resolve(provider.refresh(current));
    } catch (error) {
      // The token endpoint refusing the refresh token is the grant's death, and only this frame
      // can say so: to every layer above it is an ordinary 401 from an unknown cause.
      if (error instanceof ProviderAuthError && /invalid_grant/.test(error.message)) {
        throw new CredentialsExpiredError("This connection was revoked at the provider.",
          { cause: error });
      }
      throw error;
    }
    return { ...current, ...response, refreshToken: response.refreshToken ?? current.refreshToken };
  }
}

/**
 * The collaborator ACL oracle as a capability, not a value: a `WorkerEntrypoint` behind
 * `ctx.exports` is what the overseer hands a gatekeeper, and the only kind of stub Durable Object
 * storage will persist.
 */
export class ConformanceVerifier extends WorkerEntrypoint<unknown, { user: string }> {
  async hasSpaces(spaceIds: readonly string[]): Promise<boolean[]> {
    return spaceIds.map(spaceId => provider.hasAccess(this.ctx.props.user, spaceId));
  }
}

type SpaceVerifier = { hasSpaces(spaceIds: readonly string[]): Promise<boolean[]> };

/** What the conformance suite drives; a real gatekeeper would expose this over RPC. */
export class ConformanceResource extends DurableObject {
  #account?: DurableObjectStub<ConformanceAccount>;

  readonly #creds = new CredentialSource<PublicGrant>({
    account: () => this.#requireAccount(),
    isAuthError: error => error instanceof ProviderAuthError,
    expiredMessage: "Reconnect the conformance account.",
    vendorId: "conformance",
  });

  readonly #observers = trackedCollectionObservers<SpaceVerifier>({
    kv: this.ctx.storage.kv,
    hasCollectionAccess: (verifier, spaceIds) => verifier.hasSpaces(spaceIds),
  });

  // Named, so it cannot collide with another cache over this same storage.
  readonly #cache = KvTtlCache.partitionedBy(this.ctx.storage.kv, this.#creds, { name: "projects" });

  readonly #journal = new ActionJournal<TaggedAction<Actions>>(this.ctx.storage.kv, {
    namespace: "projects",
  });

  readonly #refs = new ProvisionalIds<string>(this.ctx.storage.kv, {
    namespace: "projects",
    isProvisional: ref => ref.startsWith("~"),
  });

  readonly #host: ProviderHost = {
    createProject: (name, spaceId, fence) => this.#createProject(name, spaceId, fence),
    renameProject: (id, name, fence) => this.#renameProject(id, name, fence),
    refs: this.#refs,
  };

  #gate?: ObservationGate;
  #queue?: RpcStub<FixtureQueue>;
  #reconnectMidApply = false;

  /**
   * Binds the account this resource answers for and the queue its session stages through.
   * @param account The account Durable Object.
   * @param queue The overseer's approval queue, borrowed for this call only.
   */
  bind(account: DurableObjectStub<ConformanceAccount>, queue: RpcStub<FixtureQueue>): void {
    this.#account = account;
    // Two owners, as a session has: its own queue for staging actions, and a gate over a second
    // dup. Both come from the borrowed argument, which the caller drops when this call returns.
    // Rebinding releases the pair the previous bind made; leases outlive it.
    this.#gate?.[Symbol.dispose]();
    this.#queue?.[Symbol.dispose]();
    this.#queue = queue.dup();
    this.#gate = new ObservationGate(queue.dup(), this.#observers);
  }

  #requireAccount(): DurableObjectStub<ConformanceAccount> {
    if (!this.#account) throw new Error("resource is not bound");
    return this.#account;
  }

  /** Replaces the connection underneath an in-flight operation. */
  async #reconnect(): Promise<void> {
    this.#reconnectMidApply = false;
    const account = this.#requireAccount();
    await account.disconnect();
    await account.completeConnect(await account.beginOAuth(await account.beginConnect()) ?? "");
  }

  #requireGate(): ObservationGate {
    if (!this.#gate) throw new Error("resource is not bound");
    return this.#gate;
  }

  #requireQueue(): RpcStub<FixtureQueue> {
    if (!this.#queue) throw new Error("resource is not bound");
    return this.#queue;
  }

  /**
   * Admits a collaborator, which verifies their access to every space read so far.
   * @param id Collaborator id.
   * @param user Provider-side user the collaborator maps to.
   */
  addObserver(id: string, user: string): Promise<void> {
    return this.#observers.addObserver(id, this.ctx.exports.ConformanceVerifier({ props: { user } }));
  }

  /** @returns Every project, paged, with each page authorized before it is returned. */
  async listProjects(): Promise<TokenCursor<Project>> {
    // Pinned to the connection the walk opened under: a continuation token is provider state
    // scoped to one account, so presenting it under the next one mixes or skips rows. Read before
    // leasing, so a disconnected account throws with nothing acquired.
    const opened = await this.#creds.read();
    // The cursor is returned to the caller and walked later, so it takes its own lease rather than
    // borrowing the session's stub, and releases it when the walk is dropped.
    const walk = this.#requireGate().lease();
    return new TokenCursor<Project>({
      dispose: () => walk[Symbol.dispose](),
      pageSize: 2,
      // Wider than the local page, so a walk serves one page from the buffer with no fetch.
      remotePageSize: 4,
      fetchPage: (token, perPage) => this.#creds.run(
        async (creds, read) => {
          requireWalkFence(opened, read);
          return provider.listProjects(creds, token, perPage);
        },
        { replayable: true }),
      authorizePage: async (projects, { terminal }) => {
        // Re-checked here, not only in `fetchPage`: a refused page is held and re-offered without
        // refetching, so this is the only check the retry path runs.
        requireWalkFence(opened, await this.#creds.read());
        await (projects.length === 0
          ? walk.authorize(
            {
              title: "Projects",
              description: terminal ? "Listed projects; there were none." : "Scanned an empty window.",
            },
            { kind: "baseline" })
          : walk.authorize(
            { title: "Projects", description: `Read ${projects.length} projects.` },
            { kind: "collections", ids: [...new Set(projects.map(project => project.spaceId))] }));
      },
    });
  }

  /**
   * Searches projects, cached under the live connection fence.
   * @param query Name substring.
   * @returns Matching projects.
   */
  async searchProjects(query: string): Promise<Project[]> {
    const { matches, spaces } = await this.#cache.cached(`search:${query}`, 60_000,
      () => this.#creds.run(async creds => provider.searchProjects(creds, query),
        { replayable: true }));
    // Every space searched, not just the ones that matched: a miss discloses absence in each of
    // them, so an observer excluded from one must not learn that.
    await this.#requireGate().authorize(
      { title: "Search", description: `Searched projects for "${query}".` },
      spaces.length === 0 ? { kind: "baseline" } : { kind: "collections", ids: spaces });
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
  async #createProject(name: string, spaceId: string, fence?: ActionFence): Promise<string> {
    // Apply's entry check has already passed, so a reconnect landing before this fetch is
    // invisible to it -- the operation would run under the new connection.
    if (this.#reconnectMidApply) await this.#reconnect();
    return this.#creds.run(async (creds, read) => {
      requireActionFence(fence, read);
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
  async #renameProject(id: string, name: string, fence?: ActionFence): Promise<void> {
    await this.#creds.run(async (creds, read) => {
      requireActionFence(fence, read);
      provider.renameProject(creds, id, name);
    });
  }

  /**
   * Stages an action, the way a session method does. The bound set stays inside the resource: a
   * gatekeeper exposes RPC methods, not its journal or its queue stub.
   * @param kind Declared action kind.
   * @param payload Action payload.
   * @returns The staged action id.
   */
  async submit<K extends keyof Actions>(kind: K, payload: Actions[K]): Promise<number> {
    // Both kinds are declared connection-fenced, so the set refuses this call without a fence.
    // Staged inside a credentialed operation, so the fence is that operation's own read rather
    // than a second one a reconnect could land in front of.
    return this.#creds.run((_creds, read) => actions.bind(this.#journal, this.#host)
      .submit(this.#requireQueue(), kind, payload, { fence: read }));
  }

  /**
   * Applies a staged action.
   * @param id Action id.
   */
  async apply(id: number, reconnectMidApply = false): Promise<void> {
    const { generation } = await this.#creds.read();
    this.#reconnectMidApply = reconnectMidApply;
    try {
      await actions.bind(this.#journal, this.#host).apply(id, { generation });
    } finally {
      this.#reconnectMidApply = false;
    }
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
