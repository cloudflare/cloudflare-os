import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { WorkspaceMetadataWithTimestamps } from '@gadgets/workshop-shared/api'
import type { WorkspaceRemoval } from '@/blocks/WorkspaceMoreMenu'
import { useApi } from '@/rpc/ApiContext'
import { WorkspacesFeed } from './WorkspacesFeed'
import { WorkspacesContext } from './WorkspacesContext'
import { removeWorkspace } from './workspaceRemoval'

/**
 * Keeps the user's workspaces live for everything beneath it (`subscribeToWorkspaces()`): one
 * subscription for the whole app, made again on each new connection, with the list kept shown
 * meanwhile. A change made here shows at once and is undone if the server refuses it.
 */
export const WorkspacesProvider = ({ children }: { children: ReactNode }) => {
  const { api, reconnecting } = useApi()
  const [list] = useState(() => new WorkspacesFeed())
  const state = useSyncExternalStore(list.subscribe, list.getSnapshot)
  useEffect(() => {
    // Over a lost connection it could only fail; the new connection's `api` subscribes.
    if (reconnecting) return
    list.start({ subscribe: (listener) => api.subscribeToWorkspaces(listener) })
    return () => list.stop()
  }, [api, reconnecting, list])

  // Shows `change` at once, and puts back what it replaced if `send` fails.
  const optimistic = async (id: string, change: Partial<WorkspaceMetadataWithTimestamps>, send: () => Promise<void>) => {
    const current = list.getSnapshot()
    const row = current.status === 'ready' ? current.workspaces.find((workspace) => workspace.id === id) : undefined
    const before = Object.fromEntries(Object.keys(change).map((key) => [key, row?.[key as keyof typeof change]]))
    list.mark(id, change)
    try {
      await send()
    } catch (error) {
      list.mark(id, before)
      throw error
    }
  }
  const setPinned = (id: string, pinned: boolean) => optimistic(id, { pinned }, () => api.setWorkspacePinned(id, pinned))
  const rename = (id: string, title: string) =>
    optimistic(id, { title }, async () => {
      const overseer = api.openWorkspace(id)
      try {
        await overseer.setTitle(title)
      } finally {
        overseer[Symbol.dispose]()
      }
    })
  const setMuted = (id: string, muted: boolean) =>
    optimistic(id, { notificationMute: muted ? { indefinite: true } : undefined }, () =>
      api.setWorkspaceNotificationMute(id, muted ? { indefinite: true } : null))
  const remove = (id: string, removal: WorkspaceRemoval) => removeWorkspace(api, id, removal)

  return <WorkspacesContext value={{ state, setPinned, rename, setMuted, remove, update: list.live }}>{children}</WorkspacesContext>
}
