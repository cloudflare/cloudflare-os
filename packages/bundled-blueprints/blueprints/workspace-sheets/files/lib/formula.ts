// The formula front end: the tokenizer, the parser that turns `=SUM(A1:B2)*2` into an AST, and the
// serializer that writes an AST back, which the grid uses to rewrite references when rows or
// columns are inserted or deleted. Evaluation lives in client.ts, since it reads the cells; nothing
// here touches the document or the DOM, which is what lets it be tested on its own.

/** A formula error as a cell shows it (`#VALUE!`, `#REF!`, ...); thrown by the parser and evaluator. */
export class CellError {
  declare value: string;
  constructor(v: string) { this.value = v; }
  toString() { return this.value; }
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

// --- Tokenizer ---
export type Token =
  | { t: "str" | "op" | "word"; v: string }
  | { t: "num"; v: number }
  | { t: "lp" | "rp" | "comma" | "colon"; v?: undefined };

export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") { i++; continue; }
    // Single quotes denote text unless the closing quote is followed by a sheet separator.
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
    // word: letters/digits/$/./! and quoted sheet names 'My Sheet'!
    if (/[A-Za-z_$]/.test(ch) || ch === "'") {
      let j = i, word = "";
      if (ch === "'") { // 'Sheet Name'!Ref
        j++;
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
    i++; // skip unknown
  }
  return tokens;
}

// --- Parser (produces AST) ---
export type Ast =
  | { k: "num"; v: number }
  | { k: "str"; v: string }
  | { k: "bool"; v: boolean }
  | { k: "ref"; ref: string }
  | { k: "range"; a: string; b: string }
  // Kept as a node so that a formula written back (see serializeAst) keeps its grouping.
  | { k: "paren"; a: Ast }
  | { k: "un"; op: string; a: Ast }
  | { k: "pct"; a: Ast }
  | { k: "bin"; op: string; a: Ast; b: Ast }
  | { k: "call"; name: string; args: Ast[] };

export function parseFormula(src: string): Ast {
  const tokens = tokenize(src);
  let pos = 0;
  const peek = (): Token | undefined => tokens[pos];
  const next = (): Token | undefined => tokens[pos++];

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
    while (peek() && peek()!.t === "op" && peek()!.v === "%") { next(); node = { k: "pct", a: node }; }
    return node;
  }
  function parsePrimary(): Ast {
    const tk = next();
    if (!tk) throw ERR.VALUE();
    if (tk.t === "num") return { k: "num", v: tk.v };
    if (tk.t === "str") return { k: "str", v: tk.v };
    if (tk.t === "lp") { const e = parseExpr(0); if (peek() && peek()!.t === "rp") next(); return { k: "paren", a: e }; }
    if (tk.t === "word") {
      if (peek() && peek()!.t === "lp") {
        next();
        const args: Ast[] = [];
        if (!(peek() && peek()!.t === "rp")) {
          args.push(parseExpr(0));
          while (peek() && peek()!.t === "comma") { next(); args.push(parseExpr(0)); }
        }
        if (peek() && peek()!.t === "rp") next();
        return { k: "call", name: tk.v.toUpperCase(), args };
      }
      const up = tk.v.toUpperCase();
      if (up === "TRUE") return { k: "bool", v: true };
      if (up === "FALSE") return { k: "bool", v: false };
      // reference — possibly a range with colon
      let ref: Ast = { k: "ref", ref: tk.v };
      if (peek() && peek()!.t === "colon") {
        next();
        // A range's end has to be a reference too: `A1:5` or `A1:(` is a #VALUE! here rather than
        // an AST holding a number or nothing that fails the same way only once evaluated.
        const end = next();
        if (!end || end.t !== "word") throw ERR.VALUE();
        ref = { k: "range", a: tk.v, b: end.v };
      }
      return ref;
    }
    throw ERR.VALUE();
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
  "^": { lbp: 5, right: true },
};

/**
 * `node` with any grouping parentheses removed: `((A5))` is `A5`. The parser keeps a `paren` node
 * so that a formula written back keeps its grouping; the evaluator sees through it, and so must a
 * function that reads an argument's shape rather than its value (ROW, COLUMN), or `ROW((A5))`
 * would find a `paren` where it looks for a reference.
 */
export function unwrapParens(node: Ast): Ast {
  return node.k === "paren" ? unwrapParens(node.a) : node;
}

// --- Serializer (AST -> string), used for ref adjustment on insert/delete ---
export function serializeAst(node: Ast): string {
  switch (node.k) {
    case "num": return String(node.v);
    case "str": return '"' + node.v.replace(/"/g, '\\"') + '"';
    case "bool": return node.v ? "TRUE" : "FALSE";
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

// Editor and copy/fill references share the grid's 702-column and 50,000-row bounds. A function
// name, identifier suffix, sheet prefix or quoted string must never become an editable reference.
const SHEET_PREFIX_SOURCE = "(?:(?:'(?:\\\\'|''|[^'])+'|[A-Za-z_][A-Za-z0-9_.]*)!)?";
const CELL_SOURCE = "(?<![A-Za-z0-9_.$])\\$?[A-Z]{1,2}\\$?[1-9]\\d*(?![A-Za-z0-9_!]|\\s*\\()";
const ENDPOINT_SOURCE = SHEET_PREFIX_SOURCE + CELL_SOURCE;
const REFERENCE_SOURCE = `${ENDPOINT_SOURCE}(?:\\s*:\\s*${ENDPOINT_SOURCE})?`;
const ENDPOINT_PATTERN = new RegExp(ENDPOINT_SOURCE, "gi");
const REFERENCE_PATTERN = new RegExp(REFERENCE_SOURCE, "gi");

export function formulaCursorInQuote(value: string, cursor: number): boolean {
  let quote: string | null = null;
  for (let index = 1; index < cursor; index++) {
    const char = value[index];
    if (quote) {
      if (char === "\\" && value[index + 1] === quote) { index++; continue; }
      if (char === quote) { if (value[index + 1] === quote) { index++; continue; } quote = null; }
    } else if (char === '"' || char === "'") quote = char;
  }
  return !!quote;
}

export function* formulaReferences(value: string, endpoints = false): Generator<{ start: number; end: number; text: string }> {
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

export function cycleReferenceToken(text: string): string {
  const bang = text.lastIndexOf("!"), prefix = text.slice(0, bang + 1);
  return prefix + text.slice(bang + 1).replace(/^(\$?)([A-Z]{1,2})(\$?)([1-9]\d*)$/i, (_, fixedColumn, column, fixedRow, row) => {
    if (!fixedColumn && !fixedRow) return "$" + column.toUpperCase() + "$" + row;
    if (fixedColumn && fixedRow) return column.toUpperCase() + "$" + row;
    if (!fixedColumn && fixedRow) return "$" + column.toUpperCase() + row;
    return column.toUpperCase() + row;
  });
}

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
