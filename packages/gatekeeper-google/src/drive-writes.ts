/**
 * What every approval-backed Drive write shares: whether a binding may make changes, the proof
 * that a write's target is still inside the binding when it is applied, and the marker that keeps
 * a send whose outcome is in doubt from being made twice.
 *
 * An error answer from Drive does not prove a write changed nothing: Drive applies a write before
 * it checks the response mask. So a send leaves a marker before it goes, and an apply that finds
 * one looks for what that send made before it sends again. The marker outlives its send until the
 * action is settled, so an apply repeated after a send that did land finds it too.
 */

import {
  ActionApplyError, type ActionFence, type ActionSubmitter, type JournalEntry, type TaggedAction,
} from "@gadgets/gatekeeper-kit/actions";
import type { Logger } from "@gadgets/observability/logger";
import {
  DriveApiDisabledError, DriveApiRequestError, driveWriteFailure, isInsufficientScope,
  type DriveWriteFailure,
  type DriveApi, type DriveScopeNode,
} from "./drive-api";
import { docsLacksScope, type GoogleDocsApi } from "./docs-api";
import { isDirectChild, readFolderLocation } from "./drive-folder-scope";
import { GoogleApiError } from "./google-response";
import type { DriveBindingScope } from "./drive-session";
import type { DriveBindingAccess } from "./drive-types";
import type { GoogleObservabilityFields } from "./observability";
import { driveResourceUrl, type DriveAccessLevel } from "./resources";

/** The refusal for a read and write binding whose account does not hold the Drive writes grant. */
export const WRITES_GRANT_MISSING =
  "Changes need a permission this Google account hasn't granted, or no longer grants. In " +
  "Workshop, start adding a Google Drive connection for this account, choose all of Drive or a " +
  "folder, then \"Read and write\", and select \"Allow changes\". The permission covers every " +
  "read and write Drive connection on the account, so the dialog can then be closed.";

/**
 * The refusal for a write on a read-only binding of `scope`. It ends with the URL to request
 * instead and nothing after it, and no URL in it is followed by punctuation: copied with a
 * URL, that would change its last parameter's value, which then reads as read-only. All of
 * Drive is the widest connection there is, so its refusal names the narrower ones first.
 */
export function readOnlyRefusal(scope: DriveBindingScope): string {
  let url = driveResourceUrl(
    scope.kind === "account" ? { kind: "driveAccount", access: "write" }
    : scope.kind === "folder" ? { kind: "driveFolder", folderId: scope.folderId, access: "write" }
    : { kind: "driveFile", fileId: scope.fileId, access: "write" });
  let request = scope.kind === "account"
    ? "To change one file, or the files of one folder, request the narrower " +
      "https://drive.google.com/file/d/<fileId>/view?access=write or " +
      "https://drive.google.com/drive/folders/<folderId>?access=write instead. For all of " +
      "Drive, request this resource URL:"
    : "Request one with this resource URL:";
  return "This Google Drive connection is read-only, so it cannot make changes. Changes take a " +
    `connection with read and write access, which the user chooses when connecting. ${request} ${
      url}`;
}

/**
 * The most this deployment lets a Drive connection do, from the Worker's `GOOGLE_DRIVE_ACCESS`:
 * `"write"` when it is unset, empty or `write`, and `"read"` for any other value, the safe side.
 */
export function driveAccessCap(env: { GOOGLE_DRIVE_ACCESS?: string }): DriveBindingAccess {
  let value = env.GOOGLE_DRIVE_ACCESS?.trim().toLowerCase();
  return value === undefined || value === "" || value === "write" ? "write" : "read";
}

/**
 * The refusal for a write on any binding of a deployment that keeps Google Drive read-only. It
 * names no URL to request: a connection asked for instead would be refused the same way.
 */
export const DEPLOYMENT_READ_ONLY =
  "This deployment keeps Google Drive read-only, so no Google Drive connection can make " +
  "changes, and none can be connected with read and write access. Only the deployment's " +
  "administrator can change that.";

