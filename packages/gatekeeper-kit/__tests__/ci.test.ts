import { describe, expect, it } from "vitest";
import {
  AppliedPushLog,
  CI_LOG_MAX_LINES,
  CI_START_WINDOW_MS,
  CiLogCache,
  CiLogTooLargeError,
  applyCarriageReturns,
  pageCiLog,
  readCiLog,
  stripAnsi,
  type CiLog,
} from "../src/ci";
import { fakeKv } from "./fake-kv";

const ESC = "\x1b";
const plain = (line: string): string => applyCarriageReturns(stripAnsi(line));

function stream(...chunks: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      }
      controller.close();
    },
  });
}

function numbered(count: number, from = 1): string[] {
  return Array.from({ length: count }, (_, index) => `line ${from + index}`);
}

function logOf(lines: string[], firstLine = 1): CiLog {
  return { lines, firstLine, totalLines: firstLine + lines.length - 1 };
}

describe("stripAnsi and applyCarriageReturns", () => {
  it("strip ANSI sequences and keep the text after the last carriage return", () => {
    expect(stripAnsi(`${ESC}[32;1mok${ESC}[0m done`)).toBe("ok done");
    expect(stripAnsi(`${ESC}]0;title\x07${ESC}(Bplain`)).toBe("plain");
    expect(stripAnsi("  indented\tverbatim  ")).toBe("  indented\tverbatim  ");
    expect(applyCarriageReturns("10%\r50%\r100%")).toBe("100%");
    expect(applyCarriageReturns("windows line\r")).toBe("windows line");
    expect(applyCarriageReturns("  indented\tverbatim  ")).toBe("  indented\tverbatim  ");
    expect(applyCarriageReturns("\r\r")).toBe("");
  });

  it("takes linear time over a long run of carriage returns before other text", () => {
    // A backtracking `/\r+$/` takes several seconds on this, past the test timeout; the scan is instant.
    expect(applyCarriageReturns(`${"\r".repeat(200_000)}x\r\r`)).toBe("x");
  });
});

describe("readCiLog", () => {
  it("splits lines across chunk and multi-byte boundaries and keeps a final line without newline", async () => {
    const bytes = new TextEncoder().encode("é");
    const log = await readCiLog(stream("fir", "st\nsec", "ond\r", "\n", bytes.slice(0, 1), bytes.slice(1), "nd"),
      plain);
    expect(log).toEqual({ lines: ["first", "second", "énd"], firstLine: 1, totalLines: 3 });
  });

  it("does not count a trailing newline as a line, and counts empty lines", async () => {
    expect(await readCiLog(stream("a\n\nb\n"), plain))
      .toEqual({ lines: ["a", "", "b"], firstLine: 1, totalLines: 3 });
    expect(await readCiLog(stream(), plain)).toEqual({ lines: [], firstLine: 1, totalLines: 0 });
  });

  it("passes each raw line, less a leading BOM, to normalizeLine and counts only the lines it keeps", async () => {
    const seen: string[] = [];
    const log = await readCiLog(stream("\uFEFF# setup\n", `${ESC}[1mkeep\r\n`, "\uFEFF# done\n", "last"), line => {
      seen.push(line);
      return line.startsWith("#") ? null : line.toUpperCase();
    });
    expect(seen).toEqual(["# setup", `${ESC}[1mkeep\r`, "# done", "last"]);
    expect(log).toEqual({ lines: [`${ESC}[1MKEEP\r`, "LAST"], firstLine: 1, totalLines: 2 });
  });

  it("keeps only the tail within retainBytes while counting every line", async () => {
    const body = numbered(1000).join("\n");
    // "line NNN" costs 2 * 8 + 16 = 32 bytes and "line 1000" 34: room for exactly 100 lines.
    const log = await readCiLog(stream(body), plain, { retainBytes: 32 * 99 + 34 });
    expect(log.totalLines).toBe(1000);
    expect(log.lines.at(-1)).toBe("line 1000");
    expect(log.lines.length).toBe(100);
    expect(log.firstLine).toBe(901);
    expect(log.lines[0]).toBe(`line ${log.firstLine}`);
  });

  it("refuses a body past maxBytes", async () => {
    await expect(readCiLog(stream("a".repeat(10), "b".repeat(10)), plain, { maxBytes: 15 }))
      .rejects.toBeInstanceOf(CiLogTooLargeError);
    await expect(readCiLog(stream("a".repeat(15)), plain, { maxBytes: 15 })).resolves
      .toMatchObject({ totalLines: 1 });
  });

  it("cuts an over-long line to its start, and keeps progress overwrites of one exactly", async () => {
    const huge = "x".repeat(100_000);
    const log = await readCiLog(stream(huge.slice(0, 50_000), huge.slice(50_000), "\nnext\n"), plain);
    expect(log.totalLines).toBe(2);
    expect(log.lines[0]!.startsWith("xxx")).toBe(true);
    expect(log.lines[0]!.endsWith("… [line truncated]")).toBe(true);
    expect(log.lines[0]!.length).toBeLessThan(10_000);
    expect(log.lines[1]).toBe("next");

    const progress = await readCiLog(stream(huge, "\r", "100% done\r", "\n"), plain);
    expect(progress.lines).toEqual(["100% done"]);
  });

  it("streams an endless run of carriage returns without retaining the run", async () => {
    // 16 MiB of bare `\r`s in 1024 chunks: no newline and no overwrite point. Remembering the whole
    // run grew with the stream and rescanned it on every chunk, far past the test timeout.
    const chunk = new TextEncoder().encode("\r".repeat(16 * 1024));
    let remaining = 1024;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (remaining-- > 0) controller.enqueue(chunk);
        else {
          controller.enqueue(new TextEncoder().encode("done\nnext\n"));
          controller.close();
        }
      },
    });
    expect(await readCiLog(body, plain)).toEqual({ lines: ["done", "next"], firstLine: 1, totalLines: 2 });
  });

  it("cuts an over-long line before a character that would straddle the cut, not through it", async () => {
    // The emoji is two UTF-16 code units, the first of them the 8192nd.
    const log = await readCiLog(stream(`${"x".repeat(8191)}😀 and more\n`), plain);
    expect(log.lines).toEqual([`${"x".repeat(8191)}… [line truncated]`]);
  });

  it("validates its bounds", async () => {
    await expect(readCiLog(stream("a"), plain, { retainBytes: 0 })).rejects.toThrow(/retainBytes/);
  });
});

