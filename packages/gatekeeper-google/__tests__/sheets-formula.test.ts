import { describe, expect, it } from "vitest";
import {
  STRUCTURE_SENSITIVE_FUNCTIONS, canonicalFormula, compactFormula, refusedFunction, rewriteFormula,
  structureSensitive, tokenize, type FormulaReference, type RewriteStep,
} from "../src/sheets-formula";
import { columnNumber, findSheet } from "../src/sheets-model";
import {
  FORMULA_CANONICALIZATION, FORMULA_SHEETS, SHEET_TITLE_QUOTING, WHITESPACE_DRIFT, sheet,
} from "./sheets-fixture";

const sheets = FORMULA_SHEETS.map((title, id) => sheet(id, title));
const titleOf = (name: string) => findSheet(sheets, name)?.title;

/** The references in `formula`, with the sheet each names. */
function references(formula: string) {
  return tokenize(formula)
    .filter((token): token is FormulaReference => token.kind === "reference")
    .map(({ text, sheet: name }) => ({ text, ...(name === undefined ? {} : { sheet: name }) }));
}

describe("Sheets formula tokens", () => {
  it("joins back into the formula", () => {
    for (let formula of [
      ...FORMULA_CANONICALIZATION.map(([entered]) => entered),
      '=IF(A1="x""y", \'Unclosed', "=\"unterminated", "=1E5+.5*2A1", "=#REF!+A1:B",
    ]) {
      expect(tokenize(formula).map(token => token.text).join("")).toBe(formula);
    }
  });

  it("reads references with their sheet, anchors and open ends", () => {
    expect(references("=SUM('It''s'!$A$1:B2, Sales!A2:A, B3:3, 3:5, A:C, x.y!C1)")).toEqual([
      { text: "'It''s'!$A$1:B2", sheet: "It's" },
      { text: "Sales!A2:A", sheet: "Sales" },
      { text: "B3:3" },
      { text: "3:5" },
      { text: "A:C" },
      { text: "x.y!C1", sheet: "x.y" },
    ]);
    // Calls, names and sheet titles that look like cells are not references.
    expect(references("=LOG10(A1B2) + AB12!C3 + TRUE")).toEqual([{ text: "AB12!C3", sheet: "AB12" }]);
    expect(references('="A1:B2"')).toEqual([]);
  });
});

describe("Sheets refused functions", () => {
  const REFUSED = ["IMPORTRANGE", "IMPORTDATA", "IMPORTHTML", "IMPORTXML", "IMPORTFEED", "IMAGE"];

  it("finds each in any case, nested and inside LAMBDA", () => {
    for (let name of REFUSED) {
      let mixed = [...name].map((c, i) => i % 2 ? c.toLowerCase() : c).join("");
      for (let typed of [name, name.toLowerCase(), mixed]) {
        expect(refusedFunction(`=${typed}("https://example.com")`), typed).toBe(name);
        expect(refusedFunction(`=IF(A1, SUM(1, ${typed}("u", 1)), 0)`), typed).toBe(name);
        expect(refusedFunction(`=LAMBDA(x, ${typed}(x))("u")`), typed).toBe(name);
        expect(refusedFunction(`=MAP(A1:A3, LAMBDA(u, ${typed} (u)))`), typed).toBe(name);
      }
    }
  });

  it("ignores string literals, sheet prefixes and names that only contain one", () => {
    expect(refusedFunction('="IMPORTRANGE(""x"")"')).toBeUndefined();
    expect(refusedFunction("='IMAGE'!A1 + 'importxml'!B2:C3")).toBeUndefined();
    expect(refusedFunction("=IMAGE!A1 + importrange!A1:B2")).toBeUndefined();
    expect(refusedFunction("=IMAGES(A1) + MYIMAGE(1) + IMPORTRANGES(2) + NORM.DIST(1, 0, 1, TRUE)"))
      .toBeUndefined();
    expect(refusedFunction("=SUM(A1:B2)")).toBeUndefined();
  });

  it("checks each dot-separated part of a name", () => {
    expect(refusedFunction('=_xlfn.IMPORTRANGE("abc", "A1")')).toBe("IMPORTRANGE");
    expect(refusedFunction('=x.image("u")')).toBe("IMAGE");
  });

  it("searches quoted text that prefixes no reference", () => {
    expect(refusedFunction("=it's!A1 & IMAGE(\"u\") & 'x'")).toBe("IMAGE");
    expect(refusedFunction("='importxml' + 1")).toBe("IMPORTXML");
    // One that follows a name prefixes nothing, so its text cannot join the name.
    expect(refusedFunction("=IMAG'e'!A1")).toBeUndefined();
    expect(refusedFunction("=X'IMPORTRANGE'!A1")).toBe("IMPORTRANGE");
  });

  it("reads a long run of apostrophes in linear time", () => {
    expect(refusedFunction("=" + "'".repeat(50_000))).toBeUndefined();
    expect(refusedFunction("=" + "'".repeat(49_000) + "image")).toBe("IMAGE");
  });

  it("finds the first of several", () => {
    expect(refusedFunction('="IMAGE" & IMPORTDATA("u") & IMAGE("v")')).toBe("IMPORTDATA");
  });
});

