import { useMemo, useState, type ReactNode } from 'react'
import { useKumoToastManager } from '@cloudflare/kumo'
import { CaretRight, Check, Eye, Lightning, ShieldCheck } from '@phosphor-icons/react'
import { RpcStub } from 'capnweb'
import { ActionLogEntry, Overseer, actionChangeTime } from '@gadgets/workshop-shared/api'
import { HookToggle, hookToggleFailureToast } from './components/HookToggle'
import { WorkshopButton } from './components/WorkshopControls'
import { useActions } from './useActions'
import { useActionHistory } from './useActionHistory'
import type { HistoryViewFilter } from './useActionHistory'
import { useAuthenticatedApi } from './AuthContext'
import { useAvatar } from './useAvatar'
import { useResolveAction } from './useResolveAction'
import { safeExternalUrl } from './utils/safeExternalUrl'
import { ReviewRequest } from './features/approvals/ReviewRequest'
import { ActionFields, entryFields } from './components/ActionFields'
import { StagedChangesBar } from './features/approvals/StagedChangesBar'
import {
  awaitsSave, chatBranchPending, unsavedConnections,
} from './features/approvals/pendingChangeGroups'
import type { ChatWithChanges } from './features/approvals/chatsWithChanges'

export type ActivityView = 'review' | 'history'

const PANE_BAR = 'flex h-9 flex-shrink-0 items-center border-b border-kumo-line'

