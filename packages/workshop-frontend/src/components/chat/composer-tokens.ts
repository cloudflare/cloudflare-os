// Composer tokens are ranges of the chat input that stand for something the user picked rather
// than typed: a resource capsule or a resolved slash command. They are ordinary text in the
// textarea (the mirror only colors them), but the caret treats each as a single unit.

export type ComposerRange = {
  start: number;
  length: number;
};

type TokenSplice = {
  value: string;
  start: number;
  length: number;
  caret: number;
  delta: number;
};

/**
 * Replaces `[start, end)` with `token`, adding single spaces so it never abuts a neighboring word.
 * The separators stay outside the returned range, so the highlight hugs the token's own text.
 */
export function spliceComposerToken(
    value: string, start: number, end: number, token: string): TokenSplice {
  let before = value.slice(0, start);
  let after = value.slice(end);
  let lead = before && !/\s$/.test(before) ? " " : "";
  let trail = /^\s/.test(after) ? "" : " ";
  let replacement = lead + token + trail;
  // Leave the caret past the trailing space, so the next keystroke starts a new word outside the
  // token.
  let caret = start + replacement.length + (!trail && /^[^\S\n]/.test(after) ? 1 : 0);
  return {
    value: before + replacement + after,
    start: start + lead.length,
    length: token.length,
    caret,
    delta: replacement.length - (end - start),
  };
}

type TokenRemoval = {
  value: string;
  caret: number;
  delta: number;
};

/** Removes a token whole, closing the gap so deletion can't strand a doubled or leading space. */
export function removeComposerToken(value: string, range: ComposerRange): TokenRemoval {
  let before = value.slice(0, range.start);
  let after = value.slice(range.start + range.length);
  if ((!before || /\s$/.test(before)) && /^[^\S\n]/.test(after)) after = after.slice(1);
  return {
    value: before + after,
    caret: before.length,
    delta: before.length + after.length - value.length,
  };
}

type CaretBias = "left" | "right" | "nearest";

/**
 * Moves a caret that landed inside a token out to one of its edges. Arrow keys pass their
 * direction of travel; clicks and other jumps pass `nearest`. Positions outside a token, or on
 * its edges, are returned unchanged.
 */
export function snapCaretOutOfRanges(
    position: number, ranges: readonly ComposerRange[], bias: CaretBias): number {
  for (let range of ranges) {
    let end = range.start + range.length;
    if (position <= range.start || position >= end) continue;
    if (bias === "left") return range.start;
    if (bias === "right") return end;
    return position - range.start <= end - position ? range.start : end;
  }
  return position;
}
