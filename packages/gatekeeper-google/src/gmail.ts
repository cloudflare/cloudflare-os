import {DurableObject, RpcStub, RpcTarget} from "cloudflare:workers";
import {skipRpcValidation, validateRpc} from "capnweb-validate";
import type {
  ActionDescription, ActionKind, ApprovalQueue, Cursor, Gatekeeper, GatekeeperUserVerifier,
  ObservationDescription, ResourceDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  base64UrlDecodedByteLength, decodeBase64UrlToBytes, enumerateGmailAttachments,
  emailRecipientToAddress, getGoogleAccountDescription, getGoogleAccountSubject, GmailApi,
  GmailApiError,
  GmailDraftFull, GmailDraftRaw, GmailDraftRef, GmailLabelRaw, GmailMessageFull, GmailMessageInfoRaw,
  GmailMessageRaw,
  GmailMessageRef,
  GmailNormalizedRecipients, GmailOutboundAttachment, GmailOutboundMessage, GmailOutboundSpec, GmailParsedDraft,
  GmailParsedDraftSnapshot, MAX_GMAIL_ATTACHMENT_BYTES, MAX_GMAIL_FORWARD_SOURCE_BYTES,
  extractRfc822Attachments, gmailMessageIdQueryValue, newGmailMessageId, normalizeAggregateRecipients,
  normalizeEmailRecipients, parseGmailDraft, parseGmailMessageMetadata, GmailThreadInfoRaw,
  summarizeGmailThread,
} from "./google-api";
import type {
  EmailAddress, EmailContent, GmailAttachment, GmailAttachmentEntry, GmailAttachmentInfo, GmailComposeOptions,
  GmailCustomLabel,
  GmailDraft, GmailDraftEntry, GmailDraftInfo, GmailDraftInput, GmailDraftPatch, GmailHeader,
  GmailLabel, GmailMessage, GmailMessageEntry, GmailMessageInfo, GmailMutableLabel,
  GmailReplyOptions, GmailScopedSession, GmailSession, GmailSystemLabel, GmailThread, GmailThreadEntry,
  GmailThreadInfo,
} from "./types";
import {
  combineGmailQueries, MAX_GMAIL_VISIBLE_THREAD_MESSAGES, validateGmailAddress, validateGmailBody,
  validateGmailBodyAlternatives, validateGmailLabelName, validateGmailQueryForGrouping,
  validateGmailRecipientCount, validateGmailRecipientMaximum, validateGmailSubject,
  validateOutboundFields,
} from "./gmail-validate";
import {
  GMAIL_MAILBOX_SCOPE, GmailCapabilityScope, gmailMessagesAllowedByScope, gmailMutationTarget,
  gmailRestrictedScope, gmailScopeAllowsMessage, groupGmailMessagesByThread,
} from "./gmail-scope";
import {
  applyGmailDraftPatch, canonicalizeGmailMutableLabel, CanonicalMutableLabel, GmailDecision,
  GmailDraftAttachmentState, GmailDraftOverlayAction, GmailDraftResource, GmailDraftSource,
  GmailDraftState, GmailForwardSnapshotReference, GmailForwardSnapshotStore,
  GmailLabelOverlayAction, GmailLabelResource, gmailDependencyError, gmailDraftFingerprint,
  gmailDraftStateFingerprint, newGmailLogicalId, overlayGmailDraft, overlayGmailLabels,
  PendingOverlayAction,
} from "./gmail-state";
import {AccessTokenCache, AccessTokenRequest} from "./auth-retry";
import {CursorPager, Pager} from "./cursor";
import TYPES_CODE from "./types.txt";

type Env = Cloudflare.Env;

const GMAIL_RESTRICTED_THREAD_PROVIDER_PAGE_SIZE = 500;
const GMAIL_RESTRICTED_THREAD_RESULT_PAGE_SIZE = 20;
const MAX_GMAIL_RESTRICTED_THREAD_MESSAGES = 1000;
const MAX_GMAIL_RESTRICTED_THREAD_PROVIDER_PAGES = 20;
const GMAIL_FORWARD_SNAPSHOT_ORPHAN_GRACE_MS = 60 * 60 * 1000;
// Keep draft inspection aligned with the maximum inline-forward message size.
const MAX_GMAIL_DRAFT_MIME_BYTES = MAX_GMAIL_FORWARD_SOURCE_BYTES;
const GMAIL_LOGICAL_ID_RE = /^[A-Za-z0-9_-]{1,256}$/;
const GMAIL_PROVIDER_ID_RE = /^[a-f0-9]{1,256}$/i;
const MAX_GMAIL_APPROVAL_DESCRIPTION_BYTES = 128 * 1024;

export type GmailGatekeeperImplProps = {
  userObjectId: string;
  searchQuery?: string;
  labelName?: string;
};

type GmailMutationOperation =
  | "archive" | "trash" | "markRead" | "markUnread" | "star" | "unstar"
  | "applyLabel" | "removeLabel";

type GmailSourceAttachment = GmailForwardSnapshotReference & {
  messageId: string;
  description: string;
  contentType?: "application/octet-stream";
};

type GmailMessageMutationAction = {
  type: "messageMutation";
  operation: GmailMutationOperation;
  target: ReturnType<typeof gmailMutationTarget>;
  labelId?: string;
  dependsOn?: number[];
};

type GmailSendAction = {
  type: "send";
  mode: "new" | "reply" | "forward";
  spec: GmailOutboundSpec;
  threadId?: string;
  sourceMessageId?: string;
  sourceAttachment?: GmailSourceAttachment;
  forwardFormat?: "inline";
};

type GmailDraftCreateAction = {
  type: "draftCreate";
  draft: GmailDraftState;
  sourceAttachment?: GmailSourceAttachment;
  dependsOn?: number[];
};

type GmailDraftUpdateAction = {
  type: "draftUpdate";
  draftId: string;
  after: GmailDraftState;
  expectedBefore: string;
  expectedProviderMessageId?: string;
  sourceAttachment?: GmailSourceAttachment;
  dependsOn?: number[];
};

type GmailDraftDeleteAction = {
  type: "draftDelete";
  draftId: string;
  expectedSnapshot: string;
  expectedProviderMessageId?: string;
  sourceAttachment?: GmailSourceAttachment;
  dependsOn?: number[];
};

type GmailDraftSendAction = {
  type: "draftSend";
  draftId: string;
  approved: GmailDraftState;
  expectedSnapshot: string;
  expectedProviderMessageId?: string;
  messageId?: string;
  sourceAttachment?: GmailSourceAttachment;
  dependsOn?: number[];
};

type GmailDraftWriteReceipt = {
  draftId: string;
  messageId: string;
  threadId?: string;
  missing?: true;
  unverified?: true;
};

type GmailSentMessageReceipt = {
  rfcMessageId: string;
  providerId: string;
  threadId: string;
};

type GmailSendFingerprint = {
  rfcMessageId: string;
  fingerprint: string;
};

type GmailDraftProviderBaseline = GmailDraftWriteReceipt & {
  fingerprint: string;
};

type GmailLabelCreateAction = {
  type: "labelCreate";
  label: GmailLabelResource;
  dependsOn?: number[];
};

type GmailLabelRenameAction = {
  type: "labelRename";
  labelId: string;
  name: string;
  expectedName: string;
  dependsOn?: number[];
};

type GmailLabelDeleteAction = {
  type: "labelDelete";
  labelId: string;
  dependsOn?: number[];
};

type GmailAction =
  | GmailMessageMutationAction | GmailSendAction | GmailDraftCreateAction
  | GmailDraftUpdateAction | GmailDraftDeleteAction | GmailDraftSendAction
  | GmailLabelCreateAction | GmailLabelRenameAction | GmailLabelDeleteAction;

const MESSAGE_MUTATION_LABELS = {
  archive: "Archive messages",
  trash: "Trash messages",
  markRead: "Mark messages as read",
  markUnread: "Mark messages as unread",
  star: "Star messages",
  unstar: "Unstar messages",
  applyLabel: "Apply labels to messages",
  removeLabel: "Remove labels from messages",
} satisfies Record<GmailMutationOperation, string>;

type GmailResourceActionType = Exclude<GmailAction["type"], "messageMutation" | "send" | "draftSend">;

const RESOURCE_ACTION_LABELS = {
  draftCreate: "Create drafts",
  draftUpdate: "Update drafts",
  draftDelete: "Delete drafts",
  labelCreate: "Create labels",
  labelRename: "Rename labels",
  labelDelete: "Delete labels",
} satisfies Record<GmailResourceActionType, string>;

function actionKinds(labels: Record<string, string>): ActionKind[] {
  return Object.entries(labels).map(([tag, label]) => ({tag, label}));
}

function gmailAutoApprovalMetadata(
    action: GmailAction,
): Partial<Pick<ActionDescription, "actionKind" | "autoApprovable">> {
  switch (action.type) {
  case "send":
  case "draftSend":
    return {};
  case "messageMutation":
    return {
      actionKind: {tag: action.operation, label: MESSAGE_MUTATION_LABELS[action.operation]},
      autoApprovable: true,
    };
  case "draftCreate":
  case "draftUpdate":
  case "draftDelete":
  case "labelCreate":
  case "labelRename":
  case "labelDelete":
    return {
      actionKind: {tag: action.type, label: RESOURCE_ACTION_LABELS[action.type]},
      autoApprovable: true,
    };
  default:
    action satisfies never;
    throw new Error(`Unknown Gmail action type: ${(action as GmailAction).type}`);
  }
}

// Legacy non-delivery actions remain applyable. Outbound records fail closed because this state
// cannot prove whether a previous implementation already attempted delivery.
type LegacyGmailAction =
  | {type: "archive" | "trash" | "markRead" | "markUnread"; threadId: string}
  | {type: "send"; to: string[]; subject: string; body: string}
  | {
      type: "reply";
      sourceMessageId: string;
      threadId: string;
      body: string;
      replyAll: boolean;
      sourceWasSent?: boolean;
    }
  | {type: "forward"; sourceMessageId: string; to: string[]; body?: string};

type StoredGmailAction = GmailAction | LegacyGmailAction;

class GmailStore {
  #storage: DurableObjectStorage;
  #kv: DurableObjectStorage["kv"];
  #forwardSnapshots: GmailForwardSnapshotStore;

  constructor(storage: DurableObjectStorage) {
    this.#storage = storage;
    this.#kv = storage.kv;
    this.#forwardSnapshots = new GmailForwardSnapshotStore(storage);
    const referencedHandles = new Set<string>();
    for (const {action} of this.listActions()) {
      const snapshot = actionSourceAttachment(action);
      if (snapshot && typeof (snapshot as Partial<GmailSourceAttachment>).handle === "string") {
        referencedHandles.add(snapshot.handle);
      }
    }
    for (const resource of this.listDrafts()) {
      if (resource.forwardSnapshot) referencedHandles.add(resource.forwardSnapshot.handle);
    }
    this.#forwardSnapshots.pruneUnreferenced(
      referencedHandles, Date.now() - GMAIL_FORWARD_SNAPSHOT_ORPHAN_GRACE_MS);
  }

  #actionKey(id: number) { return `pending:action:${id}`; }
  #draftKey(id: string) { return `gmail:draft:${id}`; }
  #draftAliasKey(id: string) { return `gmail:draftAlias:${id}`; }
  #labelKey(id: string) { return `gmail:label:${id}`; }
  #decisionKey(id: number) { return `gmail:decision:${id}`; }
  #applyingKey(id: number) { return `gmail:applying:${id}`; }
  #draftWriteReceiptKey(id: number) { return `gmail:draftWriteReceipt:${id}`; }
  #sendFingerprintKey(id: number) { return `gmail:sendFingerprint:${id}`; }
  #admittedLabelKey(id: string) { return `gmail:admittedLabel:${id}`; }
  #sentAliasKey(rfcMessageId: string) {
    return `gmail:sentAlias:${gmailMessageIdQueryValue(rfcMessageId)}`;
  }
  #sentProviderKey(providerId: string) { return `gmail:sentProvider:${providerId}`; }

  #bumpActionGeneration(): void {
    this.#kv.put("pending:actionGeneration", this.actionGeneration() + 1);
  }

  actionGeneration(): number {
    return this.#kv.get<number>("pending:actionGeneration") ?? 0;
  }

  submit(action: StoredGmailAction): number {
    const id = this.#kv.get<number>("pending:nextActionId") ?? 1;
    this.#kv.put("pending:nextActionId", id + 1);
    this.#kv.put(this.#actionKey(id), action);
    this.#bumpActionGeneration();
    return id;
  }

  getAction(id: number): StoredGmailAction | undefined {
    return this.#kv.get<StoredGmailAction>(this.#actionKey(id));
  }

  listActions(): Array<{id: number; action: StoredGmailAction}> {
    return [...this.#kv.list<StoredGmailAction>({prefix: "pending:action:"})]
      .map(([key, action]) => ({id: Number(key.slice("pending:action:".length)), action}))
      .filter(item => Number.isSafeInteger(item.id))
      .toSorted((a, b) => a.id - b.id);
  }

  removeAction(id: number): void {
    const existed = this.getAction(id) !== undefined;
    this.#kv.delete(this.#actionKey(id));
    this.#kv.delete(this.#draftWriteReceiptKey(id));
    this.#kv.delete(this.#sendFingerprintKey(id));
    if (existed) this.#bumpActionGeneration();
  }

  markApplying(id: number): void { this.#kv.put(this.#applyingKey(id), Date.now()); }
  isApplying(id: number): boolean { return this.#kv.get<number>(this.#applyingKey(id)) !== undefined; }
  clearApplying(id: number): void { this.#kv.delete(this.#applyingKey(id)); }

  setDraftWriteReceipt(id: number, receipt: GmailDraftWriteReceipt): void {
    this.#kv.put(this.#draftWriteReceiptKey(id), receipt);
  }

  getDraftWriteReceipt(id: number): GmailDraftWriteReceipt | undefined {
    return this.#kv.get<GmailDraftWriteReceipt>(this.#draftWriteReceiptKey(id));
  }

  setSendFingerprint(id: number, rfcMessageId: string, fingerprint: string): void {
    this.#storage.transactionSync(() => {
      const action = this.getAction(id);
      const expectedMessageId = action?.type === "send"
        ? ("spec" in action ? action.spec.messageId : undefined)
        : action?.type === "draftSend" ? action.messageId : undefined;
      const current = this.#kv.get<GmailSendFingerprint>(this.#sendFingerprintKey(id));
      if (!action || expectedMessageId !== rfcMessageId ||
          (current && (current.rfcMessageId !== rfcMessageId ||
            current.fingerprint !== fingerprint))) {
        throw new Error("The approved Gmail send fingerprint changed unexpectedly.");
      }
      this.#kv.put(this.#sendFingerprintKey(id), {rfcMessageId, fingerprint});
    });
  }

  getSendFingerprint(id: number, rfcMessageId: string): string | undefined {
    const stored = this.#kv.get<GmailSendFingerprint>(this.#sendFingerprintKey(id));
    if (!stored) return undefined;
    if (stored.rfcMessageId !== rfcMessageId) {
      throw new Error("The stored Gmail send fingerprint belongs to another message.");
    }
    return stored.fingerprint;
  }

  #recordSentMessage(
      rfcMessageId: string, message: {id: string; threadId: string}): GmailSentMessageReceipt {
    const normalizedId = `<${gmailMessageIdQueryValue(rfcMessageId)}>`;
    const receipt = {rfcMessageId: normalizedId, providerId: message.id, threadId: message.threadId};
    const byAlias = this.#kv.get<GmailSentMessageReceipt>(this.#sentAliasKey(normalizedId));
    const byProvider = this.#kv.get<GmailSentMessageReceipt>(this.#sentProviderKey(message.id));
    for (const existing of [byAlias, byProvider]) {
      if (existing && (existing.rfcMessageId !== receipt.rfcMessageId ||
          existing.providerId !== receipt.providerId || existing.threadId !== receipt.threadId)) {
        throw new Error("The sent Gmail message receipt conflicts with an existing mapping.");
      }
    }
    this.#kv.put(this.#sentAliasKey(normalizedId), receipt);
    this.#kv.put(this.#sentProviderKey(message.id), receipt);
    return receipt;
  }

  completeSentAction(
      actionId: number, rfcMessageId: string,
      message: {id: string; threadId: string}): StoredGmailAction {
    return this.#storage.transactionSync(() => {
      const action = this.getAction(actionId);
      const expectedMessageId = action?.type === "send"
        ? ("spec" in action ? action.spec.messageId : undefined)
        : action?.type === "draftSend" ? action.messageId : undefined;
      if (!action || !this.isApplying(actionId) || expectedMessageId !== rfcMessageId) {
        throw new Error("The pending Gmail send changed before completion.");
      }
      this.#recordSentMessage(rfcMessageId, message);
      if (action.type === "draftSend") {
        const resource = this.getDraft(action.draftId);
        if (!resource || resource.status !== "active") {
          throw new Error("The Gmail draft resource changed before send completion.");
        }
        resource.status = "sent";
        resource.version++;
        delete resource.forwardSnapshot;
        delete resource.forwardBody;
        delete resource.forwardHtml;
        this.putDraft(resource);
      }
      this.setDecision(actionId, "applied");
      this.removeAction(actionId);
      this.clearApplying(actionId);
      this.pruneDecisions();
      return action;
    });
  }

  sentMessageByRfcMessageId(rfcMessageId: string): GmailSentMessageReceipt | undefined {
    return this.#kv.get<GmailSentMessageReceipt>(this.#sentAliasKey(rfcMessageId));
  }

  isSentMessage(providerId: string): boolean {
    return this.#kv.get<GmailSentMessageReceipt>(this.#sentProviderKey(providerId)) !== undefined;
  }

  hasPendingSend(rfcMessageId: string): boolean {
    const normalizedId = `<${gmailMessageIdQueryValue(rfcMessageId)}>`;
    return this.listActions().some(({action}) =>
      (action.type === "send" && "spec" in action && action.spec.messageId === normalizedId) ||
      (action.type === "draftSend" && action.messageId === normalizedId));
  }

  hasApplyingDraftSend(logicalId: string): boolean {
    return this.listActions().some(({id, action}) => action.type === "draftSend" &&
      this.isApplying(id) && this.resolveDraftId(action.draftId) === logicalId);
  }

  markDraftWriteMissing(id: number, expected: GmailDraftWriteReceipt): void {
    this.#storage.transactionSync(() => {
      const current = this.getDraftWriteReceipt(id);
      if (current?.draftId === expected.draftId && current.messageId === expected.messageId &&
          current.threadId === expected.threadId) {
        this.setDraftWriteReceipt(id, {...current, missing: true});
      }
    });
  }

  completeMissingDraftUpdate(actionId: number): StoredGmailAction {
    return this.#storage.transactionSync(() => {
      const action = this.getAction(actionId);
      const receipt = this.getDraftWriteReceipt(actionId);
      if (action?.type !== "draftUpdate" || !this.isApplying(actionId) || !receipt?.missing) {
        throw new Error("The missing Gmail draft update changed before completion.");
      }
      const logicalId = this.resolveDraftId(action.draftId);
      const resource = this.getDraft(logicalId);
      if (!resource || (resource.status !== "active" && resource.status !== "deleted") ||
          resource.providerId !== receipt.draftId) {
        throw new Error("The Gmail draft resource changed before missing update completion.");
      }
      if (resource.status === "active") {
        resource.status = "deleted";
        resource.version++;
      }
      delete resource.forwardSnapshot;
      delete resource.forwardBody;
      delete resource.forwardHtml;
      this.putDraft(resource);
      this.setDecision(actionId, "applied");
      this.removeAction(actionId);
      this.clearApplying(actionId);
      this.pruneDecisions();
      return action;
    });
  }

  setDecision(id: number, decision: GmailDecision): void {
    this.#kv.put(this.#decisionKey(id), decision);
  }

  decisions(): Map<number, GmailDecision> {
    return new Map([...this.#kv.list<GmailDecision>({prefix: "gmail:decision:"})]
      .map(([key, decision]) => [Number(key.slice("gmail:decision:".length)), decision]));
  }

  pruneDecisions(): void {
    const needed = new Set<number>();
    for (const {action} of this.listActions()) {
      if ("dependsOn" in action) {
        for (const dependency of action.dependsOn ?? []) needed.add(dependency);
      }
    }
    for (const id of this.decisions().keys()) {
      if (!needed.has(id)) this.#kv.delete(this.#decisionKey(id));
    }
  }

  resolveDraftId(id: string): string {
    const seen = new Set<string>();
    let current = id;
    while (true) {
      if (seen.has(current) || seen.size >= 16) {
        throw new Error("Stored Gmail draft aliases are invalid.");
      }
      seen.add(current);
      const next = this.#kv.get<unknown>(this.#draftAliasKey(current));
      if (next === undefined) return current;
      if (typeof next !== "string" || next.length === 0) {
        throw new Error("Stored Gmail draft alias is invalid.");
      }
      current = next;
    }
  }

  getDraft(id: string): GmailDraftResource | undefined {
    return this.#kv.get<GmailDraftResource>(this.#draftKey(this.resolveDraftId(id)));
  }

  putDraft(resource: GmailDraftResource): void {
    this.#kv.put(this.#draftKey(resource.logicalId), resource);
  }

  deleteDraft(id: string): void {
    const resolved = this.resolveDraftId(id);
    this.#kv.delete(this.#draftKey(resolved));
    for (const [key, target] of this.#kv.list<unknown>({prefix: "gmail:draftAlias:"})) {
      if (target === resolved || key === this.#draftAliasKey(id)) this.#kv.delete(key);
    }
  }

  listDrafts(): GmailDraftResource[] {
    return [...this.#kv.list<GmailDraftResource>({prefix: "gmail:draft:"})].map(([, value]) => value);
  }

  draftForProvider(providerId: string): GmailDraftResource | undefined {
    return this.listDrafts().find(resource => resource.providerId === providerId);
  }

  mapDraftToProvider(
      logicalId: string, providerId: string,
      expectedApplyingCreateId?: number,
      afterMap?: (resource: GmailDraftResource) => void): GmailDraftResource {
    return this.#storage.transactionSync(() => {
      const resolved = this.resolveDraftId(logicalId);
      const resource = this.#kv.get<GmailDraftResource>(this.#draftKey(resolved));
      if (!resource) throw new Error("Unknown Gmail draft resource.");
      if (resource.status !== "active") {
        throw new Error("The Gmail draft resource is no longer active.");
      }
      if (resource.providerId && resource.providerId !== providerId) {
        throw new Error("The Gmail draft resource is already mapped to another provider draft.");
      }
      if (expectedApplyingCreateId !== undefined) {
        const create = this.getAction(expectedApplyingCreateId);
        if (create?.type !== "draftCreate" || !this.isApplying(expectedApplyingCreateId) ||
            this.resolveDraftId(create.draft.logicalId) !== resource.logicalId) {
          throw new Error("The uncertain Gmail draft create changed while it was being reconciled.");
        }
      }
      const duplicate = this.listDrafts().find(candidate =>
        candidate.providerId === providerId && candidate.logicalId !== resource.logicalId);
      if (duplicate) {
        if (this.listActions().some(({action}) => action.type === "draftCreate" &&
            this.resolveDraftId(action.draft.logicalId) === duplicate.logicalId)) {
          throw new Error("Gmail returned a provider draft ID already owned by another pending create.");
        }
        this.#kv.delete(this.#draftKey(duplicate.logicalId));
        this.#kv.put(this.#draftAliasKey(duplicate.logicalId), resource.logicalId);
      }
      const mergedIds = new Set([resource.logicalId, ...(duplicate ? [duplicate.logicalId] : [])]);
      const mergedActions = this.listActions().filter(({action}) => isDraftAction(action) &&
        mergedIds.has(this.resolveDraftId(actionResourceId(action)!)));
      const predecessors: number[] = [];
      for (const {id, action} of mergedActions) {
        if (!isDraftAction(action)) continue;
        let retargeted: GmailDraftCreateAction | GmailDraftUpdateAction |
          GmailDraftDeleteAction | GmailDraftSendAction;
        switch (action.type) {
        case "draftCreate":
          retargeted = {
            ...action,
            draft: {...action.draft, logicalId: resource.logicalId},
          };
          break;
        case "draftUpdate":
          retargeted = {
            ...action,
            draftId: resource.logicalId,
            after: {...action.after, logicalId: resource.logicalId},
          };
          break;
        case "draftDelete":
          retargeted = {...action, draftId: resource.logicalId};
          break;
        case "draftSend":
          retargeted = {
            ...action,
            draftId: resource.logicalId,
            approved: {...action.approved, logicalId: resource.logicalId},
          };
          break;
        }
        retargeted = {
          ...retargeted,
          dependsOn: [...new Set([...(retargeted.dependsOn ?? []), ...predecessors])]
            .filter(dependency => dependency !== id),
        };
        this.#kv.put(this.#actionKey(id), retargeted);
        predecessors.push(id);
      }
      resource.providerId = providerId;
      this.putDraft(resource);
      afterMap?.(resource);
      return resource;
    });
  }

  completeDraftWrite(
      actionId: number, baseline: GmailDraftProviderBaseline,
      approvedOutputFingerprint: string,
      expectedReceipt: GmailDraftWriteReceipt = baseline): StoredGmailAction {
    const action = this.getAction(actionId);
    if (action?.type !== "draftCreate" && action?.type !== "draftUpdate") {
      throw new Error("The pending Gmail draft write changed before completion.");
    }
    let completed: StoredGmailAction | undefined;
    if (action.type === "draftCreate") {
      this.mapDraftToProvider(
        action.draft.logicalId, baseline.draftId, actionId,
        resource => {
          completed = this.#completeDraftWrite(
            actionId, resource.logicalId, baseline, approvedOutputFingerprint, expectedReceipt);
        });
    } else {
      completed = this.#storage.transactionSync(() => this.#completeDraftWrite(
        actionId, this.resolveDraftId(action.draftId), baseline, approvedOutputFingerprint,
        expectedReceipt));
    }
    if (!completed) throw new Error("The Gmail draft write was not completed.");
    return completed;
  }

  completeMatchingDraftUpdate(
      actionId: number, baseline: GmailDraftProviderBaseline,
      approvedOutputFingerprint: string): StoredGmailAction {
    const action = this.getAction(actionId);
    if (action?.type !== "draftUpdate") {
      throw new Error("The matching Gmail draft update changed before completion.");
    }
    return this.#storage.transactionSync(() => this.#completeDraftWrite(
      actionId, this.resolveDraftId(action.draftId), baseline, approvedOutputFingerprint));
  }

  #completeDraftWrite(
      actionId: number, logicalId: string, baseline: GmailDraftProviderBaseline,
      approvedOutputFingerprint: string,
      expectedReceipt?: GmailDraftWriteReceipt): StoredGmailAction {
    const action = this.getAction(actionId);
    if (action?.type !== "draftCreate" && action?.type !== "draftUpdate") {
      throw new Error("The pending Gmail draft write changed before completion.");
    }
    const receipt = this.getDraftWriteReceipt(actionId);
    if (expectedReceipt && (!this.isApplying(actionId) || !receipt ||
        receipt.draftId !== expectedReceipt.draftId ||
        receipt.messageId !== expectedReceipt.messageId ||
        receipt.threadId !== expectedReceipt.threadId)) {
      throw new Error("The Gmail draft write receipt changed before completion.");
    }
    const resource = this.getDraft(logicalId);
    if (!resource || resource.providerId !== baseline.draftId || resource.status !== "active") {
      throw new Error("The Gmail draft resource changed before write completion.");
    }

    const pending = this.listActions();
    const pendingIds = new Set(pending.map(({id}) => id));
    const decisions = this.decisions();
    const successor = pending.find(({id, action: candidate}) =>
      id > actionId && isDraftAction(candidate) &&
      this.resolveDraftId(actionResourceId(candidate)!) === logicalId &&
      !(candidate.dependsOn ?? []).some(dependency => dependency !== actionId &&
        !pendingIds.has(dependency) && decisions.get(dependency) !== "applied"));
    if (successor && isDraftAction(successor.action)) {
      if (!successor.action.dependsOn?.includes(actionId)) {
        throw new Error("The dependent Gmail draft action lost its write prerequisite.");
      }
      let expected: string;
      let rebased: GmailDraftUpdateAction | GmailDraftDeleteAction | GmailDraftSendAction;
      switch (successor.action.type) {
      case "draftUpdate":
        expected = successor.action.expectedBefore;
        rebased = {
          ...successor.action,
          expectedBefore: baseline.fingerprint,
          expectedProviderMessageId: baseline.messageId,
        };
        break;
      case "draftDelete":
        expected = successor.action.expectedSnapshot;
        rebased = {
          ...successor.action,
          expectedSnapshot: baseline.fingerprint,
          expectedProviderMessageId: baseline.messageId,
        };
        break;
      case "draftSend":
        expected = successor.action.expectedSnapshot;
        rebased = {
          ...successor.action,
          expectedSnapshot: baseline.fingerprint,
          expectedProviderMessageId: baseline.messageId,
        };
        break;
      case "draftCreate":
        throw new Error("A Gmail draft cannot have another create action as its successor.");
      }
      if (expected !== approvedOutputFingerprint) {
        throw new Error("The dependent Gmail draft action no longer matches the approved write output.");
      }
      this.#kv.put(this.#actionKey(successor.id), rebased);
    }

    // A queued successor already advanced the resource generation and was rebased above. Without
    // one, completion must advance it so an update currently awaiting authorization detects that
    // its provider baseline changed before it can store stale preconditions.
    if (!successor) {
      resource.version++;
      this.putDraft(resource);
    }

    this.setDecision(actionId, "applied");
    this.removeAction(actionId);
    this.clearApplying(actionId);
    this.pruneDecisions();
    return action;
  }

  captureForwardSnapshot(bytes: Uint8Array): Promise<GmailForwardSnapshotReference> {
    return this.#forwardSnapshots.capture(bytes);
  }

  readForwardSnapshot(snapshot: GmailForwardSnapshotReference): Promise<Uint8Array> {
    return this.#forwardSnapshots.read(snapshot);
  }

  deleteForwardSnapshot(
      snapshot: GmailForwardSnapshotReference | undefined, exceptActionId?: number): void {
    if (snapshot && this.listActions().some(({id, action}) => id !== exceptActionId &&
        actionSourceAttachment(action)?.handle === snapshot.handle)) return;
    if (snapshot && this.listDrafts().some(resource =>
        resource.forwardSnapshot?.handle === snapshot.handle)) return;
    this.#forwardSnapshots.delete(snapshot);
  }

  clearDraftForwardSnapshot(id: string): void {
    const resource = this.getDraft(id);
    if (!resource) return;
    const snapshot = resource.forwardSnapshot;
    delete resource.forwardSnapshot;
    delete resource.forwardBody;
    delete resource.forwardHtml;
    this.putDraft(resource);
    this.#forwardSnapshots.delete(snapshot);
  }

  restoreDraftVersion(
      id: string, submittedVersion: number, previousVersion: number,
      dependencies: readonly number[]): void {
    this.#storage.transactionSync(() => {
      const resource = this.getDraft(id);
      if (resource?.status !== "active" || resource.version !== submittedVersion) return;
      if (dependencies.some(dependency =>
        this.#kv.get<GmailDecision>(this.#decisionKey(dependency)) === "applied")) return;
      resource.version = previousVersion;
      this.putDraft(resource);
    });
  }

  updateDraftForwardContent(id: string, state: GmailDraftState): void {
    const resource = this.getDraft(id);
    if (!resource?.forwardSnapshot) return;
    resource.forwardBody = state.text;
    if (state.html === undefined) delete resource.forwardHtml;
    else resource.forwardHtml = state.html;
    this.putDraft(resource);
  }

  getLabel(id: string): GmailLabelResource | undefined {
    return this.#kv.get<GmailLabelResource>(this.#labelKey(id));
  }

  putLabel(resource: GmailLabelResource): void {
    this.#kv.put(this.#labelKey(resource.logicalId), resource);
  }

  deleteLabel(id: string): void { this.#kv.delete(this.#labelKey(id)); }

  listLabels(): GmailLabelResource[] {
    return [...this.#kv.list<GmailLabelResource>({prefix: "gmail:label:"})].map(([, value]) => value);
  }

  labelForProvider(providerId: string): GmailLabelResource | undefined {
    return this.listLabels().find(resource => resource.providerId === providerId);
  }

  mapLabelToProvider(
      actionId: number, provider: GmailLabelRaw): GmailLabelResource {
    return this.#storage.transactionSync(() => {
      const action = this.getAction(actionId);
      if (action?.type !== "labelCreate" || !this.isApplying(actionId) ||
          action.label.name !== provider.name || provider.type !== "user") {
        throw new Error("The uncertain Gmail label creation changed while it was being reconciled.");
      }
      const resource = this.getLabel(action.label.logicalId);
      if (!resource || resource.status !== "active" || resource.name !== action.label.name) {
        throw new Error("The provisional Gmail label is no longer active.");
      }
      if (resource.providerId && resource.providerId !== provider.id) {
        throw new Error("The Gmail label resource is already mapped to another provider label.");
      }
      const duplicate = this.labelForProvider(provider.id);
      if (duplicate && duplicate.logicalId !== resource.logicalId) {
        throw new Error("The Gmail provider label is already mapped to another local resource.");
      }
      resource.providerId = provider.id;
      resource.name = provider.name;
      this.putLabel(resource);
      return resource;
    });
  }

  admitLabel(id: string): void { this.#kv.put(this.#admittedLabelKey(id), true); }

  isLabelAdmitted(id: string): boolean {
    return this.#kv.get<boolean>(this.#admittedLabelKey(id)) === true;
  }
}

