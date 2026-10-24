// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  CellError,
  EvaluationBudget,
  HyperlinkValue,
  type EngineModel,
  type Scalar,
  displayValue,
  formulaReferences,
  isErr,
  makeEngine,
  parseFormula,
  readableInk,
  serializeAst,
  shiftFormulaReferences,
  tokenize,
} from "../files/lib/formula.ts";

// A workbook for the engine: `Sheet1` from `cells`, plus any extra sheets by name.
function workbook(cells: Record<string, unknown>, extraSheets: Record<string, Record<string, unknown>> = {}): EngineModel {
  const model: EngineModel = { sheetOrder: ["s1"], sheets: { s1: { name: "Sheet1" } }, cells: { s1: {} } };
  for (const [ref, value] of Object.entries(cells)) model.cells.s1[ref] = { value: String(value) };
  for (const [name, sheetCells] of Object.entries(extraSheets)) {
    model.sheetOrder.push(name);
    model.sheets[name] = { name };
    model.cells[name] = {};
    for (const [ref, value] of Object.entries(sheetCells)) model.cells[name][ref] = { value: String(value) };
  }
  return model;
}

// What a cell shows as a plain value: an error as its text.
const plain = (value: Scalar) => (isErr(value) ? value.value : value);

// The review pass's battery: each formula is evaluated in column Z from row 50 down, over these cells.
const CELLS = { A1: 1, A2: 2, A3: 3, A4: "x", A5: "", B1: "TRUE", B2: "10%", B3: "1,000", C1: "", D1: "abc", D2: "Apple", D3: "banana", E1: "" };
const SHEETS = { Sheet2: { A1: 10, A2: 20 }, "My Sheet": { A1: "hi" } };
const BATTERY: [string, Scalar][] = [
  ["=A5=0", true], ['=A5=""', true], ["=C9=0", true], ["=C9=FALSE", true], ['=C9<"a"', true], ["=-2^2", 4], ["=2^3^2", 64],
  ["=SUM(A1:A4)", 6], ["=A1+A4", "#VALUE!"], ["=SUM(A1,A4)", 1], ["=COUNT(A1:A5)", 3], ["=COUNTA(A1:A5)", 4], ["=COUNTBLANK(A1:A5)", 1],
  ["=AVERAGE(A1:A3)", 2], ["=MAX(A9:A10)", 0], ['="10"=10', false], ["=TRUE>5", true], ['=1<"a"', true], ['="a"<TRUE', true],
  ["=ROUND(2.5,0)", 3], ["=ROUND(-2.5,0)", -3], ["=ROUND(1.005,2)", 1.01], ["=ROUND(1234.5,-2)", 1200], ["=MOD(-3,2)", 1], ["=MOD(3,-2)", -1],
  ["=INT(-1.5)", -2], ["=TRUNC(-1.5)", -1], ["=CEILING(2.1,1)", 3], ["=FLOOR(-2.1,1)", -3], ["=MROUND(5,2)", 6],
  ['=IF(A1,"y","n")', "y"], ['=IF(A5,"y","n")', "n"], ['=IFERROR(1/0,"e")', "e"], ["=1/0", "#DIV/0!"], ["=FOO(1)", "#NAME?"],
  ['=VLOOKUP("apple",D2:D3,1,FALSE)', "Apple"], ['=MATCH("banana",D1:D3,0)', 3], ["=INDEX(A1:A3,2)", 2],
  // "10%" is a number as typed, so INDEX reads 0.1.
  ["=INDEX(A1:B3,2,2)", 0.1],
  ['=LEFT("hello",2)', "he"], ['=MID("hello",2,3)', "ell"], ['=FIND("l","hello")', 3], ['=SUBSTITUTE("a-b-c","-","+")', "a+b+c"],
  ['=TEXT(0.256,"0.0%")', "25.6%"], ['=TEXT(1234.5,"#,##0.00")', "1,234.50"], ['=TEXT(45306,"yyyy-mm-dd")', "2024-01-15"], ['=TEXT(45306,"mmm d, yyyy")', "Jan 15, 2024"],
  ["=DATE(2024,1,15)", 45306], ["=DATE(2024,13,1)", 45658], ["=YEAR(45306)", 2024], ["=WEEKDAY(45306)", 2], ["=EOMONTH(45306,1)", 45351], ["=EDATE(45322,1)", 45351],
  ['=DATEDIF(45306,45700,"M")', 12], ['=DATEDIF(45306,45337,"M")', 1], ['=DATEDIF(45306,45336,"M")', 0],
  // 2024-01-15 to 2025-01-14 is one day short of a whole year.
  ['=DATEDIF(45306,45671,"Y")', 0], ['=DATEDIF(45306,45672,"Y")', 1], ['=DATEDIF(45306,45670,"Y")', 0],
  ["=B2*2", 0.2], ["=B3+1", 1001], ["=B1+1", 2], ["=SUM(B1:B3)", 1000.1], ["=50%", 0.5], ["=A1&A2", "12"], ['=TRUE&""', "TRUE"],
  ['=SUMIF(A1:A3,">1")', 5], ['=COUNTIF(D1:D3,"*an*")', 1], ['=COUNTIF(A1:A5,"")', 1], ["=SUMPRODUCT(A1:A3,A1:A3)", 14],
  // Its arguments are evaluated item by item; anything but a number (TRUE included) counts as 0.
  ["=SUMPRODUCT((A1:A3>1)*A1:A3)", 5], ["=SUMPRODUCT(--(A1:A3>1))", 2], ["=SUMPRODUCT(A1:A3>1)", 0], ["=SUMPRODUCT(A1:A3*2,A1:A3)", 28],
  ["=SUMPRODUCT((A1:A3>1)*A1:A4)", "#VALUE!"], ["=SUMPRODUCT(A1:A3/(A1:A3-2))", "#DIV/0!"],
  // Truncating at 15 digits: 4.35 * 100 is 434.99999999999994 in binary.
  ["=ROUND(2.4999999995,0)", 2], ["=ROUND(1.005,2)", 1.01], ["=ROUND(-2.5,0)", -3], ["=ROUNDDOWN(4.35,2)", 4.35], ["=TRUNC(4.35,2)", 4.35], ["=ROUNDDOWN(1.15*100,0)", 115], ["=ROUNDUP(0.1*3,1)", 0.3], ["=FLOOR(0.3,0.1)", 0.3], ["=CEILING(0.3,0.1)", 0.3],
  // An empty cell's value shows as 0, as in Excel.
  ["=Z1", 0], ["=A1:A3", 1], ["=SQRT(-1)", "#NUM!"], ["=LN(0)", "#NUM!"], ["=ABS(-3)", 3], ["=POWER(2,0.5)", Math.SQRT2],
  ["=MEDIAN(1,2,3,4)", 2.5], ["=STDEV(1,2,3,4)", 1.2909944487358056], ["=LARGE(A1:A3,1)", 3], ["=RANK(2,A1:A3)", 2],
  ["=AND(A1,A2)", true], ["=OR(A5)", false], ["=NOT(A5)", true], ["=ISBLANK(A5)", true], ["=ISBLANK(C9)", true], ["=ISNUMBER(B3)", true],
  ["=Sheet2!A1*2", 20], ["='My Sheet'!A1", "hi"], ["=SUM(Sheet2!A1:A2)", 30], ["=NoSheet!A1", "#REF!"],
  ["=HLOOKUP(2,A1:A3,1,FALSE)", "#N/A"], ["=VLOOKUP(2.5,A1:A3,1,TRUE)", 2], ["=VLOOKUP(0,A1:A3,1,TRUE)", "#N/A"],
  ['=CHOOSE(2,"a","b")', "b"], ["=LEN(A1)", 1], ['=PROPER("hello world")', "Hello World"], ['=TRIM("  a   b ")', "a b"],
  ["=1+", "#VALUE!"], ["=(1+2", 3], ["=SUM(1,2", 3], ["=E1", 0], ["=E1+1", 1], ['=E1&"x"', "x"],
  ["=MAX(B1:B3)", 1000], ["=MIN(D1:D3)", 0], ['=CONCAT("a",1,TRUE)', "a1TRUE"], ['=EXACT("a","A")', false],
  ["=NOW()>45000", true], ["=ROWS(A1:B3)", 3], ["=COLUMN(C5)", 3],
  ["=PERCENTILE(A1:A3,0.5)", 2], ["=MODE(1,2,2,3)", 2], ["=GCD(12,18)", 6], ["=LCM(4,6)", 12], ["=FACT(5)", 120],
  ["=XOR(TRUE,FALSE)", true], ['=SWITCH(2,1,"a",2,"b")', "b"], ['=IFS(A1>5,"a",A1>0,"b")', "b"],
  ["=TIME(12,30,0)", 0.5208333333333334], ["=TIME(27,0,0)", 0.125], ["=TIME(1.9,0,0)", 1 / 24], ["=TIME(0,0,-1)", "#NUM!"], ["=HOUR(0.75)", 18], ['=VALUE("1e3")', 1000], ['=N("x")', 0], ["=T(1)", ""],
  ["=WEEKNUM(45306)", 3], ["=DAYS(45337,45306)", 31], ['=REPT("ab",2)', "abab"], ['=SEARCH("L","hello")', 3],
  ['=HYPERLINK("javascript:alert(1)")', "#VALUE!"], ["=A1+", "#VALUE!"], ["=A1:5", "#VALUE!"], ["=ERRORTYPE(1/0)", 2],
];

