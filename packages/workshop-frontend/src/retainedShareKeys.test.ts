// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import {
  beginRetainedShareKeyWrite, clearAllRetainedShareKeys, clearRetainedShareKey,
  commitRetainedShareKeyWrite, readRetainedShareKey,
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
