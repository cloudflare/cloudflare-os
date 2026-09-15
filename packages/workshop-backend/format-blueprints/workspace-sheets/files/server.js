import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { workbookToXlsx } from "./xlsx.js";

const DEFAULT_TITLE = "Untitled spreadsheet";
const DEFAULT_ROWS = 100;
const DEFAULT_COLS = 26;

// ---------------------------------------------------------------------------
// Sheets — authoritative collaboration coordinator.
//
// Storage layout:
//   "meta"          -> { revision, title, sheetOrder:[id], sheets:{id:{...}}, lastModified }
//   "cells:<id>"    -> { "A1": { value, fmt, version }, ... }
//
// Cell content uses per-cell optimistic concurrency (like Docs blocks).
// Structure (sheet list, names, dimensions, column widths, row heights, title)
// is last-writer-wins metadata applied wholesale when a client sends it.
// ---------------------------------------------------------------------------
export class Gadget extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.subscribers = new Map();
    // Overlapping RPC calls are serialized so each observes/commits one
    // authoritative state in strict order. Callbacks to subscribers run
    // outside the queue, so a callback may itself read or write the document.
    this.mutationQueue = Promise.resolve();
  }

  enqueueMutation(fn) {
    const result = this.mutationQueue.then(fn);
    this.mutationQueue = result.catch(() => {});
    return result;
  }

  newId() {
    if (globalThis.crypto?.randomUUID) return "s_" + crypto.randomUUID().slice(0, 8);
    return "s_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  async loadMeta() {
    let meta = await this.ctx.storage.get("meta");
    if (!meta) {
      const id = this.newId();
      meta = {
        revision: 0,
        title: DEFAULT_TITLE,
        sheetOrder: [id],
        sheets: { [id]: sheetMeta({ id, name: "Sheet1" }) },
        lastModified: Date.now(),
      };
      await this.ctx.storage.put("meta", meta);
      await this.ctx.storage.put("cells:" + id, {});
    }
    return meta;
  }

  async loadCells(id) {
    return (await this.ctx.storage.get("cells:" + id)) || {};
  }

  async assembleDocument(meta) {
    const cells = {};
    for (const id of meta.sheetOrder) cells[id] = await this.loadCells(id);
    return {
      revision: meta.revision,
      title: meta.title,
      sheetOrder: meta.sheetOrder,
      sheets: meta.sheets,
      cells,
      lastModified: meta.lastModified,
    };
  }

  getDocument() {
    return this.enqueueMutation(async () => this.assembleDocument(await this.loadMeta()));
  }

  async applyOperation(operation) {
    const { result, event } = await this.enqueueMutation(() => this.applyOperationLocked(operation));
    // Issued after the queue releases, so callbacks may re-enter it, but
    // synchronously here, before the next queued mutation can reach storage,
    // so each subscriber still receives events in revision order.
    if (event) this.broadcast(event);
    return result;
  }

  async applyOperationLocked(operation) {
    const meta = await this.loadMeta();
    let changed = false;

    // --- Structure (last-writer-wins) ------------------------------------
    if (operation.structure) {
      const s = operation.structure;
      const order = Array.isArray(s.sheetOrder) ? s.sheetOrder.map(String) : meta.sheetOrder;
      const nextSheets = {};
      for (const id of order) {
        const incoming = s.sheets?.[id] || {};
        const existing = meta.sheets[id] || {};
        nextSheets[id] = sheetMeta({
          id,
          name: incoming.name ?? existing.name ?? "Sheet",
          rows: incoming.rows ?? existing.rows,
          cols: incoming.cols ?? existing.cols,
          colWidths: incoming.colWidths ?? existing.colWidths,
          rowHeights: incoming.rowHeights ?? existing.rowHeights,
          frozenRows: incoming.frozenRows ?? existing.frozenRows,
          frozenCols: incoming.frozenCols ?? existing.frozenCols,
          filter: Object.prototype.hasOwnProperty.call(incoming, "filter") ? incoming.filter : existing.filter,
          charts: Object.prototype.hasOwnProperty.call(incoming, "charts") ? incoming.charts : existing.charts,
          comments: Object.prototype.hasOwnProperty.call(incoming, "comments") ? incoming.comments : existing.comments,
          pivot: Object.prototype.hasOwnProperty.call(incoming, "pivot") ? incoming.pivot : existing.pivot,
        });
      }
      // A pivot's range lives on its source sheet, which may appear later in the order.
      for (const sheet of Object.values(nextSheets)) {
        if (!sheet.pivot) continue;
        const source = nextSheets[sheet.pivot.sourceSheetId];
        sheet.pivot.sourceRange = source ? sanitizeRange(sheet.pivot.sourceRange, source.rows, source.cols, false) : "";
      }
      for (const id of order) {
        if (!(await this.ctx.storage.get("cells:" + id))) {
          await this.ctx.storage.put("cells:" + id, {});
        }
      }
      // Drop cells for removed sheets.
      for (const id of meta.sheetOrder) {
        if (!nextSheets[id]) await this.ctx.storage.delete("cells:" + id);
      }
      meta.sheetOrder = order;
      meta.sheets = nextSheets;
      if (typeof s.title === "string") meta.title = s.title.slice(0, 200) || DEFAULT_TITLE;
      changed = true;
    }

    // Whole-sheet cell replacement (used by sort / clear / insert-delete).
    if (Array.isArray(operation.sheetReplacements)) {
      for (const rep of operation.sheetReplacements) {
        const id = String(rep.sheetId || "");
        if (!meta.sheets[id]) continue;
        const cells = sanitizeCellMap(rep.cells);
        await this.ctx.storage.put("cells:" + id, cells);
        changed = true;
      }
    }

    // --- Per-cell operations (optimistic concurrency) --------------------
    const upserts = [];
    const deletes = [];
    const conflicts = [];
    const bySheet = new Map();
    for (const op of operation.cellOps || []) {
      const sid = String(op.sheetId || "");
      if (!bySheet.has(sid)) bySheet.set(sid, []);
      bySheet.get(sid).push(op);
    }
    for (const [sheetId, ops] of bySheet) {
      if (!meta.sheets[sheetId]) continue;
      const cells = await this.loadCells(sheetId);
      let dirty = false;
      for (const op of ops) {
        const ref = String(op.ref || "");
        if (!/^[A-Z]+[0-9]+$/.test(ref)) continue;
        const cur = cells[ref];
        const base = Number(op.baseVersion || 0);
        const isDelete = op.value == null && op.fmt == null;
        if (isDelete) {
          if (!cur) continue;
          if (cur.version !== base) { conflicts.push({ sheetId, ref, cell: cur }); continue; }
          delete cells[ref];
          deletes.push({ sheetId, ref });
          dirty = true;
        } else {
          if (cur && cur.version !== base) { conflicts.push({ sheetId, ref, cell: cur }); continue; }
          const next = {
            value: op.value == null ? "" : String(op.value).slice(0, 8192),
            fmt: sanitizeFmt(op.fmt),
            version: (cur?.version || 0) + 1,
          };
          cells[ref] = next;
          upserts.push({ sheetId, ref, cell: next });
          dirty = true;
        }
      }
      if (dirty) await this.ctx.storage.put("cells:" + sheetId, cells);
    }
    if (upserts.length || deletes.length) changed = true;

    if (!changed) {
      return { result: { status: conflicts.length ? "conflict" : "unchanged", revision: meta.revision, conflicts } };
    }

    meta.revision += 1;
    meta.lastModified = Date.now();
    await this.ctx.storage.put("meta", meta);

    // sheetReplacements imply the caller already has the new cells locally, so
    // we only rebroadcast the small per-cell diffs plus structure. Peers that
    // received a replacement re-fetch via the accompanying snapshot flag.
    const event = {
      type: "operation",
      senderId: operation.senderId,
      revision: meta.revision,
      structure: { sheetOrder: meta.sheetOrder, sheets: meta.sheets, title: meta.title },
      upserts,
      deletes,
      replacedSheets: (operation.sheetReplacements || []).map((r) => String(r.sheetId || "")),
      lastModified: meta.lastModified,
    };
    // For replaced sheets, include the full new cell maps so peers stay exact.
    if (event.replacedSheets.length) {
      event.replacedCells = {};
      for (const id of event.replacedSheets) event.replacedCells[id] = await this.loadCells(id);
    }
    return { result: { status: conflicts.length ? "conflict" : "applied", ...event, conflicts }, event };
  }

  // --- Presence & subscription ------------------------------------------
  async subscribe(callback, client = {}) {
    const info = {
      clientId: String(client.clientId || ""),
      name: String(client.name || "Guest").slice(0, 40),
      color: String(client.color || "#e1632e"),
    };
    // Registering and snapshotting inside the queue means the subscriber sees
    // every operation committed after its snapshot, and none before it. The
    // callback is duplicated only once the snapshot exists, so a failed read
    // leaves nothing to dispose.
    return this.enqueueMutation(async () => {
      const document = await this.assembleDocument(await this.loadMeta());
      const existing = Array.from(this.subscribers.values());
      const dup = callback.dup();
      this.subscribers.set(dup, info);
      dup.onRpcBroken(() => {
        this.dropSubscriber(dup);
        this.broadcastPresence({ type: "leave", clientId: info.clientId });
      });
      queueMicrotask(async () => {
        for (const person of existing) {
          try {
            await dup.presence({ type: "join", clientId: person.clientId, name: person.name, color: person.color });
          } catch (e) { break; }
        }
        this.broadcastPresence({ type: "join", clientId: info.clientId, name: info.name, color: info.color });
      });
      return document;
    });
  }

  updatePresence(presence) {
    this.broadcastPresence({
      type: "cursor",
      clientId: String(presence.clientId || ""),
      name: String(presence.name || "Guest").slice(0, 40),
      color: String(presence.color || "#e1632e"),
      sheetId: presence.sheetId ? String(presence.sheetId) : null,
      r1: int(presence.r1), c1: int(presence.c1),
      r2: int(presence.r2), c2: int(presence.c2),
      at: Date.now(),
    });
  }

  leavePresence(clientId) {
    this.broadcastPresence({ type: "leave", clientId: String(clientId || ""), at: Date.now() });
  }

  dropSubscriber(stub) {
    if (this.subscribers.delete(stub)) stub[Symbol.dispose]();
  }

  // Delivery is best-effort and not awaited: a callback that fails is dropped,
  // and one that never settles holds up nothing but its own client.
  broadcast(event) {
    for (const [stub] of this.subscribers) {
      Promise.resolve(stub.operation(event)).catch(() => this.dropSubscriber(stub));
    }
  }

  broadcastPresence(event) {
    for (const [stub] of this.subscribers) {
      Promise.resolve(stub.presence(event)).catch(() => this.dropSubscriber(stub));
    }
  }
}

