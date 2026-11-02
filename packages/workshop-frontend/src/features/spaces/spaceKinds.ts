import type { SpaceInfo } from '@gadgets/workshop-shared/api'

/**
 * Whether `space`, as `AuthenticatedApi.listSpaces` reports it to a user, is that user's own
 * personal space: its owner is its only admin, so it is the one personal space they are admin of.
 */
export const isOwnPersonalSpace = (space: Pick<SpaceInfo, 'kind' | 'role'>): boolean =>
  space.kind === 'personal' && space.role === 'admin'

/**
 * What a space the user is a member of is called in a list of their spaces. A personal space's
 * name is its owner's display name, which on its own would read as a person.
 */
export const spaceLabel = (space: Pick<SpaceInfo, 'kind' | 'name' | 'role'>): string =>
  space.kind === 'team'
    ? space.name
    : isOwnPersonalSpace(space) ? 'Personal' : `${space.name}’s personal space`
