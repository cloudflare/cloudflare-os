import { useEffect, useId, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { Button, Loader, useKumoToastManager } from '@cloudflare/kumo'
import { ArrowLeft, ArrowsClockwise } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import { MAX_ISSUE_REPORT_RETENTION_DAYS } from '@gadgets/workshop-shared/api'
import type { AdminApi, AdminIssueReport } from '@gadgets/workshop-shared/api'
import { DurationSetting } from '../../components/DurationSetting'
import { logRpcFailure, rpcFailureDescription } from '../../rpcErrors'
import { issueFailure } from '../issue-reports/issueFailure'
import { ReportDetail } from './ReportDetail'
import type { ReportFilter } from './reportFilter'
import { ReportFilters } from './ReportFilters'
import { ReportList } from './ReportList'
import type { ReportRetention } from './reportSettings'
import { useAdminIdentity } from './useAdminIdentity'

type AdminReportsPanelProps = {
  admin: RpcStub<AdminApi>
  /** How long reports are kept, as the server last reported it. */
  retention: ReportRetention
  /**
   * Re-reads the settings after a change, so that the panel shows what the server holds. Rejects
   * when the re-read failed.
   */
  onSettingsChanged: () => Promise<void>
  /** The list's filters, which the admin page keeps in its URL. */
  filter: ReportFilter
  onFilterChange: (filter: ReportFilter) => void
  /** The report that is open, from the URL. */
  reportId?: string
}

/** How many reports one page of the Reports tab's list holds. */
export const REPORT_PAGE_SIZE = 50

const CARD = 'bg-kumo-elevated border border-kumo-line rounded-xl p-6'
const RETENTION_LABEL = 'Keep issue reports for (days)'
const NUMBER = new Intl.NumberFormat('en')
const IDLE = { loading: false, problem: null }

// What one load of the list's first page gave, for the request it answered (see `request` below),
// with the further pages loaded after it.
type Listed = { request: string } & ({ reports: AdminIssueReport[]; nextCursor?: string } | { failed: true })

/**
 * The admin Reports tab: the issue reports users filed, newest first, filtered and a page at a
 * time; the report that is open, with its whole thread; and how long reports are kept. It reads
 * who the admin is once, for the list and the report to tell the reports they hold from others'.
 *
 * An open report takes the list's place, and the list stays loaded behind it: a report read while
 * it is open replaces its row, so the list shows what the server last said of it once the admin
 * comes back.
 */
export const AdminReportsPanel = ({
  admin, retention, onSettingsChanged, filter, onFilterChange, reportId,
}: AdminReportsPanelProps) => {
  const toasts = useKumoToastManager()
  const me = useAdminIdentity(admin)
  const [listed, setListed] = useState<Listed | null>(null)
  // Each press of Refresh or Retry is one value of this.
  const [reloads, setReloads] = useState(0)
  // Where loading a further page stands, for the list it was asked after.
  const [furtherPage, setFurtherPage] =
    useState<{ request: string; loading: boolean; problem: string | null } | null>(null)
  const heading = useId()
  const detailHeading = useId()
  const listing = useRef<HTMLElement>(null)
  const detail = useRef<HTMLElement>(null)
  const filters = useRef<HTMLDivElement>(null)

  const { status, priority, reporter, workspace, assignee, unassigned } = filter
  // Everything the list depends on, so that an answer to an earlier load is told apart.
  const request = JSON.stringify([
    status ?? null, priority ?? null, reporter ?? null, workspace ?? null, assignee ?? null, unassigned ?? null,
    reloads,
  ])

  useEffect(() => {
    let current = true
    admin.listIssueReports({
      status, priority, reporter, workspace, assignee, unassigned, limit: REPORT_PAGE_SIZE,
    }).then(
      (page) => { if (current) setListed({ request, ...page }) },
      (err: unknown) => {
        if (!current) return
        logRpcFailure('Failed to load the issue reports:', err)
        setListed({ request, failed: true })
      },
    )
    return () => { current = false }
  }, [admin, status, priority, reporter, workspace, assignee, unassigned, request])

  // A list stays shown, dimmed, until the load that replaces it answers.
  const list = listed !== null && 'reports' in listed ? listed : null
  const busy = listed?.request !== request
  const failed = listed !== null && 'failed' in listed && !busy
  const more = furtherPage?.request === request ? furtherPage : IDLE

  const loadMore = async () => {
    if (list === null || busy || list.nextCursor === undefined || more.loading) return
    setFurtherPage({ request, loading: true, problem: null })
    let problem: string | null = null
    try {
      const page = await admin.listIssueReports({
        status, priority, reporter, workspace, assignee, unassigned, cursor: list.nextCursor, limit: REPORT_PAGE_SIZE,
      })
      // A page belongs after the list it was asked for, and is dropped once another has replaced it.
      setListed((previous) => previous?.request !== request || !('reports' in previous) ? previous : {
        request,
        reports: [
          ...previous.reports,
          ...page.reports.filter((added) => !previous.reports.some((other) => other.id === added.id)),
        ],
        nextCursor: page.nextCursor,
      })
    } catch (err) {
      problem = issueFailure(err, 'Couldn’t load more issue reports.')
    }
    setFurtherPage({ request, loading: false, problem })
  }

  const noteRead = (report: AdminIssueReport) => {
    setListed((previous) => previous === null || !('reports' in previous) ? previous : {
      ...previous,
      reports: previous.reports.map((other) => other.id === report.id ? report : other),
    })
  }

  // Opening a report replaces the list with it, and closing it brings the list back, so the press
  // that did either would leave focus on nothing. The report takes it when one opens. When the
  // list returns, the row of the report that was open takes it, or the list when it holds no such
  // row.
  const moved = useRef(false)
  const lastOpen = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (reportId !== undefined) lastOpen.current = reportId
    if (!moved.current) return
    moved.current = false
    if (reportId !== undefined) {
      detail.current?.focus()
      return
    }
    const row = [...listing.current?.querySelectorAll<HTMLElement>('a[data-report-id]') ?? []]
      .find((link) => link.dataset.reportId === lastOpen.current)
    ;(row ?? listing.current)?.focus()
  }, [reportId])

  // A row's reporter, workspace or holder button can go with the rows the filtered list replaces,
  // so focus goes to the chip that then shows the choice. The chip exists once the URL holds the
  // filter. The admin's own reports have no chip: the Assignee filter shows that choice, and takes
  // focus.
  const chipToFocus = useRef<'reporter' | 'workspace' | 'assignee' | null>(null)
  const filterBy = (added: Pick<ReportFilter, 'reporter' | 'workspace' | 'assignee'>) => {
    const field = added.reporter !== undefined ? 'reporter' : added.workspace !== undefined ? 'workspace' : 'assignee'
    if (added[field] === filter[field]) return
    chipToFocus.current = field
    // Only reports one admin holds and only reports nobody holds are one choice of two.
    onFilterChange({ ...filter, ...added, ...(field === 'assignee' && { unassigned: undefined }) })
  }
  useEffect(() => {
    if (chipToFocus.current === null) return
    const field = chipToFocus.current
    chipToFocus.current = null
    const chip = filters.current?.querySelector<HTMLElement>(`[data-filter-chip="${field}"]`)
    ;(chip ?? filters.current?.querySelector<HTMLElement>(`[data-filter-field="${field}"] [role="combobox"]`))?.focus()
  }, [reporter, workspace, assignee])

  const reporterName = list?.reports.find((report) => report.reporter.id === reporter)?.reporter.name
  const assigneeName = list?.reports.find((report) => report.assignee?.id === assignee)?.assignee?.name

  const reportFailure = (title: string, err: unknown) => {
    logRpcFailure(`${title}:`, err)
    toasts.add({ title, description: rpcFailureDescription(err), variant: 'error' })
  }

  // Resolves whether the retention was saved and the settings were re-read after it.
  const saveRetention = async (days: number): Promise<boolean> => {
    try {
      await admin.setIssueReportRetentionDays(days)
    } catch (err) {
      reportFailure(`Couldn’t update “${RETENTION_LABEL}”`, err)
      return false
    }
    try {
      await onSettingsChanged()
      return true
    } catch (err) {
      reportFailure('Couldn’t reload the admin settings', err)
      return false
    }
  }

  return (
    <div className="space-y-6">
      {reportId !== undefined && (
        <section ref={detail} tabIndex={-1} aria-labelledby={detailHeading} className="space-y-4 focus:outline-none">
          <Link
            to="/admin"
            search={{ tab: 'reports', ...filter }}
            // Exact, so that the link back to the list is not marked as where the reader is.
            activeOptions={{ exact: true }}
            onClick={() => { moved.current = true }}
            className="inline-flex items-center gap-1 text-sm text-kumo-brand hover:underline"
          >
            <ArrowLeft size={14} aria-hidden="true" />
            All reports
          </Link>
          <h2 id={detailHeading} className="text-lg font-semibold text-kumo-strong">Issue report</h2>
          {/* Keyed by the report, so that nothing drafted for one is ever written to another. */}
          <ReportDetail key={reportId} admin={admin} reportId={reportId} me={me} onRead={noteRead} />
        </section>
      )}

      <div hidden={reportId !== undefined} className="space-y-6">
        <section ref={listing} tabIndex={-1} aria-labelledby={heading} className="space-y-4 focus:outline-none">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <h2 id={heading} className="text-lg font-semibold text-kumo-strong">Issue reports</h2>
              <p className="text-sm text-kumo-subtle mt-0.5">
                What users reported to the admins, kept for {NUMBER.format(retention.effective)} days
                from filing. Reading and answering a report is not in the audit log: a
                report&rsquo;s thread is its own record of who did what.
              </p>
            </div>
            <Button
              variant="secondary"
              size="sm"
              icon={ArrowsClockwise}
              loading={busy && list !== null}
              disabled={busy}
              onClick={() => setReloads((n) => n + 1)}
            >
              Refresh
            </Button>
          </div>

          <div ref={filters}>
            <ReportFilters
              filter={filter}
              me={me}
              reporterName={reporterName}
              assigneeName={assigneeName}
              onFilterChange={onFilterChange}
            />
          </div>

          {list === null && !failed && (
            <div className="flex justify-center py-12">
              <Loader size="lg" />
            </div>
          )}
          {failed && (
            <div className="py-8 text-center">
              <p role="alert" className="text-sm text-kumo-danger">Couldn’t load the issue reports.</p>
              <Button variant="secondary" size="sm" className="mt-3" onClick={() => setReloads((n) => n + 1)}>
                Retry
              </Button>
            </div>
          )}
          {list !== null && !failed && (
            <div className={busy ? 'opacity-60' : undefined} aria-busy={busy}>
              <ReportList
                reports={list.reports}
                nextCursor={list.nextCursor}
                filter={filter}
                more={more}
                onLoadMore={() => void loadMore()}
                onFilterBy={filterBy}
                onOpen={() => { moved.current = true }}
              />
            </div>
          )}
        </section>

        <div className={CARD}>
          <h2 className="text-lg font-semibold text-kumo-strong mb-4">Issue report retention</h2>
          {retention.chosen < retention.min && (
            <p className="text-sm text-kumo-subtle mb-4">
              The retention set here is {NUMBER.format(retention.chosen)} days, so this
              deployment&rsquo;s minimum of {NUMBER.format(retention.min)} days is what holds it up.
              If a deploy lowers or removes ISSUE_REPORT_RETENTION_MIN_DAYS,{' '}
              {NUMBER.format(retention.chosen)} days applies again. To keep a retention either way,
              type the number of days and save it, even the minimum.
            </p>
          )}
          <div className="max-w-md">
            <DurationSetting
              label={RETENTION_LABEL}
              help={
                'How long an issue report is kept from its filing, with its thread and images. This deployment ' +
                `keeps at least ${NUMBER.format(retention.min)} days, which its ` +
                'ISSUE_REPORT_RETENTION_MIN_DAYS variable sets.'
              }
              unit="days"
              min={retention.min}
              max={MAX_ISSUE_REPORT_RETENTION_DAYS}
              value={retention.effective}
              onSave={saveRetention}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
