import { MAX_ASIDE_SHOWN, MAX_PREFERENCE_LENGTH, type AppPreferences as Preferences } from '@/prefs/preferenceFields'
import type { UserPreferences } from '@/prefs/UserPreferences'
import { validateAsideParam } from './asideItems'

// A chat's page, or with no chat, its workspace's own.
const keyOf = (workspaceId: string, chatId: number | undefined) => (chatId === undefined ? workspaceId : `${workspaceId}/${chatId}`)

/**
 * What was last shown beside a chat, or beside its workspace's page, as its `?open=` value, if
 * anything. Kept in the user's account, so it follows them to another browser.
 */
export const lastShown = ({ asideShown }: Preferences, workspaceId: string, chatId: number | undefined): string | undefined => {
  const open = asideShown[keyOf(workspaceId, chatId)]
  // One kept by another version of the app may be what this one cannot show.
  return open !== undefined && validateAsideParam(open) === open ? open : undefined
}

/**
 * Remembers what is shown beside a chat or a workspace's page, for the next time it is opened or
 * the aside is had back: for the latest MAX_ASIDE_SHOWN pages. One already remembered is not sent
 * again, and one too long to keep is not kept.
 */
export const rememberShown = (preferences: UserPreferences, workspaceId: string, chatId: number | undefined, open: string) => {
  const key = keyOf(workspaceId, chatId)
  if (preferences.getSnapshot().asideShown[key] === open || key.length > MAX_PREFERENCE_LENGTH || open.length > MAX_PREFERENCE_LENGTH) return
  preferences.change(({ asideShown }) => {
    const entries = Object.entries(asideShown).filter(([candidate]) => candidate !== key)
    return { asideShown: Object.fromEntries([...entries, [key, open]].slice(-MAX_ASIDE_SHOWN)) }
  })
}
