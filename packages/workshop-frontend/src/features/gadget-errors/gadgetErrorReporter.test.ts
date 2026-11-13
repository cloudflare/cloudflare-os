import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type ReportedGadgetError,
  MAX_GADGET_ERRORS_PER_CALL,
  MAX_REPORTED_GADGET_ERROR_TEXT_LENGTH,
} from '@gadgets/workshop-shared/api'
import { logRpcFailure } from '../../rpcErrors'
import {
  GADGET_ERROR_FLUSH_MS,
  GADGET_ERROR_MAX_BACKOFF_MS,
  GADGET_ERROR_SEND_TIMEOUT_MS,
  createGadgetErrorReporter,
  uncaughtErrorText,
} from './gadgetErrorReporter'

vi.mock('../../rpcErrors', () => ({
  logRpcFailure: vi.fn<(message: string, err: unknown, options?: { reportSite?: string }) => boolean>(),
}))

type Send = (entries: ReportedGadgetError[]) => PromiseLike<void> | null

/** The message a frame posts for an uncaught error whose stack or message is `text`. */
const posted = (text: string): unknown[] => ['Uncaught', text]

/** `count` errors named `prefix0`, `prefix1` and so on, as a send holds them. */
const errors = (prefix: string, from: number, count: number): ReportedGadgetError[] =>
  Array.from({ length: count }, (_, i) => ({ text: `Uncaught ${prefix}${from + i}` }))

/** A `send` whose sends stay unsettled until the test settles them, in the order they were made. */
const deferredSend = () => {
  const sends: { resolve: () => void; reject: (err: unknown) => void }[] = []
  const send = vi.fn<Send>(() => new Promise<void>((resolve, reject) => {
    sends.push({ resolve, reject })
  }))
  return { send, sends }
}

/** What `send` was given by its `call`th call, counted from one. */
const sentBy = (send: Mock<Send>, call: number) => send.mock.calls[call - 1][0]

/**
 * An array of `length` holes, as a frame can post one in a few bytes. Its length is assigned because
 * Array.from({ length }), which the lint suggests in place of `new Array(length)`, builds every
 * element: 2^32 - 1 of them cannot be built, and twenty arrays of 5 x 10^8 exhaust memory.
 */
function sparseArray(length: number): unknown[] {
  const holes: unknown[] = []
  holes.length = length
  return holes
}

