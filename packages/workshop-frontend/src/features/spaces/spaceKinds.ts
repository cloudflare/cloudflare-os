import type { SpaceInfo } from '@gadgets/workshop-shared/api'

/**
 * Whether `space`, as it is reported to a user, is that user's own personal space. Nobody but its
 * owner is ever a personal space's admin, so it is the one personal space they are admin of; any
 * other is another person's, which gives them no role or, in an entry their list of spaces has
 * not yet forgotten, a lesser one.
 */
export const isOwnPersonalSpace = (space: Pick<SpaceInfo, 'kind' | 'role'>): boolean =>
  space.kind === 'personal' && space.role === 'admin'

/**
 * What a space is called where it is shown to a user. A personal space's name is its owner's
 * display name, which on its own would read as a person: the user's own is 'Personal', and
 * another person's, which they can only visit, is named as that person's.
 */
export const spaceLabel = (space: Pick<SpaceInfo, 'kind' | 'name' | 'role'>): string =>
  space.kind === 'team'
    ? space.name
    : isOwnPersonalSpace(space) ? 'Personal' : `${space.name}’s personal space`
