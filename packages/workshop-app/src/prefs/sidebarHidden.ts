import { useSyncExternalStore } from 'react'
import { isRecord } from './stored'
import { watched } from './watched'

// By `workspaceId:chatId`, when the chat was last active as it was taken out of the sidebar.
const parse = (value: unknown): Record<string, number> | undefined =>
  isRecord(value) && Object.values(value).every((at) => typeof at === 'number') ? (value as Record<string, number>) : undefined
const store = watched<Record<string, number>>('workshop-app:sidebar-hidden', parse, {})

// Kept, so that what is read is the same object until it changes.
let snapshot: ReadonlyMap<string, number> = new Map(Object.entries(store.read()))
store.subscribe(() => {
  snapshot = new Map(Object.entries(store.read()))
})

/** The chats taken out of the sidebar on this device, by key, at the time each was last active then. The server keeps no record of it. */
export const useSidebarHidden = (): ReadonlyMap<string, number> => useSyncExternalStore(store.subscribe, () => snapshot)

/** Takes a chat out of the sidebar, as it is now (`lastActive`), or puts it back with `undefined`. */
export const setSidebarHidden = (key: string, lastActive: number | undefined) => {
  const { [key]: _was, ...rest } = store.read()
  store.write(lastActive === undefined ? rest : { ...rest, [key]: lastActive })
}
