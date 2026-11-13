// Reads a rendered page's bands with a vision model, a few at a time, and puts their texts
// together in the page's order. What can be told of one band's answer is acted on here, by
// asking for the band once more: a call that failed as any call may, an answer stopped at the
// model's output limit, one that ran away repeating itself, and one far shorter than the band's
// writing would make.

import type { RenderedBand, RenderedPage } from "@gadgets/pdf-renderer/api";
import { TranscriptionError, type Transcription } from "./workers-ai-vision";

/** The most model calls in flight for one page. */
const MAX_IN_FLIGHT = 4;
/**
 * What makes an answer a runaway: a unit of at least {@link RUNAWAY_UNIT_CHARS} characters said
 * {@link RUNAWAY_REPEATS} times on end, or {@link RUNAWAY_SHORT_CHARS} characters on end of one
 * shorter unit. A unit is the shortest thing that repeats, so a row of dots is a unit of one
 * character however long the row. A band's second answer is held to the
 * {@link RUNAWAY_SHORT_CHARS} characters whatever its unit: a table may hold twelve equal rows,
 * and nothing is asked after it that could tell such a table from a runaway.
 */
const RUNAWAY_UNIT_CHARS = 12;
const RUNAWAY_REPEATS = 12;
const RUNAWAY_SHORT_CHARS = 2000;
/**
 * Characters at the end of an answer looked at for a runaway, each time more of it arrives: room
 * for {@link RUNAWAY_REPEATS} of a unit of 512 characters, which is a long paragraph.
 */
const RUNAWAY_WINDOW_CHARS = RUNAWAY_REPEATS * 512;
/**
 * When a band's answer is too short for its writing. It is compared with the page's other bands
 * that have text, of which there have to be {@link SHORT_MIN_OTHERS}: it is short with under a
 * third of their median characters for each unit of ink ({@link SHORT_DENSITY_PART}), unless
 * its ink is under a tenth of their median ink ({@link SHORT_INK_PART}), as that of a band
 * holding one line or a rule is. The three numbers are a first setting, to be held to what
 * measuring pages shows.
 */
const SHORT_MIN_OTHERS = 2;
const SHORT_DENSITY_PART = 3;
const SHORT_INK_PART = 10;

/**
 * Asks the model for one band of a page `width` pixels wide: a transcription of a PNG made
 * afresh of the band's rows, so that nothing but the rows is held between two asks. Aborting
 * `signal` gives the call up.
 */
export type BandCall = (band: RenderedBand, width: number, signal: AbortSignal) => Promise<Transcription>;

/** What is logged of one band once it has been asked for: numbers and fixed words, never text. */
export type BandEvent = {
  /** The band's place among its page's bands, from 1, and how many bands the page has. */
  band: number;
  bands: number;
  /** Bytes of the band's image sent, over every ask. */
  imageBytes: number;
  /** How many times the model was asked for the band: 1 or 2. */
  asks: number;
  /**
   * Why it was asked a second time: the first call failed, its answer was stopped at the output
   * limit, its answer ran away, or its answer was short for the band's writing.
   */
  askedAgain?: "failed" | "truncated" | "runaway" | "short";
};

/** One band being read: what is kept of it so far, and what its event will say. */
type BandRead = Omit<BandEvent, "bands"> & {
  rendered: RenderedBand;
  /** The answer kept. */
  text: string;
  /** Whether the answer kept ends early. */
  cutOff: boolean;
};

/**
 * An answer and how it ended, without the whitespace around it. A runaway's is as far as the
 * first of what it went on to repeat.
 */
type Answer = { text: string; ended: "whole" | "truncated" | "runaway" };

/**
 * How one ask ended: with an answer, or with a failure of the model's, which is `transient` when
 * asking again may not meet it.
 */
type Asked = Answer | { failure: TranscriptionError; transient: boolean };

