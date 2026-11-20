import { describe, expect, it } from 'vitest'
import type { AiChatMetadata } from '@gadgets/workshop-shared/api'
import { RecentChats } from './RecentChatsStore'

const chat = (id: number, at: number) => ({ id, title: '', started: new Date(0), lastActive: new Date(at) }) as AiChatMetadata
const reading = (chats: AiChatMetadata[]) => ({ chats, readStates: [], approvals: new Set<number>() })

describe('RecentChats', () => {
  it('is known once every workspace expected has answered, or could not', () => {
    const store = new RecentChats()
    store.expect(['a', 'b'])
    store.set('a', reading([]))
    expect(store.snapshot().known).toBe(false)
    store.failed('b')
    expect(store.snapshot().known).toBe(true)
  })

  it('reads a chat’s last messages again only once it has been active since', () => {
    const store = new RecentChats()
    store.set('a', reading([chat(1, 5)]), new Map([[1, { lastActive: 5, wrote: true }]]))
    expect(store.needsTail('a', chat(1, 5))).toBe(false)
    expect(store.needsTail('a', chat(1, 9))).toBe(true)
    expect(store.needsTail('a', chat(2, 5))).toBe(true)
  })

  it('shows a change to a chat’s read state at once, and puts it back as it was', () => {
    const store = new RecentChats()
    store.set('a', reading([chat(1, 5)]))
    const was = store.markChat('a', 1, { notificationsEnabledOverride: false })
    expect(store.snapshot().readings.get('a')!.readStates).toEqual([{ workspaceId: 'a', chatId: 1, unreadMessageCount: 0, readThroughSequence: -1, notificationsEnabledOverride: false }])
    store.restoreChat('a', 1, was)
    expect(store.snapshot().readings.get('a')!.readStates).toEqual([])
  })
})