function isDraftAction(action: StoredGmailAction): action is GmailDraftCreateAction |
    GmailDraftUpdateAction | GmailDraftDeleteAction | GmailDraftSendAction {
  return ["draftCreate", "draftUpdate", "draftDelete", "draftSend"].includes(action.type);
}

function isLabelAction(action: StoredGmailAction): action is GmailLabelCreateAction |
    GmailLabelRenameAction | GmailLabelDeleteAction {
  return ["labelCreate", "labelRename", "labelDelete"].includes(action.type);
}

function isLegacyGmailAction(action: StoredGmailAction): action is LegacyGmailAction {
  return action.type === "archive" || action.type === "trash" || action.type === "markRead" ||
    action.type === "markUnread" || action.type === "reply" || action.type === "forward" ||
    (action.type === "send" && !("spec" in action));
}

function actionSourceAttachment(action: StoredGmailAction): GmailSourceAttachment | undefined {
  if (action.type === "draftCreate") return action.sourceAttachment;
  if (action.type === "draftUpdate" || action.type === "draftDelete" ||
      action.type === "draftSend") return action.sourceAttachment;
  if (action.type === "send" && "spec" in action) return action.sourceAttachment;
  return undefined;
}

function requireCurrentSourceSnapshot(
    snapshot: GmailSourceAttachment | undefined, sourceMessageId: string | undefined):
    GmailSourceAttachment {
  if (!snapshot || typeof (snapshot as Partial<GmailSourceAttachment>).handle !== "string" ||
      !sourceMessageId || snapshot.messageId !== sourceMessageId) {
    throw new Error(
      "This pending forward uses an obsolete source snapshot. Reject and resubmit it.");
  }
  return snapshot;
}

function sendSourceSnapshot(action: GmailSendAction): GmailSourceAttachment | undefined {
  if (action.mode === "forward") {
    return requireCurrentSourceSnapshot(action.sourceAttachment, action.sourceMessageId);
  }
  if (action.sourceAttachment) {
    throw new Error("This pending Gmail send has inconsistent source snapshot metadata.");
  }
  return undefined;
}

function draftSourceSnapshot(action: GmailDraftCreateAction): GmailSourceAttachment | undefined {
  if (action.draft.source?.kind === "forward") {
    const snapshot = requireCurrentSourceSnapshot(
      action.sourceAttachment, action.draft.source.messageId);
    if (action.draft.source.format === "inline") return snapshot;
    const attachment = action.draft.attachments[0];
    if (action.draft.attachments.length !== 1 || !attachment ||
        attachment.contentDigest !== snapshot.digest || attachment.info.size !== snapshot.size ||
        attachment.info.filename !== "forwarded-message.eml" ||
        attachment.info.mimeType !== "message/rfc822" ||
        attachment.info.disposition !== "attachment" || attachment.info.contentId !== undefined) {
      throw new Error(
        "This pending forward draft has inconsistent source snapshot metadata. " +
        "Reject and resubmit it.");
    }
    return snapshot;
  }
  if (action.sourceAttachment) {
    throw new Error("This pending Gmail draft has inconsistent source snapshot metadata.");
  }
  return undefined;
}

function actionResourceId(action: StoredGmailAction): string | undefined {
  if (action.type === "draftCreate") return action.draft.logicalId;
  if (action.type === "draftUpdate" || action.type === "draftDelete" || action.type === "draftSend") {
    return action.draftId;
  }
  if (action.type === "labelCreate") return action.label.logicalId;
  if (action.type === "labelRename" || action.type === "labelDelete") return action.labelId;
  return undefined;
}

function dependenciesFor(store: GmailStore, resourceId: string, kind: "draft" | "label"): number[] {
  const decisions = store.decisions();
  const pending = store.listActions();
  const pendingIds = new Set(pending.map(item => item.id));
  const canonicalId = kind === "draft" ? store.resolveDraftId(resourceId) : resourceId;
  const actions = pending.filter(({action}) => {
    if (kind === "draft") {
      return isDraftAction(action) &&
        store.resolveDraftId(actionResourceId(action)!) === canonicalId;
    }
    return isLabelAction(action) && actionResourceId(action) === canonicalId;
  });
  const terminal = actions.find(item =>
    item.action.type === "draftDelete" || item.action.type === "draftSend" ||
    item.action.type === "labelDelete");
  if (terminal) {
    const operation = terminal.action.type === "draftSend" ? "send" : "deletion";
    throw new Error(
      `This ${kind} already has a pending ${operation}. Resolve that action before ` +
      "submitting another one.");
  }
  const invalid = actions.find(item =>
    "dependsOn" in item.action &&
    item.action.dependsOn?.some(dependency =>
      !pendingIds.has(dependency) && decisions.get(dependency) !== "applied"));
  if (invalid) {
    throw new Error(
      `This ${kind} has a pending action with an invalid prerequisite. Reject that action before ` +
      "submitting another one.");
  }
  return actions.map(item => item.id);
}

function draftPending(store: GmailStore): PendingOverlayAction<GmailDraftOverlayAction>[] {
  const pending: PendingOverlayAction<GmailDraftOverlayAction>[] = [];
  for (const {id, action} of store.listActions()) {
    if (!isDraftAction(action)) continue;
    const logicalId = store.resolveDraftId(actionResourceId(action)!);
    switch (action.type) {
    case "draftCreate":
      pending.push({id, action: {
        type: action.type,
        draft: {...action.draft, logicalId},
        dependsOn: action.dependsOn,
      }});
      break;
    case "draftUpdate":
      pending.push({id, action: {
        type: action.type,
        draftId: logicalId,
        after: {...action.after, logicalId},
        dependsOn: action.dependsOn,
      }});
      break;
    case "draftDelete":
      pending.push({id, action: {
        type: action.type, draftId: logicalId, dependsOn: action.dependsOn,
      }});
      break;
    case "draftSend":
      pending.push({id, action: {
        type: action.type, draftId: logicalId, dependsOn: action.dependsOn,
      }});
      break;
    }
  }
  return pending;
}

function labelPending(store: GmailStore): PendingOverlayAction<GmailLabelOverlayAction>[] {
  return store.listActions().filter(item => isLabelAction(item.action)) as
    PendingOverlayAction<GmailLabelOverlayAction>[];
}

function formatApprovalField(label: string, value: string): string {
  // Reject an individually oversized field before newline expansion can allocate millions of
  // intermediate strings. The complete rendered description is checked again at submission.
  validateApprovalDescription(value);
  const block = value.split(/\r\n|\r|\n/).map(line => `    ${line}`).join("\n");
  return `**${label}:**\n\n${block}`;
}

function validateApprovalDescription(value: string): string {
  if (value.length > MAX_GMAIL_APPROVAL_DESCRIPTION_BYTES ||
      new TextEncoder().encode(value).byteLength > MAX_GMAIL_APPROVAL_DESCRIPTION_BYTES) {
    throw new Error(
      `This Gmail action exceeds the ${MAX_GMAIL_APPROVAL_DESCRIPTION_BYTES}-byte approval ` +
      "description limit and cannot be submitted safely.");
  }
  return value;
}

function sanitizeApprovalTitle(value: string): string {
  return value.replace(/[\r\n]+/g, " ").slice(0, 200);
}

function describeOutboundMessage(intro: string, message: GmailOutboundMessage): string {
  const fields = [
    formatApprovalField("From", message.from),
    ...(message.to.length ? [formatApprovalField("To", message.to.join(", "))] : []),
    ...(message.cc.length ? [formatApprovalField("Cc", message.cc.join(", "))] : []),
    ...(message.bcc.length ? [formatApprovalField("Bcc", message.bcc.join(", "))] : []),
    formatApprovalField("Subject", message.subject),
    formatApprovalField("Plain text", message.body),
    ...(message.html !== undefined ? [formatApprovalField("HTML", message.html)] : []),
    ...message.attachments.map(attachment => formatApprovalField(
      "Attachment", `${attachment.filename} (${attachment.contentType})\n${attachment.description}`)),
  ];
  return `${intro}\n\n${fields.join("\n\n")}`;
}

function outboundSpec(message: GmailOutboundMessage, attachments = message.attachments): GmailOutboundSpec {
  return {
    from: message.from,
    replyTo: message.replyTo,
    to: message.to,
    cc: message.cc,
    bcc: message.bcc,
    subject: message.subject,
    text: message.body,
    ...(message.html !== undefined ? {html: message.html} : {}),
    messageId: message.messageId,
    ...(message.inReplyTo ? {inReplyTo: message.inReplyTo} : {}),
    ...(message.references ? {references: message.references} : {}),
    attachments,
  };
}

function inlineForwardSpec(
    message: GmailOutboundMessage, body: string | undefined,
    options: GmailComposeOptions): GmailOutboundSpec {
  return {
    ...outboundSpec(message, []),
    text: body ?? "",
    ...(options.html !== undefined ? {html: options.html} : {}),
  };
}

function validateForwardFields(
    message: GmailOutboundMessage, body: string | undefined,
    options: GmailComposeOptions): void {
  validateOutboundFields(message, message.subject, body ?? "", options.html);
}

async function digestBytes(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map(value => value.toString(16).padStart(2, "0")).join("");
}

async function parseSafeGmailDraft(message: GmailMessageRaw): Promise<GmailParsedDraft> {
  if (base64UrlDecodedByteLength(message.raw) > MAX_GMAIL_DRAFT_MIME_BYTES) {
    throw new Error(
      `This Gmail draft exceeds the ${MAX_GMAIL_DRAFT_MIME_BYTES}-byte safe modification limit.`);
  }
  const parsed = await parseGmailDraft(message);
  const exactAttachments = extractRfc822Attachments(message.raw);
  const parsedIndexes = parsed.attachments.flatMap((attachment, index) =>
    attachment.contentType.split(";", 1)[0].trim().toLowerCase() === "message/rfc822" ? [index] : []);
  // Generic drafts may use a legal transfer encoding such as base64 for nested messages. The exact
  // extractor is only needed to verify the unencoded source attachment produced by our forward
  // pipeline, so leave other nested attachments to PostalMime's decoded representation.
  if (exactAttachments.length === 0) return parsed;
  if (parsedIndexes.length < exactAttachments.length) {
    throw new Error("Unable to match nested Gmail draft attachments to their exact MIME parts.");
  }
  const attachments = [...parsed.attachments];
  const unmatched = new Set(parsedIndexes);
  for (const exact of exactAttachments) {
    const candidates = [...unmatched].filter(index => {
      const attachment = attachments[index];
      return (attachment.filename || undefined) === exact.filename &&
        (attachment.disposition ?? undefined) === exact.disposition &&
        (attachment.contentId?.replace(/^<|>$/g, "") ?? undefined) === exact.contentId;
    });
    if (candidates.length !== 1) {
      throw new Error("Unable to correlate a nested Gmail draft attachment unambiguously.");
    }
    const index = candidates[0];
    unmatched.delete(index);
    attachments[index] = {...attachments[index], data: bytesToBase64(exact.bytes)};
  }
  return {...parsed, attachments};
}

