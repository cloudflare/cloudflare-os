import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ListOutputsResult, OutputSummary } from '@gadgets/workshop-shared/api'
import { CATCH_UP, catchUpDelay, readLibrary } from './readLibrary'

const output = (workpieceId: number) => ({ workpieceId }) as OutputSummary

/** A library whose index says it is catching up for the first `behind` reads. */
const library = (behind: number) => {
  let reads = 0
  return vi.fn<() => Promise<ListOutputsResult>>(async () => {
    reads++
    return { outputs: [output(reads)], catchingUp: reads <= behind }
  })
}

describe('readLibrary', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('waits between rounds while the index catches up, a second at first and then longer, up to five', () => {
    expect(Array.from({ length: 6 }, (_, round) => catchUpDelay(round))).toEqual([1000, 2000, 4000, 5000, 5000, 5000])
  })

  it('reads again only after a wait, showing what each round has, until the index has caught up', async () => {
    const list = library(2)
    const onRead = vi.fn<(outputs: OutputSummary[]) => void>()
    const done = readLibrary(list, onRead, new AbortController().signal)

    await vi.advanceTimersByTimeAsync(0)
    expect(list).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(999)
    expect(list).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(list).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(2000)
    expect(list).toHaveBeenCalledTimes(3)
    await done

    expect(onRead.mock.calls.map(([outputs]) => outputs)).toEqual([[output(1)], [output(2)], [output(3)]])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(list).toHaveBeenCalledTimes(3)
  })

  it('stops after a number of rounds when the index never catches up', async () => {
    const list = library(Infinity)
    const done = readLibrary(list, () => {}, new AbortController().signal)
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    await done
    expect(list).toHaveBeenCalledTimes(CATCH_UP.rounds)
  })

  it('reads and gives nothing more once aborted, whether waiting or reading, and leaves no timer', async () => {
    const waiting = new AbortController()
    const list = library(Infinity)
    const done = readLibrary(list, () => {}, waiting.signal)
    await vi.advanceTimersByTimeAsync(0)
    waiting.abort()
    await done
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(list).toHaveBeenCalledOnce()

    const reading = new AbortController()
    const onRead = vi.fn<(outputs: OutputSummary[]) => void>()
    let answer!: (result: ListOutputsResult) => void
    const pending = readLibrary(() => new Promise((resolve) => (answer = resolve)), onRead, reading.signal)
    reading.abort()
    answer({ outputs: [output(1)], catchingUp: true })
    await pending
    expect(onRead).not.toHaveBeenCalled()
  })

  it('rejects with a read that failed', async () => {
    await expect(readLibrary(() => Promise.reject(new Error('Index unavailable')), () => {}, new AbortController().signal)).rejects.toThrow('Index unavailable')
  })
})
