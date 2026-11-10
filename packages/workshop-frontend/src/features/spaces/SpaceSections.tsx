import { useEffect, useEffectEvent, useState } from 'react'
import { useAuthenticatedApi } from '../../AuthContext'
import type { GadgetListRows } from '../../components/GadgetList'
import { BusyButton } from './BusyButton'
import { groupWorkspaces, type WorkspaceSection } from './groupWorkspaces'
import { useFocusAfterAction } from './lostFocus'
import { SPACE_ACTION_CLASS_NAME } from './SpaceEntryPoints'
import { SpaceSection } from './SpaceSection'
import { TeamSpaceCards } from './TeamSpaceCards'
import { useSpaceListings } from './useSpaceListings'
import type { Spaces } from './useSpaces'
import { WorkspaceSearchResults } from './WorkspaceSearchResults'

type TeamSpaceSection = Extract<WorkspaceSection, { kind: 'space' }>
type ListSection = Exclude<WorkspaceSection, { kind: 'space' }>

const isTeamSpace = (section: WorkspaceSection): section is TeamSpaceSection => section.kind === 'space'
const isListSection = (section: WorkspaceSection): section is ListSection => section.kind !== 'space'

/**
 * The user's workspaces laid out under their spaces: their personal space's as rows, then each
 * team space they are a member of as a card that links to the space's own page, then their own
 * workspaces in spaces that are not in their list and what is shared with them besides. The rows
 * of the user's own list are the caller's to render; this adds what goes around them.
 *
 * Every team space's listing is read all the same: a search shows the matching workspaces of
 * every space as one list in place of the sections and cards, and a workspace shared with the
 * user that one of their spaces lists is counted on that space's card instead of being shown as
 * shared.
 */
export const SpaceSections = ({ gadgets, search, renderRow, onFocusLost, emptyState, spaces, onMembersOpen }: GadgetListRows & {
  /** The user's spaces (`useSpaces`), with the `spaces` flag on. */
  spaces: Spaces
  /** The user asked for the members of the space with this id. */
  onMembersOpen: (spaceId: string) => void
}) => {
  const { currentUser } = useAuthenticatedApi()
  const teamIds = spaces.spaces.filter(space => space.kind === 'team').map(space => space.id)
  const { listings, reload } = useSpaceListings(teamIds)
  const [reloadingSpaces, setReloadingSpaces] = useState(false)
  // `Try again` goes once the list of spaces has been read, and the focus it had with it.
  const focusSettled = useFocusAfterAction(onFocusLost)

  // A space that refuses the user has taken them off its members, and its refusal has corrected
  // the record the list of spaces is read from. The list is read again so that the space leaves
  // the page: its card goes, and the user's own workspaces recorded in it show as rows. Once for
  // each set of refusals, so a list that still has the space afterwards is not read in a loop.
  // The card goes by nothing the user pressed, so the focus stays wherever it is.
  const refusedIds = teamIds.filter(id => listings[id]?.status === 'refused').join(' ')
  const dropRefusedSpaces = useEffectEvent(() => {
    void spaces.refresh()
  })
  useEffect(() => {
    if (refusedIds !== '') dropRefusedSpaces()
  }, [refusedIds])

  const reloadSpaces = async () => {
    setReloadingSpaces(true)
    try {
      await spaces.refresh()
    } finally {
      setReloadingSpaces(false)
      focusSettled()
    }
  }

  // Without the list of spaces there is no telling which sections and cards there are.
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
  const teamSpaces = sections.filter(isTeamSpace)
  const listSections = sections.filter(isListSection)
  const renderSection = (section: ListSection) => (
    <SpaceSection key={section.kind} section={section} renderRow={renderRow} />
  )

  return (
    <>
      {spaces.failed && (
        <div role="alert" className="flex shrink-0 items-center gap-3 px-3 pb-3">
          <p className="text-[13px] leading-[18px] text-kumo-danger">Couldn’t load your spaces.</p>
          <BusyButton
            className={SPACE_ACTION_CLASS_NAME}
            busy={reloadingSpaces}
            onClick={() => void reloadSpaces()}
          >
            Try again
          </BusyButton>
        </div>
      )}
      {search !== '' ? (
        <WorkspaceSearchResults
          sections={sections}
          search={search}
          renderRow={renderRow}
          onListingReload={reload}
          onFocusLost={onFocusLost}
        />
      ) : (
        <>
          {listSections.filter(section => section.kind === 'personal').map(renderSection)}
          {teamSpaces.length > 0 && (
            <TeamSpaceCards sections={teamSpaces} onMembersOpen={onMembersOpen} onListingReload={reload} />
          )}
          {listSections.filter(section => section.kind !== 'personal').map(renderSection)}
          {emptyState}
        </>
      )}
    </>
  )
}