/** The refusal for connecting a Drive resource URL that asks for read and write access there. */
export const WRITE_CONNECTION_REFUSED =
  "This deployment keeps Google Drive read-only, so this connection cannot be made with read " +
  "and write access. Connect it read-only, by leaving access=write out of the URL.";

/** What decides whether a binding may make changes. */
export type DriveWriteGate = {
  /** What the deployment lets a Drive connection do (see {@link driveAccessCap}). */
  deployment: DriveBindingAccess;
  /** The binding's access level; anything but `"write"` is read-only. */
  access?: DriveAccessLevel;
  /** The binding's own scope, which a read-only refusal names the read and write URL of. */
  scope: DriveBindingScope;
  /**
   * Whether the account holds the Drive writes grant, read live. Rejects when the account itself
   * cannot answer for the binding, as one that was disconnected cannot: no grant would lift that.
   */
  holdsGrant(): Promise<boolean>;
};

/**
 * Why a binding cannot make changes now, or `undefined` when it can: the deployment keeps Google
 * Drive read-only, the binding is read-only, or its account does not hold the Drive writes grant.
 * Asked when a write is queued and again when it is applied. A failure of the grant's read is
 * passed on as it came.
 */
export async function writeRefusal(gate: DriveWriteGate): Promise<string | undefined> {
  // Before the binding's own level: the read-only refusal names a URL this deployment refuses too.
  if (gate.deployment !== "write") return DEPLOYMENT_READ_ONLY;
  if (gate.access !== "write") return readOnlyRefusal(gate.scope);
  return (await gate.holdsGrant()) ? undefined : WRITES_GRANT_MISSING;
}

/** Longest part of a file's or folder's name an approval shows, in characters. */
const FILE_NAME_CHARS = 200;

/**
 * What a write's approval shows of a file's or folder's name: all of it, or its first 200
 * characters and an ellipsis.
 */
export function shownFileName(name: string): string {
  let characters = [...name];
  return characters.length > FILE_NAME_CHARS
    ? `${characters.slice(0, FILE_NAME_CHARS).join("")}…` : name;
}

/** A write of any kind still to be decided or applied, as the binding's queue hands it out. */
export type QueuedWrite = JournalEntry<{ kind: string; payload: unknown }>;

/** The prefix of the ID a queued write's result is shown under until it is decided. */
export const PENDING_PREFIX = "pending:";

/** Whether `id` names a queued write's result rather than something on Drive. */
export function isPendingId(id: string): boolean {
  return id.startsWith(PENDING_PREFIX);
}

/** The ID action `actionId`'s result is shown under while it waits. */
export function pendingId(actionId: number): string {
  return `${PENDING_PREFIX}${actionId}`;
}

/** What every Drive write carries about its target. */
export type DriveWriteTargetPayload = {
  fileId: string;
  /**
   * The target's name when queued, as {@link shownFileName} cuts it, for the approver.
   */
  fileName?: string;
  /**
   * Folder binding: the path from the bound root to the target's parent, or, with `self`, to the
   * target itself. Proved again at apply.
   */
  folderIds?: string[];
  /** Folder binding: the target is the positioned folder itself. */
  self?: true;
};

/** The Google account a connection acts as: its permission ID and, if Drive gives one, address. */
export type DriveActor = { permissionId: string; emailAddress?: string };

/** The fence a write made as one Google account is staged and applied under. */
export function actorFence(actor: DriveActor): ActionFence {
  return { generation: actor.permissionId };
}

/** The part of an address after its last `@`, in lower case. */
export function addressDomain(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1).toLowerCase();
}

