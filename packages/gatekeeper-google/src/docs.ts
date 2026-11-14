/**
 * The Google Docs gatekeeper: a directly bound Doc's editor and its session, and the session a
 * Google Drive binding opens a Doc with.
 */

import { DurableObject, RpcTarget, RpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import {
  GatekeeperUserVerifier, Gatekeeper, ResourceDescription, ApprovalQueue, ActionKind, GitCache,
} from '@gadgets/workshop-shared/gatekeeper';
import { ActionJournal } from "@gadgets/gatekeeper-kit/actions";
import {
  GoogleDocSession, DocMetadata, type GoogleDocEditSession, type DocCommentOptions, type DocSuggestEditOptions,
  type GoogleDocReadSession, type GoogleDocTab,
} from "./docs-types";
import {
  DOC_COMMENT_ACTIONS, DocCommentSession, docsThreads, type DocCommentQueue,
} from "./doc-comments";
import { BLANK_DOC_TAB_ID, BlankGoogleDoc, GoogleDocsApi, type GoogleDocReader } from "./docs-api";
import { checkDocTabTitle, insertDocTab } from "./docs-tabs";
import {
  boundProps, createFileOnce, isSimulated, UNCREATED_FILE_ID, type SimulatedFileProps,
} from "./creation";
import {
  applyMarkdownEdit, canonicalizeMarkdownReplacement, computeReplaceOperations,
  MARKDOWN_RENDERING_VERSION,
} from "./markdown-converter";
import { DriveApi, DriveApiRequestError } from "./drive-api";
import { type DriveCommentAction } from "./drive-comments";
import { writeAttempts } from "./drive-writes";
import { fileSubresourceId, requireFileSubresources } from "./file-subresources";
import { driveModifiedTime, type NativeObservation, type NativeRead } from "./drive-session";
import type { DocSuggestion, DriveComment, DriveCommentReply } from "./drive-types";
import { verifyGoogleSubresourceAccess, type GoogleVerifierApi } from "./google-verifier-types";
import DOCS_READ_TYPES_CODE from "./docs-read-types.txt";
import DOCS_TYPES_CODE from "./docs-types.txt";
import COMMENT_TYPES_CODE from "./comment-types.txt";
import { obsContext } from "./observability.js";
import { AccessTokenCache, AccessTokenRequest } from "./auth-retry";
import { Mutex } from "./mutex";
import { ReadGate } from "./read-gate";
import { nativeFileUrl } from "./resources";
import { officeFileError, officeLabel } from "./office-conversion";
import { DOCS_TYPES_MODULE_PREFIX, stripTypeModulePrefix } from "./type-bundle";
import { PENDING_NEXT_ACTION_ID_KEY, PendingActionStore } from "./pending-actions";
import type { UserAccount } from "./google";
import {
  ADD_DOCUMENT_TAB_ACTION, adoptedGoogleDocTabId, assertGoogleDocActionMarkdownSize,
  describeDocEdit, DOC_ADDED_TABS_KEY, DOC_METADATA_REVISION_KEY, DOC_SNAPSHOT_KEY,
  DOC_SNAPSHOT_TTL_MS, DOC_WRITE_RECEIPT_KEY, docDefinition, EDIT_DOCUMENT_ACTION,
  findUniqueMarkdown, GoogleDocAction, GoogleDocAddTabAction, GoogleDocMetadataRevision,
  GoogleDocPendingAction, googleDocPendingFingerprint, googleDocRevisionUnchanged,
  googleDocSimulatedContent, GoogleDocSimulatedContent, GoogleDocSimulation,
  GoogleDocSimulationCacheHolder, GoogleDocSnapshot, googleDocSnapshot, googleDocTabLabel,
  googleDocTabMetadata, GoogleDocTabSnapshot, GoogleDocWriteMarker, GoogleDocWriteReceipt,
  invalidateGoogleDocAction, invalidateUnreplayableGoogleDocActions, isGoogleDocSnapshot,
  MAX_DOC_ADDED_TABS, newGoogleDocTab, parseGoogleDocWriteReceipt, PROVISIONAL_TAB_PREFIX,
  requireGoogleDocAppendIndex, resolveGoogleDocTab, storeInvalidator,
} from "./doc-actions";

const logger = obsContext.createLogger({ component: "gatekeeper.google", vendorId: "google" });

type Env = Cloudflare.Env;

let googleDocTypesCode: string | undefined;

/**
 * A directly bound Doc's bundle. It holds the comment declarations, which every Drive bundle holds
 * too, so the vendor's bundle takes them from here and from no Drive part.
 */
export function getGoogleDocTypesCode(): string {
  return googleDocTypesCode ??= [
    DOCS_READ_TYPES_CODE, COMMENT_TYPES_CODE,
    stripTypeModulePrefix(DOCS_TYPES_CODE, DOCS_TYPES_MODULE_PREFIX),
  ].join("\n");
}

// =======================================================================================
// Google Docs Gatekeeper
// =======================================================================================

export type GoogleDocGatekeeperImplProps =
  { userObjectId: string; documentId: string } | SimulatedFileProps;

/** The ID of the first tab of a document just created, for the real class to adopt pending edits. */
const CREATED_DOC_TAB_KEY = "createdDocTab";

/** Points every pending action naming tab `from`, as its target or as its parent, at tab `to`. */
function retargetGoogleDocActions(kv: DurableObjectStorage["kv"], from: string, to: string): void {
  let pendingActions = new PendingActionStore<GoogleDocAction>(kv);
  for (let { id, action } of pendingActions.list()) {
    if (action.type === "addTab") {
      if (action.parentTabId === from) pendingActions.put(id, { ...action, parentTabId: to });
    } else if (action.tabId === from) {
      pendingActions.put(id, { ...action, tabId: to });
    }
  }
}

/**
 * Hands the tab an add made from its provisional ID to the ID Google gave it: the actions queued
 * for it name Google's from now on, and the pair is kept, so an agent still holding the
 * provisional ID keeps reaching the tab.
 */
function adoptGoogleDocTab(
  kv: DurableObjectStorage["kv"], provisionalTabId: string, tabId: string,
): void {
  retargetGoogleDocActions(kv, provisionalTabId, tabId);
  let added = Object.entries(kv.get<Record<string, string>>(DOC_ADDED_TABS_KEY) ?? {});
  kv.put(DOC_ADDED_TABS_KEY,
    Object.fromEntries([...added, [provisionalTabId, tabId]].slice(-MAX_DOC_ADDED_TABS)));
}

/**
 * Moves the state a simulated document left in storage onto the created one: pending actions
 * naming the blank document's tab name the created document's first tab, and the cached reads of
 * the blank document are dropped.
 */
function adoptBlankDocument(kv: DurableObjectStorage["kv"], tabId: string): void {
  retargetGoogleDocActions(kv, BLANK_DOC_TAB_ID, tabId);
  kv.delete(DOC_SNAPSHOT_KEY);
  kv.delete(DOC_METADATA_REVISION_KEY);
  kv.delete(CREATED_DOC_TAB_KEY);
}

@validateRpc()
export class GoogleDocGatekeeperImpl
    extends DurableObject<Env, GoogleDocGatekeeperImplProps>
    implements Gatekeeper<GoogleDocSession> {
  #simulationCache: GoogleDocSimulationCacheHolder = { writes: 0 };

  // Serialize applying and rejecting actions, and creating the document, against each other. Every
  // network await below leaves the Durable Object's input gate open, and one action id can arrive
  // twice — the overseer marks a record approved only after applyAction() returns, so two approvals
  // of it both see it pending. Interleaved, both fetch the document and the loser writes content the
  // winner already committed; the write marker is no defence, since the winner's cleanup deletes it
  // before the loser looks. Two approvals of a creation would likewise create two documents.
  #actions = new Mutex();
  #tokens = new AccessTokenCache(opts => {
    let stub: DurableObjectStub<UserAccount> = this.ctx.exports.UserAccount.get(
        this.ctx.exports.UserAccount.idFromString(this.#bound.userObjectId));
    return stub.getAccessToken(opts);
  });
  // Comment writes keep the comment engine's own records. Their journal takes its IDs from the
  // edit store's counter, which holds the next unused ID and starts at 1 as a journal's does, so an
  // approval ID names one action of this binding, edit or comment: applyAction() and rejectAction()
  // tell the two apart by whether this journal holds it. A namespace would start a second counter.
  #commentJournal = new ActionJournal<DriveCommentAction>(this.ctx.storage.kv, {
    legacyKeys: { nextIdKey: PENDING_NEXT_ACTION_ID_KEY, recordPrefix: "docComments:action:" },
  });
  #commentAttempts = writeAttempts(this.ctx.storage.kv);
  #comments = DOC_COMMENT_ACTIONS.bind(this.#commentJournal, {
    // Read at apply: a Doc not created yet takes no comment writes, so none applies before it is.
    threads: docsThreads(() => this.#bound.documentId,
      new GoogleDocsApi(opts => this.#getAccessToken(opts)),
      new DriveApi(opts => this.#getAccessToken(opts))),
    docs: new GoogleDocsApi(opts => this.#getAccessToken(opts)),
    // Not gated on Drive's read and write choice, as the Doc's edits are not.
    writeRefusal: async () => undefined,
    attempts: this.#commentAttempts,
  });
  #reads = new ReadGate();

  constructor(ctx: DurableObjectState<GoogleDocGatekeeperImplProps>, env: Env) {
    super(ctx, env);
    // The real class's first start after applyCreation(): take over what the blank document left.
    let tabId = ctx.storage.kv.get<string>(CREATED_DOC_TAB_KEY);
    if (tabId !== undefined && !isSimulated(ctx.props)) {
      ctx.storage.transactionSync(() => adoptBlankDocument(ctx.storage.kv, tabId));
    }
  }

  /** The account and document this binding reaches, which a document not yet created has not. */
  get #bound(): { userObjectId: string; documentId: string } {
    return boundProps(this.ctx.props, "doc");
  }

  async #getAccessToken(opts?: AccessTokenRequest): Promise<string> {
    return this.#tokens.get(opts);
  }

  #readDocWriteReceipt(): GoogleDocWriteReceipt | undefined {
    return parseGoogleDocWriteReceipt(this.ctx.storage.kv.get<unknown>(DOC_WRITE_RECEIPT_KEY));
  }

  #clearDocWriteReceipt(markerId: string): void {
    if (this.#readDocWriteReceipt()?.markerId === markerId) {
      this.ctx.storage.kv.delete(DOC_WRITE_RECEIPT_KEY);
    }
  }


  /**
   * Hands one proven write from its pending action to a cleanup receipt, atomically.
   *
   * The cached snapshot goes with it. That snapshot predates this write, and once the action stops
   * being pending nothing overlays it, so a read interleaving with the cleanup below would report
   * content older than what is already committed. A read already awaiting Google sees the write
   * counted and fetches again rather than cache what it got.
   *
   * A write that added a tab hands that tab to the ID Google gave it in the same step, so no read
   * finds the add gone while the edits queued for its tab still name the provisional ID.
   */
  #handoffDocWriteReceipt(
    actionId: number,
    markerId: string,
    pendingActions: PendingActionStore<GoogleDocAction>,
    addedTab?: { provisionalTabId: string; tabId: string },
  ): void {
    this.ctx.storage.transactionSync(() => {
      let existing = this.#readDocWriteReceipt();
      if (existing && existing.markerId !== markerId) {
        throw new Error("A different Google Doc write receipt is already pending cleanup");
      }
      if (addedTab) adoptGoogleDocTab(this.ctx.storage.kv, addedTab.provisionalTabId, addedTab.tabId);
      this.ctx.storage.kv.put(DOC_WRITE_RECEIPT_KEY, { actionId, markerId });
      this.ctx.storage.kv.delete(DOC_SNAPSHOT_KEY);
      pendingActions.remove(actionId);
      this.#simulationCache.writes++;
    });
  }

  async describe(): Promise<ResourceDescription> {
    let props = this.ctx.props;
    if (isSimulated(props)) {
      let { title } = props.creation;
      return {
        url: nativeFileUrl("doc"),
        title,
        snippet: `Google Doc: ${title} (not created yet)`,
        suggestedBindingName: "GOOGLE_DOC",
        tsType: "GoogleDocSession",
      };
    }
    let api = new GoogleDocsApi(opts => this.#getAccessToken(opts));
    let doc = await api.getDocumentMetadata(props.documentId);
    // Docs reads an Office file as though it were native but refuses every edit to it, so only
    // Drive can say. When Drive cannot answer, the document is described as it reads.
    let mimeType = await new DriveApi(opts => this.#getAccessToken(opts))
      .getFile(props.documentId).then(file => file.mimeType, () => undefined);
    if (officeLabel("doc", mimeType) !== undefined) throw officeFileError("doc");
    return {
      url: nativeFileUrl("doc", props.documentId),
      title: doc.title,
      snippet: `Google Doc: ${doc.title}`,
      suggestedBindingName: "GOOGLE_DOC",
      tsType: "GoogleDocSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return getGoogleDocTypesCode();
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [EDIT_DOCUMENT_ACTION, ADD_DOCUMENT_TAB_ACTION, ...this.#comments.autoApprovableKinds()];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>)
      : Promise<GoogleDocSession> {
    let props = this.ctx.props;
    let pendingActions = new PendingActionStore<GoogleDocAction>(this.ctx.storage.kv);
    // Only an undecided or claimed comment write can be applied again, so no other marker is read.
    this.#commentAttempts.sweep(new Set(this.#commentJournal.listPending().map(({ id }) => id)));
    let comments: DocCommentQueue = {
      submit: (queue, kind, payload) => this.#comments.submit(queue, kind, payload),
      undecided: read => this.#reads.read(() => read(this.#commentJournal.listUndecided())),
    };
    // A blank document always has a revision, so the session never reaches Drive for one.
    let docsApi = isSimulated(props)
      ? new BlankGoogleDoc(props.creation.title)
      : new GoogleDocsApi(opts => this.#getAccessToken(opts));
    let driveApi = new DriveApi(opts => this.#getAccessToken(opts));
    let documentId = isSimulated(props) ? UNCREATED_FILE_ID : props.documentId;
    let queue = approvalQueue.dup();
    let cache = this.#simulationCache;
    let { kv } = this.ctx.storage;
    // What every read reports: the document, or nothing for one not created yet.
    let subresources = documentId === UNCREATED_FILE_ID
      ? [] : [fileSubresourceId({ kind: "document", fileId: documentId })];
    return new GoogleDocSessionImpl({
      docsApi, driveApi, documentId, approvalQueue: queue,
      read: async (fetch, observe) => {
        let value = await fetch();
        await queue.authorizeObservation({ ...observe(value), subresources });
        return value;
      },
      changes: {
        pending: () => pendingActions.list(),
        invalidate: storeInvalidator(pendingActions),
        cache,
        queue: async prepare => {
          let { action, result } = await prepare();
          await submitGoogleDocEdit(queue, pendingActions, cache, action);
          return result;
        },
        afterTurns: async () => {},
        adoptedTabId: tabId => adoptedGoogleDocTabId(kv, tabId),
        authorizesPreparation: false,
        simulates: true,
      },
      source: storedDocSource(docsApi, driveApi, documentId, this.ctx.storage, cache),
      comments,
    });
  }

  async applyAction(actionId: number, _cache: RpcStub<GitCache>): Promise<void> {
    return this.#actions.run(() => this.#isComment(actionId)
      ? this.#applyComment(actionId) : this.#applyAction(actionId));
  }

  async rejectAction(actionId: number): Promise<void | {restart?: boolean}> {
    return this.#actions.run(() => this.#isComment(actionId)
      ? this.#rejectComment(actionId) : this.#rejectAction(actionId));
  }

  /** Whether `actionId` names a comment write, pending or already applied, rather than an edit. */
  #isComment(actionId: number): boolean {
    return this.#commentJournal.get(actionId) !== undefined ||
      this.#commentJournal.wasApplied(actionId);
  }

  /**
   * Applies a comment write, and then drops its attempt marker, as a Drive binding does. A claim an
   * earlier apply left is handed back as undecided first: the marker decides whether its send is
   * looked for before anything is sent again. Comments depend on no edit, so they are applied in
   * any order.
   */
  #applyComment(actionId: number): Promise<void> {
    return this.#reads.resolve(async () => {
      if (this.#commentJournal.get(actionId)?.state === "claimed") {
        this.#commentJournal.restorePending(actionId);
      }
      await this.#comments.apply(actionId);
      this.#commentAttempts.delete(actionId);
    });
  }

  /** Withdraws a comment write. No edit waits on it, so nothing restarts. */
  #rejectComment(actionId: number): Promise<void> {
    return this.#reads.resolve(async () => {
      await this.#comments.reject(actionId);
      this.#commentAttempts.delete(actionId);
    });
  }

  async applyCreation(creator: Fetcher<GatekeeperUserVerifier>, configuration: string | null)
      : Promise<{class: DurableObjectClass<Gatekeeper<any>>, resourceUrl: string}> {
    return this.#actions.run(() => this.#applyCreation(creator, configuration));
  }

  async #applyCreation(creator: Fetcher<GatekeeperUserVerifier>, configuration: string | null)
      : Promise<{class: DurableObjectClass<Gatekeeper<any>>, resourceUrl: string}> {
    let { userObjectId, fileId, resourceUrl, getAccessToken: tokens } = await createFileOnce(
        this.ctx, creator, "doc", configuration,
        (title, getToken) => new GoogleDocsApi(getToken).createDocument(title));
    // Edits queued against the blank document name its tab, which the created one may not share.
    let [tab] = (await new GoogleDocsApi(tokens).getDocument(fileId)).tabs;
    this.ctx.storage.kv.put(CREATED_DOC_TAB_KEY, tab.tabId);
    return {
      class: this.ctx.exports.GoogleDocGatekeeperImpl({props: {userObjectId, documentId: fileId}}),
      resourceUrl,
    };
  }

  async #applyAction(actionId: number): Promise<void> {
    let { documentId } = this.#bound;
    let pendingActions = new PendingActionStore<GoogleDocAction>(this.ctx.storage.kv);
    let pending = pendingActions.list();
    let pendingIndex = pending.findIndex(({id}) => id === actionId);
    if (pendingIndex === -1) {
      throw new Error(`Unknown pending Google Doc action: ${actionId}`);
    }
    let action = pending[pendingIndex].action;
    // Left pending, not removed: the overseer keeps its own record when this throws, so removing
    // ours would answer the next retry with "unknown action" instead of the reason. Rejecting
    // clears both.
    if (action.invalidatedReason) {
      throw new Error(action.invalidatedReason);
    }

    let firstPending = pending.find(record => !record.action.invalidatedReason);
    if (firstPending?.id !== actionId) {
      throw new Error(
        `Google Doc edits must be approved in order. Approve earlier edit ` +
        `${firstPending?.id} before edit ${actionId}.`);
    }

    if (!action.writeId) {
      action.writeId = crypto.randomUUID();
      pendingActions.put(actionId, action);
    }
    let api = new GoogleDocsApi(opts => this.#getAccessToken(opts));
    let landed: { writeMarker?: GoogleDocWriteMarker; snapshot: GoogleDocSnapshot } | undefined;
    await docDefinition(action).apply(action, {
      api,
      documentId,
      mimeType: async () =>
        (await new DriveApi(opts => this.#getAccessToken(opts)).getFile(documentId)).mimeType,
      receipt: () => this.#readDocWriteReceipt(),
      clearReceipt: markerId => this.#clearDocWriteReceipt(markerId),
      saved: (id, saved) => pendingActions.put(id, saved),
      landed: (id, writeMarker, snapshot, addedTab) => {
        landed = { writeMarker, snapshot };
        if (writeMarker) this.#handoffDocWriteReceipt(id, writeMarker.id, pendingActions, addedTab);
        else pendingActions.remove(id);
      },
      unapplyable: async (id, unapplied, reason, snapshot) => {
        invalidateGoogleDocAction(pendingActions, { id, action: unapplied }, reason);
        this.#simulationCache.current = undefined;
        await this.ctx.storage.put(DOC_SNAPSHOT_KEY, snapshot);
      },
    }, { id: actionId });
    let { writeMarker, snapshot } = landed!;
    if (writeMarker) {
      try {
        await api.deleteNamedRange(documentId, writeMarker.id, writeMarker.tabId);
        this.#clearDocWriteReceipt(writeMarker.id);
      } catch (error) {
        logger.warn("failed to clean up Google Doc write marker", {
          event: "google.doc.write-marker.cleanup.failed", actionId, error,
        });
      }
    }
    this.#simulationCache.current = undefined;

    // The handoff dropped the snapshot this edit made stale. Only edits queued behind it need the
    // new revision now, to be replayed over it; otherwise the next read fetches it, and an approval
    // that nobody reads after costs no full document read. They are listed again, since the
    // handoff of an added tab pointed those queued for it at Google's ID.
    let later = pendingActions.list()
      .filter(record => record.id > actionId && !record.action.invalidatedReason);
    if (writeMarker && later.length === 0) return;
    try {
      let refreshedSnapshot = snapshot;
      if (writeMarker) {
        refreshedSnapshot = googleDocSnapshot(await api.getDocument(documentId));
      }
      await this.ctx.storage.put(DOC_SNAPSHOT_KEY, refreshedSnapshot);
      invalidateUnreplayableGoogleDocActions(
          storeInvalidator(pendingActions),
          refreshedSnapshot,
          later,
          `Pending Google Doc edits could not be replayed after edit ${actionId} was applied`);
    } catch (error) {
      logger.warn("failed to refresh Google Doc simulation after applying action", {
        event: "google.doc.simulation.refresh.failed", error,
      });
      await this.ctx.storage.delete(DOC_SNAPSHOT_KEY);
    }
  }

  async #rejectAction(actionId: number): Promise<void | {restart?: boolean}> {
    let pendingActions = new PendingActionStore<GoogleDocAction>(this.ctx.storage.kv);
    let pending = pendingActions.list();
    let index = pending.findIndex(({id}) => id === actionId);
    if (index === -1) {
      throw new Error(`Unknown pending Google Doc action: ${actionId}`);
    }

    let wasActive = !pending[index].action.invalidatedReason;

    pendingActions.remove(actionId);
    this.#simulationCache.current = undefined;
    await this.ctx.storage.delete(DOC_SNAPSHOT_KEY);

    if (wasActive && index < pending.length - 1) {
      return {restart: true};
    }
  }

  revertAction(action: number):
      Promise<void | {message?: string, canRetry?: boolean, restart?: boolean}> {
    throw new Error("revert is not implemented");
  }

  /**
   * Observer tracking — strategy B (ACL check, single unit). The binding is one document, so we just
   * confirm the observer can open it with their own token (hasDocAccess, via the Drive/Docs ACL).
   * The document is the atomic unit (everything read through this binding is that one doc), so no
   * observers are tracked and removeObserver is a no-op. The overseer re-runs addObserver on every
   * open, catching loss of access promptly.
   *
   * Reads now also report the document as a `docs/document/<documentId>` subresource, which
   * verifyObserverAccess checks; this check stays for the reads made before they did.
   */
  async addObserver(_id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    let verifier = user as unknown as Fetcher<GoogleVerifierApi>;
    if (!(await verifier.hasDocAccess(this.#bound.documentId))) {
      throw new Error(
        "This collaborator does not have access to the bound Google Doc, so they cannot be allowed " +
        "to observe data this workspace read from it.");
    }
  }

  async removeObserver(_id: string): Promise<void> {}

  /**
   * Checks the document subresource every read reports, failing the whole call for any other ID.
   * Each observer's UserAccount answers whether the Docs API opens the document for their own
   * account, reusing recent answers (see UserAccount.checkSubresourceAccess).
   */
  async verifyObserverAccess(
    observers: { id: string; verifier: Fetcher<GatekeeperUserVerifier> }[],
    subresources: string[],
  ): Promise<{ allowedObserverIds: string[] }> {
    requireFileSubresources(subresources, ["document"]);
    return verifyGoogleSubresourceAccess(observers, subresources);
  }
}

/**
 * Stores `action` in a directly bound Doc's store and submits it for approval with the card its
 * definition builds, removing it again if the submission fails. Nothing is awaited between the
 * store and the submission.
 */
async function submitGoogleDocEdit(
  approvalQueue: RpcStub<ApprovalQueue>,
  pendingActions: PendingActionStore<GoogleDocAction>,
  cache: GoogleDocSimulationCacheHolder,
  action: GoogleDocAction,
): Promise<void> {
  let definition = docDefinition(action);
  let presentation = describeDocEdit(action);
  let actionId = pendingActions.submit(action);
  cache.current = undefined;

  try {
    await approvalQueue.submitAction(actionId, {
      ...presentation,
      actionKind: definition.kind,
      autoApprovable: definition.autoApprovable,
    });
  } catch (error) {
    pendingActions.remove(actionId);
    cache.current = undefined;
    throw error;
  }
}

/** What a Doc session needs of its connection to show and queue edits. */
export type DocChangeQueue = {
  /**
   * The edits a read replays, oldest first. A connection that records an unreplayable edit in the
   * record itself lists it too, marked with `invalidatedReason`.
   */
  pending(): GoogleDocPendingAction[];
  /** Records that edit `record` can no longer be replayed, for `reason`. */
  invalidate(record: GoogleDocPendingAction, reason: string): void;
  /** The replay last computed and the writes landed, which the connection keeps per document. */
  cache: GoogleDocSimulationCacheHolder;
  /**
   * Runs `prepare` as a write's turn: after the writes called before it, and before those called
   * after it, whether or not the caller awaits each. Then queues the edit it returns for approval
   * before the next turn starts.
   */
  queue<T>(prepare: () => Promise<{ action: GoogleDocAction; result: T }>): Promise<T>;
  /**
   * Resolves once the writes called before this have had their turn, so that a read sent behind
   * them shows them. Never awaited from inside a turn, which would wait for itself.
   */
  afterTurns(): Promise<void>;
  /** `tabId`, or the ID Google gave the tab when it is the provisional ID of an applied add. */
  adoptedTabId(tabId: string | undefined): string | undefined;
  /**
   * Whether the read that prepares an edit is authorized when it succeeds, as on a connection
   * whose reads go through a scope check. A failed one always is, since it discloses something.
   */
  authorizesPreparation: boolean;
  /** Whether reads replay pending edits at all, which a read-only session's never do. */
  simulates: boolean;
};

/** The queue of a session nothing can be queued against: its reads see no pending edit. */
function noDocChanges(): DocChangeQueue {
  return {
    pending: () => [],
    invalidate: () => {},
    cache: { writes: 0 },
    queue: () => Promise.reject(new Error("This Google Doc is open read-only.")),
    afterTurns: () => Promise.resolve(),
    adoptedTabId: tabId => tabId,
    authorizesPreparation: false,
    simulates: false,
  };
}

/** Where a Doc session's document comes from, and what its title and date are read from. */
export type DocSource = {
  /** The document to replay pending edits over. */
  snapshot(): Promise<GoogleDocSnapshot>;
  /** Called with the snapshot of every read once that read is authorized. */
  approved(snapshot: GoogleDocSnapshot): void;
  /** The document's title and modification time, before pending edits move the time. */
  metadata(): Promise<{ title: string; modifiedAt: number }>;
  /** What a metadata read says it read. */
  metadataObservation: NativeObservation;
};

/** What a failed read says it read: the error says whether that tab, or that text, exists. */
const DOC_CONTENT_OBSERVATION: NativeObservation = {
  title: "Read Google Doc content",
  description: "Read the content of one tab of the document.",
};

/** What a read of the tab list says it read. */
const DOC_TABS_OBSERVATION: NativeObservation = {
  title: "List Google Doc tabs",
  description: "Read the document's tab names and hierarchy.",
};

/** A Doc session's construction. */
export type GoogleDocSessionOptions = {
  docsApi: GoogleDocReader;
  driveApi: DriveApi;
  documentId: string;
  approvalQueue: RpcStub<ApprovalQueue>;
  /** Every read goes through it, which reports what it read and proves the binding's scope. */
  read: NativeRead;
  changes: DocChangeQueue;
  source: DocSource;
  /** A directly bound Doc's comment writes; none for a Doc opened from Drive. */
  comments?: DocCommentQueue;
};

/** A failure a read resolves with, so that the read is authorized before it is thrown. */
class ReadFailure {
  constructor(readonly error: unknown) {}
}

/** The selected tab of a replay, with the snapshot and tabs it was computed over. */
type GoogleDocSelectedContent = GoogleDocSimulatedContent & {
  snapshot: GoogleDocSnapshot;
  tab: GoogleDocTabSnapshot;
};

/**
 * A Google Doc session: its reads, its edits and, bound directly, its comments. A Doc opened from
 * Drive is handed out through a wrapper: GoogleDocReadSessionImpl read-only, and
 * GoogleDocEditSessionImpl, with no comment method, read and write.
 */
@validateRpc()
export class GoogleDocSessionImpl extends RpcTarget implements GoogleDocSession {
  #docsApi: GoogleDocReader;
  #driveApi: DriveApi;
  #documentId: string;
  #approvalQueue: RpcStub<ApprovalQueue>;
  #read: NativeRead;
  #changes: DocChangeQueue;
  #source: DocSource;
  #comments: DocCommentSession | undefined;

  constructor(options: GoogleDocSessionOptions) {
    super();
    this.#docsApi = options.docsApi;
    this.#driveApi = options.driveApi;
    this.#documentId = options.documentId;
    this.#approvalQueue = options.approvalQueue;
    this.#read = options.read;
    this.#changes = options.changes;
    this.#source = options.source;
    let { comments } = options;
    this.#comments = comments && new DocCommentSession({
      documentId: this.#documentId, docs: this.#docsApi, drive: this.#driveApi, comments,
      approvalQueue: this.#approvalQueue,
      authorizeRead: description => this.#read(async () => undefined, () => description),
      onlyInPendingEdits: async (tabId, quote) => {
        if (this.#changes.pending().length === 0) return false;
        let { tab, markdown } = await this.#getSimulatedContent(tabId, "getContent");
        return !tab.markdown.includes(quote) && markdown.includes(quote);
      },
    });
  }

  [Symbol.dispose](): void {
    this.#approvalQueue[Symbol.dispose]();
  }

  #commentSession(): DocCommentSession {
    if (!this.#comments) throw new Error("This Google Doc session takes no comments.");
    return this.#comments;
  }

  listComments(): Promise<DriveComment[]> {
    return this.#commentSession().listComments();
  }

  comment(text: string, options: DocCommentOptions): Promise<DriveComment> {
    return this.#commentSession().comment(
      text, { ...options, tabId: this.#changes.adoptedTabId(options.tabId) });
  }

  suggestEdit(
    oldText: string, newText: string, options?: DocSuggestEditOptions,
  ): Promise<DocSuggestion> {
    return this.#commentSession().suggestEdit(oldText, newText,
      options && { ...options, tabId: this.#changes.adoptedTabId(options.tabId) });
  }

  reply(commentId: string, text: string): Promise<DriveCommentReply> {
    return this.#commentSession().reply(commentId, text);
  }

  resolve(commentId: string, text?: string): Promise<DriveCommentReply> {
    return this.#commentSession().resolve(commentId, text);
  }

  /**
   * The ID `tabId` names among `tabs`, a simulation's: `tabId` itself while the simulation lists
   * it, as it lists a provisional tab, edits replayed into it, until it sees the add's handoff
   * (even beside the tab Google made, which it lists once the add lands); otherwise Google's ID
   * for an applied add. Whatever is stored from it is read through `adoptedTabId()` again.
   */
  #simulatedTabId(tabs: GoogleDocTabSnapshot[], tabId: string | undefined): string | undefined {
    return tabId === undefined || tabs.some(tab => tab.tabId === tabId)
      ? tabId : this.#changes.adoptedTabId(tabId);
  }

  /**
   * Reads through the session's NativeRead with `fetch`, which reads the document from `source`,
   * and tells `source` of the snapshot once the read is authorized. A failure `fetch` resolves
   * with is authorized as `failed` and then thrown.
   */
  async #readDocument<T>(
    fetch: (snapshot: () => Promise<GoogleDocSnapshot>) => Promise<T | ReadFailure>,
    observe: (value: T) => NativeObservation,
    failed = DOC_CONTENT_OBSERVATION,
  ): Promise<T> {
    let used: GoogleDocSnapshot | undefined;
    let snapshot = async () => used = await this.#source.snapshot();
    let value = await this.#read(() => fetch(snapshot), result =>
      result instanceof ReadFailure ? failed : observe(result));
    if (used) this.#source.approved(used);
    if (value instanceof ReadFailure) throw value.error;
    return value;
  }

  /**
   * Runs `use`, which replays pending edits, over the snapshot `snapshot` resolves to, with the
   * same writes landed as when the snapshot was asked for: a write that lands meanwhile leaves the
   * queue without its edit while the snapshot predates it, so the snapshot is asked for again.
   * Nothing is awaited between that check and `use`.
   */
  async #settled<T>(
    snapshot: () => Promise<GoogleDocSnapshot>, use: (snapshot: GoogleDocSnapshot) => T,
  ): Promise<T> {
    for (;;) {
      let writes = this.#changes.cache.writes;
      let taken = await snapshot();
      if (writes === this.#changes.cache.writes) return use(taken);
    }
  }

  /** `snapshot` with every pending edit replayed over it, or as it is for a read-only session. */
  #replay(snapshot: GoogleDocSnapshot): GoogleDocSimulation {
    if (!this.#changes.simulates) return { tabs: snapshot.tabs, contentByTabId: new Map() };
    let { cache } = this.#changes;
    let pending = this.#changes.pending();
    let cached = cache.current;
    // An unknown revision cannot be shown to match, so the replay is recomputed.
    if (cached && cached.baseRevisionId !== undefined &&
        cached.baseRevisionId === snapshot.revisionId &&
        cached.pendingFingerprint === googleDocPendingFingerprint(pending)) {
      return cached.simulation;
    }

    let simulation = invalidateUnreplayableGoogleDocActions(
        (record, reason) => this.#changes.invalidate(record, reason),
        snapshot,
        pending,
        "Pending Google Doc edit could not be replayed against the current document");
    cache.current = {
      baseRevisionId: snapshot.revisionId,
      pendingFingerprint: googleDocPendingFingerprint(this.#changes.pending()),
      simulation,
    };
    return simulation;
  }

  /**
   * The selected tab's content with every pending edit replayed over `snapshot`.
   *
   * The selector is resolved before anything is replayed or cached, so naming a tab that does not
   * exist cannot disturb the pending queue.
   */
  #simulate(
    snapshot: GoogleDocSnapshot, tabId: string | undefined,
    operation: "getContent" | "replaceText" | "appendText",
  ): GoogleDocSelectedContent {
    let { tabs, contentByTabId } = this.#replay(snapshot);
    let tab = resolveGoogleDocTab({ ...snapshot, tabs }, this.#simulatedTabId(tabs, tabId), operation);
    let content = contentByTabId.get(tab.tabId) ?? googleDocSimulatedContent(tab);
    return { snapshot, tab, ...content };
  }

  /** {@link #simulate} over the snapshot the source holds, unauthorized: for a comment's check. */
  async #getSimulatedContent(
    tabId: string | undefined, operation: "getContent" | "replaceText" | "appendText",
  ): Promise<GoogleDocSelectedContent> {
    return this.#settled(() => this.#source.snapshot(), taken => this.#simulate(taken, tabId, operation));
  }

  /**
   * Runs `check` against the selected tab as it reads with every pending edit, to prepare an
   * edit. The read is authorized when the connection asks for it, and always when it fails, since
   * a refusal says something about the tab.
   */
  async #prepare<T>(
    tabId: string | undefined, operation: "replaceText" | "appendText",
    check: (selected: GoogleDocSelectedContent) => T,
  ): Promise<{ selected: GoogleDocSelectedContent; value: T }> {
    /** The queue the last check ran against, as the replay saw it. */
    let checkedOver: string | undefined;
    let fetch = async (snapshot: () => Promise<GoogleDocSnapshot>) => {
      try {
        return await this.#settled(snapshot, taken => {
          let selected = this.#simulate(taken, tabId, operation);
          let value = check(selected);
          checkedOver = googleDocPendingFingerprint(this.#changes.pending());
          return { selected, value };
        });
      } catch (error) {
        return new ReadFailure(error);
      }
    };
    if (this.#changes.authorizesPreparation) {
      // The check runs inside the read, and the read's authorization (and a folder's second scope
      // proof) is awaited after it. An approval or a rejection can land meanwhile, and the caller's
      // text was matched over the queue it moved: checked again, it could match other text than
      // the caller read. So the edit is refused, and the caller reads again.
      let prepared = await this.#readDocument(fetch, ({ selected }) => ({
        title: "Read Google Doc content",
        description: `Read tab ${googleDocTabLabel(selected.tab)} to change it.`,
      }));
      if (checkedOver !== googleDocPendingFingerprint(this.#changes.pending())) {
        throw new Error(`${operation}: an edit queued on this Doc was approved or rejected while ` +
          "this one was checked against it, so it was not queued. Read the Doc again and retry.");
      }
      return prepared;
    }
    let result = await fetch(() => this.#source.snapshot());
    if (result instanceof ReadFailure) {
      await this.#read(async () => undefined, () => DOC_CONTENT_OBSERVATION);
      throw result.error;
    }
    return result;
  }

  /**
   * Current title, and a modification time that moves forward with the edits still pending,
   * since `getContent()` already shows them.
   */
  async getMetadata(): Promise<DocMetadata> {
    await this.#changes.afterTurns();
    return this.#read(async () => {
      let { title, modifiedAt } = await this.#source.metadata();
      let lastModified = this.#changes.pending()
        .map(({action}) => action)
        .filter(action => !action.invalidatedReason)
        .reduce((latest, action) => Math.max(latest, action.submittedAt), modifiedAt);
      // UNCREATED_FILE_ID, empty, until the document is created.
      return { id: this.#documentId, title, lastModified: new Date(lastModified) };
    }, () => this.#source.metadataObservation);
  }

  async listTabs(): Promise<GoogleDocTab[]> {
    await this.#changes.afterTurns();
    return this.#readDocument(
      snapshot => this.#settled(snapshot, taken => this.#replay(taken).tabs.map(googleDocTabMetadata)),
      () => DOC_TABS_OBSERVATION);
  }

  async addTab(title: string, options: { parentTabId?: string; index?: number } = {})
      : Promise<string> {
    checkDocTabTitle(title);
    let { index } = options;
    let provisionalTabId = `${PROVISIONAL_TAB_PREFIX}${crypto.randomUUID()}`;
    return this.#changes.queue(async () => {
      let snapshot, simulation, action: GoogleDocAddTabAction, tabs, simulatedParent;
      try {
        ({ snapshot, simulation } = await this.#settled(() => this.#source.snapshot(),
          taken => ({ snapshot: taken, simulation: this.#replay(taken) })));
        simulatedParent = this.#simulatedTabId(simulation.tabs, options.parentTabId);
        tabs = insertDocTab(simulation.tabs, newGoogleDocTab({ provisionalTabId, title }),
          { parentTabId: simulatedParent, index });
        let parentTabId = this.#changes.adoptedTabId(simulatedParent);
        action = {
          type: "addTab",
          provisionalTabId,
          title,
          ...parentTabId === undefined ? {} : { parentTabId },
          ...index === undefined ? {} : { index },
          submittedAt: Date.now(),
          baseRevisionId: snapshot.revisionId,
          writeId: crypto.randomUUID(),
        };
      } catch (error) {
        // The error says whether that parent exists, and how many tabs it holds.
        await this.#read(async () => undefined, () => DOC_TABS_OBSERVATION);
        throw error;
      }

      let parent = simulation.tabs.find(tab => tab.tabId === simulatedParent);
      let siblings = tabs.filter(tab => tab.parentTabId === simulatedParent).length;
      action.display = {
        placement:
          `Add a new, empty tab ${parent ? `under tab ${googleDocTabLabel(parent)}` : "at the top level"}` +
          (index === undefined ? ", after the tabs already there." :
            `, at position ${index + 1} of ${siblings}.`),
      };
      return { action, result: provisionalTabId };
    });
  }

  async getContent(tabId?: string): Promise<string> {
    await this.#changes.afterTurns();
    let selected = await this.#readDocument(async snapshot => {
      try {
        return await this.#settled(snapshot, taken => this.#simulate(taken, tabId, "getContent"));
      } catch (error) {
        return new ReadFailure(error);
      }
    }, result => ({
      title: "Read Google Doc content",
      description: this.#changes.simulates
        ? `Read the full simulated content of tab ${googleDocTabLabel(result.tab)} as Markdown.`
        : `Read the current content of tab ${googleDocTabLabel(result.tab)} as Markdown.`,
    }));
    return selected.markdown;
  }

  async replaceText(oldMarkdown: string, newMarkdown: string, tabId?: string): Promise<void> {
    if (oldMarkdown === newMarkdown) {
      return;
    }
    assertGoogleDocActionMarkdownSize(oldMarkdown, newMarkdown);

    await this.#changes.queue(async () => {
      let { selected, value: renderedNewMarkdown } = await this.#prepare(
        tabId, "replaceText", selected => {
          let start = findUniqueMarkdown(
            selected.markdown, oldMarkdown, "replaceText", selected.tab.tabId,
          );
          let rendered = canonicalizeMarkdownReplacement(oldMarkdown, newMarkdown);
          applyMarkdownEdit(selected, start, start + oldMarkdown.length, rendered);
          // With no earlier edit to this tab, approval will build exactly these requests.
          if (selected.markdown === selected.tab.markdown) {
            computeReplaceOperations(selected.tab.sourceMap, selected.markdown, start,
              start + oldMarkdown.length, rendered, selected.tab.tabId);
          }
          return rendered;
        });
      let { snapshot, tab } = selected;

      let action: GoogleDocAction = {
        type: "replaceText",
        // Read again: the add of a tab selected before the await above may have applied since.
        tabId: this.#changes.adoptedTabId(tab.tabId),
        submittedAt: Date.now(),
        markdownVersion: MARKDOWN_RENDERING_VERSION,
        baseRevisionId: snapshot.revisionId,
        writeId: crypto.randomUUID(),
        oldMarkdown,
        newMarkdown,
        display: {
          tab: googleDocTabLabel(tab),
          ...(renderedNewMarkdown === newMarkdown ? {} : { rendered: renderedNewMarkdown }),
        },
      };
      return { action, result: undefined };
    });
  }

  async appendText(markdown: string, tabId?: string): Promise<void> {
    assertGoogleDocActionMarkdownSize(markdown);
    await this.#changes.queue(async () => {
      let { selected } = await this.#prepare(tabId, "appendText", selected => {
        requireGoogleDocAppendIndex(selected.appendIndex);
      });
      let { snapshot, tab } = selected;

      let action: GoogleDocAction = {
        type: "appendText",
        // Read again: the add of a tab selected before the await above may have applied since.
        tabId: this.#changes.adoptedTabId(tab.tabId),
        submittedAt: Date.now(),
        markdownVersion: MARKDOWN_RENDERING_VERSION,
        baseRevisionId: snapshot.revisionId,
        writeId: crypto.randomUUID(),
        markdown,
        display: { tab: googleDocTabLabel(tab) },
      };
      return { action, result: undefined };
    });
  }
}