describe("formula battery", () => {
  const cells: Record<string, unknown> = { ...CELLS };
  BATTERY.forEach(([formula], i) => { cells["Z" + (50 + i)] = formula; });
  cells.Y50 = "=ROW()";
  const engine = makeEngine(workbook(cells, SHEETS));

  it.each(BATTERY.map(([formula, want], i) => [formula, want, i] as const))("%s", (_formula, want, i) => {
    const got = plain(engine.computeRef("s1", "Z" + (50 + i)));
    if (typeof want === "number") {
      expect(typeof got).toBe("number");
      expect(got as number).toBeCloseTo(want, 9);
    } else if (want === null) {
      expect(got === null || got === "").toBe(true);
    } else {
      expect(got).toBe(want);
    }
  });

  it("ROW() is the formula's own row", () => {
    expect(engine.computeRef("s1", "Y50")).toBe(50);
  });
});

// Cases where a simple calculation differs from what Excel computes for the same formula; an
// exported workbook recalculates in Excel, so they must agree.
const EXCEL_CASES: [string, Scalar][] = [
  // Criteria compare numbers with numbers and text with text.
  ['=COUNTIF(F1:F5,">1")', 2], ['=SUMIF(F1:F5,"<5",G1:G5)', 5], ['=SUMIFS(G1:G5,F1:F5,">1")', 6], ['=COUNTIF(F1:F5,">a")', 1],
  // AVERAGEA counts text as 0 and booleans as 1 in references.
  ["=AVERAGEA(F1:F5)", 1.6], ["=AVERAGEA(F1,F4)", 2.5], ["=AVERAGEA(1,TRUE)", 1],
  // A single reference aggregates like a range; a direct value is coerced, else #VALUE!.
  ["=SUM(F2)", 0], ["=SUM(F3)", 0], ['=SUM("5",6)', 11], ['=SUM("x")', "#VALUE!"], ["=SUM((F1),1)", 6],
  ["=SUMPRODUCT(F1:F2,G1:G3)", "#VALUE!"],
  ['=COUNT(1,"2",TRUE,"x")', 3], ["=COUNT(F1:F5,F2,1/0)", 2],
  ["=ERROR.TYPE(1/0)", 2], ['=SEARCH("b?","abc")', 2], ['=SEARCH("~?","a?c")', 2], ['=SEARCH("*c","abc")', 1], ['=SEARCH("x","abc")', "#VALUE!"],
  // `;` only separates an array constant's rows.
  ["=SUM(1;2)", "#VALUE!"],
  ['=TEXT(-5,"0;(0)")', "(5)"], ['=TEXT(0,"0;-0;""zero""")', "zero"], ['=TEXT(5,"000")', "005"], ['=TEXT(0.5,"#.00")', ".50"], ['=TEXT(5,"#.##")', "5."],
  ['=TEXT(1234567,"#,##0,")', "1,235"], ['=TEXT(123456,"0.00E+00")', "1.23E+05"], ['=TEXT(0.000123,"0.0E+0")', "1.2E-4"], ['=TEXT(5551234,"000-0000")', "555-1234"],
  ['=TEXT(3,"0 ""items""")', "3 items"], ['=TEXT("abc","@")', "abc"], ['=TEXT("abc","0.0")', "abc"], ['=TEXT(5,"@")', "5"], ['=TEXT(12.5,"General")', "12.5"],
  ['=TEXT(-1234.5,"$#,##0.00")', "-$1,234.50"], ['=TEXT(0.75,"h:mm AM/PM")', "6:00 PM"],
];

