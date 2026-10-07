import type { GadgetMetadataWithTimestamps } from '@gadgets/workshop-shared/api'
import { isOwnPersonalSpace, spaceLabel } from '../spaceKinds'
import { useSpaceListings, type SpaceListing } from '../useSpaceListings'
import type { Spaces } from '../useSpaces'
import { SpaceTreeLayout } from './SpaceTreeLayout'

const LOADING: SpaceListing = { status: 'loading' }
const FAILED: SpaceListing = { status: 'failed' }

const UNLISTED_DESCRIPTION = 'Yours, and in no space you can see: holding restricted data, shared only by you, '
  + 'not listed by their space yet, or in a space you have left.'

/**
 * The user's personal space as its tree beside a preview (see `SpaceTreeLayout`), with the user's
 * own workspaces that no listing they can see shows apart under it, whichever space they are
 * grouped in: one holding restricted data or that only its owner may share, which no space
 * lists; one whose registration its space has not seen yet; and one in a team space the user is
 * no longer a member of. Each of the user's spaces is read for this, and the user's own records
 * (`listGadgets`) say where each workspace is grouped.
 */
export const PersonalTree = ({ spaces }: {
  /** The user's spaces (`useSpaces`), with the `spaces` flag on. */
  spaces: Spaces
}) => {
  const personal = spaces.spaces.find(isOwnPersonalSpace)
  const { listings, reload } = useSpaceListings(spaces.spaces.map(space => space.key))

  // Until the list of spaces has it, the personal space's listing is as far off as that list.
  const listing = personal
    ? listings[personal.key] ?? LOADING
    : spaces.failed ? FAILED : LOADING

  // Only a listing that has been read can be said not to show a workspace, and only a list of
  // spaces that has been read can say the user is not in one.
  const isUnlisted = (record: GadgetMetadataWithTimestamps) => {
    const spaceKey = record.spaceKey ?? personal?.key
    if (spaceKey === undefined) return false
    const grouped = listings[spaceKey]
    if (!grouped) return !spaces.loading && !spaces.failed && !spaces.spaces.some(space => space.key === spaceKey)
    if (grouped.status === 'refused') return true
    return grouped.status === 'ready' && !grouped.workspaces.some(entry => entry.id === record.id)
  }

  // A change made from the tree can make any of the user's spaces list a workspace shown apart.
  const reloadListing = async () => {
    if (!personal) return spaces.refresh()
    await Promise.all(spaces.spaces.map(space => reload(space.key)))
  }

  return (
    <SpaceTreeLayout
      // Nothing is done with the key before the listing is read, which needs the space.
      space={{ key: personal?.key ?? '', kind: 'personal', label: personal ? spaceLabel(personal) : 'Personal' }}
      role={personal?.role}
      listing={listing}
      onListingReload={reloadListing}
      unlisted={{ includes: isUnlisted, description: UNLISTED_DESCRIPTION }}
    />
  )
}