describe("Sheets canonical formulas", () => {
  it("writes each entered formula as Google stored it", () => {
    for (let [entered, stored] of FORMULA_CANONICALIZATION) {
      expect(canonicalFormula(entered, titleOf), entered).toBe(stored);
    }
  });

  it("leaves string literals, names and whitespace as typed", () => {
    expect(canonicalFormula('=concat( "b3:a2", sales!b3 )', titleOf)).toBe('=concat( "b3:a2", Sales!B3 )');
    expect(canonicalFormula("=myFn(a1)", titleOf)).toBe("=myFn(A1)");
  });

  it("never merges a quoted sheet prefix into the name before it", () => {
    let merging = [sheet(0, "Sales"), sheet(1, "E")];
    let mergingTitle = (name: string) => findSheet(merging, name)?.title;
    expect(canonicalFormula("=X'Sales'!a1", mergingTitle)).toBe("=X'Sales'!A1");
    expect(canonicalFormula("=IMAG'e'!a1", mergingTitle)).toBe("=IMAG'e'!A1");
    expect(canonicalFormula("=1+'Sales'!a1", mergingTitle)).toBe("=1+Sales!A1");
  });

  it("leaves references to a sheet the grid lacks as typed", () => {
    expect(canonicalFormula("=Nope!b3:a2 + sales!b3:a2", titleOf)).toBe("=Nope!b3:a2 + Sales!A2:B3");
  });

  it("orders only unanchored corners, and keeps whole rows and columns as typed", () => {
    expect(canonicalFormula("=Rw!$B3:A2", titleOf)).toBe("=Rw!$B3:A2");
    expect(canonicalFormula("=A3:B2", titleOf)).toBe("=A2:B3");
    expect(canonicalFormula("=rw!5:3 + rw!c:a", titleOf)).toBe("=Rw!5:3 + Rw!c:a");
    expect(canonicalFormula("=b3:b + b3:3", titleOf)).toBe("=B3:B + B3:3");
  });

  it("quotes a matched title as Google does", () => {
    let probe = [sheet(0, "Probe Tab"), sheet(1, "A1")];
    let probeTitle = (name: string) => findSheet(probe, name)?.title;
    expect(canonicalFormula("='probe tab'!a1 + 'a1'!b2", probeTitle)).toBe("='Probe Tab'!A1 + 'A1'!B2");
  });
});

describe("Sheets compact formulas", () => {
  it("drops whitespace outside string literals and sheet titles", () => {
    let [stored, later] = WHITESPACE_DRIFT;
    expect(compactFormula(stored)).toBe(compactFormula(later));
    expect(compactFormula("=IF( A1 , \"a  b\" , 'Probe Tab'!A1 )")).toBe("=IF(A1,\"a  b\",'Probe Tab'!A1)");
  });
});

const insertRows = (title: string, before: number, count = 1): RewriteStep =>
  ({ kind: "insert", title, axis: "rows", start: before - 1, count });
const deleteRows = (title: string, first: number, last = first): RewriteStep =>
  ({ kind: "delete", title, axis: "rows", start: first - 1, count: last - first + 1 });
const insertColumns = (title: string, before: string, count = 1): RewriteStep =>
  ({ kind: "insert", title, axis: "columns", start: columnNumber(before) - 1, count });