/** A send that may have reached Drive, recorded before it went. */
export type WriteAttempt = {
  at: number;
  /**
   * The IDs of what was already there and looks like what this send makes: for a reply, the
   * account's replies on the comment. A sharing change's and a move's marker notes none.
   */
  existing?: string[];
  /** Earlier sends of this write proven to have made nothing, counted for one given a limit. */
  failedSends?: number;
  /** A suggested edit's suggestion, once it is known to be made: what remains is its note. */
  suggestionId?: string;
  /**
   * What the write posted, once it is over: a comment, reply or resolve Google confirmed or a look
   * found, or a suggested edit's suggestion once its note is too. A retry answers with it and never
   * looks, since the post may have been edited or deleted since.
   */
  postedId?: string;
  /** When a suggested edit's note's send began, once one has: a retry looks for it first. */
  noteAt?: number;
};

/** Where a send's attempt marker is stored, by action ID, for every kind of Drive write. */
export const WRITE_ATTEMPT_PREFIX = "driveComments:attempt:";

function attemptKey(id: number): string {
  return `${WRITE_ATTEMPT_PREFIX}${id}`;
}

/** The attempt markers of one Drive binding, kept in its Durable Object's storage. */
export function writeAttempts(kv: DurableObjectStorage["kv"]): {
  /** The marker of action `id`'s last send, if it left one. */
  get(id: number): WriteAttempt | undefined;
  /** Records a send of action `id` before it goes. */
  put(id: number, attempt: WriteAttempt): void;
  /** Drops action `id`'s marker. */
  delete(id: number): void;
  /** Drops the markers of actions `keep` does not name: none of them can be applied again. */
  sweep(keep: ReadonlySet<number>): void;
} {
  return {
    get: id => kv.get<WriteAttempt>(attemptKey(id)),
    put: (id, attempt) => kv.put(attemptKey(id), attempt),
    delete: id => { kv.delete(attemptKey(id)); },
    sweep: keep => {
      for (let [stored] of kv.list({ prefix: WRITE_ATTEMPT_PREFIX })) {
        let id = Number(stored.slice(WRITE_ATTEMPT_PREFIX.length));
        if (!keep.has(id)) kv.delete(stored);
      }
    },
  };
}

/** What applying a Drive write needs of its gatekeeper. */
export type DriveWritesHost = {
  api: Pick<DriveApi,
    "getScopeNodes" | "getComment" | "listComments" | "listReplies" | "createComment" |
    "createReply" | "listPermissions" | "createPermission" | "updatePermission" |
    "deletePermission" | "swapParent">;
  /** The Docs API, through which comments that quote a Doc and suggested edits are sent. */
  docs: Pick<GoogleDocsApi,
    "getDocumentWithSuggestions" | "getRevisionId" | "insertComment" | "suggest" |
    "replyToSuggestion">;
  /** The binding's scope, read when an action applies. */
  scope(): DriveBindingScope;
  /** Why this binding cannot make changes now, read when an action applies. */
  writeRefusal(): Promise<string | undefined>;
  /** The attempt markers a handler reads and writes. Sweeping them is the gatekeeper's. */
  attempts: Pick<ReturnType<typeof writeAttempts>, "get" | "put" | "delete">;
};

/** What a Drive session needs of its gatekeeper to show and queue the writes of action map `M`. */
export type DriveWriteQueue<M extends Record<string, unknown>> = {
  /** The binding's access, which the session reports with its scope. */
  access: DriveBindingAccess;
  /** Why this binding cannot make changes now, or `undefined` when it can. */
  writeRefusal(): Promise<string | undefined>;
  /**
   * The Google account the connection acts as now, read from Drive on every call with the
   * credentials the account holds at that moment.
   */
  actor(): Promise<DriveActor>;
  /** Queues one write through `queue`, under `fence` when its definition is fenced. */
  submit<K extends keyof M>(
    queue: ActionSubmitter, kind: K, payload: M[K], fence?: ActionFence): Promise<number>;
  /**
   * Runs `read` with the writes awaiting a decision, of every kind, while none is being applied
   * or rejected. These are what a read shows as if made.
   */
  undecided<T>(
    read: (pending: readonly JournalEntry<TaggedAction<M>>[]) => Promise<T>,
  ): Promise<T>;
  /**
   * Runs `read` with every write an approval can still apply, of every kind, while none is being
   * applied or rejected: those awaiting a decision, and those an approval that ended before it
   * settled them left claimed, which the next approval takes up. A write is refused for what
   * already waits by this list, so that nothing is queued behind a write that will still be made.
   */
  waiting<T>(
    read: (pending: readonly JournalEntry<TaggedAction<M>>[]) => Promise<T>,
  ): Promise<T>;
};

