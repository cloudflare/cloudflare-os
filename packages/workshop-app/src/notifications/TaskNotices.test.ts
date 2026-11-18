import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NotificationSubscriber, UserNotification } from '@gadgets/workshop-shared/api'
import { NOTICE_SHOWN_FOR, TaskNotices, type NoticesBackend, type TabVisibility } from './TaskNotices'

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

const notification = (id: string, change: Partial<UserNotification> = {}): UserNotification => ({
  id,
  kind: 'taskCompleted',
  workspaceId: 'w',
  chatId: 1,
  chatTitle: 'Weekly report',
  ...change,
})

/** A tab that can be put out of view and back. */
const fakeTab = () => {
  let visible = true
  const listeners = new Set<() => void>()
  const visibility: TabVisibility = {
    visible: () => visible,
    onChange: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  return {
    visibility,
    set: (next: boolean) => {
      visible = next
      listeners.forEach((listener) => listener())
    },
  }
}

/** The backend, and what a test needs to act as the server: each listener it was given. */
const fakeBackend = () => {
  const listeners: (NotificationSubscriber & Disposable)[] = []
  const leaseDispose = vi.fn<() => void>()
  const subscribe = vi.fn<NoticesBackend['subscribe']>((given) => {
    listeners.push(given as unknown as NotificationSubscriber & Disposable)
    return Promise.resolve({ [Symbol.dispose]: leaseDispose })
  })
  return { backend: { subscribe }, subscribe, server: () => listeners.at(-1)!, leaseDispose }
}

const started = (isShown: (workspaceId: string, chatId: number) => boolean = () => false) => {
  const fake = fakeBackend()
  const tab = fakeTab()
  const notices = new TaskNotices(fake.backend, isShown, tab.visibility)
  notices.start()
  return { ...fake, tab, notices }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('TaskNotices', () => {
  it('shows the latest, and puts it away by itself after a while', async () => {
    const { notices, server } = started()
    await server().notify(notification('1'))
    await server().notify(notification('2', { kind: 'permissionRequested', chatTitle: 'Invoices' }))

    expect(notices.getSnapshot()).toEqual({ id: '2', kind: 'permissionRequested', workspaceId: 'w', chatId: 1, chatTitle: 'Invoices' })
    await vi.advanceTimersByTimeAsync(NOTICE_SHOWN_FOR)
    expect(notices.getSnapshot()).toBeUndefined()
  })

  it('takes one for the chat on screen as seen, and shows nothing', async () => {
    const { notices, server } = started((workspaceId, chatId) => workspaceId === 'w' && chatId === 1)
    await expect(server().notify(notification('1'))).resolves.toBeUndefined()
    expect(notices.getSnapshot()).toBeUndefined()
  })

  it('puts one away when asked, but not one that came after it', async () => {
    const { notices, server } = started()
    await server().notify(notification('1'))
    await server().notify(notification('2'))
    notices.dismiss('1')
    expect(notices.getSnapshot()?.id).toBe('2')
    notices.dismiss('2')
    expect(notices.getSnapshot()).toBeUndefined()
  })

  it('is subscribed only while the tab is in view, and refuses what arrives once it is not', async () => {
    const { server, subscribe, tab, leaseDispose } = started()
    const listener = server()
    tab.set(false)
    await flush()

    expect(leaseDispose).toHaveBeenCalledOnce()
    // Refused, the account pushes it to the user's devices instead.
    await expect(listener.notify(notification('1'))).rejects.toThrow('This tab can’t show notifications right now.')
    tab.set(true)
    expect(subscribe).toHaveBeenCalledTimes(2)
  })

  it('subscribes again once the account forgets it, as it does when it restarts', async () => {
    const { server, subscribe } = started()
    await flush()
    server()[Symbol.dispose]()
    expect(subscribe).toHaveBeenCalledTimes(2)
  })

  it('tries a failed subscription again, waiting longer each time', async () => {
    const { backend, subscribe } = fakeBackend()
    subscribe.mockRejectedValue(new Error('unavailable'))
    new TaskNotices(backend, () => false, fakeTab().visibility).start()
    await flush()

    await vi.advanceTimersByTimeAsync(1000)
    expect(subscribe).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1000)
    expect(subscribe).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1000)
    expect(subscribe).toHaveBeenCalledTimes(3)
  })

  it('lets go of everything when stopped, refusing what its listener hears after', async () => {
    const { notices, server, leaseDispose, tab, subscribe } = started()
    const listener = server()
    notices.stop()
    await flush()

    expect(leaseDispose).toHaveBeenCalledOnce()
    await expect(listener.notify(notification('1'))).rejects.toThrow('This tab can’t show notifications right now.')
    tab.set(true)
    expect(subscribe).toHaveBeenCalledOnce()
  })
})
