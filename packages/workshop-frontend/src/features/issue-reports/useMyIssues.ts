import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import type { RpcStub } from 'capnweb'
import type {
  AdminAccessGrant,
  AuthenticatedApi,
  IssueReportEntry,
  OwnIssueReport,
  OwnIssueReportPage,
} from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../AuthContext'
import { logRpcFailure } from '../../rpcErrors'
import { issueFailure } from './issueFailure'
import { useIssueReportCount } from './useIssueReportCount'

type Api = RpcStub<AuthenticatedApi>

/** An issue report with its public thread, as its reporter reads one. */
export type OpenedIssueReport = OwnIssueReport & { entries: IssueReportEntry[] }

// Each of these is kept with the session it was read over (and the report it is of), and counts
// only while that is still the session (and the report) the page shows.
type Pages = { api: Api } & ({ reports: OwnIssueReport[]; nextCursor?: string } | { problem: string })
type Opened = { api: Api; id: string } & ({ report: OpenedIssueReport } | { problem: string })

const withReport = (
  pages: Pages | undefined, id: string, change: (report: OwnIssueReport) => OwnIssueReport,
): Pages | undefined => pages === undefined || !('reports' in pages) ? pages : {
  ...pages,
  reports: pages.reports.map((report) => report.id === id ? change(report) : report),
}

// The first page as it is read again, over the pages already loaded: its reports come first, and
// the rows it does not hold stay after them. A report is only ever added at the newest end, so
// what was loaded past the first page still follows it, and so does the cursor.
const withFirstPage = (pages: Pages | undefined, api: Api, page: OwnIssueReportPage): Pages =>
  pages?.api === api && 'reports' in pages ? {
    ...pages,
    reports: [
      ...page.reports,
      ...pages.reports.filter((report) => !page.reports.some((other) => other.id === report.id)),
    ],
  } : { api, ...page }

// A report with the replies its reporter sent from this page (`sent`). A read and a reply's answer
// arrive in either order: a reply the report does not hold yet is added, with the status the last
// one left, and one it holds already changes nothing, so a reply is shown once.
const withReplies = (report: OpenedIssueReport, sent: IssueReportEntry[]): OpenedIssueReport => {
  const missing = sent.filter((entry) => !report.entries.some((other) => other.id === entry.id))
  if (missing.length === 0) return report
  const status = missing.findLast((entry) => entry.status !== undefined)?.status ?? report.status
  return { ...report, status, entries: [...report.entries, ...missing] }
}

const readAccountGrant = async (api: Api): Promise<{ api: Api; grant: AdminAccessGrant | null } | undefined> => {
  try {
    return { api, grant: await api.getAccountAdminGrant() }
  } catch (err) {
    logRpcFailure('Failed to read the account-wide grant:', err)
    return undefined
  }
}

/**
 * What the My issues page reads and writes: the caller's issue reports a page at a time, the
 * report that is open with its thread, and the account-wide grant.
 *
 * Opening a report reads it, shows it, marks it seen and then reads it once more. The mark covers
 * everything the report holds when it arrives, which can be more than the first read returned, so
 * the second read is what shows a reply that landed in between. It is sent only once the mark has
 * answered: two calls are not ordered in the store until the first has. The second read marks
 * nothing, and if it fails what the first one showed stays.
 *
 * Nothing is pushed to the page. The first page is read again each time the count of reports with
 * a new reply has been read, whether or not the count changed: a report filed while the page is open
 * leaves it as it was, and so does a change of status. The open report is opened again when that
 * read says a reply arrived after it was marked seen, or when its reader asks.
 */
