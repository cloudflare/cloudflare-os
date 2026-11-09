// The pure parts of admin writes to workspaces: what is computed from its arguments alone, with no
// storage read and no call made.

import {
  MAX_ADMIN_AUDIT_ARG_LENGTH,
  type AdminWriteAction, type AdminWriteArgs, type AdminWriteRequest, type CollaboratorGrant,
} from "@gadgets/workshop-shared/api";
import { adminAuditValue, cutAdminAuditText, redactAdminAuditArgs } from "./admin-access.js";

/** A write request as AdminSettings stores it: the API's, without the URL (derived from the
 * environment when read), with what only the server needs to record its later steps. */
export type StoredAdminWrite = Omit<AdminWriteRequest, "approvalUrl"> & {
  /** The requester's audit session, for the "expired" record. */
  sessionId: string;
};

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
  retryAgent: { required: ["chatId"], optional: ["modelId"] },
  restartWorkspace: { required: [] },
  addCollaborator: { required: ["username", "grant"], optional: ["note"] },
  deleteChat: { required: ["chatId"] },
  revertChat: { required: ["chatId", "revertFrom"] },
  revertGadget: { required: ["gadgetId", "commitId"] },
  deleteGadget: { required: ["gadgetId"] },
  deleteWorkspace: { required: [] },
  rejectPendingActions: { required: [], optional: ["gatekeeperId"] },
  removeConnection: { required: ["gatekeeperId"] },
};

// What an argument's value must be beyond its type, which the RPC validator has checked: `keep`
// returns the value to keep, or undefined for one that is refused.
type WriteArgRule<T> = { must: string; keep: (value: T) => T | undefined };

const ID: WriteArgRule<number> = {
  must: "be a non-negative whole number",
  keep: value => Number.isSafeInteger(value) && value >= 0 ? value : undefined,
};
const TEXT: WriteArgRule<string> = {
  must: `be non-blank and at most ${MAX_ADMIN_AUDIT_ARG_LENGTH} characters`,
  keep: value => value.trim() && value.length <= MAX_ADMIN_AUDIT_ARG_LENGTH ? value : undefined,
};
const COMMIT: WriteArgRule<string> = {
  must: "be 40 lowercase hex characters",
  keep: value => /^[0-9a-f]{40}$/.test(value) ? value : undefined,
};
// Rebuilt as `{ gadgetId }` alone, so that nothing else the client put in it is kept.
const GRANT: WriteArgRule<CollaboratorGrant> = {
  must: 'be "workspace" or { gadgetId }, a non-negative whole number',
  keep: value => value === "workspace" ? value
      : ID.keep(value.gadgetId) === undefined ? undefined : { gadgetId: value.gadgetId },
};

// Every argument has a rule: one without does not compile.
type WriteArgValues = Required<AdminWriteArgs>;
const WRITE_ARG_RULES: { [Name in keyof WriteArgValues]: WriteArgRule<WriteArgValues[Name]> } = {
  chatId: ID, modelId: TEXT, revertFrom: ID, gadgetId: ID, commitId: COMMIT, gatekeeperId: ID,
  username: TEXT, grant: GRANT, note: TEXT,
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
 * missing required one, one the action does not take, a chat, gadget or connection id that is not
 * a non-negative safe integer, a commit id that is not 40 lowercase hex characters, or a username,
 * model id or note that is blank or over MAX_ADMIN_AUDIT_ARG_LENGTH characters. */
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

/** `args` as an AdminWriteRecord keeps them (see AdminWriteRecord.args). */
export function adminWriteAuditArgs(args: AdminWriteArgs): Record<string, string | number> {
  let { grant, ...rest } = args;
  return redactAdminAuditArgs({
    ...rest,
    grant: grant === undefined || grant === "workspace" ? grant : `gadget:${grant.gadgetId}`,
  });
}

/** What an entry of the workspace's action log calls the write, e.g. "Stop the agent in chat
 * 3": the write named, not reported done, since the entry is written before it runs. Built from
 * the action and its numeric ids alone (a version by the first seven characters of its commit
 * id), never from text the requester wrote: the reason and, for "addCollaborator", the account
 * named are fields of the entry, shown as literal text. */
export function adminWriteTitle(action: AdminWriteAction, args: AdminWriteArgs): string {
  // No default, so that an action without a title does not compile.
  switch (action) {
    case "stopAgent": return `Stop the agent in chat ${args.chatId}`;
    case "retryAgent": return `Retry the agent in chat ${args.chatId}`;
    case "restartWorkspace": return "Restart the workspace";
    case "addCollaborator": return "Add a collaborator";
    case "deleteChat": return `Delete chat ${args.chatId}`;
    case "revertChat": return `Revert chat ${args.chatId} from message ${args.revertFrom}`;
    case "revertGadget":
      return `Restore gadget ${args.gadgetId} to version ${args.commitId?.slice(0, 7)}`;
    case "deleteGadget": return `Delete gadget ${args.gadgetId}`;
    case "deleteWorkspace": return "Delete the workspace";
    case "rejectPendingActions":
      return args.gatekeeperId === undefined ? "Reject the pending actions"
          : `Reject the pending actions of connection ${args.gatekeeperId}`;
    case "removeConnection": return `Remove connection ${args.gatekeeperId}`;
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
