import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatSession } from './ChatSession'
import { ChatSessions } from './ChatSessions'

const fakeSession = () => ({ start: vi.fn<() => void>(), stop: vi.fn<() => void>(), reconnect: vi.fn<() => void>() }) as unknown as ChatSession & {
  start: ReturnType<typeof vi.fn<() => void>>
  stop: ReturnType<typeof vi.fn<() => void>>
  reconnect: ReturnType<typeof vi.fn<() => void>>
}

describe('ChatSessions', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('shares one session for a chat, connected while anyone holds it', () => {
    const sessions = new ChatSessions(() => fakeSession())
    const session = sessions.get('w', 1) as ReturnType<typeof fakeSession>
    expect(sessions.get('w', 1)).toBe(session)
    expect(sessions.get('w', 2)).not.toBe(session)

    const first = sessions.hold(session)
    const second = sessions.hold(session)
    expect(session.start).toHaveBeenCalledTimes(1)
    first()
    first()
    expect(session.stop).not.toHaveBeenCalled()
    second()
    expect(session.stop).toHaveBeenCalledTimes(1)
  })

  it('connects again only the sessions that are held', () => {
    const sessions = new ChatSessions(() => fakeSession())
    const held = sessions.get('w', 1) as ReturnType<typeof fakeSession>
    const letGo = sessions.get('w', 2) as ReturnType<typeof fakeSession>
    sessions.hold(held)
    sessions.hold(letGo)()

    sessions.reconnect()

    expect(held.reconnect).toHaveBeenCalledOnce()
    expect(letGo.reconnect).not.toHaveBeenCalled()
  })

  it('picks up a session taken hold of again soon after, and forgets it otherwise', () => {
    const sessions = new ChatSessions(() => fakeSession())
    const session = sessions.get('w', 1)
    sessions.hold(session)()
    sessions.hold(session)
    vi.runAllTimers()
    expect(sessions.get('w', 1)).toBe(session)

    const other = sessions.get('w', 2)
    sessions.hold(other)()
    vi.runAllTimers()
    expect(sessions.get('w', 2)).not.toBe(other)
  })
})
