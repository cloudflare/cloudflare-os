import { afterEach, describe, expect, it, vi } from "vitest";
import { GMAIL_PDF, type PdfPageRange } from "../src/drive-pdf";
import { forwardRangeReader, type PdfOpener } from "../src/pdf-forward-reader";

/** A file of 1,000 bytes in which a byte out of place shows. */
const FILE = Uint8Array.from({ length: 1000 }, (_, i) => (i * 7 + (i >> 8)) % 256);
/** How many bytes the fake file hands out at a time. */
const CHUNK = 100;
const BROKE = new Error("The attachment's download broke off.");
const REFUSED = new Error("The observation was refused.");
const STALLED = "The PDF stopped arriving while a page was being read; read it again.";
const LET_GO = "The PDF is no longer being read.";

/** What one open of the fake file does other than hand the file out to its end. */
type Plan = {
  /** What the open rejects with. */
  refuse?: Error;
  /** What the open waits for before it answers. */
  wait?: Promise<void>;
  /** How many bytes are handed out before a read fails, is never answered, or finds the file ended. */
  breakAt?: number;
  stallAt?: number;
  endAt?: number;
};

/** One open of the fake file: what it was for, the stream it answered with, and what became of that. */
type Opened = {
  purpose: { page?: number; again: boolean };
  stream?: ReadableStream<Uint8Array>;
  handed: number;
  cancelled: boolean;
};

/**
 * A file that is read only from its start. The nth open does what `plans[n]` says, and hands the
 * file out {@link CHUNK} bytes at a time, each only when it is read.
 */
function fakeFile(plans: Plan[] = []) {
  let opens: Opened[] = [];
  let open: PdfOpener = async purpose => {
    let plan = plans[opens.length] ?? {};
    let opened: Opened = { purpose, handed: 0, cancelled: false };
    opens.push(opened);
    await plan.wait;
    if (plan.refuse) throw plan.refuse;
    opened.stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (opened.handed === plan.breakAt) throw BROKE;
        if (opened.handed === plan.stallAt) return new Promise<void>(() => {});
        if (opened.handed >= (plan.endAt ?? FILE.byteLength)) return controller.close();
        controller.enqueue(FILE.slice(opened.handed, opened.handed += CHUNK));
      },
      cancel() { opened.cancelled = true; },
    }, { highWaterMark: 0 });
    return opened.stream;
  };
  return { open, opens };
}

/** The range of page image `page`: `length` bytes from `offset`. */
function range(page: number, offset: number, length: number): PdfPageRange {
  return { page, offset, length, fileSize: FILE.byteLength };
}

/** The range the whole file is read by. */
const WHOLE: PdfPageRange = { offset: 0, length: FILE.byteLength, fileSize: FILE.byteLength };

/** All of a stream's bytes, read a chunk at a time. */
async function bytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  let reader = stream.getReader();
  let read: number[] = [];
  for (;;) {
    let chunk = await reader.read();
    if (chunk.done) return Uint8Array.from(read);
    read.push(...chunk.value);
  }
}

/** What each open was for. */
function purposes(opens: Opened[]) {
  return opens.map(({ purpose }) => purpose);
}

/** A pause long enough for anything read ahead of what was asked for to show. */
function settled(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 20));
}

