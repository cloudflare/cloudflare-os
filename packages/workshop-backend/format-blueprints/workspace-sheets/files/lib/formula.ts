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
    if (ch === '"') {
      let j = i + 1, str = "";
      while (j < n) {
        if (src[j] === '"') { if (src[j + 1] === '"') { str += '"'; j += 2; continue; } j++; break; }
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
        while (j < n && src[j] !== "'") word += src[j++];
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
  return ast;
}
const BP: Record<string, { lbp: number; right?: boolean }> = {
  "=": { lbp: 1 }, "<>": { lbp: 1 }, "<": { lbp: 1 }, ">": { lbp: 1 }, "<=": { lbp: 1 }, ">=": { lbp: 1 },
  "&": { lbp: 2 },
  "+": { lbp: 3 }, "-": { lbp: 3 },
  "*": { lbp: 4 }, "/": { lbp: 4 },
  "^": { lbp: 5, right: true },
};

// --- Serializer (AST -> string), used for ref adjustment on insert/delete ---
export function serializeAst(node: Ast): string {
  switch (node.k) {
    case "num": return String(node.v);
    case "str": return '"' + node.v.replace(/"/g, '""') + '"';
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