describe("Excel semantics", () => {
  it("tokenizes unsupported characters for scanners instead of throwing", () => {
    expect(tokenize("SUM(Table1[Qty])").map((token) => token.v)).toContain("[");
    expect(() => parseFormula("SUM(Table1[Qty])")).toThrow();
  });
  const cells: Record<string, unknown> = { F1: 5, F2: "'5", F3: "TRUE", F4: "b", F5: 2, G1: 1, G2: 2, G3: 3, G4: 4, G5: 5 };
  EXCEL_CASES.forEach(([formula], i) => { cells["Z" + (1 + i)] = formula; });
  const engine = makeEngine(workbook(cells));
  it.each(EXCEL_CASES.map(([formula, want], i) => [formula, want, i] as const))("%s", (_formula, want, i) => {
    const got = plain(engine.computeRef("s1", "Z" + (1 + i)));
    if (typeof want === "number") expect(got as number).toBeCloseTo(want, 9);
    else expect(got).toBe(want);
  });
});

describe("parser", () => {
  it("keeps parentheses and quoting when written back", () => {
    for (const formula of ["(A1+B2)*2", "SUM(A1:B3,'My Sheet'!C4)", '"a""b"&C1', "-A1%", "IF((A1),1,2)"]) {
      expect(serializeAst(parseFormula(formula))).toBe(formula);
    }
  });

  it("is left-associative for ^ and binds unary minus tighter", () => {
    expect(serializeAst(parseFormula("2^3^2"))).toBe("2^3^2");
    expect(parseFormula("2^3^2")).toEqual({ k: "bin", op: "^", a: { k: "bin", op: "^", a: { k: "num", v: 2 }, b: { k: "num", v: 3 } }, b: { k: "num", v: 2 } });
  });

  it("rejects trailing tokens and range ends that aren't references", () => {
    expect(() => parseFormula("1 2")).toThrow(CellError);
    expect(() => parseFormula("A1:5")).toThrow(CellError);
  });
});