/**
 * A folder binding's saved path as it stands now, with the nodes of `extraIds` read in the same
 * batch. `undefined` unless the binding is a folder's, the path starts at its bound root and every
 * saved link still holds.
 */
export async function provePath(
  host: Pick<DriveWritesHost, "api" | "scope">, folderIds: readonly string[] | undefined,
  extraIds: readonly string[],
): Promise<{ path: DriveScopeNode[]; extras: (DriveScopeNode | undefined)[] } | undefined> {
  let scope = host.scope();
  if (scope.kind !== "folder" || !folderIds?.length || folderIds[0] !== scope.folderId) {
    return undefined;
  }
  let nodes = await host.api.getScopeNodes([...folderIds, ...extraIds]);
  if (nodes.length !== folderIds.length + extraIds.length) return undefined;
  let extras = nodes.splice(folderIds.length);
  // Handed the nodes already read, the location check can only refuse.
  let path = await readFolderLocation({ folderIds }, async () => nodes).catch(() => undefined);
  return path && { path, extras };
}

/**
 * The target as the binding's scope reaches it at apply, or `undefined` when it is out of scope
 * or invisible. A folder binding re-proves every saved link in one batch, and then that
 * the target is a live direct child of the last folder, or, with `self`, that it is that folder.
 */
export async function proveTarget(
  host: Pick<DriveWritesHost, "api" | "scope">, payload: DriveWriteTargetPayload,
): Promise<DriveScopeNode | undefined> {
  let scope = host.scope();
  if (scope.kind !== "folder") {
    // Only a folder binding is positioned at a folder that can be its own target.
    if (payload.self) return undefined;
    if (scope.kind === "file" && payload.fileId !== scope.fileId) return undefined;
    return (await host.api.getScopeNodes([payload.fileId]))[0];
  }
  if (payload.self) {
    if (payload.folderIds?.at(-1) !== payload.fileId) return undefined;
    return (await provePath(host, payload.folderIds, []))?.path.at(-1);
  }
  let proved = await provePath(host, payload.folderIds, [payload.fileId]);
  let file = proved?.extras[0];
  let parent = proved?.path.at(-1);
  return file && parent && isDirectChild(file, parent) ? file : undefined;
}

/**
 * Whether a later approval can pass a write refusal with no new connection: the grant can be
 * given and the deployment's setting lifted, while a binding's own access level never changes.
 */
export function isLiftable(refusal: string): boolean {
  return refusal === WRITES_GRANT_MISSING || refusal === DEPLOYMENT_READ_ONLY;
}

/**
 * Refuses a write whose binding may not make changes when it is applied: retryably for a refusal a
 * later approval can pass, and for good for any other.
 */
export async function requireWritable(host: Pick<DriveWritesHost, "writeRefusal">): Promise<void> {
  let refused = await host.writeRefusal();
  if (refused === undefined) return;
  throw isLiftable(refused) ? new Error(refused) : new ActionApplyError(refused);
}

