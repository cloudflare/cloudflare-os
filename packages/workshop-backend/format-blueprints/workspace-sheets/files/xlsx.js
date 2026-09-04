import { createZip } from "./zip.js";

const encoder = new TextEncoder();
const MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const MAX_ROWS = 1048576;
const MAX_COLUMNS = 16384;
const DEFAULT_ROWS = 100;
const DEFAULT_COLUMNS = 26;
const DEFAULT_ROW_PIXELS = 24;
const DEFAULT_COLUMN_PIXELS = 92;
const MAX_FONTS = 512;
const MAX_FILLS = 256;
const MAX_CELL_FORMATS = 65490;
const MAX_FORMULA_CHARACTERS = 8192;
const TEXT_CHUNK_SIZE = 64 * 1024;
const FUTURE_FUNCTIONS = new Set([
  "CONCAT", "DAYS", "IFNA", "IFS", "SWITCH", "TEXTJOIN", "UNICHAR", "UNICODE", "XOR",
]);

function spreadsheetXml(value, attribute = false) {
  const input = String(value).replace(/_x[0-9a-f]{4}_/gi, (match) => "_x005F_" + match.slice(1));
  let clean = "";
  for (let i = 0; i < input.length; ++i) {
    const code = input.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = input.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) clean += input[i] + input[++i];
      else clean += "_xFFFD_";
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      clean += "_xFFFD_";
    } else if (code === 13) {
      clean += "_x000D_";
    } else if (code === 9 || code === 10 ||
        (code >= 0x20 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd)) {
      clean += input[i];
    } else {
      clean += `_x${code.toString(16).toUpperCase().padStart(4, "0")}_`;
    }
  }
  clean = clean.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  if (attribute) clean = clean.replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  return clean;
}

function formulaXml(value) {
  const input = String(value);
  let clean = "";
  for (let i = 0; i < input.length; ++i) {
    const code = input.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = input.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) clean += input[i] + input[++i];
      else clean += String.fromCharCode(0xfffd);
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      clean += String.fromCharCode(0xfffd);
    } else if (code === 9 || code === 10 || code === 13 ||
        (code >= 0x20 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd)) {
      clean += input[i];
    } else {
      clean += String.fromCharCode(0xfffd);
    }
  }
  return clean.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\r/g, "&#13;");
}

function xmlAttribute(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

// Encodes a string generator into ~64 KiB byte chunks. Cell-sized chunks would make the ZIP's
// CompressionStream the bottleneck. `highWaterMark: 0` keeps generation lazy until the archive
// reaches this part.
function textStream(generator) {
  return new ReadableStream({
    pull(controller) {
      const parts = [];
      let length = 0;
      while (length < TEXT_CHUNK_SIZE) {
        const result = generator.next();
        if (result.done) {
          if (parts.length) controller.enqueue(encoder.encode(parts.join("")));
          controller.close();
          return;
        }
        parts.push(result.value);
        length += result.value.length;
      }
      controller.enqueue(encoder.encode(parts.join("")));
    },
    cancel(reason) {
      generator.return(reason);
    },
  }, {highWaterMark: 0});
}

function count(value, fallback, maximum) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.max(1, Math.min(maximum, number));
}

function frozenCount(value, maximum) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(50, maximum, number));
}

function truncateSheetName(value, length) {
  const input = value.slice(0, length);
  let result = "";
  for (let i = 0; i < input.length; ++i) {
    const code = input.charCodeAt(i);
    if (code < 32 || (code >= 127 && code <= 159)) {
      result += "_";
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const low = input.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) result += input[i] + input[++i];
      else result += "_";
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      result += "_";
    } else {
      result += input[i];
    }
  }
  return result;
}

function safeSheetName(value) {
  let name = String(value ?? "").replace(/[:\\/?*\[\]]/g, "_").trim();
  name = truncateSheetName(name, 31);
  if (name.startsWith("'")) name = "_" + name.slice(1);
  if (name.endsWith("'")) name = name.slice(0, -1) + "_";
  if (name.toLowerCase() === "history") name += "_";
  return name || "Sheet";
}

