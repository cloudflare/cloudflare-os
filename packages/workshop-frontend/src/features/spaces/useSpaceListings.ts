import { useEffect, useEffectEvent, useRef, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, SpaceWorkspaceInfo } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../AuthContext'
import { useUiFeatureFlag } from '../../FeatureFlagsContext'
import { logRpcFailure } from '../../rpcErrors'
import { isNotAMemberError } from './spaceErrors'

/**
 * What one space lists, as last read for the signed-in user.
 *
 * - `loading`: not read yet.
 * - `ready`: the workspaces the space lists, newest first.
 * - `refused`: the space does not count the user as a member.
 * - `failed`: it could not be read for another reason; `reload` reads it again.
 */
export type SpaceListing =
  | { status: 'loading' | 'refused' | 'failed' }
  | { status: 'ready'; workspaces: SpaceWorkspaceInfo[] }

/** Each space's listing by space id. A space with no entry has not been read yet. */
export type SpaceListings = Readonly<Record<string, SpaceListing>>

const NO_LISTINGS: SpaceListings = {}

/**
 * Reads what each of these spaces lists when the component mounts. When the set of ids changes,
 * the spaces that joined it are read, and so are those whose listing has not been read; a space
 * that stays in the set with its listing read is not asked again, since every read opens the
 * space. Every space is read on its own, so one that fails or refuses leaves the others as they
 * are. A listing already read stays in place while it is read again.
 *
 * Like `useSpaces`, the hook asks a session for nothing before that session's own flags say the
 * `spaces` flag is on: the ids it is given may be the ones a session before it listed.
 */
export const useSpaceListings = (ids: readonly string[]): {
  listings: SpaceListings
  /** Reads one space's listing again, resolving once the read has settled. */
  reload: (id: string) => Promise<void>
} => {
  const { authenticatedApi } = useAuthenticatedApi()
  const { enabled } = useUiFeatureFlag('spaces')
  const [read, setRead] = useState<{
    api: RpcStub<AuthenticatedApi>
    listings: SpaceListings
  } | null>(null)
  const reloadRef = useRef<((id: string) => Promise<void>) | null>(null)
  // One string, so the effect follows the set of spaces and not the identity of the array. It
  // is JSON because an id is whatever names the space to the caller, a page's route parameter
  // included, and may hold any character.
  const serializedIds = JSON.stringify(ids)
  // The ids the effect last read for. A space that left the set and is back is read again.
  const previousIds = useRef<readonly string[]>([])
  const hasBeenRead = useEffectEvent((id: string) =>
    read?.api === authenticatedApi && read.listings[id]?.status === 'ready')

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    const latest = new Map<string, number>()
    const load = async (id: string) => {
      const request = (latest.get(id) ?? 0) + 1
      latest.set(id, request)
      // Not awaited: the read is pipelined on the open, a refused open rejects it with the
      // refusal, and disposing the promise disposes the space it resolves to.
      const space = authenticatedApi.openSpace(id)
      let listing: SpaceListing
      try {
        listing = { status: 'ready', workspaces: await space.listWorkspaces() }
      } catch (err) {
        if (isNotAMemberError(err)) {
          listing = { status: 'refused' }
        } else {
          logRpcFailure('Failed to load a space’s workspaces:', err)
          listing = { status: 'failed' }
        }
      } finally {
        space[Symbol.dispose]()
      }
      if (cancelled || latest.get(id) !== request) return
      setRead(previous => ({
        api: authenticatedApi,
        listings: {
          ...(previous?.api === authenticatedApi ? previous.listings : NO_LISTINGS),
          [id]: listing,
        },
      }))
    }
    reloadRef.current = load
    const stayed = new Set(previousIds.current)
    previousIds.current = JSON.parse(serializedIds) as string[]
    for (const id of previousIds.current) {
      if (!(stayed.has(id) && hasBeenRead(id))) void load(id)
    }
    return () => {
      cancelled = true
      reloadRef.current = null
    }
  }, [authenticatedApi, enabled, serializedIds])

  return {
    listings: read?.api === authenticatedApi ? read.listings : NO_LISTINGS,
    reload: id => reloadRef.current?.(id) ?? Promise.resolve(),
  }
}
