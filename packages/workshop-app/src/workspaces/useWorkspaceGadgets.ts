import { useEffect, useMemo } from 'react'
import { workspaceAsideItems, type AsideItem } from '@/aside/asideItems'
import { useLibrary } from '@/library/useLibrary'

// What each workspace had made when last read, for the visit: shown again while it is read again.
const lastRead = new Map<string, AsideItem[]>()

/**
 * What one workspace has made, from the library (`workspaceAsideItems`), most recent first: read
 * once for each workspace it is given, and shown as last read meanwhile. Nothing until first read.
 */
export const useWorkspaceGadgets = (workspaceId: string): AsideItem[] | undefined => {
  const library = useLibrary(workspaceId)
  const outputs = library.status === 'ready' ? library.outputs : undefined
  const items = useMemo(() => (outputs === undefined ? undefined : workspaceAsideItems(workspaceId, undefined, outputs, [])), [workspaceId, outputs])
  useEffect(() => {
    if (items !== undefined) lastRead.set(workspaceId, items)
  }, [workspaceId, items])
  return items ?? lastRead.get(workspaceId)
}
