import { useEffect, useRef, useState } from 'react'
import { Button, Loader, Table } from '@cloudflare/kumo'
import { CaretLeft, CaretRight } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import type { AdminApi, AdminAuditPage } from '@gadgets/workshop-shared/api'
import { logRpcFailure } from '../../rpcErrors'
import { auditQueryOf, isFiltered, type AuditFilter } from './auditFilter'
import { AuditFilters } from './AuditFilters'
import { AUDIT_LOG_COLUMNS, AuditLogRow } from './AuditLogRow'

/** How many records one page of the Audit tab's log shows. */
export const AUDIT_PAGE_SIZE = 50

// The answer to one load, for the request it answered (see `request` below).
type Answer = { request: string } & ({ page: AdminAuditPage } | { failed: true })

// Identifies a filter, so that the pages turned under one are forgotten once it changes.
const filterKey = ({ admin, method, sensitivity, workspace, owner }: AuditFilter) =>
  JSON.stringify([admin, method, sensitivity, workspace, owner].map((value) => value ?? null))

/**
 * The Audit tab's log, filtered as `filter` says, one page at a time, newest first. Older pages
 * are reached through each page's cursor, and newer ones by going back through the cursors used,
 * so the pages stay put while new records arrive. A change of `filter` or of `reloads` loads again,
 * keeping what is shown until the new page answers; a change of filter starts again from the
 * newest page.
 */
export const AuditLog = ({ admin, filter, onFilterChange, adminSuggestions, reloads }: {
  admin: RpcStub<AdminApi>
  filter: AuditFilter
  onFilterChange: (filter: AuditFilter) => void
  /** Admins to offer in the admin filter. */
  adminSuggestions: string[]
  /** Increases to load the shown page again. */
  reloads: number
}) => {
  const key = filterKey(filter)
  // The cursors of the pages turned to under the current filter, oldest page last. Forgotten as
  // soon as the filter changes, during that render, so that coming back to an earlier filter
  // starts again from its newest page.
  const [turned, setTurned] = useState<{ filter: string; cursors: string[] }>({ filter: key, cursors: [] })
  if (turned.filter !== key) setTurned({ filter: key, cursors: [] })
  const [retries, setRetries] = useState(0)
  const [answer, setAnswer] = useState<Answer | null>(null)
  const cursors = turned.filter === key ? turned.cursors : []
  const cursor = cursors.at(-1)
  // Everything a load depends on, so that an answer to an earlier one is told apart.
  const request = JSON.stringify([key, cursor ?? null, reloads, retries])

  const { admin: byAdmin, method, sensitivity, workspace, owner } = filter
  useEffect(() => {
    let current = true
    const query = auditQueryOf({ admin: byAdmin, method, sensitivity, workspace, owner })
    admin.listAdminAudit({ ...query, cursor, limit: AUDIT_PAGE_SIZE }).then(
      (page) => { if (current) setAnswer({ request, page }) },
      (err: unknown) => {
        if (!current) return
        logRpcFailure('Failed to load the admin audit log:', err)
        setAnswer({ request, failed: true })
      },
    )
    return () => { current = false }
  }, [admin, byAdmin, method, sensitivity, workspace, owner, cursor, request])

  // A page stays shown, dimmed, until the load that replaces it answers.
  const page = answer !== null && 'page' in answer ? answer.page : null
  const busy = answer?.request !== request
  const failed = answer !== null && 'failed' in answer && !busy
  const nextCursor = page?.nextCursor
  const pageNumber = cursors.length + 1
  const filterBy = (added: AuditFilter) => onFilterChange({ ...filter, ...added })
  const targetSuggestions = [...new Set(page?.records.flatMap((record) =>
    record.kind === 'workspace' && record.workspaceOwner ? [record.workspaceOwner] : []))]
  const workspaceRecord = page?.records.find((record) =>
    record.kind === 'workspace' && record.workspaceId === workspace && record.workspaceTitle)
  const workspaceLabel = workspace === undefined ? undefined
    : (workspaceRecord?.kind === 'workspace' ? workspaceRecord.workspaceTitle : undefined)

  // A page button is disabled on the first or the last page, and a browser drops the focus of a
  // control that becomes disabled without giving it back. So once a turn lands there, focus moves
  // to the other page button, unless it has gone elsewhere since.
  const newerButton = useRef<HTMLButtonElement>(null)
  const olderButton = useRef<HTMLButtonElement>(null)
  const turning = useRef(false)
  const turnTo = (next: string[]) => {
    turning.current = true
    setTurned({ filter: key, cursors: next })
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

  return (
    <div className="space-y-4">
      <AuditFilters
        filter={filter}
        adminSuggestions={adminSuggestions}
        workspaceLabel={workspaceLabel}
        targetSuggestions={targetSuggestions}
        onFilterChange={onFilterChange}
      />

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
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.Head><span className="sr-only">Expand</span></Table.Head>
                  <Table.Head>Time</Table.Head>
                  <Table.Head>Admin</Table.Head>
                  <Table.Head>Action</Table.Head>
                  <Table.Head>Sensitivity</Table.Head>
                  <Table.Head className="whitespace-nowrap">Target user</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {page.records.length === 0
                  ? (
                    <Table.Row>
                      <Table.Cell colSpan={AUDIT_LOG_COLUMNS} className="py-8 text-center text-kumo-subtle">
                        {isFiltered(filter)
                          ? 'No admin activity matches these filters.'
                          : 'No admin activity is recorded yet.'}
                      </Table.Cell>
                    </Table.Row>
                  )
                  : page.records.map((record, index) => (
                    <AuditLogRow
                      key={`${cursor ?? ''}:${index}:${record.at.getTime()}`}
                      record={record}
                      onFilterBy={filterBy}
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
