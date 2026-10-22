import { describe, expect, it } from "vitest";
import { MAX_TOOL_RESULT_CHARS } from "../src/agent";
import { BlobReader, BlobWriter, CHUNK_MAX_SIZE, type ChunkStore } from "../src/git-chunked-blob";
import { encodeLooseObject } from "../src/git-codec";
import { UnreadableContentError } from "../src/git-cache";
import { readFileWindow, type LineSource, type ReadFileWindow } from "../src/line-window";
import type { GitObjectRecord } from "../src/storage-schema/overseer-storage";

const MAX = MAX_TOOL_RESULT_CHARS;

// A blob source over an in-memory chunk store, stored as the git store stores it: chunked iff
// over CHUNK_MAX_SIZE.
function blob(content: string | Uint8Array): LineSource & { kind: "blob" } {
  let bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
  let rows = new Map<string, GitObjectRecord>();
  let store: ChunkStore = { get: oid => rows.get(oid), put: record => rows.set(record.oid, record) };
  let writer = new BlobWriter(store, bytes.length);
  writer.write(bytes);
  let pending = writer.finish();
  let record: GitObjectRecord = pending.record ??
      { oid: pending.oid, data: encodeLooseObject("blob", pending.payload) };
  rows.set(record.oid, record);
  return { kind: "blob", reader: BlobReader.open(store, record) };
}

const text = (content: string): LineSource => ({ kind: "text", text: content });

const render = (source: LineSource, window: ReadFileWindow, maxChars = MAX) =>
  readFileWindow(source, window, "f.txt", maxChars);

// readFileWindow as it was before blob sources existed, verbatim: the reference that every
// recorded read was rendered with, which a read of valid, NUL-free text must still reproduce.
function legacyReadFileWindow(content: string, { startLine, lineCount }: ReadFileWindow): string {
  if (startLine === undefined && lineCount === undefined && content.length <= MAX) return content;
  let lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  let first = startLine ?? 1;
  if (first > lines.length) {
    throw new Error(`startLine ${first} is past the end of the file, which has ` +
        `${lines.length} line${lines.length === 1 ? "" : "s"}.`);
  }
  let note = (last: number) => `[lines ${first}-${last} of ${lines.length}` +
      (last < lines.length ? `; next startLine: ${last + 1}]` : "]");
  let limit = lineCount === undefined ? lines.length : Math.min(lines.length, first - 1 + lineCount);
  let budget = MAX - note(lines.length - 1).length - 2;
  let last = first;
  let chars = lines[first - 1].length;
  while (last < limit && chars + 1 + lines[last].length <= budget) {
    chars += 1 + lines[last].length;
    ++last;
  }
  return `${lines.slice(first - 1, last).join("\n")}\n\n${note(last)}`;
}

// The window note at the end of `shown`, or a thrown error naming what was there instead.
function windowNote(shown: string) {
  let match = /\n\n\[lines (\d+)-(\d+) of (\d+)(?:; next startLine: (\d+))?\]$/.exec(shown);
  if (match === null) throw new Error(`no window note: ${shown.slice(-100)}`);
  return {
    body: shown.slice(0, match.index),
    first: Number(match[1]),
    last: Number(match[2]),
    total: Number(match[3]),
    next: match[4] === undefined ? undefined : Number(match[4]),
  };
}

// Deterministic pseudo-random numbers in [0, 1) (mulberry32).
function rng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Random NUL-free text with lines of widely varying length and multi-byte characters.
function randomText(random: () => number, approxBytes: number): string {
  let alphabet = ["a", "b", " ", "é", "中", "😀", "\t", "\r"];
  let parts: string[] = [];
  let bytes = 0;
  while (bytes < approxBytes) {
    let r = random();
    let length = r < 0.05 ? Math.floor(random() * 40_000) : r < 0.2 ? 0 : Math.floor(random() * 120);
    let line = Array.from({ length }, () => alphabet[Math.floor(random() * alphabet.length)]).join("");
    parts.push(line);
    bytes += new TextEncoder().encode(line).length + 1;
  }
  let joined = parts.join("\n");
  return random() < 0.5 ? joined + "\n" : joined;
}