export const useMyIssues = (reportId: string | undefined) => {
  const { authenticatedApi } = useAuthenticatedApi()
  const { read: countRead, refresh: refreshCount } = useIssueReportCount()
  const [pages, setPages] = useState<Pages>()
  const [attempt, setAttempt] = useState(0)
  const [more, setMore] = useState<{ loading: boolean; problem: string | null }>({ loading: false, problem: null })
  const [opened, setOpened] = useState<Opened>()
  // Counts the times the open report was opened again.
  const [opening, setOpening] = useState(0)
  // The replies sent from this page, by report.
  const sent = useRef(new Map<string, IssueReportEntry[]>())
  const [account, setAccount] = useState<{ api: Api; grant: AdminAccessGrant | null }>()

  const list = pages?.api === authenticatedApi ? pages : undefined
  const open = opened?.api === authenticatedApi && opened.id === reportId ? opened : undefined

  const onFirstPage = useEffectEvent((page: OwnIssueReportPage) => {
    const unseen = (reports: OwnIssueReport[]) => reports.find((report) => report.id === reportId)?.unseen
    // The open report was marked seen, and holds a reply again: it is opened again, which shows
    // the reply and marks it.
    if (list !== undefined && 'reports' in list && unseen(list.reports) === false && unseen(page.reports) === true) {
      setOpening((value) => value + 1)
    }
    setPages((previous) => withFirstPage(previous, authenticatedApi, page))
  })

  useEffect(() => {
    let current = true
    void authenticatedApi.listIssueReports().then((page) => {
      if (current) onFirstPage(page)
    }, (err: unknown) => {
      if (!current) return
      const problem = issueFailure(err, 'Couldn’t load your issue reports.')
      // Rows that are listed stay when reading them again fails.
      setPages((previous) => previous?.api === authenticatedApi && 'reports' in previous
        ? previous
        : { api: authenticatedApi, problem })
    })
    return () => { current = false }
  }, [authenticatedApi, attempt, countRead])

  useEffect(() => {
    if (reportId === undefined) return
    let current = true
    const show = (read: OpenedIssueReport) => {
      const report = withReplies(read, sent.current.get(reportId) ?? [])
      const { entries: _entries, ...listed } = report
      setOpened({ api: authenticatedApi, id: reportId, report })
      setPages((previous) => withReport(previous, reportId, () => listed))
    }
    void (async () => {
      let first: OpenedIssueReport
      try {
        first = await authenticatedApi.getIssueReport(reportId)
      } catch (err) {
        if (current) {
          const problem = issueFailure(err, 'Couldn’t load this report.')
          // A report that is shown stays when opening it again fails.
          setOpened((previous) => previous?.api === authenticatedApi && previous.id === reportId && 'report' in previous
            ? previous
            : { api: authenticatedApi, id: reportId, problem })
        }
        return
      }
      if (!current) return
      // Rendered before the mark is sent: a report is marked seen once its entries are on screen.
      flushSync(() => show(first))
      try {
        await authenticatedApi.markIssueReportSeen(reportId)
      } catch (err) {
        logRpcFailure('Failed to mark an issue report seen:', err)
        return
      }
      // The report is seen whether or not it is still the one that is open.
      setPages((previous) => previous?.api === authenticatedApi
        ? withReport(previous, reportId, (report) => ({ ...report, unseen: false }))
        : previous)
      if (current) {
        try {
          const second = await authenticatedApi.getIssueReport(reportId)
          if (current) show(second)
        } catch {
          // What the first read showed stays.
        }
      }
      refreshCount()
    })()
    return () => { current = false }
  }, [authenticatedApi, reportId, opening, refreshCount])

  useEffect(() => {
    let current = true
    void readAccountGrant(authenticatedApi).then((read) => {
      if (current && read !== undefined) setAccount(read)
    })
    return () => { current = false }
  }, [authenticatedApi])

  return {
    /** The pages loaded, or why the first could not be; undefined while it loads. */
    list,
    /** Reads the first page again, after it could not be loaded. */
    retry: () => {
      setPages(undefined)
      setAttempt((value) => value + 1)
    },
    /** Where loading the next page stands. */
    more,
    /** Appends the next page. */
    loadMore: async () => {
      if (list === undefined || !('reports' in list) || list.nextCursor === undefined || more.loading) return
      setMore({ loading: true, problem: null })
      try {
        const page = await authenticatedApi.listIssueReports(list.nextCursor)
        setPages((previous) => previous?.api === authenticatedApi && 'reports' in previous
          ? { api: authenticatedApi, reports: [...previous.reports, ...page.reports], nextCursor: page.nextCursor }
          : previous)
        setMore({ loading: false, problem: null })
      } catch (err) {
        setMore({ loading: false, problem: issueFailure(err, 'Couldn’t load more issue reports.') })
      }
    },
    /** The open report, or why it could not be read; undefined while it loads or none is open. */
    open,
    /** Opens the open report again: reads it, marks it seen and reads it once more. */
    openAgain: () => setOpening((value) => value + 1),
    /** Replies in the open report's thread, and shows the reply and the status it left. */
    reply: async (text: string) => {
      if (reportId === undefined) return
      const entry = await authenticatedApi.replyToIssueReport(reportId, text)
      const status = entry.status
      sent.current.set(reportId, [...sent.current.get(reportId) ?? [], entry])
      setOpened((previous) => previous?.api === authenticatedApi && previous.id === reportId && 'report' in previous
        ? { ...previous, report: withReplies(previous.report, [entry]) }
        : previous)
      if (status !== undefined) {
        setPages((previous) => withReport(previous, reportId, (report) => ({ ...report, status })))
      }
    },
    /** The account-wide grant, when the account holds one. */
    accountGrant: account?.api === authenticatedApi ? account.grant : null,
    /**
     * Reads again what shows a grant, after one was given, renewed or ended: the account-wide
     * grant, and the open report's. Of the report only its grant is taken: entries that arrived
     * since it was opened were not marked seen, so showing them would leave them counted.
     */
    grantChanged: async () => {
      const readReportGrant = async () => {
        if (reportId === undefined) return
        try {
          const { grant } = await authenticatedApi.getIssueReport(reportId)
          setOpened((previous) => previous?.api === authenticatedApi && previous.id === reportId && 'report' in previous
            ? { ...previous, report: { ...previous.report, grant } }
            : previous)
        } catch (err) {
          logRpcFailure('Failed to read an issue report again:', err)
        }
      }
      const [read] = await Promise.all([readAccountGrant(authenticatedApi), readReportGrant()])
      if (read !== undefined) setAccount((previous) => previous === undefined || previous.api === authenticatedApi ? read : previous)
    },
  }
}
