import { Badge, Tooltip } from '@cloudflare/kumo'
import { ArrowSquareOut, CaretRight } from '@phosphor-icons/react'
import { GatekeeperIcon } from '../../components/GatekeeperIcon'
import type { VendorBranding } from '../../useVendorBranding'
import { ReviewRequest } from './ReviewRequest'
import {
  describeGroupSize, isFromElsewhere, needsReview, type PendingChange,
  type PendingChangeGroup,
} from './pendingChangeGroups'

/** What the tray can do with one request, once the user drills into it. */
export interface PendingChangeActions {
  processing: ReadonlySet<number>
  onApprove: (entry: PendingChange) => void
  onReject: (entry: PendingChange) => void
  /**
   * Whether a request is approved on its own. Most apply when their chat's changes are accepted.
   */
  canApprove: (entry: PendingChange) => boolean
  /** Tries again to apply a request that failed to. */
  onRetry: (entry: PendingChange) => void
}

/**
 * One connection's row in the tray, and its requests once opened.
 *
 * The body scrolls rather than growing without limit: a single request can carry a whole JSON
 * document, and while restricted the field caps are deliberately dropped. `ReviewRequest` keeps
 * each request's controls in its header, so a decision stays reachable however far the body is
 * scrolled.
 */
export const PendingChangeGroupRow = ({
  group,
  vendorId,
  branding,
  restricted,
  expandedActionId,
  onToggleAction,
  open,
  onToggle,
  actions,
}: {
  group: PendingChangeGroup
  vendorId?: string
  branding?: VendorBranding
  restricted: boolean
  expandedActionId: number | null
  onToggleAction: (actionId: number) => void
  open: boolean
  onToggle: () => void
  actions: PendingChangeActions
}) => {
  // Nothing in this group is something the open chat asked for, so the row says so once rather
  // than every request inside it repeating the same sentence. This is also why the group sorts
  // below the ones this conversation did ask for.
  const allElsewhere = isFromElsewhere(group)
  // Said on the row too, since its requests are hidden until it is opened.
  const flagged = group.entries.some(needsReview)

  return (
    <div className="border-t border-kumo-line/70 first:border-t-0">
      <div className="flex items-center gap-2.5 px-3.5 py-2">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring"
        >
          <GatekeeperIcon
            vendorId={vendorId}
            fallbackText={group.title}
            logoUrl={branding?.logoUrl}
            color={branding?.color}
            size={14}
            className="h-6 w-6 rounded-md"
          />
          <span className={`min-w-[4rem] flex-1 truncate text-[12.5px] leading-[17px] tracking-[-0.15px] text-kumo-default ${flagged ? 'font-semibold' : 'font-medium'}`}>
            {group.title}
          </span>
          {flagged && <Badge variant="warning" className="flex-shrink-0">Needs review</Badge>}
          <span className="flex-shrink-0 text-[11.5px] leading-4 text-kumo-inactive">
            {describeGroupSize(group)}
          </span>
          {allElsewhere && (
            // Gives way to the connection's name rather than taking its width: at the narrowest
            // pane these badges together left the title nothing, and the name is what tells the
            // user which service is waiting. Both badges are repeated inside the group.
            <span className="flex min-w-0 shrink items-center gap-1 text-[11.5px] leading-4 text-kumo-inactive">
              <ArrowSquareOut size={11} className="flex-shrink-0" aria-hidden="true" />
              <span className="truncate">Asked elsewhere</span>
            </span>
          )}
          <CaretRight
            size={12}
            weight="bold"
            aria-hidden="true"
            className={`ml-auto flex-shrink-0 text-kumo-inactive transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
          />
        </button>
      </div>

      {open && (
        <div className="border-t border-kumo-line/70 bg-kumo-base">
          {/* Only the requests scroll, and they are capped below the tray's own cap so an open
              group still leaves room for its header, its footer and a glimpse of the next
              connection. Both caps track the window, so the relationship holds on a short one
              too — otherwise the footer with the group's own actions is sliced off. A single
              request can carry a whole JSON document. */}
          <div className="max-h-[min(18rem,20vh)] overflow-y-auto">
            {group.entries.map(entry => {
              // An apply stops at the first request that fails, and what is queued behind it on
              // the connection waits for it to be retried or denied.
              const failedBefore =
                group.entries.find(other => other.id < entry.id && other.applyError)
              return (
                <div key={entry.id}>
                  {!allElsewhere && entry.origin === 'elsewhere' && (
                    // A mixed group: this one sits beside requests the conversation does account
                    // for, so saying where it came from keeps it from reading as something this
                    // conversation did. A wholly-elsewhere group says it once, on its row.
                    <p className="m-0 flex items-center gap-1.5 px-5 pt-2 text-[11.5px] leading-4 text-kumo-inactive">
                      <ArrowSquareOut size={11} aria-hidden="true" />
                      Asked elsewhere in this workspace
                    </p>
                  )}
                  {entry.applyError && (
                    <p
                      role="alert"
                      className="m-0 flex flex-wrap items-center gap-x-1.5 px-5 pt-2 text-[11.5px] leading-4 text-kumo-danger"
                    >
                      <span className="min-w-0">
                        Could not apply: {entry.applyError.message}
                      </span>
                      {entry.applyError.retryable && (
                        <button
                          type="button"
                          onClick={() => actions.onRetry(entry)}
                          disabled={actions.processing.has(entry.id)}
                          className="cursor-pointer text-kumo-default underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          Retry
                        </button>
                      )}
                    </p>
                  )}
                  {failedBefore && (
                    <div className="flex px-5 pt-2">
                      <Tooltip content={`Waiting on "${failedBefore.description.title}" above it.`} asChild>
                        <span className="inline-flex">
                          <Badge variant="neutral">Blocked</Badge>
                        </span>
                      </Tooltip>
                    </div>
                  )}
                  <ReviewRequest
                    record={entry}
                    restricted={restricted}
                    showResource={false}
                    expanded={expandedActionId === entry.id}
                    processing={actions.processing.has(entry.id)}
                    onToggle={() => onToggleAction(entry.id)}
                    decide={{
                      onApprove: actions.canApprove(entry) ? () => actions.onApprove(entry) : undefined,
                      onReject: () => actions.onReject(entry),
                    }}
                  />
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
