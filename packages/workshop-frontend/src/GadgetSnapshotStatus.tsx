import { useEffect, useState } from 'react'
import { Badge, Tooltip } from '@cloudflare/kumo'
import { Camera } from '@phosphor-icons/react'
import { formatRelativeTime } from './utils/formatRelativeTime'
import { SnapshotRefreshButton } from './SnapshotRefreshButton'

type Props = {
  refreshedAt: Date
  onRefresh: () => Promise<void>
}

/**
 * Marks the gadget on screen as a static snapshot (see Overseer.getGadgetSnapshot), saying when it
 * was taken, with a control to take a new snapshot.
 */
export const GadgetSnapshotStatus = ({ refreshedAt, onRefresh }: Props) => {
  // Re-render each minute so the relative age stays current.
  const [, setTick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setTick(tick => tick + 1), 60_000)
    return () => clearInterval(timer)
  }, [])

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      {/* Badge forwards no ref, so a focusable span carries the tooltip. */}
      <Tooltip content={`Updated ${formatRelativeTime(refreshedAt)}`} asChild>
        <span tabIndex={0} className="inline-flex rounded-full">
          <Badge variant="secondary" icon={<Camera size={12} />}>Snapshot</Badge>
        </span>
      </Tooltip>
      <SnapshotRefreshButton onRefresh={onRefresh} />
    </div>
  )
}
