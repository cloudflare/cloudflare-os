import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { Badge, Collapsible, Meter, type BadgeVariant } from '@cloudflare/kumo'
import type { SpaceSyncJobInfo } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../../AuthContext'
import { WorkshopButton } from '../../../components/WorkshopControls'
import { logRpcFailure, rpcFailureDescription } from '../../../rpcErrors'
import { formatFullTimestamp } from '../../../utils/formatTimestamp'
import { SPACE_ACTION_CLASS_NAME } from '../SpaceEntryPoints'

type SyncStatus = SpaceSyncJobInfo['status']

/** How each status of a sync job is named in the UI. */
export const SPACE_SYNC_STATUS_LABELS: Record<SyncStatus, string> = {
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

const STATUS_BADGES: Record<SyncStatus, BadgeVariant> = {
  running: 'info',
  done: 'success',
  failed: 'error',
  cancelled: 'neutral',
}

// What a screen reader hears when a job the user is watching changes status.
const announcementFor = (job: SpaceSyncJobInfo, sourceName: string): string => {
  switch (job.status) {
    case 'running': return `Sync from ${sourceName} is running.`
    case 'done': return `Sync from ${sourceName} is done: ${job.progress.done} items synced.`
    case 'failed': return `Sync from ${sourceName} failed.${job.error ? ` ${job.error}` : ''}`
    case 'cancelled': return `Sync from ${sourceName} was cancelled.`
  }
}

/**
 * Where one sync job stands: its status, how many source items it has synced, the warnings and
 * error the account reported, and when it started or finished, with Cancel while it runs and,
 * with `onDismiss`, Dismiss once it has ended. A change of status is announced politely, and so is how a job already ended when first shown
 * ended, as one started a moment ago may have. Everything shown comes from the job as last read;
 * after a cancel, reading it again is the caller's, through `onCancelled`, and the focus Cancel
 * held moves to the progress itself, since Cancel goes once the job reads as cancelled.
 */
export const SpaceSyncProgress = ({ job, sourceName, onCancelled, onDismiss }: {
  job: SpaceSyncJobInfo
  /** What the job's source is called, such as its vendor's display name. */
  sourceName: string
  /** The job was cancelled: its new status is for the caller to read. */
  onCancelled: () => void
  /** Puts the job, once it has ended, out of view. */
  onDismiss?: () => void
}) => {
  const { authenticatedApi } = useAuthenticatedApi()
  const [cancelling, setCancelling] = useState(false)
  const [cancelFailure, setCancelFailure] = useState<string | null>(null)
  const sectionRef = useRef<HTMLElement>(null)
  // The status last rendered, so that a running job is announced only once its status changes.
  const [seen, setSeen] = useState({ jobId: job.jobId, status: job.status, announcement: '' })
  if (seen.jobId !== job.jobId || seen.status !== job.status) {
    const changed = seen.jobId === job.jobId || job.status !== 'running'
    setSeen({ jobId: job.jobId, status: job.status, announcement: changed ? announcementFor(job, sourceName) : '' })
  }
  // A live region announces only what changes in it once it is in the document, so a job that
  // has already ended when first shown is announced after the region has mounted.
  const announceEnded = useEffectEvent(() => {
    if (job.status === 'running') return
    setSeen({ jobId: job.jobId, status: job.status, announcement: announcementFor(job, sourceName) })
  })
  useEffect(() => announceEnded(), [])

  const running = job.status === 'running'
  const { done, total, warnings } = job.progress
  const max = total === undefined ? undefined : Math.max(total, done)
  const counted = `${done} of ${max} items synced`
  // Named for when it started too, so that the jobs of one source listed together can be told apart.
  const subject = `${sourceName} started ${formatFullTimestamp(job.created)}`

  const handleCancel = async () => {
    if (cancelling) return
    setCancelling(true)
    setCancelFailure(null)
    try {
      await authenticatedApi.cancelSpaceSync(job.jobId)
      const section = sectionRef.current
      const focused = document.activeElement
      if (section && (focused === null || focused === document.body || section.contains(focused))) section.focus()
      onCancelled()
    } catch (err) {
      logRpcFailure('Failed to cancel a space sync:', err)
      setCancelFailure(rpcFailureDescription(err) ?? 'Couldn’t cancel the sync. Try again.')
    } finally {
      setCancelling(false)
    }
  }

  return (
    <section
      ref={sectionRef}
      tabIndex={-1}
      aria-label={`Sync from ${subject}`}
      className="flex flex-col gap-3 rounded-xl border border-kumo-line bg-kumo-base px-3 py-3 outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={STATUS_BADGES[job.status]} className="shrink-0">
          {SPACE_SYNC_STATUS_LABELS[job.status]}
        </Badge>
        <span className="min-w-0 truncate text-[12px] leading-4 text-kumo-subtle">
          {job.finished
            ? `Finished ${formatFullTimestamp(job.finished)}`
            : `Started ${formatFullTimestamp(job.created)}`}
        </span>
        {running && (
          <WorkshopButton
            className={`${SPACE_ACTION_CLASS_NAME} ml-auto`}
            aria-label={`${cancelling ? 'Cancelling' : 'Cancel'} sync from ${subject}`}
            disabled={cancelling}
            onClick={() => void handleCancel()}
          >
            {cancelling ? 'Cancelling…' : 'Cancel'}
          </WorkshopButton>
        )}
        {!running && onDismiss && (
          <WorkshopButton
            className={`${SPACE_ACTION_CLASS_NAME} ml-auto`}
            aria-label={`Dismiss sync from ${subject}`}
            onClick={onDismiss}
          >
            Dismiss
          </WorkshopButton>
        )}
      </div>

      {max === undefined ? (
        <p className="text-[12px] leading-4 text-kumo-default">
          {running ? `${done} items synced so far` : `${done} items synced`}
        </p>
      ) : (
        <Meter
          label="Items synced"
          value={done}
          max={Math.max(max, 1)}
          customValue={`${done} of ${max}`}
          getAriaValueText={() => counted}
        />
      )}

      {warnings.length > 0 && (
        <Collapsible.Root>
          <Collapsible.DefaultTrigger className="w-fit text-[12px]">
            {warnings.length === 1 ? '1 warning' : `${warnings.length} warnings`}
          </Collapsible.DefaultTrigger>
          <Collapsible.DefaultPanel>
            <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto text-[12px] leading-4 text-kumo-default">
              {warnings.map((warning, index) => (
                // Warnings are plain text and may repeat, so their place is their identity.
                <li key={index}>{warning}</li>
              ))}
            </ul>
          </Collapsible.DefaultPanel>
        </Collapsible.Root>
      )}

      {job.status === 'failed' && (
        <p className="text-[12px] leading-4 text-kumo-danger">
          {job.error ?? 'The sync failed.'}
        </p>
      )}
      {cancelFailure && <p role="alert" className="text-[12px] leading-4 text-kumo-danger">{cancelFailure}</p>}
      <p role="status" className="sr-only">{seen.announcement}</p>
    </section>
  )
}
