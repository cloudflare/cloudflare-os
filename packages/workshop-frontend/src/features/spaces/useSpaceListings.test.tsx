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
      design: { status: 'ready', workspaces: [] },
      platform: { status: 'ready', workspaces: [workspace('w-plan')] },
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
      platform: { status: 'ready', workspaces: [workspace('w-plan')] },
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

    expect(current.listings.platform).toEqual({ status: 'ready', workspaces: listed })
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

    expect(current.listings.platform).toEqual({ status: 'ready', workspaces: [workspace('w-new')] })
    expect(first[Symbol.dispose]).toHaveBeenCalledOnce()
  })

  it('reads a space again when the set changes before it has been read, and drops the read begun for the set before', async () => {
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
    await act(async () => before.resolve([workspace('w-old')]))
    await settle()

    expect(current.listings).toEqual({
      platform: { status: 'ready', workspaces: [workspace('w-new')] },
      design: { status: 'ready', workspaces: [] },
    })
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
    expect(current.listings.design).toEqual({ status: 'ready', workspaces: [] })
    expect(current.listings.platform).toEqual({ status: 'ready', workspaces: [] })
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
    expect(current.listings.platform).toEqual({ status: 'ready', workspaces: [] })
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
    expect(current.listings.platform).toEqual({ status: 'ready', workspaces: [workspace('w-old')] })

    const next = space('platform', [])
    next.listWorkspaces.mockImplementation(() => late.promise)
    await rerender(<Probe ids={['platform']} />, fakeApi({ openSpace: () => next }))
    await settle()
    expect(current.listings).toEqual({})

    await act(async () => late.resolve([workspace('w-new')]))
    await settle()
    expect(current.listings.platform).toEqual({ status: 'ready', workspaces: [workspace('w-new')] })
  })
})
