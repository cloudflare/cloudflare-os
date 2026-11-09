import { describe, expect, it } from 'vitest'
import type { AiChatMessage } from '@gadgets/workshop-shared/api'
import { findChangePoints } from './changePoints'

const USER = { type: 'user' as const, id: 'a@example.com', name: 'Alice' }
const base = (sequence: number) => ({ chatId: 1, sequence, timestamp: new Date(sequence), author: USER })
const merge = (sequence: number, commits: { gadgetId: number, commitId: string, previousCommit?: string | null }[]) =>
  ({ ...base(sequence), type: 'merge', mergeThrough: sequence - 1, commits, automatic: true }) as AiChatMessage
const restore = (sequence: number, from: number, to: 'before' | 'after', gadgetIds: number[],
  removedGadgets?: { gadgetId: number, title: string }[]) =>
  ({ ...base(sequence), type: 'restore', from, to, removedGadgets,
     commits: gadgetIds.map((gadgetId) => ({ gadgetId, commitId: `r${sequence}`, previousCommit: 'p' })) }) as AiChatMessage
const titles: Record<number, string> = { 1: 'Budget', 2: 'Notes', 3: 'Clock' }
const points = (messages: AiChatMessage[]) => findChangePoints(messages, (id) => titles[id])

describe('findChangePoints', () => {
  it('offers Undo on the newest accept and Restore on older ones', () => {
    const found = points([
      merge(1, [{ gadgetId: 1, commitId: 'a', previousCommit: null }]),
      merge(3, [{ gadgetId: 1, commitId: 'b', previousCommit: 'a' }]),
    ])
    expect(found.get(1)).toMatchObject({ label: 'Created Budget', action: 'Restore', to: 'after' })
    expect(found.get(1)?.deletes).toBeUndefined()
    expect(found.get(3)).toMatchObject({ label: 'Updated Budget', action: 'Undo', to: 'before' })
  })

  it('confirms an undo that deletes the app the accept created', () => {
    expect(points([merge(1, [{ gadgetId: 3, commitId: 'a', previousCommit: null }])]).get(1))
      .toMatchObject({ action: 'Undo', deletes: ['Clock'] })
  })

  it('names several apps together, and leaves an accept that changed no code out', () => {
    const found = points([
      merge(1, [{ gadgetId: 1, commitId: 'a', previousCommit: 'x' }, { gadgetId: 2, commitId: 'b', previousCommit: 'y' }]),
      merge(2, []),
    ])
    expect(found.get(1)).toMatchObject({ label: 'Updated Budget and Notes', action: 'Undo' })
    expect(found.has(2)).toBe(false)
  })

  it('offers no way back from an accept from before accepts recorded one', () => {
    expect(points([merge(1, [{ gadgetId: 1, commitId: 'a' }])]).get(1)?.action).toBeUndefined()
  })

  it('reads an undo, its redo, and a restore, each newest offering the way back', () => {
    const accepted = merge(1, [{ gadgetId: 1, commitId: 'a', previousCommit: 'x' }])
    expect(points([accepted, restore(2, 1, 'before', [1])]).get(2))
      .toMatchObject({ label: 'Undid changes to Budget', action: 'Redo', to: 'before', back: true })
    expect(points([accepted, restore(2, 1, 'before', [1]), restore(3, 2, 'before', [1])]).get(3))
      .toMatchObject({ label: 'Redid changes to Budget', action: 'Undo' })
    const found = points([accepted, merge(2, [{ gadgetId: 1, commitId: 'b', previousCommit: 'a' }]), restore(3, 1, 'after', [1])])
    expect(found.get(3)).toMatchObject({ label: 'Restored Budget to an earlier version', action: 'Undo' })
    expect(found.get(2)).toMatchObject({ action: 'Restore' })
  })

  it('says which apps a restore removed, with nothing to go back to', () => {
    const found = points([merge(1, [{ gadgetId: 3, commitId: 'a', previousCommit: null }]),
      restore(2, 1, 'before', [], [{ gadgetId: 3, title: 'Clock' }])])
    expect(found.get(2)).toMatchObject({ label: 'Removed Clock' })
    expect(found.get(2)?.action).toBeUndefined()
  })
})
