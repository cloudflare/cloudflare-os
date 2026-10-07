import { SpaceSyncProgress } from './SpaceSyncProgress'
import type { SpaceSync } from './useSpaceSync'

/**
 * Where the syncs into a space stand (`SpaceSync.shown`), each with its progress, Cancel while it
 * runs and Dismiss once it has ended. Nothing is shown to a user with no account that can sync
 * into the space.
 */
export const SpaceSyncStatus = ({ sync, className = '' }: {
  sync: SpaceSync
  /** Placed on the status's container, which is not rendered while there is nothing to show. */
  className?: string
}) => {
  if (sync.accounts.length === 0 || sync.shown.length === 0) return null
  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      {sync.shown.map(job => (
        <SpaceSyncProgress
          key={job.jobId}
          job={job}
          sourceName={sync.sourceNameOf(job)}
          onCancelled={() => void sync.jobs.refresh()}
          onDismiss={() => sync.dismiss(job)}
        />
      ))}
    </div>
  )
}
