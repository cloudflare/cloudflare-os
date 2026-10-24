// ─────────────────────────────────────────────────────────────────────────────
// Sheets formula engine: the tokenizer, the Pratt parser and its serializer, the text-level
// reference scanner, number formatting, the evaluator (`makeEngine`) and the function library.
// One module, imported by client.ts (the grid) and server.ts (exports: cached formula results
// in Excel files, CSV values, filters and charts), so an export computes what the grid shows
// (except NOW() and TODAY(), which use the browser's clock in the grid and UTC in exports). It touches neither the DOM nor the Workers runtime, and is type-checked under both.
// It ships inlined into both bundles; this is section 3 of the client's index.
// ─────────────────────────────────────────────────────────────────────────────

/* ═══════════════════════════ 3. Formula engine ═══════════════════════════ */

// A1 <-> (row, col) — both zero-based internally.
export function colToLetter(c: number): string {
  let s = "";
  c += 1;
  while (c > 0) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); }
  return s;
}
export function letterToCol(s: string): number {
  let c = 0;
  for (const ch of s.toUpperCase()) c = c * 26 + (ch.charCodeAt(0) - 64);
  return c - 1;
}
export function rcToRef(r: number, c: number): string { return colToLetter(c) + (r + 1); }
export function parseRef(ref: string): { r: number; c: number } | null {
  const m = /^\$?([A-Za-z]+)\$?(\d+)$/.exec(ref);
  if (!m) return null;
  return { r: parseInt(m[2], 10) - 1, c: letterToCol(m[1]) };
}

/** A formula error as a cell shows it (`#VALUE!`, `#REF!`, ...); thrown and returned by the evaluator. */
export class CellError {
  declare value: string;
  constructor(v: string) { this.value = v; }
  toString() { return this.value; }
}
/** What `HYPERLINK(url, label)` returns: a value that shows its label and links to its URL. */
export class HyperlinkValue {
  declare url: string;
  declare label: string;
  constructor(url: string, label?: string) { this.url = url; this.label = label || url; }
  toString() { return this.label; }
}
export function safeHyperlinkUrl(value: unknown): string | null {
  try {
    const url = new URL(String(value));
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch (error) { return null; }
}
export const ERR = {
  DIV0: () => new CellError("#DIV/0!"),
  VALUE: () => new CellError("#VALUE!"),
  REF: () => new CellError("#REF!"),
  NAME: () => new CellError("#NAME?"),
  NA: () => new CellError("#N/A"),
  NUM: () => new CellError("#NUM!"),
  CYCLE: () => new CellError("#CYCLE!"),
};
export const isErr = (v: unknown): v is CellError => v instanceof CellError;

/** One computed cell value: blank (`null`), a number, text, a boolean, an error or a link. */
export type Scalar = number | string | boolean | null | CellError | HyperlinkValue;
/** A range as the evaluator passes it around: read lazily, cell by cell, through `get`. */
export interface Matrix {
  matrix: true;
  sheetId?: string;
  r1?: number;
  c1?: number;
  r2?: number;
  c2?: number;
  rows: number;
  cols: number;
  get(i: number, j: number): Scalar;
}
/** What evaluating an expression gives: a scalar, or a range. */
export type Value = Scalar | Matrix;
export const isMatrix = (v: unknown): v is Matrix => typeof v === "object" && v !== null && (v as Partial<Matrix>).matrix === true;

// --- Tokenizer ---
export type Token =
  | { t: "str" | "op" | "word"; v: string }
  | { t: "num"; v: number }
  | { t: "err"; v: string }
  | { t: "lp" | "rp" | "comma" | "colon" | "lb" | "rb" | "semi"; v?: undefined };
// Excel's error values, as a formula may spell them (`=IF(A1,#N/A,1)`, `{1,#N/A}`).
const ERROR_LITERAL = /^#(?:NULL!|DIV\/0!|VALUE!|REF!|NAME\?|NUM!|N\/A)/i;

export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") { i++; continue; }
    // Single quotes denote text unless the closing quote is followed by a sheet separator.
    // Inside a quoted sheet name, `''` and `\'` both stand for a literal apostrophe.
    const singleQuotedSheet = ch === "'" && (() => {
      for (let j = i + 1; j < n; j++) {
        if (src[j] === "\\" && src[j + 1] === "'") { j++; continue; }
        if (src[j] === "'") {
          if (src[j + 1] === "'") { j++; continue; }
          return src[j + 1] === "!";
        }
      }
      return false;
    })();
    if (ch === '"' || (ch === "'" && !singleQuotedSheet)) {
      const quote = ch;
      let j = i + 1, str = "";
      while (j < n) {
        if (src[j] === quote) { if (src[j + 1] === quote) { str += quote; j += 2; continue; } j++; break; }
        if (src[j] === "\\" && src[j + 1] === quote) { str += quote; j += 2; continue; }
        str += src[j++];
      }
      tokens.push({ t: "str", v: str }); i = j; continue;
    }
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(src[i + 1] || ""))) {
      let j = i;
      while (j < n && /[0-9.]/.test(src[j])) j++;
      if (src[j] === "e" || src[j] === "E") { j++; if (src[j] === "+" || src[j] === "-") j++; while (j < n && /[0-9]/.test(src[j])) j++; }
      tokens.push({ t: "num", v: parseFloat(src.slice(i, j)) }); i = j; continue;
    }
    const two = src.slice(i, i + 2);
    if (two === "<=" || two === ">=" || two === "<>") { tokens.push({ t: "op", v: two }); i += 2; continue; }
    if ("+-*/^&=<>%".includes(ch)) { tokens.push({ t: "op", v: ch }); i++; continue; }
    if (ch === "(") { tokens.push({ t: "lp" }); i++; continue; }
    if (ch === ")") { tokens.push({ t: "rp" }); i++; continue; }
    if (ch === ",") { tokens.push({ t: "comma" }); i++; continue; }
    if (ch === ":") { tokens.push({ t: "colon" }); i++; continue; }
    // Array constants: `{1,2;3,4}` is two rows of two columns.
    if (ch === "{") { tokens.push({ t: "lb" }); i++; continue; }
    if (ch === "}") { tokens.push({ t: "rb" }); i++; continue; }
    if (ch === ";") { tokens.push({ t: "semi" }); i++; continue; }
    if (ch === "#") {
      const error = ERROR_LITERAL.exec(src.slice(i));
      if (error) { tokens.push({ t: "err", v: error[0].toUpperCase() }); i += error[0].length; continue; }
    }
    // word: letters/digits/$/./! and quoted sheet names 'My Sheet'!
    if (/[A-Za-z_$]/.test(ch) || ch === "'") {
      let j = i, word = "";
      if (ch === "'") { // 'Sheet Name'!Ref
        j++;
        // The escape is kept in its doubled form so the reference round-trips unchanged.
        while (j < n) {
          if ((src[j] === "\\" || src[j] === "'") && src[j + 1] === "'") { word += "''"; j += 2; continue; }
          if (src[j] === "'") break;
          word += src[j++];
        }
        j++; word = "'" + word + "'";
      } else {
        while (j < n && /[A-Za-z0-9_$.]/.test(src[j])) word += src[j++];
      }
      if (src[j] === "!") { word += "!"; j++; while (j < n && /[A-Za-z0-9_$]/.test(src[j])) word += src[j++]; }
      tokens.push({ t: "word", v: word }); i = j; continue;
    }
    // `@` and structured references aren't supported. Skipping them would compute something
    // other than what Excel computes from the same text, so they become operator tokens no rule
    // of the parser accepts (the formula is invalid), while callers that only scan tokens
    // (reference highlighting) still can.
    if ("@[]".includes(ch)) { tokens.push({ t: "op", v: ch }); i++; continue; }
    i++; // skip unknown
  }
  return tokens;
}

// --- Parser (produces AST) ---
/** A parsed formula. `paren` keeps the grouping as typed, so a formula written back keeps it. */
export type Ast =
  | { k: "num"; v: number }
  | { k: "str"; v: string }
  | { k: "bool"; v: boolean }
  | { k: "err"; v: string }
  | { k: "array"; rows: ArrayItem[][] }
  | { k: "missing" }
  | { k: "ref"; ref: string }
  | { k: "range"; a: string; b: string }
  | { k: "paren"; a: Ast }
  | { k: "un"; op: string; a: Ast }
  | { k: "pct"; a: Ast }
  | { k: "bin"; op: string; a: Ast; b: Ast }
  | { k: "call"; name: string; args: Ast[] };

/** One item of an array constant: a number, text, a boolean or an error value. */
export type ArrayItem = number | string | boolean | CellError;

export function parseFormula(src: string): Ast {
  const tokens = tokenize(src);
  let pos = 0;
  const peek = (): Token | undefined => tokens[pos];
  const next = (): Token | undefined => tokens[pos++];
  // The operator the next token is, if it is one.
  const peekOp = () => { const tk = peek(); return tk && tk.t === "op" ? tk.v : null; };

  function parseExpr(minbp = 0): Ast {
    let left = parseUnary();
    while (true) {
      const tk = peek();
      if (!tk || tk.t !== "op") break;
      const bp = BP[tk.v];
      if (bp == null || bp.lbp <= minbp) break;
      next();
      const right = parseExpr(bp.lbp - (bp.right ? 1 : 0));
      left = { k: "bin", op: tk.v, a: left, b: right };
    }
    return left;
  }
  function parseUnary(): Ast {
    const tk = peek();
    if (tk && tk.t === "op" && (tk.v === "-" || tk.v === "+")) { next(); return { k: "un", op: tk.v, a: parseUnary() }; }
    let node = parsePrimary();
    // postfix percent
    while (peekOp() === "%") { next(); node = { k: "pct", a: node }; }
    return node;
  }
  function parsePrimary(): Ast {
    const tk = next();
    if (!tk) throw ERR.VALUE();
    if (tk.t === "num") return { k: "num", v: tk.v };
    if (tk.t === "str") return { k: "str", v: tk.v };
    if (tk.t === "err") {
      // A range whose end was deleted (`#REF!:B2`, from shiftFormulaReferences) is #REF! as a whole.
      if (peek()?.t === "colon") { next(); const end = next(); if (!end || (end.t !== "word" && end.t !== "err")) throw ERR.VALUE(); return { k: "err", v: "#REF!" }; }
      return { k: "err", v: tk.v };
    }
    if (tk.t === "lb") return parseArray();
    // Kept as a node so a formula written back (see serializeAst) keeps its grouping.
    if (tk.t === "lp") { const e = parseExpr(0); if (peek()?.t === "rp") next(); return { k: "paren", a: e }; }
    if (tk.t === "word") {
      if (peek()?.t === "lp") {
        next();
        // An argument left empty (`IF(A1,,2)`, `IF(1,)`) is `missing`: Excel reads it as 0, "" or
        // FALSE, as the function's parameter needs (see the function library).
        const args: Ast[] = [];
        const argument = (): Ast => peek()?.t === "comma" || peek()?.t === "rp" ? { k: "missing" } : parseExpr(0);
        if (!(peek()?.t === "rp")) {
          args.push(argument());
          while (peek()?.t === "comma") { next(); args.push(argument()); }
        }
        if (peek()?.t === "rp") next();
        return { k: "call", name: tk.v.toUpperCase(), args };
      }
      const up = tk.v.toUpperCase();
      if (up === "TRUE") return { k: "bool", v: true };
      if (up === "FALSE") return { k: "bool", v: false };
      // reference — possibly a range with colon
      let ref: Ast = { k: "ref", ref: tk.v };
      if (peek()?.t === "colon") {
        next();
        // A range's end must be a reference too: `A1:5` is #VALUE! as soon as it is parsed.
        const end = next();
        if (!end || end.t !== "word") throw ERR.VALUE();
        ref = { k: "range", a: tk.v, b: end.v };
      }
      return ref;
    }
    throw ERR.VALUE();
  }
  // An array constant, after its `{`: rows split by `;`, columns by `,`, all rows the same length.
  // Items are constants only (an optionally signed number, text, TRUE/FALSE or an error), as in
  // Excel, which refuses anything else.
  function parseArray(): Ast {
    const rows: ArrayItem[][] = [[]];
    for (;;) {
      let tk = next(), sign = 1, signed = false;
      while (tk && tk.t === "op" && (tk.v === "-" || tk.v === "+")) { if (tk.v === "-") sign = -sign; signed = true; tk = next(); }
      if (!tk) throw ERR.VALUE();
      let item: ArrayItem;
      if (tk.t === "num") item = sign * tk.v;
      else if (signed) throw ERR.VALUE();
      else if (tk.t === "str") item = tk.v;
      else if (tk.t === "err") item = new CellError(tk.v);
      else if (tk.t === "word" && /^(TRUE|FALSE)$/i.test(tk.v)) item = tk.v.toUpperCase() === "TRUE";
      else throw ERR.VALUE();
      rows[rows.length - 1].push(item);
      const sep = next();
      if (sep?.t === "comma") continue;
      if (sep?.t === "semi") { rows.push([]); continue; }
      if (sep?.t === "rb") break;
      throw ERR.VALUE();
    }
    if (rows.some((row) => row.length !== rows[0].length)) throw ERR.VALUE();
    return { k: "array", rows };
  }
  const ast = parseExpr(0);
  if (pos !== tokens.length) throw ERR.VALUE();
  return ast;
}
const BP: Record<string, { lbp: number; right?: boolean }> = {
  "=": { lbp: 1 }, "<>": { lbp: 1 }, "<": { lbp: 1 }, ">": { lbp: 1 }, "<=": { lbp: 1 }, ">=": { lbp: 1 },
  "&": { lbp: 2 },
  "+": { lbp: 3 }, "-": { lbp: 3 },
  "*": { lbp: 4 }, "/": { lbp: 4 },
  "^": { lbp: 5 }, // left-associative, as in Excel: 2^3^2 = 64
};

