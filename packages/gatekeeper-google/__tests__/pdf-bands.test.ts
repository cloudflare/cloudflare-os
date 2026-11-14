import type { RenderedPage } from "@gadgets/pdf-renderer/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readBands, RETRY_PAUSE, type BandCall, type BandEvent } from "../src/pdf-bands";
import { TranscriptionError, type Transcription } from "../src/workers-ai-vision";

/** Bytes every fake answer says were sent of its band's image. */
const SENT = 100;
const WIDTH = 1275;
/** Rows of a band of {@link page}: fewer than a band is cut in two with. */
const ROWS = 40;
/** The width of a page of {@link tall} bands. */
const NARROW = 4;

/**
 * A page whose bands hold as much ink as `inks` says; one with `undefined` has no pixels. Its
 * bands are too small to be cut in two, so one asked for again is asked for as it is.
 */
function page(inks: (number | undefined)[]): RenderedPage {
  return {
    width: WIDTH, height: inks.length * ROWS, blank: false, images: 1, surveyed: true, dpi: 150, reduced: false,
    bands: inks.map((ink, index) => ({
      top: index * ROWS, rows: ROWS, ink: ink ?? 0, ...(ink === undefined ? {} : { pixels: new Uint8Array(8) }),
    })),
    cost: { heapBytes: 0, objects: 1, imagePixels: 0, steps: 1, strips: 1, work: 0 },
  };
}

/**
 * A page of bands with all their pixels, each given as the ink of its rows: a row's last pixel
 * is that far from white, and its others are white.
 */
function tall(bands: number[][]): RenderedPage {
  let top = 0;
  return {
    ...page([]), width: NARROW, height: bands.flat().length,
    bands: bands.map(inks => {
      let pixels = new Uint8Array(inks.length * NARROW).fill(255);
      inks.forEach((ink, index) => { pixels[(index + 1) * NARROW - 1] = 255 - ink; });
      let band = { top, rows: inks.length, ink: inks.reduce((sum, ink) => sum + ink, 0), pixels };
      top += inks.length;
      return band;
    }),
  };
}

/** The ink of `count` rows: `ink` each, but for the rows `others` names. */
function rowsOf(count: number, ink: number, others: Record<number, number> = {}): number[] {
  return Array.from({ length: count }, (_, index) => others[index] ?? ink);
}

/** `length` characters of words, which begin and end with none of the whitespace an answer loses. */
function prose(length: number, seed = 1): string {
  let words = ["harbour", "ledger", "florins", "manifest", "apricot", "weighbridge", "surcharge", "lot"];
  let text = "";
  for (let x = seed; text.length < length;) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    text += `${words[(x >>> 16) % words.length]} `;
  }
  return `${text.slice(0, length - 1)}.`;
}

/** A table's row of `columns` cells. */
function row(columns: number, cell: (column: number) => string): string {
  return `${Array.from({ length: columns }, (_, column) => `|${cell(column)}`).join("")}|\n`;
}

