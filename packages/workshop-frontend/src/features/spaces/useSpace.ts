import { useEffect, useRef, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, Space, SpaceInfo, SpaceMemberInfo } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../AuthContext'
import { useUiFeatureFlag } from '../../FeatureFlagsContext'
import { logRpcFailure } from '../../rpcErrors'
import { isNotAMemberError } from './spaceErrors'

/**
 * One space as the signed-in user sees it.
 *
 * - `loading`: not read yet.
 * - `ready`: its info and members, as last read. For a member the info has their own role. For a
 *   visitor, someone who is not a member and to whom the space is open while it lists a
 *   published workspace (see `Space`), the info has no `role` and `members` is empty: the space
 *   does not show a visitor its members.
 * - `refused`: the space is not open to the user, who is not a member of it and for whom it
 *   lists nothing published (the server gives that one answer for a key no space has claimed
 *   too).
 * - `failed`: it could not be read for another reason; `refresh` opens it again.
 */
export type SpaceState =
  | { status: 'loading' | 'refused' | 'failed' }
  | { status: 'ready'; info: SpaceInfo; members: SpaceMemberInfo[] }

/** What `useSpace` returns. */
export type OpenSpace = {
  state: SpaceState
  /**
   * Reads the space again, resolving once the read has settled. After a read that did not end
   * `ready`, the space is opened again first.
   */
  refresh: () => Promise<void>
  /**
   * Runs `action` against the space and then reads the space again, whether or not the action
   * succeeded, so `state` shows what the action left behind: a refused action may mean the user
   * has been demoted or removed since the last read. Resolves or rejects as `action` does, once
   * that read has settled. The stub is lent for the action only and must not be kept.
   */
  change: <T>(action: (space: RpcStub<Space>) => Promise<T>) => Promise<T>
}

const LOADING: SpaceState = { status: 'loading' }
const NO_MEMBERS: SpaceMemberInfo[] = []

// The space's members, or null when it refuses them, as it does to a visitor.
const membersIfShown = async (space: RpcStub<Space>) => {
  try {
    return await space.listMembers()
  } catch (err) {
    if (isNotAMemberError(err)) return null
    throw err
  }
}

/**
 * Opens the space with this key for as long as the component is mounted with it, and reads its
 * info and members. The space is opened again, and the previous one disposed, when the key
 * changes. What the space lists is not read here (see `useSpaceListings`).
 *
 * A space re-checks the user's membership on every call, so a space that opened may start
 * refusing, or go on as a visitor's: every read here, including the one after a `change`, turns
 * the first into `refused` and the second into info with no `role`.
 *
 * Like `useSpaces`, the hook asks a session for nothing before that session's own flags say the
 * `spaces` flag is on. Until then the space is `loading` and not open.
 */
export const useSpace = (key: string): OpenSpace => {
  const { authenticatedApi } = useAuthenticatedApi()
  const { enabled } = useUiFeatureFlag('spaces')
  const [read, setRead] = useState<{
    key: string
    api: RpcStub<AuthenticatedApi>
    state: SpaceState
  } | null>(null)
  const sessionRef = useRef<Pick<OpenSpace, 'refresh' | 'change'> | null>(null)

  useEffect(() => {
    if (!enabled) return
    // Not awaited: the reads are pipelined on the promise, a refused open rejects them with the
    // refusal, and disposing the promise disposes the space it resolves to.
    let stub: RpcStub<Space> = authenticatedApi.openSpace(key)
    // The last read did not end `ready`, and the stub itself may be why: every call pipelined on
    // an open that failed fails with it, and so does every call on a space whose Durable Object
    // has reset since. No further read can tell, so the next one opens the space again.
    let stale = false
    let closed = false
    let latest = 0
    const load = async () => {
      if (closed) return
      const request = ++latest
      if (stale) {
        stub[Symbol.dispose]()
        stub = authenticatedApi.openSpace(key)
        stale = false
      }
      const space = stub
      let state: SpaceState
      try {
        const [info, members] = await Promise.all([space.getInfo(), membersIfShown(space)])
        state = members
          ? { status: 'ready', info, members }
          // Refused its members by a space that answered with its info, the user is a visitor,
          // whatever role that info, read a moment earlier, may still have had.
          : { status: 'ready', info: { ...info, role: undefined }, members: NO_MEMBERS }
      } catch (err) {
        if (isNotAMemberError(err)) {
          state = { status: 'refused' }
        } else {
          logRpcFailure('Failed to load space:', err)
          state = { status: 'failed' }
        }
      }
      if (closed || request !== latest) return
      stale = state.status !== 'ready'
      setRead({ key, api: authenticatedApi, state })
    }
    sessionRef.current = {
      refresh: load,
      change: async action => {
        try {
          return await action(stub)
        } finally {
          await load()
        }
      },
    }
    void load()
    return () => {
      closed = true
      sessionRef.current = null
      stub[Symbol.dispose]()
    }
  }, [authenticatedApi, enabled, key])

  return {
    state: read?.key === key && read.api === authenticatedApi ? read.state : LOADING,
    refresh: () => sessionRef.current?.refresh() ?? Promise.resolve(),
    change: async action => {
      const session = sessionRef.current
      if (!session) throw new Error('This space is not open.')
      return session.change(action)
    },
  }
}