const deleteColumns = (title: string, first: string, last = first): RewriteStep => ({
  kind: "delete", title, axis: "columns",
  start: columnNumber(first) - 1, count: columnNumber(last) - columnNumber(first) + 1,
});

/** A formula, a step, the text Google wrote after it, and whether its cells changed or broke. */
type Rewrite = [formula: string, step: RewriteStep, text: string, cellsChanged: boolean, broken?: boolean];

/** Formulas on the sheet "Rw" whose rows or columns change, and the text Google wrote after. */
const ON_SHEET: Rewrite[] = [
  ["=A2:A5", insertRows("Rw", 2), "=A3:A6", false],
  ["=A2:A5", insertRows("Rw", 5), "=A2:A6", true],
  ["=A2:A5", insertRows("Rw", 6), "=A2:A5", false],
  ["=A1:A2", insertRows("Rw", 2), "=A1:A3", true],
  ["=A2:A", insertRows("Rw", 2), "=A3:A", false],
  ["=A:C", insertRows("Rw", 2), "=A:C", true],
  ["=3:5", insertRows("Rw", 2), "=4:6", false],
  ["=B3:3", insertRows("Rw", 2), "=B4:4", false],
  ["=A2:A5", deleteRows("Rw", 2), "=A2:A4", true],
  ["=A1:A2", deleteRows("Rw", 2), "=A1", true],
  ["=A2:B2", deleteRows("Rw", 2), "=#REF!", true, true],
  ["=2:2", deleteRows("Rw", 2), "=#REF!", true, true],
  ["=B2:C3", deleteRows("Rw", 2), "=B2:C2", true],
  ["=A2:A5", deleteRows("Rw", 2, 5), "=#REF!", true, true],
  ["=A6", deleteRows("Rw", 2, 5), "=A2", false],
  ["=B3:3", deleteRows("Rw", 3), "=#REF!", true, true],
  ["=A2:A5", deleteRows("Rw", 4, 7), "=A2:A3", true],
  ["=3:5", deleteRows("Rw", 4, 7), "=3:3", true],
  ["=A5", deleteRows("Rw", 4, 7), "=#REF!", true, true],
  ["=A6", deleteRows("Rw", 4, 7), "=#REF!", true, true],
  ["=A:C", insertColumns("Rw", "A"), "=B:D", false],
  ["=B3:3", insertColumns("Rw", "A"), "=C3:3", false],
  ["=$A$2", insertColumns("Rw", "A"), "=$B$2", false],
  ["=A:C", insertColumns("Rw", "B"), "=A:D", true],
  ["=A2:B2", insertColumns("Rw", "B"), "=A2:C2", true],
  ["=A:C", deleteColumns("Rw", "A"), "=A:B", true],
  ["=B3:3", deleteColumns("Rw", "A"), "=A3:3", false],
  ["=A2:B2", deleteColumns("Rw", "A"), "=A2", true],
  ["=A2", deleteColumns("Rw", "A"), "=#REF!", true, true],
  ["=A1:A3", deleteColumns("Rw", "A"), "=#REF!", true, true],
  ["=A:A", deleteColumns("Rw", "A"), "=#REF!", true, true],
  ["=A:C", deleteColumns("Rw", "A", "C"), "=#REF!", true, true],
  // Formulas in rows 3 and 5 of a sheet whose rows 1 and 2 are deleted.
  ["=SUM(A1:A3)", deleteRows("Rw", 1, 2), "=SUM(A1)", true],
  ["=A1", deleteRows("Rw", 1, 2), "=#REF!", true, true],
  ["=ROW()", deleteRows("Rw", 1, 2), "=ROW()", false],
];

/**
 * Formulas on another sheet, referring to "Rw" or to "O" (10 rows, 4 columns), and the text Google
 * wrote after.
 */
