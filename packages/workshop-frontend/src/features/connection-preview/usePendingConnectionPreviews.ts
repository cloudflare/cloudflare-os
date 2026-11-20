import { useEffect, useReducer, useRef, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { Overseer, WorkpieceId } from '@gadgets/workshop-shared/api'
import { useActions } from '../../useActions'
import {
  previewKey, previewOf, type ConnectionPreview, type OffersPreview, type PreviewOffer,
} from './connectionPreview'

/** The previews of what has changes waiting, oldest change first: one for each connection, or each item of one. */
export const usePendingConnectionPreviews = (
  overseer: RpcStub<Overseer> | null, offersPreview: OffersPreview,
): ConnectionPreview[] => {
  const { pending } = useActions(overseer)
  const waiting = new Map<string, ConnectionPreview>()
  // The connections whose resource is yet to be created: each is asked again once it is.
  const drafts = new Set<WorkpieceId>()
  for (const entry of pending) {
    if (entry.type !== 'action' || entry.gatekeeperId === undefined) continue
    if (entry.creation) drafts.add(entry.gatekeeperId)
    const preview = previewOf(entry.gatekeeperId, entry)
    if (!waiting.has(previewKey(preview))) waiting.set(previewKey(preview), preview)
  }

  // Kept with what gave them: another workspace numbers its connections from one again.
  const [offered, setOffered] = useState<{ by?: OffersPreview, offers: ReadonlyMap<string, PreviewOffer> }>(
    { offers: new Map() })
  const failures = useRef(0)
  const [retried, retry] = useReducer((count: number) => count + 1, 0)
  // Only a connection is asked: a change that names an item is itself the offer of that item's preview.
  const asked = [...waiting].filter(([, { item }]) => item === undefined)
  const keys = asked.map(([key, { gatekeeperId }]) => `${key} ${drafts.has(gatekeeperId)}`).join('\n')
  useEffect(() => {
    if (!overseer || !keys) return
    let stale = false
    let timer: number | undefined
    void Promise.allSettled(asked.map(([, preview]) => offersPreview(overseer, preview))).then(answers => {
      if (stale) return
      setOffered({
        by: offersPreview,
        offers: new Map(asked.flatMap(([key], index) => {
          const answer = answers[index]
          return answer.status === 'fulfilled' && answer.value ? [[key, answer.value]] : []
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
    // `keys` names everything `asked` holds that the offers depend on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overseer, keys, offersPreview, retried])

  const offers = offered.by === offersPreview ? offered.offers : undefined
  return [...waiting].flatMap(([key, preview]) => {
    const offer = preview.item === undefined ? offers?.get(key) : {}
    return offer ? [{ ...preview, ...offer }] : []
  })
}
