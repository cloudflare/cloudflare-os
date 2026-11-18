import type { IssueReportPriority, IssueReportStatus } from '@gadgets/workshop-shared/api'

/** What each priority of an issue report is called. */
export const ISSUE_PRIORITY_NAMES: Record<IssueReportPriority, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
}

/** What each status of an issue report is called, as its reporter reads it. */
export const ISSUE_STATUS_NAMES: Record<IssueReportStatus, string> = {
  new: 'New',
  investigating: 'Investigating',
  answered: 'Answered',
  waitingOnReporter: 'Waiting on you',
  withAdmin: 'With the admins',
  closed: 'Closed',
}

/** What each status of an issue report is called, as the admins read it. */
export const ADMIN_ISSUE_STATUS_NAMES: Record<IssueReportStatus, string> = {
  ...ISSUE_STATUS_NAMES,
  waitingOnReporter: 'Waiting on the reporter',
}
