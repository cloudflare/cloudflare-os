// @vitest-environment node
import { describe, expect, it } from "vitest";
import { type Ast, CellError, cycleReferenceToken, formulaCursorInQuote, formulaReferences, parseFormula, serializeAst, shiftFormulaReferences, tokenize, unwrapParens } from "../files/lib/formula.ts";

describe("the formula tokenizer", () => {
  it("reads numbers, strings, operators, references and quoted sheet names", () => {
    expect(tokenize('SUM(A1:B2, 1.5e3) & "a""b" <> \'My Sheet\'!C3')).toEqual([
      { t: "word", v: "SUM" }, { t: "lp" }, { t: "word", v: "A1" }, { t: "colon" }, { t: "word", v: "B2" },
      { t: "comma" }, { t: "num", v: 1500 }, { t: "rp" }, { t: "op", v: "&" }, { t: "str", v: 'a"b' },
      { t: "op", v: "<>" }, { t: "word", v: "'My Sheet'!C3" },
    ]);
  });

  it("distinguishes single-quoted text from escaped sheet names", () => {
    expect(tokenize(String.raw`'it''s' & 'it\'s' & "a\"b" & 'Owner''s Sheet'!A1 & 'Owner\'s Sheet'!B2`)).toEqual([
      { t: "str", v: "it's" }, { t: "op", v: "&" }, { t: "str", v: "it's" },
      { t: "op", v: "&" }, { t: "str", v: 'a"b' }, { t: "op", v: "&" },
      { t: "word", v: "'Owner''s Sheet'!A1" }, { t: "op", v: "&" }, { t: "word", v: "'Owner''s Sheet'!B2" },
    ]);
  });

  it("keeps an escaped apostrophe followed by a bang inside a string", () => {
    expect(parseFormula(String.raw`'don\'!t'`)).toEqual({ k: "str", v: "don'!t" });
  });
});

