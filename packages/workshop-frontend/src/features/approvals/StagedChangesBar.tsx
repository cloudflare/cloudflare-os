import { useState } from 'react'
import { Popover, Tooltip, useKumoToastManager } from '@cloudflare/kumo'
import { Check } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import type { ActionLogEntry, Overseer } from '@gadgets/workshop-shared/api'
import { WorkshopButton } from '../../components/WorkshopControls'
import { acceptThrough } from './pendingChangeGroups'

const requestCount = (count: number) => count === 1 ? '1 request' : `${count} requests`

/**
 * Accepts or discards what staging holds: the requests no chat made, which wait only while the
 * workspace has read restricted data, behind one left from before they applied at once, or behind
 * one that failed (see Overseer.acceptStagedActions()). It is to staging what a chat's pending-changes bar is to the
 * chat, so the composer tray and the Activity page show the same one.
 */
export const StagedChangesBar = ({ overseer, requests, blocked }: {
  overseer: RpcStub<Overseer>
  /** The requests staging holds, as the surface shows them: accepting applies no others. */
  requests: readonly ActionLogEntry[]
  /** Why accepting must wait, when the requests it would apply are not all known and shown. */
  blocked?: string
}) => {
  const toasts = useKumoToastManager()
  const [busy, setBusy] = useState<'accept' | 'discard' | null>(null)
  const [confirmingDiscard, setConfirmingDiscard] = useState(false)
  const count = requests.length

  const accept = async () => {
    setBusy('accept')
    try {
      const { outcome } = await overseer.acceptStagedActions(acceptThrough(requests))
      toasts.add(outcome === 'applied'
        ? { title: 'Requests applied', variant: 'success' }
        : { title: 'A request could not be applied', description: 'Retry it or deny it.', variant: 'error' })
    } catch (err) {
      console.error('Failed to apply requests:', err)
      toasts.add({ title: 'Failed to apply requests', variant: 'error' })
    } finally {
      setBusy(null)
    }
  }

  const discard = async () => {
    setBusy('discard')
    try {
      await overseer.discardStagedActions()
      setConfirmingDiscard(false)
    } catch (err) {
      console.error('Failed to discard requests:', err)
      toasts.add({ title: 'Failed to discard requests', variant: 'error' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="themed-surface-inset relative flex items-center gap-2 overflow-hidden border-b border-kumo-line bg-kumo-elevated px-3.5 py-2">
      <span className="min-w-0 flex-1 truncate text-[12px] font-medium leading-4 tracking-[-0.2px] text-kumo-default">
        Held changes
        <span className="font-normal text-kumo-inactive"> · {requestCount(count)} to apply</span>
      </span>
      <Popover open={confirmingDiscard} onOpenChange={open => { if (busy !== 'discard') setConfirmingDiscard(open) }}>
        <Popover.Trigger
          render={
            <button
              type="button"
              disabled={busy !== null}
              className="inline-flex h-[30px] cursor-pointer items-center justify-center rounded-md border border-kumo-fill bg-kumo-base px-2.5 text-[12px] font-medium leading-[18px] tracking-[-0.25px] text-kumo-default transition-colors enabled:hover:bg-kumo-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring disabled:cursor-not-allowed disabled:opacity-40"
            >
              Discard…
            </button>
          }
        />
        <Popover.Content
          align="center"
          side="top"
          sideOffset={8}
          positionMethod="fixed"
          className="themed-floating-shadow !z-[1100] !w-[min(300px,calc(100vw-24px))] !min-w-0 overflow-hidden rounded-xl border border-kumo-line bg-kumo-base !p-0 !outline-none [&>:first-child]:hidden"
        >
          <div className="px-3.5 pb-2.5 pt-3">
            <Popover.Title className="text-[13px] font-medium leading-[18px] tracking-[-0.25px] text-kumo-default">
              Discard the held changes?
            </Popover.Title>
            <p className="mt-0.5 text-[11.5px] leading-4 tracking-[-0.15px] text-kumo-subtle">
              Deny the {requestCount(count)} made outside any chat. Denied requests can&apos;t be
              restored.
            </p>
          </div>
          <div className="flex items-center justify-end gap-0.5 border-t border-kumo-line px-2 py-1.5">
            <button
              type="button"
              disabled={busy === 'discard'}
              onClick={() => setConfirmingDiscard(false)}
              className="flex h-6 cursor-pointer items-center rounded-md px-2 text-[12px] font-medium tracking-[-0.15px] text-kumo-inactive transition-colors enabled:hover:bg-kumo-tint enabled:hover:text-kumo-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring disabled:cursor-not-allowed disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => { void discard() }}
              className="flex h-6 cursor-pointer items-center rounded-md px-2 text-[12px] font-medium tracking-[-0.15px] text-kumo-default transition-colors enabled:hover:bg-kumo-tint enabled:hover:text-kumo-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy === 'discard' ? 'Discarding...' : 'Discard changes'}
            </button>
          </div>
        </Popover.Content>
      </Popover>
      <Tooltip content={blocked ?? "Apply the requests made outside any chat."} asChild>
        <WorkshopButton
          disabled={busy !== null || blocked !== undefined}
          onClick={() => { void accept() }}
          tone="primary"
          className="!h-7 !cursor-pointer !rounded-md !border-transparent !shadow-none gap-1 text-[12px]"
        >
          <Check size={11} weight="bold" />
          Accept changes
        </WorkshopButton>
      </Tooltip>
    </div>
  )
}
