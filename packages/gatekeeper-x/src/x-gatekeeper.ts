// The per-binding gatekeeper Durable Object: one instance per binding of an X connection, whether to
// the whole account, one post, one List, or one profile. It owns the binding's action journal, the
// temporary IDs of posts and Lists not yet created, captured images, a read cache partitioned by
// connection, and the observer records reads made before they reported subresources. It pins the X
// user the connection belongs to, and mints the capabilities gadgets hold (x-sessions.ts). Every X
// request runs through the account's credential source, and every read draws on the connection's
// daily read limit.

import { DurableObject, type RpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type {
  ActionKind,
  ApprovalQueue,
  Gatekeeper,
  GatekeeperUserVerifier,
  GitCache,
  ResourceDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { ActionFileStore, type ActionFileReference } from "@gadgets/gatekeeper-kit/action-files";
import { ActionJournal, type ActionSubmitter } from "@gadgets/gatekeeper-kit/actions";
import { KvTtlCache } from "@gadgets/gatekeeper-kit/cache";
import { ObservationGate, observerAccessVerifier, trackedCollectionObservers } from "@gadgets/gatekeeper-kit/observers";
import { ProvisionalIds } from "@gadgets/gatekeeper-kit/simulation";
import type { XAccountSession, XList, XPost, XProfile } from "./types";
import TYPES_CODE from "./types.txt";
import { obsContext } from "./observability";
import {
  MAX_IMAGE_BYTES,
  actions,
  dependedRefs,
  imageHandles,
  providedRefs,
  revert,
  type ListDetails,
  type RevertOutcome,
  type SendAttempt,
  type XAction,
  type XActionHost,
  type XActions,
} from "./x-actions";
import { XApi, XApiError, XCreditsError, XRateLimitError, type XEnvelope } from "./x-api";
import {
  accountSource, parseXUserSubresource, withinReadLimit, xUserSubresourceId, type StoredIdentity, type XVerifierApi,
} from "./x-credentials";
import { ACCOUNT_URL, VENDOR_ID, type Env, type ResourceKind, type XGatekeeperImplProps } from "./x-env";
import { toUserInfo, type WireUser } from "./x-normalize";
import {
  SessionContext,
  XAccountSessionImpl,
  XListImpl,
  XPostImpl,
  XProfileImpl,
  readUser,
  type XSessionHost,
} from "./x-sessions";
import { listUrl, postUrl } from "./x-urls";

const logger = obsContext.createLogger({ component: "gatekeeper.x", vendorId: VENDOR_ID });

/** How long the connected identity is trusted in memory before the account is asked again. */
const IDENTITY_MEMO_MS = 60 * 1000;
/** Most bytes the images of every pending post may hold together. */
const PENDING_MEDIA_BYTES = 64 * 1024 * 1024;
/** How long a captured image may go unreferenced before it is swept: past any submit in flight. */
const IMAGE_GRACE_MS = 60 * 60 * 1000;
/** How long an applied action stays revertible. */
const RETAINED_ACTION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** How often housekeeping may run. */
const HOUSEKEEPING_INTERVAL_MS = 6 * 60 * 60 * 1000;

// Storage keys of this class's own. The kit modules own theirs: `x:` and the journal's
// `retained:`/`applied:` tiers, `refs:`, `cache:@x:`, `images:`, `imageAllocations:`, and the
// observers' `observer:` and `observed:` (named here, since the historical export reads it).
const PINNED_USER_KEY = "pinnedUserId";
const PROFILE_USER_KEY = "profileUserId";
const DESCRIPTION_KEY = "description";
const HOUSEKEEPING_KEY = "housekeptAt";
const OBSERVED_PREFIX = "observed:";
const PROGRESS_PREFIX = "progress:";
const ATTEMPT_PREFIX = "attempt:";
const PREVIOUS_PREFIX = "previous:";

/** The collection reads private to the account named before they reported subresources. */
const OWNER_COLLECTION = "owner";

/** Which action tags each kind of binding can submit, for the auto-approval catalog. */
const BINDING_ACTIONS: Record<ResourceKind, (tag: string) => boolean> = {
  account: () => true,
  post: tag => tag.startsWith("x.post."),
  list: tag => tag.startsWith("x.list."),
  profile: () => false,
};

type XSession = XAccountSession | XPost | XList | XProfile;

@validateRpc()
export class XGatekeeperImpl extends DurableObject<Env, XGatekeeperImplProps> implements Gatekeeper<XSession> {
  readonly #creds = accountSource(this.ctx.exports, this.ctx.props.userObjectId);
  readonly #journal = new ActionJournal<XAction>(this.ctx.storage.kv, { namespace: "x" });
  readonly #refs = new ProvisionalIds<string>(this.ctx.storage.kv, {
    namespace: "refs:",
    isProvisional: id => id.startsWith("~"),
  });
  readonly #cache = KvTtlCache.partitionedBy(this.ctx.storage.kv, this.#creds, { name: "x" });
  readonly #files = new ActionFileStore(this.ctx.storage, {
    filePrefix: "images:",
    allocationPrefix: "imageAllocations:",
    maxFileBytes: MAX_IMAGE_BYTES,
    maxTotalBytes: PENDING_MEDIA_BYTES,
  });

  // Observers (plans/x-gatekeeper.md §7): every read reports what restricts who may see it, which
  // the Workshop checks through verifyObserverAccess(): nothing for a public read, and for one
  // private to the account the pinned X user's `user/<id>`, which only an observer connected as that
  // same X user may see. The tracker keeps what reads recorded before they reported subresources --
  // only ever the `owner` collection, which the same rule guards -- for addObserver() and
  // getHistoricalSubresources(); no read adds to it.
  readonly #observers = trackedCollectionObservers<XVerifierApi>({
    kv: this.ctx.storage.kv,
    collectionPrefix: OBSERVED_PREFIX,
    hasCollectionAccess: async (verifier, ids) => {
      const same = await this.#isPinnedUser(verifier);
      return ids.map(id => id === OWNER_COLLECTION && same);
    },
    denyMessage: () => "This collaborator isn't connected as the X account this workspace read " +
      "private data from (bookmarks, likes, mutes, private Lists, or protected accounts' posts), " +
      "so they can't observe it.",
    vendorId: VENDOR_ID,
  });

  // Every ID that reaches it names the pinned X user, so an observer's answer is the same for each.
  readonly #verifyAccess = observerAccessVerifier<XVerifierApi>({
    hasCollectionAccess: async (verifier, ids) => {
      const same = await this.#isPinnedUser(verifier);
      return ids.map(() => same);
    },
  });

  #identity?: { value: StoredIdentity; at: number };

  // What apply handlers may do. A plain object, not this class: its stub is the overseer's.
  readonly #actionHost: XActionHost = {
    refs: this.#refs,
    me: () => this.#me(),
    write: (op, options) => this.#write(op, options),
    read: (reserve, op) => this.#read(reserve, op),
    readImage: file => this.#files.read(file),
    releaseImages: drafts => {
      for (const draft of drafts) for (const image of draft.images ?? []) this.#files.delete(image.file);
    },
    progress: {
      get: id => this.ctx.storage.kv.get<string[]>(`${PROGRESS_PREFIX}${id}`) ?? [],
      put: (id, ids) => this.ctx.storage.kv.put(`${PROGRESS_PREFIX}${id}`, ids),
      delete: id => this.ctx.storage.kv.delete(`${PROGRESS_PREFIX}${id}`),
    },
    previous: {
      get: id => this.ctx.storage.kv.get<ListDetails | boolean | "unknown">(`${PREVIOUS_PREFIX}${id}`),
      put: (id, before) => this.ctx.storage.kv.put(`${PREVIOUS_PREFIX}${id}`, before),
      delete: id => this.ctx.storage.kv.delete(`${PREVIOUS_PREFIX}${id}`),
    },
    attempts: {
      get: key => this.ctx.storage.kv.get<SendAttempt>(`${ATTEMPT_PREFIX}${key}`),
      put: (key, attempt) => this.ctx.storage.kv.put(`${ATTEMPT_PREFIX}${key}`, attempt),
      delete: key => this.ctx.storage.kv.delete(`${ATTEMPT_PREFIX}${key}`),
    },
    invalidate: async () => this.#cache.invalidateAll(),
  };

  readonly #actions = actions.bind(this.#journal, this.#actionHost);

  readonly #sessionHost: XSessionHost = {
    me: options => this.#me(options),
    read: (reserve, op) => this.#read(reserve, op),
    cached: (key, ttlMs, load) => this.#cache.cached(key, ttlMs, load),
    pending: () => this.#journal.listPending(),
    resolve: id => this.#refs.resolve(id),
    allocate: kind => this.#refs.allocate(sequence => `~${sequence}`, { kind }),
    submit: (queue, kind, payload) => this.#submit(queue, kind, payload),
    captureImage: bytes => this.#captureImage(bytes),
  };

  async describe(): Promise<ResourceDescription> {
    const props = this.ctx.props;
    if (props.resourceKind === "account") {
      const me = await this.#me();
      return {
        url: ACCOUNT_URL, title: `@${me.username}`, snippet: me.name,
        suggestedBindingName: "X", tsType: "XAccountSession",
      };
    }
    // Descriptions are visible outside observation authorization. Never expose post text or List
    // metadata here, even if it was public when cached: privacy can change before the next open.
    // Discard descriptions written before this rule rather than returning their private snippets.
    if (props.resourceKind === "post" || props.resourceKind === "list") {
      this.ctx.storage.kv.delete(DESCRIPTION_KEY);
      return props.resourceKind === "post" ? {
        url: postUrl(props.postId), title: `X post ${props.postId}`, snippet: "",
        suggestedBindingName: "X_POST", tsType: "XPost",
      } : {
        url: listUrl(props.listId), title: `X List ${props.listId}`, snippet: "",
        suggestedBindingName: "X_LIST", tsType: "XList",
      };
    }
    // A profile description contains only public profile fields. Fetch it once to avoid billed
    // reads on every open; the pinned user ID prevents a reused handle from retargeting it.
    const stored = this.ctx.storage.kv.get<ResourceDescription>(DESCRIPTION_KEY);
    if (stored) return stored;
    const user = toUserInfo(await this.#profileUser(props.username), false);
    const description: ResourceDescription = {
      url: user.url, title: `@${user.username}`,
      snippet: `${user.name} · ${user.followersCount.toLocaleString("en-US")} ` +
        `follower${user.followersCount === 1 ? "" : "s"}`,
      suggestedBindingName: "X_PROFILE", tsType: "XProfile",
    };
    this.ctx.storage.kv.put(DESCRIPTION_KEY, description);
    return description;
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    const submits = BINDING_ACTIONS[this.ctx.props.resourceKind];
    return this.#actions.autoApprovableKinds().filter(kind => submits(kind.tag));
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<XSession> {
    // Two owners, as every capability has: a queue stub for staging actions, and a gate over another.
    const ctx = new SessionContext(this.#sessionHost, approvalQueue.dup(),
      new ObservationGate(approvalQueue.dup(), this.#observers));
    const props = this.ctx.props;
    switch (props.resourceKind) {
      case "account": return new XAccountSessionImpl(ctx);
      case "post": return new XPostImpl(ctx, props.postId);
      case "list": return new XListImpl(ctx, props.listId);
      case "profile": return new XProfileImpl(ctx, () => this.#profileUser(props.username));
    }
  }

  async applyAction(actionId: number, _cache: RpcStub<GitCache>): Promise<void> {
    await this.#housekeep();
    // Actions are fenced on the X user the connection is pinned to; see `#submit`.
    const { id } = await this.#me();
    await this.#actions.apply(actionId, { generation: id });
  }

  async rejectAction(actionId: number): Promise<void | { restart?: boolean }> {
    // Rejecting a post or List that later actions build on retires those too, and the gadget may
    // hold capabilities for its temporary ID: restart it rather than leave them dangling.
    const record = this.#journal.get(actionId);
    const provided = record ? providedRefs(record.action) : [];
    const builtOn = provided.length > 0 && this.#journal.listUndecided().some(({ id, action }) =>
      id !== actionId && dependedRefs(action).some(ref => provided.includes(ref)));
    await this.#actions.reject(actionId);
    return builtOn ? { restart: true } : undefined;
  }

  async revertAction(actionId: number): Promise<void | { message?: string; canRetry?: boolean; restart?: boolean }> {
    return await this.#actions.runExclusive(async (): Promise<RevertOutcome> => {
      const record = this.#journal.get(actionId);
      if (record?.state !== "applied") {
        return { message: "This action is too old to undo automatically.", canRetry: false };
      }
      let outcome: RevertOutcome;
      try {
        outcome = await revert(record.action, this.#actionHost);
      } catch (error) {
        // X's own refusal is final; anything else (a limit, an outage) may pass.
        const refused = error instanceof XApiError && error.status >= 400 && error.status < 500
          && !error.isAuthError && !(error instanceof XRateLimitError) && !(error instanceof XCreditsError);
        if (refused) return { message: `X refused to undo this action. ${error.message}`, canRetry: false };
        throw error;
      }
      if (outcome) return outcome;
      this.#journal.retire(actionId);
      await this.#actions.resolved("reverted");
    });
  }

  /**
   * Admits any observer, unless reads private to the account were recorded before they reported
   * subresources: then only one connected as the same X user. Every read since reports what
   * restricts it, which the Workshop checks through `verifyObserverAccess()`.
   */
  async addObserver(id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    await this.#observers.addObserver(id, user);
  }

  async removeObserver(id: string): Promise<void> {
    await this.#observers.removeObserver(id);
  }

  /**
   * Checks the `user/<id>` subresource reads private to the account report, failing the whole call
   * for any other ID, another X user's included. An observer is allowed only when their own
   * connection is pinned to this binding's X user (see `#isPinnedUser`): no request reaches X, and
   * nothing is remembered between calls.
   */
  async verifyObserverAccess(
      observers: { id: string; verifier: Fetcher<GatekeeperUserVerifier> }[],
      subresources: string[]): Promise<{ allowedObserverIds: string[] }> {
    const pinned = this.#pinnedUserId();
    for (const id of subresources) {
      if (parseXUserSubresource(id) !== pinned) {
        throw new Error("This subresource ID names a different X user than this binding is pinned to.");
      }
    }
    return await this.#verifyAccess(observers, subresources);
  }

  /**
   * Exports what reads recorded before they reported subresources: the `owner` collection, observed
   * or still pending (its read may have been recorded), as the pinned X user's `user/<id>`. Public
   * reads recorded nothing, and a Post or List binding's check that an observer could see the bound
   * post or List guarded admission, not data a read recorded, so nothing else is exported.
   */
  async getHistoricalSubresources(): Promise<string[]> {
    if (this.ctx.storage.kv.get(`${OBSERVED_PREFIX}${OWNER_COLLECTION}`) === undefined) return [];
    return [xUserSubresourceId(this.#pinnedUserId())];
  }

  // -- the connection ----------------------------------------------------------------------

  #account() {
    return this.ctx.exports.UserAccount.get(this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
  }

  /**
   * The X user the connection belongs to, pinned at the binding's first use. The account already
   * refuses a reconnect as anyone else; the pin keeps a binding from following one regardless.
   */
  async #me(options?: { maxAgeMs?: number }): Promise<StoredIdentity> {
    const now = Date.now();
    const memo = this.#identity;
    if (memo && now - memo.at < IDENTITY_MEMO_MS
      && (options?.maxAgeMs === undefined || now - memo.value.fetchedAt < options.maxAgeMs)) {
      return memo.value;
    }
    const identity = await this.#account().getIdentity(options);
    const kv = this.ctx.storage.kv;
    const pinned = kv.get<string>(PINNED_USER_KEY);
    if (pinned === undefined) {
      kv.put(PINNED_USER_KEY, identity.id);
    } else if (pinned !== identity.id) {
      throw new Error("This binding was made for a different X account than its connection now uses. " +
        "Remove it and bind the X resource again.");
    }
    this.#identity = { value: identity, at: now };
    return identity;
  }

  /** Runs a read as the connection, within its daily read limit; `reserve` is the rows expected. */
  async #read<T>(reserve: number, op: (api: XApi, me: StoredIdentity) => Promise<XEnvelope<T>>):
      Promise<XEnvelope<T>> {
    const me = await this.#me();
    return await withinReadLimit(this.#account(), reserve,
      () => this.#creds.run(creds => op(new XApi(creds.accessToken), me), { replayable: true }));
  }

  /** Runs a write as the connection. Writes are bounded by approvals, not by the read limit. */
  async #write<T>(op: (api: XApi, me: StoredIdentity) => Promise<T>, options?: { replayable?: boolean }):
      Promise<T> {
    const me = await this.#me();
    return await this.#creds.run(creds => op(new XApi(creds.accessToken), me),
      { replayable: options?.replayable === true });
  }

  /** The bound profile's user: looked up by handle once, then by the ID that lookup pinned. */
  async #profileUser(username: string): Promise<WireUser> {
    const kv = this.ctx.storage.kv;
    const pinned = kv.get<string>(PROFILE_USER_KEY);
    const user = await readUser(this.#sessionHost, pinned === undefined ? { username } : { id: pinned });
    if (pinned === undefined) kv.put(PROFILE_USER_KEY, user.id);
    return user;
  }

  // -- actions -----------------------------------------------------------------------------

  /**
   * Stages an action, fenced on the X user rather than the connection generation: a reconnect as
   * the same user to widen the grant must not strand what is waiting.
   */
  async #submit<K extends keyof XActions>(queue: ActionSubmitter, kind: K, payload: XActions[K]): Promise<number> {
    const { id } = await this.#me();
    return await this.#actions.submit(queue, kind, payload, { fence: { generation: id } });
  }

  /** Captures an image for a pending post, first sweeping images no pending post holds. */
  async #captureImage(bytes: Uint8Array): Promise<ActionFileReference> {
    const referenced = new Set(this.#journal.listPending().flatMap(({ action }) => imageHandles(action)));
    this.#files.pruneUnreferenced(referenced, Date.now() - IMAGE_GRACE_MS);
    return await this.#files.capture(bytes);
  }

  /**
   * Retires applied actions too old to revert, and drops the thread progress, send attempts and
   * List snapshots left by actions no longer waiting. Runs at most every few hours, from apply.
   */
  async #housekeep(): Promise<void> {
    const kv = this.ctx.storage.kv;
    const now = Date.now();
    if (now - (kv.get<number>(HOUSEKEEPING_KEY) ?? 0) < HOUSEKEEPING_INTERVAL_MS) return;
    kv.put(HOUSEKEEPING_KEY, now);
    try {
      await this.#actions.runExclusive(() => {
        let cursor: string | undefined;
        do {
          const page = this.#journal.listRetained({ limit: 100, ...(cursor === undefined ? {} : { cursor }) });
          for (const { id, action } of page.entries) {
            if ((action.payload.appliedAt ?? 0) < now - RETAINED_ACTION_TTL_MS) this.#journal.retire(id);
          }
          cursor = page.nextCursor;
        } while (cursor !== undefined);

        const waiting = new Set(this.#journal.listPending().map(({ id }) => id));
        const leftovers: string[] = [];
        for (const prefix of [PROGRESS_PREFIX, ATTEMPT_PREFIX, PREVIOUS_PREFIX]) {
          for (const [key] of kv.list({ prefix })) {
            if (!waiting.has(Number.parseInt(key.slice(prefix.length), 10))) leftovers.push(key);
          }
        }
        for (const key of leftovers) kv.delete(key);
      });
    } catch (error) {
      logger.warn("X gatekeeper housekeeping failed", { event: "x.housekeeping.failed", error });
    }
  }

  // -- observers ---------------------------------------------------------------------------

  /**
   * The X user this binding is pinned to. Every read pins it first, so a binding with none has made
   * no read whose observers need checking; asked anyway, this throws rather than answer for nobody.
   */
  #pinnedUserId(): string {
    const pinned = this.ctx.storage.kv.get<string>(PINNED_USER_KEY);
    if (pinned === undefined) throw new Error("This X binding has not read anything as its X account yet.");
    return pinned;
  }

  /**
   * Whether `verifier` stands for the X user this binding is pinned to, as the observer's own
   * connection names them, without a request to X. Not knowing is no denial: a connection that can
   * no longer vouch for anyone, or an account that can't answer, fails the check instead.
   */
  async #isPinnedUser(verifier: XVerifierApi): Promise<boolean> {
    const pinned = this.#pinnedUserId();
    const observer = await verifier.getXUserId();
    if (observer === null) {
      throw new Error("This collaborator's X connection has expired. They need to reconnect it " +
        "before they can observe this workspace.");
    }
    return observer === pinned;
  }
}
