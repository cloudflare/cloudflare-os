// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ME,
  fakeApi,
  fakeSpace,
  member,
  mount,
  openSpaceAmong,
  settle,
  teamSpace,
  unmountAll,
} from './spacesTestUtils'
import { useSpaceInfos } from './useSpaceInfos'

describe('useSpaceInfos', () => {
  let current: ReturnType<typeof useSpaceInfos>

  const Probe = ({ ids }: { ids: string[] }) => {
    current = useSpaceInfos(ids)
    return null
  }

  afterEach(() => {
    unmountAll()
    vi.restoreAllMocks()
  })

  it('reads the info of each space and disposes every space it opened', async () => {
    // A member of Design itself, and of Infra only through the space it is inside.
    const design = fakeSpace(teamSpace('design', 'Design'), [member(ME, 'use')])
    const infra = fakeSpace(teamSpace('infra', 'Infra', 'use', 'platform'), [], [], { inherited: 'build' })
    const openSpace = openSpaceAmong([design, infra])
    await mount(<Probe ids={['design', 'infra']} />, fakeApi({ openSpace }))
    await settle()

    expect(current.infos).toEqual({
      design: { status: 'ready', info: teamSpace('design', 'Design', 'use') },
      infra: { status: 'ready', info: teamSpace('infra', 'Infra', 'build', 'platform') },
    })
    expect(openSpace.mock.calls).toEqual([['design'], ['infra']])
    for (const space of [design, infra]) {
      expect(space.getInfo).toHaveBeenCalledOnce()
      expect(space.listMembers).not.toHaveBeenCalled()
      expect(space.listWorkspaces).not.toHaveBeenCalled()
      expect(space.listSubspaces).not.toHaveBeenCalled()
      expect(space[Symbol.dispose]).toHaveBeenCalledOnce()
    }
  })

  it('tells a space the user cannot open from one that could not be read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const broken = fakeSpace(teamSpace('broken', 'Broken'), [member(ME, 'use')])
    broken.getInfo.mockRejectedValue(new Error('boom'))
    const left = fakeSpace(teamSpace('left', 'Left'), [])
    await mount(<Probe ids={['broken', 'left']} />, fakeApi({ openSpace: openSpaceAmong([broken, left]) }))
    await settle()

    expect(current.infos).toEqual({ broken: { status: 'failed' }, left: { status: 'refused' } })
    expect(broken[Symbol.dispose]).toHaveBeenCalledOnce()
    expect(left[Symbol.dispose]).toHaveBeenCalledOnce()
  })

  it('asks nothing while the flag is off', async () => {
    const openSpace = openSpaceAmong([fakeSpace(teamSpace('design', 'Design'), [member(ME, 'use')])])
    await mount(<Probe ids={['design']} />, fakeApi({ openSpace }, { spacesFlag: false }))
    await settle()

    expect(openSpace).not.toHaveBeenCalled()
    expect(current.infos).toEqual({})
  })
})
