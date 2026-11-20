import { useEffect, useReducer, useRef, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { Overseer, WorkpieceId } from '@gadgets/workshop-shared/api'
import { useActions } from '../../useActions'
import {
  previewOf, type ConnectionPreview, type OffersPreview, type PreviewOffer,
} from './connectionPreview'

/** The previews of the connections that have changes waiting, oldest change first. */
export const usePendingConnectionPreviews = (
  overseer: RpcStub<Overseer> | null, offersPreview: OffersPreview,
): ConnectionPreview[] => {
  const { pending } = useActions(overseer)
  const waiting = new Map<WorkpieceId, ConnectionPreview>()
  // The connections whose resource is yet to be created: each is asked again once it is.
  const drafts = new Set<WorkpieceId>()
  for (const entry of pending) {
    const { gatekeeperId } = entry
    if (entry.type !== 'action' || gatekeeperId === undefined) continue
    if (entry.creation) drafts.add(gatekeeperId)
    if (!waiting.has(gatekeeperId)) waiting.set(gatekeeperId, previewOf(gatekeeperId, entry))
  }

  // Kept with what gave them: another workspace numbers its connections from one again.
  const [offered, setOffered] = useState<{ by?: OffersPreview, offers: ReadonlyMap<WorkpieceId, PreviewOffer> }>(
    { offers: new Map() })
  const failures = useRef(0)
  const [retried, retry] = useReducer((count: number) => count + 1, 0)
  const ids = [...waiting.keys()].join()
  const drafted = [...drafts].join()
  useEffect(() => {
    if (!overseer || !ids) return
    let stale = false
    let timer: number | undefined
    const asked = ids.split(',').map(Number)
    void Promise.allSettled(asked.map(id => offersPreview(overseer, id))).then(answers => {
      if (stale) return
      setOffered({
        by: offersPreview,
        offers: new Map(asked.flatMap((id, index) => {
          const answer = answers[index]
          return answer.status === 'fulfilled' && answer.value ? [[id, answer.value]] : []
        })),
      })
      // A connection that could not be asked still has changes waiting, so it is asked again,
      // less often each time, until every one has answered.
      failures.current = answers.some(({ status }) => status === 'rejected') ? failures.current + 1 : 0
      if (failures.current) timer = window.setTimeout(retry, Math.min(60_000, 1_000 * 2 ** failures.current))
    })
    return () => {
      stale = true
      window.clearTimeout(timer)
    }
    // `drafted` is not read: a connection whose resource was created has a new answer to give.
  }, [overseer, ids, drafted, offersPreview, retried])

  const offers = offered.by === offersPreview ? offered.offers : undefined
  return [...waiting.values()].flatMap(preview => {
    const offer = offers?.get(preview.gatekeeperId)
    return offer ? [{ ...preview, ...offer }] : []
  })
}