/** A promise, and what resolves it. */
function deferred() {
  let resolve!: () => void;
  let promise = new Promise<void>(settle => { resolve = settle; });
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("forwardRangeReader", () => {
  it("serves page images in the file's order from one open, dropping the bytes between them", async () => {
    let { open, opens } = fakeFile();
    let { readRange } = forwardRangeReader(open, GMAIL_PDF);
    // Nothing is opened until a range is asked for.
    expect(opens).toEqual([]);

    // Ranges with bytes between them, one after another, inside one chunk, and at the file's end.
    for (let [page, offset, length] of [[1, 120, 60], [2, 180, 250], [3, 440, 5], [4, 990, 10]] as const) {
      expect(await bytes(await readRange(range(page, offset, length)))).toEqual(FILE.slice(offset, offset + length));
    }
    expect(purposes(opens)).toEqual([{ page: 1, again: false }]);
    expect(opens[0]!.cancelled).toBe(false);
  });

  it("reads a range only as it is read, and keeps no more between ranges than the rest of one chunk", async () => {
    let { open, opens } = fakeFile();
    let { readRange } = forwardRangeReader(open, GMAIL_PDF);

    let first = (await readRange(range(1, 250, 170))).getReader();
    // The pass stands at the range's start, in the chunk that holds it, and no further.
    await settled();
    expect(opens[0]!.handed).toBe(300);
    expect((await first.read()).value).toEqual(FILE.slice(250, 300));
    await settled();
    expect(opens[0]!.handed).toBe(300);
    expect((await first.read()).value).toEqual(FILE.slice(300, 400));
    expect((await first.read()).value).toEqual(FILE.slice(400, 420));
    expect((await first.read()).done).toBe(true);
    await settled();
    expect(opens[0]!.handed).toBe(500);

    // The next range begins in what was left of that chunk: nothing is read to stand at it.
    let second = await readRange(range(2, 450, 100));
    expect(opens[0]!.handed).toBe(500);
    expect(await bytes(second)).toEqual(FILE.slice(450, 550));
    await settled();
    expect(opens[0]!.handed).toBe(600);
  });

  it("says it moved for each chunk it drops on the way to a range, and for none of the range", async () => {
    let { open } = fakeFile();
    let { readRange } = forwardRangeReader(open, GMAIL_PDF);
    let moved = vi.fn();

    let first = await readRange(range(1, 250, 10), moved);
    expect(moved).toHaveBeenCalledTimes(3);
    await bytes(first);
    expect(moved).toHaveBeenCalledTimes(3);
    // The rest of the chunk the first range ended in, and two chunks more.
    await readRange(range(2, 480, 10), moved);
    expect(moved).toHaveBeenCalledTimes(6);
  });

  it.each([
    ["under a range", 300, 6],
    ["on the way to one", 100, 4],
  ])("opens the file again, once, when the pass breaks %s, and goes on from where the range had got to", async (_label, breakAt, moves) => {
    let { open, opens } = fakeFile([{ breakAt }]);
    let { readRange } = forwardRangeReader(open, GMAIL_PDF);
    let moved = vi.fn();

    expect(await bytes(await readRange(range(2, 250, 170), moved))).toEqual(FILE.slice(250, 420));
    expect(purposes(opens)).toEqual([{ page: 2, again: false }, { page: 2, again: true }]);
    // What the new pass gives before the range's place is dropped, chunk by chunk.
    expect(moved).toHaveBeenCalledTimes(moves);
    expect(opens[1]!.handed).toBe(500);
  });

  it("fails a range under which the pass breaks a second time, with what the read failed with", async () => {
    let { open, opens } = fakeFile([{ breakAt: 300 }, { breakAt: 400 }]);
    let { readRange } = forwardRangeReader(open, GMAIL_PDF);

    let reader = (await readRange(range(1, 250, 170))).getReader();
    expect((await reader.read()).value).toEqual(FILE.slice(250, 300));
    expect((await reader.read()).value).toEqual(FILE.slice(300, 400));
    await expect(reader.read()).rejects.toBe(BROKE);
    expect(opens).toHaveLength(2);
  });

  it("rejects a range the pass breaks twice on the way to", async () => {
    let { open, opens } = fakeFile([{ breakAt: 100 }, { breakAt: 200 }]);
    let { readRange } = forwardRangeReader(open, GMAIL_PDF);

    await expect(readRange(range(1, 250, 170))).rejects.toBe(BROKE);
    expect(opens).toHaveLength(2);
  });

  it("opens the file again once for each range", async () => {
    let { open, opens } = fakeFile([{ breakAt: 300 }, { breakAt: 600 }]);
    let { readRange } = forwardRangeReader(open, GMAIL_PDF);

    expect(await bytes(await readRange(range(1, 250, 170)))).toEqual(FILE.slice(250, 420));
    expect(await bytes(await readRange(range(2, 550, 100)))).toEqual(FILE.slice(550, 650));
    expect(purposes(opens)).toEqual([
      { page: 1, again: false }, { page: 1, again: true }, { page: 2, again: true },
    ]);
  });

  it("opens the file again when a read of the pass has been outstanding for fifteen seconds", async () => {
    vi.useFakeTimers();
    let { open, opens } = fakeFile([{ stallAt: 300 }]);
    let { readRange } = forwardRangeReader(open, GMAIL_PDF);

    let reading = bytes(await readRange(range(1, 250, 170)));
    await vi.advanceTimersByTimeAsync(14_999);
    expect(opens).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await reading).toEqual(FILE.slice(250, 420));
    expect(purposes(opens)).toEqual([{ page: 1, again: false }, { page: 1, again: true }]);
    expect(opens[0]!.cancelled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails a range under which the pass stalls a second time, saying so, after the time it was told", async () => {
    vi.useFakeTimers();
    let { open, opens } = fakeFile([{ stallAt: 300 }, { stallAt: 300 }]);
    let { readRange } = forwardRangeReader(open, GMAIL_PDF, { stallMs: 50 });

    let reader = (await readRange(range(1, 250, 170))).getReader();
    expect((await reader.read()).value).toEqual(FILE.slice(250, 300));
    let outcome: unknown = "waiting";
    reader.read().then(() => { outcome = "read"; }, (error: unknown) => { outcome = error; });
    await vi.advanceTimersByTimeAsync(99);
    expect(outcome).toBe("waiting");
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toEqual(new Error(STALLED));
    expect(opens.map(({ cancelled }) => cancelled)).toEqual([true, true]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times only a read that is outstanding, not a range that is read slowly", async () => {
    vi.useFakeTimers();
    let { open, opens } = fakeFile();
    let { readRange } = forwardRangeReader(open, GMAIL_PDF);

    let reader = (await readRange(range(1, 250, 170))).getReader();
    for (let read = 0; read < 3; read++) {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(vi.getTimerCount()).toBe(0);
      expect((await reader.read()).done).toBe(false);
    }
    expect((await reader.read()).done).toBe(true);
    // Nor is the pass timed between two ranges.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await bytes(await readRange(range(2, 500, 50)))).toEqual(FILE.slice(500, 550));
    expect(opens).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("opens a new pass for a range that starts before where the pass has got to", async () => {
    let { open, opens } = fakeFile();
    let { readRange } = forwardRangeReader(open, GMAIL_PDF);

    expect(await bytes(await readRange(range(1, 600, 50)))).toEqual(FILE.slice(600, 650));
    // One byte before the pass's place, in the chunk it still holds the rest of.
    expect(await bytes(await readRange(range(2, 649, 20)))).toEqual(FILE.slice(649, 669));
    expect(await bytes(await readRange(range(3, 200, 50)))).toEqual(FILE.slice(200, 250));
    expect(purposes(opens)).toEqual([
      { page: 1, again: false }, { page: 2, again: false }, { page: 3, again: false },
    ]);
    expect(opens.map(({ cancelled }) => cancelled)).toEqual([true, true, false]);
  });

  it("opens a pass for a range before its place four times, and then fails such a range", async () => {
    let { open, opens } = fakeFile();
    let { readRange } = forwardRangeReader(open, GMAIL_PDF);

    // A page image that an update to the file defined again lies after the ones that follow it.
    for (let page = 1; page <= 8; page += 2) {
      expect(await bytes(await readRange(range(page, 600, 50)))).toEqual(FILE.slice(600, 650));
      expect(await bytes(await readRange(range(page + 1, 200, 50)))).toEqual(FILE.slice(200, 250));
    }
    expect(opens).toHaveLength(5);
    await bytes(await readRange(range(9, 600, 50)));
    await expect(readRange(range(10, 200, 50))).rejects.toThrow(new Error(GMAIL_PDF.transcriptionFailed));
    expect(opens).toHaveLength(5);
    expect(opens.every(({ cancelled }) => cancelled)).toBe(true);
  });

  it("opens a pass for a page that is asked for again, however often, and counts none of those among the four", async () => {
    let { open, opens } = fakeFile();
    let { readRange } = forwardRangeReader(open, GMAIL_PDF);

    // A page whose call the model's service refused is asked for again, from a pass that stands
    // past it: at its own end, or at the end of a page after it.
    for (let again = 0; again < 6; again++) {
      expect(await bytes(await readRange(range(1, 600, 50)))).toEqual(FILE.slice(600, 650));
    }
    expect(await bytes(await readRange(range(2, 700, 50)))).toEqual(FILE.slice(700, 750));
    expect(await bytes(await readRange(range(1, 600, 50)))).toEqual(FILE.slice(600, 650));
    expect(purposes(opens)).toEqual(Array.from({ length: 7 }, () => ({ page: 1, again: false })));

    // The four passes for a page image that lies before the pass's place are all still to be had.
    for (let page = 3; page <= 10; page += 2) {
      expect(await bytes(await readRange(range(page, 700, 50)))).toEqual(FILE.slice(700, 750));
      expect(await bytes(await readRange(range(page + 1, 200, 50)))).toEqual(FILE.slice(200, 250));
    }
    expect(opens).toHaveLength(11);
    await bytes(await readRange(range(11, 700, 50)));
    await expect(readRange(range(12, 200, 50))).rejects.toThrow(new Error(GMAIL_PDF.transcriptionFailed));
    expect(opens).toHaveLength(11);
  });

  it.each([
    ["under a range", 300],
    ["before one", 200],
  ])("fails a range as a changed file when the file ends %s, having opened it again once", async (_label, endAt) => {
    let { open, opens } = fakeFile([{ endAt }, { endAt }]);
    let { readRange } = forwardRangeReader(open, GMAIL_PDF);

    let read = readRange(range(1, 250, 170)).then(bytes);
    await expect(read).rejects.toThrow(new Error(GMAIL_PDF.changed));
    expect(purposes(opens)).toEqual([{ page: 1, again: false }, { page: 1, again: true }]);
  });

  it.each([
    ["partway", 1],
    ["before any of it was read", 0],
  ])("lets the pass go when a range is cancelled %s, and opens a new one for the next", async (_label, reads) => {
    let { open, opens } = fakeFile();
    let { readRange } = forwardRangeReader(open, GMAIL_PDF);

    let reader = (await readRange(range(1, 250, 170))).getReader();
    for (let read = 0; read < reads; read++) await reader.read();
    await reader.cancel();
    expect(opens[0]!.cancelled).toBe(true);

    expect(await bytes(await readRange(range(2, 500, 50)))).toEqual(FILE.slice(500, 550));
    expect(purposes(opens)).toEqual([{ page: 1, again: false }, { page: 2, again: false }]);
  });

  it("leaves no timer behind, and opens nothing again, when a range is cancelled with a read outstanding", async () => {
    vi.useFakeTimers();
    let { open, opens } = fakeFile([{ stallAt: 300 }]);
    let { readRange } = forwardRangeReader(open, GMAIL_PDF);

    let reader = (await readRange(range(1, 250, 170))).getReader();
    await reader.read();
    let pending = reader.read();
    await vi.advanceTimersByTimeAsync(1);
    expect(vi.getTimerCount()).toBe(1);
    await reader.cancel();
    expect(vi.getTimerCount()).toBe(0);
    expect((await pending).done).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(opens).toHaveLength(1);
    expect(opens[0]!.cancelled).toBe(true);
  });

  it("gives up a range that has not ended when the next is asked for", async () => {
    let { open, opens } = fakeFile();
    let { readRange } = forwardRangeReader(open, GMAIL_PDF);

    let first = (await readRange(range(1, 250, 170))).getReader();
    await first.read();
    expect(await bytes(await readRange(range(2, 500, 50)))).toEqual(FILE.slice(500, 550));
    await expect(first.read()).rejects.toThrow(LET_GO);
    expect(purposes(opens)).toEqual([{ page: 1, again: false }, { page: 2, again: false }]);
    expect(opens[0]!.cancelled).toBe(true);
  });

  it("gives the whole file as a stream of its own, which leaves the pass where it is", async () => {
    let { open, opens } = fakeFile();
    let { readRange } = forwardRangeReader(open, GMAIL_PDF);

    await bytes(await readRange(range(1, 250, 50)));
    let whole = await readRange(WHOLE);
    expect(whole).toBe(opens[1]!.stream);
    expect(await bytes(whole)).toEqual(FILE);
    expect(await bytes(await readRange(range(2, 400, 50)))).toEqual(FILE.slice(400, 450));
    expect(purposes(opens)).toEqual([{ page: 1, again: false }, { again: false }]);
    expect(opens[0]).toMatchObject({ handed: 500, cancelled: false });
  });

  it("passes on what an open rejects with as it is, and does not open again", async () => {
    let first = fakeFile([{ refuse: REFUSED }, { refuse: REFUSED }]);
    await expect(forwardRangeReader(first.open, GMAIL_PDF).readRange(range(1, 250, 170))).rejects.toBe(REFUSED);
    await expect(forwardRangeReader(first.open, GMAIL_PDF).readRange(WHOLE)).rejects.toBe(REFUSED);
    expect(first.opens).toHaveLength(2);

    // The open after a break is refused: the range fails with that, not with the break.
    let again = fakeFile([{ breakAt: 300 }, { refuse: REFUSED }]);
    let reader = (await forwardRangeReader(again.open, GMAIL_PDF).readRange(range(1, 250, 170))).getReader();
    await reader.read();
    await expect(reader.read()).rejects.toBe(REFUSED);
    expect(again.opens).toHaveLength(2);
  });

  it("lets the pass go when released, and reads nothing after", async () => {
    let { open, opens } = fakeFile();
    let { readRange, release } = forwardRangeReader(open, GMAIL_PDF);

    await bytes(await readRange(range(1, 250, 50)));
    let unread = (await readRange(range(2, 400, 50))).getReader();
    release();
    expect(opens[0]!.cancelled).toBe(true);
    await expect(unread.read()).rejects.toThrow(LET_GO);
    await expect(readRange(range(3, 500, 50))).rejects.toThrow(LET_GO);
    await expect(readRange(WHOLE)).rejects.toThrow(LET_GO);
    release();
    expect(opens).toHaveLength(1);
  });

  it("rejects a range that is waiting on the pass when released, leaving no timer behind", async () => {
    vi.useFakeTimers();
    let { open, opens } = fakeFile([{ stallAt: 100 }]);
    let { readRange, release } = forwardRangeReader(open, GMAIL_PDF);

    let outcome: unknown = "waiting";
    readRange(range(1, 250, 50)).then(() => { outcome = "read"; }, (error: unknown) => { outcome = error; });
    await vi.advanceTimersByTimeAsync(1);
    expect([outcome, vi.getTimerCount()]).toEqual(["waiting", 1]);
    release();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(outcome).toEqual(new Error(LET_GO));
    expect(opens).toHaveLength(1);
    expect(opens[0]!.cancelled).toBe(true);
  });

  it.each([
    ["a page image", range(1, 250, 50)],
    ["the whole file", WHOLE],
  ])("cancels the stream an open for %s answers with after the reader was released", async (_label, asked) => {
    let wait = deferred();
    let { open, opens } = fakeFile([{ wait: wait.promise }]);
    let { readRange, release } = forwardRangeReader(open, GMAIL_PDF);

    let pending = readRange(asked);
    release();
    wait.resolve();
    await expect(pending).rejects.toThrow(LET_GO);
    expect(opens).toHaveLength(1);
    expect(opens[0]).toMatchObject({ handed: 0, cancelled: true });
  });

  it("gives nothing of a range that was given up while its bytes were on their way, and still guards the pass for the next", async () => {
    let { open } = fakeFile();
    let { readRange } = forwardRangeReader(open, GMAIL_PDF);

    // The first range's bytes are in the rest of a chunk, so its read is served without a read
    // of the pass, and is still on its way when the next range is asked for.
    let first = (await readRange(range(1, 10, 20))).getReader();
    let read = first.read();
    let second = (await readRange(range(2, 40, 30))).getReader();
    await expect(read).rejects.toThrow(LET_GO);

    // The second range is the one being read: asked for a third, it is given up in its turn.
    let third = await readRange(range(3, 80, 10));
    await expect(second.read()).rejects.toThrow(LET_GO);
    expect(await bytes(third)).toEqual(FILE.slice(80, 90));
  });

  it("rejects a range whose place was reached from a chunk's rest when the reader is released meanwhile", async () => {
    let { open, opens } = fakeFile();
    let { readRange, release } = forwardRangeReader(open, GMAIL_PDF);
    expect(await bytes(await readRange(range(1, 10, 20)))).toEqual(FILE.slice(10, 30));

    let pending = readRange(range(2, 40, 20));
    release();
    await expect(pending).rejects.toThrow(LET_GO);
    expect(opens).toHaveLength(1);
    expect(opens[0]!.cancelled).toBe(true);
  });

  it("cancels the stream an open answers with after its range was given up", async () => {
    let wait = deferred();
    let { open, opens } = fakeFile([{ wait: wait.promise }]);
    let { readRange } = forwardRangeReader(open, GMAIL_PDF);

    let first = readRange(range(1, 250, 50));
    let second = readRange(range(2, 500, 50));
    wait.resolve();
    await expect(first).rejects.toThrow(LET_GO);
    expect(await bytes(await second)).toEqual(FILE.slice(500, 550));
    expect(opens.map(({ handed, cancelled }) => ({ handed, cancelled }))).toEqual([
      { handed: 0, cancelled: true }, { handed: 600, cancelled: false },
    ]);
  });
});
