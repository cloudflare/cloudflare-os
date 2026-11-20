import { MAX_STARRED_WORKSPACES } from '@/prefs/preferenceFields'
import type { UserPreferences } from '@/prefs/UserPreferences'

/**
 * The starred workspaces in the order the user put them in (`order`, their ids, as the preferences'
 * `starredWorkspaces` keep it). One the order does not have was starred since, so it comes first, as
 * the latest starred does, in the order it was given. Ids the order has that are not starred, or no
 * longer listed, are passed over.
 */
export const orderStarred = <T extends { id: string }>(starred: T[], order: readonly string[]): T[] => {
  const place = new Map(order.map((id, index) => [id, index]))
  const unplaced = starred.filter(({ id }) => !place.has(id))
  const placed = starred.filter(({ id }) => place.has(id)).toSorted((a, b) => place.get(a.id)! - place.get(b.id)!)
  return [...unplaced, ...placed]
}

/** Keeps `order` (every starred workspace's id) as the order of the user's starred workspaces. */
export const keepStarredOrder = (preferences: UserPreferences, order: string[]) =>
  preferences.change(() => ({ starredWorkspaces: order.slice(0, MAX_STARRED_WORKSPACES) }))

/**
 * Takes a workspace out of the order the starred are kept in, as it is starred, so that it comes
 * first as the latest starred does, rather than back in the place it had when last starred.
 */
export const leaveStarredOrder = (preferences: UserPreferences, id: string) => {
  if (!preferences.getSnapshot().starredWorkspaces.includes(id)) return
  preferences.change(({ starredWorkspaces }) => ({ starredWorkspaces: starredWorkspaces.filter((other) => other !== id) }))
}
