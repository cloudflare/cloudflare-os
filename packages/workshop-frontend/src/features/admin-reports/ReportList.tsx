import { useEffect, useRef } from 'react'
import { Link } from '@tanstack/react-router'
import { Badge, Button } from '@cloudflare/kumo'
import type { AdminIssueReport, IssueReportStatus } from '@gadgets/workshop-shared/api'
import { formatFullTimestamp } from '../../utils/formatTimestamp'
import { ADMIN_ISSUE_STATUS_NAMES, ISSUE_PRIORITY_NAMES } from '../issue-reports/issueLabels'
import { isFiltered, type ReportFilter } from './reportFilter'
import { GRANT_SCOPE_NAMES, grantStanding } from './reportGrant'

// "New", "With the admins" and "Fix suggested" are the statuses that wait on an admin.
const STATUS_VARIANTS: Record<IssueReportStatus, 'outline' | 'warning' | 'neutral'> = {
  new: 'warning',
  investigating: 'outline',
  answered: 'outline',
  waitingOnReporter: 'outline',
  withAdmin: 'warning',
  fixSuggested: 'warning',
  fixInProgress: 'outline',
  fixProposed: 'outline',
  closed: 'neutral',
}

// A report is listed by the first line of what its reporter wrote.
const firstLine = (text: string) => text.trim().split('\n', 1)[0]

const When = ({ at }: { at: Date }) => <time dateTime={at.toISOString()}>{formatFullTimestamp(at)}</time>

const FILTER_BUTTON = '-mx-1.5 max-w-full text-xs'

// A row is its title above its details, and who holds it: a line of its own beneath them on a
// narrow screen and a column of one width beside them on a wider one, so that the holder starts
// at the same place in every row. The cell is as tall as the button a held report shows, so that
// a row is the same height whether or not it is held.
const ROW = 'grid grid-cols-[minmax(0,1fr)] gap-y-1.5 py-3 sm:grid-cols-[minmax(0,1fr)_14rem] sm:gap-x-4'
const HOLDER_CELL = [
  'flex min-h-6.5 min-w-0 items-center gap-x-1.5 text-xs text-kumo-subtle',
  'sm:col-start-2 sm:row-span-2 sm:row-start-1 sm:self-start',
].join(' ')
// Drawn back on the left alone, to start where "Held by" ends: drawn back on the right as well, a
// long name's button would reach past its row.
const HOLDER_BUTTON = '-ml-1.5 min-w-0 shrink text-xs'

/**
 * The issue reports loaded so far, newest first, with Load more while the server holds further
 * ones. A row shows a report's first line, which opens it, where it stands, who filed it and the
 * workspace it names, each a button that filters the list by it, when it was filed and last
 * written in, how many images it holds, and what the grant given with it covers and how long that
 * has left. Who holds the report has a cell of its own, at the same place in every row: the
 * holder's name, a button that filters the list by them, or that nobody holds it.
 */
export const ReportList = ({ reports, nextCursor, filter, more, onLoadMore, onFilterBy, onOpen }: {
  reports: AdminIssueReport[]
  /** Present while the server holds further reports. */
  nextCursor: string | undefined
  /** The filter the reports were listed under, which a link to one of them keeps. */
  filter: ReportFilter
  /** Where loading a further page stands. */
  more: { loading: boolean; problem: string | null }
  onLoadMore: () => void
  /** Filters the list by a row's reporter, workspace or holder as well. */
  onFilterBy: (added: Pick<ReportFilter, 'reporter' | 'workspace' | 'assignee'>) => void
  /** Told that a press is opening a report. */
  onOpen: () => void
}) => {
  const rows = useRef<HTMLUListElement>(null)
  // Set by a press of Load more: the button, and how many rows the list held.
  const loadedFrom = useRef<{ button: HTMLElement; count: number } | null>(null)

  // Load more is disabled while its page loads, which takes focus from it, and goes with the last
  // page. Focus moves to the first row the page added, or back to the button when it added none,
  // unless it has gone elsewhere than the button since.
  const loadingMore = more.loading
  useEffect(() => {
    if (loadingMore || loadedFrom.current === null) return
    const { button, count } = loadedFrom.current
    loadedFrom.current = null
    if (document.activeElement !== document.body && document.activeElement !== button) return
    const added = rows.current?.children[count]?.querySelector('a')
    ;(added ?? (button.isConnected ? button : null))?.focus()
  }, [loadingMore])

  if (reports.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-kumo-subtle">
        {isFiltered(filter) ? 'No issue report matches these filters.' : 'Nobody has filed an issue report yet.'}
      </p>
    )
  }

  const now = Date.now()
  return (
    <>
      <ul ref={rows} aria-label="Issue reports" className="divide-y divide-kumo-line">
        {reports.map((report) => {
          const { workspaceId } = report.context
          const images = report.images.length
          const holder = report.assignee
          return (
            <li key={report.id} className={ROW}>
              <Link
                to="/admin"
                search={{ tab: 'reports', ...filter, report: report.id }}
                data-report-id={report.id}
                onClick={onOpen}
                className={[
                  'block truncate rounded text-sm font-medium text-kumo-default hover:underline',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring',
                ].join(' ')}
              >
                {firstLine(report.text)}
              </Link>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-kumo-subtle">
                <Badge variant={STATUS_VARIANTS[report.status]}>{ADMIN_ISSUE_STATUS_NAMES[report.status]}</Badge>
                <span>{ISSUE_PRIORITY_NAMES[report.priority]} priority</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className={FILTER_BUTTON}
                  aria-label={`Show only ${report.reporter.name}’s reports`}
                  onClick={() => onFilterBy({ reporter: report.reporter.id })}
                >
                  <span className="truncate">{report.reporter.name}</span>
                </Button>
                {workspaceId !== undefined && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className={FILTER_BUTTON}
                    aria-label={`Show only reports naming workspace ${workspaceId}`}
                    onClick={() => onFilterBy({ workspace: workspaceId })}
                  >
                    <span className="truncate font-mono">{workspaceId}</span>
                  </Button>
                )}
                <span>Filed <When at={report.filedAt} /></span>
                {report.updatedAt.getTime() !== report.filedAt.getTime() && (
                  <span>Updated <When at={report.updatedAt} /></span>
                )}
                {images > 0 && <span>{images} {images === 1 ? 'image' : 'images'}</span>}
                {report.grant !== undefined && (
                  <span>{GRANT_SCOPE_NAMES[report.grant.scope]}, {grantStanding(report.grant, now)}</span>
                )}
              </div>
              <div className={HOLDER_CELL} data-report-holder="">
                {holder === undefined ? 'Unassigned' : (
                  <>
                    <span className="shrink-0">Held by</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className={HOLDER_BUTTON}
                      aria-label={`Show only reports ${holder.name} holds`}
                      onClick={() => onFilterBy({ assignee: holder.id })}
                    >
                      <span className="truncate">{holder.name}</span>
                    </Button>
                  </>
                )}
              </div>
            </li>
          )
        })}
      </ul>
      {more.problem !== null && <p role="alert" className="mt-3 text-sm text-kumo-danger">{more.problem}</p>}
      {nextCursor !== undefined && (
        <Button
          size="sm"
          variant="secondary"
          className="mt-3"
          loading={more.loading}
          onClick={(event) => {
            loadedFrom.current = { button: event.currentTarget, count: reports.length }
            onLoadMore()
          }}
        >
          Load more
        </Button>
      )}
    </>
  )
}