interface ActivityProps {
  overseer: RpcStub<Overseer>
  // True once the workspace has read restricted data (WorkspaceMetadata.containsRestrictedData).
  // Every request is then reviewed in full.
  restricted?: boolean
  view: ActivityView
  onViewChange: (view: ActivityView) => void
  // A chat's requests are accepted with its changes, so the review tab lists each chat with
  // changes waiting, which opens in the chat panel, and what staging holds.
  chats: readonly ChatWithChanges[]
  onOpenChat: (chatId: number) => void
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
  if (record.state === 'pending') {
    // Accepted while its resource was unsaved, and waiting on the resource being saved.
    if (record.accepted) {
      return { label: 'Accepted', dotClass: 'bg-kumo-brand', textClass: 'text-kumo-strong' }
    }
    return { label: 'Pending', dotClass: 'bg-kumo-brand', textClass: 'text-kumo-strong' }
  }
  if (record.state === 'rejected') {
    return { label: 'Denied', dotClass: 'bg-kumo-danger', textClass: 'text-kumo-danger' }
  }
  return { label: 'Approved', dotClass: 'bg-kumo-success', textClass: 'text-kumo-subtle' }
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
  chats,
  onOpenChat,
}: ActivityProps) {
  const { status: pendingStatus, pending: pendingActions } = useActions(overseer)
  const [historyFilter, setHistoryFilter] = useState<HistoryViewFilter>('all')
  const [processingActions, setProcessingActions] = useState<Set<number>>(new Set())
  const [togglingHooks, setTogglingHooks] = useState<Set<number>>(new Set())
  const [expandedActionId, setExpandedActionId] = useState<number | null>(null)

  const toasts = useKumoToastManager()

  const history = useActionHistory(overseer, historyFilter, view === 'history')
  const unsavedResources = useMemo(() => unsavedConnections(pendingActions), [pendingActions])

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

  const { resolveAction, creationAccountModal } = useResolveAction(overseer, setProcessingActions)

  const handleToggleHook = async (hookId: number, enabled: boolean) => {
    setTogglingHooks(previous => new Set(previous).add(hookId))
    try {
      if (enabled) await overseer.enableHook(hookId)
      else await overseer.disableHook(hookId)
    } catch (error) {
      console.error('Failed to toggle hook:', error)
      toasts.add(hookToggleFailureToast(enabled, error))
    } finally {
      setTogglingHooks(previous => {
        const next = new Set(previous)
        next.delete(hookId)
        return next
      })
    }
  }

  const toggleExpanded = (id: number) => {
    setExpandedActionId(previous => (previous === id ? null : id))
  }

  function renderNothingToReview(): ReactNode {
    if (pendingStatus === 'checking') {
      return (
        <div className="flex flex-1 items-center justify-center text-[13px] text-kumo-subtle">
          {PENDING_CHECKING_COPY}
        </div>
      )
    }

    if (pendingStatus === 'error') {
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
      >
        <WorkshopButton className="mt-4" onClick={() => onViewChange('history')}>
          View history
        </WorkshopButton>
      </ActivityNotice>
    )
  }

  // A chat's requests are accepted with its code, in the chat, so the review tab lists the chats
  // rather than their requests. What staging holds belongs to no chat, so it is reviewed here:
  // accepted or discarded as a whole, or denied one at a time.
  //
  // A resource an agent created stays unsaved after its chat is accepted, with the changes
  // accepted on it, until someone saves it to an account. It has left the chat, so it is saved
  // here, and what was accepted on it can still be denied.
  function renderReviewContent(): ReactNode {
    const staged = chatBranchPending(pendingActions, null)
    const unsaved = unsavedResources
    const toSave = [...unsaved.values()].flatMap(creation => {
      const accepted = pendingActions.filter(record =>
        record.gatekeeperId === creation.gatekeeperId && record.id !== creation.id &&
        awaitsSave(record, unsaved))
      return awaitsSave(creation, unsaved) || accepted.length > 0 ? [{ creation, accepted }] : []
    })
    const count = chats.length + (staged.length > 0 ? 1 : 0) + toSave.length
    if (count === 0) {
      return renderNothingToReview()
    }
    return (
      <>
        <div className={`${PANE_BAR} gap-2 px-5`}>
          <span className="text-[12.5px] font-medium leading-[17px] tracking-[-0.15px] text-kumo-default">
            {count} with changes to review
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {staged.length > 0 && (
            <section aria-label="Held changes">
              <StagedChangesBar
                overseer={overseer}
                requests={staged}
                blocked={pendingStatus === 'ready' ? undefined
                  : pendingStatus === 'error' ? PENDING_ERROR_COPY : PENDING_CHECKING_COPY}
              />
              {staged.map(record => (
                <div key={record.id}>
                  {record.type === 'action' && record.applyError && (
                    <p role="alert" className="m-0 px-5 pt-2 text-[11.5px] leading-4 text-kumo-danger">
                      Could not apply: {record.applyError.message}
                    </p>
                  )}
                  <ReviewRequest
                    record={record}
                    restricted={restricted}
                    expanded={expandedActionId === record.id}
                    processing={processingActions.has(record.id)}
                    onToggle={() => toggleExpanded(record.id)}
                    decide={{ onReject: () => void resolveAction(record, 'deny') }}
                  />
                </div>
              ))}
            </section>
          )}
          {toSave.length > 0 && (
            <section aria-label="Unsaved resources">
              <h3 className="sticky top-0 m-0 border-b border-kumo-line bg-kumo-base/90 px-5 py-1 text-[11px] font-medium uppercase tracking-[0.06em] text-kumo-inactive backdrop-blur-sm">
                Unsaved resources
              </h3>
              {toSave.map(({ creation, accepted }) => (
                <div key={creation.id}>
                  <ReviewRequest
                    record={creation}
                    restricted={restricted}
                    expanded={expandedActionId === creation.id}
                    processing={processingActions.has(creation.id)}
                    onToggle={() => toggleExpanded(creation.id)}
                    decide={{
                      onApprove: awaitsSave(creation, unsaved)
                        ? () => void resolveAction(creation, 'approve')
                        : undefined,
                      approveLabel: 'Save to account',
                      onReject: () => void resolveAction(creation, 'deny'),
                    }}
                  />
                  {accepted.map(record => (
                    <div key={record.id} className="pl-4">
                      {record.type === 'action' && record.accepted && (
                        <p className="m-0 px-5 pt-2 text-[11.5px] leading-4 text-kumo-inactive">
                          {record.accepted.autoApproved
                            ? `Accepted automatically for ${record.accepted.by.name}`
                            : `Accepted by ${record.accepted.by.name}`}
                        </p>
                      )}
                      <ReviewRequest
                        record={record}
                        restricted={restricted}
                        showResource={false}
                        expanded={expandedActionId === record.id}
                        processing={processingActions.has(record.id)}
                        onToggle={() => toggleExpanded(record.id)}
                        decide={{ onReject: () => void resolveAction(record, 'deny') }}
                      />
                    </div>
                  ))}
                </div>
              ))}
            </section>
          )}
          {chats.length > 0 && (
            <section>
              <h3 className="sticky top-0 m-0 border-b border-kumo-line bg-kumo-base/90 px-5 py-1 text-[11px] font-medium uppercase tracking-[0.06em] text-kumo-inactive backdrop-blur-sm">
                Chats
              </h3>
              {chats.map(chat => (
                <ChatChangesRow key={chat.id} chat={chat} onOpen={() => onOpenChat(chat.id)} />
              ))}
            </section>
          )}
          {pendingStatus === 'checking' && (
            <p className="m-0 px-5 py-3 text-center text-[12px] leading-4 text-kumo-inactive">
              Still checking for held requests…
            </p>
          )}
          {pendingStatus === 'error' && (
            <p className="m-0 px-5 py-3 text-center text-[12px] leading-4 text-kumo-inactive">
              Could not finish checking for held requests — reload the page to try again.
            </p>
          )}
        </div>
      </>
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
    }
  }

  return (
    <div className="flex h-full flex-col bg-kumo-base">
      {renderActivityContent()}

      {creationAccountModal}
    </div>
  )
}