/**
 * A directly bound Doc's document: the snapshot it stores, reused for the TTL and then while its
 * revision holds, and its title, dated by when this binding first saw the current revision.
 */
function storedDocSource(
  docsApi: GoogleDocReader, driveApi: DriveApi, documentId: string, storage: DurableObjectStorage,
  cache: GoogleDocSimulationCacheHolder,
): DocSource {
  async function fetchSnapshot(): Promise<GoogleDocSnapshot> {
    for (;;) {
      let writes = cache.writes;
      // A snapshot written before tabs existed has no tab list and is simply replaced.
      let cached = await storage.get<unknown>(DOC_SNAPSHOT_KEY);
      if (isGoogleDocSnapshot(cached) && Date.now() - cached.fetchedAt < DOC_SNAPSHOT_TTL_MS) {
        return cached;
      }
      let snapshot = isGoogleDocSnapshot(cached) &&
          await googleDocRevisionUnchanged(docsApi, documentId, cached)
        ? { ...cached, fetchedAt: Date.now() }
        : googleDocSnapshot(await docsApi.getDocument(documentId));
      // What Google returned before a write landed is stale: the edit is no longer pending to be
      // replayed over it, so it would read as missing, and edits queued after it could not replay.
      if (writes !== cache.writes) continue;
      await storage.put(DOC_SNAPSHOT_KEY, snapshot);
      return snapshot;
    }
  }

  /**
   * When this binding first saw `revisionId`, recording it if the revision is new.
   *
   * An unreadable record is re-observed rather than rejected: it only dates a revision, so the
   * worst a lost record costs is one timestamp that moves when the document did not. Two absent
   * revisions count as the same: a document that offers no change token must not look edited by
   * every read, which is the opposite of what a cache needs from the same comparison.
   */
  function observeDocRevision(revisionId?: string): number {
    let stored = storage.kv.get<unknown>(DOC_METADATA_REVISION_KEY);
    if (stored && typeof stored === "object") {
      let { revisionId: seen, observedAt } = stored as Partial<GoogleDocMetadataRevision>;
      if (seen === revisionId &&
          typeof observedAt === "number" && Number.isFinite(observedAt)) {
        return observedAt;
      }
    }
    let observedAt = Date.now();
    storage.kv.put<GoogleDocMetadataRevision>(
      DOC_METADATA_REVISION_KEY, { revisionId, observedAt });
    return observedAt;
  }

  /**
   * The modification time of a document Google reports no revision for.
   *
   * Without edit access there is no revision to date, so Drive is asked instead. An account
   * connected before per-resource grants may not hold the picker's metadata scope, leaving no
   * signal at all; the first observation then stands rather than every read looking like an edit.
   */
  async function modifiedWithoutRevision(): Promise<number> {
    try {
      return driveModifiedTime(await driveApi.getFile(documentId)).valueOf();
    } catch (error) {
      // Only a refused grant means no signal will ever arrive. A quota 403 (also 403), an outage
      // or a malformed body are transient or fixable, and dating the document from one would
      // report a changed document as unchanged for as long as Drive stays unhealthy.
      let refusedGrant = error instanceof DriveApiRequestError && error.status === 403 &&
          !error.isAccountWide;
      if (!refusedGrant) throw error;
      logger.warn("no Drive grant to date a Google Doc that has no revision", {
        event: "google.doc.metadata.drive.ungranted", error,
      });
      return observeDocRevision(undefined);
    }
  }

  return {
    // The snapshot and the queue replayed over it must come from one side of a write landing:
    // the handoff removes the write, and an added tab's handoff points the edits queued for it at
    // a tab an older snapshot lacks, which would invalidate them.
    snapshot: async () => {
      let snapshot, writes;
      do {
        writes = cache.writes;
        snapshot = await fetchSnapshot();
      } while (writes !== cache.writes);
      return snapshot;
    },
    approved: () => {},
    /**
     * Google Docs exposes no modification time, so the moment this binding first saw the current
     * revision stands in for it and is reused for as long as that revision holds: reading a
     * document must not make it look freshly edited. Without edit access there is no revision to
     * date, and Drive's own timestamp is used instead.
     */
    metadata: async () => {
      let metadata = await docsApi.getDocumentMetadata(documentId);
      let modifiedAt = metadata.revisionId === undefined
        ? await modifiedWithoutRevision()
        : observeDocRevision(metadata.revisionId);
      return { title: metadata.title, modifiedAt };
    },
    metadataObservation: {
      title: "Read Google Doc metadata",
      description: "Read the title and modification time of the document.",
    },
  };
}

