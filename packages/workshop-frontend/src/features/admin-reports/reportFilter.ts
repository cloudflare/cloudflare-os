import {
  ISSUE_REPORT_PRIORITIES,
  ISSUE_REPORT_STATUSES,
  type IssueReportPriority,
  type IssueReportStatus,
} from '@gadgets/workshop-shared/api'

/**
 * The Reports tab's filters, kept in the admin page's URL as search parameters of these names, so
 * a filtered list can be linked. Each is passed to AdminApi.listIssueReports() as is.
 */
export type ReportFilter = {
  /** Only reports with this status. */
  status?: IssueReportStatus
  /** Only reports of this priority. */
  priority?: IssueReportPriority
  /** Only this user's reports, by the id a report shows for its reporter. */
  reporter?: string
  /** Only reports naming this workspace, by id. */
  workspace?: string
}

/** What the Reports tab keeps in the URL: its filters, and the report that is open. */
export type ReportSearch = ReportFilter & {
  /** The open report, by id. */
  report?: string
}

const isStatus = (value: unknown): value is IssueReportStatus =>
  (ISSUE_REPORT_STATUSES as readonly unknown[]).includes(value)

const isPriority = (value: unknown): value is IssueReportPriority =>
  (ISSUE_REPORT_PRIORITIES as readonly unknown[]).includes(value)

// The router reads a search value as JSON where it can, so an id made of digits is a number.
const id = (value: unknown) =>
  typeof value === 'string' && value !== '' ? value : typeof value === 'number' ? String(value) : undefined

/** The Reports tab's part of `search`, leaving out any parameter that is malformed. */
export const reportSearchOf = (search: Record<string, unknown>): ReportSearch => {
  const found: ReportSearch = {}
  if (isStatus(search.status)) found.status = search.status
  if (isPriority(search.priority)) found.priority = search.priority
  const reporter = id(search.reporter)
  if (reporter !== undefined) found.reporter = reporter
  const workspace = id(search.workspace)
  if (workspace !== undefined) found.workspace = workspace
  const report = id(search.report)
  if (report !== undefined) found.report = report
  return found
}

/** Whether any filter is set. */
export const isFiltered = ({ status, priority, reporter, workspace }: ReportFilter) =>
  [status, priority, reporter, workspace].some((value) => value !== undefined)
