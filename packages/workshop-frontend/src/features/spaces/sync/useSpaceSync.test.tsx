// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConnectedAccountsSubscriber, SpaceSyncJobInfo } from '@gadgets/workshop-shared/api'
import { fakeApi, mount, settle, unmountAll } from '../spacesTestUtils'
import { RECENTLY_ENDED_MS, useSpaceSync } from './useSpaceSync'

const HOUR = 60 * 60 * 1000

const job = (jobId: string, status: SpaceSyncJobInfo['status'], endedAgo = HOUR): SpaceSyncJobInfo => ({
  jobId,
  accountId: 7,
  vendorId: 'docs',
  spaceKey: 'design',
  blueprintId: 'document',
  publication: 'use',
  status,
  progress: { done: 0, warnings: [] },
  created: new Date(Date.now() - endedAgo - HOUR),
  ...(status !== 'running' && { finished: new Date(Date.now() - endedAgo) }),
})

type List = (spaceKey?: string) => Promise<SpaceSyncJobInfo[]>

// The user's connected accounts: one that can sync into a space unless `syncs` is false.
const accountsSubscription = ({ syncs = true } = {}) => (subscriber: ConnectedAccountsSubscriber) => {
  subscriber.add(7, {
    displayName: 'Work docs',
    avatar: { url: 'https://docs.example.com/a' },
    ...(syncs && { providesSpaceSync: { blueprintId: 'document', importMethods: ['importSnapshot'] } }),
  }, { displayName: 'Docs Hub', url: 'https://docs.example.com/' }, [], true, 'docs')
  subscriber.ready()
  return Object.assign(Promise.resolve({ [Symbol.dispose]() {} }), { [Symbol.dispose]() {} })
}

let current: ReturnType<typeof useSpaceSync>
const Probe = ({ spaceKey, canAddWorkspaces = true }: { spaceKey: string | undefined; canAddWorkspaces?: boolean }) => {
  current = useSpaceSync(spaceKey, canAddWorkspaces)
  return null
}

// `spaceKey` is null for a space not known yet.
const render = async ({ spaceKey = 'design' as string | null, canAddWorkspaces = true, syncs = true, jobs = [] as SpaceSyncJobInfo[] } = {}) => {
  const listSpaceSyncJobs = vi.fn<List>(async () => jobs)
  const api = fakeApi({ listSpaceSyncJobs, subscribeConnectedAccounts: accountsSubscription({ syncs }) })
  const view = await mount(<Probe spaceKey={spaceKey ?? undefined} canAddWorkspaces={canAddWorkspaces} />, api)
  await settle()
  return { ...view, listSpaceSyncJobs }
}

describe('useSpaceSync', () => {
  afterEach(() => {
    unmountAll()
    sessionStorage.clear()
    vi.restoreAllMocks()
  })

  it('reads the jobs once the space is known and the user has an account that can sync into it', async () => {
    const { listSpaceSyncJobs } = await render()

    expect(listSpaceSyncJobs.mock.calls).toEqual([['design']])
    expect(current.accounts.map(account => account.id)).toEqual([7])
  })

  it('reads no jobs before the space is known', async () => {
    const { listSpaceSyncJobs } = await render({ spaceKey: null })

    expect(listSpaceSyncJobs).not.toHaveBeenCalled()
    expect(current.accounts).toEqual([])
  })

  it('reads no jobs for a user who may not add workspaces to the space', async () => {
    const { listSpaceSyncJobs } = await render({ canAddWorkspaces: false })

    expect(listSpaceSyncJobs).not.toHaveBeenCalled()
    expect(current.accounts).toEqual([])
  })

  it('reads no jobs for a user with no account that can sync', async () => {
    const { listSpaceSyncJobs } = await render({ syncs: false })

    expect(listSpaceSyncJobs).not.toHaveBeenCalled()
  })

  it('shows how the newest sync ended when it ended shortly before, though it was never seen running', async () => {
    await render({ jobs: [job('j2', 'failed'), job('j1', 'done', 2 * HOUR)] })

    expect(current.shown.map(shown => shown.jobId)).toEqual(['j2'])
    expect(current.endedKey).toBe('')
  })

  it('shows no sync that ended long before', async () => {
    await render({ jobs: [job('j1', 'done', RECENTLY_ENDED_MS + HOUR)] })

    expect(current.shown).toEqual([])
  })

  it('puts a dismissed sync out of view, and keeps it out for the rest of the session', async () => {
    const jobs = [job('j1', 'done')]
    await render({ jobs })
    expect(current.shown.map(shown => shown.jobId)).toEqual(['j1'])

    await act(async () => current.dismiss(jobs[0]))
    expect(current.shown).toEqual([])

    unmountAll()
    await render({ jobs })
    expect(current.shown).toEqual([])
  })
})
