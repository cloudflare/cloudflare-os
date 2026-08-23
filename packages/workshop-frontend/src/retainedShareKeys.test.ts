// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  beginRetainedShareKeyWrite, clearAllRetainedShareKeys, clearRetainedShareKey,
  commitRetainedShareKeyWrite, readRetainedShareKey, RETAINED_SHARE_KEY_TTL_MS,
} from './retainedShareKeys'

const ENTRY = { key: 'deadbeef', userId: 'person@example.com', captureId: 'capture-1' }

describe('retained share key write tokens', () => {
  afterEach(() => sessionStorage.clear())

  it('commits a write whose generations are undisturbed', () => {
    const token = beginRetainedShareKeyWrite('ws-1', ENTRY.captureId)
    commitRetainedShareKeyWrite(token, ENTRY)
    expect(readRetainedShareKey('ws-1')).toEqual(ENTRY)
  })

  it('reads an entry without a capture id as absent', () => {
    // Not a migration concern (the v2 format never shipped without one); just the shape check
    // holding the line so no clear path has to reason about ownerless entries.
    sessionStorage.setItem('gadgets:retained-share-key:v2:ws-1',
        JSON.stringify({ key: ENTRY.key, userId: ENTRY.userId }))
    expect(readRetainedShareKey('ws-1')).toBeUndefined()
  })

  // The stamp is asynchronous (identity resolves after the open is issued), so a success or a
  // logout can clear storage while a stamp is still in flight. The clear must win permanently:
  // a resurrected entry re-redeems a link its owner may since have revoked the recipient from,
  // and after logout it would sit waiting for the tab's next user.
  it('a workspace clear voids an in-flight write for that workspace only', () => {
    const cleared = beginRetainedShareKeyWrite('ws-1', ENTRY.captureId)
    const other = beginRetainedShareKeyWrite('ws-2', ENTRY.captureId)
    clearRetainedShareKey('ws-1')
    commitRetainedShareKeyWrite(cleared, ENTRY)
    commitRetainedShareKeyWrite(other, ENTRY)
    expect(readRetainedShareKey('ws-1')).toBeUndefined()
    expect(readRetainedShareKey('ws-2')).toEqual(ENTRY)
  })

  it("a workspace clear voids every capture's in-flight stamp", () => {
    const stampA = beginRetainedShareKeyWrite('ws-1', 'capture-a')
    const stampB = beginRetainedShareKeyWrite('ws-1', 'capture-b')
    clearRetainedShareKey('ws-1')
    commitRetainedShareKeyWrite(stampA,
        { key: 'aaaa', userId: 'person@example.com', captureId: 'capture-a' })
    commitRetainedShareKeyWrite(stampB,
        { key: 'bbbb', userId: 'person@example.com', captureId: 'capture-b' })
    expect(readRetainedShareKey('ws-1')).toBeUndefined()
  })

  it('the logout sweep voids every in-flight write', () => {
    const token = beginRetainedShareKeyWrite('ws-1', ENTRY.captureId)
    clearAllRetainedShareKeys()
    commitRetainedShareKeyWrite(token, ENTRY)
    expect(readRetainedShareKey('ws-1')).toBeUndefined()
  })
})