const ELSEWHERE: Rewrite[] = [
  ["=Rw!A5", deleteRows("Rw", 2, 5), "=#REF!", true, true],
  ["=SUM(Rw!A2:A5,Rw!A10)", deleteRows("Rw", 2, 5), "=SUM(#REF!,Rw!A6)", true, true],
  ['=Rw!A1&"Rw!A1"', { kind: "rename", from: "Rw", to: "Rw 2" }, `='Rw 2'!A1&"Rw!A1"`, false],
  ["=Rw!A1", { kind: "rename", from: "Rw", to: "It's x" }, "='It''s x'!A1", false],
  ["=Rw!A1", { kind: "rename", from: "Rw", to: "AB12" }, "='AB12'!A1", false],
  ["=Rw!A1+1", { kind: "deleteSheet", title: "Rw" }, "=Rw!A1+1", true, true],
  ['=INDIRECT("Rw!A3")', insertRows("Rw", 2), '=INDIRECT("Rw!A3")', false],
  ["=ROW(Rw!A3)", insertRows("Rw", 2), "=ROW(Rw!A4)", false],
  ["=LAMBDA(x, x + Rw!A3)(1)", insertRows("Rw", 2), "=LAMBDA(x, x + Rw!A4)(1)", false],
  ["=LET(r, Rw!A3, r * 2)", insertRows("Rw", 2), "=LET(r, Rw!A4, r * 2)", false],

  ["=O!A2:A", deleteRows("O", 1, 3), "=O!A1:A", true],
  ["=O!A2:B", deleteRows("O", 1, 3), "=O!A1:B", true],
  ["=O!C3:C", deleteRows("O", 1, 3), "=O!C1:C", true],
  ["=O!B2:C", deleteRows("O", 1, 3), "=O!B1:C", true],
  ["=O!B2:2", deleteRows("O", 1, 3), "=#REF!", true, true],
  ["=O!2:3", deleteRows("O", 1, 3), "=#REF!", true, true],
  ["=O!A:A", deleteRows("O", 1, 3), "=O!A:A", true],

  ["=O!A2:A", deleteRows("O", 5, 6), "=O!A2:A", true],
  ["=O!A2:B", deleteRows("O", 5, 6), "=O!A2:B", true],
  ["=O!C3:C", deleteRows("O", 5, 6), "=O!C3:C", true],
  ["=O!B2:C", deleteRows("O", 5, 6), "=O!B2:C", true],
  ["=O!B2:2", deleteRows("O", 5, 6), "=O!B2:2", false],
  ["=O!2:3", deleteRows("O", 5, 6), "=O!2:3", false],
  ["=O!A:A", deleteRows("O", 5, 6), "=O!A:A", true],

  ["=O!A2:B", insertColumns("O", "B"), "=O!A2:C", true],
  ["=O!B2:2", insertColumns("O", "B"), "=O!C2:2", false],
  ["=O!C3:C", insertColumns("O", "B"), "=O!D3:D", false],
  ["=O!B2:C", insertColumns("O", "B"), "=O!C2:D", false],
  ["=O!A2:A", insertColumns("O", "B"), "=O!A2:A", false],
  ["=O!A:A", insertColumns("O", "B"), "=O!A:A", false],
  ["=O!2:3", insertColumns("O", "B"), "=O!2:3", true],

  ["=O!A2:B", deleteColumns("O", "B"), "=O!A2:A", true],
  ["=O!C3:C", deleteColumns("O", "B"), "=O!B3:B", false],
  ["=O!B2:C", deleteColumns("O", "B"), "=O!B2:B", true],
  ["=O!B2:2", deleteColumns("O", "B"), "=O!B2:2", true],

  ["=O!A2:A", deleteColumns("O", "A"), "=#REF!", true, true],
  ["=O!A:A", deleteColumns("O", "A"), "=#REF!", true, true],
  ["=O!A2:B", deleteColumns("O", "A"), "=O!A2:A", true],
  ["=O!B2:2", deleteColumns("O", "A"), "=O!A2:2", false],
  ["=O!B2:C", deleteColumns("O", "A"), "=O!A2:B", false],

  ["=O!A2:B", deleteColumns("O", "A", "B"), "=#REF!", true, true],
  ["=O!B2:2", deleteColumns("O", "A", "B"), "=O!A2:2", true],
  ["=O!C3:C", deleteColumns("O", "A", "B"), "=O!A3:A", false],
  ["=O!B2:C", deleteColumns("O", "A", "B"), "=O!A2:A", true],

  // A row added after the last of the 10: open and whole-column ranges take it in.
  ["=O!A2:A", insertRows("O", 11), "=O!A2:A", true],
  ["=O!A2:B", insertRows("O", 11), "=O!A2:B", true],
  ["=O!C3:C", insertRows("O", 11), "=O!C3:C", true],
  ["=O!B2:C", insertRows("O", 11), "=O!B2:C", true],
  ["=O!B2:2", insertRows("O", 11), "=O!B2:2", false],
  ["=O!2:3", insertRows("O", 11), "=O!2:3", false],
  ["=O!A:A", insertRows("O", 11), "=O!A:A", true],
];

