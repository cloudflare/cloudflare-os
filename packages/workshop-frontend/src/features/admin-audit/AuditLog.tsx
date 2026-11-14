import { useEffect, useRef, useState } from 'react'
import { Button, Loader, Table } from '@cloudflare/kumo'
import { CaretLeft, CaretRight } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import type { AdminApi, AdminAuditPage } from '@gadgets/workshop-shared/api'
import { logRpcFailure } from '../../rpcErrors'
import type { AuditFilter } from './auditFilter'
import { AuditFilters } from './AuditFilters'
import { AUDIT_LOG_COLUMNS, AuditLogRow } from './AuditLogRow'
import { ColumnResizeHandle } from './ColumnResizeHandle'
import { useColumnWidths } from './useColumnWidths'

/** How many records one page of the Audit tab's log shows. */
export const AUDIT_PAGE_SIZE = 50

/** Where the log's column widths are kept, per browser. */
export const AUDIT_COLUMN_WIDTHS_KEY = 'gadgets:workshop:adminAuditColumnWidths'

// The log's resizable columns, by the name each is shown and announced with, and their widths
// before any is resized, in pixels. Changes is not among them: it takes the width left over, at
// least CHANGES_MIN_WIDTH, so widening one column never narrows another.
const RESIZABLE_COLUMNS = { time: 'Time', admin: 'Admin', action: 'Action', via: 'Via' } as const
type ResizableColumn = keyof typeof RESIZABLE_COLUMNS
// Sized so that, with Changes at its least, the log fits the Audit tab at a 1440 px window.
const DEFAULT_WIDTHS: Record<ResizableColumn, number> = { time: 180, admin: 160, action: 220, via: 64 }
const TOGGLE_WIDTH = 48
const CHANGES_MIN_WIDTH = 160

// The answer to one load, for the request it answered (see `request` below).
type Answer = { request: string } & ({ page: AdminAuditPage } | { failed: true })

// Identifies a filter, so that the pages turned under one are forgotten once it changes.
const filterKey = ({ admin, method }: AuditFilter) => JSON.stringify([admin ?? null, method ?? null])

/**
 * The Audit tab's log, filtered as `filter` says, one page at a time, newest first. Older pages
 * are reached through each page's cursor, and newer ones by going back through the cursors used,
 * so the pages stay put while new records arrive. A change of `filter` or of `reloads` loads again,
 * keeping what is shown until the new page answers; a change of filter starts again from the
 * newest page.
 */
export const AuditLog = ({ admin, filter, onFilterChange, adminSuggestions, reloads, restarts }: {
  admin: RpcStub<AdminApi>
  filter: AuditFilter
  onFilterChange: (filter: AuditFilter) => void
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
  const cursors = turned.filter === turnedUnder ? turned.cursors : []
  const cursor = cursors.at(-1)
  // Everything a load depends on, so that an answer to an earlier one is told apart.
  const request = JSON.stringify([key, cursor ?? null, reloads, retries])

  const { admin: byAdmin, method } = filter
  useEffect(() => {
    let current = true
    admin.listAdminAudit({ admin: byAdmin, method, cursor, limit: AUDIT_PAGE_SIZE }).then(
      (page) => { if (current) setAnswer({ request, page }) },
      (err: unknown) => {
        if (!current) return
        logRpcFailure('Failed to load the admin audit log:', err)
        setAnswer({ request, failed: true })
      },
    )
    return () => { current = false }
  }, [admin, byAdmin, method, cursor, request])

  // A page stays shown, dimmed, until the load that replaces it answers.
  const page = answer !== null && 'page' in answer ? answer.page : null
  const busy = answer?.request !== request
  const failed = answer !== null && 'failed' in answer && !busy
  const nextCursor = page?.nextCursor
  const pageNumber = cursors.length + 1

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

  const columns = useColumnWidths(AUDIT_COLUMN_WIDTHS_KEY, DEFAULT_WIDTHS)
  const tableWidth = TOGGLE_WIDTH + CHANGES_MIN_WIDTH +
    Object.values<number>(columns.widths).reduce((sum, width) => sum + width, 0)
  const head = (column: ResizableColumn) => (
    <Table.Head>
      {RESIZABLE_COLUMNS[column]}
      <ColumnResizeHandle
        column={RESIZABLE_COLUMNS[column]}
        width={columns.widths[column]}
        onResize={(width, done) => columns.setWidth(column, width, done)}
        onReset={() => columns.reset(column)}
      />
    </Table.Head>
  )

  // A row's admin button is gone once the page filtered by that admin replaces the row, so focus
  // goes to the admin field, which now shows the admin chosen, rather than drop to the page.
  const filters = useRef<HTMLDivElement>(null)
  const selectAdmin = (selected: string) => {
    onFilterChange({ ...filter, admin: selected })
    filters.current?.querySelector<HTMLInputElement>('input[role="combobox"]')?.focus()
  }

  return (
    <div className="space-y-4">
      <div ref={filters}>
        <AuditFilters filter={filter} adminSuggestions={adminSuggestions} onFilterChange={onFilterChange} />
      </div>

      {page === null && !failed && (
        <div className="flex justify-center py-12">
          <Loader size="lg" />
        </div>
      )}
      {failed && (
        <div className="py-8 text-center">
          <p role="alert" className="text-sm text-kumo-danger">Couldn’t load the admin audit log.</p>
          <Button variant="secondary" size="sm" className="mt-3" onClick={() => setRetries((n) => n + 1)}>
            Retry
          </Button>
        </div>
      )}
      {page !== null && !failed && (
        <>
          <div className={`overflow-x-auto${busy ? ' opacity-60' : ''}`} aria-busy={busy}>
            {/* Fixed, so the columns take the widths set here rather than their content's. */}
            <Table layout="fixed" style={{ minWidth: tableWidth }}>
              <colgroup>
                <col style={{ width: TOGGLE_WIDTH }} />
                <col style={{ width: columns.widths.time }} />
                <col style={{ width: columns.widths.admin }} />
                <col style={{ width: columns.widths.action }} />
                <col />
                <col style={{ width: columns.widths.via }} />
              </colgroup>
              <Table.Header>
                <Table.Row>
                  <Table.Head><span className="sr-only">Details</span></Table.Head>
                  {head('time')}
                  {head('admin')}
                  {head('action')}
                  <Table.Head>Changes</Table.Head>
                  {head('via')}
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {page.records.length === 0
                  ? (
                    <Table.Row>
                      <Table.Cell colSpan={AUDIT_LOG_COLUMNS} className="py-8 text-center text-kumo-subtle">
                        {pageNumber > 1
                          ? 'No older admin activity.'
                          : filter.admin !== undefined || filter.method !== undefined
                            ? 'No admin activity matches these filters.'
                            : 'No admin activity is recorded yet.'}
                      </Table.Cell>
                    </Table.Row>
                  )
                  : page.records.map((record, index) => (
                    <AuditLogRow
                      key={`${cursor ?? ''}:${index}:${record.at.getTime()}`}
                      record={record}
                      shaded={index % 2 === 1}
                      onAdminSelect={selectAdmin}
                    />
                  ))}
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