// An attempt whose keyed open the server confirmed clears exactly its own retention, even after
// being superseded. `onlyCapture` is what scopes the clear: the named capture's in-flight stamp
// is always voided (it stamps the confirmed key, and its late landing would resurrect it), while
// a stored entry carrying a different capture id belongs to a newer capture and must survive
// untouched -- entry and in-flight stamp both -- even when that newer capture holds the same key.
describe('attempt-owned clears (onlyCapture)', () => {
  afterEach(() => sessionStorage.clear())

  it('a matching-capture clear removes the entry and voids a pending write', () => {
    const stamp = beginRetainedShareKeyWrite('ws-1', ENTRY.captureId)
    commitRetainedShareKeyWrite(beginRetainedShareKeyWrite('ws-1', ENTRY.captureId), ENTRY)
    clearRetainedShareKey('ws-1', ENTRY.captureId)
    expect(readRetainedShareKey('ws-1')).toBeUndefined()
    // A late-landing stamp for the same attempt must not resurrect the confirmed key.
    commitRetainedShareKeyWrite(stamp, ENTRY)
    expect(readRetainedShareKey('ws-1')).toBeUndefined()
  })

  it("a different-capture clear neither removes the entry nor voids that capture's writes", () => {
    const newerEntry = { key: 'cafe', userId: 'person@example.com', captureId: 'capture-2' }
    const newerStamp = beginRetainedShareKeyWrite('ws-1', newerEntry.captureId)
    commitRetainedShareKeyWrite(
        beginRetainedShareKeyWrite('ws-1', newerEntry.captureId), newerEntry)
    clearRetainedShareKey('ws-1', 'capture-1')
    // The newer capture's entry survives, and so does its license to (re)write: no bump landed
    // on its capture.
    expect(readRetainedShareKey('ws-1')).toEqual(newerEntry)
    commitRetainedShareKeyWrite(newerStamp, newerEntry)
    expect(readRetainedShareKey('ws-1')).toEqual(newerEntry)
  })

  it("a same-key later capture survives the earlier capture's clear, stamp and all", () => {
    // The same invite link clicked twice in one tab: user A's disposed open of key K resolves
    // *after* user B captured the very same K. A's success clear owns only A's capture -- if it
    // cleared by raw key it would erase B's entry and void B's in-flight stamp, dead-ending B's
    // retry on the access-denied page.
    const entryB = { key: 'deadbeef', userId: 'other@example.com', captureId: 'capture-b' }
    const stampB = beginRetainedShareKeyWrite('ws-1', entryB.captureId)
    commitRetainedShareKeyWrite(beginRetainedShareKeyWrite('ws-1', entryB.captureId), entryB)
    clearRetainedShareKey('ws-1', 'capture-a')
    expect(readRetainedShareKey('ws-1')).toEqual(entryB)
    // B's still-in-flight stamp keeps its license too.
    commitRetainedShareKeyWrite(stampB, entryB)
    expect(readRetainedShareKey('ws-1')).toEqual(entryB)
  })

  it("a different-capture clear still voids the cleared capture's own in-flight stamp", () => {
    // Attempt A (capture-a) was confirmed by the server but its identity stamp is still in
    // flight; a newer attempt B (capture-b) already occupies the entry. A's clear must no-op on
    // B's entry yet void A's own stamp -- otherwise the stamp lands late, overwrites B's entry
    // with A's *confirmed* key, and a replay re-redeems it after an owner removal.
    const stampA = beginRetainedShareKeyWrite('ws-1', 'capture-a')
    const entryB = { key: 'bbbb', userId: 'other@example.com', captureId: 'capture-b' }
    commitRetainedShareKeyWrite(beginRetainedShareKeyWrite('ws-1', 'capture-b'), entryB)
    clearRetainedShareKey('ws-1', 'capture-a')
    expect(readRetainedShareKey('ws-1')).toEqual(entryB)
    commitRetainedShareKeyWrite(stampA,
        { key: 'aaaa', userId: 'person@example.com', captureId: 'capture-a' })
    expect(readRetainedShareKey('ws-1')).toEqual(entryB)
  })

  it("a different capture's stamp survives an onlyCapture clear even with the entry absent", () => {
    // The clear is scoped to its own capture's generation, so a concurrent newer attempt whose
    // stamp is still in flight keeps its license even when nothing is stored yet.
    const stampB = beginRetainedShareKeyWrite('ws-1', 'capture-b')
    clearRetainedShareKey('ws-1', 'capture-a')
    const entryB = { key: 'bbbb', userId: 'person@example.com', captureId: 'capture-b' }
    commitRetainedShareKeyWrite(stampB, entryB)
    expect(readRetainedShareKey('ws-1')).toEqual(entryB)
  })

  it('an absent-entry clear with onlyCapture still voids a pending write', () => {
    // The absence may be the clearing attempt's own stamp still in flight; letting it land would
    // resurrect a key the server already confirmed.
    const stamp = beginRetainedShareKeyWrite('ws-1', ENTRY.captureId)
    clearRetainedShareKey('ws-1', ENTRY.captureId)
    commitRetainedShareKeyWrite(stamp, ENTRY)
    expect(readRetainedShareKey('ws-1')).toBeUndefined()
  })
})

// A duplicated tab copies sessionStorage, so an entry cleared in the original tab can survive in
// the copy. The TTL bounds how long such a copy stays honored.
describe('entry expiry', () => {
  afterEach(() => {
    sessionStorage.clear()
    vi.useRealTimers()
  })

  it('honors a fresh entry and expires (and removes) a stale one', () => {
    vi.useFakeTimers()
    commitRetainedShareKeyWrite(beginRetainedShareKeyWrite('ws-1', ENTRY.captureId), ENTRY)
    expect(readRetainedShareKey('ws-1')).toEqual(ENTRY)
    vi.advanceTimersByTime(RETAINED_SHARE_KEY_TTL_MS + 1)
    expect(readRetainedShareKey('ws-1')).toBeUndefined()
    // Removed rather than left to be re-judged on every read.
    expect(sessionStorage.getItem('gadgets:retained-share-key:v2:ws-1')).toBeNull()
  })

  it('reads an entry without a stamp time as absent and removes it', () => {
    sessionStorage.setItem('gadgets:retained-share-key:v2:ws-1', JSON.stringify(ENTRY))
    expect(readRetainedShareKey('ws-1')).toBeUndefined()
    expect(sessionStorage.getItem('gadgets:retained-share-key:v2:ws-1')).toBeNull()
  })
})

