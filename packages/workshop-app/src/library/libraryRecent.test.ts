import { describe, expect, it, vi } from 'vitest'
import type { OutputSummary, UserPreferencesSubscriber } from '@gadgets/workshop-shared/api'
import { encodePreferences, MAX_OPENED_OUTPUTS } from '@/prefs/preferenceFields'
import { UserPreferences, type PreferencesBackend } from '@/prefs/UserPreferences'
import { outputKey } from './libraryList'
import { RECENT_SHOWN, recentOutputs, recordOpened } from './libraryRecent'

const NOW = new Date('2026-11-17T12:00:00Z')
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000)
const output = (workpieceId: number, lastActive = NOW): OutputSummary => ({
  workspaceId: 'w',
  workpieceId,
  title: `Output ${workpieceId}`,
  workspaceTitle: 'Workspace',
  created: NOW,
  lastActive,
})

describe('recentOutputs', () => {
  const outputs = [output(1, hoursAgo(5)), output(2, hoursAgo(1)), output(3, hoursAgo(2)), output(4)]
  const waiting = new Map([[outputKey(outputs[0]), 1], [outputKey(outputs[1]), 1], [outputKey(outputs[2]), 3]])
  const waitingOf = (each: OutputSummary) => waiting.get(outputKey(each)) ?? 0

  it('has what waits on the user first, the most waiting first, then the latest active', () => {
    expect(recentOutputs(outputs, [], waitingOf).needsYou.map(({ workpieceId }) => workpieceId)).toEqual([3, 2, 1])
  })

  it('has what was opened last after that, latest first, leaving out what waits and what is gone', () => {
    const opened = ['w/4', 'w/9', 'w/1']
    expect(recentOutputs(outputs, opened, waitingOf).opened.map(({ workpieceId }) => workpieceId)).toEqual([4])
    expect(recentOutputs(outputs, opened).opened.map(({ workpieceId }) => workpieceId)).toEqual([4, 1])
  })

  it('shows no more of what was opened than it has room for', () => {
    const lots = Array.from({ length: RECENT_SHOWN + 5 }, (_, index) => output(index + 10))
    expect(recentOutputs(lots, lots.map(outputKey)).opened).toHaveLength(RECENT_SHOWN)
  })
})

describe('recordOpened', () => {
  it('puts the one opened first, once, within the bound, and sends nothing when it already is', async () => {
    let server: UserPreferencesSubscriber | undefined
    const subscribe = vi.fn<PreferencesBackend['subscribe']>(async (given) => {
      server = given as unknown as UserPreferencesSubscriber
      return { [Symbol.dispose]: () => {} }
    })
    const update = vi.fn<PreferencesBackend['update']>(async () => {})
    const store = new UserPreferences()
    store.start({ subscribe, update })
    const many = Array.from({ length: MAX_OPENED_OUTPUTS }, (_, index) => ({ workspaceId: 'w', workpieceId: index }))
    await server!.updated(encodePreferences({ openedOutputs: many }))

    recordOpened(store, { workspaceId: 'w', workpieceId: 5 })
    recordOpened(store, { workspaceId: 'v', workpieceId: 1 })
    const opened = store.getSnapshot().openedOutputs.map(outputKey)
    expect(opened).toHaveLength(MAX_OPENED_OUTPUTS)
    expect(opened.slice(0, 3)).toEqual(['v/1', 'w/5', 'w/0'])
    recordOpened(store, { workspaceId: 'v', workpieceId: 1 })
    expect(update).toHaveBeenCalledTimes(2)
  })
})
