import type { SpaceKind, SpaceMemberRole } from '@gadgets/workshop-shared/api'

/** How each member role is named in the UI. */
export const SPACE_ROLE_LABELS: Record<SpaceMemberRole, string> = {
  admin: 'Admin',
  build: 'Build',
  use: 'Use',
}

/**
 * What membership gives, role by role, said where members are managed: the role controls show
 * the role names alone. A role reaches the workspaces the space lists, none of which holds
 * restricted data or is owner-invites-only.
 */
export const SPACE_ROLES_DESCRIPTION =
  'Members can open the workspaces this space lists. '
  + 'Admin: build in them and manage the space’s members and addresses. '
  + 'Build: build in them. Use: use them. '
  + 'Workspaces that have read sensitive data, or that only their owner can add people to, are not included.'

const TEAM_ROLES: readonly SpaceMemberRole[] = ['admin', 'build', 'use']
const PERSONAL_ROLES: readonly SpaceMemberRole[] = ['build', 'use']

/**
 * The roles a member can be given in a space of this kind. A personal space's owner is its only
 * admin, so nobody else can be made one there.
 */
export const assignableRoles = (kind: SpaceKind): readonly SpaceMemberRole[] =>
  kind === 'personal' ? PERSONAL_ROLES : TEAM_ROLES
