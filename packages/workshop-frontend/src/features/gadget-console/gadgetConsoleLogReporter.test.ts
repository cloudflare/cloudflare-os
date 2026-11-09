import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type ConsoleLogEvent,
  type ReportedGadgetConsoleLog,
  MAX_GADGET_CONSOLE_LOGS_PER_CALL,
  MAX_REPORTED_GADGET_CONSOLE_LOG_TEXT_LENGTH,
} from '@gadgets/workshop-shared/api'
import { logRpcFailure } from '../../rpcErrors'
import {
  GADGET_CONSOLE_LOG_FLUSH_MS,
  GADGET_CONSOLE_LOG_MAX_BACKOFF_MS,
  GADGET_CONSOLE_LOG_MAX_PARTS,
  GADGET_CONSOLE_LOG_SEND_TIMEOUT_MS,
  consoleLogFromFrame,
  createGadgetConsoleLogReporter,
} from './gadgetConsoleLogReporter'

vi.mock('../../rpcErrors', () => ({
  logRpcFailure: vi.fn<(message: string, err: unknown) => boolean>(),
}))

type Send = (entries: ReportedGadgetConsoleLog[]) => PromiseLike<void> | null

const event = (text: string, level: ConsoleLogEvent['level'] = 'log'): ConsoleLogEvent =>
  ({ timestamp: new Date(), level, message: [text] })

const entry = (text: string, level: ConsoleLogEvent['level'] = 'log') =>
  ({ time: expect.any(Date), level, text })

const marker = (text: string) => entry(text, 'warn')

/** `count` entries named `prefix0`, `prefix1` and so on, as a batch holds them. */
const entries = (prefix: string, from: number, count: number) =>
  Array.from({ length: count }, (_, i) => entry(`${prefix}${from + i}`))

/** A `send` whose sends stay unsettled until the test settles them, in the order they were made. */
const deferredSend = () => {
  const sends: { resolve: () => void; reject: (err: unknown) => void }[] = []
  const send = vi.fn<Send>(() => new Promise<void>((resolve, reject) => {
    sends.push({ resolve, reject })
  }))
  return { send, sends }
}

/** The batch `send` was given by its `call`th call, counted from one. */
const batchOf = (send: Mock<Send>, call: number) => send.mock.calls[call - 1][0]

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

