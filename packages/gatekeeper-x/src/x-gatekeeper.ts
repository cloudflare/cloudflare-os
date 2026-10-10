// The per-binding gatekeeper Durable Object: one instance per binding of an X connection, whether to
// the whole account, one post, one List, or one profile. It owns the binding's action journal, the
// temporary IDs of posts and Lists not yet created, captured images, a read cache partitioned by
// connection, and its observer records. It pins the X user the connection belongs to, and mints the
// capabilities gadgets hold (x-sessions.ts). Every X request runs through the account's credential
// source, and every read draws on the connection's daily read limit.

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
import { ObservationGate, trackedCollectionObservers } from "@gadgets/gatekeeper-kit/observers";
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
import { accountSource, withinReadLimit, type StoredIdentity, type XVerifierApi } from "./x-credentials";
import { ACCOUNT_URL, VENDOR_ID, type Env, type ResourceKind, type XGatekeeperImplProps } from "./x-env";
import { toUserInfo, type WireUser } from "./x-normalize";
import {
  OWNER_COLLECTION,
  SessionContext,
  XAccountSessionImpl,
  XListImpl,
  XPostImpl,
  XProfileImpl,
  fetchList,
  fetchPost,
  readUser,
  type XSessionHost,
} from "./x-sessions";
import { listUrl, postUrl } from "./x-urls";

const logger = obsContext.createLogger({ component: "gatekeeper.x", vendorId: VENDOR_ID });

/** How long the connected identity is trusted in memory before the account is asked again. */
const IDENTITY_MEMO_MS = 60 * 1000;
/** How long an observer's account is trusted to see the bound post or List once it could. */
const VERDICT_TTL_MS = 60 * 60 * 1000;
/** Most bytes the images of every pending post may hold together. */
const PENDING_MEDIA_BYTES = 64 * 1024 * 1024;
/** How long a captured image may go unreferenced before it is swept: past any submit in flight. */
const IMAGE_GRACE_MS = 60 * 60 * 1000;
/** How long an applied action stays revertible. */
const RETAINED_ACTION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** How often housekeeping may run. */
const HOUSEKEEPING_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** A description's snippet, in characters. */
const SNIPPET_LENGTH = 100;

// Storage keys of this class's own. The kit modules own theirs: `x:` and the journal's
// `retained:`/`applied:` tiers, `refs:`, `cache:@x:`, `images:`, `imageAllocations:`, and the
// observers' `observer:`/`observed:`.
const PINNED_USER_KEY = "pinnedUserId";
const PROFILE_USER_KEY = "profileUserId";
const DESCRIPTION_KEY = "description";
const HOUSEKEEPING_KEY = "housekeptAt";
const VERDICT_PREFIX = "verdict:";
const PROGRESS_PREFIX = "progress:";
const ATTEMPT_PREFIX = "attempt:";
const PREVIOUS_PREFIX = "previous:";

/** Which action tags each kind of binding can submit, for the auto-approval catalog. */
const BINDING_ACTIONS: Record<ResourceKind, (tag: string) => boolean> = {
  account: () => true,
  post: tag => tag.startsWith("x.post."),
  list: tag => tag.startsWith("x.list."),
  profile: () => false,
};

type XSession = XAccountSession | XPost | XList | XProfile;

