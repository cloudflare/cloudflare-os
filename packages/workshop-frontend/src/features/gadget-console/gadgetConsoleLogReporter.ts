import {
  type ConsoleLogEvent,
  type ReportedGadgetConsoleLog,
  MAX_GADGET_CONSOLE_LOGS_PER_CALL,
  MAX_REPORTED_GADGET_CONSOLE_LOG_TEXT_LENGTH,
  droppedGadgetConsoleLogsText,
} from '@gadgets/workshop-shared/api'
import { logRpcFailure } from '../../rpcErrors'

/** How long a captured console call waits before it is sent. */
export const GADGET_CONSOLE_LOG_FLUSH_MS = 5_000

/** The longest a reporter waits between sends after the server has refused one. */
export const GADGET_CONSOLE_LOG_MAX_BACKOFF_MS = 5 * 60_000

/** How long a send may stay unsettled before it is given up: a dropped RPC never settles. */
export const GADGET_CONSOLE_LOG_SEND_TIMEOUT_MS = 30_000

/**
 * The most characters of text one batch holds, so that it stays one modest message however its
 * text is escaped.
 */
export const GADGET_CONSOLE_LOG_BATCH_CHARS = 100_000

/**
 * The most arguments of one console call that are read from a frame's message. Joined by spaces,
 * that many already make MAX_REPORTED_GADGET_CONSOLE_LOG_TEXT_LENGTH characters, so no later
 * argument could add to the text a report reads.
 */
export const GADGET_CONSOLE_LOG_MAX_PARTS = MAX_REPORTED_GADGET_CONSOLE_LOG_TEXT_LENGTH + 1

const LEVELS: readonly ConsoleLogEvent['level'][] = ['debug', 'info', 'log', 'warn', 'error']

// One posted argument as a string, in constant time. Only a primitive whose text has a bounded
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
 * A `console` message from a gadget's frame as a ConsoleLogEvent, made in a time and a size that
 * do not depend on what the frame posted: its code is the gadget's, and a few bytes can stand for
 * an array of 2^32 - 1 arguments. An unknown level is "log". At most GADGET_CONSOLE_LOG_MAX_PARTS
 * arguments are read, by index, so the posted array is never visited whole. Each becomes a string
 * in constant time: a string as it is; a number, a boolean, null or undefined through String();
 * anything else by the name of its kind ("[object Array]"), since printing its content would cost
 * what the frame chose. A posted value is a structured clone, with no getters and none of the
 * frame's methods, so this neither throws nor runs the frame's code.
 */
export const consoleLogFromFrame = (data: { level?: unknown; message?: unknown }): ConsoleLogEvent => {
  const posted = data.message
  const message: string[] = []
  if (Array.isArray(posted)) {
    // An index loop over a bounded count: a map, a spread, an iteration or a join would visit
    // every index up to the length the frame chose.
    const count = Math.min(posted.length, GADGET_CONSOLE_LOG_MAX_PARTS)
    for (let i = 0; i < count; i++) message.push(printedPart(posted[i]))
  } else {
    message.push(printedPart(posted))
  }
  return {
    timestamp: new Date(),
    level: LEVELS.find(level => level === data.level) ?? 'log',
    message,
  }
}

/**
 * Batches the console calls captured from one gadget view and sends them (see
 * createGadgetConsoleLogReporter()).
 */
export type GadgetConsoleLogReporter = {
  /** Queues one captured call for the next batch. */
  add(log: ConsoleLogEvent): void
  /** Sends what is queued without waiting for the interval, unless a send is in flight. */
  flush(): void
  /** Sends what is queued one last time and ends the reporter. */
  stop(): void
}

const SEND_FAILURE = 'Failed to report gadget console logs:'

/**
 * A reporter that queues captured console calls and hands them to `send` in batches, one
 * GADGET_CONSOLE_LOG_FLUSH_MS after the first is queued and one at a time. A batch is at most
 * MAX_GADGET_CONSOLE_LOGS_PER_CALL entries and GADGET_CONSOLE_LOG_BATCH_CHARS characters: past
 * either, the oldest queued entries are dropped and counted, and the next batch starts with one
 * entry of level "warn" that says how many (droppedGadgetConsoleLogsText()). A batch that is
 * refused, or given up after GADGET_CONSOLE_LOG_SEND_TIMEOUT_MS, is not sent again: what it stood
 * for is added to that count, and each refusal that is not transient doubles the wait, up to
 * GADGET_CONSOLE_LOG_MAX_BACKOFF_MS.
 *
 * `send` returns null when there is nothing to send through just now, which keeps the batch
 * queued. stop() sends what is queued once more and ends the reporter's accounting: from then on
 * a send that fails is logged and nothing else, so a stopped reporter never sends again.
 */