// --- Sanitizers -------------------------------------------------------------
function int(v) { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(0, n) : 0; }
function clampInt(v, lo, hi, dflt) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}

// Clients walk chart and pivot ranges cell by cell, so a range outside the sheet or beyond this
// many cells would hang every client that opens the workbook. It is clamped to the sheet and
// rejected (empty) when still too large.
const MAX_RANGE_CELLS = 200000;
function sanitizeRange(text, rows, cols, allowSingle) {
  const match = /^([A-Z]+)([1-9]\d*)(?::([A-Z]+)([1-9]\d*))?$/.exec(String(text || "").toUpperCase());
  if (!match || (!match[3] && !allowSingle)) return "";
  const first = parseCsvCellRef(match[1] + match[2]);
  const last = match[3] ? parseCsvCellRef(match[3] + match[4]) : first;
  const top = Math.min(first.row, last.row), left = Math.min(first.column, last.column);
  const bottom = Math.min(Math.max(first.row, last.row), rows - 1), right = Math.min(Math.max(first.column, last.column), cols - 1);
  if (top > bottom || left > right || (bottom - top + 1) * (right - left + 1) > MAX_RANGE_CELLS) return "";
  return csvCellRef(top, left) + (match[3] ? ":" + csvCellRef(bottom, right) : "");
}

