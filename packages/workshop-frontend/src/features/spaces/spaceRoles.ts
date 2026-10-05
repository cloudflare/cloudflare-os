import type { SpaceKind, SpaceMemberRole } from '@gadgets/workshop-shared/api'

/** How each member role is named in the UI. */
export const SPACE_ROLE_LABELS: Record<SpaceMemberRole, string> = {
  admin: 'Admin',
  build: 'Build',
  use: 'Use',
}

const TEAM_ROLES: readonly SpaceMemberRole[] = ['admin', 'build', 'use']
const PERSONAL_ROLES: readonly SpaceMemberRole[] = ['build', 'use']

/**
 * The roles a member can be given in a space of this kind. A personal space's owner is its only
 * admin, so nobody else can be made one there.
 */
export const assignableRoles = (kind: SpaceKind): readonly SpaceMemberRole[] =>
  kind === 'personal' ? PERSONAL_ROLES : TEAM_ROLES
