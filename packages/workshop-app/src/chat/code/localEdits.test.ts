import { describe, expect, it } from 'vitest'
import { composeCodeChange } from '@gadgets/workshop-shared/code-change'
import type { StreamRow } from './changeStream'
import { applied, changeOf } from './codeTesting'
import { LocalEdits } from './localEdits'

const BASE = { 'a.js': 'let a = 1\nlet b = 2\n' }
const ids = () => {
  let made = 0
  return () => `client-${++made}`
}
const remote = (change: StreamRow['change'], revision = 1): StreamRow => ({ generation: 1, revision, change })
const notPinned = () => false

describe('LocalEdits', () => {
  it('sends what was edited as one change, declaring the commit it was over, and waits for it to come back', () => {
    const edits = new LocalEdits(ids())
    edits.add(changeOf(1, BASE, { 'a.js': 'let a = 10\nlet b = 2\n' }), () => 'head')
    edits.add(changeOf(1, { 'a.js': 'let a = 10\nlet b = 2\n' }, { 'a.js': 'let a = 10\nlet b = 20\n' }), () => 'later')
    const sent = edits.next(1, 3, notPinned)!
    expect(sent).toMatchObject({ generation: 1, revision: 3, clientId: 'client-1', seq: 1, pins: [{ gadgetId: 1, baseCommit: 'head' }] })
    expect(applied(1, BASE, sent.change)['a.js']).toBe('let a = 10\nlet b = 20\n')
    expect(edits.sending).toBe(true)
    // Not answered: the same change goes again, as it was.
    expect(edits.next(1, 4, notPinned)).toBe(sent)

    edits.heard({ generation: 1, revision: 4, change: sent.change, submission: { clientId: 'client-1', seq: 1 } })
    expect(edits.idle).toBe(true)
  })

  it('declares no pin the chat has, nor one for a gadget it made', () => {
    const edits = new LocalEdits(ids())
    edits.add({ ...changeOf(1, BASE, { 'a.js': 'x\n' }), ...changeOf(2, {}, { 'b.js': 'y\n' }) }, (gadgetId) => (gadgetId === 1 ? 'head' : undefined))
    expect(edits.next(1, 0, (gadgetId) => gadgetId === 1)?.pins).toBeUndefined()
  })

  it('moves what is sent and what was edited since on past someone else’s change', () => {
    const edits = new LocalEdits(ids())
    const mine = { 'a.js': 'let a = 10\nlet b = 2\n' }
    edits.add(changeOf(1, BASE, mine), () => 'head')
    edits.next(1, 0, notPinned)
    const more = { 'a.js': 'let a = 10\nlet b = 2\nlet c = 3\n' }
    edits.add(changeOf(1, mine, more), () => 'head')

    // The agent changed the second line, and was taken first.
    const theirs = changeOf(1, BASE, { 'a.js': 'let a = 1\nlet b = 200\n' })
    edits.heard(remote(theirs))
    expect(applied(1, BASE, composeCodeChange(theirs, edits.change))['a.js']).toBe('let a = 10\nlet b = 200\nlet c = 3\n')
  })

  it('carries on after a keep over the commits it made, but for a gadget whose content it changed', () => {
    const edits = new LocalEdits(ids())
    edits.add({ ...changeOf(1, BASE, { 'a.js': 'x\n' }), ...changeOf(2, BASE, { 'a.js': 'y\n' }) }, () => 'head')
    edits.kept([2], new Map([[1, 'kept-1'], [2, 'kept-2']]))
    expect(Object.keys(edits.change)).toEqual(['1'])
    expect(edits.bases).toEqual(new Map([[1, 'kept-1']]))
  })

  it('lets go of everything, and sends as a client the server has not heard from', () => {
    const edits = new LocalEdits(ids())
    edits.add(changeOf(1, BASE, { 'a.js': 'x\n' }), () => 'head')
    edits.next(1, 0, notPinned)
    edits.drop()
    expect(edits.idle).toBe(true)
    edits.add(changeOf(1, BASE, { 'a.js': 'y\n' }), () => 'head')
    expect(edits.next(2, 0, notPinned)).toMatchObject({ clientId: 'client-2', seq: 1 })
  })
})