describe("readFile windows", () => {
  let file = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
  let bigLine = "0123456789".repeat(10);
  let bigLines = Math.ceil(MAX / (bigLine.length + 1)) + 50;
  let big = Array.from({ length: bigLines }, () => bigLine).join("\n");

  // Every rule shared by both sources is checked against both.
  for (let [name, source] of [["text", text], ["blob", blob]] as const) {
    describe(`from ${name}`, () => {
      it("returns a small unwindowed file verbatim", () => {
        expect(render(source(file), {})).toBe(file);
        expect(render(source(""), {})).toBe("");
      });

      it("returns the requested lines with the range and where to continue", () => {
        expect(render(source(file), { startLine: 3, lineCount: 2 }))
            .toBe("line 3\nline 4\n\n[lines 3-4 of 10; next startLine: 5]");
        expect(render(source(file), { startLine: 9 }))
            .toBe("line 9\nline 10\n\n[lines 9-10 of 10]");
        expect(render(source(file), { lineCount: 1 }))
            .toBe("line 1\n\n[lines 1-1 of 10; next startLine: 2]");
      });

      it("counts a final line with or without its newline, and no line in an empty file", () => {
        expect(render(source("a\nb"), { startLine: 2 })).toBe("b\n\n[lines 2-2 of 2]");
        expect(render(source("a\nb\n"), { startLine: 2 })).toBe("b\n\n[lines 2-2 of 2]");
        expect(render(source("a\n\n"), { startLine: 2 })).toBe("\n\n[lines 2-2 of 2]");
        expect(() => render(source(""), { startLine: 1 }))
            .toThrow("startLine 1 is past the end of the file, which has 0 lines.");
      });

      it("rejects a start past the end", () => {
        expect(() => render(source(file), { startLine: 11 }))
            .toThrow("startLine 11 is past the end of the file, which has 10 lines.");
        expect(() => render(source("one"), { startLine: 2 }))
            .toThrow("startLine 2 is past the end of the file, which has 1 line.");
      });

      it("turns an unwindowed read of a large file into a window of whole lines under the cap",
          () => {
        let shown = render(source(big), {});
        expect(shown.length).toBeLessThanOrEqual(MAX);
        let note = windowNote(shown);
        expect(note).toMatchObject({ first: 1, total: bigLines, next: note.last + 1 });
        expect(note.body).toBe(Array.from({ length: note.last }, () => bigLine).join("\n"));
        // One more line would not have fit.
        expect(shown.length + bigLine.length + 1).toBeGreaterThan(MAX);
      });

      it("treats lineCount as an upper bound, so an oversized request still says where to continue",
          () => {
        let shown = render(source(big), { startLine: 5, lineCount: bigLines });
        expect(shown.length).toBeLessThanOrEqual(MAX);
        let note = windowNote(shown);
        expect(note).toMatchObject({ first: 5, total: bigLines, next: note.last + 1 });
        expect(note.last).toBeLessThan(bigLines);
        expect(note.body).toBe(Array.from({ length: note.last - 4 }, () => bigLine).join("\n"));
      });
    });
  }

  it("renders a chunked blob exactly as the pre-blob renderer rendered its text", () => {
    let random = rng(1);
    for (let round = 0; round < 6; round++) {
      let content = randomText(random, round < 2 ? 4000 : 3 * CHUNK_MAX_SIZE);
      let source = blob(content);
      let lines = content.split("\n").length;
      let windows: ReadFileWindow[] = [{}, { startLine: 1 }, { startLine: lines - 1 }];
      for (let i = 0; i < 40; i++) {
        let startLine = 1 + Math.floor(random() * (lines - 1));
        windows.push(random() < 0.5 ? { startLine }
            : { startLine, lineCount: 1 + Math.floor(random() * 200) });
      }
      for (let window of windows) {
        let expected: string;
        try {
          expected = legacyReadFileWindow(content, window);
        } catch (err) {
          expect(() => render(source, window)).toThrow((err as Error).message);
          expect(() => render(text(content), window)).toThrow((err as Error).message);
          continue;
        }
        expect(render(text(content), window)).toBe(expected);
        let shown = render(source, window);
        // A first line too long for the cap is shown whole from text, but cut from a blob.
        if (/\n\n\[line \d+ of \d+ is \d+ bytes; showing/.test(shown)) {
          let body = windowNote(expected).body;
          expect(body.includes("\n") || body.length < MAX - 100).toBe(false);
          expect(body.startsWith(shown.slice(0, shown.lastIndexOf("\n\n[")))).toBe(true);
        } else {
          expect(shown).toBe(expected);
        }
      }
    }
  });

  it("windows across chunk boundaries, including a line that spans one", () => {
    // Lines of ~300 KiB: every chunk boundary falls inside one.
    let content = Array.from({ length: 12 }, (_, i) => line(i)).join("\n") + "\n";
    let source = blob(content);
    for (let startLine = 1; startLine <= 12; startLine++) {
      let shown = render(source, { startLine, lineCount: 1 }, 400 * 1024);
      expect(shown.split("\n")[0]).toBe(line(startLine - 1));
      expect(shown).toBe(textRender(content, { startLine, lineCount: 1 }, 400 * 1024));
    }
  });

  it("decides the verbatim fit from the size bound: 3 bytes can be one character", () => {
    // Exactly at the bound, an all-3-byte file (and one of 3-byte invalid sequences) is MAX
    // characters, so still returned whole; 3 bytes more and it cannot fit.
    let threeByte = "中".repeat(MAX);
    expect(render(blob(threeByte), {})).toBe(threeByte);
    let invalid = new Uint8Array(3 * MAX);
    for (let i = 0; i < invalid.length; i += 3) invalid.set([0xf0, 0x90, 0x80], i);
    expect(render(blob(invalid), {})).toBe("\ufffd".repeat(MAX));
    expect(render(blob(threeByte + "中"), {})).not.toBe(threeByte + "中");
  });

  it("errors on binary data in the window, naming its lines, but not just outside it", () => {
    let content = "one\ntwo\nthr\0ee\nfour\nfive\n";
    expect(() => render(blob(content), { startLine: 2, lineCount: 2 }))
        .toThrow(new UnreadableContentError(
            "f.txt contains binary data in lines 2-3, which readFile cannot show as text."));
    expect(() => render(blob(content), { startLine: 3, lineCount: 1 }))
        .toThrow("f.txt contains binary data in line 3,");
    expect(() => render(blob(content), {})).toThrow("binary data in lines 1-5");
    expect(render(blob(content), { startLine: 4 })).toBe("four\nfive\n\n[lines 4-5 of 5]");
    expect(render(blob(content), { startLine: 1, lineCount: 2 }))
        .toBe("one\ntwo\n\n[lines 1-2 of 5; next startLine: 3]");
    // Session text is shown as it is, as it always was.
    expect(render(text(content), {})).toBe(content);
  });

  it("shows invalid UTF-8 as U+FFFD", () => {
    let bytes = Uint8Array.of(0x61, 0xff, 0x62, 0x0a, 0xe4, 0xb8, 0x0a, 0x63);
    expect(render(blob(bytes), {})).toBe("a\ufffdb\n\ufffd\nc");
    expect(render(blob(bytes), { startLine: 2 })).toBe("\ufffd\nc\n\n[lines 2-3 of 3]");
  });

  it("cuts a single blob line longer than the cap, saying so; text keeps it whole", () => {
    let long = "y".repeat(5 * CHUNK_MAX_SIZE + 7);
    let content = `short\n${long}\nafter\n`;
    let shown = render(blob(content), { startLine: 2 });
    expect(shown.length).toBeLessThanOrEqual(MAX);
    let match = /^(y*)\n\n\[line 2 of 3 is (\d+) bytes; showing the first (\d+) characters\. Use readBytes for byte ranges\.\]$/
        .exec(shown);
    expect(match).not.toBeNull();
    expect(Number(match![2])).toBe(long.length);
    expect(Number(match![3])).toBe(match![1].length);
    expect(render(text(content), { startLine: 2 })).toBe(`${long}\n\n[lines 2-2 of 3; next startLine: 3]`);

    // A whole file with no newline, read unwindowed, is cut the same way; a surrogate pair is
    // never split.
    let emoji = "😀".repeat(MAX);
    let cut = render(blob(emoji), {});
    expect(cut.length).toBeLessThanOrEqual(MAX);
    expect(cut).toMatch(/^(?:😀)+\n\n\[line 1 of 1 is \d+ bytes;/);
  });
});

// A line of ~300 KiB, numbered.
function line(i: number): string {
  return `${i}:` + "x".repeat(300 * 1024);
}

// The text-source rendering at another cap, for windows wider than MAX_TOOL_RESULT_CHARS.
function textRender(content: string, window: ReadFileWindow, maxChars: number): string {
  return readFileWindow(text(content), window, "f.txt", maxChars);
}
