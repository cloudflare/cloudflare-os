import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { Checkbox, Switch, useKumoToastManager } from '@cloudflare/kumo'
import { CaretRight, Check, Eye, Lightning, ShieldCheck } from '@phosphor-icons/react'
import { RpcStub } from 'capnweb'
import { ActionLogEntry, Overseer, WorkpieceId, actionChangeTime } from '@gadgets/workshop-shared/api'
import { ActionFailureNote } from './ActionFailureNote'
import { actionStatusLabel } from './features/actions/actionStatus'
import type {
  ActionReview,
  AutoApprovalBlocker,
  ReviewAction,
  ReviewGroup,
} from './features/actions/useActionReview'
import { GatekeeperIcon } from './components/GatekeeperIcon'
import { HookToggle } from './components/HookToggle'
import { WorkshopButton } from './components/WorkshopControls'
import { useActionHistory } from './useActionHistory'
import type { HistoryViewFilter } from './useActionHistory'
import { useAutoApproval, autoApprovalKey, type AutoApprovalEntry } from './useAutoApproval'
import { useAuthenticatedApi } from './AuthContext'
import { useAvatar } from './useAvatar'
import { useVendorBranding } from './useVendorBranding'
import { safeExternalUrl } from './utils/safeExternalUrl'
import { IncompleteDescriptionNotice, isDescriptionIncomplete } from './components/IncompleteDescriptionNotice'
import { ActionFields, entryFields, fieldCountLabel } from './components/ActionFields'
import { RestrictedApprovalNotice } from './components/RestrictedApprovalNotice'

export type ActivityView = 'review' | 'history' | 'auto'

const PANE_BAR = 'flex h-9 flex-shrink-0 items-center border-b border-kumo-line'

interface ActivityProps {
  overseer: RpcStub<Overseer>
  // True once the workspace has read restricted data (GadgetMetadata.containsRestrictedData).
  // The reviewer is then the leak check, so every batch is shown in full under a notice saying
  // so; latched actions are never auto-approved, so existing rules are shown as suspended but
  // stay revocable.
  restricted?: boolean
  view: ActivityView
  onViewChange: (view: ActivityView) => void
  /** Owned by the workspace, so drafts outlive this pane being closed. */
  review: ActionReview
  /** A request to reveal one connection's review; `request` changes on every explicit open. */
  reviewTarget?: { gatekeeperId?: WorkpieceId; request: number }
}

/** Pending-status copy while the pending set is still being gathered (also in the popover). */
export const PENDING_CHECKING_COPY = 'Checking for requests…'
/** Pending-status copy when gathering the pending set failed (also in the popover). */
export const PENDING_ERROR_COPY = 'Could not check for requests — reload the page to try again.'

const HISTORY_FILTERS: { value: HistoryViewFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'action', label: 'Actions' },
  { value: 'observation', label: 'Observations' },
  { value: 'bindHook', label: 'Hooks' },
]

