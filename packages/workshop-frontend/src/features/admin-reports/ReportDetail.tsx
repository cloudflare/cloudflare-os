import { useEffect, useEffectEvent, useId, useRef, useState, type ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { Button, Loader, Select } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import {
  getIssueReportErrorCode,
  ISSUE_REPORT_ERROR_CODES,
  ISSUE_REPORT_STATUSES,
  type AdminApi,
  type AdminIssueReport,
  type IssueReportEntry,
  type IssueReportStatus,
  type NamedUser,
} from '@gadgets/workshop-shared/api'
import { logRpcFailure } from '../../rpcErrors'
import { formatFullTimestamp } from '../../utils/formatTimestamp'
import { issueFailure } from '../issue-reports/issueFailure'
import { ADMIN_ISSUE_STATUS_NAMES, ISSUE_PRIORITY_NAMES, reporterReads } from '../issue-reports/issueLabels'
import { IssueThread } from '../issue-reports/IssueThread'
import { ReportAssignee } from './ReportAssignee'
import { ReportComposer } from './ReportComposer'
import { GRANT_SCOPE_NAMES, grantStanding } from './reportGrant'
import { ReportLinks } from './ReportLinks'

type Opened = AdminIssueReport & { entries: IssueReportEntry[] }

const CARD = 'rounded-xl border border-kumo-line bg-kumo-elevated px-5 py-4'
const CARD_HEADING = 'text-sm font-semibold text-kumo-strong'

const Detail = ({ term, children }: { term: string; children: ReactNode }) => (
  <div className="grid gap-x-4 gap-y-0.5 sm:grid-cols-[7rem_minmax(0,1fr)]">
    <dt className="text-xs text-kumo-subtle">{term}</dt>
    <dd className="min-w-0 break-words text-sm text-kumo-default">{children}</dd>
  </div>
)

const Mono = ({ children }: { children: ReactNode }) => (
  <span className="break-all font-mono text-xs">{children}</span>
)

/**
 * One issue report as the admins work it: its whole thread, admins-only entries included, where
 * an admin writes a note or a reply; its status, which says what the reporter reads where that
 * is not what the admins read; who holds it, which the admin reading it can change; its links;
 * its images, read through the admin API; the grant given with it; where its reporter was; and
 * the way into the admin page of the workspace it names. The report is read again after each
 * change, so what is shown is what the server holds. Whoever renders it keys it by the report.
 *
 * The thread and the composer are rendered whoever holds the report, so a change of assignee
 * leaves what is being written as it is.
 */
export const ReportDetail = ({ admin, reportId, me, onRead }: {
  admin: RpcStub<AdminApi>
  reportId: string
  /** The admin reading the report, once known. */
  me: NamedUser | undefined
  /** Told what the server holds of the report, each time it is read. */
  onRead: (report: AdminIssueReport) => void
}) => {
  const [open, setOpen] = useState<{ report: Opened } | { problem: string }>()
  // The status being set, which the select shows until the report is read again. The select is
  // not disabled meanwhile: its list gives focus back to it as it closes, which a disabled control
  // cannot take.
  const [pendingStatus, setPendingStatus] = useState<IssueReportStatus | null>(null)
  const [statusProblem, setStatusProblem] = useState<string | null>(null)
  // Why the report could not be read again after a change that went through.
  const [staleProblem, setStaleProblem] = useState<string | null>(null)
  const grantHeading = useId()
  const contextHeading = useId()
  // Counts the reads begun, so that only the latest one's answer is shown.
  const reads = useRef(0)
  const statusField = useRef<HTMLDivElement>(null)

  const read = async () => {
    const mine = ++reads.current
    const report = await admin.getIssueReport(reportId)
    if (mine !== reads.current) return
    setOpen({ report })
    const { entries: _entries, ...listed } = report
    onRead(listed)
  }

  // Reads the report after a change the server took, and answers whether it could. A failure is
  // said beside the report rather than as the change's own, which would invite making the change
  // a second time.
  const readAfterChange = async () => {
    try {
      await read()
      setStaleProblem(null)
      return true
    } catch (err) {
      setStaleProblem(issueFailure(err, 'Couldn’t read the report again.'))
      return false
    }
  }

  // The button that asks for the read goes with its notice once the report is read, which would
  // leave focus on nothing: the status, the first of the report's controls, takes it instead.
  const readAgain = async (button: HTMLElement) => {
    if (!await readAfterChange()) return
    const focused = document.activeElement
    if (focused === button || focused === document.body) {
      statusField.current?.querySelector<HTMLElement>('[role="combobox"]')?.focus()
    }
  }

  const firstRead = useEffectEvent(read)
  useEffect(() => {
    let current = true
    firstRead().catch((err: unknown) => {
      if (current) setOpen({ problem: issueFailure(err, 'Couldn’t load the report.') })
    })
    return () => {
      current = false
      // An answer still on its way belongs to a session, or a report, the page has left.
      reads.current++
    }
  }, [admin, reportId])

  if (open === undefined) return <Loader aria-label="Loading the report" />
  if ('problem' in open) return <p role="alert" className="text-sm text-kumo-danger">{open.problem}</p>

  const { report } = open
  const { workspaceId, chatId, gadgetId, appVersion } = report.context

  const changeStatus = async (status: IssueReportStatus) => {
    if (status === report.status || pendingStatus !== null) return
    setPendingStatus(status)
    setStatusProblem(null)
    try {
      await admin.setIssueReportStatus(report.id, status)
    } catch (err) {
      setStatusProblem(issueFailure(err, 'Couldn’t set the status.'))
      setPendingStatus(null)
      return
    }
    await readAfterChange()
    setPendingStatus(null)
  }

  // A claim or a release refused because another admin holds the report is answered by reading
  // the report again, so that the holder shown, and the one a take-over is next asked about, is
  // the one the server has.
  const changeAssignee = async (change: () => Promise<void>) => {
    try {
      await change()
    } catch (err) {
      if (getIssueReportErrorCode(err) === ISSUE_REPORT_ERROR_CODES.assigned) {
        await read().catch((failure: unknown) => logRpcFailure('Failed to read the report again:', failure))
      }
      throw err
    }
    await readAfterChange()
  }

  const shownStatus = pendingStatus ?? report.status
  const reporterStatus = reporterReads(shownStatus)

  return (
    <div className="space-y-6">
      {staleProblem !== null && (
        <div role="alert" className="space-y-2 text-sm text-kumo-danger">
          <p>Your change was saved, but what is shown here is from before it. {staleProblem}</p>
          <Button size="sm" variant="secondary" onClick={(event) => void readAgain(event.currentTarget)}>
            Read the report again
          </Button>
        </div>
      )}
      <div className="space-y-4">
        <div className="space-y-2">
          <p className="text-sm text-kumo-subtle">{ISSUE_PRIORITY_NAMES[report.priority]} priority</p>
          <div ref={statusField} className="max-w-md" aria-busy={pendingStatus !== null}>
            <Select<IssueReportStatus>
              label="Status"
              className="w-56 max-w-full"
              value={shownStatus}
              onValueChange={(status) => { if (status !== null) void changeStatus(status) }}
              renderValue={(status) => ADMIN_ISSUE_STATUS_NAMES[status]}
              description={
                'The reporter sees each change they can tell apart, with your name.'
                + (reporterStatus === undefined ? '' : ` The reporter reads this as “${reporterStatus}”.`)
              }
            >
              {ISSUE_REPORT_STATUSES.map((status) => {
                const forReporter = reporterReads(status)
                return (
                  <Select.Option key={status} value={status}>
                    {ADMIN_ISSUE_STATUS_NAMES[status]}
                    {forReporter !== undefined && (
                      <span className="text-kumo-subtle"> (the reporter reads “{forReporter}”)</span>
                    )}
                  </Select.Option>
                )
              })}
            </Select>
          </div>
          {statusProblem !== null && <p role="alert" className="text-sm text-kumo-danger">{statusProblem}</p>}
        </div>
        {/* Rendered whoever holds the report, as the thread and the composer below are: a change
            of holder remounts none of them. */}
        <ReportAssignee
          assignee={report.assignee}
          me={me}
          onClaim={(takeOverFrom) => changeAssignee(async () => {
            await (takeOverFrom === undefined
              ? admin.claimIssueReport(report.id) : admin.claimIssueReport(report.id, { takeOverFrom }))
          })}
          onRelease={() => changeAssignee(async () => { await admin.releaseIssueReport(report.id) })}
        />
      </div>

      <IssueThread
        forAdmins
        report={report}
        entries={report.entries}
        readImage={(imageId) => admin.readIssueReportImage(report.id, imageId)}
      >
        <ReportComposer
          entries={report.entries}
          onAdd={async (text, visibility) => {
            await admin.addIssueReportEntry(report.id, text, visibility)
            await readAfterChange()
          }}
        />
      </IssueThread>

      <div className="grid items-start gap-4 md:grid-cols-2">
        <section aria-labelledby={grantHeading} className={`${CARD} space-y-2`}>
          <h3 id={grantHeading} className={CARD_HEADING}>Access given with this report</h3>
          {report.grant === undefined ? (
            <p className="text-sm text-kumo-subtle">The reporter gave no access to content with this report.</p>
          ) : (
            <>
              <p className="text-sm text-kumo-default">
                {GRANT_SCOPE_NAMES[report.grant.scope]}, {grantStanding(report.grant, Date.now())}
                {report.grant.endedAt === undefined && (
                  <span className="text-kumo-subtle">
                    {' '}(until{' '}
                    <time dateTime={report.grant.expiresAt.toISOString()}>
                      {formatFullTimestamp(report.grant.expiresAt)}
                    </time>)
                  </span>
                )}
              </p>
              <p className="text-xs text-kumo-subtle">
                As the workspace last reported. The workspace decides when you ask for content.
              </p>
            </>
          )}
        </section>

        <section aria-labelledby={contextHeading} className={`${CARD} space-y-3`}>
          <h3 id={contextHeading} className={CARD_HEADING}>Where the reporter was</h3>
          <dl className="space-y-2">
            <Detail term="Reporter">
              {report.reporter.name}
              <span className="block"><Mono>{report.reporter.id}</Mono></span>
            </Detail>
            <Detail term="Workspace">
              {workspaceId === undefined ? 'None: filed outside a workspace' : <Mono>{workspaceId}</Mono>}
            </Detail>
            {chatId !== undefined && <Detail term="Chat"><Mono>{chatId}</Mono></Detail>}
            {gadgetId !== undefined && <Detail term="Gadget"><Mono>{gadgetId}</Mono></Detail>}
            {appVersion !== undefined && <Detail term="App version"><Mono>{appVersion}</Mono></Detail>}
          </dl>
          {workspaceId !== undefined && (
            <Link
              to="/admin/workspace/$workspaceId"
              params={{ workspaceId }}
              search={{ report: report.id }}
              className="inline-block text-sm text-kumo-brand hover:underline"
            >
              Open the workspace’s admin view
            </Link>
          )}
        </section>

        <div className={`${CARD} md:col-span-2`}>
          <ReportLinks
            links={report.links}
            stale={staleProblem !== null}
            onSave={async (links) => {
              await admin.setIssueReportLinks(report.id, links)
              await readAfterChange()
            }}
          />
        </div>
      </div>
    </div>
  )
}
