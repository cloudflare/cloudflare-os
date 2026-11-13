// What reading a PDF's pages ahead of its reader is held to: how many model calls are in flight
// for one text, and how many bytes of drawn pixels are held for one text and in the isolate.
// Neither knows what a call or a page is: a call is run when its turn comes, and a hold is a
// count of bytes.

/** What reading ahead is held to. An object so that a test may set a number and put it back. */
export const READ_AHEAD = {
  /** Model calls in flight for one text, unless the deployment says (`PDF_OCR_CALLS`). */
  calls: 32,
  /** Pages begun and not yet given to the reader, for one text. */
  pages: 16,
  /** Bytes of drawn pixels held for one text. */
  textBytes: 32 * 1024 * 1024,
  /** Bytes of drawn pixels held in the isolate, over every text. */
  isolateBytes: 64 * 1024 * 1024,
  /** Characters of a PDF's own text held while it is looked ahead in. */
  ownTextChars: 256 * 1024,
  /** Stored page images begun and not yet read to their end by the reader. */
  storedPages: 4,
  /**
   * Characters of a stored page's answer held for its reader, past which no more of the answer
   * is read until the reader has taken some. A page's text is far shorter, so an answer the
   * model ends within its output limit is read to its end ahead of its reader, and one that
   * goes on regardless is not held whole.
   */
  answerChars: 256 * 1024,
};

/** One page's use of a text's limiter of model calls: see {@link callSlots}. */
export type PageSlots = {
  /** Runs `call` once a slot is free, and frees it when `call` settles. */
  run<T>(signal: AbortSignal, call: () => Promise<T>): Promise<T>;
  /** Told that the service refused a call for rate or capacity. */
  refused(): void;
  /** Told that a call was answered. */
  answered(): void;
};

/**
 * A text's limiter of model calls: the slots of page `page`, from 0, how many calls may run at
 * once just now, and how many do.
 */
export type CallSlots = { of(page: number): PageSlots; readonly limit: number; readonly inFlight: number };

/**
 * A limiter of model calls for one text, of whose calls at most `limit` run at once: `capacity`,
 * an integer of at least 1, to begin with. Of the calls waiting for a slot the lowest page's
 * goes first, and of one page's the first to ask. A wait ended by its `signal` rejects with the
 * signal's reason and takes no slot; a call that is running is ended by nothing here.
 *
 * Each refusal halves `limit`, never to under 1, and the calls already running go on; each
 * answer adds one to it, up to `capacity`. There is no timer, and nothing is held once every
 * call has settled.
 */
export function callSlots(capacity: number): CallSlots {
  let limit = capacity;
  let inFlight = 0;
  /** The calls waiting for a slot, in the order they asked. */
  let waiting: { page: number; go: () => void }[] = [];
  /** Gives the slots that are free to those waiting. */
  let admit = () => {
    while (inFlight < limit && waiting.length > 0) {
      let next = waiting.reduce((first, waiter) => waiter.page < first.page ? waiter : first);
      waiting.splice(waiting.indexOf(next), 1);
      inFlight++;
      next.go();
    }
  };
  return {
    get limit() { return limit; },
    get inFlight() { return inFlight; },
    of: page => ({
      async run<T>(signal: AbortSignal, call: () => Promise<T>): Promise<T> {
        await new Promise<void>((resolve, reject) => {
          if (signal.aborted) return reject(signal.reason);
          let waiter = {
            page,
            go: () => {
              signal.removeEventListener("abort", ended);
              resolve();
            },
          };
          let ended = () => {
            waiting.splice(waiting.indexOf(waiter), 1);
            reject(signal.reason);
          };
          signal.addEventListener("abort", ended, { once: true });
          waiting.push(waiter);
          admit();
        });
        try {
          return await call();
        } finally {
          inFlight--;
          admit();
        }
      },
      refused() {
        limit = Math.max(1, Math.floor(limit / 2));
      },
      answered() {
        if (limit === capacity) return;
        limit++;
        admit();
      },
    }),
  };
}

/** A hold on bytes of drawn pixels: made as many as `resize` says, and let go by `release`. */
export type PixelHold = { resize(bytes: number): void; release(): void };

/** One text's budget of drawn pixels: see {@link pixelRoom}. */
export type PixelRoom = {
  /**
   * A hold on `bytes`, once the text and the isolate both have room for them, or at once when
   * `waitedFor()` says the reader is waiting for what they are for.
   */
  reserve(bytes: number, signal: AbortSignal, waitedFor: () => boolean): Promise<PixelHold>;
  /** Looks again at who waits: called when what `waitedFor` answers may have changed. */
  recheck(): void;
};

/** A hold waited for: its bytes, the text it is for, and what gives it. */
type PixelWait = { bytes: number; text: { held: number }; waitedFor: () => boolean; give: () => void };

/** Bytes of drawn pixels held in the isolate, over every text. */
let held = 0;
/** The holds waited for, over every text, in the order they were asked for. */
let waiting: PixelWait[] = [];

/**
 * Gives each hold waited for that its text and the isolate now have room for, or that its
 * reader waits for, in the order they were asked for. One that does not fit is passed over,
 * and does not hold back a later one that does.
 */
function givePixels(): void {
  // Giving a hold takes it out of those waiting, so a copy of them is gone through.
  for (let wait of waiting.slice()) {
    let fits = wait.text.held + wait.bytes <= READ_AHEAD.textBytes &&
      held + wait.bytes <= READ_AHEAD.isolateBytes;
    if (fits || wait.waitedFor()) wait.give();
  }
}

/**
 * A budget of drawn pixels for one text: {@link READ_AHEAD}'s `textBytes` for the text, and its
 * `isolateBytes` for every text in the isolate between them. A hold that its reader waits for
 * is given over either, so each text can always hold the one page its reader waits for. Those
 * waiting are looked at again on every release and resize in the isolate, and on `recheck()`.
 * Releasing a hold twice does nothing, and neither does resizing one that was released. A wait
 * ended by its `signal` rejects with the signal's reason and holds nothing.
 */
export function pixelRoom(): PixelRoom {
  let text = { held: 0 };
  return {
    reserve: (bytes, signal, waitedFor) => new Promise<PixelHold>((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      let released = false;
      let resize = (to: number) => {
        if (released) return;
        text.held += to - bytes;
        held += to - bytes;
        bytes = to;
        givePixels();
      };
      let wait: PixelWait = {
        bytes, text, waitedFor,
        give: () => {
          signal.removeEventListener("abort", ended);
          waiting.splice(waiting.indexOf(wait), 1);
          text.held += bytes;
          held += bytes;
          resolve({
            resize,
            release: () => {
              resize(0);
              released = true;
            },
          });
        },
      };
      let ended = () => {
        waiting.splice(waiting.indexOf(wait), 1);
        reject(signal.reason);
      };
      signal.addEventListener("abort", ended, { once: true });
      waiting.push(wait);
      givePixels();
    }),
    recheck: givePixels,
  };
}

/** Bytes of drawn pixels held in the isolate just now, over every text: for tests. */
export function pixelsHeld(): number {
  return held;
}
