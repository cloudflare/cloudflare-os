// Reads a rendered page's bands with a vision model, as many at a time as the text's limiter of
// model calls has slots for, and puts their texts together in the page's order. What can be told
// of one band's answer is acted on here. A call the service refused for rate or capacity is made
// again after a pause, a few times. A call that failed as any call may is made once more. A band
// whose answer was stopped at the model's output limit, ran away repeating itself, or is far
// shorter than the band's writing would make is cut in two, and its halves asked for.

import type { RenderedBand, RenderedPage } from "@gadgets/pdf-renderer/api";
import type { PageSlots } from "./pdf-read-ahead";
import { CAPACITY_CODE, TranscriptionError, type Transcription } from "./workers-ai-vision";

/**
 * What makes an answer a runaway: a unit of at least {@link RUNAWAY_UNIT_CHARS} characters said
 * {@link RUNAWAY_REPEATS} times on end, or {@link RUNAWAY_SHORT_CHARS} characters on end of one
 * shorter unit. A unit is the shortest thing that repeats, so a row of dots is a unit of one
 * character however long the row. Every answer after a band's first is held to the
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
/** The fewest rows a band is cut in two with. One of fewer is asked for again as it is. */
const CUT_MIN_ROWS = 64;

/**
 * How long a call that failed waits before it is made again: `ms` milliseconds, and up to
 * `jitterMs` more at random, so that the calls a model had no room for do not all come back at
 * once. Tests set both to nothing.
 */
export const RETRY_PAUSE = { ms: 250, jitterMs: 250 };

/**
 * How long a call the service refused for rate or capacity waits before it is made again: the
 * nth refusal of an ask `ms[n]` milliseconds, and up to `jitter` of that more at random. No
 * pause is as long as a text may sit idle, and each refusal counts as the text moving, so a band
 * being refused is not what ends a text that sits idle. Refused once more than there are pauses,
 * the call is not made again. Tests set the pauses to nothing, or leave none.
 */
export const REFUSED_PAUSE = { ms: [1000, 2000, 4000, 8000, 16000], jitter: 0.25 };

/**
 * Whether `error` is the service refusing a call for rate or capacity: one that failed before
 * any answer with HTTP 429, or with the service's code for a model with no room under any status.
 */
export function refusedCall(error: unknown): boolean {
  if (!(error instanceof TranscriptionError) || !("httpStatus" in error.failure)) return false;
  return error.failure.httpStatus === 429 || error.failure.providerCode === CAPACITY_CODE;
}

/** Waits out `ms` milliseconds, or until `signal` aborts. */
export function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>(resolve => {
    if (ms <= 0 || signal.aborted) return resolve();
    let end = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", end);
      resolve();
    };
    let timer = setTimeout(end, ms);
    signal.addEventListener("abort", end, { once: true });
  });
}

/** Waits out the pause that the nth refusal of an ask has in {@link REFUSED_PAUSE}, from 0. */
export function refusedPause(refusals: number, signal: AbortSignal): Promise<void> {
  return pause(REFUSED_PAUSE.ms[refusals]! * (1 + Math.random() * REFUSED_PAUSE.jitter), signal);
}

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
  /** How many times the model was asked for the band, its halves included: 1 to 3. */
  asks: number;
  /** How many of the band's calls the service refused for rate or capacity, over every ask. */
  refused?: number;
  /**
   * Why it was asked again: the first call failed, its answer was stopped at the output limit,
   * its answer ran away, or its answer was short for the band's writing.
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
 * The text of `page`, read from its bands that have pixels by `call`, every band at once and
 * each call in a slot of `slots`: the bands' texts in the page's order, each on a line of its
 * own after the last, given only once every band has been read. `cutOff` says that a band's text
 * ends early. `moved` is called as any band's text arrives and at each refusal, and `log` once
 * for each band asked for, also when the page fails.
 *
 * A call holds its slot from the request until its answer has been read to the end, has failed
 * or was cancelled: not while it waits for one, and not during a pause. One the service refused
 * for rate or capacity, which is one that failed before any answer with HTTP 429, or with the
 * service's code for a model with no room under any status, is not an ask of its own: `slots`
 * is told, and the call is made again within its ask after {@link REFUSED_PAUSE}. Refused once
 * more than there are pauses, it is the ask's failure, and not one the band is asked again
 * after. `slots` is told of each ask that ends with an answer, however the answer ended.
 *
 * A band costs three calls at most, not counting refused ones. Its call is made again as it
 * was, once and after {@link RETRY_PAUSE}, when it failed with a 5xx without that code, or its
 * response broke or reported an error partway: a second failure is thrown, any other failure is
 * thrown at once, and the second answer is the band's however it ended.
 *
 * A band whose first answer was stopped at the output limit, or ran away and was stopped here,
 * is not asked for again as it was: the model would answer the same. It is cut in two (see
 * {@link halves}) and each half that has ink is asked for, the top first. The halves' texts,
 * the top's on the lines before the bottom's, are then the band's, cut off when either did not
 * end whole. When a half's call fails, or neither half has ink, the first answer is kept, a
 * runaway as far as the first of what it repeated, and the page is cut off. A half's answer is
 * let repeat for longer before it is stopped, so that a table of equal rows, which the first
 * was stopped in, is read to its end. And once every band has an answer, a band whose answer is
 * short for its writing is cut in two likewise, and its halves' texts kept when they are longer
 * together. A band of fewer than {@link CUT_MIN_ROWS} rows is not cut but asked for once more
 * as it is: after an answer that did not end whole, a second that did is the band's, and after
 * a short one the longer of the two is.
 *
 * When a band fails, or `signal` aborts, every other call that is running, waiting for a slot
 * or pausing is given up and waited for before this rejects, with the band's failure or the
 * signal's reason: no call outlives it.
 */
