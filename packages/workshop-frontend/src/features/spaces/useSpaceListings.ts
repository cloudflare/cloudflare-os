import { useEffect, useRef, useState } from 'react'
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

/** Each space's listing by space key. A space with no entry has not been read yet. */
export type SpaceListings = Readonly<Record<string, SpaceListing>>

const NO_LISTINGS: SpaceListings = {}

/**
 * Reads what each of these spaces lists, when the component mounts and whenever the set of keys
 * changes. Every space is read on its own, so one that fails or refuses leaves the others as
 * they are. A listing already read stays in place while it is read again.
 *
 * Like `useSpaces`, the hook asks a session for nothing before that session's own flags say the
 * `spaces` flag is on: the keys it is given may be the ones a session before it listed.
 */
export const useSpaceListings = (keys: readonly string[]): {
  listings: SpaceListings
  /** Reads one space's listing again, resolving once the read has settled. */
  reload: (key: string) => Promise<void>
} => {
  const { authenticatedApi } = useAuthenticatedApi()
  const { enabled } = useUiFeatureFlag('spaces')
  const [read, setRead] = useState<{
    api: RpcStub<AuthenticatedApi>
    listings: SpaceListings
  } | null>(null)
  const reloadRef = useRef<((key: string) => Promise<void>) | null>(null)
  // One string, so the effect follows the set of spaces and not the identity of the array. No
  // space key contains a space.
  const joinedKeys = keys.join(' ')

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    const latest = new Map<string, number>()
    const load = async (key: string) => {
      const request = (latest.get(key) ?? 0) + 1
      latest.set(key, request)
      // Not awaited: the read is pipelined on the open, a refused open rejects it with the
      // refusal, and disposing the promise disposes the space it resolves to.
      const space = authenticatedApi.openSpace(key)
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
      if (cancelled || latest.get(key) !== request) return
      setRead(previous => ({
        api: authenticatedApi,
        listings: {
          ...(previous?.api === authenticatedApi ? previous.listings : NO_LISTINGS),
          [key]: listing,
        },
      }))
    }
    reloadRef.current = load
    if (joinedKeys !== '') {
      for (const key of joinedKeys.split(' ')) void load(key)
    }
    return () => {
      cancelled = true
      reloadRef.current = null
    }
  }, [authenticatedApi, enabled, joinedKeys])

  return {
    listings: read?.api === authenticatedApi ? read.listings : NO_LISTINGS,
    reload: key => reloadRef.current?.(key) ?? Promise.resolve(),
  }
}
