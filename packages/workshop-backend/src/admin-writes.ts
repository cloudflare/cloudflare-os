// The pure parts of admin writes to workspaces: what is computed from its arguments alone, with no
// storage read and no call made.

import {
  MAX_ADMIN_AUDIT_ARG_LENGTH,
} from "@gadgets/workshop-shared/api";
import {
  adminAuditValue, cutAdminAuditText, type AdminWriteActor,
} from "./admin-access.js";

/** A write request as AdminSettings stores it: the API's, without the URL (derived from the
 * environment when read), with what only the server needs to record its later steps. */
export type StoredAdminWrite = Omit<AdminWriteRequest, "approvalUrl"> & {
  /** The requester's audit session, for the "expired" record. */
  sessionId: string;
  /** Who approved it, through which session and with which passkey: what its grant carries to
   * the workspace, and the actor of its "applied" or "failed" record. */
  approver?: AdminWriteApprover;
  /** Set while its "applied" or "failed" record is still to be written. The workspace has run by
   * then, so its answer is stored first and recorded until that succeeds. */
  unrecorded?: true;
};

/** Who approved a write request, and with which passkey: its credential id as
 * AdminWriteRecord.passkey keeps it (auditOwnerId() of the id). */
export type AdminWriteApprover = AdminWriteActor & { passkey: string };

/** What OverseerDurableObject.applyAdminWrite() is given: an approved request, and who approved
 * it, through which session and with which passkey, for the "approved" record the workspace
 * writes. `workspaceOwner` is the owner the approval page showed: the workspace refuses
 * (`workspaceChanged`) a grant naming another owner than its own, since a deleted workspace's id
 * can be initialised again for someone else. */
export type AdminWriteGrant =
    Pick<StoredAdminWrite,
        "action" | "args" | "reason" | "requestedBy" | "expiresAt" | "workspaceOwner"> &
    AdminWriteApprover & { requestId: string };

/** A fresh challenge: 32 random bytes, then `binding` (the digest of what the ceremony confirms:
 * an approval's request, a removal's credential id), as unpadded base64url. */
export function newPasskeyChallenge(binding?: Uint8Array): string {
  let challenge = new Uint8Array(32 + (binding?.length ?? 0));
  crypto.getRandomValues(challenge.subarray(0, 32));
  if (binding) challenge.set(binding, 32);
  return challenge.toBase64({ alphabet: "base64url", omitPadding: true });
}

// The arguments each action takes: exactly the list in AdminWriteArgs' doc.
const WRITE_ARGS: Record<AdminWriteAction,
    { required: (keyof AdminWriteArgs)[]; optional?: (keyof AdminWriteArgs)[] }> = {
  stopAgent: { required: ["chatId"] },
  restartWorkspace: { required: [] },
  deleteChat: { required: ["chatId"] },
  rejectPendingActions: { required: [], optional: ["gatekeeperId"] },
};

// What an argument's value must be beyond its type, which the RPC validator has checked: `keep`
// returns the value to keep, or undefined for one that is refused.
type WriteArgRule<T> = { must: string; keep: (value: T) => T | undefined };

const ID: WriteArgRule<number> = {
  must: "be a non-negative whole number",
  keep: value => Number.isSafeInteger(value) && value >= 0 ? value : undefined,
};

// Every argument has a rule: one without does not compile.
type WriteArgValues = Required<AdminWriteArgs>;
const WRITE_ARG_RULES: { [Name in keyof WriteArgValues]: WriteArgRule<WriteArgValues[Name]> } = {
  chatId: ID, gatekeeperId: ID,
};

// Puts `value` in `kept` under `name`, as its rule keeps it.
function keepWriteArg<Name extends keyof WriteArgValues>(
    kept: AdminWriteArgs, name: Name, value: WriteArgValues[Name]): void {
  let rule = WRITE_ARG_RULES[name];
  let clean = rule.keep(value);
  if (clean === undefined) throw new TypeError(`\`${name}\` must ${rule.must}.`);
  kept[name] = clean;
}

/** The arguments `action` takes, each validated and nothing else kept: throws TypeError for a
 * missing required one, one the action does not take, or a chat or connection id that is not a
 * non-negative safe integer. */
export function adminWriteArgs(action: AdminWriteAction, args: AdminWriteArgs): AdminWriteArgs {
  // An own entry only: "constructor" names no action.
  if (!Object.hasOwn(WRITE_ARGS, action)) throw new TypeError("No such write action.");
  let { required, optional = [] } = WRITE_ARGS[action];
  let taken: string[] = [...required, ...optional];
  // The validator lets through properties the type does not declare, so every key is looked at.
  // A name the client made up is cut as the audit log cuts a string before it is quoted back.
  for (let [name, value] of Object.entries(args)) {
    if (value !== undefined && !taken.includes(name)) {
      throw new TypeError(`"${action}" takes no \`${
          cutAdminAuditText(name, MAX_ADMIN_AUDIT_ARG_LENGTH)}\`.`);
    }
  }

  // Built field by field from the table, so that nothing else the client sent is kept.
  let kept: AdminWriteArgs = {};
  for (let name of required) {
    let value = args[name];
    if (value === undefined) throw new TypeError(`"${action}" needs \`${name}\`.`);
    keepWriteArg(kept, name, value);
  }
  for (let name of optional) {
    let value = args[name];
    if (value !== undefined) keepWriteArg(kept, name, value);
  }
  return kept;
}

/** What an entry of the workspace's action log calls the write, e.g. "Stop the agent in chat
 * 3": the write named, not reported done, since the entry is written before it runs. Built from
 * the action and its numeric ids alone, never from text the requester wrote: the reason is a
 * field of the entry, shown as literal text. */
export function adminWriteTitle(action: AdminWriteAction, args: AdminWriteArgs): string {
  // No default, so that an action without a title does not compile.
  switch (action) {
    case "stopAgent": return `Stop the agent in chat ${args.chatId}`;
    case "restartWorkspace": return "Restart the workspace";
    case "deleteChat": return `Delete chat ${args.chatId}`;
    case "rejectPendingActions":
      return args.gatekeeperId === undefined ? "Reject the pending actions"
          : `Reject the pending actions of connection ${args.gatekeeperId}`;
  }
}

/** The SHA-256 an approval signs: of the canonical JSON (adminAuditValue()) of everything about
 * the request that its approval page shows and that never changes: its id, workspace (id, title
 * and owner as stored), action, arguments, reason, requester, `via`, and the times it was made and
 * expires. */
export async function adminWriteDigest(request: Pick<StoredAdminWrite,
    "id" | "workspaceId" | "workspaceTitle" | "workspaceOwner" | "action" | "args" | "reason" |
    "requestedBy" | "via" | "requestedAt" | "expiresAt">): Promise<Uint8Array> {
  let { id, workspaceId, workspaceTitle, workspaceOwner, action, args, reason, requestedBy, via } =
      request;
  // Sorted keys at every level, so the digest does not depend on how the request was built or
  // stored.
  let canonical = adminAuditValue({
    id, workspaceId, workspaceTitle, workspaceOwner, action, args, reason, requestedBy, via,
    requestedAt: request.requestedAt.getTime(), expiresAt: request.expiresAt.getTime(),
  });
  return new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)));
}
