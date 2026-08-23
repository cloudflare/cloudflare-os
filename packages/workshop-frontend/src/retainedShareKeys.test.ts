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