/** A chat with changes waiting, which opens the chat, where they are accepted. */
const ChatChangesRow = ({ chat, onOpen }: { chat: ChatWithChanges; onOpen: () => void }) => {
  const summary = [
    chat.requests > 0 && (chat.requests === 1 ? '1 request to apply' : `${chat.requests} requests to apply`),
    chat.codeChanges && 'code changes',
    chat.holding && 'holding',
    chat.awaitingDecision && 'waiting on your decision',
  ].filter(part => part !== false).join(' · ')
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex w-full cursor-pointer items-center gap-3 border-b border-kumo-line/70 px-5 py-2.5 text-left transition-colors hover:bg-kumo-elevated/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-kumo-ring"
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium leading-[18px] tracking-[-0.25px] text-kumo-default">
          {chat.title || 'Chat'}
        </span>
        <span className="mt-0.5 block truncate text-[12px] leading-4 tracking-[-0.2px] text-kumo-inactive">
          {summary.charAt(0).toUpperCase() + summary.slice(1)}
        </span>
      </span>
      <CaretRight size={12} className="flex-shrink-0 text-kumo-inactive" />
    </button>
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
  const autoApproved = record.type === 'action' && record.autoApproved === true
  const accepted = record.type === 'action' && record.state === 'pending' ? record.accepted : undefined
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
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11.5px] text-kumo-inactive">
            <span>{formatFullDate(at)}</span>
            <span className="text-kumo-subtle">{record.resourceTitle}</span>
            {resolvedBy && (
              <ResolverBadge profileId={resolvedBy.id}>
                {autoApproved ? `Auto-approved for ${resolvedBy.name}` : `By ${resolvedBy.name}`}
              </ResolverBadge>
            )}
            {accepted && (
              <ResolverBadge profileId={accepted.by.id}>
                {accepted.autoApproved
                  ? `Accepted automatically for ${accepted.by.name}`
                  : `Accepted by ${accepted.by.name}`}
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
                hookTitle={record.description.title}
                enabled={record.enabled}
                pending={togglingHook}
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