function assignSheetNames(sheets) {
  const used = new Set();
  // Next unused suffix per truncated stem (keyed with the suffix's digit count, since the stem
  // shrinks to make room), so N same-named sheets take O(N) probes rather than O(N²).
  const nextSuffixes = new Map();
  for (const sheet of sheets) {
    const base = safeSheetName(sheet.sourceName);
    let name = base;
    let suffix = 2;
    while (used.has(name.toLowerCase())) {
      const digits = String(suffix).length;
      const stem = truncateSheetName(base, 28 - digits);
      const key = `${stem.toLowerCase()}|${digits}`;
      const next = nextSuffixes.get(key) ?? suffix;
      if (next > suffix) {
        suffix = next;
        continue;
      }
      name = `${stem} (${suffix})`;
      nextSuffixes.set(key, ++suffix);
    }
    used.add(name.toLowerCase());
    sheet.name = name;
  }
}

function parseCellReference(reference) {
  const match = /^([A-Z]+)([1-9]\d*)$/.exec(reference);
  if (!match) return null;
  let column = 0;
  for (const character of match[1]) {
    column = column * 26 + character.charCodeAt(0) - 64;
    if (column > MAX_COLUMNS) return null;
  }
  const row = Number(match[2]);
  if (!Number.isSafeInteger(row) || row > MAX_ROWS) return null;
  return {row, column};
}

function columnName(column) {
  let name = "";
  for (let value = column; value > 0; value = Math.floor((value - 1) / 26)) {
    name = String.fromCharCode(65 + (value - 1) % 26) + name;
  }
  return name;
}

function pixelDimension(value) {
  const pixels = Math.round(Number(value));
  return Number.isFinite(pixels) && pixels >= 8 && pixels <= 2000 ? pixels : null;
}

function rowPoints(pixels) {
  return String(Math.min(409, Math.round(pixels * 75) / 100));
}

function columnWidth(pixels) {
  return String(Math.min(255, Math.round(Math.max(0, (pixels - 5) / 7) * 256) / 256));
}

function dimensions(source, maximum, convert) {
  const result = [];
  if (!source || typeof source !== "object") return result;
  for (const [key, value] of Object.entries(source)) {
    if (!/^(0|[1-9]\d*)$/.test(key)) continue;
    const index = Number(key);
    const pixels = pixelDimension(value);
    if (!Number.isSafeInteger(index) || index < 0 || index >= maximum || pixels == null) continue;
    result.push({index, value: convert(pixels)});
  }
  result.sort((a, b) => a.index - b.index);
  return result;
}

function xlsxColor(value) {
  if (typeof value !== "string") return null;
  const hex = value.slice(1);
  if (!value.startsWith("#") || ![3, 4, 6, 8].includes(hex.length) || !/^[0-9a-f]+$/i.test(hex)) return null;
  if (hex.length === 3) return "FF" + Array.from(hex, character => character + character).join("").toUpperCase();
  if (hex.length === 4) {
    const [r, g, b, a] = Array.from(hex, character => character + character);
    return (a + r + g + b).toUpperCase();
  }
  if (hex.length === 6) return "FF" + hex.toUpperCase();
  return (hex.slice(6) + hex.slice(0, 6)).toUpperCase();
}

function decimals(fmt) {
  if (fmt?.d == null) return null;
  const value = Math.round(Number(fmt?.d));
  return Number.isFinite(value) && value >= 0 && value <= 10 ? value : null;
}

function decimalPattern(value) {
  return value ? "." + "0".repeat(value) : "";
}

class Styles {
  constructor() {
    this.fonts = [{size: 11}];
    this.fontIds = new Map();
    this.fills = [null, {gray125: true}];
    this.fillIds = new Map();
    this.numberFormats = [];
    this.numberFormatIds = new Map();
    this.alignments = [null];
    this.alignmentIds = new Map();
    this.cellFormats = [{fontId: 0, fillId: 0, numberFormatId: 0, alignmentId: 0}];
    this.cellFormatIds = new Map();
  }

  font(fmt) {
    const color = xlsxColor(fmt?.c);
    const pixels = Math.round(Number(fmt?.fs));
    // The grid renders `fs` in CSS pixels; Excel font sizes are points.
    const size = Number.isFinite(pixels) && pixels >= 6 && pixels <= 96 ? pixels * 0.75 : null;
    const font = {
      bold: Boolean(fmt?.b), italic: Boolean(fmt?.i), underline: Boolean(fmt?.u),
      strike: Boolean(fmt?.s), color, size,
    };
    if (!font.bold && !font.italic && !font.underline && !font.strike && !font.color && !font.size) return 0;
    const key = JSON.stringify(font);
    let id = this.fontIds.get(key);
    if (id == null) {
      if (this.fonts.length >= MAX_FONTS) throw new Error("XLSX font count exceeds Excel's limit of 512.");
      id = this.fonts.length;
      this.fontIds.set(key, id);
      this.fonts.push(font);
    }
    return id;
  }