/** One kind of write, as {@link sendOnce} drives it. */
export type WriteStep<Sent> = {
  /** Logs `<events>.applied`, `<events>.reconciled` and `<events>.send.failed`. */
  log: Logger<GoogleObservabilityFields>;
  /** The prefix of the events `log` is given, such as `drive.sharing`. */
  events: string;
  /**
   * The last segment and outcome of the event a send that worked is logged as; `applied` by
   * default.
   */
  applied?: { event: string; outcome: string };
  /**
   * What an earlier send of this write left behind: `found`, with what it made; or nothing, with
   * `conclusive` saying whether that proves the send made nothing. Throws
   * ActionOutcomeUnknownError when it cannot tell.
   */
  look(prior: WriteAttempt): Promise<{ found: Sent } | { conclusive: boolean; retry?: Error }>;
  /**
   * The checks repeated at apply. Throws ActionApplyError to fail the write for good and any other
   * error to leave it pending. Resolves with what the marker should note of what is already there.
   */
  check(): Promise<{ existing?: string[] }>;
  /** Makes the change at Drive, resolving with what it made. */
  send(): Promise<Sent>;
  /** Whether Google can be sent this write twice without a second effect. */
  repeatable: boolean;
  /**
   * A limit on the sends of this write: once this many, each left unconfirmed, are found by a look
   * to have made nothing, the write fails for good with `message` and is not sent again.
   */
  exhausted?: { sends: number; message: string };
  /**
   * How a failed send failed, for a write sent through another Google API than Drive's, such as a
   * comment that quotes a Google Doc. Drive's classification by default.
   */
  failure?(error: unknown): DriveWriteFailure;
  /**
   * A reason a later approval can pass a send refused with nothing made, which leaves the write
   * pending rather than failing it: a Google Doc that changed while the send went, for one.
   */
  passable?(error: unknown): Promise<string | undefined>;
  /** Drive's refusal, for good, of a send that changed nothing, in our words. */
  refusal(error: unknown): string;
  /**
   * What a send refused for a missing scope fails with, leaving the write pending: the binding's
   * own remedy. The Drive writes grant's refusal by default.
   */
  grantMissing?: string;
  /** Said when a send's outcome is not known. */
  unconfirmed: string;
  /** What the log line of a send that worked, or was found, carries beyond the bound fields. */
  logFields?(sent: Sent): Partial<GoogleObservabilityFields>;
};

/** Said of a send Google answered 401: its approval's token is no longer accepted. */
export const CREDENTIALS_NOT_ACCEPTED =
  "Google did not accept this connection's credentials for this change. Approve it again, " +
  "which first checks the file; if it is refused the same way, reconnect the Google account.";

/** Said of a send Google refused for the rate of requests, which it may take later. */
const RATE_LIMITED =
  "Google Drive is limiting requests from this account. Approve it again in a minute.";

/**
 * Makes one approved write, looking first for what an earlier send of it may have made.
 *
 * A marker is written before the send and is never dropped here for a send that worked, that a
 * look found, or that a look could not judge: the gatekeeper drops it once the action's record is
 * settled, and until then a retry must find it and look, never send. It is dropped once the write
 * fails for good with nothing changed: at a check, by Google's refusal, or when the last send its
 * limit allows is also found to have made nothing. The marker of a send a look proves empty stays
 * until the next send's replaces it, which is what counts the sends. A write that cannot be
 * repeated loses its marker on a rate limit and on a missing scope, when no send of it is in
 * doubt. A write that can be repeated keeps it through both and through a 401, so that its next
 * approval looks first: a change such a send made all the same is then found and bound, where an
 * approval with no marker would take it for someone else's.
 * @returns What the send made, or what a look found an earlier send had made.
 */