/** The rows of `ON_SHEET` whose formula is one reference. */
const SINGLE_REFERENCES = ON_SHEET.filter(([formula]) => tokenize(formula.slice(1)).length === 1);

/** A duplicate of "F" titled "F copy". */
const DUPLICATE: RewriteStep = { kind: "duplicate", title: "F", newTitle: "F copy" };

const UNCHANGED = { cellsChanged: false, broken: false };

describe("Sheets formulas through structural changes", () => {
  it.each(ON_SHEET)("rewrites %s on the sheet through %j", (formula, step, text, cellsChanged, broken = false) => {
    expect(rewriteFormula(formula, step, true)).toEqual({ text, cellsChanged, broken });
  });

  it.each(ELSEWHERE)("rewrites %s through %j", (formula, step, text, cellsChanged, broken = false) => {
    expect(rewriteFormula(formula, step, false)).toEqual({ text, cellsChanged, broken });
  });

  it("rewrites a reference naming the sheet from elsewhere as one on the sheet, ignoring case", () => {
    expect(SINGLE_REFERENCES.length).toBeGreaterThan(20);
    for (let [formula, step, text, cellsChanged, broken = false] of SINGLE_REFERENCES) {
      let body = formula.slice(1);
      let after = text === "=#REF!" ? text : `=Rw!${text.slice(1)}`;
      expect(rewriteFormula(`=Rw!${body}`, step, false), formula).toEqual({ text: after, cellsChanged, broken });
      expect(rewriteFormula(`='rw'!${body}`, step, false).text, formula)
        .toBe(text === "=#REF!" ? text : `='rw'!${text.slice(1)}`);
    }
  });

  it("leaves unqualified references off the sheet, and references to other sheets, as they are", () => {
    for (let [formula, step] of ON_SHEET) {
      expect(rewriteFormula(formula, step, false), formula).toEqual({ text: formula, ...UNCHANGED });
    }
    for (let [formula, step] of SINGLE_REFERENCES) {
      let other = `=Sales!${formula.slice(1)}`;
      expect(rewriteFormula(other, step, true), other).toEqual({ text: other, ...UNCHANGED });
    }
    expect(rewriteFormula("=SUM(A1:A3, Rw!A1:A3)", deleteRows("Rw", 1), false))
      .toEqual({ text: "=SUM(A1:A3, Rw!A1:A2)", cellsChanged: true, broken: false });
  });

  it("moves anchored corners, either end of a range typed bottom-up, and long column names", () => {
    expect(rewriteFormula("=$A$2:$B$5", deleteRows("Rw", 3), true).text).toBe("=$A$2:$B$4");
    expect(rewriteFormula("=B3:A2", insertRows("Rw", 3), true))
      .toEqual({ text: "=B4:A2", cellsChanged: true, broken: false });
    expect(rewriteFormula("=$A$1:A2", deleteRows("Rw", 2), true).text).toBe("=$A$1:A1");
    expect(rewriteFormula("=A:C", insertColumns("Rw", "AA", 2), true).text).toBe("=A:C");
    expect(rewriteFormula("=Z1", insertColumns("Rw", "A", 2), true).text).toBe("=AB1");
  });

  it("never touches string literals, INDIRECT text or error literals", () => {
    let formula = '=IF(ISERROR(#REF!), "A1:A3 Rw!B2", INDIRECT("Rw!A3")) & #N/A';
    for (let step of [insertRows("Rw", 1), deleteRows("Rw", 1, 5), deleteColumns("Rw", "A", "C")]) {
      expect(rewriteFormula(formula, step, true)).toEqual({ text: formula, ...UNCHANGED });
    }
    expect(rewriteFormula('="Rw!A1"', { kind: "rename", from: "Rw", to: "X" }, true).text).toBe('="Rw!A1"');
  });

  it("quotes a renamed sheet as Google quotes it, to and from quoted titles", () => {
    expect(rewriteFormula("='Probe Tab'!A1:B2 + 'probe tab'!C3", { kind: "rename", from: "Probe Tab", to: "Sales" }, false))
      .toEqual({ text: "=Sales!A1:B2 + Sales!C3", ...UNCHANGED });
    expect(rewriteFormula("='It''s'!A1 + Rw!A1", { kind: "rename", from: "It's", to: "Rw 2" }, false).text)
      .toBe("='Rw 2'!A1 + Rw!A1");
    for (let [title, quoted] of Object.entries(SHEET_TITLE_QUOTING)) {
      expect(rewriteFormula("=rw!B2:C3", { kind: "rename", from: "Rw", to: title }, false).text, title)
        .toBe(`=${quoted}!B2:C3`);
    }
    // An unqualified reference follows its sheet whatever its title.
    expect(rewriteFormula("=A1", { kind: "rename", from: "Rw", to: "X" }, true).text).toBe("=A1");
  });

  it("points a copy's references to the sheet copied at the copy, and nothing else", () => {
    expect(rewriteFormula("=F!B1", DUPLICATE, true)).toEqual({ text: "='F copy'!B1", ...UNCHANGED });
    expect(rewriteFormula("=B1 + Rw!A1 + f!C2:C", DUPLICATE, true).text).toBe("=B1 + Rw!A1 + 'F copy'!C2:C");
    expect(rewriteFormula("=F!B1", DUPLICATE, false)).toEqual({ text: "=F!B1", ...UNCHANGED });
  });

  it("breaks references to a deleted sheet, unqualified ones on it included", () => {
    let step: RewriteStep = { kind: "deleteSheet", title: "Rw" };
    expect(rewriteFormula("=A1", step, true)).toEqual({ text: "=A1", cellsChanged: true, broken: true });
    expect(rewriteFormula("=A1 + Sales!A1", step, false)).toEqual({ text: "=A1 + Sales!A1", ...UNCHANGED });
  });

  it("reads error literals as single tokens", () => {
    expect(tokenize("=#REF!+#DIV/0!&#n/a").filter(token => token.kind === "error").map(token => token.text))
      .toEqual(["#REF!", "#DIV/0!", "#n/a"]);
  });
});

