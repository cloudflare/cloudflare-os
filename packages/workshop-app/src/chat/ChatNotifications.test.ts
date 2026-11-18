import { describe, expect, it, vi } from 'vitest'
import type { ChatReadState, UnreadStateSubscriber } from '@gadgets/workshop-shared/api'
import { ChatNotifications, notificationChoices, notificationsOf, type NotificationsBackend } from './ChatNotifications'

const row = (chatId: number, change: Partial<ChatReadState> = {}, workspaceId = 'w'): ChatReadState => ({
  workspaceId,
  chatId,
  unreadMessageCount: 0,
  readThroughSequence: 0,
  ...change,
})

const summary = { unreadChatCount: 0, unreadMessageCount: 0, workspace: { workspaceId: 'w', unreadChatCount: 0, unreadMessageCount: 0 } }

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

/** The backend, and what a test needs to act as the server: the listener it was given. */
const fakeBackend = () => {
  let listener: UnreadStateSubscriber | undefined
  const leaseDispose = vi.fn<() => void>()
  const overseerDispose = vi.fn<() => void>()
  const setChatNotificationsEnabled = vi.fn<(chatId: number, enabled: boolean) => Promise<void>>(async () => {})
  const backend: NotificationsBackend = {
    subscribe: (given) => {
      listener = given as unknown as UnreadStateSubscriber
      return Promise.resolve({ [Symbol.dispose]: leaseDispose })
    },
    open: () => ({ setChatNotificationsEnabled, [Symbol.dispose]: overseerDispose }),
  }
  return { backend, server: () => listener!, leaseDispose, overseerDispose, setChatNotificationsEnabled }
}

const started = () => {
  const fake = fakeBackend()
  const notifications = new ChatNotifications(fake.backend, 'w')
  notifications.start()
  return { ...fake, notifications }
}

describe('notificationsOf', () => {
  it('goes by what the workspace says of the chat, where it says anything', () => {
    expect(notificationsOf({ notificationsEnabled: false, notificationsEnabledOverride: false }, false)).toEqual({ enabled: false, override: false })
  })

  it('is on by default, but off in a chat that asks to be taken part in first', () => {
    expect(notificationsOf(undefined, false)).toEqual({ enabled: true, override: undefined })
    expect(notificationsOf(undefined, true)).toEqual({ enabled: false, override: undefined })
  })
})

describe('notificationChoices', () => {
  it('offers to mute notifications that are on', () => {
    expect(notificationChoices({ enabled: true })).toEqual([{ enabled: false, label: 'Mute notifications' }])
  })

  it('offers to unmute notifications the viewer muted', () => {
    expect(notificationChoices({ enabled: false, override: false })).toEqual([{ enabled: true, label: 'Unmute notifications' }])
  })

  it('offers to enable notifications that are off by default, or to mute them, which also silences approvals', () => {
    expect(notificationChoices({ enabled: false })).toEqual([
      { enabled: true, label: 'Enable notifications' },
      { enabled: false, label: 'Mute notifications' },
    ])
  })
})

describe('ChatNotifications', () => {
  it('knows each of the workspace’s chats from the snapshot, and nothing of another workspace’s', async () => {
    const { notifications, server } = started()
    await server().updated({ unreadChatCount: 0, unreadMessageCount: 0, workspaces: [], chats: [row(1, { notificationsEnabled: false }), row(2, {}, 'other')] })

    expect([...notifications.getSnapshot().keys()]).toEqual([1])
    expect(notifications.getSnapshot().get(1)).toMatchObject({ notificationsEnabled: false })
  })

  it('replaces a chat that changed, and forgets one that was deleted', async () => {
    const { notifications, server } = started()
    await server().updated({ unreadChatCount: 0, unreadMessageCount: 0, workspaces: [], chats: [row(1), row(2)] })

    await server().chatUpdated('w', 1, row(1, { notificationsEnabled: false }), summary)
    await server().chatUpdated('w', 2, null, summary)

    expect(notifications.getSnapshot().get(1)).toMatchObject({ notificationsEnabled: false })
    expect(notifications.getSnapshot().has(2)).toBe(false)
  })

  it('shows a change at once, and keeps it over an update from before the change was made', async () => {
    const { notifications, server, setChatNotificationsEnabled, overseerDispose } = started()
    let answer!: () => void
    setChatNotificationsEnabled.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)))

    const changing = notifications.setEnabled(1, false)
    expect(notifications.getSnapshot().get(1)).toEqual({ notificationsEnabled: false, notificationsEnabledOverride: false })
    // Something else happened in the chat while the change was on its way.
    await server().chatUpdated('w', 1, row(1, { notificationsEnabled: true }), summary)
    expect(notifications.getSnapshot().get(1)).toMatchObject({ notificationsEnabled: false })

    answer()
    await changing
    expect(setChatNotificationsEnabled).toHaveBeenCalledExactlyOnceWith(1, false)
    expect(overseerDispose).toHaveBeenCalledOnce()
    // Once it is made, what the workspace says next is what it came to.
    await server().chatUpdated('w', 1, row(1, { notificationsEnabled: false, notificationsEnabledOverride: false }), summary)
    expect(notifications.getSnapshot().get(1)).toMatchObject({ notificationsEnabled: false, notificationsEnabledOverride: false, unreadMessageCount: 0 })
  })

  it('puts a refused change back, and says why', async () => {
    const { notifications, server, setChatNotificationsEnabled } = started()
    await server().updated({ unreadChatCount: 0, unreadMessageCount: 0, workspaces: [], chats: [row(1, { notificationsEnabled: true })] })
    setChatNotificationsEnabled.mockRejectedValueOnce(new Error('The chat is no longer available.'))

    await expect(notifications.setEnabled(1, false)).rejects.toThrow('The chat is no longer available.')

    expect(notifications.getSnapshot().get(1)).toMatchObject({ notificationsEnabled: true })
  })

  it('lets go of the subscription when stopped, and hears nothing from it after', async () => {
    const { notifications, server, leaseDispose } = started()
    const listener = server()
    notifications.stop()
    await flush()

    expect(leaseDispose).toHaveBeenCalledOnce()
    await listener.chatUpdated('w', 1, row(1, { notificationsEnabled: false }), summary)
    expect(notifications.getSnapshot().has(1)).toBe(false)
  })
})