function formatClockTime(date: Date): string {
  return new Date(date).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function formatFullDate(date: Date): string {
  return new Date(date).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export function formatRelativeTime(date: Date): string {
  const minutes = Math.floor(Math.max(0, Date.now() - new Date(date).getTime()) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

function dayLabel(date: Date): string {
  const value = new Date(date)
  const days = Math.round((startOfDay(new Date()) - startOfDay(value)) / 86_400_000)
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  return value.toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' })
}

function activityStatus(
  record: ActionLogEntry,
): { label: string; dotClass: string; textClass: string } {
  if (record.type === 'observation') {
    return { label: 'Observed', dotClass: 'bg-kumo-inactive', textClass: 'text-kumo-subtle' }
  }
  if (record.type === 'bindHook') {
    if (record.hookId === undefined) {
      return { label: 'Deleted', dotClass: 'bg-kumo-inactive', textClass: 'text-kumo-subtle' }
    }
    return record.enabled
      ? { label: 'Enabled', dotClass: 'bg-kumo-success', textClass: 'text-kumo-subtle' }
      : { label: 'Disabled', dotClass: 'bg-kumo-inactive', textClass: 'text-kumo-subtle' }
  }
  const label = actionStatusLabel(record)
  if (record.state === 'pending') {
    return { label, dotClass: 'bg-kumo-brand', textClass: 'text-kumo-strong' }
  }
  if (record.state === 'rejected') {
    return { label, dotClass: 'bg-kumo-danger', textClass: 'text-kumo-danger' }
  }
  return { label, dotClass: 'bg-kumo-success', textClass: 'text-kumo-subtle' }
}

// A cascade-invalidated action inherits the resolver of the rejection that took it down, so it must
// not read as a direct decision on this action.
function resolverLabel(record: ActionLogEntry, name: string): string {
  if (record.type !== 'action') return `By ${name}`
  if (record.cascadedFrom !== undefined) return `Invalidated by ${name}'s earlier rejection`
  return record.autoApproved === true ? `Auto-approved (${name}'s rule)` : `By ${name}`
}

function TypeIcon({ record, className }: { record: ActionLogEntry; className?: string }) {
  const props = { size: 13, weight: 'bold' as const, className }
  if (record.type === 'observation') return <Eye {...props} />
  if (record.type === 'bindHook') return <Lightning {...props} />
  return <ShieldCheck {...props} />
}

function LoadOlderButton({ history, className, label = 'Load older' }: {
  history: { loadMore: () => void; isLoadingMore: boolean }
  className?: string
  label?: string
}) {
  return (
    <WorkshopButton className={className} onClick={history.loadMore}
        disabled={history.isLoadingMore}>
      {history.isLoadingMore ? 'Loading…' : label}
    </WorkshopButton>
  )
}

/** Centered full-pane notice: an empty, error, or call-to-action state. */
function ActivityNotice({ icon, title, description, children }: {
  icon?: ReactNode
  title: string
  description?: string
  children?: ReactNode
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
      {icon && (
        <span className="mb-3 grid h-9 w-9 place-items-center rounded-full bg-kumo-tint text-kumo-subtle">
          {icon}
        </span>
      )}
      <p className="m-0 text-[13px] font-medium leading-[18px] tracking-[-0.25px] text-kumo-default">
        {title}
      </p>
      {description && (
        <p className="mt-1 max-w-xs text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle">
          {description}
        </p>
      )}
      {children}
    </div>
  )
}

export default function Activity({
  overseer,
  restricted,
  view,
  onViewChange,
  review,
  reviewTarget,
}: ActivityProps) {
  const [historyFilter, setHistoryFilter] = useState<HistoryViewFilter>('all')
  const [togglingHooks, setTogglingHooks] = useState<Set<number>>(new Set())
  const [expandedActionId, setExpandedActionId] = useState<number | null>(null)
  const toasts = useKumoToastManager()
  const reviewHeadingRef = useRef<HTMLHeadingElement>(null)
  const groupHeadings = useRef(new Map<WorkpieceId, HTMLElement>())
  const revealedRequest = useRef<number>(undefined)

  const history = useActionHistory(overseer, historyFilter, view === 'history')

  // Grouped by day in id order (newest first). A day label can repeat when resolution order
  // differs from creation order — accepted for a paged, creation-ordered log.
  const historyGroups = useMemo(() => {
    const groups: { label: string; records: ActionLogEntry[] }[] = []
    for (const record of history.entries) {
      const label = dayLabel(actionChangeTime(record))
      const last = groups.at(-1)
      if (last?.label === label) last.records.push(record)
      else groups.push({ label, records: [record] })
    }
    return groups
  }, [history.entries])

  const handleToggleHook = async (hookId: number, enabled: boolean) => {
    setTogglingHooks(previous => new Set(previous).add(hookId))
    try {
      if (enabled) await overseer.enableHook(hookId)
      else await overseer.disableHook(hookId)
    } catch (error) {
      console.error('Failed to toggle hook:', error)
      toasts.add({ title: `Failed to ${enabled ? 'enable' : 'disable'} hook`, variant: 'error' })
    } finally {
      setTogglingHooks(previous => {
        const next = new Set(previous)
        next.delete(hookId)
        return next
      })
    }
  }

  // Reveal the connection a chat card or notification asked about, once its rows are loaded. A
  // settled request is consumed either way, so a connection with nothing left pending falls back
  // to the review heading and an empty review can't fire at a later arrival.
  useEffect(() => {
    if (view !== 'review' || reviewTarget === undefined) return
    if (revealedRequest.current === reviewTarget.request || review.status === 'checking') return
    revealedRequest.current = reviewTarget.request
    const heading = (reviewTarget.gatekeeperId !== undefined
      ? groupHeadings.current.get(reviewTarget.gatekeeperId)
      : undefined) ?? reviewHeadingRef.current
    heading?.scrollIntoView({ block: 'nearest' })
    heading?.focus({ preventScroll: true })
  }, [view, reviewTarget, review.status, review.groups])

  const toggleExpanded = (id: number) => {
    setExpandedActionId(previous => (previous === id ? null : id))
  }

  const registerHeading = (gatekeeperId: WorkpieceId, node: HTMLElement | null) => {
    if (node === null) groupHeadings.current.delete(gatekeeperId)
    else groupHeadings.current.set(gatekeeperId, node)
  }

  function renderReviewContent(): ReactNode {
    const { groups, unavailable, status } = review
    if (groups.length > 0 || unavailable.length > 0) {
      return (
        <>
          <div className="flex-shrink-0 border-b border-kumo-line px-5 py-2">
            <h2
              ref={reviewHeadingRef}
              tabIndex={-1}
              className="m-0 text-[12.5px] font-medium leading-[17px] tracking-[-0.15px] text-kumo-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring"
            >
              Review requests
            </h2>
            <p className="m-0 mt-0.5 text-[11.5px] leading-4 tracking-[-0.1px] text-kumo-inactive">
              Veto selections are saved only when you apply the batch. Pending actions can still
              be resolved by {restricted ? 'other reviewers' : 'auto-approval rules or other reviewers'}.
            </p>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {groups.map(group => (
              <ReviewConnection
                key={group.gatekeeperId}
                group={group}
                review={review}
                restricted={restricted}
                expandedActionId={expandedActionId}
                onToggleExpanded={toggleExpanded}
                registerHeading={registerHeading}
              />
            ))}
            {unavailable.map(record => (
              <article key={record.id} className="border-b border-kumo-line px-5 py-3">
                <h3 className="m-0 truncate text-[13px] font-medium leading-[18px] tracking-[-0.25px] text-kumo-default">
                  {record.description.title}
                </h3>
                <p className="m-0 mt-0.5 text-[12px] leading-4 text-kumo-inactive">
                  This action’s connection is unavailable. Reload to check its status.
                </p>
              </article>
            ))}
            {status === 'checking' && (
              <p className="m-0 px-5 py-3 text-center text-[12px] leading-4 text-kumo-inactive">
                Still checking older activity…
              </p>
            )}
            {status === 'error' && (
              <p className="m-0 px-5 py-3 text-center text-[12px] leading-4 text-kumo-inactive">
                Could not finish checking for requests — reload the page to try again.
              </p>
            )}
          </div>
        </>
      )
    }

    if (status === 'checking') {
      return (
        <div className="flex flex-1 items-center justify-center text-[13px] text-kumo-subtle">
          {PENDING_CHECKING_COPY}
        </div>
      )
    }

    if (status === 'error') {
      return (
        <ActivityNotice
          title="Could not check for requests"
          description="Reload the page to try again."
        />
      )
    }

    return (
      <ActivityNotice
        icon={<Check size={17} weight="bold" />}
        title="Nothing to review"
        description="Requests that need your approval show up here and in the workspace header."
      >
        <WorkshopButton className="mt-4" onClick={() => onViewChange('history')}>
          View history
        </WorkshopButton>
      </ActivityNotice>
    )
  }

  function renderHistoryBody(): ReactNode {
    if (history.entries.length > 0) {
      return (
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="grid grid-cols-[54px_minmax(0,1fr)_auto_16px] items-center gap-3 border-b border-kumo-line bg-kumo-elevated/50 px-5 py-1.5 text-[11px] font-medium uppercase tracking-[0.06em] text-kumo-inactive">
            <span>Time</span>
            <span>Event</span>
            <span>Status</span>
            <span />
          </div>
          {historyGroups.map(group => (
            // Keyed by the group's oldest record: live inserts land at the front of a group, so
            // keying by the first would remount the section (dropping focus) on every insert.
            // Day labels can repeat (see historyGroups), so the label alone can't be the key.
            <section key={group.records.at(-1)!.id}>
              <h3 className="sticky top-0 m-0 border-b border-kumo-line bg-kumo-base/90 px-5 py-1 text-[11px] font-medium uppercase tracking-[0.06em] text-kumo-inactive backdrop-blur-sm">
                {group.label}
              </h3>
              {group.records.map(record => (
                <HistoryRow
                  key={record.id}
                  record={record}
                  expanded={expandedActionId === record.id}
                  onToggle={() => toggleExpanded(record.id)}
                  togglingHook={record.type === 'bindHook' && record.hookId !== undefined
                    ? togglingHooks.has(record.hookId)
                    : false}
                  onToggleHook={handleToggleHook}
                />
              ))}
            </section>
          ))}
          {history.loadMoreFailed ? (
            <div className="flex items-center justify-center gap-3 py-3">
              <span className="text-[12px] leading-4 text-kumo-inactive">
                Couldn't load older activity
              </span>
              <LoadOlderButton history={history} label="Retry" />
            </div>
          ) : history.hasMore && (
            <div className="flex justify-center py-3">
              <LoadOlderButton history={history} />
            </div>
          )}
        </div>
      )
    }

    if (history.status === 'error') {
      return (
        <ActivityNotice title="Could not load activity">
          <LoadOlderButton className="mt-4" history={history} label="Retry" />
        </ActivityNotice>
      )
    }

    if (history.status === 'loading') {
      return (
        <div className="flex flex-1 items-center justify-center text-[13px] text-kumo-subtle">
          Loading activity…
        </div>
      )
    }

    if (history.hasMore) {
      return (
        <ActivityNotice title="Nothing in the most recent activity">
          <LoadOlderButton className="mt-4" history={history} />
        </ActivityNotice>
      )
    }

    if (historyFilter === 'all') {
      return (
        <ActivityNotice
          title="No activity yet"
          description="Every resource an agent reads or changes is recorded here."
        />
      )
    }

    return (
      <ActivityNotice title="No matching events">
        <button
          type="button"
          onClick={() => setHistoryFilter('all')}
          className="mt-1.5 cursor-pointer text-[12px] font-medium text-kumo-subtle hover:text-kumo-default"
        >
          Show all activity
        </button>
      </ActivityNotice>
    )
  }

  function renderActivityContent(): ReactNode {
    switch (view) {
      case 'review':
        return renderReviewContent()
      case 'history':
        return (
          <>
            <div className={`${PANE_BAR} gap-1 px-3`}>
              {HISTORY_FILTERS.map(filter => (
                <button
                  key={filter.value}
                  type="button"
                  onClick={() => setHistoryFilter(filter.value)}
                  className={`flex h-6 cursor-pointer items-center rounded-md px-2 text-[12.5px] font-medium tracking-[-0.15px] transition-colors ${
                    historyFilter === filter.value
                      ? 'bg-kumo-tint text-kumo-default'
                      : 'text-kumo-subtle hover:text-kumo-default'
                  }`}
                >
                  {filter.label}
                </button>
              ))}
              <span className="ml-auto pr-2 text-[11.5px] leading-[17px] tabular-nums text-kumo-inactive">
                {history.entries.length} loaded
              </span>
            </div>
            {renderHistoryBody()}
          </>
        )
      case 'auto':
        return (
          <AutoApprovalPanel
            overseer={overseer}
            restricted={restricted}
            pendingActions={review.pending}
            blockedConnections={review.blockedAutoApprovalConnections}
          />
        )
    }
  }

  return (
    <div className="flex h-full flex-col bg-kumo-base">
      {renderActivityContent()}
    </div>
  )
}

function AutoApprovalPanel({
  overseer,
  restricted,
  pendingActions,
  blockedConnections,
}: {
  overseer: RpcStub<Overseer>
  restricted?: boolean
  pendingActions: readonly ActionLogEntry[]
  blockedConnections: ReadonlyMap<WorkpieceId, AutoApprovalBlocker>
}) {
  const { entries, isLoading, loadError, pending, refresh, setEnabled } =
    useAutoApproval(overseer, pendingActions)
  const { authenticatedApi } = useAuthenticatedApi()
  const vendorBranding = useVendorBranding(authenticatedApi)

  const groups = useMemo(() => {
    const byConnection = new Map<
      number,
      { gatekeeperId: number; title: string; vendorId?: string; entries: AutoApprovalEntry[] }
    >()
    for (const entry of entries) {
      const group = byConnection.get(entry.gatekeeperId)
      if (group) group.entries.push(entry)
      else {
        byConnection.set(entry.gatekeeperId, {
          gatekeeperId: entry.gatekeeperId,
          title: entry.resourceTitle,
          vendorId: entry.vendorId,
          entries: [entry],
        })
      }
    }
    for (const group of byConnection.values()) {
      group.title ||= 'Unavailable connection'
      group.entries = group.entries.toSorted((a, b) =>
        a.actionKind.label.localeCompare(b.actionKind.label))
    }
    return [...byConnection.values()].toSorted((a, b) => a.title.localeCompare(b.title))
  }, [entries])

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-[13px] text-kumo-subtle">
        Loading auto-approval…
      </div>
    )
  }

  if (entries.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
        <p className="m-0 text-[13px] font-medium leading-[18px] tracking-[-0.25px] text-kumo-default">
          {loadError ? 'Could not load auto-approval' : 'Nothing can run automatically'}
        </p>
        <p className="mt-1 max-w-xs text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle">
          {loadError
            ? 'The current rules may be incomplete. Try loading them again.'
            : 'Action types appear here once a connected resource offers one its author marked safe to apply without review.'}
        </p>
        {loadError && (
          <WorkshopButton className="mt-4" onClick={() => void refresh()}>
            Retry
          </WorkshopButton>
        )}
      </div>
    )
  }

  return (
    <>
      <div className={`${PANE_BAR} gap-3 px-5`}>
        <p className="m-0 min-w-0 flex-1 truncate text-[12.5px] leading-[17px] tracking-[-0.2px] text-kumo-subtle">
          {loadError
            ? 'Some auto-approval options could not be loaded.'
            : 'Enabling a rule may immediately apply matching pending actions and allows future '
              + 'matching actions without review. Stopped actions still need explicit review.'}
        </p>
        {loadError && (
          <button
            type="button"
            onClick={() => void refresh()}
            className="cursor-pointer text-[12px] font-medium text-kumo-default hover:text-kumo-default-hover"
          >
            Retry
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {groups.map(group => (
          <section key={group.gatekeeperId}>
            <div className="sticky top-0 flex items-center gap-2 border-b border-kumo-line bg-kumo-base/90 px-5 py-1.5 backdrop-blur-sm">
              <GatekeeperIcon
                vendorId={group.vendorId}
                {...(group.vendorId ? vendorBranding.get(group.vendorId) : undefined)}
                fallbackText={group.title}
                size={12}
                className="h-5 w-5 rounded-md [&>img]:p-px"
              />
              <h3 className="m-0 min-w-0 truncate text-[12px] font-medium leading-4 tracking-[-0.2px] text-kumo-subtle">
                {group.title}
              </h3>
            </div>
            {group.entries.map(entry => {
              const key = autoApprovalKey(entry)
              const busy = pending.has(key)
              // Revoking a rule is always allowed; granting one while the user is mid-review
              // would apply rows they are still deciding about.
              const blocker = entry.enabled ? undefined : blockedConnections.get(entry.gatekeeperId)
              return (
                <div
                  key={key}
                  className="flex w-full items-center gap-3 border-b border-kumo-line/60 px-5 py-2.5 text-left"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-default">
                      {entry.actionKind.label}
                    </span>
                    <span className="mt-0.5 block text-[12px] leading-4 tracking-[-0.2px] text-kumo-inactive">
                      {restricted
                        // Rules don't apply while restricted; say so, but keep them revocable.
                        ? "Won't apply: this workspace has read sensitive data, so actions always require manual approval."
                        : blocker !== undefined
                          ? AUTO_APPROVAL_BLOCKED[blocker]
                          : entry.orphaned
                            ? 'This connection no longer offers this action; the rule still applies.'
                            : entry.enabled
                              ? 'Applied without asking'
                              : 'Waits for your approval'}
                    </span>
                  </span>
                  <Switch
                    size="sm"
                    checked={entry.enabled}
                    // A rule never fires while restricted, so enabling one is pointless; disabling
                    // must stay possible.
                    disabled={busy || blocker !== undefined || (restricted === true && !entry.enabled)}
                    aria-label={`${entry.enabled ? 'Disable' : 'Enable'} auto-approval for ${entry.actionKind.label}`}
                    onCheckedChange={enabled => {
                      if (enabled && blocker !== undefined) return
                      void setEnabled(entry, enabled)
                    }}
                  />
                </div>
              )
            })}
          </section>
        ))}
      </div>
    </>
  )
}

const AUTO_APPROVAL_BLOCKED: Record<AutoApprovalBlocker, string> = {
  vetoed: 'Apply this connection’s batch or clear its veto selections before enabling auto-approval.',
  applying: 'Wait for this connection’s batch to finish before enabling auto-approval.',
}

/** Shared by a group's column header and its rows, so every Veto box lands in one column. */
const REVIEW_ROW = 'grid grid-cols-[minmax(0,1fr)_3rem] items-start gap-x-3'

/** One connection's frozen batch: its reviewed rows, its arrivals, and its single Apply. */
function ReviewConnection({
  group,
  review,
  restricted,
  expandedActionId,
  onToggleExpanded,
  registerHeading,
}: {
  group: ReviewGroup
  review: ActionReview
  // While restricted the reviewer is the leak check: every row is shown in full, under a notice
  // saying so that Apply names as its description.
  restricted?: boolean
  expandedActionId: number | null
  onToggleExpanded: (id: number) => void
  registerHeading: (gatekeeperId: WorkpieceId, node: HTMLElement | null) => void
}) {
  const locked = !review.canEdit || group.applying
  const applyCount = group.actions.length - group.vetoIds.length
  const vetoCount = group.vetoIds.length
  const newCount = group.newActions.length
  const resourceUrl = safeExternalUrl(group.resourceUrl)
  const noticeId = useId()

  return (
    <section className="border-b border-kumo-line">
      <div className="sticky top-0 z-[1] flex flex-wrap items-baseline gap-x-2 border-b border-kumo-line bg-kumo-base/90 px-5 py-1.5 backdrop-blur-sm">
        <h3
          ref={node => registerHeading(group.gatekeeperId, node)}
          tabIndex={-1}
          className="m-0 min-w-0 truncate text-[12px] font-medium leading-4 tracking-[-0.2px] text-kumo-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring"
        >
          {resourceUrl ? (
            <a
              href={resourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-kumo-default hover:underline"
            >
              {group.resourceTitle}
            </a>
          ) : group.resourceTitle}
        </h3>
      </div>

      {restricted && <RestrictedApprovalNotice id={noticeId} className="mx-5 my-2 max-w-2xl" />}

      {group.actions.length > 0 && (
        <div className={`${REVIEW_ROW} border-t border-kumo-line/60 px-5 py-1 text-[11px] font-medium uppercase tracking-[0.06em] text-kumo-inactive`}>
          <span>Action</span>
          <span className="text-center">Veto</span>
        </div>
      )}

      {group.actions.map(record => (
        <ReviewRequest
          key={record.id}
          record={record}
          connectionTitle={group.resourceTitle}
          restricted={restricted}
          expanded={expandedActionId === record.id}
          vetoed={group.vetoIds.includes(record.id)}
          disabled={locked}
          onToggle={() => onToggleExpanded(record.id)}
          onVetoChange={vetoed => review.setVeto(group.gatekeeperId, record.id, vetoed)}
        />
      ))}

      {newCount > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-t border-kumo-line/60 px-5 py-2">
          <span className="text-[12px] leading-4 tracking-[-0.2px] text-kumo-subtle">
            {newCount} new {newCount === 1 ? 'action' : 'actions'} arrived since you opened this
          </span>
          <WorkshopButton
            disabled={locked}
            onClick={() => review.includeNewActions(group.gatekeeperId)}
          >
            Include
          </WorkshopButton>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-kumo-line/60 px-5 py-2.5">
        <p aria-live="polite" className="m-0 text-[12px] leading-4 tracking-[-0.2px] text-kumo-subtle">
          {`${applyCount} ${applyCount === 1 ? 'action' : 'actions'} to apply`
            + (vetoCount > 0 ? ` · ${vetoCount} ${vetoCount === 1 ? 'veto' : 'vetoes'}` : '')}
        </p>
        <WorkshopButton
          tone="primary"
          className="ml-auto"
          disabled={locked || group.actions.length === 0}
          aria-describedby={restricted ? noticeId : undefined}
          onClick={() => void review.applyBatch(group.gatekeeperId)}
        >
          {group.applying ? 'Applying…' : 'Apply batch'}
        </WorkshopButton>
      </div>

      {group.error !== undefined && (
        <p role="alert" className="m-0 px-5 pb-2.5 text-[12px] leading-4 text-kumo-danger">
          {group.error}
        </p>
      )}
    </section>
  )
}

const titleClass = 'm-0 truncate text-[13px] font-medium leading-[18px] tracking-[-0.25px] text-kumo-default'

function ReviewRequest({
  record,
  connectionTitle,
  restricted,
  expanded,
  vetoed,
  disabled,
  onToggle,
  onVetoChange,
}: {
  record: ReviewAction
  connectionTitle: string
  restricted?: boolean
  expanded: boolean
  vetoed: boolean
  disabled: boolean
  onToggle: () => void
  onVetoChange: (vetoed: boolean) => void
}) {
  const fields = entryFields(record)
  return (
    <article className={`${REVIEW_ROW} border-t border-kumo-line/60 px-5 py-2.5 transition-colors hover:bg-kumo-elevated/50`}>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-2">
          {restricted ? (
            // Everything expanding would reveal is already shown, so there is no disclosure.
            <h4 className={titleClass}>{record.description.title}</h4>
          ) : (
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={expanded}
              className="flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring"
            >
              <h4 className={titleClass}>{record.description.title}</h4>
              <CaretRight
                size={11}
                className={`flex-shrink-0 text-kumo-inactive transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}
              />
            </button>
          )}
          <span className="flex-shrink-0 text-[11.5px] leading-4 tracking-[-0.1px] text-kumo-inactive">
            {formatRelativeTime(record.createdAt)}
          </span>
        </div>

        {record.description.description && (
          <p className={`m-0 mt-1 max-w-2xl whitespace-pre-wrap text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle ${restricted || expanded ? '' : 'line-clamp-2'}`}>
            {record.description.description}
          </p>
        )}
        {fields.length > 0 && (restricted || expanded ? (
          <ActionFields fields={fields} uncapped={restricted} className="mt-2 max-w-2xl" />
        ) : (
          <p className="m-0 mt-1 text-[11.5px] leading-4 tracking-[-0.1px] text-kumo-inactive">
            {fieldCountLabel(fields.length)}
          </p>
        ))}
        {isDescriptionIncomplete(record) && (
          <IncompleteDescriptionNotice className="mt-2 max-w-2xl" />
        )}
        {record.failure !== undefined && (
          <>
            <ActionFailureNote failure={record.failure} />
            <p className="m-0 mt-1 text-[11.5px] leading-4 tracking-[-0.1px] text-kumo-inactive">
              Select Veto to skip it, or apply again to retry.
            </p>
          </>
        )}
      </div>

      <span className="flex justify-center pt-px">
        <Checkbox
          aria-label={`Veto ${record.description.title} on ${connectionTitle}`}
          checked={vetoed}
          disabled={disabled}
          onCheckedChange={onVetoChange}
        />
      </span>
    </article>
  )
}

function HistoryRow({
  record,
  expanded,
  onToggle,
  togglingHook,
  onToggleHook,
}: {
  record: ActionLogEntry
  expanded: boolean
  onToggle: () => void
  togglingHook: boolean
  onToggleHook: (hookId: number, enabled: boolean) => void
}) {
  const resourceUrl = safeExternalUrl(record.resourceUrl)
  const resolvedBy = record.type === 'action' ? record.resolvedBy : undefined
  const at = actionChangeTime(record)
  const status = activityStatus(record)

  return (
    <div className={expanded ? 'bg-kumo-elevated/30' : ''}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="group grid w-full cursor-pointer grid-cols-[54px_minmax(0,1fr)_auto_16px] items-center gap-3 border-b border-kumo-line/70 px-5 py-[7px] text-left transition-colors hover:bg-kumo-elevated/50"
      >
        <time className="text-[11.5px] tabular-nums leading-4 text-kumo-inactive">
          {formatClockTime(at)}
        </time>
        <span className="flex min-w-0 items-center gap-2">
          <TypeIcon record={record} className="flex-shrink-0 text-kumo-inactive" />
          <span className="truncate text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-default">
            {record.description.title}
          </span>
          <span className="hidden flex-shrink-0 truncate text-[12px] leading-4 tracking-[-0.1px] text-kumo-inactive sm:inline">
            {record.resourceTitle}
          </span>
        </span>
        <span className={`flex items-center gap-1.5 text-[11.5px] font-medium ${status.textClass}`}>
          <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${status.dotClass}`} />
          {status.label}
        </span>
        <CaretRight
          size={12}
          className={`text-kumo-inactive transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}
        />
      </button>

      {expanded && (
        <div className="border-b border-kumo-line/70 px-5 pb-3 pl-[86px] pt-1">
          {record.description.description && (
            <p className="m-0 whitespace-pre-wrap text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle">
              {record.description.description}
            </p>
          )}
          <ActionFields fields={entryFields(record)} className="mt-2 max-w-2xl" />
          {record.type === 'action' && record.failure && (
            <ActionFailureNote failure={record.failure} />
          )}
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11.5px] text-kumo-inactive">
            <span>{formatFullDate(at)}</span>
            <span className="text-kumo-subtle">{record.resourceTitle}</span>
            {resolvedBy && (
              <ResolverBadge profileId={resolvedBy.id}>
                {resolverLabel(record, resolvedBy.name)}
              </ResolverBadge>
            )}
            {resourceUrl && (
              <a
                href={resourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-kumo-subtle hover:text-kumo-default hover:underline"
              >
                Open resource
              </a>
            )}
            {record.type === 'bindHook' && record.hookId !== undefined && (
              <HookToggle
                enabled={record.enabled}
                disabled={togglingHook}
                onToggle={enabled => onToggleHook(record.hookId!, enabled)}
              />
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function ResolverBadge({ profileId, children }: { profileId: string; children: ReactNode }) {
  const { authenticatedApi } = useAuthenticatedApi()
  const avatarUrl = useAvatar(authenticatedApi, profileId)
  return (
    <span className="flex min-w-0 items-center gap-1 text-kumo-subtle">
      {avatarUrl && (
        <img src={avatarUrl} alt="" className="h-3.5 w-3.5 flex-shrink-0 rounded-full object-cover" />
      )}
      <span className="truncate">{children}</span>
    </span>
  )
}
