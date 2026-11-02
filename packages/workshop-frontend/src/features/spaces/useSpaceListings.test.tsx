// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SpaceWorkspaceInfo } from '@gadgets/workshop-shared/api'
import {
  ME,
  deferred,
  fakeApi,
  fakeSpace,
  member,
  mount,
  person,
  settle,
  teamSpace,
  unmountAll,
} from './spacesTestUtils'
import { asMemberListing, useSpaceListings } from './useSpaceListings'

const ADA = person('ada@example.com', 'Ada')
const DAY = new Date('2026-09-01T00:00:00Z')

const workspace = (id: string): SpaceWorkspaceInfo => ({ id, title: id, owner: ADA, created: DAY })

// A space the user is a member of unless `asMember` says otherwise, listing these workspaces.
const space = (key: string, workspaces: SpaceWorkspaceInfo[], asMember = true) =>
  fakeSpace(teamSpace(key, key), asMember ? [member(ME, 'use')] : [], workspaces)

describe('useSpaceListings', () => {
  let current: ReturnType<typeof useSpaceListings>

  const Probe = ({ keys }: { keys: string[] }) => {
    current = useSpaceListings(keys)
    return null
  }

  afterEach(() => {
    unmountAll()
    vi.restoreAllMocks()
  })

  it('reads what each space lists, and disposes every space it opened', async () => {
    const opened: Record<string, ReturnType<typeof space>> = {
      design: space('design', []),
      platform: space('platform', [workspace('w-plan')]),
    }
    const openSpace = vi.fn<(key: string) => unknown>(key => opened[key])
    await mount(<Probe keys={['design', 'platform']} />, fakeApi({ openSpace }))
    await settle()

    expect(current.listings).toEqual({
      design: { status: 'ready', workspaces: [], asMember: true },
      platform: { status: 'ready', workspaces: [workspace('w-plan')], asMember: true },
    })
    expect(openSpace.mock.calls).toEqual([['design'], ['platform']])
    for (const each of Object.values(opened)) expect(each[Symbol.dispose]).toHaveBeenCalledOnce()
  })

  it('tells a space that refuses the user from one that could not be read, and keeps the others', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const broken = space('broken', [])
    broken.listWorkspaces.mockRejectedValue(new Error('boom'))
    const spaces: Record<string, unknown> = {
      broken,
      left: space('left', [], false),
      platform: space('platform', [workspace('w-plan')]),
    }
    await mount(
      <Probe keys={['broken', 'left', 'platform']} />,
      fakeApi({ openSpace: (key: string) => spaces[key] }),
    )
    await settle()

    expect(current.listings).toEqual({
      broken: { status: 'failed' },
      left: { status: 'refused' },
      platform: { status: 'ready', workspaces: [workspace('w-plan')], asMember: true },
    })
    expect(broken[Symbol.dispose]).toHaveBeenCalledOnce()
  })

  it('tells a listing read as a visitor, the published entries only, from a member’s', async () => {
    const published: SpaceWorkspaceInfo = { ...workspace('w-brief'), published: 'use' }
    const spaces: Record<string, unknown> = {
      visited: space('visited', [workspace('w-plan'), published], false),
      platform: space('platform', [workspace('w-plan'), published]),
    }
    await mount(<Probe keys={['visited', 'platform']} />, fakeApi({ openSpace: (key: string) => spaces[key] }))
    await settle()

    expect(current.listings).toEqual({
      visited: { status: 'ready', workspaces: [published], asMember: false },
      platform: { status: 'ready', workspaces: [workspace('w-plan'), published], asMember: true },
    })
    expect(asMemberListing(current.listings.visited)).toEqual({ status: 'refused' })
    expect(asMemberListing(current.listings.platform)).toBe(current.listings.platform)
  })

  it('reads one space again on reload, and leaves the others unread', async () => {
    let listed = [workspace('w-plan')]
    const openSpace = vi.fn<(key: string) => unknown>(key =>
      space(key, key === 'platform' ? listed : []))
    await mount(<Probe keys={['design', 'platform']} />, fakeApi({ openSpace }))
    await settle()

    listed = [workspace('w-next'), workspace('w-plan')]
    await act(() => current.reload('platform'))

    expect(current.listings.platform).toEqual({ status: 'ready', workspaces: listed, asMember: true })
    expect(openSpace.mock.calls).toEqual([['design'], ['platform'], ['platform']])
  })

  it('keeps the newer of two reads of one space when the older one settles last', async () => {
    const older = deferred<SpaceWorkspaceInfo[]>()
    const first = space('platform', [])
    first.listWorkspaces.mockImplementation(() => older.promise)
    const openSpace = vi.fn<(key: string) => unknown>(() => space('platform', [workspace('w-new')]))
      .mockImplementationOnce(() => first)
    await mount(<Probe keys={['platform']} />, fakeApi({ openSpace }))
    await settle()
    expect(current.listings).toEqual({})

    await act(() => current.reload('platform'))
    await act(async () => older.resolve([workspace('w-old')]))
    await settle()

    expect(current.listings.platform).toEqual({ status: 'ready', workspaces: [workspace('w-new')], asMember: true })
    expect(first[Symbol.dispose]).toHaveBeenCalledOnce()
  })

  it('reads every space again when the set changes, and drops a read begun for the set before', async () => {
    const before = deferred<SpaceWorkspaceInfo[]>()
    const first = space('platform', [])
    first.listWorkspaces.mockImplementation(() => before.promise)
    const openSpace = vi.fn<(key: string) => unknown>(key =>
      space(key, key === 'platform' ? [workspace('w-new')] : []))
      .mockImplementationOnce(() => first)
    const api = fakeApi({ openSpace })
    const { rerender } = await mount(<Probe keys={['platform']} />, api)
    await settle()

    await rerender(<Probe keys={['platform', 'design']} />, api)
    await settle()
    await act(async () => before.resolve([workspace('w-old')]))
    await settle()

    expect(current.listings).toEqual({
      platform: { status: 'ready', workspaces: [workspace('w-new')], asMember: true },
      design: { status: 'ready', workspaces: [], asMember: true },
    })
  })

  it('does not read again when the same set arrives as another array', async () => {
    const openSpace = vi.fn<(key: string) => unknown>(key => space(key, []))
    const api = fakeApi({ openSpace })
    const { rerender } = await mount(<Probe keys={['design', 'platform']} />, api)
    await settle()

    await rerender(<Probe keys={['design', 'platform']} />, api)
    await settle()

    expect(openSpace).toHaveBeenCalledTimes(2)
  })

  it('asks a session for nothing before its own flags say the flag is on', async () => {
    const flags = deferred<{ spaces: boolean }>()
    const openSpace = vi.fn<(key: string) => unknown>(key => space(key, []))
    await mount(<Probe keys={['platform']} />, fakeApi({ getUiFeatureFlags: () => flags.promise, openSpace }))
    await settle()
    expect(openSpace).not.toHaveBeenCalled()

    await act(async () => flags.resolve({ spaces: true }))
    await settle()
    expect(openSpace.mock.calls).toEqual([['platform']])
    expect(current.listings.platform).toEqual({ status: 'ready', workspaces: [], asMember: true })
  })

  it('reads nothing while the flag is off', async () => {
    const openSpace = vi.fn<(key: string) => unknown>(key => space(key, []))
    await mount(<Probe keys={['platform']} />, fakeApi({ openSpace }, { spacesFlag: false }))
    await settle()

    expect(openSpace).not.toHaveBeenCalled()
    expect(current.listings).toEqual({})
  })

  it('shows nothing read under a session that has been replaced', async () => {
    const late = deferred<SpaceWorkspaceInfo[]>()
    const { rerender } = await mount(
      <Probe keys={['platform']} />,
      fakeApi({ openSpace: () => space('platform', [workspace('w-old')]) }),
    )
    await settle()
    expect(current.listings.platform).toEqual({ status: 'ready', workspaces: [workspace('w-old')], asMember: true })

    const next = space('platform', [])
    next.listWorkspaces.mockImplementation(() => late.promise)
    await rerender(<Probe keys={['platform']} />, fakeApi({ openSpace: () => next }))
    await settle()
    expect(current.listings).toEqual({})

    await act(async () => late.resolve([workspace('w-new')]))
    await settle()
    expect(current.listings.platform).toEqual({ status: 'ready', workspaces: [workspace('w-new')], asMember: true })
  })
})
