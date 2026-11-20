import { useState } from 'react'
import { Eye, X } from '@phosphor-icons/react'
import { WorkshopIconButton } from './components/WorkshopControls'
import { formatRelativeTime } from './utils/formatRelativeTime'
import { formatFullTimestamp } from './utils/formatTimestamp'
import { useMinuteTick } from './useMinuteTick'

type Props = {
  // The gadget owner's name, when known.
  ownerName: string | undefined
  refreshedAt: Date
}

/**
 * A dismissable card over a gadget snapshot (see Overseer.getGadgetSnapshot), explaining what it
 * is. Dismissal lasts for this component instance, so the caller keys it by gadget and snapshot to
 * bring it back for each new one.
 */
export const GadgetSnapshotCard = ({ ownerName, refreshedAt }: Props) => {
  const [dismissed, setDismissed] = useState(false)
  useMinuteTick(!dismissed)
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
          {/* Wraps rather than truncates, so the note about refresh is never cut off. */}
          <p className="text-pretty text-xs text-kumo-subtle">
            <span title={formatFullTimestamp(refreshedAt)}>Updated {formatRelativeTime(refreshedAt)}.</span>
            {' '}Any changes made to the snapshot are discarded on refresh.
          </p>
        </div>
        <span aria-hidden="true" className="h-5 w-px shrink-0 bg-kumo-line" />
        <WorkshopIconButton aria-label="Dismiss" onClick={() => setDismissed(true)}>
          <X size={16} />
        </WorkshopIconButton>
      </div>
    </div>
  )
}
