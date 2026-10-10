/**
 * Formula text, read as Google Sheets reads it: string literals, which are never looked into,
 * references, names and the rest.
 *
 * Nothing here evaluates a formula. It finds the functions a formula calls, so that those reaching
 * outside the spreadsheet are refused, writes references the way Google stores them once entered,
 * so the approver and a simulated read see the text Google keeps, and rewrites them as Google does
 * when rows, columns or sheets change, telling whether the cells a reference covers changed.
 */

import { columnLetters, columnNumber, quoteSheetTitle } from "./sheets-model";

/** One end of a reference as typed: a column, a row or a cell, each part optionally `$`-anchored. */
export type RefCorner = {
  /** The corner as typed, anchors included. */
  text: string;
  /** Its column letters, if it has a column. */
  column?: string;
  /** Its row digits, if it has a row. */
  row?: string;
};

/**
 * An A1 reference: a cell, a range of cells, whole columns or rows, or a range from a cell to the
 * end of a column or row, such as `A2:A` or `B3:3`.
 */
export type FormulaReference = {
  kind: "reference";
  /** The reference as typed. */
  text: string;
  /** The sheet it names, unquoted, if it names one. */
  sheet?: string;
  /** One corner for a cell, two for a range. */
  corners: [RefCorner] | [RefCorner, RefCorner];
};

/** A piece of formula text. Joining every token's `text` gives the formula back. */
export type FormulaToken =
  | FormulaReference
  | {
      /**
       * `string` is a `"…"` literal, `quoted` an apostrophe-quoted name that prefixes no reference,
       * `name` a function, named range or other identifier, `error` an error literal such as
       * `#REF!`, `space` a run of whitespace, and `other` one character of anything else.
       */
      kind: "string" | "quoted" | "name" | "error" | "number" | "space" | "other";
      text: string;
    };

/**
 * Functions a formula may not call, and why: each reads data from outside the spreadsheet, so a
 * write could carry it past the binding.
 */
export const REFUSED_FUNCTIONS: ReadonlyMap<string, string> = new Map([
  ["IMPORTRANGE", "it reads another spreadsheet"],
  ["IMPORTDATA", "it makes Google fetch a URL"],
  ["IMPORTHTML", "it makes Google fetch a URL"],
  ["IMPORTXML", "it makes Google fetch a URL"],
  ["IMPORTFEED", "it makes Google fetch a URL"],
  ["IMAGE", "it makes Google fetch a URL"],
]);

const REFUSED_ANYWHERE = new RegExp([...REFUSED_FUNCTIONS.keys()].join("|"));

const COLUMN = String.raw`\$?[A-Za-z]{1,3}`;
const ROW = String.raw`\$?[0-9]+`;
const CELL = COLUMN + ROW;

