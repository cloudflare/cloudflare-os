// The pure parts of admin writes to workspaces: what is computed from its arguments alone, with no
// storage read and no call made.

import {
  ADMIN_WRITE_ARGS, MAX_ADMIN_AUDIT_ARG_LENGTH,
  type AdminWriteAction, type AdminWriteArgs, type AdminWriteRecord, type AdminWriteRequest,
} from "@gadgets/workshop-shared/api";
import {
  adminAuditValue, cutAdminAuditText, type AdminWriteActor,
} from "./admin-access.js";
import { sameDeploymentAdmin } from "./auth/config.js";

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
  /** The refused attempts to approve it whose "refused" record could not be written, oldest
   * first: each is kept until the audit log takes it. */
  refusals?: AdminWriteRefusal[];
  /** For a request filed through the admin gatekeeper for content access: who was in the
   * workspace it was filed from, by profile id (see AdminCaller.insiders). None of them may
   * approve it (see isRequestInsider()). Kept with the request and handed to the workspace with
   * its grant; never returned by the API, recorded, or covered by the digest: it is not
   * something the approver reads. */
  insiders?: string[];
};

/** Who approved a write request, and with which passkey: its credential id as
 * AdminWriteRecord.passkey keeps it (auditOwnerId() of the id). */
export type AdminWriteApprover = AdminWriteActor & { passkey: string };

/** A refused attempt to approve a write request, as its "refused" record keeps it: who tried, the
 * check the attempt failed and, when the answer named one of that admin's own, the passkey. */
export type AdminWriteRefusal =
    AdminWriteActor & Required<Pick<AdminWriteRecord, "refusal">> & Pick<AdminWriteRecord, "passkey">;

/** What OverseerDurableObject.applyAdminWrite() is given: an approved request, and who approved
 * it, through which session and with which passkey, for the "approved" record the workspace
 * writes. `workspaceOwner` is the owner the approval page showed: the workspace refuses
 * (`workspaceChanged`) a grant naming another owner than its own, since a deleted workspace's id
 * can be initialised again for someone else. */
export type AdminWriteGrant =
    Pick<StoredAdminWrite,
        "action" | "args" | "reason" | "requestedBy" | "insiders" | "expiresAt" |
        "workspaceOwner"> &
    AdminWriteApprover & { requestId: string };

/** A fresh challenge: 32 random bytes, then `binding` (the digest of what the ceremony confirms:
 * an approval's request, a removal's credential id), as unpadded base64url. */
export function newPasskeyChallenge(binding?: Uint8Array): string {
  let challenge = new Uint8Array(32 + (binding?.length ?? 0));
  crypto.getRandomValues(challenge.subarray(0, 32));
  if (binding) challenge.set(binding, 32);
  return challenge.toBase64({ alphabet: "base64url", omitPadding: true });
}

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
  if (!Object.hasOwn(ADMIN_WRITE_ARGS, action)) throw new TypeError("No such write action.");
  let { required, optional = [] } = ADMIN_WRITE_ARGS[action];
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
    // A case only because the switch has no default: no entry of the action log is written with
    // it (see entersActionLog()).
    case "grantContentAccess": return "Read the workspace's content";
  }
}

/** Whether a request for `action` must be approved by an admin other than the one who made it.
 * True for "grantContentAccess" alone: it lets admins read a workspace's content without its
 * owner, so one admin's word is not enough. The other actions change a workspace in ways its
 * members see, and their requester may approve them. */
export function needsSecondAdmin(action: AdminWriteAction): boolean {
  return action === "grantContentAccess";
}

/** Whether admin `approver` may not approve `request` because they had a part in asking for it:
 * they are its requester or, for a request filed through the admin gatekeeper, one of the
 * people who were in the workspace it was filed from. Each compared with sameDeploymentAdmin(). */
export function isRequestInsider(
    request: Pick<StoredAdminWrite, "requestedBy" | "insiders">, approver: string): boolean {
  return [request.requestedBy, ...request.insiders ?? []].some(
      insider => sameDeploymentAdmin(insider, approver));
}

/** Whether an approved `action` is entered in the workspace's action log, where its members read
 * it. False for "grantContentAccess" alone: the workspace's owner is not told that admins read
 * its content, so the write is recorded in the admin audit log and nowhere a member can see. */
export function entersActionLog(action: AdminWriteAction): boolean {
  return action !== "grantContentAccess";
}

/** The SHA-256 an approval signs: of the canonical JSON (adminAuditValue()) of everything about
 * the request that its approval page shows and that never changes: its id, workspace (id, title
 * and owner as stored), action, arguments, reason, requester, `via`, where an agent's request came
 * from (`agent`), and the times it was made and expires. */
export async function adminWriteDigest(request: Pick<StoredAdminWrite,
    "id" | "workspaceId" | "workspaceTitle" | "workspaceOwner" | "action" | "args" | "reason" |
    "requestedBy" | "via" | "agent" | "requestedAt" | "expiresAt">): Promise<Uint8Array> {
  let { id, workspaceId, workspaceTitle, workspaceOwner, action, args, reason, requestedBy, via,
        agent } = request;
  // Sorted keys at every level, so the digest does not depend on how the request was built or
  // stored. An undefined value adds no key, so a request with no `agent` digests without one.
  let canonical = adminAuditValue({
    id, workspaceId, workspaceTitle, workspaceOwner, action, args, reason, requestedBy, via, agent,
    requestedAt: request.requestedAt.getTime(), expiresAt: request.expiresAt.getTime(),
  });
  return new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)));
}
