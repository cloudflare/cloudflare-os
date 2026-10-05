// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SpaceMemberInfo } from '@gadgets/workshop-shared/api'
import {
  ME,
  deferred,
  fakeApi,
  fakeSpace,
  member,
  mount,
  notAMember,
  person,
  settle,
  teamSpace,
  unmountAll,
} from './spacesTestUtils'
import { useSpace, type OpenSpace } from './useSpace'

const ADA = person('ada@example.com', 'Ada')

const platform = () =>
  fakeSpace(teamSpace('platform', 'Platform'), [member(ME, 'admin'), member(ADA, 'use')])
const design = () => fakeSpace(teamSpace('design', 'Design'), [member(ME, 'use')])

// A stub no read on which can succeed again: every call rejects the same way.
const unreadable = (failure: () => Error) => {
  const fail = async () => { throw failure() }
  return {
    getInfo: fail,
    listMembers: fail,
    [Symbol.dispose]: vi.fn<() => void>(),
  }
}

// What a refused open leaves behind: a space every pipelined call on which is refused.
const unopened = () => unreadable(notAMember)

// What an open that failed leaves behind, and a space whose Durable Object has reset since.
const lost = () => unreadable(() => new Error('Network connection lost.'))

describe('useSpace', () => {
  let current: OpenSpace
  // What every render saw: the key it asked for, and the space it was shown.
  let renders: { asked: string; shown: string }[] = []

  const Probe = ({ spaceKey }: { spaceKey: string }) => {
    current = useSpace(spaceKey)
    const { state } = current
    renders.push({ asked: spaceKey, shown: state.status === 'ready' ? state.info.key : state.status })
    return null
  }

  afterEach(() => {
    unmountAll()
    renders = []
    vi.restoreAllMocks()
  })

  it('reads the open space and disposes it on unmount', async () => {
    const space = platform()
    const openSpace = vi.fn<(key: string) => unknown>(() => space.stub)
    const { unmount } = await mount(<Probe spaceKey="platform" />, fakeApi({ openSpace }))
    await settle()

    expect(renders[0]).toEqual({ asked: 'platform', shown: 'loading' })
    expect(openSpace).toHaveBeenCalledExactlyOnceWith('platform')
    expect(current.state).toEqual({
      status: 'ready',
      info: teamSpace('platform', 'Platform'),
      members: space.members(),
    })
    // What the space lists is `useSpaceListings`' to read, for the page that shows it.
    expect(space.listWorkspaces).not.toHaveBeenCalled()
    expect(space[Symbol.dispose]).not.toHaveBeenCalled()

    await unmount()
    expect(space[Symbol.dispose]).toHaveBeenCalledOnce()
  })

  it('opens the space only once the session’s own flags say the flag is on', async () => {
    const flags = deferred<{ spaces: boolean }>()
    const space = platform()
    const openSpace = vi.fn<(key: string) => unknown>(() => space.stub)
    await mount(
      <Probe spaceKey="platform" />,
      fakeApi({ getUiFeatureFlags: () => flags.promise, openSpace }),
    )
    await settle()
    expect(openSpace).not.toHaveBeenCalled()
    expect(current.state).toEqual({ status: 'loading' })

    await act(async () => flags.resolve({ spaces: true }))
    await settle()
    expect(openSpace).toHaveBeenCalledExactlyOnceWith('platform')
    expect(current.state.status).toBe('ready')
  })

  it('opens nothing while the flag is off', async () => {
    const openSpace = vi.fn<(key: string) => unknown>(() => platform().stub)
    await mount(<Probe spaceKey="platform" />, fakeApi({ openSpace }, { spacesFlag: false }))
    await settle()

    expect(openSpace).not.toHaveBeenCalled()
    expect(current.state).toEqual({ status: 'loading' })
  })

  it('disposes the previous space when the key changes, and never shows it under the new key', async () => {
    const spaces = { platform: platform(), design: design() }
    const api = fakeApi({ openSpace: (key: keyof typeof spaces) => spaces[key].stub })
    const { rerender } = await mount(<Probe spaceKey="platform" />, api)
    await settle()

    await rerender(<Probe spaceKey="design" />)
    await settle()

    expect(spaces.platform[Symbol.dispose]).toHaveBeenCalledOnce()
    expect(spaces.design[Symbol.dispose]).not.toHaveBeenCalled()
    expect(current.state).toMatchObject({ status: 'ready', info: { key: 'design', role: 'use' } })
    expect(renders.filter(render => render.asked === 'design').map(render => render.shown))
      .toEqual(expect.arrayContaining(['loading', 'design']))
    expect(renders).not.toContainEqual({ asked: 'design', shown: 'platform' })
  })

  it('reads the space again after a change, whether it worked or was refused', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const space = platform()
    await mount(<Probe spaceKey="platform" />, fakeApi({ openSpace: () => space.stub }))
    await settle()

    await act(() => current.change(stub => stub.setMemberRole(ADA.id, 'build')))
    expect(current.state).toMatchObject({ members: [member(ME, 'admin'), member(ADA, 'build')] })

    // Someone else removed Ada meanwhile; the refused change still brings the list up to date.
    await space.removeMember(ADA.id)
    space.setMemberRole.mockRejectedValueOnce(new Error('A space must keep at least one admin.'))
    let refusal: unknown
    await act(() => current.change(stub => stub.setMemberRole(ME.id, 'use')).catch((err: unknown) => {
      refusal = err
    }))
    expect(refusal).toEqual(new Error('A space must keep at least one admin.'))
    expect(current.state).toMatchObject({ status: 'ready', members: [member(ME, 'admin')] })
  })

  it('reports a space that refuses, at open or later, as refused', async () => {
    const space = platform()
    const api = fakeApi({
      openSpace: (key: string) => (key === 'platform' ? space.stub : unopened()),
    })
    const { rerender } = await mount(<Probe spaceKey="nowhere" />, api)
    await settle()
    expect(current.state).toEqual({ status: 'refused' })

    await rerender(<Probe spaceKey="platform" />)
    await settle()
    expect(current.state.status).toBe('ready')

    // The user is removed while the space is open: the next read is refused.
    await space.removeMember(ME.id)
    await act(() => current.refresh())
    expect(current.state).toEqual({ status: 'refused' })
  })

  it.each([
    { cause: 'failed', broken: lost, status: 'failed' },
    { cause: 'was refused', broken: unopened, status: 'refused' },
  ])('opens the space again on the refresh after a read that $cause', async ({ broken, status }) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const first = broken()
    const space = platform()
    const openSpace = vi.fn<(key: string) => unknown>()
      .mockReturnValueOnce(first)
      .mockReturnValue(space.stub)
    await mount(<Probe spaceKey="platform" />, fakeApi({ openSpace }))
    await settle()
    expect(current.state).toEqual({ status })

    await act(() => current.refresh())
    expect(current.state.status).toBe('ready')
    expect(openSpace).toHaveBeenCalledTimes(2)
    expect(first[Symbol.dispose]).toHaveBeenCalledOnce()
    expect(space[Symbol.dispose]).not.toHaveBeenCalled()

    // A space that reads is kept.
    await act(() => current.refresh())
    expect(openSpace).toHaveBeenCalledTimes(2)
  })

  it('keeps the newer of two reads when the older one settles last', async () => {
    const space = platform()
    const older = deferred<SpaceMemberInfo[]>()
    space.listMembers.mockImplementationOnce(() => older.promise)
    await mount(<Probe spaceKey="platform" />, fakeApi({ openSpace: () => space.stub }))
    await settle()
    expect(current.state.status).toBe('loading')

    await space.setMemberRole(ADA.id, 'build')
    await act(() => current.refresh())
    await act(async () => older.resolve([member(ME, 'admin'), member(ADA, 'use')]))
    await settle()

    expect(current.state).toMatchObject({ members: [member(ME, 'admin'), member(ADA, 'build')] })
  })

  it('drops a read that settles after the key has changed', async () => {
    const spaces = { platform: platform(), design: design() }
    const late = deferred<SpaceMemberInfo[]>()
    spaces.platform.listMembers.mockImplementationOnce(() => late.promise)
    const api = fakeApi({ openSpace: (key: keyof typeof spaces) => spaces[key].stub })
    const { rerender } = await mount(<Probe spaceKey="platform" />, api)
    await settle()

    await rerender(<Probe spaceKey="design" />)
    await settle()
    await act(async () => late.resolve(spaces.platform.members()))
    await settle()

    expect(current.state).toMatchObject({ status: 'ready', info: { key: 'design' } })
  })

  it('reads nothing once unmounted, after a change that was still in flight', async () => {
    const space = platform()
    const { unmount } = await mount(<Probe spaceKey="platform" />, fakeApi({ openSpace: () => space.stub }))
    await settle()
    const action = deferred<void>()
    const changed = current.change(() => action.promise)

    await unmount()
    const reads = space.getInfo.mock.calls.length
    action.resolve()
    await changed

    expect(space.getInfo).toHaveBeenCalledTimes(reads)
  })
})
