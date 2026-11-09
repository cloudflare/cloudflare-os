import type { RpcStub } from 'capnweb'
import type { Space, SpaceInfo, SpaceWorkspaceInfo, SubspaceInfo } from '@gadgets/workshop-shared/api'
import { useSpaceReads, type SpaceRead } from '../../features/spaces/useSpaceReads'

/**
 * What a space's own page shows of the space besides its info, as last read for the signed-in
 * user (see `SpaceRead`): the sub-spaces directly inside it, by name, and the workspaces it
 * lists, newest first. `workspaces` is empty for a personal space, whose listing is not read.
 */
export type SpaceContents = SpaceRead<{ subspaces: SubspaceInfo[]; workspaces: SpaceWorkspaceInfo[] }>

const LOADING: SpaceContents = { status: 'loading' }
const NO_WORKSPACES: SpaceWorkspaceInfo[] = []

// Both calls are made before either is awaited, so they travel together on the one open.
const readTeamSpace = async (space: RpcStub<Space>) => {
  const [subspaces, workspaces] = await Promise.all([space.listSubspaces(), space.listWorkspaces()])
  return { subspaces, workspaces }
}

const readPersonalSpace = async (space: RpcStub<Space>) =>
  ({ subspaces: await space.listSubspaces(), workspaces: NO_WORKSPACES })

/**
 * Reads, on one open, the sub-spaces of a space (`Space.listSubspaces`) and, for a team space,
 * what it lists (`Space.listWorkspaces`). A personal space's listing is not read: every entry
 * of it is one of its owner's own workspaces, which the owner's records already give, and
 * there is nobody else for it to differ for. Nothing is read while `space` is undefined, which
 * is how a caller waits to learn the space's kind. Reads, and holds back from reading, as
 * `useSpaceReads` says.
 */
export const useSpaceContents = (space: Pick<SpaceInfo, 'id' | 'kind'> | undefined): {
  contents: SpaceContents
  /** Reads the space again, resolving once the read has settled. Does nothing with no space. */
  reload: () => Promise<void>
} => {
  const { reads, reload } = useSpaceReads(
    space ? [space.id] : [],
    space?.kind === 'personal' ? readPersonalSpace : readTeamSpace,
    'Failed to load a space’s contents:',
  )
  return {
    contents: (space && reads[space.id]) ?? LOADING,
    reload: () => (space ? reload(space.id) : Promise.resolve()),
  }
}