export async function sendOnce<Sent>(
  host: Pick<DriveWritesHost, "attempts">, id: number, step: WriteStep<Sent>,
): Promise<Sent> {
  let { log, events } = step;
  let prior = host.attempts.get(id);
  let failedSends = 0;
  if (prior) {
    let looked = await step.look(prior);
    if ("found" in looked) {
      log.info("found what an earlier send of a Drive write made", {
        ...step.logFields?.(looked.found), event: `${events}.reconciled`, outcome: "found",
      });
      return looked.found;
    }
    // A look that proves nothing and names no reason leaves the outcome as open as it was.
    if (!looked.conclusive) throw looked.retry ?? new Error(step.unconfirmed);
    // That send made nothing. Its marker stays until the next send's replaces it, so that a check
    // that fails in between and is tried again counts the send from the same marker.
    failedSends = (prior.failedSends ?? 0) + 1;
    if (step.exhausted && failedSends >= step.exhausted.sends) {
      host.attempts.delete(id);
      throw new ActionApplyError(step.exhausted.message);
    }
  }

  let noted: { existing?: string[] };
  try {
    noted = await step.check();
  } catch (error) {
    // Failed for good with nothing sent since the look: no later approval reads the marker.
    if (error instanceof ActionApplyError) host.attempts.delete(id);
    throw error;
  }
  host.attempts.put(id, {
    at: Date.now(), ...(noted.existing?.length ? { existing: noted.existing } : {}),
    // Counted only for a write with a limit: a repeatable one is sent again as often as approved.
    ...(step.exhausted && failedSends ? { failedSends } : {}),
  });

  let sent: Sent;
  try {
    sent = await step.send();
  } catch (error) {
    let failure = step.failure?.(error) ?? driveWriteFailure(error, { repeatable: step.repeatable });
    log.warn("Drive write send failed", {
      event: `${events}.send.failed`, outcome: failure, error,
      ...(error instanceof DriveApiRequestError
        ? { httpStatus: error.status, ...(error.reason ? { providerReasons: [error.reason] } : {}) }
        : error instanceof GoogleApiError && error.providerReasons.length
          ? { providerReasons: [...error.providerReasons] } : {}),
    });
    if (failure === "unknown") throw new Error(step.unconfirmed, { cause: error });
    // The approval's one token was not accepted. The next approval loads the account's afresh.
    if (failure === "unauthorized") throw new Error(CREDENTIALS_NOT_ACCEPTED, { cause: error });
    // The token lacks the scope, which allowing changes again lifts, as when the account says so.
    let later = failure === "rateLimited" ? RATE_LIMITED
      : isInsufficientScope(error) || docsLacksScope(error)
        ? step.grantMissing ?? WRITES_GRANT_MISSING : undefined;
    if (later !== undefined) {
      if (!step.repeatable) host.attempts.delete(id);
      throw new Error(later, { cause: error });
    }
    host.attempts.delete(id);
    let passable = await step.passable?.(error);
    if (passable !== undefined) throw new Error(passable, { cause: error });
    throw new ActionApplyError(step.refusal(error));
  }
  let applied = step.applied ?? { event: "applied", outcome: "applied" };
  log.info("made a Drive write", {
    ...step.logFields?.(sent), event: `${events}.${applied.event}`, outcome: applied.outcome,
  });
  return sent;
}

/** One refusal Drive can give a write: a status and reason, and what the approver is told. */
export type RefusalRow = { status: number; reason: string; message: string };

/**
 * Drive's refusal of a send that changed nothing, in our words, ending with the status and reason
 * Google gave so that a reason no row knows is still visible. `rows` are the kind's own;
 * `fallback` is said for any other refusal. Google's own message is never read.
 */
export function driveRefusal(
  error: unknown, rows: readonly RefusalRow[], fallback: string,
): string {
  // The class carries neither field: it is made for exactly this status and reason.
  if (error instanceof DriveApiDisabledError) {
    return "The Google Drive API is not enabled for this deployment's Google project. " +
      "[http=403 reason=accessNotConfigured]";
  }
  if (!(error instanceof DriveApiRequestError)) return fallback;
  let { status, reason } = error;
  let message = status === 403 && reason === "domainPolicy"
    ? "Your organization's administrator does not allow this app to use Google Drive."
    : rows.find(row => row.status === status && row.reason === reason)?.message ?? fallback;
  return `${message} [http=${status}${reason === undefined ? "" : ` reason=${reason}`}]`;
}
