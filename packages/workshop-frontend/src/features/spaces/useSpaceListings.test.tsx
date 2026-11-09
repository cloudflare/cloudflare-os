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
  invalidSpaceId,
  member,
  mount,
  notAMember,
  person,
  settle,
  teamSpace,
  unmountAll,
} from './spacesTestUtils'
import { useSpaceListings } from './useSpaceListings'

const ADA = person('ada@example.com', 'Ada')
const DAY = new Date('2026-09-01T00:00:00Z')

const workspace = (id: string): SpaceWorkspaceInfo => ({ id, title: id, owner: ADA, created: DAY })

// A space the user is a member of unless `asMember` says otherwise, listing these workspaces.
const space = (id: string, workspaces: SpaceWorkspaceInfo[], asMember = true) =>
  fakeSpace(teamSpace(id, id), asMember ? [member(ME, 'use')] : [], workspaces)

describe('useSpaceListings', () => {
  let current: ReturnType<typeof useSpaceListings>

  const Probe = ({ ids }: { ids: string[] }) => {
    current = useSpaceListings(ids)
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
    const openSpace = vi.fn<(id: string) => unknown>(id => opened[id])
    await mount(<Probe ids={['design', 'platform']} />, fakeApi({ openSpace }))
    await settle()

    expect(current.listings).toEqual({
      design: { status: 'ready', workspaces: [], role: 'use' },
      platform: { status: 'ready', workspaces: [workspace('w-plan')], role: 'use' },
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
      <Probe ids={['broken', 'left', 'platform']} />,
      fakeApi({ openSpace: (id: string) => spaces[id] }),
    )
    await settle()

    expect(current.listings).toEqual({
      broken: { status: 'failed' },
      left: { status: 'refused' },
      platform: { status: 'ready', workspaces: [workspace('w-plan')], role: 'use' },
    })
    expect(broken[Symbol.dispose]).toHaveBeenCalledOnce()
  })

  it('reads one space again on reload, and leaves the others unread', async () => {
    let listed = [workspace('w-plan')]
    const openSpace = vi.fn<(id: string) => unknown>(id =>
      space(id, id === 'platform' ? listed : []))
    await mount(<Probe ids={['design', 'platform']} />, fakeApi({ openSpace }))
    await settle()

    listed = [workspace('w-next'), workspace('w-plan')]
    await act(() => current.reload('platform'))

    expect(current.listings.platform).toEqual({ status: 'ready', workspaces: listed, role: 'use' })
    expect(openSpace.mock.calls).toEqual([['design'], ['platform'], ['platform']])
  })

  it('keeps the newer of two reads of one space when the older one settles last', async () => {
    const older = deferred<SpaceWorkspaceInfo[]>()
    const first = space('platform', [])
    first.listWorkspaces.mockImplementation(() => older.promise)
    const openSpace = vi.fn<(id: string) => unknown>(() => space('platform', [workspace('w-new')]))
      .mockImplementationOnce(() => first)
    await mount(<Probe ids={['platform']} />, fakeApi({ openSpace }))
    await settle()
    expect(current.listings).toEqual({})

    await act(() => current.reload('platform'))
    await act(async () => older.resolve([workspace('w-old')]))
    await settle()

    expect(current.listings.platform).toEqual({ status: 'ready', workspaces: [workspace('w-new')], role: 'use' })
    expect(first[Symbol.dispose]).toHaveBeenCalledOnce()
  })

  it('keeps the read under way of a space that stays in the set when another joins it', async () => {
    const before = deferred<SpaceWorkspaceInfo[]>()
    const first = space('platform', [])
    first.listWorkspaces.mockImplementation(() => before.promise)
    const openSpace = vi.fn<(id: string) => unknown>(id =>
      space(id, id === 'platform' ? [workspace('w-new')] : []))
      .mockImplementationOnce(() => first)
    const api = fakeApi({ openSpace })
    const { rerender } = await mount(<Probe ids={['platform']} />, api)
    await settle()

    await rerender(<Probe ids={['platform', 'design']} />, api)
    await settle()
    expect(current.listings).toEqual({ design: { status: 'ready', workspaces: [], role: 'use' } })
    await act(async () => before.resolve([workspace('w-old')]))
    await settle()

    expect(openSpace.mock.calls).toEqual([['platform'], ['design']])
    expect(current.listings).toEqual({
      platform: { status: 'ready', workspaces: [workspace('w-old')], role: 'use' },
      design: { status: 'ready', workspaces: [], role: 'use' },
    })
    expect(first[Symbol.dispose]).toHaveBeenCalledOnce()
  })

  it('drops the read under way of a space that has left the set', async () => {
    const before = deferred<SpaceWorkspaceInfo[]>()
    const first = space('platform', [])
    first.listWorkspaces.mockImplementation(() => before.promise)
    const openSpace = vi.fn<(id: string) => unknown>(id => (id === 'platform' ? first : space(id, [])))
    const api = fakeApi({ openSpace })
    const { rerender } = await mount(<Probe ids={['platform']} />, api)
    await settle()

    await rerender(<Probe ids={['design']} />, api)
    await settle()
    await act(async () => before.resolve([workspace('w-old')]))
    await settle()

    expect(current.listings).toEqual({ design: { status: 'ready', workspaces: [], role: 'use' } })
    expect(first[Symbol.dispose]).toHaveBeenCalledOnce()
  })

  it('reports the role the space says the user holds, not the one they were given there', async () => {
    const inherited = fakeSpace(teamSpace('platform', 'platform'), [member(ME, 'use')], [], { inherited: 'admin' })
    await mount(<Probe ids={['platform']} />, fakeApi({ openSpace: () => inherited }))
    await settle()

    expect(current.listings.platform).toEqual({ status: 'ready', workspaces: [], role: 'admin' })
  })

  it('reads the role on the open that reads the listing', async () => {
    const platform = space('platform', [])
    const openSpace = vi.fn<(id: string) => unknown>(() => platform)
    await mount(<Probe ids={['platform']} />, fakeApi({ openSpace }))
    await settle()

    expect(openSpace).toHaveBeenCalledExactlyOnceWith('platform')
    expect(platform.listWorkspaces).toHaveBeenCalledOnce()
    expect(platform.getInfo).toHaveBeenCalledOnce()
    expect(platform[Symbol.dispose]).toHaveBeenCalledOnce()
  })

  it.each([
    ['listWorkspaces', 'getInfo'],
    ['getInfo', 'listWorkspaces'],
  ] as const)('asks for the listing and the role together: %s unanswered, %s is asked all the same', async (unanswered, other) => {
    const platform = space('platform', [])
    platform[unanswered].mockImplementation(() => new Promise<never>(() => {}))
    await mount(<Probe ids={['platform']} />, fakeApi({ openSpace: () => platform }))
    await settle()

    expect(platform[unanswered]).toHaveBeenCalledOnce()
    expect(platform[other]).toHaveBeenCalledOnce()
    // The space is held for as long as one of its answers is awaited.
    expect(platform[Symbol.dispose]).not.toHaveBeenCalled()
    expect(current.listings).toEqual({})
  })

  it.each([
    ['failed', () => new Error('boom')],
    ['refused', notAMember],
  ] as const)('reports a listing as %s when the space’s info cannot be read for that reason', async (status, failure) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const platform = space('platform', [workspace('w-plan')])
    platform.getInfo.mockRejectedValue(failure())
    await mount(<Probe ids={['platform']} />, fakeApi({ openSpace: () => platform }))
    await settle()

    expect(current.listings.platform).toEqual({ status })
    expect(platform[Symbol.dispose]).toHaveBeenCalledOnce()
  })

  it('reads the spaces that join the set and one that could not be read, and not again one that stays in it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const openSpace = vi.fn<(id: string) => unknown>((id) => {
      const opened = space(id, [])
      if (id === 'broken') opened.listWorkspaces.mockRejectedValue(new Error('boom'))
      return opened
    })
    const api = fakeApi({ openSpace })
    const { rerender } = await mount(<Probe ids={['atlas', 'broken', 'design']} />, api)
    await settle()
    openSpace.mockClear()

    await rerender(<Probe ids={['broken', 'design', 'platform']} />, api)
    await settle()

    expect(openSpace.mock.calls).toEqual([['broken'], ['platform']])
    expect(current.listings.design).toEqual({ status: 'ready', workspaces: [], role: 'use' })
    expect(current.listings.platform).toEqual({ status: 'ready', workspaces: [], role: 'use' })
  })

  it('reads again a space that left the set and is back in it', async () => {
    const openSpace = vi.fn<(id: string) => unknown>(id => space(id, []))
    const api = fakeApi({ openSpace })
    const { rerender } = await mount(<Probe ids={['design']} />, api)
    await settle()
    await rerender(<Probe ids={[]} />, api)
    await settle()

    await rerender(<Probe ids={['design']} />, api)
    await settle()

    expect(openSpace.mock.calls).toEqual([['design'], ['design']])
  })

  it('does not read again when the same set arrives as another array', async () => {
    const openSpace = vi.fn<(id: string) => unknown>(id => space(id, []))
    const api = fakeApi({ openSpace })
    const { rerender } = await mount(<Probe ids={['design', 'platform']} />, api)
    await settle()

    await rerender(<Probe ids={['design', 'platform']} />, api)
    await settle()

    expect(openSpace).toHaveBeenCalledTimes(2)
  })

  it('asks a session for nothing before its own flags say the flag is on', async () => {
    const flags = deferred<{ spaces: boolean }>()
    const openSpace = vi.fn<(id: string) => unknown>(id => space(id, []))
    await mount(<Probe ids={['platform']} />, fakeApi({ getUiFeatureFlags: () => flags.promise, openSpace }))
    await settle()
    expect(openSpace).not.toHaveBeenCalled()

    await act(async () => flags.resolve({ spaces: true }))
    await settle()
    expect(openSpace.mock.calls).toEqual([['platform']])
    expect(current.listings.platform).toEqual({ status: 'ready', workspaces: [], role: 'use' })
  })

  it('asks about a space under the string it was given, whatever that holds', async () => {
    const refused = space('x', [])
    refused.listWorkspaces.mockRejectedValue(invalidSpaceId())
    const openSpace = vi.fn<(id: string) => unknown>(() => refused)
    await mount(<Probe ids={['not an id']} />, fakeApi({ openSpace }))
    await settle()

    expect(openSpace.mock.calls).toEqual([['not an id']])
    expect(current.listings).toEqual({ 'not an id': { status: 'refused' } })
  })

  it('reads nothing while the flag is off', async () => {
    const openSpace = vi.fn<(id: string) => unknown>(id => space(id, []))
    await mount(<Probe ids={['platform']} />, fakeApi({ openSpace }, { spacesFlag: false }))
    await settle()

    expect(openSpace).not.toHaveBeenCalled()
    expect(current.listings).toEqual({})
  })

  it('shows nothing read under a session that has been replaced', async () => {
    const late = deferred<SpaceWorkspaceInfo[]>()
    const { rerender } = await mount(
      <Probe ids={['platform']} />,
      fakeApi({ openSpace: () => space('platform', [workspace('w-old')]) }),
    )
    await settle()
    expect(current.listings.platform).toEqual({ status: 'ready', workspaces: [workspace('w-old')], role: 'use' })

    const next = space('platform', [])
    next.listWorkspaces.mockImplementation(() => late.promise)
    await rerender(<Probe ids={['platform']} />, fakeApi({ openSpace: () => next }))
    await settle()
    expect(current.listings).toEqual({})

    await act(async () => late.resolve([workspace('w-new')]))
    await settle()
    expect(current.listings.platform).toEqual({ status: 'ready', workspaces: [workspace('w-new')], role: 'use' })
  })

  it('reads again under a session that replaces one whose read was under way, and drops that read', async () => {
    const before = deferred<SpaceWorkspaceInfo[]>()
    const first = space('platform', [])
    first.listWorkspaces.mockImplementation(() => before.promise)
    const { rerender } = await mount(<Probe ids={['platform']} />, fakeApi({ openSpace: () => first }))
    await settle()

    const openSpace = vi.fn<(id: string) => unknown>(() => space('platform', [workspace('w-new')]))
    await rerender(<Probe ids={['platform']} />, fakeApi({ openSpace }))
    await settle()
    expect(openSpace.mock.calls).toEqual([['platform']])
    expect(current.listings.platform).toEqual({ status: 'ready', workspaces: [workspace('w-new')], role: 'use' })

    await act(async () => before.resolve([workspace('w-old')]))
    await settle()
    expect(current.listings.platform).toEqual({ status: 'ready', workspaces: [workspace('w-new')], role: 'use' })
  })
})
