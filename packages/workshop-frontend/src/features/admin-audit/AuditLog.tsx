import { useEffect, useRef, useState } from 'react'
import { Button, Loader, Table } from '@cloudflare/kumo'
import { CaretLeft, CaretRight } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import type { AdminApi, AdminAuditPage, AdminAuditRecord, AdminContentRequest } from '@gadgets/workshop-shared/api'
import { logRpcFailure } from '../../rpcErrors'
import { isFiltered, targetUserOf, type AuditFilter } from './auditFilter'
import { AuditFilters } from './AuditFilters'
import { AUDIT_LOG_COLUMNS, AuditLogRow } from './AuditLogRow'
import { ColumnResizeHandle } from './ColumnResizeHandle'
import { RequestDecision } from './RequestDecision'
import { useColumnWidths } from './useColumnWidths'

/** How many records one page of the Audit tab's log shows. */
export const AUDIT_PAGE_SIZE = 50

/** Where the log's column widths are kept, per browser. */
export const AUDIT_COLUMN_WIDTHS_KEY = 'gadgets:workshop:adminAuditColumnWidths'

// The log's resizable columns, by the name each is shown and announced with, and their widths
// before any is resized, in pixels. Action is not among them: it takes the width left over, at
// least ACTION_MIN_WIDTH, so that it is the column a narrow log cuts, never a name.
const RESIZABLE_COLUMNS = {
  time: 'Time', admin: 'Admin', kind: 'Kind', target: 'Target user',
} as const
type ResizableColumn = keyof typeof RESIZABLE_COLUMNS
// Sized so that, with Action at its least, the log fits the Audit tab at a 1440 px window, and a
// call's kind and what it exposed share a line, as a write's kind and step do. A refused call's
// third badge goes on a line below.
const DEFAULT_WIDTHS: Record<ResizableColumn, number> = { time: 170, admin: 140, kind: 240, target: 140 }
const TOGGLE_WIDTH = 48
const ACTION_MIN_WIDTH = 140

// The pending requests to read a workspace's content, by id.
type PendingRequests = Map<string, AdminContentRequest>

// The answer to one load, for the request it answered (see `request` below).
type Answer = { request: string } & ({ page: AdminAuditPage } | { failed: true })

// Identifies a filter, so that the pages turned under one are forgotten once it changes.
const filterKey = ({ admin, method, kind, workspace, owner, exposed, pending }: AuditFilter) =>
  JSON.stringify([admin, method, kind, workspace, owner, exposed, pending].map((value) => value ?? null))

// Keys that stay with their records when a load puts newer records above them, so that a row
// keeps its details open, and a decision made in them can give focus back to the row.
const rowKeys = (records: AdminAuditRecord[]) => {
  const seen = new Map<string, number>()
  return records.map((record) => {
    // A grant step names its request, which two steps of one method never share.
    const request = record.kind === 'grant' ? record.requestId : ''
    const key = `${record.at.getTime()}:${record.kind}:${record.method}:${record.admin}:${request}`
    const count = seen.get(key) ?? 0
    seen.set(key, count + 1)
    return `${key}:${count}`
  })
}

/**
 * The Audit tab's log, filtered as `filter` says, one page at a time, newest first. Older pages
 * are reached through each page's cursor, and newer ones by going back through the cursors used,
 * so the pages stay put while new records arrive. A change of `filter` or of `reloads` loads again,
 * keeping what is shown until the new page answers; a change of filter starts again from the
 * newest page. Each load also lists the content access requests, and a request still pending
 * offers its decision in its record's details.
 */
