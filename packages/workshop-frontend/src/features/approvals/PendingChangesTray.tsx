import { useState } from 'react'
import { Warning } from '@phosphor-icons/react'
import type { VendorBranding } from '../../useVendorBranding'
import { formatRelativeTime } from '../../utils/formatRelativeTime'
import { PendingChangeGroupRow, type PendingChangeActions } from './PendingChangeGroupRow'
import { countFromElsewhere, pendingChangeEntries, type PendingChangeGroup } from './pendingChangeGroups'

/**
 * How many unresolved requests on one connection start a warning.
 *
 * The gatekeeper kit refuses to queue past `DEFAULT_MAX_PENDING` (50) per resource journal, and
 * an individual gatekeeper may set its own cap. Today that limit reaches the user only as a tool
 * error inside the agent's turn, which is exactly the wrong place: a tray that makes ignoring the
 * queue comfortable makes reaching it likelier. Treated as a heuristic, not the real cap, so the
 * copy warns rather than predicts.
 */
const JOURNAL_PRESSURE_THRESHOLD = 35

const barClass =
  'themed-surface-inset relative flex flex-col overflow-hidden border-b border-kumo-line bg-kumo-elevated'

/**
 * Everything the workspace is waiting on, docked above the composer and grouped by the resource
 * each request touches.
 *
 * Nothing here has been applied. Most of it never stopped the agent either: a gatekeeper that
 * simulates its effects leaves `awaitDecision` unset, so the agent kept working while these
 * queued up. A request that did suspend its turn is here too, beside its callout in the
 * transcript. The tray exists to make that queue visible in one place, rather than as a row per
 * request scattered through the transcript. A chat's requests apply when its changes are
 * accepted, from the code-draft bar that shares this slot; outside any chat, the held-changes bar
 * under it accepts the rest.
 *
 * In a chat it lists the chat's requests and the ones no chat made that accepting it applies
 * first; outside any chat, the ones no chat made. The group rows mark the ones this conversation
 * did not ask for.
 */
export const PendingChangesTray = ({
  groups,
  restricted,
  vendorIdByGatekeeper,
  vendorBranding,
  actions,
}: {
  groups: readonly PendingChangeGroup[]
  /** The workspace's restricted-data latch (WorkspaceMetadata.containsRestrictedData). */
  restricted: boolean
  vendorIdByGatekeeper: ReadonlyMap<number, string>
  vendorBranding: ReadonlyMap<string, VendorBranding>
  actions: PendingChangeActions
}) => {
  const [openGroupId, setOpenGroupId] = useState<number | null>(null)
  const [expandedActionId, setExpandedActionId] = useState<number | null>(null)

  if (groups.length === 0) return null

  const all = pendingChangeEntries(groups)
  const oldest = all[0]
  const elsewhere = countFromElsewhere(groups)
  const pressured = groups.filter(group => group.entries.length >= JOURNAL_PRESSURE_THRESHOLD)

  return (
    <div className={`${barClass} max-h-[min(30rem,45vh)] rounded-t-[calc(1rem-1px)]`}>
      <span
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-kumo-brand/40 to-transparent"
        aria-hidden="true"
      />
      <div className="flex flex-shrink-0 items-center gap-2 px-3.5 py-2">
        <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-kumo-brand" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium leading-4 tracking-[-0.2px] text-kumo-default">
          {all.length === 1 ? '1 request waiting' : `${all.length} requests waiting`}
          <span className="font-normal text-kumo-inactive">
            {elsewhere > 0 && (elsewhere === all.length
              ? ' · asked elsewhere in this workspace'
              : ` · ${elsewhere} from elsewhere`)}
            {' · nothing applied yet'}
            {oldest && ` · oldest ${formatRelativeTime(oldest.createdAt)}`}
          </span>
        </span>
      </div>

      {/* Two notices can stand at once, and at the narrowest pane each wraps to several lines
          -- enough to leave the requests below them no height at all, which is worse than any
          notice is useful. So this block gives way before the list does, and scrolls when it
          has given up all it can. */}
      <div className="min-h-0 shrink overflow-y-auto">
      {restricted && (
        <p className="m-0 border-t border-kumo-line/70 px-3.5 py-1.5 text-[11.5px] leading-4 text-kumo-inactive">
          This workspace has read sensitive data, so every request is reviewed on its own.
        </p>
      )}

      {pressured.length > 0 && (
        <p className="m-0 flex items-center gap-1.5 border-t border-kumo-line/70 px-3.5 py-1.5 text-[11.5px] leading-4 text-kumo-warning">
          <Warning size={12} weight="duotone" aria-hidden="true" />
          {pressured.length === 1
            ? `${pressured[0].title} is holding ${pressured[0].entries.length} unresolved requests — resolve some before its queue fills up.`
            : `${pressured.length} resources are holding large unresolved queues — resolve some before they fill up.`}
        </p>
      )}

      </div>

      {/* The tray sits in the composer's unshrinkable section inside a pane that hides its
          overflow, so one tall enough to fill a short window pushes the composer past the bottom
          edge, where scrolling cannot bring it back. The cap is on the tray rather than on this
          list, because the notices are part of its height too and there can be several; capping
          only the list let each notice add to the total without limit. Within that cap the list
          keeps a floor, so however many notices stand there is always a request to act on. */}
      <div className="min-h-[5.5rem] flex-1 overflow-y-auto border-t border-kumo-line/70">
        {groups.map(group => {
          const vendorId = vendorIdByGatekeeper.get(group.gatekeeperId)
          return (
            <PendingChangeGroupRow
              key={group.gatekeeperId}
              group={group}
              vendorId={vendorId}
              branding={vendorId ? vendorBranding.get(vendorId) : undefined}
              restricted={restricted}
              expandedActionId={expandedActionId}
              onToggleAction={id => setExpandedActionId(current => current === id ? null : id)}
              // One group at a time: two expanded bodies would push the tray past any height the
              // composer stack can give it.
              open={openGroupId === group.gatekeeperId}
              onToggle={() => setOpenGroupId(current =>
                current === group.gatekeeperId ? null : group.gatekeeperId)}
              actions={actions}
            />
          )
        })}
      </div>
    </div>
  )
}
