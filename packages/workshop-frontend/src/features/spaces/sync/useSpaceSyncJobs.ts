import { useEffect, useRef, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, SpaceSyncJobInfo } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../../AuthContext'
import { useUiFeatureFlag } from '../../../FeatureFlagsContext'
import { logRpcFailure } from '../../../rpcErrors'

/** How long a running job's progress waits before it is read again. */
export const SPACE_SYNC_POLL_INTERVAL_MS = 3000

// The most a failed read's retry waits, as a multiple of the poll interval.
const MAX_RETRY_BACKOFF = 16

/** The caller's sync jobs into one space, as last read. */
export type SpaceSyncJobs = {
  /** Newest first; null until the first read has settled. */
  jobs: SpaceSyncJobInfo[] | null
  /** The newest of them still running. The server runs one at a time per user and space. */
  running: SpaceSyncJobInfo | undefined
  /** The last read failed; the jobs shown, if any, are from the read before it. */
  failed: boolean
  /** Reads the jobs again now, resolving once the read has settled. */
  refresh: () => Promise<void>
}

type Read = {
  api: RpcStub<AuthenticatedApi>
  spaceKey: string
  jobs: SpaceSyncJobInfo[] | null
  failed: boolean
}

const isRunning = (job: SpaceSyncJobInfo) => job.status === 'running'

/**
 * Follows the signed-in user's own sync jobs into the space `spaceKey` by polling
 * `listSpaceSyncJobs`, since nothing is pushed: every few seconds while one of them is running
 * and the document is visible, at once when the document becomes visible again, since a job may
 * have started elsewhere meanwhile, and whenever `refresh` is called, as after starting,
 * cancelling or re-syncing a job. A failed read is retried, less often each time it fails again,
 * since a job started just before it may be running unseen. Polling stops once a read finds no
 * job running, and on unmount. A read that settles after a later one is dropped, so a slow
 * response never replaces a newer one. Reads nothing while `spaceKey` is undefined, as for a
 * page that offers no sync, or the `spaces` flag is off.
 */
export const useSpaceSyncJobs = (spaceKey: string | undefined): SpaceSyncJobs => {
  const { authenticatedApi } = useAuthenticatedApi()
  const { enabled } = useUiFeatureFlag('spaces')
  const [read, setRead] = useState<Read | null>(null)
  const refreshRef = useRef<(() => Promise<void>) | null>(null)

  useEffect(() => {
    if (!enabled || spaceKey === undefined) return
    let cancelled = false
    let issued = 0
    let applied = 0
    let anyRunning = false
    // How many reads in a row have failed.
    let failures = 0
    let timer: ReturnType<typeof setTimeout> | undefined

    const stopTimer = () => {
      clearTimeout(timer)
      timer = undefined
    }
    const schedule = () => {
      stopTimer()
      if (cancelled || document.visibilityState !== 'visible') return
      if (failures > 0) {
        const backoff = Math.min(2 ** (failures - 1), MAX_RETRY_BACKOFF)
        timer = setTimeout(() => void load(), SPACE_SYNC_POLL_INTERVAL_MS * backoff)
      } else if (anyRunning) {
        timer = setTimeout(() => void load(), SPACE_SYNC_POLL_INTERVAL_MS)
      }
    }
    const load = async () => {
      const request = ++issued
      stopTimer()
      let jobs: SpaceSyncJobInfo[] | undefined
      try {
        jobs = await authenticatedApi.listSpaceSyncJobs(spaceKey)
      } catch (err) {
        if (!cancelled) logRpcFailure('Failed to read space sync jobs:', err)
      }
      if (cancelled || request <= applied) return
      applied = request
      if (jobs) {
        failures = 0
        anyRunning = jobs.some(isRunning)
        setRead({ api: authenticatedApi, spaceKey, jobs, failed: false })
      } else {
        failures += 1
        setRead(previous => ({
          api: authenticatedApi,
          spaceKey,
          jobs: previous?.api === authenticatedApi && previous.spaceKey === spaceKey ? previous.jobs : null,
          failed: true,
        }))
      }
      // Only the newest read schedules the next one: an older one settling first leaves that to it.
      if (request === issued) schedule()
    }
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') stopTimer()
      else void load()
    }

    refreshRef.current = load
    document.addEventListener('visibilitychange', onVisibilityChange)
    void load()
    return () => {
      cancelled = true
      stopTimer()
      refreshRef.current = null
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [authenticatedApi, enabled, spaceKey])

  const current = enabled && read?.api === authenticatedApi && read.spaceKey === spaceKey ? read : null
  const jobs = current?.jobs ?? null
  return {
    jobs,
    running: jobs?.find(isRunning),
    failed: current?.failed ?? false,
    refresh: () => refreshRef.current?.() ?? Promise.resolve(),
  }
}
