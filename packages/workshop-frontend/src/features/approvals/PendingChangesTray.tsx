import { useState } from 'react'
import { Warning } from '@phosphor-icons/react'
import type { VendorBranding } from '../../useVendorBranding'
import { formatRelativeTime } from '../../utils/formatRelativeTime'
import { BulkResolveButtons } from './BulkResolveButtons'
import { PendingChangeGroupRow, type PendingChangeActions } from './PendingChangeGroupRow'
import type { AutoApprovalRules } from './autoApprovalRules'
import {
  countFromElsewhere, pendingChangeEntries, type PendingChange, type PendingChangeGroup,
} from './pendingChangeGroups'
import {
  describeBulkFailure, describeBulkProgress, type BulkResolve,
} from './useBulkResolve'

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
 * transcript. The tray exists to make that queue visible and resolvable as a batch, rather than
 * as a row per request scattered through the transcript.
 *
 * Workspace-scoped, not chat-scoped. A hook firing, a scheduled task, or another conversation
 * queues requests that wait on a decision just as much, and they have no chat surface at all;
 * the group rows mark the ones this conversation did not ask for.
 *
 * Its bulk actions are deliberately quiet rather than the loudest control in the composer stack.
 * They send real, mostly irreversible effects to someone else's service, and the code-draft bar
 * that shares this slot owns the filled primary for a local, reversible accept.
 */
export const PendingChangesTray = ({
  groups,
  rules,
  ready,
  vendorIdByGatekeeper,
  vendorBranding,
  actions,
  bulk,
}: {
  groups: readonly PendingChangeGroup[]
  rules: AutoApprovalRules
  /**
   * Whether the workspace's pending set and its auto-approval rules have both finished loading.
   * The pending set pages in, so until then a group can be missing its oldest requests, and
   * resolving one as a batch would apply a later request over requests nobody has seen yet. The
   * rule list arrives separately, and a run that read it half-loaded would not leave the drain
   * its turn on a request a rule covers: it would race the drain there and stop on the refusal.
   */
  ready: boolean
  vendorIdByGatekeeper: ReadonlyMap<number, string>
  vendorBranding: ReadonlyMap<string, VendorBranding>
  actions: PendingChangeActions
  bulk: BulkResolve
}) => {
  const [openGroupId, setOpenGroupId] = useState<number | null>(null)
  const [expandedActionId, setExpandedActionId] = useState<number | null>(null)

  const failureNotice = (divided: boolean) => bulk.failure && (
    <p
      role="alert"
      className={`m-0 flex items-start gap-2 px-3.5 py-1.5 text-[11.5px] leading-4 text-kumo-danger ${divided ? 'border-t border-kumo-line/70' : ''}`}
    >
      <span className="min-w-0 flex-1">{describeBulkFailure(bulk.failure)}</span>
      <button
        type="button"
        onClick={bulk.dismissFailure}
        className="flex-shrink-0 cursor-pointer text-kumo-inactive underline-offset-2 hover:underline"
      >
        Dismiss
      </button>
    </p>
  )

  if (groups.length === 0) {
    // The queue can empty under a run that stopped, often because the very request it stopped
    // at has just landed -- a discard whose last request was applied first. What the run says is
    // still owed to the user, so it outlives the queue until they dismiss it. Capped and
    // scrolling like the full tray, for the same reason: it sits in the composer's unshrinkable
    // section, and a long reason on a short window would push the composer off the pane.
    return bulk.failure
      ? (
        <div className={`${barClass} max-h-[min(30rem,45vh)] rounded-t-[calc(1rem-1px)]`}>
          <div className="min-h-0 overflow-y-auto">{failureNotice(false)}</div>
        </div>
      )
      : null
  }

  const all = pendingChangeEntries(groups)
  // A creation needs an account chosen for it, and nothing queued behind it can apply until it
  // does, so its group is decided one request at a time.
  const bulkable = groups.filter(group => !group.hasCreation)
  const bulkableEntries = pendingChangeEntries(bulkable)
  // While restricted, RESTRICTED_APPROVAL_COPY asks the approver to read every request in full.
  // Bulk apply would be the first path around that, and around the latch that already disables
  // every auto-approval rule.
  const canBulk = ready && !rules.restricted && bulkableEntries.length > 1
  const busy = bulk.progress !== null
  const oldest = all[0]
  const elsewhere = countFromElsewhere(groups)
  const pressured = groups.filter(group => group.entries.length >= JOURNAL_PRESSURE_THRESHOLD)

  // The run owns the view it is shown in. A decision taken here mid-run would land out of the
  // order the run keeps, or reach it as someone else's and stop it: a Deny clicked beside
  // "Applying 2 of 5" would read back as a denial made elsewhere. Activity and the header popover
  // are not locked, deliberately: they are other views, and the run treats what is decided there
  // as it treats another tab's decisions, while the workspace refuses any duplicate.
  const decisions: PendingChangeActions = busy
    ? { ...actions, processing: new Set([...actions.processing, ...all.map(entry => entry.id)]) }
    : actions

  const runBulk = (entries: readonly PendingChange[], decision: 'approve' | 'deny') => {
    setOpenGroupId(null)
    void bulk.run(entries, decision)
  }

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
        {busy && bulk.progress && (
          <span
            role="status"
            className="flex-shrink-0 text-[11.5px] leading-4 text-kumo-inactive"
          >
            {describeBulkProgress(bulk.progress)}
          </span>
        )}
        {canBulk && (
          <BulkResolveButtons
            count={bulkableEntries.length}
            disabled={busy}
            onDiscardAll={() => runBulk(bulkableEntries, 'deny')}
            onApplyAll={() => runBulk(bulkableEntries, 'approve')}
          />
        )}
      </div>

      {/* Three notices can stand at once, and at the narrowest pane each wraps to several lines
          -- enough to leave the requests below them no height at all, which is worse than any
          notice is useful. So this block gives way before the list does, and scrolls when it
          has given up all it can. */}
      <div className="min-h-0 shrink overflow-y-auto">
      {rules.restricted && (
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

      {failureNotice(true)}

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
              rules={rules}
              expandedActionId={expandedActionId}
              onToggleAction={id => setExpandedActionId(current => current === id ? null : id)}
              // One group at a time: two expanded bodies would push the tray past any height the
              // composer stack can give it.
              open={openGroupId === group.gatekeeperId}
              onToggle={() => setOpenGroupId(current =>
                current === group.gatekeeperId ? null : group.gatekeeperId)}
              actions={decisions}
              bulk={!ready || group.hasCreation || rules.restricted ? undefined : {
                onApplyAll: () => runBulk(group.entries, 'approve'),
                onDiscardAll: () => runBulk(group.entries, 'deny'),
                disabled: busy,
              }}
            />
          )
        })}
      </div>
    </div>
  )
}
