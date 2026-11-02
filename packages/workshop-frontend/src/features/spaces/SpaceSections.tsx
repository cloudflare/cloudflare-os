import { useState, type ReactNode } from 'react'
import type { GadgetMetadataWithTimestamps } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../AuthContext'
import { WorkshopButton } from '../../components/WorkshopControls'
import { groupWorkspaces, type WorkspaceRow, type WorkspaceSection } from './groupWorkspaces'
import { SECTION_ACTION_CLASS_NAME, SpaceSection } from './SpaceSection'
import { isOwnPersonalSpace } from './spaceKinds'
import { useSpaceListings } from './useSpaceListings'
import type { Spaces } from './useSpaces'

const sectionKey = (section: WorkspaceSection) =>
  section.kind === 'space' ? `space:${section.space.key}` : section.kind

const rowTitle = (row: WorkspaceRow) => (row.kind === 'record' ? row.gadget.title : row.workspace.title)

/**
 * The user's workspaces laid out under their spaces: their personal space, each other space they
 * are a member of with what it lists, and what is shared with them besides. The rows of the
 * user's own list are the caller's to render; this adds the sections around them and the rows
 * for other members' workspaces.
 *
 * While a search is on, only the rows whose title matches are shown, and only the sections that
 * still have one.
 */
export const SpaceSections = ({
  gadgets,
  search,
  renderRow,
  spaces,
  focusedSpaceKey,
  onSpaceFocused,
  onMembersOpen,
}: {
  /** The user's list (`AuthenticatedApi.listGadgets`), in the order to show it in. */
  gadgets: GadgetMetadataWithTimestamps[]
  /** The text workspaces are being searched for, or empty. */
  search: string
  /** The list's own row for one of `gadgets`, keyed. */
  renderRow: (gadget: GadgetMetadataWithTimestamps) => ReactNode
  /** The user's spaces (`useSpaces`), with the `spaces` flag on. */
  spaces: Spaces
  /** The space whose section the page is being asked for, if any. */
  focusedSpaceKey: string | undefined
  /**
   * That section has been scrolled to and focused. The caller now withdraws the request, so that
   * it is not answered again when the sections next mount.
   */
  onSpaceFocused: () => void
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
  const needle = search.toLowerCase()
  const matching = needle === ''
    ? sections
    : sections.map(section => ({
        ...section,
        rows: section.rows.filter(row => rowTitle(row).toLowerCase().includes(needle)),
      }))
  const hidden = (section: WorkspaceSection) => needle !== '' && section.rows.length === 0
  const listingsSettled = sections.every(section =>
    section.kind !== 'space' || section.listing !== 'loading')

  return (
    <>
      {spaces.failed && (
        <div role="alert" className="flex shrink-0 items-center gap-3 px-3 pb-3">
          <p className="text-[13px] leading-[18px] text-kumo-danger">Couldn’t load your spaces.</p>
          <WorkshopButton
            className={SECTION_ACTION_CLASS_NAME}
            loading={reloadingSpaces}
            onClick={() => void reloadSpaces()}
          >
            Try again
          </WorkshopButton>
        </div>
      )}
      {matching.every(hidden) && (
        <div className="py-12 text-center text-sm text-kumo-inactive">No workspaces found</div>
      )}
      {matching.map(section => (
        <SpaceSection
          key={sectionKey(section)}
          section={section}
          hidden={hidden(section)}
          focused={
            focusedSpaceKey !== undefined
            && (section.kind === 'personal' || section.kind === 'space')
            && section.space?.key === focusedSpaceKey
          }
          onFocused={onSpaceFocused}
          listingsSettled={listingsSettled}
          renderRow={renderRow}
          onMembersOpen={onMembersOpen}
          onListingReload={reload}
        />
      ))}
    </>
  )
}
