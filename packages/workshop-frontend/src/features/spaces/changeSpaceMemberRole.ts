import type { RpcStub } from 'capnweb'
import type { Space, SpaceMemberInfo, SpaceMemberRole } from '@gadgets/workshop-shared/api'

/** How an attempt to change a member's role ended. */
type SpaceMemberRoleChangeOutcome =
  /** They were a member, and have the role. */
  | { kind: 'changed' }
  /** They were not a member when the members were read for this change: nothing was sent. */
  | { kind: 'held-back' }
  /**
   * They had been removed since the members were read for this change, so the call made them
   * a member again, in the role.
   */
  | { kind: 'added-back' }
  /** No account has this profile id. */
  | { kind: 'no-account' }

/**
 * Sets the role of the member of `space` with this profile id to `role`.
 *
 * `setMemberRole` makes a member of whoever is not one, so sending someone whom another admin
 * has removed since the caller last read the members would let them back in. The members are
 * therefore read first, and nothing is sent for someone who is not among them. Another admin may
 * still remove them between that read and the change. To tell, the members are read once more in
 * the same breath as the change, the two calls sent together so that the space runs them back to
 * back: someone that read lacks was let back in by the change. A read that fails is no failure
 * of the change, which goes by its own answer.
 */
export const changeSpaceMemberRole = async (
  space: RpcStub<Space>,
  profileId: string,
  role: SpaceMemberRole,
): Promise<SpaceMemberRoleChangeOutcome> => {
  const isMember = ({ profile }: SpaceMemberInfo) => profile.id === profileId
  if (!(await space.listMembers()).some(isMember)) return { kind: 'held-back' }

  const membersAtChange = space.listMembers().then(read => read, () => null)
  if (await space.setMemberRole(profileId, role) === null) return { kind: 'no-account' }
  const read = await membersAtChange
  return { kind: read === null || read.some(isMember) ? 'changed' : 'added-back' }
}
