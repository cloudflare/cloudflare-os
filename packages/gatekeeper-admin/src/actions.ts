// The admin gatekeeper's actions: what an agent would ask of the admins, a write to a workspace or
// access to its content. Each is queued when called and runs only once it is approved, as one
// call on the Admin API opened from the account's grant.

import { buildDescription, sanitizeTitle } from "@gadgets/gatekeeper-kit/action-description";
import {
  ActionApplyError, ActionOutcomeUnknownError, type ActionPresentation, type BoundActionSet,
  defineActions,
} from "@gadgets/gatekeeper-kit/actions";
import {
  ADMIN_ACCESS_ERROR_CODES, ADMIN_GRANT_ERROR_CODES, type AdminApi, type AdminWriteAction,
  type AdminWriteArgs, MAX_ADMIN_ACCESS_REASON_LENGTH, getAdminAccessErrorCode,
  getAdminGrantErrorCode,
} from "@gadgets/workshop-shared/api";

/** A write to make, as writeWorkspace() takes it. */
export type WritePayload = {
  workspaceId: string; action: AdminWriteAction; args: AdminWriteArgs; reason: string;
};

/** A request for content access to file, as requestContentAccess() takes it. */
export type ContentRequestPayload = { workspaceId: string; reason: string };

/** The payload of each action kind. */
export type AdminActions = {
  workspaceWriteRequest: WritePayload;
  contentAccessRequest: ContentRequestPayload;
};

/** The Admin API as an approved action uses it: the one method its kind calls. */
export type ActionAdminApi = Pick<AdminApi, "writeWorkspace" | "requestContentAccess"> & Disposable;

/** What the actions need of the facet they are bound to. */
export interface AdminActionHost {
  /**
   * Opens the Admin API from the account's grant, as a session does. Refused when the account's
   * user is no longer a deployment admin, or the account was removed.
   */
  openAdminApi(): Promise<ActionAdminApi>;
}

/** The actions bound to one facet's journal. */
export type BoundAdminActions = BoundActionSet<AdminActions>;

/**
 * `reason` as a write or a content request holds it: trimmed. Throws for a reason the Admin API
 * would refuse, which it does with no code: approved, such an action would end as an outcome
 * nobody knows, although nothing was done.
 */
export function requestReason(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed === "" || trimmed.length > MAX_ADMIN_ACCESS_REASON_LENGTH) {
    throw new TypeError(
        `A reason is required, and must be at most ${MAX_ADMIN_ACCESS_REASON_LENGTH} characters.`);
  }
  return trimmed;
}

/**
 * The arguments each write action takes, all of them required, as AdminWriteArgs' doc lists
 * them. An action added to AdminWriteAction does not compile until it is listed here.
 */
const WRITE_ARGS: Record<AdminWriteAction, readonly (keyof AdminWriteArgs)[]> = {
  stopAgent: ["chatId"],
  restartWorkspace: [],
};

/**
 * `args` as a write of `action` holds them: the arguments the action takes and nothing else.
 * Throws for arguments the Admin API would refuse, which it does with no code, as it refuses a
 * reason: one missing, one the action does not take, or an id that is not a non-negative whole
 * number. The Admin API checks them again when the write is made.
 */
export function requestArgs(action: AdminWriteAction, args: AdminWriteArgs): AdminWriteArgs {
  const taken: readonly string[] = WRITE_ARGS[action];
  // The schema's check has refused a property the type does not declare.
  for (const [name, value] of Object.entries(args)) {
    if (value !== undefined && !taken.includes(name)) {
      throw new TypeError(`"${action}" takes no \`${name}\`.`);
    }
  }
  const kept: AdminWriteArgs = {};
  for (const name of WRITE_ARGS[action]) {
    const value = args[name];
    if (value === undefined) throw new TypeError(`"${action}" needs \`${name}\`.`);
    // Every argument is an id.
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`\`${name}\` must be a non-negative whole number.`);
    }
    kept[name] = value;
  }
  return kept;
}

/**
 * The coded refusals after which an action can never apply: the Admin API makes each before it
 * writes anything, and the action is not run again, even once what refused it has passed (a
 * pending request that was decided). The Workshop keeps it pending until a person rejects it.
 * For a write, writes are off or the workspace's id names no workspace; for a content request,
 * content access is off, the workspace's id is malformed or the directory does not list it, a
 * request for it is already pending, or too many are.
 */
export const TERMINAL_REFUSALS: ReadonlySet<string> = new Set([
  ADMIN_ACCESS_ERROR_CODES.writesOff,
  ADMIN_ACCESS_ERROR_CODES.workspaceNotFound,
  ADMIN_ACCESS_ERROR_CODES.contentOff,
  ADMIN_GRANT_ERROR_CODES.workspaceUnlisted,
  ADMIN_GRANT_ERROR_CODES.requestPending,
  ADMIN_GRANT_ERROR_CODES.tooManyRequests,
]);