function sanitizeDims(dims) {
  const out = {};
  if (dims && typeof dims === "object") {
    for (const [k, v] of Object.entries(dims)) {
      if (!/^\d+$/.test(k)) continue;
      const n = Math.round(Number(v));
      if (Number.isFinite(n) && n >= 8 && n <= 2000) out[k] = n;
    }
  }
  return out;
}

function sheetMeta(s) {
  const rows = clampInt(s.rows, 1, 50000, DEFAULT_ROWS), cols = clampInt(s.cols, 1, 702, DEFAULT_COLS);
  return {
    id: String(s.id),
    name: String(s.name || "Sheet").slice(0, 60),
    rows,
    cols,
    colWidths: sanitizeDims(s.colWidths),
    rowHeights: sanitizeDims(s.rowHeights),
    frozenRows: clampInt(s.frozenRows, 0, 50, 0),
    frozenCols: clampInt(s.frozenCols, 0, 50, 0),
    filter: sanitizeFilter(s.filter, rows, cols),
    charts: sanitizeCharts(s.charts, rows, cols),
    comments: sanitizeComments(s.comments),
    pivot: sanitizePivot(s.pivot),
  };
}

function sanitizePivot(pivot) {
  if (!pivot || typeof pivot !== "object") return null;
  const aggregates = new Set(["sum", "count", "average", "min", "max"]);
  return {
    sourceSheetId: String(pivot.sourceSheetId || "").slice(0, 80),
    // Shape only; applyOperationLocked bounds it against the source sheet.
    sourceRange: /^([A-Z]+[1-9]\d*):([A-Z]+[1-9]\d*)$/.test(String(pivot.sourceRange || "").toUpperCase()) ? String(pivot.sourceRange).toUpperCase() : "",
    // Fields are keyed by their header cell's text, so they share the cell value limit.
    rowField: String(pivot.rowField || "").slice(0, 8192),
    columnField: String(pivot.columnField || "").slice(0, 8192),
    valueField: String(pivot.valueField || "").slice(0, 8192),
    aggregate: aggregates.has(pivot.aggregate) ? pivot.aggregate : "sum",
    showRowTotals: pivot.showRowTotals !== false,
    showColumnTotals: pivot.showColumnTotals !== false,
    filterField: String(pivot.filterField || "").slice(0, 8192),
    // Compared exactly to cell values, so they keep the cell limit; an oversized set is dropped
    // whole rather than trimmed into a different filter.
    filterValues: ((values) => values.length <= MAX_FILTER_SELECTIONS ? values : [])(Array.isArray(pivot.filterValues)
      ? [...new Set(pivot.filterValues.map((value) => String(value).slice(0, 8192)))]
      : (pivot.filterValue ? [String(pivot.filterValue).slice(0, 8192)] : [])),
  };
}

