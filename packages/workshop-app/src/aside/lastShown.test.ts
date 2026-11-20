import { describe, expect, it, vi } from 'vitest'
import type { UserPreferencesSubscriber } from '@gadgets/workshop-shared/api'
import { encodePreferences, MAX_ASIDE_SHOWN } from '@/prefs/preferenceFields'
import { UserPreferences, type PreferencesBackend } from '@/prefs/UserPreferences'
import { lastShown, rememberShown } from './lastShown'

/** The store, subscribed, with the listener it gave the server; every change lands. */
const started = () => {
  const listeners: UserPreferencesSubscriber[] = []
  const subscribe = vi.fn<PreferencesBackend['subscribe']>((given) => {
    listeners.push(given as unknown as UserPreferencesSubscriber)
    return Promise.resolve({ [Symbol.dispose]: () => {} })
  })
  const store = new UserPreferences()
  store.start({ subscribe, update: async () => {} })
  return { store, server: () => listeners.at(-1)! }
}

describe('lastShown', () => {
  it('keeps the latest pages within the bound, a chat apart from its workspace, and ignores what cannot be shown', async () => {
    const { store, server } = started()
    const full = Object.fromEntries(Array.from({ length: MAX_ASIDE_SHOWN }, (_, index) => [`w${index}`, '1']))
    await server().updated(encodePreferences({ asideShown: { ...full, 'w0/3': 'not a ref' } }))
    expect(lastShown(store.getSnapshot(), 'w0', undefined)).toBe('1')
    expect(lastShown(store.getSnapshot(), 'w0', 3)).toBeUndefined()

    rememberShown(store, 'w1', undefined, 'file-a')
    const kept = Object.keys(store.getSnapshot().asideShown)
    expect(kept).toHaveLength(MAX_ASIDE_SHOWN)
    expect(kept.at(-1)).toBe('w1')
    expect(kept).not.toContain('w0')
  })
})
