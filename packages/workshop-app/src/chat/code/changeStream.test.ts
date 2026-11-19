import { describe, expect, it } from 'vitest'
import { ChangeStream, type StreamRow } from './changeStream'
import { applied, changeOf } from './codeTesting'
import type { EpochCode } from './epochCode'

const BASE = { 'a.js': 'one\n' }
const history = (extra: Partial<EpochCode> = {}): EpochCode => ({ generation: 1, change: {}, rowsThrough: 0, kept: new Map(), ...extra })
// Each row sets a.js to the next line, so what the stream has says which rows it took.
const text = (revision: number) => Array.from({ length: revision + 1 }, (_, line) => `line ${line}\n`).join('')
const row = (revision: number, generation = 1): StreamRow => ({
  generation,
  revision,
  change: changeOf(1, revision === 1 ? BASE : { 'a.js': text(revision - 1) }, { 'a.js': text(revision) }),
})
const shown = (stream: ChangeStream) => applied(1, BASE, stream.change)['a.js']
const kinds = (events: readonly { type: string }[]) => events.map(({ type }) => type)

describe('ChangeStream', () => {
  it('starts from the history, with the rows after it on top, in order', () => {
    const stream = new ChangeStream()
    expect(stream.ready).toBe(false)
    expect(stream.row(row(2))).toEqual([])
    expect(kinds(stream.history(history({ change: changeOf(1, BASE, { 'a.js': text(1) }), rowsThrough: 1 })))).toEqual(['row'])
    expect(stream.revision).toBe(2)
    expect(shown(stream)).toBe(text(2))
  })

  it('lets go of a row it has had, and of one the history takes in', () => {
    const stream = new ChangeStream()
    stream.history(history({ change: changeOf(1, BASE, { 'a.js': text(1) }), rowsThrough: 1 }))
    expect(stream.row(row(1))).toEqual([])
    stream.row(row(2))
    expect(stream.row(row(2))).toEqual([])
    expect(shown(stream)).toBe(text(2))
  })

  it('holds a row past a gap until the gap is filled, and says it is stalled meanwhile', () => {
    const stream = new ChangeStream()
    stream.history(history())
    expect(stream.row(row(2))).toEqual([])
    expect(stream.stalled).toBe(true)
    expect(stream.row(row(1)).map((event) => event.type === 'row' && event.row.revision)).toEqual([1, 2])
    expect(stream.stalled).toBe(false)
  })

  it('takes the history in again as rows are recorded, without changing what it has', () => {
    const stream = new ChangeStream()
    stream.history(history())
    stream.row(row(1))
    stream.row(row(2))
    expect(stream.history(history({ change: changeOf(1, BASE, { 'a.js': text(1) }), rowsThrough: 1 }))).toEqual([])
    expect(shown(stream)).toBe(text(2))
  })

  it('starts over from a history that took in rows it never had', () => {
    const stream = new ChangeStream()
    stream.history(history())
    expect(kinds(stream.history(history({ change: changeOf(1, BASE, { 'a.js': text(2) }), rowsThrough: 2 })))).toEqual(['reset'])
    expect(stream.revision).toBe(2)
    expect(shown(stream)).toBe(text(2))
  })

  it('finishes the generation a keep closed before going on to the next, which starts from nothing', () => {
    const stream = new ChangeStream()
    stream.history(history())
    stream.row(row(1))
    const next = history({ generation: 2, prior: { generation: 1, finalRevision: 2, discontinuousGadgets: [4] } })
    expect(stream.history(next)).toEqual([])
    expect(stream.stalled).toBe(true)
    // A row of the next generation waits for the last of this one.
    const after: StreamRow = { generation: 2, revision: 1, change: changeOf(1, BASE, { 'a.js': 'two\n' }) }
    expect(stream.row(after)).toEqual([])
    expect(stream.row(row(2))).toEqual([
      { type: 'row', row: row(2) },
      { type: 'kept', discontinuous: [4] },
      { type: 'row', row: after },
    ])
    expect(stream.generation).toBe(2)
    expect(stream.stalled).toBe(false)
  })

  it('goes on at once from a keep whose rows it has all had', () => {
    const stream = new ChangeStream()
    stream.history(history())
    stream.row(row(1))
    expect(kinds(stream.history(history({ generation: 2, prior: { generation: 1, finalRevision: 1, discontinuousGadgets: [] } })))).toEqual(['kept'])
    expect(stream.change).toEqual({})
  })

  it('starts over from what is left after a discard', () => {
    const stream = new ChangeStream()
    stream.history(history())
    stream.row(row(1))
    expect(kinds(stream.history(history({ generation: 2 })))).toEqual(['reset'])
    expect(stream.change).toEqual({})
    // A late row of the discarded generation changes nothing.
    expect(stream.row(row(2))).toEqual([])
  })

  it('pays no mind to an older history', () => {
    const stream = new ChangeStream()
    stream.history(history({ generation: 2 }))
    expect(stream.history(history({ generation: 1, rowsThrough: 5 }))).toEqual([])
    expect(stream.generation).toBe(2)
  })
})
