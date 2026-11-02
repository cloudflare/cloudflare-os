import { useState, type ReactNode } from 'react'
import type { GadgetMetadataWithTimestamps } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../AuthContext'
import { WorkshopButton } from '../../components/WorkshopControls'
import { groupWorkspaces, matchingRows, type WorkspaceSection } from './groupWorkspaces'
import { SPACE_ACTION_CLASS_NAME } from './SpaceEntryPoints'
import { SpaceSection } from './SpaceSection'
import { isOwnPersonalSpace } from './spaceKinds'
import { useSpaceListings } from './useSpaceListings'
import type { Spaces } from './useSpaces'
import type { WorkspaceRowListing } from './workspaceAddress'

const sectionKey = (section: WorkspaceSection) =>
  section.kind === 'space' ? `space:${section.space.key}` : section.kind

/**
 * The user's workspaces laid out under their spaces: their personal space, each other space they
 * are a member of with what it lists, and what is shared with them besides. The rows of the
 * user's own list are the caller's to render; this adds the sections around them and the rows
 * for other members' workspaces.
 *
 * While a search is on, only the rows whose title matches are shown, and only the sections that
 * still have one.
 */
export const SpaceSections = ({ gadgets, search, renderRow, spaces, onMembersOpen }: {
  /** The user's list (`AuthenticatedApi.listGadgets`), in the order to show it in. */
  gadgets: GadgetMetadataWithTimestamps[]
  /** The text workspaces are being searched for, or empty. */
  search: string
  /** The list's own row for one of `gadgets`, keyed. */
  renderRow: (gadget: GadgetMetadataWithTimestamps, listing?: WorkspaceRowListing) => ReactNode
  /** The user's spaces (`useSpaces`), with the `spaces` flag on. */
  spaces: Spaces
  /** The user asked for the members of the space with this key. */
  onMembersOpen: (spaceKey: string) => void
}) => {
  const { currentUser } = useAuthenticatedApi()
  const { listings, reload } = useSpaceListings(
    spaces.spaces.filter(space => !isOwnPersonalSpace(space)).map(space => space.key))
  const [reloadingSpaces, setReloadingSpaces] = useState(false)

  const reloadSpaces = async () => {
    setReloadingSpaces(true)
    try {
      await spaces.refresh()
    } finally {
      setReloadingSpaces(false)
    }
  }

  // Without the list of spaces there is no telling which sections there are.
  if (spaces.loading) {
    return (
      <div role="status" aria-label="Loading your spaces" className="flex flex-col gap-0.5">
        {[1, 2, 3].map(row => (
          <div key={row} className="h-[56px] animate-pulse rounded-xl bg-kumo-elevated" />
        ))}
      </div>
    )
  }

  const sections = groupWorkspaces({
    gadgets,
    spaces: spaces.spaces,
    listings,
    userId: currentUser?.id,
  })
  const shown = search === ''
    ? sections
    : sections
        .map(section => ({ ...section, rows: matchingRows(section.rows, search) }))
        .filter(section => section.rows.length > 0)

  return (
    <>
      {spaces.failed && (
        <div role="alert" className="flex shrink-0 items-center gap-3 px-3 pb-3">
          <p className="text-[13px] leading-[18px] text-kumo-danger">Couldn’t load your spaces.</p>
          <WorkshopButton
            className={SPACE_ACTION_CLASS_NAME}
            loading={reloadingSpaces}
            onClick={() => void reloadSpaces()}
          >
            Try again
          </WorkshopButton>
        </div>
      )}
      {shown.length === 0 && (
        <div className="py-12 text-center text-sm text-kumo-inactive">No workspaces found</div>
      )}
      {shown.map(section => (
        <SpaceSection
          key={sectionKey(section)}
          section={section}
          renderRow={renderRow}
          onMembersOpen={onMembersOpen}
          onListingReload={reload}
        />
      ))}
    </>
  )
}
