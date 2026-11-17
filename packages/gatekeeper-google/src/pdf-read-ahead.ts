// What reading a PDF's pages ahead of its reader is held to: how many model calls are in flight
// for one text, and how many bytes of drawn pixels are held in the isolate. Neither knows what
// a call or a page is: a call is run when its turn comes, and a hold is a count of bytes.
//
// The isolate is the Worker's, not one connection's: every Durable Object of the class that a
// machine runs shares it and its memory, so what the texts of all of them hold between them is
// what has to stay under a number.

/** What reading ahead is held to. An object so that a test may set a number and put it back. */
export const READ_AHEAD = {
  /** Model calls in flight for one text, unless the deployment says (`PDF_OCR_CALLS`). */
  calls: 8,
  /** Pages begun and not yet given to the reader, for one text. */
  pages: 16,
  /**
   * Bytes of drawn pixels held in the isolate, over every text: never more. A quarter of the
   * memory an isolate has. One text at eight calls, of pages cut into four bands, holds some
   * 15 MB at most, so two are read at full pace and more wait their turn for room (the README
   * has what that was measured to cost).
   */
  isolateBytes: 32 * 1024 * 1024,
  /** How often a hold that waits its turn for room in the isolate says that it does. */
  queuedMs: 15_000,
  /**
   * How long a text may hold pixels without moving before they are taken to be a Durable
   * Object's that is gone: three times as long as a text that lives may sit idle.
   */
  abandonedMs: 180_000,
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
  /**
   * Waits out `pause`, which a refused call has before it is made again. Until it is over the
   * call counts as one that waits for a slot, as it soon will: see {@link CallSlots.wanting}.
   */
  rest<T>(pause: Promise<T>): Promise<T>;
};

/**
 * A text's limiter of model calls: the slots of page `page`, from 0, how many calls may run at
 * once just now, and how many do.
 */
export type CallSlots = {
  of(page: number): PageSlots;
  readonly limit: number;
  readonly inFlight: number;
  /**
   * Resolves once fewer than `under` calls wait for a slot or rest before they ask for one
   * again, which is at once when that is so: for making more calls only as those made find
   * slots. A wait ended by `signal` rejects with its reason.
   */
  wanting(under: number, signal: AbortSignal): Promise<void>;
};

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
  /** How many refused calls rest before they are made again. */
  let resting = 0;
  /** Those waiting for fewer than `under` calls to wait. */
  let wanted: { under: number; go: () => void }[] = [];
  /** Tells those for whom few enough calls now wait. */
  let tell = () => {
    for (let want of wanted.slice()) {
      if (waiting.length + resting < want.under) want.go();
    }
  };
  /** Gives the slots that are free to those waiting. */
  let admit = () => {
    while (inFlight < limit && waiting.length > 0) {
      let next = waiting.reduce((first, waiter) => waiter.page < first.page ? waiter : first);
      waiting.splice(waiting.indexOf(next), 1);
      inFlight++;
      next.go();
    }
    tell();
  };
  return {
    get limit() { return limit; },
    get inFlight() { return inFlight; },
    wanting: (under, signal) => new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      if (waiting.length + resting < under) return resolve();
      let want = {
        under,
        go: () => {
          signal.removeEventListener("abort", ended);
          wanted.splice(wanted.indexOf(want), 1);
          resolve();
        },
      };
      let ended = () => {
        wanted.splice(wanted.indexOf(want), 1);
        reject(signal.reason);
      };
      signal.addEventListener("abort", ended, { once: true });
      wanted.push(want);
    }),
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
            tell();
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
      async rest<T>(pause: Promise<T>): Promise<T> {
        resting++;
        try {
          return await pause;
        } finally {
          resting--;
          tell();
        }
      },
    }),
  };
}

/** A hold on bytes of drawn pixels: made as many as `resize` says, and let go by `release`. */
export type PixelHold = { resize(bytes: number): void; release(): void };

/** One text's share of the isolate's room for drawn pixels: see {@link pixelRoom}. */
export type PixelRoom = {
  /**
   * A hold on `bytes`, once the isolate has room for them. `queued` is called every
   * {@link READ_AHEAD}'s `queuedMs` for as long as the hold waits while its text holds nothing:
   * it is then other texts alone that it waits for.
   */
  reserve(bytes: number, signal: AbortSignal, queued: () => void): Promise<PixelHold>;
  /** Says that the text lives: something of a page of its has moved, or its reader has asked. */
  moved(): void;
};

/** What the isolate knows of one text: see {@link pixelRoom}. */
type PixelText = {
  /** The bytes it holds. */
  held: number;
  /** When it last moved, or took or let go of pixels. */
  moved: number;
  /** How often what it held was taken back as abandoned: a hold from before then counts for nothing. */
  taken: number;
  abandoned: (bytes: number) => void;
};

/** A hold waited for: its bytes, the text it is for, what gives it, and when its own timer last ran. */
type PixelWait = { bytes: number; text: PixelText; give: () => void; alive: number };

/** Bytes of drawn pixels held in the isolate, over every text. */
let held = 0;
/** The texts that hold pixels. */
let holding = new Set<PixelText>();
/** The holds waited for, over every text, in the order they were asked for. */
let waiting: PixelWait[] = [];

