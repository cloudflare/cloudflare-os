import { useEffect, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { Overseer, WorkpieceId } from '@gadgets/workshop-shared/api'
import { useActions } from '../../useActions'
import { offersPreview, previewOf, type ConnectionPreview } from './connectionPreview'

/** The previews of the connections that have changes waiting, oldest change first. */
export const usePendingConnectionPreviews = (overseer: RpcStub<Overseer> | null): ConnectionPreview[] => {
  const { pending } = useActions(overseer)
  const waiting = new Map<WorkpieceId, ConnectionPreview>()
  for (const entry of pending) {
    const { gatekeeperId } = entry
    if (entry.type === 'action' && gatekeeperId !== undefined && !waiting.has(gatekeeperId)) {
      waiting.set(gatekeeperId, previewOf({ ...entry, gatekeeperId }))
    }
  }

  const [offered, setOffered] = useState<ReadonlySet<WorkpieceId>>(new Set())
  const ids = [...waiting.keys()].join()
  useEffect(() => {
    if (!overseer || !ids) return
    let stale = false
    const asked = ids.split(',').map(Number)
    void Promise.all(asked.map(id => offersPreview(overseer, id))).then(answers => {
      if (!stale) setOffered(new Set(asked.filter((_, index) => answers[index])))
    })
    return () => {
      stale = true
    }
  }, [overseer, ids])

  return [...waiting.values()].filter(preview => offered.has(preview.gatekeeperId))
}
