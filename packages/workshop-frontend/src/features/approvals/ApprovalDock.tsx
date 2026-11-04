import { useId, useState } from 'react'
import { Button } from '@cloudflare/kumo'
import { CaretDown, CaretLeft, CaretRight, ShieldCheck, X } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import type { ActionLogEntry, Overseer } from '@gadgets/workshop-shared/api'
import { ActionFields, entryFields } from '../../components/ActionFields'
import {
  IncompleteDescriptionNotice, isDescriptionIncomplete,
} from '../../components/IncompleteDescriptionNotice'
import AutoApproveConfirmDialog from '../../components/AutoApproveConfirmDialog'
import { RestrictedApprovalNotice } from '../../components/RestrictedApprovalNotice'
import { useActions } from '../../useActions'
import { useAlwaysApproveTag } from '../../useAlwaysApproveTag'
import { useResolveAction } from '../../useResolveAction'
import { alwaysApproveTarget, type AlwaysApproveTarget } from './alwaysApproveTarget'

type ApprovalDockProps = {
  overseer: RpcStub<Overseer>
  // True once the workspace has read restricted data (WorkspaceMetadata.containsRestrictedData):
  // the approver is the leak check, so the request is always shown in full with a notice saying so.
  restricted: boolean
  // Called once an auto-approval rule is enabled from the dock, so lists of rules can refresh.
  onAutoApproveChange: () => void
  // Hides the dock without deciding the requests it holds.
  onHide: () => void
  // Opens the full list of requests (Activity → Review).
  onViewAll: () => void
  // Shows the request where it was asked for: called on paging to it and on clicking it, for one
  // that names its chat.
  onShowInChat: (action: ActionLogEntry) => void
  // The request the approver paged to; null shows the oldest (see `index` for one that is no
  // longer pending). Held by the caller, so it survives the dock moving between placements.
  selectedActionId: number | null
  onSelect: (actionId: number) => void
}

const pagerButtonClassName =
  'flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-kumo-subtle transition-colors enabled:hover:bg-kumo-tint enabled:hover:text-kumo-default disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring'

/**
 * The workspace's pending requests, one at a time, floating over the bottom of the workspace:
 * page through them and approve or deny each. Renders nothing while none is pending.
 */
