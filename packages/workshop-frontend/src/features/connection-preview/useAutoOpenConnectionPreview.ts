import { useCallback, useEffect, useRef } from 'react'
import type { RpcStub } from 'capnweb'
import type { Overseer, WorkpieceId } from '@gadgets/workshop-shared/api'
import { useActionEntries } from '../../useActions'
import { offersPreview, previewOf, type ConnectionPreview } from './connectionPreview'

/**
 * Opens a connection's preview when work on it starts: at the first read or change of a
 * connection that offers one, and at each change queued after that. Work from before the
 * workspace was opened does not count, and a connection whose preview was dismissed stays closed.
 *
 * Returns the function that dismisses a connection.
 */
export const useAutoOpenConnectionPreview = (
  overseer: RpcStub<Overseer> | null,
  onOpen: (preview: ConnectionPreview) => void,
) => {
  const onOpenRef = useRef(onOpen)
  onOpenRef.current = onOpen
  const live = useRef(false)
  const entries = useRef(new Set<number>())
  const started = useRef(new Set<WorkpieceId>())
  const dismissed = useRef(new Set<WorkpieceId>())

  useActionEntries(overseer, entry => {
    // Subscribing replays what this session already received, which is not new work.
    if (!live.current || !overseer) return
    const { gatekeeperId } = entry
    if (gatekeeperId === undefined || dismissed.current.has(gatekeeperId)) return
    // An entry is delivered again when it changes, and a change resolved is not one queued.
    if (entries.current.has(entry.id)) return
    entries.current.add(entry.id)
    const queued = entry.type === 'action' && entry.state === 'pending'
    // The preview's own reads are logged on its connection, so only the first read opens it.
    if (!queued && (entry.type !== 'observation' || started.current.has(gatekeeperId))) return
    started.current.add(gatekeeperId)

    void offersPreview(overseer, gatekeeperId).then(offered => {
      if (offered && !dismissed.current.has(gatekeeperId)) {
        onOpenRef.current(previewOf({ ...entry, gatekeeperId }))
      }
    })
  })
  // After useActionEntries, so its replay has run by the time this is set.
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])

  return useCallback((gatekeeperId: WorkpieceId) => {
    dismissed.current.add(gatekeeperId)
  }, [])
}
