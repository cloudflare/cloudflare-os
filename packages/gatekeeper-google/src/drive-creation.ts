import type { ApprovalQueue } from "@gadgets/workshop-shared/gatekeeper";
import { formatApprovalField, sanitizeApprovalTitle } from "./approval-format";
import type { DriveApi, DriveFile } from "./drive-api";
import {
  isDriveFileInScope, validateDriveCreationParent,
  type DriveBindingScope, type DriveCreationParent,
} from "./drive-session";
import type { DriveCreationHandle, DriveCreationKind } from "./drive-types";
import { PendingActionStore, type PendingActionStorage } from "./pending-action-store";
import { obsContext } from "./observability";

const OUTCOME_PREFIX = "drive:create:outcome:";
const NEXT_OUTCOME_SEQUENCE_KEY = "drive:create:nextOutcomeSequence";
const MAX_PENDING_CREATIONS = 100;
const MAX_TERMINAL_OUTCOMES = 100;

const MIME_TYPE_BY_KIND: Record<DriveCreationKind, string> = {
  googleDoc: "application/vnd.google-apps.document",
  googleSheet: "application/vnd.google-apps.spreadsheet",
  folder: "application/vnd.google-apps.folder",
};

const KIND_LABEL: Record<DriveCreationKind, string> = {
  googleDoc: "Google Doc",
  googleSheet: "Google Sheet",
  folder: "folder",
};

const logger = obsContext.createLogger({
  component: "gatekeeper.google.drive-creation", vendorId: "google",
});

/** Synchronous Durable Object KV operations used by Drive creation state. */
export type DriveCreationStorage = PendingActionStorage;

/** Narrow provider surface used by creation callbacks. */
export type DriveCreationApi = Pick<
  DriveApi, "getFile" | "findFileByCreationRequestId" | "createFile" | "trashFile"
>;

/** Authoritative request persisted until the approval callback reaches a terminal state. */
export type DriveCreationAction = {
  kind: DriveCreationKind;
  name: string;
  parentId: string;
  parentAuthority: DriveCreationParent["authority"];
  requestId: string;
};

/** Persisted callback outcome; provider metadata is intentionally represented only by file ID. */
export type StoredDriveCreationOutcome =
  | { status: "applying"; createdFileId?: string }
  | { status: "rejected" }
  | { status: "failed"; message: string; createdFileId?: string }
  | { status: "created"; kind: DriveCreationKind; fileId: string }
  | { status: "reverted" };

/** Current authoritative state before created metadata is freshly observed. */
export type StoredDriveCreationState =
  | { status: "pending"; lastError?: string }
  | { status: "rejected" }
  | { status: "created"; kind: DriveCreationKind; fileId: string }
  | { status: "reverted" };

type StoredOutcomeRecord = {
  sequence: number;
  outcome: StoredDriveCreationOutcome;
};

/** Durable action and bounded outcome storage for one Drive binding. */
export class DriveCreationStore {
  #actions: PendingActionStore<DriveCreationAction>;

  constructor(private storage: DriveCreationStorage) {
    this.#actions = new PendingActionStore(storage);
  }

  submit(action: DriveCreationAction): number {
    return this.#actions.submit(action);
  }

  pendingCount(): number {
    return this.#actions.list().length;
  }

  getAction(id: number): DriveCreationAction | undefined {
    return this.#actions.get(id);
  }

  removeAction(id: number): void {
    this.#actions.remove(id);
  }

  getOutcome(id: number): StoredDriveCreationOutcome | undefined {
    return this.storage.get<StoredOutcomeRecord>(this.#outcomeKey(id))?.outcome;
  }

  putApplying(id: number, createdFileId?: string): void {
    this.#putOutcome(id, {
      status: "applying", ...(createdFileId ? { createdFileId } : {}),
    });
  }

  putFailure(id: number, message: string, createdFileId?: string): void {
    this.#putOutcome(id, {
      status: "failed", message, ...(createdFileId ? { createdFileId } : {}),
    });
  }

  finish(id: number, outcome: Exclude<StoredDriveCreationOutcome, { status: "failed" }>): void {
    this.#putOutcome(id, outcome);
    this.removeAction(id);
    this.#pruneTerminalOutcomes();
  }

  cleanupTerminal(id: number): void {
    this.removeAction(id);
    this.#pruneTerminalOutcomes();
  }

  #outcomeKey(id: number): string {
    return `${OUTCOME_PREFIX}${id}`;
  }

  #putOutcome(id: number, outcome: StoredDriveCreationOutcome): void {
    let sequence = this.storage.get<number>(NEXT_OUTCOME_SEQUENCE_KEY) ?? 1;
    this.storage.put(NEXT_OUTCOME_SEQUENCE_KEY, sequence + 1);
    this.storage.put(this.#outcomeKey(id), { sequence, outcome } satisfies StoredOutcomeRecord);
  }

  #pruneTerminalOutcomes(): void {
    let terminal = [...this.storage.list<StoredOutcomeRecord>({ prefix: OUTCOME_PREFIX })]
      .map(([key, record]) => ({
        id: Number(key.slice(OUTCOME_PREFIX.length)), key, sequence: record.sequence,
      }))
      .filter(({ id }) => Number.isFinite(id) && this.getAction(id) === undefined)
      .toSorted((a, b) => a.sequence - b.sequence);
    for (let record of terminal.slice(0, -MAX_TERMINAL_OUTCOMES)) {
      this.storage.delete(record.key);
    }
  }
}

