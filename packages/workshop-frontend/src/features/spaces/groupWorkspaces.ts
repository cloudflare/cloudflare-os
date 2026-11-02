import type {
  GadgetMetadataWithTimestamps,
  SpaceInfo,
  SpaceWorkspaceInfo,
} from '@gadgets/workshop-shared/api'
import { isOwnPersonalSpace } from './spaceKinds'
import type { SpaceListing, SpaceListings } from './useSpaceListings'

/**
 * One row of a section.
 *
 * - `record`: a workspace in the user's own list, theirs or shared with them, which keeps the
 *   list's row and its actions.
 * - `listed`: a workspace known only from a space's listing, which is another member's.
 */
export type WorkspaceRow =
  | { kind: 'record'; id: string; gadget: GadgetMetadataWithTimestamps }
  | { kind: 'listed'; id: string; workspace: SpaceWorkspaceInfo }

/**
 * One section of the grouped workspace list.
 *
 * - `personal`: the user's own workspaces that are in no team space. `space` is their personal
 *   space once the list of spaces has it.
 * - `space`: another space the user is a member of, with what it lists. `listing` is how far the
 *   read of that listing got; until it is `ready` the rows are only the user's own workspaces.
 * - `elsewhere`: the user's own workspaces in a team space that is not among their spaces, which
 *   is where a workspace stays when its owner leaves a space.
 * - `shared`: workspaces shared with the user that no space section shows.
 */
export type WorkspaceSection = { rows: WorkspaceRow[] } & (
  | { kind: 'personal'; space: SpaceInfo | undefined }
  | { kind: 'space'; space: SpaceInfo; listing: SpaceListing['status'] }
  | { kind: 'elsewhere' | 'shared' }
)

const record = (gadget: GadgetMetadataWithTimestamps): WorkspaceRow =>
  ({ kind: 'record', id: gadget.id, gadget })

/**
 * Lays the user's workspaces out under their spaces, each workspace in exactly one section:
 * `personal`, then one section per other space in the order of `spaces`, then `elsewhere` and
 * `shared` when they have rows.
 *
 * A workspace the user owns is placed by its own record alone (`GadgetMetadata.spaceKey`), which
 * is the authority on where it belongs; a listing can trail it, so a listing's entries for the
 * user's own workspaces are ignored. Every other entry of a space's listing is shown in that
 * space's section: with the user's own record of it when it is also shared with them, as a
 * `listed` row otherwise. A workspace two spaces list (as one being moved may be) is shown by the
 * first.
 *
 * Within a section the rows from the user's list come first, in the order of `gadgets`, then the
 * `listed` rows in the order of the listing.
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
  const ownIds = new Set(gadgets.filter(gadget => !gadget.owner).map(gadget => gadget.id))
  const sharedIds = new Set(gadgets.filter(gadget => gadget.owner).map(gadget => gadget.id))
  // The workspaces a space section already shows from its listing.
  const shown = new Set<string>()

  const spaceSections = otherSpaces.map((space): WorkspaceSection => {
    const listing = listings[space.key] ?? { status: 'loading' }
    const sharedHere = new Set<string>()
    const listed: WorkspaceRow[] = []
    for (const workspace of listing.status === 'ready' ? listing.workspaces : []) {
      const { id } = workspace
      if (ownIds.has(id) || workspace.owner.id === userId || shown.has(id)) continue
      shown.add(id)
      if (sharedIds.has(id)) sharedHere.add(id)
      else listed.push({ kind: 'listed', id, workspace })
    }
    const fromList = gadgets.filter(gadget =>
      gadget.owner ? sharedHere.has(gadget.id) : gadget.spaceKey === space.key)
    return { kind: 'space', space, listing: listing.status, rows: [...fromList.map(record), ...listed] }
  })

  const own = gadgets.filter(gadget => !gadget.owner)
  const elsewhere = own.filter(gadget => gadget.spaceKey !== undefined && !otherKeys.has(gadget.spaceKey))
  const shared = gadgets.filter(gadget => gadget.owner && !shown.has(gadget.id))
  return [
    {
      kind: 'personal',
      space: spaces.find(isOwnPersonalSpace),
      rows: own.filter(gadget => gadget.spaceKey === undefined).map(record),
    },
    ...spaceSections,
    ...(elsewhere.length > 0 ? [{ kind: 'elsewhere' as const, rows: elsewhere.map(record) }] : []),
    ...(shared.length > 0 ? [{ kind: 'shared' as const, rows: shared.map(record) }] : []),
  ]
}
