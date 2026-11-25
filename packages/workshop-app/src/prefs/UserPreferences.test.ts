import { describe, expect, it, vi } from 'vitest'
import type { UserPreferences as StoredPreferences, UserPreferencesSubscriber } from '@gadgets/workshop-shared/api'
import { EMPTY_PREFERENCES as EMPTY, encodePreferences as encode, MAX_RECENT_COMMANDS } from './preferenceFields'
import { recordCommandUse } from './recentCommands'
import { UserPreferences, type PreferencesBackend } from './UserPreferences'

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

/** The store, subscribed, and what a test needs to act as the server: the listener it was given last, and the updates sent. */
const started = () => {
  const listeners: (UserPreferencesSubscriber & Disposable)[] = []
  const subscribe = vi.fn<PreferencesBackend['subscribe']>((given) => {
    listeners.push(given as unknown as UserPreferencesSubscriber & Disposable)
    return Promise.resolve({ [Symbol.dispose]: () => {} })
  })
  const sent: { update: StoredPreferences; land: () => void; refuse: () => void }[] = []
  const update = vi.fn<PreferencesBackend['update']>((given) => new Promise<void>((resolve, reject) => {
    sent.push({ update: given, land: resolve, refuse: () => reject(new Error('refused')) })
  }))
  const store = new UserPreferences()
  store.start({ subscribe, update })
  return { store, subscribe, update, sent, server: () => listeners.at(-1)! }
}

describe('UserPreferences', () => {
  it('holds a change made before the account has said until it has, then makes it of what is kept', async () => {
    const { store, sent, server } = started()
    recordCommandUse(store, 'digest')
    expect(sent).toEqual([])
    await server().updated(encode({ ...EMPTY, recentCommands: ['brief'] }))
    expect(store.getSnapshot().recentCommands).toEqual(['digest', 'brief'])
    expect(sent.map(({ update }) => update)).toEqual([encode({ recentCommands: ['digest', 'brief'] })])
  })

  it('shows a change at once, and what the account says meanwhile only once every change has landed', async () => {
    const { store, sent, server } = started()
    await server().updated(encode(EMPTY))
    store.change(() => ({ asideShown: { 'w1/2': '7' } }))
    expect(store.getSnapshot().asideShown).toEqual({ 'w1/2': '7' })

    // Another tab's change, said before this one lands, does not undo it meanwhile.
    await server().updated(encode({ ...EMPTY, recentCommands: ['brief'] }))
    expect(store.getSnapshot()).toEqual({ ...EMPTY, asideShown: { 'w1/2': '7' } })
    const told = { ...EMPTY, recentCommands: ['brief'], asideShown: { 'w1/2': '7' } }
    await server().updated(encode(told))
    sent[0].land()
    await flush()
    expect(store.getSnapshot()).toEqual(told)
  })

  it('gives way to what the account says when a change is refused', async () => {
    const { store, sent, server } = started()
    await server().updated(encode(EMPTY))
    recordCommandUse(store, 'digest')
    expect(store.getSnapshot().recentCommands).toEqual(['digest'])
    sent[0].refuse()
    await flush()
    expect(store.getSnapshot()).toEqual(EMPTY)
  })

  it('subscribes again once the account forgets it, keeping what was known meanwhile', async () => {
    const { store, server, subscribe } = started()
    await flush()
    await server().updated(encode({ ...EMPTY, recentCommands: ['brief'] }))
    server()[Symbol.dispose]()
    expect(subscribe).toHaveBeenCalledTimes(2)
    expect(store.getSnapshot().recentCommands).toEqual(['brief'])
  })

  it('keeps what the account said through a disconnect, dropping what was on its way, and changes nothing while stopped', async () => {
    const { store, sent, server, update } = started()
    await server().updated(encode({ ...EMPTY, recentCommands: ['brief'] }))
    recordCommandUse(store, 'digest')
    store.stop()
    expect(store.getSnapshot().recentCommands).toEqual(['brief'])
    recordCommandUse(store, 'other')
    expect(update).toHaveBeenCalledTimes(1)

    store.start({ subscribe: async () => ({ [Symbol.dispose]: () => {} }), update })
    sent[0].land()
    await flush()
    expect(store.getSnapshot().recentCommands).toEqual(['brief'])
    // Made of what the new connection says, once it has.
    recordCommandUse(store, 'other')
    expect(update).toHaveBeenCalledTimes(1)
  })
})

describe('decoding', () => {
  it('reads what is missing, not JSON, or of another shape as empty, and leaves out entries of another shape', async () => {
    const { store, server } = started()
    await server().updated({
      recentCommands: '{"not":"a list"}',
      asideShown: 'not json',
      savedExports: JSON.stringify({ good: { accountId: 1, url: 'u', name: 'n' }, bad: { url: 'u' } }),
    })
    expect(store.getSnapshot()).toEqual({ ...EMPTY, savedExports: { good: { accountId: 1, url: 'u', name: 'n' } } })
  })

  it('reads outputs, workspace ids and looks, leaving out what is of another shape and a shape or colour there no longer is', async () => {
    const { store, server } = started()
    await server().updated({
      starredOutputs: JSON.stringify([{ workspaceId: 'w', workpieceId: 2 }, { workspaceId: 'w', workpieceId: 'x' }]),
      openedOutputs: JSON.stringify({ not: 'a list' }),
      starredWorkspaces: JSON.stringify(['b', 3, 'a']),
      workspaceLooks: JSON.stringify({ a: { shape: 'rocket', color: 'blue' }, b: { shape: 'gone', color: 'red' }, c: 'not a look' }),
    })
    expect(store.getSnapshot()).toEqual({
      ...EMPTY,
      starredOutputs: [{ workspaceId: 'w', workpieceId: 2 }],
      starredWorkspaces: ['b', 'a'],
      workspaceLooks: { a: { shape: 'rocket', color: 'blue' }, b: { shape: undefined, color: 'red' } },
    })
  })
})

describe('recordCommandUse', () => {
  it('puts the one chosen first, once, within the bound, and sends nothing when it already is', async () => {
    const { store, sent, server } = started()
    const many = Array.from({ length: MAX_RECENT_COMMANDS }, (_, index) => `command-${index}`)
    await server().updated(encode({ ...EMPTY, recentCommands: many }))
    recordCommandUse(store, 'command-5')
    expect(store.getSnapshot().recentCommands).toHaveLength(MAX_RECENT_COMMANDS)
    expect(store.getSnapshot().recentCommands.slice(0, 2)).toEqual(['command-5', 'command-0'])
    recordCommandUse(store, 'fresh')
    expect(store.getSnapshot().recentCommands).toHaveLength(MAX_RECENT_COMMANDS)
    expect(store.getSnapshot().recentCommands.at(-1)).toBe('command-18')
    recordCommandUse(store, 'fresh')
    expect(sent).toHaveLength(2)
  })
})
