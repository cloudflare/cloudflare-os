import { useEffect, useState } from 'react'
import type { SpaceInfo } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../AuthContext'
import { useUiFeatureFlag } from '../../FeatureFlagsContext'
import { logRpcFailure } from '../../rpcErrors'
import { isNotAMemberError } from './spaceErrors'

const NO_ANCESTORS: SpaceInfo[] = []

/**
 * The spaces a space is inside, as far up as the signed-in user can open them, outermost
 * first. `parent` is `SpaceInfo.parent` of the space: the server tells it only to a user who
 * holds a role in that parent, and with none there is nothing above to show and nothing is
 * asked.
 *
 * Each ancestor is opened to read its info, which names the next one up, and released as soon
 * as it has answered. The walk ends at an ancestor whose info names no parent, at the first
 * the server refuses or that cannot be read, and at an id it has already met. Nothing is shown
 * of a walk until it has ended, so the trail does not grow under the reader. A session's walk
 * replaces the one before it; until it ends, what the session before found stays.
 *
 * Like `useSpaces`, the hook asks a session for nothing before that session's own flags say
 * the `spaces` flag is on.
 */
export const useSpaceAncestors = (parent: string | undefined): SpaceInfo[] => {
  const { authenticatedApi } = useAuthenticatedApi()
  const { enabled } = useUiFeatureFlag('spaces')
  // The walk that last ended, with the parent it began at: a walk begun at another is not this
  // space's.
  const [walk, setWalk] = useState<{ parent: string; ancestors: SpaceInfo[] } | null>(null)

  useEffect(() => {
    if (!enabled || parent === undefined) return
    let cancelled = false
    void (async () => {
      // Nearest first, as the walk meets them.
      const found: SpaceInfo[] = []
      const met = new Set<string>()
      let next: string | undefined = parent
      while (next !== undefined && !met.has(next)) {
        met.add(next)
        // Not awaited: the read is pipelined on the open, a refused open rejects it with the
        // refusal, and disposing the promise disposes the space it resolves to.
        const space = authenticatedApi.openSpace(next)
        try {
          const info = await space.getInfo()
          found.push(info)
          next = info.parent
        } catch (err) {
          // A refusal is the answer for a space the user holds no role in: the way up ends
          // below it, and nothing is wrong.
          if (!isNotAMemberError(err)) logRpcFailure('Failed to load a space above this one:', err)
          break
        } finally {
          space[Symbol.dispose]()
        }
        if (cancelled) return
      }
      if (!cancelled) setWalk({ parent, ancestors: found.toReversed() })
    })()
    return () => { cancelled = true }
  }, [authenticatedApi, enabled, parent])

  return walk !== null && walk.parent === parent ? walk.ancestors : NO_ANCESTORS
}