  fill(fmt) {
    const color = xlsxColor(fmt?.bg);
    if (!color) return 0;
    let id = this.fillIds.get(color);
    if (id == null) {
      if (this.fills.length >= MAX_FILLS) throw new Error("XLSX fill count exceeds Excel's limit of 256.");
      id = this.fills.length;
      this.fillIds.set(color, id);
      this.fills.push({color});
    }
    return id;
  }

  customNumberFormat(code) {
    let id = this.numberFormatIds.get(code);
    if (id == null) {
      if (164 + this.numberFormats.length > 0xffff) {
        throw new Error("XLSX number format count exceeds the format ID limit of 65,535.");
      }
      id = 164 + this.numberFormats.length;
      this.numberFormatIds.set(code, id);
      this.numberFormats.push({id, code});
    }
    return id;
  }

  numberFormat(fmt) {
    const places = decimals(fmt);
    const name = fmt?.nf;
    if (name === "text") return 49;
    if (name === "integer") return this.customNumberFormat("#,##0");
    if (name === "number") return this.customNumberFormat("#,##0" + decimalPattern(places ?? 2));
    if (name === "currency") {
      const pattern = '"$"#,##0' + decimalPattern(places ?? 2);
      return this.customNumberFormat(pattern + ";-" + pattern);
    }
    if (name === "percent") return this.customNumberFormat("#,##0" + decimalPattern(places ?? 2) + "%");
    if (name === "scientific") return this.customNumberFormat("0" + decimalPattern(places ?? 2) + "E+00");
    if (name === "date") return this.customNumberFormat("mm/dd/yyyy");
    if (name === "time") return this.customNumberFormat("h:mm:ss AM/PM");
    if (name === "datetime") return this.customNumberFormat("mm/dd/yyyy h:mm:ss AM/PM");
    if (name != null) return 0;
    return places == null ? 0 : this.customNumberFormat("0" + decimalPattern(places));
  }

  alignment(fmt) {
    const horizontal = fmt?.a === "l" ? "left" : fmt?.a === "c" ? "center" : fmt?.a === "r" ? "right" : null;
    const wrap = Boolean(fmt?.wrap);
    if (!horizontal && !wrap) return 0;
    const key = `${horizontal || ""}|${wrap}`;
    let id = this.alignmentIds.get(key);
    if (id == null) {
      id = this.alignments.length;
      this.alignmentIds.set(key, id);
      this.alignments.push({horizontal, wrap});
    }
    return id;
  }

  style(fmt) {
    if (!fmt || typeof fmt !== "object") return 0;
    const cellFormat = {
      fontId: this.font(fmt), fillId: this.fill(fmt), numberFormatId: this.numberFormat(fmt),
      alignmentId: this.alignment(fmt),
    };
    if (!cellFormat.fontId && !cellFormat.fillId && !cellFormat.numberFormatId && !cellFormat.alignmentId) return 0;
    const key = `${cellFormat.fontId}|${cellFormat.fillId}|${cellFormat.numberFormatId}|${cellFormat.alignmentId}`;
    let id = this.cellFormatIds.get(key);
    if (id == null) {
      if (this.cellFormats.length >= MAX_CELL_FORMATS) {
        throw new Error("XLSX cell format count exceeds Excel's limit of 65,490.");
      }
      id = this.cellFormats.length;
      this.cellFormatIds.set(key, id);
      this.cellFormats.push(cellFormat);
    }
    return id;
  }
}

function sourceSheets(document) {
  const result = [];
  const seen = new Set();
  const order = Array.isArray(document?.sheetOrder) ? document.sheetOrder : [];
  const sheetMap = document?.sheets && typeof document.sheets === "object" ? document.sheets : {};
  const cellMap = document?.cells && typeof document.cells === "object" ? document.cells : {};
  for (const rawId of order) {
    const id = String(rawId);
    if (seen.has(id)) continue;
    seen.add(id);
    const metadata = sheetMap[id];
    if (!metadata || typeof metadata !== "object") continue;
    result.push({
      id,
      sourceName: typeof metadata.name === "string" ? metadata.name : "Sheet",
      metadata,
      sourceCells: cellMap[id] && typeof cellMap[id] === "object" ? cellMap[id] : {},
    });
  }
  if (!result.length) result.push({id: "", sourceName: "Sheet", metadata: {}, sourceCells: {}});
  assignSheetNames(result);
  return result;
}

