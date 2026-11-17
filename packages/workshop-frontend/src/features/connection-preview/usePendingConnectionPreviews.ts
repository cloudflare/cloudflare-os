import { useEffect, useState } from 'react'
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
  for (const entry of pending) {
    const { gatekeeperId } = entry
    if (entry.type === 'action' && gatekeeperId !== undefined && !waiting.has(gatekeeperId)) {
      waiting.set(gatekeeperId, previewOf(gatekeeperId, entry))
    }
  }

  // Kept with what gave them: another workspace numbers its connections from one again.
  const [offered, setOffered] = useState<{ by?: OffersPreview, offers: ReadonlyMap<WorkpieceId, PreviewOffer> }>(
    { offers: new Map() })
  const [attempt, setAttempt] = useState(0)
  const ids = [...waiting.keys()].join()
  useEffect(() => {
    if (!overseer || !ids) return
    let stale = false
    let retry: number | undefined
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
      // less often each time.
      if (answers.some(({ status }) => status === 'rejected')) {
        retry = window.setTimeout(() => setAttempt(attempt + 1), Math.min(60_000, 2_000 * 2 ** attempt))
      }
    })
    return () => {
      stale = true
      window.clearTimeout(retry)
    }
  }, [overseer, ids, offersPreview, attempt])

  const offers = offered.by === offersPreview ? offered.offers : undefined
  return [...waiting.values()].flatMap(preview => {
    const offer = offers?.get(preview.gatekeeperId)
    return offer ? [{ ...preview, ...offer }] : []
  })
}
