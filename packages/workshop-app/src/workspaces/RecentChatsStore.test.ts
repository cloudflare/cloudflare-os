import { describe, expect, it } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, UnreadStateSubscriber, UnreadThread } from '@gadgets/workshop-shared/api'
import { RecentChats } from './RecentChatsStore'

const thread = (chatId: number, more: Partial<UnreadThread> = {}): UnreadThread => ({
  workspaceId: 'w', chatId, unreadMessageCount: 0, readThroughSequence: 0, notificationsEnabled: true,
  chatTitle: 'Chat', latestSequence: 0, latestMessagePreview: 'Hi', latestActivityAt: new Date(0), ...more,
})

const started = () => {
  const store = new RecentChats()
  let listener: UnreadStateSubscriber | undefined
  const api = {
    subscribeToUnreadState: async (scope: unknown, given: UnreadStateSubscriber) => {
      expect(scope).toBe('recent')
      listener = given
      return { [Symbol.dispose]() {} }
    },
  } as unknown as RpcStub<AuthenticatedApi>
  const stop = store.start(api)
  return { store, stop, listener: () => listener! }
}
const summary = { unreadChatCount: 0, unreadMessageCount: 0, workspaces: [] }
const update = { unreadChatCount: 0, unreadMessageCount: 0, workspace: { workspaceId: 'w', unreadChatCount: 0, unreadMessageCount: 0 } }

describe('RecentChats', () => {
  it('takes the snapshot, then each chat as the account says it changed, dropping one it says is gone', async () => {
    const { store, stop, listener } = started()
    await Promise.resolve()
    expect(store.snapshot().known).toBe(false)
    await listener().updated({ ...summary, chats: [thread(1), thread(2)] })
    await listener().chatUpdated('w', 1, thread(1, { latestMessagePreview: 'Later' }), update)
    await listener().chatUpdated('w', 2, null, update)
    expect(store.snapshot().known).toBe(true)
    expect([...store.snapshot().threads.values()].map(({ chatId, latestMessagePreview }) => [chatId, latestMessagePreview])).toEqual([[1, 'Later']])
    stop()
  })

  it('shows a change at once and puts it back when told how it was', async () => {
    const { store, stop, listener } = started()
    await Promise.resolve()
    await listener().updated({ ...summary, chats: [thread(1)] })
    const was = store.markChat('w', 1, { notificationsEnabledOverride: false })
    expect(store.snapshot().threads.get('w:1')?.notificationsEnabledOverride).toBe(false)
    store.restoreChat('w', 1, was)
    expect(store.snapshot().threads.get('w:1')?.notificationsEnabledOverride).toBeUndefined()
    stop()
  })
})
