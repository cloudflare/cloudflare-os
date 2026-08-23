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
    const token = beginRetainedShareKeyWrite('ws-1')
    commitRetainedShareKeyWrite(token, ENTRY)
    expect(readRetainedShareKey('ws-1')).toEqual(ENTRY)
  })

  // The stamp is asynchronous (identity resolves after the open is issued), so a success or a
  // logout can clear storage while a stamp is still in flight. The clear must win permanently:
  // a resurrected entry re-redeems a link its owner may since have revoked the recipient from,
  // and after logout it would sit waiting for the tab's next user.
  it('a workspace clear voids an in-flight write for that workspace only', () => {
    const cleared = beginRetainedShareKeyWrite('ws-1')
    const other = beginRetainedShareKeyWrite('ws-2')
    clearRetainedShareKey('ws-1')
    commitRetainedShareKeyWrite(cleared, ENTRY)
    commitRetainedShareKeyWrite(other, ENTRY)
    expect(readRetainedShareKey('ws-1')).toBeUndefined()
    expect(readRetainedShareKey('ws-2')).toEqual(ENTRY)
  })

  it('the logout sweep voids every in-flight write', () => {
    const token = beginRetainedShareKeyWrite('ws-1')
    clearAllRetainedShareKeys()
    commitRetainedShareKeyWrite(token, ENTRY)
    expect(readRetainedShareKey('ws-1')).toBeUndefined()
  })
})

// An attempt whose keyed open the server confirmed clears exactly its own retention, even after
// being superseded. `onlyKey` is what scopes the clear: a stored entry carrying a different key
// belongs to a newer capture and must survive untouched -- including its in-flight stamp -- while
// a matching or absent entry is this attempt's own to discard.
describe('attempt-owned clears (onlyKey)', () => {
  afterEach(() => sessionStorage.clear())

  it('a matching-key clear removes the entry and voids a pending write', () => {
    const stamp = beginRetainedShareKeyWrite('ws-1')
    commitRetainedShareKeyWrite(beginRetainedShareKeyWrite('ws-1'), ENTRY)
    clearRetainedShareKey('ws-1', ENTRY.key)
    expect(readRetainedShareKey('ws-1')).toBeUndefined()
    // A late-landing stamp for the same attempt must not resurrect the confirmed key.
    commitRetainedShareKeyWrite(stamp, ENTRY)
    expect(readRetainedShareKey('ws-1')).toBeUndefined()
  })

  it("a different-key clear neither removes the entry nor voids the workspace's writes", () => {
    const newerEntry = { key: 'cafe', userId: 'person@example.com' }
    const newerStamp = beginRetainedShareKeyWrite('ws-1')
    commitRetainedShareKeyWrite(beginRetainedShareKeyWrite('ws-1'), newerEntry)
    clearRetainedShareKey('ws-1', 'deadbeef')
    // The newer capture's entry survives, and so does its license to (re)write: no bump landed.
    expect(readRetainedShareKey('ws-1')).toEqual(newerEntry)
    commitRetainedShareKeyWrite(newerStamp, newerEntry)
    expect(readRetainedShareKey('ws-1')).toEqual(newerEntry)
  })

  it('an absent-entry clear with onlyKey still voids a pending write', () => {
    // The absence may be the clearing attempt's own stamp still in flight; letting it land would
    // resurrect a key the server already confirmed.
    const stamp = beginRetainedShareKeyWrite('ws-1')
    clearRetainedShareKey('ws-1', ENTRY.key)
    commitRetainedShareKeyWrite(stamp, ENTRY)
    expect(readRetainedShareKey('ws-1')).toBeUndefined()
  })
})
