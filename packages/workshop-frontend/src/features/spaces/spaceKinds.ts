import type { SpaceInfo } from '@gadgets/workshop-shared/api'

/**
 * What a space is called where it is shown to a user. A personal space's name is its owner's
 * display name, which on its own would read as a person, and the only personal space a user is
 * shown is their own, so it is called 'Personal'.
 */
export const spaceLabel = (space: Pick<SpaceInfo, 'kind' | 'name'>): string =>
  space.kind === 'team' ? space.name : 'Personal'
