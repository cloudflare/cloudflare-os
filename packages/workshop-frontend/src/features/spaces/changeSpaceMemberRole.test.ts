import { describe, expect, it } from 'vitest'
import type { SpaceMemberInfo } from '@gadgets/workshop-shared/api'
import { changeSpaceMemberRole } from './changeSpaceMemberRole'
import { ME, deferred, fakeSpace, member, person, teamSpace } from './spacesTestUtils'

const ADA = person('ada@example.com', 'Ada')

const platform = () =>
  fakeSpace(teamSpace('platform', 'Platform'), [member(ME, 'admin'), member(ADA, 'admin')])

describe('changeSpaceMemberRole', () => {
  it('changes the role of a member', async () => {
    const space = platform()

    expect(await changeSpaceMemberRole(space.stub, ADA.id, 'use')).toEqual({ kind: 'changed' })
    expect(space.setMemberRole).toHaveBeenCalledExactlyOnceWith(ADA.id, 'use')
    expect(space.members()).toContainEqual(member(ADA, 'use'))
  })

  it('sends nothing for someone who is not a member, whom the change would let in', async () => {
    const space = platform()
    // Another admin removed Ada after the caller read the members.
    await space.removeMember(ADA.id)

    expect(await changeSpaceMemberRole(space.stub, ADA.id, 'use')).toEqual({ kind: 'held-back' })
    expect(space.setMemberRole).not.toHaveBeenCalled()
    expect(space.members()).toEqual([member(ME, 'admin')])
  })

  it('says so when the member was removed between the read and the change', async () => {
    const space = platform()
    space.listMembers.mockImplementationOnce(async () => {
      const before = space.members()
      await space.removeMember(ADA.id)
      return before
    })

    expect(await changeSpaceMemberRole(space.stub, ADA.id, 'use')).toEqual({ kind: 'added-back' })
    expect(space.members().map(({ profile, role }) => [profile.id, role]))
      .toEqual([[ME.id, 'admin'], [ADA.id, 'use']])
  })

  it('finds no account', async () => {
    const space = platform()
    space.setMemberRole.mockImplementationOnce(async () => null)

    expect(await changeSpaceMemberRole(space.stub, ADA.id, 'use')).toEqual({ kind: 'no-account' })
  })

  it('sends the read and the change together', async () => {
    const space = platform()
    const read = deferred<SpaceMemberInfo[]>()
    space.listMembers
      .mockImplementationOnce(async () => space.members())
      .mockImplementationOnce(() => read.promise)

    const changing = changeSpaceMemberRole(space.stub, ADA.id, 'use')
    await new Promise(resolve => setTimeout(resolve, 0))

    // The read has no answer yet, and the change did not wait for one.
    expect(space.listMembers).toHaveBeenCalledTimes(2)
    expect(space.setMemberRole).toHaveBeenCalledExactlyOnceWith(ADA.id, 'use')

    read.resolve([member(ME, 'admin'), member(ADA, 'admin')])
    expect(await changing).toEqual({ kind: 'changed' })
  })

  it('goes by the change’s own answer when the read sent with it fails', async () => {
    const space = platform()
    space.listMembers
      .mockImplementationOnce(async () => space.members())
      .mockRejectedValueOnce(new Error('The space is busy.'))

    expect(await changeSpaceMemberRole(space.stub, ADA.id, 'use')).toEqual({ kind: 'changed' })
  })

  it('fails as the first read does, having sent nothing', async () => {
    const space = platform()
    space.listMembers.mockRejectedValueOnce(new Error('The space is busy.'))

    await expect(changeSpaceMemberRole(space.stub, ADA.id, 'use')).rejects.toThrow('The space is busy.')
    expect(space.setMemberRole).not.toHaveBeenCalled()
  })

  it('fails as the change does', async () => {
    const space = platform()
    space.setMemberRole.mockRejectedValueOnce(new Error('A space must keep at least one admin.'))

    await expect(changeSpaceMemberRole(space.stub, ADA.id, 'use'))
      .rejects.toThrow('A space must keep at least one admin.')
  })
})