function prepareWorkbook(document) {
  const sheets = sourceSheets(document);
  const formulaNames = new Map();
  for (const sheet of sheets) {
    const key = sheet.sourceName.toLowerCase();
    if (!formulaNames.has(key)) formulaNames.set(key, sheet.name);
  }
  const styles = new Styles();
  for (const sheet of sheets) {
    sheet.rows = count(sheet.metadata.rows, DEFAULT_ROWS, MAX_ROWS);
    sheet.columns = count(sheet.metadata.cols, DEFAULT_COLUMNS, MAX_COLUMNS);
    sheet.frozenRows = frozenCount(sheet.metadata.frozenRows, sheet.rows);
    sheet.frozenColumns = frozenCount(sheet.metadata.frozenCols, sheet.columns);
    sheet.columnWidths = dimensions(sheet.metadata.colWidths, sheet.columns, columnWidth);
    sheet.rowHeights = dimensions(sheet.metadata.rowHeights, sheet.rows, rowPoints);
    sheet.cells = [];
    for (const [reference, sourceCell] of Object.entries(sheet.sourceCells)) {
      const position = parseCellReference(reference);
      if (!position || !sourceCell || typeof sourceCell !== "object") continue;
      const style = styles.style(sourceCell.fmt);
      const value = sourceCell.value == null ? "" : String(sourceCell.value);
      if (value === "" && !style) continue;
      sheet.cells.push({reference, ...position, value, style});
    }
    delete sheet.sourceCells;
    sheet.cells.sort((a, b) => a.row - b.row || a.column - b.column);
  }
  return {sheets, styles, formulaNames};
}

function formulaReferenceAt(formula, offset) {
  const match = /^\$?([A-Za-z]{1,3})\$?([1-9]\d*)/.exec(formula.slice(offset));
  if (!match) return false;
  let column = 0;
  for (const character of match[1].toUpperCase()) column = column * 26 + character.charCodeAt(0) - 64;
  if (column > MAX_COLUMNS || Number(match[2]) > MAX_ROWS) return false;
  const next = formula[offset + match[0].length];
  return !next || !/[A-Za-z0-9_$]/.test(next);
}

function quotedSheetReference(formula, offset, names) {
  const nameParts = [];
  for (let i = offset + 1; i < formula.length; ++i) {
    if (formula[i] !== "'") {
      nameParts.push(formula[i]);
      continue;
    }
    if (formula[i + 1] === "'") {
      nameParts.push("'");
      ++i;
      continue;
    }
    const quoteEnd = i + 1;
    const hasBang = formula[quoteEnd] === "!";
    const end = quoteEnd + (hasBang ? 1 : 0);
    const text = formula.slice(offset, end);
    const name = nameParts.join("");
    const normalized = names.get(name.toLowerCase());
    const malformed = offset > 0 && /[A-Za-z0-9_.$]/.test(formula[offset - 1]);
    const external = formula[offset - 1] === "]" || (!normalized && /\[[^\]]*\]/.test(name));
    if (!hasBang || !formulaReferenceAt(formula, end) || malformed || external ||
        isThreeDimensionalReference(formula, offset)) return {end, text};
    return normalized
      ? {end, text: `'${normalized.replace(/'/g, "''")}'!`}
      : {end, text};
  }
  return null;
}

function unquotedSheetReference(formula, offset, names) {
  if (!/[A-Za-z_$]/.test(formula[offset]) ||
      (offset > 0 && /[A-Za-z0-9_.$]/.test(formula[offset - 1])) ||
      formula[offset - 1] === "]" || isThreeDimensionalReference(formula, offset)) return null;
  let end = offset + 1;
  while (end < formula.length && /[A-Za-z0-9_.$]/.test(formula[end])) ++end;
  if (formula[end] !== "!" || !formulaReferenceAt(formula, end + 1)) return null;
  const name = formula.slice(offset, end);
  const normalized = names.get(name.toLowerCase());
  if (!normalized) return null;
  if (normalized.toLowerCase() === name.toLowerCase()) {
    return {end: end + 1, text: formula.slice(offset, end + 1)};
  }
  return {end: end + 1, text: `'${normalized.replace(/'/g, "''")}'!`};
}

