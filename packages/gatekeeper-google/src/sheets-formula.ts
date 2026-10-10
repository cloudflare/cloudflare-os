/**
 * Formula text, read as Google Sheets reads it: string literals, which are never looked into,
 * references, names and the rest.
 *
 * Nothing here evaluates a formula. It finds the functions a formula calls, so that those reaching
 * outside the spreadsheet are refused, and writes references the way Google stores them once
 * entered, so the approver and a simulated read see the text Google keeps.
 */

import { columnNumber, quoteSheetTitle } from "./sheets-model";

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
       * `name` a function, named range or other identifier, `space` a run of whitespace, and
       * `other` one character of anything else.
       */
      kind: "string" | "quoted" | "name" | "number" | "space" | "other";
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
