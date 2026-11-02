import type {
  GadgetMetadataWithTimestamps,
  SpaceInfo,
  SpaceWorkspaceInfo,
} from '@gadgets/workshop-shared/api'
import { isOwnPersonalSpace } from './spaceKinds'
import { asMemberListing, type SpaceListing, type SpaceListings } from './useSpaceListings'

/**
 * One row of a section.
 *
 * - `record`: a workspace in the user's own list, theirs or shared with them, which keeps the
 *   list's row and its actions. `entry` is the entry the section's space lists it under, once
 *   that listing has been read and has one: where its address in the space comes from.
 * - `listed`: a workspace known only from a space's listing, which is another member's.
 */
export type WorkspaceRow =
  | { kind: 'record'; id: string; gadget: GadgetMetadataWithTimestamps; entry?: SpaceWorkspaceInfo }
  | { kind: 'listed'; id: string; workspace: SpaceWorkspaceInfo }

/**
 * One section of the grouped workspace list.
 *
 * - `personal`: the user's own workspaces that are in no team space. `space` is their personal
 *   space once the list of spaces has it.
 * - `space`: a space the user is a member of, with what it lists (see `spaceRows`). `listing` is
 *   how far the read of that listing got; until it is `ready` the rows are only the user's own
 *   workspaces. On the workspaces page these are every space but the user's own personal one.
 * - `elsewhere`: the user's own workspaces in a team space that is not among their spaces, which
 *   is where a workspace stays when its owner leaves a space.
 * - `shared`: workspaces shared with the user that no space section shows.
 */
export type WorkspaceSection = { rows: WorkspaceRow[] } & (
  | { kind: 'personal'; space: SpaceInfo | undefined }
  | { kind: 'space'; space: SpaceInfo; listing: SpaceListing['status'] }
  | { kind: 'elsewhere' | 'shared' }
)

const record = (gadget: GadgetMetadataWithTimestamps, entry?: SpaceWorkspaceInfo): WorkspaceRow =>
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
 * A workspace the user owns is placed by its own record alone (`GadgetMetadata.spaceKey`, absent
 * for their personal space), which is the authority on where it belongs; a listing can trail it,
 * so a listing's entry for one of the user's own workspaces places nothing and only gives the row
 * its `entry`. Every other entry of the listing is a row: with the user's own record of the
 * workspace when it is also shared with them, as a `listed` row otherwise.
 *
 * The rows from the user's list come first, in the order of `gadgets`, then the `listed` rows in
 * the order of the listing.
 */
export const spaceRows = ({ gadgets, space, workspaces, userId, shown = new Set() }: {
  /** The user's list (`AuthenticatedApi.listGadgets`), in the order to show it in. */
  gadgets: GadgetMetadataWithTimestamps[]
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
  const ownSpaceKey = isOwnPersonalSpace(space) ? undefined : space.key
  const fromList = gadgets.filter(gadget =>
    gadget.owner ? sharedHere.has(gadget.id) : gadget.spaceKey === ownSpaceKey)
  return [...fromList.map(gadget => record(gadget, entries.get(gadget.id))), ...listed]
}

/**
 * Lays the user's workspaces out under their spaces, each workspace in exactly one section:
 * `personal`, then one section per other space in the order of `spaces` (see `spaceRows`), then
 * `elsewhere` and `shared` when they have rows.
 *
 * The user's own personal space is not read for this: its section is their own records, which
 * therefore have no `entry`. A workspace two spaces list (as one being moved may be) is shown by
 * the first.
 */
export const groupWorkspaces = ({ gadgets, spaces, listings, userId }: {
  /** The user's list (`AuthenticatedApi.listGadgets`), in the order to show it in. */
  gadgets: GadgetMetadataWithTimestamps[]
  /** The user's spaces (`AuthenticatedApi.listSpaces`). */
  spaces: SpaceInfo[]
  listings: SpaceListings
  /** The user's profile id, once known. */
  userId: string | undefined
}): WorkspaceSection[] => {
  const otherSpaces = spaces.filter(space => !isOwnPersonalSpace(space))
  const otherKeys = new Set(otherSpaces.map(space => space.key))
  // The other members' workspaces a space section already shows.
  const shown = new Set<string>()

  const spaceSections = otherSpaces.map((space): WorkspaceSection => {
    const listing = asMemberListing(listings[space.key] ?? { status: 'loading' })
    const workspaces = listing.status === 'ready' ? listing.workspaces : []
    return {
      kind: 'space',
      space,
      listing: listing.status,
      rows: spaceRows({ gadgets, space, workspaces, userId, shown }),
    }
  })

  const own = gadgets.filter(gadget => !gadget.owner)
  const elsewhere = own.filter(gadget => gadget.spaceKey !== undefined && !otherKeys.has(gadget.spaceKey))
  const shared = gadgets.filter(gadget => gadget.owner && !shown.has(gadget.id))
  return [
    {
      kind: 'personal',
      space: spaces.find(isOwnPersonalSpace),
      rows: own.filter(gadget => gadget.spaceKey === undefined).map(gadget => record(gadget)),
    },
    ...spaceSections,
    ...(elsewhere.length > 0 ? [{ kind: 'elsewhere' as const, rows: elsewhere.map(gadget => record(gadget)) }] : []),
    ...(shared.length > 0 ? [{ kind: 'shared' as const, rows: shared.map(gadget => record(gadget)) }] : []),
  ]
}
