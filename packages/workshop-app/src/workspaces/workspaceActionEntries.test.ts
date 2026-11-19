import { describe, expect, it, vi } from 'vitest'
import { searchMatches } from '@/blocks/searchMatches'
import { workspaceActionEntries } from './workspaceActionEntries'

const build = (overrides: Partial<Parameters<typeof workspaceActionEntries>[0]> = {}) =>
  workspaceActionEntries({ workspaceTitle: 'Garden planning', onNewChat: vi.fn<() => void>(), onInvite: vi.fn<() => void>(), ...overrides })

describe('workspaceActionEntries', () => {
  it('has a new chat and the way to invite, with plain names', () => {
    const { newChat, invite } = build()
    expect(newChat?.title).toBe('New chat')
    expect(invite?.title).toBe('Invite')
  })

  it('says at the end of each which workspace it is for, as the New chat that starts one is also found, and only where that is known', () => {
    const { newChat, invite } = build()
    expect([newChat?.detail, invite?.detail]).toEqual(['Garden planning', 'Garden planning'])
    const unknown = build({ workspaceTitle: undefined })
    expect([unknown.newChat?.detail, unknown.invite?.detail]).toEqual([undefined, undefined])
  })

  it('has only what is given, as the viewer may not do both everywhere', () => {
    expect(build({ onInvite: undefined }).invite).toBeUndefined()
    expect(build({ onInvite: undefined }).newChat).toBeDefined()
    expect(build({ onNewChat: undefined }).newChat).toBeUndefined()
    expect(build({ onNewChat: undefined }).invite).toBeDefined()
  })

  it('is found for "new chat" and "invite", and "share" or "workspace" for the second', () => {
    const { newChat, invite } = build()
    const entries = [newChat!, invite!]
    expect(searchMatches('new chat', entries).map(({ key }) => key)).toEqual(['workspace:new-chat'])
    expect(searchMatches('invite', entries).map(({ key }) => key)).toEqual(['workspace:invite'])
    expect(searchMatches('share', entries).map(({ key }) => key)).toEqual(['workspace:invite'])
    expect(searchMatches('invite workspace', entries).map(({ key }) => key)).toEqual(['workspace:invite'])
  })

  it('does what it was given', async () => {
    const onNewChat = vi.fn<() => void>()
    const onInvite = vi.fn<() => void>()
    const { newChat, invite } = build({ onNewChat, onInvite })
    await newChat!.onSelect()
    await invite!.onSelect()
    expect([onNewChat.mock.calls.length, onInvite.mock.calls.length]).toEqual([1, 1])
  })
})
