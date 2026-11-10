import type { SpaceMemberRole } from '@gadgets/workshop-shared/api'

/** How each member role is named in the UI. */
export const SPACE_ROLE_LABELS: Record<SpaceMemberRole, string> = {
  admin: 'Admin',
  build: 'Build',
  use: 'Use',
}

/**
 * What membership gives, role by role, said where members are managed: the role controls show
 * the role names alone. A role reaches every workspace the space lists.
 */
export const SPACE_ROLES_DESCRIPTION =
  'Members can open the workspaces this space lists. '
  + 'Admin: build in them and manage the space’s members. '
  + 'Build: build in them. Use: use them.'

/** The roles a member can be given, in the order they are offered. */
export const SPACE_ROLES: readonly SpaceMemberRole[] = ['admin', 'build', 'use']
