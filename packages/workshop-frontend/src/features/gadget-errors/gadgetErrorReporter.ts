import {
  type ReportedGadgetError,
  MAX_GADGET_ERRORS_PER_CALL,
  MAX_REPORTED_GADGET_ERROR_TEXT_LENGTH,
} from '@gadgets/workshop-shared/api'
import { logRpcFailure } from '../../rpcErrors'

/** How long a captured error waits before it is sent. */
export const GADGET_ERROR_FLUSH_MS = 5_000

/** The longest a reporter waits between sends after the server has refused one. */
export const GADGET_ERROR_MAX_BACKOFF_MS = 5 * 60_000

/** How long a send may stay unsettled before it is given up: a dropped RPC never settles. */
export const GADGET_ERROR_SEND_TIMEOUT_MS = 30_000

// One posted part as a string, in constant time. Only a primitive whose text has a bounded
// length goes through String(): of anything else it costs what the frame chose (an array's
// elements joined, a BigInt's digits) or throws (an object whose toString and valueOf are not
// functions), so the rest is named by its kind and never printed.
const printedPart = (part: unknown): string => {
  if (typeof part === 'string') return part
  if (part === null || part === undefined || typeof part === 'number' || typeof part === 'boolean') {
    return String(part)
  }
  return Object.prototype.toString.call(part)
}

/**
 * The text of an uncaught error as a gadget's frame posted it (its `message`: a label and the
 * error's stack or message), in a time and a size that do not depend on what the frame posted:
 * its parts joined by spaces, read by index until MAX_REPORTED_GADGET_ERROR_TEXT_LENGTH characters
 * are held, a string as it is, a number, boolean, null or undefined through String(), anything
 * else named by its kind. The result is a string of its own, not a slice of a posted one.
 *
 * The frame's code is the gadget's, and a few bytes can stand for an array of 2^32 - 1 parts. A
 * posted value is a structured clone, with no getters and none of the frame's methods, so this
 * neither throws nor runs the frame's code.
 */
export const uncaughtErrorText = (
  message: unknown,
  location?: string | (() => string | undefined),
  clean?: (part: string, clipped: boolean) => string,
): string => {
  // A part as it is kept: `clean` is given at most what is left of CLEAN_WINDOW, counted across
  // the parts, so its cost has a bound whatever the frame posted, however many long parts clean to
  // a little text each. Its answer is cut like any part.
  let unread = CLEAN_WINDOW
  const kept = (part: unknown) => {
    const printed = printedPart(part)
    if (!clean) return printed
    const window = printed.slice(0, unread)
    unread -= window.length
    return clean(window, printed.length > window.length)
  }
  // From each part only what is still missing is taken: one part may be tens of megabytes, so
  // none is joined or copied whole. Not cut to the length the server keeps: it redacts before it
  // cuts, and must see the whole of a token that straddles the cut.
  let text = ''
  if (Array.isArray(message)) {
    // An index loop that ends once the text is full: a map, a spread, an iteration or a join
    // would visit every index up to the length the frame chose. Each part after the first adds
    // a space, so the loop reads at most one part more than the text has characters.
    for (let i = 0; i < message.length && text.length < MAX_REPORTED_GADGET_ERROR_TEXT_LENGTH; i++) {
      // kept() spends the window; once it is spent no part is read.
      if (clean && unread === 0) break
      if (i > 0) text += ' '
      text += kept(message[i]).slice(0, MAX_REPORTED_GADGET_ERROR_TEXT_LENGTH - text.length)
    }
  } else {
    text = kept(message).slice(0, MAX_REPORTED_GADGET_ERROR_TEXT_LENGTH)
  }
  // Where it happened, as the live console shows it, within what is left of the bound.
  const where = text.length < MAX_REPORTED_GADGET_ERROR_TEXT_LENGTH
    ? (typeof location === 'function' ? location() : location) : undefined
  if (where !== undefined) {
    text += ` at ${where}`.slice(0, MAX_REPORTED_GADGET_ERROR_TEXT_LENGTH - text.length)
  }
  // A string of its own. A slice shares its parent's characters in the engines the Workshop
  // runs in, so a slice of a very long posted string would keep the whole of it alive for as
  // long as it is queued: seconds, or minutes while a send backs off or the connection is
  // lost. A string joined from its characters holds only them.
  return [...text].join('')
}

// How much of the posted parts, together, a `clean` of uncaughtErrorText() reads: enough for it to
// replace a long run (a module's data: URL) with a short name and still fill the text with what
// follows.
const CLEAN_WINDOW = 16 * MAX_REPORTED_GADGET_ERROR_TEXT_LENGTH