// --- Serializer (AST -> string), used for ref adjustment on insert/delete ---
export function serializeAst(node: Ast): string {
  switch (node.k) {
    case "num": return String(node.v);
    case "str": return '"' + node.v.replace(/"/g, '""') + '"';
    case "bool": return node.v ? "TRUE" : "FALSE";
    case "err": return node.v;
    case "array": return "{" + node.rows.map((row) => row.map((item) =>
      isErr(item) ? item.value : typeof item === "boolean" ? (item ? "TRUE" : "FALSE") : typeof item === "string" ? '"' + item.replace(/"/g, '""') + '"' : String(item)).join(",")).join(";") + "}";
    case "missing": return "";
    case "ref": return node.ref;
    case "range": return node.a + ":" + node.b;
    case "paren": return "(" + serializeAst(node.a) + ")";
    case "un": return node.op + serializeAst(node.a);
    case "pct": return serializeAst(node.a) + "%";
    case "bin": return serializeAst(node.a) + node.op + serializeAst(node.b);
    case "call": return node.name + "(" + node.args.map(serializeAst).join(",") + ")";
  }
  return "";
}
// `node` without grouping parentheses: ROW((A5)) still finds a reference.
export function unwrapParens(node: Ast): Ast { return node && node.k === "paren" ? unwrapParens(node.a) : node; }
// Whether an argument is a reference, whose text and booleans aggregates skip or count as in a
// range. A reference-form INDEX picking one cell gives that cell's value, but is still a reference.
function isReference(node: Ast): boolean {
  const n = unwrapParens(node);
  return n.k === "ref" || (n.k === "call" && n.name === "INDEX");
}

// --- Text-level reference scanning (copy, fill, cut and the formula editor) ---
// A function name, identifier suffix, sheet prefix or quoted string never becomes a reference.
// References share the grid's bounds: 702 columns (two letters) and 50,000 rows.
const SHEET_PREFIX_SOURCE = "(?:(?:'(?:\\\\'|''|[^'])+'|[A-Za-z_][A-Za-z0-9_.]*)!)?";
const CELL_SOURCE = "(?<![A-Za-z0-9_.$])\\$?[A-Z]{1,2}\\$?[1-9]\\d*(?![A-Za-z0-9_!]|\\s*\\()";
const ENDPOINT_SOURCE = SHEET_PREFIX_SOURCE + CELL_SOURCE;
const ENDPOINT_PATTERN = new RegExp(ENDPOINT_SOURCE, "gi");
const REFERENCE_PATTERN = new RegExp(`${ENDPOINT_SOURCE}(?:\\s*:\\s*${ENDPOINT_SOURCE})?`, "gi");
/** A reference found in a formula's text: where it starts and ends, and what it says. */
export interface FormulaReference {
  start: number;
  end: number;
  text: string;
}
// Yields each reference (or, with `endpoints`, each single endpoint) outside quoted text.
export function* formulaReferences(value: string, endpoints = false): Generator<FormulaReference> {
  const pattern = endpoints ? ENDPOINT_PATTERN : REFERENCE_PATTERN;
  let cursor = 1, quote: string | null = null;
  for (const match of value.matchAll(pattern)) {
    while (cursor < match.index) {
      const char = value[cursor++];
      if (quote) {
        if (char === "\\" && value[cursor] === quote) { cursor++; continue; }
        if (char === quote) { if (value[cursor] === quote) cursor++; else quote = null; }
      } else if (char === '"' || char === "'") quote = char;
    }
    if (quote) continue;
    let inBounds = true;
    for (const endpoint of match[0].matchAll(ENDPOINT_PATTERN)) {
      const row = /\$?([1-9]\d*)$/.exec(endpoint[0]);
      if (!row || Number(row[1]) > 50000) { inBounds = false; break; }
    }
    if (inBounds) yield { start: match.index, end: match.index + match[0].length, text: match[0] };
  }
}
// Moves relative parts of every reference; `$` parts and sheet prefixes stay as written.
export function shiftFormulaReferences(value: string, rowDelta: number, columnDelta: number): string {
  let result = "", start = 0;
  for (const reference of formulaReferences(value, true)) {
    const bang = reference.text.lastIndexOf("!"), prefix = reference.text.slice(0, bang + 1);
    const match = /^(\$?)([A-Z]{1,2})(\$?)([1-9]\d*)$/i.exec(reference.text.slice(bang + 1));
    if (!match) continue;
    let column = 0;
    for (const letter of match[2].toUpperCase()) column = column * 26 + letter.charCodeAt(0) - 64;
    column = column - 1 + (match[1] ? 0 : columnDelta);
    const row = Number(match[4]) - 1 + (match[3] ? 0 : rowDelta);
    let replacement = "#REF!";
    if (row >= 0 && column >= 0) {
      let letters = "";
      for (let index = column + 1; index > 0; index = Math.floor((index - 1) / 26)) letters = String.fromCharCode(65 + (index - 1) % 26) + letters;
      replacement = prefix + match[1] + letters + match[3] + (row + 1);
    }
    result += value.slice(start, reference.start) + replacement;
    start = reference.end;
  }
  return result + value.slice(start);
}

// ===========================================================================
// Number coercion + formatting
// ===========================================================================
// Serial dates count days as Excel's 1900 date system does: 1 is 1900-01-01, 61 is 1900-03-01.
// Excel keeps Lotus 1-2-3's 29 February 1900, a day that never was (serial 60), so serials 1-59
// fall a day later than a plain count from 1899-12-30 would put them. The engine emulates it, so
// a date before March 1900 shows, and exports, as the same day Excel shows. Serial 60 shows as
// 1900-02-29 and 0 as Excel's 1900-01-00; as a Date (for month arithmetic) 60 is 28 February.
const DATE_EPOCH = Date.UTC(1899, 11, 30);
const DAY_MS = 86400000;
function serialToDate(s: number): Date { return new Date(DATE_EPOCH + Math.round((s < 60 ? s + 1 : s) * DAY_MS)); }
function dateToSerial(d: Date): number { const n = (d.getTime() - DATE_EPOCH) / DAY_MS; return n < 61 ? n - 1 : n; }
// Excel's DATE: years 0-1899 are 1900 onwards, the month and day may overflow, and January and
// February 1900 count the 29th that Excel's calendar has (DATE(1900,2,29) is 60, DATE(1900,3,0) too).
function excelDate(y: number, m: number, d: number): number | CellError {
  y = Math.trunc(y); m = Math.trunc(m); d = Math.trunc(d);
  if (y >= 0 && y < 1900) y += 1900;
  y += Math.floor((m - 1) / 12); m = ((m - 1) % 12 + 12) % 12;
  if (y < 1900 || y > 9999) return ERR.NUM();
  let serial;
  if (y === 1900 && m <= 1) serial = (m ? 31 : 0) + d;
  else if (y === 1900) serial = 60 + (Date.UTC(1900, m, d) - Date.UTC(1900, 1, 28)) / DAY_MS;
  else serial = dateToSerial(new Date(Date.UTC(y, m, d)));
  return serial < 0 ? ERR.NUM() : serial;
}
/** A serial's calendar date and time of day, rounded to the second as Excel shows it; `weekday` 0 is Sunday. */
interface DateParts { y: number; mo: number; d: number; h: number; mi: number; s: number; weekday: number }
function dateParts(serial: number): DateParts {
  // Excel rounds to the second before splitting: 12:29:59.999 shows as 12:30:00, and a moment
  // before midnight as the next day.
  const seconds = Math.round(serial * 86400), day = Math.floor(seconds / 86400), time = seconds - day * 86400;
  let y = 1900, mo = 1, d = 0;
  if (day === 60) { mo = 2; d = 29; }
  else if (day !== 0) { const date = serialToDate(day); y = date.getUTCFullYear(); mo = date.getUTCMonth() + 1; d = date.getUTCDate(); }
  return { y, mo, d, h: Math.floor(time / 3600), mi: Math.floor(time % 3600 / 60), s: time % 60, weekday: ((day - 1) % 7 + 7) % 7 };
}

function toNum(v: Value): number {
  if (isErr(v)) throw v;
  if (v == null || v === "") return 0;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  const s = String(v).trim();
  if (s === "") return 0;
  const n = Number(s.replace(/,/g, "").replace(/%$/, ""));
  if (!Number.isFinite(n)) throw ERR.VALUE();
  return s.endsWith("%") ? n / 100 : n;
}
function toStr(v: Value): string {
  if (isErr(v)) throw v;
  if (v instanceof HyperlinkValue) return v.label;
  if (v == null) return "";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return String(v);
}
function toBool(v: Value): boolean {
  if (isErr(v)) throw v;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (v == null || v === "") return false;
  const s = String(v).toUpperCase();
  if (s === "TRUE") return true;
  if (s === "FALSE") return false;
  return toNum(v) !== 0;
}

function fmtNumber(n: number, decimals: number, thousands: boolean): string {
  const opts: Intl.NumberFormatOptions = { minimumFractionDigits: decimals, maximumFractionDigits: decimals };
  if (!thousands) opts.useGrouping = false;
  return n.toLocaleString("en-US", opts);
}
export function fmtGeneral(n: number): string {
  if (!Number.isFinite(n)) return "#NUM!";
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n);
  const abs = Math.abs(n);
  // Excel's General form: 1.23457E+16, -1.2345E-07.
  if (abs !== 0 && (abs >= 1e11 || abs < 1e-6)) return n.toExponential(5).replace(/\.?0+e/, "e").replace(/e([+-])(\d)$/, "e$10$2").toUpperCase();
  let s = n.toPrecision(11);
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s;
}
function pad2(x: number): string { return String(x).padStart(2, "0"); }
function fmtDate(serial: number): string {
  const d = dateParts(serial);
  return `${pad2(d.mo)}/${pad2(d.d)}/${d.y}`;
}
function fmtTime(serial: number): string {
  const d = dateParts(serial);
  let h = d.h; const ap = h >= 12 ? "PM" : "AM"; h = h % 12 || 12;
  return `${h}:${pad2(d.mi)}:${pad2(d.s)} ${ap}`;
}

/** How a computed value shows: its text, and whether it is an error, a number, a centred boolean or a link. */
export interface Display {
  text: string;
  err?: boolean;
  numeric?: boolean;
  center?: boolean;
  link?: string;
}
/** The formatting `displayValue` reads: the number format and its decimals. */
export interface NumberFormatting {
  nf?: string;
  d?: number;
}

// Returns { text, numeric, err } for a computed value + format.
export function displayValue(computed: Value | undefined, fmt?: NumberFormatting | null): Display {
  if (isErr(computed)) return { text: computed.value, err: true };
  if (computed instanceof HyperlinkValue) return { text: computed.label, link: computed.url };
  if (computed == null || computed === "") return { text: "" };
  const nf = fmt?.nf;
  const d = fmt?.d;
  if (typeof computed === "boolean") return { text: computed ? "TRUE" : "FALSE", center: true };
  if (typeof computed === "number") {
    if (!Number.isFinite(computed)) return { text: "#NUM!", err: true };
    let text;
    switch (nf) {
      case "number": text = fmtNumber(computed, d ?? 2, true); break;
      // Rounded half away from zero, as Excel's #,##0 does (Math.round would give -2 for -2.5).
      case "integer": text = fmtNumber(computed, 0, true); break;
      case "currency": text = (computed < 0 ? "-$" : "$") + fmtNumber(Math.abs(computed), d ?? 2, true); break;
      case "percent": text = fmtNumber(computed * 100, d ?? 2, true) + "%"; break;
      // Excel's form, as the format menu shows it: 1.01E+03.
      case "scientific": text = computed.toExponential(d ?? 2).replace(/e([+-])(\d)$/, "e$10$2").toUpperCase(); break;
      case "date": text = fmtDate(computed); break;
      case "time": text = fmtTime(computed); break;
      case "datetime": text = fmtDate(computed) + " " + fmtTime(computed); break;
      case "text": text = fmtGeneral(computed); break;
      default: text = d != null ? fmtNumber(computed, d, false) : fmtGeneral(computed);
    }
    return { text, numeric: true };
  }
  // string
  if (nf === "text") return { text: String(computed) };
  const text = String(computed);
  const link = safeHyperlinkUrl(text);
  return link ? { text, link } : { text };
}

// ===========================================================================
// Evaluation context — resolves refs across sheets with memoization + cycles.
// ===========================================================================
/** A cell as the engine reads it: only its raw text matters. */
export interface EngineCell {
  value?: string | null;
}
/**
 * The workbook as the engine reads it: sheet names (for cross-sheet references) and each sheet's
 * cells by A1 reference. The grid hands over its own model; exports a view of the cells read.
 */
export interface EngineModel {
  sheetOrder: string[];
  sheets: Record<string, { name: string }>;
  cells: Record<string, Record<string, EngineCell | undefined>>;
}
/** A cell an edit touched, for `invalidate`. */
export interface CellChange {
  sheetId: string;
  ref: string;
}
/** A built engine: computes cells on demand, caching results until `invalidate` drops them. */
export interface Engine {
  model: EngineModel;
  computeRef(sheetId: string, ref: string): Scalar;
  invalidate(changes: CellChange[]): boolean;
  /** The grid's note of which sheet names this engine was built for (see the client's rebuildEngine). */
  namesKey?: string;
}
/** Where a formula is evaluated: its own sheet and cell. */
export interface EvalCtx {
  sheetId: string;
  r: number;
  c: number;
}
/** A reference resolved to a sheet and zero-based cell. */
export interface SplitRef {
  sheetId: string;
  r: number;
  c: number;
}
/** Helpers exposed to builtins. */
export interface Helpers {
  evalNode(node: Ast, ctx: EvalCtx): Value;
  isErr: typeof isErr;
  ERR: typeof ERR;
  toNum: typeof toNum;
  toStr: typeof toStr;
  toBool: typeof toBool;
  compare(a: Scalar, b: Scalar, op: string): boolean | undefined;
  serialToDate: typeof serialToDate;
  dateToSerial: typeof dateToSerial;
  flatVals(args: Ast[], ctx: EvalCtx): Scalar[];
  flatNums(args: Ast[], ctx: EvalCtx): number[];
  scalar(node: Ast, ctx: EvalCtx): Scalar;
  matrixOf(node: Ast, ctx: EvalCtx): Matrix;
  /** `node` evaluated item by item over the ranges it reads (see SUMPRODUCT). */
  arrayOf(node: Ast, ctx: EvalCtx): Matrix;
}
/** Raw resolvers for builtins that look at references rather than values (ROW, COLUMN). */
export interface Resolvers {
  evalCellRef(sheetId: string, r: number, c: number): Scalar;
  splitRef(ref: string, defSheet: string): SplitRef | null;
  makeMatrix(sheetId: string, r1: number, c1: number, r2: number, c2: number): Matrix;
  model: EngineModel;
}
/** A builtin: its argument nodes, where it is evaluated, the helpers and the resolvers. */
export type FormulaFunction = (args: Ast[], ctx: EvalCtx, H: Helpers, R: Resolvers) => Value | undefined;

// Parsed formulas, shared by every engine (most formulas' text doesn't change between engines).
// Cleared wholesale if it grows very large.
const sharedAstCache = new Map<string, Ast | CellError>(); // formula string -> ast|error
// Thrown (never returned) when evaluation nests deeper than DEEP_LIMIT cells; see computeCell.
class DeepEvaluation {
  declare sheetId: string;
  declare r: number;
  declare c: number;
  constructor(sheetId: string, r: number, c: number) { this.sheetId = sheetId; this.r = r; this.c = c; }
}
const DEEP_LIMIT = 200;
// Thrown (never returned) once an engine has read more than `limits.budget` cells, for callers
// that must stop somewhere (the server's exports); the grid sets no budget.
export class EvaluationBudget {}
/** How many cells an engine has read (`work`), and how many it may read before throwing EvaluationBudget. */
export interface EvaluationLimits {
  work: number;
  budget: number;
}
export function makeEngine(model: EngineModel, limits: EvaluationLimits = { work: 0, budget: Infinity }): Engine {
  const cache = new Map<string, Scalar>(); // "sheetId!REF" -> value
  const inProgress = new Set<string>();
  if (sharedAstCache.size > 100000) sharedAstCache.clear();
  const astCache = sharedAstCache;
  // Long chains (a running total down 20,000 rows) would overflow the call stack if every
  // reference were followed recursively. Past DEEP_LIMIT nested formulas, evaluation stops with
  // a DeepEvaluation naming the cell it needed; computeCell works that cell out first, on a
  // fresh stack, and tries again. Cached results accumulate, so any depth works in linear time.
  // `pending` holds the cells waiting on a deeper one: meeting one again is a cycle.
  let depth = 0;
  const pending = new Set<string>();
  function computeCell(sheetId: string, r: number, c: number): Scalar {
    if (depth > 0) return evalCellRef(sheetId, r, c);
    const stack: SplitRef[] = [{ sheetId, r, c }];
    const keyOf = (item: SplitRef) => item.sheetId + "!" + rcToRef(item.r, item.c);
    try {
      for (;;) {
        const top = stack[stack.length - 1];
        try {
          const value = evalCellRef(top.sheetId, top.r, top.c);
          stack.pop();
          if (!stack.length) return value;
          pending.delete(keyOf(stack[stack.length - 1]));
        } catch (e) {
          if (!(e instanceof DeepEvaluation)) throw e;
          pending.add(keyOf(top));
          stack.push({ sheetId: e.sheetId, r: e.r, c: e.c });
        }
      }
    } finally { pending.clear(); depth = 0; }
  }

  function sheetByName(name: string): string | null {
    // Quoted names escape an apostrophe as '' (the tokenizer normalizes \' to that form too).
    if (/^'.*'$/.test(name)) name = name.slice(1, -1).replace(/''/g, "'");
    for (const id of model.sheetOrder) if (model.sheets[id].name.toLowerCase() === name.toLowerCase()) return id;
    return null;
  }
  function splitRef(ref: string, defSheet: string): SplitRef | null {
    let sheetId = defSheet;
    let cellPart = ref;
    // The last "!" ends the sheet name; a quoted name may itself contain one.
    const bang = ref.lastIndexOf("!");
    if (bang >= 0) {
      const sid = sheetByName(ref.slice(0, bang));
      if (!sid) return null;
      sheetId = sid;
      cellPart = ref.slice(bang + 1);
    }
    const rc = parseRef(cellPart);
    if (!rc) return null;
    return { sheetId, r: rc.r, c: rc.c };
  }

  function rawCellValue(sheetId: string, r: number, c: number): string | null {
    const cells = model.cells[sheetId];
    if (!cells) return null;
    const cell = cells[rcToRef(r, c)];
    if (!cell || cell.value === "" || cell.value == null) return null;
    return cell.value;
  }

  // ── Dependencies, for recalculating only what an edit affects ──────────────
  // While a formula is evaluated (`reader`), each single reference it reads is noted as an edge
  // cell -> formula, and each range it reads is noted once (not cell by cell). After an edit,
  // invalidate() drops the edited cells' results and, transitively, those of every formula
  // reading them; everything else stays computed. Edges from older evaluations may linger,
  // which only ever invalidates a little more than needed. Formulas using RAND/NOW/TODAY are
  // recomputed after every edit.
  const dependents = new Map<string, Set<string>>();   // cell key -> Set(formula key)
  const readerRanges = new Map<string, { sheetId: string; r1: number; c1: number; r2: number; c2: number }[]>(); // formula key -> [{ sheetId, r1, c1, r2, c2 }]
  const rangeIndex = new Map<string, Set<string>>();   // target sheetId -> Set(formula key) with ranges there
  const volatile = new Set<string>();
  // Only read while a formula is being evaluated, so the noting helpers below always see one.
  let reader: string | null = null;
  function noteRead(reader: string, cellKey: string) {
    let set = dependents.get(cellKey);
    if (!set) dependents.set(cellKey, set = new Set());
    set.add(reader);
  }
  function noteRange(reader: string, sheetId: string, r1: number, c1: number, r2: number, c2: number) {
    let list = readerRanges.get(reader);
    if (!list) readerRanges.set(reader, list = []);
    list.push({ sheetId, r1, c1, r2, c2 });
    let set = rangeIndex.get(sheetId);
    if (!set) rangeIndex.set(sheetId, set = new Set());
    set.add(reader);
  }
  function resetAll() { cache.clear(); dependents.clear(); readerRanges.clear(); rangeIndex.clear(); volatile.clear(); }
  // Returns false (having cleared everything) when an edit reaches so far that working out
  // exactly what it affects would cost more than recomputing on demand.
  function invalidate(changes: CellChange[]): boolean {
    const queue: string[] = [], seen = new Set<string>();
    const push = (key: string) => { if (!seen.has(key)) { seen.add(key); queue.push(key); } };
    for (const change of changes) push(change.sheetId + "!" + change.ref);
    for (const key of volatile) push(key);
    volatile.clear();
    let work = 0;
    for (let i = 0; i < queue.length; i++) {
      const key = queue[i];
      cache.delete(key);
      const direct = dependents.get(key);
      if (direct) for (const formula of direct) push(formula);
      const bang = key.lastIndexOf("!"), sheetId = key.slice(0, bang);
      const readers = rangeIndex.get(sheetId);
      if (readers?.size) {
        const p = parseRef(key.slice(bang + 1));
        if (p) for (const formula of readers) {
          const list = readerRanges.get(formula); if (!list) continue;
          work += list.length;
          for (const g of list) if (g.sheetId === sheetId && p.r >= g.r1 && p.r <= g.r2 && p.c >= g.c1 && p.c <= g.c2) { push(formula); break; }
        }
      }
      if (work > 4e6 || queue.length > 250000) { resetAll(); return false; }
    }
    return true;
  }

  function evalCellRef(sheetId: string, r: number, c: number): Scalar {
    if (++limits.work > limits.budget) throw new EvaluationBudget();
    const key = sheetId + "!" + rcToRef(r, c);
    if (cache.has(key)) return cache.get(key) as Scalar;
    if (inProgress.has(key) || pending.has(key)) return ERR.CYCLE();
    const raw = rawCellValue(sheetId, r, c);
    if (raw == null) { cache.set(key, null); return null; }
    let result: Scalar;
    if (raw[0] === "=") {
      if (depth >= DEEP_LIMIT) throw new DeepEvaluation(sheetId, r, c);
      inProgress.add(key); depth++;
      const outer = reader;
      reader = key; readerRanges.delete(key);
      try {
        let ast = astCache.get(raw);
        if (ast === undefined) { try { ast = parseFormula(raw.slice(1)); } catch (e) { ast = e instanceof CellError ? e : ERR.VALUE(); } astCache.set(raw, ast); }
        const here = { sheetId, r, c };
        // A sum or difference that is the whole formula drops the residue of binary fractions
        // (0.1+0.2-0.3 is 0), as Excel does there and only there.
        const value = isErr(ast) ? ast : ast.k === "bin" ? evalBin(ast, here, true) : evalNode(ast, here);
        // A formula that is just a range (=A1:B3) shows the range's first value (Excel files get
        // it as an array formula, which does the same); any other range result is intersected
        // with the formula's row or column, as Excel does. An empty cell's value shows as 0.
        result = isMatrix(value) ? (!isErr(ast) && unwrapParens(ast).k === "range" ? value.get(0, 0) : intersect(value, here)) : value;
        if (result === null) result = 0;
      } catch (e) { if (e instanceof DeepEvaluation || e instanceof EvaluationBudget) throw e; result = isErr(e) ? e : ERR.VALUE(); }
      finally { inProgress.delete(key); depth--; reader = outer; }
    } else {
      result = literalValue(raw);
    }
    cache.set(key, result);
    return result;
  }

  function literalValue(raw: string): Scalar {
    if (raw[0] === "'") return raw.slice(1);
    const s = raw.trim();
    if (s === "") return "";
    if (/^(TRUE|FALSE)$/i.test(s)) return /^true$/i.test(s);
    // numeric (incl. leading +, %, thousands)
    if (/^[-+]?\$?[\d,]*\.?\d+%?$/.test(s) && /\d/.test(s)) {
      const neg = s.startsWith("-");
      const cleaned = s.replace(/[$,+%-]/g, "");
      let n = Number(cleaned);
      if (Number.isFinite(n)) { if (s.endsWith("%")) n /= 100; return neg ? -n : n; }
    }
    return raw;
  }

  // Where one value is expected, a range gives the cell in the formula's own row (a one-column
  // range) or column (a one-row range), and #VALUE! when there's none: Excel's implicit
  // intersection. An array constant gives its first item.
  function intersect(m: Matrix, ctx: EvalCtx): Scalar {
    if (m.r1 == null || m.c1 == null || (m.rows === 1 && m.cols === 1)) return m.get(0, 0);
    if (m.cols === 1 && ctx.r >= m.r1 && ctx.r < m.r1 + m.rows) return m.get(ctx.r - m.r1, 0);
    if (m.rows === 1 && ctx.c >= m.c1 && ctx.c < m.c1 + m.cols) return m.get(0, ctx.c - m.c1);
    return ERR.VALUE();
  }

  // Matrix wrapper for ranges.
  function makeMatrix(sheetId: string, r1: number, c1: number, r2: number, c2: number): Matrix {
    return { matrix: true, sheetId, r1, c1, r2, c2,
      // (Read after evaluation too, e.g. a formula showing a range: then it starts a fresh computation.)
      get(i: number, j: number) { return computeCell(sheetId, r1 + i, c1 + j); },
      rows: r2 - r1 + 1, cols: c2 - c1 + 1 };
  }

  function evalNode(node: Ast, ctx: EvalCtx): Value {
    switch (node.k) {
      case "num": return node.v;
      case "str": return node.v;
      case "bool": return node.v;
      case "err": return new CellError(node.v);
      case "array": return arrayMatrix(node.rows);
      // An empty argument; the function library gives it its meaning.
      case "missing": return null;
      case "pct": { const v = evalNode(node.a, ctx); return pctScalar(isMatrix(v) ? intersect(v, ctx) : v); }
      case "paren": return evalNode(node.a, ctx);
      case "ref": {
        const p = splitRef(node.ref, ctx.sheetId);
        if (!p) return ERR.REF();
        if (reader) noteRead(reader, p.sheetId + "!" + rcToRef(p.r, p.c));
        return evalCellRef(p.sheetId, p.r, p.c);
      }
      case "range": {
        const a = splitRef(node.a, ctx.sheetId);
        const b = splitRef(node.b, ctx.sheetId);
        if (!a || !b) return ERR.REF();
        const r1 = Math.min(a.r, b.r), c1 = Math.min(a.c, b.c), r2 = Math.max(a.r, b.r), c2 = Math.max(a.c, b.c);
        if (reader) noteRange(reader, a.sheetId, r1, c1, r2, c2);
        return makeMatrix(a.sheetId, r1, c1, r2, c2);
      }
      case "un": {
        const v = evalNode(node.a, ctx);
        return unScalar(node.op, isMatrix(v) ? intersect(v, ctx) : v);
      }
      case "bin": return evalBin(node, ctx);
      case "call": return callFn(node, ctx);
    }
    return ERR.VALUE();
  }

  function evalBin(node: Extract<Ast, { k: "bin" }>, ctx: EvalCtx, whole = false): Value {
    let a = evalNode(node.a, ctx), b = evalNode(node.b, ctx);
    if (isMatrix(a)) a = intersect(a, ctx);
    if (isMatrix(b)) b = intersect(b, ctx);
    return binScalar(node.op, a, b, whole);
  }
  function binScalar(op: string, a: Scalar, b: Scalar, whole = false): Scalar {
    if (isErr(a)) return a;
    if (isErr(b)) return b;
    try {
      if (op === "&") return cellText(toStr(a) + toStr(b));
      if ("=<>".includes(op[0]) || op === "<=" || op === ">=" || op === "<>") return compare(a, b, op) as boolean;
      const x = toNum(a), y = toNum(b);
      switch (op) {
        case "+": case "-": {
          const r = op === "+" ? x + y : x - y;
          return whole && Math.abs(r) < Math.max(Math.abs(x), Math.abs(y)) * 1e-15 ? 0 : r;
        }
        case "*": return x * y;
        case "/": return y === 0 ? ERR.DIV0() : x / y;
        case "^": return power(x, y);
      }
    } catch (e) { return isErr(e) ? e : ERR.VALUE(); }
    return ERR.VALUE();
  }

  function unScalar(op: string, v: Scalar): Scalar {
    if (isErr(v)) return v;
    try { return op === "-" ? -toNum(v) : +toNum(v); } catch (e) { return e as CellError; }
  }
  function pctScalar(v: Scalar): Scalar {
    if (isErr(v)) return v;
    try { return divSafe(toNum(v), 100); } catch (e) { return e as CellError; }
  }
  // An expression evaluated item by item over its ranges, as SUMPRODUCT reads its arguments:
  // (A1:A3>1)*B1:B3 is three products. A single value applies to every item; ranges of other
  // shapes give #VALUE!.
  function arrayOf(node: Ast, ctx: EvalCtx): Matrix {
    if (node.k === "paren") return arrayOf(node.a, ctx);
    if (node.k !== "bin" && node.k !== "un" && node.k !== "pct") return H.matrixOf(node, ctx);
    const operands = node.k === "bin" ? [arrayOf(node.a, ctx), arrayOf(node.b, ctx)] : [arrayOf(node.a, ctx)];
    let rows = 1, cols = 1;
    for (const m of operands) { rows = Math.max(rows, m.rows); cols = Math.max(cols, m.cols); }
    if (operands.some((m) => (m.rows !== 1 && m.rows !== rows) || (m.cols !== 1 && m.cols !== cols))) {
      return { matrix: true, rows: 1, cols: 1, get: () => ERR.VALUE() };
    }
    const at = (m: Matrix, i: number, j: number) => m.get(m.rows === 1 ? 0 : i, m.cols === 1 ? 0 : j);
    const [x, y] = operands;
    return { matrix: true, rows, cols, get: (i, j) => node.k === "bin" ? binScalar(node.op, at(x, i, j), at(y, i, j)) : node.k === "un" ? unScalar(node.op, at(x, i, j)) : pctScalar(at(x, i, j)) };
  }

  // Excel's rules: a blank takes the other side's type (0, "" or FALSE), so a blank cell equals
  // 0; otherwise numbers sort before text, text before booleans, and "10" never equals 10.
  function compare(a: Scalar, b: Scalar, op: string): boolean | undefined {
    const blankAs = (other: unknown) => typeof other === "number" ? 0 : typeof other === "boolean" ? false : "";
    let x = a instanceof HyperlinkValue ? a.label : a, y = b instanceof HyperlinkValue ? b.label : b;
    if (x == null) x = blankAs(y);
    if (y == null) y = blankAs(x);
    const rank = (v: unknown) => typeof v === "number" ? 0 : typeof v === "boolean" ? 2 : 1;
    let cmp;
    if (rank(x) !== rank(y)) cmp = rank(x) - rank(y);
    // Numbers compare at 15 significant digits, as Excel does: =SQRT(2)^2=2 is TRUE.
    else if (typeof x === "number") cmp = Number(x.toPrecision(15)) - Number((y as number).toPrecision(15));
    else if (typeof x === "boolean") cmp = Number(x) - Number(y);
    else { const p = String(x).toLowerCase(), q = String(y).toLowerCase(); cmp = p < q ? -1 : p > q ? 1 : 0; }
    switch (op) {
      case "=": return cmp === 0;
      case "<>": return cmp !== 0;
      case "<": return cmp < 0;
      case ">": return cmp > 0;
      case "<=": return cmp <= 0;
      case ">=": return cmp >= 0;
    }
  }

  // Helpers exposed to builtins.
  const H: Helpers = {
    evalNode, isErr, ERR, toNum, toStr, toBool, compare, serialToDate, dateToSerial,
    // flat list of scalar values from arg nodes (ranges expanded)
    flatVals(args, ctx) {
      const out: Scalar[] = [];
      for (const node of args) collectVals(evalNode(node, ctx), out);
      return out;
    },
    // flat list of numbers, ignoring blanks & non-numeric text (aggregation style)
    // As in Excel, a single reference counts like a range (only its numbers: SUM(A1) skips text
    // "5" and TRUE there), while a value given directly is coerced, and text that isn't a number is #VALUE!.
    flatNums(args, ctx) {
      const out: number[] = [];
      for (const node of args) {
        // An empty argument counts as 0 (MAX(-1,) is 0, AVERAGE(1,) is 0.5).
        if (node.k === "missing") { out.push(0); continue; }
        const v = evalNode(node, ctx);
        if (isReference(node) && !isMatrix(v)) collectNums({ matrix: true, rows: 1, cols: 1, get: () => v }, out);
        else collectNums(v, out);
      }
      return out;
    },
    scalar(node, ctx) { const v = evalNode(node, ctx); return isMatrix(v) ? intersect(v, ctx) : v; },
    matrixOf(node, ctx) { const v = evalNode(node, ctx); return isMatrix(v) ? v : { matrix: true, rows: 1, cols: 1, get: () => v }; },
    arrayOf,
  };
  function collectVals(v: Value, out: Scalar[]) {
    if (isMatrix(v)) { for (let i = 0; i < v.rows; i++) for (let j = 0; j < v.cols; j++) out.push(v.get(i, j)); }
    else out.push(v);
  }
  function collectNums(v: Value, out: number[]) {
    if (isMatrix(v)) {
      for (let i = 0; i < v.rows; i++) for (let j = 0; j < v.cols; j++) {
        const c = v.get(i, j);
        if (isErr(c)) throw c;
        if (typeof c === "number") out.push(c);
        else if (typeof c === "boolean") { /* ranges ignore booleans */ }
      }
    } else {
      if (isErr(v)) throw v;
      if (typeof v === "number") out.push(v);
      else if (typeof v === "boolean") out.push(v ? 1 : 0);
      else if (typeof v === "string" || v instanceof HyperlinkValue) out.push(toNum(v instanceof HyperlinkValue ? v.label : v.trim() === "" ? "x" : v));
    }
  }

  function callFn(node: Extract<Ast, { k: "call" }>, ctx: EvalCtx): Value {
    const fn = FUNCTIONS[node.name];
    if (!fn) return ERR.NAME();
    if (reader && VOLATILE_FUNCTIONS.has(node.name)) volatile.add(reader);
    try {
      const r = fn(node.args, ctx, H, { evalCellRef, splitRef, makeMatrix, model });
      return r === undefined ? null : r;
    } catch (e) { if (e instanceof DeepEvaluation || e instanceof EvaluationBudget) throw e; return isErr(e) ? e : ERR.VALUE(); }
  }

  return {
    model,
    computeRef(sheetId, ref) { const rc = parseRef(ref); return rc ? computeCell(sheetId, rc.r, rc.c) : ERR.REF(); },
    invalidate,
  };
}
const VOLATILE_FUNCTIONS = new Set(["RAND", "RANDBETWEEN", "NOW", "TODAY"]);
function divSafe(a: number, b: number): number | CellError { return b === 0 ? ERR.DIV0() : a / b; }
// A scaled value at Excel's 15 significant digits, so truncating doesn't cut off binary error:
// 4.35 * 100 is 434.99999999999994, and TRUNC(4.35, 2) is 4.35.
function digits15(x: number): number { return Number(x.toPrecision(15)); }
// Excel's longest text value. Longer results are #VALUE!, as in Excel, which also keeps a chain of
// formulas from doubling a text until it exhausts memory.
const MAX_TEXT = 32767;
function cellText(text: string): string | CellError { return text.length > MAX_TEXT ? ERR.VALUE() : text; }
// `parts` joined by `separator`, measured before it is built.
function joinText(parts: string[], separator: string): string | CellError {
  let length = separator.length * Math.max(0, parts.length - 1);
  for (const part of parts) { length += part.length; if (length > MAX_TEXT) return ERR.VALUE(); }
  return length > MAX_TEXT ? ERR.VALUE() : parts.join(separator);
}
// An array constant's rows as a matrix (no sheet: it is no reference).
function arrayMatrix(rows: ArrayItem[][]): Matrix {
  return { matrix: true, rows: rows.length, cols: rows[0].length, get: (i, j) => rows[i][j] };
}
// `x^y` and POWER as Excel computes them: 0^0 is #NUM!, 0 to a negative power #DIV/0!, and a
// negative number has only odd roots (-8^(1/3) is -2; -8^(2/3) is #NUM!).
function power(x: number, y: number): number | CellError {
  if (x === 0 && y === 0) return ERR.NUM();
  if (x === 0 && y < 0) return ERR.DIV0();
  let r: number;
  if (x < 0 && !Number.isInteger(y)) {
    const root = Math.round(1 / y);
    if (root % 2 === 0 || Math.abs(1 / y - root) > 1e-10) return ERR.NUM();
    r = -Math.pow(-x, y);
  } else r = Math.pow(x, y);
  return Number.isFinite(r) ? r : ERR.NUM();
}

// ===========================================================================
// Function library. Signature: (args, ctx, H, R) -> value
// H = helpers, R = raw resolvers { evalCellRef, splitRef, makeMatrix, model }
// ===========================================================================
export const FUNCTIONS: Record<string, FormulaFunction> = (() => {
  const F: Record<string, FormulaFunction> = {};
  const numArgs = (args: Ast[], ctx: EvalCtx, H: Helpers) => H.flatNums(args, ctx);
  const s = (args: Ast[], ctx: EvalCtx, H: Helpers, i: number) => H.scalar(args[i], ctx);

  // ---- Math / aggregation ----
  F.SUM = (a, c, H) => numArgs(a, c, H).reduce((x, y) => x + y, 0);
  F.SUMSQ = (a, c, H) => numArgs(a, c, H).reduce((x, y) => x + y * y, 0);
  // PRODUCT alone skips an empty argument (PRODUCT(2,) is 2) rather than counting it as 0.
  F.PRODUCT = (a, c, H) => { const n = numArgs(a.filter((node) => node.k !== "missing"), c, H); return n.length ? n.reduce((x, y) => x * y, 1) : 0; };
  F.AVERAGE = (a, c, H) => { const n = numArgs(a, c, H); if (!n.length) return ERR.DIV0(); return n.reduce((x, y) => x + y, 0) / n.length; };
  // Excel's AVERAGEA: in references (a single cell too), text counts as 0 and booleans as 1/0
  // (blanks are skipped); a direct argument is coerced like any number.
  F.AVERAGEA = (a, c, H) => {
    let total = 0, count = 0;
    for (const node of a) {
      const result = H.evalNode(node, c);
      const v = !isMatrix(result) && isReference(node) ? { matrix: true as const, rows: 1, cols: 1, get: () => result } : result;
      if (isMatrix(v)) {
        for (let i = 0; i < v.rows; i++) for (let j = 0; j < v.cols; j++) {
          const x = v.get(i, j);
          if (isErr(x)) throw x;
          if (x == null || x === "") continue;
          total += typeof x === "number" ? x : x === true ? 1 : 0; count++;
        }
      } else if (v != null) { total += H.toNum(v); count++; }
    }
    return count ? total / count : ERR.DIV0();
  };
  // COUNT never fails: in references it counts numbers (errors and text are skipped); a value given
  // directly counts when it is a number, a boolean or text that reads as a number.
  F.COUNT = (a, c, H) => {
    let count = 0;
    for (const node of a) {
      if (node.k === "missing") { count++; continue; } // as Excel's 0
      let v: Value;
      try { v = H.evalNode(node, c); } catch (e) { if (!isErr(e)) throw e; continue; }
      if (isMatrix(v)) { for (let i = 0; i < v.rows; i++) for (let j = 0; j < v.cols; j++) if (typeof v.get(i, j) === "number") count++; }
      else if (isReference(node)) { if (typeof v === "number") count++; }
      else if (typeof v === "number" || typeof v === "boolean") count++;
      else if (typeof v === "string" && v.trim() !== "") { try { toNum(v); count++; } catch (e) { /* not a number */ } }
    }
    return count;
  };
  // Anything but an empty cell counts, "" included (a formula's "" or a direct ""), and so does
  // an empty argument.
  F.COUNTA = (a, c, H) => a.filter((node) => node.k === "missing").length + H.flatVals(a.filter((node) => node.k !== "missing"), c).filter((v) => v != null).length;
  F.COUNTBLANK = (a, c, H) => H.flatVals(a, c).filter((v) => v == null || v === "").length;
  // A loop, not Math.max(...n): spreading a big range's numbers as arguments overflows the stack.
  F.MAX = (a, c, H) => { const n = numArgs(a, c, H); return n.length ? n.reduce((x, y) => (y > x ? y : x)) : 0; };
  F.MIN = (a, c, H) => { const n = numArgs(a, c, H); return n.length ? n.reduce((x, y) => (y < x ? y : x)) : 0; };
  F.MEDIAN = (a, c, H) => { const n = numArgs(a, c, H).sort((x, y) => x - y); if (!n.length) return ERR.NUM(); const m = n.length >> 1; return n.length % 2 ? n[m] : (n[m - 1] + n[m]) / 2; };
  F.MODE = (a, c, H) => { const n = numArgs(a, c, H); const m: Record<number, number> = {}; let best: number | null = null, bc = 0; for (const x of n) { m[x] = (m[x] || 0) + 1; if (m[x] > bc) { bc = m[x]; best = x; } } return bc > 1 ? best : ERR.NA(); };
  F.ABS = (a, c, H) => Math.abs(H.toNum(s(a, c, H, 0)));
  F.SIGN = (a, c, H) => Math.sign(H.toNum(s(a, c, H, 0)));
  F.SQRT = (a, c, H) => { const x = H.toNum(s(a, c, H, 0)); return x < 0 ? ERR.NUM() : Math.sqrt(x); };
  F.POWER = (a, c, H) => power(H.toNum(s(a, c, H, 0)), H.toNum(s(a, c, H, 1)));
  F.EXP = (a, c, H) => Math.exp(H.toNum(s(a, c, H, 0)));
  F.LN = (a, c, H) => { const x = H.toNum(s(a, c, H, 0)); return x <= 0 ? ERR.NUM() : Math.log(x); };
  F.LOG10 = (a, c, H) => { const x = H.toNum(s(a, c, H, 0)); return x <= 0 ? ERR.NUM() : Math.log10(x); };
  F.LOG = (a, c, H) => { const x = H.toNum(s(a, c, H, 0)); const b = a.length > 1 ? H.toNum(s(a, c, H, 1)) : 10; return x <= 0 ? ERR.NUM() : Math.log(x) / Math.log(b); };
  F.MOD = (a, c, H) => { const y = H.toNum(s(a, c, H, 1)); if (y === 0) return ERR.DIV0(); const x = H.toNum(s(a, c, H, 0)); return x - Math.floor(x / y) * y; };
  F.INT = (a, c, H) => Math.floor(H.toNum(s(a, c, H, 0)));
  F.TRUNC = (a, c, H) => { const x = H.toNum(s(a, c, H, 0)); const d = a.length > 1 ? H.toNum(s(a, c, H, 1)) : 0; const f = Math.pow(10, d); return Math.trunc(digits15(x * f)) / f; };
  F.ROUND = (a, c, H) => { const x = H.toNum(s(a, c, H, 0)); const d = a.length > 1 ? H.toNum(s(a, c, H, 1)) : 0; const f = Math.pow(10, d); return (x < 0 ? -1 : 1) * Math.round(digits15(Math.abs(x) * f)) / f; };
  F.ROUNDUP = (a, c, H) => { const x = H.toNum(s(a, c, H, 0)); const d = a.length > 1 ? H.toNum(s(a, c, H, 1)) : 0; const f = Math.pow(10, d); return (x < 0 ? -1 : 1) * Math.ceil(digits15(Math.abs(x) * f)) / f; };
  F.ROUNDDOWN = (a, c, H) => { const x = H.toNum(s(a, c, H, 0)); const d = a.length > 1 ? H.toNum(s(a, c, H, 1)) : 0; const f = Math.pow(10, d); return (x < 0 ? -1 : 1) * Math.floor(digits15(Math.abs(x) * f)) / f; };
  F.MROUND = (a, c, H) => { const x = H.toNum(s(a, c, H, 0)); const m = H.toNum(s(a, c, H, 1)); return m === 0 ? 0 : Math.round(x / m) * m; };
  F.CEILING = (a, c, H) => { const x = H.toNum(s(a, c, H, 0)); const m = a.length > 1 ? H.toNum(s(a, c, H, 1)) : 1; return m === 0 ? 0 : Math.ceil(digits15(x / m)) * m; };
  F.FLOOR = (a, c, H) => { const x = H.toNum(s(a, c, H, 0)); const m = a.length > 1 ? H.toNum(s(a, c, H, 1)) : 1; return m === 0 ? 0 : Math.floor(digits15(x / m)) * m; };
  F.PI = () => Math.PI;
  F.SQRTPI = (a, c, H) => Math.sqrt(H.toNum(s(a, c, H, 0)) * Math.PI);
  F.RAND = () => Math.random();
  F.RANDBETWEEN = (a, c, H) => { const lo = Math.ceil(H.toNum(s(a, c, H, 0))); const hi = Math.floor(H.toNum(s(a, c, H, 1))); return lo + Math.floor(Math.random() * (hi - lo + 1)); };
  F.GCD = (a, c, H) => { const n = numArgs(a, c, H).map((x) => Math.abs(Math.trunc(x))); const g = (x: number, y: number): number => y ? g(y, x % y) : x; return n.reduce((x, y) => g(x, y), 0); };
  F.LCM = (a, c, H) => { const n = numArgs(a, c, H).map((x) => Math.abs(Math.trunc(x))); const g = (x: number, y: number): number => y ? g(y, x % y) : x; return n.reduce((x, y) => (x && y ? x * y / g(x, y) : 0), 1); };
  // 170! is the largest factorial a number holds; past it Excel gives #NUM!.
  F.FACT = (a, c, H) => { let x = Math.floor(H.toNum(s(a, c, H, 0))); if (x < 0 || x > 170) return ERR.NUM(); let r = 1; for (let i = 2; i <= x; i++) r *= i; return r; };
  F.RADIANS = (a, c, H) => H.toNum(s(a, c, H, 0)) * Math.PI / 180;
  F.DEGREES = (a, c, H) => H.toNum(s(a, c, H, 0)) * 180 / Math.PI;
  for (const fn of ["SIN", "COS", "TAN", "ASIN", "ACOS", "ATAN", "SINH", "COSH", "TANH"]) F[fn] = (a, c, H) => (Math[fn.toLowerCase() as keyof Math] as (x: number) => number)(H.toNum(s(a, c, H, 0)));
  F.ATAN2 = (a, c, H) => Math.atan2(H.toNum(s(a, c, H, 1)), H.toNum(s(a, c, H, 0)));

  // ---- Conditional aggregation ----
  function matchCriteria(val: Scalar, crit: Scalar): boolean {
    if (crit == null) return val == null || val === "";
    let c = typeof crit === "string" ? crit : String(crit);
    const m = /^(<=|>=|<>|=|<|>)(.*)$/.exec(c);
    let op = "=", rhs = c;
    if (m) { op = m[1]; rhs = m[2]; }
    const rn = Number(rhs);
    const rhsNum = rhs.trim() !== "" && Number.isFinite(rn);
    if (op === "=" || op === "<>") {
      let eq;
      if (rhsNum && typeof val === "number") eq = val === rn;
      else if (/[*?]/.test(rhs)) eq = wildcardMatches(rhs, String(val ?? ""));
      else eq = String(val ?? "").toLowerCase() === rhs.toLowerCase();
      return op === "=" ? eq : !eq;
    }
    // As in Excel, a numeric comparison only matches numbers, and a text one only text: ">1"
    // skips "n/a", blanks and TRUE.
    if (rhsNum) return typeof val === "number" && (op === "<" ? val < rn : op === ">" ? val > rn : op === "<=" ? val <= rn : val >= rn);
    if (typeof val !== "string" || val === "") return false;
    const x = val.toLowerCase(), y = rhs.toLowerCase();
    const cmp = x < y ? -1 : x > y ? 1 : 0;
    return op === "<" ? cmp < 0 : op === ">" ? cmp > 0 : op === "<=" ? cmp <= 0 : cmp >= 0;
  }
  function matVals(m: Matrix): Scalar[] { const o: Scalar[] = []; for (let i = 0; i < m.rows; i++) for (let j = 0; j < m.cols; j++) o.push(m.get(i, j)); return o; }

  F.SUMIF = (a, c, H) => {
    const range = matVals(H.matrixOf(a[0], c));
    const crit = a.length > 1 ? H.scalar(a[1], c) : null;
    const sumRange = a.length > 2 ? matVals(H.matrixOf(a[2], c)) : range;
    let t = 0; for (let i = 0; i < range.length; i++) if (matchCriteria(range[i], crit)) { const v = sumRange[i]; if (typeof v === "number") t += v; }
    return t;
  };
  F.COUNTIF = (a, c, H) => { const range = matVals(H.matrixOf(a[0], c)); const crit = a.length > 1 ? H.scalar(a[1], c) : null; return range.filter((v) => matchCriteria(v, crit)).length; };
  F.AVERAGEIF = (a, c, H) => {
    const range = matVals(H.matrixOf(a[0], c));
    const crit = a.length > 1 ? H.scalar(a[1], c) : null;
    const avgRange = a.length > 2 ? matVals(H.matrixOf(a[2], c)) : range;
    let t = 0, n = 0; for (let i = 0; i < range.length; i++) if (matchCriteria(range[i], crit)) { const v = avgRange[i]; if (typeof v === "number") { t += v; n++; } }
    return n ? t / n : ERR.DIV0();
  };
  function ifsMatch(a: Ast[], c: EvalCtx, H: Helpers, startIdx: number): boolean[] {
    // returns boolean array over first criteria range
    const pairs: [Scalar[], Scalar][] = [];
    for (let i = startIdx; i + 1 < a.length; i += 2) pairs.push([matVals(H.matrixOf(a[i], c)), H.scalar(a[i + 1], c)]);
    const len = pairs.length ? pairs[0][0].length : 0;
    const mask: boolean[] = [];
    for (let i = 0; i < len; i++) mask.push(pairs.every(([rng, cr]) => matchCriteria(rng[i], cr)));
    return mask;
  }
  F.SUMIFS = (a, c, H) => { const sum = matVals(H.matrixOf(a[0], c)); const mask = ifsMatch(a, c, H, 1); let t = 0; for (let i = 0; i < mask.length; i++) { const v = sum[i]; if (mask[i] && typeof v === "number") t += v; } return t; };
  F.COUNTIFS = (a, c, H) => ifsMatch(a, c, H, 0).filter(Boolean).length;
  F.AVERAGEIFS = (a, c, H) => { const avg = matVals(H.matrixOf(a[0], c)); const mask = ifsMatch(a, c, H, 1); let t = 0, n = 0; for (let i = 0; i < mask.length; i++) { const v = avg[i]; if (mask[i] && typeof v === "number") { t += v; n++; } } return n ? t / n : ERR.DIV0(); };
  // Anything but a number counts as 0 (so a condition needs arithmetic: --(A1:A9>1) or (A1:A9>1)*B1:B9),
  // and an error in any item is the result, as in Excel.
  F.SUMPRODUCT = (a, c, H) => {
    const mats = a.map((nd) => H.arrayOf(nd, c));
    const rows = mats[0].rows, cols = mats[0].cols;
    if (mats.some((m) => m.rows !== rows || m.cols !== cols)) return ERR.VALUE();
    let t = 0;
    for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) {
      let p = 1;
      for (const m of mats) { const v = m.get(i, j); if (isErr(v)) return v; p *= typeof v === "number" ? v : 0; }
      t += p;
    }
    return t;
  };

  // ---- Statistics ----
  function stdVar(vals: number[], pop: boolean, variance: boolean): number | CellError {
    if (vals.length < (pop ? 1 : 2)) return ERR.DIV0();
    const mean = vals.reduce((x, y) => x + y, 0) / vals.length;
    const ss = vals.reduce((x, y) => x + (y - mean) ** 2, 0);
    const v = ss / (vals.length - (pop ? 0 : 1));
    return variance ? v : Math.sqrt(v);
  }
  F.STDEV = (a, c, H) => stdVar(numArgs(a, c, H), false, false);
  F.STDEVP = (a, c, H) => stdVar(numArgs(a, c, H), true, false);
  F.VAR = (a, c, H) => stdVar(numArgs(a, c, H), false, true);
  F.VARP = (a, c, H) => stdVar(numArgs(a, c, H), true, true);
  F.LARGE = (a, c, H) => { const n = matVals(H.matrixOf(a[0], c)).filter((v) => typeof v === "number").sort((x, y) => y - x); const k = H.toNum(s(a, c, H, 1)); return n[k - 1] ?? ERR.NUM(); };
  F.SMALL = (a, c, H) => { const n = matVals(H.matrixOf(a[0], c)).filter((v) => typeof v === "number").sort((x, y) => x - y); const k = H.toNum(s(a, c, H, 1)); return n[k - 1] ?? ERR.NUM(); };
  F.RANK = (a, c, H) => { const x = H.toNum(s(a, c, H, 0)); const arr = matVals(H.matrixOf(a[1], c)).filter((v) => typeof v === "number"); const asc = a.length > 2 && H.toBool(s(a, c, H, 2)); const sorted = arr.slice().sort((p, q) => asc ? p - q : q - p); const i = sorted.indexOf(x); return i < 0 ? ERR.NA() : i + 1; };
  F.PERCENTILE = (a, c, H) => { const arr = matVals(H.matrixOf(a[0], c)).filter((v) => typeof v === "number").sort((x, y) => x - y); const p = H.toNum(s(a, c, H, 1)); if (!arr.length) return ERR.NUM(); const idx = p * (arr.length - 1); const lo = Math.floor(idx); return arr[lo] + (arr[Math.min(lo + 1, arr.length - 1)] - arr[lo]) * (idx - lo); };

  // ---- Logical ----
  // A chosen argument left empty gives 0, as in Excel: IF(1,) is 0, IFERROR(1/0,) too.
  const pick = (node: Ast | undefined, c: EvalCtx, H: Helpers): Scalar => node == null || node.k === "missing" ? 0 : H.scalar(node, c);
  F.IF = (a, c, H) => { const t = H.toBool(H.scalar(a[0], c)); if (t) return a.length > 1 ? pick(a[1], c, H) : true; return a.length > 2 ? pick(a[2], c, H) : false; };
  F.IFS = (a, c, H) => { for (let i = 0; i + 1 < a.length; i += 2) if (H.toBool(H.scalar(a[i], c))) return pick(a[i + 1], c, H); return ERR.NA(); };
  F.IFERROR = (a, c, H) => { const v = H.scalar(a[0], c); return isErr(v) ? (a.length > 1 ? pick(a[1], c, H) : "") : v; };
  F.IFNA = (a, c, H) => { const v = H.scalar(a[0], c); return isErr(v) && v.value === "#N/A" ? pick(a[1], c, H) : v; };
  // An empty argument is FALSE here: AND(TRUE,) is FALSE.
  F.AND = (a, c, H) => { if (a.some((node) => node.k === "missing")) return false; for (const v of H.flatVals(a, c)) { if (isErr(v)) return v; if (v != null && v !== "" && !H.toBool(v)) return false; } return true; };
  F.OR = (a, c, H) => { let any = false; for (const v of H.flatVals(a, c)) { if (isErr(v)) return v; if (v != null && v !== "" && H.toBool(v)) any = true; } return any; };
  F.XOR = (a, c, H) => { let cnt = 0; for (const v of H.flatVals(a, c)) if (H.toBool(v)) cnt++; return cnt % 2 === 1; };
  F.NOT = (a, c, H) => !H.toBool(H.scalar(a[0], c));
  F.TRUE = () => true;
  F.FALSE = () => false;
  F.SWITCH = (a, c, H) => { const target = H.scalar(a[0], c); let i = 1; for (; i + 1 < a.length; i += 2) { if (H.compare(target, H.scalar(a[i], c), "=")) return pick(a[i + 1], c, H); } return i < a.length ? pick(a[i], c, H) : ERR.NA(); };

  // ---- Text ----
  F.CONCAT = (a, c, H) => joinText(H.flatVals(a, c).map((v) => v == null ? "" : H.toStr(v)), "");
  F.CONCATENATE = F.CONCAT;
  F.TEXTJOIN = (a, c, H) => { const delim = H.toStr(H.scalar(a[0], c)); const skip = H.toBool(H.scalar(a[1], c)); const vals = H.flatVals(a.slice(2), c).map((v) => v == null ? "" : H.toStr(v)); return joinText(skip ? vals.filter((v) => v !== "") : vals, delim); };
  F.LEFT = (a, c, H) => { const t = H.toStr(H.scalar(a[0], c)); const n = a.length > 1 ? H.toNum(H.scalar(a[1], c)) : 1; return t.slice(0, Math.max(0, n)); };
  F.RIGHT = (a, c, H) => { const t = H.toStr(H.scalar(a[0], c)); const n = a.length > 1 ? H.toNum(H.scalar(a[1], c)) : 1; return n <= 0 ? "" : t.slice(-n); };
  F.MID = (a, c, H) => { const t = H.toStr(H.scalar(a[0], c)); const start = H.toNum(H.scalar(a[1], c)); const len = H.toNum(H.scalar(a[2], c)); return t.slice(Math.max(0, start - 1), Math.max(0, start - 1) + Math.max(0, len)); };
  F.LEN = (a, c, H) => H.toStr(H.scalar(a[0], c)).length;
  F.LOWER = (a, c, H) => H.toStr(H.scalar(a[0], c)).toLowerCase();
  F.UPPER = (a, c, H) => H.toStr(H.scalar(a[0], c)).toUpperCase();
  F.PROPER = (a, c, H) => H.toStr(H.scalar(a[0], c)).replace(/\b\w/g, (m) => m.toUpperCase()).replace(/\B\w/g, (m) => m.toLowerCase());
  F.TRIM = (a, c, H) => H.toStr(H.scalar(a[0], c)).replace(/\s+/g, " ").trim();
  F.CLEAN = (a, c, H) => H.toStr(H.scalar(a[0], c)).replace(/[\x00-\x1F]/g, "");
  F.SUBSTITUTE = (a, c, H) => { const t = H.toStr(H.scalar(a[0], c)); const oldT = H.toStr(H.scalar(a[1], c)); const newT = H.toStr(H.scalar(a[2], c)); if (a.length > 3) { const inst = H.toNum(H.scalar(a[3], c)); let k = 0; let idx = -1; while ((idx = t.indexOf(oldT, idx + 1)) >= 0) { if (++k === inst) return t.slice(0, idx) + newT + t.slice(idx + oldT.length); } return t; } return oldT === "" ? t : joinText(t.split(oldT), newT); };
  F.REPLACE = (a, c, H) => { const t = H.toStr(H.scalar(a[0], c)); const start = H.toNum(H.scalar(a[1], c)); const len = H.toNum(H.scalar(a[2], c)); const newT = H.toStr(H.scalar(a[3], c)); return cellText(t.slice(0, start - 1) + newT + t.slice(start - 1 + len)); };
  F.FIND = (a, c, H) => { const find = H.toStr(H.scalar(a[0], c)); const within = H.toStr(H.scalar(a[1], c)); const start = a.length > 2 ? H.toNum(H.scalar(a[2], c)) : 1; const i = within.indexOf(find, start - 1); return i < 0 ? ERR.VALUE() : i + 1; };
  // SEARCH takes Excel's wildcards: ? any character, * any run, ~ escapes either.
  F.SEARCH = (a, c, H) => {
    const find = H.toStr(H.scalar(a[0], c)), within = H.toStr(H.scalar(a[1], c));
    const start = a.length > 2 ? H.toNum(H.scalar(a[2], c)) : 1;
    if (start < 1 || start > within.length + 1) return ERR.VALUE();
    const index = wildcardSearch(wildcardSegments(find, true), within.slice(start - 1));
    return index >= 0 ? index + start : ERR.VALUE();
  };
  F.REPT = (a, c, H) => {
    const text = H.toStr(H.scalar(a[0], c)), times = Math.max(0, Math.trunc(H.toNum(H.scalar(a[1], c))));
    if (!text) return "";
    return text.length * times > MAX_TEXT ? ERR.VALUE() : text.repeat(times);
  };
  F.EXACT = (a, c, H) => H.toStr(H.scalar(a[0], c)) === H.toStr(H.scalar(a[1], c));
  // CHAR and CODE use Windows-1252, as Excel for Windows and the web do (CHAR(128) is €), for codes 1-255.
  F.CHAR = (a, c, H) => { const n = Math.trunc(H.toNum(H.scalar(a[0], c))); if (n < 1 || n > 255) return ERR.VALUE(); return n >= 128 && n < 160 && CP1252[n - 128] ? CP1252[n - 128] : String.fromCharCode(n); };
  F.UNICHAR = (a, c, H) => String.fromCodePoint(H.toNum(H.scalar(a[0], c)));
  F.CODE = (a, c, H) => { const t = H.toStr(H.scalar(a[0], c)); if (!t) return ERR.VALUE(); const i = CP1252.indexOf(t[0]); return i >= 0 ? 128 + i : t.charCodeAt(0); };
  F.UNICODE = (a, c, H) => { const t = H.toStr(H.scalar(a[0], c)); return t ? t.codePointAt(0) : ERR.VALUE(); };
  F.T = (a, c, H) => { const v = H.scalar(a[0], c); return typeof v === "string" ? v : ""; };
  F.VALUE = (a, c, H) => H.toNum(H.scalar(a[0], c));
  F.TEXT = (a, c, H) => {
    const value = H.scalar(a[0], c), f = H.toStr(H.scalar(a[1], c));
    let v: number;
    try { v = H.toNum(value); } catch (e) {
      // Text that isn't a number goes through the format's text section (or its @), else unchanged.
      if (isErr(value)) throw value;
      const text = H.toStr(value), sections = formatSections(f);
      const section = sections.length > 3 ? sections[3] : sections.find((part) => /@/.test(part.replace(/"[^"]*"/g, "")));
      if (section == null) return text;
      // The result is bounded like other built text (each @ repeats the whole text).
      const ats = (section.replace(/"[^"]*"/g, "").match(/@/g) || []).length;
      if (section.length + ats * text.length > MAX_TEXT) return ERR.VALUE();
      return section.replace(/"([^"]*)"|@/g, (m, quoted) => quoted ?? text);
    }
    return applyTextFormat(v, f);
  };
  F.HYPERLINK = (a, c, H) => {
    const rawUrl = H.toStr(H.scalar(a[0], c));
    const url = safeHyperlinkUrl(rawUrl); if (!url) return ERR.VALUE();
    const label = a.length > 1 ? H.toStr(H.scalar(a[1], c)) : rawUrl;
    return new HyperlinkValue(url, label);
  };

  // A format code's sections (positive;negative;zero;text), split outside quotes and escapes.
  function formatSections(f: string): string[] {
    const sections = [""];
    for (let i = 0; i < f.length; i++) {
      if (f[i] === '"') { const j = f.indexOf('"', i + 1), end = j < 0 ? f.length : j; sections[sections.length - 1] += f.slice(i, end + 1); i = end; }
      else if (f[i] === "\\") { sections[sections.length - 1] += f.slice(i, i + 2); i++; }
      else if (f[i] === ";") sections.push("");
      else sections[sections.length - 1] += f[i];
    }
    return sections;
  }
  // Excel's number format codes, as TEXT applies them: sections, 0 # ? placeholders, grouping and
  // scaling commas, %, E+00, "quoted" and \escaped text, and date/time codes.
  function applyTextFormat(v: number, f: string): string {
    const sections = formatSections(f);
    let section = sections[0], value = v, sign = "";
    if (v < 0 && sections.length > 1 && sections[1] !== "") { section = sections[1]; value = -v; }
    else if (v === 0 && sections.length > 2 && sections[2] !== "") section = sections[2];
    else if (v < 0) { value = -v; sign = "-"; }
    section = section.replace(/\[[^\]]*\]/g, ""); // colours and conditions
    const plain = section.replace(/"[^"]*"|\\./g, "");
    if (/^general$/i.test(plain.trim())) return sign + fmtGeneral(value);
    if (/[ydhs]|am\/pm|a\/p|m/i.test(plain.replace(/E[+-]/gi, "")) && !/[0#?]/.test(plain)) return sign + formatDatePattern(value, section);
    // Split into literal text and the number's pattern (placeholders, '.', ',' and E+00).
    const parts: { text?: string; code?: string }[] = [];
    for (let i = 0; i < section.length; i++) {
      const ch = section[i];
      if (ch === '"') { const j = section.indexOf('"', i + 1), end = j < 0 ? section.length : j; parts.push({ text: section.slice(i + 1, end) }); i = end; }
      else if (ch === "\\") { parts.push({ text: section[i + 1] ?? "" }); i++; }
      else if (ch === "_") { parts.push({ text: " " }); i++; }
      else if (ch === "*") i++;
      else if ("0#?.,".includes(ch) || ((ch === "E" || ch === "e") && /[+-]/.test(section[i + 1] ?? ""))) {
        const run = /^(?:[0#?.,]|[Ee][+-][0#?]+)+/.exec(section.slice(i))![0];
        parts.push({ code: run }); i += run.length - 1;
      } else parts.push({ text: ch });
    }
    const code = parts.filter((part) => part.code != null).map((part) => part.code).join("");
    if (!code) return sign + parts.map((part) => part.text === "@" ? fmtGeneral(value) : part.text).join("");
    const percents = (plain.match(/%/g) || []).length;
    value *= Math.pow(100, percents);
    const exponentMatch = /[Ee]([+-])([0#?]+)/.exec(code);
    let mantissaCode = exponentMatch ? code.slice(0, exponentMatch.index) : code;
    // Commas right before the decimal point (or the end) divide by 1,000 each.
    const scaling = /,+(?=\.|$)/.exec(mantissaCode);
    if (scaling && !exponentMatch) { value /= Math.pow(1000, scaling[0].length); mantissaCode = mantissaCode.replace(/,+(?=\.|$)/, ""); }
    const [intCode, fracCode = ""] = mantissaCode.split(".");
    const grouping = /[0#?],+[0#?]/.test(intCode);
    const fracPlaces = fracCode.replace(/[^0#?]/g, "").length, fracMin = fracCode.replace(/[^0?]/g, "").length;
    let exponent = 0;
    if (exponentMatch && value !== 0) {
      const intPlaces = Math.max(1, intCode.replace(/[^0#?]/g, "").length);
      exponent = Math.floor(Math.log10(value)) - (intPlaces - 1);
      value /= Math.pow(10, exponent);
      if (Number(value.toFixed(fracPlaces)) >= Math.pow(10, intPlaces)) { value /= 10; exponent++; }
    }
    const fixed = value.toLocaleString("en-US", { minimumFractionDigits: fracPlaces, maximumFractionDigits: fracPlaces, useGrouping: false });
    let [intDigits, fracDigits = ""] = fixed.split(".");
    while (fracDigits.length > fracMin && fracDigits.endsWith("0")) fracDigits = fracDigits.slice(0, -1);
    const intMin = intCode.replace(/[^0]/g, "").length;
    if (intDigits === "0" && !intMin) intDigits = "";
    intDigits = intDigits.padStart(intMin, "0");
    if (grouping) intDigits = intDigits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    let number = intDigits + (mantissaCode.includes(".") ? "." + fracDigits : "");
    if (exponentMatch) {
      const digits = String(Math.abs(exponent)).padStart(exponentMatch[2].replace(/[^0]/g, "").length, "0");
      number += "E" + (exponent < 0 ? "-" : exponentMatch[1] === "+" ? "+" : "") + digits;
    }
    // A whole number split by literal text (000-0000) fills its placeholders from the right.
    const codeParts = parts.filter((part) => part.code != null);
    if (codeParts.length > 1 && !mantissaCode.includes(".") && !exponentMatch && !grouping) {
      let digits = intDigits.replace(/^0+(?=\d)/, "");
      const filled = parts.map((part) => part.code == null ? part.text : "");
      for (let k = parts.length - 1; k >= 0; k--) {
        const piece = parts[k].code;
        if (piece == null) continue;
        let out = "";
        for (let j = piece.length - 1; j >= 0; j--) {
          if (!"0#?".includes(piece[j])) continue;
          out = (digits ? digits.slice(-1) : piece[j] === "0" ? "0" : piece[j] === "?" ? " " : "") + out;
          digits = digits.slice(0, -1);
        }
        filled[k] = out;
      }
      const firstCode = parts.indexOf(codeParts[0]);
      filled[firstCode] = digits + filled[firstCode];
      return sign + filled.join("");
    }
    // The number goes where its pattern first appears; any later pattern pieces are dropped.
    let placed = false;
    return sign + parts.map((part) => part.code == null ? part.text : placed ? "" : (placed = true, number)).join("");
  }
  // Excel's date codes, token by token: y/m/d/h/s runs, AM/PM, and "quoted" or \escaped text.
  // `m`/`mm` mean minutes right after an hour or right before seconds, months otherwise.
  function formatDatePattern(serial: number, f: string): string {
    const d = dateParts(serial);
    const M = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    const D = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const tokens: ({ k: "ampm" | "text"; v: string } | { k: "y" | "m" | "d" | "h" | "s"; v: number })[] = [];
    for (let i = 0; i < f.length;) {
      const rest = f.slice(i);
      const ampm = /^(am\/pm|a\/p)/i.exec(rest);
      if (ampm) { tokens.push({ k: "ampm", v: ampm[0] }); i += ampm[0].length; continue; }
      if (f[i] === '"') { const j = f.indexOf('"', i + 1); tokens.push({ k: "text", v: f.slice(i + 1, j < 0 ? f.length : j) }); i = j < 0 ? f.length : j + 1; continue; }
      if (f[i] === "\\") { tokens.push({ k: "text", v: f[i + 1] || "" }); i += 2; continue; }
      const run = /^(y+|m+|d+|h+|s+)/i.exec(rest);
      if (run) { tokens.push({ k: run[0][0].toLowerCase() as "y" | "m" | "d" | "h" | "s", v: run[0].length }); i += run[0].length; continue; }
      tokens.push({ k: "text", v: f[i++] });
    }
    const twelve = tokens.some((t) => t.k === "ampm");
    const near = (i: number, step: number, kind: string) => { for (let j = i + step; j >= 0 && j < tokens.length; j += step) { if (tokens[j].k === "text") continue; return tokens[j].k === kind; } return false; };
    return tokens.map((t, i) => {
      switch (t.k) {
        case "y": return t.v <= 2 ? String(d.y).slice(-2) : String(d.y);
        case "m":
          if (t.v <= 2 && (near(i, -1, "h") || near(i, 1, "s"))) return t.v === 2 ? pad2(d.mi) : String(d.mi);
          return t.v >= 5 ? M[d.mo - 1][0] : t.v === 4 ? M[d.mo - 1] : t.v === 3 ? M[d.mo - 1].slice(0, 3) : t.v === 2 ? pad2(d.mo) : String(d.mo);
        case "d": return t.v >= 4 ? D[d.weekday] : t.v === 3 ? D[d.weekday].slice(0, 3) : t.v === 2 ? pad2(d.d) : String(d.d);
        case "h": { const h = twelve ? d.h % 12 || 12 : d.h; return t.v >= 2 ? pad2(h) : String(h); }
        case "s": return t.v >= 2 ? pad2(d.s) : String(d.s);
        case "ampm": { const pm = d.h >= 12; const s = t.v.length > 3 ? (pm ? "PM" : "AM") : (pm ? "P" : "A"); return t.v[0] === t.v[0].toLowerCase() ? s.toLowerCase() : s; }
        default: return t.v;
      }
    }).join("");
  }

  // ---- Lookup / reference ----
  F.CHOOSE = (a, c, H) => { const i = Math.trunc(H.toNum(H.scalar(a[0], c))); return i >= 1 && i < a.length ? pick(a[i], c, H) : ERR.VALUE(); };
  F.ROW = (a, c, H, R) => { if (!a.length) return c.r + 1; const nd = unwrapParens(a[0]); if (nd.k === "ref") { const p = R.splitRef(nd.ref, c.sheetId); return p ? p.r + 1 : ERR.REF(); } if (nd.k === "range") { const p = R.splitRef(nd.a, c.sheetId); return p ? p.r + 1 : ERR.REF(); } return ERR.REF(); };
  F.COLUMN = (a, c, H, R) => { if (!a.length) return c.c + 1; const nd = unwrapParens(a[0]); if (nd.k === "ref") { const p = R.splitRef(nd.ref, c.sheetId); return p ? p.c + 1 : ERR.REF(); } if (nd.k === "range") { const p = R.splitRef(nd.a, c.sheetId); return p ? p.c + 1 : ERR.REF(); } return ERR.REF(); };
  F.ROWS = (a, c, H) => H.matrixOf(a[0], c).rows;
  F.COLUMNS = (a, c, H) => H.matrixOf(a[0], c).cols;
  F.MATCH = (a, c, H) => {
    const target = H.scalar(a[0], c);
    const m = H.matrixOf(a[1], c);
    const type = a.length > 2 ? H.toNum(H.scalar(a[2], c)) : 1;
    const arr = matVals(m);
    if (type === 0) {
      for (let i = 0; i < arr.length; i++) {
        if (typeof target === "string" && /[*?]/.test(target)) { if (wildcardMatches(target, String(arr[i] ?? ""))) return i + 1; }
        else if (H.compare(arr[i], target, "=")) return i + 1;
      }
      return ERR.NA();
    }
    // 1: largest <= target (asc); -1: smallest >= target (desc)
    let best = -1;
    for (let i = 0; i < arr.length; i++) {
      const cmp = type === 1 ? H.compare(arr[i], target, "<=") : H.compare(arr[i], target, ">=");
      if (cmp) best = i;
    }
    return best < 0 ? ERR.NA() : best + 1;
  };
  // Row or column 0 picks the whole column or row: a range (SUM(INDEX(B1:C5,0,2)) sums column C),
  // which a cell on its own shows by intersection (#VALUE! off it). With the column left out,
  // a range more than one cell wide and tall is #REF!, while an array gives the row.
  F.INDEX = (a, c, H, R) => {
    const m = H.matrixOf(a[0], c);
    let row = a.length > 1 ? Math.trunc(H.toNum(H.scalar(a[1], c))) : 0;
    let col = a.length > 2 ? Math.trunc(H.toNum(H.scalar(a[2], c))) : 0;
    if (m.rows === 1 && a.length === 2) { col = row; row = 1; }
    else if (a.length === 2 && m.cols > 1 && m.r1 != null) return ERR.REF();
    if (col === 0 && m.cols === 1) col = 1;
    if (row === 0 && m.rows === 1) row = 1;
    if (row < 0 || col < 0) return ERR.VALUE();
    if (row > m.rows || col > m.cols) return ERR.REF();
    if (row && col) return m.get(row - 1, col - 1);
    const r0 = row ? row - 1 : 0, c0 = col ? col - 1 : 0, rows = row ? 1 : m.rows, cols = col ? 1 : m.cols;
    if (m.sheetId != null && m.r1 != null && m.c1 != null) return R.makeMatrix(m.sheetId, m.r1 + r0, m.c1 + c0, m.r1 + r0 + rows - 1, m.c1 + c0 + cols - 1);
    return { matrix: true, rows, cols, get: (i: number, j: number) => m.get(r0 + i, c0 + j) };
  };
  F.VLOOKUP = (a, c, H) => {
    const target = H.scalar(a[0], c);
    const m = H.matrixOf(a[1], c);
    const colIdx = H.toNum(H.scalar(a[2], c));
    const approx = a.length > 3 ? H.toBool(H.scalar(a[3], c)) : true;
    if (colIdx < 1 || colIdx > m.cols) return ERR.REF();
    let found = -1;
    for (let i = 0; i < m.rows; i++) {
      const v = m.get(i, 0);
      if (!approx) { if (typeof target === "string" && /[*?]/.test(target) ? wildcardMatches(target, String(v ?? "")) : H.compare(v, target, "=")) { found = i; break; } }
      else { if (H.compare(v, target, "<=")) found = i; else break; }
    }
    return found < 0 ? ERR.NA() : m.get(found, colIdx - 1);
  };
  F.HLOOKUP = (a, c, H) => {
    const target = H.scalar(a[0], c);
    const m = H.matrixOf(a[1], c);
    const rowIdx = H.toNum(H.scalar(a[2], c));
    const approx = a.length > 3 ? H.toBool(H.scalar(a[3], c)) : true;
    if (rowIdx < 1 || rowIdx > m.rows) return ERR.REF();
    let found = -1;
    for (let j = 0; j < m.cols; j++) {
      const v = m.get(0, j);
      if (!approx) { if (H.compare(v, target, "=")) { found = j; break; } }
      else { if (H.compare(v, target, "<=")) found = j; else break; }
    }
    return found < 0 ? ERR.NA() : m.get(rowIdx - 1, found);
  };
  F.LOOKUP = (a, c, H) => {
    const target = H.scalar(a[0], c);
    const m = H.matrixOf(a[1], c);
    const vec = matVals(m);
    const result = a.length > 2 ? matVals(H.matrixOf(a[2], c)) : vec;
    let found = -1;
    for (let i = 0; i < vec.length; i++) { if (H.compare(vec[i], target, "<=")) found = i; else break; }
    return found < 0 ? ERR.NA() : (result[found] ?? ERR.NA());
  };

  // ---- Date & time ----
  F.TODAY = () => { const n = new Date(); return Math.floor(dateToSerial(new Date(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate())))); };
  F.NOW = () => { const n = new Date(); return dateToSerial(new Date(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate(), n.getHours(), n.getMinutes(), n.getSeconds()))); };
  F.DATE = (a, c, H) => excelDate(H.toNum(s(a, c, H, 0)), H.toNum(s(a, c, H, 1)), H.toNum(s(a, c, H, 2)));
  // As in Excel: whole hours, minutes and seconds (each at most 32767), wrapped into one day; a negative total is #NUM!.
  F.TIME = (a, c, H) => {
    const [h, m, sec] = [0, 1, 2].map((i) => Math.trunc(H.toNum(s(a, c, H, i))));
    const total = h * 3600 + m * 60 + sec;
    if (h > 32767 || m > 32767 || sec > 32767 || total < 0) throw ERR.NUM();
    return (total % 86400) / 86400;
  };
  // Date parts read the date as it shows (see dateParts); a negative serial is no date at all.
  const partsOf = (a: Ast[], c: EvalCtx, H: Helpers) => { const serial = H.toNum(s(a, c, H, 0)); if (serial < 0) throw ERR.NUM(); return dateParts(serial); };
  F.YEAR = (a, c, H) => partsOf(a, c, H).y;
  F.MONTH = (a, c, H) => partsOf(a, c, H).mo;
  F.DAY = (a, c, H) => partsOf(a, c, H).d;
  F.HOUR = (a, c, H) => partsOf(a, c, H).h;
  F.MINUTE = (a, c, H) => partsOf(a, c, H).mi;
  F.SECOND = (a, c, H) => partsOf(a, c, H).s;
  F.WEEKDAY = (a, c, H) => { const d = partsOf(a, c, H).weekday; const type = a.length > 1 ? H.toNum(s(a, c, H, 1)) : 1; if (type === 2) return d === 0 ? 7 : d; if (type === 3) return (d + 6) % 7; return d + 1; };
  F.WEEKNUM = (a, c, H) => { const serial = Math.floor(H.toNum(s(a, c, H, 0))), d = partsOf(a, c, H); const start = excelDate(d.y, 1, 1) as number; return Math.floor((serial - start + dateParts(start).weekday) / 7) + 1; };
  F.DAYS = (a, c, H) => H.toNum(s(a, c, H, 0)) - H.toNum(s(a, c, H, 1));
  // Past the end of the target month, the date stops at its last day (Jan 31 + 1 month = Feb 29).
  F.EDATE = (a, c, H) => { const d = serialToDate(Math.floor(H.toNum(s(a, c, H, 0)))); const mo = Math.trunc(H.toNum(s(a, c, H, 1))); const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + mo + 1, 0)).getUTCDate(); return dateToSerial(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + mo, Math.min(d.getUTCDate(), last)))); };
  F.EOMONTH = (a, c, H) => { const d = serialToDate(H.toNum(s(a, c, H, 0))); const mo = H.toNum(s(a, c, H, 1)); return dateToSerial(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + mo + 1, 0))); };
  // Whole units only, as Excel counts them: a month is complete once the end day reaches the start day.
  F.DATEDIF = (a, c, H) => {
    const n1 = Math.floor(H.toNum(s(a, c, H, 0))), n2 = Math.floor(H.toNum(s(a, c, H, 1)));
    const unit = H.toStr(H.scalar(a[2], c)).toUpperCase();
    if (n1 > n2) return ERR.NUM();
    const s1 = serialToDate(n1), s2 = serialToDate(n2);
    const months = (s2.getUTCFullYear() - s1.getUTCFullYear()) * 12 + (s2.getUTCMonth() - s1.getUTCMonth()) - (s2.getUTCDate() < s1.getUTCDate() ? 1 : 0);
    if (unit === "D") return n2 - n1;
    if (unit === "M") return months;
    if (unit === "Y") return Math.floor(months / 12);
    if (unit === "YM") return months % 12;
    if (unit === "MD") { const back = new Date(Date.UTC(s2.getUTCFullYear(), s2.getUTCMonth() - (s2.getUTCDate() < s1.getUTCDate() ? 1 : 0), s1.getUTCDate())); return Math.round((s2.getTime() - back.getTime()) / 86400000); }
    if (unit === "YD") { let start = new Date(Date.UTC(s2.getUTCFullYear(), s1.getUTCMonth(), s1.getUTCDate())); if (start > s2) start = new Date(Date.UTC(s2.getUTCFullYear() - 1, s1.getUTCMonth(), s1.getUTCDate())); return Math.round((s2.getTime() - start.getTime()) / 86400000); }
    return ERR.NUM();
  };

  // ---- Information ----
  F.ISBLANK = (a, c, H) => { const v = H.scalar(a[0], c); return v == null || v === ""; };
  F.ISNUMBER = (a, c, H) => typeof H.scalar(a[0], c) === "number";
  F.ISTEXT = (a, c, H) => typeof H.scalar(a[0], c) === "string";
  F.ISNONTEXT = (a, c, H) => typeof H.scalar(a[0], c) !== "string";
  F.ISLOGICAL = (a, c, H) => typeof H.scalar(a[0], c) === "boolean";
  F.ISERROR = (a, c, H) => isErr(H.scalar(a[0], c));
  F.ISERR = (a, c, H) => { const v = H.scalar(a[0], c); return isErr(v) && v.value !== "#N/A"; };
  F.ISNA = (a, c, H) => { const v = H.scalar(a[0], c); return isErr(v) && v.value === "#N/A"; };
  F.ISEVEN = (a, c, H) => Math.trunc(H.toNum(H.scalar(a[0], c))) % 2 === 0;
  F.ISODD = (a, c, H) => Math.abs(Math.trunc(H.toNum(H.scalar(a[0], c))) % 2) === 1;
  F.N = (a, c, H) => { const v = H.scalar(a[0], c); if (typeof v === "number") return v; if (typeof v === "boolean") return v ? 1 : 0; return 0; };
  F.NA = () => ERR.NA();
  F.ERRORTYPE = (a, c, H) => { const v = H.scalar(a[0], c); if (!isErr(v)) return ERR.NA(); const map: Record<string, number> = { "#NULL!": 1, "#DIV/0!": 2, "#VALUE!": 3, "#REF!": 4, "#NAME?": 5, "#NUM!": 6, "#N/A": 7 }; return map[v.value] || ERR.NA(); };
  F["ERROR.TYPE"] = F.ERRORTYPE; // Excel's name (exports write ERRORTYPE as this too)

  return F;
})();

// --- Wildcards (? one character, * any run), matched case-insensitively ---
// Not with a regular expression: a pattern such as *a*a*a*b backtracks exponentially over a long
// text, which would hang every grid showing the formula, and exports.
// A pattern as the runs of characters between its `*`s; `null` is a `?`. `tilde`: `~` escapes the
// next `*`, `?` or `~`, as SEARCH reads it (criteria and lookups take every other character as itself).
type WildcardSegment = (string | null)[];
function wildcardSegments(pattern: string, tilde: boolean): WildcardSegment[] {
  const segments: WildcardSegment[] = [[]];
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (tilde && ch === "~" && i + 1 < pattern.length && "*?~".includes(pattern[i + 1])) segments[segments.length - 1].push(foldCase(pattern[++i]));
    else if (ch === "*") segments.push([]);
    else segments[segments.length - 1].push(ch === "?" ? null : foldCase(ch));
  }
  return segments;
}
// The case a regular expression's `i` flag compares a UTF-16 unit in.
function foldCase(ch: string): string {
  const upper = ch.toUpperCase();
  return upper.length === 1 && !(ch.charCodeAt(0) >= 128 && upper.charCodeAt(0) < 128) ? upper : ch;
}
function foldText(text: string): string[] { return Array.from({ length: text.length }, (_, i) => foldCase(text[i])); }
function segmentAt(segment: WildcardSegment, text: string[], at: number): boolean {
  if (at + segment.length > text.length) return false;
  for (let k = 0; k < segment.length; k++) if (segment[k] !== null && segment[k] !== text[at + k]) return false;
  return true;
}
// Where `segment` first fits at or after `from`, ending by `limit`; -1 if nowhere.
function findSegment(segment: WildcardSegment, text: string[], from: number, limit: number): number {
  for (let at = from; at + segment.length <= limit; at++) if (segmentAt(segment, text, at)) return at;
  return -1;
}
// Places each segment as early as it fits after the one before, which finds a match whenever one exists.
function placeSegments(segments: WildcardSegment[], text: string[], from: number, limit: number): number {
  let at = from;
  for (const segment of segments) {
    const found = findSegment(segment, text, at, limit);
    if (found < 0) return -1;
    at = found + segment.length;
  }
  return at;
}
// Whether the whole of `value` matches the criteria or lookup pattern.
function wildcardMatches(pattern: string, value: string): boolean {
  const segments = wildcardSegments(pattern, false), text = foldText(value);
  const first = segments[0], last = segments[segments.length - 1];
  if (segments.length === 1) return first.length === text.length && segmentAt(first, text, 0);
  const lastAt = text.length - last.length;
  if (lastAt < first.length || !segmentAt(first, text, 0) || !segmentAt(last, text, lastAt)) return false;
  return placeSegments(segments.slice(1, -1), text, first.length, lastAt) >= 0;
}
// Where the first match of the pattern starts in `value` (SEARCH), or -1.
function wildcardSearch(segments: WildcardSegment[], value: string): number {
  const text = foldText(value), [first, ...rest] = segments;
  for (let at = 0; at + first.length <= text.length; at++) {
    if (!segmentAt(first, text, at)) continue;
    // The rest only has less room from a later start, so if it doesn't fit now it never will.
    return placeSegments(rest, text, at + first.length, text.length) >= 0 ? at : -1;
  }
  return -1;
}

// Windows-1252's characters for codes 128-159 ("" where it has none, which keeps the Latin-1 control character).
const CP1252 = ["€", "", "‚", "ƒ", "„", "…", "†", "‡", "ˆ", "‰", "Š", "‹", "Œ", "", "Ž", "", "", "‘", "’", "“", "”", "•", "–", "—", "˜", "™", "š", "›", "œ", "", "ž", "Ÿ"];

// Full list of function names for the insert-function menu / documentation.
export const FUNCTION_NAMES = Object.keys(FUNCTIONS).sort();
const FUNCTION_HELP: Record<string, [string, string]> = {
  SUM: ["SUM(value1, [value2, …])", "Adds numbers or ranges."],
  AVERAGE: ["AVERAGE(value1, [value2, …])", "Returns the arithmetic mean."],
  COUNT: ["COUNT(value1, [value2, …])", "Counts numeric values."],
  COUNTA: ["COUNTA(value1, [value2, …])", "Counts non-empty values."],
  COUNTIF: ["COUNTIF(range, criterion)", "Counts cells matching a condition."],
  COUNTIFS: ["COUNTIFS(range1, criterion1, …)", "Counts rows matching multiple conditions."],
  SUMIF: ["SUMIF(range, criterion, [sum_range])", "Sums values matching a condition."],
  SUMIFS: ["SUMIFS(sum_range, range1, criterion1, …)", "Sums values matching multiple conditions."],
  AVERAGEIF: ["AVERAGEIF(range, criterion, [average_range])", "Averages values matching a condition."],
  MIN: ["MIN(value1, [value2, …])", "Returns the smallest number."],
  MAX: ["MAX(value1, [value2, …])", "Returns the largest number."],
  MEDIAN: ["MEDIAN(value1, [value2, …])", "Returns the median value."],
  ROUND: ["ROUND(value, places)", "Rounds a number to a specified precision."],
  ROUNDUP: ["ROUNDUP(value, places)", "Rounds a number away from zero."],
  ROUNDDOWN: ["ROUNDDOWN(value, places)", "Rounds a number toward zero."],
  IF: ["IF(condition, value_if_true, [value_if_false])", "Returns values based on a condition."],
  IFS: ["IFS(condition1, value1, [condition2, value2, …])", "Tests multiple conditions in order."],
  IFERROR: ["IFERROR(value, fallback)", "Returns a fallback when a value is an error."],
  IFNA: ["IFNA(value, fallback)", "Returns a fallback for #N/A."],
  AND: ["AND(condition1, [condition2, …])", "Returns TRUE when every condition is true."],
  OR: ["OR(condition1, [condition2, …])", "Returns TRUE when any condition is true."],
  NOT: ["NOT(condition)", "Reverses a logical value."],
  CONCAT: ["CONCAT(value1, [value2, …])", "Joins text values."],
  TEXTJOIN: ["TEXTJOIN(delimiter, ignore_empty, text1, …)", "Joins text with a delimiter."],
  LEFT: ["LEFT(text, [characters])", "Returns characters from the beginning of text."],
  RIGHT: ["RIGHT(text, [characters])", "Returns characters from the end of text."],
  MID: ["MID(text, start, length)", "Returns characters from the middle of text."],
  LEN: ["LEN(text)", "Returns the number of characters."],
  TEXT: ["TEXT(value, format)", "Formats a number as text."],
  HYPERLINK: ["HYPERLINK(url, [link_label])", "Creates a clickable HTTP or HTTPS link."],
  VLOOKUP: ["VLOOKUP(search_key, range, column, [approximate])", "Looks down the first column of a range."],
  HLOOKUP: ["HLOOKUP(search_key, range, row, [approximate])", "Looks across the first row of a range."],
  INDEX: ["INDEX(reference, row, [column])", "Returns a value at a row and column."],
  MATCH: ["MATCH(search_key, range, [search_type])", "Returns the position of a matching value."],
  LOOKUP: ["LOOKUP(search_key, search_range, [result_range])", "Finds a value in a sorted range."],
  TODAY: ["TODAY()", "Returns the current date."],
  NOW: ["NOW()", "Returns the current date and time."],
  DATE: ["DATE(year, month, day)", "Builds a date from year, month, and day."],
  YEAR: ["YEAR(date)", "Returns the year of a date."],
  MONTH: ["MONTH(date)", "Returns the month of a date."],
  DAY: ["DAY(date)", "Returns the day of the month."],
  PRODUCT: ["PRODUCT(value1, [value2, …])", "Multiplies numbers or ranges."],
  ABS: ["ABS(value)", "Returns the absolute value."],
  SQRT: ["SQRT(value)", "Returns the positive square root."],
  MOD: ["MOD(dividend, divisor)", "Returns the remainder after division."],
  POWER: ["POWER(base, exponent)", "Raises a number to a power."],
  STDEV: ["STDEV(value1, [value2, …])", "Estimates sample standard deviation."],
  VAR: ["VAR(value1, [value2, …])", "Estimates sample variance."],
  RANK: ["RANK(value, range, [ascending])", "Returns a value’s rank in a range."],
  LARGE: ["LARGE(range, rank)", "Returns the nth largest value."],
  SWITCH: ["SWITCH(expression, case1, value1, [default])", "Matches an expression to cases."],
  UPPER: ["UPPER(text)", "Converts text to uppercase."],
  LOWER: ["LOWER(text)", "Converts text to lowercase."],
  TRIM: ["TRIM(text)", "Removes repeated and surrounding spaces."],
  SUBSTITUTE: ["SUBSTITUTE(text, old_text, new_text, [instance])", "Replaces matching text."],
  CHOOSE: ["CHOOSE(index, choice1, [choice2, …])", "Returns a choice by numeric index."],
  WEEKDAY: ["WEEKDAY(date, [type])", "Returns the weekday number."],
  EDATE: ["EDATE(start_date, months)", "Moves a date by a number of months."],
  DATEDIF: ["DATEDIF(start_date, end_date, unit)", "Returns the difference between two dates."],
};
export function functionHelp(name: string): [string, string] { return FUNCTION_HELP[name] || [`${name}(value, …)`, "Spreadsheet function."]; }

// Text that stays legible on any fill: the darker or lighter ink, whichever contrasts.
export function readableInk(hex: string | null | undefined): string {
  let h = String(hex || "").replace("#", "");
  if (h.length === 3 || h.length === 4) h = h.slice(0, 3).split("").map((x) => x + x).join("");
  if (h.length < 6) return "";
  const lin = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const L = 0.2126 * lin(parseInt(h.slice(0, 2), 16)) + 0.7152 * lin(parseInt(h.slice(2, 4), 16)) + 0.0722 * lin(parseInt(h.slice(4, 6), 16));
  return L > 0.36 ? "#1b1b1f" : "#f4f4f5";
}
