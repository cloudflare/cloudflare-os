import { describe, expect, it } from 'vitest'
import type { SidebarChat } from './SidebarChatItem'
import { railWorkspacesOf } from './railWorkspaces'

const chat = (id: string, workspaceId: string, more: Partial<SidebarChat> = {}): SidebarChat =>
  ({ id, workspaceId, title: id, workspaceTitle: workspaceId, workspaceLabel: workspaceId.slice(0, 2), time: 'now', ...more })

describe('railWorkspacesOf', () => {
  it('has the pinned workspaces first, then each the chats are in, once, in the order of its first chat', () => {
    const rail = railWorkspacesOf(
      [{ id: 'pinned', title: 'Pinned', workspaceLabel: 'PI' }],
      [chat('b1', 'b'), chat('p1', 'pinned'), chat('a1', 'a'), chat('b2', 'b')],
    )
    expect(rail.map(({ id, chats }) => [id, chats.map(({ id: chatId }) => chatId)])).toEqual([['pinned', ['p1']], ['b', ['b1', 'b2']], ['a', ['a1']]])
  })

  it('marks a workspace for what its chats have, but not for a muted one’s', () => {
    const rail = railWorkspacesOf([], [chat('a1', 'a', { unread: true, muted: true }), chat('b1', 'b', { unread: true }), chat('c1', 'c', { attention: 'Needs approval' })])
    expect(rail.map(({ id, unread, attention }) => [id, unread, attention])).toEqual([['a', false, undefined], ['b', true, undefined], ['c', false, 'Needs approval']])
  })
})