/**
 * Lets go of what is held or waited for by a text that is gone. The isolate outlives a Durable
 * Object that is reset in it, and nothing of that object runs again to let its pixels go: with
 * a ceiling that is never passed, they would be room no text in the isolate ever got back. So
 * pixels whose text has not moved for `abandonedMs` are taken back, and a wait whose own timer
 * has stopped running is taken out of the line. A text that lives moves far more often than
 * that while its reader waits on its pages ({@link PixelRoom.moved}); should one be taken for
 * gone all the same, it reads on, and what it held then counts for nothing until it is let go.
 * A wait that is gone but whose timer ran within the last three ticks may still be given room,
 * which is then taken back as the rest is.
 */
function reclaim(now: number): void {
  for (let text of holding) {
    if (now - text.moved <= READ_AHEAD.abandonedMs) continue;
    let bytes = text.held;
    held -= bytes;
    text.held = 0;
    text.taken++;
    holding.delete(text);
    text.abandoned(bytes);
  }
  waiting = waiting.filter(wait => now - wait.alive <= 3 * READ_AHEAD.queuedMs);
}

/**
 * Gives the holds waited for that the isolate now has room for, in the order they were asked
 * for: no hold is given before one asked for earlier, so that every text gets its turn, and
 * what a text lets go is room for whichever has waited longest.
 */
function givePixels(): void {
  reclaim(Date.now());
  while (waiting.length > 0 && held + waiting[0]!.bytes <= READ_AHEAD.isolateBytes) waiting[0]!.give();
}

/** Counts `bytes` more, or fewer, as held by `text`. */
function count(text: PixelText, bytes: number): void {
  text.held += bytes;
  held += bytes;
  text.moved = Date.now();
  if (text.held > 0) holding.add(text);
  else holding.delete(text);
}

/**
 * One text's share of {@link READ_AHEAD}'s `isolateBytes`, which every text in the isolate has
 * between them and which is never passed. A text has no number of its own: it holds what the
 * pages it is reading hold, and it is the reader that draws no page before its calls can take
 * it. Those waiting are looked at again on every release and resize in the isolate, when a
 * wait ends, and at each tick of a wait's timer. A hold of more than `isolateBytes` is refused
 * with a `RangeError`: it could never be given.
 * Releasing a hold twice does nothing, and neither does resizing one that was released. A wait
 * ended by its `signal` rejects with the signal's reason and holds nothing.
 *
 * A hold that waits has a timer of its own, every `queuedMs`. When its text holds nothing, it
 * waits for what other texts hold, which is nothing its own text can move: so it is told then
 * that it still waits, for its text not to be taken for one that sits idle. A text that holds
 * pixels is told nothing: those are being read, and that is what moves it or does not. Such a
 * wait ends: a hold is on pixels that are being read, and is let go when they have been or
 * when its text ends, whether or not anyone reads that text; and what a text that is gone
 * left held is taken back ({@link reclaim}), when `abandoned` is told how many bytes that was.
 */
export function pixelRoom(abandoned: (bytes: number) => void = () => undefined): PixelRoom {
  let text: PixelText = { held: 0, moved: Date.now(), taken: 0, abandoned };
  return {
    reserve: (bytes, signal, queued) => new Promise<PixelHold>((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      if (bytes > READ_AHEAD.isolateBytes) return reject(new RangeError("More pixels than the isolate may hold."));
      let timer: ReturnType<typeof setTimeout> | undefined;
      /** Whether the wait is over: given, or ended by its signal. */
      let over = false;
      let wait: PixelWait = {
        bytes, text, alive: Date.now(),
        give: () => {
          leave();
          let { taken } = text;
          let released = false;
          let resize = (to: number) => {
            // What was taken back as abandoned is not counted a second time.
            if (released || taken !== text.taken) return;
            count(text, to - bytes);
            bytes = to;
            givePixels();
          };
          count(text, bytes);
          resolve({
            resize,
            release: () => {
              resize(0);
              released = true;
            },
          });
        },
      };
      /** Takes the wait out of the line, however it ends. */
      let leave = () => {
        over = true;
        signal.removeEventListener("abort", ended);
        if (timer !== undefined) clearTimeout(timer);
        let at = waiting.indexOf(wait);
        if (at >= 0) waiting.splice(at, 1);
      };
      let ended = () => {
        leave();
        reject(signal.reason);
        // What waited behind it may be first in line now.
        givePixels();
      };
      // The timer is the wait's own, so that it runs for as long as its Durable Object does. A
      // wait may be given from another object's turn, where clearing this timer may do nothing:
      // a tick after the wait is over does nothing either.
      let tick = () => {
        timer = undefined;
        if (over) return;
        // A tick is the text's sign of life, and puts back a wait that was taken for gone.
        wait.alive = text.moved = Date.now();
        if (!waiting.includes(wait)) waiting.push(wait);
        if (text.held === 0) queued();
        givePixels();
        if (!over) timer = setTimeout(tick, READ_AHEAD.queuedMs);
      };
      signal.addEventListener("abort", ended, { once: true });
      waiting.push(wait);
      givePixels();
      if (!over) timer = setTimeout(tick, READ_AHEAD.queuedMs);
    }),
    moved() { text.moved = Date.now(); },
  };
}

/** Bytes of drawn pixels held in the isolate just now, over every text: for tests. */
export function pixelsHeld(): number {
  return held;
}