describe("Sheets structure-sensitive formulas", () => {
  it("flags each listed function in any case and behind a prefix", () => {
    expect(STRUCTURE_SENSITIVE_FUNCTIONS.size).toBe(14);
    for (let name of STRUCTURE_SENSITIVE_FUNCTIONS) {
      expect(structureSensitive(`=1 + ${name}(A1)`), name).toBe(true);
      expect(structureSensitive(`=1 + ${name.toLowerCase()} (A1)`), name).toBe(true);
      expect(structureSensitive(`=_xlfn.${name}(A1)`), name).toBe(true);
    }
  });

  it("flags names that are not function calls", () => {
    expect(structureSensitive("=MyRange * 2")).toBe(true);
    expect(structureSensitive("=SUM(Totals)")).toBe(true);
    expect(structureSensitive("=Sales!Totals")).toBe(true);
  });

  it("leaves calls, constants, references, error literals and strings alone", () => {
    expect(structureSensitive("=SUM(A1:B2) + IF(TRUE, 1, false) + NORM.DIST(1, 0, 1, TRUE)")).toBe(false);
    expect(structureSensitive("='It''s'!A1 + Sales!B2:B + #REF! + #N/A + #DIV/0!")).toBe(false);
    expect(structureSensitive('="ROW(" & "MyRange"')).toBe(false);
    expect(structureSensitive("=ROWSUM(1)")).toBe(false);
  });

  it("flags a range whose ends are not one reference, and QUERY's lettered columns", () => {
    expect(structureSensitive("=SUM( A1 : A3 )")).toBe(true);
    expect(structureSensitive("=SUM(B1:INDEX(A5:A10, 1))")).toBe(true);
    expect(structureSensitive('=QUERY(Data!A1:C10, "select B where A > 1")')).toBe(true);
    expect(structureSensitive('="A1 : A3" & SUM(A1:A3)')).toBe(false);
  });
});