export const AuditLog = ({
  admin, userId, filter, onFilterChange, onDecided, contentLevel, adminSuggestions, reloads, restarts,
}: {
  admin: RpcStub<AdminApi>
  /** The signed-in admin, by canonical user id, once confirmed. */
  userId: string | undefined
  filter: AuditFilter
  onFilterChange: (filter: AuditFilter) => void
  /** Called once a decision on a request has settled, to load the log again. */
  onDecided: () => void
  /** Whether the level in force is Content, at which requests are made and approved: the Pending
   * filter is offered, and a pending request's Approve (see AuditFilters, RequestDecision). */
  contentLevel: boolean
  /** Admins to offer in the admin filter. */
  adminSuggestions: string[]
  /** Increases to load the shown page again (Refresh), staying on it. */
  reloads: number
  /** Increases to load the newest page (after a settings change, whose own record is there and
   * whose retention may have removed the pages turned to). */
  restarts: number
}) => {
  const key = filterKey(filter)
  // The cursors of the pages turned to under the current filter and restart, oldest page last.
  // Forgotten as soon as either changes, during that render, so that coming back to an earlier
  // filter starts again from its newest page.
  const turnedUnder = JSON.stringify([key, restarts])
  const [turned, setTurned] = useState<{ filter: string; cursors: string[] }>({ filter: turnedUnder, cursors: [] })
  if (turned.filter !== turnedUnder) setTurned({ filter: turnedUnder, cursors: [] })
  const [retries, setRetries] = useState(0)
  const [answer, setAnswer] = useState<Answer | null>(null)
  // The pending requests as one load listed them, which arrive apart from its page.
  const [listed, setListed] = useState<{ request: string; pending: PendingRequests; failed?: true } | null>(null)
  const cursors = turned.filter === turnedUnder ? turned.cursors : []
  const cursor = cursors.at(-1)
  // Everything a load depends on, so that an answer to an earlier one is told apart.
  const request = JSON.stringify([key, cursor ?? null, reloads, retries])

  const { admin: byAdmin, method, kind, workspace, owner, exposed, pending: onlyPending } = filter
  useEffect(() => {
    let current = true
    const query = {
      admin: byAdmin, method, kind, workspace, owner, exposed, pending: onlyPending, cursor, limit: AUDIT_PAGE_SIZE,
    }
    // Listed once the page has answered, which never waits for them: a listing taken after the
    // page marks every request on it still pending, where one taken before would miss a request
    // filed in between. Only the requests on the page are asked for, and none when it holds none.
    // A failed listing, as from a backend older than the requests, leaves the log as it was, with
    // no request offered for a decision.
    const listPending = (page: AdminAuditPage) => {
      const ids = page.records.flatMap((record) =>
        record.kind === 'grant' && record.method === 'requestContentAccess' ? [record.requestId] : [])
      if (ids.length === 0) {
        setListed({ request, pending: new Map() })
        return
      }
      admin.listContentAccessRequests({ pending: true, ids }).then(
        (requests) => {
          if (!current) return
          const pending = requests.filter((r) => r.state === 'pending')
          setListed({ request, pending: new Map(pending.map((r) => [r.id, r])) })
        },
        (err: unknown) => {
          if (!current) return
          logRpcFailure('Failed to list the content access requests:', err)
          setListed({ request, pending: new Map(), failed: true })
        },
      )
    }
    admin.listAdminAudit(query).then(
      (page) => {
        if (!current) return
        setAnswer({ request, page })
        listPending(page)
      },
      (err: unknown) => {
        if (!current) return
        logRpcFailure('Failed to load the admin audit log:', err)
        setAnswer({ request, failed: true })
      },
    )
    return () => { current = false }
  }, [admin, byAdmin, method, kind, workspace, owner, exposed, onlyPending, cursor, request])

  // A page stays shown, dimmed, until the load that replaces it answers.
  const page = answer !== null && 'page' in answer ? answer.page : null
  // So do the pending requests, until the listing that replaces them answers.
  const pendingRequests = listed?.pending ?? null
  const listing = listed?.request !== request
  // A page holding requests comes from a backend that has them, so a failed listing there is an
  // error, not an older backend: its requests would otherwise look as if none could be decided.
  // Said until a listing answers, a retry's included, so that Retry keeps the focus it holds.
  const listingFailed = listed?.failed === true &&
    page?.records.some((record) => record.kind === 'grant' && record.method === 'requestContentAccess')
  const keys = rowKeys(page?.records ?? [])
  const busy = answer?.request !== request
  const failed = answer !== null && 'failed' in answer && !busy
  const nextCursor = page?.nextCursor
  const pageNumber = cursors.length + 1
  // A row's name or workspace button is gone once the filtered page replaces the row, so focus goes
  // to the filter field that now shows the choice (the admin field for a workspace, whose chip comes
  // and goes) rather than drop to the page.
  const filters = useRef<HTMLDivElement>(null)
  const filterBy = (added: AuditFilter) => {
    onFilterChange({ ...filter, ...added })
    const field = added.owner !== undefined ? 'owner' : 'admin'
    filters.current?.querySelector<HTMLInputElement>(`[data-filter-field="${field}"] input[role="combobox"]`)
      ?.focus()
  }
  const targetSuggestions = [...new Set(page?.records.flatMap((record) => targetUserOf(record) ?? []))]
  // A call into a workspace, a write to one and a grant step on one name the workspace and its
  // title.
  const workspaceLabel = page?.records
    .flatMap((record) => record.kind === 'workspace' || record.kind === 'write' || record.kind === 'grant'
      ? [record] : [])
    .find(({ workspaceId, workspaceTitle }) => workspaceId === workspace && workspaceTitle)?.workspaceTitle

  // A page button is disabled on the first or the last page, and a browser drops the focus of a
  // control that becomes disabled without giving it back. So once a turn lands there, focus moves
  // to the other page button, unless it has gone elsewhere since.
  const newerButton = useRef<HTMLButtonElement>(null)
  const olderButton = useRef<HTMLButtonElement>(null)
  const turning = useRef(false)
  const turnTo = (next: string[]) => {
    turning.current = true
    setTurned({ filter: turnedUnder, cursors: next })
  }
  useEffect(() => {
    if (!turning.current || busy) return
    turning.current = false
    // Chrome drops the focus only after this runs, so a focused button that is now disabled counts
    // as focus lost.
    const focused = document.activeElement
    if (focused !== document.body && !(focused instanceof HTMLButtonElement && focused.disabled)) return
    const enabled = [newerButton.current, olderButton.current].find((button) => button && !button.disabled)
    enabled?.focus()
  }, [busy, pageNumber])

  // A decided request's row keeps focus when the load after it keeps the row (see AuditLogRow).
  // When the row is gone, focus goes to the Pending filter, or to the admin filter where Pending
  // is not offered, as below Content, and to the log's Retry when the page did not load. The page
  // must have answered, and the listing too once it has: the row loses its decision only with the
  // listing, and a page that did not load lists nothing.
  const decided = useRef(false)
  const pageRetry = useRef<HTMLButtonElement>(null)
  const decide = () => {
    decided.current = true
    onDecided()
  }
  useEffect(() => {
    if (!decided.current || busy || (listing && !failed)) return
    decided.current = false
    if (document.activeElement !== document.body) return
    const target = failed
      ? pageRetry.current
      : filters.current?.querySelector<HTMLElement>('[data-filter-field="pending"] [role="checkbox"]') ??
        filters.current?.querySelector<HTMLElement>('[data-filter-field="admin"] input[role="combobox"]')
    target?.focus()
  }, [busy, listing, failed])

  // Once a retried listing answers, Retry is gone, and focus it held goes to the log's first row,
  // or else to the admin filter, rather than drop to the page.
  const log = useRef<HTMLDivElement>(null)
  const retried = useRef(false)
  const retryListing = () => {
    if (listing) return
    retried.current = true
    setRetries((n) => n + 1)
  }
  useEffect(() => {
    if (!retried.current || listing) return
    retried.current = false
    if (listingFailed || document.activeElement !== document.body) return
    const target = log.current?.querySelector<HTMLElement>('tbody button[aria-expanded]') ??
      filters.current?.querySelector<HTMLElement>('[data-filter-field="admin"] input[role="combobox"]')
    target?.focus()
  }, [listing, listingFailed])

  const columns = useColumnWidths(AUDIT_COLUMN_WIDTHS_KEY, DEFAULT_WIDTHS)
  const tableWidth = TOGGLE_WIDTH + ACTION_MIN_WIDTH +
    Object.values<number>(columns.widths).reduce((sum, width) => sum + width, 0)
  const head = (column: ResizableColumn) => (
    <Table.Head className="whitespace-nowrap">
      {RESIZABLE_COLUMNS[column]}
      <ColumnResizeHandle
        column={RESIZABLE_COLUMNS[column]}
        width={columns.widths[column]}
        onResize={(width, done) => columns.setWidth(column, width, done)}
        onReset={() => columns.reset(column)}
      />
    </Table.Head>
  )

  return (
    <div ref={log} className="space-y-4">
      <div ref={filters}>
        <AuditFilters
          filter={filter}
          adminSuggestions={adminSuggestions}
          workspaceLabel={workspaceLabel}
          targetSuggestions={targetSuggestions}
          offerPending={contentLevel}
          onFilterChange={onFilterChange}
        />
      </div>

      {page === null && !failed && (
        <div className="flex justify-center py-12">
          <Loader size="lg" />
        </div>
      )}
      {failed && (
        <div className="py-8 text-center">
          <p role="alert" className="text-sm text-kumo-danger">Couldn’t load the admin audit log.</p>
          <Button
            ref={pageRetry}
            variant="secondary"
            size="sm"
            className="mt-3"
            onClick={() => setRetries((n) => n + 1)}
          >
            Retry
          </Button>
        </div>
      )}
      {page !== null && !failed && (
        <>
          {listingFailed && (
            <div className="flex flex-wrap items-center gap-3">
              <p role="alert" className="text-sm text-kumo-danger">
                Couldn’t load which requests are pending, so none can be approved or denied here.
              </p>
              <Button variant="secondary" size="sm" onClick={retryListing}>Retry</Button>
            </div>
          )}
          <div className={`overflow-x-auto${busy ? ' opacity-60' : ''}`} aria-busy={busy}>
            {/* Fixed, so the columns take the widths set here rather than their content's. */}
            <Table layout="fixed" style={{ minWidth: tableWidth }}>
              <colgroup>
                <col style={{ width: TOGGLE_WIDTH }} />
                <col style={{ width: columns.widths.time }} />
                <col style={{ width: columns.widths.admin }} />
                <col />
                <col style={{ width: columns.widths.kind }} />
                <col style={{ width: columns.widths.target }} />
              </colgroup>
              <Table.Header>
                <Table.Row>
                  <Table.Head><span className="sr-only">Expand</span></Table.Head>
                  {head('time')}
                  {head('admin')}
                  <Table.Head>Action</Table.Head>
                  {head('kind')}
                  {head('target')}
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {page.records.length === 0
                  ? (
                    <Table.Row>
                      <Table.Cell colSpan={AUDIT_LOG_COLUMNS} className="py-8 text-center text-kumo-subtle">
                        {pageNumber > 1
                          ? 'No older admin activity.'
                          : isFiltered(filter)
                            ? 'No admin activity matches these filters.'
                            : 'No admin activity is recorded yet.'}
                      </Table.Cell>
                    </Table.Row>
                  )
                  : page.records.map((record, index) => {
                    const pendingRequest = record.kind === 'grant' && record.method === 'requestContentAccess'
                      ? pendingRequests?.get(record.requestId)
                      : undefined
                    return (
                      <AuditLogRow
                        key={`${cursor ?? ''}:${keys[index]}`}
                        record={record}
                        shaded={index % 2 === 1}
                        decision={pendingRequest && (
                          <RequestDecision
                            admin={admin}
                            request={pendingRequest}
                            userId={userId}
                            approvable={contentLevel}
                            onDecided={decide}
                          />
                        )}
                        onFilterBy={filterBy}
                      />
                    )
                  })}
              </Table.Body>
            </Table>
          </div>
          {(pageNumber > 1 || nextCursor !== undefined) && (
            <nav className="flex items-center justify-between gap-4" aria-label="Audit log pages">
              <Button
                ref={newerButton}
                variant="secondary"
                size="sm"
                icon={CaretLeft}
                disabled={pageNumber === 1}
                onClick={() => { if (!busy) turnTo(cursors.slice(0, -1)) }}
              >
                Newer
              </Button>
              <span className="text-sm text-kumo-subtle" aria-live="polite">Page {pageNumber}</span>
              <Button
                ref={olderButton}
                variant="secondary"
                size="sm"
                disabled={nextCursor === undefined}
                onClick={() => { if (!busy && nextCursor !== undefined) turnTo([...cursors, nextCursor]) }}
              >
                Older
                <CaretRight aria-hidden="true" />
              </Button>
            </nav>
          )}
        </>
      )}
    </div>
  )
}
