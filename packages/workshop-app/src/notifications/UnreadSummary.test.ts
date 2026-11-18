import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UnreadStateSubscriber, UserUnreadState } from '@gadgets/workshop-shared/api'
import { UnreadSummary, type UnreadBackend } from './UnreadSummary'

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

const state = (workspaces: Record<string, number>): UserUnreadState => ({
  unreadChatCount: Object.keys(workspaces).length,
  unreadMessageCount: Object.values(workspaces).reduce((sum, count) => sum + count, 0),
  workspaces: Object.entries(workspaces).map(([workspaceId, unreadMessageCount]) => ({ workspaceId, unreadChatCount: 1, unreadMessageCount })),
  chats: [],
})

const update = (total: number, workspaceId: string, unreadMessageCount: number) => ({
  unreadChatCount: 0,
  unreadMessageCount: total,
  workspace: { workspaceId, unreadChatCount: unreadMessageCount > 0 ? 1 : 0, unreadMessageCount },
})

/** The backend, and what a test needs to act as the server: each listener it was given. */
const fakeBackend = () => {
  const listeners: (UnreadStateSubscriber & Disposable)[] = []
  const leaseDispose = vi.fn<() => void>()
  const subscribe = vi.fn<UnreadBackend['subscribe']>((given) => {
    listeners.push(given as unknown as UnreadStateSubscriber & Disposable)
    return Promise.resolve({ [Symbol.dispose]: leaseDispose })
  })
  return { backend: { subscribe }, subscribe, server: () => listeners.at(-1)!, leaseDispose }
}

const started = () => {
  const fake = fakeBackend()
  const summary = new UnreadSummary(fake.backend)
  summary.start()
  return { ...fake, summary }
}

const counts = (summary: UnreadSummary) => Object.fromEntries(summary.getSnapshot().workspaces)

afterEach(() => {
  vi.useRealTimers()
})

describe('UnreadSummary', () => {
  it('knows nothing until the account has said, then each workspace with anything unread', async () => {
    const { summary, server } = started()
    expect(summary.getSnapshot().known).toBe(false)

    await server().updated(state({ a: 2, b: 1 }))

    expect(summary.getSnapshot()).toMatchObject({ known: true, total: 3 })
    expect(counts(summary)).toEqual({ a: 2, b: 1 })
  })

  it('replaces the workspace that changed, and forgets one with nothing left unread', async () => {
    const { summary, server } = started()
    await server().updated(state({ a: 2, b: 1 }))

    await server().summaryUpdated(update(4, 'a', 3))
    await server().chatUpdated('b', 1, null, update(3, 'b', 0))

    expect(summary.getSnapshot().total).toBe(3)
    expect(counts(summary)).toEqual({ a: 3 })
  })

  it('subscribes again once the account forgets it, as it does when it restarts', async () => {
    const { summary, server, subscribe } = started()
    await flush()
    await server().updated(state({ a: 1 }))

    server()[Symbol.dispose]()

    expect(subscribe).toHaveBeenCalledTimes(2)
    // What was known stays until the new one says otherwise.
    expect(counts(summary)).toEqual({ a: 1 })
  })

  it('tries a failed subscription again, waiting longer each time', async () => {
    vi.useFakeTimers()
    const { backend, subscribe } = fakeBackend()
    subscribe.mockRejectedValue(new Error('unavailable'))
    new UnreadSummary(backend).start()
    await flush()

    await vi.advanceTimersByTimeAsync(1000)
    expect(subscribe).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1000)
    expect(subscribe).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1000)
    expect(subscribe).toHaveBeenCalledTimes(3)
  })

  it('lets go of the subscription when stopped, and hears nothing from it after', async () => {
    const { summary, server, leaseDispose, subscribe } = started()
    const listener = server()
    summary.stop()
    await flush()

    expect(leaseDispose).toHaveBeenCalledOnce()
    await listener.updated(state({ a: 1 }))
    listener[Symbol.dispose]()
    expect(summary.getSnapshot().known).toBe(false)
    expect(subscribe).toHaveBeenCalledOnce()
  })
})
