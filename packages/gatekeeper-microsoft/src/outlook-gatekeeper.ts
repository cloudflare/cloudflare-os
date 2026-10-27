// The Outlook gatekeeper Durable Object: one per binding of a Microsoft 365 connection to a mailbox.
// It holds the binding's action journal, the temporary IDs of drafts and folders not yet created,
// captured attachment bytes, a read cache partitioned by connection, and observer records. It pins
// the Entra user the connection belongs to, and mints the sessions gadgets hold (outlook-session.ts).

import { DurableObject, restore, type RpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type {
  ActionKind, ApprovalQueue, Gatekeeper, GatekeeperUserVerifier, GitCache, ResourceDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { ActionFileStore } from "@gadgets/gatekeeper-kit/action-files";
import { ActionApplyError, ActionJournal } from "@gadgets/gatekeeper-kit/actions";
import { KvTtlCache } from "@gadgets/gatekeeper-kit/cache";
import { ProvisionalIds } from "@gadgets/gatekeeper-kit/simulation";
import TYPES_CODE from "./outlook-types.txt";
import { DESCRIPTION_TTL_MS, RETAINED_ACTION_TTL_MS, housekeep, isProvisional, PinnedUser, provisionalId, revertRefused } from "./binding";
import { GraphApi } from "./graph-api";
import { accountSource } from "./microsoft-credentials";
import { effectiveOutlookAccess, grantsSharedMailboxes, type Env, type OutlookGatekeeperProps } from "./microsoft-env";
import {
  actions, dependedRefs, fileHandles, providedRefs, requiredAccess, revert,
  type DraftVersion, type OutlookAction, type OutlookActionHost, type RevertOutcome,
} from "./outlook-actions";
import { MAX_ATTACHMENT_BYTES } from "./outlook-content";
import {
  OutlookHookDeliveryImpl, subscribeNewMessages, type OutlookHookDelivery, type OutlookHookParams, type OutlookHookTarget,
} from "./outlook-hooks";
import { outlookObservers } from "./outlook-observers";
import { allows, describeScope, outlookUrl, type OutlookAccessLevel } from "./outlook-scope";
import { MailboxGuard, OutlookContext, OutlookReaderImpl, OutlookSessionImpl, type OutlookSessionHost } from "./outlook-session";
import type { OutlookReader, OutlookSession } from "./outlook-types";


/** Most bytes the attachments of every pending action may hold together. */
const PENDING_FILE_BYTES = 64 * 1024 * 1024;
const FILE_GRACE_MS = 60 * 60 * 1000;

// Storage keys this class owns. binding.ts owns `pinnedUser` and `housekeptAt`; the kit modules own
// theirs: `outlook:` and the journal's tiers, `refs:`, `cache:@outlook:`, `files:`,
// `fileAllocations:`, `observer:`/`observedUnit:`.
const DESCRIPTION_KEY = "description";
const OWN_DRAFT_PREFIX = "ownDraft:";
/** The change key a draft had after this binding last wrote it: what a send of it is fenced on. */
const DRAFT_VERSION_PREFIX = "draftVersion:";

/** Which action tags each access level can submit, for the auto-approval catalog. */
const LEVEL_TAGS: Record<OutlookAccessLevel, readonly string[]> = {
  read: [],
  draft: ["outlook.organize", "outlook.drafts"],
  send: ["outlook.organize", "outlook.drafts"],
};

type Session = OutlookReader | OutlookSession;

/** The per-binding Outlook resource gatekeeper. */
@validateRpc()
export class OutlookGatekeeper extends DurableObject<Env, OutlookGatekeeperProps> implements Gatekeeper<Session> {
  readonly #creds = accountSource(this.ctx.exports, this.ctx.props.userObjectId);
  readonly #journal = new ActionJournal<OutlookAction>(this.ctx.storage.kv, { namespace: "outlook" });
  readonly #refs = new ProvisionalIds<string>(this.ctx.storage.kv, { namespace: "refs:", isProvisional });
  readonly #cache = KvTtlCache.partitionedBy(this.ctx.storage.kv, this.#creds, { name: "outlook" });
  readonly #files = new ActionFileStore(this.ctx.storage, {
    filePrefix: "files:", allocationPrefix: "fileAllocations:", maxFileBytes: MAX_ATTACHMENT_BYTES, maxTotalBytes: PENDING_FILE_BYTES,
  });
  readonly #observers = outlookObservers(this.ctx.storage.kv, () => this.#user.get());

  readonly #user = new PinnedUser(this.ctx.storage.kv, () => this.#account().getIdentity(), "Outlook");

  /** The mailbox as Exchange holds it now, for sessions and for the checks an approved action makes before writing. */
  readonly #mailbox = new MailboxGuard({
    scope: this.ctx.props.scope,
    owner: () => this.#user.get(),
    read: op => this.#graph(op, true),
    cached: (key, ttlMs, load) => this.#cache.cached(key, ttlMs, load),
    ownDrafts: () => new Set([...this.ctx.storage.kv.list<number>({ prefix: OWN_DRAFT_PREFIX })].map(([key]) => key.slice(OWN_DRAFT_PREFIX.length))),
  });

  readonly #actionHost: OutlookActionHost = {
    refs: this.#refs,
    graph: (op, options) => this.#graph(op, options?.replayable === true),
    readFile: file => this.#files.read(file),
    releaseFile: file => this.#files.delete(file),
    invalidate: async () => this.#cache.invalidateAll(),
    rememberDraft: id => this.ctx.storage.kv.put(OWN_DRAFT_PREFIX + id, Date.now()),
    noteDraftVersion: (id, version) => this.ctx.storage.kv.put<DraftVersion>(DRAFT_VERSION_PREFIX + id, version),
    draftVersion: id => this.ctx.storage.kv.get<DraftVersion>(DRAFT_VERSION_PREFIX + id),
    inScope: check => this.#inScope(check),
  };

  readonly #actions = actions.bind(this.#journal, this.#actionHost);

  #sessionHost(access: OutlookAccessLevel): OutlookSessionHost {
    return {
      ...this.#mailbox.host,
      access,
      owner: () => this.#user.get(),
      pending: () => this.#journal.listPending(),
      resolve: id => this.#refs.resolve(id),
      allocate: kind => this.#refs.allocate(provisionalId, { kind }),
      submit: async (queue, kind, payload) => {
        return await this.#actions.submit(queue, kind, payload, { fence: await this.#user.fence() });
      },
      capture: async bytes => {
        const referenced = new Set(this.#journal.listPending().flatMap(({ action }) => fileHandles(action)));
        this.#files.pruneUnreferenced(referenced, Date.now() - FILE_GRACE_MS);
        return await this.#files.capture(bytes);
      },
      subscribe: (ctx, hook) => this.#subscribe(ctx, hook),
      ...(this.env.AI ? { ai: this.env.AI } : {}),
    };
  }

  async describe(): Promise<ResourceDescription> {
    const scope = this.ctx.props.scope;
    const access = await this.#access();
    const tsType = access === "read" ? "OutlookReader" : access === "draft" ? "OutlookDrafter" : "OutlookSession";
    const kv = this.ctx.storage.kv;
    const stored = kv.get<{ value: ResourceDescription; at: number }>(DESCRIPTION_KEY);
    if (stored && Date.now() - stored.at < DESCRIPTION_TTL_MS) return { ...stored.value, tsType };
    const me = await this.#user.get();
    const mailboxName = scope.mailbox.kind === "shared" ? scope.mailbox.address : me.name;
    const title = scope.conversation ? scope.conversation.subject
      : scope.folder ? scope.folder.name
      : scope.mailbox.kind === "shared" ? scope.mailbox.address : "Outlook";
    const description: ResourceDescription = {
      url: outlookUrl(scope),
      title,
      snippet: describeScope(scope, mailboxName),
      suggestedBindingName: scope.mailbox.kind === "shared" ? "SHARED_MAILBOX"
        : scope.conversation ? "OUTLOOK_CONVERSATION" : scope.folder ? "OUTLOOK_FOLDER" : "OUTLOOK",
      tsType,
    };
    kv.put(DESCRIPTION_KEY, { value: description, at: Date.now() });
    return description;
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    const tags = LEVEL_TAGS[await this.#access()];
    return this.#actions.autoApprovableKinds().filter(kind => tags.includes(kind.tag));
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<Session> {
    const access = await this.#access();
    const ctx = new OutlookContext(this.#sessionHost(access), approvalQueue.dup(), this.#observers);
    return access === "read" ? new OutlookReaderImpl(ctx) : new OutlookSessionImpl(ctx);
  }

  [restore](_params: OutlookHookParams): OutlookHookDelivery {
    // The binding's own props decide what is delivered; a hook names nothing narrower.
    return new OutlookHookDeliveryImpl(async approvalQueue =>
      new OutlookContext(this.#sessionHost(await this.#access()), approvalQueue, this.#observers));
  }

  async applyAction(actionId: number, _cache: RpcStub<GitCache>): Promise<void> {
    await housekeep(this.ctx.storage.kv, this.#journal, this.#actions, "outlook", now => {
      // A draft this binding made is covered for as long as revert could reach it, then as any other.
      const kv = this.ctx.storage.kv;
      for (const [key, at] of kv.list<number>({ prefix: OWN_DRAFT_PREFIX })) {
        if (at < now - RETAINED_ACTION_TTL_MS) kv.delete(key);
      }
      for (const [key, version] of kv.list<DraftVersion>({ prefix: DRAFT_VERSION_PREFIX })) {
        if (version.at < now - RETAINED_ACTION_TTL_MS) kv.delete(key);
      }
    });
    // Access is checked when a session is minted; a change approved after the binding's owner, the
    // deployment or the grant lowered it waits, retryable, rather than landing.
    const record = this.#journal.get(actionId);
    if (record !== undefined && !allows(await this.#access(), requiredAccess(record.action))) {
      throw new Error("This connection no longer allows that change to Outlook.");
    }
    await this.#actions.apply(actionId, await this.#user.fence());
  }

  async rejectAction(actionId: number): Promise<void | { restart?: boolean }> {
    // Rejecting a draft or folder later actions build on retires those too, and the gadget may
    // hold its temporary ID: restart it rather than leave the ID dangling.
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
      if (record?.state !== "applied") return { message: "This action is too old to undo automatically.", canRetry: false };
      // An undo writes at the level its action did: one asked for after the ceiling dropped waits, as applying would.
      if (!allows(await this.#access(), requiredAccess(record.action))) {
        return { message: "This connection no longer allows that change to Outlook, so it wasn't undone.", canRetry: true };
      }
      let outcome: RevertOutcome;
      try {
        outcome = await revert(record.action, this.#actionHost);
      } catch (error) {
        return revertRefused(error, "Outlook");
      }
      if (outcome) return outcome;
      this.#journal.retire(actionId);
      await this.#cache.invalidateAll();
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

  /** What the binding, the deployment and the grant together allow: never more than any of them. */
  async #access(): Promise<OutlookAccessLevel> {
    const scopes = await this.#account().getGrantedScopes();
    const access = effectiveOutlookAccess(this.env, scopes, this.ctx.props.scope.access);
    if (access === null) throw new Error("This Microsoft 365 connection no longer grants Outlook access. Reconnect the Microsoft 365 account.");
    if (this.ctx.props.scope.mailbox.kind === "shared" && !grantsSharedMailboxes(scopes, access)) {
      throw new Error("This Microsoft 365 connection no longer grants access to shared mailboxes. Reconnect the Microsoft 365 account.");
    }
    return access;
  }


  async #graph<T>(op: (api: GraphApi) => Promise<T>, replayable: boolean): Promise<T> {
    await this.#user.get();
    return await this.#creds.run(creds => op(new GraphApi(creds.accessToken)), { replayable });
  }

  /** Proves what an approved action is about to write is still the binding's: see `OutlookActionHost.inScope`. */
  async #inScope({ messages = [], folder }: { messages?: readonly string[]; folder?: string }): Promise<void> {
    if (folder !== undefined && !(await this.#mailbox.coversFolder(folder))) {
      throw new ActionApplyError("That folder is no longer one this connection covers, so nothing was changed.");
    }
    if (messages.length === 0) return;
    const found = await this.#mailbox.mail(mail => mail.messages(messages));
    for (const message of found.values()) {
      if (!(await this.#mailbox.covers(message))) {
        throw new ActionApplyError(`"${message.subject}" is no longer in the mail this connection covers, so nothing was changed.`);
      }
    }
  }

  async #subscribe(ctx: OutlookContext, hook: RpcStub<OutlookHookTarget>): Promise<void> {
    await subscribeNewMessages({
      ctx,
      userObjectId: this.ctx.props.userObjectId,
      mailboxUser: await ctx.mailboxUser(),
      restore: params => this.ctx.restore(params),
      controller: props => this.ctx.exports.OutlookHookController({ props }),
      hook,
    });
  }
}