function isThreeDimensionalReference(formula, offset) {
  if (formula[offset - 1] !== ":") return false;
  let start = offset - 2;
  while (start >= 0 && /[A-Za-z0-9_$]/.test(formula[start])) --start;
  const preceding = formula.slice(start + 1, offset - 1);
  return !/^\$?[A-Za-z]{1,3}\$?[1-9]\d*$/.test(preceding);
}

// Recognizes a function call at `offset`. The grid's tokenizer discards whitespace, so it accepts
// `SUM (1)`; in Excel that space is the intersection operator, so the gap is dropped here.
function formulaFunctionAt(formula, offset) {
  if (!/[A-Za-z_]/.test(formula[offset]) ||
      (offset > 0 && /[A-Za-z0-9_.$!]/.test(formula[offset - 1]))) return null;
  let end = offset + 1;
  while (end < formula.length && /[A-Za-z0-9_.]/.test(formula[end])) ++end;
  let parenthesis = end;
  while (parenthesis < formula.length && /\s/.test(formula[parenthesis])) ++parenthesis;
  if (formula[parenthesis] !== "(") return null;
  const name = formula.slice(offset, end).toUpperCase();
  if (FUTURE_FUNCTIONS.has(name)) return {end: parenthesis, text: "_xlfn." + name};
  if (name === "ERRORTYPE") return {end: parenthesis, text: "ERROR.TYPE"};
  return parenthesis > end ? {end: parenthesis, text: formula.slice(offset, end)} : null;
}

// Rewrites sheet and function names for Excel. Returns null when the formula is unbalanced
// (unterminated string or quoted name, mismatched parentheses or brackets): the grid's parser
// tolerates those, but one such `<f>` makes Excel report the whole workbook as damaged.
function rewriteFormula(formula, names) {
  const result = [];
  let stringLiteral = false;
  let parentheses = 0;
  let structuredReferenceDepth = 0;
  for (let i = 0; i < formula.length;) {
    const character = formula[i];
    if (character === '"') {
      result.push(character);
      if (stringLiteral && formula[i + 1] === '"') {
        result.push(formula[i + 1]);
        i += 2;
        continue;
      }
      stringLiteral = !stringLiteral;
      ++i;
      continue;
    }
    if (!stringLiteral) {
      let apostrophes = 0;
      if (structuredReferenceDepth && (character === "[" || character === "]")) {
        for (let j = i - 1; formula[j] === "'"; --j) ++apostrophes;
      }
      const escapedBracket = apostrophes % 2 === 1;
      if (character === "[" && !escapedBracket) ++structuredReferenceDepth;
      else if (character === "]" && !escapedBracket && --structuredReferenceDepth < 0) return null;
      if (!structuredReferenceDepth) {
        if (character === "(") ++parentheses;
        else if (character === ")" && --parentheses < 0) return null;
        const reference = character === "'"
          ? quotedSheetReference(formula, i, names)
          : formulaFunctionAt(formula, i) || unquotedSheetReference(formula, i, names);
        if (character === "'" && !reference) return null;
        if (reference) {
          result.push(reference.text);
          i = reference.end;
          continue;
        }
      }
    }
    result.push(character);
    ++i;
  }
  return stringLiteral || parentheses || structuredReferenceDepth ? null : result.join("");
}

function parsedCellValue(value, formulaNames) {
  if (value[0] === "'") return {type: "text", value: value.slice(1)};
  if (value[0] === "=") {
    const formula = rewriteFormula(value.slice(1), formulaNames);
    // Excel also rejects empty formulas and those over its length limit; keep the stored text.
    return formula && formula.trim() && formula.length < MAX_FORMULA_CHARACTERS
      ? {type: "formula", value: formula}
      : {type: "text", value};
  }
  const trimmed = value.trim();
  if (trimmed === "") return {type: "blank", value: ""};
  if (/^(TRUE|FALSE)$/i.test(trimmed)) return {type: "boolean", value: /^true$/i.test(trimmed)};
  if (/^[-+]?\$?[\d,]*\.?\d+%?$/.test(trimmed) && /\d/.test(trimmed)) {
    const negative = trimmed.startsWith("-");
    const cleaned = trimmed.replace(/[$,+%-]/g, "");
    let number = Number(cleaned);
    if (Number.isFinite(number)) {
      if (trimmed.endsWith("%")) number /= 100;
      return {type: "number", value: negative ? -number : number};
    }
  }
  return {type: "text", value};
}

