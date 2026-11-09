// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SubspaceInfo } from '@gadgets/workshop-shared/api'
import {
  ME,
  deferred,
  fakeApi,
  fakeSpace,
  member,
  mount,
  settle,
  subspace,
  teamSpace,
  unmountAll,
} from './spacesTestUtils'
import { useSubspaces } from './useSubspaces'

const INFRA = subspace('infra', 'Infra')
const OPS = subspace('ops', 'Ops')

// A space the user is a member of unless `asMember` says otherwise, with these sub-spaces in it.
const space = (id: string, subspaces: SubspaceInfo[], asMember = true) =>
  fakeSpace(teamSpace(id, id), asMember ? [member(ME, 'build')] : [], [], { subspaces })

describe('useSubspaces', () => {
  let current: ReturnType<typeof useSubspaces>

  const Probe = ({ ids }: { ids: string[] }) => {
    current = useSubspaces(ids)
    return null
  }

  afterEach(() => {
    unmountAll()
    vi.restoreAllMocks()
  })

  it('reads the sub-spaces directly inside each space, and disposes every space it opened', async () => {
    const opened: Record<string, ReturnType<typeof space>> = {
      design: space('design', []),
      // Created in this order: the space lists them by name.
      platform: space('platform', [OPS, INFRA]),
    }
    const openSpace = vi.fn<(id: string) => unknown>(id => opened[id])
    await mount(<Probe ids={['design', 'platform']} />, fakeApi({ openSpace }))
    await settle()

    expect(current.subspaces).toEqual({
      design: { status: 'ready', subspaces: [] },
      platform: { status: 'ready', subspaces: [INFRA, OPS] },
    })
    expect(openSpace.mock.calls).toEqual([['design'], ['platform']])
    for (const each of Object.values(opened)) {
      expect(each.listSubspaces).toHaveBeenCalledOnce()
      expect(each.listWorkspaces).not.toHaveBeenCalled()
      expect(each.getInfo).not.toHaveBeenCalled()
      expect(each[Symbol.dispose]).toHaveBeenCalledOnce()
    }
  })

  it('tells a space that refuses the user from one that could not be read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const broken = space('broken', [INFRA])
    broken.listSubspaces.mockRejectedValue(new Error('boom'))
    const spaces: Record<string, unknown> = { broken, left: space('left', [INFRA], false) }
    await mount(<Probe ids={['broken', 'left']} />, fakeApi({ openSpace: (id: string) => spaces[id] }))
    await settle()

    expect(current.subspaces).toEqual({ broken: { status: 'failed' }, left: { status: 'refused' } })
    expect(broken[Symbol.dispose]).toHaveBeenCalledOnce()
  })

  it('reads one space again on reload', async () => {
    const platform = space('platform', [INFRA])
    const openSpace = vi.fn<(id: string) => unknown>(id => (id === 'platform' ? platform : space(id, [])))
    await mount(<Probe ids={['design', 'platform']} />, fakeApi({ openSpace }))
    await settle()

    await platform.createSubspace('Ops')
    await act(() => current.reload('platform'))

    expect(current.subspaces.platform).toEqual({ status: 'ready', subspaces: platform.subspaces() })
    expect(platform.subspaces().map(each => each.name)).toEqual(['Infra', 'Ops'])
    expect(openSpace.mock.calls).toEqual([['design'], ['platform'], ['platform']])
  })

  it('reads a space that joins the set, and not again one that stays in it', async () => {
    const openSpace = vi.fn<(id: string) => unknown>(id => space(id, id === 'platform' ? [INFRA] : []))
    const api = fakeApi({ openSpace })
    const { rerender } = await mount(<Probe ids={['design']} />, api)
    await settle()
    openSpace.mockClear()

    await rerender(<Probe ids={['design', 'platform']} />, api)
    await settle()

    expect(openSpace.mock.calls).toEqual([['platform']])
    expect(current.subspaces).toEqual({
      design: { status: 'ready', subspaces: [] },
      platform: { status: 'ready', subspaces: [INFRA] },
    })
  })

  it('opens once a space that is still being read when another joins the set', async () => {
    const slow = deferred<SubspaceInfo[]>()
    const platform = space('platform', [])
    platform.listSubspaces.mockImplementation(() => slow.promise)
    const openSpace = vi.fn<(id: string) => unknown>(id => (id === 'platform' ? platform : space(id, [OPS])))
    const api = fakeApi({ openSpace })
    const { rerender } = await mount(<Probe ids={['platform']} />, api)
    await settle()

    await rerender(<Probe ids={['platform', 'design']} />, api)
    await settle()
    await act(async () => slow.resolve([INFRA]))
    await settle()

    expect(openSpace.mock.calls).toEqual([['platform'], ['design']])
    expect(current.subspaces).toEqual({
      platform: { status: 'ready', subspaces: [INFRA] },
      design: { status: 'ready', subspaces: [OPS] },
    })
    expect(platform[Symbol.dispose]).toHaveBeenCalledOnce()
  })

  it('asks nothing while the flag is off', async () => {
    const openSpace = vi.fn<(id: string) => unknown>(id => space(id, [INFRA]))
    await mount(<Probe ids={['platform']} />, fakeApi({ openSpace }, { spacesFlag: false }))
    await settle()

    expect(openSpace).not.toHaveBeenCalled()
    expect(current.subspaces).toEqual({})
  })
})
