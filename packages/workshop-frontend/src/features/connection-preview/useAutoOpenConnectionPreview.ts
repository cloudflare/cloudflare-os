import { useCallback, useRef } from 'react'
import type { RpcStub } from 'capnweb'
import type { Overseer, WorkpieceId } from '@gadgets/workshop-shared/api'
import { previewOf, type ConnectionPreview, type OffersPreview } from './connectionPreview'
import { useNewActionEntries } from './useNewActionEntries'

/**
 * Opens a connection's preview when work on it starts: at the first read or change of a
 * connection that offers one, and at each change queued after that. Work from before the
 * workspace was opened does not count, and a connection whose preview was dismissed stays closed.
 * Connections and log entries are numbered within a workspace, so another workspace starts afresh.
 *
 * Returns the function that dismisses a connection.
 */
export const useAutoOpenConnectionPreview = (
  overseer: RpcStub<Overseer> | null,
  workspaceId: string | undefined,
  onOpen: (preview: ConnectionPreview) => void,
  offersPreview: OffersPreview,
) => {
  const onOpenRef = useRef(onOpen)
  onOpenRef.current = onOpen
  const seen = useRef(seenIn(workspaceId))
  if (seen.current.workspaceId !== workspaceId) seen.current = seenIn(workspaceId)

  useNewActionEntries(overseer, entry => {
    if (!overseer) return
    const here = seen.current
    const { entries, started, dismissed } = here
    const { gatekeeperId } = entry
    if (gatekeeperId === undefined || dismissed.has(gatekeeperId)) return
    // An entry is delivered again when it changes, and a change resolved is not one queued.
    if (entries.has(entry.id)) return
    entries.add(entry.id)
    const queued = entry.type === 'action' && entry.state === 'pending'
    // The preview's own reads are logged on its connection, so only the first read opens it.
    if (!queued && (entry.type !== 'observation' || started.has(gatekeeperId))) return
    started.add(gatekeeperId)

    void offersPreview(overseer, gatekeeperId).then(offered => {
      if (offered && here === seen.current && !dismissed.has(gatekeeperId)) {
        onOpenRef.current(previewOf(gatekeeperId, entry))
      }
      // Not an answer: the connection's next read asks again.
    }, () => started.delete(gatekeeperId))
  })
  return useCallback((gatekeeperId: WorkpieceId) => {
    seen.current.dismissed.add(gatekeeperId)
  }, [])
}

const seenIn = (workspaceId: string | undefined) => ({
  workspaceId,
  entries: new Set<number>(),
  started: new Set<WorkpieceId>(),
  dismissed: new Set<WorkpieceId>(),
})