describe("reference scanning", () => {
  it("finds references outside quoted text, with sheet prefixes", () => {
    const refs = [...formulaReferences(`=SUM(A1:B2)+"C3"+'Owner''s Sheet'!D4+Sheet2!$E$5`)].map((ref) => ref.text);
    expect(refs).toEqual(["A1:B2", "'Owner''s Sheet'!D4", "Sheet2!$E$5"]);
  });

  it("ignores function names, out-of-bounds rows and identifiers", () => {
    expect([...formulaReferences("=LOG10(A1)+A50001+X1Y")].map((ref) => ref.text)).toEqual(["A1"]);
  });

  it("shifts relative parts only and writes #REF! past the edge", () => {
    expect(shiftFormulaReferences("=A1+$B$2+C$3+$D4", 1, 1)).toBe("=B2+$B$2+D$3+$D5");
    expect(shiftFormulaReferences("=A1+Sheet2!B2", -1, 0)).toBe("=#REF!+Sheet2!B1");
  });
});

describe("evaluation", () => {
  // Past a few hundred levels the engine suspends a chain and resumes it; COUNT mustn't treat that as a skipped argument.
  it("counts a reference at the end of a long chain", () => {
    const cells: Record<string, unknown> = { A1: 1, B1: "=COUNT(A500)" };
    for (let r = 2; r <= 500; r++) cells["A" + r] = `=A${r - 1}+1`;
    expect(makeEngine(workbook(cells)).computeRef("s1", "B1")).toBe(1);
  });
  it("reports cycles, and keeps evaluating a long chain without overflowing the stack", () => {
    const cells: Record<string, unknown> = { A1: "=A1+1", B1: 1 };
    for (let r = 2; r <= 5000; r++) cells["B" + r] = `=B${r - 1}+1`;
    const engine = makeEngine(workbook(cells));
    expect(plain(engine.computeRef("s1", "A1"))).toBe("#CYCLE!");
    expect(engine.computeRef("s1", "B5000")).toBe(5000);
  });

  it("recalculates only what an edit reaches", () => {
    const model = workbook({ A1: 1, A2: "=A1*2", A3: "=SUM(A1:A2)", B1: "=5" });
    const engine = makeEngine(model);
    expect(engine.computeRef("s1", "A3")).toBe(3);
    model.cells.s1.A1 = { value: "10" };
    expect(engine.invalidate([{ sheetId: "s1", ref: "A1" }])).toBe(true);
    expect(engine.computeRef("s1", "A2")).toBe(20);
    expect(engine.computeRef("s1", "A3")).toBe(30);
    expect(engine.computeRef("s1", "B1")).toBe(5);
  });

  it("throws EvaluationBudget once the read budget is spent", () => {
    const cells: Record<string, unknown> = {};
    for (let r = 1; r <= 100; r++) cells["A" + r] = r;
    cells.B1 = "=SUM(A1:A100)";
    const engine = makeEngine(workbook(cells), { work: 0, budget: 50 });
    expect(() => engine.computeRef("s1", "B1")).toThrow(EvaluationBudget);
  });

  it("returns links from HYPERLINK", () => {
    const value = makeEngine(workbook({ A1: '=HYPERLINK("https://example.com/","Ex")' })).computeRef("s1", "A1");
    expect(value).toBeInstanceOf(HyperlinkValue);
    expect(displayValue(value)).toEqual({ text: "Ex", link: "https://example.com/" });
  });
});