function snippet(text: string): string {
  const chars = [...text.replace(/\s+/g, " ").trim()];
  return chars.length > SNIPPET_LENGTH ? `${chars.slice(0, SNIPPET_LENGTH - 1).join("")}…` : chars.join("");
}

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

  // Observers (plans/x-gatekeeper.md §7): public reads need only an X account of the observer's
  // own; reads private to the account authorize against the synthetic `owner` collection, which
  // only the same X user may see.
  readonly #observers = trackedCollectionObservers<XVerifierApi>({
    kv: this.ctx.storage.kv,
    verifyBaseline: verifier => this.#verifyBaseline(verifier),
    hasCollectionAccess: async (verifier, ids) => {
      const pinned = this.ctx.storage.kv.get<string>(PINNED_USER_KEY);
      const observer = await verifier.getXUserId();
      return ids.map(id => id === OWNER_COLLECTION && pinned !== undefined && observer === pinned);
    },
    denyMessage: () => "This collaborator isn't connected as the X account this workspace read " +
      "private data from (bookmarks, likes, mutes, private Lists, or protected accounts' posts), " +
      "so they can't observe it.",
    vendorId: VENDOR_ID,
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
      get: id => this.ctx.storage.kv.get<ListDetails>(`${PREVIOUS_PREFIX}${id}`),
      put: (id, details) => this.ctx.storage.kv.put(`${PREVIOUS_PREFIX}${id}`, details),
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
    me: () => this.#me(),
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
    // Describing a post, List or profile costs a read, so it is fetched once and kept.
    const stored = this.ctx.storage.kv.get<ResourceDescription>(DESCRIPTION_KEY);
    if (stored) return stored;
    let description: ResourceDescription;
    switch (props.resourceKind) {
      case "post": {
        const { info: post } = await fetchPost(this.#sessionHost, props.postId);
        description = {
          url: post.url ?? postUrl(props.postId), title: `Post by @${post.author.username}`,
          snippet: snippet(post.text), suggestedBindingName: "X_POST", tsType: "XPost",
        };
        break;
      }
      case "list": {
        const list = await fetchList(this.#sessionHost, props.listId);
        description = {
          url: list.url ?? listUrl(props.listId), title: list.name,
          snippet: `List by @${list.owner.username} · ${list.memberCount.toLocaleString("en-US")} ` +
            `member${list.memberCount === 1 ? "" : "s"}`,
          suggestedBindingName: "X_LIST", tsType: "XList",
        };
        break;
      }
      case "profile": {
        const user = toUserInfo(await this.#profileUser(props.username), false);
        description = {
          url: user.url, title: `@${user.username}`,
          snippet: `${user.name} · ${user.followersCount.toLocaleString("en-US")} ` +
            `follower${user.followersCount === 1 ? "" : "s"}`,
          suggestedBindingName: "X_PROFILE", tsType: "XProfile",
        };
        break;
      }
    }
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

  async addObserver(id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    await this.#observers.addObserver(id, user);
  }

  async removeObserver(id: string): Promise<void> {
    await this.#observers.removeObserver(id);
  }

  // -- the connection ----------------------------------------------------------------------

  #account() {
    return this.ctx.exports.UserAccount.get(this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
  }

  /**
   * The X user the connection belongs to, pinned at the binding's first use. The account already
   * refuses a reconnect as anyone else; the pin keeps a binding from following one regardless.
   */
  async #me(): Promise<StoredIdentity> {
    const now = Date.now();
    if (this.#identity && now - this.#identity.at < IDENTITY_MEMO_MS) return this.#identity.value;
    const identity = await this.#account().getIdentity();
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
   * Admits an observer with a working X connection of their own and, for a Post or List binding,
   * an account that can see the bound post or List. This runs on every open and each probe is a
   * read billed to the observer, so a positive answer is remembered for an hour.
   */
  async #verifyBaseline(verifier: XVerifierApi): Promise<void> {
    const observer = await verifier.getXUserId();
    if (observer === null) {
      throw new Error("This collaborator's X connection has expired. They need to reconnect it " +
        "before they can observe this workspace.");
    }
    const props = this.ctx.props;
    if (props.resourceKind !== "post" && props.resourceKind !== "list") return;
    if (observer === this.ctx.storage.kv.get<string>(PINNED_USER_KEY)) return;
    const key = `${VERDICT_PREFIX}${observer}`;
    const verifiedAt = this.ctx.storage.kv.get<number>(key);
    if (verifiedAt !== undefined && Date.now() - verifiedAt < VERDICT_TTL_MS) return;
    const visible = props.resourceKind === "post"
      ? await verifier.canViewPost(props.postId)
      : await verifier.canViewList(props.listId);
    if (visible !== true) {
      throw new Error(`This collaborator's X account can't see the ${props.resourceKind === "post" ? "post" : "List"} ` +
        "this workspace is bound to, so they can't observe it.");
    }
    this.ctx.storage.kv.put(key, Date.now());
  }
}
