// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SpaceSyncJobInfo } from '@gadgets/workshop-shared/api'
import { deferred, fakeApi, mount, unmountAll } from '../spacesTestUtils'
import { SPACE_SYNC_POLL_INTERVAL_MS, useSpaceSyncJobs } from './useSpaceSyncJobs'

const job = (jobId: string, status: SpaceSyncJobInfo['status'], done = 0): SpaceSyncJobInfo => ({
  jobId,
  accountId: 1,
  vendorId: 'docs',
  spaceKey: 'design',
  blueprintId: 'document',
  publication: 'use',
  status,
  progress: { done, warnings: [] },
  created: new Date('2026-10-01T00:00:00Z'),
  ...(status !== 'running' && { finished: new Date('2026-10-01T00:05:00Z') }),
})

type List = (spaceKey?: string) => Promise<SpaceSyncJobInfo[]>

let visibility: DocumentVisibilityState = 'visible'
const setVisibility = (next: DocumentVisibilityState) => act(async () => {
  visibility = next
  document.dispatchEvent(new Event('visibilitychange'))
})

// Lets pending promises settle without running a poll that is due later.
const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0) })
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

describe('useSpaceSyncJobs', () => {
  let current: ReturnType<typeof useSpaceSyncJobs>
  const Probe = ({ spaceKey = 'design' }: { spaceKey?: string | null }) => {
    current = useSpaceSyncJobs(spaceKey ?? undefined)
    return null
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    visibility = 'visible'
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
  })

  afterEach(() => {
    unmountAll()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('reads the space’s jobs, and reads again while one runs until none does', async () => {
    const listSpaceSyncJobs = vi.fn<List>()
      .mockResolvedValueOnce([job('j1', 'running', 1)])
      .mockResolvedValueOnce([job('j1', 'running', 4)])
      .mockResolvedValueOnce([job('j1', 'done', 9)])
    await mount(<Probe />, fakeApi({ listSpaceSyncJobs }))
    await flush()

    expect(listSpaceSyncJobs.mock.calls).toEqual([['design']])
    expect(current.running?.progress.done).toBe(1)

    await advance(SPACE_SYNC_POLL_INTERVAL_MS)
    expect(current.running?.progress.done).toBe(4)

    await advance(SPACE_SYNC_POLL_INTERVAL_MS)
    expect(current.jobs).toEqual([job('j1', 'done', 9)])
    expect(current.running).toBeUndefined()

    await advance(SPACE_SYNC_POLL_INTERVAL_MS * 5)
    expect(listSpaceSyncJobs).toHaveBeenCalledTimes(3)
  })

  it('reads once and stops when no job runs', async () => {
    const listSpaceSyncJobs = vi.fn<List>(async () => [job('j1', 'done')])
    await mount(<Probe />, fakeApi({ listSpaceSyncJobs }))
    await flush()
    await advance(SPACE_SYNC_POLL_INTERVAL_MS * 3)

    expect(listSpaceSyncJobs).toHaveBeenCalledOnce()
    expect(current).toMatchObject({ jobs: [job('j1', 'done')], running: undefined, failed: false })
  })

  it('pauses while the document is hidden, and reads at once when it is visible again', async () => {
    const listSpaceSyncJobs = vi.fn<List>(async () => [job('j1', 'running')])
    await mount(<Probe />, fakeApi({ listSpaceSyncJobs }))
    await flush()
    expect(listSpaceSyncJobs).toHaveBeenCalledOnce()

    await setVisibility('hidden')
    await advance(SPACE_SYNC_POLL_INTERVAL_MS * 4)
    expect(listSpaceSyncJobs).toHaveBeenCalledOnce()

    await setVisibility('visible')
    await flush()
    expect(listSpaceSyncJobs).toHaveBeenCalledTimes(2)

    await advance(SPACE_SYNC_POLL_INTERVAL_MS)
    expect(listSpaceSyncJobs).toHaveBeenCalledTimes(3)
  })

  it('arms no poll for a read that settles after the document was hidden', async () => {
    const inFlight = deferred<SpaceSyncJobInfo[]>()
    const listSpaceSyncJobs = vi.fn<List>()
      .mockReturnValueOnce(inFlight.promise)
      .mockResolvedValue([job('j1', 'running')])
    await mount(<Probe />, fakeApi({ listSpaceSyncJobs }))
    await setVisibility('hidden')

    inFlight.resolve([job('j1', 'running')])
    await flush()
    expect(current.running?.jobId).toBe('j1')
    await advance(SPACE_SYNC_POLL_INTERVAL_MS * 4)
    expect(listSpaceSyncJobs).toHaveBeenCalledOnce()

    await setVisibility('visible')
    await flush()
    expect(listSpaceSyncJobs).toHaveBeenCalledTimes(2)
  })

  it('never lets a read that settles late replace a newer one', async () => {
    const slow = deferred<SpaceSyncJobInfo[]>()
    const listSpaceSyncJobs = vi.fn<List>()
      .mockReturnValueOnce(slow.promise)
      .mockResolvedValueOnce([job('j2', 'running'), job('j1', 'done')])
    await mount(<Probe />, fakeApi({ listSpaceSyncJobs }))
    await act(async () => { await current.refresh() })

    expect(current.running?.jobId).toBe('j2')

    slow.resolve([job('j1', 'running')])
    await flush()
    expect(current.jobs?.map(each => each.jobId)).toEqual(['j2', 'j1'])
    expect(current.running?.jobId).toBe('j2')
  })

  it('follows a job started after the first read once it is refreshed', async () => {
    const listSpaceSyncJobs = vi.fn<List>()
      .mockResolvedValueOnce([])
      .mockResolvedValue([job('j1', 'running')])
    await mount(<Probe />, fakeApi({ listSpaceSyncJobs }))
    await flush()
    expect(current.jobs).toEqual([])
    await advance(SPACE_SYNC_POLL_INTERVAL_MS * 2)
    expect(listSpaceSyncJobs).toHaveBeenCalledOnce()

    await act(async () => { await current.refresh() })
    expect(current.running?.jobId).toBe('j1')
    await advance(SPACE_SYNC_POLL_INTERVAL_MS)
    expect(listSpaceSyncJobs).toHaveBeenCalledTimes(3)
  })

  it('stops polling on unmount', async () => {
    const listSpaceSyncJobs = vi.fn<List>(async () => [job('j1', 'running')])
    const { unmount } = await mount(<Probe />, fakeApi({ listSpaceSyncJobs }))
    await flush()
    await unmount()
    await advance(SPACE_SYNC_POLL_INTERVAL_MS * 3)

    expect(listSpaceSyncJobs).toHaveBeenCalledOnce()
  })

  it('keeps the jobs it has through a failed read, and retries while one runs', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const listSpaceSyncJobs = vi.fn<List>()
      .mockResolvedValueOnce([job('j1', 'running', 2)])
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce([job('j1', 'running', 5)])
    await mount(<Probe />, fakeApi({ listSpaceSyncJobs }))
    await flush()

    await advance(SPACE_SYNC_POLL_INTERVAL_MS)
    expect(current.failed).toBe(true)
    expect(current.running?.progress.done).toBe(2)

    await advance(SPACE_SYNC_POLL_INTERVAL_MS)
    expect(current.failed).toBe(false)
    expect(current.running?.progress.done).toBe(5)
  })

  it('retries a failed read when no job was seen running, so that a job just started is followed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const listSpaceSyncJobs = vi.fn<List>()
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue([job('j1', 'running')])
    await mount(<Probe />, fakeApi({ listSpaceSyncJobs }))
    await flush()

    // As after a start: the read that would have found the new job fails.
    await act(async () => { await current.refresh() })
    expect(current).toMatchObject({ running: undefined, failed: true })

    await advance(SPACE_SYNC_POLL_INTERVAL_MS)
    expect(current).toMatchObject({ running: job('j1', 'running'), failed: false })
    await advance(SPACE_SYNC_POLL_INTERVAL_MS)
    expect(listSpaceSyncJobs).toHaveBeenCalledTimes(4)
  })

  it('retries a read that keeps failing less often each time', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const listSpaceSyncJobs = vi.fn<List>().mockRejectedValue(new Error('boom'))
    await mount(<Probe />, fakeApi({ listSpaceSyncJobs }))
    await flush()
    expect(listSpaceSyncJobs).toHaveBeenCalledTimes(1)

    await advance(SPACE_SYNC_POLL_INTERVAL_MS)
    expect(listSpaceSyncJobs).toHaveBeenCalledTimes(2)
    await advance(SPACE_SYNC_POLL_INTERVAL_MS)
    expect(listSpaceSyncJobs).toHaveBeenCalledTimes(2)
    await advance(SPACE_SYNC_POLL_INTERVAL_MS)
    expect(listSpaceSyncJobs).toHaveBeenCalledTimes(3)
  })

  it('reads again when the document is visible again, though no job ran, for one started elsewhere', async () => {
    const listSpaceSyncJobs = vi.fn<List>()
      .mockResolvedValueOnce([])
      .mockResolvedValue([job('j1', 'running')])
    await mount(<Probe />, fakeApi({ listSpaceSyncJobs }))
    await flush()

    await setVisibility('hidden')
    await setVisibility('visible')
    await flush()

    expect(listSpaceSyncJobs).toHaveBeenCalledTimes(2)
    expect(current.running?.jobId).toBe('j1')
  })

  it('says a first read failed, with nothing to show', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const listSpaceSyncJobs = vi.fn<List>().mockRejectedValue(new Error('boom'))
    await mount(<Probe />, fakeApi({ listSpaceSyncJobs }))
    await flush()

    expect(current).toMatchObject({ jobs: null, running: undefined, failed: true })
  })

  it('shows another space’s jobs only once they are read for it', async () => {
    const other = deferred<SpaceSyncJobInfo[]>()
    const listSpaceSyncJobs = vi.fn<List>()
      .mockResolvedValueOnce([job('j1', 'done')])
      .mockReturnValueOnce(other.promise)
    const { rerender } = await mount(<Probe />, fakeApi({ listSpaceSyncJobs }))
    await flush()
    expect(current.jobs).toHaveLength(1)

    await rerender(<Probe spaceKey="platform" />)
    expect(current.jobs).toBeNull()
    expect(listSpaceSyncJobs).toHaveBeenLastCalledWith('platform')

    other.resolve([])
    await flush()
    expect(current.jobs).toEqual([])
  })

  it('reads nothing without a space, and starts once it has one', async () => {
    const listSpaceSyncJobs = vi.fn<List>(async () => [job('j1', 'done')])
    const { rerender } = await mount(<Probe spaceKey={null} />, fakeApi({ listSpaceSyncJobs }))
    await flush()
    expect(listSpaceSyncJobs).not.toHaveBeenCalled()
    expect(current.jobs).toBeNull()

    await rerender(<Probe />)
    await flush()
    expect(listSpaceSyncJobs.mock.calls).toEqual([['design']])
  })

  it('reads nothing while the spaces flag is off', async () => {
    const listSpaceSyncJobs = vi.fn<List>(async () => [])
    await mount(<Probe />, fakeApi({ listSpaceSyncJobs }, { spacesFlag: false }))
    await flush()

    expect(listSpaceSyncJobs).not.toHaveBeenCalled()
    expect(current.jobs).toBeNull()
  })
})