describe("displayValue", () => {
  it("formats numbers by number format", () => {
    expect(displayValue(1234.5, { nf: "currency" }).text).toBe("$1,234.50");
    expect(displayValue(-1234.5, { nf: "currency", d: 0 }).text).toBe("-$1,235");
    expect(displayValue(0.256, { nf: "percent", d: 1 }).text).toBe("25.6%");
    expect(displayValue(1012, { nf: "scientific" }).text).toBe("1.01E+03");
    expect(displayValue(45306, { nf: "date" }).text).toBe("01/15/2024");
    expect(displayValue(45306.75, { nf: "datetime" }).text).toBe("01/15/2024 6:00:00 PM");
    expect(displayValue(1 / 3).text).toBe("0.33333333333");
    expect(displayValue(1e12).text).toBe("1000000000000");
    // Excel's General form, which the exported workbook shows.
    expect(displayValue(1.5e-7).text).toBe("1.5E-07");
    expect(displayValue(12345678901234568).text).toBe("1.23457E+16");
    // #,##0 rounds half away from zero, as Excel does.
    expect(displayValue(-2.5, { nf: "integer" }).text).toBe("-3");
    expect(displayValue(2.5, { nf: "integer" }).text).toBe("3");
  });

  it("marks errors, booleans and links", () => {
    expect(displayValue(new CellError("#N/A"))).toEqual({ text: "#N/A", err: true });
    expect(displayValue(true)).toEqual({ text: "TRUE", center: true });
    expect(displayValue("https://example.com")).toEqual({ text: "https://example.com", link: "https://example.com/" });
    expect(displayValue("https://example.com", { nf: "text" })).toEqual({ text: "https://example.com" });
  });
});

describe("readableInk", () => {
  it("picks dark ink on light fills and light ink on dark ones", () => {
    expect(readableInk("#fbf0c2")).toBe("#1b1b1f");
    expect(readableInk("#2f3a4a")).toBe("#f4f4f5");
    expect(readableInk("#fff")).toBe("#1b1b1f");
    expect(readableInk("")).toBe("");
  });
});

