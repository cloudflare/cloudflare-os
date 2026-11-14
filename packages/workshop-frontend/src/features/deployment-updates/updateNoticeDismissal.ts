/** The part of `Storage` the update notice's dismissal reads and writes. */
export type DismissalStorage = Pick<Storage, 'getItem' | 'setItem'>

/** When an admin last closed the update notice in this browser, in epoch milliseconds. */
export const UPDATE_NOTICE_DISMISSED_AT_KEY = 'gadgets:workshop:updateNoticeDismissedAt'

const HOUR_MS = 60 * 60 * 1000

/** Remembers that the notice was closed at `now` (epoch milliseconds). Best-effort. */
export const recordDismissal = (storage: DismissalStorage, now: number): void => {
  try {
    storage.setItem(UPDATE_NOTICE_DISMISSED_AT_KEY, String(now))
  } catch {
    // Storage can be full or blocked; the notice then simply returns on the next visit.
  }
}

/**
 * Whether the notice was closed less than `snoozeHours` hours before `now`, so 0 hours never
 * snoozes it. Only a whole number of milliseconds no later than `now` counts as a dismissal: a
 * junk value, a storage that throws, and a timestamp in the future (left by a clock that has since
 * been set back) all read as no dismissal, so none of them can hide the notice indefinitely.
 */
export const isSnoozed = (storage: DismissalStorage, now: number, snoozeHours: number): boolean => {
  let stored: string | null
  try {
    stored = storage.getItem(UPDATE_NOTICE_DISMISSED_AT_KEY)
  } catch {
    return false
  }
  if (stored === null || !/^\d+$/.test(stored)) return false
  const dismissedAt = Number(stored)
  if (!Number.isSafeInteger(dismissedAt) || dismissedAt > now) return false
  return now - dismissedAt < snoozeHours * HOUR_MS
}
