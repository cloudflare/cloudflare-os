import {describe, expect, it} from "vitest";
import {MAX_TOOL_RESULT_CHARS, readFileWindow} from "../src/agent";
import {formatGrep, matchLines, scanWorkpieceForGrep, type GrepScan} from "../src/grep";

describe("grep", () => {
  it("anchors on the line, not its CRLF ending", () => {
    expect(matchLines("alpha\r\nneedle\r\nneedle too\r\n", /needle$/))
        .toEqual([{line: 2, text: "needle"}]);
  });

  it("keeps whole lines under the cap, notes included, and says how many were dropped", () => {
    let scan: GrepScan = {
      files: [{path: "a.txt", text: Array.from({length: 100}, (_, i) => `hit ${i}`).join("\n")}],
      errors: Array.from({length: 50}, (_, i) => ({file: `b${i}`, error: `b${i} is binary`})),
      single: false,
    };
    let full = formatGrep(scan, /hit/, Infinity).split("\n");
    expect(full).toHaveLength(150);

    // Parses a cut result into its kept lines and the two counts its notes report.
    let parse = (text: string) => {
      let lines = text.split("\n");
      let more = (re: RegExp) => Number(lines.find(l => re.test(l))?.match(/\d+/)?.[0] ?? 0);
      return {
        lines,
        matches: lines.filter(l => l.startsWith("a.txt:")),
        skipped: lines.filter(l => l.startsWith("(skipped:")),
        moreMatches: more(/^\(\d+ more matches/),
        moreSkipped: more(/^\(\d+ more files skipped\)$/),
      };
    };

    // Tight: every kept line is a whole leading line of its group, both counts add up, and
    // the whole stays under the cap even with both notes present.
    for (let cap of [120, 200, 600, 1500]) {
      let cut = parse(formatGrep(scan, /hit/, cap));
      expect(cut.lines.join("\n").length).toBeLessThanOrEqual(cap);
      expect(cut.matches).toEqual(full.slice(0, cut.matches.length));
      expect(cut.matches.length + cut.moreMatches).toBe(100);
      expect(cut.skipped.length + cut.moreSkipped).toBe(50);
    }
    // Wide enough for everything: no notes at all.
    let whole = parse(formatGrep(scan, /hit/, 10_000));
    expect(whole.lines).toEqual(full);
  });

  it("reports no matches, not an error, for an empty workpiece", async () => {
    // No base commit, so nothing in the cache is ever consulted except the (empty) blob batch.
    let unreached = () => { throw new Error("not reached"); };
    let cache = {
      pathEntryAtCommit: unreached, listCommitTreePaths: unreached, readTextBlob: unreached,
      ensureBlobs: async () => new Set<string>(),
    };
    let turn = {getOverlayFiles: () => new Map<string, string>(), getRemovedPaths: () => new Set<string>()};
    let scan = await scanWorkpieceForGrep(cache, turn, 1, undefined, undefined);
    expect(formatGrep(scan, /x/, Infinity)).toBe("(no matches)");
    await expect(scanWorkpieceForGrep(cache, turn, 1, undefined, "src"))
        .rejects.toThrow("src: no such file or directory");
  });
});

describe("readFile windows", () => {
  let file = Array.from({length: 10}, (_, i) => `line ${i + 1}`).join("\n") + "\n";
  let bigLine = "0123456789".repeat(10);
  let bigLines = Math.ceil(MAX_TOOL_RESULT_CHARS / (bigLine.length + 1)) + 50;
  let big = Array.from({length: bigLines}, () => bigLine).join("\n");

  // The window note at the end of `shown`, or a thrown error naming what was there instead.
  let windowNote = (shown: string) => {
    let match = /\n\n\[lines (\d+)-(\d+) of (\d+)(?:; next startLine: (\d+))?\]$/.exec(shown);
    if (match === null) throw new Error(`no window note: ${shown.slice(-100)}`);
    return {
      body: shown.slice(0, match.index),
      first: Number(match[1]),
      last: Number(match[2]),
      total: Number(match[3]),
      next: match[4] === undefined ? undefined : Number(match[4]),
    };
  };

  it("returns a small unwindowed file verbatim", () => {
    expect(readFileWindow(file, {})).toBe(file);
  });

  it("returns the requested lines with the range and where to continue", () => {
    expect(readFileWindow(file, {startLine: 3, lineCount: 2}))
        .toBe("line 3\nline 4\n\n[lines 3-4 of 10; next startLine: 5]");
    expect(readFileWindow(file, {startLine: 9}))
        .toBe("line 9\nline 10\n\n[lines 9-10 of 10]");
    expect(readFileWindow(file, {lineCount: 1}))
        .toBe("line 1\n\n[lines 1-1 of 10; next startLine: 2]");
  });

  it("rejects a start past the end", () => {
    expect(() => readFileWindow(file, {startLine: 11}))
        .toThrow("startLine 11 is past the end of the file, which has 10 lines.");
  });

  it("turns an unwindowed read of a large file into a window of whole lines under the cap", () => {
    let shown = readFileWindow(big, {});
    expect(shown.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS);
    let note = windowNote(shown);
    expect(note).toMatchObject({first: 1, total: bigLines, next: note.last + 1});
    expect(note.body).toBe(Array.from({length: note.last}, () => bigLine).join("\n"));
    // One more line would not have fit.
    expect(shown.length + bigLine.length + 1).toBeGreaterThan(MAX_TOOL_RESULT_CHARS);
  });

  it("treats lineCount as an upper bound, so an oversized request still says where to continue",
      () => {
    let shown = readFileWindow(big, {startLine: 5, lineCount: bigLines});
    expect(shown.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS);
    let note = windowNote(shown);
    expect(note).toMatchObject({first: 5, total: bigLines, next: note.last + 1});
    expect(note.last).toBeLessThan(bigLines);
    expect(note.body).toBe(Array.from({length: note.last - 4}, () => bigLine).join("\n"));
  });
});
