import { MAX_STARRED_OUTPUTS } from '@/prefs/preferenceFields'
import type { UserPreferences } from '@/prefs/UserPreferences'

/**
 * The stars (outputs' keys, in their order) with `key` starred or not: one newly starred comes
 * first, as the latest starred does, and the others keep their places.
 */
export const withStar = (stars: string[], key: string, on: boolean): string[] => {
  const others = stars.filter((other) => other !== key)
  return on ? [key, ...others] : others
}

/**
 * The stars with those listed put in another `order`. A star for what is not listed stays, after
 * them: its output may only not have been read yet, as while the library's index catches up.
 */
export const withStarOrder = (stars: string[], order: string[]): string[] => [...order, ...stars.filter((key) => !order.includes(key))]

/**
 * Keeps `stars` (outputs' keys, in their order) as the user's starred outputs, in their
 * preferences (`starredOutputs`): the first MAX_STARRED_OUTPUTS, so that starring another past it
 * drops the last. A workspace's id has no slash, so a key's last slash is the one between.
 */
export const keepStars = (preferences: UserPreferences, stars: string[]) =>
  preferences.change(() => ({
    starredOutputs: stars.slice(0, MAX_STARRED_OUTPUTS).map((key) => {
      const at = key.lastIndexOf('/')
      return { workspaceId: key.slice(0, at), workpieceId: Number(key.slice(at + 1)) }
    }),
  }))
