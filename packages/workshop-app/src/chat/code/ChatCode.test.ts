import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatGadgetPinState, CodeChangeSubmission } from '@gadgets/workshop-shared/api'
import { ChatCode, NotSent, type ChatCodeSnapshot } from './ChatCode'
import { applied, changeOf, type Files } from './codeTesting'
import type { EpochCode } from './epochCode'

const BASE: Files = { 'a.js': 'let a = 1\nlet b = 2\n' }
const PIN: ChatGadgetPinState = { gadgetId: 1, baseCommit: 'base', mergedCommit: 'base' }
const epoch = (extra: Partial<EpochCode> = {}): EpochCode => ({ generation: 1, change: {}, rowsThrough: 0, kept: new Map(), ...extra })

const ready = (code: ChatCode) => {
  const snapshot: ChatCodeSnapshot = code.getSnapshot()
  if (snapshot.status !== 'ready') throw new Error('not ready')
  return snapshot
}
// Gadget 1's files as the chat has them, over BASE.
const shown = (code: ChatCode) => applied(1, BASE, { 1: [...(ready(code).gadgets.get(1)?.files ?? [])] })
const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

const made = () => {
  const sent: CodeChangeSubmission[] = []
  const submit = vi.fn<(submission: CodeChangeSubmission) => Promise<void>>(async (submission) => {
    sent.push(submission)
  })
  let clients = 0
  const reread = vi.fn<() => void>()
  const code = new ChatCode({ submit, reread, newClientId: () => `client-${++clients}` })
  return { code, sent, submit, reread }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('ChatCode', () => {
  it('is loading until the history is had, and then has each gadget the chat changed over its pin', () => {
    const { code } = made()
    expect(code.getSnapshot().status).toBe('loading')
    code.history(epoch({ change: changeOf(1, BASE, { 'a.js': 'agent\n' }) }), [PIN])
    expect(ready(code).gadgets.get(1)).toMatchObject({ base: 'base', review: 'base' })
    expect(shown(code)['a.js']).toBe('agent\n')
  })

  it('shows an edit at once, sends it over the commit it was made on, and is done once it comes back', async () => {
    const { code, sent } = made()
    code.history(epoch(), [])
    const typed = { 'a.js': 'let a = 10\nlet b = 2\n' }
    expect(code.edit(1, changeOf(1, BASE, typed)[1], 'head')).toBe(true)
    expect(shown(code)).toEqual(typed)
    expect(ready(code)).toMatchObject({ sending: true })
    expect(ready(code).gadgets.get(1)?.base).toBe('head')
    await settle()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ generation: 1, revision: 0, pins: [{ gadgetId: 1, baseCommit: 'head' }] })

    code.row({ generation: 1, revision: 1, change: sent[0].change, submission: { clientId: sent[0].clientId, seq: sent[0].seq } })
    expect(ready(code).sending).toBe(false)
    expect(shown(code)).toEqual(typed)
  })

  it('sends what was typed meanwhile as one change once the last comes back, moved past the agent’s', async () => {
    const { code, sent } = made()
    code.history(epoch(), [PIN])
    const first = { 'a.js': 'let a = 10\nlet b = 2\n' }
    code.edit(1, changeOf(1, BASE, first)[1], undefined)
    await settle()
    const second = { 'a.js': 'let a = 10\nlet b = 2\nlet c = 3\n' }
    code.edit(1, changeOf(1, first, second)[1], undefined)
    await settle()
    expect(sent).toHaveLength(1)

    // Someone else's change was taken first, then the one sent.
    code.row({ generation: 1, revision: 1, change: changeOf(1, BASE, { 'a.js': 'let a = 1\nlet b = 20\n' }) })
    code.row({ generation: 1, revision: 2, change: changeOf(1, { 'a.js': 'let a = 1\nlet b = 20\n' }, { 'a.js': 'let a = 10\nlet b = 20\n' }), submission: { clientId: 'client-1', seq: 1 } })
    await settle()
    expect(sent[1]).toMatchObject({ revision: 2, seq: 2 })
    expect(shown(code)['a.js']).toBe('let a = 10\nlet b = 20\nlet c = 3\n')
  })

  it('edits nothing while the agent works, and sends nothing until it is done', async () => {
    const { code, sent } = made()
    code.history(epoch(), [PIN])
    code.edit(1, changeOf(1, BASE, { 'a.js': 'x\n' })[1], undefined)
    code.agent(true)
    expect(code.edit(1, changeOf(1, { 'a.js': 'x\n' }, { 'a.js': 'y\n' })[1], undefined)).toBe(false)
    expect(ready(code).agentActive).toBe(true)
    await settle()
    expect(sent).toHaveLength(1)
  })

  it('tries a failed sending again as it was, after a wait', async () => {
    vi.useFakeTimers()
    const { code, sent, submit } = made()
    submit.mockRejectedValueOnce(new Error('Peer closed WebSocket'))
    code.history(epoch(), [PIN])
    code.edit(1, changeOf(1, BASE, { 'a.js': 'x\n' })[1], undefined)
    await vi.advanceTimersByTimeAsync(0)
    expect(ready(code)).toMatchObject({ sending: true, lost: undefined })
    await vi.advanceTimersByTimeAsync(1000)
    expect(submit).toHaveBeenCalledTimes(2)
    expect(submit.mock.calls[1][0]).toBe(submit.mock.calls[0][0])
    expect(sent).toHaveLength(1)
  })

  it('lets go of what was edited once the chat has refused it a few more times, and says so', async () => {
    vi.useFakeTimers()
    const { code, submit, reread } = made()
    submit.mockRejectedValue(new Error('The pin is stale.'))
    code.history(epoch(), [PIN])
    code.edit(1, changeOf(1, BASE, { 'a.js': 'x\n' })[1], undefined)
    // Tried again after one second, two, and four, and then no more.
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1000 + 2000 + 3999)
    expect(submit).toHaveBeenCalledTimes(3)
    expect(ready(code).lost).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(submit).toHaveBeenCalledTimes(4)
    expect(ready(code)).toMatchObject({ sending: false, lost: expect.stringMatching(/couldn’t be saved/) })
    expect(shown(code)['a.js']).toBe(BASE['a.js'])
    // What it kept refusing them over may be what the server has moved on from.
    expect(reread).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(submit).toHaveBeenCalledTimes(4)
  })

  it('says an edit refused and waiting to be sent again was not kept, when the stream starts over meanwhile', async () => {
    vi.useFakeTimers()
    const { code, submit } = made()
    submit.mockRejectedValueOnce(new Error('Peer closed WebSocket'))
    code.history(epoch(), [PIN])
    code.edit(1, changeOf(1, BASE, { 'a.js': 'x\n' })[1], undefined)
    await vi.advanceTimersByTimeAsync(0)
    code.history(epoch({ change: changeOf(1, BASE, { 'a.js': 'agent\n' }), rowsThrough: 2 }), [PIN])
    expect(ready(code).lost).toMatch(/couldn’t be matched/)
    await vi.advanceTimersByTimeAsync(5000)
    expect(submit).toHaveBeenCalledOnce()
  })

  it('counts a refusal afresh once a change could not be sent at all, as while reconnecting', async () => {
    vi.useFakeTimers()
    const { code, submit } = made()
    const refused = new Error('Peer closed WebSocket')
    const reconnecting = new NotSent('The conversation is reconnecting.')
    for (const error of [refused, refused, refused, reconnecting, refused, refused, refused]) submit.mockRejectedValueOnce(error)
    code.history(epoch(), [PIN])
    code.edit(1, changeOf(1, BASE, { 'a.js': 'x\n' })[1], undefined)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(submit).toHaveBeenCalledTimes(8)
    expect(ready(code)).toMatchObject({ sending: true, lost: undefined })
  })

  it('goes on through a keep over the commit it made, until the head says so', () => {
    const { code } = made()
    code.history(epoch({ change: changeOf(1, BASE, { 'a.js': 'agent\n' }) }), [PIN])
    code.history(epoch({ generation: 2, prior: { generation: 1, finalRevision: 0, discontinuousGadgets: [] }, kept: new Map([[1, 'kept']]) }), [])
    expect(ready(code).gadgets.get(1)).toEqual({ base: undefined, review: undefined, kept: { commit: 'kept', over: 'base' }, files: new Map() })
  })

  it('says what was edited here was lost with the chat’s changes, and starts as a new client', async () => {
    const { code, sent } = made()
    code.history(epoch(), [PIN])
    code.edit(1, changeOf(1, BASE, { 'a.js': 'x\n' })[1], undefined)
    code.history(epoch({ generation: 2 }), [])
    expect(ready(code)).toMatchObject({ sending: false, lost: expect.stringMatching(/discarded/) })
    expect(ready(code).gadgets.size).toBe(0)
    await settle()
    // Typed over what was shown before, it cannot follow, until what is shown now is drawn.
    expect(code.edit(1, changeOf(1, { 'a.js': 'x\n' }, { 'a.js': 'xy\n' })[1], 'head')).toBe(false)
    code.shown(ready(code).version)
    code.edit(1, changeOf(1, BASE, { 'a.js': 'y\n' })[1], 'head')
    await settle()
    expect(sent.at(-1)).toMatchObject({ clientId: 'client-2', seq: 1, generation: 2 })
  })

  it('says edits it could not follow and had not sent were not kept, rather than that they were discarded', async () => {
    const { code } = made()
    code.history(epoch(), [PIN])
    code.edit(1, changeOf(1, BASE, { 'a.js': 'x\n' })[1], undefined)
    await settle()
    code.edit(1, changeOf(1, { 'a.js': 'x\n' }, { 'a.js': 'xy\n' })[1], undefined)
    // Rows it never had as rows, recorded while it was not listening.
    code.history(epoch({ change: changeOf(1, BASE, { 'a.js': 'agent\n' }), rowsThrough: 2 }), [PIN])
    expect(ready(code).lost).toMatch(/couldn’t be matched/)
    expect(shown(code)['a.js']).toBe('agent\n')
  })

  it('says nothing was lost of an edit sent as it started over, once the server says it took it', async () => {
    const { code, submit } = made()
    let answer: (() => void) | undefined
    submit.mockImplementationOnce(() => new Promise<void>((resolve) => { answer = resolve }))
    code.history(epoch(), [PIN])
    code.edit(1, changeOf(1, BASE, { 'a.js': 'x\n' })[1], undefined)
    await settle()
    code.history(epoch({ change: changeOf(1, BASE, { 'a.js': 'x\n' }), rowsThrough: 1 }), [PIN])
    answer?.()
    await settle()
    expect(ready(code).lost).toBeUndefined()
    expect(shown(code)['a.js']).toBe('x\n')
  })

  it('says an edit sent as it started over was not kept, once the server says it did not take it', async () => {
    const { code, submit } = made()
    let refuse: (() => void) | undefined
    submit.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { refuse = () => reject(new Error('Stale revision.')) }))
    code.history(epoch(), [PIN])
    code.edit(1, changeOf(1, BASE, { 'a.js': 'x\n' })[1], undefined)
    await settle()
    code.history(epoch({ change: changeOf(1, BASE, { 'a.js': 'agent\n' }), rowsThrough: 2 }), [PIN])
    expect(ready(code).lost).toBeUndefined()
    refuse?.()
    await settle()
    expect(ready(code).lost).toMatch(/couldn’t be matched/)
  })

  it('moves an edit typed over what was drawn past what was taken since', () => {
    const { code } = made()
    code.history(epoch(), [PIN])
    code.shown(ready(code).version)
    code.row({ generation: 1, revision: 1, change: changeOf(1, BASE, { 'a.js': 'let a = 100\nlet b = 2\n' }) })
    // Typed before the row was drawn, over the text as it was.
    expect(code.edit(1, changeOf(1, BASE, { 'a.js': 'let a = 1\nlet b = 20\n' })[1], undefined)).toBe(true)
    expect(shown(code)['a.js']).toBe('let a = 100\nlet b = 20\n')
    // And the next, over that and its own edit, still before the row is drawn.
    code.edit(1, changeOf(1, { 'a.js': 'let a = 1\nlet b = 20\n' }, { 'a.js': 'let a = 1\nlet b = 20\nlet c = 3\n' })[1], undefined)
    expect(shown(code)['a.js']).toBe('let a = 100\nlet b = 20\nlet c = 3\n')
  })

  it('gives up waiting for the last rows of a generation a keep closed, starting from the keep', async () => {
    vi.useFakeTimers()
    const reread = vi.fn<() => void>()
    const code = new ChatCode({ submit: async () => {}, reread })
    code.history(epoch(), [PIN])
    code.history(epoch({ generation: 2, change: changeOf(1, BASE, { 'a.js': 'kept\n' }), prior: { generation: 1, finalRevision: 3, discontinuousGadgets: [] } }), [PIN])
    expect(shown(code)).toEqual(BASE)
    await vi.advanceTimersByTimeAsync(5000)
    expect(shown(code)['a.js']).toBe('kept\n')
    expect(reread).not.toHaveBeenCalled()
  })

  it('tries again a change that was not sent, as while reconnecting, without saying it failed', async () => {
    vi.useFakeTimers()
    const { code, sent, submit } = made()
    submit.mockRejectedValueOnce(new NotSent('The conversation is reconnecting.'))
    code.history(epoch(), [PIN])
    code.edit(1, changeOf(1, BASE, { 'a.js': 'x\n' })[1], undefined)
    await vi.advanceTimersByTimeAsync(0)
    expect(ready(code).lost).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1000)
    expect(sent).toHaveLength(1)
  })

  it('keeps a gadget’s code the same object while nothing of it changes', () => {
    const { code } = made()
    code.history(epoch({ change: { ...changeOf(1, BASE, { 'a.js': 'agent\n' }), ...changeOf(2, {}, { 'b.js': 'b\n' }) } }), [PIN])
    const before = ready(code).gadgets.get(2)
    code.row({ generation: 1, revision: 1, change: changeOf(1, { 'a.js': 'agent\n' }, { 'a.js': 'again\n' }) })
    expect(ready(code).gadgets.get(2)).toBe(before)
  })
})