function deferred() {
  let resolve!: () => void;
  let promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

/** Lets everything that can go on without a timer do so. */
function tick(ms = 0): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** As {@link tick} does, where `setTimeout` is faked. */
function settle(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

function refusal(failure: TranscriptionError["failure"], sentBytes = SENT): TranscriptionError {
  return new TranscriptionError(failure, sentBytes);
}

/** What a response that breaks off fails with. */
function broken(): TranscriptionError {
  return refusal({ error: new Error("The model's response ended early.") });
}

/** What the fake model does when asked for a band: answers, or fails. */
type Reply = (signal: AbortSignal) => Promise<Transcription>;
/** What became of one fake answer. */
type AnswerState = { reads: number; cancelled: boolean };

/**
 * An answer giving `pieces` and then its end, or `breaks` in the end's place. Once cancelled it
 * fails as a response that broke off does.
 */
function answer(
  pieces: Iterable<string>, { truncated = false, breaks, state = { reads: 0, cancelled: false } }:
    { truncated?: boolean; breaks?: unknown; state?: AnswerState } = {},
): Transcription {
  let left = pieces[Symbol.iterator]();
  let ended = false;
  return {
    sentBytes: SENT,
    get truncated() { return truncated && ended; },
    async next() {
      if (state.cancelled) throw broken();
      let piece = left.next();
      if (!piece.done) {
        state.reads++;
        return piece.value;
      }
      if (breaks) throw breaks;
      ended = true;
      return undefined;
    },
    async cancel() { state.cancelled = true; },
  };
}

/** Answers with `text`, whole or in the pieces given. */
function says(text: string | Iterable<string>, options?: Parameters<typeof answer>[1]): Reply {
  return async () => answer(typeof text === "string" ? (text === "" ? [] : [text]) : text, options);
}

/** Fails the call with `error`. */
function fails(error: unknown): Reply {
  return async () => { throw error; };
}

/** `reply`, once `gate` has opened. */
function after(gate: { promise: Promise<void> }, reply: Reply): Reply {
  return async signal => {
    await gate.promise;
    return reply(signal);
  };
}

/** `unit` over and over, a piece at a time, for longer than any answer is read. */
function* endless(unit: string, before: string[] = []): Generator<string> {
  yield* before;
  for (let i = 0; i < 100_000; i++) yield unit;
}

/**
 * A fake of the model for `sheet`: band n's asks, those for its halves among them, are answered
 * by `script[n - 1]` in turn, and an ask past its end fails the test. It records every ask,
 * `retry` saying that the band was asked for before and `top`, `rows` and `pixels` what of it
 * was asked for, and how many are in flight: from the call until its answer has ended, failed
 * or been cancelled.
 */
function fakeModel(sheet: RenderedPage, script: Reply[][]) {
  let asks: {
    band: number; width: number; retry: boolean; signal: AbortSignal; top: number; rows: number; pixels: Uint8Array;
  }[] = [];
  let flight = { now: 0, most: 0 };
  let turns = script.map(() => 0);
  let call: BandCall = async (band, width, signal) => {
    let index = sheet.bands.findIndex(whole => band.top >= whole.top && band.top < whole.top + whole.rows);
    asks.push({
      band: index + 1, width, retry: turns[index]! > 0, signal, top: band.top, rows: band.rows, pixels: band.pixels!,
    });
    flight.most = Math.max(flight.most, ++flight.now);
    let landed = false;
    let land = () => {
      if (!landed) flight.now--;
      landed = true;
    };
    try {
      let reply = script[index]?.[turns[index]!++];
      if (!reply) throw new Error(`Band ${index + 1} was asked for more often than it may be.`);
      let given = await reply(signal);
      return {
        get sentBytes() { return given.sentBytes; },
        get truncated() { return given.truncated; },
        async next() {
          try {
            let piece = await given.next();
            if (piece === undefined) land();
            return piece;
          } catch (error) {
            land();
            throw error;
          }
        },
        async cancel(reason) {
          await given.cancel(reason);
          land();
        },
      };
    } catch (error) {
      land();
      throw error;
    }
  };
  return { call, asks, flight };
}

/** Reads `sheet` with a fake model following `script`, keeping what was logged and how often text moved. */
function reading(sheet: RenderedPage, script: Reply[][], signal = new AbortController().signal) {
  let model = fakeModel(sheet, script);
  let seen = { events: [] as BandEvent[], moved: 0 };
  let done = readBands(sheet, model.call, signal, () => { seen.moved++; }, event => { seen.events.push(event); });
  return { ...model, seen, done };
}

/** The text of a page of one band whose first answer is `pieces`, and how the model was asked. */
async function oneBand(pieces: Iterable<string>, second: Reply[] = []) {
  let state: AnswerState = { reads: 0, cancelled: false };
  let run = reading(page([500]), [[says(pieces, { state }), ...second]]);
  return { ...await run.done, asks: run.asks.length, state, events: run.seen.events };
}

/** What of the page each ask was for, in the order asked. */
function partsAsked(run: { asks: { top: number; rows: number }[] }): { top: number; rows: number }[] {
  return run.asks.map(({ top, rows }) => ({ top, rows }));
}

// The pause before a failed call is made again is off, but where it is what is tested.
beforeEach(() => {
  Object.assign(RETRY_PAUSE, { ms: 0, jitterMs: 0 });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("readBands", () => {
  it("reads the bands that have pixels, and gives their texts in order, a line each", async () => {
    // The last band holds a rule and no writing.
    let sheet = page([900, undefined, 700, 20]);
    let run = reading(sheet, [
      [says(["Harbour ", "Ledger\n\n", "Lot 55-0193-G"])], [], [says("  \n18,442.07 florins.\n\n")], [says("")],
    ]);
    expect(await run.done).toEqual({ text: "Harbour Ledger\n\nLot 55-0193-G\n18,442.07 florins.", cutOff: false });
    expect(run.asks.map(({ band, width, retry }) => ({ band, width, retry }))).toEqual([
      { band: 1, width: WIDTH, retry: false }, { band: 3, width: WIDTH, retry: false },
      { band: 4, width: WIDTH, retry: false },
    ]);
    // Once for each piece of text that arrived.
    expect(run.seen.moved).toBe(4);
  });

  it("gives no text and asks for nothing when no band has pixels", async () => {
    let run = reading(page([undefined, undefined]), [[], []]);
    expect(await run.done).toEqual({ text: "", cutOff: false });
    expect(run.asks).toEqual([]);
    expect(run.seen.events).toEqual([]);
  });

  it("has four calls in flight and no more, and keeps the page's order whatever order they end in", async () => {
    let sheet = page([5, 5, 5, 5, 5, 5, 5, 5, 5]);
    let gates = sheet.bands.map(() => deferred());
    let run = reading(sheet, sheet.bands.map((_, index) => [after(gates[index]!, says(`band ${index + 1}`))]));
    await tick();
    expect(run.asks.map(ask => ask.band)).toEqual([1, 2, 3, 4]);
    expect(run.flight.now).toBe(4);
    // The fourth ends first, and only then is a fifth begun.
    gates[3]!.resolve();
    await tick();
    expect(run.asks.map(ask => ask.band)).toEqual([1, 2, 3, 4, 5]);
    expect(run.flight.now).toBe(4);
    for (let index of [8, 7, 6, 5, 4, 2, 1, 0]) {
      gates[index]!.resolve();
      await tick();
      expect(run.flight.now).toBeLessThanOrEqual(4);
    }
    expect((await run.done).text).toBe(sheet.bands.map((_, index) => `band ${index + 1}`).join("\n"));
    expect(run.flight.most).toBe(4);
    expect(run.asks).toHaveLength(9);
  });

  it("counts a second ask among the four in flight", async () => {
    let sheet = page([5, 5, 5, 5, 5, 5]);
    let gate = deferred();
    let run = reading(sheet, sheet.bands.map((_, index) => [
      fails(refusal({ httpStatus: 503 })), after(gate, says(`band ${index + 1}`)),
    ]));
    await tick();
    expect(run.asks.map(({ band, retry }) => `${band}${retry ? " again" : ""}`))
      .toEqual(["1", "2", "3", "4", "1 again", "2 again", "3 again", "4 again"]);
    expect(run.flight.now).toBe(4);
    gate.resolve();
    expect((await run.done).text).toBe("band 1\nband 2\nband 3\nband 4\nband 5\nband 6");
    expect(run.flight.most).toBe(4);
  });

  describe("a call that fails", () => {
    it.each([429, 500, 503, 599])("is made again after HTTP %i", async status => {
      let run = reading(page([5, 5]), [
        [fails(refusal({ httpStatus: status, providerCode: 3040 }, 40)), says("the second answer")], [says("below")],
      ]);
      expect(await run.done).toEqual({ text: "the second answer\nbelow", cutOff: false });
      expect(run.asks.map(({ band, retry }) => ({ band, retry }))).toEqual([
        { band: 1, retry: false }, { band: 2, retry: false }, { band: 1, retry: true },
      ]);
      expect(run.seen.events).toEqual([
        { band: 1, bands: 2, imageBytes: 40 + SENT, asks: 2, askedAgain: "failed" },
        { band: 2, bands: 2, imageBytes: SENT, asks: 1 },
      ]);
    });

    it("is made again when its response broke or reported an error partway, without what it had said", async () => {
      let run = reading(page([5]), [[says(["half a ", "page"], { breaks: broken() }), says("the whole page")]]);
      expect(await run.done).toEqual({ text: "the whole page", cutOff: false });
      expect(run.asks.map(ask => ask.retry)).toEqual([false, true]);
      expect(run.seen.events).toEqual([{ band: 1, bands: 1, imageBytes: 2 * SENT, asks: 2, askedAgain: "failed" }]);
    });

    it.each([
      ["HTTP 400", refusal({ httpStatus: 400, providerCode: 8006 })],
      ["HTTP 404", refusal({ httpStatus: 404 })],
      ["HTTP 600", refusal({ httpStatus: 600 })],
      ["a request the binding threw on", refusal({ error: new Error("Network connection lost.") })],
      ["a failure of the image's own stream", new Error("The page's pixels are gone.")],
    ])("is not made again after %s, which is thrown as it is", async (_label, error) => {
      let run = reading(page([5, 5]), [[fails(error), says("never asked for")], [says("below")]]);
      await expect(run.done).rejects.toBe(error);
      expect(run.asks.filter(ask => ask.band === 1)).toHaveLength(1);
    });

    it("is not made again when the image's own stream fails while the answer is read", async () => {
      let gone = new Error("The page's pixels are gone.");
      let run = reading(page([5]), [[says(["half"], { breaks: gone }), says("never asked for")]]);
      await expect(run.done).rejects.toBe(gone);
      expect(run.asks).toHaveLength(1);
    });

    it.each([
      ["fails", fails(refusal({ httpStatus: 503 }))],
      ["breaks", says(["half"], { breaks: broken() })],
    ])("throws the second failure when the first %s and the second fails, and never asks a third time", async (_label, first) => {
      let again = refusal({ httpStatus: 500 }, 60);
      let run = reading(page([5]), [[first, fails(again), says("never asked for")]]);
      await expect(run.done).rejects.toBe(again);
      expect(run.asks.map(ask => ask.retry)).toEqual([false, true]);
      expect(run.seen.events).toEqual([{ band: 1, bands: 1, imageBytes: SENT + 60, asks: 2, askedAgain: "failed" }]);
    });

    it("keeps a second answer that does not end whole, cut off, since there is no first", async () => {
      let run = reading(page([5]), [[
        fails(refusal({ httpStatus: 429 })), says("as far as the limit", { truncated: true }), says("never asked for"),
      ]]);
      expect(await run.done).toEqual({ text: "as far as the limit", cutOff: true });
      expect(run.asks).toHaveLength(2);
    });
  });

  describe("an answer stopped at the output limit", () => {
    it("is asked for again, and a second answer that ends whole replaces it", async () => {
      let run = reading(page([5, 5]), [
        [says("as far as the limit", { truncated: true }), says("the whole band")], [says("below")],
      ]);
      expect(await run.done).toEqual({ text: "the whole band\nbelow", cutOff: false });
      expect(run.asks.filter(ask => ask.band === 1).map(ask => ask.retry)).toEqual([false, true]);
      expect(run.seen.events[0]).toEqual({ band: 1, bands: 2, imageBytes: 2 * SENT, asks: 2, askedAgain: "truncated" });
    });

    it.each([
      ["is stopped there too", says("as far as the limit, again", { truncated: true })],
      ["runs away", says(endless("| Lot 55-0193-G | 18,442.07 |\n"))],
      ["fails", fails(refusal({ httpStatus: 503 }))],
      ["breaks", says(["half"], { breaks: broken() })],
    ])("is kept, and the page cut off, when the second %s; there is no third", async (_label, second) => {
      let run = reading(page([5, 5]), [
        [says("as far as the limit", { truncated: true }), second, says("never asked for")], [says("below")],
      ]);
      expect(await run.done).toEqual({ text: "as far as the limit\nbelow", cutOff: true });
      expect(run.asks.filter(ask => ask.band === 1)).toHaveLength(2);
    });

    it("fails the page when the image's own stream fails at the second ask", async () => {
      let gone = new Error("The page's pixels are gone.");
      let run = reading(page([5]), [[says("as far as the limit", { truncated: true }), fails(gone)]]);
      await expect(run.done).rejects.toBe(gone);
    });
  });

  describe("an answer that runs away", () => {
    const ROW = "| Lot 55-0193-G | 18,442.07 |\n";

    it("is stopped at the twelfth of a unit of twelve characters or more, and asked for again", async () => {
      for (let unit of [ROW, "abcdefghijk\n"]) {
        let read = await oneBand(endless(unit, ["Harbour Ledger\n\n"]), [says("Harbour Ledger\n\nthe whole band")]);
        expect(read).toMatchObject({ text: "Harbour Ledger\n\nthe whole band", cutOff: false, asks: 2 });
        // The heading and twelve of the unit were read, and the answer then let go.
        expect(read.state).toEqual({ reads: 13, cancelled: true });
        expect(read.events).toEqual([{ band: 1, bands: 1, imageBytes: 2 * SENT, asks: 2, askedAgain: "runaway" }]);
      }
    });

    it.each([
      ["runs away too", says(endless(ROW))],
      ["is stopped at the output limit", says("as far as the limit", { truncated: true })],
      ["fails", fails(refusal({ httpStatus: 500 }))],
    ])("is kept as far as the first of what it repeated, and the page cut off, when the second %s", async (_label, second) => {
      let read = await oneBand(endless(ROW, ["Harbour Ledger\n\n"]), [second, says("never asked for")]);
      expect(read).toMatchObject({ text: `Harbour Ledger\n\n${ROW.trim()}`, cutOff: true, asks: 2 });
    });

    it("is stopped at the second ask only after 2,000 characters of what it repeats, whatever the unit", async () => {
      let again: AnswerState = { reads: 0, cancelled: false };
      let read = await oneBand(endless(ROW, ["Harbour Ledger\n\n"]), [
        says(endless(ROW, ["Harbour Ledger\n\n"]), { state: again }),
      ]);
      expect(read).toMatchObject({ text: `Harbour Ledger\n\n${ROW.trim()}`, cutOff: true, asks: 2 });
      expect(read.state).toEqual({ reads: 13, cancelled: true });
      expect(again).toEqual({ reads: 1 + Math.ceil(2000 / ROW.length), cancelled: true });
    });

    it.each([
      ["twelve", 12, "| 0 | 0 | 0 | 0 |\n"],
      ["thirteen", 13, "| 0 | 0 | 0 | 0 |\n"],
      ["forty", 40, "| N/A | 0.00 | 0.00 | 0.00 |\n"],
    ])("is not one for a table of %s equal rows, which the second ask reads to its end", async (_label, rows, equal) => {
      let table = `| Lot | Mon | Tue | Wed |\n|---|---|---|---|\n${equal.repeat(rows)}` +
        "| Total | 0 | 0 | 0 |\nCounted by the harbour master";
      for (let size of [1, 3, 4, 5]) {
        let pieces = table.match(new RegExp(`[^]{1,${size}}`, "g"))!;
        let again: AnswerState = { reads: 0, cancelled: false };
        let read = await oneBand(pieces, [says(pieces, { state: again })]);
        expect(read).toMatchObject({ text: table, cutOff: false, asks: 2 });
        // The first answer was stopped in its twelfth equal row, and the second read whole.
        expect(read.state.cancelled).toBe(true);
        expect(again).toEqual({ reads: pieces.length, cancelled: false });
        expect(read.events).toEqual([{ band: 1, bands: 1, imageBytes: 2 * SENT, asks: 2, askedAgain: "runaway" }]);
        // So is the one answer of a band whose first call failed.
        let run = reading(page([500]), [[fails(refusal({ httpStatus: 503 })), says(pieces)]]);
        expect(await run.done).toEqual({ text: table, cutOff: false });
      }
    });

    it("is cut where its repetition began, however much of it arrived at once", async () => {
      let read = await oneBand([`Harbour Ledger\n\n${ROW.repeat(1000)}`], [fails(refusal({ httpStatus: 500 }))]);
      expect(read).toMatchObject({ text: `Harbour Ledger\n\n${ROW.trim()}`, cutOff: true });
      // A unit that begins partway through the pieces, and one a few hundred characters long.
      let line = `${prose(480, 7)}\n`;
      for (let unit of ["abcdefghijk\n", line]) {
        read = await oneBand(endless(unit.slice(5) + unit.slice(0, 5), [`Before it. ${unit.slice(0, 5)}`]), [fails(broken())]);
        expect(read).toMatchObject({ text: `Before it. ${unit.trim()}`, cutOff: true });
      }
    });

    it("is one after 2,000 characters on end of a unit shorter than twelve", async () => {
      for (let unit of ["0 ", ".", "abcdefghij\n", "| | |\n"]) {
        let read = await oneBand(endless(unit, ["Total: "]), [says("Total: 0")]);
        expect(read).toMatchObject({ text: "Total: 0", asks: 2 });
        expect(read.state.cancelled).toBe(true);
        // Stopped by the piece that made it 2,000 characters, the piece before the unit counted.
        expect(read.state.reads).toBe(1 + Math.ceil(2000 / unit.length));
      }
    });

    it.each([
      ["eleven of a unit of twelve characters", `${"abcdefghijk\n".repeat(11)}the end`],
      ["eleven of a longer unit", `${ROW.repeat(11)}| Lot 55-0194-G | 9.50 |`],
      ["twelve of a unit of eleven characters", "abcdefghij\n".repeat(12)],
      ["1,999 characters of one short unit", `Total:${"0 ".repeat(999)}0`],
      ["1,999 dots", ".".repeat(1999)],
    ])("is not one for %s", async (_label, text) => {
      let read = await oneBand(text.match(/[^]{1,7}/g)!);
      expect(read).toMatchObject({ text: text.trim(), cutOff: false, asks: 1 });
      expect(read.state.cancelled).toBe(false);
    });

    it("is not one for a table's separator row, however many columns it rules", async () => {
      let rules = [["---", 60], [" :--- ", 40], [" ------------- ", 14], ["-----------", 30], [":-------------:", 24]] as const;
      for (let [rule, columns] of rules) {
        let table = row(columns, column => ` Lot ${column + 1} `) + row(columns, () => rule) +
          row(columns, column => ` 55-0193-${column} `).repeat(3);
        let read = await oneBand(table.match(/[^]{1,5}/g)!);
        expect(read).toMatchObject({ text: table.trim(), cutOff: false, asks: 1 });
      }
    });

    it("is not one for a contents page's dot leaders", async () => {
      let contents = Array.from({ length: 40 }, (_, index) =>
        `${index + 1}. ${prose(12 + index % 5, index + 1)} ${".".repeat(150)} ${index * 3 + 1}`).join("\n");
      // Leaders as dots, as dots set apart, and as one line of nothing else.
      for (let text of [contents, contents.replaceAll("...", ". . "), `Contents\n${". ".repeat(900)}\n1`, "_".repeat(1500)]) {
        let read = await oneBand(text.match(/[^]{1,9}/g)!);
        expect(read).toMatchObject({ text, cutOff: false, asks: 1 });
      }
    });

    it("holds a unit with no letter or digit, a form's empty rows, to the 2,000 characters", async () => {
      let empty = "|     |     |     |\n";
      let form = `| Name | Date | Signed |\n|---|---|---|\n${empty.repeat(40)}`;
      expect(await oneBand(form.match(/[^]{1,9}/g)!)).toMatchObject({ text: form.trim(), cutOff: false, asks: 1 });
      let read = await oneBand(endless(empty, ["| Name | Date | Signed |\n"]), [fails(broken())]);
      // The heading row ends as an empty one does, so what is repeated begins inside it.
      expect(read).toMatchObject({ text: "| Name | Date | Signed |\n|     |     |", cutOff: true, asks: 2 });
      expect(read.state.reads).toBe(1 + Math.ceil(2000 / empty.length));
    });
  });

  describe("an answer short for its band's writing", () => {
    /**
     * Three bands of 1,024 ink: the first answers `chars` characters, and the others 768 each,
     * which is 0.75 for each unit of ink.
     */
    function sheetOf(chars: number, second: Reply[] = []) {
      return reading(page([1024, 1024, 1024]), [
        [says(prose(chars)), ...second], [says(prose(768, 2))], [says(prose(768, 3))],
      ]);
    }

    it("is asked for again when it has under a third of the other bands' median characters for its ink", async () => {
      let longer = prose(700, 9);
      let run = sheetOf(255, [says(longer), says("never asked for")]);
      expect((await run.done).text.split("\n")[0]).toBe(longer);
      expect(run.asks.map(({ band, retry }) => ({ band, retry }))).toEqual([
        { band: 1, retry: false }, { band: 2, retry: false }, { band: 3, retry: false }, { band: 1, retry: true },
      ]);
      expect(run.seen.events).toEqual([
        { band: 1, bands: 3, imageBytes: 2 * SENT, asks: 2, askedAgain: "short" },
        { band: 2, bands: 3, imageBytes: SENT, asks: 1 }, { band: 3, bands: 3, imageBytes: SENT, asks: 1 },
      ]);
    });

    it("is not asked for again at a third of the median, or over it", async () => {
      for (let chars of [256, 257, 768, 1500]) {
        let run = sheetOf(chars);
        expect((await run.done).text.split("\n")[0]).toHaveLength(chars);
        expect(run.asks).toHaveLength(3);
      }
    });

    it("is measured against the median, which one long or one empty band does not move", async () => {
      // Others of 0.75, 0.75 and 6 characters for each unit of ink: a third of the median is 0.25.
      let run = reading(page([1024, 1024, 1024, 1024, 1024]), [
        [says(prose(255)), says("")], [says(prose(768, 2))], [says(prose(768, 3))], [says(prose(6144, 4))],
        [says(""), says("")],
      ]);
      await run.done;
      // The empty band has ink as the others have, so it is short too.
      expect(run.asks.filter(ask => ask.retry).map(ask => ask.band)).toEqual([1, 5]);
    });

    it("is asked for again only when its ink is at least a tenth of the other bands' median", async () => {
      // The other two bands' median ink is 1,280, of which a tenth is 128.
      let found = "found at the second ask";
      let sheet = (ink: number) => reading(page([ink, 1024, 1536]), [
        [says(""), says(found)], [says(prose(768, 2))], [says(prose(1152, 3))],
      ]);
      let asked = sheet(128);
      expect((await asked.done).text.split("\n")[0]).toBe(found);
      expect(asked.asks.filter(ask => ask.retry).map(ask => ask.band)).toEqual([1]);
      let spared = sheet(127);
      expect((await spared.done).text.split("\n")).toHaveLength(2);
      expect(spared.asks.filter(ask => ask.retry)).toEqual([]);
    });

    it("is not asked for again with fewer than two other bands that have text", async () => {
      for (let others of [[prose(768, 2)], [prose(768, 2), ""], ["", ""]]) {
        let run = reading(page([1024, ...others.map(() => 1024)]), [[says("")], ...others.map(text => [says(text)])]);
        await run.done;
        expect(run.asks.filter(ask => ask.retry)).toEqual([]);
      }
      // With two it is.
      let run = reading(page([1024, 1024, 1024]), [[says(""), says("")], [says(prose(768, 2))], [says(prose(768, 3))]]);
      await run.done;
      expect(run.asks.filter(ask => ask.retry).map(ask => ask.band)).toEqual([1]);
      // A band's own text is not one of the others'.
      let own = reading(page([1024, 1024]), [[says("ab")], [says(prose(900, 2))]]);
      await own.done;
      expect(own.asks).toHaveLength(2);
    });

    it.each([
      ["is shorter", says(prose(100, 5)), false],
      ["is as long", says(prose(255, 5)), false],
      ["fails", fails(refusal({ httpStatus: 500 })), false],
      ["breaks", says([prose(900, 5)], { breaks: broken() }), false],
      ["is longer but stopped at the output limit", says(prose(900, 5), { truncated: true }), true],
    ])("keeps the longer answer: the first when the second %s", async (_label, second, cutOff) => {
      let run = sheetOf(255, [second, says("never asked for")]);
      let read = await run.done;
      expect(read.text.split("\n")[0]).toBe(cutOff ? prose(900, 5) : prose(255));
      expect(read.cutOff).toBe(cutOff);
      expect(run.asks.filter(ask => ask.band === 1)).toHaveLength(2);
    });

    it("waits for every band's first answer before asking again", async () => {
      let gate = deferred();
      let run = reading(page([1024, 1024, 1024]), [
        [says(""), says("found at the second ask")], [says(prose(768, 2))], [after(gate, says(prose(768, 3)))],
      ]);
      await tick();
      expect(run.asks.map(ask => ask.retry)).toEqual([false, false, false]);
      gate.resolve();
      expect((await run.done).text.split("\n")[0]).toBe("found at the second ask");
      expect(run.asks.at(-1)).toMatchObject({ band: 1, retry: true });
    });

    it("has four second asks in flight at most", async () => {
      let gate = deferred();
      // Six bands with nothing read of them among three with text.
      let texts = ["", "", "", prose(768, 2), "", prose(768, 3), "", prose(768, 4), ""];
      let run = reading(page(texts.map(() => 1024)), texts.map(text => [says(text), after(gate, says("found"))]));
      await tick();
      expect(run.asks.filter(ask => ask.retry).map(ask => ask.band)).toEqual([1, 2, 3, 5]);
      expect(run.flight.now).toBe(4);
      gate.resolve();
      expect((await run.done).text.split("\n").filter(line => line === "found")).toHaveLength(6);
      expect(run.flight.most).toBe(4);
    });

    it("is never a third ask of a band already asked for twice", async () => {
      let run = reading(page([1024, 1024, 1024]), [
        [says("cut", { truncated: true }), says("cut too", { truncated: true }), says("never asked for")],
        [says(prose(768, 2))], [says(prose(768, 3))],
      ]);
      expect(await run.done).toMatchObject({ cutOff: true });
      expect(run.asks.filter(ask => ask.band === 1)).toHaveLength(2);
      expect(run.seen.events[0]).toMatchObject({ asks: 2, askedAgain: "truncated" });
    });
  });

  describe("a band cut in two", () => {
    const ROW = "| Lot 55-0193-G | 18,442.07 |\n";
    const CUT = says("as far as the limit", { truncated: true });

    // Of 90 rows, the middle third is rows 30 to 59 and the middle is row 45.
    it.each([
      ["its one least inked row", { 40: 1 }, 40],
      ["the nearest the middle of several as little inked", { 33: 2, 50: 2 }, 50],
      ["the middle, when every row is as inked as the next", {}, 45],
      ["the third's first row, whatever lies above it", { 29: 0, 30: 5 }, 30],
      ["the third's last row, whatever lies below it", { 59: 5, 60: 0 }, 59],
    ])("is cut at the least inked row of its middle third: %s", async (_label, others, cut) => {
      // The band is the page's second, so that its halves are placed in the page and not in it.
      let run = reading(tall([rowsOf(90, 9), rowsOf(90, 9, others)]), [[says("above")], [CUT, says("top"), says("bottom")]]);
      expect(await run.done).toEqual({ text: "above\ntop\nbottom", cutOff: false });
      expect(partsAsked(run).slice(1)).toEqual([
        { top: 90, rows: 90 }, { top: 90, rows: cut }, { top: 90 + cut, rows: 90 - cut },
      ]);
    });

    it("is cut between two lines of light writing on a dark ground, where the rows stand out least from their ground", async () => {
      // Every row is black but for one white pixel of writing; row 40 holds none.
      let sheet = tall([rowsOf(90, 9)]);
      let pixels = sheet.bands[0]!.pixels!.fill(0);
      for (let row = 0; row < 90; row++) if (row !== 40) pixels[row * NARROW] = 255;
      let run = reading(sheet, [[CUT, says("top"), says("bottom")]]);
      expect(await run.done).toEqual({ text: "top\nbottom", cutOff: false });
      expect(partsAsked(run)).toEqual([{ top: 0, rows: 90 }, { top: 0, rows: 40 }, { top: 40, rows: 50 }]);
    });

    it("has its halves read from its own rows, the top first, and is never asked for a fourth time", async () => {
      let sheet = tall([rowsOf(90, 9, { 50: 1 })]);
      let run = reading(sheet, [[CUT, says("the top half"), says("the bottom half"), says("never asked for")]]);
      expect(await run.done).toEqual({ text: "the top half\nthe bottom half", cutOff: false });
      expect(run.asks.map(({ band, width, retry }) => ({ band, width, retry }))).toEqual([
        { band: 1, width: NARROW, retry: false }, { band: 1, width: NARROW, retry: true },
        { band: 1, width: NARROW, retry: true },
      ]);
      // Views of the band's pixels, not copies of them.
      let { pixels } = sheet.bands[0]!;
      expect(run.asks.map(ask => [ask.pixels.buffer === pixels!.buffer, ask.pixels.byteOffset, ask.pixels.byteLength]))
        .toEqual([[true, 0, 90 * NARROW], [true, 0, 50 * NARROW], [true, 50 * NARROW, 40 * NARROW]]);
      expect(run.seen.events).toEqual([{ band: 1, bands: 1, imageBytes: 3 * SENT, asks: 3, askedAgain: "truncated" }]);
    });

    it.each([
      ["the top", [says("top", { truncated: true }), says("bottom")]],
      ["the bottom", [says("top"), says("bottom", { truncated: true })]],
      ["either", [says("top", { truncated: true }), says("bottom", { truncated: true })]],
    ])("is cut off when %s half's answer did not end whole, and no half is asked for again", async (_label, halves) => {
      let run = reading(tall([rowsOf(90, 9)]), [[CUT, ...halves, says("never asked for")]]);
      expect(await run.done).toEqual({ text: "top\nbottom", cutOff: true });
      expect(run.asks).toHaveLength(3);
    });

    it("is not asked for again when its halves' texts are short for its writing", async () => {
      let run = reading(tall([rowsOf(90, 9), rowsOf(90, 9), rowsOf(90, 9)]), [
        [CUT, says("a"), says("b"), says("never asked for")], [says(prose(600, 2))], [says(prose(600, 3))],
      ]);
      expect((await run.done).text.split("\n").slice(0, 2)).toEqual(["a", "b"]);
      expect(run.asks.filter(ask => ask.band === 1)).toHaveLength(3);
    });

    it("is cut in two when its answer ran away, and its halves let repeat for 2,000 characters", async () => {
      // A table of twenty equal rows, which the first answer was stopped in.
      let table = `| Lot | Florins |\n|---|---|\n${ROW.repeat(20)}| Total | 368,841.40 |`;
      let run = reading(tall([rowsOf(90, 9)]), [[
        says(endless(ROW, ["| Lot | Florins |\n|---|---|\n"])), says(table.match(/[^]{1,7}/g)!), says("Counted by the harbour master"),
      ]]);
      expect(await run.done).toEqual({ text: `${table}\nCounted by the harbour master`, cutOff: false });
      expect(partsAsked(run)).toEqual([{ top: 0, rows: 90 }, { top: 0, rows: 45 }, { top: 45, rows: 45 }]);
      expect(run.seen.events).toEqual([{ band: 1, bands: 1, imageBytes: 3 * SENT, asks: 3, askedAgain: "runaway" }]);

      // A half that runs away is stopped, and kept as far as the first of what it repeated.
      let state: AnswerState = { reads: 0, cancelled: false };
      run = reading(tall([rowsOf(90, 9)]), [[says(endless(ROW)), says(endless(ROW), { state }), says("the end")]]);
      expect(await run.done).toEqual({ text: `${ROW.trim()}\nthe end`, cutOff: true });
      expect(state).toEqual({ reads: Math.ceil(2000 / ROW.length), cancelled: true });
    });

    it.each([
      ["is stopped at the output limit", says("as far as the limit", { truncated: true }), "as far as the limit"],
      ["runs away", says(endless(ROW)), ROW.trim()],
    ])("is not cut when the call made again after one that failed %s: that answer is kept, cut off", async (_label, second, text) => {
      for (let first of [fails(refusal({ httpStatus: 503 })), says(["half"], { breaks: broken() })]) {
        let run = reading(tall([rowsOf(90, 9)]), [[first, second, says("never asked for")]]);
        expect(await run.done).toEqual({ text, cutOff: true });
        expect(partsAsked(run)).toEqual([{ top: 0, rows: 90 }, { top: 0, rows: 90 }]);
        expect(run.seen.events).toEqual([{ band: 1, bands: 1, imageBytes: 2 * SENT, asks: 2, askedAgain: "failed" }]);
      }
    });

    it("has only its halves that have ink asked for", async () => {
      // The top half of the first is white, and the bottom half of the second.
      let run = reading(tall([[...rowsOf(50, 0), ...rowsOf(40, 9)], [...rowsOf(40, 9), ...rowsOf(50, 0)]]), [
        [CUT, says("the bottom half"), says("never asked for")], [CUT, says("the top half"), says("never asked for")],
      ]);
      expect(await run.done).toEqual({ text: "the bottom half\nthe top half", cutOff: false });
      expect(partsAsked(run).filter(({ rows }) => rows !== 90)).toEqual([{ top: 45, rows: 45 }, { top: 90, rows: 45 }]);
      expect(run.seen.events).toEqual([
        { band: 1, bands: 2, imageBytes: 2 * SENT, asks: 2, askedAgain: "truncated" },
        { band: 2, bands: 2, imageBytes: 2 * SENT, asks: 2, askedAgain: "truncated" },
      ]);
    });

    it("keeps its first answer, cut off, when neither half has ink, and asks for nothing more", async () => {
      let run = reading(tall([rowsOf(90, 0)]), [[CUT, says("never asked for")]]);
      expect(await run.done).toEqual({ text: "as far as the limit", cutOff: true });
      expect(run.seen.events).toEqual([{ band: 1, bands: 1, imageBytes: SENT, asks: 1 }]);
    });

    it.each([
      ["the top half's call fails as one that may be made again", [fails(refusal({ httpStatus: 503 }))], 2],
      ["the top half's call is refused", [fails(refusal({ httpStatus: 400, providerCode: 8006 }))], 2],
      ["the top half's response breaks", [says(["half"], { breaks: broken() })], 2],
      ["the bottom half's call fails", [says("the top half"), fails(refusal({ httpStatus: 503 }))], 3],
    ])("keeps its first answer, cut off, when %s, and asks for nothing after", async (_label, halves, asks) => {
      let run = reading(tall([rowsOf(90, 9)]), [[CUT, ...halves, says("never asked for"), says("never asked for")]]);
      expect(await run.done).toEqual({ text: "as far as the limit", cutOff: true });
      expect(run.asks).toHaveLength(asks);
      expect(run.seen.events).toEqual([{ band: 1, bands: 1, imageBytes: asks * SENT, asks, askedAgain: "truncated" }]);
    });

    it("fails the page when the image's own stream fails at a half", async () => {
      let gone = new Error("The page's pixels are gone.");
      let run = reading(tall([rowsOf(90, 9)]), [[CUT, says("the top half"), fails(gone)]]);
      await expect(run.done).rejects.toBe(gone);
    });

    it("is asked for again as it is with fewer than 64 rows, and cut in two with 64", async () => {
      let small = reading(tall([rowsOf(63, 9)]), [[CUT, says("the whole band"), says("never asked for")]]);
      expect(await small.done).toEqual({ text: "the whole band", cutOff: false });
      expect(partsAsked(small)).toEqual([{ top: 0, rows: 63 }, { top: 0, rows: 63 }]);
      let cut = reading(tall([rowsOf(64, 9)]), [[CUT, says("top"), says("bottom")]]);
      expect(await cut.done).toEqual({ text: "top\nbottom", cutOff: false });
      expect(partsAsked(cut)).toEqual([{ top: 0, rows: 64 }, { top: 0, rows: 32 }, { top: 32, rows: 32 }]);
    });

    describe("whose answer is short for its writing", () => {
      /** Three bands of 810 ink: the first answers 100 characters, and the others 600 each. */
      function sheetOf(halves: Reply[]) {
        return reading(tall([rowsOf(90, 9), rowsOf(90, 9), rowsOf(90, 9)]), [
          [says(prose(100)), ...halves, says("never asked for")], [says(prose(600, 2))], [says(prose(600, 3))],
        ]);
      }

      it("has its halves asked for once every band has answered, and their texts kept when longer together", async () => {
        let run = sheetOf([says(prose(300, 5)), says(prose(300, 6))]);
        expect((await run.done).text.split("\n").slice(0, 2)).toEqual([prose(300, 5), prose(300, 6)]);
        expect(partsAsked(run)).toEqual([
          { top: 0, rows: 90 }, { top: 90, rows: 90 }, { top: 180, rows: 90 }, { top: 0, rows: 45 }, { top: 45, rows: 45 },
        ]);
        expect(run.seen.events[0]).toEqual({ band: 1, bands: 3, imageBytes: 3 * SENT, asks: 3, askedAgain: "short" });
      });

      it.each([
        ["its halves' texts are shorter together", [says(prose(49, 5)), says(prose(49, 6))], 3],
        ["they are as long together", [says(prose(49, 5)), says(prose(50, 6))], 3],
        ["the top half's call fails, after which the bottom is not asked for", [fails(refusal({ httpStatus: 503 }))], 2],
        ["the bottom half's call fails", [says(prose(300, 5)), fails(refusal({ httpStatus: 400 }))], 3],
      ])("keeps its first answer as it is when %s", async (_label, halves, asks) => {
        let run = sheetOf(halves);
        let read = await run.done;
        expect(read.text.split("\n")[0]).toBe(prose(100));
        expect(read.cutOff).toBe(false);
        expect(run.asks.filter(ask => ask.band === 1)).toHaveLength(asks);
      });

      it("is cut off when its halves' texts are kept and one did not end whole", async () => {
        let run = sheetOf([says(prose(300, 5)), says(prose(300, 6), { truncated: true })]);
        expect(await run.done).toMatchObject({ cutOff: true });
      });
    });
  });

  describe("the pause before a failed call is made again", () => {
    beforeEach(() => {
      Object.assign(RETRY_PAUSE, { ms: 250, jitterMs: 250 });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    });

    it.each([[0, 250], [0.5, 375], [0.996, 499]])("is 250 ms and up to 250 more at random: %f makes %i", async (random, ms) => {
      vi.spyOn(Math, "random").mockReturnValue(random);
      for (let first of [fails(refusal({ httpStatus: 503 })), says(["half"], { breaks: broken() })]) {
        let run = reading(page([5]), [[first, says("the second answer")]]);
        await vi.advanceTimersByTimeAsync(ms - 1);
        await settle();
        expect(run.asks).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(await run.done).toEqual({ text: "the second answer", cutOff: false });
        expect(run.asks).toHaveLength(2);
        expect(vi.getTimerCount()).toBe(0);
      }
    });

    it.each([400, 503])("comes before a call that failed for want of room, under HTTP %i, is made again, and never a third time", async status => {
      vi.spyOn(Math, "random").mockReturnValue(0);
      let again = refusal({ httpStatus: status, providerCode: 3040 }, 60);
      let run = reading(page([5]), [[
        fails(refusal({ httpStatus: status, providerCode: 3040 })), fails(again), says("never asked for"),
      ]]);
      let failed = expect(run.done).rejects.toBe(again);
      await vi.advanceTimersByTimeAsync(249);
      await settle();
      expect(run.asks).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      await failed;
      expect(run.asks.map(ask => ask.retry)).toEqual([false, true]);
      expect(run.seen.events).toEqual([{ band: 1, bands: 1, imageBytes: SENT + 60, asks: 2, askedAgain: "failed" }]);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("is ended at once when another band fails the page, which does not wait it out", async () => {
      let gate = deferred();
      let refused = refusal({ httpStatus: 400 });
      let run = reading(page([5, 5]), [
        [fails(refusal({ httpStatus: 503 })), says("never asked for")], [after(gate, fails(refused))],
      ]);
      let failed = expect(run.done).rejects.toBe(refused);
      await settle();
      expect(vi.getTimerCount()).toBe(1);
      gate.resolve();
      await settle();
      // No time has passed.
      expect(vi.getTimerCount()).toBe(0);
      await failed;
      expect(run.asks.map(({ band, retry }) => ({ band, retry }))).toEqual([
        { band: 1, retry: false }, { band: 2, retry: false },
      ]);
    });

    it("is ended at once when the signal aborts", async () => {
      let request = new AbortController();
      let reason = new Error("The text was cancelled.");
      let run = reading(page([5]), [[fails(refusal({ httpStatus: 503 })), says("never asked for")]], request.signal);
      let failed = expect(run.done).rejects.toBe(reason);
      await settle();
      expect(vi.getTimerCount()).toBe(1);
      request.abort(reason);
      expect(vi.getTimerCount()).toBe(0);
      await failed;
      expect(run.asks).toHaveLength(1);
    });

    it("is not made before a band's halves, nor after a half that failed", async () => {
      let cut = says("as far as the limit", { truncated: true });
      let run = reading(tall([rowsOf(90, 9), rowsOf(90, 9)]), [
        [cut, says("top"), says("bottom")], [cut, fails(refusal({ httpStatus: 503 })), says("never asked for")],
      ]);
      // No time passes.
      expect(await run.done).toEqual({ text: "top\nbottom\nas far as the limit", cutOff: true });
      expect(run.asks).toHaveLength(5);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe("ending early", () => {
    /** How many of the fake calls and answers below have ended. */
    type Ended = { count: number };

    /** A call the service does not answer: aborted, it takes `ms` to fail as an aborted request does. */
    function unanswered(ended: Ended, ms: number): Reply {
      return signal => new Promise<Transcription>((_, reject) => {
        signal.addEventListener("abort", () => {
          setTimeout(() => {
            ended.count++;
            reject(refusal({ error: signal.reason }, 10));
          }, ms);
        });
      });
    }

    /**
     * An answer that gives one piece and then nothing: its request's signal does not end it, and
     * cancelled, it takes `ms` to fail as a response that broke off does.
     */
    function stalled(ended: Ended, ms: number, state: AnswerState): Reply {
      return async () => {
        let cancelled!: () => void;
        let wait = new Promise<void>(resolve => { cancelled = resolve; });
        return {
          sentBytes: SENT,
          truncated: false,
          async next() {
            if (state.reads++ === 0) return "half a band";
            await wait;
            await tick(ms);
            ended.count++;
            throw broken();
          },
          async cancel() {
            state.cancelled = true;
            cancelled();
          },
        };
      };
    }

    it("gives up every call in flight when its signal aborts, and waits for all of them", async () => {
      let ended = { count: 0 };
      let states = [{ reads: 0, cancelled: false }, { reads: 0, cancelled: false }];
      let request = new AbortController();
      let run = reading(page([5, 5, 5, 5, 5, 5]), [
        [unanswered(ended, 20), says("never asked for")], [stalled(ended, 40, states[0]!), says("never asked for")],
        [unanswered(ended, 5), says("never asked for")], [stalled(ended, 30, states[1]!), says("never asked for")],
        [says("never asked for")], [says("never asked for")],
      ], request.signal);
      let settled = false;
      void run.done.catch(() => undefined).finally(() => { settled = true; });
      await tick();
      expect(run.asks).toHaveLength(4);
      let reason = new Error("The text was cancelled.");
      request.abort(reason);
      expect(run.asks.every(ask => ask.signal.aborted && ask.signal.reason === reason)).toBe(true);
      expect(states.every(state => state.cancelled)).toBe(true);
      // Not before the slowest of the four has ended.
      await tick(25);
      expect(settled).toBe(false);
      await expect(run.done).rejects.toBe(reason);
      expect(ended.count).toBe(4);
      expect(run.flight.now).toBe(0);
      // No band was asked for again, and none after the four.
      expect(run.asks).toHaveLength(4);
      expect(run.seen.events.map(({ band, asks }) => ({ band, asks }))).toEqual([
        { band: 1, asks: 1 }, { band: 2, asks: 1 }, { band: 3, asks: 1 }, { band: 4, asks: 1 },
      ]);
    });

    it("makes no call for a signal already aborted", async () => {
      let reason = new Error("The text was cancelled.");
      let run = reading(page([5, 5]), [[], []], AbortSignal.abort(reason));
      await expect(run.done).rejects.toBe(reason);
      expect(run.asks).toEqual([]);
      expect(run.seen.events).toEqual([]);
    });

    it("gives up the other calls when a band fails for good, and waits for them before failing with it", async () => {
      let ended = { count: 0 };
      let state = { reads: 0, cancelled: false };
      let gate = deferred();
      let refused = refusal({ httpStatus: 400 }, 70);
      let run = reading(page([5, 5, 5, 5, 5, 5]), [
        [unanswered(ended, 30)], [after(gate, fails(refused))], [stalled(ended, 20, state)], [unanswered(ended, 10)],
        [says("never asked for")], [says("never asked for")],
      ]);
      let settled = false;
      void run.done.catch(() => undefined).finally(() => { settled = true; });
      await tick();
      gate.resolve();
      await tick(15);
      expect(settled).toBe(false);
      expect(run.asks.every(ask => ask.signal.aborted)).toBe(true);
      expect(state.cancelled).toBe(true);
      await expect(run.done).rejects.toBe(refused);
      expect(ended.count).toBe(3);
      expect(run.asks.map(ask => ask.band)).toEqual([1, 2, 3, 4]);
      expect(run.seen.events).toEqual([
        { band: 1, bands: 6, imageBytes: 10, asks: 1 }, { band: 2, bands: 6, imageBytes: 70, asks: 1 },
        { band: 3, bands: 6, imageBytes: SENT, asks: 1 }, { band: 4, bands: 6, imageBytes: 10, asks: 1 },
      ]);
    });

    it("does not ask again for a band whose answer ended as the page was given up", async () => {
      let gate = deferred();
      let refused = refusal({ httpStatus: 400 });
      // An answer that ends, stopped at the output limit, once it is cancelled.
      let cut: Reply = async () => {
        let cancelled = deferred();
        return {
          sentBytes: SENT, truncated: true,
          next: () => cancelled.promise.then(() => undefined),
          cancel: async () => cancelled.resolve(),
        };
      };
      let run = reading(page([5, 5]), [[cut, says("never asked for")], [after(gate, fails(refused))]]);
      await tick();
      gate.resolve();
      await expect(run.done).rejects.toBe(refused);
      expect(run.asks.map(({ band, retry }) => ({ band, retry }))).toEqual([
        { band: 1, retry: false }, { band: 2, retry: false },
      ]);
      // An ask that was not made is not logged as one.
      expect(run.seen.events).toEqual([
        { band: 1, bands: 2, imageBytes: SENT, asks: 1 }, { band: 2, bands: 2, imageBytes: SENT, asks: 1 },
      ]);
    });

    it("gives up an answer that arrives after the page was given up", async () => {
      let ended = { count: 0 };
      let state = { reads: 0, cancelled: false };
      let refused = refusal({ httpStatus: 400 });
      // A call that does not heed its signal, answered once the other band has failed.
      let late: Reply = async signal => {
        await tick(10);
        return stalled(ended, 0, state)(signal);
      };
      let run = reading(page([5, 5]), [[late], [fails(refused)]]);
      await expect(run.done).rejects.toBe(refused);
      expect(state.cancelled).toBe(true);
      expect(ended.count).toBe(1);
    });

    it("does not ask again for a call that failed because it was given up", async () => {
      // A request given up fails as one the binding threw on does, and so may one answered 503.
      let request = new AbortController();
      let reason = new Error("The text sat idle.");
      let run = reading(page([5]), [[
        async signal => {
          request.abort(reason);
          expect(signal.aborted).toBe(true);
          throw refusal({ httpStatus: 503 });
        },
        says("never asked for"),
      ]], request.signal);
      await expect(run.done).rejects.toBe(reason);
      expect(run.asks).toHaveLength(1);
    });
  });

  it("logs one event a band, of numbers and fixed words, and never text", async () => {
    let texts = [prose(300, 11), prose(280, 12), prose(310, 13), prose(290, 14)];
    let run = reading(page([900, undefined, 800, 700, 850]), [
      [says(texts[0]!)], [],
      [says(endless("Lot 55-0193-G, 18,442.07 florins.\n")), says(texts[1]!)],
      [says(texts[2]!, { truncated: true }), says(texts[3]!, { truncated: true })],
      [fails(refusal({ httpStatus: 503 }, 12)), says(texts[3]!)],
    ]);
    expect(await run.done).toEqual({ text: [texts[0], texts[1], texts[2], texts[3]].join("\n"), cutOff: true });
    expect(run.seen.events).toEqual([
      { band: 1, bands: 5, imageBytes: SENT, asks: 1 },
      { band: 3, bands: 5, imageBytes: 2 * SENT, asks: 2, askedAgain: "runaway" },
      { band: 4, bands: 5, imageBytes: 2 * SENT, asks: 2, askedAgain: "truncated" },
      { band: 5, bands: 5, imageBytes: 12 + SENT, asks: 2, askedAgain: "failed" },
    ]);
    let logged = JSON.stringify(run.seen.events);
    for (let word of ["harbour", "ledger", "florins", "Lot", "55-0193"]) expect(logged).not.toContain(word);
    for (let event of run.seen.events) {
      for (let [key, value] of Object.entries(event)) {
        if (key === "askedAgain") expect(["failed", "truncated", "runaway", "short"]).toContain(value);
        else expect(value).toBeTypeOf("number");
      }
    }
  });
});
