import { isRecord, stored } from '@/prefs/stored'
import { validateAsideParam } from './asideItems'

// Remembered for this many chats, the most recently shown last.
const LIMIT = 100

const store = stored<Record<string, string>>(
  'workshop-app:aside-last-shown',
  (value) => (isRecord(value) ? Object.fromEntries(Object.entries(value).filter(([, open]) => validateAsideParam(open) === open)) as Record<string, string> : undefined),
  {},
)

const keyOf = (workspaceId: string, chatId: number) => `${workspaceId}/${chatId}`

/** What was last shown beside a chat in this browser, as its `?open=` value, if anything. */
export const lastShown = (workspaceId: string, chatId: number): string | undefined => store.read()[keyOf(workspaceId, chatId)]

/** Remembers what is shown beside a chat, for the next time it is opened or the aside is had back. */
export const rememberShown = (workspaceId: string, chatId: number, open: string) => {
  const key = keyOf(workspaceId, chatId)
  const entries = Object.entries(store.read()).filter(([candidate]) => candidate !== key)
  store.write(Object.fromEntries([...entries, [key, open]].slice(-LIMIT)))
}
