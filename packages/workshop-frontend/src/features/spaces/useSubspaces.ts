import type { RpcStub } from 'capnweb'
import type { Space, SubspaceInfo } from '@gadgets/workshop-shared/api'
import { useSpaceReads, type SpaceRead, type SpaceReads } from './useSpaceReads'

/** The sub-spaces created directly in one space, as last read for the signed-in user (see `SpaceRead`). */
export type SubspaceListing = SpaceRead<{ subspaces: SubspaceInfo[] }>

const readSubspaces = async (space: RpcStub<Space>) => ({ subspaces: await space.listSubspaces() })

/**
 * Reads the sub-spaces of each of these spaces (`Space.listSubspaces`): those directly inside
 * each, by name. Reads, and holds back from reading, as `useSpaceReads` says.
 */
export const useSubspaces = (ids: readonly string[]): {
  subspaces: SpaceReads<{ subspaces: SubspaceInfo[] }>
  /** Reads one space's sub-spaces again, resolving once the read has settled. */
  reload: (id: string) => Promise<void>
} => {
  const { reads, reload } = useSpaceReads(ids, readSubspaces, 'Failed to load a space’s sub-spaces:')
  return { subspaces: reads, reload }
}