/**
 * What a Doc opened from Drive learns from its binding about the document's other sessions: how
 * many writes have landed in it, and when its newest pending edit was queued.
 */
export type DocFreshness = {
  writes(): number;
  newestPending(): number;
  /** The newest pending edit's number, or 0: any edit queued since changes it. */
  newestQueued(): number;
};

/**
 * A Doc as a Drive binding opens one, on the snapshot it read last: reused for the TTL, then
 * confirmed still current before it is reused again. Only a revision a whole scope check approved
 * becomes reusable, since a revision fetched while the document was outside the binding must never
 * reach a later read; reads issued together share one fetch, each bracketing it with its own checks.
 *
 * Edits are shared by every session open on the document while each keeps its own snapshot, so
 * with `freshness` a snapshot is not reused once a write has landed since it was fetched, or once
 * an edit was queued after it, which another session may have checked against a newer revision;
 * and a fetch a write landed during is made again.
 */
export function driveDocSource(
  docsApi: GoogleDocReader, driveApi: DriveApi, documentId: string, freshness?: DocFreshness,
): DocSource {
  let writes = () => freshness?.writes() ?? 0;
  let queued = () => freshness?.newestQueued() ?? 0;
  /** The writes landed when each snapshot was fetched. */
  let fetchedAfter = new WeakMap<GoogleDocSnapshot, number>();
  /** A fetch still in flight, so reads issued together observe one revision. */
  let inFlight: Promise<GoogleDocSnapshot> | undefined;
  /** The last revision a completed scope check approved, the only one a later read may reuse. */
  let approved: GoogleDocSnapshot | undefined;
  let next = async (): Promise<GoogleDocSnapshot> => {
    for (;;) {
      let landed = writes();
      let newest = queued();
      // An edit queued while a request was out may have been checked against a newer revision
      // than the one it answers, so the replay over it would fail that edit.
      let moved = () => landed !== writes() || newest !== queued();
      let cached = approved;
      if (cached && fetchedAfter.get(cached) === landed &&
          (freshness?.newestPending() ?? 0) <= cached.fetchedAt) {
        if (Date.now() - cached.fetchedAt < DOC_SNAPSHOT_TTL_MS) return cached;
        if (await googleDocRevisionUnchanged(docsApi, documentId, cached)) {
          if (moved()) continue;
          cached.fetchedAt = Date.now();
          return cached;
        }
      }
      let snapshot = googleDocSnapshot(await docsApi.getDocument(documentId));
      // Fetched before a write landed, it would read the edit as neither made nor pending.
      if (moved()) continue;
      fetchedAfter.set(snapshot, landed);
      return snapshot;
    }
  };
  return {
    snapshot: () => inFlight ??= next().finally(() => { inFlight = undefined; }),
    // A slow guard must not republish its older revision over a newer one already approved.
    approved: snapshot => {
      if (snapshot.fetchedAt >= (approved?.fetchedAt ?? 0)) approved = snapshot;
    },
    metadata: async () => {
      let file = await driveApi.getFile(documentId);
      return { title: file.name, modifiedAt: driveModifiedTime(file).valueOf() };
    },
    metadataObservation: {
      title: "Read Google Doc metadata",
      description: "Read the current title and modification time of the Drive document.",
    },
  };
}

