import { describe, expect, it, vi } from 'vitest'
import { NativeConnectSession, nativeConnectCompletion } from './connectSession'

const person = { type: 'user' as const, id: 'alice', name: 'Alice' }
const ticket = 'a'.repeat(64), nonce = 'b'.repeat(64)
const signal = () => new AbortController().signal
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
const api = () => {
  let broken: (error: unknown) => void = vi.fn<(error: unknown) => void>()
  return {
    completeConnectHandoff: vi.fn<(ticket: string, nonce: string) => Promise<void>>().mockResolvedValue(undefined),
    onRpcBroken: (callback: (error: unknown) => void) => { broken = callback },
    break: () => broken(new Error('socket lost')),
  }
}

describe('native connect session ownership', () => {
  it('uses the replacement connection when the browser returns after reconnecting', async () => {
    const session = new NativeConnectSession(), first = api(), next = api()
    const untrack = session.track(first, Promise.resolve(person))
    const complete = nativeConnectCompletion(first, nonce)
    first.break()
    untrack()
    session.track(next, Promise.resolve(person))
    await complete(ticket, signal())
    expect(first.completeConnectHandoff).not.toHaveBeenCalled()
    expect(next.completeConnectHandoff).toHaveBeenCalledExactlyOnceWith(ticket, nonce)
  })

  it('retains the ticket while disconnected and redeems when this owner reconnects', async () => {
    const session = new NativeConnectSession(), first = api(), next = api()
    session.track(first, Promise.resolve(person))
    first.break()
    const completion = nativeConnectCompletion(first, nonce)(ticket, signal())
    await flush()
    expect(first.completeConnectHandoff).not.toHaveBeenCalled()
    session.track(next, Promise.resolve(person))
    await completion
    expect(next.completeConnectHandoff).toHaveBeenCalledExactlyOnceWith(ticket, nonce)
  })

  it('retries a redemption interrupted by a broken transport, but only on its replacement', async () => {
    const session = new NativeConnectSession(), first = api(), next = api()
    let reject!: (error: Error) => void
    first.completeConnectHandoff.mockImplementation(() => new Promise((_, fail) => { reject = fail }))
    session.track(first, Promise.resolve(person))
    const completion = nativeConnectCompletion(first, nonce)(ticket, signal())
    await flush()
    first.break()
    reject(new Error('socket lost'))
    await flush()
    expect(first.completeConnectHandoff).toHaveBeenCalledOnce()
    session.track(next, Promise.resolve(person))
    await completion
    expect(next.completeConnectHandoff).toHaveBeenCalledExactlyOnceWith(ticket, nonce)
  })

  it('surfaces a live-session server rejection without retrying it', async () => {
    const session = new NativeConnectSession(), first = api()
    first.completeConnectHandoff.mockRejectedValue(new Error('ticket expired'))
    session.track(first, Promise.resolve(person))
    await expect(nativeConnectCompletion(first, nonce)(ticket, signal())).rejects.toThrow('ticket expired')
    expect(first.completeConnectHandoff).toHaveBeenCalledOnce()
  })

  it('rejects after a user switch instead of attaching the grant to another user', async () => {
    const session = new NativeConnectSession(), first = api(), next = api()
    session.track(first, Promise.resolve(person))
    const complete = nativeConnectCompletion(first, nonce)
    session.track(next, Promise.resolve({ ...person, id: 'bob' }))
    await expect(complete(ticket, signal())).rejects.toThrow('signed-in user changed')
    expect(next.completeConnectHandoff).not.toHaveBeenCalled()
  })

  it('does not substitute another mounted auth owner, even for the same user', async () => {
    const first = api(), other = api()
    const untrack = new NativeConnectSession().track(first, Promise.resolve(person))
    const complete = nativeConnectCompletion(first, nonce)
    new NativeConnectSession().track(other, Promise.resolve(person))
    untrack()
    await expect(complete(ticket, signal())).rejects.toThrow('signed out')
    expect(other.completeConnectHandoff).not.toHaveBeenCalled()
  })

  it('cancels a ticket waiting for reconnect and ignores later replacement connections', async () => {
    const session = new NativeConnectSession(), first = api(), next = api(), controller = new AbortController()
    session.track(first, Promise.resolve(person))
    first.break()
    const completion = nativeConnectCompletion(first, nonce)(ticket, controller.signal)
    await flush()
    controller.abort(new Error('cancelled'))
    await expect(completion).rejects.toThrow('cancelled')
    session.track(next, Promise.resolve(person))
    await flush()
    expect(next.completeConnectHandoff).not.toHaveBeenCalled()
  })
})
