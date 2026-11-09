import { useEffect, useEffectEvent, useRef, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, Space } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../AuthContext'
import { useUiFeatureFlag } from '../../FeatureFlagsContext'
import { logRpcFailure } from '../../rpcErrors'
import { isNotAMemberError } from './spaceErrors'

/**
 * How far one read of a space got, for the signed-in user.
 *
 * - `loading`: not read yet.
 * - `ready`: what was read, as last read.
 * - `refused`: the space does not count the user as a member.
 * - `failed`: it could not be read for another reason; `reload` reads it again.
 */
export type SpaceRead<T extends object> =
  | { status: 'loading' | 'refused' | 'failed' }
  | ({ status: 'ready' } & T)

/** Each space's read by space id. A space with no entry has not been read yet. */
export type SpaceReads<T extends object> = Readonly<Record<string, SpaceRead<T>>>

const NO_READS: SpaceReads<never> = {}

// What the hook is reading for one session, while the flag is on.
type Reading = {
  /** The ids last read for. A space that left the set and is back is read again. */
  ids: readonly string[]
  /** The number of each space's newest read, which is the one whose answer counts. */
  latest: Map<string, number>
  /** The spaces whose newest read is under way. */
  pending: Set<string>
}

/**
 * Reads something of each of these spaces when the component mounts. When the set of ids
 * changes, the spaces that joined it are read, and so are those whose read did not work; a space
 * that stays in the set with its read done is not asked again, since every read opens the space.
 * A read under way stays the space's read while the space stays in the set, so a set that grows
 * opens no space twice; the read of a space that has left the set is dropped. Every space is
 * read on its own, so one that fails or refuses leaves the others as they are. What was read
 * stays in place while it is read again.
 *
 * Like `useSpaces`, the hook asks a session for nothing before that session's own flags say the
 * `spaces` flag is on: the ids it is given may be the ones a session before it listed.
 *
 * `read` is given the space, opened for that one read. It is a dependency of the hook's effect,
 * so pass a function declared outside the component.
 */
export const useSpaceReads = <T extends object>(
  ids: readonly string[],
  read: (space: RpcStub<Space>) => Promise<T>,
  /** What a failed read is logged as, for example `Failed to load a space’s workspaces:`. */
  failureLog: string,
): {
  reads: SpaceReads<T>
  /** Reads one space again, resolving once the read has settled. */
  reload: (id: string) => Promise<void>
} => {
  const { authenticatedApi } = useAuthenticatedApi()
  const { enabled } = useUiFeatureFlag('spaces')
  const [answered, setAnswered] = useState<{
    api: RpcStub<AuthenticatedApi>
    reads: SpaceReads<T>
  } | null>(null)
  const reads = answered?.api === authenticatedApi ? answered.reads : NO_READS
  const reloadRef = useRef<((id: string) => Promise<void>) | null>(null)
  const readingRef = useRef<Reading | null>(null)
  // One string, so the effect follows the set of spaces and not the identity of the array. It
  // is JSON because an id is whatever names the space to the caller, a page's route parameter
  // included, and may hold any character.
  const serializedIds = JSON.stringify(ids)
  const hasBeenRead = useEffectEvent((id: string) => reads[id]?.status === 'ready')

  useEffect(() => {
    if (!enabled) return
    const reading: Reading = (readingRef.current ??= { ids: [], latest: new Map(), pending: new Set() })
    const load = async (id: string) => {
      const request = (reading.latest.get(id) ?? 0) + 1
      reading.latest.set(id, request)
      reading.pending.add(id)
      // Not awaited: the read is pipelined on the open, a refused open rejects it with the
      // refusal, and disposing the promise disposes the space it resolves to.
      const space = authenticatedApi.openSpace(id)
      let result: SpaceRead<T>
      try {
        result = { status: 'ready', ...(await read(space)) }
      } catch (err) {
        if (isNotAMemberError(err)) {
          result = { status: 'refused' }
        } else {
          logRpcFailure(failureLog, err)
          result = { status: 'failed' }
        }
      } finally {
        space[Symbol.dispose]()
      }
      if (reading.latest.get(id) !== request) return
      reading.pending.delete(id)
      if (readingRef.current !== reading || !reading.ids.includes(id)) return
      setAnswered(previous => ({
        api: authenticatedApi,
        reads: {
          ...(previous?.api === authenticatedApi ? previous.reads : NO_READS),
          [id]: result,
        },
      }))
    }
    reloadRef.current = load
    const stayed = new Set(reading.ids)
    reading.ids = JSON.parse(serializedIds) as string[]
    for (const id of reading.ids) {
      if (!(stayed.has(id) && (hasBeenRead(id) || reading.pending.has(id)))) void load(id)
    }
    return () => {
      reloadRef.current = null
    }
  }, [authenticatedApi, enabled, read, failureLog, serializedIds])

  // What is being read is for one session, with the flag on: when either changes, and when the
  // component unmounts, every read under way is dropped.
  useEffect(() => () => {
    readingRef.current = null
  }, [authenticatedApi, enabled])

  return {
    reads,
    reload: id => reloadRef.current?.(id) ?? Promise.resolve(),
  }
}