/** An array that counts every look at it: its members, its length, its keys. */
const countingMessage = () => {
  const reads = { count: 0 }
  const message: unknown = new Proxy<unknown[]>(['Uncaught', 'counted'], {
    get(target, key, receiver) {
      reads.count++
      return Reflect.get(target, key, receiver)
    },
    has(target, key) {
      reads.count++
      return Reflect.has(target, key)
    },
    ownKeys(target) {
      reads.count++
      return Reflect.ownKeys(target)
    },
    getOwnPropertyDescriptor(target, key) {
      reads.count++
      return Reflect.getOwnPropertyDescriptor(target, key)
    },
  })
  return { message, reads }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.mocked(logRpcFailure).mockReset().mockReturnValue(false)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('createGadgetErrorReporter', () => {
  it('sends nothing before the interval, then one call with the errors in order', async () => {
    const send = vi.fn<Send>(async () => {})
    const reporter = createGadgetErrorReporter(send)
    reporter.add(['Uncaught', 'Error: first\n    at client.js:1:1'])
    reporter.add(['Unhandled promise rejection:', 'Error: second'])

    await vi.advanceTimersByTimeAsync(GADGET_ERROR_FLUSH_MS - 1)
    expect(send).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(send).toHaveBeenCalledTimes(1)
    expect(sentBy(send, 1)).toStrictEqual([
      { text: 'Uncaught Error: first\n    at client.js:1:1' },
      { text: 'Unhandled promise rejection: Error: second' },
    ])
  })

  it('is bounded: the first errors of a burst are sent and the rest dropped', async () => {
    const send = vi.fn<Send>(async () => {})
    const reporter = createGadgetErrorReporter(send)
    for (let i = 0; i < MAX_GADGET_ERRORS_PER_CALL + 5; i++) reporter.add(posted(`burst${i}`))

    await vi.advanceTimersByTimeAsync(GADGET_ERROR_FLUSH_MS)
    expect(send).toHaveBeenCalledTimes(1)
    expect(sentBy(send, 1)).toStrictEqual(errors('burst', 0, MAX_GADGET_ERRORS_PER_CALL))

    // Nothing stands for the five that were dropped: no later send, no marker.
    await vi.advanceTimersByTimeAsync(GADGET_ERROR_MAX_BACKOFF_MS)
    expect(send).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)

    reporter.add(posted('after'))
    await vi.advanceTimersByTimeAsync(GADGET_ERROR_FLUSH_MS)
    expect(send).toHaveBeenCalledTimes(2)
    expect(sentBy(send, 2)).toStrictEqual([{ text: 'Uncaught after' }])
  })

  it('does not read the message of an error it drops', () => {
    const send = vi.fn<Send>(async () => {})

    // The trap works: a reporter with room reads the message.
    const withRoom = countingMessage()
    createGadgetErrorReporter(send).add(withRoom.message)
    expect(withRoom.reads.count).toBeGreaterThan(0)

    const full = createGadgetErrorReporter(send)
    for (let i = 0; i < MAX_GADGET_ERRORS_PER_CALL; i++) full.add(posted(`queued${i}`))
    const whenFull = countingMessage()
    full.add(whenFull.message)
    expect(whenFull.reads.count).toBe(0)

    const stopped = createGadgetErrorReporter(send)
    stopped.stop()
    const whenStopped = countingMessage()
    stopped.add(whenStopped.message)
    expect(whenStopped.reads.count).toBe(0)
  })

  it('sends texts only: the server stamps the time', async () => {
    const send = vi.fn<Send>(async () => {})
    const reporter = createGadgetErrorReporter(send)
    reporter.add(posted('a'))
    reporter.add(posted('b'))

    await vi.advanceTimersByTimeAsync(GADGET_ERROR_FLUSH_MS)
    for (const [i, sent] of sentBy(send, 1).entries()) {
      expect(sent).toStrictEqual({ text: `Uncaught ${'ab'[i]}` })
    }
    expect(sentBy(send, 1)).toHaveLength(2)
  })

  it('sends one batch at a time', async () => {
    const { send, sends } = deferredSend()
    const reporter = createGadgetErrorReporter(send)
    reporter.add(posted('first'))
    await vi.advanceTimersByTimeAsync(GADGET_ERROR_FLUSH_MS)
    expect(send).toHaveBeenCalledTimes(1)

    for (let i = 0; i < MAX_GADGET_ERRORS_PER_CALL + 5; i++) reporter.add(posted(`queued${i}`))
    await vi.advanceTimersByTimeAsync(3 * GADGET_ERROR_FLUSH_MS)
    expect(send).toHaveBeenCalledTimes(1)

    sends[0].resolve()
    await vi.advanceTimersByTimeAsync(GADGET_ERROR_FLUSH_MS - 1)
    expect(send).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(send).toHaveBeenCalledTimes(2)
    expect(sentBy(send, 2)).toStrictEqual(errors('queued', 0, MAX_GADGET_ERRORS_PER_CALL))
  })

  it.each<{ how: string; settleLate: (sent: { resolve: () => void; reject: (err: unknown) => void }) => void }>([
    { how: 'fulfils', settleLate: sent => sent.resolve() },
    { how: 'is refused', settleLate: sent => sent.reject(new Error('refused late')) },
  ])('gives up a send that never settles, and ignores it when it later $how', async ({ settleLate }) => {
    const { send, sends } = deferredSend()
    const reporter = createGadgetErrorReporter(send)
    reporter.add(posted('lost0'))
    reporter.add(posted('lost1'))
    await vi.advanceTimersByTimeAsync(GADGET_ERROR_FLUSH_MS)
    expect(send).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(GADGET_ERROR_SEND_TIMEOUT_MS - 1)
    expect(send).toHaveBeenCalledTimes(1)
    reporter.add(posted('next'))
    await vi.advanceTimersByTimeAsync(1 + GADGET_ERROR_FLUSH_MS)
    expect(send).toHaveBeenCalledTimes(2)
    // The send that was given up is not made again: its errors are lost.
    expect(sentBy(send, 2)).toStrictEqual([{ text: 'Uncaught next' }])

    // It settles after all, while the next is in flight: nothing is logged or sent for it, and
    // the send in flight stays the only one.
    settleLate(sends[0])
    reporter.add(posted('queued'))
    await vi.advanceTimersByTimeAsync(GADGET_ERROR_FLUSH_MS)
    expect(send).toHaveBeenCalledTimes(2)
    expect(logRpcFailure).not.toHaveBeenCalled()

    sends[1].resolve()
    await vi.advanceTimersByTimeAsync(GADGET_ERROR_FLUSH_MS)
    expect(send).toHaveBeenCalledTimes(3)
    expect(sentBy(send, 3)).toStrictEqual([{ text: 'Uncaught queued' }])
  })

  it('waits twice as long after each refusal, up to a limit, and as before after a success', async () => {
    const { send, sends } = deferredSend()
    const reporter = createGadgetErrorReporter(send)
    reporter.add(posted('refused'))
    await vi.advanceTimersByTimeAsync(GADGET_ERROR_FLUSH_MS)
    expect(send).toHaveBeenCalledTimes(1)

    // The sixth wait would be 320 seconds if nothing bounded it.
    const waits = [10_000, 20_000, 40_000, 80_000, 160_000, GADGET_ERROR_MAX_BACKOFF_MS, GADGET_ERROR_MAX_BACKOFF_MS]
    for (const [refused, wait] of waits.entries()) {
      sends[refused].reject(new Error('refused'))
      // The refusal is seen before the next error is queued, as it is when errors come apart.
      await vi.advanceTimersByTimeAsync(0)
      reporter.add(posted(`after refusal ${refused}`))
      await vi.advanceTimersByTimeAsync(wait - 1)
      expect(send).toHaveBeenCalledTimes(refused + 1)
      await vi.advanceTimersByTimeAsync(1)
      expect(send).toHaveBeenCalledTimes(refused + 2)
    }

    sends[7].resolve()
    await vi.advanceTimersByTimeAsync(GADGET_ERROR_MAX_BACKOFF_MS)
    reporter.add(posted('accepted'))
    await vi.advanceTimersByTimeAsync(GADGET_ERROR_FLUSH_MS - 1)
    expect(send).toHaveBeenCalledTimes(8)
    await vi.advanceTimersByTimeAsync(1)
    expect(send).toHaveBeenCalledTimes(9)
    expect(sentBy(send, 9)).toStrictEqual([{ text: 'Uncaught accepted' }])
  })

  it('keeps its interval after a failure a reconnect cures', async () => {
    vi.mocked(logRpcFailure).mockReturnValue(true)
    const { send, sends } = deferredSend()
    const reporter = createGadgetErrorReporter(send)
    reporter.add(posted('refused'))
    await vi.advanceTimersByTimeAsync(GADGET_ERROR_FLUSH_MS)

    for (let refusals = 1; refusals <= 3; refusals++) {
      sends[refusals - 1].reject(new Error('Peer closed WebSocket'))
      await vi.advanceTimersByTimeAsync(0)
      reporter.add(posted(`after refusal ${refusals}`))
      await vi.advanceTimersByTimeAsync(GADGET_ERROR_FLUSH_MS - 1)
      expect(send).toHaveBeenCalledTimes(refusals)
      await vi.advanceTimersByTimeAsync(1)
      expect(send).toHaveBeenCalledTimes(refusals + 1)
    }
  })

  it('does not send a refused batch again, and logs its failure to the browser console only', async () => {
    const refusal = new Error('refused')
    const send = vi.fn<Send>(async () => {})
      .mockImplementationOnce(() => Promise.reject(refusal))
    const reporter = createGadgetErrorReporter(send)
    for (let i = 0; i < 3; i++) reporter.add(posted(`refused${i}`))
    await vi.advanceTimersByTimeAsync(GADGET_ERROR_FLUSH_MS)

    // Exactly two arguments: a third would name a report site, and with one the failure is also
    // sent to the deployment's error reporting. The text of a queued error is no argument either.
    expect(logRpcFailure).toHaveBeenCalledTimes(1)
    expect(vi.mocked(logRpcFailure).mock.calls[0]).toStrictEqual(['Failed to report gadget errors:', refusal])

    // The rejection is handled by the reporter: one nothing handled would fail the run.
    await vi.advanceTimersByTimeAsync(GADGET_ERROR_MAX_BACKOFF_MS)
    expect(send).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)

    reporter.add(posted('next'))
    await vi.advanceTimersByTimeAsync(GADGET_ERROR_MAX_BACKOFF_MS)
    expect(send).toHaveBeenCalledTimes(2)
    expect(sentBy(send, 2)).toStrictEqual([{ text: 'Uncaught next' }])
  })

  it('keeps everything while there is nothing to send through, and sends it once there is', async () => {
    let connected = false
    const send = vi.fn<Send>(() => connected ? Promise.resolve() : null)
    const reporter = createGadgetErrorReporter(send)
    reporter.add(posted('held0'))
    reporter.add(posted('held1'))

    for (let interval = 1; interval <= 12; interval++) {
      await vi.advanceTimersByTimeAsync(GADGET_ERROR_FLUSH_MS)
      // The timer comes round once an interval: it does not spin.
      expect(send).toHaveBeenCalledTimes(interval)
    }
    // Held through the outage, the queue stays bounded and keeps its first errors.
    for (let i = 2; i < MAX_GADGET_ERRORS_PER_CALL + 5; i++) reporter.add(posted(`held${i}`))

    connected = true
    await vi.advanceTimersByTimeAsync(GADGET_ERROR_FLUSH_MS)
    expect(send).toHaveBeenCalledTimes(13)
    expect(sentBy(send, 13)).toStrictEqual(errors('held', 0, MAX_GADGET_ERRORS_PER_CALL))
  })

  it('runs no timer while it has nothing to send', async () => {
    const send = vi.fn<Send>(async () => {})
    const reporter = createGadgetErrorReporter(send)
    await vi.advanceTimersByTimeAsync(GADGET_ERROR_MAX_BACKOFF_MS)
    expect(send).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)

    reporter.add(posted('one'))
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(GADGET_ERROR_FLUSH_MS)
    expect(send).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('sends at once when flushed, in place of the send its interval would have made', () => {
    const { send } = deferredSend()
    const reporter = createGadgetErrorReporter(send)
    reporter.add(posted('now'))

    reporter.flush()
    expect(send).toHaveBeenCalledTimes(1)
    expect(sentBy(send, 1)).toStrictEqual([{ text: 'Uncaught now' }])
    // The one timer left is the one that gives the send up: the interval's is cleared.
    expect(vi.getTimerCount()).toBe(1)
  })

  // A flush that left the interval's timer running would start one more chain of sends each time
  // it found nothing to send through.
  it('keeps one timer however often it is flushed with nothing to send through', async () => {
    const send = vi.fn<Send>(() => null)
    const reporter = createGadgetErrorReporter(send)
    reporter.add(posted('held'))

    reporter.flush()
    reporter.flush()
    expect(send).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(1)

    await vi.advanceTimersByTimeAsync(GADGET_ERROR_FLUSH_MS)
    expect(send).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(1)
  })

  // A page hidden during a send flushes then. A second send beside the first would take its
  // place as the one in flight and leave the first's give-up timer running.
  it('sends nothing when flushed while a send is in flight, and sends it once that one settles', async () => {
    const { send, sends } = deferredSend()
    const reporter = createGadgetErrorReporter(send)
    reporter.add(posted('first'))
    await vi.advanceTimersByTimeAsync(GADGET_ERROR_FLUSH_MS)
    expect(send).toHaveBeenCalledTimes(1)
    reporter.add(posted('second'))

    reporter.flush()
    expect(send).toHaveBeenCalledTimes(1)
    // The one timer is the one that gives the send in flight up.
    expect(vi.getTimerCount()).toBe(1)

    sends[0].resolve()
    await vi.advanceTimersByTimeAsync(GADGET_ERROR_FLUSH_MS)
    expect(send).toHaveBeenCalledTimes(2)
    expect(sentBy(send, 2)).toStrictEqual([{ text: 'Uncaught second' }])
  })

  it('sends what is queued when stopped, even while a send is in flight, and nothing afterwards', async () => {
    const { send, sends } = deferredSend()
    const reporter = createGadgetErrorReporter(send)
    reporter.add(posted('first'))
    await vi.advanceTimersByTimeAsync(GADGET_ERROR_FLUSH_MS)
    reporter.add(posted('second'))

    reporter.stop()
    expect(send).toHaveBeenCalledTimes(2)
    expect(sentBy(send, 2)).toStrictEqual([{ text: 'Uncaught second' }])
    expect(vi.getTimerCount()).toBe(0)

    reporter.add(posted('late'))
    sends[0].resolve()
    sends[1].resolve()
    await vi.advanceTimersByTimeAsync(GADGET_ERROR_MAX_BACKOFF_MS)
    expect(send).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('discards its queue when stopped with nothing to send through', async () => {
    let connected = false
    const send = vi.fn<Send>(() => connected ? Promise.resolve() : null)
    const reporter = createGadgetErrorReporter(send)
    reporter.add(posted('held'))

    reporter.stop()
    expect(send).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)

    // The queue is lost, on purpose: a reporter kept alive to wait for the connection would
    // outlive the view that owns it.
    connected = true
    await vi.advanceTimersByTimeAsync(GADGET_ERROR_MAX_BACKOFF_MS)
    expect(send).toHaveBeenCalledTimes(1)
  })

  // A stopped reporter logs a send that is refused and does nothing else: no timer, no further
  // send through a stub its view has let go. `true` is what logRpcFailure answers for a
  // connection failure, which is what a disposed stub's refusal is.
  it.each([true, false])('does nothing further once stopped (a failure a reconnect cures: %s)', async transient => {
    vi.mocked(logRpcFailure).mockReturnValue(transient)
    const { send, sends } = deferredSend()
    const reporter = createGadgetErrorReporter(send)
    reporter.add(posted('first'))
    await vi.advanceTimersByTimeAsync(GADGET_ERROR_FLUSH_MS)
    reporter.add(posted('second'))

    reporter.stop()
    expect(send).toHaveBeenCalledTimes(2)
    // The first send's give-up timer is cleared and the final send starts none.
    expect(vi.getTimerCount()).toBe(0)

    sends[0].reject(new Error('refused'))
    sends[1].reject(new Error('refused'))
    await vi.advanceTimersByTimeAsync(0)
    // Each failure is logged, with no report site, and nothing else follows.
    expect(logRpcFailure).toHaveBeenCalledTimes(2)
    for (const call of vi.mocked(logRpcFailure).mock.calls) expect(call).toHaveLength(2)
    expect(vi.getTimerCount()).toBe(0)

    await vi.advanceTimersByTimeAsync(2 * GADGET_ERROR_MAX_BACKOFF_MS)
    expect(send).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('never gives up its final send', async () => {
    const { send } = deferredSend()
    const reporter = createGadgetErrorReporter(send)
    reporter.add(posted('last'))
    reporter.stop()
    expect(send).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(GADGET_ERROR_SEND_TIMEOUT_MS + GADGET_ERROR_FLUSH_MS)
    expect(send).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('queues and sends nothing once it was stopped', async () => {
    const send = vi.fn<Send>(async () => {})
    const reporter = createGadgetErrorReporter(send)
    reporter.add(posted('last'))
    reporter.stop()
    expect(send).toHaveBeenCalledTimes(1)

    // No send is in flight here, so only the reporter being stopped keeps a timer from being armed.
    reporter.add(posted('late'))
    expect(vi.getTimerCount()).toBe(0)
    reporter.flush()
    await vi.advanceTimersByTimeAsync(GADGET_ERROR_FLUSH_MS)
    expect(send).toHaveBeenCalledTimes(1)
  })

  // A view whose frame threw nothing makes no call as it goes away.
  it('sends nothing when stopped with nothing queued', () => {
    const send = vi.fn<Send>(async () => {})
    createGadgetErrorReporter(send).stop()
    expect(send).not.toHaveBeenCalled()
  })
})

describe('uncaughtErrorText', () => {
  it("takes what the frame's listeners post", () => {
    const stack = 'Error: x\n    at render (client.js:12:9)'
    expect(uncaughtErrorText(['Uncaught', stack])).toBe(`Uncaught ${stack}`)
    expect(uncaughtErrorText(['Unhandled promise rejection:', 'undefined'])).toBe('Unhandled promise rejection: undefined')
    // An error event with no error and no message posts an undefined part.
    expect(uncaughtErrorText(['Uncaught', undefined])).toBe('Uncaught undefined')
    expect(uncaughtErrorText(['a', 'b c', 5, true, null, undefined])).toBe('a b c 5 true null undefined')
    expect(uncaughtErrorText([])).toBe('')
  })

  it('handles a message that is not an array', () => {
    expect(uncaughtErrorText('just text')).toBe('just text')
    expect(uncaughtErrorText(5)).toBe('5')
    expect(uncaughtErrorText(undefined)).toBe('undefined')
    expect(uncaughtErrorText(null)).toBe('null')
    expect(uncaughtErrorText({ length: 2 ** 32 - 1 })).toBe('[object Object]')
    expect(uncaughtErrorText('x'.repeat(5_000))).toBe('x'.repeat(MAX_REPORTED_GADGET_ERROR_TEXT_LENGTH))
  })

  it('names a part by its kind and never prints its content', () => {
    const stringify = vi.spyOn(JSON, 'stringify')
    const toString = vi.fn<() => string>(() => {
      throw new Error('the part was printed')
    })
    // String() joins the array's elements, and throws on the object whose toString and valueOf
    // are not functions.
    const text = uncaughtErrorText([{ a: 1 }, [1, 2], 10n, { toString: 1, valueOf: 2 }, { toString }])
    const stringified = stringify.mock.calls.length
    stringify.mockRestore()

    expect(text).toBe('[object Object] [object Array] [object BigInt] [object Object] [object Object]')
    expect(toString).not.toHaveBeenCalled()
    expect(stringified).toBe(0)
  })

  // No timing is asserted. A form that visits every index of the posted array does not finish
  // inside the test timeout, so it fails by timing out.
  it('reads a bounded number of parts from a message that stands for 2^32 - 1', () => {
    const text = uncaughtErrorText(sparseArray(2 ** 32 - 1))
    expect(text).toHaveLength(MAX_REPORTED_GADGET_ERROR_TEXT_LENGTH)
    expect(text.startsWith('undefined undefined ')).toBe(true)
  })

  // String() of one such part is a string of 500 MB, and twenty of them exhaust the heap.
  it('names parts that are huge sparse arrays without printing them', () => {
    const text = uncaughtErrorText(Array.from({ length: 20 }, () => sparseArray(5e8)))
    expect(text).toBe(Array.from({ length: 20 }, () => '[object Array]').join(' '))
  })

  it.each<{ name: string; message: string[]; text: string }>([
    { name: 'two short parts', message: ['a', 'b'], text: 'a b' },
    { name: 'one part of 5,000 characters', message: ['x'.repeat(5_000)], text: 'x'.repeat(4_000) },
    {
      name: 'a part of 3,999 characters and one more',
      message: ['x'.repeat(3_999), 'y'],
      text: `${'x'.repeat(3_999)} `,
    },
    { name: 'a part of 4,000 characters and one more', message: ['x'.repeat(4_000), 'y'], text: 'x'.repeat(4_000) },
    {
      name: 'more empty parts than the text has characters',
      message: Array.from({ length: MAX_REPORTED_GADGET_ERROR_TEXT_LENGTH + 100 }, () => ''),
      text: ' '.repeat(4_000),
    },
    {
      name: 'a short part and one of 1,000,000 characters',
      message: ['Uncaught', 'z'.repeat(1_000_000)],
      text: `Uncaught ${'z'.repeat(3_991)}`,
    },
  ])('joins the parts by spaces and cuts to what a report reads: $name', ({ message, text }) => {
    const cut = uncaughtErrorText(message)
    expect(cut).toBe(message.join(' ').slice(0, MAX_REPORTED_GADGET_ERROR_TEXT_LENGTH))
    expect(cut).toBe(text)
  })

  it('reads no more parts than can add to the text', () => {
    const { message, reads } = countingMessage()
    const parts = message as unknown[]
    for (let i = 0; i < 10_000; i++) parts.push('')
    reads.count = 0

    expect(uncaughtErrorText(message)).toHaveLength(MAX_REPORTED_GADGET_ERROR_TEXT_LENGTH)
    // Each part read costs a look at the length and one at the part.
    expect(reads.count).toBeLessThanOrEqual(2 * (MAX_REPORTED_GADGET_ERROR_TEXT_LENGTH + 2))
  })
})