/** Reject empty names before any provider lookup. */
export function validateDriveCreationName(name: string): void {
  if (!name.trim()) throw new Error("Google Drive creation name must not be empty");
}

/** Reject submissions before provider lookup once the binding has 100 unresolved creates. */
export function assertDriveCreationCapacity(storage: DriveCreationStorage): void {
  if (new DriveCreationStore(storage).pendingCount() >= MAX_PENDING_CREATIONS) {
    throw new Error(
      "Too many pending Google Drive creations. Resolve existing actions before adding more.",
    );
  }
}

/** Persist one request and submit its manual approval description. */
export async function submitDriveCreation(options: {
  storage: DriveCreationStorage;
  approvalQueue: Pick<ApprovalQueue, "submitAction">;
  kind: DriveCreationKind;
  name: string;
  parent: DriveCreationParent;
  requestId?: string;
}): Promise<DriveCreationHandle> {
  validateDriveCreationName(options.name);
  assertDriveCreationCapacity(options.storage);
  let action: DriveCreationAction = {
    kind: options.kind,
    name: options.name,
    parentId: options.parent.id,
    parentAuthority: options.parent.authority,
    requestId: options.requestId ?? crypto.randomUUID(),
  };
  let store = new DriveCreationStore(options.storage);
  let id = store.submit(action);
  try {
    await options.approvalQueue.submitAction(id, {
      title: sanitizeApprovalTitle(`Create ${KIND_LABEL[action.kind]}: ${action.name}`),
      description: [
        `Create a blank ${KIND_LABEL[action.kind]} in Google Drive. ` +
          "The new item inherits the destination folder's permissions.",
        formatApprovalField("Name", action.name),
        formatApprovalField("Destination folder", options.parent.name),
        formatApprovalField("Destination folder ID", options.parent.id),
      ].join("\n\n"),
      implementsRevert: true,
      awaitDecision: true,
    });
  } catch (error) {
    store.removeAction(id);
    throw error;
  }
  return { id, kind: action.kind, name: action.name };
}

/** Provider and durable state required by Drive creation callbacks. */
export type DriveCreationRuntime = {
  storage: DriveCreationStorage;
  api: DriveCreationApi;
  scope: DriveBindingScope;
};

/** Read persisted state by authoritative numeric action ID. */
export function readDriveCreationState(
  storage: DriveCreationStorage, actionId: number,
): StoredDriveCreationState {
  let store = new DriveCreationStore(storage);
  let outcome = store.getOutcome(actionId);
  if (outcome?.status === "failed") {
    return { status: "pending", lastError: outcome.message };
  }
  if (outcome?.status === "applying") return { status: "pending" };
  if (outcome) return outcome;
  if (store.getAction(actionId)) return { status: "pending" };
  throw new Error(`Unknown Google Drive creation action: ${actionId}`);
}

/** Apply or idempotently recover one approved creation. */
export async function applyDriveCreation(
  runtime: DriveCreationRuntime, actionId: number,
): Promise<void> {
  if (runtime.scope.kind === "file") {
    throw new Error("The requested file is outside this Drive binding.");
  }
  let store = new DriveCreationStore(runtime.storage);
  let outcome = store.getOutcome(actionId);
  if (outcome && outcome.status !== "failed" && outcome.status !== "applying") {
    store.cleanupTerminal(actionId);
    return;
  }
  let action = store.getAction(actionId);
  if (!action) throw new Error(`Unknown pending Google Drive creation action: ${actionId}`);
  let knownCreatedFileId = outcome?.status === "failed" || outcome?.status === "applying"
    ? outcome.createdFileId
    : undefined;
  store.putApplying(actionId, knownCreatedFileId);

  let created: DriveFile | undefined;
  try {
    let parent = await runtime.api.getFile(action.parentId);
    validateDriveCreationParent(runtime.scope, parent, action.parentAuthority);
    created = await runtime.api.findFileByCreationRequestId(action.requestId) ??
      await runtime.api.createFile({
        name: action.name,
        mimeType: MIME_TYPE_BY_KIND[action.kind],
        parentId: action.parentId,
        requestId: action.requestId,
      });
    validateCreatedFile(runtime.scope, action, created);
  } catch (error) {
    store.putFailure(actionId, failureMessage(error), created?.id ?? knownCreatedFileId);
    logger.warn("Drive creation action failed", {
      event: "drive.creation.apply.failed", actionId, operation: "apply", error,
    });
    throw error;
  }

  store.finish(actionId, { status: "created", kind: action.kind, fileId: created.id });
}

