import type { RpcStub } from 'capnweb'
import type { Space, SpaceMemberInfo, SpaceMemberRole } from '@gadgets/workshop-shared/api'

/** How an attempt to add a person to a space ended. */
export type SpaceMemberAddOutcome =
  /** They were not a member, and are one now. */
  | { kind: 'added'; member: SpaceMemberInfo }
  /**
   * They had become a member since the members were read for this add, so the call set their
   * role instead of adding them: `was` is the role it replaced.
   */
  | { kind: 'already-member'; member: SpaceMemberInfo; was: SpaceMemberRole }
  /** They were a member when the members were read for this add: nothing was sent. */
  | { kind: 'held-back' }
  /** No account has this username or email. */
  | { kind: 'no-account' }

/**
 * Adds the user with this username or email to `space` in `role`.
 *
 * A space has no call that only adds: `setMemberRole` sets a role exactly, so sending someone
 * who is a member already would replace their role with the one picked for a newcomer. The
 * members are therefore read first, and nothing is sent for someone who is among them. Another
 * admin may still add the same person between that read and the change. To tell, the members
 * are read once more in the same breath as the change, the two calls sent together so that the
 * space runs them back to back: someone that read has was a member before the change, whose
 * answer then shows the role they have, not a newcomer. A read that fails is no failure of the
 * add, which goes by the change's own answer.
 */
export const addSpaceMember = async (
  space: RpcStub<Space>,
  username: string,
  role: SpaceMemberRole,
): Promise<SpaceMemberAddOutcome> => {
  const members = await space.listMembers()
  if (members.some(({ profile }) => profile.id === username)) return { kind: 'held-back' }

  const membersAtChange = space.listMembers().then(read => read, () => null)
  const member = await space.setMemberRole(username, role)
  if (member === null) return { kind: 'no-account' }
  const was = (await membersAtChange)?.find(({ profile }) => profile.id === member.profile.id)
  return was ? { kind: 'already-member', member, was: was.role } : { kind: 'added', member }
}
