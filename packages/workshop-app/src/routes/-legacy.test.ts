import { describe, expect, it } from 'vitest'
import { legacyTarget } from './-legacy'

describe('legacyTarget', () => {
  it('opens the chat a notification links to', () => {
    expect(legacyTarget('/workspace/abc', { chat: 4, showChat: true })).toEqual({ href: '/workspace/abc/chat/4' })
    expect(legacyTarget('/workspace/abc', { chat: '4' })).toEqual({ href: '/workspace/abc/chat/4' })
  })

  it('keeps the gadget shown beside it', () => {
    expect(legacyTarget('/workspace/abc', { chat: 4, w: 12 })).toEqual({ href: '/workspace/abc/chat/4?open=12' })
    expect(legacyTarget('/workspace/abc', { w: 12 })).toEqual({ href: '/workspace/abc?open=12' })
  })

  it('takes a workspace from its oldest address', () => {
    expect(legacyTarget('/gadget/abc', {})).toEqual({ href: '/workspace/abc' })
    expect(legacyTarget('/gadget/abc', { chat: 2 })).toEqual({ href: '/workspace/abc/chat/2' })
  })

  it('leaves current addresses alone', () => {
    expect(legacyTarget('/workspace/abc', {})).toBeUndefined()
    expect(legacyTarget('/workspace/abc', { chat: 'x' })).toBeUndefined()
    expect(legacyTarget('/workspace/abc/chat/4', { chat: 4 })).toBeUndefined()
    expect(legacyTarget('/library', {})).toBeUndefined()
    expect(legacyTarget('/', {})).toBeUndefined()
  })

  it('renames the old pages', () => {
    expect(legacyTarget('/blueprints', {})).toEqual({ href: '/library/templates' })
    expect(legacyTarget('/blueprint/b-1', {})).toEqual({ href: '/library/templates/b-1' })
    expect(legacyTarget('/gatekeepers/github', {})).toEqual({ href: '/connections' })
    expect(legacyTarget('/profile/', {})).toEqual({ href: '/settings' })
  })
})
