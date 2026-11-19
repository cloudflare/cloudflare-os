import { describe, expect, it } from 'vitest'
import type { AiChatMessage, AiChatMessageBody, ChatCodeBase } from '@gadgets/workshop-shared/api'
import { applied, changeOf } from './codeTesting'
import { epochCode } from './epochCode'

const author = { type: 'agent', id: 'a', name: 'Agent' } as const
const at = (sequence: number, body: AiChatMessageBody): AiChatMessage =>
  ({ chatId: 0, sequence, timestamp: new Date(0), author, ...body }) as AiChatMessage
const base = (extra: Partial<ChatCodeBase> = {}): ChatCodeBase => ({ pins: [], generation: 3, revision: 0, ...extra })
const BASE = { 'a.js': 'one\n' }

describe('epochCode', () => {
  it('composes the epoch’s changes, and says how far into the stream they reach', () => {
    const code = epochCode([
      at(1, { type: 'changes', change: changeOf(1, BASE, { 'a.js': 'two\n' }), watermark: { changesGeneration: 3, throughRevision: 2 } }),
      at(2, { type: 'changes', change: changeOf(1, { 'a.js': 'two\n' }, { 'a.js': 'three\n' }), watermark: { changesGeneration: 3, throughRevision: 5 } }),
    ], base())
    expect(applied(1, BASE, code.change)['a.js']).toBe('three\n')
    expect(code).toMatchObject({ generation: 3, rowsThrough: 5 })
  })

  it('leaves out what came before the epoch and what a revert discarded, and counts only this generation’s rows', () => {
    const code = epochCode([
      at(1, { type: 'changes', change: changeOf(1, BASE, { 'a.js': 'old\n' }) }),
      at(2, { type: 'merge', mergeThrough: 1, commits: [{ gadgetId: 1, commitId: 'kept' }], epochBoundary: true }),
      at(3, { type: 'changes', change: changeOf(2, {}, { 'b.js': 'b\n' }), watermark: { changesGeneration: 2, throughRevision: 9 } }),
      at(4, { type: 'changes', change: changeOf(3, {}, { 'c.js': 'c\n' }) }),
      at(5, { type: 'revert', revertFrom: 4 }),
    ], base({ epoch: 2 }))
    expect(Object.keys(code.change)).toEqual(['2'])
    expect(code.rowsThrough).toBe(0)
    expect(code.kept).toEqual(new Map([[1, 'kept']]))
  })

  it('takes in a migrated chat’s conversion, which opens its epoch', () => {
    const code = epochCode([at(4, { type: 'changes', conversionBoundary: true, change: changeOf(1, BASE, { 'a.js': 'converted\n' }) })], base({ epoch: 4 }))
    expect(applied(1, BASE, code.change)['a.js']).toBe('converted\n')
  })
})
