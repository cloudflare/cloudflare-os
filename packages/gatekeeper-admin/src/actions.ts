// The admin gatekeeper's actions: what an agent would post to an issue report, set on one or ask
// of the admins. Each is queued when called and runs only once it is approved, as the one Admin
// API call the Workshop lends that action.

import type { RpcStub } from "cloudflare:workers";
import {
  buildDescription, plainInline, sanitizeTitle,
} from "@gadgets/gatekeeper-kit/action-description";
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
  type AdminWriteArgs, ISSUE_REPORT_ERROR_CODES, type IssueReportStatus, MAX_ADMIN_ACCESS_REASON_LENGTH,
  MAX_ISSUE_REPORT_TEXT_LENGTH, getAdminAccessErrorCode, getAdminGrantErrorCode, getIssueReportErrorCode,
  issueReportStatusForReporter,
} from "@gadgets/workshop-shared/api";

/** An entry to add to a report's thread: a reply through the admin binding, or a note. */
export type EntryPayload = { reportId: string; text: string };

/** A reply from a session limited to one report, with what its card says of that report. */
export type ScopedReplyPayload = EntryPayload & {
  /** Shown on the card and never sent: the reporter's name, when the report was filed (ISO),
   * and how its text begins. */
  report: { reporter: string; filedAt: string; firstLine: string };
};

/** A status to set on a report. */
export type StatusPayload = { reportId: string; status: IssueReportStatus };

/** A report to claim for the workspace's owner, or to release. */
export type AssignmentPayload = { reportId: string; assignment: "claim" | "release" };

/** What an agent is told when it asks to take a report over. */
export const TAKE_OVER_BY_PERSON = "Only a person takes an issue report from the admin who " +
  "holds it: an admin does, in the Workshop, the CLI or the API. Call claimIssueReport() " +
  "without takeOverFrom, which is refused when another admin holds the report.";

/** A write to make, as writeWorkspace() takes it. */
export type WritePayload = {
  workspaceId: string; action: AdminWriteAction; args: AdminWriteArgs; reason: string;
};

/** A request for content access to file, as requestContentAccess() takes it. */
export type ContentRequestPayload = { workspaceId: string; reason: string };

/** The payload of each action kind, by its name in ADMIN_AGENT_ACTIONS. */
export type AdminActions = {
  issueReportReply: EntryPayload;
  issueReportScopedReply: ScopedReplyPayload;
  issueReportNote: EntryPayload;
  issueReportStatus: StatusPayload;
  issueReportAssignment: AssignmentPayload;
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
 * `text` as an entry of a report's thread holds it: trimmed. Throws for a text the Admin API
 * would refuse, so that no card is built for a call that cannot be made.
 */
export function entryText(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "" || trimmed.length > MAX_ISSUE_REPORT_TEXT_LENGTH) {
    throw new TypeError(
        `The text must be non-blank and at most ${MAX_ISSUE_REPORT_TEXT_LENGTH} characters.`);
  }
  return trimmed;
}

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
 * holder who released the report). The Workshop keeps it pending until a person rejects it.
 * For an entry, a status or an assignment, the report does not exist, its thread is full, it is
 * closed or another admin holds it; for a write, writes are off or the workspace's id names no
 * workspace; for a content request, content access is off, the workspace's id is malformed or
 * the directory does not list it, a request for it is already pending, or too many are.
 */
export const TERMINAL_REFUSALS: ReadonlySet<string> = new Set([
  ISSUE_REPORT_ERROR_CODES.notFound,
  ISSUE_REPORT_ERROR_CODES.threadFull,
  ISSUE_REPORT_ERROR_CODES.closed,
  ISSUE_REPORT_ERROR_CODES.assigned,
  ADMIN_ACCESS_ERROR_CODES.writesOff,
  ADMIN_ACCESS_ERROR_CODES.workspaceNotFound,
  ADMIN_ACCESS_ERROR_CODES.contentOff,
  ADMIN_GRANT_ERROR_CODES.workspaceUnlisted,
  ADMIN_GRANT_ERROR_CODES.requestPending,
  ADMIN_GRANT_ERROR_CODES.tooManyRequests,
]);

const NOT_LENT = "This action was given no Admin API to apply with.";

const OUTCOME_UNKNOWN = "The Admin API did not say whether this was done. Check the report's " +
  "thread (or the audit log, for a write or a request) before rejecting this action.";

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
  const code = getIssueReportErrorCode(error) ?? getAdminGrantErrorCode(error) ??
      getAdminAccessErrorCode(error);
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

/** What a reporter reads for a status, where the Workshop's page for reporters words it otherwise
 * than STATUS_LABELS: "withAdmin" is what "fixSuggested" and "fixInProgress" are given to them as. */
const REPORTER_READS: Partial<Record<IssueReportStatus, string>> = { withAdmin: "With the admins" };

