// The admin gatekeeper's actions: what an agent would ask of the admins, a write to a workspace or
// access to its content. Each is queued when called and runs only once it is approved, as the one
// Admin API call the Workshop lends that action.

import type { RpcStub } from "cloudflare:workers";
import { buildDescription, sanitizeTitle } from "@gadgets/gatekeeper-kit/action-description";
import {
  type ActionContext, ActionApplyError, ActionOutcomeUnknownError, type ActionPresentation,
  type BoundActionSet, defineActions,
} from "@gadgets/gatekeeper-kit/actions";
import {
  ADMIN_AGENT_ACTIONS, ADMIN_GATEKEEPER_VENDOR_ID,
} from "@gadgets/workshop-shared/admin-agent";
import type { AdminAgentApi } from "@gadgets/workshop-shared/admin-gatekeeper";
import {
  ADMIN_ACCESS_ERROR_CODES, ADMIN_GRANT_ERROR_CODES, ADMIN_WRITE_ARGS, type AdminWriteAction,
  type AdminWriteArgs, MAX_ADMIN_ACCESS_REASON_LENGTH, getAdminAccessErrorCode,
  getAdminGrantErrorCode,
} from "@gadgets/workshop-shared/api";

/** A write to make, as writeWorkspace() takes it. */
export type WritePayload = {
  workspaceId: string; action: AdminWriteAction; args: AdminWriteArgs; reason: string;
};

/** A request for content access to file, as requestContentAccess() takes it. */
export type ContentRequestPayload = { workspaceId: string; reason: string };

/** The payload of each action kind, by its name in ADMIN_AGENT_ACTIONS. */
export type AdminActions = {
  workspaceWriteRequest: WritePayload;
  contentAccessRequest: ContentRequestPayload;
};

