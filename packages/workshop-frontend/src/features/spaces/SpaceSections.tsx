import { useId, useState, type ReactNode } from 'react'
import type { GadgetMetadataWithTimestamps } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../AuthContext'
import { WorkshopButton } from '../../components/WorkshopControls'
import {
  groupWorkspaces,
  matchingRows,
  rowListing,
  sectionTitle,
  type SpaceRowListing,
  type WorkspaceSection,
} from './groupWorkspaces'
import { ListedWorkspaceRow } from './ListedWorkspaceRow'
import { SPACE_ACTION_CLASS_NAME } from './SpaceEntryPoints'
import { SpaceSection } from './SpaceSection'
import { isOwnPersonalSpace } from './spaceKinds'
import { TeamSpaceCard } from './TeamSpaceCard'
import { useSpaceListings } from './useSpaceListings'
import type { Spaces } from './useSpaces'

type RenderRow = (gadget: GadgetMetadataWithTimestamps, listing?: SpaceRowListing, describedBy?: string) => ReactNode
type SpaceOfList = Extract<WorkspaceSection, { kind: 'space' }>
type ListSection = Exclude<WorkspaceSection, { kind: 'space' }>

const isSpaceSection = (section: WorkspaceSection): section is SpaceOfList => section.kind === 'space'
const isListSection = (section: WorkspaceSection): section is ListSection => section.kind !== 'space'

/** The user's team spaces as cards, under a heading of their own. */
const TeamSpaceCards = ({ sections, onMembersOpen, onListingReload }: {
  sections: SpaceOfList[]
  onMembersOpen: (spaceKey: string) => void
  onListingReload: (spaceKey: string) => Promise<void>
}) => {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} className="flex shrink-0 flex-col gap-1.5 pb-5">
      <h2 id={headingId} className="flex min-h-9 items-center px-3 text-[13px] leading-[18px] font-semibold tracking-[-0.25px] text-kumo-default">
        Team spaces
      </h2>
      <ul className="grid grid-cols-1 gap-2 px-3 sm:grid-cols-2">
        {sections.map(section => (
          <TeamSpaceCard
            key={section.space.key}
            section={section}
            onMembersOpen={onMembersOpen}
            onListingReload={onListingReload}
          />
        ))}
      </ul>
    </section>
  )
}

/**
 * Every section's rows whose workspace's title matches the search, as one list in the order of
 * the sections, each described by which space it is in. A team space whose listing is still being
 * read or could not be read says so, since its workspaces are missing from the results.
 */
const SearchResults = ({ sections, search, renderRow, onListingReload }: {
  sections: WorkspaceSection[]
  search: string
  renderRow: RenderRow
  onListingReload: (spaceKey: string) => Promise<void>
}) => {
  const { currentUser } = useAuthenticatedApi()
  const [reloading, setReloading] = useState(false)
  const captionIdPrefix = useId()
  const results = sections.flatMap(section =>
    matchingRows(section.rows, search).map(row => ({ section, row })))
  const spaceSections = sections.filter(isSpaceSection)
  const loading = spaceSections.some(section => section.listing === 'loading')
  const failed = spaceSections.filter(section => section.listing === 'failed')

  const reloadFailed = async () => {
    setReloading(true)
    try {
      await Promise.all(failed.map(section => onListingReload(section.space.key)))
    } finally {
      setReloading(false)
    }
  }

  return (
    <>
      {failed.length > 0 && (
        <div role="alert" className="flex items-center gap-3 px-3 pb-2">
          <p className="text-[13px] leading-[18px] text-kumo-danger">
            Couldn’t search {failed.map(section => sectionTitle(section)).join(', ')}.
          </p>
          <WorkshopButton
            className={SPACE_ACTION_CLASS_NAME}
            aria-label="Try again to search every space"
            loading={reloading}
            onClick={() => void reloadFailed()}
          >
            Try again
          </WorkshopButton>
        </div>
      )}
      {results.length > 0 && (
        <ul aria-label="Search results" className="flex shrink-0 flex-col gap-0.5">
          {results.map(({ section, row }) => {
            const entry = row.kind === 'record' ? row.entry : row.workspace
            const listing = rowListing({ section, entry, userId: currentUser?.id })
            const captionId = `${captionIdPrefix}${row.id}`
            return (
              <li key={row.id}>
                <p id={captionId} className="px-3 pt-1.5 text-[12px] leading-4 text-kumo-subtle">
                  {sectionTitle(section)}
                </p>
                {row.kind === 'record'
                  ? renderRow(row.gadget, listing, captionId)
                  : <ListedWorkspaceRow workspace={row.workspace} listing={listing} describedBy={captionId} />}
              </li>
            )
          })}
        </ul>
      )}
      {loading && (
        <p role="status" className="px-3 py-2 text-[13px] leading-[18px] text-kumo-inactive">
          Loading the workspaces of your spaces…
        </p>
      )}
      {results.length === 0 && !loading && (
        <div className="py-12 text-center text-sm text-kumo-inactive">
          {failed.length > 0 ? 'No workspaces found, but the results may be incomplete.' : 'No workspaces found'}
        </div>
      )}
    </>
  )
}

/**
 * The user's workspaces laid out under their spaces: their personal space's, then each team
 * space they are a member of as a card that links to the space's own page, then their own
 * workspaces in spaces they are no longer in and what is shared with them besides. The rows of
 * the user's own list are the caller's to render; this adds the sections around them.
 *
 * Every other space's listing is read all the same: a search shows the matching workspaces of
 * every space as one list, and a workspace shared with the user that one of their spaces lists
 * is counted on that space's card instead of being shown as shared.
 */
export const SpaceSections = ({ gadgets, search, renderRow, spaces, onMembersOpen }: {
  /** The user's list (`AuthenticatedApi.listGadgets`), in the order to show it in. */
  gadgets: GadgetMetadataWithTimestamps[]
  /** The text workspaces are being searched for, or empty. */
  search: string
  /** The list's own row for one of `gadgets`, keyed. */
  renderRow: RenderRow
  /** The user's spaces (`useSpaces`), with the `spaces` flag on. */
  spaces: Spaces
  /** The user asked for the members of the space with this key. */
  onMembersOpen: (spaceKey: string) => void
}) => {
  const { currentUser } = useAuthenticatedApi()
  // Another person's personal space has no members besides its owner, so an entry for one that the
  // user's list of spaces still has is stale: it is neither one of their spaces nor a team space.
  const ownSpaces = spaces.spaces.filter(space => space.kind === 'team' || isOwnPersonalSpace(space))
  const { listings, reload } = useSpaceListings(
    ownSpaces.filter(space => !isOwnPersonalSpace(space)).map(space => space.key))
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
    spaces: ownSpaces,
    listings,
    userId: currentUser?.id,
  })
  const spaceSections = sections.filter(isSpaceSection)
  const listSections = sections.filter(isListSection)
  const renderSection = (section: ListSection) => (
    <SpaceSection key={section.kind} section={section} renderRow={renderRow} onListingReload={reload} />
  )

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
      {search !== '' ? (
        <SearchResults sections={sections} search={search} renderRow={renderRow} onListingReload={reload} />
      ) : (
        <>
          {listSections.filter(section => section.kind === 'personal').map(renderSection)}
          {spaceSections.length > 0 && (
            <TeamSpaceCards sections={spaceSections} onMembersOpen={onMembersOpen} onListingReload={reload} />
          )}
          {listSections.filter(section => section.kind !== 'personal').map(renderSection)}
        </>
      )}
    </>
  )
}