/** `iso`, an ISO timestamp, as a card shows it: the same text wherever it is read. */
function utc(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

const STATUS_LABELS: Record<IssueReportStatus, string> = {
  new: "New",
  investigating: "Investigating",
  answered: "Answered",
  waitingOnReporter: "Waiting on the reporter",
  withAdmin: "With an admin",
  fixSuggested: "Fix suggested",
  fixInProgress: "Fix in progress",
  fixProposed: "Fix proposed",
  closed: "Closed",
};

/** A card: its title on one line, the builder's text and fields, and nothing to revert. */
function card(title: string, rendered: ReturnType<typeof buildDescription>): ActionPresentation {
  return { title: sanitizeTitle(title), ...rendered.finish(), implementsRevert: false };
}


/**
 * The seven action kinds, one per entry of ADMIN_AGENT_ACTIONS, which gives each its tag and its
 * verdict: the Workshop enforces the same table, so the two cannot differ. Unfenced: the
 * authority is lent per apply and checked by the Workshop, so there is no connection to pin.
 *
 * Every kind awaits its decision: an entry, a status, an assignment, a write or a request is in
 * no read until it is applied. Every kind claims before it applies, so that none runs twice: a
 * second run would be a second entry, a second write or a second request, a status set again
 * after someone changed it would undo their change, with a second status line and a second end
 * of an investigation, and a report claimed again after its holder released it would be held
 * once more.
 */
export const ADMIN_ACTIONS = defineActions<AdminActionHost, AdminActions>({
  issueReportReply: {
    kind: ADMIN_AGENT_ACTIONS.issueReportReply.kind,
    // Never auto-approved (write-gatekeeper rule 2): it sends text to the reporter, a person
    // outside this binding, written by code that can read what only admins see.
    autoApprovable: ADMIN_AGENT_ACTIONS.issueReportReply.autoApprovable,
    delivery: "await-decision",
    claimBeforeApply: true,
    describe: ({ reportId, text }) => card(
        `Reply to the reporter of issue report ${reportId}`,
        buildDescription("Posts this reply in the report's public thread, where its reporter " +
            "reads it. It was written with access to what only admins see: read it before " +
            "approving.")
            .inline("Report", reportId)
            .verbatim("Reply", text)),
    apply: ({ reportId, text }, host, ctx) =>
      callLent(host, ctx, (admin) => admin.addIssueReportEntry(reportId, text, "public")),
  },

  issueReportScopedReply: {
    kind: ADMIN_AGENT_ACTIONS.issueReportScopedReply.kind,
    autoApprovable: ADMIN_AGENT_ACTIONS.issueReportScopedReply.autoApprovable,
    delivery: "await-decision",
    claimBeforeApply: true,
    describe: ({ reportId, text, report }) => card(
        `Reply to ${report.reporter} on issue report ${reportId}`,
        buildDescription("Posts this reply in the public thread of the report " +
            `${plainInline(report.reporter)} filed on ${utc(report.filedAt)}. Sent from a ` +
            "session limited to this report.")
            .inline("Report", reportId)
            .inline("Reporter", report.reporter)
            .inline("Filed", utc(report.filedAt))
            .verbatim("Report begins", report.firstLine)
            .verbatim("Reply", text)),
    apply: ({ reportId, text }, host, ctx) =>
      callLent(host, ctx, (admin) => admin.addIssueReportEntry(reportId, text, "public")),
  },

  issueReportNote: {
    kind: ADMIN_AGENT_ACTIONS.issueReportNote.kind,
    autoApprovable: ADMIN_AGENT_ACTIONS.issueReportNote.autoApprovable,
    delivery: "await-decision",
    claimBeforeApply: true,
    describe: ({ reportId, text }) => card(
        `Add an admins-only note to issue report ${reportId}`,
        buildDescription("Adds this note to the report's thread. Only admins read it.")
            .inline("Report", reportId)
            .verbatim("Note", text)),
    apply: ({ reportId, text }, host, ctx) =>
      callLent(host, ctx, (admin) => admin.addIssueReportEntry(reportId, text, "admins")),
  },

  // The card names no earlier status: the action is lent no read, so it could not check one, and
  // setting a status over a newer one is what the approver agreed to.
  issueReportStatus: {
    kind: ADMIN_AGENT_ACTIONS.issueReportStatus.kind,
    autoApprovable: ADMIN_AGENT_ACTIONS.issueReportStatus.autoApprovable,
    delivery: "await-decision",
    claimBeforeApply: true,
    describe: ({ reportId, status }) => {
      const rendered = buildDescription("Changes the report's status. Its reporter sees the " +
          "change in the thread, unless they read the old status and the new one as the same.")
          .inline("Report", reportId)
          .inline("Status", STATUS_LABELS[status]);
      const reporterReads = issueReportStatusForReporter(status);
      if (reporterReads !== status) rendered.inline("Reporter reads",
          REPORTER_READS[reporterReads] ?? STATUS_LABELS[reporterReads]);
      return card(`Set issue report ${reportId} to ${STATUS_LABELS[status]}`, rendered);
    },
    apply: ({ reportId, status }, host, ctx) =>
      callLent(host, ctx, (admin) => admin.setIssueReportStatus(reportId, status)),
  },

  // The card names the owner in words, never by a read: queuing reads nothing. Which admin
  // that is, the Workshop decides where the call lands.
  issueReportAssignment: {
    kind: ADMIN_AGENT_ACTIONS.issueReportAssignment.kind,
    autoApprovable: ADMIN_AGENT_ACTIONS.issueReportAssignment.autoApprovable,
    delivery: "await-decision",
    claimBeforeApply: true,
    describe: ({ reportId, assignment }) => assignment === "claim"
      ? card(
          `Assign issue report ${reportId} to this workspace's owner`,
          buildDescription("Makes this workspace's owner, the admin this connection acts " +
              "as, the report's assignee, whoever approves this. Every admin sees who holds " +
              "a report. Nothing changes if the owner already holds it, and it is refused " +
              "if another admin does: it never takes a report from anyone.")
              .inline("Report", reportId)
              .inline("Assignee", "This workspace's owner"))
      : card(
          `Release issue report ${reportId} from this workspace's owner`,
          buildDescription("Leaves the report with no assignee, if this workspace's owner, " +
              "the admin this connection acts as, holds it. Nothing changes if nobody " +
              "holds it, and it is refused if another admin does.")
              .inline("Report", reportId)
              .inline("Released by", "This workspace's owner")),
    apply: ({ reportId, assignment }, host, ctx) => callLent(host, ctx, (admin) =>
        assignment === "claim"
            ? admin.claimIssueReport(reportId) : admin.releaseIssueReport(reportId)),
  },

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