describe("pageCiLog", () => {
  const log = logOf(numbered(500));

  it("returns the last 200 lines by default", () => {
    const page = pageCiLog(log, undefined, true);
    expect(page.lines).toHaveLength(200);
    expect(page.lines[0]).toEqual({ number: 301, text: "line 301" });
    expect(page.lines.at(-1)).toEqual({ number: 500, text: "line 500" });
    expect(page).toMatchObject({ totalLines: 500, firstAvailableLine: 1, complete: true });
  });

  it("pages forward from fromLine", () => {
    const page = pageCiLog(log, { fromLine: 10, maxLines: 3 }, false);
    expect(page.lines.map(line => line.number)).toEqual([10, 11, 12]);
    expect(page.complete).toBe(false);
    expect(pageCiLog(log, { fromLine: 499, maxLines: 5 }, true).lines.map(line => line.number))
      .toEqual([499, 500]);
    expect(pageCiLog(log, { fromLine: 501 }, true).lines).toEqual([]);
  });

  it("caps maxLines", () => {
    const long = logOf(numbered(3000));
    expect(pageCiLog(long, { maxLines: 10_000 }, true).lines).toHaveLength(CI_LOG_MAX_LINES);
  });

  it("starts at the first available line when fromLine is below it", () => {
    const tail = logOf(numbered(10, 91), 91);
    const page = pageCiLog(tail, { fromLine: 1, maxLines: 2 }, true);
    expect(page.lines.map(line => line.number)).toEqual([91, 92]);
    expect(page).toMatchObject({ totalLines: 100, firstAvailableLine: 91 });
  });

  it("returns the last matching lines for a search, case-insensitively", () => {
    const mixed = logOf(["ok", "Error: one", "ok", "error: two", "ERROR three", "ok"]);
    expect(pageCiLog(mixed, { search: "error", maxLines: 2 }, true).lines).toEqual([
      { number: 4, text: "error: two" },
      { number: 5, text: "ERROR three" },
    ]);
    expect(pageCiLog(mixed, { search: "eRRor", fromLine: 3 }, true).lines.map(line => line.number))
      .toEqual([4, 5]);
    expect(pageCiLog(mixed, { search: "error", fromLine: 1, maxLines: 1 }, true).lines)
      .toEqual([{ number: 2, text: "Error: one" }]);
  });

  it("refuses invalid options with a TypeError", () => {
    for (const options of [
      { fromLine: 0 }, { fromLine: 1.5 }, { maxLines: -1 }, { maxLines: "5" }, { search: 3 },
    ]) {
      expect(() => pageCiLog(log, options as never, true)).toThrow(TypeError);
    }
    expect(() => pageCiLog(log, "tail" as never, true)).toThrow(TypeError);
  });
});