/** Queues the uncaught errors of one gadget view and sends them. */
export type GadgetErrorReporter = {
  /**
   * Queues one error for the next send, given the `message` its frame posted and what says
   * where it happened. Once MAX_GADGET_ERRORS_PER_CALL are queued, or the reporter was stopped,
   * the error is dropped and neither is read at all: uncaughtErrorText() runs, and `location` is
   * called, only for an error that is queued, and `location` only while the text has room.
   */
  add(message: unknown, location?: () => string | undefined, clean?: (part: string, clipped: boolean) => string): void
  /** Sends what is queued without waiting for the interval, unless a send is in flight. */
  flush(): void
  /** Sends what is queued one last time and ends the reporter. */
  stop(): void
}

const SEND_FAILURE = 'Failed to report gadget errors:'

/**
 * A reporter that queues the uncaught errors of one gadget view and hands them to `send`, one
 * GADGET_ERROR_FLUSH_MS after the first is queued and one send at a time. The queue holds at
 * most MAX_GADGET_ERRORS_PER_CALL errors, the first of a burst: the ones after them are dropped
 * unread and nothing marks them. A send that is refused, or given up after
 * GADGET_ERROR_SEND_TIMEOUT_MS, is not sent again and its errors are lost; each refusal that is
 * not transient doubles the wait, up to GADGET_ERROR_MAX_BACKOFF_MS, and a send that is
 * accepted brings it back to GADGET_ERROR_FLUSH_MS.
 *
 * `send` returns null when there is nothing to send through just now, which keeps the queue.
 * stop() sends what is queued once more and ends the reporter: from then on a send that fails
 * is logged and nothing else, so a stopped reporter never sends again.
 *
 * Only the RPC failure of a send is logged, never a queued text, and it goes to the browser's
 * console alone: a gadget's errors are its workspace's content.
 */
export const createGadgetErrorReporter = (
  send: (entries: ReportedGadgetError[]) => PromiseLike<void> | null,
): GadgetErrorReporter => {
  let queue: ReportedGadgetError[] = []
  // The send whose settlement is awaited, or null. A send that was given up is no longer this
  // one, which is how its late settlement is ignored.
  let inFlight: object | null = null
  let flushTimer: ReturnType<typeof setTimeout> | undefined
  let giveUpTimer: ReturnType<typeof setTimeout> | undefined
  let delay = GADGET_ERROR_FLUSH_MS
  let stopped = false

  const arm = () => {
    if (flushTimer !== undefined || inFlight !== null || queue.length === 0) return
    flushTimer = setTimeout(flush, delay)
  }

  const flush = () => {
    if (stopped) return
    clearTimeout(flushTimer)
    flushTimer = undefined
    if (inFlight !== null || queue.length === 0) return

    const sending = send(queue)
    if (sending === null) {
      arm()
      return
    }

    queue = []
    const current = (inFlight = {})
    const settle = (nextDelay: number) => {
      clearTimeout(giveUpTimer)
      inFlight = null
      delay = nextDelay
      arm()
    }

    // A dropped RPC never settles, and would hold every later error back.
    giveUpTimer = setTimeout(() => settle(delay), GADGET_ERROR_SEND_TIMEOUT_MS)

    sending.then(
      () => {
        if (inFlight === current && !stopped) settle(GADGET_ERROR_FLUSH_MS)
      },
      (err: unknown) => {
        if (inFlight !== current) return
        // No report site: with one, logRpcFailure() also sends the failure to the deployment's
        // error reporting, where nothing about a gadget's errors goes.
        const transient = logRpcFailure(SEND_FAILURE, err)
        // A stopped reporter keeps no account, of its wait or of anything else: what a view has
        // in flight as it goes away is logged once when it is refused, and lost.
        if (stopped) return
        // A transient failure leaves the wait alone: the reconnect cures it, and reporting
        // resumes within one interval of it.
        settle(transient ? delay : Math.min(delay * 2, GADGET_ERROR_MAX_BACKOFF_MS))
      },
    )
  }

  return {
    add(message, location, clean) {
      // Both checks come before `message` is touched, so that an error that is dropped costs
      // two comparisons: a frame in a tight throw loop posts one message after another, and
      // reading each would make the page pay for every one of them.
      if (stopped || queue.length >= MAX_GADGET_ERRORS_PER_CALL) return
      queue.push({ text: uncaughtErrorText(message, location, clean) })
      arm()
    },

    flush,

    stop() {
      stopped = true
      clearTimeout(flushTimer)
      clearTimeout(giveUpTimer)
      flushTimer = undefined
      if (queue.length === 0) return

      // Nothing later will send what is queued, so it goes at once, even while a send is in
      // flight, and with no give-up timer: giving a send up frees the next one, and there is
      // none. When there is nothing to send through (the connection is lost, or the workspace
      // has none) the queue is discarded, since nothing later could send it.
      const sending = send(queue)
      queue = []
      sending?.then(undefined, (err: unknown) => {
        logRpcFailure(SEND_FAILURE, err)
      })
    },
  }
}
