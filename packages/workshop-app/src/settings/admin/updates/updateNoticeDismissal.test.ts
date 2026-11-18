import { describe, expect, it } from 'vitest'
import {
  UPDATE_NOTICE_DISMISSED_AT_KEY,
  isSnoozed,
  recordDismissal,
  type DismissalStorage,
} from './updateNoticeDismissal'

const HOUR_MS = 60 * 60 * 1000
const NOW = Date.UTC(2026, 9, 5, 12)

const memoryStorage = (initial?: string): DismissalStorage & { values: Map<string, string> } => {
  const values = new Map<string, string>()
  if (initial !== undefined) values.set(UPDATE_NOTICE_DISMISSED_AT_KEY, initial)
  return {
    values,
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
  }
}

const throwingStorage: DismissalStorage = {
  getItem: () => { throw new DOMException('blocked', 'SecurityError') },
  setItem: () => { throw new DOMException('full', 'QuotaExceededError') },
}

describe('update notice dismissal', () => {
  it('snoozes the notice for the given hours after it is closed', () => {
    const storage = memoryStorage()
    recordDismissal(storage, NOW)

    expect(storage.values.get(UPDATE_NOTICE_DISMISSED_AT_KEY)).toBe(String(NOW))
    expect(isSnoozed(storage, NOW, 24)).toBe(true)
    expect(isSnoozed(storage, NOW + 24 * HOUR_MS - 1, 24)).toBe(true)
  })

  it('stops snoozing once the hours have passed', () => {
    const storage = memoryStorage(String(NOW))

    expect(isSnoozed(storage, NOW + 24 * HOUR_MS, 24)).toBe(false)
    expect(isSnoozed(storage, NOW + 25 * HOUR_MS, 24)).toBe(false)
  })

  it('never snoozes for zero hours', () => {
    expect(isSnoozed(memoryStorage(String(NOW)), NOW, 0)).toBe(false)
  })

  it('does not snooze when the notice was never closed', () => {
    expect(isSnoozed(memoryStorage(), NOW, 24)).toBe(false)
  })

  it.each(['', 'yesterday', '1.5e12', '-5', ' 1759665600000', String(Number.MAX_SAFE_INTEGER) + '0'])(
    'ignores the stored value %j',
    (stored) => {
      expect(isSnoozed(memoryStorage(stored), NOW, 24)).toBe(false)
    },
  )

  // A clock set back after the close leaves a timestamp ahead of now; honouring it would hide the
  // notice until the clock caught up.
  it('ignores a dismissal dated in the future', () => {
    expect(isSnoozed(memoryStorage(String(NOW + HOUR_MS)), NOW, 24)).toBe(false)
  })

  it('treats storage that throws as never dismissed, and records nothing', () => {
    expect(() => recordDismissal(throwingStorage, NOW)).not.toThrow()
    expect(isSnoozed(throwingStorage, NOW, 24)).toBe(false)
  })
})
