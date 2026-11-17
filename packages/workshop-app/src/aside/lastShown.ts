import { isRecord, stored } from '@/prefs/stored'
import { validateAsideParam } from './asideItems'

// Remembered for this many pages, the most recently shown last.
const LIMIT = 100

const store = stored<Record<string, string>>(
  'workshop-app:aside-last-shown',
  (value) => (isRecord(value) ? Object.fromEntries(Object.entries(value).filter(([, open]) => validateAsideParam(open) === open)) as Record<string, string> : undefined),
  {},
)

// A chat's page, or with no chat, its workspace's own.
const keyOf = (workspaceId: string, chatId: number | undefined) => (chatId === undefined ? workspaceId : `${workspaceId}/${chatId}`)

/** What was last shown beside a chat, or beside its workspace's page, in this browser, as its `?open=` value, if anything. */
export const lastShown = (workspaceId: string, chatId: number | undefined): string | undefined => store.read()[keyOf(workspaceId, chatId)]

/** Remembers what is shown beside a chat or a workspace's page, for the next time it is opened or the aside is had back. */
export const rememberShown = (workspaceId: string, chatId: number | undefined, open: string) => {
  const key = keyOf(workspaceId, chatId)
  const entries = Object.entries(store.read()).filter(([candidate]) => candidate !== key)
  store.write(Object.fromEntries([...entries, [key, open]].slice(-LIMIT)))
}