async function readDraftProviderBaseline(
    api: GmailApi, store: GmailStore, actionId: number,
    receipt: GmailDraftWriteReceipt,
    approvedOutputFingerprint?: string,
    approvedThreadId?: string): Promise<GmailDraftProviderBaseline> {
  let current: GmailDraftRaw;
  try {
    current = await api.getDraft(receipt.draftId);
  } catch (error) {
    if (error instanceof GmailApiError && error.status === 404) {
      store.markDraftWriteMissing(actionId, receipt);
    }
    throw error;
  }
  if (current.id !== receipt.draftId) {
    throw new Error(
      "The Gmail draft revision changed before its provider-normalized state could be recorded.");
  }
  const parsed = await parseSafeGmailDraft(current.message);
  const fingerprint = await gmailDraftFingerprint(parsed, current.message.threadId);
  if (receipt.unverified && fingerprint !== approvedOutputFingerprint) {
    throw new Error(
      "The Gmail draft revision changed before its provider-normalized state could be recorded.");
  }
  if (current.message.id !== receipt.messageId) {
    const expectedThreadId = receipt.threadId ?? approvedThreadId;
    if (fingerprint !== approvedOutputFingerprint || !expectedThreadId ||
        current.message.threadId !== expectedThreadId) {
      throw new Error(
        "The Gmail draft revision changed before its provider-normalized state could be recorded.");
    }
  }
  return {
    draftId: current.id,
    messageId: current.message.id,
    threadId: current.message.threadId,
    fingerprint,
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).match(/.{1,76}/g)?.join("\r\n") ?? "";
}

async function captureSourceAttachment(
    store: GmailStore, source: GmailMessageRaw,
    message: GmailOutboundMessage): Promise<GmailSourceAttachment> {
  const bytes = decodeBase64UrlToBytes(source.raw);
  const snapshot = await store.captureForwardSnapshot(bytes);
  return {
    ...snapshot,
    messageId: source.id,
    description: message.attachments.length > 0
      ? `Inline forward includes ${message.attachments.length} original attachment(s).`
      : "Inline forward includes the original message body.",
  };
}

function materializeSourceAttachment(
    bytes: Uint8Array, snapshot: GmailSourceAttachment): GmailOutboundAttachment {
  if (bytes.byteLength !== snapshot.size || bytes.byteLength > MAX_GMAIL_FORWARD_SOURCE_BYTES) {
    throw new Error("The stored forward source no longer matches its approved attachment snapshot.");
  }
  return {
    filename: "forwarded-message.eml",
    contentType: snapshot.contentType ?? "message/rfc822",
    data: bytesToBase64(bytes),
    disposition: "attachment",
    description: snapshot.description,
  };
}

function validateDraftState(draft: GmailDraftState): void {
  const recipients = [...draft.to, ...draft.cc, ...draft.bcc];
  validateGmailRecipientMaximum(recipients);
  for (const recipient of recipients) validateGmailAddress(recipient);
  validateGmailSubject(draft.subject);
  validateGmailBodyAlternatives(draft.text, draft.html);
  if (new TextEncoder().encode(JSON.stringify(draft)).byteLength > 96 * 1024) {
    throw new Error("This Gmail draft is too large to stage safely for approval.");
  }
}

function validateDraftPatch(patch: GmailDraftPatch): void {
  if (patch.text !== undefined) validateGmailBody(patch.text);
  if (patch.html !== undefined && patch.html !== null) validateGmailBody(patch.html);
  if (patch.text !== undefined && patch.html !== undefined && patch.html !== null) {
    validateGmailBodyAlternatives(patch.text, patch.html);
  }
}

function validateDraftRecipientPatch(
    draft: GmailDraftState, patch: Partial<GmailNormalizedRecipients>): void {
  const fields = ["to", "cc", "bcc"] as const;
  const effective = {
    to: patch.to ?? draft.to,
    cc: patch.cc ?? draft.cc,
    bcc: patch.bcc ?? draft.bcc,
  };
  for (const field of fields) {
    if (patch[field] === undefined) continue;
    const otherAddresses = new Set(fields.filter(other => other !== field)
      .flatMap(other => effective[other])
      .map(recipient => emailRecipientToAddress(recipient).address.toLowerCase()));
    if (effective[field].some(recipient =>
      otherAddresses.has(emailRecipientToAddress(recipient).address.toLowerCase()))) {
      throw new Error("A Gmail draft recipient cannot appear in more than one of To, Cc, or Bcc.");
    }
  }
}

async function attachmentDigest(attachment: GmailOutboundAttachment): Promise<string> {
  const encoded = attachment.data.replace(/\s/g, "");
  return digestBytes(Uint8Array.from(atob(encoded), char => char.charCodeAt(0)));
}

async function parsedDraftToState(
    logicalId: string, resource: GmailDraftResource, draft: GmailDraftRaw,
    parsed: GmailParsedDraft, fallbackFrom: string): Promise<GmailDraftState> {
  const attachments: GmailDraftAttachmentState[] = await Promise.all(parsed.attachments.map(
    async (attachment, index) => {
      const encoded = attachment.data.replace(/\s/g, "");
      const size = atob(encoded).length;
      return {
        key: String(index),
        info: {
          filename: attachment.filename || null,
          mimeType: attachment.contentType,
          size,
          disposition: attachment.disposition ?? null,
          ...(attachment.contentId ? {contentId: attachment.contentId} : {}),
          readable: size <= MAX_GMAIL_ATTACHMENT_BYTES,
        },
        contentDigest: await attachmentDigest(attachment),
      };
    }));
  const inlineForward = resource.source?.kind === "forward" && resource.source.format === "inline" &&
    resource.forwardSnapshot;
  return {
    logicalId,
    providerId: draft.id,
    from: parsed.from ?? fallbackFrom,
    replyTo: parsed.replyTo,
    messageId: draft.message.id,
    threadId: draft.message.threadId,
    to: parsed.to,
    cc: parsed.cc,
    bcc: parsed.bcc,
    ...(parsed.date !== undefined ? {date: parsed.date} : {}),
    subject: parsed.subject,
    text: inlineForward && resource.forwardBody !== undefined ? resource.forwardBody : parsed.text,
    ...(inlineForward && resource.forwardHtml !== undefined
      ? {html: resource.forwardHtml}
      : !inlineForward && parsed.html !== undefined ? {html: parsed.html} : {}),
    ...(parsed.messageId ? {rfcMessageId: parsed.messageId} : {}),
    ...(parsed.inReplyTo ? {inReplyTo: parsed.inReplyTo} : {}),
    ...(parsed.references ? {references: parsed.references} : {}),
    timestamp: Number(draft.message.internalDate) || resource.createdAt,
    ...(resource.source ? {source: resource.source} : {}),
    attachments,
    version: resource.version,
  };
}

function parsedDraftSnapshotToState(
    logicalId: string, resource: GmailDraftResource, draft: GmailDraftFull,
    parsed: GmailParsedDraftSnapshot, fallbackFrom: string): GmailDraftState {
  const inlineForward = resource.source?.kind === "forward" && resource.source.format === "inline" &&
    resource.forwardSnapshot;
  return {
    logicalId,
    providerId: draft.id,
    from: parsed.from ?? fallbackFrom,
    replyTo: parsed.replyTo,
    messageId: draft.message.id,
    threadId: draft.message.threadId,
    to: parsed.to,
    cc: parsed.cc,
    bcc: parsed.bcc,
    ...(parsed.date !== undefined ? {date: parsed.date} : {}),
    subject: parsed.subject,
    text: inlineForward && resource.forwardBody !== undefined ? resource.forwardBody : parsed.text,
    ...(inlineForward && resource.forwardHtml !== undefined
      ? {html: resource.forwardHtml}
      : !inlineForward && parsed.html !== undefined ? {html: parsed.html} : {}),
    ...(parsed.messageId ? {rfcMessageId: parsed.messageId} : {}),
    ...(parsed.inReplyTo ? {inReplyTo: parsed.inReplyTo} : {}),
    ...(parsed.references ? {references: parsed.references} : {}),
    timestamp: Number(draft.message.internalDate) || resource.createdAt,
    ...(resource.source ? {source: resource.source} : {}),
    attachments: parsed.attachments.map(snapshot => ({key: snapshot.key, info: snapshot.info})),
    version: resource.version,
  };
}

function draftInfo(state: GmailDraftState): GmailDraftInfo {
  return {
    id: state.logicalId,
    ...(state.messageId ? {messageId: state.messageId} : {}),
    ...(state.threadId ? {threadId: state.threadId} : {}),
    to: state.to.map(emailRecipientToAddress),
    cc: state.cc.map(emailRecipientToAddress),
    bcc: state.bcc.map(emailRecipientToAddress),
    subject: state.subject,
    timestamp: new Date(state.timestamp),
    ...(state.source ? {
      source: {kind: state.source.kind, messageId: state.source.messageId},
    } : {}),
  };
}

function draftSpec(
    state: GmailDraftState, attachments: GmailOutboundAttachment[] = []): GmailOutboundSpec {
  return {
    from: state.from,
    replyTo: state.replyTo,
    to: state.to,
    cc: state.cc,
    bcc: state.bcc,
    ...(state.date !== undefined ? {date: state.date} : {}),
    subject: state.subject,
    text: state.text,
    ...(state.html !== undefined ? {html: state.html} : {}),
    messageId: state.rfcMessageId ?? newGmailMessageId(),
    ...(state.inReplyTo ? {inReplyTo: state.inReplyTo} : {}),
    ...(state.references ? {references: state.references} : {}),
    attachments,
  };
}

function pendingForwardSnapshot(
    store: GmailStore, logicalId: string): GmailSourceAttachment | undefined {
  const resource = store.getDraft(logicalId);
  if (resource?.source?.kind === "forward" && resource.forwardSnapshot) {
    return {
      ...resource.forwardSnapshot,
      messageId: resource.source.messageId,
      description: "Inline forward source snapshot.",
    };
  }
  const actions = store.listActions()
    .filter(({action}) => isDraftAction(action) &&
      store.resolveDraftId(actionResourceId(action)!) === logicalId)
    .toReversed();
  for (const {action} of actions) {
    const snapshot = actionSourceAttachment(action);
    if (snapshot) return snapshot;
  }
  return undefined;
}

async function inlineForwardMessage(
    api: GmailApi, store: GmailStore, state: GmailDraftState,
    snapshot: GmailSourceAttachment): Promise<GmailOutboundMessage> {
  const bytes = await store.readForwardSnapshot(snapshot);
  return api.buildForwardFromBytes(bytes, state.to, state.text, {
    cc: state.cc,
    bcc: state.bcc,
    ...(state.html !== undefined ? {html: state.html} : {}),
  }, state.rfcMessageId, state.subject, state.date);
}

async function draftOutputFingerprint(
    api: GmailApi, store: GmailStore, state: GmailDraftState,
    snapshot?: GmailSourceAttachment): Promise<string> {
  if (state.source?.kind === "forward" && state.source.format === "inline" && snapshot) {
    const message = await inlineForwardMessage(api, store, state, snapshot);
    const parsed = await parseGmailDraft({
      id: "forward-snapshot", threadId: state.threadId ?? "forward-snapshot",
      internalDate: "0", raw: message.raw,
    });
    return gmailDraftFingerprint(parsed, state.threadId);
  }
  return gmailDraftStateFingerprint(state);
}

const SYSTEM_LABEL_IDS: GmailSystemLabel[] = [
  "INBOX", "TRASH", "SPAM", "UNREAD", "STARRED", "IMPORTANT", "SENT", "DRAFT", "CHAT",
  "CATEGORY_PRIMARY", "CATEGORY_PERSONAL", "CATEGORY_SOCIAL", "CATEGORY_PROMOTIONS",
  "CATEGORY_UPDATES", "CATEGORY_FORUMS",
];
const SYSTEM_LABELS = new Set<string>(SYSTEM_LABEL_IDS);

function publicLabels(ids: string[], labels: GmailLabelRaw[], resources: GmailLabelResource[]): GmailLabel[] {
  const byProvider = new Map(resources.filter(item => item.providerId)
    .map(item => [item.providerId!, item]));
  const byId = new Map(labels.map(label => [label.id, label]));
  const result: GmailLabel[] = [];
  for (const id of ids) {
    if (SYSTEM_LABELS.has(id)) {
      result.push({id, name: id as GmailSystemLabel, type: "system"});
      continue;
    }
    const resource = byProvider.get(id);
    const label = byId.get(resource?.logicalId ?? id) ?? byId.get(id);
    if (!label || label.type !== "user") continue;
    result.push({
      id: resource?.logicalId ?? id,
      name: label?.name ?? resource?.name ?? id,
      type: "custom",
    });
  }
  return result;
}

type GmailContext = {
  api: GmailApi;
  approvalQueue: SharedApprovalQueue;
  store: GmailStore;
  selfEmail: string;
  searchQuery?: string;
  labelId?: string;
  labelName?: string;
  restricted: boolean;
  providerLabels(): Promise<GmailLabelRaw[]>;
};

class SharedApprovalQueue {
  #stub: RpcStub<ApprovalQueue>;
  #references = 0;

  constructor(stub: RpcStub<ApprovalQueue>) {
    this.#stub = stub;
  }

  retain(): () => void {
    this.#references++;
    let retained = true;
    return () => {
      if (!retained) return;
      retained = false;
      if (--this.#references === 0) this.#stub[Symbol.dispose]();
    };
  }

  authorizeObservation(description: ObservationDescription): Promise<void> {
    return this.#stub.authorizeObservation(description);
  }

  submitAction(actionId: number, description: ActionDescription): Promise<void> {
    return this.#stub.submitAction(actionId, description);
  }
}

class GmailRpcTarget extends RpcTarget {
  #releaseApprovalQueue: () => void;

  constructor(approvalQueue: SharedApprovalQueue) {
    super();
    this.#releaseApprovalQueue = approvalQueue.retain();
  }

  [Symbol.dispose](): void {
    this.#releaseApprovalQueue();
  }
}

@validateRpc()
class RpcCursor<Entry> extends GmailRpcTarget implements Cursor<Entry> {
  #pager: Pager<Entry>;

  constructor(pager: Pager<Entry>, approvalQueue: SharedApprovalQueue) {
    super(approvalQueue);
    this.#pager = pager;
  }