/**
 * The text of `page`, read from its bands that have pixels by `call`, at most
 * {@link MAX_IN_FLIGHT} at a time: the bands' texts in the page's order, each on a line of its
 * own after the last, given only once every band has been read. `cutOff` says that a band's text
 * ends early. `moved` is called as any band's text arrives, and `log` once for each band asked
 * for, also when the page fails.
 *
 * A band is asked for twice at most. It is asked again when its call failed with HTTP 429 or a
 * 5xx, or its response broke or reported an error partway, and a second failure is thrown; any
 * other failure is thrown at once. It is asked again when its answer was stopped at the output
 * limit, or ran away and was stopped here: a second answer that ended whole is then the band's,
 * and failing one the first is kept, a runaway as far as the first of what it repeated, and the
 * page is cut off. A second answer is let repeat for longer before it is stopped, so that a
 * table of equal rows, which the first was stopped in, is read to its end. And once every band
 * has an answer, a band whose answer is short for its writing is asked again, and the longer of
 * its two answers kept.
 *
 * When a band fails, or `signal` aborts, every other call in flight is given up and waited for
 * before this rejects, with the band's failure or the signal's reason: no call outlives it.
 */
export async function readBands(
  page: RenderedPage, call: BandCall, signal: AbortSignal, moved: () => void,
  log: (event: BandEvent) => void,
): Promise<{ text: string; cutOff: boolean }> {
  /** Gives up every call in flight: aborted with `signal`, and by the first band to fail. */
  let abort = new AbortController();
  let chain = () => abort.abort(signal.reason);
  signal.addEventListener("abort", chain, { once: true });
  if (signal.aborted) chain();
  /** What failed bands failed with, the first being what the page fails with. */
  let failures: unknown[] = [];
  let reads = page.bands.flatMap((rendered, index): BandRead[] => rendered.pixels
    ? [{ rendered, band: index + 1, imageBytes: 0, asks: 0, text: "", cutOff: false }] : []);

  /** Asks for `read`'s band: a second time when `again` says why. */
  let ask = async (read: BandRead, again?: BandEvent["askedAgain"]): Promise<Asked> => {
    abort.signal.throwIfAborted();
    read.asks++;
    read.askedAgain = again;
    let answer: Transcription;
    try {
      answer = await call(read.rendered, page.width, abort.signal);
    } catch (error) {
      if (!(error instanceof TranscriptionError)) throw error;
      read.imageBytes += error.sentBytes;
      if (abort.signal.aborted) throw error;
      let status = "httpStatus" in error.failure ? error.failure.httpStatus : 0;
      return { failure: error, transient: status === 429 || (status >= 500 && status <= 599) };
    }
    // An answer being read is not ended by the signal its request was made with.
    let stop = () => void answer.cancel(abort.signal.reason).catch(() => undefined);
    abort.signal.addEventListener("abort", stop, { once: true });
    if (abort.signal.aborted) stop();
    try {
      let text = "";
      for (let piece = await answer.next(); piece !== undefined; piece = await answer.next()) {
        moved();
        text += piece;
        let kept = keptOfRunaway(text, again !== undefined);
        if (kept === undefined) continue;
        await answer.cancel();
        return { text: text.slice(0, kept).trim(), ended: "runaway" };
      }
      return { text: text.trim(), ended: answer.truncated ? "truncated" : "whole" };
    } catch (error) {
      // A response that broke may not break again; an image that could not be read will.
      if (!(error instanceof TranscriptionError) || abort.signal.aborted) throw error;
      return { failure: error, transient: true };
    } finally {
      abort.signal.removeEventListener("abort", stop);
      read.imageBytes += answer.sentBytes;
    }
  };
  /** A band's first ask, and the second that a failure or an answer that did not end whole gets. */
  let first = async (read: BandRead) => {
    let asked = await ask(read);
    let why: BandEvent["askedAgain"];
    if ("failure" in asked) {
      if (!asked.transient) throw asked.failure;
      why = "failed";
    } else if (asked.ended === "whole") {
      return keep(read, asked);
    } else {
      why = asked.ended;
    }
    let second = await ask(read, why);
    if ("failure" in second) {
      if ("failure" in asked) throw second.failure;
      keep(read, asked);
    } else {
      keep(read, second.ended === "whole" || "failure" in asked ? second : asked);
    }
  };
  /** The second ask of a band whose whole answer is short. A failure leaves it its first. */
  let again = async (read: BandRead) => {
    let second = await ask(read, "short");
    if ("text" in second && second.text.length > read.text.length) keep(read, second);
  };
  /** Runs `run` for each of `some`, {@link MAX_IN_FLIGHT} at a time, until one fails. */
  let inFlight = async (some: BandRead[], run: (read: BandRead) => Promise<void>) => {
    let next = 0;
    let turn = async () => {
      while (next < some.length && !abort.signal.aborted) {
        try {
          await run(some[next++]!);
        } catch (error) {
          // What a call that was given up throws is not why the page failed.
          if (abort.signal.aborted) continue;
          failures.push(error);
          abort.abort(error);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(MAX_IN_FLIGHT, some.length) }, turn));
  };

  try {
    await inFlight(reads, first);
    await inFlight(reads.filter(read => short(read, reads)), again);
    if (failures.length > 0) throw failures[0];
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener("abort", chain);
    for (let { band, imageBytes, asks, askedAgain } of reads) {
      if (asks === 0) continue;
      log({ band, bands: page.bands.length, imageBytes, asks, ...(askedAgain ? { askedAgain } : {}) });
    }
  }
  return {
    text: reads.map(read => read.text).filter(text => text !== "").join("\n"),
    cutOff: reads.some(read => read.cutOff),
  };
}

