import { useEffect, useState } from 'react'
import { Tooltip } from '@cloudflare/kumo'
import { CaretRight, Eye, X } from '@phosphor-icons/react'
import { WorkshopIconButton } from './components/WorkshopControls'
import { formatRelativeTime } from './Activity'
import { formatFullTimestamp } from './utils/formatTimestamp'

type Props = {
  // The gadget owner's name, when known.
  ownerName: string | undefined
  refreshedAt: Date
  // Asks to verify the collaborator's accounts and open the live gadget in place of the snapshot.
  onVerify: () => void
  // Whether that verification is under way.
  verifying: boolean
}

/**
 * A dismissable card over a gadget snapshot (see Overseer.getGadgetSnapshot), explaining what it
 * is and offering to verify for the live gadget. Dismissal lasts for this component instance, so
 * the caller keys it by gadget and snapshot to bring it back for each new one.
 */
export const GadgetSnapshotCard = ({ ownerName, refreshedAt, onVerify, verifying }: Props) => {
  const [dismissed, setDismissed] = useState(false)
  // Re-render each minute so the relative age stays current.
  const [, setTick] = useState(0)
  useEffect(() => {
    if (dismissed) return
    const timer = setInterval(() => setTick(tick => tick + 1), 60_000)
    return () => clearInterval(timer)
  }, [dismissed])
  if (dismissed) return null

  return (
    <div className="pointer-events-none absolute inset-x-0 top-4 z-10 flex justify-center px-4">
      <div className="pointer-events-auto flex w-full max-w-[36rem] items-center gap-3 rounded-xl border border-kumo-line bg-kumo-base p-2.5 shadow-lg">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-kumo-tint text-kumo-default">
          <Eye size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-kumo-default">
            {`You're viewing a snapshot of ${ownerName ? `${ownerName}'s` : 'this'} gadget`}
          </p>
          <p className="truncate text-xs text-kumo-subtle">
            <span title={formatFullTimestamp(refreshedAt)}>Updated {formatRelativeTime(refreshedAt)}.</span>
            {' '}Verify your accounts for full access.
          </p>
        </div>
        <Tooltip content="Verify access" asChild>
          <WorkshopIconButton aria-label="Verify access" disabled={verifying} onClick={onVerify}>
            <CaretRight size={16} />
          </WorkshopIconButton>
        </Tooltip>
        <span aria-hidden="true" className="h-5 w-px shrink-0 bg-kumo-line" />
        <WorkshopIconButton aria-label="Dismiss" onClick={() => setDismissed(true)}>
          <X size={16} />
        </WorkshopIconButton>
      </div>
    </div>
  )
}