  @skipRpcValidation()
  next(): Promise<Entry[] | null> { return this.#pager.next(); }
}

async function submitAction(
    ctx: GmailContext, action: GmailAction,
    description: {title: string; description: string; awaitDecision?: boolean},
    onFailure?: () => void): Promise<number> {
  if (ctx.store.listActions().length >= 100) {
    throw new Error("Too many pending Gmail actions. Resolve existing actions before adding more.");
  }
  const id = ctx.store.submit(action);
  try {
    await ctx.approvalQueue.submitAction(id, {
      ...description,
      description: validateApprovalDescription(description.description),
      implementsRevert: false,
      ...gmailAutoApprovalMetadata(action),
    });
    return id;
  } catch (error) {
    // A concurrent child may already reference this ID. Preserve an explicit rejection until all
    // such children are resolved rather than letting a missing prerequisite look applied.
    ctx.store.setDecision(id, "rejected");
    ctx.store.removeAction(id);
    onFailure?.();
    ctx.store.pruneDecisions();
    throw error;
  }
}

type GmailLabelSnapshot = {labels: GmailLabelRaw[]; resources: GmailLabelResource[]};

async function currentLabels(ctx: GmailContext): Promise<GmailLabelSnapshot> {
  const provider = await ctx.providerLabels();
  const resources = ctx.store.listLabels();
  return {
    labels: overlayGmailLabels(provider, resources, labelPending(ctx.store), ctx.store.decisions()),
    resources,
  };
}

async function resolveLabels(
    ctx: GmailContext, ids: string[], snapshot?: GmailLabelSnapshot): Promise<GmailLabel[]> {
  const current = snapshot ?? await currentLabels(ctx);
  return publicLabels(ids, current.labels, current.resources);
}

async function messageInfo(
    ctx: GmailContext, raw: GmailMessageInfoRaw,
    labels?: GmailLabelSnapshot): Promise<GmailMessageInfo> {
  return {
    id: raw.id,
    threadId: raw.threadId,
    from: raw.from,
    to: raw.to,
    cc: raw.cc,
    ...(raw.bcc.length ? {bcc: raw.bcc} : {}),
    subject: raw.subject,
    timestamp: raw.timestamp,
    labels: await resolveLabels(ctx, raw.labelIds, labels),
  };
}

async function threadInfo(
    ctx: GmailContext, raw: GmailThreadInfoRaw,
    labels?: GmailLabelSnapshot): Promise<GmailThreadInfo> {
  const {labelIds, ...info} = raw;
  return {...info, labels: await resolveLabels(ctx, labelIds, labels)};
}

function admitReturnedLabels(ctx: GmailContext, labels: readonly GmailLabel[]): void {
  if (!ctx.restricted) return;
  for (const label of labels) ctx.store.admitLabel(label.id);
}

function applyingDraftCreates(store: GmailStore): Array<{
  id: number;
  action: GmailDraftCreateAction;
}> {
  return store.listActions().flatMap(({id, action}) =>
    action.type === "draftCreate" && store.isApplying(id) ? [{id, action}] : []);
}

function applyingDraftCreateForMessageId(
    store: GmailStore, rfcMessageId: string | undefined): {
      id: number;
      action: GmailDraftCreateAction;
    } | undefined {
  if (!rfcMessageId) return undefined;
  const matches = applyingDraftCreates(store).filter(
    ({action}) => action.draft.rfcMessageId === rfcMessageId);
  if (matches.length > 1) {
    throw new Error("Multiple uncertain Gmail draft creates have the same Message-ID.");
  }
  return matches[0];
}

async function mapMatchingApplyingDraftCreate(
    api: GmailApi, store: GmailStore, provider: GmailDraftRaw,
    parsed?: GmailParsedDraft): Promise<GmailDraftResource | undefined> {
  const current = parsed ?? await parseSafeGmailDraft(provider.message);
  const matched = applyingDraftCreateForMessageId(store, current.messageId);
  if (!matched) return undefined;
  const create = matched.action;
  const resource = store.getDraft(create.draft.logicalId);
  if (!resource || resource.status !== "active") {
    throw new Error("The uncertain Gmail draft create no longer has an active local resource.");
  }
  if (resource.providerId && resource.providerId !== provider.id) {
    throw new Error("The uncertain Gmail draft create is already mapped to another provider draft.");
  }
  const sourceSnapshot = draftSourceSnapshot(create);
  const approvedOutputFingerprint = await draftOutputFingerprint(
    api, store, create.draft, sourceSnapshot);
  if (await gmailDraftFingerprint(current, provider.message.threadId) !==
      approvedOutputFingerprint) {
    throw new Error("A discovered Gmail draft has the approved Message-ID but different content.");
  }
  const mapped = store.mapDraftToProvider(resource.logicalId, provider.id, matched.id);
  // Listing has verified both identity and content. Persist the provider receipt so a later retry
  // can finish reconciliation without creating another draft.
  store.setDraftWriteReceipt(matched.id, {
    draftId: provider.id,
    messageId: provider.message.id,
    threadId: provider.message.threadId,
  });
  return mapped;
}

async function ensureProviderDraft(
    ctx: GmailContext, draft: GmailDraftRef): Promise<GmailDraftResource> {
  let mapped = ctx.store.draftForProvider(draft.id);
  if (applyingDraftCreates(ctx.store).length > 0) {
    let provider: GmailDraftRaw | undefined;
    let rfcMessageId: string | undefined;
    if (draft.message?.id) {
      const metadata = await ctx.api.getMessageMetadata(draft.message.id);
      rfcMessageId = metadata.payload?.headers?.find(
        header => header.name.toLowerCase() === "message-id")?.value.trim();
    } else {
      provider = await ctx.api.getDraft(draft.id);
      rfcMessageId = (await parseSafeGmailDraft(provider.message)).messageId;
    }
    if (applyingDraftCreateForMessageId(ctx.store, rfcMessageId)) {
      provider ??= await ctx.api.getDraft(draft.id);
      const reconciled = await mapMatchingApplyingDraftCreate(ctx.api, ctx.store, provider);
      if (reconciled) return reconciled;
    }
    mapped = ctx.store.draftForProvider(draft.id);
  }
  if (mapped) return mapped;
  const resource: GmailDraftResource = {
    logicalId: draft.id,
    providerId: draft.id,
    createdAt: Date.now(),
    status: "active",
    version: 0,
  };
  ctx.store.putDraft(resource);
  return resource;
}

async function loadDraftBase(
    ctx: GmailContext, resource: GmailDraftResource, captureAttachments: boolean):
    Promise<GmailDraftState | undefined> {
  if (resource.status === "rejected") throw new Error("This provisional Gmail draft was rejected.");
  if (resource.status === "deleted") throw new Error("This Gmail draft has been deleted.");
  if (resource.status === "sent") throw new Error("This Gmail draft has already been sent.");
  if (!resource.providerId) return undefined;
  if (captureAttachments) {
    const snapshot = await ctx.api.getDraftFull(resource.providerId);
    if ((snapshot.message.sizeEstimate ?? 0) > MAX_GMAIL_DRAFT_MIME_BYTES) {
      throw new Error(
        `This Gmail draft exceeds the ${MAX_GMAIL_DRAFT_MIME_BYTES}-byte safe modification limit.`);
    }
    const provider = await ctx.api.getDraft(resource.providerId);
    const parsed = await parseSafeGmailDraft(provider.message);
    return parsedDraftToState(resource.logicalId, resource, provider, parsed, ctx.selfEmail);
  }
  const provider = await ctx.api.getDraftFull(resource.providerId);
  return parsedDraftSnapshotToState(
    resource.logicalId, resource, provider, await ctx.api.parseDraftSnapshot(provider.message),
    ctx.selfEmail);
}

async function loadSimulatedDraft(
    ctx: GmailContext, logicalId: string, captureAttachments = false): Promise<{
  state: GmailDraftState;
  resource: GmailDraftResource;
}> {
  const canonicalId = ctx.store.resolveDraftId(logicalId);
  const resource = ctx.store.getDraft(canonicalId);
  if (!resource) throw new Error("Unknown Gmail draft capability.");
  const providerId = resource.providerId;
  const version = resource.version;
  let base: GmailDraftState | undefined;
  try {
    base = await loadDraftBase(ctx, resource, captureAttachments);
  } catch (error) {
    if (!(error instanceof GmailApiError && error.status === 404 && providerId)) throw error;
    const current = ctx.store.getDraft(canonicalId);
    if (!current || current.logicalId !== canonicalId || current.providerId !== providerId ||
        current.version !== version || current.status !== "active") {
      throw new Error(
        "The Gmail draft changed identity while it was being read. Retry it.", {cause: error});
    }
    if (ctx.store.hasApplyingDraftSend(canonicalId)) {
      throw new Error("This Gmail draft has an uncertain send outcome.", {cause: error});
    }
    current.status = "deleted";
    current.version++;
    ctx.store.putDraft(current);
    ctx.store.clearDraftForwardSnapshot(canonicalId);
    throw new Error("This Gmail draft has been deleted.", {cause: error});
  }
  const resolvedAfterRead = ctx.store.resolveDraftId(logicalId);
  const current = ctx.store.getDraft(resolvedAfterRead);
  if (resolvedAfterRead !== canonicalId || !current || current.logicalId !== canonicalId ||
      current.providerId !== providerId || current.version !== version ||
      current.status !== resource.status) {
    throw new Error("The Gmail draft changed identity while it was being read. Retry it.");
  }
  const state = overlayGmailDraft(
    canonicalId, base, draftPending(ctx.store), ctx.store.decisions());
  if (!state) throw new Error("This Gmail draft is pending deletion or send.");
  return {state, resource: current};
}

async function walkRestrictedMessages(
    ctx: GmailContext, visit: (messages: readonly GmailMessageRef[]) => boolean,
    allowPartial = false): Promise<void> {
  if (!ctx.restricted) throw new Error("Expected a restricted Gmail binding.");
  const labelIds = ctx.labelId ? [ctx.labelId] : undefined;
  if (!ctx.searchQuery && !labelIds) throw new Error("Restricted Gmail binding has no restriction.");
  const seenTokens = new Set<string>();
  let pages = 0;
  let pageToken: string | undefined;
  do {
    const result = await ctx.api.listMessages(
      GMAIL_RESTRICTED_THREAD_PROVIDER_PAGE_SIZE, ctx.searchQuery, pageToken, labelIds);
    if (visit(result.messages)) return;
    pages++;
    pageToken = result.nextPageToken;
    if (pageToken) {
      if (seenTokens.has(pageToken)) throw new Error("Gmail returned a repeated page token.");
      seenTokens.add(pageToken);
      if (pages === MAX_GMAIL_RESTRICTED_THREAD_PROVIDER_PAGES) {
        if (allowPartial) return;
        throw new Error("The Gmail restriction contains too many messages to verify this capability.");
      }
    }
  } while (pageToken);
}

async function messagesAvailableThroughRestriction(
    ctx: GmailContext, soughtMessageIds: ReadonlySet<string>): Promise<Set<string>> {
  const remaining = new Set(soughtMessageIds);
  const matched = new Set<string>();
  await walkRestrictedMessages(ctx, messages => {
    for (const message of messages) {
      if (remaining.delete(message.id)) matched.add(message.id);
    }
    return remaining.size === 0;
  });
  return matched;
}

async function messageStillAvailable(ctx: GmailContext, messageId: string): Promise<boolean> {
  if (!ctx.restricted) return true;
  const matched = await messagesAvailableThroughRestriction(ctx, new Set([messageId]));
  return matched.has(messageId);
}

async function sourceStillAvailable(ctx: GmailContext, source: GmailDraftSource): Promise<boolean> {
  return messageStillAvailable(ctx, source.messageId);
}

async function restrictedThreadMessageIds(ctx: GmailContext, threadId: string): Promise<string[]> {
  const matched = new Set<string>();
  await walkRestrictedMessages(ctx, messages => {
    for (const message of messages) {
      if (message.threadId === threadId) matched.add(message.id);
    }
    if (matched.size > MAX_GMAIL_RESTRICTED_THREAD_MESSAGES) {
      throw new Error(
        `This restricted Gmail thread contains more than ` +
        `${MAX_GMAIL_RESTRICTED_THREAD_MESSAGES} messages.`);
    }
    return false;
  }, true);
  return [...matched];
}

async function restrictedThreadScope(
    ctx: GmailContext, threadId: string,
    sentMessageIds: readonly string[] = [],
    knownRestrictedMessageIds?: readonly string[]): Promise<GmailCapabilityScope> {
  const restrictedMessageIds = knownRestrictedMessageIds ??
    await restrictedThreadMessageIds(ctx, threadId);
  if (!restrictedMessageIds.length && !sentMessageIds.length) {
    throw new Error("This Gmail thread is not available through this restricted binding.");
  }
  const thread = await ctx.api.getThread(threadId);
  if (thread.id !== threadId) throw new Error("Gmail thread identity changed unexpectedly.");
  if (thread.messages.length > MAX_GMAIL_RESTRICTED_THREAD_MESSAGES) {
    throw new Error(
      `This restricted Gmail thread contains more than ` +
      `${MAX_GMAIL_RESTRICTED_THREAD_MESSAGES} messages.`);
  }
  const messageIds = [...new Set(thread.messages.map(message => message.id))];
  const admitted = messageIds.filter(messageId => restrictedMessageIds.includes(messageId));
  for (const messageId of sentMessageIds) {
    if (messageIds.includes(messageId) && ctx.store.isSentMessage(messageId) &&
        !admitted.includes(messageId)) {
      admitted.push(messageId);
    }
  }
  if (!admitted.length) {
    throw new Error("This Gmail thread is not available through this restricted binding.");
  }
  for (let i = 0; i < admitted.length; i += 5) {
    await Promise.all(admitted.slice(i, i + 5).map(async messageId => {
      const metadata = await ctx.api.getMessageMetadata(messageId);
      if (metadata.threadId !== threadId) {
        throw new Error("Gmail message thread identity changed unexpectedly.");
      }
      return undefined;
    }));
  }
  return gmailRestrictedScope(admitted);
}

function effectiveListQuery(ctx: GmailContext, caller?: string): string | undefined {
  return combineGmailQueries(ctx.searchQuery, caller);
}

function listLabelIds(ctx: GmailContext, defaultInbox: boolean): string[] | undefined {
  if (ctx.labelId) return [ctx.labelId];
  if (defaultInbox && !ctx.searchQuery) return ["INBOX"];
  return undefined;
}

function disposeEntryTargets<Entry>(
    entries: readonly Entry[], target: (entry: Entry) => GmailRpcTarget): void {
  for (const entry of entries) {
    try {
      target(entry)[Symbol.dispose]();
    } catch {
      // Continue releasing the rest of the unreturned page.
    }
  }
}

type OwnedGmailMessageEntry = Omit<GmailMessageEntry, "message"> & {message: GmailMessageStub};
type OwnedGmailThreadEntry = Omit<GmailThreadEntry, "thread"> & {thread: GmailThreadStub};
type OwnedGmailDraftEntry = Omit<GmailDraftEntry, "draft"> & {draft: GmailDraftStub};
type OwnedGmailAttachmentEntry = Omit<GmailAttachmentEntry, "attachment"> & {
  attachment: GmailAttachmentStub;
};

function gmailMessageCursor(
    ctx: GmailContext, query: string | undefined, labelIds: string[] | undefined,
    capabilityScope: GmailCapabilityScope): Cursor<GmailMessageEntry> {
  return new RpcCursor(new CursorPager<{
    id: string;
    threadId: string;
    snippet?: string;
    }, OwnedGmailMessageEntry>({
    provider: "Gmail",
    async fetchPage(pageToken) {
      const page = await ctx.api.listMessages(20, query, pageToken, labelIds);
      return {items: page.messages, nextPageToken: page.nextPageToken};
    },
    async buildEntries(messages) {
      const entries: OwnedGmailMessageEntry[] = [];
      try {
        if (messages.length === 0) return entries;
        const labels = await currentLabels(ctx);
        for (let i = 0; i < messages.length; i += 5) {
          const enriched = await Promise.all(messages.slice(i, i + 5).map(async ref => {
            const metadata = await ctx.api.getMessageMetadata(ref.id);
            const info = await messageInfo(ctx, parseGmailMessageMetadata(metadata), labels);
            const scope = capabilityScope.kind === "mailbox"
              ? capabilityScope
              : gmailRestrictedScope([ref.id]);
            return {ref, info, scope};
          }));
          entries.push(...enriched.map(({ref, info, scope}) => ({
            info,
            message: new GmailMessageStub(ctx, ref.id, ref.threadId, scope),
          })));
        }
        return entries;
      } catch (error) {
        disposeEntryTargets(entries, entry => entry.message);
        throw error;
      }
    },
    authorize: async entries => {
      await ctx.approvalQueue.authorizeObservation({
        title: `Read ${entries.length} Gmail messages`,
        description: "Fetch the next page of Gmail message results.",
      });
      for (const entry of entries) admitReturnedLabels(ctx, entry.info.labels);
    },
    disposeEntries: entries =>
      disposeEntryTargets(entries, entry => entry.message),
  }), ctx.approvalQueue);
}

function gmailFullThreadCursor(
    ctx: GmailContext, query: string | undefined, labelIds: string[] | undefined): Cursor<GmailThreadEntry> {
  return new RpcCursor(new CursorPager<{id: string; snippet?: string}, OwnedGmailThreadEntry>({
    provider: "Gmail",
    async fetchPage(pageToken) {
      const page = await ctx.api.listThreads(20, query, pageToken, labelIds);
      return {items: page.threads, nextPageToken: page.nextPageToken};
    },
    async buildEntries(threads) {
      const entries: OwnedGmailThreadEntry[] = [];
      try {
        if (threads.length === 0) return entries;
        const labels = await currentLabels(ctx);
        for (let i = 0; i < threads.length; i += 5) {
          const enriched = await Promise.all(threads.slice(i, i + 5).map(async thread => {
            const metadata = await threadInfo(
              ctx, await ctx.api.getThreadInfo(thread.id), labels);
            return {
              thread,
              info: {
                ...metadata,
                ...(thread.snippet !== undefined ? {snippet: thread.snippet} : {}),
              },
            };
          }));
          entries.push(...enriched.map(({thread, info}) => ({
            info,
            thread: new GmailThreadStub(ctx, thread.id, GMAIL_MAILBOX_SCOPE, info),
          })));
        }
        return entries;
      } catch (error) {
        disposeEntryTargets(entries, entry => entry.thread);
        throw error;
      }
    },
    authorize: async entries => {
      await ctx.approvalQueue.authorizeObservation({
        title: `Read ${entries.length} Gmail threads`,
        description: "Fetch the next page of Gmail thread results.",
      });
      for (const entry of entries) admitReturnedLabels(ctx, entry.info.labels);
    },
    disposeEntries: entries =>
      disposeEntryTargets(entries, entry => entry.thread),
  }), ctx.approvalQueue);
}

async function collectRestrictedThreadGroups(
    ctx: GmailContext, query: string | undefined,
    labelIds: string[] | undefined): Promise<Array<{threadId: string; messages: GmailMessageRef[]}>> {
  const messages: GmailMessageRef[] = [];
  const seenTokens = new Set<string>();
  let pages = 0;
  let pageToken: string | undefined;
  do {
    pages++;
    const page = await ctx.api.listMessages(
      GMAIL_RESTRICTED_THREAD_PROVIDER_PAGE_SIZE, query, pageToken, labelIds);
    const total = messages.length + page.messages.length;
    if (total > MAX_GMAIL_RESTRICTED_THREAD_MESSAGES ||
        (total >= MAX_GMAIL_RESTRICTED_THREAD_MESSAGES && page.nextPageToken)) {
      throw new Error(
        `This restricted Gmail thread search matches more than ` +
        `${MAX_GMAIL_RESTRICTED_THREAD_MESSAGES} messages. Narrow the query or use searchMessages().`);
    }
    messages.push(...page.messages);
    pageToken = page.nextPageToken;
    if (pageToken) {
      if (pages >= MAX_GMAIL_RESTRICTED_THREAD_PROVIDER_PAGES) {
        throw new Error(
          `Gmail returned more than ${MAX_GMAIL_RESTRICTED_THREAD_PROVIDER_PAGES} pages while ` +
          "collecting restricted thread results. Narrow the query or use searchMessages().");
      }
      if (seenTokens.has(pageToken)) throw new Error("Gmail returned a repeated page token.");
      seenTokens.add(pageToken);
    }
  } while (pageToken);
  return groupGmailMessagesByThread(messages);
}

function gmailRestrictedThreadCursor(
    ctx: GmailContext, query: string | undefined, labelIds: string[] | undefined): Cursor<GmailThreadEntry> {
  let pendingGroups: Promise<Array<{threadId: string; messages: GmailMessageRef[]}>> | undefined;
  const getGroups = async () => {
    if (!pendingGroups) pendingGroups = collectRestrictedThreadGroups(ctx, query, labelIds);
    const current = pendingGroups;
    try {
      return await current;
    } catch (error) {
      if (pendingGroups === current) pendingGroups = undefined;
      throw error;
    }
  };
  return new RpcCursor(new CursorPager<{
    threadId: string;
    messages: GmailMessageRef[];
  }, OwnedGmailThreadEntry>({
    provider: "Gmail",
    async fetchPage(pageToken) {
      const groups = await getGroups();
      const offset = pageToken === undefined ? 0 : Number(pageToken);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > groups.length) {
        throw new Error("Invalid internal Gmail thread cursor position.");
      }
      const items = groups.slice(offset, offset + GMAIL_RESTRICTED_THREAD_RESULT_PAGE_SIZE);
      const nextOffset = offset + items.length;
      return {
        items,
        ...(nextOffset < groups.length ? {nextPageToken: String(nextOffset)} : {}),
      };
    },
    async buildEntries(groups) {
      const entries: OwnedGmailThreadEntry[] = [];
      try {
        if (groups.length === 0) return entries;
        const labels = await currentLabels(ctx);
        for (const group of groups) {
          const metadata: Array<{ref: typeof group.messages[number]; info: GmailMessageInfoRaw}> = [];
          for (let i = 0; i < group.messages.length; i += 5) {
            metadata.push(...await Promise.all(group.messages.slice(i, i + 5).map(async ref => ({
              ref,
              info: parseGmailMessageMetadata(await ctx.api.getMessageMetadata(ref.id)),
            }))));
          }
          const first = metadata[0];
          if (!first) continue;
          const info = await threadInfo(ctx, summarizeGmailThread(
            group.threadId, first.ref.snippet, metadata.map(item => item.info)), labels);
          const scope = gmailRestrictedScope(metadata.map(item => item.info.id));
          entries.push({info, thread: new GmailThreadStub(ctx, group.threadId, scope, info)});
        }
        return entries;
      } catch (error) {
        disposeEntryTargets(entries, entry => entry.thread);
        throw error;
      }
    },
    authorize: async entries => {
      await ctx.approvalQueue.authorizeObservation({
        title: `Read ${entries.length} restricted Gmail threads`,
        description: "Fetch matching messages grouped into scope-preserving thread capabilities.",
      });
      for (const entry of entries) admitReturnedLabels(ctx, entry.info.labels);
    },
    disposeEntries: entries =>
      disposeEntryTargets(entries, entry => entry.thread),
  }), ctx.approvalQueue);
}

@validateRpc()
class GmailSessionImpl extends GmailRpcTarget implements GmailSession {
  #ctx: GmailContext;

  constructor(ctx: GmailContext) {
    super(ctx.approvalQueue);
    this.#ctx = ctx;
  }

  async #authorizeCursor(title: string, description: string): Promise<void> {
    await this.#ctx.approvalQueue.authorizeObservation({title, description});
  }

