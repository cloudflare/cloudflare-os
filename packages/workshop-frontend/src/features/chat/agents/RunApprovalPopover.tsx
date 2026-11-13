import { useState, type ReactElement } from 'react'
import { Popover } from '@cloudflare/kumo'
import { ArrowRight } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import type { ActionLogEntry, Overseer } from '@gadgets/workshop-shared/api'
import { useResolveAction } from '../../../useResolveAction'
import { PendingApprovalCard } from './PendingApprovalCard'

/**
 * The request blocking a run, answered where the user met it.
 *
 * A popover rather than the row: what an approver has to read is a `<pre>` of whatever the action
 * will send, and the chat list is a column narrow enough to break a wrapped email body into
 * ribbons. The popover is the same card at a width where it can be read, and leaves the list
 * exactly where it was — opening the run is still one click away for whoever wants the thread.
 */
export const RunApprovalPopover = ({
  overseer, records, restricted, onOpenRun, onOpenChange, children,
}: {
  overseer: RpcStub<Overseer>
  /** The action approvals attached to this run; never empty. */
  records: ActionLogEntry[]
  /** The workspace has read restricted data, which every approve surface has to say. */
  restricted: boolean
  onOpenRun: () => void
  /** Told when the popover opens or closes. */
  onOpenChange: (open: boolean) => void
  /** The run's row, which opens this. */
  children: ReactElement
}) => {
  const [open, setOpen] = useState(false)
  const [processing, setProcessing] = useState<Set<number>>(new Set())
  const { resolveAction, creationAccountModal } = useResolveAction(overseer, setProcessing)
  const changeOpen = (next: boolean) => {
    setOpen(next)
    onOpenChange(next)
  }

  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <Popover.Trigger render={children} />
      {/* Kumo always renders base-ui's arrow as the popup's first child; hide it, as the rest of
          the Workshop's popovers do. */}
      <Popover.Content
        side="right"
        align="start"
        sideOffset={8}
        positionMethod="fixed"
        className="themed-floating-shadow !z-[1100] !w-[min(440px,calc(100vw-24px))] !min-w-0 overflow-hidden rounded-xl border border-kumo-line bg-kumo-base !p-0 !outline-none [&>:first-child]:hidden"
      >
        <Popover.Title className="block px-3.5 pb-1.5 pt-2.5 text-[11px] font-medium uppercase tracking-[0.06em] text-kumo-inactive">
          {records.length === 1 ? 'Waiting on you' : `Waiting on you (${records.length})`}
        </Popover.Title>

        <div className="flex max-h-[min(70vh,520px)] flex-col gap-2 overflow-y-auto px-3 pb-2">
          {records.map(record => (
            <PendingApprovalCard
              key={record.id}
              record={record}
              restricted={restricted}
              busy={processing.has(record.id)}
              onResolve={decision => void resolveAction(record, decision)}
            />
          ))}
        </div>

        <div className="border-t border-kumo-line p-1">
          <button
            type="button"
            onClick={() => { changeOpen(false); onOpenRun() }}
            className="flex w-full cursor-pointer items-center justify-between rounded-md px-2.5 py-1.5 text-left text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-default transition-colors hover:bg-kumo-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-kumo-ring"
          >
            Open run
            <ArrowRight size={13} className="text-kumo-inactive" aria-hidden="true" />
          </button>
        </div>
      </Popover.Content>
      {/* Outside the content: approving a creation opens this modal, and taking its first click
          closes the popover. */}
      {creationAccountModal}
    </Popover>
  )
}