function cellXml(cell, formulaNames) {
  const style = cell.style ? ` s="${cell.style}"` : "";
  if (cell.value === "") return `<c r="${cell.reference}"${style}/>`;
  const parsed = parsedCellValue(cell.value, formulaNames);
  if (parsed.type === "blank") return `<c r="${cell.reference}"${style}/>`;
  if (parsed.type === "formula") return `<c r="${cell.reference}"${style}><f>${formulaXml(parsed.value)}</f></c>`;
  if (parsed.type === "boolean") return `<c r="${cell.reference}"${style} t="b"><v>${parsed.value ? 1 : 0}</v></c>`;
  if (parsed.type === "number") return `<c r="${cell.reference}"${style}><v>${String(parsed.value)}</v></c>`;
  return `<c r="${cell.reference}"${style} t="inlineStr"><is><t xml:space="preserve">${spreadsheetXml(parsed.value)}</t></is></c>`;
}

function frozenPane(sheet) {
  const rows = sheet.frozenRows;
  const columns = sheet.frozenColumns;
  if (!rows && !columns) return "";
  const attributes = [];
  if (columns) attributes.push(`xSplit="${columns}"`);
  if (rows) attributes.push(`ySplit="${rows}"`);
  attributes.push(`topLeftCell="${columnName(columns + 1)}${rows + 1}"`);
  attributes.push(`activePane="${rows && columns ? "bottomRight" : rows ? "bottomLeft" : "topRight"}"`);
  attributes.push('state="frozen"');
  return `<pane ${attributes.join(" ")}/>`;
}

function worksheetDimension(cells) {
  if (!cells.length) return "A1";
  let minRow = MAX_ROWS, minColumn = MAX_COLUMNS, maxRow = 1, maxColumn = 1;
  for (const cell of cells) {
    minRow = Math.min(minRow, cell.row);
    minColumn = Math.min(minColumn, cell.column);
    maxRow = Math.max(maxRow, cell.row);
    maxColumn = Math.max(maxColumn, cell.column);
  }
  const first = columnName(minColumn) + minRow;
  const last = columnName(maxColumn) + maxRow;
  return first === last ? first : first + ":" + last;
}

function* worksheetXml(sheet, formulaNames) {
  yield `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${MAIN_NS}">`;
  yield `<dimension ref="${worksheetDimension(sheet.cells)}"/>`;
  yield `<sheetViews><sheetView workbookViewId="0">${frozenPane(sheet)}</sheetView></sheetViews>`;
  yield `<sheetFormatPr defaultColWidth="${columnWidth(DEFAULT_COLUMN_PIXELS)}" defaultRowHeight="${rowPoints(DEFAULT_ROW_PIXELS)}"/>`;
  if (sheet.columnWidths.length) {
    yield "<cols>";
    for (const width of sheet.columnWidths) {
      yield `<col min="${width.index + 1}" max="${width.index + 1}" width="${width.value}" customWidth="1"/>`;
    }
    yield "</cols>";
  }
  yield "<sheetData>";
  let cellIndex = 0;
  let heightIndex = 0;
  while (cellIndex < sheet.cells.length || heightIndex < sheet.rowHeights.length) {
    const cellRow = sheet.cells[cellIndex]?.row ?? Infinity;
    const heightRow = (sheet.rowHeights[heightIndex]?.index ?? Infinity) + 1;
    const row = Math.min(cellRow, heightRow);
    const height = heightRow === row ? sheet.rowHeights[heightIndex++] : null;
    yield `<row r="${row}"${height ? ` ht="${height.value}" customHeight="1"` : ""}>`;
    while (sheet.cells[cellIndex]?.row === row) yield cellXml(sheet.cells[cellIndex++], formulaNames);
    yield "</row>";
  }
  yield "</sheetData></worksheet>";
}

