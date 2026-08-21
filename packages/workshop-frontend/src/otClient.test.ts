import { describe, expect, it } from 'vitest'
import type { CodeChangeSubmission } from '@gadgets/workshop-shared/api'
import { applyCodeChange, transformCodeChange, type CodeContent, type CodeChange }
  from '@gadgets/workshop-shared/code-change'
import { ChatOtClient, type ChatChangeRow, type ChatOtClientDelegate, type RemoteFileEvent }
  from './otClient'

// Exercises the two-buffer client against a tiny in-test "server": submissions are captured,
// echoes and remote rows are fed back through pushRow, and durable snapshots through
// setDurableState -- the same inputs the real subscription delivers.

const AUTHOR = { type: 'user', id: 'me@example.com', name: 'Me' } as const
const OTHER = { type: 'user', id: 'other@example.com', name: 'Other' } as const

function flush(ms = 5): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

class TestHarness {
  commits = new Map<string, Map<string, string>>()
  submissions: CodeChangeSubmission[] = []
  submitResult:
      (submission: CodeChangeSubmission) => Promise<{ generation: number; revision: number }> =
    async () => ({ generation: 0, revision: 0 })
  discards = 0
  fatal: unknown = null
  remoteEvents: RemoteFileEvent[][] = []
  dirty: boolean[] = []

  readonly delegate: ChatOtClientDelegate = {
    fetchCommitFiles: async (commitId: string) => {
      const files = this.commits.get(commitId)
      if (!files) throw new Error(`no such commit: ${commitId}`)
      return files
    },
    submitCodeChange: submission => {
      this.submissions.push(submission)
      return this.submitResult(submission)
    },
    isTransientError: err => err instanceof Error && err.message === 'transient',
    onRemoteChange: events => { this.remoteEvents.push(events) },
    onLocalEditsDiscarded: () => { this.discards++ },
    onDirtyState: dirty => { this.dirty.push(dirty) },
    onFatalError: err => { this.fatal = err },
  }

  readonly client = new ChatOtClient(this.delegate)
}

function filesOf(content: CodeContent, gadgetId: number): Record<string, string> {
  return Object.fromEntries(content.get(gadgetId) ?? [])
}

function row(generation: number, revision: number, change: CodeChange,
             submission?: { clientId: string; seq: number }): ChatChangeRow {
  return {
    generation, revision, change,
    author: submission ? AUTHOR : OTHER,
    ...(submission !== undefined ? { submission } : {}),
  }
}

