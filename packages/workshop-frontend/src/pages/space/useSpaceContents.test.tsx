// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SpaceInfo, SpaceWorkspaceInfo } from '@gadgets/workshop-shared/api'
import {
  ME,
  fakeApi,
  fakeSpace,
  member,
  mount,
  notAMember,
  person,
  personalSpace,
  settle,
  subspace,
  teamSpace,
  unmountAll,
} from '../../features/spaces/spacesTestUtils'
import { useSpaceContents } from './useSpaceContents'

const ADA = person('ada@example.com', 'Ada')
const INFRA = subspace('infra', 'Infra')
const PLAN: SpaceWorkspaceInfo = { id: 'w-plan', title: 'Plan', owner: ADA, created: new Date('2026-09-01T00:00:00Z') }
const PLATFORM = teamSpace('platform', 'Platform')
const PERSONAL = personalSpace(ME)

const platform = () => fakeSpace(PLATFORM, [member(ME, 'build')], [PLAN], { subspaces: [INFRA] })

describe('useSpaceContents', () => {
  let current: ReturnType<typeof useSpaceContents>

  const Probe = ({ space }: { space: Pick<SpaceInfo, 'id' | 'kind'> | undefined }) => {
    current = useSpaceContents(space)
    return null
  }

  afterEach(() => {
    unmountAll()
    vi.restoreAllMocks()
  })

  it('reads a team space’s sub-spaces and what it lists on one open, which it releases', async () => {
    const space = platform()
    const openSpace = vi.fn<(id: string) => unknown>(() => space)
    await mount(<Probe space={PLATFORM} />, fakeApi({ openSpace }))
    await settle()

    expect(current.contents).toEqual({ status: 'ready', subspaces: [INFRA], workspaces: [PLAN] })
    expect(openSpace).toHaveBeenCalledExactlyOnceWith('platform')
    expect(space.listSubspaces).toHaveBeenCalledOnce()
    expect(space.listWorkspaces).toHaveBeenCalledOnce()
    expect(space.getInfo).not.toHaveBeenCalled()
    expect(space.listMembers).not.toHaveBeenCalled()
    expect(space[Symbol.dispose]).toHaveBeenCalledOnce()
  })

  it.each([
    ['listSubspaces', 'listWorkspaces'],
    ['listWorkspaces', 'listSubspaces'],
  ] as const)('asks a team space for both together: %s unanswered, %s is asked all the same', async (unanswered, other) => {
    const space = platform()
    space[unanswered].mockImplementation(() => new Promise<never>(() => {}))
    await mount(<Probe space={PLATFORM} />, fakeApi({ openSpace: () => space }))
    await settle()

    expect(space[unanswered]).toHaveBeenCalledOnce()
    expect(space[other]).toHaveBeenCalledOnce()
    // The space is held for as long as one of its answers is awaited.
    expect(space[Symbol.dispose]).not.toHaveBeenCalled()
    expect(current.contents).toEqual({ status: 'loading' })
  })

  it('reads a personal space’s sub-spaces and not what it lists', async () => {
    const space = fakeSpace(PERSONAL, [member(ME, 'admin')], [PLAN], { subspaces: [INFRA] })
    const openSpace = vi.fn<(id: string) => unknown>(() => space)
    await mount(<Probe space={PERSONAL} />, fakeApi({ openSpace }))
    await settle()

    expect(current.contents).toEqual({ status: 'ready', subspaces: [INFRA], workspaces: [] })
    expect(openSpace).toHaveBeenCalledExactlyOnceWith(PERSONAL.id)
    expect(space.listSubspaces).toHaveBeenCalledOnce()
    expect(space.listWorkspaces).not.toHaveBeenCalled()
    expect(space[Symbol.dispose]).toHaveBeenCalledOnce()
  })

  it('reads nothing while the space is not known', async () => {
    const openSpace = vi.fn<(id: string) => unknown>(() => platform())
    await mount(<Probe space={undefined} />, fakeApi({ openSpace }))
    await settle()

    expect(openSpace).not.toHaveBeenCalled()
    expect(current.contents).toEqual({ status: 'loading' })
    await act(() => current.reload())
    expect(openSpace).not.toHaveBeenCalled()
  })

  it.each([
    ['listSubspaces', 'failed', () => new Error('boom')],
    ['listWorkspaces', 'failed', () => new Error('boom')],
    ['listSubspaces', 'refused', notAMember],
    ['listWorkspaces', 'refused', notAMember],
  ] as const)('tells a space that refuses the user from one that could not be read: %s %s', async (call, status, failure) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const space = platform()
    space[call].mockRejectedValue(failure())
    await mount(<Probe space={PLATFORM} />, fakeApi({ openSpace: () => space }))
    await settle()

    expect(current.contents).toEqual({ status })
    expect(space[Symbol.dispose]).toHaveBeenCalledOnce()
  })

  it('reads the space again on reload', async () => {
    const space = platform()
    const openSpace = vi.fn<(id: string) => unknown>(() => space)
    await mount(<Probe space={PLATFORM} />, fakeApi({ openSpace }))
    await settle()

    await space.createSubspace('Ops')
    await act(() => current.reload())

    expect(current.contents).toEqual({ status: 'ready', subspaces: space.subspaces(), workspaces: [PLAN] })
    expect(space.subspaces().map(each => each.name)).toEqual(['Infra', 'Ops'])
    expect(openSpace.mock.calls).toEqual([['platform'], ['platform']])
    expect(space[Symbol.dispose]).toHaveBeenCalledTimes(2)
  })

  it('asks nothing while the flag is off', async () => {
    const openSpace = vi.fn<(id: string) => unknown>(() => platform())
    await mount(<Probe space={PLATFORM} />, fakeApi({ openSpace }, { spacesFlag: false }))
    await settle()

    expect(openSpace).not.toHaveBeenCalled()
    expect(current.contents).toEqual({ status: 'loading' })
  })
})