function sanitizeComments(comments) {
  if (!Array.isArray(comments)) return [];
  return comments.slice(0, 2000).map((comment, index) => ({
    id: String(comment?.id || "comment_" + index).slice(0, 80),
    ref: /^[A-Z]+[1-9]\d*$/.test(String(comment?.ref || "").toUpperCase()) ? String(comment.ref).toUpperCase() : "A1",
    text: String(comment?.text || "").slice(0, 4000),
    createdAt: Math.max(0, Math.round(Number(comment?.createdAt)) || Date.now()),
    resolved: comment?.resolved === true,
  })).filter((comment) => comment.text.trim());
}

function sanitizeCharts(charts, rows, cols) {
  if (!Array.isArray(charts)) return [];
  return charts.slice(0, 50).map((chart, index) => ({
    id: String(chart?.id || "chart_" + index).slice(0, 80),
    type: ["line", "pie", "area", "stackedBar"].includes(chart?.type) ? chart.type : "line",
    range: sanitizeRange(chart?.range, rows, cols, true),
    title: String(chart?.title || "").slice(0, 200),
    xAxisTitle: String(chart?.xAxisTitle || "").slice(0, 120),
    yAxisTitle: String(chart?.yAxisTitle || "").slice(0, 120),
    legend: chart?.legend !== false,
    firstRowHeaders: chart?.firstRowHeaders !== false,
    firstColLabels: chart?.firstColLabels !== false,
    smooth: chart?.smooth === true,
    x: clampInt(chart?.x, 48, 5000, 96),
    y: clampInt(chart?.y, 28, 5000, 44),
    width: clampInt(chart?.width, 280, 1200, 520),
    height: clampInt(chart?.height, 200, 900, 320),
  }));
}
const MAX_FILTER_SELECTIONS = 500; // the client's filter menu refuses larger selections