export async function readBands(
  page: RenderedPage, call: BandCall, signal: AbortSignal, moved: () => void,
  log: (event: BandEvent) => void, slots: PageSlots,
): Promise<{ text: string; cutOff: boolean }> {
  /** Gives up every call, running or yet to be: aborted with `signal`, and by the first band to fail. */
  let abort = new AbortController();
  let chain = () => abort.abort(signal.reason);
  signal.addEventListener("abort", chain, { once: true });
  if (signal.aborted) chain();
  /** What failed bands failed with, the first being what the page fails with. */
  let failures: unknown[] = [];
  let reads = page.bands.flatMap((rendered, index): BandRead[] => rendered.pixels
    ? [{ rendered, band: index + 1, imageBytes: 0, asks: 0, text: "", cutOff: false }] : []);

  /**
   * Makes one call for `read`'s band, or for `band` of it, and reads its answer to the end: the
   * first call of an ask when `refusals` is 0, and not the band's first ask when `again` says
   * why. `refused` is what a call the service refused for rate or capacity failed with.
   */
  let attempt = async (
    read: BandRead, again: BandEvent["askedAgain"], band: RenderedBand, refusals: number,
  ): Promise<Asked | { refused: TranscriptionError }> => {
    abort.signal.throwIfAborted();
    if (refusals === 0) {
      read.asks++;
      read.askedAgain = again;
    }
    let answer: Transcription;
    try {
      answer = await call(band, page.width, abort.signal);
    } catch (error) {
      if (!(error instanceof TranscriptionError)) throw error;
      read.imageBytes += error.sentBytes;
      if (abort.signal.aborted) throw error;
      if (refusedCall(error)) return { refused: error };
      let status = "httpStatus" in error.failure ? error.failure.httpStatus : 0;
      return { failure: error, transient: status >= 500 && status <= 599 };
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
  /**
   * Asks for `read`'s band, or for `band` of it: not for the first time when `again` says why.
   * Each call is made in a slot. One the service refused is made again, after the pause its
   * refusal has in {@link REFUSED_PAUSE}; refused once more than there are pauses, it is the
   * ask's failure.
   */
  let ask = async (
    read: BandRead, again?: BandEvent["askedAgain"], band = read.rendered,
  ): Promise<Asked> => {
    for (let refusals = 0;; refusals++) {
      let called = await slots.run(abort.signal, () => attempt(read, again, band, refusals));
      if (!("refused" in called)) {
        if (!("failure" in called)) slots.answered();
        return called;
      }
      slots.refused();
      // A refusal is the service answering: a band being refused is not a text that sits idle.
      moved();
      read.refused = (read.refused ?? 0) + 1;
      if (refusals === REFUSED_PAUSE.ms.length) return { failure: called.refused, transient: false };
      await refusedPause(refusals, abort.signal);
    }
  };
  /**
   * What the halves of `read`'s band that have ink say, the top first, as one answer, which did
   * not end whole when either did not. `undefined` when neither half has ink, and when a half's
   * call failed, after which the other is not asked for.
   */
  let recut = async (read: BandRead, why: BandEvent["askedAgain"]): Promise<Answer | undefined> => {
    let said: Answer | undefined;
    for (let half of halves(read.rendered, page.width)) {
      if (half.ink <= 0) continue;
      let asked = await ask(read, why, half);
      if ("failure" in asked) return undefined;
      said = said === undefined ? asked : {
        text: [said.text, asked.text].filter(text => text !== "").join("\n"),
        ended: said.ended === "whole" ? asked.ended : said.ended,
      };
    }
    return said;
  };
  /** A band's first ask, and what a failure or an answer that did not end whole gets after it. */
  let first = async (read: BandRead) => {
    let asked = await ask(read);
    let why: BandEvent["askedAgain"];
    if ("failure" in asked) {
      if (!asked.transient) throw asked.failure;
      await pause(RETRY_PAUSE.ms + Math.random() * RETRY_PAUSE.jitterMs, abort.signal);
      why = "failed";
    } else if (asked.ended === "whole") {
      return keep(read, asked);
    } else if (read.rendered.rows >= CUT_MIN_ROWS) {
      return keep(read, await recut(read, asked.ended) ?? asked);
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
  /** What is asked after a band's whole answer that is short. A failure leaves it its first. */
  let again = async (read: BandRead) => {
    let second = read.rendered.rows >= CUT_MIN_ROWS ? await recut(read, "short") : await ask(read, "short");
    if (second && "text" in second && second.text.length > read.text.length) keep(read, second);
  };
  /** Runs `run` for each of `some`, all at once, and gives the others up when one fails. */
  let each = async (some: BandRead[], run: (read: BandRead) => Promise<void>) => {
    // Nothing is begun, nor a band cut in two, for a page that was given up.
    if (abort.signal.aborted) return;
    await Promise.all(some.map(async read => {
      try {
        await run(read);
      } catch (error) {
        // What a call that was given up throws is not why the page failed.
        if (abort.signal.aborted) return;
        failures.push(error);
        abort.abort(error);
      }
    }));
  };

  try {
    await each(reads, first);
    await each(reads.filter(read => short(read, reads)), again);
    if (failures.length > 0) throw failures[0];
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener("abort", chain);
    for (let { band, imageBytes, asks, refused, askedAgain } of reads) {
      if (asks === 0) continue;
      log({
        band, bands: page.bands.length, imageBytes, asks, ...(refused ? { refused } : {}),
        ...(askedAgain ? { askedAgain } : {}),
      });
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
 * `band`, of a page `width` pixels wide, cut in two at the least inked row of its middle third:
 * the top half, and the bottom, which begins with that row. A row's ink is measured as the
 * renderer measures it: how far its pixels are from the row's ground, the level that half of
 * them are at or under, summed. So a row between two lines of writing has the least whether the
 * page is dark on light or light on dark, and on a white ground it is the darkness of the row's
 * pixels. Of the rows with the least, the one nearest the band's middle is taken. Each half is a
 * view of the band's rows, and its `ink` is its rows'.
 */
function halves(band: RenderedBand, width: number): [RenderedBand, RenderedBand] {
  let pixels = band.pixels!;
  let inks = new Float64Array(band.rows);
  let levels = new Uint32Array(256);
  for (let row = 0, at = 0; row < band.rows; row++) {
    for (let end = at + width; at < end; at++) levels[pixels[at]!]!++;
    let ground = 0, under = levels[0]!;
    while (under * 2 < width) under += levels[++ground]!;
    let ink = 0;
    for (let level = 0; level < 256; level++) ink += levels[level]! * Math.abs(level - ground);
    inks[row] = ink;
    levels.fill(0);
  }
  let third = Math.floor(band.rows / 3);
  let middle = band.rows / 2;
  let cut = third;
  for (let row = third + 1; row < band.rows - third; row++) {
    if (inks[row]! < inks[cut]! ||
      (inks[row] === inks[cut] && Math.abs(row - middle) < Math.abs(cut - middle))) cut = row;
  }
  let inked = (from: number, to: number) => inks.subarray(from, to).reduce((sum, ink) => sum + ink, 0);
  return [
    { top: band.top, rows: cut, ink: inked(0, cut), pixels: pixels.subarray(0, cut * width) },
    {
      top: band.top + cut, rows: band.rows - cut, ink: inked(cut, band.rows),
      pixels: pixels.subarray(cut * width, band.rows * width),
    },
  ];
}

/**
 * How much of `text` is kept when its end is a runaway, as the constants above define one: up to
 * the end of the first of what is repeated. `undefined` for a text that does not end in one. A
 * unit with no letter or digit in it, however long, is held to {@link RUNAWAY_SHORT_CHARS}: a
 * table's rule of many equal columns and a page of empty rows repeat as a runaway does. So is
 * every unit of a `second` answer, which is any after a band's first.
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