// Each checked against Excel for the web (see the README's limitations for what still differs).
const EXCEL_WEB_CASES: [string, Scalar][] = [
  // Array constants: commas separate columns, semicolons rows.
  ['=LOOKUP(3,{1,2,3},{"x","y","z"})', "z"], ["=MATCH(5,{1,3,5})", 3], ["=LOOKUP(3,{1,2,3},{4,5,6})", 6], ['=MATCH("b",{"a","b"},0)', 2],
  ["={1,2;3,4}", 1], ['=SUM({1,"2",TRUE})', 1], ['=COUNTA({1,"",TRUE})', 3], ['=COUNT({1,"2",TRUE})', 1], ["=ROWS({1,2;3,4})", 2], ["=COLUMNS({1,2,3})", 3],
  ["=MAX({1,5,3})", 5], ['=HLOOKUP(2,{1,2;"a","b"},2,FALSE)', "b"], ["={1,2}+1", 2], ["=AVERAGE({1,2,3})", 2], ["={#N/A,1}", "#N/A"], ["=ISNA({#N/A})", true],
  ["={TRUE}", true], ["={-1,2.5E3}", -1], ["=SUMPRODUCT({1,2},{3,4})", 11], ["=INDEX({1,2;3,4},2)", 3], ["=INDEX({1,2;3,4},0,2)", 2], ["=INDEX({1,2;3,4},2,2)", 4],
  ['=VLOOKUP(2,{1,"a";3,"b"},2)', "a"], ["={1,2;3}", "#VALUE!"], ["={A1}", "#VALUE!"], ["={1+1}", "#VALUE!"], ["=IF(1,#N/A,2)", "#N/A"],
  // Powers.
  ["=POWER(-8,1/3)", -2], ["=(-8)^(1/3)", -2], ["=(-27)^(1/3)", -3], ["=POWER(-32,0.2)", -2], ["=POWER(-8,-1/3)", -0.5], ["=(-8)^(2/3)", "#NUM!"],
  ["=POWER(-2,0.5)", "#NUM!"], ["=0^0", "#NUM!"], ["=POWER(0,0)", "#NUM!"], ["=POWER(0,-1)", "#DIV/0!"], ["=0^-1", "#DIV/0!"],
  // Comparisons at 15 significant digits, and a whole-formula sum or difference without binary residue.
  ["=SQRT(2)^2=2", true], ["=0.1+0.2=0.3", true], ["=1+1E-15=1", true], ["=1+1E-14=1", false], ["=0.1+0.2>0.3", false], ["=0.3<0.1+0.2", false],
  ["=(0.1+0.2)<>0.3", false], ["=1/3*3=1", true], ["=MATCH(0.3,{0.1,0.2,0.30000000000000004},0)", 3], ["=0.1+0.2-0.3", 0], ["=123456789012345678=123456789012345600", true],
  // INDEX: row or column 0 is the whole column or row, intersected when shown on its own.
  ["=INDEX(B1:B5,0)", "#VALUE!"], ["=SUM(INDEX(B1:B5,0))", 25], ["=INDEX(B1:C5,2)", "#REF!"], ["=INDEX(B1:B5,-1)", "#VALUE!"], ["=INDEX(B1:B5,6)", "#REF!"],
  ["=SUM(INDEX(B1:C5,0,2))", 150], ["=INDEX(B1:C5,2,0)", "#VALUE!"], ["=INDEX(B1:B5,2)", 3],
  // Empty arguments.
  ["=IF(,1,2)", 2], ["=IF(1,)", 0], ["=IF(0,1,)", 0], ["=IF(TRUE,,1)", 0], ["=IFERROR(1/0,)", 0], ["=CHOOSE(2,1,)", 0], ["=COUNT(1,)", 2], ["=COUNTA(1,)", 2],
  ["=AVERAGE(1,)", 0.5], ["=MAX(-1,)", 0], ["=MIN(1,)", 0], ["=SUM(1,,2)", 3], ["=PRODUCT(2,)", 2], ["=AND(TRUE,)", false], ["=OR(FALSE,)", false],
  ['=CONCATENATE("a",,"b")', "ab"], ['=VLOOKUP(2,{1,"a";3,"b"},2,)', "#N/A"], ['=LEFT("abc",)', ""], ["=ROUND(2.5,)", 3], ['=MID("abc",2,)', ""],
  ['=COUNTA(1,"",A99)', 2], ["=B99", 0], ["=IF(1,B99)", 0], ['=B99&""', ""],
  // CHAR and CODE in Windows-1252.
  ["=CHAR(0)", "#VALUE!"], ["=CHAR(256)", "#VALUE!"], ["=CHAR(-1)", "#VALUE!"], ["=CHAR(128)", "€"], ["=CHAR(255)", "ÿ"], ["=CHAR(65.9)", "A"],
  ['=CODE("€")', 128], ["=CODE(CHAR(150))", 150], ['=CHAR(160)=" "', false],
  // Excel's 1900 serials, with its 29 February 1900.
  ["=DATE(1900,2,28)", 59], ["=DATE(1900,2,29)", 60], ["=DATE(1900,3,1)", 61], ["=DATE(1900,1,1)", 1], ["=DATE(1900,3,0)", 60], ["=DATE(24,1,15)", 8781],
  ["=YEAR(59)", 1900], ["=DAY(60)", 29], ["=MONTH(60)", 2], ['=TEXT(60,"yyyy-mm-dd")', "1900-02-29"], ['=TEXT(59,"yyyy-mm-dd")', "1900-02-28"],
  ['=TEXT(61,"yyyy-mm-dd")', "1900-03-01"], ["=DAY(0)", 0], ['=TEXT(0,"yyyy-mm-dd")', "1900-01-00"], ["=WEEKDAY(1)", 1], ["=WEEKDAY(59)", 3], ["=WEEKDAY(61)", 5],
  ['=DATEDIF(1,100,"d")', 99], ["=EOMONTH(1,1)", 59], ["=EDATE(31,1)", 59], ["=DATE(2024,1,15)", 45306],
  // Shown times round to the second.
  ['=TEXT(45306.999999,"mm/dd/yyyy")', "01/16/2024"], ['=TEXT(0.520833321759259,"h:mm:ss")', "12:30:00"], ['=TEXT(0.99999999,"h:mm:ss")', "0:00:00"],
];

