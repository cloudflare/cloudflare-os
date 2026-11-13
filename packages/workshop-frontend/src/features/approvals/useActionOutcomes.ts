import { useCallback, useRef } from 'react'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import { useActionEntries } from '../../useActions'

/** How a request someone resolved ended. */
export type ActionOutcome = 'approved' | 'rejected'

/**
 * How each request this view has watched get resolved ended, as soon as the workspace says so.
 *
 * The pending set says only that a request is gone, and says it late: it is a snapshot rebuilt
 * once per animation frame, which a background tab may not draw for as long as it stays hidden.
 * A bulk run needs both what this adds. It needs to know a request is gone the moment it is, or it
 * waits out the drain on one the drain has already taken and then reports the refusal as a
 * failure. And it needs to know which way it went: an apply carries on past an approval and stops
 * at a rejection, a discard the other way round.
 *
 * Read from the entry stream, which every resolution reaches synchronously, and which reaches a
 * refused call ahead of its refusal when both come over the same connection. Held in a ref:
 * nothing on screen reads it, so a render per resolution would buy no change.
 */
export function useActionOutcomes(
  overseer: RpcStub<Overseer> | null,
): (id: number) => ActionOutcome | undefined {
  const outcomes = useRef(new Map<number, ActionOutcome>())
  useActionEntries(overseer, record => {
    if (record.type === 'action' && record.state !== 'pending') {
      outcomes.current.set(record.id, record.state)
    }
  })
  return useCallback((id: number) => outcomes.current.get(id), [])
}