function* stylesXml(styles) {
  yield `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="${MAIN_NS}">`;
  if (styles.numberFormats.length) {
    yield `<numFmts count="${styles.numberFormats.length}">`;
    for (const format of styles.numberFormats) yield `<numFmt numFmtId="${format.id}" formatCode="${xmlAttribute(format.code)}"/>`;
    yield "</numFmts>";
  }
  yield `<fonts count="${styles.fonts.length}">`;
  for (const font of styles.fonts) {
    yield "<font>";
    if (font.bold) yield "<b/>";
    if (font.italic) yield "<i/>";
    if (font.underline) yield "<u/>";
    if (font.strike) yield "<strike/>";
    yield `<sz val="${font.size || 11}"/>`;
    if (font.color) yield `<color rgb="${font.color}"/>`;
    yield '<name val="Calibri"/><family val="2"/><scheme val="minor"/></font>';
  }
  yield "</fonts>";
  yield `<fills count="${styles.fills.length}"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>`;
  for (let i = 2; i < styles.fills.length; ++i) {
    yield `<fill><patternFill patternType="solid"><fgColor rgb="${styles.fills[i].color}"/><bgColor indexed="64"/></patternFill></fill>`;
  }
  yield "</fills>";
  yield '<borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>';
  yield `<cellXfs count="${styles.cellFormats.length}">`;
  for (const format of styles.cellFormats) {
    const alignment = styles.alignments[format.alignmentId];
    let attributes = `numFmtId="${format.numberFormatId}" fontId="${format.fontId}" fillId="${format.fillId}" borderId="0" xfId="0"`;
    if (format.numberFormatId) attributes += ' applyNumberFormat="1"';
    if (format.fontId) attributes += ' applyFont="1"';
    if (format.fillId) attributes += ' applyFill="1"';
    if (alignment) attributes += ' applyAlignment="1"';
    if (!alignment) {
      yield `<xf ${attributes}/>`;
      continue;
    }
    const alignmentAttributes = [];
    if (alignment.horizontal) alignmentAttributes.push(`horizontal="${alignment.horizontal}"`);
    if (alignment.wrap) alignmentAttributes.push('wrapText="1"');
    yield `<xf ${attributes}><alignment ${alignmentAttributes.join(" ")}/></xf>`;
  }
  yield '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
}

function contentTypes(sheetCount) {
  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  xml += '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">';
  xml += '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>';
  xml += '<Default Extension="xml" ContentType="application/xml"/>';
  xml += '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>';
  xml += '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>';
  for (let i = 1; i <= sheetCount; ++i) {
    xml += `<Override PartName="/xl/worksheets/sheet${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`;
  }
  return xml + "</Types>";
}

function workbookXml(sheets) {
  let xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}">`;
  xml += "<bookViews><workbookView/></bookViews><sheets>";
  for (let i = 0; i < sheets.length; ++i) {
    xml += `<sheet name="${spreadsheetXml(sheets[i].name, true)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`;
  }
  // Formulas are written without cached results, so ask for one full recalculation on open.
  return xml + '</sheets><calcPr calcId="0" fullCalcOnLoad="1"/></workbook>';
}

function workbookRelationships(sheetCount) {
  let xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${PACKAGE_REL_NS}">`;
  for (let i = 1; i <= sheetCount; ++i) {
    xml += `<Relationship Id="rId${i}" Type="${REL_NS}/worksheet" Target="worksheets/sheet${i}.xml"/>`;
  }
  return xml + `<Relationship Id="rId${sheetCount + 1}" Type="${REL_NS}/styles" Target="styles.xml"/></Relationships>`;
}

/** Streams `document` (a complete `Gadget.getDocument()` snapshot) as an XLSX workbook. */
export function workbookToXlsx(document) {
  const {sheets, styles, formulaNames} = prepareWorkbook(document);
  const entries = [
    {name: "[Content_Types].xml", data: contentTypes(sheets.length)},
    {name: "_rels/.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${PACKAGE_REL_NS}"><Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`},
    {name: "xl/workbook.xml", data: workbookXml(sheets)},
    {name: "xl/_rels/workbook.xml.rels", data: workbookRelationships(sheets.length)},
    {name: "xl/styles.xml", data: textStream(stylesXml(styles))},
    ...sheets.map((sheet, i) => ({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      data: textStream(worksheetXml(sheet, formulaNames)),
    })),
  ];
  return createZip(entries);
}