export const ApprovalDock = ({
  overseer, restricted, onAutoApproveChange, onHide, onViewAll, onShowInChat, selectedActionId, onSelect,
}: ApprovalDockProps) => {
  const { pending } = useActions(overseer)
  const [processing, setProcessing] = useState<Set<number>>(new Set())
  const { resolveAction, creationAccountModal } = useResolveAction(overseer, setProcessing)
  const { alwaysApproveTag, isTagAutoApproved } =
    useAlwaysApproveTag(overseer, setProcessing, onAutoApproveChange)
  const [confirming, setConfirming] = useState<AlwaysApproveTarget | null>(null)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const id = useId()

  if (pending.length === 0) return creationAccountModal || null

  // The selected request; once it is resolved, the one after it, so the dock stays where the
  // approver was (ids count up in creation order, which is the pending list's order).
  const atOrAfter = selectedActionId === null
    ? 0
    : pending.findIndex(action => action.id >= selectedActionId)
  const index = atOrAfter >= 0 ? atOrAfter : pending.length - 1
  const action = pending[index]
  const isProcessing = processing.has(action.id)

  const fields = entryFields(action)
  const incomplete = isDescriptionIncomplete(action)
  const showDetails = restricted || detailsOpen
  const detailsId = `${id}-details`
  const noticeId = `${id}-restricted-notice`
  const requestId = `${id}-request`
  const fieldsId = `${id}-fields`
  const incompleteId = `${id}-incomplete`
  // While restricted the notice and the request precede the controls but are long, so the
  // approve/deny buttons also name them as their description.
  const describedBy = restricted
    ? [
      noticeId,
      ...(action.description.description ? [requestId] : []),
      ...(fields.length > 0 ? [fieldsId] : []),
      ...(incomplete ? [incompleteId] : []),
    ].join(' ')
    : undefined
  const subtitle = action.resourceTitle || action.description.description.split('\n', 1)[0]

  const target = alwaysApproveTarget(action, restricted)
  const offerAlwaysApprove = target !== undefined &&
    !isTagAutoApproved(target.gatekeeperId, target.actionKind.tag)

  // Paging also takes the chat to the request (a request resolving moves the dock on without it).
  const go = (to: number) => {
    onSelect(pending[to].id)
    if (pending[to].chatId !== undefined) onShowInChat(pending[to])
  }

  const summary = (
    <>
      <span className="block truncate text-[14px] font-medium leading-5 tracking-[-0.25px] text-kumo-default group-hover/summary:underline">
        {action.description.title}
      </span>
      {subtitle && (
        <span className="block truncate text-[12.5px] leading-4 tracking-[-0.1px] text-kumo-inactive">
          {subtitle}
        </span>
      )}
    </>
  )

  return (
    <section
      aria-label="Pending approvals"
      className="themed-floating-shadow pointer-events-auto w-full overflow-hidden rounded-xl border border-kumo-line bg-kumo-base"
    >
      {showDetails && (
        <div
          id={detailsId}
          className="max-h-[min(50vh,480px)] space-y-2 overflow-y-auto border-b border-kumo-line px-4 py-3"
        >
          {restricted && <RestrictedApprovalNotice id={noticeId} />}
          {action.description.description && (
            <p
              id={requestId}
              className="m-0 whitespace-pre-wrap text-[13px] leading-[19px] tracking-[-0.2px] text-kumo-subtle"
            >
              {action.description.description}
            </p>
          )}
          {fields.length > 0 && (
            <div id={fieldsId}>
              <ActionFields fields={fields} uncapped={restricted} />
            </div>
          )}
          {incomplete && <IncompleteDescriptionNotice id={incompleteId} />}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5">
        <div className="flex flex-shrink-0 items-center gap-0.5">
          <button
            type="button"
            aria-label="Previous request"
            disabled={index === 0}
            onClick={() => go(index - 1)}
            className={pagerButtonClassName}
          >
            <CaretLeft size={14} />
          </button>
          <span className="min-w-[3.25rem] text-center text-[13px] tabular-nums leading-[18px] text-kumo-subtle">
            {index + 1} of {pending.length}
          </span>
          <button
            type="button"
            aria-label="Next request"
            disabled={index === pending.length - 1}
            onClick={() => go(index + 1)}
            className={pagerButtonClassName}
          >
            <CaretRight size={14} />
          </button>
        </div>

        <div className="min-w-[10rem] flex-1" aria-live="polite">
          {action.chatId === undefined ? summary : (
            <button
              type="button"
              onClick={() => onShowInChat(action)}
              title="Show in chat"
              className="group/summary block w-full min-w-0 cursor-pointer rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring"
            >
              {summary}
            </button>
          )}
        </div>

        <div className="ml-auto flex flex-shrink-0 items-center gap-1.5">
          {offerAlwaysApprove && (
            <Button
              variant="ghost"
              size="sm"
              disabled={isProcessing}
              onClick={() => setConfirming(target)}
              title="Always approve this type of action on this connection, without future prompts."
            >
              Always approve
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={isProcessing}
            onClick={() => void resolveAction(action, 'deny')}
            aria-describedby={describedBy}
          >
            Deny
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={isProcessing}
            onClick={() => void resolveAction(action, 'approve')}
            aria-describedby={describedBy}
          >
            Approve
          </Button>
        </div>
      </div>

      <div className="flex items-center border-t border-kumo-line bg-kumo-elevated px-2 py-1">
        {restricted ? (
          <span className="flex h-7 items-center gap-1.5 px-1.5 text-[12.5px] text-kumo-subtle">
            <ShieldCheck size={14} aria-hidden="true" />
            Approval needed
          </span>
        ) : (
          <button
            type="button"
            aria-expanded={detailsOpen}
            aria-controls={detailsOpen ? detailsId : undefined}
            onClick={() => setDetailsOpen(open => !open)}
            className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-[12.5px] text-kumo-subtle transition-colors hover:bg-kumo-tint hover:text-kumo-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring"
          >
            <ShieldCheck size={14} aria-hidden="true" />
            Approval needed
            <CaretDown
              size={11}
              aria-hidden="true"
              className={`transition-transform duration-150 ${detailsOpen ? 'rotate-180' : ''}`}
            />
          </button>
        )}
        <div className="ml-auto flex items-center gap-0.5">
          <button
            type="button"
            onClick={onViewAll}
            className="flex h-7 cursor-pointer items-center rounded-md px-1.5 text-[12.5px] text-kumo-subtle transition-colors hover:bg-kumo-tint hover:text-kumo-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring"
          >
            View all
          </button>
          <button
            type="button"
            aria-label="Hide approvals"
            title="Hide approvals"
            onClick={onHide}
            className={pagerButtonClassName}
          >
            <X size={13} />
          </button>
        </div>
      </div>
      {creationAccountModal}
      {confirming && (
        <AutoApproveConfirmDialog
          open
          actionLabel={confirming.actionLabel}
          resourceTitle={confirming.resourceTitle}
          isProcessing={processing.has(confirming.actionId)}
          onOpenChange={open => { if (!open) setConfirming(null) }}
          onConfirm={async () => {
            if (await alwaysApproveTag(confirming.actionId, confirming.gatekeeperId, confirming.actionKind)) {
              setConfirming(null)
            }
          }}
        />
      )}
    </section>
  )
}