function sanitizeFilter(filter, rows, cols) {
  if (!filter || typeof filter !== "object") return null;
  const row = clampInt(filter.row, 0, Math.max(0, rows - 1), 0);
  const criteria = {};
  if (filter.criteria && typeof filter.criteria === "object") {
    for (const [column, values] of Object.entries(filter.criteria)) {
      if (!/^\d+$/.test(column)) continue;
      const col = Number(column);
      if (col < 0 || col >= cols || !Array.isArray(values)) continue;
      // Trimming a selection would change which rows it hides; an oversized one is dropped whole.
      // (Values are compared to cell values, which the server caps at 8,192 characters.)
      const clean = [...new Set(values.map((value) => String(value).slice(0, 8192)))];
      if (clean.length && clean.length <= MAX_FILTER_SELECTIONS) criteria[col] = clean;
    }
  }
  const endRow = clampInt(filter.endRow, row, Math.max(row, rows - 1), rows - 1);
  const columns = Array.isArray(filter.columns)
    ? [...new Set(filter.columns.map(Number).filter((column) => Number.isInteger(column) && column >= 0 && column < cols))].slice(0, cols)
    : Array.from({ length: cols }, (_, column) => column);
  const expectedRows = Math.max(0, endRow - row);
  const incomingOrder = Array.isArray(filter.rowOrder) ? filter.rowOrder.map(Number) : [];
  const rowOrder = incomingOrder.length === expectedRows && incomingOrder.every(Number.isFinite)
    ? incomingOrder.map((value) => Math.round(value))
    : Array.from({ length: expectedRows }, (_, index) => row + 1 + index);
  const sortColumn = Number(filter.sort?.column);
  const sort = Number.isInteger(sortColumn) && columns.includes(sortColumn) && (filter.sort?.direction === "asc" || filter.sort?.direction === "desc")
    ? { column: sortColumn, direction: filter.sort.direction }
    : null;
  return { row, endRow, columns, criteria, rowOrder, sort };
}