// A reference ends where no name, call or sheet prefix continues it.
const REFERENCE = new RegExp(
  `(?:${CELL}:${CELL}|${CELL}:${COLUMN}|${CELL}:${ROW}|${CELL}|${COLUMN}:${COLUMN}|${ROW}:${ROW})` +
  String.raw`(?![\p{L}\p{N}_.(!])`,
  "uy",
);
const CORNER = /^(\$?([A-Za-z]*))(\$?([0-9]*))$/;
const STRING = /"(?:[^"]|"")*"?/y;
const ERROR = /#(?:NULL!|DIV\/0!|VALUE!|REF!|NAME\?|NUM!|N\/A|ERROR!)/iy;
const QUOTED = /'(?:[^']|'')*('?)/y;
const BARE_PREFIX = /[\p{L}_][\p{L}\p{N}_.]*!/uy;
const NAME = /[\p{L}_][\p{L}\p{N}_.]*/uy;
const NUMBER = /(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/y;
const SPACE = /\s+/y;
const NAME_CHARACTER = /[\p{L}\p{N}_.]/u;

function execAt(pattern: RegExp, text: string, at: number): RegExpExecArray | null {
  pattern.lastIndex = at;
  return pattern.exec(text);
}

function matchAt(pattern: RegExp, text: string, at: number): string | undefined {
  return execAt(pattern, text, at)?.[0];
}

function corner(text: string): RefCorner {
  let [, , column, , row] = text.match(CORNER)!;
  return { text, ...(column ? { column } : {}), ...(row ? { row } : {}) };
}

function reference(formula: string, at: number, prefix = ""): FormulaReference | undefined {
  let body = matchAt(REFERENCE, formula, at + prefix.length);
  if (body === undefined) return undefined;
  let [start, end] = body.split(":");
  let sheet = prefix === "" ? undefined
    : prefix.startsWith("'") ? prefix.slice(1, -2).replaceAll("''", "'") : prefix.slice(0, -1);
  return {
    kind: "reference",
    text: prefix + body,
    ...(sheet === undefined ? {} : { sheet }),
    corners: end === undefined ? [corner(start)] : [corner(start), corner(end)],
  };
}

function nextToken(formula: string, at: number): FormulaToken {
  let character = formula[at];
  if (character === '"') return { kind: "string", text: matchAt(STRING, formula, at)! };
  let error = character === "#" ? matchAt(ERROR, formula, at) : undefined;
  if (error !== undefined) return { kind: "error", text: error };
  // A reference starts only where no name continues, so `2A1` holds no reference, and `X'S'!A1`
  // none that a sheet prefix could merge with the name into another sheet's.
  let boundary = at === 0 || !NAME_CHARACTER.test(formula[at - 1]);
  if (character === "'") {
    let [quoted, closing] = execAt(QUOTED, formula, at)!;
    // A title holds at least one character, so `''` is an empty name rather than a prefix.
    let prefixed = boundary && closing && quoted.length > 2 && formula[at + quoted.length] === "!"
      ? reference(formula, at, `${quoted}!`) : undefined;
    return prefixed ?? { kind: "quoted", text: quoted };
  }
  let space = matchAt(SPACE, formula, at);
  if (space !== undefined) return { kind: "space", text: space };
  if (boundary) {
    let prefix = matchAt(BARE_PREFIX, formula, at);
    let found = (prefix !== undefined ? reference(formula, at, prefix) : undefined) ??
      reference(formula, at);
    if (found) return found;
  }
  let name = matchAt(NAME, formula, at);
  if (name !== undefined) return { kind: "name", text: name };
  let number = matchAt(NUMBER, formula, at);
  if (number !== undefined) return { kind: "number", text: number };
  return { kind: "other", text: String.fromCodePoint(formula.codePointAt(at)!) };
}

/** Splits formula text into tokens, whose texts join back into it. */
export function tokenize(formula: string): FormulaToken[] {
  let tokens: FormulaToken[] = [];
  for (let at = 0; at < formula.length;) {
    let token = nextToken(formula, at);
    tokens.push(token);
    at += token.text.length;
  }
  return tokens;
}

/**
 * The first function in `REFUSED_FUNCTIONS` that `formula` names, upper case, ignoring case as
 * Google does, in a name or any of its dot-separated parts. Text in string literals and sheet
 * titles before `!` is not a name.
 */
export function refusedFunction(formula: string): string | undefined {
  for (let token of tokenize(formula)) {
    // A name is checked part by part, so a prefix such as `_xlfn.` cannot hide one. Quoted text
    // that prefixes no reference is searched whole, so a stray apostrophe cannot hide the rest of
    // the formula.
    let refused = token.kind === "name"
      ? token.text.toUpperCase().split(".").find(part => REFUSED_FUNCTIONS.has(part))
      : token.kind === "quoted" ? token.text.toUpperCase().match(REFUSED_ANYWHERE)?.[0] : undefined;
    if (refused !== undefined) return refused;
  }
  return undefined;
}

function canonicalCorners([start, end]: FormulaReference["corners"]): string {
  if (!end) return start.text.toUpperCase();
  // Whole rows and columns are kept as Google keeps them: as typed.
  if (start.column === undefined || start.row === undefined) return `${start.text}:${end.text}`;
  let first = start.text.toUpperCase();
  let second = end.text.toUpperCase();
  if (end.column === undefined || end.row === undefined) return `${first}:${second}`;
  if (first === second) return first;
  if (first.includes("$") || second.includes("$")) return `${first}:${second}`;
  let [left, right] = columnNumber(start.column) <= columnNumber(end.column)
    ? [start.column, end.column] : [end.column, start.column];
  let [top, bottom] = Number(start.row) <= Number(end.row) ? [start.row, end.row] : [end.row, start.row];
  return `${left}${top}:${right}${bottom}`.toUpperCase();
}

/**
 * `formula` with its references written as Google stores them: column letters upper case, a range
 * of one cell written as that cell, an unanchored range from its top-left to its bottom-right cell,
 * and a sheet named by its title, quoted as Google quotes it. `titleOf` gives the title of the
 * sheet a reference names, ignoring case, or undefined when there is none; such a reference is
 * left as typed, as are names, whitespace and string literals.
 */
export function canonicalFormula(
  formula: string, titleOf: (name: string) => string | undefined,
): string {
  return tokenize(formula).map(token => {
    if (token.kind !== "reference") return token.text;
    if (token.sheet === undefined) return canonicalCorners(token.corners);
    let title = titleOf(token.sheet);
    return title === undefined ? token.text : `${quoteSheetTitle(title)}!${canonicalCorners(token.corners)}`;
  }).join("");
}

/**
 * `formula` without whitespace outside string literals and sheet titles, which Google may add or
 * drop in a formula it keeps.
 */
export function compactFormula(formula: string): string {
  return tokenize(formula).filter(token => token.kind !== "space").map(token => token.text).join("");
}

/**
 * A change to a spreadsheet's structure, as formulas are rewritten through it. Sheets are named by
 * their titles when the change was made.
 */
export type RewriteStep =
  | {
      kind: "insert" | "delete";
      /** The sheet whose rows or columns change. */
      title: string;
      /** Whether rows or columns change. */
      axis: "rows" | "columns";
      /** The zero-based first line inserted, or deleted. Inserted lines go before this one. */
      start: number;
      /** How many lines are inserted or deleted. */
      count: number;
    }
  | { kind: "rename"; from: string; to: string }
  | { kind: "deleteSheet"; title: string }
  | {
      kind: "duplicate";
      /** The sheet copied. */
      title: string;
      /** The copy's title. */
      newTitle: string;
    };

/** A formula rewritten through one `RewriteStep`. */
export type RewrittenFormula = {
  /** The formula as Google writes it after the step. */
  text: string;
  /** Whether some reference covers cells other than before the step: more, fewer, or none. */
  cellsChanged: boolean;
  /** Whether some reference no longer refers to anything: `#REF!`, or a deleted sheet. */
  broken: boolean;
};

type LineStep = Extract<RewriteStep, { kind: "insert" | "delete" }>;

function sameTitle(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function lineOf(end: RefCorner, axis: LineStep["axis"]): number | undefined {
  if (axis === "rows") return end.row === undefined ? undefined : Number(end.row) - 1;
  return end.column === undefined ? undefined : columnNumber(end.column) - 1;
}

function movedCorner(end: RefCorner, axis: LineStep["axis"], line: number): string {
  let [, column, , row] = end.text.match(CORNER)!;
  return axis === "rows"
    ? column + (row.startsWith("$") ? "$" : "") + (line + 1)
    : (column.startsWith("$") ? "$" : "") + columnLetters(line) + row;
}

/**
 * `ref` as Google rewrites it when `step` inserts or deletes lines of the sheet it refers
 * to. Only the step's axis moves: a reference spanning all of that axis, such as `A:C` under a row
 * change, keeps its text but gains or loses cells.
 */
function moveReference(ref: FormulaReference, step: LineStep): RewrittenFormula {
  let lines = ref.corners.map(end => lineOf(end, step.axis));
  let bounded = lines.filter(line => line !== undefined);
  if (bounded.length === 0) return { text: ref.text, cellsChanged: true, broken: false };
  // An open end, such as `A2:A`, runs to the last line whatever the sheet's size.
  let first = Math.min(...bounded);
  let last = bounded.length < lines.length ? Infinity : Math.max(...bounded);
  let moved: [number, number];
  let cellsChanged: boolean;
  if (step.kind === "insert") {
    let move = (line: number) => line >= step.start ? line + step.count : line;
    moved = [move(first), move(last)];
    cellsChanged = first < step.start && step.start <= last;
  } else {
    let deletedLast = step.start + step.count - 1;
    if (first >= step.start && last <= deletedLast) {
      return { text: "#REF!", cellsChanged: true, broken: true };
    }
    moved = [
      first < step.start ? first : first <= deletedLast ? step.start : first - step.count,
      last < step.start ? last : last <= deletedLast ? step.start - 1 : last - step.count,
    ];
    cellsChanged = first <= deletedLast && last >= step.start;
  }
  if (moved[0] === first && moved[1] === last) return { text: ref.text, cellsChanged, broken: false };

  let corners = ref.corners.map((end, i) => {
    let line = lines[i];
    if (line === undefined) return end.text;
    let to = line === first ? moved[0] : moved[1];
    return to === line ? end.text : movedCorner(end, step.axis, to);
  });
  let body = ref.corners.map(end => end.text).join(":");
  let prefix = ref.text.slice(0, ref.text.length - body.length);
  // Two cell corners that meet name one cell, which Google writes alone; whole rows and columns
  // and open ranges keep both ends.
  let collapses = ref.corners.length === 2 &&
    ref.corners.every(end => end.column !== undefined && end.row !== undefined) &&
    corners[0].toUpperCase() === corners[1].toUpperCase();
  return { text: prefix + (collapses ? corners[0] : corners.join(":")), cellsChanged, broken: false };
}

function rewriteReference(
  ref: FormulaReference, step: RewriteStep, onTarget: boolean,
): RewrittenFormula {
  let unchanged = { text: ref.text, cellsChanged: false, broken: false };
  let body = ref.corners.map(end => end.text).join(":");
  let names = (title: string) => ref.sheet !== undefined && sameTitle(ref.sheet, title);
  let follows = (title: string) => ref.sheet === undefined ? onTarget : names(title);
  switch (step.kind) {
    case "insert":
    case "delete":
      return follows(step.title) ? moveReference(ref, step) : unchanged;
    case "rename":
      return names(step.from) ? { ...unchanged, text: `${quoteSheetTitle(step.to)}!${body}` } : unchanged;
    case "deleteSheet":
      return follows(step.title) ? { ...unchanged, cellsChanged: true, broken: true } : unchanged;
    case "duplicate":
      return onTarget && names(step.title)
        ? { ...unchanged, text: `${quoteSheetTitle(step.newTitle)}!${body}` } : unchanged;
  }
}

/**
 * `formula` as Google rewrites it through `step`, with whether the cells its references cover
 * changed. `onTarget` says the formula is on the sheet the step changes: for an insert or delete,
 * the sheet whose lines change, which its unqualified references then follow; for `deleteSheet`,
 * the deleted sheet; for `duplicate`, the copy, whose references naming the sheet copied name the
 * copy instead (a duplicate changes no formula anywhere else). A reference names a sheet by its
 * title, ignoring case.
 *
 * Inserting lines moves the bounds at or after them, and grows a range they land inside. Deleting
 * lines turns a reference wholly inside them, sheet prefix included, into `#REF!`, moves a bound
 * inside them to their edge and a bound after them back, and writes a range of cells that becomes
 * one cell as that cell. A rename re-quotes each reference to the sheet with its new title. A
 * deleted sheet leaves the text as it is, though its references no longer refer to anything.
 * String literals are never touched.
 */
export function rewriteFormula(formula: string, step: RewriteStep, onTarget: boolean): RewrittenFormula {
  let cellsChanged = false;
  let broken = false;
  let text = tokenize(formula).map(token => {
    if (token.kind !== "reference") return token.text;
    let rewritten = rewriteReference(token, step, onTarget);
    cellsChanged ||= rewritten.cellsChanged;
    broken ||= rewritten.broken;
    return rewritten.text;
  }).join("");
  return { text, cellsChanged, broken };
}

/**
 * Functions whose result depends on where cells are, or on references they build or take apart,
 * so that a structural change can alter it though every reference keeps its cells.
 */
export const STRUCTURE_SENSITIVE_FUNCTIONS: ReadonlySet<string> = new Set([
  "ROW", "COLUMN", "ROWS", "COLUMNS", "OFFSET", "INDIRECT", "ADDRESS", "CELL", "SHEET", "SHEETS",
  "FORMULATEXT", "LAMBDA", "LET",
  // Its query names the data's columns by letter in a string, which Google never rewrites.
  "QUERY",
]);

const CONSTANTS: ReadonlySet<string> = new Set(["TRUE", "FALSE"]);

/**
 * Whether a structural change could alter what `formula` computes in ways its references do not
 * show: it calls one of `STRUCTURE_SENSITIVE_FUNCTIONS` (in any case, in a name or any of its
 * dot-separated parts), or uses a name that is neither a function call nor `TRUE` or `FALSE`, such
 * as a named range or a `LET` or `LAMBDA` name, whose cells its text does not show. So does a `:`
 * outside a reference, as in `A1 : A3` or `B1:INDEX(...)`: the range it makes can grow or shrink
 * while each of its ends only moves.
 */
export function structureSensitive(formula: string): boolean {
  let tokens = tokenize(formula);
  return tokens.some((token, i) => {
    if (token.kind === "other" && token.text === ":") return true;
    if (token.kind !== "name") return false;
    let name = token.text.toUpperCase();
    if (name.split(".").some(part => STRUCTURE_SENSITIVE_FUNCTIONS.has(part))) return true;
    // A run of whitespace is one token, so the token after it is the next of substance.
    let next = tokens[i + 1]?.kind === "space" ? tokens[i + 2] : tokens[i + 1];
    return next?.text !== "(" && !CONSTANTS.has(name);
  });
}
