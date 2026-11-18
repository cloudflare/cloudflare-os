import { useCallback, useRef } from 'react'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import { previewKey, previewOf, type ConnectionPreview, type OffersPreview } from './connectionPreview'
import { useNewActionEntries } from './useNewActionEntries'

/**
 * Opens a connection's preview when work on it starts: at the first read or change of a
 * connection that offers one, and at each change queued after that. An item of a connection is
 * named only by a change to it, so its preview opens when one is queued. Work from before the
 * workspace was first opened does not count; work done while it was left, or while its connection
 * was lost, is delivered on the return and does. A preview that was dismissed stays closed.
 * Connections and log entries are numbered within a workspace, so another workspace starts afresh.
 *
 * Returns the function that dismisses a preview.
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
    if (gatekeeperId === undefined) return
    const preview = previewOf(gatekeeperId, entry)
    const key = previewKey(preview)
    // A draft discarded is gone with its connection: a preview still being asked for stays closed.
    if (entry.type === 'action' && entry.creation && entry.state === 'rejected') dismissed.add(key)
    if (dismissed.has(key)) return
    // An entry is delivered again when it changes, and a change resolved is not one queued.
    if (entries.has(entry.id)) return
    entries.add(entry.id)
    const queued = entry.type === 'action' && entry.state === 'pending'
    // The preview's own reads are logged on its connection, so only the first read opens it.
    if (!queued && (entry.type !== 'observation' || started.has(key))) return
    started.add(key)

    void offersPreview(overseer, preview).then(offered => {
      if (offered && here === seen.current && !dismissed.has(key)) {
        onOpenRef.current({ ...preview, ...offered })
      }
      // Not an answer: the connection's next read asks again.
    }, () => started.delete(key))
  })
  return useCallback((preview: Pick<ConnectionPreview, 'gatekeeperId' | 'item'>) => {
    seen.current.dismissed.add(previewKey(preview))
  }, [])
}

const seenIn = (workspaceId: string | undefined) => ({
  workspaceId,
  entries: new Set<number>(),
  started: new Set<string>(),
  dismissed: new Set<string>(),
})
