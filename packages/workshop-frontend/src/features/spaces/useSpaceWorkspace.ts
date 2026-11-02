import { useEffect, useState } from 'react'
import { isValidSpaceKey, type SpaceWorkspaceResolution } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../AuthContext'
import { useUiFeatureFlag } from '../../FeatureFlagsContext'
import { logRpcFailure } from '../../rpcErrors'
import { isNotAMemberError } from './spaceErrors'

/**
 * What a workspace's address, /spaces/<spaceKey>/<slug>, leads to for the signed-in user.
 *
 * - `loading`: not known yet.
 * - `ready`: the workspace the slug addresses, and whether the slug is its current one. For a
 *   user who is not a member of the space, only a published workspace is there (see `Space`).
 * - `not-found`: nothing is there for this user. The `spaces` flag is off, the key is malformed,
 *   the space refused them (which is also its answer for a key no space has claimed), or no
 *   workspace the space lists has or had the slug.
 * - `failed`: the space could not be asked; `retry` asks again.
 */
export type SpaceWorkspaceState =
  | { status: 'loading' | 'not-found' | 'failed' }
  | ({ status: 'ready' } & SpaceWorkspaceResolution)

const LOADING: SpaceWorkspaceState = { status: 'loading' }
const NOT_FOUND: SpaceWorkspaceState = { status: 'not-found' }

/**
 * Resolves a slug in a space (`Space.resolveWorkspace`). Resolving authorizes nothing of its own:
 * the workspace it finds opens for the user as any that the space lists does.
 *
 * The workspace an address led to stays the answer for as long as the route is at that address.
 * A session that replaces another (a reconnect) is not asked about it again: an editor open at
 * the address goes on by the workspace's id, as one at /workspace/<id> does, and is not taken
 * down because the workspace has since left the space's listing or changed its address there.
 * An address that led nowhere, or could not be asked about, is asked about again.
 *
 * Like `useSpaces`, the hook asks a session for nothing before that session's own flags say the
 * `spaces` flag is on.
 */
export const useSpaceWorkspace = (spaceKey: string, slug: string): {
  state: SpaceWorkspaceState
  /** Asks again after a `failed` answer. */
  retry: () => void
} => {
  const { authenticatedApi } = useAuthenticatedApi()
  const flag = useUiFeatureFlag('spaces')
  const [attempt, setAttempt] = useState(0)
  const [answer, setAnswer] = useState<{
    spaceKey: string
    slug: string
    attempt: number
    state: SpaceWorkspaceState
  } | null>(null)
  const known = answer?.spaceKey === spaceKey && answer.slug === slug && answer.attempt === attempt
    ? answer.state
    : null
  const askable = flag.enabled && isValidSpaceKey(spaceKey) && known?.status !== 'ready'

  useEffect(() => {
    if (!askable) return
    let cancelled = false
    const resolve = async () => {
      // Not awaited: the call is pipelined on the open, a refused open rejects it with the
      // refusal, and disposing the promise disposes the space it resolves to.
      const space = authenticatedApi.openSpace(spaceKey)
      let state: SpaceWorkspaceState
      try {
        const resolution = await space.resolveWorkspace(slug)
        state = resolution ? { status: 'ready', ...resolution } : NOT_FOUND
      } catch (err) {
        if (isNotAMemberError(err)) {
          state = NOT_FOUND
        } else {
          logRpcFailure('Failed to resolve a workspace’s address:', err)
          state = { status: 'failed' }
        }
      } finally {
        space[Symbol.dispose]()
      }
      if (!cancelled) setAnswer({ spaceKey, slug, attempt, state })
    }
    void resolve()
    return () => { cancelled = true }
  }, [authenticatedApi, askable, spaceKey, slug, attempt])

  const flagOff = !flag.loading && !flag.enabled
  return {
    state: flagOff || !isValidSpaceKey(spaceKey) ? NOT_FOUND : known ?? LOADING,
    retry: () => setAttempt(current => current + 1),
  }
}
