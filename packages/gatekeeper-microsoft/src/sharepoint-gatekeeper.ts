// The per-binding gatekeeper Durable Object: one instance per binding of a Microsoft 365 connection to
// SharePoint, whatever its scope (everything, a site, a library, a folder, a file, a list or a page).
// It owns the binding's action journal, the temporary IDs of files, folders and list items not yet
// created, captured upload bytes, a read cache partitioned by connection, and its observer records.
// It pins the Entra user the connection belongs to, and mints the capabilities gadgets hold
// (sharepoint-session.ts). Every Graph request runs through the account's credential source.

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
import { ActionFileStore } from "@gadgets/gatekeeper-kit/action-files";
import { ActionJournal } from "@gadgets/gatekeeper-kit/actions";
import { KvTtlCache } from "@gadgets/gatekeeper-kit/cache";
import { ProvisionalIds } from "@gadgets/gatekeeper-kit/simulation";
import { SerialTaskQueue } from "@gadgets/gatekeeper-kit/serial-queue";
import TYPES_CODE from "./types.txt";
import { DESCRIPTION_TTL_MS, housekeep, isProvisional, PinnedUser, provisionalId, revertRefused } from "./binding";
import { GraphApi, GraphApiError } from "./graph-api";
import { accountSource } from "./microsoft-credentials";
import { effectiveSharePoint, type Env, type SharePointAccess, type SharePointGatekeeperProps, type SharePointSites } from "./microsoft-env";
import {
  actions,
  dependedRefs,
  fileHandles,
  providedRefs,
  revert,
  type RevertOutcome,
  type SharePointAction,
  type SharePointActionHost,
} from "./sharepoint-actions";
import { MAX_UPLOAD_BYTES } from "./sharepoint-content";
import { sharePointObservers } from "./sharepoint-observers";
import { effectiveRoles, getDrive, getItem } from "./sharepoint-reads";
import { ScopeGuard, type ScopeKind } from "./sharepoint-scope";
import { ScopeReader, SessionContext, SharePointReaderImpl, SharePointSessionImpl, type SessionHost } from "./sharepoint-session";
import type { SharePointReader, SharePointSession } from "./types";

/** Most bytes the uploads of every pending action may hold together. */
const PENDING_FILE_BYTES = 128 * 1024 * 1024;
/** How long captured bytes may go unreferenced before they are swept: past any submit in flight. */
const FILE_GRACE_MS = 60 * 60 * 1000;
/** How long the user's own role on the bound item is reused. A share changed in OneDrive applies within this long. */
const ROLE_TTL_MS = 2 * 60 * 1000;

// Storage keys of this class's own. binding.ts owns `pinnedUser` and `housekeptAt`; the kit modules
// own theirs: `sp:` and the journal's `retained:`/`applied:` tiers, `refs:`, `cache:@sharepoint:`,
// `files:`, `fileAllocations:`, and the observers' `observer:`/`observedUnit:`.
const DESCRIPTION_KEY = "description";

/** The binding name the agent sees for each kind of scope. */
/** The agent-facing type of a binding, by what its scope reaches and whether it can write. */
const TS_TYPES: Record<ScopeKind, Record<SharePointAccess, string>> = {
  all: { read: "SharePointReader", write: "SharePointSession" },
  site: { read: "SharePointReader", write: "SharePointSession" },
  library: { read: "SharePointFolderReader", write: "SharePointFolderSession" },
  folder: { read: "SharePointFolderReader", write: "SharePointFolderSession" },
  file: { read: "SharePointFileReader", write: "SharePointFileSession" },
  list: { read: "SharePointListScopeReader", write: "SharePointListScopeSession" },
  page: { read: "SharePointPageReader", write: "SharePointPageReader" },
};

const BINDING_NAMES: Record<ScopeKind, string> = {
  all: "SHAREPOINT",
  site: "SHAREPOINT_SITE",
  library: "SHAREPOINT_LIBRARY",
  folder: "SHAREPOINT_FOLDER",
  file: "SHAREPOINT_FILE",
  list: "SHAREPOINT_LIST",
  page: "SHAREPOINT_PAGE",
};

/** Which action tags each kind of binding can submit, for the auto-approval catalog. */
const BINDING_ACTIONS: Record<ScopeKind, (tag: string) => boolean> = {
  all: () => true,
  site: () => true,
  library: tag => tag.startsWith("sharepoint.files."),
  folder: tag => tag.startsWith("sharepoint.files."),
  // The file is the binding's top, which can be replaced but not renamed, moved or deleted.
  file: tag => tag === "sharepoint.files.edit",
  list: tag => tag.startsWith("sharepoint.lists."),
  page: () => false,
};