const FMT_KEYS = new Set(["b", "i", "u", "s", "c", "bg", "a", "nf", "d", "fs", "wrap"]);
function sanitizeFmt(fmt) {
  if (!fmt || typeof fmt !== "object") return null;
  const out = {};
  for (const [k, v] of Object.entries(fmt)) {
    if (!FMT_KEYS.has(k) || v == null || v === false || v === "") continue;
    if (k === "c" || k === "bg") { if (/^#[0-9a-fA-F]{3,8}$/.test(v)) out[k] = v; }
    else if (k === "a") { if (v === "l" || v === "c" || v === "r") out[k] = v; }
    else if (k === "nf") { out[k] = String(v).slice(0, 20); }
    else if (k === "d") { const n = Math.round(Number(v)); if (n >= 0 && n <= 10) out[k] = n; }
    else if (k === "fs") { const n = Math.round(Number(v)); if (n >= 6 && n <= 96) out[k] = n; }
    else out[k] = true;
  }
  return Object.keys(out).length ? out : null;
}

function sanitizeCellMap(map) {
  const out = {};
  if (!map || typeof map !== "object") return out;
  let count = 0;
  for (const [ref, cell] of Object.entries(map)) {
    if (!/^[A-Z]+[0-9]+$/.test(ref) || count++ > 200000) continue;
    out[ref] = {
      value: cell?.value == null ? "" : String(cell.value).slice(0, 8192),
      fmt: sanitizeFmt(cell?.fmt),
      version: Math.max(1, Math.round(Number(cell?.version)) || 1),
    };
  }
  return out;
}

const CSV_FORMAT_PREFIX = "csv:";
const MAX_CSV_SHEETS = 31; // The platform allows 32 formats; one is the workbook.
const MAX_EXPORT_ID_LENGTH = 128;
const XLSX_FORMAT = {
  id: "xlsx",
  label: "Excel Workbook",
  mode: "server",
  contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  fileExtension: ".xlsx",
};

// Sheet ids are client-chosen, so duplicates and over-long ids are possible in
// stored structure. Either would fail format validation and disable every export.
function csvSheetIds(document) {
  const ids = document.sheetOrder.filter((id) => (CSV_FORMAT_PREFIX + id).length <= MAX_EXPORT_ID_LENGTH);
  return Array.from(new Set(ids)).slice(0, MAX_CSV_SHEETS);
}

export class ExportHandler extends WorkerEntrypoint {
  async getExportFormats(gadget) {
    const document = await gadget.getDocument();
    const sheetIds = csvSheetIds(document);
    return [XLSX_FORMAT, ...sheetIds.map((sheetId) => ({
      id: CSV_FORMAT_PREFIX + sheetId,
      label: sheetIds.length === 1 ? "CSV" : "CSV (" + document.sheets[sheetId].name + ")",
      mode: "server",
      contentType: "text/csv",
      fileExtension: ".csv",
    }))];
  }

  async export(gadget, id) {
    if (id === XLSX_FORMAT.id) {
      const document = await gadget.getDocument();
      return workbookToXlsx(document);
    }
    if (!id.startsWith(CSV_FORMAT_PREFIX)) {
      throw new Error("Unsupported spreadsheet export format: " + id);
    }
    const document = await gadget.getDocument();
    const sheetId = id.slice(CSV_FORMAT_PREFIX.length);
    if (!csvSheetIds(document).includes(sheetId)) {
      throw new Error("The selected worksheet is unavailable for CSV export.");
    }
    return new Response(workbookSheetToCsv(document, sheetId)).body;
  }
}

function workbookSheetToCsv(document, sheetId) {
  const cells = document.cells?.[sheetId] || {};
  let maxRow = -1;
  let maxColumn = -1;
  for (const [ref, cell] of Object.entries(cells)) {
    if (cell?.value == null || cell.value === "") continue;
    const position = parseCsvCellRef(ref);
    if (!position) continue;
    maxRow = Math.max(maxRow, position.row);
    maxColumn = Math.max(maxColumn, position.column);
  }
  if (maxRow < 0 || maxColumn < 0) return "";

  const rows = [];
  for (let row = 0; row <= maxRow; ++row) {
    const fields = [];
    for (let column = 0; column <= maxColumn; ++column) {
      const value = cells[csvCellRef(row, column)]?.value ?? "";
      fields.push(escapeCsvField(value));
    }
    rows.push(fields.join(","));
  }
  return rows.join("\r\n") + "\r\n";
}

function parseCsvCellRef(ref) {
  const match = /^([A-Z]+)([1-9]\d*)$/.exec(ref);
  if (!match) return null;
  let column = 0;
  for (const char of match[1]) column = column * 26 + char.charCodeAt(0) - 64;
  return { row: Number(match[2]) - 1, column: column - 1 };
}

function csvCellRef(row, column) {
  let letters = "";
  for (let value = column + 1; value > 0; value = Math.floor((value - 1) / 26)) {
    letters = String.fromCharCode(65 + (value - 1) % 26) + letters;
  }
  return letters + (row + 1);
}

function escapeCsvField(value) {
  const text = String(value);
  return /[",\r\n]/.test(text) ? "\"" + text.replace(/\"/g, "\"\"") + "\"" : text;
}
