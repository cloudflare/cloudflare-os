import type { RpcStub } from 'capnweb'
import type { Space, SpaceMemberRole, SpaceWorkspaceInfo } from '@gadgets/workshop-shared/api'
import { useSpaceReads, type SpaceRead, type SpaceReads } from './useSpaceReads'

type Listing = {
  /** The workspaces the space lists, newest first. */
  workspaces: SpaceWorkspaceInfo[]
  /** The role the space says the user holds in it. */
  role: SpaceMemberRole
  /**
   * The id of the space it is inside, which it tells only a user who holds a role there
   * (`SpaceInfo.parent`): `role` may then be the one they hold above it.
   */
  parent?: string
}

/**
 * What one space lists, as last read for the signed-in user (see `SpaceRead`), with the role
 * the space says the user holds in it (`Space.getInfo`): the higher of the one given there and
 * the one inherited, which the entry of the user's list of spaces may understate.
 */
export type SpaceListing = SpaceRead<Listing>

/** Each space's listing by space id. A space with no entry has not been read yet. */
export type SpaceListings = SpaceReads<Listing>

// Both calls are made before either is awaited, so they travel together on the one open.
const readListing = async (space: RpcStub<Space>): Promise<Listing> => {
  const [workspaces, info] = await Promise.all([space.listWorkspaces(), space.getInfo()])
  return { workspaces, role: info.role, parent: info.parent }
}

/**
 * Reads what each of these spaces lists, and the role the user holds in it, on one open of the
 * space. Reads, and holds back from reading, as `useSpaceReads` says.
 */
export const useSpaceListings = (ids: readonly string[]): {
  listings: SpaceListings
  /** Reads one space's listing again, resolving once the read has settled. */
  reload: (id: string) => Promise<void>
} => {
  const { reads, reload } = useSpaceReads(ids, readListing, 'Failed to load a space’s workspaces:')
  return { listings: reads, reload }
}
