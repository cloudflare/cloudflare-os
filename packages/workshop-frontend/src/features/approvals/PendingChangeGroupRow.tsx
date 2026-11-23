import { ArrowSquareOut, CaretRight, Lightning } from '@phosphor-icons/react'
import { GatekeeperIcon } from '../../components/GatekeeperIcon'
import type { VendorBranding } from '../../useVendorBranding'
import { BulkResolveButtons } from './BulkResolveButtons'
import { ReviewRequest } from './ReviewRequest'
import {
  blockedBy, canOfferAlwaysApprove, isAutoApproved, type AutoApprovalRules,
} from './autoApprovalRules'
import { describeGroupSize, isFromElsewhere, type PendingChange, type PendingChangeGroup } from './pendingChangeGroups'

/** What the tray can do with one request, once the user drills into it. */
export interface PendingChangeActions {
  processing: ReadonlySet<number>
  onApprove: (entry: PendingChange) => void
  onReject: (entry: PendingChange) => void
  /** Enables a standing rule for the request's kind on its connection. */
  onAlwaysApprove: (entry: PendingChange) => void
  /** Opens the pane where a standing rule is turned off again. */
  onManageRules: () => void
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
  rules,
  expandedActionId,
  onToggleAction,
  open,
  onToggle,
  actions,
  bulk,
}: {
  group: PendingChangeGroup
  vendorId?: string
  branding?: VendorBranding
  rules: AutoApprovalRules
  expandedActionId: number | null
  onToggleAction: (actionId: number) => void
  open: boolean
  onToggle: () => void
  actions: PendingChangeActions
  /** Absent for a group nothing here can resolve in bulk, such as one holding a pending creation. */
  bulk?: { onApplyAll: () => void, onDiscardAll: () => void, disabled: boolean }
}) => {
  const autoApprovedCount = group.entries.filter(entry => isAutoApproved(entry, rules)).length
  // Nothing in this group is something the open chat asked for, so the row says so once rather
  // than every request inside it repeating the same sentence. This is also why the group sorts
  // below the ones this conversation did ask for.
  const allElsewhere = isFromElsewhere(group)

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
          <span className="min-w-[4rem] flex-1 truncate text-[12.5px] font-medium leading-[17px] tracking-[-0.15px] text-kumo-default">
            {group.title}
          </span>
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
          {autoApprovedCount > 0 && (
            <span className="flex min-w-0 shrink items-center gap-1 text-[11.5px] leading-4 text-kumo-inactive">
              <Lightning size={11} weight="fill" className="flex-shrink-0" aria-hidden="true" />
              <span className="truncate">
                {autoApprovedCount === group.entries.length
                  ? 'Standing rule'
                  : `${autoApprovedCount} on a standing rule`}
              </span>
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
            {group.hasCreation && (
              <p className="m-0 border-b border-kumo-line px-5 py-2 text-[11.5px] leading-4 text-kumo-inactive">
                This resource does not exist yet. Approve its creation first — everything queued
                behind it applies after, and discarding it discards them too.
              </p>
            )}
            {group.entries.map(entry => {
              const blocker = blockedBy(entry, group.entries, rules)
              // A rule covers this one, so the kernel will apply it unasked once the drain reaches
              // it. The controls stay, though: a drain stops for good at an apply that fails, and
              // a request nobody can decide here would be stranded with nothing saying why. One
              // the drain is applying right now refuses a second decision, whoever sends it.
              const ruled = isAutoApproved(entry, rules)
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
                  {ruled && (
                    <p className="m-0 flex flex-wrap items-center gap-x-1.5 bg-kumo-tint/60 px-5 pt-2 text-[11.5px] leading-4 text-kumo-inactive">
                      {blocker
                        ? `Standing rule enabled, waiting on "${blocker.description.title}" above it.`
                        : 'Standing rule enabled.'}
                      <button
                        type="button"
                        onClick={actions.onManageRules}
                        className="cursor-pointer text-kumo-default underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring"
                      >
                        Manage rule
                      </button>
                    </p>
                  )}
                  <ReviewRequest
                    record={entry}
                    restricted={rules.restricted}
                    showResource={false}
                    expanded={expandedActionId === entry.id}
                    processing={actions.processing.has(entry.id)}
                    onToggle={() => onToggleAction(entry.id)}
                    decide={{
                      onApprove: () => actions.onApprove(entry),
                      onReject: () => actions.onReject(entry),
                      onAlwaysApprove: canOfferAlwaysApprove(entry, rules)
                        ? () => actions.onAlwaysApprove(entry)
                        : undefined,
                    }}
                  />
                </div>
              )
            })}
          </div>
          {/* Outside the scroller: resolving the group as a whole must not be something the user
              has to scroll past every request to reach. */}
          {bulk && group.entries.length > 1 && (
            <div className="flex items-center gap-2 border-t border-kumo-line/70 px-5 py-2">
              <BulkResolveButtons
                count={group.entries.length}
                disabled={bulk.disabled}
                onDiscardAll={bulk.onDiscardAll}
                onApplyAll={bulk.onApplyAll}
              />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