export const createGadgetConsoleLogReporter = (
  send: (entries: ReportedGadgetConsoleLog[]) => PromiseLike<void> | null,
): GadgetConsoleLogReporter => {
  let queue: ReportedGadgetConsoleLog[] = []
  let queuedChars = 0
  let dropped = 0
  // The send whose settlement is awaited, or null. A send that was given up is no longer this
  // one, which is how its late settlement is ignored.
  let inFlight: object | null = null
  let flushTimer: ReturnType<typeof setTimeout> | undefined
  let giveUpTimer: ReturnType<typeof setTimeout> | undefined
  let delay = GADGET_CONSOLE_LOG_FLUSH_MS
  let stopped = false

  // The queue as one batch: the marker for what was dropped first, which keeps the batch within
  // MAX_GADGET_CONSOLE_LOGS_PER_CALL entries because the queue holds one fewer.
  const batch = (): ReportedGadgetConsoleLog[] => dropped === 0 ? queue : [
    { time: new Date(), level: 'warn', text: droppedGadgetConsoleLogsText(dropped) },
    ...queue,
  ]

  const clearQueue = () => {
    queue = []
    queuedChars = 0
    dropped = 0
  }

  const arm = () => {
    if (flushTimer !== undefined || inFlight !== null) return
    if (queue.length === 0 && dropped === 0) return
    flushTimer = setTimeout(flush, delay)
  }

  const flush = () => {
    if (stopped) return
    clearTimeout(flushTimer)
    flushTimer = undefined
    if (inFlight !== null || (queue.length === 0 && dropped === 0)) return

    const sending = send(batch())
    if (sending === null) {
      arm()
      return
    }

    // What the batch stands for, should it be lost: the captured entries it carries plus the
    // number its marker reports. The marker itself stands for no console call.
    const stoodFor = queue.length + dropped
    clearQueue()
    const current = (inFlight = {})
    const settle = (lost: number, nextDelay: number) => {
      clearTimeout(giveUpTimer)
      inFlight = null
      dropped += lost
      delay = nextDelay
      arm()
    }

    // A dropped RPC never settles, and would hold every later batch back. Giving it up makes the
    // count an estimate: the server may still have recorded the batch, so a marker can count
    // entries that were kept.
    giveUpTimer = setTimeout(() => settle(stoodFor, delay), GADGET_CONSOLE_LOG_SEND_TIMEOUT_MS)

    sending.then(
      () => {
        if (inFlight === current && !stopped) settle(0, GADGET_CONSOLE_LOG_FLUSH_MS)
      },
      (err: unknown) => {
        if (inFlight !== current) return
        const transient = logRpcFailure(SEND_FAILURE, err)
        // A stopped reporter keeps no account: no later batch could carry the count, and counting
        // it would arm the timer for a batch of one marker, sent through a stub the view no
        // longer follows and refused in turn, every interval for the life of the tab (a disposed
        // stub's refusal is transient, so nothing would slow it). What a view sends last, or has
        // in flight as it goes away, is logged once when it is refused and lost unmarked.
        if (stopped) return
        // A transient failure leaves the wait alone: the reconnect cures it, and reporting
        // resumes within one interval of it.
        settle(stoodFor, transient ? delay : Math.min(delay * 2, GADGET_CONSOLE_LOG_MAX_BACKOFF_MS))
      },
    )
  }

  return {
    add(log) {
      if (stopped) return

      // The first MAX_REPORTED_GADGET_CONSOLE_LOG_TEXT_LENGTH characters of the parts joined by
      // spaces, taking from each part only what is still missing: one part may be tens of
      // megabytes, so none is joined or copied whole. Not cut to the length the server keeps: it
      // redacts before it cuts, and must see the whole of a token that straddles the cut.
      let text = ''
      for (let i = 0; i < log.message.length && text.length < MAX_REPORTED_GADGET_CONSOLE_LOG_TEXT_LENGTH; i++) {
        if (i > 0) text += ' '
        text += printedPart(log.message[i]).slice(0, MAX_REPORTED_GADGET_CONSOLE_LOG_TEXT_LENGTH - text.length)
      }
      // A string of its own. A slice shares its parent's characters in the engines the Workshop
      // runs in, so a slice of a very long posted string would keep the whole of it alive for as
      // long as it is queued: seconds, or minutes while a send backs off or the connection is
      // lost. A string joined from its characters holds only them.
      text = [...text].join('')

      // The oldest goes: the error that ends a burst is the entry most worth keeping.
      while (queue.length >= MAX_GADGET_CONSOLE_LOGS_PER_CALL - 1 ||
          (queue.length > 0 && queuedChars + text.length > GADGET_CONSOLE_LOG_BATCH_CHARS)) {
        queuedChars -= queue[0].text.length
        queue.shift()
        dropped++
      }
      queue.push({ time: log.timestamp, level: log.level, text })
      queuedChars += text.length
      arm()
    },

    flush,

    stop() {
      stopped = true
      clearTimeout(flushTimer)
      clearTimeout(giveUpTimer)
      flushTimer = undefined
      if (queue.length === 0 && dropped === 0) return

      // Nothing later will send what is queued, so it goes at once, even while a send is in
      // flight, and with no give-up timer: giving a send up frees the next batch, and there is
      // none. When there is nothing to send through (the connection is lost, or the workspace has
      // none) the queue is discarded, since nothing later could send it or a marker for it: one
      // of the losses nothing marks.
      const sending = send(batch())
      clearQueue()
      sending?.then(undefined, (err: unknown) => {
        logRpcFailure(SEND_FAILURE, err)
      })
    },
  }
}