/** What the actions need of the facet they are bound to. */
export interface AdminActionHost {
  /** The Admin API the Workshop lent for `action` while it is applied, or undefined. */
  lentFor(action: number): RpcStub<AdminAgentApi> | undefined;
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
 * `args` as a write of `action` holds them: the arguments the action takes
 * (ADMIN_WRITE_ARGS) and nothing else. Throws for arguments the Admin API would refuse, which it
 * does with no code, as it refuses a reason: a required one missing, one the action does not
 * take, or an id that is not a non-negative whole number.
 */
export function requestArgs(action: AdminWriteAction, args: AdminWriteArgs): AdminWriteArgs {
  const { required, optional = [] } = ADMIN_WRITE_ARGS[action];
  const taken: readonly string[] = [...required, ...optional];
  const kept: AdminWriteArgs = {};
  // The schema's check has refused a property the type does not declare.
  for (const [name, value] of Object.entries(args)) {
    if (value === undefined) continue;
    if (!taken.includes(name)) throw new TypeError(`"${action}" takes no \`${name}\`.`);
    // Every argument is an id.
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`\`${name}\` must be a non-negative whole number.`);
    }
    kept[name as keyof AdminWriteArgs] = value;
  }
  for (const name of required) {
    if (kept[name] === undefined) throw new TypeError(`"${action}" needs \`${name}\`.`);
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

const NOT_LENT = "This action was given no Admin API to apply with.";

const OUTCOME_UNKNOWN = "The Admin API did not say whether this was done. Check the audit log " +
  "before rejecting this action.";

/**
 * What a handler throws for `error`, the rejection of its one call on the lent Admin API:
 *   - a coded refusal in TERMINAL_REFUSALS: an ActionApplyError with the refusal's message.
 *     Nothing was done and nothing will be.
 *   - the coded refusal of an owner who is no longer a deployment admin, or of a gatekeeper the
 *     deployment has turned off: `error` itself. Nothing was done, and the action is pending
 *     again, to be approved once the owner is an admin or the gatekeeper is on.
 *   - anything else (a broken or timed-out call, an error with no code, a code this list does
 *     not know): the call may have been carried out, so an ActionOutcomeUnknownError, which is
 *     never run again.
 */
export function classifyApplyFailure(error: unknown): unknown {
  const code = getAdminGrantErrorCode(error) ?? getAdminAccessErrorCode(error);
  if (code !== undefined && TERMINAL_REFUSALS.has(code)) {
    return new ActionApplyError(error instanceof Error ? error.message : code, { cause: error });
  }
  if (code === ADMIN_ACCESS_ERROR_CODES.notAdmin ||
      code === ADMIN_ACCESS_ERROR_CODES.gatekeeperOff) {
    return error;
  }
  return new ActionOutcomeUnknownError(OUTCOME_UNKNOWN, { cause: error });
}

/**
 * Makes an action's one call on the Admin API lent for it. With none lent it throws before any
 * call, so the action stays pending.
 */
async function callLent(
  host: AdminActionHost, ctx: ActionContext,
  call: (admin: RpcStub<AdminAgentApi>) => Promise<unknown>,
): Promise<void> {
  const admin = host.lentFor(ctx.id);
  if (!admin) throw new Error(NOT_LENT);
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
 * The two action kinds, one per entry of ADMIN_AGENT_ACTIONS, which gives each its tag and its
 * verdict: the Workshop enforces the same table, so the two cannot differ. Unfenced: the
 * authority is lent per apply and checked by the Workshop, so there is no connection to pin.
 *
 * Both kinds await their decision: a write or a request is in no read until it is applied. Both
 * claim before they apply, so that neither runs twice: a second run would be a second write or a
 * second request.
 */
export const ADMIN_ACTIONS = defineActions<AdminActionHost, AdminActions>({
  workspaceWriteRequest: {
    kind: ADMIN_AGENT_ACTIONS.workspaceWriteRequest.kind,
    // Never auto-approved: once approved it runs at once, as the owner, a deployment admin, in
    // another workspace, and no other check stands between the agent and that workspace.
    autoApprovable: ADMIN_AGENT_ACTIONS.workspaceWriteRequest.autoApprovable,
    delivery: "await-decision",
    claimBeforeApply: true,
    describe: ({ workspaceId, action, args, reason }) => card(
        `Write to workspace ${workspaceId}: ${action}`,
        buildDescription("Runs the write as the owner, a deployment admin, as soon as this is " +
            "approved. Its reason goes to the deployment's admin audit log, not to that " +
            "workspace, whose members see only what the write does.")
            .inline("Workspace", workspaceId)
            .inline("Action", action)
            .json("Arguments", args)
            .verbatim("Reason", reason)),
    apply: ({ workspaceId, action, args, reason }, host, ctx) =>
      callLent(host, ctx, (admin) => admin.writeWorkspace(workspaceId, action, args, reason)),
  },

  contentAccessRequest: {
    kind: ADMIN_AGENT_ACTIONS.contentAccessRequest.kind,
    // Never auto-approved (write-gatekeeper rule 7): it asks for access to a workspace's
    // content, and whoever approves this card may not approve that request, which only a
    // person present can be.
    autoApprovable: ADMIN_AGENT_ACTIONS.contentAccessRequest.autoApprovable,
    delivery: "await-decision",
    claimBeforeApply: true,
    describe: ({ workspaceId, reason }) => card(
        `Ask the admins for access to the content of workspace ${workspaceId}`,
        buildDescription("Files a request that another deployment admin approves from the " +
            "admin panel's pending approvals: once approved, admins can read that workspace's " +
            "chats and files for a time. Nobody who is in this workspace now, you included once " +
            "you approve this, can approve that request.")
            .inline("Workspace", workspaceId)
            .verbatim("Reason", reason)),
    apply: ({ workspaceId, reason }, host, ctx) =>
      callLent(host, ctx, (admin) => admin.requestContentAccess(workspaceId, reason)),
  },
}, { fence: "none", vendorId: ADMIN_GATEKEEPER_VENDOR_ID });
