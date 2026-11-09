// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SpaceInfo } from '@gadgets/workshop-shared/api'
import {
  ME,
  deferred,
  fakeApi,
  fakeSpace,
  member,
  mount,
  notAMember,
  openSpaceAmong,
  settle,
  teamSpace,
  unmountAll,
} from './spacesTestUtils'
import { useSpaceAncestors } from './useSpaceAncestors'

// Org holds Platform, which holds Infra; Ops is inside Org too. The user was added to Org, and
// holds that role in everything below it.
const chain = () => ({
  org: fakeSpace(teamSpace('org', 'Org', 'use'), [member(ME, 'use')]),
  platform: fakeSpace(teamSpace('platform', 'Platform', 'use', 'org'), [], [], { inherited: 'use' }),
  infra: fakeSpace(teamSpace('infra', 'Infra', 'use', 'platform'), [], [], { inherited: 'use' }),
  ops: fakeSpace(teamSpace('ops', 'Ops', 'use', 'org'), [], [], { inherited: 'use' }),
})

describe('useSpaceAncestors', () => {
  let current: SpaceInfo[]

  const Probe = ({ parent }: { parent: string | undefined }) => {
    current = useSpaceAncestors(parent)
    return null
  }

  const names = () => current.map(ancestor => ancestor.name)

  afterEach(() => {
    unmountAll()
    vi.restoreAllMocks()
  })

  it('asks nothing for a space with no parent', async () => {
    const openSpace = openSpaceAmong(Object.values(chain()))
    const { rerender } = await mount(<Probe parent={undefined} />, fakeApi({ openSpace }))
    await settle()
    const none = current

    expect(none).toEqual([])
    expect(openSpace).not.toHaveBeenCalled()
    // One array for 'none', so a caller's render is not handed another each time.
    await rerender(<Probe parent={undefined} />)
    expect(current).toBe(none)
  })

  it('walks up from the parent, opening each ancestor once and releasing it once it has answered', async () => {
    const spaces = chain()
    const events: string[] = []
    const openSpace = vi.fn<(id: string) => unknown>((id) => {
      events.push(`open ${id}`)
      return spaces[id as keyof typeof spaces]
    })
    for (const space of Object.values(spaces)) {
      space[Symbol.dispose].mockImplementation(() => { events.push(`release ${space.id}`) })
    }
    await mount(<Probe parent="infra" />, fakeApi({ openSpace }))
    await settle()

    // The next ancestor is not opened before the one below it has been released.
    expect(events).toEqual([
      'open infra', 'release infra', 'open platform', 'release platform', 'open org', 'release org',
    ])
    for (const space of [spaces.infra, spaces.platform, spaces.org]) {
      expect(space.getInfo).toHaveBeenCalledOnce()
      expect(space.listMembers).not.toHaveBeenCalled()
      expect(space.listWorkspaces).not.toHaveBeenCalled()
      expect(space.listSubspaces).not.toHaveBeenCalled()
      expect(space[Symbol.dispose]).toHaveBeenCalledOnce()
    }
  })

  it('returns the ancestors outermost first once the walk has ended, and none before', async () => {
    const spaces = chain()
    const answer = deferred<SpaceInfo>()
    spaces.platform.getInfo.mockReturnValueOnce(answer.promise)
    await mount(<Probe parent="infra" />, fakeApi({ openSpace: openSpaceAmong(Object.values(spaces)) }))
    await settle()

    // Infra has answered, and nothing of the walk is shown while Platform has not.
    expect(spaces.infra.getInfo).toHaveBeenCalledOnce()
    expect(current).toEqual([])

    await act(async () => answer.resolve(teamSpace('platform', 'Platform', 'use', 'org')))
    await settle()

    expect(current).toEqual([
      teamSpace('org', 'Org', 'use'),
      teamSpace('platform', 'Platform', 'use', 'org'),
      teamSpace('infra', 'Infra', 'use', 'platform'),
    ])
  })

  it('stops at an ancestor the server refuses, and keeps the ones below it', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { platform, infra } = chain()
    // Org is none of the spaces the user can open: the server refuses it.
    const openSpace = openSpaceAmong([platform, infra])
    await mount(<Probe parent="infra" />, fakeApi({ openSpace }))
    await settle()

    expect(names()).toEqual(['Platform', 'Infra'])
    expect(openSpace.mock.calls).toEqual([['infra'], ['platform'], ['org']])
    expect(logged).not.toHaveBeenCalled()
  })

  it('stops at an ancestor that cannot be read, and says so in the log', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const spaces = chain()
    const failure = new Error('boom')
    spaces.platform.getInfo.mockRejectedValue(failure)
    const openSpace = openSpaceAmong(Object.values(spaces))
    await mount(<Probe parent="infra" />, fakeApi({ openSpace }))
    await settle()

    expect(names()).toEqual(['Infra'])
    expect(openSpace.mock.calls).toEqual([['infra'], ['platform']])
    expect(spaces.platform[Symbol.dispose]).toHaveBeenCalledOnce()
    expect(logged).toHaveBeenCalledExactlyOnceWith('Failed to load a space above this one:', failure)
  })

  it('stops at an id it has already met', async () => {
    const { infra } = chain()
    // A space that names the one below it as its parent: the walk would never end.
    const platform = fakeSpace(teamSpace('platform', 'Platform', 'use', 'infra'), [], [], { inherited: 'use' })
    const openSpace = openSpaceAmong([platform, infra])
    await mount(<Probe parent="infra" />, fakeApi({ openSpace }))
    await settle()

    expect(names()).toEqual(['Platform', 'Infra'])
    expect(openSpace.mock.calls).toEqual([['infra'], ['platform']])
  })

  it('walks again when the parent changes, and drops a walk still under way', async () => {
    const spaces = chain()
    const { rerender } = await mount(
      <Probe parent="infra" />,
      fakeApi({ openSpace: openSpaceAmong(Object.values(spaces)) }),
    )
    await settle()
    expect(names()).toEqual(['Org', 'Platform', 'Infra'])

    // The space is another, inside Ops, which is slow to answer: what was found above Infra is
    // not this space's.
    const answer = deferred<SpaceInfo>()
    spaces.ops.getInfo.mockReturnValueOnce(answer.promise)
    await rerender(<Probe parent="ops" />)
    await settle()
    expect(current).toEqual([])

    // Back under Infra before Ops has answered: the walk from Ops goes no further.
    await rerender(<Probe parent="infra" />)
    await settle()
    await act(async () => answer.resolve(teamSpace('ops', 'Ops', 'use', 'org')))
    await settle()

    expect(names()).toEqual(['Org', 'Platform', 'Infra'])
    expect(spaces.ops[Symbol.dispose]).toHaveBeenCalledOnce()
    // Org was read by the two walks from Infra, and not by the one from Ops.
    expect(spaces.org.getInfo).toHaveBeenCalledTimes(2)
  })

  it('shows nothing of a walk that ends in a refusal after another session has walked', async () => {
    const first = chain()
    let refuse!: (err: Error) => void
    first.infra.getInfo.mockReturnValueOnce(new Promise<SpaceInfo>((_resolve, reject) => { refuse = reject }))
    const { rerender } = await mount(
      <Probe parent="infra" />,
      fakeApi({ openSpace: openSpaceAmong(Object.values(first)) }),
    )
    await settle()

    await rerender(<Probe parent="infra" />, fakeApi({ openSpace: openSpaceAmong(Object.values(chain())) }))
    await settle()
    expect(names()).toEqual(['Org', 'Platform', 'Infra'])

    // The session before is answered at last, with a refusal: its walk found nothing.
    await act(async () => refuse(notAMember()))
    await settle()

    expect(names()).toEqual(['Org', 'Platform', 'Infra'])
    expect(first.infra[Symbol.dispose]).toHaveBeenCalledOnce()
  })

  it('asks nothing while the flag is off', async () => {
    const openSpace = openSpaceAmong(Object.values(chain()))
    await mount(<Probe parent="infra" />, fakeApi({ openSpace }, { spacesFlag: false }))
    await settle()

    expect(current).toEqual([])
    expect(openSpace).not.toHaveBeenCalled()
  })

  it('keeps what the session before found until the session that replaced it has walked', async () => {
    const { rerender } = await mount(
      <Probe parent="infra" />,
      fakeApi({ openSpace: openSpaceAmong(Object.values(chain())) }),
    )
    await settle()
    expect(names()).toEqual(['Org', 'Platform', 'Infra'])

    // The session that replaces it has not said its flags yet, and is asked nothing.
    const flags = deferred<{ spaces: boolean }>()
    const next = chain()
    const answer = deferred<SpaceInfo>()
    next.infra.getInfo.mockReturnValueOnce(answer.promise)
    // Under this session the user holds no role in Org.
    const openSpace = openSpaceAmong([next.platform, next.infra])
    await rerender(<Probe parent="infra" />, fakeApi({ getUiFeatureFlags: () => flags.promise, openSpace }))
    await settle()
    expect(openSpace).not.toHaveBeenCalled()
    expect(names()).toEqual(['Org', 'Platform', 'Infra'])

    await act(async () => flags.resolve({ spaces: true }))
    await settle()
    expect(openSpace).toHaveBeenCalledExactlyOnceWith('infra')
    expect(names()).toEqual(['Org', 'Platform', 'Infra'])

    await act(async () => answer.resolve(teamSpace('infra', 'Infra', 'use', 'platform')))
    await settle()
    expect(names()).toEqual(['Platform', 'Infra'])
  })
})