/** The read-only session a Drive binding opens a Doc with: a Doc session with nothing queued. */
@validateRpc()
export class GoogleDocReadSessionImpl extends RpcTarget implements GoogleDocReadSession {
  #session: GoogleDocSessionImpl;

  constructor(
    docsApi: GoogleDocsApi,
    driveApi: DriveApi,
    documentId: string,
    approvalQueue: RpcStub<ApprovalQueue>,
    read: NativeRead,
  ) {
    super();
    this.#session = new GoogleDocSessionImpl({
      docsApi, driveApi, documentId, approvalQueue, read,
      changes: noDocChanges(),
      source: driveDocSource(docsApi, driveApi, documentId),
    });
  }

  [Symbol.dispose](): void {
    this.#session[Symbol.dispose]();
  }

  getMetadata(): Promise<DocMetadata> {
    return this.#session.getMetadata();
  }

  listTabs(): Promise<GoogleDocTab[]> {
    return this.#session.listTabs();
  }

  getContent(tabId?: string): Promise<string> {
    return this.#session.getContent(tabId);
  }
}

/**
 * A Doc as a read and write Drive binding opens one: its reads and edits, and no comment method,
 * since the binding's own comment writes reach the file. It holds the session rather than
 * extending it, so its RPC surface has nothing else to call.
 */
@validateRpc()
export class GoogleDocEditSessionImpl extends RpcTarget implements GoogleDocEditSession {
  #session: GoogleDocSessionImpl;

  constructor(options: Omit<GoogleDocSessionOptions, "comments">) {
    super();
    this.#session = new GoogleDocSessionImpl(options);
  }

  [Symbol.dispose](): void {
    this.#session[Symbol.dispose]();
  }

  getMetadata(): Promise<DocMetadata> {
    return this.#session.getMetadata();
  }

  listTabs(): Promise<GoogleDocTab[]> {
    return this.#session.listTabs();
  }

  getContent(tabId?: string): Promise<string> {
    return this.#session.getContent(tabId);
  }

  replaceText(oldMarkdown: string, newMarkdown: string, tabId?: string): Promise<void> {
    return this.#session.replaceText(oldMarkdown, newMarkdown, tabId);
  }

  appendText(markdown: string, tabId?: string): Promise<void> {
    return this.#session.appendText(markdown, tabId);
  }
}