describe("CiLogCache", () => {
  function makeCache(options: { ttlMs?: number; maxTotalBytes?: number } = {}) {
    const kv = fakeKv();
    let now = 1_000;
    const cache = new CiLogCache(kv, { ...options, now: () => now });
    return { kv, cache, advance: (ms: number) => void (now += ms) };
  }

  it("round-trips a log stored across several chunks", () => {
    const { kv, cache } = makeCache();
    // 2000 lines of ~200 characters is ~800 KiB at two bytes per character: at least two chunks.
    const lines = Array.from({ length: 2000 }, (_, index) => `${index}:${"y".repeat(200)}`);
    lines[5] = "";
    const log: CiLog = { lines, firstLine: 11, totalLines: 2010 };
    cache.put("job:1", log);
    expect(kv.keys().filter(key => key.includes(":chunk:")).length).toBeGreaterThan(1);
    expect(cache.get("job:1")).toEqual(log);
    expect(cache.get("job:2")).toBeUndefined();
  });

  it("round-trips an empty log", () => {
    const { cache } = makeCache();
    cache.put("empty", { lines: [], firstLine: 1, totalLines: 0 });
    expect(cache.get("empty")).toEqual({ lines: [], firstLine: 1, totalLines: 0 });
  });

  it("treats expired entries as misses and deletes them", () => {
    const { kv, cache, advance } = makeCache({ ttlMs: 60_000 });
    cache.put("job", logOf(["a", "b"]));
    advance(59_999);
    expect(cache.get("job")).toEqual(logOf(["a", "b"]));
    advance(1);
    expect(cache.get("job")).toBeUndefined();
    expect(kv.keys()).toEqual(["ciLog:totalBytes"]);
    expect(kv.get("ciLog:totalBytes")).toBe(0);
  });

  it("treats an entry another version of the cache wrote as a miss and deletes it", () => {
    const { kv, cache } = makeCache();
    cache.put("job", logOf(["a", "b"]));
    const metaKey = kv.keys().find(key => key.includes(":meta:"))!;
    kv.put(metaKey, { ...kv.get<object>(metaKey), version: 2 });
    expect(cache.get("job")).toBeUndefined();
    expect(kv.keys()).toEqual(["ciLog:totalBytes"]);
    expect(kv.get("ciLog:totalBytes")).toBe(0);
  });

  it("evicts the oldest entries to stay within its budget", () => {
    // Each log is 100 nine-character lines joined by newlines: 2 * 999 = 1998 bytes.
    const lines = Array.from({ length: 100 }, () => "x".repeat(9));
    const { cache, advance } = makeCache({ maxTotalBytes: 5000 });
    cache.put("a", logOf(lines));
    advance(1);
    cache.put("b", logOf(lines));
    advance(1);
    cache.put("c", logOf(lines));
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toEqual(logOf(lines));
    expect(cache.get("c")).toEqual(logOf(lines));
  });

  it("replaces an entry under the same key and skips a log larger than the budget", () => {
    const { kv, cache } = makeCache({ maxTotalBytes: 100 });
    cache.put("job", logOf(["first"]));
    cache.put("job", logOf(["second"]));
    expect(cache.get("job")).toEqual(logOf(["second"]));
    expect(kv.get("ciLog:totalBytes")).toBe(12);
    cache.put("job", logOf(["z".repeat(100)]));
    expect(cache.get("job")).toBeUndefined();
    cache.delete("missing");
    expect(kv.keys()).toEqual(["ciLog:totalBytes"]);
  });

  it("reports whether delete removed a live entry", () => {
    const { cache, advance } = makeCache({ ttlMs: 60_000 });
    cache.put("live", logOf(["a"]));
    cache.put("stale", logOf(["b"]));
    expect(cache.delete("live")).toBe(true);
    expect(cache.delete("live")).toBe(false);
    advance(60_000);
    expect(cache.delete("stale")).toBe(false);
  });

  it("keeps keys that share a prefix apart", () => {
    const { cache } = makeCache();
    cache.put("a", logOf(["one"]));
    cache.put("a:000000", logOf(["two"]));
    cache.delete("a");
    expect(cache.get("a:000000")).toEqual(logOf(["two"]));
  });
});

describe("AppliedPushLog", () => {
  it("records a head once, keeping the first time", () => {
    let now = 1_000;
    const log = new AppliedPushLog(fakeKv(), { now: () => now });
    log.record("a");
    now += 5;
    log.record("a");
    expect(log.get("a")).toBe(1_000);
    expect(log.get("b")).toBeUndefined();
  });

  it("prunes records past the window when recording", () => {
    let now = 0;
    const kv = fakeKv();
    const log = new AppliedPushLog(kv, { now: () => now });
    log.record("old");
    now = CI_START_WINDOW_MS;
    log.record("new");
    expect(kv.keys()).toEqual(["ciPushApplied:new"]);
  });

  it("reads no record once it is past the window, before any prune", () => {
    let now = 0;
    const log = new AppliedPushLog(fakeKv(), { now: () => now });
    log.record("a");
    now = CI_START_WINDOW_MS - 1;
    expect(log.get("a")).toBe(0);
    now = CI_START_WINDOW_MS;
    expect(log.get("a")).toBeUndefined();
  });

  it("drops the oldest records past the cap", () => {
    let now = 0;
    const kv = fakeKv();
    const log = new AppliedPushLog(kv, { max: 2, now: () => now++ });
    for (const sha of ["c", "a", "b"]) log.record(sha);
    expect(kv.keys()).toEqual(["ciPushApplied:a", "ciPushApplied:b"]);
  });
});