  async getMailboxAddress(): Promise<EmailAddress> {
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "Read Gmail mailbox address",
      description: "Read the email address of the connected Gmail mailbox.",
    });
    return {address: this.#ctx.selfEmail};
  }

  async listThreads(): Promise<Cursor<GmailThreadEntry>> {
    await this.#authorizeCursor(
      "List Gmail threads", "Create a cursor constrained to this Gmail binding.");
    const query = effectiveListQuery(this.#ctx);
    const labels = listLabelIds(this.#ctx, true);
    return this.#ctx.restricted
      ? gmailRestrictedThreadCursor(this.#ctx, query, labels)
      : gmailFullThreadCursor(this.#ctx, query, labels);
  }

  async searchThreads(query: string): Promise<Cursor<GmailThreadEntry>> {
    const effective = effectiveListQuery(this.#ctx, query);
    await this.#authorizeCursor(
      "Search Gmail threads",
      "Create a cursor for threads matching the binding restriction and supplied Gmail query.");
    const labels = listLabelIds(this.#ctx, false);
    return this.#ctx.restricted
      ? gmailRestrictedThreadCursor(this.#ctx, effective, labels)
      : gmailFullThreadCursor(this.#ctx, effective, labels);
  }

  async search(query: string): Promise<Cursor<GmailThreadEntry>> {
    return this.searchThreads(query);
  }

  async listMessages(): Promise<Cursor<GmailMessageEntry>> {
    await this.#authorizeCursor(
      "List Gmail messages", "Create a cursor constrained to this Gmail binding.");
    return gmailMessageCursor(
      this.#ctx, effectiveListQuery(this.#ctx), listLabelIds(this.#ctx, true),
      this.#ctx.restricted ? gmailRestrictedScope([]) : GMAIL_MAILBOX_SCOPE);
  }

  async searchMessages(query: string): Promise<Cursor<GmailMessageEntry>> {
    const effective = effectiveListQuery(this.#ctx, query);
    await this.#authorizeCursor(
      "Search Gmail messages",
      "Create a cursor for messages matching the binding restriction and supplied Gmail query.");
    return gmailMessageCursor(
      this.#ctx, effective, listLabelIds(this.#ctx, false),
      this.#ctx.restricted ? gmailRestrictedScope([]) : GMAIL_MAILBOX_SCOPE);
  }

  async getMessage(id: string): Promise<GmailMessage> {
    let providerId = id;
    let sentThroughBinding = false;
    if (GMAIL_PROVIDER_ID_RE.test(providerId)) {
      sentThroughBinding = this.#ctx.store.isSentMessage(providerId);
    } else {
      let normalizedId: string;
      try {
        normalizedId = `<${gmailMessageIdQueryValue(id)}>`;
      } catch {
        throw new Error("Invalid Gmail message ID.");
      }
      const receipt = this.#ctx.store.sentMessageByRfcMessageId(normalizedId);
      if (!receipt) {
        if (this.#ctx.store.hasPendingSend(normalizedId)) {
          throw new Error("This Gmail send is pending or has not been reconciled yet.");
        }
        throw new Error("Unknown Gmail message ID.");
      }
      providerId = receipt.providerId;
      sentThroughBinding = true;
    }
    if (!sentThroughBinding && !await messageStillAvailable(this.#ctx, providerId)) {
      throw new Error("This Gmail message is not available through this restricted binding.");
    }
    let metadata: GmailMessageFull;
    try {
      metadata = await this.#ctx.api.getMessageMetadata(providerId);
    } catch (error) {
      if (this.#ctx.restricted && error instanceof GmailApiError && error.status === 404) {
        throw new Error(
          "This Gmail message is not available through this restricted binding.", {cause: error});
      }
      throw error;
    }
    if (metadata.id !== providerId) throw new Error("Gmail message identity changed unexpectedly.");
    const info = parseGmailMessageMetadata(metadata);
    await this.#ctx.approvalQueue.authorizeObservation({
      title: sanitizeApprovalTitle(`Open Gmail message: ${info.subject || "(no subject)"}`),
      description: "Open a known Gmail message by its stable ID within this binding.",
    });
    const scope = this.#ctx.restricted ? gmailRestrictedScope([providerId]) : GMAIL_MAILBOX_SCOPE;
    return new GmailMessageStub(this.#ctx, providerId, info.threadId, scope, undefined, info);
  }

  async getThread(id: string): Promise<GmailThread> {
    if (!GMAIL_PROVIDER_ID_RE.test(id)) throw new Error("Invalid Gmail thread ID.");
    if (!this.#ctx.restricted) {
      const info = await threadInfo(this.#ctx, await this.#ctx.api.getThreadInfo(id));
      await this.#ctx.approvalQueue.authorizeObservation({
        title: sanitizeApprovalTitle(`Open Gmail thread: ${info.subject || "(no subject)"}`),
        description: "Open a known Gmail thread by its stable ID within this binding.",
      });
      return new GmailThreadStub(this.#ctx, id, GMAIL_MAILBOX_SCOPE, info);
    }
    const admitted = await restrictedThreadMessageIds(this.#ctx, id);
    if (!admitted.length) {
      throw new Error("This Gmail thread is not available through this restricted binding.");
    }
    let scope: GmailCapabilityScope;
    try {
      scope = await restrictedThreadScope(this.#ctx, id, [], admitted);
    } catch (error) {
      if (error instanceof GmailApiError && error.status === 404) {
        throw new Error(
          "This Gmail thread is not available through this restricted binding.", {cause: error});
      }
      throw error;
    }
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "Open Gmail thread",
      description: "Open the messages admitted by a known Gmail thread ID within this binding.",
    });
    return new GmailThreadStub(this.#ctx, id, scope);
  }

  async send(
      to: string[], subject: string, body: string, options: GmailComposeOptions = {}): Promise<string> {
    if (this.#ctx.restricted) {
      throw new Error(
        "send() is unavailable on a search- or label-scoped binding. Use a message capability.");
    }
    const message = this.#ctx.api.buildSendRaw(to, subject, body, options);
    validateOutboundFields(message, message.subject, message.body, message.html);
    await submitAction(this.#ctx, {
      type: "send",
      mode: "new",
      spec: outboundSpec(message),
    }, {
      title: sanitizeApprovalTitle(`Send email: ${message.subject}`),
      description: describeOutboundMessage("Send a new email.", message),
      awaitDecision: true,
    });
    return message.messageId;
  }

  async listDrafts(): Promise<Cursor<GmailDraftEntry>> {
    await this.#authorizeCursor(
      "List Gmail drafts", "Create a cursor for drafts available through this Gmail binding.");
    return gmailDraftCursor(this.#ctx);
  }

  async getDraft(id: string): Promise<GmailDraft> {
    if (!GMAIL_LOGICAL_ID_RE.test(id)) throw new Error("Invalid Gmail draft ID.");
    const resource = this.#ctx.store.getDraft(id);
    if (!resource) throw new Error("Unknown Gmail draft ID for this binding.");
    if (this.#ctx.restricted &&
        (!resource.source || !await sourceStillAvailable(this.#ctx, resource.source))) {
      throw new Error("This Gmail draft is not available through this restricted binding.");
    }
    const {state} = await loadSimulatedDraft(this.#ctx, resource.logicalId);
    await this.#ctx.approvalQueue.authorizeObservation({
      title: sanitizeApprovalTitle(`Open Gmail draft: ${state.subject || "(no subject)"}`),
      description: "Reopen a known draft capability with pending changes overlaid.",
    });
    return new GmailDraftStub(this.#ctx, state.logicalId);
  }

  async createDraft(input: GmailDraftInput): Promise<GmailDraft> {
    if (this.#ctx.restricted) {
      throw new Error("createDraft() is only available on a whole-mailbox Gmail binding.");
    }
    const recipients = normalizeAggregateRecipients(input.to, input.cc, input.bcc);
    const logicalId = newGmailLogicalId("draft");
    const now = Date.now();
    const state: GmailDraftState = {
      logicalId,
      from: this.#ctx.selfEmail,
      replyTo: [],
      ...recipients,
      date: new Date(now).toUTCString(),
      subject: input.subject ?? "",
      text: input.text ?? "",
      ...(input.html !== undefined ? {html: input.html} : {}),
      rfcMessageId: newGmailMessageId(),
      timestamp: now,
      attachments: [],
      version: 0,
    };
    validateDraftState(state);
    const resource: GmailDraftResource = {
      logicalId, createdAt: now, status: "active", version: 0,
    };
    this.#ctx.store.putDraft(resource);
    const action: GmailDraftCreateAction = {
      type: "draftCreate", draft: state,
    };
    await submitAction(this.#ctx, action, {
      title: sanitizeApprovalTitle(`Create Gmail draft: ${state.subject || "(no subject)"}`),
      description: describeDraftAction("Create a draft.", state),
    }, () => this.#ctx.store.deleteDraft(logicalId));
    return new GmailDraftStub(this.#ctx, logicalId);
  }

  async listLabels(): Promise<GmailLabel[]> {
    if (this.#ctx.restricted) {
      throw new Error("listLabels() is only available on a whole-mailbox Gmail binding.");
    }
    const labels = await currentLabels(this.#ctx);
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "List Gmail labels",
      description: `Read ${labels.labels.length} system and custom Gmail labels.`,
    });
    return labels.labels.filter(label => label.type === "user" || SYSTEM_LABELS.has(label.id))
      .map(label => label.type === "system"
      ? {id: label.id, name: label.name as GmailSystemLabel, type: "system" as const}
      : {id: label.id, name: label.name, type: "custom" as const});
  }

  async createLabel(name: string): Promise<GmailCustomLabel> {
    if (this.#ctx.restricted) {
      throw new Error("createLabel() is only available on a whole-mailbox Gmail binding.");
    }
    validateGmailLabelName(name);
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "Check Gmail label name",
      description: "Verify that the requested custom label name is not already in use.",
    });
    const existing = (await currentLabels(this.#ctx)).labels.some(
      label => label.type === "user" && label.name === name);
    if (existing) throw new Error("A Gmail label with this name already exists.");
    const logicalId = newGmailLogicalId("label");
    const resource: GmailLabelResource = {logicalId, name, status: "active"};
    this.#ctx.store.putLabel(resource);
    await submitAction(this.#ctx, {type: "labelCreate", label: resource}, {
      title: sanitizeApprovalTitle(`Create Gmail label: ${name}`),
      description: formatApprovalField("New label", name),
    }, () => this.#ctx.store.deleteLabel(logicalId));
    return {id: logicalId, name, type: "custom"};
  }

  async renameLabel(label: GmailCustomLabel, name: string): Promise<GmailCustomLabel> {
    if (this.#ctx.restricted) {
      throw new Error("renameLabel() is only available on a whole-mailbox Gmail binding.");
    }
    validateGmailLabelName(name);
    let generation: number;
    let canonical: CanonicalMutableLabel;
    do {
      generation = this.#ctx.store.actionGeneration();
      canonical = await resolveMutableLabel(this.#ctx, label);
    } while (generation !== this.#ctx.store.actionGeneration());
    if (canonical.type !== "custom") throw new Error("System Gmail labels cannot be renamed.");
    const resource = ensureLabelResource(this.#ctx, canonical);
    const dependencies = dependenciesFor(this.#ctx.store, resource.logicalId, "label");
    await submitAction(this.#ctx, {
      type: "labelRename", labelId: resource.logicalId, name,
      expectedName: canonical.name, dependsOn: dependencies,
    }, {
      title: sanitizeApprovalTitle(`Rename Gmail label: ${canonical.name}`),
      description: `${formatApprovalField("Current name", canonical.name)}\n\n` +
        formatApprovalField("New name", name),
    });
    return {id: resource.logicalId, name, type: "custom"};
  }

  async deleteLabel(label: GmailCustomLabel): Promise<void> {
    if (this.#ctx.restricted) {
      throw new Error("deleteLabel() is only available on a whole-mailbox Gmail binding.");
    }
    const canonical = await resolveMutableLabel(this.#ctx, label);
    if (canonical.type !== "custom") throw new Error("System Gmail labels cannot be deleted.");
    const resource = ensureLabelResource(this.#ctx, canonical);
    const pendingUses = this.#ctx.store.listActions().filter(item =>
      item.action.type === "messageMutation" && item.action.labelId === resource.logicalId);
    if (pendingUses.length) {
      throw new Error(
        "Resolve pending message actions that use this Gmail label before deleting it.");
    }
    await submitAction(this.#ctx, {
      type: "labelDelete",
      labelId: resource.logicalId,
      dependsOn: dependenciesFor(this.#ctx.store, resource.logicalId, "label"),
    }, {
      title: sanitizeApprovalTitle(`Delete Gmail label: ${canonical.name}`),
      description: formatApprovalField("Label", canonical.name),
    });
  }
}

@validateRpc()
class GmailScopedSessionImpl extends GmailRpcTarget implements GmailScopedSession {
  #mailbox: GmailSessionImpl;

  constructor(ctx: GmailContext) {
    super(ctx.approvalQueue);
    this.#mailbox = new GmailSessionImpl(ctx);
  }

  getMailboxAddress(): Promise<EmailAddress> { return this.#mailbox.getMailboxAddress(); }
  listThreads(): Promise<Cursor<GmailThreadEntry>> { return this.#mailbox.listThreads(); }
  searchThreads(query: string): Promise<Cursor<GmailThreadEntry>> {
    return this.#mailbox.searchThreads(query);
  }
  search(query: string): Promise<Cursor<GmailThreadEntry>> { return this.#mailbox.search(query); }
  listMessages(): Promise<Cursor<GmailMessageEntry>> { return this.#mailbox.listMessages(); }
  searchMessages(query: string): Promise<Cursor<GmailMessageEntry>> {
    return this.#mailbox.searchMessages(query);
  }
  getMessage(id: string): Promise<GmailMessage> { return this.#mailbox.getMessage(id); }
  getThread(id: string): Promise<GmailThread> { return this.#mailbox.getThread(id); }
  listDrafts(): Promise<Cursor<GmailDraftEntry>> { return this.#mailbox.listDrafts(); }
  getDraft(id: string): Promise<GmailDraft> { return this.#mailbox.getDraft(id); }

  [Symbol.dispose](): void {
    this.#mailbox[Symbol.dispose]();
    super[Symbol.dispose]();
  }
}

async function resolveMutableLabel(
    ctx: GmailContext, candidate: unknown): Promise<CanonicalMutableLabel> {
  if (ctx.restricted) {
    const id = candidate && typeof candidate === "object"
      ? (candidate as Record<string, unknown>).id
      : undefined;
    if (typeof id !== "string" || !ctx.store.isLabelAdmitted(id)) {
      throw new Error("This Gmail label is unavailable through this restricted binding.");
    }
  }
  await ctx.approvalQueue.authorizeObservation({
    title: "Resolve Gmail label",
    description: "Resolve the supplied label ID against this connected Gmail account.",
  });
  const provider = await ctx.providerLabels();
  const resources = ctx.store.listLabels();
  const canonical = canonicalizeGmailMutableLabel(candidate, provider, resources);
  if (ctx.restricted && !ctx.store.isLabelAdmitted(canonical.id)) {
    throw new Error("This Gmail label has not been returned by this restricted binding.");
  }
  const current = canonical.type === "custom"
    ? overlayGmailLabels(provider, resources, labelPending(ctx.store), ctx.store.decisions())
      .find(label => label.id === canonical.id)
    : undefined;
  if (canonical.type === "custom" && !current) {
    throw new Error("This Gmail label is pending deletion.");
  }
  return current
    ? {id: canonical.id, name: current.name, type: "custom"}
    : canonical;
}

function ensureLabelResource(ctx: GmailContext, label: GmailCustomLabel): GmailLabelResource {
  const existing = ctx.store.getLabel(label.id) ?? ctx.store.labelForProvider(label.id);
  if (existing) return existing;
  const resource: GmailLabelResource = {
    logicalId: label.id,
    providerId: label.id,
    name: label.name,
    status: "active",
  };
  ctx.store.putLabel(resource);
  return resource;
}

function labelActionId(ctx: GmailContext, label: CanonicalMutableLabel): {
  id: string;
  dependencies: number[];
} {
  if (label.type === "system") return {id: label.id, dependencies: []};
  const resource = ensureLabelResource(ctx, label);
  return {
    id: resource.logicalId,
    dependencies: dependenciesFor(ctx.store, resource.logicalId, "label"),
  };
}

function mutationAliasMethod(
    operation: GmailMutationOperation, label: CanonicalMutableLabel | undefined): string | undefined {
  if (label?.type !== "system") return undefined;
  if (operation === "applyLabel") {
    switch (label.id) {
    case "TRASH": return "trash";
    case "UNREAD": return "markUnread";
    case "STARRED": return "star";
    }
  }
  if (operation === "removeLabel") {
    switch (label.id) {
    case "INBOX": return "archive";
    case "UNREAD": return "markRead";
    case "STARRED": return "unstar";
    }
  }
  return undefined;
}

async function submitMutation(
    ctx: GmailContext, operation: GmailMutationOperation,
    target: ReturnType<typeof gmailMutationTarget>, title: string, description: string,
    label?: CanonicalMutableLabel): Promise<void> {
  const alias = mutationAliasMethod(operation, label);
  if (alias && label) {
    throw new Error(`Use ${alias}() instead of ${operation}() with the ${label.id} system label.`);
  }
  const resolved = label ? labelActionId(ctx, label) : undefined;
  await submitAction(ctx, {
    type: "messageMutation",
    operation,
    target,
    ...(resolved ? {labelId: resolved.id, dependsOn: resolved.dependencies} : {}),
  }, {
    title: sanitizeApprovalTitle(title),
    description: description + "\n\n" + formatApprovalField(
      "Mutation scope",
      target.kind === "thread"
        ? "the complete thread admitted by a whole-mailbox binding"
        : `${target.messageIds.length} explicitly admitted individual message(s)`) +
      "\n\n" + formatApprovalField(
        target.kind === "thread" ? "Thread ID" : "Message IDs",
        target.kind === "thread" ? target.threadId : target.messageIds.join("\n")) +
      (resolved ? `\n\n${formatApprovalField("Label ID", resolved.id)}` : ""),
    // Message label mutations are not overlaid into provider message reads.
    awaitDecision: true,
  });
}

@validateRpc()
class GmailThreadStub extends GmailRpcTarget implements GmailThread {
  #ctx: GmailContext;
  #threadId: string;
  #scope: GmailCapabilityScope;
  #cachedInfo?: GmailThreadInfo;

  constructor(
      ctx: GmailContext, threadId: string, scope: GmailCapabilityScope,
      cachedInfo?: GmailThreadInfo) {
    super(ctx.approvalQueue);
    this.#ctx = ctx;
    this.#threadId = threadId;
    this.#scope = scope;
    this.#cachedInfo = cachedInfo;
  }

  async #loadInfo(): Promise<GmailThreadInfo> {
    if (this.#cachedInfo) {
      const info = this.#cachedInfo;
      this.#cachedInfo = undefined;
      return info;
    }
    if (this.#scope.kind === "mailbox") {
      return threadInfo(this.#ctx, await this.#ctx.api.getThreadInfo(this.#threadId));
    }
    const admitted = this.#scope.admittedMessageIds;
    if (!admitted.length) throw new Error("This restricted Gmail thread admits no messages.");
    const metadata: GmailMessageFull[] = [];
    for (let i = 0; i < admitted.length; i += 5) {
      metadata.push(...await Promise.all(
        admitted.slice(i, i + 5).map(id => this.#ctx.api.getMessageMetadata(id))));
    }
    const parsed = metadata.map(parseGmailMessageMetadata);
    return threadInfo(this.#ctx, summarizeGmailThread(
      this.#threadId, metadata[0]?.snippet, parsed));
  }

  async #messageIds(): Promise<string[]> {
    if (this.#scope.kind === "restricted") return [...this.#scope.admittedMessageIds];
    const thread = await this.#ctx.api.getThread(this.#threadId);
    return gmailMessagesAllowedByScope(this.#scope, thread.messages).map(message => message.id);
  }

  async getMetadata(): Promise<GmailThreadInfo> {
    const info = await this.#loadInfo();
    await this.#ctx.approvalQueue.authorizeObservation({
      title: sanitizeApprovalTitle(`Gmail thread: ${info.subject}`),
      description: "Read metadata for the messages admitted by this thread capability.",
    });
    admitReturnedLabels(this.#ctx, info.labels);
    return info;
  }

  async messages(): Promise<GmailMessage[]> {
    const ids = await this.#messageIds();
    await this.#ctx.approvalQueue.authorizeObservation({
      title: `Read ${ids.length} Gmail thread messages`,
      description: "Create message capabilities for the admitted portion of this thread.",
    });
    return ids.map(id => new GmailMessageStub(this.#ctx, id, this.#threadId, this.#scope));
  }

  async messagesVisibleTo(address: string): Promise<GmailMessage[]> {
    validateGmailAddress(address);
    const [normalized] = normalizeEmailRecipients([address]);
    const ids = await this.#messageIds();
    if (ids.length > MAX_GMAIL_VISIBLE_THREAD_MESSAGES) {
      throw new Error(
        `This thread capability has ${ids.length} messages; at most ` +
        `${MAX_GMAIL_VISIBLE_THREAD_MESSAGES} can be filtered by participant.`);
    }
    const target = emailRecipientToAddress(normalized).address.toLowerCase();
    const visible: string[] = [];
    for (let i = 0; i < ids.length; i += 5) {
      const batch = ids.slice(i, i + 5);
      const participants = await Promise.all(
        batch.map(id => this.#ctx.api.getMessageParticipants(id)));
      for (let j = 0; j < batch.length; j++) {
        if (participants[j].has(target)) visible.push(batch[j]);
      }
    }
    await this.#ctx.approvalQueue.authorizeObservation({
      title: `Read ${visible.length} participant-visible Gmail messages`,
      description: "Filter the admitted thread messages by an exact participant address.",
    });
    return visible.map(id => new GmailMessageStub(this.#ctx, id, this.#threadId, this.#scope));
  }

  async #mutate(operation: GmailMutationOperation, label?: GmailMutableLabel): Promise<void> {
    const info = await this.#loadInfo();
    const canonical = label ? await resolveMutableLabel(this.#ctx, label) : undefined;
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "Read Gmail thread before mutation",
      description: "Read the admitted thread metadata needed to describe this action.",
    });
    await submitMutation(
      this.#ctx,
      operation,
      gmailMutationTarget(this.#scope, this.#threadId),
      `${mutationTitle(operation)}: ${info.subject || "(no subject)"}`,
      mutationDescription(operation, canonical),
      canonical);
  }

  async archive(): Promise<void> { await this.#mutate("archive"); }
  async trash(): Promise<void> { await this.#mutate("trash"); }
  async markRead(): Promise<void> { await this.#mutate("markRead"); }
  async markUnread(): Promise<void> { await this.#mutate("markUnread"); }
  async star(): Promise<void> { await this.#mutate("star"); }
  async unstar(): Promise<void> { await this.#mutate("unstar"); }
  @skipRpcValidation()
  async applyLabel(label: GmailMutableLabel): Promise<void> { await this.#mutate("applyLabel", label); }
  @skipRpcValidation()
  async removeLabel(label: GmailMutableLabel): Promise<void> { await this.#mutate("removeLabel", label); }
}

function mutationTitle(operation: GmailMutationOperation): string {
  switch (operation) {
    case "archive": return "Archive";
    case "trash": return "Trash";
    case "markRead": return "Mark read";
    case "markUnread": return "Mark unread";
    case "star": return "Star";
    case "unstar": return "Unstar";
    case "applyLabel": return "Apply label";
    case "removeLabel": return "Remove label";
  }
}

function mutationDescription(
    operation: GmailMutationOperation, label?: CanonicalMutableLabel): string {
  if (operation === "applyLabel" || operation === "removeLabel") {
    return `${operation === "applyLabel" ? "Apply" : "Remove"} the resolved Gmail label.\n\n` +
      formatApprovalField("Label", label?.name ?? "(unknown)");
  }
  return `${mutationTitle(operation)} only the messages admitted by this capability.`;
}

@validateRpc()
class GmailMessageStub extends GmailRpcTarget implements GmailMessage {
  #ctx: GmailContext;
  #messageId: string;
  #threadId: string;
  #scope: GmailCapabilityScope;
  #cachedRaw?: GmailMessageRaw;
  #cachedInfo?: GmailMessageInfoRaw;

  constructor(
      ctx: GmailContext, messageId: string, threadId: string, scope: GmailCapabilityScope,
      cachedRaw?: GmailMessageRaw, cachedInfo?: GmailMessageInfoRaw) {
    if (!gmailScopeAllowsMessage(scope, messageId)) {
      throw new Error("Message is outside this Gmail capability's admitted scope.");
    }
    super(ctx.approvalQueue);
    this.#ctx = ctx;
    this.#messageId = messageId;
    this.#threadId = threadId;
    this.#scope = scope;
    this.#cachedRaw = cachedRaw;
    this.#cachedInfo = cachedInfo;
  }

  async #raw(): Promise<GmailMessageRaw> {
    this.#cachedRaw ??= await this.#ctx.api.getMessage(this.#messageId);
    if (this.#cachedRaw.threadId !== this.#threadId) {
      throw new Error("Gmail message thread identity changed unexpectedly.");
    }
    return this.#cachedRaw;
  }

  async #forwardSource(): Promise<GmailMessageRaw> {
    const metadata = await this.#ctx.api.getMessageMetadata(this.#messageId);
    if ((metadata.sizeEstimate ?? 0) > MAX_GMAIL_FORWARD_SOURCE_BYTES) {
      throw new Error(
        `Cannot forward this message: it exceeds the ${MAX_GMAIL_FORWARD_SOURCE_BYTES}-byte safe limit.`);
    }
    return this.#raw();
  }

  async #info(): Promise<GmailMessageInfoRaw> {
    const metadata = await this.#ctx.api.getMessageMetadata(this.#messageId);
    if (metadata.threadId !== this.#threadId) {
      throw new Error("Gmail message thread identity changed unexpectedly.");
    }
    this.#cachedInfo = parseGmailMessageMetadata(metadata);
    return this.#cachedInfo;
  }

  async getMetadata(): Promise<GmailMessageInfo> {
    const info = await messageInfo(this.#ctx, await this.#info());
    await this.#ctx.approvalQueue.authorizeObservation({
      title: sanitizeApprovalTitle(`Gmail message: ${info.subject}`),
      description: "Read sender, recipients, timestamp, subject, and labels for this message.",
    });
    admitReturnedLabels(this.#ctx, info.labels);
    return info;
  }

  async getHeaders(): Promise<GmailHeader[]> {
    let headers: GmailHeader[];
    if (this.#cachedRaw) {
      headers = await this.#ctx.api.parseMessageHeaders(this.#cachedRaw);
    } else {
      const full = await this.#ctx.api.getMessageFull(this.#messageId);
      if (full.threadId !== this.#threadId) throw new Error("Gmail message identity changed.");
      headers = this.#ctx.api.collectMessageHeaders(full.payload?.headers ?? []);
    }
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "Read Gmail message headers",
      description: `Read ${headers.length} ordered headers from this message.`,
    });
    return headers;
  }

  async thread(): Promise<GmailThread> {
    const scope = this.#scope.kind === "mailbox"
      ? this.#scope
      : await restrictedThreadScope(
        this.#ctx,
        this.#threadId,
        this.#scope.admittedMessageIds.filter(messageId => this.#ctx.store.isSentMessage(messageId)),
      );
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "Open Gmail message thread",
      description: "Create a thread capability carrying the messages admitted by this binding.",
    });
    return new GmailThreadStub(this.#ctx, this.#threadId, scope);
  }

  async getContent(): Promise<EmailContent> {
    let rawInfo: GmailMessageInfoRaw;
    let content: EmailContent;
    if (this.#cachedRaw) {
      const parsed = await this.#ctx.api.parseMessage(this.#cachedRaw);
      rawInfo = parsed.info;
      content = parsed.content;
    } else {
      const full = await this.#ctx.api.getMessageFull(this.#messageId);
      if (full.threadId !== this.#threadId) throw new Error("Gmail message identity changed.");
      rawInfo = parseGmailMessageMetadata(full);
      content = await this.#ctx.api.getMessageContent(full);
    }
    this.#cachedInfo = rawInfo;
    await this.#ctx.approvalQueue.authorizeObservation({
      title: sanitizeApprovalTitle(`Read Gmail message: ${rawInfo.subject}`),
      description: "Read the plain-text and HTML representations of this message.",
    });
    return content;
  }

  async attachments(): Promise<GmailAttachmentEntry[]> {
    const full = await this.#ctx.api.getMessageFull(this.#messageId);
    if (full.threadId !== this.#threadId) throw new Error("Gmail message identity changed.");
    const snapshots = enumerateGmailAttachments(this.#messageId, full.payload);
    await this.#ctx.approvalQueue.authorizeObservation({
      title: `List ${snapshots.length} Gmail attachments`,
      description: "Read attachment and inline MIME-part metadata for this message.",
    });
    return snapshots.map(snapshot => ({
      info: snapshot.info,
      attachment: new GmailAttachmentStub(
        this.#ctx, snapshot.info, () => this.#ctx.api.getAttachmentContent(snapshot)),
    }));
  }

  async #reply(body: string, replyAll: boolean, options: GmailReplyOptions = {}): Promise<string> {
    validateGmailBody(body);
    if (options.html !== undefined) validateGmailBody(options.html);
    const source = await this.#ctx.api.getMessageMetadata(this.#messageId);
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "Read Gmail source message to prepare reply",
      description: "Read immutable source headers needed for recipients and thread placement.",
    });
    const message = await this.#ctx.api.buildReplyFromMetadata(source, body, replyAll, options);
    validateOutboundFields(message, message.subject, message.body, message.html);
    await submitAction(this.#ctx, {
      type: "send",
      mode: "reply",
      spec: outboundSpec(message),
      threadId: this.#threadId,
      sourceMessageId: this.#messageId,
    }, {
      title: sanitizeApprovalTitle(`${replyAll ? "Reply all" : "Reply"}: ${message.subject}`),
      description: describeOutboundMessage(
        replyAll ? "Send a reply to all calculated recipients." : "Send a reply.", message) +
        `\n\n${formatApprovalField("Source message", this.#messageId)}` +
        `\n\n${formatApprovalField("Threading mode", "reply in source thread")}`,
      awaitDecision: true,
    });
    return message.messageId;
  }

  async reply(body: string, options?: GmailReplyOptions): Promise<string> {
    return this.#reply(body, false, options);
  }

  async replyAll(body: string, options?: GmailReplyOptions): Promise<string> {
    return this.#reply(body, true, options);
  }

  async forward(
      to: string[], body?: string, options: GmailComposeOptions = {}): Promise<string> {
    const source = await this.#forwardSource();
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "Read Gmail source message to prepare forward",
      description: "Read the complete source message and attachment metadata for an inline forward.",
    });
    const message = await this.#ctx.api.buildForwardRaw(source, to, body, options);
    validateForwardFields(message, body, options);
    const snapshot = await captureSourceAttachment(this.#ctx.store, source, message);
    try {
      await submitAction(this.#ctx, {
        type: "send",
        mode: "forward",
        spec: inlineForwardSpec(message, body, options),
        sourceMessageId: this.#messageId,
        sourceAttachment: snapshot,
        forwardFormat: "inline",
      }, {
        title: sanitizeApprovalTitle(`Forward: ${message.subject}`),
        description: describeOutboundMessage(
          "Forward this message inline with its original body and attachments.", message) +
          `\n\n${formatApprovalField("Source message", this.#messageId)}` +
          `\n\n${formatApprovalField("Threading mode", "new forward message")}`,
        awaitDecision: true,
      }, () => this.#ctx.store.deleteForwardSnapshot(snapshot));
      return message.messageId;
    } catch (error) {
      this.#ctx.store.deleteForwardSnapshot(snapshot);
      throw error;
    }
  }

  async #createReplyDraft(
      body: string, replyAll: boolean, options: GmailReplyOptions = {}): Promise<GmailDraft> {
    validateGmailBody(body);
    const source = await this.#ctx.api.getMessageMetadata(this.#messageId);
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "Read Gmail source message to prepare reply draft",
      description: "Read immutable source headers needed for draft recipients and threading.",
    });
    const message = await this.#ctx.api.buildReplyFromMetadata(source, body, replyAll, options);
    validateOutboundFields(message, message.subject, message.body, message.html);
    return createDraftFromMessage(
      this.#ctx, message, {kind: "reply", messageId: this.#messageId}, this.#threadId);
  }

  async createReplyDraft(body: string, options?: GmailReplyOptions): Promise<GmailDraft> {
    return this.#createReplyDraft(body, false, options);
  }

  async createReplyAllDraft(body: string, options?: GmailReplyOptions): Promise<GmailDraft> {
    return this.#createReplyDraft(body, true, options);
  }

  async createForwardDraft(
      to: string[], body?: string, options: GmailComposeOptions = {}): Promise<GmailDraft> {
    const source = await this.#forwardSource();
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "Read Gmail source message to prepare forward draft",
      description: "Read the complete source message for the draft's inline forwarded content.",
    });
    const message = await this.#ctx.api.buildForwardRaw(source, to, body, options);
    validateForwardFields(message, body, options);
    const snapshot = await captureSourceAttachment(this.#ctx.store, source, message);
    return createDraftFromMessage(
      this.#ctx, message, {kind: "forward", messageId: this.#messageId, format: "inline"}, undefined,
      snapshot, {body, options});
  }

  async #mutate(operation: GmailMutationOperation, label?: GmailMutableLabel): Promise<void> {
    const rawInfo = await this.#info();
    const canonical = label ? await resolveMutableLabel(this.#ctx, label) : undefined;
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "Read Gmail message before mutation",
      description: "Read current message metadata needed to describe this action.",
    });
    await submitMutation(
      this.#ctx,
      operation,
      {kind: "messages", messageIds: [this.#messageId]},
      `${mutationTitle(operation)}: ${rawInfo.subject || "(no subject)"}`,
      mutationDescription(operation, canonical),
      canonical);
  }

  async archive(): Promise<void> { await this.#mutate("archive"); }
  async trash(): Promise<void> { await this.#mutate("trash"); }
  async markRead(): Promise<void> { await this.#mutate("markRead"); }
  async markUnread(): Promise<void> { await this.#mutate("markUnread"); }
  async star(): Promise<void> { await this.#mutate("star"); }
  async unstar(): Promise<void> { await this.#mutate("unstar"); }
  @skipRpcValidation()
  async applyLabel(label: GmailMutableLabel): Promise<void> { await this.#mutate("applyLabel", label); }
  @skipRpcValidation()
  async removeLabel(label: GmailMutableLabel): Promise<void> { await this.#mutate("removeLabel", label); }
}

@validateRpc()
class GmailAttachmentStub extends GmailRpcTarget implements GmailAttachment {
  #ctx: GmailContext;
  #info: GmailAttachmentInfo;
  #read: () => Promise<ArrayBuffer>;
  #validate?: () => void;

  constructor(
      ctx: GmailContext, info: GmailAttachmentInfo, read: () => Promise<ArrayBuffer>,
      validate?: () => void) {
    super(ctx.approvalQueue);
    this.#ctx = ctx;
    this.#info = info;
    this.#read = read;
    this.#validate = validate;
  }

  async getMetadata(): Promise<GmailAttachmentInfo> {
    this.#validate?.();
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "Read Gmail attachment metadata",
      description: "Read filename, MIME type, size, disposition, and availability.",
    });
    this.#validate?.();
    return this.#info;
  }

  async getContent(): Promise<ArrayBuffer> {
    this.#validate?.();
    if (!this.#info.readable || this.#info.size > MAX_GMAIL_ATTACHMENT_BYTES) {
      throw new Error(
        `Attachment is unavailable or exceeds the ${MAX_GMAIL_ATTACHMENT_BYTES}-byte safe limit.`);
    }
    const content = await this.#read();
    this.#validate?.();
    if (content.byteLength !== this.#info.size || content.byteLength > MAX_GMAIL_ATTACHMENT_BYTES) {
      throw new Error("Attachment no longer matches the authorized snapshot.");
    }
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "Read Gmail attachment content",
      description: `Read ${content.byteLength} bytes from this snapshot-bound MIME part.`,
    });
    this.#validate?.();
    return content;
  }
}

function describeDraftAction(
    intro: string, state: GmailDraftState, message?: GmailOutboundMessage): string {
  const from = message?.from ?? state.from;
  const replyTo = message?.replyTo ?? state.replyTo;
  const to = message?.to ?? state.to;
  const cc = message?.cc ?? state.cc;
  const bcc = message?.bcc ?? state.bcc;
  const subject = message?.subject ?? state.subject;
  const text = message?.body ?? state.text;
  const html = message?.html ?? state.html;
  const attachments = message
    ? message.attachments.map(attachment => formatApprovalField(
      "Attachment", `${attachment.filename || "(unnamed)"} (${attachment.contentType})\n` +
      attachment.description))
    : state.attachments.map(attachment => formatApprovalField(
      "Attachment",
      `${attachment.info.filename ?? "(unnamed)"} (${attachment.info.mimeType}, ` +
      `${attachment.info.size} bytes)`));
  const fields = [
    formatApprovalField("From", from),
    ...(replyTo.length ? [formatApprovalField("Reply-To", replyTo.join(", "))] : []),
    ...(to.length ? [formatApprovalField("To", to.join(", "))] : []),
    ...(cc.length ? [formatApprovalField("Cc", cc.join(", "))] : []),
    ...(bcc.length ? [formatApprovalField("Bcc", bcc.join(", "))] : []),
    formatApprovalField("Subject", subject),
    formatApprovalField("Plain text", text),
    ...(html !== undefined ? [formatApprovalField("HTML", html)] : []),
    ...attachments,
    ...(state.source ? [formatApprovalField(
      "Source", `${state.source.kind} from message ${state.source.messageId}`)] : []),
    ...(state.inReplyTo ? [formatApprovalField("Threading mode", "reply in source thread")] : []),
  ];
  return `${intro}\n\n${fields.join("\n\n")}`;
}

function describeDraftDeletion(state: GmailDraftState): string {
  return "Delete this draft without sending it.\n\n" +
    formatApprovalField("Draft ID", state.logicalId) + "\n\n" +
    formatApprovalField("Subject", state.subject.replace(/[\r\n]+/g, " "));
}

async function createDraftFromMessage(
    ctx: GmailContext, message: GmailOutboundMessage, source: GmailDraftSource,
    threadId?: string, sourceSnapshot?: GmailSourceAttachment,
    forwardInput?: {body?: string; options: GmailComposeOptions}): Promise<GmailDraft> {
  const logicalId = newGmailLogicalId("draft");
  let submitted = false;
  try {
    const now = Date.now();
    const attachments: GmailDraftAttachmentState[] = await Promise.all(
      message.attachments.map(async (attachment, index) => {
        const bytes = atob(attachment.data.replace(/\s/g, "")).length;
        return {
          key: String(index),
          info: {
            filename: attachment.filename || null,
            mimeType: attachment.contentType,
            size: bytes,
            disposition: attachment.disposition ?? null,
            ...(attachment.contentId ? {contentId: attachment.contentId} : {}),
            readable: bytes <= MAX_GMAIL_ATTACHMENT_BYTES,
          },
          contentDigest: await attachmentDigest(attachment),
        };
      }));
    const state: GmailDraftState = {
      logicalId,
      from: message.from,
      replyTo: message.replyTo,
      to: message.to,
      cc: message.cc,
      bcc: message.bcc,
      date: new Date(now).toUTCString(),
      subject: message.subject,
      text: source.format === "inline" ? forwardInput?.body ?? "" : message.body,
      ...(source.format === "inline"
        ? (forwardInput?.options.html !== undefined ? {html: forwardInput.options.html} : {})
        : (message.html !== undefined ? {html: message.html} : {})),
      rfcMessageId: message.messageId,
      ...(message.inReplyTo ? {inReplyTo: message.inReplyTo} : {}),
      ...(message.references ? {references: message.references} : {}),
      ...(threadId ? {threadId} : {}),
      timestamp: now,
      source,
      attachments,
      version: 0,
    };
    validateDraftState(state);
    const resource: GmailDraftResource = {
      logicalId, source, createdAt: now, status: "active", version: 0,
      ...(source.format === "inline" && sourceSnapshot ? {
        forwardSnapshot: sourceSnapshot,
        forwardBody: forwardInput?.body ?? "",
        ...(forwardInput?.options.html !== undefined
          ? {forwardHtml: forwardInput.options.html} : {}),
      } : {}),
    };
    ctx.store.putDraft(resource);
    await submitAction(ctx, {
      type: "draftCreate",
      draft: state,
      ...(sourceSnapshot ? {sourceAttachment: sourceSnapshot} : {}),
    }, {
      title: sanitizeApprovalTitle(`Create Gmail draft: ${state.subject || "(no subject)"}`),
      description: describeDraftAction(
        source.kind === "reply"
          ? "Create a threaded reply draft."
          : "Create an inline forward draft.",
        state, message),
    }, () => {
      ctx.store.deleteDraft(logicalId);
      ctx.store.deleteForwardSnapshot(sourceSnapshot);
    });
    submitted = true;
    return new GmailDraftStub(ctx, logicalId);
  } finally {
    if (!submitted) {
      ctx.store.deleteDraft(logicalId);
      ctx.store.deleteForwardSnapshot(sourceSnapshot);
    }
  }
}

type DraftCursorRef = {logicalId: string; providerId?: string};

function gmailDraftCursor(ctx: GmailContext): Cursor<GmailDraftEntry> {
  if (ctx.restricted) return restrictedDraftCursor(ctx);
  const emittedLogicalIds = new Set<string>();
  return new RpcCursor(new CursorPager<DraftCursorRef, OwnedGmailDraftEntry>({
    provider: "Gmail",
    async fetchPage(pageToken) {
      const page = await ctx.api.listDrafts(20, pageToken);
      const items: DraftCursorRef[] = [];
      for (const draft of page.drafts) {
        const resource = await ensureProviderDraft(ctx, draft);
        if (emittedLogicalIds.has(resource.logicalId) ||
            items.some(item => item.logicalId === resource.logicalId)) continue;
        items.push({logicalId: resource.logicalId, providerId: draft.id});
      }
      if (!pageToken) {
        for (const resource of ctx.store.listDrafts()) {
          if (!resource.providerId && resource.status === "active" &&
              !emittedLogicalIds.has(resource.logicalId) &&
              !items.some(item => item.logicalId === resource.logicalId)) {
            items.unshift({logicalId: resource.logicalId});
          }
        }
      }
      return {items, nextPageToken: page.nextPageToken};
    },
    async buildEntries(items) {
      const entries: OwnedGmailDraftEntry[] = [];
      try {
        for (const item of items) {
          try {
            const {state} = await loadSimulatedDraft(ctx, item.logicalId);
            entries.push({info: draftInfo(state), draft: new GmailDraftStub(ctx, item.logicalId)});
          } catch (error) {
            if (!(error instanceof Error) ||
                !/pending deletion|already been sent|has been deleted|was rejected|uncertain send outcome/
                  .test(error.message)) {
              throw error;
            }
          }
        }
        return entries;
      } catch (error) {
        disposeEntryTargets(entries, entry => entry.draft);
        throw error;
      }
    },
    authorize: async entries => {
      await ctx.approvalQueue.authorizeObservation({
        title: `Read ${entries.length} Gmail drafts`,
        description: "Fetch the next page with pending draft changes overlaid.",
      });
      for (const entry of entries) emittedLogicalIds.add(entry.info.id);
    },
    disposeEntries: entries =>
      disposeEntryTargets(entries, entry => entry.draft),
  }), ctx.approvalQueue);
}

function restrictedDraftCursor(ctx: GmailContext): Cursor<GmailDraftEntry> {
  const resources = ctx.store.listDrafts().filter(resource => resource.source &&
    resource.status === "active");
  return new RpcCursor(new CursorPager<GmailDraftResource, OwnedGmailDraftEntry>({
    provider: "Gmail",
    async fetchPage(pageToken) {
      const offset = pageToken ? Number(pageToken) : 0;
      const items = resources.slice(offset, offset + 20);
      const next = offset + items.length;
      return {items, ...(next < resources.length ? {nextPageToken: String(next)} : {})};
    },
    async buildEntries(items) {
      const entries: OwnedGmailDraftEntry[] = [];
      try {
        const sourceIds = new Set(items.flatMap(resource =>
          resource.source ? [resource.source.messageId] : []));
        const available = await messagesAvailableThroughRestriction(ctx, sourceIds);
        for (const resource of items) {
          if (!resource.source || !available.has(resource.source.messageId)) continue;
          try {
            const {state} = await loadSimulatedDraft(ctx, resource.logicalId);
            entries.push({
              info: draftInfo(state),
              draft: new GmailDraftStub(ctx, resource.logicalId),
            });
          } catch (error) {
            if (!(error instanceof Error) ||
                !/pending deletion|already been sent|has been deleted|was rejected|uncertain send outcome/
                  .test(error.message)) {
              throw error;
            }
          }
        }
        return entries;
      } catch (error) {
        disposeEntryTargets(entries, entry => entry.draft);
        throw error;
      }
    },
    authorize: entries => ctx.approvalQueue.authorizeObservation({
      title: `Read ${entries.length} restricted Gmail drafts`,
      description: "Read only same-binding drafts whose immutable source message remains admitted.",
    }),
    disposeEntries: entries =>
      disposeEntryTargets(entries, entry => entry.draft),
  }), ctx.approvalQueue);
}

@validateRpc()
class GmailDraftStub extends GmailRpcTarget implements GmailDraft {
  #ctx: GmailContext;
  #logicalId: string;

  constructor(ctx: GmailContext, logicalId: string) {
    super(ctx.approvalQueue);
    this.#ctx = ctx;
    this.#logicalId = logicalId;
  }

  async getMetadata(): Promise<GmailDraftInfo> {
    const {state} = await loadSimulatedDraft(this.#ctx, this.#logicalId);
    const info = draftInfo(state);
    await this.#ctx.approvalQueue.authorizeObservation({
      title: sanitizeApprovalTitle(`Read Gmail draft: ${state.subject || "(no subject)"}`),
      description: "Read the draft's simulated identifiers, recipients, subject, and timestamp.",
    });
    return info;
  }

  async getContent(): Promise<EmailContent> {
    const {state} = await loadSimulatedDraft(this.#ctx, this.#logicalId);
    const sourceSnapshot = state.source?.kind === "forward" && state.source.format === "inline"
      ? pendingForwardSnapshot(this.#ctx.store, state.logicalId)
      : undefined;
    const message = sourceSnapshot
      ? await inlineForwardMessage(this.#ctx.api, this.#ctx.store, state, sourceSnapshot)
      : undefined;
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "Read Gmail draft content",
      description: "Read the draft's simulated plain-text and HTML bodies.",
    });
    return {
      text: message?.body ?? state.text,
      ...((message?.html ?? state.html) !== undefined
        ? {html: message?.html ?? state.html} : {}),
    };
  }

  async attachments(): Promise<GmailAttachmentEntry[]> {
    const logicalId = this.#ctx.store.resolveDraftId(this.#logicalId);
    const resource = this.#ctx.store.getDraft(logicalId);
    if (!resource || resource.status !== "active") {
      throw new Error("This Gmail draft is no longer active.");
    }
    const decisions = this.#ctx.store.decisions();
    const relevant = draftPending(this.#ctx.store).filter(({action}) => {
      if ((action.dependsOn ?? []).some(id => decisions.get(id) === "rejected")) return false;
      return action.type === "draftCreate"
        ? action.draft.logicalId === logicalId
        : action.draftId === logicalId;
    });
    const terminal = relevant.findLast(({action}) =>
      action.type === "draftDelete" || action.type === "draftSend");
    if (terminal) throw new Error("This Gmail draft is pending deletion or send.");
    const capturedVersion = resource.version;
    const validateVersion = () => {
      const resolved = this.#ctx.store.resolveDraftId(logicalId);
      const current = this.#ctx.store.getDraft(resolved);
      if (resolved !== logicalId || !current || current.logicalId !== logicalId ||
          current.version !== capturedVersion || current.status !== "active") {
        throw new Error("This draft attachment capability became stale after the draft changed.");
      }
    };

    let entries: OwnedGmailAttachmentEntry[];
    if (resource.providerId) {
      const full = await this.#ctx.api.getDraftFull(resource.providerId);
      const snapshots = enumerateGmailAttachments(full.message.id, full.message.payload);
      entries = snapshots.map(snapshot => ({
        info: snapshot.info,
        attachment: new GmailAttachmentStub(
          this.#ctx, snapshot.info, () => this.#ctx.api.getAttachmentContent(snapshot), validateVersion),
      }));
    } else {
      const {state} = await loadSimulatedDraft(this.#ctx, logicalId);
      if (state.source?.kind !== "forward" || !state.attachments.length) {
        entries = [];
        await this.#ctx.approvalQueue.authorizeObservation({
          title: "List 0 Gmail draft attachments",
          description: "Read attachment metadata from this exact simulated draft revision.",
        });
        validateVersion();
        return entries;
      }
      const sourceSnapshot = pendingForwardSnapshot(this.#ctx.store, logicalId);
      if (!sourceSnapshot) {
        throw new Error(
          "This pending forward draft uses an obsolete source snapshot. Reject and resubmit it.");
      }
      entries = state.source.format === "inline"
        ? state.attachments.map((attachment, index) => ({
          info: attachment.info,
          attachment: new GmailAttachmentStub(this.#ctx, attachment.info, async () => {
            const message = await inlineForwardMessage(
              this.#ctx.api, this.#ctx.store, state, sourceSnapshot);
            const data = message.attachments[index]?.data;
            if (data === undefined) throw new Error("Forward attachment is no longer available.");
            const binary = atob(data.replace(/\s/g, ""));
            const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
            return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
          }, validateVersion),
        }))
        : [{
          info: state.attachments[0].info,
          attachment: new GmailAttachmentStub(this.#ctx, state.attachments[0].info, async () => {
            const bytes = await this.#ctx.store.readForwardSnapshot(sourceSnapshot);
            return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
          }, validateVersion),
        }];
    }
    try {
      await this.#ctx.approvalQueue.authorizeObservation({
        title: `List ${entries.length} Gmail draft attachments`,
        description: "Read attachment metadata from this exact simulated draft revision.",
      });
      validateVersion();
      return entries;
    } catch (error) {
      disposeEntryTargets(entries, entry => entry.attachment);
      throw error;
    }
  }

  async update(patch: GmailDraftPatch): Promise<void> {
    validateDraftPatch(patch);
    const loaded = await loadSimulatedDraft(this.#ctx, this.#logicalId, true);
    const {state, resource} = loaded;
    const logicalId = resource.logicalId;
    const recipientPatch = {
      ...(patch.to !== undefined ? {to: normalizeEmailRecipients(patch.to)} : {}),
      ...(patch.cc !== undefined ? {cc: normalizeEmailRecipients(patch.cc)} : {}),
      ...(patch.bcc !== undefined ? {bcc: normalizeEmailRecipients(patch.bcc)} : {}),
    };
    validateDraftRecipientPatch(state, recipientPatch);
    const patched = applyGmailDraftPatch(state, {...patch, ...recipientPatch});
    const revision = Math.max(patched.version, resource.version + 1);
    // Updating raw MIME necessarily writes Date and Message-ID headers. Persist them in the
    // approved state so retries and later dependent actions never generate different values.
    const after = {
      ...patched,
      date: patched.date ?? new Date().toUTCString(),
      version: revision,
      ...(!/^<[^<>\s@]+@[^<>\s@]+>$/.test(patched.rfcMessageId ?? "")
        ? {rfcMessageId: newGmailMessageId()} : {}),
    };
    validateDraftState(after);
    const sourceSnapshot = state.source?.kind === "forward" && state.source.format === "inline"
      ? pendingForwardSnapshot(this.#ctx.store, logicalId)
      : undefined;
    const expectedBefore = await draftOutputFingerprint(
      this.#ctx.api, this.#ctx.store, state, sourceSnapshot);
    const descriptionMessage = sourceSnapshot
      ? await inlineForwardMessage(this.#ctx.api, this.#ctx.store, after, sourceSnapshot)
      : undefined;
    const previousVersion = resource.version;
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "Read Gmail draft before update",
      description: "Read the exact simulated draft revision used as the update base.",
    });
    const resolved = this.#ctx.store.resolveDraftId(logicalId);
    const current = this.#ctx.store.getDraft(logicalId);
    if (resolved !== logicalId || !current || current.logicalId !== logicalId ||
        current.status !== "active" || current.version !== previousVersion) {
      throw new Error("The Gmail draft changed while this update was being prepared. Retry it.");
    }
    const dependencies = dependenciesFor(this.#ctx.store, logicalId, "draft");
    current.version = after.version;
    this.#ctx.store.putDraft(current);
    await submitAction(this.#ctx, {
      type: "draftUpdate",
      draftId: logicalId,
      after,
      expectedBefore,
      ...(dependencies.length === 0 && state.messageId
        ? {expectedProviderMessageId: state.messageId}
        : {}),
      ...(sourceSnapshot ? {sourceAttachment: sourceSnapshot} : {}),
      dependsOn: dependencies,
    }, {
      title: sanitizeApprovalTitle(`Update Gmail draft: ${after.subject || "(no subject)"}`),
      description: describeDraftAction(
        "Replace the selected draft fields.", after, descriptionMessage),
    }, () => this.#ctx.store.restoreDraftVersion(
      logicalId, after.version, previousVersion, dependencies));
  }

  async delete(): Promise<void> {
    const {state, resource} = await loadSimulatedDraft(this.#ctx, this.#logicalId, true);
    const logicalId = resource.logicalId;
    const version = resource.version;
    const sourceSnapshot = state.source?.kind === "forward" && state.source.format === "inline"
      ? pendingForwardSnapshot(this.#ctx.store, logicalId)
      : undefined;
    const expectedSnapshot = await draftOutputFingerprint(
      this.#ctx.api, this.#ctx.store, state, sourceSnapshot);
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "Read Gmail draft before deletion",
      description: "Read the exact simulated draft revision being deleted.",
    });
    const resolved = this.#ctx.store.resolveDraftId(logicalId);
    const current = this.#ctx.store.getDraft(logicalId);
    if (resolved !== logicalId || !current || current.logicalId !== logicalId ||
        current.status !== "active" || current.version !== version) {
      throw new Error("The Gmail draft changed while deletion was being prepared. Retry it.");
    }
    const dependencies = dependenciesFor(this.#ctx.store, logicalId, "draft");
    current.version++;
    const submittedVersion = current.version;
    this.#ctx.store.putDraft(current);
    await submitAction(this.#ctx, {
      type: "draftDelete",
      draftId: logicalId,
      expectedSnapshot,
      ...(dependencies.length === 0 && state.messageId
        ? {expectedProviderMessageId: state.messageId}
        : {}),
      ...(sourceSnapshot ? {sourceAttachment: sourceSnapshot} : {}),
      dependsOn: dependencies,
    }, {
      title: sanitizeApprovalTitle(`Delete Gmail draft: ${state.subject || "(no subject)"}`),
      description: describeDraftDeletion(state),
    }, () => this.#ctx.store.restoreDraftVersion(
      logicalId, submittedVersion, version, dependencies));
  }

  async send(): Promise<string> {
    const {state, resource} = await loadSimulatedDraft(this.#ctx, this.#logicalId, true);
    const logicalId = resource.logicalId;
    const version = resource.version;
    const recipients = [...state.to, ...state.cc, ...state.bcc];
    validateGmailRecipientCount(recipients);
    const importedWithNonTextContent = resource.providerId === resource.logicalId &&
      (state.html !== undefined || state.attachments.length > 0);
    if (state.text.length === 0 && !importedWithNonTextContent && state.source?.kind !== "reply" &&
        !(state.source?.kind === "forward" && state.source.format === "inline")) {
      throw new Error("A Gmail draft must contain a plain-text body before it can be sent.");
    }
    validateDraftState(state);
    const sourceSnapshot = state.source?.kind === "forward" && state.source.format === "inline"
      ? pendingForwardSnapshot(this.#ctx.store, logicalId)
      : undefined;
    const expectedSnapshot = await draftOutputFingerprint(
      this.#ctx.api, this.#ctx.store, state, sourceSnapshot);
    // A send action always owns a fresh identity. Imported drafts can reuse a Message-ID from an
    // already-delivered message, which would make ambiguous-send reconciliation unsafe.
    const messageId = newGmailMessageId();
    const approved = {...state, rfcMessageId: messageId};
    const approvedMessage = sourceSnapshot
      ? await inlineForwardMessage(this.#ctx.api, this.#ctx.store, approved, sourceSnapshot)
      : undefined;
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "Read Gmail draft before send",
      description: "Read the exact simulated draft snapshot that will be sent.",
    });
    const resolved = this.#ctx.store.resolveDraftId(logicalId);
    const current = this.#ctx.store.getDraft(logicalId);
    if (resolved !== logicalId || !current || current.logicalId !== logicalId ||
        current.status !== "active" || current.version !== version) {
      throw new Error("The Gmail draft changed while send was being prepared. Retry it.");
    }
    const dependencies = dependenciesFor(this.#ctx.store, logicalId, "draft");
    current.version++;
    const submittedVersion = current.version;
    this.#ctx.store.putDraft(current);
    await submitAction(this.#ctx, {
      type: "draftSend",
      draftId: logicalId,
      approved,
      expectedSnapshot,
      ...(dependencies.length === 0 && state.messageId
        ? {expectedProviderMessageId: state.messageId}
        : {}),
      messageId,
      ...(sourceSnapshot ? {sourceAttachment: sourceSnapshot} : {}),
      dependsOn: dependencies,
    }, {
      title: sanitizeApprovalTitle(`Send Gmail draft: ${state.subject || "(no subject)"}`),
      description: describeDraftAction(
        "Send this exact draft snapshot.", approved, approvedMessage),
      awaitDecision: true,
    }, () => this.#ctx.store.restoreDraftVersion(
      logicalId, submittedVersion, version, dependencies));
    return messageId;
  }
}

function assertDependencies(store: GmailStore, action: {dependsOn?: number[]}): void {
  const pendingIds = new Set(store.listActions().map(item => item.id));
  const error = gmailDependencyError(action, pendingIds, store.decisions());
  if (error) throw new Error(error);
}

function providerDraftId(store: GmailStore, logicalId: string): string {
  const resource = store.getDraft(logicalId);
  if (!resource) throw new Error("Unknown Gmail draft resource.");
  if (resource.status === "rejected") throw new Error("The draft creation prerequisite was rejected.");
  if (resource.status === "deleted") throw new Error("This Gmail draft has been deleted.");
  if (resource.status === "sent") throw new Error("This Gmail draft has already been sent.");
  if (!resource.providerId) {
    throw new Error("The draft does not exist in Gmail yet. Approve its create action first.");
  }
  return resource.providerId;
}

async function reconcileDraftActionAlias(
    api: GmailApi, store: GmailStore, action: StoredGmailAction): Promise<void> {
  if (action.type !== "draftUpdate" && action.type !== "draftDelete" &&
      action.type !== "draftSend") return;
  if (applyingDraftCreates(store).length === 0) return;
  const resource = store.getDraft(action.draftId);
  if (!resource?.providerId) return;
  const provider = await api.getDraft(resource.providerId);
  const parsed = await parseSafeGmailDraft(provider.message);
  await mapMatchingApplyingDraftCreate(api, store, provider, parsed);
}

function providerLabelId(store: GmailStore, logicalId: string): string {
  const resource = store.getLabel(logicalId);
  if (!resource) return logicalId;
  if (resource.status === "rejected") throw new Error("The label creation prerequisite was rejected.");
  if (!resource.providerId) {
    throw new Error("The label does not exist in Gmail yet. Approve its create action first.");
  }
  return resource.providerId;
}

function isDefinitiveWriteRejection(error: unknown): boolean {
  return error instanceof GmailApiError && error.status >= 400 && error.status < 500 &&
    error.status !== 408 && error.status !== 429;
}

async function applyUncertainWrite<T>(
    store: GmailStore, actionId: number, write: () => Promise<T>): Promise<T> {
  store.markApplying(actionId);
  try {
    return await write();
  } catch (error) {
    // A definitive rejection proves this invocation did not mutate Gmail. Read/reconciliation
    // failures must never reach this path or erase an earlier invocation's uncertain outcome.
    if (isDefinitiveWriteRejection(error)) store.clearApplying(actionId);
    throw error;
  }
}

async function exactSpecWithSource(
    api: GmailApi, store: GmailStore, spec: GmailOutboundSpec,
    snapshot: GmailSourceAttachment | undefined, inline = false): Promise<GmailOutboundSpec> {
  if (!snapshot) return spec;
  const bytes = await store.readForwardSnapshot(snapshot);
  if (inline) {
    if (spec.attachments.length > 0) {
      throw new Error("This inline forward has inconsistent attachment metadata.");
    }
    const message = await api.buildForwardFromBytes(bytes, spec.to, spec.text, {
      cc: spec.cc,
      bcc: spec.bcc,
      ...(spec.html !== undefined ? {html: spec.html} : {}),
    }, spec.messageId, spec.subject, spec.date);
    if (message.from !== spec.from || message.subject !== spec.subject ||
        message.to.join("\n") !== spec.to.join("\n") ||
        message.cc.join("\n") !== spec.cc.join("\n") ||
        message.bcc.join("\n") !== spec.bcc.join("\n")) {
      throw new Error("The stored forward source no longer matches its approved message.");
    }
    return {
      ...outboundSpec(message),
      ...(spec.date !== undefined ? {date: spec.date} : {}),
    };
  }
  return {...spec, attachments: [materializeSourceAttachment(bytes, snapshot)]};
}

async function verifyReconciledSend(
    api: GmailApi, action: GmailSendAction, sent: {id: string; threadId: string},
    approvedFingerprint: string): Promise<void> {
  const provider = await api.getMessage(sent.id);
  if (provider.id !== sent.id || provider.threadId !== sent.threadId ||
      (action.threadId !== undefined && provider.threadId !== action.threadId)) {
    throw new Error(
      "A delivered Gmail message matched the approved Message-ID but not the approved thread.");
  }
  const deliveredParsed = await parseSafeGmailDraft(provider);
  if (await gmailDraftFingerprint(deliveredParsed, provider.threadId) !==
      approvedFingerprint) {
    throw new Error(
      "A delivered Gmail message matched the approved Message-ID but had different content.");
  }
}

async function sentMessageFingerprint(
    raw: string, threadId: string | undefined): Promise<string> {
  const parsed = await parseSafeGmailDraft({
    id: "approved-send",
    threadId: threadId ?? "approved-send",
    internalDate: "0",
    raw,
  });
  return gmailDraftFingerprint(parsed, threadId);
}

async function applyMessageMutation(
    api: GmailApi, store: GmailStore, actionId: number,
    action: GmailMessageMutationAction): Promise<void> {
  const labelId = action.labelId ? providerLabelId(store, action.labelId) : undefined;
  const trashLabelOperation = labelId === "TRASH" &&
    (action.operation === "applyLabel" || action.operation === "removeLabel");
  const labels = (() => {
    switch (action.operation) {
      case "archive": return {add: [] as string[], remove: ["INBOX"]};
      case "markRead": return {add: [] as string[], remove: ["UNREAD"]};
      case "markUnread": return {add: ["UNREAD"], remove: [] as string[]};
      case "star": return {add: ["STARRED"], remove: [] as string[]};
      case "unstar": return {add: [] as string[], remove: ["STARRED"]};
      case "applyLabel": return {add: [labelId!], remove: [] as string[]};
      case "removeLabel": return {add: [] as string[], remove: [labelId!]};
      case "trash": return undefined;
    }
  })();
  const applyTarget = async (target: {messageId?: string; threadId?: string}) => {
    const targetId = target.messageId ?? target.threadId!;
    if (action.operation === "trash" || (trashLabelOperation && action.operation === "applyLabel")) {
      if (target.messageId) await api.trashMessage(targetId);
      else await api.trashThread(targetId);
    } else if (trashLabelOperation) {
      if (target.messageId) await api.untrashMessage(targetId);
      else await api.untrashThread(targetId);
    } else if (target.messageId) {
      await api.modifyMessage(targetId, labels!.add, labels!.remove);
    } else {
      await api.modifyThread(targetId, labels!.add, labels!.remove);
    }
  };
  const targets = action.target.kind === "thread"
    ? [{threadId: action.target.threadId}]
    : action.target.messageIds.map(messageId => ({messageId}));
  const reconciling = store.isApplying(actionId);
  let mayHaveWritten = reconciling;
  store.markApplying(actionId);
  try {
    for (const target of targets) {
      try {
        await applyTarget(target);
      } catch (error) {
        if (!(reconciling && action.target.kind === "messages" &&
            error instanceof GmailApiError && error.status === 404)) {
          throw error;
        }
      }
      mayHaveWritten = true;
    }
  } catch (error) {
    if (!mayHaveWritten && isDefinitiveWriteRejection(error)) store.clearApplying(actionId);
    throw error;
  }
}

@validateRpc()
export class GmailGatekeeperImpl extends DurableObject<Env, GmailGatekeeperImplProps>
    implements Gatekeeper<GmailScopedSession | GmailSession> {
  #applying = new Set<number>();
  #verifiedToken?: string;
  #subjectToken?: string;
  #tokenSubject?: string;
  #tokens = new AccessTokenCache(opts => {
    const account = this.ctx.exports.UserAccount.get(
      this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
    return account.getAccessToken(opts);
  });

  async #getTokenSubject(token: string): Promise<string> {
    if (token !== this.#subjectToken) {
      this.#tokenSubject = await getGoogleAccountSubject(token);
      this.#subjectToken = token;
    }
    return this.#tokenSubject!;
  }

  async #getAccessToken(opts?: AccessTokenRequest): Promise<string> {
    const token = await this.#tokens.get(opts);
    if (token !== this.#verifiedToken) {
      const pinned = this.ctx.storage.kv.get<string>("gmail:accountSubject");
      if (pinned && pinned !== await this.#getTokenSubject(token)) {
        throw new Error(
          "This Gmail binding belongs to a different Google account. Reconnect the original account.");
      }
      this.#verifiedToken = token;
    }
    return token;
  }

  async #getSelfEmail(): Promise<string> {
    const cached = this.ctx.storage.kv.get<string>("selfEmail");
    const token = await this.#getAccessToken();
    const [subject, description] = await Promise.all([
      this.#getTokenSubject(token), getGoogleAccountDescription(token),
    ]);
    if (!description.uniqueName) throw new Error("Google account has no email address.");
    const pinned = this.ctx.storage.kv.get<string>("gmail:accountSubject");
    if (pinned && pinned !== subject) {
      throw new Error(
        "This Gmail binding belongs to a different Google account. Reconnect the original account.");
    }
    // Legacy bindings predate subject pinning. Verify their last known email once before adopting
    // a stable subject; after that, Workspace primary-email renames are safe to accept.
    if (!pinned && cached && cached.toLowerCase() !== description.uniqueName.toLowerCase()) {
      throw new Error(
        "This Gmail binding belongs to a different Google account. Reconnect the original account.");
    }
    if (!pinned) this.ctx.storage.kv.put("gmail:accountSubject", subject);
    this.ctx.storage.kv.put("selfEmail", description.uniqueName);
    return description.uniqueName;
  }

  async #resolveBindingLabel(
      api: GmailApi, approvalQueue: RpcStub<ApprovalQueue>): Promise<{
        id?: string;
        name?: string;
      }> {
    if (this.ctx.props.labelName === undefined) return {};
    validateGmailLabelName(this.ctx.props.labelName);
    const labels = await api.listLabelRecords();
    const storedId = this.ctx.storage.kv.get<string>("gmail:bindingLabelId");
    if (storedId) {
      const label = labels.find(item => item.id === storedId);
      if (!label) {
        throw new Error(
          "The Gmail label bound to this connection no longer exists. Reconnect a label explicitly.");
      }
      await approvalQueue.authorizeObservation({
        title: "Resolve bound Gmail label",
        description: "Verify the binding's persisted stable Gmail label ID still exists.",
      });
      return {id: storedId, name: label.name};
    }
    const label = labels.find(item => item.name === this.ctx.props.labelName);
    if (!label) throw new Error(`Gmail label not found: ${this.ctx.props.labelName}`);
    // Once recorded, a rename/delete/recreate by name can never retarget this binding.
    this.ctx.storage.kv.put("gmail:bindingLabelId", label.id);
    await approvalQueue.authorizeObservation({
      title: "Resolve bound Gmail label",
      description: "Resolve the legacy name-only binding once and persist Gmail's stable label ID.",
    });
    return {id: label.id, name: label.name};
  }

  async describe(): Promise<ResourceDescription> {
    if (this.ctx.props.labelName !== undefined) {
      validateGmailLabelName(this.ctx.props.labelName);
      return {
        url: `https://mail.google.com/mail/#label/${encodeURIComponent(this.ctx.props.labelName)}`,
        title: `Gmail label: ${this.ctx.props.labelName}`,
        snippet: `Gmail messages with label: ${this.ctx.props.labelName}`,
        suggestedBindingName: "GMAIL_LABEL",
        tsType: "GmailScopedSession",
      };
    }
    if (this.ctx.props.searchQuery !== undefined) {
      validateGmailQueryForGrouping(this.ctx.props.searchQuery);
      return {
        url: `https://mail.google.com/mail/#search/${encodeURIComponent(this.ctx.props.searchQuery)}`,
        title: `Gmail: ${this.ctx.props.searchQuery}`,
        snippet: "Gmail messages matching the connected search",
        suggestedBindingName: "GMAIL_SEARCH",
        tsType: "GmailScopedSession",
      };
    }
    return {
      url: "https://mail.google.com/mail/",
      title: "Gmail Inbox",
      snippet: "Your personal Gmail inbox",
      suggestedBindingName: "GMAIL_INBOX",
      tsType: "GmailSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> { return TYPES_CODE; }
  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [...actionKinds(MESSAGE_MUTATION_LABELS), ...actionKinds(RESOURCE_ACTION_LABELS)];
  }

  async startSession(
      approvalQueue: RpcStub<ApprovalQueue>,
  ): Promise<GmailScopedSession | GmailSession> {
    if (this.ctx.props.searchQuery !== undefined) {
      validateGmailQueryForGrouping(this.ctx.props.searchQuery);
    }
    const selfEmail = await this.#getSelfEmail();
    const api = new GmailApi(selfEmail, opts => this.#getAccessToken(opts));
    await approvalQueue.authorizeObservation({
      title: "Open Gmail session",
      description: "Resolve the connected Google account used by this private Gmail binding.",
    });
    const bindingLabel = await this.#resolveBindingLabel(api, approvalQueue);
    const store = new GmailStore(this.ctx.storage);
    const ctx: GmailContext = {
      api,
      approvalQueue: new SharedApprovalQueue(approvalQueue.dup()),
      store,
      selfEmail,
      searchQuery: this.ctx.props.searchQuery,
      labelId: bindingLabel.id,
      labelName: bindingLabel.name,
      restricted: this.ctx.props.searchQuery !== undefined || bindingLabel.id !== undefined,
      providerLabels: () => api.listLabelRecords(),
    };
    return ctx.restricted ? new GmailScopedSessionImpl(ctx) : new GmailSessionImpl(ctx);
  }

  async applyAction(actionId: number): Promise<void> {
    const store = new GmailStore(this.ctx.storage);
    const initialAction = store.getAction(actionId);
    if (!initialAction) throw new Error(`Unknown pending Gmail action: ${actionId}`);
    if (this.#applying.has(actionId)) throw new Error(`Gmail action ${actionId} is already applying.`);
    this.#applying.add(actionId);
    try {
      const selfEmail = await this.#getSelfEmail();
      const api = new GmailApi(selfEmail, opts => this.#getAccessToken(opts));

      await reconcileDraftActionAlias(api, store, initialAction);
      const action = store.getAction(actionId);
      if (!action) throw new Error(`Unknown pending Gmail action: ${actionId}`);
      if ("dependsOn" in action) assertDependencies(store, action);
      if (isLegacyGmailAction(action) &&
          (action.type === "send" || action.type === "reply" || action.type === "forward")) {
        throw new Error(
          "This legacy outbound Gmail action cannot be retried safely. Inspect Sent mail to " +
          "determine whether it was delivered before rejecting or resubmitting it.");
      }
      if ((this.ctx.props.searchQuery !== undefined || this.ctx.props.labelName !== undefined) &&
          isLegacyGmailAction(action)) {
        throw new Error(
          "This legacy Gmail action cannot be applied through a restricted binding safely.");
      }

      switch (action.type) {
      case "messageMutation":
        await applyMessageMutation(api, store, actionId, action);
        break;
      case "send": {
        const sourceSnapshot = sendSourceSnapshot(action);
        const receipt = store.sentMessageByRfcMessageId(action.spec.messageId);
        if (receipt) {
          const completed = store.completeSentAction(actionId, action.spec.messageId, {
            id: receipt.providerId,
            threadId: receipt.threadId,
          });
          store.deleteForwardSnapshot(actionSourceAttachment(completed));
          return;
        }
        if (store.isApplying(actionId)) {
          const existing = await api.findMessageByRfcMessageId(action.spec.messageId, "delivered");
          if (!existing) {
            throw new Error(
              "The previous Gmail send outcome is still unknown; refusing to risk duplicate delivery.");
          }
          let approvedFingerprint = store.getSendFingerprint(actionId, action.spec.messageId);
          if (!approvedFingerprint) {
            const spec = await exactSpecWithSource(
              api, store, action.spec, sourceSnapshot, action.forwardFormat === "inline");
            approvedFingerprint = await sentMessageFingerprint(
              api.buildOutbound(spec).raw, action.threadId);
            store.setSendFingerprint(actionId, action.spec.messageId, approvedFingerprint);
          }
          await verifyReconciledSend(api, action, existing, approvedFingerprint);
          const completed = store.completeSentAction(actionId, action.spec.messageId, existing);
          store.deleteForwardSnapshot(actionSourceAttachment(completed));
          return;
        }
        const spec = await exactSpecWithSource(
          api, store, action.spec, sourceSnapshot, action.forwardFormat === "inline");
        const message = api.buildOutbound(spec);
        store.setSendFingerprint(
          actionId, action.spec.messageId,
          await sentMessageFingerprint(message.raw, action.threadId));
        const sent = await applyUncertainWrite(
          store, actionId, () => api.sendRawMessage(message.raw, action.threadId));
        const completed = store.completeSentAction(actionId, action.spec.messageId, sent);
        store.deleteForwardSnapshot(actionSourceAttachment(completed));
        return;
      }
      case "draftCreate": {
        const resource = store.getDraft(action.draft.logicalId);
        if (!resource || resource.status !== "active") {
          throw new Error("The provisional Gmail draft is no longer active.");
        }
        const sourceSnapshot = draftSourceSnapshot(action);
        const approvedOutputFingerprint = await draftOutputFingerprint(
          api, store, action.draft, sourceSnapshot);
        const storedReceipt = store.getDraftWriteReceipt(actionId);
        if (storedReceipt) {
          const baseline = await readDraftProviderBaseline(
            api, store, actionId, storedReceipt, approvedOutputFingerprint, action.draft.threadId);
          const completed = store.completeDraftWrite(
            actionId, baseline, approvedOutputFingerprint, storedReceipt);
          store.deleteForwardSnapshot(actionSourceAttachment(completed));
          return;
        }
        if (resource.providerId) {
          const current = await api.getDraft(resource.providerId);
          const parsed = await parseSafeGmailDraft(current.message);
          if (await gmailDraftFingerprint(parsed, current.message.threadId) !==
              approvedOutputFingerprint) {
            throw new Error(
              "The mapped Gmail draft no longer matches the approved create action.");
          }
          const receipt = {
            draftId: resource.providerId,
            messageId: current.message.id,
            threadId: current.message.threadId,
          };
          store.setDraftWriteReceipt(actionId, receipt);
          const completed = store.completeDraftWrite(actionId, {
            ...receipt,
            fingerprint: approvedOutputFingerprint,
          }, approvedOutputFingerprint);
          store.deleteForwardSnapshot(actionSourceAttachment(completed));
          return;
        }
        if (store.isApplying(actionId)) {
          if (!action.draft.rfcMessageId) {
            throw new Error("The staged Gmail draft has no stable Message-ID for reconciliation.");
          }
          const existing = await api.findDraftByRfcMessageId(action.draft.rfcMessageId);
          if (!existing) {
            draftSourceSnapshot(action);
            throw new Error(
              "The previous Gmail draft creation outcome is still unknown; refusing to create a duplicate.");
          }
          const current = await api.getDraft(existing.id);
          const receipt = {
            draftId: existing.id,
            messageId: current.message.id,
            threadId: current.message.threadId,
            unverified: true as const,
          };
          store.setDraftWriteReceipt(actionId, receipt);
          const parsed = await parseSafeGmailDraft(current.message);
          if (await gmailDraftFingerprint(parsed, current.message.threadId) !==
              approvedOutputFingerprint) {
            throw new Error(
              "The reconciled Gmail draft no longer matches the approved create action.");
          }
          const completed = store.completeDraftWrite(actionId, {
            ...receipt,
            fingerprint: approvedOutputFingerprint,
          }, approvedOutputFingerprint);
          store.deleteForwardSnapshot(actionSourceAttachment(completed));
          return;
        }
        const spec = await exactSpecWithSource(
          api, store, draftSpec(action.draft), sourceSnapshot,
          action.draft.source?.format === "inline");
        const message = api.buildOutbound(spec);
        const created = await applyUncertainWrite(
          store, actionId, () => api.createDraft(message.raw, action.draft.threadId));
        const receipt = {
          draftId: created.id,
          messageId: created.message.id,
          ...(created.message.threadId ? {threadId: created.message.threadId} : {}),
        };
        store.setDraftWriteReceipt(actionId, receipt);
        const baseline = await readDraftProviderBaseline(
          api, store, actionId, receipt, approvedOutputFingerprint, action.draft.threadId);
        const completed = store.completeDraftWrite(
          actionId, baseline, approvedOutputFingerprint, receipt);
        store.deleteForwardSnapshot(actionSourceAttachment(completed));
        return;
      }
      case "draftUpdate": {
        const storedReceipt = store.getDraftWriteReceipt(actionId);
        if (storedReceipt?.missing) {
          const completed = store.completeMissingDraftUpdate(actionId);
          store.deleteForwardSnapshot(actionSourceAttachment(completed));
          return;
        }
        const id = providerDraftId(store, action.draftId);
        const approvedOutputFingerprint = await draftOutputFingerprint(
          api, store, action.after, action.sourceAttachment);
        if (storedReceipt) {
          const baseline = await readDraftProviderBaseline(
            api, store, actionId, storedReceipt, approvedOutputFingerprint, action.after.threadId);
          const completed = store.completeDraftWrite(
            actionId, baseline, approvedOutputFingerprint, storedReceipt);
          store.updateDraftForwardContent(action.draftId, action.after);
          store.deleteForwardSnapshot(actionSourceAttachment(completed));
          return;
        }
        const current = await api.getDraft(id);
        const reconciling = store.isApplying(actionId);
        if (!reconciling && action.expectedProviderMessageId &&
            current.message.id !== action.expectedProviderMessageId) {
          throw new Error(
            "The Gmail draft revision changed outside this approval sequence; refusing to update it.");
        }
        const parsed = await parseSafeGmailDraft(current.message);
        const currentFingerprint = await gmailDraftFingerprint(parsed, current.message.threadId);
        if (currentFingerprint === approvedOutputFingerprint) {
          const completed = store.completeMatchingDraftUpdate(actionId, {
            draftId: id,
            messageId: current.message.id,
            fingerprint: currentFingerprint,
          }, approvedOutputFingerprint);
          store.updateDraftForwardContent(action.draftId, action.after);
          store.deleteForwardSnapshot(actionSourceAttachment(completed));
          return;
        }
        // Gmail replaces a draft's message ID on every edit but offers no conditional write.
        // Checking both identity and content catches every stale revision visible to this preflight.
        if (action.expectedProviderMessageId &&
            current.message.id !== action.expectedProviderMessageId) {
          throw new Error(
            "The Gmail draft revision changed outside this approval sequence; refusing to update it.");
        }
        if (currentFingerprint !== action.expectedBefore) {
          throw new Error(
            "The Gmail draft changed outside this approval sequence; refusing to apply a different update.");
        }
        const sourceSnapshot = action.sourceAttachment;
        const spec = sourceSnapshot
          ? await exactSpecWithSource(
            api, store, draftSpec(action.after), sourceSnapshot,
            action.after.source?.format === "inline")
          : draftSpec(action.after, parsed.attachments);
        const message = api.buildOutbound(spec);
        const updated = await applyUncertainWrite(
          store, actionId, () => api.updateDraft(id, message.raw, action.after.threadId));
        if (updated.id !== id) {
          throw new Error("Gmail returned a different draft after updating it.");
        }
        const receipt = {
          draftId: updated.id,
          messageId: updated.message.id,
          threadId: updated.message.threadId ?? current.message.threadId,
        };
        store.setDraftWriteReceipt(actionId, receipt);
        const baseline = await readDraftProviderBaseline(
          api, store, actionId, receipt, approvedOutputFingerprint, action.after.threadId);
        const completed = store.completeDraftWrite(
          actionId, baseline, approvedOutputFingerprint, receipt);
        store.updateDraftForwardContent(action.draftId, action.after);
        store.deleteForwardSnapshot(actionSourceAttachment(completed));
        return;
      }
      case "draftDelete": {
        const existing = store.getDraft(action.draftId);
        if (store.isApplying(actionId) && existing?.status === "deleted") break;
        const reconciling = store.isApplying(actionId);
        const id = providerDraftId(store, action.draftId);
        let current: GmailDraftRaw;
        try {
          current = await api.getDraft(id);
        } catch (error) {
          if (!(error instanceof GmailApiError && error.status === 404)) {
            throw error;
          }
          const resource = store.getDraft(action.draftId);
          if (!resource) {
            throw new Error(
              "The Gmail draft resource disappeared while being deleted.", {cause: error});
          }
          resource.status = "deleted";
          resource.version++;
          store.putDraft(resource);
          store.clearDraftForwardSnapshot(action.draftId);
          store.clearApplying(actionId);
          break;
        }
        if (current.id !== id) throw new Error("Gmail returned a different draft during deletion.");
        // A successful GET of this exact draft proves the earlier DELETE did not complete.
        if (reconciling) store.clearApplying(actionId);
        if (action.expectedProviderMessageId &&
            current.message.id !== action.expectedProviderMessageId) {
          throw new Error(
            "The Gmail draft revision changed outside this approval sequence; refusing to delete it.");
        }
        const parsed = await parseSafeGmailDraft(current.message);
        if (await gmailDraftFingerprint(parsed, current.message.threadId) !== action.expectedSnapshot) {
          throw new Error(
            "The Gmail draft changed outside this approval sequence; refusing to delete a different revision.");
        }
        try {
          await applyUncertainWrite(store, actionId, () => api.deleteDraft(id));
        } catch (error) {
          if (!(error instanceof GmailApiError && error.status === 404)) throw error;
        }
        const resource = store.getDraft(action.draftId)!;
        resource.status = "deleted";
        resource.version++;
        store.putDraft(resource);
        store.clearDraftForwardSnapshot(action.draftId);
        break;
      }
      case "draftSend": {
        const resource = store.getDraft(action.draftId)!;
        const resourceSnapshot = resource.forwardSnapshot;
        const receipt = action.messageId
          ? store.sentMessageByRfcMessageId(action.messageId)
          : undefined;
        if (receipt) {
          const completed = store.completeSentAction(actionId, action.messageId!, {
            id: receipt.providerId,
            threadId: receipt.threadId,
          });
          store.deleteForwardSnapshot(actionSourceAttachment(completed));
          store.deleteForwardSnapshot(resourceSnapshot);
          return;
        }
        if (store.isApplying(actionId)) {
          const sent = action.messageId
            ? await api.findMessageByRfcMessageId(action.messageId, "delivered")
            : undefined;
          if (!sent) {
            throw new Error(
              "The previous Gmail draft send outcome is still unknown; refusing to risk duplicate delivery.");
          }
          const sentMessage = await api.getMessage(sent.id);
          if (sentMessage.id !== sent.id ||
              (action.approved.threadId !== undefined &&
               sentMessage.threadId !== action.approved.threadId)) {
            throw new Error(
              "A delivered Gmail message matched the approved Message-ID but not the approved draft.");
          }
          const sentParsed = await parseSafeGmailDraft(sentMessage);
          let approvedOutputFingerprint = store.getSendFingerprint(actionId, action.messageId!);
          if (!approvedOutputFingerprint) {
            approvedOutputFingerprint = await draftOutputFingerprint(
              api, store, action.approved, action.sourceAttachment);
            store.setSendFingerprint(actionId, action.messageId!, approvedOutputFingerprint);
          }
          if (await gmailDraftFingerprint(sentParsed, sentMessage.threadId) !==
              approvedOutputFingerprint) {
            throw new Error(
              "A delivered Gmail message matched the approved Message-ID but had different content.");
          }
          const completed = store.completeSentAction(actionId, action.messageId!, sent);
          store.deleteForwardSnapshot(actionSourceAttachment(completed));
          store.deleteForwardSnapshot(resourceSnapshot);
          return;
        }
        const id = providerDraftId(store, action.draftId);
        const current = await api.getDraft(id);
        if (action.expectedProviderMessageId &&
            current.message.id !== action.expectedProviderMessageId) {
          throw new Error(
            "The Gmail draft revision changed outside this approval sequence; refusing to send it.");
        }
        const parsed = await parseSafeGmailDraft(current.message);
        if (await gmailDraftFingerprint(parsed, current.message.threadId) !== action.expectedSnapshot) {
          throw new Error(
            "The Gmail draft changed outside this approval sequence; refusing to send different content.");
        }
        const approvedSource = action.sourceAttachment;
        const approvedSpec = approvedSource
          ? await exactSpecWithSource(
            api, store, draftSpec(action.approved), approvedSource,
            action.approved.source?.format === "inline")
          : draftSpec(action.approved, parsed.attachments);
        const approved = api.buildOutbound(approvedSpec);
        if (action.messageId) {
          store.setSendFingerprint(
            actionId, action.messageId,
            await sentMessageFingerprint(approved.raw, action.approved.threadId));
        }
        const sent = await applyUncertainWrite(
          store, actionId, () => api.sendDraft(id, approved.raw, action.approved.threadId));
        if (action.messageId) {
          const completed = store.completeSentAction(actionId, action.messageId, sent);
          store.deleteForwardSnapshot(actionSourceAttachment(completed));
          store.deleteForwardSnapshot(resourceSnapshot);
          return;
        }
        resource.status = "sent";
        resource.version++;
        store.putDraft(resource);
        store.clearDraftForwardSnapshot(action.draftId);
        break;
      }
      case "labelCreate": {
        const resource = store.getLabel(action.label.logicalId);
        if (!resource || resource.status !== "active") {
          throw new Error("The provisional Gmail label is no longer active.");
        }
        if (resource.providerId) {
          const existing = (await api.listLabelRecords()).find(
            label => label.id === resource.providerId && label.type === "user");
          if (!existing || existing.name !== resource.name) {
            throw new Error("The mapped Gmail label no longer matches its approved creation.");
          }
          break;
        }
        if (store.isApplying(actionId)) {
          const matches = (await api.listLabelRecords()).filter(
            label => label.type === "user" && label.name === action.label.name);
          if (matches.length !== 1) {
            throw new Error(
              "The previous Gmail label creation outcome is unknown; refusing to map or create a label.");
          }
          store.mapLabelToProvider(actionId, matches[0]);
          break;
        }
        const created = await applyUncertainWrite(
          store, actionId, () => api.createLabel(action.label.name));
        store.mapLabelToProvider(actionId, created);
        break;
      }
      case "labelRename": {
        const id = providerLabelId(store, action.labelId);
        const current = await api.getLabel(id);
        if (current.type !== "user") throw new Error("Only custom Gmail labels can be renamed.");
        if (current.name !== action.name) {
          if (current.name !== action.expectedName) {
            throw new Error(
              "The Gmail label changed outside this approval sequence; refusing to rename it.");
          }
          const renamed = await applyUncertainWrite(
            store, actionId, () => api.renameLabel(id, action.name));
          if (renamed.name !== action.name) {
            throw new Error("Gmail returned a different label name after renaming it.");
          }
        }
        const resource = store.getLabel(action.labelId);
        if (resource) {
          resource.name = action.name;
          store.putLabel(resource);
        }
        break;
      }
      case "labelDelete": {
        const id = providerLabelId(store, action.labelId);
        try {
          await applyUncertainWrite(store, actionId, () => api.deleteLabel(id));
        } catch (error) {
          if (!(error instanceof GmailApiError && error.status === 404)) throw error;
        }
        const resource = store.getLabel(action.labelId);
        if (resource) {
          resource.status = "deleted";
          store.putLabel(resource);
        }
        break;
      }
      case "archive": await api.modifyThread(action.threadId, [], ["INBOX"]); break;
      case "trash": await api.trashThread(action.threadId); break;
      case "markRead": await api.modifyThread(action.threadId, [], ["UNREAD"]); break;
      case "markUnread": await api.modifyThread(action.threadId, ["UNREAD"], []); break;
      default:
        action satisfies never;
        throw new Error(`Unknown Gmail action type: ${(action as {type: string}).type}`);
      }

      store.deleteForwardSnapshot(actionSourceAttachment(action), actionId);
      store.setDecision(actionId, "applied");
      store.removeAction(actionId);
      store.clearApplying(actionId);
      store.pruneDecisions();
    } finally {
      this.#applying.delete(actionId);
    }
  }

  async rejectAction(actionId: number): Promise<void | {restart?: boolean}> {
    const store = new GmailStore(this.ctx.storage);
    const action = store.getAction(actionId);
    if (!action) throw new Error(`Unknown pending Gmail action: ${actionId}`);
    const receipt = store.getDraftWriteReceipt(actionId);
    const writeReceipt = (action.type === "draftCreate" || action.type === "draftUpdate")
      ? receipt
      : undefined;
    if (this.#applying.has(actionId) ||
        (store.isApplying(actionId) &&
         !(action.type === "draftCreate" && writeReceipt !== undefined))) {
      throw new Error(
        `Gmail action ${actionId} has an uncertain provider outcome and must be reconciled first.`);
    }
    if (receipt && !receipt.missing && action.type === "draftCreate") {
      // The stable Message-ID proves the remote write is real even if its content changed before
      // reconciliation. Preserve that provider draft while rejecting the local pending action.
      store.mapDraftToProvider(action.draft.logicalId, receipt.draftId, actionId);
    }
    store.deleteForwardSnapshot(actionSourceAttachment(action), actionId);
    store.setDecision(actionId, "rejected");
    store.removeAction(actionId);
    store.clearApplying(actionId);
    if (action.type === "draftCreate") {
      const resource = store.getDraft(action.draft.logicalId);
      if (resource) {
        // Rejecting reconciliation cannot undo an identified provider write, so keep it visible.
        if (receipt?.missing) resource.status = "deleted";
        else if (!resource.providerId) resource.status = "rejected";
        resource.version++;
        store.putDraft(resource);
        if (resource.status === "rejected" || receipt?.missing) {
          store.clearDraftForwardSnapshot(action.draft.logicalId);
          store.deleteForwardSnapshot(actionSourceAttachment(action));
        }
      }
    } else if (action.type === "draftUpdate" || action.type === "draftDelete" ||
        action.type === "draftSend") {
      const resource = store.getDraft(action.draftId);
      if (resource) {
        if (receipt?.missing) resource.status = "deleted";
        resource.version++;
        store.putDraft(resource);
      }
    } else if (action.type === "labelCreate") {
      const resource = store.getLabel(action.label.logicalId);
      if (resource) {
        resource.status = "rejected";
        store.putLabel(resource);
      }
    }
    const hasDependents = store.listActions().some(item =>
      "dependsOn" in item.action && item.action.dependsOn?.includes(actionId));
    store.pruneDecisions();
    return hasDependents ? {restart: true} : undefined;
  }

  revertAction(_action: number): Promise<void> {
    throw new Error("Gmail actions are not revertible.");
  }

  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    throw new Error(
      "Gmail data is private to the connected account owner and cannot be shared with observers.");
  }

  async removeObserver(_id: string): Promise<void> {}
}