const OUTCOME_UNKNOWN = "The Admin API did not say whether this was done. Check the audit log " +
  "before rejecting this action.";

/**
 * What a handler throws for `error`, the rejection of its one call on the Admin API:
 *   - a coded refusal in TERMINAL_REFUSALS: an ActionApplyError with the refusal's message.
 *     Nothing was done and nothing will be.
 *   - the coded refusal of a user who is no longer a deployment admin: `error` itself. Nothing
 *     was done, and the action is pending again, to be approved once they are an admin.
 *   - anything else (a broken or timed-out call, an error with no code, a code this list does
 *     not know): the call may have been carried out, so an ActionOutcomeUnknownError, which is
 *     never run again.
 */
export function classifyApplyFailure(error: unknown): unknown {
  const code = getAdminGrantErrorCode(error) ?? getAdminAccessErrorCode(error);
  if (code !== undefined && TERMINAL_REFUSALS.has(code)) {
    return new ActionApplyError(error instanceof Error ? error.message : code, { cause: error });
  }
  if (code === ADMIN_ACCESS_ERROR_CODES.notAdmin) return error;
  return new ActionOutcomeUnknownError(OUTCOME_UNKNOWN, { cause: error });
}

/**
 * Makes an action's one call on the Admin API, opened for it now. An Admin API that does not
 * open (its admin was demoted, the account was removed) is refused before any call, so the
 * action stays pending.
 */
async function callAdminApi(
  host: AdminActionHost, call: (admin: ActionAdminApi) => Promise<unknown>,
): Promise<void> {
  using admin = await host.openAdminApi();
  try {
    await call(admin);
  } catch (error) {
    throw classifyApplyFailure(error);
  }
}

/** A card: its title on one line, the builder's text and fields, and nothing to revert. */
function card(title: string, rendered: ReturnType<typeof buildDescription>): ActionPresentation {
  return { title: sanitizeTitle(title), ...rendered.finish(), implementsRevert: false };
}

/**
 * The two action kinds. Unfenced: the authority is the account's grant, asked at each apply, so
 * there is no connection generation to pin.
 *
 * Both kinds await their decision: a write or a request is in no read until it is applied. Both
 * claim before they apply, so that neither runs twice: a second run would be a second write or a
 * second request. Auto-approval rules are stored under a kind's tag, so a tag is never renamed
 * or reused.
 */
export const ADMIN_ACTIONS = defineActions<AdminActionHost, AdminActions>({
  workspaceWriteRequest: {
    kind: { tag: "workspace-write-request", label: "Write to a workspace as a deployment admin" },
    // Never auto-approved (write-gatekeeper rule 4: one kind covers every write an admin can
    // make): once approved it runs at once, as a deployment admin, in another workspace. The
    // person who approves this card is the one check between an agent and that workspace.
    autoApprovable: false,
    delivery: "await-decision",
    claimBeforeApply: true,
    describe: ({ workspaceId, action, args, reason }) => card(
        `Write to workspace ${workspaceId}: ${action}`,
        buildDescription("Runs the write as the deployment admin who connected this account, " +
            "as soon as this is approved. Its reason goes to the deployment's admin audit log, " +
            "not to that workspace, whose members see only what the write does.")
            .inline("Workspace", workspaceId)
            .inline("Action", action)
            .json("Arguments", args)
            .verbatim("Reason", reason)),
    apply: ({ workspaceId, action, args, reason }, host) =>
      callAdminApi(host, (admin) => admin.writeWorkspace(workspaceId, action, args, reason)),
  },

  contentAccessRequest: {
    kind: {
      tag: "content-access-request",
      label: "Ask the admins for access to a workspace's content",
    },
    // Never auto-approved (write-gatekeeper rule 7): it asks for access to a workspace's
    // content.
    autoApprovable: false,
    delivery: "await-decision",
    claimBeforeApply: true,
    describe: ({ workspaceId, reason }) => card(
        `Ask the admins for access to the content of workspace ${workspaceId}`,
        buildDescription("Files a request, as the deployment admin who connected this account, " +
            "that another deployment admin approves from the admin panel's pending approvals: " +
            "once approved, admins can read that workspace's chats and files for a time. The " +
            "admin the request is filed as cannot approve it.")
            .inline("Workspace", workspaceId)
            .verbatim("Reason", reason)),
    apply: ({ workspaceId, reason }, host) =>
      callAdminApi(host, (admin) => admin.requestContentAccess(workspaceId, reason)),
  },
}, { fence: "none", vendorId: "admin" });