beforeEach(() => {
  vi.useFakeTimers()
  vi.mocked(logRpcFailure).mockReset().mockReturnValue(false)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('createGadgetConsoleLogReporter', () => {
  it('sends nothing before the interval, then one batch of the entries in order', async () => {
    const send = vi.fn<Send>(async () => {})
    const reporter = createGadgetConsoleLogReporter(send)
    const first: ConsoleLogEvent = { timestamp: new Date(1_000), level: 'warn', message: ['a', 'b'] }
    const second: ConsoleLogEvent = { timestamp: new Date(2_000), level: 'error', message: ['c'] }
    reporter.add(first)
    reporter.add(second)

    await vi.advanceTimersByTimeAsync(GADGET_CONSOLE_LOG_FLUSH_MS - 1)
    expect(send).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(send).toHaveBeenCalledTimes(1)
    expect(batchOf(send, 1)).toStrictEqual([
      { time: first.timestamp, level: 'warn', text: 'a b' },
      { time: second.timestamp, level: 'error', text: 'c' },
    ])
  })

  it('cuts a text to what a report reads, and sends a shorter one whole', async () => {
    const send = vi.fn<Send>(async () => {})
    const reporter = createGadgetConsoleLogReporter(send)
    reporter.add(event('x'.repeat(MAX_REPORTED_GADGET_CONSOLE_LOG_TEXT_LENGTH + 1_000)))
    reporter.add(event('y'.repeat(3_000)))

    await vi.advanceTimersByTimeAsync(GADGET_CONSOLE_LOG_FLUSH_MS)
    expect(batchOf(send, 1).map(sent => sent.text)).toStrictEqual([
      'x'.repeat(MAX_REPORTED_GADGET_CONSOLE_LOG_TEXT_LENGTH),
      'y'.repeat(3_000),
    ])
  })

  it.each<{ name: string; message: string[]; text: string }>([
    { name: 'two short parts', message: ['a', 'b'], text: 'a b' },
    { name: 'no parts', message: [], text: '' },
    { name: 'one part of 5,000 characters', message: ['x'.repeat(5_000)], text: 'x'.repeat(4_000) },
    {
      name: 'a part of 3,999 characters and one more',
      message: ['x'.repeat(3_999), 'y'],
      text: `${'x'.repeat(3_999)} `,
    },
    { name: 'a part of 4,000 characters and one more', message: ['x'.repeat(4_000), 'y'], text: 'x'.repeat(4_000) },
    {
      name: 'as many empty parts as are read',
      message: Array.from({ length: GADGET_CONSOLE_LOG_MAX_PARTS }, () => ''),
      text: ' '.repeat(4_000),
    },
    {
      name: 'a short part and one of 1,000,000 characters',
      message: ['Uncaught', 'z'.repeat(1_000_000)],
      text: `Uncaught ${'z'.repeat(3_991)}`,
    },
  ])('sends the parts joined by spaces, then cut: $name', async ({ message, text }) => {
    const send = vi.fn<Send>(async () => {})
    const reporter = createGadgetConsoleLogReporter(send)
    reporter.add({ timestamp: new Date(), level: 'log', message })

    await vi.advanceTimersByTimeAsync(GADGET_CONSOLE_LOG_FLUSH_MS)
    const sent = batchOf(send, 1)[0].text
    expect(sent).toBe(message.join(' ').slice(0, MAX_REPORTED_GADGET_CONSOLE_LOG_TEXT_LENGTH))
    expect(sent).toBe(text)
  })

  it('keeps the newest entries of a burst and says how many it dropped', async () => {
    const send = vi.fn<Send>(async () => {})
    const reporter = createGadgetConsoleLogReporter(send)
    for (let i = 0; i < 60; i++) reporter.add(event(`burst${i}`))

    await vi.advanceTimersByTimeAsync(GADGET_CONSOLE_LOG_FLUSH_MS)
    expect(send).toHaveBeenCalledTimes(1)
    expect(batchOf(send, 1)).toHaveLength(MAX_GADGET_CONSOLE_LOGS_PER_CALL)
    expect(batchOf(send, 1)).toStrictEqual([marker('11 entries dropped'), ...entries('burst', 11, 49)])

    reporter.add(event('after'))
    await vi.advanceTimersByTimeAsync(GADGET_CONSOLE_LOG_FLUSH_MS)
    expect(send).toHaveBeenCalledTimes(2)
    expect(batchOf(send, 2)).toStrictEqual([entry('after')])
  })

  it('keeps the error that ends a burst', async () => {
    const send = vi.fn<Send>(async () => {})
    const reporter = createGadgetConsoleLogReporter(send)
    for (let i = 0; i < 100; i++) reporter.add(event(`noise${i}`))
    reporter.add(event('the error', 'error'))

    await vi.advanceTimersByTimeAsync(GADGET_CONSOLE_LOG_FLUSH_MS)
    expect(batchOf(send, 1).at(-1)).toStrictEqual(entry('the error', 'error'))
  })

  it('bounds a batch by its characters as well', async () => {
    const send = vi.fn<Send>(async () => {})
    const reporter = createGadgetConsoleLogReporter(send)
    const texts = Array.from({ length: 30 }, (_, i) => String(i).padEnd(4_000, '.'))
    for (const text of texts) reporter.add(event(text))

    await vi.advanceTimersByTimeAsync(GADGET_CONSOLE_LOG_FLUSH_MS)
    expect(batchOf(send, 1)).toStrictEqual([
      marker('5 entries dropped'),
      ...texts.slice(5).map(text => entry(text)),
    ])

    // The characters of a batch that has gone do not count against the next one.
    reporter.add(event('short0'))
    reporter.add(event('short1'))
    await vi.advanceTimersByTimeAsync(GADGET_CONSOLE_LOG_FLUSH_MS)
    expect(batchOf(send, 2)).toStrictEqual([entry('short0'), entry('short1')])
  })

  it('sends one batch at a time', async () => {
    const { send, sends } = deferredSend()
    const reporter = createGadgetConsoleLogReporter(send)
    reporter.add(event('first'))
    await vi.advanceTimersByTimeAsync(GADGET_CONSOLE_LOG_FLUSH_MS)
    expect(send).toHaveBeenCalledTimes(1)

    for (let i = 0; i < 60; i++) reporter.add(event(`queued${i}`))
    await vi.advanceTimersByTimeAsync(3 * GADGET_CONSOLE_LOG_FLUSH_MS)
    expect(send).toHaveBeenCalledTimes(1)

    sends[0].resolve()
    await vi.advanceTimersByTimeAsync(GADGET_CONSOLE_LOG_FLUSH_MS - 1)
    expect(send).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(send).toHaveBeenCalledTimes(2)
    expect(batchOf(send, 2)).toStrictEqual([marker('11 entries dropped'), ...entries('queued', 11, 49)])
  })

  it.each<{ how: string; settleLate: (sent: { resolve: () => void; reject: (err: unknown) => void }) => void }>([
    { how: 'fulfils', settleLate: sent => sent.resolve() },
    { how: 'is refused', settleLate: sent => sent.reject(new Error('refused late')) },
  ])('gives up a send that never settles, and ignores it when it later $how', async ({ settleLate }) => {
    const { send, sends } = deferredSend()
    const reporter = createGadgetConsoleLogReporter(send)
    reporter.add(event('lost0'))
    reporter.add(event('lost1'))
    await vi.advanceTimersByTimeAsync(GADGET_CONSOLE_LOG_FLUSH_MS)
    expect(send).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(GADGET_CONSOLE_LOG_SEND_TIMEOUT_MS - 1)
    expect(send).toHaveBeenCalledTimes(1)
    reporter.add(event('next'))
    await vi.advanceTimersByTimeAsync(1 + GADGET_CONSOLE_LOG_FLUSH_MS)
    expect(send).toHaveBeenCalledTimes(2)
    expect(batchOf(send, 2)).toStrictEqual([marker('2 entries dropped'), entry('next')])

    // The send that was given up settles after all, while the next is in flight: nothing is
    // logged, counted or sent for it, and the send in flight stays the only one.
    settleLate(sends[0])
    reporter.add(event('queued'))
    await vi.advanceTimersByTimeAsync(GADGET_CONSOLE_LOG_FLUSH_MS)
    expect(send).toHaveBeenCalledTimes(2)
    expect(logRpcFailure).not.toHaveBeenCalled()

    sends[1].resolve()
    await vi.advanceTimersByTimeAsync(GADGET_CONSOLE_LOG_FLUSH_MS)
    expect(send).toHaveBeenCalledTimes(3)
    expect(batchOf(send, 3)).toStrictEqual([entry('queued')])
  })

  it('waits twice as long after each refusal, up to a limit, and as before after a success', async () => {
    const { send, sends } = deferredSend()
    const reporter = createGadgetConsoleLogReporter(send)
    reporter.add(event('refused'))
    await vi.advanceTimersByTimeAsync(GADGET_CONSOLE_LOG_FLUSH_MS)
    expect(send).toHaveBeenCalledTimes(1)

    // Each refused batch leaves a count behind, so a batch of one marker follows it. The sixth
    // wait would be 320 seconds if nothing bounded it.
    const waits = [10_000, 20_000, 40_000, 80_000, 160_000, GADGET_CONSOLE_LOG_MAX_BACKOFF_MS, GADGET_CONSOLE_LOG_MAX_BACKOFF_MS]
    for (const [refused, wait] of waits.entries()) {
      sends[refused].reject(new Error('refused'))
      await vi.advanceTimersByTimeAsync(wait - 1)
      expect(send).toHaveBeenCalledTimes(refused + 1)
      await vi.advanceTimersByTimeAsync(1)
      expect(send).toHaveBeenCalledTimes(refused + 2)
    }

    sends[7].resolve()
    await vi.advanceTimersByTimeAsync(GADGET_CONSOLE_LOG_MAX_BACKOFF_MS)
    reporter.add(event('accepted'))
    await vi.advanceTimersByTimeAsync(GADGET_CONSOLE_LOG_FLUSH_MS - 1)
    expect(send).toHaveBeenCalledTimes(8)
    await vi.advanceTimersByTimeAsync(1)
    expect(send).toHaveBeenCalledTimes(9)
    expect(batchOf(send, 9)).toStrictEqual([entry('accepted')])
  })

  it('keeps its interval after a failure a reconnect cures', async () => {
    vi.mocked(logRpcFailure).mockReturnValue(true)
    const { send, sends } = deferredSend()
    const reporter = createGadgetConsoleLogReporter(send)
    reporter.add(event('refused'))
    await vi.advanceTimersByTimeAsync(GADGET_CONSOLE_LOG_FLUSH_MS)

    for (let refusals = 1; refusals <= 3; refusals++) {
      sends[refusals - 1].reject(new Error('Peer closed WebSocket'))
      await vi.advanceTimersByTimeAsync(GADGET_CONSOLE_LOG_FLUSH_MS - 1)
      expect(send).toHaveBeenCalledTimes(refusals)
      await vi.advanceTimersByTimeAsync(1)
      expect(send).toHaveBeenCalledTimes(refusals + 1)
    }
  })

  it('says in its next batch how many entries a refused batch held', async () => {
    const send = vi.fn<Send>(async () => {})
      .mockImplementationOnce(() => Promise.reject(new Error('refused')))
    const reporter = createGadgetConsoleLogReporter(send)
    for (let i = 0; i < 3; i++) reporter.add(event(`refused${i}`))
    await vi.advanceTimersByTimeAsync(GADGET_CONSOLE_LOG_FLUSH_MS)
    expect(logRpcFailure).toHaveBeenCalledWith('Failed to report gadget console logs:', expect.any(Error))

    reporter.add(event('next'))
    // The rejection is handled by the reporter: one nothing handled would fail the run.
    await vi.advanceTimersByTimeAsync(GADGET_CONSOLE_LOG_MAX_BACKOFF_MS)
    expect(send).toHaveBeenCalledTimes(2)
    expect(batchOf(send, 2)).toStrictEqual([marker('3 entries dropped'), entry('next')])
  })

  it.each<{ way: string; fail: (sent: { reject: (err: unknown) => void }) => Promise<void> }>([
    {
      way: 'is refused',
      fail: async sent => {
        sent.reject(new Error('Peer closed WebSocket'))
        await vi.advanceTimersByTimeAsync(GADGET_CONSOLE_LOG_FLUSH_MS)
      },
    },
    {
      way: 'never settles and is given up',
      fail: async () => {
        await vi.advanceTimersByTimeAsync(GADGET_CONSOLE_LOG_SEND_TIMEOUT_MS + GADGET_CONSOLE_LOG_FLUSH_MS)
      },
    },
  ])('counts what a batch that $way stood for: its entries and what its marker reported', async ({ fail }) => {
    vi.mocked(logRpcFailure).mockReturnValue(true)
    const { send, sends } = deferredSend()
    const reporter = createGadgetConsoleLogReporter(send)
    for (let i = 0; i < 60; i++) reporter.add(event(`burst${i}`))
    await vi.advanceTimersByTimeAsync(GADGET_CONSOLE_LOG_FLUSH_MS)
    expect(batchOf(send, 1)).toStrictEqual([marker('11 entries dropped'), ...entries('burst', 11, 49)])

    await fail(sends[0])
    expect(send).toHaveBeenCalledTimes(2)
    // The 49 entries plus the 11 their marker reported. The marker is no entry: a count taken from
    // the failed batch's length would say 61, and one that kept only its entries 49.
    expect(batchOf(send, 2)).toStrictEqual([marker('60 entries dropped')])
  })

  it('keeps everything while there is nothing to send through', async () => {
    const send = vi.fn<Send>(async () => {}).mockReturnValueOnce(null).mockReturnValueOnce(null)
    const reporter = createGadgetConsoleLogReporter(send)
    reporter.add(event('a'))
    reporter.add(event('b'))

    await vi.advanceTimersByTimeAsync(2 * GADGET_CONSOLE_LOG_FLUSH_MS)
    expect(send).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(GADGET_CONSOLE_LOG_FLUSH_MS)
    expect(send).toHaveBeenCalledTimes(3)
    expect(batchOf(send, 3)).toStrictEqual([entry('a'), entry('b')])
  })

  it('holds its newest entries through an outage, and marks the rest once it is over', async () => {
    let connected = false
    const send = vi.fn<Send>(() => connected ? Promise.resolve() : null)
    const reporter = createGadgetConsoleLogReporter(send)

    for (let interval = 0; interval < 12; interval++) {
      for (let i = 0; i < 5; i++) reporter.add(event(`held${interval * 5 + i}`))
      await vi.advanceTimersByTimeAsync(GADGET_CONSOLE_LOG_FLUSH_MS)
      // The timer comes round once an interval: it does not spin.
      expect(send).toHaveBeenCalledTimes(interval + 1)
    }

    connected = true
    await vi.advanceTimersByTimeAsync(GADGET_CONSOLE_LOG_FLUSH_MS)
    expect(send).toHaveBeenCalledTimes(13)
    expect(batchOf(send, 13)).toStrictEqual([marker('11 entries dropped'), ...entries('held', 11, 49)])
  })

  it('runs no timer while it has nothing to send', async () => {
    const send = vi.fn<Send>(async () => {})
    const reporter = createGadgetConsoleLogReporter(send)
    await vi.advanceTimersByTimeAsync(GADGET_CONSOLE_LOG_MAX_BACKOFF_MS)
    expect(send).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)

    reporter.add(event('one'))
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(GADGET_CONSOLE_LOG_FLUSH_MS)
    expect(send).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('sends at once when flushed, in place of the send its interval would have made', () => {
    const { send } = deferredSend()
    const reporter = createGadgetConsoleLogReporter(send)
    reporter.add(event('now'))

    reporter.flush()
    expect(send).toHaveBeenCalledTimes(1)
    expect(batchOf(send, 1)).toStrictEqual([entry('now')])
    // The one timer left is the one that gives the send up: the interval's is cleared.
    expect(vi.getTimerCount()).toBe(1)
  })

  // A flush that left the interval's timer running would start one more chain of sends each time
  // it found nothing to send through.
  it('keeps one timer however often it is flushed with nothing to send through', async () => {
    const send = vi.fn<Send>(() => null)
    const reporter = createGadgetConsoleLogReporter(send)
    reporter.add(event('held'))

    reporter.flush()
    reporter.flush()
    expect(send).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(1)

    await vi.advanceTimersByTimeAsync(GADGET_CONSOLE_LOG_FLUSH_MS)
    expect(send).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('sends what is queued when stopped, even while a send is in flight, and nothing afterwards', async () => {
    const { send, sends } = deferredSend()
    const reporter = createGadgetConsoleLogReporter(send)
    reporter.add(event('first'))
    await vi.advanceTimersByTimeAsync(GADGET_CONSOLE_LOG_FLUSH_MS)
    reporter.add(event('second'))

    reporter.stop()
    expect(send).toHaveBeenCalledTimes(2)
    expect(batchOf(send, 2)).toStrictEqual([entry('second')])
    expect(vi.getTimerCount()).toBe(0)

    reporter.add(event('late'))
    sends[0].resolve()
    sends[1].resolve()
    await vi.advanceTimersByTimeAsync(GADGET_CONSOLE_LOG_MAX_BACKOFF_MS)
    expect(send).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('discards its queue when stopped with nothing to send through', async () => {
    let connected = false
    const send = vi.fn<Send>(() => connected ? Promise.resolve() : null)
    const reporter = createGadgetConsoleLogReporter(send)
    reporter.add(event('held'))

    reporter.stop()
    expect(send).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)

    // The queue is lost unmarked, on purpose: a stopped reporter has no later batch to send it in,
    // and one kept alive to wait for the connection would outlive the view that owns it.
    connected = true
    await vi.advanceTimersByTimeAsync(GADGET_CONSOLE_LOG_MAX_BACKOFF_MS)
    expect(send).toHaveBeenCalledTimes(1)
  })

  // What this guards: counted and re-armed, a refused last batch would send a marker through a dead
  // stub every interval for the life of the tab. `true` is what logRpcFailure answers for a
  // connection failure, which is what a disposed stub's refusal is.
  it.each([true, false])('keeps no account once stopped (a failure a reconnect cures: %s)', async transient => {
    vi.mocked(logRpcFailure).mockReturnValue(transient)
    const { send, sends } = deferredSend()
    const reporter = createGadgetConsoleLogReporter(send)
    reporter.add(event('first'))
    await vi.advanceTimersByTimeAsync(GADGET_CONSOLE_LOG_FLUSH_MS)
    reporter.add(event('second'))

    reporter.stop()
    expect(send).toHaveBeenCalledTimes(2)
    // The first send's give-up timer is cleared and the final send starts none.
    expect(vi.getTimerCount()).toBe(0)

    sends[0].reject(new Error('refused'))
    sends[1].reject(new Error('refused'))
    await vi.advanceTimersByTimeAsync(0)
    expect(logRpcFailure).toHaveBeenCalledTimes(2)
    // No timer is armed for a count that no batch could carry.
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(GADGET_CONSOLE_LOG_MAX_BACKOFF_MS)
    expect(vi.getTimerCount()).toBe(0)

    await vi.advanceTimersByTimeAsync(GADGET_CONSOLE_LOG_MAX_BACKOFF_MS)
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('never gives up its final send', async () => {
    const { send } = deferredSend()
    const reporter = createGadgetConsoleLogReporter(send)
    reporter.add(event('last'))
    reporter.stop()
    expect(send).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(GADGET_CONSOLE_LOG_SEND_TIMEOUT_MS + GADGET_CONSOLE_LOG_FLUSH_MS)
    expect(send).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('queues and sends nothing once it was stopped', async () => {
    const send = vi.fn<Send>(async () => {})
    const reporter = createGadgetConsoleLogReporter(send)
    reporter.add(event('last'))
    reporter.stop()
    expect(send).toHaveBeenCalledTimes(1)

    // No send is in flight here, so only the reporter being stopped keeps a timer from being armed.
    reporter.add(event('late'))
    expect(vi.getTimerCount()).toBe(0)
    reporter.flush()
    await vi.advanceTimersByTimeAsync(GADGET_CONSOLE_LOG_FLUSH_MS)
    expect(send).toHaveBeenCalledTimes(1)
  })

  // A view whose frame logged nothing makes no call as it goes away.
  it('sends nothing when stopped with nothing queued', () => {
    const send = vi.fn<Send>(async () => {})
    createGadgetConsoleLogReporter(send).stop()
    expect(send).not.toHaveBeenCalled()
  })

  it('says in its final batch how many entries it dropped', () => {
    const send = vi.fn<Send>(async () => {})
    const reporter = createGadgetConsoleLogReporter(send)
    for (let i = 0; i < 60; i++) reporter.add(event(`burst${i}`))

    reporter.stop()
    expect(send).toHaveBeenCalledTimes(1)
    expect(batchOf(send, 1)).toStrictEqual([marker('11 entries dropped'), ...entries('burst', 11, 49)])
  })

  it('sends a final batch of one marker when all it holds is a count', async () => {
    const send = vi.fn<Send>(async () => {})
      .mockImplementationOnce(() => Promise.reject(new Error('refused')))
    const reporter = createGadgetConsoleLogReporter(send)
    for (let i = 0; i < 3; i++) reporter.add(event(`refused${i}`))
    await vi.advanceTimersByTimeAsync(GADGET_CONSOLE_LOG_FLUSH_MS)
    expect(send).toHaveBeenCalledTimes(1)

    reporter.stop()
    expect(send).toHaveBeenCalledTimes(2)
    expect(batchOf(send, 2)).toStrictEqual([marker('3 entries dropped')])
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('consoleLogFromFrame', () => {
  it('takes what the frame patch posts', () => {
    expect(consoleLogFromFrame({ level: 'nope', message: [] }).level).toBe('log')
    expect(consoleLogFromFrame({ level: 'debug', message: [] }).level).toBe('debug')
    expect(consoleLogFromFrame({ level: 'log', message: 5 }).message).toStrictEqual(['5'])
    expect(consoleLogFromFrame({ level: 'log' }).message).toStrictEqual(['undefined'])
    // An undefined part is what the frame's patch posts for `console.log(undefined)`.
    expect(consoleLogFromFrame({ level: 'warn', message: ['a', 'b c', 5, true, null, undefined] })).toStrictEqual({
      timestamp: expect.any(Date),
      level: 'warn',
      message: ['a', 'b c', '5', 'true', 'null', 'undefined'],
    })
  })

  it('names a part by its kind and never prints its content', () => {
    const stringify = vi.spyOn(JSON, 'stringify')
    const toString = vi.fn<() => string>(() => {
      throw new Error('the part was printed')
    })
    const { message } = consoleLogFromFrame({
      level: 'log',
      // String() joins the array's elements, and throws on the object whose toString and valueOf
      // are not functions.
      message: [{ a: 1 }, [1, 2], 10n, { toString: 1, valueOf: 2 }, { toString }],
    })
    const stringified = stringify.mock.calls.length
    stringify.mockRestore()

    expect(message).toStrictEqual([
      '[object Object]', '[object Array]', '[object BigInt]', '[object Object]', '[object Object]',
    ])
    expect(toString).not.toHaveBeenCalled()
    expect(stringified).toBe(0)
  })

  // No timing is asserted. A form that visits every index of the posted array does not finish
  // inside the test timeout, so it fails by timing out.
  it('reads a bounded number of parts from a message that stands for 2^32 - 1', () => {
    const { message } = consoleLogFromFrame({ level: 'log', message: sparseArray(2 ** 32 - 1) })
    expect(message).toStrictEqual(Array.from({ length: GADGET_CONSOLE_LOG_MAX_PARTS }, () => 'undefined'))
  })

  // String() of one such part is a string of 500 MB, and twenty of them exhaust the heap.
  it('names parts that are huge sparse arrays without printing them', () => {
    const { message } = consoleLogFromFrame({
      level: 'log',
      message: Array.from({ length: 20 }, () => sparseArray(5e8)),
    })
    expect(message).toStrictEqual(Array.from({ length: 20 }, () => '[object Array]'))
  })

  it('reads no more parts than can add to the text a report reads', async () => {
    const parts = Array.from({ length: 5_000 }, (_, i) => `p${i}`)
    const log = consoleLogFromFrame({ level: 'log', message: parts })
    expect(log.message).toStrictEqual(parts.slice(0, GADGET_CONSOLE_LOG_MAX_PARTS))

    const send = vi.fn<Send>(async () => {})
    createGadgetConsoleLogReporter(send).add(log)
    await vi.advanceTimersByTimeAsync(GADGET_CONSOLE_LOG_FLUSH_MS)
    expect(batchOf(send, 1)).toHaveLength(1)
    expect(batchOf(send, 1)[0].text).toHaveLength(MAX_REPORTED_GADGET_CONSOLE_LOG_TEXT_LENGTH)
  })
})
