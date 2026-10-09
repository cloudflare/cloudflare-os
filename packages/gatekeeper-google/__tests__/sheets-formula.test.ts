import { describe, expect, it } from "vitest";
import {
  canonicalFormula, compactFormula, refusedFunction, tokenize, type FormulaReference,
} from "../src/sheets-formula";
import { findSheet } from "../src/sheets-model";
import { FORMULA_CANONICALIZATION, FORMULA_SHEETS, WHITESPACE_DRIFT, sheet } from "./sheets-fixture";

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
