import {describe, expect, it} from "vite-plus/test";
import {
  removeComposerToken, snapCaretOutOfRanges, spliceComposerToken,
} from "./composer-tokens";

describe("composer tokens", () => {
  it("inserts a token with separators and places the caret outside it", () => {
    expect(spliceComposerToken("", 0, 0, "Token")).toEqual({
      value: "Token ",
      start: 0,
      length: 5,
      caret: 6,
      delta: 6,
    });
    expect(spliceComposerToken("hello world", 5, 5, "Token")).toEqual({
      value: "hello Token world",
      start: 6,
      length: 5,
      caret: 12,
      delta: 6,
    });
    expect(spliceComposerToken("see url now", 4, 7, "Document")).toEqual({
      value: "see Document now",
      start: 4,
      length: 8,
      caret: 13,
      delta: 5,
    });
  });

  it("removes a whole token without leaving a redundant space", () => {
    expect(removeComposerToken("Token next", {start: 0, length: 5})).toEqual({
      value: "next",
      caret: 0,
      delta: -6,
    });
    expect(removeComposerToken("hello Token world", {start: 6, length: 5})).toEqual({
      value: "hello world",
      caret: 6,
      delta: -6,
    });
  });

  it("preserves a newline after a removed token", () => {
    expect(removeComposerToken("Token\nnext", {start: 0, length: 5})).toEqual({
      value: "\nnext",
      caret: 0,
      delta: -5,
    });
  });

  it("snaps interior caret positions to the requested edge", () => {
    const ranges = [{start: 4, length: 6}];
    expect(snapCaretOutOfRanges(7, ranges, "left")).toBe(4);
    expect(snapCaretOutOfRanges(7, ranges, "right")).toBe(10);
    expect(snapCaretOutOfRanges(6, ranges, "nearest")).toBe(4);
    expect(snapCaretOutOfRanges(4, ranges, "right")).toBe(4);
    expect(snapCaretOutOfRanges(10, ranges, "left")).toBe(10);
  });
});
