import type { RpcStub } from 'capnweb'
import type { Space, SpaceInfo } from '@gadgets/workshop-shared/api'
import { useSpaceReads, type SpaceReads } from './useSpaceReads'

const readInfo = async (space: RpcStub<Space>) => ({ info: await space.getInfo() })

/**
 * Reads the info of each of these spaces (`Space.getInfo`), for a space the user's list does
 * not have: one a workspace is recorded in, or one a link names. A space the user cannot open
 * is `refused`. Reads, and holds back from reading, as `useSpaceReads` says.
 */
export const useSpaceInfos = (ids: readonly string[]): {
  infos: SpaceReads<{ info: SpaceInfo }>
  /** Reads one space's info again, resolving once the read has settled. */
  reload: (id: string) => Promise<void>
} => {
  const { reads, reload } = useSpaceReads(ids, readInfo, 'Failed to load a space’s info:')
  return { infos: reads, reload }
}