describe("the formula parser", () => {
  it("builds precedence-aware trees and writes them back", () => {
    const ast = parseFormula("1+2*A1^2%");
    expect(ast).toEqual({
      k: "bin", op: "+", a: { k: "num", v: 1 },
      b: { k: "bin", op: "*", a: { k: "num", v: 2 }, b: { k: "bin", op: "^", a: { k: "ref", ref: "A1" }, b: { k: "pct", a: { k: "num", v: 2 } } } },
    });
    expect(serializeAst(ast)).toBe("1+2*A1^2%");
    expect(serializeAst(parseFormula('IF(A1>=3, "yes", TRUE)'))).toBe('IF(A1>=3,"yes",TRUE)');
  });

  it("parses a range as two references", () => {
    expect(parseFormula("SUM(A1:B2)")).toEqual({
      k: "call", name: "SUM", args: [{ k: "range", a: "A1", b: "B2" }],
    });
    expect(serializeAst(parseFormula("Sheet2!A1:'Other Sheet'!B9")))
      .toBe("Sheet2!A1:'Other Sheet'!B9");
  });

  it.each(["A1:5", "A1:(", "A1:", "SUM(A1:)"])("rejects %s, whose range has no end reference", (src) => {
    let thrown: unknown;
    try { parseFormula(src); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(CellError);
    expect(String(thrown)).toBe("#VALUE!");
  });

  it("rejects an empty or dangling expression as #VALUE!", () => {
    for (const src of ["", "1+", "*2"]) {
      let thrown: unknown;
      try { parseFormula(src); } catch (e) { thrown = e; }
      expect(thrown, src).toBeInstanceOf(CellError);
    }
  });

  it.each(["1 2", "SUM(A1) B2", "A1,B2", "1)"])("rejects %s rather than evaluating only its prefix", (src) => {
    let thrown: unknown;
    try { parseFormula(src); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(CellError);
    expect(String(thrown)).toBe("#VALUE!");
  });

  it("keeps parentheses when writing a formula back", () => {
    // Rows and columns are inserted by rewriting each formula's references through the
    // serializer, so a dropped pair of parentheses would silently change what a cell computes.
    expect(serializeAst(parseFormula("(A1+A2)*3"))).toBe("(A1+A2)*3");
    expect(serializeAst(parseFormula("-(A1)"))).toBe("-(A1)");
    expect(parseFormula("(1+2)*3")).toEqual({
      k: "bin", op: "*", a: { k: "paren", a: { k: "bin", op: "+", a: { k: "num", v: 1 }, b: { k: "num", v: 2 } } }, b: { k: "num", v: 3 },
    });
  });

  it("preserves grouping and quoted text while rewriting formulas", () => {
    const ast = parseFormula(String.raw`IF((A1+2)*3>5,'it\'s fine','Owner''s Sheet'!B2)`);
    expect(serializeAst(ast)).toBe(`IF((A1+2)*3>5,"it's fine",'Owner''s Sheet'!B2)`);
    expect(parseFormula(serializeAst(ast))).toEqual(ast);
  });

  it.each([
    String.raw`'a\"b'`,
    String.raw`'a\\"b'`,
    String.raw`'a\""b'`,
    String.raw`"a\\\"b"`,
    String.raw`'both \'quotes\' and \"slashes'`,
  ])("preserves literal backslashes next to quotes when rewriting %s", (literal) => {
    const ast = parseFormula(`IF(A1>0,${literal},"fallback")`);
    expect(parseFormula(serializeAst(ast))).toEqual(ast);
  });

  it("sees through grouping parentheses on request", () => {
    // ROW and COLUMN read their argument's shape rather than its value, so `ROW((A5))` has to find
    // the reference behind the grouping the parser keeps for the serializer.
    expect(unwrapParens(parseFormula("((A5))"))).toEqual({ k: "ref", ref: "A5" });
    expect(unwrapParens(parseFormula("(A1:B2)"))).toEqual({ k: "range", a: "A1", b: "B2" });
    const ref: Ast = { k: "ref", ref: "A5" };
    expect(unwrapParens(ref)).toBe(ref);
  });

  it("round-trips every node kind through the serializer", () => {
    const sources = ["-A1", "A1%", "(1+2)*3", '"quoted ""text"""', "FALSE", "F(A1,B2:C3)"];
    for (const src of sources) {
      const ast: Ast = parseFormula(src);
      expect(parseFormula(serializeAst(ast)), src).toEqual(ast);
    }
  });
});

describe("formula references in editing and copied cells", () => {
  it("excludes quoted text, function names, identifier suffixes and out-of-grid references", () => {
    const formula = String.raw`="A1" & 'B2' & 'don\'!t C3' & LOG10(D4) + ABC5 + A50001 + ZZ50000 + named.E6`;
    expect([...formulaReferences(formula)].map((reference) => reference.text)).toEqual(["D4", "ZZ50000"]);
    expect(formulaCursorInQuote('="A1"', 3)).toBe(true);
    expect(formulaCursorInQuote('="A1"+B2', 7)).toBe(false);
  });

  it("identifies qualified references and whole ranges without treating prefixes as endpoints", () => {
    const formula = "=Q1!B2 + 'Owner''s Sheet'!$C$3:D4 + Q1.A2!E5";
    const references = [...formulaReferences(formula)];
    expect(references.map((reference) => reference.text)).toEqual(["Q1!B2", "'Owner''s Sheet'!$C$3:D4", "Q1.A2!E5"]);
    expect(references.every((reference) => formula.slice(reference.start, reference.end) === reference.text)).toBe(true);
    expect([...formulaReferences(formula, true)].map((reference) => reference.text)).toEqual(["Q1!B2", "'Owner''s Sheet'!$C$3", "D4", "Q1.A2!E5"]);
  });

  it("keeps whitespace-separated ranges together for editing and cut preflight", () => {
    const range = "'Source'!$A1 \t:\r\nB$2";
    const formula = `=SUM(${range})`;
    expect([...formulaReferences(formula)]).toEqual([{ start: 5, end: 5 + range.length, text: range }]);
    expect([...formulaReferences(formula, true)].map((reference) => reference.text)).toEqual(["'Source'!$A1", "B$2"]);
    expect(shiftFormulaReferences(formula, 1, 1)).toBe("=SUM('Source'!$A2 \t:\r\nC$2)");
  });

  it("preserves literal backslashes and escaped apostrophes in sheet identities", () => {
    const range = String.raw`'C:\Data'!A1 : 'D:\Owner\'s Data'!$B$2`;
    const formula = `=SUM(${range})`;
    expect([...formulaReferences(formula)].map((reference) => reference.text)).toEqual([range]);
    expect(shiftFormulaReferences(formula, 1, 1)).toBe(String.raw`=SUM('C:\Data'!B2 : 'D:\Owner\'s Data'!$B$2)`);
    expect(parseFormula(range)).toEqual({ k: "range", a: String.raw`'C:\Data'!A1`, b: String.raw`'D:\Owner''s Data'!$B$2` });
  });

  it("cycles only the qualified endpoint through absolute and mixed locks", () => {
    let reference = "Q1!B2";
    for (const expected of ["Q1!$B$2", "Q1!B$2", "Q1!$B2", "Q1!B2"]) {
      reference = cycleReferenceToken(reference);
      expect(reference).toBe(expected);
    }
    expect(cycleReferenceToken("'Owner''s Sheet'!B2")).toBe("'Owner''s Sheet'!$B$2");
    expect(cycleReferenceToken("LOG10")).toBe("LOG10");
  });

  it("shifts unlocked components without changing literals, function names or sheet prefixes", () => {
    const formula = String.raw`="A1" & 'B2' & 'don\'!t C3' & LOG10(D4) + Q1!B2 + Q1.A2!C3 + 'Q1'!D4 + $A$1 + $A1 + A$1 + A1:B2`;
    expect(shiftFormulaReferences(formula, 1, 1)).toBe(String.raw`="A1" & 'B2' & 'don\'!t C3' & LOG10(E5) + Q1!C3 + Q1.A2!D4 + 'Q1'!E5 + $A$1 + $A2 + B$1 + B2:C3`);
    expect(shiftFormulaReferences("=(A1+B1)*C1", 1, 0)).toBe("=(A2+B2)*C2");
    expect(shiftFormulaReferences("=A1+$A1+A$1+$A$1", -1, -1)).toBe("=#REF!+#REF!+#REF!+$A$1");
  });
});
