import {describe, expect, it} from "vitest";
import {boundToolResultText, MAX_TOOL_RESULT_CHARS, readFileWindow} from "../src/agent";
import {matchLines} from "../src/grep";

describe("grep line matching", () => {
  it("anchors on the line, not its CRLF ending", () => {
    expect(matchLines("alpha\r\nneedle\r\nneedle too\r\n", /needle$/))
        .toEqual([{line: 2, text: "needle"}]);
  });
});

describe("tool result bound", () => {
  // The elision note, or a thrown error naming what was there instead.
  let elision = (bounded: string) => {
    let match = /^([^]*?)\n\n\[\.\.\. (\d+) of (\d+) characters elided \.\.\.\]\n\n([^]*)$/.exec(bounded);
    if (match === null) throw new Error(`unexpected shape: ${bounded.slice(-120)}`);
    return {head: match[1], elided: Number(match[2]), total: Number(match[3]), tail: match[4]};
  };

  it("passes a result at the cap through untouched and elides the middle past it", () => {
    let atCap = "x".repeat(MAX_TOOL_RESULT_CHARS);
    expect(boundToolResultText(atCap)).toBe(atCap);

    let over = `HEAD${"x".repeat(MAX_TOOL_RESULT_CHARS)}TAIL`;
    let bounded = boundToolResultText(over);
    expect(bounded.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS);
    let {head, elided, total, tail} = elision(bounded);
    expect(head.startsWith("HEAD")).toBe(true);
    expect(tail.endsWith("TAIL")).toBe(true);
    expect(head.length + elided + tail.length).toBe(over.length);
    expect(total).toBe(over.length);
  });

  it("bounds a bounded result to itself, so recorded outputs may be stored bounded", () => {
    let bounded = boundToolResultText("y".repeat(3 * MAX_TOOL_RESULT_CHARS));
    expect(boundToolResultText(bounded)).toBe(bounded);
  });

  it("never leaves half of a surrogate pair at either edge of the elision", () => {
    let {head, tail} = elision(boundToolResultText("a".repeat(3 * MAX_TOOL_RESULT_CHARS)));
    // Sweep an emoji across each edge; whichever position straddles a cut must give way whole.
    for (let shift = -2; shift <= 2; shift++) {
      let text = "a".repeat(head.length + shift) + "😀" + "b".repeat(MAX_TOOL_RESULT_CHARS) +
          "😀" + "c".repeat(tail.length + shift);
      let bounded = boundToolResultText(text);
      expect(bounded.isWellFormed()).toBe(true);
      expect(bounded.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS);
    }
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
    expect(boundToolResultText(shown)).toBe(shown);
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
