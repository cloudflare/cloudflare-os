import {
  issueReportStatusForReporter,
  type IssueReportAssignment,
  type IssueReportEntry,
  type IssueReportPriority,
  type IssueReportStatus,
} from '@gadgets/workshop-shared/api'

/** What each priority of an issue report is called. */
export const ISSUE_PRIORITY_NAMES: Record<IssueReportPriority, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
}

/**
 * What each status of an issue report is called, as its reporter reads it. The server never
 * sends a reporter "fixSuggested" or "fixInProgress": both read as "withAdmin", and are named
 * as it is.
 */
export const ISSUE_STATUS_NAMES: Record<IssueReportStatus, string> = {
  new: 'New',
  investigating: 'Investigating',
  answered: 'Answered',
  waitingOnReporter: 'Waiting on you',
  withAdmin: 'With the admins',
  fixSuggested: 'With the admins',
  fixInProgress: 'With the admins',
  fixProposed: 'Fix in review',
  closed: 'Closed',
}

/** What each status of an issue report is called, as the admins read it. */
export const ADMIN_ISSUE_STATUS_NAMES: Record<IssueReportStatus, string> = {
  ...ISSUE_STATUS_NAMES,
  waitingOnReporter: 'Waiting on the reporter',
  fixSuggested: 'Fix suggested',
  fixInProgress: 'Fix in progress',
  fixProposed: 'Fix proposed',
}

/**
 * What the reporter reads where the admins read `status`, when the two differ, as the admins'
 * status control says it beside the status: another status ("fixSuggested" and
 * "fixInProgress" read as "With the admins"), or another name for the same one ("fixProposed"
 * reads as "Fix in review", "waitingOnReporter" as "Waiting on you"). Undefined where both
 * read the same words.
 */
export const reporterReads = (status: IssueReportStatus): string | undefined => {
  const name = ISSUE_STATUS_NAMES[issueReportStatusForReporter(status)]
  return name === ADMIN_ISSUE_STATUS_NAMES[status] ? undefined : name
}

/** Who made a bare change of assignee, and what it was, as one line of an admins' thread. */
export const ASSIGNMENT_LINES: Record<IssueReportAssignment, string> = {
  claimed: 'took this report',
  takenOver: 'took this report over',
  released: 'released this report',
}

/**
 * Who a thread entry or a change of status is shown as written by: its author's name, or, for
 * one an agent wrote for an admin through the admin gatekeeper, "Agent, for" that admin. The
 * reporter and the admins read the same words.
 */
export const entryAuthorLabel = ({ author, via }: Pick<IssueReportEntry, 'author' | 'via'>): string =>
  via === 'gatekeeper' ? `Agent, for ${author.name}` : author.name
