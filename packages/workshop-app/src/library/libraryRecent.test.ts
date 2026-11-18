import { describe, expect, it } from 'vitest'
import type { OutputSummary } from '@gadgets/workshop-shared/api'
import { outputKey } from './libraryList'
import { OPENED_KEPT, withOpened } from '@/prefs/libraryOpened'
import { RECENT_SHOWN, recentOutputs } from './libraryRecent'

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

describe('withOpened', () => {
  it('puts the one opened now first, once, and keeps no more than it remembers', () => {
    expect(withOpened(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c'])
    const many = Array.from({ length: OPENED_KEPT }, (_, index) => String(index))
    expect(withOpened(many, 'new')).toHaveLength(OPENED_KEPT)
    expect(withOpened(many, 'new')[0]).toBe('new')
  })
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
