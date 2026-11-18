import { useEffect, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { Badge, Button, Empty, Loader } from '@cloudflare/kumo'
import { ArrowLeft, Lifebuoy } from '@phosphor-icons/react'
import type { IssueReportStatus, OwnIssueReport } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../AuthContext'
import { GrantControls } from './GrantControls'
import { IssueReplyBox } from './IssueReplyBox'
import { IssueThread } from './IssueThread'
import { ISSUE_PRIORITY_NAMES, ISSUE_STATUS_NAMES } from './issueLabels'
import { useMyIssues } from './useMyIssues'

// "Waiting on you" is the one status that asks its reader to do something.
const STATUS_VARIANTS: Record<IssueReportStatus, 'outline' | 'warning' | 'neutral'> = {
  new: 'outline',
  investigating: 'outline',
  answered: 'outline',
  waitingOnReporter: 'warning',
  withAdmin: 'outline',
  fixSuggested: 'outline',
  fixInProgress: 'outline',
  fixProposed: 'outline',
  closed: 'neutral',
}

const CARD_CLASS = 'rounded-xl border border-kumo-line bg-kumo-elevated px-5 py-4'

// A report is listed by the first line of what its reporter wrote.
const firstLine = (text: string) => text.trim().split('\n', 1)[0]

const Standing = ({ report }: { report: OwnIssueReport }) => (
  <>
    <Badge variant={STATUS_VARIANTS[report.status]}>{ISSUE_STATUS_NAMES[report.status]}</Badge>
    <span>{ISSUE_PRIORITY_NAMES[report.priority]} priority</span>
  </>
)

/**
 * The My issues page: the reports the user filed, newest first and a page at a time, the public
 * thread of the one that is open, where they reply, and the grants they gave, each with Renew and
 * End access. `reportId` is the open report: one that is on no loaded page is read by its id and
 * shown all the same. Opening a report marks it seen.
 */
export const MyIssues = ({ reportId }: {
  /** The report that is open, from the URL. */
  reportId?: string
}) => {
  const { authenticatedApi } = useAuthenticatedApi()
  const issues = useMyIssues(reportId)
  const { list, open, accountGrant } = issues
  const heading = useRef<HTMLHeadingElement>(null)
  const detail = useRef<HTMLElement>(null)
  const listing = useRef<HTMLElement>(null)
  const rows = useRef<HTMLUListElement>(null)
  // Set by a press that opens or closes a report, for the Effect below.
  const moved = useRef(false)
  // Set by a press of Load more: the button, and how many rows the list held.
  const loadedFrom = useRef<{ button: HTMLElement; count: number } | null>(null)
  // Counts the changes made from the account-wide grant's card.
  const [cardChanges, setCardChanges] = useState(0)

  // Opening a report puts its thread after the whole list in the tab order, and at a phone's width
  // replaces the list with it, so the thread takes focus when a press opens one, and the list
  // when a press goes back to it.
  useEffect(() => {
    if (!moved.current) return
    moved.current = false
    ;(reportId === undefined ? listing : detail).current?.focus()
  }, [reportId])

  const reports = list !== undefined && 'reports' in list ? list.reports : []
  const accountGrantLive = accountGrant !== null && accountGrant.revokedAt === undefined
    && accountGrant.expiresAt.getTime() > Date.now()

  // Load more is disabled while its page loads, which takes focus from it, and goes with the last
  // page. Focus moves to the first row the page added, or back to the button when it added none,
  // unless it has gone elsewhere than the button since.
  const loadingMore = issues.more.loading
  useEffect(() => {
    if (loadingMore || loadedFrom.current === null) return
    const { button, count } = loadedFrom.current
    loadedFrom.current = null
    if (document.activeElement !== document.body && document.activeElement !== button) return
    const added = rows.current?.children[count]?.querySelector('a')
    ;(added ?? (button.isConnected ? button : listing.current))?.focus()
  }, [loadingMore])

  // End access takes the account-wide grant's card away, and with it the button that had focus
  // and the line GrantControls would move it to. The page's heading takes it, unless it has gone
  // elsewhere since. Only a change made from the card moves focus: the same grant ended from a
  // report keeps focus there.
  useEffect(() => {
    if (cardChanges > 0 && !accountGrantLive && document.activeElement === document.body) heading.current?.focus()
  }, [cardChanges])

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 px-4 pb-10 pt-6 sm:px-10 sm:pt-10">
      <header>
        <h1
          ref={heading}
          tabIndex={-1}
          className="text-2xl font-semibold tracking-tight text-kumo-default focus:outline-none"
        >
          My issues
        </h1>
        <p className="mt-1 text-[13px] leading-[18px] text-kumo-subtle">
          The reports you sent to the admins, and their replies.
        </p>
      </header>

      {accountGrantLive && (
        <section aria-labelledby="account-grant-heading" className={`${CARD_CLASS} space-y-2`}>
          <h2 id="account-grant-heading" className="text-sm font-semibold text-kumo-strong">
            Admins can read the content of all your workspaces
          </h2>
          <p className="text-sm text-kumo-subtle">
            You gave this access. It covers every workspace you own, those you make later included,
            and everything an admin reads under it is recorded.
          </p>
          <GrantControls
            grant={{
              id: accountGrant.id,
              scope: 'account',
              expiresAt: accountGrant.expiresAt,
              endedAt: accountGrant.revokedAt,
            }}
            onChanged={async () => {
              await issues.grantChanged()
              setCardChanges((value) => value + 1)
            }}
          />
        </section>
      )}

      <div className="grid gap-6 md:grid-cols-[20rem_minmax(0,1fr)]">
        <section
          ref={listing}
          tabIndex={-1}
          aria-label="Your issue reports"
          className={`min-w-0 focus:outline-none ${reportId === undefined ? '' : 'hidden md:block'}`}
        >
          {list === undefined ? (
            <Loader aria-label="Loading your issue reports" />
          ) : 'problem' in list ? (
            <div role="alert" className="space-y-2 text-sm text-kumo-danger">
              <p>{list.problem}</p>
              <Button size="sm" variant="secondary" onClick={issues.retry}>Try again</Button>
            </div>
          ) : reports.length === 0 ? (
            <Empty
              size="sm"
              icon={<Lifebuoy size={28} />}
              title="You have reported no issues"
              description="When something goes wrong, choose Report issue in your account menu or in a workspace’s menu. Your report and the admins’ replies are then shown here."
            />
          ) : (
            <>
              <ul ref={rows} className="divide-y divide-kumo-line">
                {reports.map((report) => (
                  <li key={report.id}>
                    <Link
                      to="/issues"
                      search={{ report: report.id }}
                      onClick={() => {
                        moved.current = report.id !== reportId
                        // A press of the open report's row reads it again.
                        if (report.id === reportId) issues.openAgain()
                      }}
                      className={[
                        'block rounded-lg px-3 py-3 transition-colors hover:bg-kumo-tint',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring',
                        report.id === reportId ? 'bg-kumo-fill' : '',
                      ].join(' ')}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        {report.unseen && (
                          <span role="img" aria-label="New reply" className="h-2 w-2 shrink-0 rounded-full bg-kumo-brand" />
                        )}
                        <span className="truncate text-sm font-medium text-kumo-default">{firstLine(report.text)}</span>
                      </span>
                      <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-kumo-subtle">
                        <Standing report={report} />
                        <time dateTime={report.filedAt.toISOString()}>
                          {report.filedAt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                        </time>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
              {issues.more.problem !== null && (
                <p role="alert" className="mt-3 px-3 text-sm text-kumo-danger">{issues.more.problem}</p>
              )}
              {list.nextCursor !== undefined && (
                <Button
                  size="sm"
                  variant="secondary"
                  className="mt-3"
                  loading={issues.more.loading}
                  onClick={(event) => {
                    loadedFrom.current = { button: event.currentTarget, count: reports.length }
                    void issues.loadMore()
                  }}
                >
                  Load more
                </Button>
              )}
            </>
          )}
        </section>

        {reportId === undefined ? (
          reports.length > 0 && (
            <p className="hidden text-sm text-kumo-subtle md:block">Choose a report to read its thread.</p>
          )
        ) : (
          <section
            ref={detail}
            tabIndex={-1}
            aria-label="Issue report"
            className="min-w-0 space-y-4 focus:outline-none"
          >
            <Link
              to="/issues"
              // Exact, so that the link back to the list is not marked as where the reader is.
              activeOptions={{ exact: true }}
              onClick={() => { moved.current = true }}
              className="inline-flex items-center gap-1 text-sm text-kumo-brand hover:underline md:hidden"
            >
              <ArrowLeft size={14} aria-hidden="true" />
              All issues
            </Link>
            {open === undefined ? (
              <Loader aria-label="Loading the report" />
            ) : 'problem' in open ? (
              <p role="alert" className="text-sm text-kumo-danger">{open.problem}</p>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-kumo-subtle">
                  <Standing report={open.report} />
                </div>
                <IssueThread
                  report={open.report}
                  entries={open.report.entries}
                  readImage={(imageId) => authenticatedApi.readIssueReportImage(open.report.id, imageId)}
                >
                  {/* Keyed by the report, so that a reply drafted to one is never sent to another. */}
                  <IssueReplyBox
                    key={open.report.id}
                    closed={open.report.status === 'closed'}
                    onReply={issues.reply}
                  />
                </IssueThread>
                {open.report.grant !== undefined && (
                  <section aria-labelledby="report-grant-heading" className={`${CARD_CLASS} space-y-2`}>
                    <h2 id="report-grant-heading" className="text-sm font-semibold text-kumo-strong">
                      Access you gave the admins with this report
                    </h2>
                    <GrantControls
                      grant={open.report.grant}
                      report={{ id: open.report.id, workspaceId: open.report.context.workspaceId }}
                      onChanged={issues.grantChanged}
                    />
                  </section>
                )}
              </>
            )}
          </section>
        )}
      </div>
    </div>
  )
}