/** Serialize callbacks for each action while retaining crash recovery in durable state. */
export class DriveCreationCoordinator {
  #inFlight = new Map<number, Promise<void>>();

  /** Apply one approved creation after any earlier callback for the same action. */
  apply(runtime: DriveCreationRuntime, actionId: number): Promise<void> {
    return this.#run(actionId, () => applyDriveCreation(runtime, actionId));
  }

  /** Reject one creation after any earlier callback for the same action. */
  reject(runtime: DriveCreationRuntime, actionId: number): Promise<void> {
    return this.#run(actionId, () => rejectDriveCreation(runtime, actionId));
  }

  /** Revert one creation after any earlier callback for the same action. */
  revert(runtime: DriveCreationRuntime, actionId: number): Promise<void> {
    return this.#run(actionId, () => revertDriveCreation(runtime, actionId));
  }

  #run(actionId: number, operation: () => Promise<void>): Promise<void> {
    let previous = this.#inFlight.get(actionId) ?? Promise.resolve();
    let current = previous.catch(() => {}).then(operation).finally(() => {
      if (this.#inFlight.get(actionId) === current) this.#inFlight.delete(actionId);
    });
    this.#inFlight.set(actionId, current);
    return current;
  }
}

/** Reject pending creation, first removing any file produced by a failed attempt. */
export async function rejectDriveCreation(
  runtime: DriveCreationRuntime, actionId: number,
): Promise<void> {
  let store = new DriveCreationStore(runtime.storage);
  let outcome = store.getOutcome(actionId);
  if (outcome?.status === "rejected") {
    store.cleanupTerminal(actionId);
    return;
  }
  if (outcome?.status === "applying") {
    throw new Error(`Google Drive creation action ${actionId} is currently being applied`);
  }
  if (outcome?.status === "created" || outcome?.status === "reverted") {
    throw new Error(`Google Drive creation action ${actionId} has already been applied`);
  }
  if (!store.getAction(actionId)) {
    throw new Error(`Unknown pending Google Drive creation action: ${actionId}`);
  }
  if (outcome?.status === "failed" && outcome.createdFileId) {
    await trashCreatedFile(runtime, outcome.createdFileId);
  }
  store.finish(actionId, { status: "rejected" });
}

/** Trash a currently authorized created item and record its reverted state. */
export async function revertDriveCreation(
  runtime: DriveCreationRuntime, actionId: number,
): Promise<void> {
  let store = new DriveCreationStore(runtime.storage);
  let outcome = store.getOutcome(actionId);
  if (outcome?.status === "reverted") return;
  let fileId: string | undefined;
  if (outcome?.status === "created") fileId = outcome.fileId;
  else if (outcome?.status === "failed") fileId = outcome.createdFileId;
  if (!fileId) {
    throw new Error(`Google Drive creation action ${actionId} cannot be reverted`);
  }
  await trashCreatedFile(runtime, fileId);
  store.finish(actionId, { status: "reverted" });
}

async function trashCreatedFile(runtime: DriveCreationRuntime, fileId: string): Promise<void> {
  let file = await runtime.api.getFile(fileId);
  if (runtime.scope.kind === "file" || !isDriveFileInScope(runtime.scope, file)) {
    throw new Error("The requested file is outside this Drive binding.");
  }
  if (file.capabilities?.canTrash !== true) {
    throw new Error("The created Google Drive item cannot currently be moved to trash");
  }
  await runtime.api.trashFile(file.id);
}

function validateCreatedFile(
  scope: DriveBindingScope, action: DriveCreationAction, file: DriveFile,
): void {
  if (scope.kind === "file" ||
      isDriveFileInScope(scope, file) === false ||
      file.name !== action.name ||
      file.mimeType !== MIME_TYPE_BY_KIND[action.kind] ||
      file.trashed !== false ||
      file.parents?.length !== 1 ||
      file.parents[0] !== action.parentId) {
    throw new Error("Google Drive creation marker matched unexpected file metadata");
  }
}

function failureMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1000);
}
