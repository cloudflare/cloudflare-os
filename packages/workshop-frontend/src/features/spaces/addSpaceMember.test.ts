import { describe, expect, it } from 'vitest'
import type { SpaceMemberInfo } from '@gadgets/workshop-shared/api'
import { addSpaceMember } from './addSpaceMember'
import { ME, deferred, fakeSpace, member, person, teamSpace } from './spacesTestUtils'

const ADA = person('ada@example.com', 'Ada')
const CAROL = 'carol@example.com'

const platform = () =>
  fakeSpace(teamSpace('platform', 'Platform'), [member(ME, 'admin'), member(ADA, 'admin')])

describe('addSpaceMember', () => {
  it('adds someone who is not a member', async () => {
    const space = platform()

    const outcome = await addSpaceMember(space.stub, CAROL, 'build')

    expect(outcome).toEqual({ kind: 'added', member: member(person(CAROL, CAROL), 'build') })
    expect(space.listMembers).toHaveBeenCalledTimes(2)
    expect(space.setMemberRole).toHaveBeenCalledExactlyOnceWith(CAROL, 'build')
  })

  it('sends nothing for someone who is a member already', async () => {
    const space = platform()

    expect(await addSpaceMember(space.stub, ADA.id, 'use')).toEqual({ kind: 'held-back' })
    expect(space.setMemberRole).not.toHaveBeenCalled()
    expect(space.members()).toContainEqual(member(ADA, 'admin'))
  })

  it('says so when the person became a member between the read and the change', async () => {
    const space = platform()
    // Another admin adds Carol after the members were read for this add and before its change.
    let firstGiven: SpaceMemberInfo | null = null
    space.listMembers.mockImplementationOnce(async () => {
      const before = space.members()
      firstGiven = await space.setMemberRole(CAROL, 'admin')
      return before
    })

    const outcome = await addSpaceMember(space.stub, CAROL, 'use')

    // The change set the role of the member she had become, who keeps the date she was added.
    expect(outcome).toEqual({
      kind: 'already-member',
      was: 'admin',
      member: { ...firstGiven!, role: 'use' },
    })
    expect(space.members()).toContainEqual({ ...firstGiven!, role: 'use' })
  })

  it('finds no account', async () => {
    const space = platform()
    space.setMemberRole.mockImplementationOnce(async () => null)

    expect(await addSpaceMember(space.stub, 'nobody', 'use')).toEqual({ kind: 'no-account' })
  })

  it('sends the read and the change together', async () => {
    const space = platform()
    const read = deferred<SpaceMemberInfo[]>()
    space.listMembers
      .mockImplementationOnce(async () => space.members())
      .mockImplementationOnce(() => read.promise)

    const adding = addSpaceMember(space.stub, CAROL, 'use')
    await new Promise(resolve => setTimeout(resolve, 0))

    // The read has no answer yet, and the change did not wait for one.
    expect(space.listMembers).toHaveBeenCalledTimes(2)
    expect(space.setMemberRole).toHaveBeenCalledExactlyOnceWith(CAROL, 'use')

    read.resolve([member(ME, 'admin'), member(ADA, 'admin')])
    expect(await adding).toMatchObject({ kind: 'added' })
  })

  it('goes by the change’s own answer when the read sent with it fails', async () => {
    const space = platform()
    space.listMembers
      .mockImplementationOnce(async () => space.members())
      .mockRejectedValueOnce(new Error('The space is busy.'))

    expect(await addSpaceMember(space.stub, CAROL, 'use')).toMatchObject({ kind: 'added' })
  })

  it('fails as the first read does, having sent nothing', async () => {
    const space = platform()
    space.listMembers.mockRejectedValueOnce(new Error('The space is busy.'))

    await expect(addSpaceMember(space.stub, CAROL, 'use')).rejects.toThrow('The space is busy.')
    expect(space.listMembers).toHaveBeenCalledOnce()
    expect(space.setMemberRole).not.toHaveBeenCalled()
  })

  it('fails as the change does', async () => {
    const space = platform()
    space.setMemberRole.mockRejectedValueOnce(
      new Error('Only an admin of this space can change its members.'))

    await expect(addSpaceMember(space.stub, CAROL, 'use'))
      .rejects.toThrow('Only an admin of this space can change its members.')
  })
})
