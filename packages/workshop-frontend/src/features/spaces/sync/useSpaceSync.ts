import { useState } from 'react'
import type { SpaceSyncJobInfo } from '@gadgets/workshop-shared/api'
import { useSpaceSyncAccounts, type SpaceSyncAccount } from './useSpaceSyncAccounts'
import { useSpaceSyncJobs, type SpaceSyncJobs } from './useSpaceSyncJobs'

/**
 * How long before a page showing a space was opened the newest of the user's syncs into it may
 * have ended and still be shown there, though the page never saw it running: a sync started
 * before a reload, or from another tab, then still says how it ended.
 */
export const RECENTLY_ENDED_MS = 24 * 60 * 60 * 1000

// Where the jobs whose outcome the user put out of view are kept, for as long as the tab is open.
const DISMISSED_KEY = 'gadgets.spaces.dismissedSyncJobs'

// Storage that cannot be read holds no dismissal, and one that cannot be written keeps a new one
// for this page only.
const readDismissed = (): ReadonlySet<string> => {
  try {
    const stored: unknown = JSON.parse(sessionStorage.getItem(DISMISSED_KEY) ?? '[]')
    return new Set(Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : [])
  } catch {
    return new Set()
  }
}
const writeDismissed = (ids: ReadonlySet<string>) => {
  try {
    sessionStorage.setItem(DISMISSED_KEY, JSON.stringify([...ids]))
  } catch {
    // Kept in memory instead.
  }
}

/** What a page showing a space offers of syncing sources into it (`useSpaceSync`). */
export type SpaceSync = {
  /**
   * The user's connected accounts that can sync into the space (`useSpaceSyncAccounts`); none
   * unless the user may add workspaces to it. Nothing of syncing is offered, shown or read
   * without one.
   */
  accounts: SpaceSyncAccount[]
  /** The user's own sync jobs into the space. */
  jobs: SpaceSyncJobs
  /**
   * The jobs to show: those running, or else the newest one that has ended of those followed
   * here and the newest of all when it ended shortly before the page opened
   * (`RECENTLY_ENDED_MS`), so that how it ended stays in view until it is dismissed.
   */
  shown: SpaceSyncJobInfo[]
  /** Follows a job just started here, which may already have ended, and reads the jobs again. */
  follow: (job: SpaceSyncJobInfo) => void
  /** Puts a job that has ended out of view, for as long as the browser tab is open. */
  dismiss: (job: SpaceSyncJobInfo) => void
  /**
   * Changes each time another job followed here is seen to have ended: a sync that ends, however
   * it ends, may have created workspaces or replaced one, so what shows them is read again.
   * Empty until one has.
   */
  endedKey: string
  /** What the source of a job is called: the display name of its account's vendor. */
  sourceNameOf: (job: SpaceSyncJobInfo) => string
}

const NO_JOB_IDS: ReadonlySet<string> = new Set()

/**
 * Syncs into the space `spaceKey` for a page that shows it, undefined while the page does not know
 * the space yet: the accounts that may start one, which are none unless `canAddWorkspaces`, and
 * the user's jobs into it, which are read only while there is such an account and are followed
 * from the moment this page sees one running or starts one.
 */
export const useSpaceSync = (spaceKey: string | undefined, canAddWorkspaces: boolean): SpaceSync => {
  const { accounts } = useSpaceSyncAccounts()
  const offered = spaceKey !== undefined && canAddWorkspaces ? accounts : []
  const jobs = useSpaceSyncJobs(offered.length > 0 ? spaceKey : undefined)
  const [openedAt] = useState(() => Date.now())
  const [dismissed, setDismissed] = useState(readDismissed)
  const followedKey = spaceKey ?? ''
  const [followed, setFollowed] = useState<{ spaceKey: string; ids: ReadonlySet<string> }>(
    { spaceKey: followedKey, ids: NO_JOB_IDS },
  )
  const followedIds = followed.spaceKey === followedKey ? followed.ids : NO_JOB_IDS
  const followAlso = (ids: readonly string[]) =>
    setFollowed(previous => ({
      spaceKey: followedKey,
      ids: new Set([...(previous.spaceKey === followedKey ? previous.ids : []), ...ids]),
    }))

  const listed = jobs.jobs ?? []
  const running = listed.filter(job => job.status === 'running')
  const unfollowed = running.filter(job => !followedIds.has(job.jobId))
  if (unfollowed.length > 0) followAlso(unfollowed.map(job => job.jobId))
  const ended = listed.filter(job => job.status !== 'running' && followedIds.has(job.jobId))
  const endedRecently = (job: SpaceSyncJobInfo) =>
    job === listed[0] && job.finished !== undefined && openedAt - job.finished.getTime() < RECENTLY_ENDED_MS
  const outcomes = listed.filter(job => job.status !== 'running' && !dismissed.has(job.jobId)
    && (followedIds.has(job.jobId) || endedRecently(job)))

  return {
    accounts: offered,
    jobs,
    shown: running.length > 0 ? running : outcomes.slice(0, 1),
    follow: (job) => {
      followAlso([job.jobId])
      void jobs.refresh()
    },
    dismiss: (job) => {
      const next = new Set([...readDismissed(), ...dismissed, job.jobId])
      writeDismissed(next)
      setDismissed(next)
    },
    endedKey: ended.map(job => job.jobId).join(' '),
    sourceNameOf: (job) => (accounts.find(account => account.id === job.accountId)
      ?? accounts.find(account => account.vendorId === job.vendorId))?.vendorName ?? 'its source',
  }
}