describe('ChatOtClient', () => {
  it('builds content from pin bases, the epoch change, and rows', async () => {
    const h = new TestHarness()
    h.commits.set('c1', new Map([['a.txt', 'abc']]))
    h.client.setDurableState({
      codeBase: {
        pins: [{ gadgetId: 1, baseCommit: 'c1', mergedCommit: 'c1' }],
        generation: 0, revision: 2,
      },
      epochChange: { 1: [['a.txt', { edit: [3, [0, '!']] }]] },  // append "!"
      rowsThrough: 1,
    })
    h.client.pushRow(row(0, 2, { 1: [['b.txt', { set: 'new' }]] }))
    await flush()

    expect(h.client.isReady()).toBe(true)
    expect(filesOf(h.client.getContent(), 1)).toEqual({ 'a.txt': 'abc!', 'b.txt': 'new' })
  })

  it('ignores duplicate rows (subscribe-replay)', async () => {
    const h = new TestHarness()
    h.client.setDurableState({ rowsThrough: 0 })
    h.client.setPendingCreations(new Set([1]))  // gadget 1 is chat-created: no pin needed
    const r = row(0, 1, { 1: [['a.txt', { set: 'x' }]] })
    h.client.pushRow(r)
    h.client.pushRow(row(0, 1, { 1: [['a.txt', { set: 'CLOBBER' }]] }))  // same revision
    h.client.pushRow(row(0, 2, { 1: [['a.txt', { edit: [1, [0, 'y']] }]] }))
    await flush()

    expect(filesOf(h.client.getContent(), 1)).toEqual({ 'a.txt': 'xy' })
  })

  it('submits local edits with a first-keystroke pin declaration and applies the echo', async () => {
    const h = new TestHarness()
    h.commits.set('head', new Map([['a.txt', 'abc']]))
    h.client.setDurableState({ rowsThrough: 0 })
    await flush()

    h.client.ensureGadgetEditable(1, 'head', new Map([['a.txt', 'abc']]))
    h.client.applyLocalChange({ 1: [['a.txt', { edit: [3, [0, 'd']] }]] })  // append "d"
    expect(filesOf(h.client.getContent(), 1)).toEqual({ 'a.txt': 'abcd' })

    // Hold the RPC response so the echo row (which precedes it in reality) does the clearing.
    h.submitResult = () => new Promise(() => {})
    await flush()
    expect(h.submissions).toHaveLength(1)
    const submission = h.submissions[0]
    expect(submission.seq).toBe(1)
    expect(submission.generation).toBe(0)
    expect(submission.revision).toBe(0)
    expect(submission.pins).toEqual([{ gadgetId: 1, baseCommit: 'head' }])
    expect(h.client.hasLocalEdits()).toBe(true)

    // The echo row (recognized by clientId/seq) folds the change into acked state.
    h.remoteEvents.length = 0
    h.client.setDurableState({
      codeBase: {
        pins: [{ gadgetId: 1, baseCommit: 'head', mergedCommit: 'head' }],
        generation: 0, revision: 1,
      },
      rowsThrough: 0,
    })
    h.client.pushRow(row(0, 1, submission.change,
                         { clientId: submission.clientId, seq: submission.seq }))
    await flush()
    expect(h.client.hasLocalEdits()).toBe(false)
    expect(filesOf(h.client.getContent(), 1)).toEqual({ 'a.txt': 'abcd' })
    // The echo changes nothing displayed, so it must deliver no notification at all -- in
    // particular not an empty events array, which means a coarse change and would make the code
    // view rebuild its open editors (dropping focus and selection) after every acked keystroke.
    expect(h.remoteEvents).toEqual([])

    // The same holds for a subsequent keystroke's echo, once the gadget's content is acked.
    h.client.applyLocalChange({ 1: [['a.txt', { edit: [4, [0, 'e']] }]] })
    await flush()
    expect(h.submissions).toHaveLength(2)
    const second = h.submissions[1]
    h.client.pushRow(row(0, 2, second.change,
                         { clientId: second.clientId, seq: second.seq }))
    await flush()
    expect(h.client.hasLocalEdits()).toBe(false)
    expect(filesOf(h.client.getContent(), 1)).toEqual({ 'a.txt': 'abcde' })
    expect(h.remoteEvents).toEqual([])
  })

  it('stays silent on a remote row whose transformed form changes nothing displayed', async () => {
    const h = new TestHarness()
    h.commits.set('c1', new Map([['a.txt', 'abc']]))
    h.client.setDurableState({
      codeBase: {
        pins: [{ gadgetId: 1, baseCommit: 'c1', mergedCommit: 'c1' }],
        generation: 0, revision: 0,
      },
      rowsThrough: 0,
    })
    await flush()
    h.remoteEvents.length = 0

    // Our own remove is in flight when another author's identical remove lands first.
    h.submitResult = () => new Promise(() => {})
    h.client.applyLocalChange({ 1: [['a.txt', { remove: true }]] })
    await flush()
    expect(h.submissions).toHaveLength(1)

    // The row transforms to a display no-op (remove vs remove: the earlier writer's side is
    // dropped): no notification -- especially not an empty (coarse) one, which would rebuild
    // open editors.
    h.client.pushRow(row(0, 1, { 1: [['a.txt', { remove: true }]] }))
    await flush()
    expect(h.remoteEvents).toEqual([])
    expect(filesOf(h.client.getContent(), 1)).toEqual({})
  })

  it('clears an accepted submission from the ack alone when its echo row never arrives', async () => {
    const h = new TestHarness()
    h.commits.set('head', new Map([['a.txt', 'abc']]))
    h.client.setDurableState({ rowsThrough: 0 })
    await flush()

    // The submission is accepted, but its broadcast row is never delivered (e.g. it was
    // materialized while the client was disconnected, so no replay carries it).
    h.submitResult = async () => ({ generation: 0, revision: 1 })
    h.client.ensureGadgetEditable(1, 'head', new Map([['a.txt', 'abc']]))
    h.client.applyLocalChange({ 1: [['a.txt', { edit: [3, [0, 'd']] }]] })
    await flush()

    expect(h.submissions).toHaveLength(1)
    expect(h.client.hasLocalEdits()).toBe(false)
    expect(filesOf(h.client.getContent(), 1)).toEqual({ 'a.txt': 'abcd' })

    // The next local edit submits normally at the advanced stream position.
    h.submitResult = async () => ({ generation: 0, revision: 2 })
    h.client.applyLocalChange({ 1: [['a.txt', { edit: [4, [0, 'e']] }]] })
    await flush()
    expect(h.submissions).toHaveLength(2)
    expect(h.submissions[1].revision).toBe(1)
    expect(h.submissions[1].seq).toBe(2)
    expect(h.client.hasLocalEdits()).toBe(false)
    expect(filesOf(h.client.getContent(), 1)).toEqual({ 'a.txt': 'abcde' })
  })

  it('rebuilds immediately when a watermark outruns the stream and nothing local is at risk', async () => {
    const h = new TestHarness()
    h.client.setDurableState({ rowsThrough: 0 })
    h.client.setPendingCreations(new Set([1]))  // gadget 1 is chat-created: no pin needed
    h.client.pushRow(row(0, 1, { 1: [['a.txt', { set: 'x' }]] }))
    await flush()
    expect(filesOf(h.client.getContent(), 1)).toEqual({ 'a.txt': 'x' })

    // Rows 2..3 were materialized without ever being delivered: the snapshot's epochChange covers
    // them, and with no local edits at risk the client rebuilds right away -- no stall, no
    // discard notice.
    h.client.setDurableState({
      codeBase: { pins: [], generation: 0, revision: 3 },
      epochChange: { 1: [['a.txt', { set: 'xyz' }]] },
      rowsThrough: 3,
    })
    await flush()
    expect(filesOf(h.client.getContent(), 1)).toEqual({ 'a.txt': 'xyz' })
    expect(h.discards).toBe(0)

    // The stream continues past the rebuilt position.
    h.client.pushRow(row(0, 4, { 1: [['a.txt', { edit: [3, [0, '!']] }]] }))
    await flush()
    expect(filesOf(h.client.getContent(), 1)).toEqual({ 'a.txt': 'xyz!' })
  })

  it('holds a watermark gap open while unacknowledged local edits are at risk', async () => {
    const h = new TestHarness()
    h.client.setDurableState({ rowsThrough: 0 })
    h.client.setPendingCreations(new Set([1]))
    h.client.pushRow(row(0, 1, { 1: [['a.txt', { set: 'x' }]] }))
    await flush()

    // An unacknowledged local edit is in flight when a watermark outruns the stream.
    h.submitResult = () => new Promise(() => {})
    h.client.applyLocalChange({ 1: [['a.txt', { edit: [1, [0, 'L']] }]] })
    await flush()
    h.client.setDurableState({
      codeBase: { pins: [], generation: 0, revision: 2 },
      epochChange: { 1: [['a.txt', { set: 'xy' }]] },
      rowsThrough: 2,
    })
    await flush(50)

    // Within the grace period nothing is rebuilt or discarded: the missing row may still be in
    // flight, and rebuilding now would drop the local edit.
    expect(h.discards).toBe(0)
    expect(h.client.hasLocalEdits()).toBe(true)
    expect(filesOf(h.client.getContent(), 1)).toEqual({ 'a.txt': 'xL' })

    // The missing row arrives (the local edit rebases over it): the gap closes normally.
    h.client.pushRow(row(0, 2, { 1: [['a.txt', { edit: [1, [0, 'y']] }]] }))
    await flush()
    expect(h.discards).toBe(0)
    expect(filesOf(h.client.getContent(), 1)).toEqual({ 'a.txt': 'xyL' })
    h.client.dispose()  // cancel the pending stall-recheck timer
  })

  it('transforms in-flight and pending edits over remote rows, converging with the server', async () => {
    const h = new TestHarness()
    h.commits.set('head', new Map([['a.txt', 'abc']]))
    h.client.setDurableState({
      codeBase: {
        pins: [{ gadgetId: 1, baseCommit: 'head', mergedCommit: 'head' }],
        generation: 0, revision: 0,
      },
      rowsThrough: 0,
    })
    await flush()

    // Local: insert "X" at the start. Hold the ack so the change stays in flight.
    let releaseSubmit: () => void = () => {}
    h.submitResult = () => new Promise(resolve => {
      releaseSubmit = () => resolve({ generation: 0, revision: 2 })
    })
    h.client.applyLocalChange({ 1: [['a.txt', { edit: [[0, 'X'], 3] }]] })
    await flush()
    expect(h.submissions).toHaveLength(1)
    const local = h.submissions[0]

    // A remote row (ordered first by the server): append "Y".
    const remote: CodeChange = { 1: [['a.txt', { edit: [3, [0, 'Y']] }]] }
    h.client.pushRow(row(0, 1, remote))
    await flush()
    expect(filesOf(h.client.getContent(), 1)).toEqual({ 'a.txt': 'XabcY' })

    // The server transforms the in-flight change over the remote row and broadcasts the result.
    const serverSide = transformCodeChange(remote, local.change).b
    h.client.pushRow(row(0, 2, serverSide, { clientId: local.clientId, seq: local.seq }))
    releaseSubmit()
    await flush()

    expect(h.client.hasLocalEdits()).toBe(false)
    // Server-side content: base + remote + transformed local == our display.
    const base: CodeContent = new Map([[1, new Map([['a.txt', 'abc']])]])
    const serverContent = applyCodeChange(applyCodeChange(base, remote), serverSide)
    expect(filesOf(h.client.getContent(), 1)).toEqual(filesOf(serverContent, 1))
  })

  it('treats a materialization watermark as covered content, not a change', async () => {
    const h = new TestHarness()
    h.client.setDurableState({ rowsThrough: 0 })
    h.client.setPendingCreations(new Set([1]))  // gadget 1 is chat-created: no pin needed
    h.client.pushRow(row(0, 1, { 1: [['a.txt', { set: 'x' }]] }))
    await flush()

    // The row materializes into a message: same content, expressed durably.
    h.client.setDurableState({
      codeBase: { pins: [], generation: 0, revision: 1 },
      epochChange: { 1: [['a.txt', { set: 'x' }]] },
      rowsThrough: 1,
    })
    await flush()

    expect(h.discards).toBe(0)
    expect(filesOf(h.client.getContent(), 1)).toEqual({ 'a.txt': 'x' })
  })

  it('discards local edits and rebuilds on a destructive generation bump', async () => {
    const h = new TestHarness()
    h.commits.set('head', new Map([['a.txt', 'abc']]))
    h.client.setDurableState({ rowsThrough: 0 })
    await flush()
    h.submitResult = () => new Promise(() => {})  // never acked
    h.client.ensureGadgetEditable(1, 'head', new Map([['a.txt', 'abc']]))
    h.client.applyLocalChange({ 1: [['a.txt', { edit: [3, [0, 'd']] }]] })
    await flush()

    // A revert: generation bumps with no `prior`.
    h.client.setDurableState({
      codeBase: { pins: [], generation: 1, revision: 0 },
      rowsThrough: 0,
    })
    await flush()

    expect(h.discards).toBe(1)
    expect(h.client.hasLocalEdits()).toBe(false)
    expect(h.client.hasGadget(1)).toBe(false)
  })

  it('rides a content-preserving epoch reset, bridging the pending buffer', async () => {
    const h = new TestHarness()
    h.commits.set('head', new Map([['a.txt', 'abc']]))
    h.client.setDurableState({
      codeBase: {
        pins: [{ gadgetId: 1, baseCommit: 'head', mergedCommit: 'head' }],
        generation: 0, revision: 1,
      },
      epochChange: { 1: [['a.txt', { edit: [3, [0, 'd']] }]] },
      rowsThrough: 1,
    })
    await flush()
    expect(filesOf(h.client.getContent(), 1)).toEqual({ 'a.txt': 'abcd' })

    // Local typing continues right as someone accepts the chat's changes.
    h.submitResult = () => new Promise(() => {})  // in flight across the boundary
    h.client.applyLocalChange({ 1: [['a.txt', { edit: [4, [0, 'e']] }]] })
    await flush()
    expect(h.submissions).toHaveLength(1)
    expect(h.submissions[0].generation).toBe(0)

    // The merge closes generation 0 at its final revision 1 (all rows drained).
    h.client.setDurableState({
      codeBase: {
        pins: [], generation: 1, revision: 0,
        prior: { generation: 0, finalRevision: 1, discontinuousGadgets: [] },
      },
      rowsThrough: 0,
    })
    await flush()

    // Nothing was discarded: content carried across for the touched gadget, and the in-flight
    // submission rides the server's straggler bridge under its old-generation claim.
    expect(h.discards).toBe(0)
    expect(filesOf(h.client.getContent(), 1)).toEqual({ 'a.txt': 'abcde' })

    // The bridged echo lands in the new generation, re-pinning the gadget at the merge's head.
    h.commits.set('head2', new Map([['a.txt', 'abcd']]))
    h.client.setDurableState({
      codeBase: {
        pins: [{ gadgetId: 1, baseCommit: 'head2', mergedCommit: 'head2' }],
        generation: 1, revision: 1,
        prior: { generation: 0, finalRevision: 1, discontinuousGadgets: [] },
      },
      rowsThrough: 0,
    })
    h.client.pushRow(row(1, 1, h.submissions[0].change,
                         { clientId: h.submissions[0].clientId, seq: h.submissions[0].seq }))
    await flush()
    expect(h.client.hasLocalEdits()).toBe(false)
    expect(filesOf(h.client.getContent(), 1)).toEqual({ 'a.txt': 'abcde' })
  })

  it('submits a pending-only buffer under the closing generation at an epoch reset', async () => {
    const h = new TestHarness()
    h.commits.set('head', new Map([['a.txt', 'abc']]))
    h.client.setDurableState({
      codeBase: {
        pins: [{ gadgetId: 1, baseCommit: 'head', mergedCommit: 'head' }],
        generation: 0, revision: 1,
      },
      epochChange: { 1: [['a.txt', { edit: [3, [0, 'd']] }]] },
      rowsThrough: 1,
    })
    await flush()

    // Type... but block the submission from leaving until after the merge lands, so the edit
    // is still a pending (never-submitted) buffer at switch time.
    h.submitResult = () => new Promise(() => {})
    h.client.applyLocalChange({ 1: [['a.txt', { edit: [4, [0, 'e']] }]] })
    h.client.setDurableState({
      codeBase: {
        pins: [], generation: 1, revision: 0,
        prior: { generation: 0, finalRevision: 1, discontinuousGadgets: [] },
      },
      rowsThrough: 0,
    })
    await flush()

    // The buffer rides the straggler bridge: the submission claims the *closed* generation
    // (whose boundary map lets the server derive the pin), never the pinless new epoch.
    expect(h.discards).toBe(0)
    expect(h.submissions).toHaveLength(1)
    expect(h.submissions[0].generation).toBe(0)
    expect(h.submissions[0].revision).toBe(1)
    expect(h.submissions[0].pins).toBeUndefined()
    expect(filesOf(h.client.getContent(), 1)).toEqual({ 'a.txt': 'abcde' })
  })

  it('drops pending changes touching discontinuous gadgets at an epoch reset', async () => {
    const h = new TestHarness()
    h.commits.set('h1', new Map([['a.txt', 'abc']]))
    h.commits.set('h2', new Map([['b.txt', 'xyz']]))
    h.client.setDurableState({
      codeBase: {
        pins: [
          { gadgetId: 1, baseCommit: 'h1', mergedCommit: 'h1' },
          { gadgetId: 2, baseCommit: 'h2', mergedCommit: 'h2' },
        ],
        generation: 0, revision: 0,
      },
      rowsThrough: 0,
    })
    await flush()
    h.submitResult = () => new Promise(() => {})
    h.client.applyLocalChange({ 2: [['b.txt', { edit: [3, [0, 'w']] }]] })
    await flush()  // the gadget-2 edit is now in flight...
    // ...so this gadget-1 edit stays pending behind it.
    h.client.applyLocalChange({ 1: [['a.txt', { edit: [3, [0, 'd']] }]] })
    await flush()

    // Gadget 1's pin evaporated with content differing from head: bridge-ineligible.
    h.client.setDurableState({
      codeBase: {
        pins: [], generation: 1, revision: 0,
        prior: { generation: 0, finalRevision: 0, discontinuousGadgets: [1] },
      },
      rowsThrough: 0,
    })
    await flush()

    // The pending changes on the discontinuous gadget were dropped proactively (the server would
    // reject them as bridge-ineligible); the clean in-flight edit carried across.
    expect(h.discards).toBe(1)
    expect(h.client.hasGadget(1)).toBe(false)
    expect(filesOf(h.client.getContent(), 2)).toEqual({ 'b.txt': 'xyzw' })
  })

  it('discards local edits when the epoch reset marks an in-flight gadget discontinuous', async () => {
    const h = new TestHarness()
    h.commits.set('head', new Map([['a.txt', 'abc']]))
    h.client.setDurableState({
      codeBase: {
        pins: [{ gadgetId: 1, baseCommit: 'head', mergedCommit: 'head' }],
        generation: 0, revision: 0,
      },
      rowsThrough: 0,
    })
    await flush()
    h.submitResult = () => new Promise(() => {})
    h.client.applyLocalChange({ 1: [['a.txt', { edit: [3, [0, 'd']] }]] })
    await flush()

    h.client.setDurableState({
      codeBase: {
        pins: [], generation: 1, revision: 0,
        prior: { generation: 0, finalRevision: 0, discontinuousGadgets: [1] },
      },
      rowsThrough: 0,
    })
    await flush()

    // The in-flight submission is doomed (the server rejects it as bridge-ineligible) and its
    // content basis is gone: the client discards and rebuilds rather than wedging.
    expect(h.discards).toBe(1)
    expect(h.client.hasLocalEdits()).toBe(false)
    expect(h.client.hasGadget(1)).toBe(false)
  })

  it('retries a transiently-failing submission with the same seq and payload', async () => {
    const h = new TestHarness()
    h.commits.set('head', new Map([['a.txt', 'abc']]))
    h.client.setDurableState({ rowsThrough: 0 })
    await flush()

    let attempts = 0
    let resolveDone: () => void = () => {}
    const done = new Promise<void>(resolve => { resolveDone = resolve })
    h.submitResult = async () => {
      attempts++
      if (attempts === 1) throw new Error('transient')
      resolveDone()
      return { generation: 0, revision: 1 }
    }
    h.client.ensureGadgetEditable(1, 'head', new Map([['a.txt', 'abc']]))
    h.client.applyLocalChange({ 1: [['a.txt', { edit: [3, [0, 'd']] }]] })
    await flush()
    expect(h.dirty).toContain(true)
    await done  // the retry (after backoff) succeeds

    expect(attempts).toBe(2)
    expect(h.submissions).toHaveLength(2)
    expect(h.submissions[1]).toEqual(h.submissions[0])
    expect(h.submissions[1].seq).toBe(1)
  }, 10_000)

  it('discards local edits on a hard rejection and rebuilds under a fresh clientId', async () => {
    const h = new TestHarness()
    h.commits.set('head', new Map([['a.txt', 'abc']]))
    h.client.setDurableState({ rowsThrough: 0 })
    await flush()

    h.submitResult = async () => { throw new Error('pin conflict') }
    h.client.ensureGadgetEditable(1, 'head', new Map([['a.txt', 'abc']]))
    h.client.applyLocalChange({ 1: [['a.txt', { edit: [3, [0, 'd']] }]] })
    await flush()
    expect(h.discards).toBe(1)
    expect(h.client.hasGadget(1)).toBe(false)

    // The next local edit starts a fresh client session.
    h.submitResult = async () => ({ generation: 0, revision: 1 })
    h.client.ensureGadgetEditable(1, 'head', new Map([['a.txt', 'abc']]))
    h.client.applyLocalChange({ 1: [['a.txt', { edit: [3, [0, 'x']] }]] })
    await flush()
    expect(h.submissions).toHaveLength(2)
    expect(h.submissions[1].clientId).not.toBe(h.submissions[0].clientId)
    expect(h.submissions[1].seq).toBe(1)
  })

  it('holds rows that outrun the metadata pin and applies them once it arrives', async () => {
    const h = new TestHarness()
    h.commits.set('c1', new Map([['a.txt', 'abc']]))
    h.client.setDurableState({ rowsThrough: 0 })
    // Another client's first edit: the row can arrive around its pin's metadata.
    h.client.pushRow(row(0, 1, { 1: [['a.txt', { edit: [3, [0, '!']] }]] }))
    await flush()
    expect(h.client.hasGadget(1)).toBe(false)  // held: no pin known yet

    h.client.setDurableState({
      codeBase: {
        pins: [{ gadgetId: 1, baseCommit: 'c1', mergedCommit: 'c1' }],
        generation: 0, revision: 1,
      },
      rowsThrough: 0,
    })
    await flush()
    expect(filesOf(h.client.getContent(), 1)).toEqual({ 'a.txt': 'abc!' })
  })
})