type Session = SharePointReader | SharePointSession;

/** One binding of a Microsoft 365 connection to SharePoint. */
@validateRpc()
export class SharePointGatekeeper extends DurableObject<Env, SharePointGatekeeperProps> implements Gatekeeper<Session> {
  readonly #creds = accountSource(this.ctx.exports, this.ctx.props.userObjectId);
  readonly #journal = new ActionJournal<SharePointAction>(this.ctx.storage.kv, { namespace: "sp" });
  readonly #refs = new ProvisionalIds<string>(this.ctx.storage.kv, {
    namespace: "refs:",
    isProvisional,
  });
  readonly #cache = KvTtlCache.partitionedBy(this.ctx.storage.kv, this.#creds, { name: "sharepoint" });
  readonly #files = new ActionFileStore(this.ctx.storage, {
    filePrefix: "files:",
    allocationPrefix: "fileAllocations:",
    maxFileBytes: MAX_UPLOAD_BYTES,
    maxTotalBytes: PENDING_FILE_BYTES,
  });
  readonly #observers = sharePointObservers(this.ctx.storage.kv, () => this.#user.get());
  /**
   * Writes prepare one at a time, across every session of this binding: each checks what is pending
   * before its slow steps (a download, an edit, capturing bytes), and two prepared together would
   * both pass and both be submitted, the second certain to fail at apply.
   */
  readonly #preparing = new SerialTaskQueue();

  readonly #user = new PinnedUser(this.ctx.storage.kv, () => this.#account().getIdentity(), "SharePoint");

  // What apply handlers may do. A plain object, not this class: its stub is the overseer's.
  readonly #actionHost: SharePointActionHost = {
    refs: this.#refs,
    graph: (op, options) => this.#graph(op, options?.replayable === true),
    // The same proof a session's reads make, at apply time: an item moved out of a bound folder
    // since the proposal is refused before the write.
    inScope: async ref => { await this.#guard().item(ref); },
    readFile: file => this.#files.read(file),
    releaseFile: file => this.#files.delete(file),
    invalidate: async () => this.#cache.invalidateAll(),
  };

  readonly #actions = actions.bind(this.#journal, this.#actionHost);

  #sessionHost({ access, sites }: { access: SharePointAccess; sites: SharePointSites }): SessionHost {
    return {
      scope: this.ctx.props.scope,
      access,
      sites,
      owner: () => this.#user.get(),
      read: op => this.#graph(op, true),
      cached: (key, ttlMs, load) => this.#cache.cached(key, ttlMs, load),
      pending: () => this.#journal.listPending(),
      resolve: id => this.#refs.resolve(id),
      allocate: kind => this.#refs.allocate(provisionalId, { kind }),
      submit: async (queue, kind, payload) => {
        return await this.#actions.submit(queue, kind, payload, { fence: await this.#user.fence() });
      },
      prepareExclusively: body => this.#preparing.run(body),
      capture: async bytes => {
        const referenced = new Set(this.#journal.listPending().flatMap(({ action }) => fileHandles(action)));
        this.#files.pruneUnreferenced(referenced, Date.now() - FILE_GRACE_MS);
        return await this.#files.capture(bytes);
      },
      readCaptured: file => this.#files.read(file),
      ...(this.env.AI ? { ai: this.env.AI } : {}),
    };
  }

  async describe(): Promise<ResourceDescription> {
    const scope = this.ctx.props.scope;
    const grant = await this.#grant();
    const tsType = TS_TYPES[scope.kind][grant.access];
    const kv = this.ctx.storage.kv;
    const stored = kv.get<{ value: ResourceDescription; at: number }>(DESCRIPTION_KEY);
    if (stored && Date.now() - stored.at < DESCRIPTION_TTL_MS) return { ...stored.value, tsType };

    let description: ResourceDescription;
    try {
      // The description is the session's own account of its scope, from the same reads.
      const root = await new ScopeReader(this.#sessionHost(grant)).root();
      const personal = scope.kind === "library" && root.location === "OneDrive";
      description = {
        url: root.webUrl,
        title: scope.kind === "all" ? "SharePoint & OneDrive" : root.name,
        snippet: scope.kind === "all" ? (await this.#user.get()).username ?? root.description : root.location,
        suggestedBindingName: personal ? "ONEDRIVE" : BINDING_NAMES[scope.kind],
        tsType,
      };
    } catch (error) {
      // A binding whose target went away still has to be listed, so the user can remove it.
      if (stored) return { ...stored.value, tsType };
      if (!(error instanceof GraphApiError) && !(error instanceof Error && /no longer exists/.test(error.message))) throw error;
      return { url: "", title: "Unavailable SharePoint item", snippet: error.message, suggestedBindingName: BINDING_NAMES[scope.kind], tsType };
    }
    kv.put(DESCRIPTION_KEY, { value: description, at: Date.now() });
    return description;
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    if ((await this.#grant()).access !== "write") return [];
    const submits = BINDING_ACTIONS[this.ctx.props.scope.kind];
    return this.#actions.autoApprovableKinds().filter(kind => submits(kind.tag));
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<Session> {
    const grant = await this.#grant();
    const ctx = new SessionContext(this.#sessionHost(grant), approvalQueue.dup(), this.#observers);
    return grant.access === "write" ? new SharePointSessionImpl(ctx) : new SharePointReaderImpl(ctx);
  }

  async applyAction(actionId: number, _cache: RpcStub<GitCache>): Promise<void> {
    await housekeep(this.ctx.storage.kv, this.#journal, this.#actions, "sharepoint");
    // Write access is checked when a session is minted; a change approved after the deployment,
    // the grant or the user's role withdrew it waits, retryable, rather than landing.
    if ((await this.#grant()).access !== "write") throw new Error("This connection no longer allows changes to SharePoint.");
    await this.#actions.apply(actionId, await this.#user.fence());
  }

  async rejectAction(actionId: number): Promise<void | { restart?: boolean }> {
    // Rejecting a folder or item that later actions build on retires those too, and the gadget may
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
      if (record?.state !== "applied") {
        return { message: "This action is too old to undo automatically.", canRetry: false };
      }
      // An undo writes too: one asked for after the deployment, the grant or the user's role
      // withdrew write access waits, as applying would.
      if ((await this.#grant()).access !== "write") {
        return { message: "This connection no longer allows changes to SharePoint, so nothing was undone.", canRetry: true };
      }
      let outcome: RevertOutcome;
      try {
        outcome = await revert(record.action, this.#actionHost);
      } catch (error) {
        return revertRefused(error, "SharePoint");
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

  #scopeGuard?: ScopeGuard;

  /** The scope's proofs for the overseer's own calls, which have no session. One guard, so its ancestry memo spans applies. */
  #guard(): ScopeGuard {
    this.#scopeGuard ??= new ScopeGuard(this.ctx.props.scope, {
      item: ref => this.#graph(api => getItem(api, ref), true),
      drive: driveId => this.#graph(api => getDrive(api, driveId), true),
    });
    return this.#scopeGuard;
  }

  #account() {
    return this.ctx.exports.UserAccount.get(this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
  }

  /**
   * Which sites the connection's grant reaches, and what the deployment, the grant and the user's
   * own role on the bound item together allow: never more than any of them. So a file shared with
   * the user to view binds read-only.
   */
  async #grant(): Promise<{ access: SharePointAccess; sites: SharePointSites }> {
    const grant = effectiveSharePoint(this.env, await this.#account().getGrantedScopes());
    if (grant === null) {
      throw new Error("This Microsoft 365 connection no longer grants SharePoint access. Reconnect the Microsoft 365 account.");
    }
    return { access: grant.access === "write" && !await this.#mayChange() ? "read" : grant.access, sites: grant.sites };
  }

  /**
   * Whether the user's role on the bound file, folder or library lets them change it. The role is
   * only lowered on Graph's word (`effectiveRoles`): where Graph is silent, or the read fails, the
   * binding keeps write and SharePoint refuses a change the user can't make, when it's applied.
   */
  async #mayChange(): Promise<boolean> {
    const scope = this.ctx.props.scope;
    if (scope.kind !== "folder" && scope.kind !== "file" && scope.kind !== "library") return true;
    const ref = scope.kind === "library" ? { driveId: scope.driveId } : { driveId: scope.driveId, itemId: scope.itemId };
    try {
      const roles = await this.#cache.cached("roles", ROLE_TTL_MS, () => this.#graph(api => effectiveRoles(api, ref), true));
      return roles === null || roles.some(role => role === "write" || role === "owner");
    } catch {
      return true;
    }
  }

  /** Runs a Graph call as the connection; reads are replayed once on a refreshed credential. */
  async #graph<T>(op: (api: GraphApi) => Promise<T>, replayable: boolean): Promise<T> {
    await this.#user.get();
    return await this.#creds.run(creds => op(new GraphApi(creds.accessToken)), { replayable });
  }
}
