import type { ListOutputsResult, OutputSummary } from '@gadgets/workshop-shared/api'

/**
 * How the library is asked again while its index catches up: after a second, then twice as long
 * each time up to five, and no more than `rounds` times in all. An index that is still catching up
 * by then is shown as far as it got.
 */
export const CATCH_UP = { first: 1000, most: 5000, rounds: 12 }

/** How long to wait after round `round` (from 0) before the next. */
export const catchUpDelay = (round: number) => Math.min(CATCH_UP.first * 2 ** round, CATCH_UP.most)

/** Resolves after `ms`, or as soon as `signal` aborts, letting go of the timer either way. */
const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
  })

/**
 * Reads the library with `list`, giving `onRead` what it has each time, and reads it again while
 * it says it is catching up (see `CATCH_UP`). Nothing is read or given once `signal` aborts.
 * Rejects with the first failure.
 */
export const readLibrary = async (
  list: () => Promise<ListOutputsResult>,
  onRead: (outputs: OutputSummary[]) => void,
  signal: AbortSignal,
): Promise<void> => {
  for (let round = 0; !signal.aborted; round++) {
    const { outputs, catchingUp } = await list()
    if (signal.aborted) return
    onRead(outputs)
    if (!catchingUp || round + 1 >= CATCH_UP.rounds) return
    await wait(catchUpDelay(round), signal)
  }
}