// Clears are broadcast so a duplicated tab's copied entry (which shares the original's
// captureId) is cleared the moment the original spends its key. Node >= 18 provides
// BroadcastChannel in the vitest process, so these run against the real channel.
describe('cross-tab clear propagation', () => {
  let channel: BroadcastChannel | undefined

  afterEach(() => {
    channel?.close()
    channel = undefined
    sessionStorage.clear()
  })

  function openSiblingChannel(): BroadcastChannel {
    const sibling = new BroadcastChannel('gadgets:retained-share-keys');
    // Match the module's unref so a test failure can't wedge the process either.
    (sibling as { unref?: () => void }).unref?.()
    channel = sibling
    return sibling
  }

  // BroadcastChannel.postMessage takes no targetOrigin; the unicorn rule is written for
  // window.postMessage.
  function post(sibling: BroadcastChannel, message: unknown): void {
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    sibling.postMessage(message)
  }

  it('a received capture clear removes the matching entry and voids its stamp', async () => {
    const stamp = beginRetainedShareKeyWrite('ws-1', ENTRY.captureId)
    commitRetainedShareKeyWrite(beginRetainedShareKeyWrite('ws-1', ENTRY.captureId), ENTRY)
    post(openSiblingChannel(),
        { type: 'clear-capture', workspaceId: 'ws-1', captureId: ENTRY.captureId })
    await vi.waitFor(() => expect(readRetainedShareKey('ws-1')).toBeUndefined())
    // The broadcast also voids the capture's in-flight stamp, like a local clear would.
    commitRetainedShareKeyWrite(stamp, ENTRY)
    expect(readRetainedShareKey('ws-1')).toBeUndefined()
  })

  it('a received capture clear leaves a different capture untouched', async () => {
    // ws-1 holds an independent sibling capture; ws-2 holds a sentinel entry whose clear-out
    // proves the earlier (non-matching) message was already processed, since delivery is FIFO.
    commitRetainedShareKeyWrite(beginRetainedShareKeyWrite('ws-1', ENTRY.captureId), ENTRY)
    const sentinel = { key: 'cafe', userId: ENTRY.userId, captureId: 'capture-sentinel' }
    commitRetainedShareKeyWrite(beginRetainedShareKeyWrite('ws-2', sentinel.captureId), sentinel)
    const sibling = openSiblingChannel()
    post(sibling, { type: 'clear-capture', workspaceId: 'ws-1', captureId: 'capture-other' })
    post(sibling, { type: 'clear-capture', workspaceId: 'ws-2', captureId: sentinel.captureId })
    await vi.waitFor(() => expect(readRetainedShareKey('ws-2')).toBeUndefined())
    expect(readRetainedShareKey('ws-1')).toEqual(ENTRY)
  })

  it('a received clear-all sweeps the entries and voids every in-flight write', async () => {
    const stamp = beginRetainedShareKeyWrite('ws-1', ENTRY.captureId)
    commitRetainedShareKeyWrite(beginRetainedShareKeyWrite('ws-1', ENTRY.captureId), ENTRY)
    post(openSiblingChannel(), { type: 'clear-all' })
    await vi.waitFor(() => expect(readRetainedShareKey('ws-1')).toBeUndefined())
    commitRetainedShareKeyWrite(stamp, ENTRY)
    expect(readRetainedShareKey('ws-1')).toBeUndefined()
  })

  it('a malformed message is ignored', async () => {
    commitRetainedShareKeyWrite(beginRetainedShareKeyWrite('ws-1', ENTRY.captureId), ENTRY)
    const sentinel = { key: 'cafe', userId: ENTRY.userId, captureId: 'capture-sentinel' }
    commitRetainedShareKeyWrite(beginRetainedShareKeyWrite('ws-2', sentinel.captureId), sentinel)
    const sibling = openSiblingChannel()
    post(sibling, { type: 'clear-capture', workspaceId: 'ws-1' })
    post(sibling, 'clear-all')
    post(sibling, { type: 'clear-capture', workspaceId: 'ws-2', captureId: sentinel.captureId })
    await vi.waitFor(() => expect(readRetainedShareKey('ws-2')).toBeUndefined())
    expect(readRetainedShareKey('ws-1')).toEqual(ENTRY)
  })

  it('broadcasts exactly the capture-scoped clears and the logout sweep', async () => {
    const received: unknown[] = []
    openSiblingChannel().addEventListener('message', event => received.push(event.data))
    // Workspace-scoped clears stay local: they name no capture, and blanket-clearing sibling
    // tabs could erase an independent capture that is still legitimately retrying.
    clearRetainedShareKey('ws-1')
    clearRetainedShareKey('ws-1', 'capture-1')
    clearAllRetainedShareKeys()
    await vi.waitFor(() => expect(received).toHaveLength(2))
    expect(received).toEqual([
      { type: 'clear-capture', workspaceId: 'ws-1', captureId: 'capture-1' },
      { type: 'clear-all' },
    ])
  })
})
