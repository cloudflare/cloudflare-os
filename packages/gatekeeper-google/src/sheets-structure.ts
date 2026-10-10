/**
 * A sheet's rows, or its columns, as queued changes leave them: an ordered list of runs, each
 * either lines of the sheet Google holds or lines a queued change inserted.
 *
 * Every line has an identity that moves with it, `b<index>` for the line at `index` of the sheet
 * Google holds and `n<id>.<offset>` for one a queued change inserted, so what is keyed by a line's
 * identity follows it as lines are inserted and deleted around it. Positions are zero-based.
 * Nothing here mutates a list it is given.
 */

/** A run of consecutive lines. */
export type LineRun =
  /** Lines `start` to `start + length - 1` of the sheet Google holds, by their index there. */
  | { kind: "base"; start: number; length: number }
  /** Lines `start` to `start + length - 1` of the lines insertion `id` added. */
  | { kind: "new"; id: number; start: number; length: number };

/** A sheet's rows or columns, in order. */
export type Lines = readonly LineRun[];

/** The lines of a sheet Google holds `count` of. */
export function baseLines(count: number): Lines {
  return count > 0 ? [{ kind: "base", start: 0, length: count }] : [];
}

/** How many lines there are. */
export function lineCount(lines: Lines): number {
  return lines.reduce((total, run) => total + run.length, 0);
}

function identityOf(run: LineRun, offset: number): string {
  return run.kind === "base" ? `b${run.start + offset}` : `n${run.id}.${run.start + offset}`;
}

/** The identity of the line at `position`, or undefined past the last line. */
export function lineAt(lines: Lines, position: number): string | undefined {
  let first = 0;
  for (let run of lines) {
    if (position >= first && position < first + run.length) return identityOf(run, position - first);
    first += run.length;
  }
  return undefined;
}

/** The identities of the lines at positions `start` to `end - 1`, undefined past the last line. */
export function linesAt(lines: Lines, start: number, end: number): (string | undefined)[] {
  return Array.from({ length: Math.max(0, end - start) }, (_, i) => lineAt(lines, start + i));
}

const IDENTITY = /^(?:b(\d+)|n(\d+)\.(\d+))$/;

/** The position of the line with `identity`, or undefined if there is none. */
export function positionOf(lines: Lines, identity: string): number | undefined {
  let match = identity.match(IDENTITY);
  if (!match) return undefined;
  let [, base, id, offset] = match;
  let index = Number(base ?? offset);
  let first = 0;
  for (let run of lines) {
    let holds = base !== undefined ? run.kind === "base" : run.kind === "new" && run.id === Number(id);
    if (holds && index >= run.start && index < run.start + run.length) return first + index - run.start;
    first += run.length;
  }
  return undefined;
}

/** The index in the sheet Google holds of the line with `identity`, if it is one of its lines. */
export function baseIndexOf(identity: string): number | undefined {
  let match = identity.match(/^b(\d+)$/);
  return match ? Number(match[1]) : undefined;
}

function piece(run: LineRun, start: number, end: number): LineRun {
  return { ...run, start: run.start + start, length: end - start };
}

// Whether `next` holds the lines right after `run`'s.
function continues(run: LineRun, next: LineRun): boolean {
  if (run.start + run.length !== next.start) return false;
  return run.kind === "base" ? next.kind === "base" : next.kind === "new" && next.id === run.id;
}

// Joins runs that continue each other, so a list reads the same however it was edited.
function joined(runs: readonly LineRun[]): Lines {
  let result: LineRun[] = [];
  for (let run of runs) {
    if (run.length === 0) continue;
    let last = result.at(-1);
    if (last && continues(last, run)) result[result.length - 1] = { ...last, length: last.length + run.length };
    else result.push(run);
  }
  return result;
}

// The runs before `position`, and those from it on.
function split(lines: Lines, position: number): [LineRun[], LineRun[]] {
  let before: LineRun[] = [];
  let after: LineRun[] = [];
  let first = 0;
  for (let run of lines) {
    let cut = position - first;
    if (cut >= run.length) before.push(run);
    else if (cut <= 0) after.push(run);
    else {
      before.push(piece(run, 0, cut));
      after.push(piece(run, cut, run.length));
    }
    first += run.length;
  }
  return [before, after];
}

/** `lines` with `count` lines of insertion `id` before the line at `at` (at the end for `at` past it). */
export function insertLines(lines: Lines, at: number, count: number, id: number): Lines {
  let [before, after] = split(lines, at);
  return joined([...before, { kind: "new", id, start: 0, length: count }, ...after]);
}

/** `lines` without the `count` lines from position `start`. */
export function deleteLines(lines: Lines, start: number, count: number): Lines {
  let [before] = split(lines, start);
  let [, after] = split(lines, start + count);
  return joined([...before, ...after]);
}

/**
 * The lines of the sheet Google holds among positions `start` to `end - 1`, as runs of their
 * indices there, in order: what a read of those positions fetches.
 */
export function basePieces(lines: Lines, start: number, end: number): { start: number; length: number }[] {
  let [, from] = split(lines, start);
  let [within] = split(from, end - start);
  return within.flatMap(run => run.kind === "base" ? [{ start: run.start, length: run.length }] : []);
}
