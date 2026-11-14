// ---------------------------------------------------------------------------
// Formulas as stored: each cell reference names lines by id (see lib/lines.ts), so it keeps
// pointing at the same cells however rows and columns move, and at the same sheet however it's
// renamed, without anything rewriting the formula. Editors, the engine, exports and the agent
// work with the A1 text `render` gives for the order of the moment, and `toStored` turns A1 text
// back into the stored form.
//
// A stored formula is the typed text with each reference swapped for a token
// `\uE000sheet|from|sep|to\uE001` (`sheet` empty for the formula's own sheet; `sep` and `to` only
// for a range). An endpoint is `[$]col.[$]row`, each part a line id, or `@n` for position n past
// the sheet's edge (no line is there to follow; it stays that position, so a formula written
// ahead of the data still reads it once the sheet grows to hold it).
// Everything else is kept as typed. A reference to a sheet that doesn't exist is kept as typed
// too, so it starts working if such a sheet is made.
//
// How a stored reference reads:
//   - a single cell whose row or column was deleted is #REF!;
//   - a range whose end line was deleted ends at the nearest live line inside it, and is #REF!
//     only when no line of it is left;
//   - a range is the lines between its two ends, so lines inserted inside it join it, and moving
//     a line it ends on moves that end (the cut-and-insert rule spreadsheets use);
//   - a reference to a deleted sheet is #REF!;
//   - on a sheet that started over (a rebuilt pivot table), a line it no longer has is read by
//     its old position.
// ---------------------------------------------------------------------------
import { colToLetter, formulaReferences, letterToCol } from "./formula.ts";
import { FIRST_NEW_ID, type LineOrder, type SheetOrder } from "./lines.ts";
import type { Dims, SheetFilter, SheetMeta } from "./protocol.ts";

/** A formula in stored form: references hold line ids (see this module's header). */
export type StoredFormula = string & { readonly storedFormula: unique symbol };

/** What reading or writing a formula needs: the sheet it's on, and every sheet's order and name. */
export interface RefContext {
  sheetId: string;
  order(sheetId: string): SheetOrder | undefined;
  /** The id of the sheet with this name (compared case-insensitively). */
  sheetIdByName(name: string): string | undefined;
  sheetName(sheetId: string): string | undefined;
}

const OPEN = "\uE000", CLOSE = "\uE001";
const TOKEN = /\uE000([^\uE000\uE001]*)\uE001/g;
const STRAY = /[\uE000\uE001]/g;
const MAX_ROWS = 50000, MAX_COLS = 702;

/** Whether a value is a formula with stored references (the only values `render` changes). */
export function hasStoredRefs(value: string): boolean {
  return value.startsWith("=") && value.includes(OPEN);
}

