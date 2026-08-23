// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import {
  beginRetainedShareKeyWrite, clearAllRetainedShareKeys, clearRetainedShareKey,
  commitRetainedShareKeyWrite, readRetainedShareKey,
} from './retainedShareKeys'

const ENTRY = { key: 'deadbeef', userId: 'person@example.com' }

describe('retained share key write tokens', () => {
  afterEach(() => sessionStorage.clear())

  it('commits a write whose generations are undisturbed', () => {
    const token = beginRetainedShareKeyWrite('ws-1', ENTRY.key)
    commitRetainedShareKeyWrite(token, ENTRY)
    expect(readRetainedShareKey('ws-1')).toEqual(ENTRY)
  })

  // The stamp is asynchronous (identity resolves after the open is issued), so a success or a
  // logout can clear storage while a stamp is still in flight. The clear must win permanently:
  // a resurrected entry re-redeems a link its owner may since have revoked the recipient from,
  // and after logout it would sit waiting for the tab's next user.
  it('a workspace clear voids an in-flight write for that workspace only', () => {
    const cleared = beginRetainedShareKeyWrite('ws-1', ENTRY.key)
    const other = beginRetainedShareKeyWrite('ws-2', ENTRY.key)
    clearRetainedShareKey('ws-1')
    commitRetainedShareKeyWrite(cleared, ENTRY)
    commitRetainedShareKeyWrite(other, ENTRY)
    expect(readRetainedShareKey('ws-1')).toBeUndefined()
    expect(readRetainedShareKey('ws-2')).toEqual(ENTRY)
  })

  it("a workspace clear voids every key's in-flight stamp", () => {
    const stampA = beginRetainedShareKeyWrite('ws-1', 'aaaa')
    const stampB = beginRetainedShareKeyWrite('ws-1', 'bbbb')
    clearRetainedShareKey('ws-1')
    commitRetainedShareKeyWrite(stampA, { key: 'aaaa', userId: 'person@example.com' })
    commitRetainedShareKeyWrite(stampB, { key: 'bbbb', userId: 'person@example.com' })
    expect(readRetainedShareKey('ws-1')).toBeUndefined()
  })

  it('the logout sweep voids every in-flight write', () => {
    const token = beginRetainedShareKeyWrite('ws-1', ENTRY.key)
    clearAllRetainedShareKeys()
    commitRetainedShareKeyWrite(token, ENTRY)
    expect(readRetainedShareKey('ws-1')).toBeUndefined()
  })
})

// An attempt whose keyed open the server confirmed clears exactly its own retention, even after
// being superseded. `onlyKey` is what scopes the clear: the named key's in-flight stamp is always
// voided (it is the confirmed key, and its late landing would resurrect it), while a stored entry
// carrying a different key belongs to a newer capture and must survive untouched -- entry and
// in-flight stamp both.
describe('attempt-owned clears (onlyKey)', () => {
  afterEach(() => sessionStorage.clear())

  it('a matching-key clear removes the entry and voids a pending write', () => {
    const stamp = beginRetainedShareKeyWrite('ws-1', ENTRY.key)
    commitRetainedShareKeyWrite(beginRetainedShareKeyWrite('ws-1', ENTRY.key), ENTRY)
    clearRetainedShareKey('ws-1', ENTRY.key)
    expect(readRetainedShareKey('ws-1')).toBeUndefined()
    // A late-landing stamp for the same attempt must not resurrect the confirmed key.
    commitRetainedShareKeyWrite(stamp, ENTRY)
    expect(readRetainedShareKey('ws-1')).toBeUndefined()
  })

  it("a different-key clear neither removes the entry nor voids that key's writes", () => {
    const newerEntry = { key: 'cafe', userId: 'person@example.com' }
    const newerStamp = beginRetainedShareKeyWrite('ws-1', newerEntry.key)
    commitRetainedShareKeyWrite(beginRetainedShareKeyWrite('ws-1', newerEntry.key), newerEntry)
    clearRetainedShareKey('ws-1', 'deadbeef')
    // The newer capture's entry survives, and so does its license to (re)write: no bump landed
    // on its key.
    expect(readRetainedShareKey('ws-1')).toEqual(newerEntry)
    commitRetainedShareKeyWrite(newerStamp, newerEntry)
    expect(readRetainedShareKey('ws-1')).toEqual(newerEntry)
  })

  it("a different-key clear still voids the cleared key's own in-flight stamp", () => {
    // Attempt A (key aaaa) was confirmed by the server but its identity stamp is still in
    // flight; a newer attempt B (key bbbb) already occupies the entry. A's clear must no-op on
    // B's entry yet void A's own stamp -- otherwise the stamp lands late, overwrites B's entry
    // with A's *confirmed* key, and a replay re-redeems it after an owner removal.
    const stampA = beginRetainedShareKeyWrite('ws-1', 'aaaa')
    const entryB = { key: 'bbbb', userId: 'other@example.com' }
    commitRetainedShareKeyWrite(beginRetainedShareKeyWrite('ws-1', 'bbbb'), entryB)
    clearRetainedShareKey('ws-1', 'aaaa')
    expect(readRetainedShareKey('ws-1')).toEqual(entryB)
    commitRetainedShareKeyWrite(stampA, { key: 'aaaa', userId: 'person@example.com' })
    expect(readRetainedShareKey('ws-1')).toEqual(entryB)
  })

  it("a different key's stamp survives an onlyKey clear even with the entry absent", () => {
    // The clear is scoped to its own key's generation, so a concurrent newer attempt whose stamp
    // is still in flight keeps its license even when nothing is stored yet.
    const stampB = beginRetainedShareKeyWrite('ws-1', 'bbbb')
    clearRetainedShareKey('ws-1', 'aaaa')
    commitRetainedShareKeyWrite(stampB, { key: 'bbbb', userId: 'person@example.com' })
    expect(readRetainedShareKey('ws-1'))
        .toEqual({ key: 'bbbb', userId: 'person@example.com' })
  })

  it('an absent-entry clear with onlyKey still voids a pending write', () => {
    // The absence may be the clearing attempt's own stamp still in flight; letting it land would
    // resurrect a key the server already confirmed.
    const stamp = beginRetainedShareKeyWrite('ws-1', ENTRY.key)
    clearRetainedShareKey('ws-1', ENTRY.key)
    commitRetainedShareKeyWrite(stamp, ENTRY)
    expect(readRetainedShareKey('ws-1')).toBeUndefined()
  })
})