describe("Excel for the web", () => {
  const cells: Record<string, unknown> = { B1: 1, B2: 3, B3: 5, B4: 7, B5: 9, C1: 10, C2: 20, C3: 30, C4: 40, C5: 50 };
  EXCEL_WEB_CASES.forEach(([formula], i) => { cells["Z" + (20 + i)] = formula; });
  // Implicit intersection: in row 3, a one-column range gives its row-3 cell.
  Object.assign(cells, { F3: "=INDEX(B1:B5,0)", G3: "=IF(1,B1:B5)", H3: "=B1:B5", I3: "=B1:B5*2", J3: "=ABS(B1:B5)", K30: "=B1:B5+1" });
  const engine = makeEngine(workbook(cells));
  it.each(EXCEL_WEB_CASES.map(([formula, want], i) => [formula, want, i] as const))("%s", (_formula, want, i) => {
    const got = plain(engine.computeRef("s1", "Z" + (20 + i)));
    if (typeof want === "number") { expect(typeof got).toBe("number"); expect(got as number).toBeCloseTo(want, 9); }
    else expect(got).toBe(want);
  });
  it("intersects a range with the formula's row, except a formula that is just a range", () => {
    expect(["F3", "G3", "H3", "I3", "J3", "K30"].map((ref) => plain(engine.computeRef("s1", ref)))).toEqual([5, 5, 1, 10, 5, "#VALUE!"]);
  });
  it("parses array constants and writes them back", () => {
    expect(parseFormula('{1,-2.5;"a""b",TRUE}')).toEqual({ k: "array", rows: [[1, -2.5], ['a"b', true]] });
    for (const formula of ['LOOKUP(3,{1,2,3},{"x","y","z"})', "SUM({1,2;3,4})", "IF(A1,,2)", "IF(1,)", "{#N/A,FALSE}"]) {
      expect(serializeAst(parseFormula(formula))).toBe(formula);
    }
    expect(() => parseFormula("{1,2")).toThrow();
    expect(() => parseFormula("{1,,2}")).toThrow();
  });
  it("leaves array constants alone when finding and shifting references", () => {
    expect([...formulaReferences("=SUM({1,2;3,4},A1)+{1E5}")].map((reference) => reference.text)).toEqual(["A1"]);
    expect(shiftFormulaReferences('=LOOKUP(B1,{1,2},{"A1","B2"})', 1, 1)).toBe('=LOOKUP(C2,{1,2},{"A1","B2"})');
  });
  it("reads a range whose end was deleted as #REF!", () => {
    expect(plain(makeEngine(workbook({ A1: "=SUM(#REF!:B2)" })).computeRef("s1", "A1"))).toBe("#REF!");
  });
  it("shows dates and times rounded to the second, and Excel's serials before March 1900", () => {
    expect(displayValue(0.520833321759259, { nf: "time" }).text).toBe("12:30:00 PM");
    expect(displayValue(45306.999999, { nf: "date" }).text).toBe("01/16/2024");
    expect(displayValue(45306.999999, { nf: "datetime" }).text).toBe("01/16/2024 12:00:00 AM");
    expect(displayValue(0.99999999, { nf: "time" }).text).toBe("12:00:00 AM");
    expect([59, 60, 61, 1].map((serial) => displayValue(serial, { nf: "date" }).text)).toEqual(["02/28/1900", "02/29/1900", "03/01/1900", "01/01/1900"]);
  });
});