// The sheet name a reference prefix names, folded for comparison: `'Owner''s Sheet'!` and
// `'Owner\'s Sheet'!` both name "owner's sheet".
function prefixSheetName(prefix: string): string {
  const name = prefix.endsWith("!") ? prefix.slice(0, -1) : prefix;
  return (name.startsWith("'") ? name.slice(1, -1).replace(/\\'|''/g, "'") : name).toLowerCase();
}

/** A sheet name as formulas write it before `!`: bare when it can be, otherwise quoted with '' for an apostrophe. */
export function sheetPrefix(name: string): string {
  const bare = /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) && !/^[A-Za-z]{1,3}\d+$/.test(name) && !/^(true|false)$/i.test(name);
  return (bare ? name : "'" + name.replace(/'/g, "''") + "'") + "!";
}

/** A line as an endpoint names it: by id, or by a position past the sheet's edge. */
type LinePart = { id: number } | { at: number };

function storePart(index: number, order: LineOrder): string {
  const id = order.idAt(index);
  return id !== undefined ? String(id) : "@" + index;
}
function readPart(text: string): LinePart | null {
  if (text.startsWith("@")) { const at = Number(text.slice(1)); return Number.isSafeInteger(at) && at >= 0 ? { at } : null; }
  const id = Number(text);
  return text !== "" && Number.isSafeInteger(id) && id >= 0 ? { id } : null;
}

/** One endpoint of a reference as typed: its `$` locks and position. */
interface TypedEndpoint { prefix: string; colLock: boolean; col: number; rowLock: boolean; row: number; start: number; end: number }
function parseEndpoints(text: string): TypedEndpoint[] | null {
  const out: TypedEndpoint[] = [];
  for (const endpoint of formulaReferences("=" + text, true)) {
    const bang = endpoint.text.lastIndexOf("!");
    const m = /^(\$?)([A-Z]{1,2})(\$?)([1-9]\d*)$/i.exec(endpoint.text.slice(bang + 1));
    if (!m) return null;
    out.push({ prefix: endpoint.text.slice(0, bang + 1), colLock: !!m[1], col: letterToCol(m[2].toUpperCase()), rowLock: !!m[3], row: Number(m[4]) - 1, start: endpoint.start - 1, end: endpoint.end - 1 });
  }
  return out.length === 1 || out.length === 2 ? out : null;
}

/**
 * A formula's A1 text in stored form, read against the current order: each reference into a
 * sheet that exists becomes a token naming its lines. Values that aren't formulas are returned
 * as they are.
 */
export function toStored(value: string, ctx: RefContext): StoredFormula {
  if (!value.startsWith("=")) return value as StoredFormula;
  const text = value.replace(STRAY, "");
  let result = "", start = 0;
  for (const reference of formulaReferences(text)) {
    const parts = parseEndpoints(reference.text);
    if (!parts) continue;
    const [first, second] = parts;
    const sheetId = first.prefix ? ctx.sheetIdByName(prefixSheetName(first.prefix)) : ctx.sheetId;
    // A range's second endpoint is read on the first's sheet, as the engine reads it; one that
    // names another sheet is left as typed.
    if (!sheetId || (second?.prefix && ctx.sheetIdByName(prefixSheetName(second.prefix)) !== sheetId)) continue;
    const order = ctx.order(sheetId);
    if (!order) continue;
    const endpoint = (p: TypedEndpoint) => (p.colLock ? "$" : "") + storePart(p.col, order.cols) + "." + (p.rowLock ? "$" : "") + storePart(p.row, order.rows);
    let body = (first.prefix ? sheetId : "") + "|" + endpoint(first);
    if (second) body += "|" + (second.prefix ? "!" : "") + reference.text.slice(first.end, second.start).replace(/[^:\s]/g, "") + "|" + endpoint(second);
    result += text.slice(start, reference.start) + OPEN + body + CLOSE;
    start = reference.end;
  }
  return (result + text.slice(start)) as StoredFormula;
}

/** One endpoint of a stored reference. */
interface StoredEndpoint { colLock: boolean; col: LinePart; rowLock: boolean; row: LinePart }
function readEndpoint(text: string | undefined): StoredEndpoint | null {
  const m = /^(\$?)([^.$]+)\.(\$?)(.+)$/.exec(text || "");
  if (!m) return null;
  const col = readPart(m[2]), row = readPart(m[4]);
  return col && row ? { colLock: !!m[1], col, rowLock: !!m[3], row } : null;
}

// A sheet that starts over (a pivot table rebuilt, see SheetReplacement) has lines 0..n-1 again,
// so an id below FIRST_NEW_ID that its order doesn't have is position n past its edge, as `@n`.
function settled(part: LinePart, order: LineOrder): LinePart {
  return "id" in part && part.id < FIRST_NEW_ID && !order.has(part.id) ? { at: part.id } : part;
}
// Where one end of a reference is on an axis now: a live index, or null when its line is gone.
function singleIndex(stored: LinePart, order: LineOrder): number | null {
  const part = settled(stored, order);
  if ("at" in part) return part.at;
  const index = order.indexOf(part.id);
  return index < 0 ? null : index;
}
// Where a range is on an axis now, first line first (as spreadsheets write a range, however its
// ends were typed or have moved), after deleted ends walk inward; null when nothing of it is left.
// `swapped`: the second end is the first line, so its `$` goes first.
function spanIndexes(storedA: LinePart, storedB: LinePart, order: LineOrder): { lo: number; hi: number; swapped: boolean } | null {
  const a = settled(storedA, order), b = settled(storedB, order);
  const sorted = (x: number, y: number) => (x <= y ? { lo: x, hi: y, swapped: false } : { lo: y, hi: x, swapped: true });
  if ("at" in a && "at" in b) return sorted(a.at, b.at);
  if ("at" in a) { const to = order.liveFrom((b as { id: number }).id); return to === null ? null : sorted(a.at, to); }
  if ("at" in b) { const from = order.liveFrom(a.id); return from === null ? null : sorted(from, b.at); }
  const span = order.span(a.id, b.id);
  return span && { lo: span[0], hi: span[1], swapped: order.before(b.id, a.id) };
}

function endpointText(colLock: boolean, col: number, rowLock: boolean, row: number): string | null {
  if (col < 0 || row < 0 || col >= MAX_COLS || row >= MAX_ROWS) return null;
  return (colLock ? "$" : "") + colToLetter(col) + (rowLock ? "$" : "") + (row + 1);
}

function renderToken(body: string, ctx: RefContext): string {
  const [sheetField, fromField, sepField, toField] = body.split("|");
  const sheetId = sheetField || ctx.sheetId;
  const order = ctx.order(sheetId), name = sheetField ? ctx.sheetName(sheetId) : "";
  const from = readEndpoint(fromField);
  if (!order || name === undefined || !from) return "#REF!";
  const prefix = sheetField ? sheetPrefix(name) : "";
  if (toField === undefined) {
    const col = singleIndex(from.col, order.cols), row = singleIndex(from.row, order.rows);
    const text = col === null || row === null ? null : endpointText(from.colLock, col, from.rowLock, row);
    return text === null ? "#REF!" : prefix + text;
  }
  const to = readEndpoint(toField);
  if (!to) return "#REF!";
  const cols = spanIndexes(from.col, to.col, order.cols), rows = spanIndexes(from.row, to.row, order.rows);
  if (!cols || !rows) return "#REF!";
  const lock = (swapped: boolean, first: boolean, fromLock: boolean, toLock: boolean) => (swapped === first ? toLock : fromLock);
  const a = endpointText(lock(cols.swapped, true, from.colLock, to.colLock), cols.lo, lock(rows.swapped, true, from.rowLock, to.rowLock), rows.lo);
  const b = endpointText(lock(cols.swapped, false, from.colLock, to.colLock), cols.hi, lock(rows.swapped, false, from.rowLock, to.rowLock), rows.hi);
  if (a === null || b === null) return "#REF!";
  const sep = (sepField || ":").replace(/^!/, "");
  return prefix + a + sep + (sepField?.startsWith("!") ? prefix : "") + b;
}

/** A stored formula's A1 text for the current order. Values without stored references are returned as they are. */
export function render(value: string, ctx: RefContext): string {
  if (!hasStoredRefs(value)) return value;
  return value.replace(TOKEN, (_, body: string) => renderToken(body, ctx));
}

/** The ids of every sheet a stored formula refers to by name (its own sheet's references aren't listed). */
export function storedSheets(value: string): Set<string> {
  const ids = new Set<string>();
  if (!hasStoredRefs(value)) return ids;
  for (const m of value.matchAll(TOKEN)) { const sheet = m[1].split("|")[0]; if (sheet) ids.add(sheet); }
  return ids;
}

/** A context for one sheet's own ranges (charts, a pivot's source): only that sheet is known. */
export function sheetContext(sheetId: string, order: SheetOrder): RefContext {
  return { sheetId, order: (id) => (id === sheetId ? order : undefined), sheetIdByName: () => undefined, sheetName: () => undefined };
}

// The id a sheet-only context gives its sheet; its ranges never name one.
const OWN = "_";
/** A range on one sheet ("A1:C9", or "B2") in stored form; text that isn't a range is kept as it is. */
export function storeRange(text: string, order: SheetOrder): string {
  if (!text || /[!\uE000\uE001]/.test(text)) return text.replace(STRAY, "");
  return toStored("=" + text, sheetContext(OWN, order)).slice(1);
}

/** A stored range's text for the current order: "" when every line of it is gone. */
export function renderRange(stored: string, order: SheetOrder): string {
  if (!stored.includes(OPEN)) return stored;
  const text = render("=" + stored, sheetContext(OWN, order)).slice(1);
  return text.includes("#REF!") ? "" : text;
}

// --- Sheet settings by id -----------------------------------------------------
// A sheet's settings name lines by id as stored, so they stay with their lines too: column
// widths and row heights are keyed by line id, a filter names its header and last rows and its
// columns by id, and chart and pivot ranges are stored ranges. Editors and the agent see them by
// position (`viewSheet`), and `storeSheet` turns them back. A filter's `rowOrder` (the order its
// rows had before a sort) is by position, and starts over whenever its sheet's rows change.

/** Widths or heights keyed by position, as keyed by line id (and back): entries for lines that aren't live are dropped. */
function dimsByIds(dims: Dims, order: LineOrder): Dims {
  const out: Dims = {};
  for (const [index, px] of Object.entries(dims || {})) { const id = order.idAt(Number(index)); if (id !== undefined) out[id] = px; }
  return out;
}
function dimsByIndex(dims: Dims, order: LineOrder): Dims {
  const out: Dims = {};
  for (const [id, px] of Object.entries(dims || {})) { const index = order.indexOf(Number(id)); if (index >= 0) out[index] = px; }
  return out;
}

function filterByIds(filter: SheetFilter | null, order: SheetOrder): SheetFilter | null {
  if (!filter) return null;
  const row = order.rows.idAt(filter.row), endRow = order.rows.idAt(filter.endRow ?? order.rows.size - 1);
  if (row === undefined || endRow === undefined) return null;
  const col = (index: number) => order.cols.idAt(index);
  const criteria: Record<string, string[]> = {};
  for (const [index, values] of Object.entries(filter.criteria || {})) { const id = col(Number(index)); if (id !== undefined) criteria[id] = values; }
  const sortColumn = filter.sort ? col(filter.sort.column) : undefined;
  return {
    ...filter, row, endRow,
    columns: (filter.columns || []).map(col).filter((id): id is number => id !== undefined),
    criteria,
    sort: filter.sort && sortColumn !== undefined ? { ...filter.sort, column: sortColumn } : null,
  };
}
function filterByIndex(filter: SheetFilter | null, order: SheetOrder): SheetFilter | null {
  if (!filter) return null;
  const row = order.rows.indexOf(filter.row), span = order.rows.span(filter.row, filter.endRow);
  if (row < 0 || !span) return null;
  const col = (id: number) => order.cols.indexOf(id);
  const criteria: Record<string, string[]> = {};
  for (const [id, values] of Object.entries(filter.criteria || {})) { const index = col(Number(id)); if (index >= 0) criteria[index] = values; }
  const columns = (filter.columns || []).map(col).filter((index) => index >= 0);
  if (!columns.length) return null;
  const sortColumn = filter.sort ? col(filter.sort.column) : -1;
  return { ...filter, row, endRow: Math.max(row, span[1]), columns, criteria, sort: filter.sort && sortColumn >= 0 ? { ...filter.sort, column: sortColumn } : null };
}

/** A sheet's settings as stored (lines by id), from how editors see them (lines by position). */
export function storeSheet(sheet: SheetMeta, orderOf: (sheetId: string) => SheetOrder | undefined): SheetMeta {
  const order = orderOf(sheet.id);
  if (!order) return sheet;
  const source = sheet.pivot ? orderOf(sheet.pivot.sourceSheetId) : undefined;
  return {
    ...sheet,
    colWidths: dimsByIds(sheet.colWidths, order.cols),
    rowHeights: dimsByIds(sheet.rowHeights, order.rows),
    filter: filterByIds(sheet.filter, order),
    charts: (sheet.charts || []).map((chart) => ({ ...chart, range: storeRange(chart.range, order) })),
    pivot: sheet.pivot && { ...sheet.pivot, sourceRange: source ? storeRange(sheet.pivot.sourceRange, source) : "" },
  };
}

/** A sheet's settings as editors see them (lines by position, sizes from its order), from how they're stored. */
export function viewSheet(sheet: SheetMeta, orderOf: (sheetId: string) => SheetOrder | undefined): SheetMeta {
  const order = orderOf(sheet.id);
  if (!order) return sheet;
  const source = sheet.pivot ? orderOf(sheet.pivot.sourceSheetId) : undefined;
  return {
    ...sheet,
    rows: order.rows.size,
    cols: order.cols.size,
    colWidths: dimsByIndex(sheet.colWidths, order.cols),
    rowHeights: dimsByIndex(sheet.rowHeights, order.rows),
    filter: filterByIndex(sheet.filter, order),
    charts: (sheet.charts || []).map((chart) => ({ ...chart, range: renderRange(chart.range, order) })),
    pivot: sheet.pivot && { ...sheet.pivot, sourceRange: source ? renderRange(sheet.pivot.sourceRange, source) : "" },
  };
}
