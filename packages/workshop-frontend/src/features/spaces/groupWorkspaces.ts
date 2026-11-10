import type {
  WorkspaceMetadataWithTimestamps,
  SpaceInfo,
  SpaceWorkspaceInfo,
} from '@gadgets/workshop-shared/api'
import { spaceLabel } from './spaceKinds'
import type { SpaceListing, SpaceListings } from './useSpaceListings'

/**
 * One row of a section.
 *
 * - `record`: a workspace in the user's own list, theirs or shared with them, which keeps the
 *   list's row and its actions. `entry` is the entry its space lists it under, once that listing
 *   has been read and has one: without it the space is not known to list the workspace.
 * - `listed`: a workspace known only from a space's listing, which is another member's.
 */
export type WorkspaceRow =
  | { kind: 'record'; id: string; gadget: WorkspaceMetadataWithTimestamps; entry?: SpaceWorkspaceInfo }
  | { kind: 'listed'; id: string; workspace: SpaceWorkspaceInfo }

/**
 * One group of the user's workspaces: a section of the workspaces page, or a team space, which
 * that page shows as a card and the space's own page shows as rows.
 *
 * - `personal`: the user's own workspaces that are in no team space. `space` is their personal
 *   space once the list of spaces has it.
 * - `space`: a space the user is a member of, with what it lists (see `spaceRows`). `listing` is
 *   how far the read of that listing got; until it is `ready` the rows are only the user's own
 *   workspaces. On the workspaces page these are the user's team spaces.
 * - `elsewhere`: the user's own workspaces in a team space that is not among their spaces, which
 *   is where a workspace stays when its owner leaves a space.
 * - `shared`: workspaces shared with the user that none of their team spaces shows.
 */
export type WorkspaceSection = { rows: WorkspaceRow[] } & (
  | { kind: 'personal'; space: SpaceInfo | undefined }
  | { kind: 'space'; space: SpaceInfo; listing: SpaceListing['status'] }
  | { kind: 'elsewhere' | 'shared' }
)

/** What a section is called where it is shown: its heading, or the space a search result is in. */
export const sectionTitle = (section: WorkspaceSection): string => {
  switch (section.kind) {
    case 'personal': return 'Personal'
    case 'space': return spaceLabel(section.space)
    case 'elsewhere': return 'In other spaces'
    case 'shared': return 'Shared with me'
  }
}

const record = (gadget: WorkspaceMetadataWithTimestamps, entry?: SpaceWorkspaceInfo): WorkspaceRow =>
  ({ kind: 'record', id: gadget.id, gadget, entry })

const rowTitle = (row: WorkspaceRow) => (row.kind === 'record' ? row.gadget.title : row.workspace.title)

/** The rows whose title contains `search`, in any case; every row when `search` is empty. */
export const matchingRows = (rows: WorkspaceRow[], search: string): WorkspaceRow[] => {
  const needle = search.toLowerCase()
  return needle === '' ? rows : rows.filter(row => rowTitle(row).toLowerCase().includes(needle))
}

/**
 * The rows of one space the user is a member of.
 *
 * A workspace the user owns is placed by its own record alone (`WorkspaceMetadata.spaceId`, absent
 * for their personal space), which is the authority on where it belongs; a listing can trail it,
 * so a listing's entry for one of the user's own workspaces places nothing and only gives the row
 * its `entry`. Every other entry of the listing is a row: with the user's own record of the
 * workspace when it is also shared with them, as a `listed` row otherwise.
 *
 * The rows from the user's list come first, in the order of `gadgets`, then the `listed` rows in
 * the order of the listing.
 */
export const spaceRows = ({ gadgets, space, workspaces, userId, shown = new Set() }: {
  /** The user's list (`AuthenticatedApi.listWorkspaces`), in the order to show it in. */
  gadgets: WorkspaceMetadataWithTimestamps[]
  space: SpaceInfo
  /** What the space lists (`Space.listWorkspaces`), or nothing while that has not been read. */
  workspaces: SpaceWorkspaceInfo[]
  /** The user's profile id, once known. */
  userId: string | undefined
  /**
   * Other members' workspaces that another space's rows already show. They are left out here,
   * and the ones these rows show are added.
   */
  shown?: Set<string>
}): WorkspaceRow[] => {
  const records = new Map(gadgets.map(gadget => [gadget.id, gadget]))
  const entries = new Map(workspaces.map(workspace => [workspace.id, workspace]))
  const sharedHere = new Set<string>()
  const listed: WorkspaceRow[] = []
  for (const workspace of workspaces) {
    const { id } = workspace
    const known = records.get(id)
    if ((known && !known.owner) || workspace.owner.id === userId || shown.has(id)) continue
    shown.add(id)
    if (known) sharedHere.add(id)
    else listed.push({ kind: 'listed', id, workspace })
  }
  const ownSpaceId = space.kind === 'personal' ? undefined : space.id
  const fromList = gadgets.filter(gadget =>
    gadget.owner ? sharedHere.has(gadget.id) : gadget.spaceId === ownSpaceId)
  return [...fromList.map(gadget => record(gadget, entries.get(gadget.id))), ...listed]
}

/**
 * Groups the user's workspaces by their spaces, each workspace in exactly one group: `personal`,
 * then one per team space in the order of `spaces` (see `spaceRows`), then `elsewhere` and
 * `shared` when they have rows.
 *
 * The user's personal space is not read for this: its rows are their own records, which
 * therefore have no `entry`. A workspace two spaces list (as one being moved may be) is shown by
 * the first.
 */
export const groupWorkspaces = ({ gadgets, spaces, listings, userId }: {
  /** The user's list (`AuthenticatedApi.listWorkspaces`), in the order to show it in. */
  gadgets: WorkspaceMetadataWithTimestamps[]
  /** The user's spaces (`AuthenticatedApi.listSpaces`). */
  spaces: SpaceInfo[]
  listings: SpaceListings
  /** The user's profile id, once known. */
  userId: string | undefined
}): WorkspaceSection[] => {
  const teamSpaces = spaces.filter(space => space.kind === 'team')
  const teamIds = new Set(teamSpaces.map(space => space.id))
  // The other members' workspaces a team space before this one already shows.
  const shown = new Set<string>()

  const spaceSections = teamSpaces.map((space): WorkspaceSection => {
    const listing: SpaceListing = listings[space.id] ?? { status: 'loading' }
    const workspaces = listing.status === 'ready' ? listing.workspaces : []
    return {
      kind: 'space',
      space,
      listing: listing.status,
      rows: spaceRows({ gadgets, space, workspaces, userId, shown }),
    }
  })

  const own = gadgets.filter(gadget => !gadget.owner)
  const elsewhere = own.filter(gadget => gadget.spaceId !== undefined && !teamIds.has(gadget.spaceId))
  const shared = gadgets.filter(gadget => gadget.owner && !shown.has(gadget.id))
  return [
    {
      kind: 'personal',
      space: spaces.find(space => space.kind === 'personal'),
      rows: own.filter(gadget => gadget.spaceId === undefined).map(gadget => record(gadget)),
    },
    ...spaceSections,
    ...(elsewhere.length > 0 ? [{ kind: 'elsewhere' as const, rows: elsewhere.map(gadget => record(gadget)) }] : []),
    ...(shared.length > 0 ? [{ kind: 'shared' as const, rows: shared.map(gadget => record(gadget)) }] : []),
  ]
}