/** Makes `answer` the one kept of `read`. */
function keep(read: BandRead, answer: Answer): void {
  read.text = answer.text;
  read.cutOff = answer.ended !== "whole";
}

/**
 * How much of `text` is kept when its end is a runaway, as the constants above define one: up to
 * the end of the first of what is repeated. `undefined` for a text that does not end in one. A
 * unit with no letter or digit in it, however long, is held to {@link RUNAWAY_SHORT_CHARS}: a
 * table's rule of many equal columns and a page of empty rows repeat as a runaway does. So is
 * every unit of a `second` answer.
 */
function keptOfRunaway(text: string, second: boolean): number | undefined {
  let window = Math.min(text.length, RUNAWAY_WINDOW_CHARS);
  if (window < RUNAWAY_UNIT_CHARS * RUNAWAY_REPEATS) return undefined;
  let last = text.length - 1;
  // borders[n] is the length of the longest part of the last n characters, short of all of
  // them, that they both begin and end with: they repeat a unit of n less that many.
  let borders = new Uint16Array(window + 1);
  for (let n = 2, border = 0; n <= window; n++) {
    let ch = text.charCodeAt(last - (n - 1));
    while (border > 0 && ch !== text.charCodeAt(last - border)) border = borders[border]!;
    if (ch === text.charCodeAt(last - border)) border++;
    borders[n] = border;
  }
  for (let n = window; n >= RUNAWAY_UNIT_CHARS * RUNAWAY_REPEATS; n--) {
    let unit = n - borders[n]!;
    if (n < unit * RUNAWAY_REPEATS) continue;
    let words = !second && unit >= RUNAWAY_UNIT_CHARS && /[\p{L}\p{N}]/u.test(text.slice(-unit));
    if (!words && n < RUNAWAY_SHORT_CHARS) continue;
    // The repetition may have begun before the window.
    let start = text.length - n;
    while (start > 0 && text[start - 1] === text[start - 1 + unit]) start--;
    return start + unit;
  }
  return undefined;
}

/** Whether `read`'s one answer is short for its ink, beside the page's other bands in `reads`. */
function short(read: BandRead, reads: BandRead[]): boolean {
  let others = reads.filter(other => other !== read && other.text !== "" && other.rendered.ink > 0);
  if (read.asks !== 1 || read.rendered.ink <= 0 || others.length < SHORT_MIN_OTHERS) return false;
  let density = median(others.map(other => other.text.length / other.rendered.ink));
  let ink = median(others.map(other => other.rendered.ink));
  return read.rendered.ink >= ink / SHORT_INK_PART &&
    read.text.length / read.rendered.ink < density / SHORT_DENSITY_PART;
}

/** The middle of `values`, of which there is at least one. */
function median(values: number[]): number {
  let sorted = values.toSorted((a, b) => a - b);
  let middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