describe("pathological inputs", () => {
  const compute = (formula: string, cells: Record<string, unknown> = {}) => plain(makeEngine(workbook({ ...cells, Z1: formula })).computeRef("s1", "Z1"));

  it("matches wildcards in linear time, as the regular expressions did", () => {
    const text = "a".repeat(5000);
    const started = Date.now();
    expect(compute(`=SEARCH("${"*a".repeat(12)}*b",A1)`, { A1: text })).toBe("#VALUE!");
    expect(compute(`=COUNTIF(A1,"${"*a".repeat(12)}*b")`, { A1: text })).toBe(0);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(compute('=SEARCH("b*d","abcd")')).toBe(2);
    expect(compute('=SEARCH("*c","abcd")')).toBe(1);
    expect(compute('=SEARCH("~*","a*b")')).toBe(2);
    expect(compute('=SEARCH("~","a~")')).toBe(2);
    expect(compute('=SEARCH("?","")')).toBe("#VALUE!");
    expect(compute('=SEARCH("","abc",2)')).toBe(2);
    expect(compute('=COUNTIF(A1:A3,"b?n*a")', { A1: "Banana", A2: "bandana", A3: "ban" })).toBe(2);
    expect(compute('=COUNTIF(A1:A2,"a*a")', { A1: "a", A2: "aa" })).toBe(1);
    expect(compute('=MATCH("*an?",A1:A3,0)', { A1: "x", A2: "Plant", A3: "ant" })).toBe(2);
  });

  it("refuses text longer than Excel's 32,767 characters instead of building it", () => {
    expect(compute('=LEN(REPT("ab",16383))')).toBe(32766);
    expect(compute('=REPT("ab",16384)')).toBe("#VALUE!");
    expect(compute('=REPT("",1E+300)')).toBe("");
    expect(compute("=A1&A1", { A1: "x".repeat(20000) })).toBe("#VALUE!");
    expect(compute('=SUBSTITUTE(A1,"a",A1)', { A1: "a".repeat(8000) })).toBe("#VALUE!");
    expect(compute("=CONCAT(A1:A5)", { A1: "x".repeat(8000), A2: "x".repeat(8000), A3: "x".repeat(8000), A4: "x".repeat(8000), A5: "x".repeat(8000) })).toBe("#VALUE!");
    expect(compute('=TEXTJOIN("-",TRUE,A1:A2)', { A1: "a", A2: "b" })).toBe("a-b");
  });

  it("answers FACT past 170 at once, and MAX/MIN over ranges too big to spread", () => {
    expect(compute("=FACT(1E+9)")).toBe("#NUM!");
    expect(compute("=FACT(170)")).toBeGreaterThan(1e306);
    const cells: Record<string, unknown> = {};
    for (let r = 1; r <= 130000; r++) cells["A" + r] = r % 1000;
    expect(compute("=MAX(A1:A130000)", cells)).toBe(999);
    expect(compute("=MIN(A1:A130000,-1)", cells)).toBe(-1);
    expect(compute("=MAX(-5,-2)")).toBe(-2);
  });
});
