import { useSyncExternalStore } from 'react'
import type { WorkspaceLook } from '@/components/workspaceLook'
import { useLooksStore } from './WorkspacesContext'
import type { WorkspaceLooksById } from './WorkspaceLooks'

/** How each workspace's icon is drawn on this device, by the workspace's id (`WorkspaceLooks`). */
export const useWorkspaceLooks = (): WorkspaceLooksById => {
  const store = useLooksStore()
  return useSyncExternalStore(store.subscribe, store.snapshot)
}

/** Has a workspace's icon drawn another way, wherever it is drawn. */
export const useSetWorkspaceLook = (): ((id: string, look: WorkspaceLook) => void) => {
  const store = useLooksStore()
  return (id, look) => store.set(id, look)
}
