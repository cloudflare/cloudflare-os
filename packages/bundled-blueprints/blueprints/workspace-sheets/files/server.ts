import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { MutationQueue, SubscriberRegistry } from "@gadgets/bundled-blueprints/libraries/sync/server";
import { CHART_BOUNDS, MAX_CHARTS, PLACEMENT_ROWS, chartPlacement } from "./lib/charts.ts";
import { type Display, type Scalar, displayValue, formulaReferences } from "./lib/formula.ts";
import { DEFAULT_COLS, DEFAULT_ROWS, EXPORT_PAGE_CHARS, EXPORT_UNKNOWN, type ExportCells, type ExportEvaluator, disposeResult, loadExportWorkbook, parseCsvCellRef, refreshExportPivots, textStream } from "./lib/export-data.ts";
import { workbookToXlsx } from "./lib/xlsx.ts";
import { type Axis, type LineOp, type StoredOrder, LineOrder, SheetOrder, newLineIds, parseCellKey } from "./lib/lines.ts";
import { type RefContext, render, renderRange, sheetPrefix, storeRange, storeSheet, toStored, viewSheet } from "./lib/refs.ts";
import type {
  AgentHint,
  AgentWriteResult,
  Cell,
  CellConflict,
  CellDeletion,
  CellFmt,
  CellMap,
  CellOp,
  CellUpsert,
  CellsPage,
  Chart,
  ChartType,
  Dims,
  DocumentMeta,
  ExportGadgetStub,
  ExportPage,
  FilterSort,
  FullPackedCells,
  OpenedDocument,
  Operation,
  OperationEvent,
  OperationResult,
  PackedCells,
  PivotSettings,
  RecentOperation,
  SheetFilter,
  SheetMeta,
  SheetSlice,
  SheetsDocument,
  SheetsPresenceEvent,
  SortWrite,
  Structure,
  StructureWithRevision,
  SubscriberEvent,
  SubscribeOptions,
  SubscriberCallbacks,
} from "./lib/protocol.ts";

const DEFAULT_TITLE = "Untitled spreadsheet";

// ---------------------------------------------------------------------------
// Sheets — authoritative collaboration coordinator.
//
// Storage layout:
//   "meta"         -> { revision, title, sheetOrder:[id], sheets:{id:{...}}, lastModified, cellStorage: 4 }
//   "o:<sheetId>"  -> the sheet's line order, { rows, cols } as runs of ids (lib/lines.ts); absent
//                     while the sheet is still in identity order (ids 0..rows-1, 0..cols-1)
//   "c:<sheetId>:<000000000000012>" -> block 12: the cells of rows with ids 384–415, packed (see blockKey)
//
// Rows and columns have ids that stay with them (lib/lines.ts), so cells are keyed "rowId:colId",
// formulas name lines by id (lib/refs.ts), and inserting, deleting or moving lines changes only
// the order: no cell is rewritten, and an edit or a formula made before the change still names
// the cell it meant. Blocks of rows keep stored values small, let an edit rewrite only the blocks
// it touches, and keep a big sheet to a few thousand keys. Older workbooks (blocks by position, or
// one "cells:<id>" value per sheet) are converted the first time they load (migrateCellStorage).
//
// Cell content uses per-cell optimistic concurrency (like Docs blocks).
// Structure (sheet list, names, column widths, row heights, filter, charts, title)
// is last-writer-wins metadata applied wholesale when a client sends it.
// ---------------------------------------------------------------------------
/** A stored block part: its cells packed (see blockKey); part 0 of a block in several parts says how many (`parts`). */
interface StoredPart extends FullPackedCells {
  parts?: number;
}
/** Where `blockParts` walks: after block `after` (a name), or from block `from`, up to block `to` (excluded). */
interface BlockRun {
  after?: string;
  from?: string;
  to?: string;
}
/** One step of `blockParts`: a block's name, one of its parts, and whether it is the block's last. */
interface BlockStep {
  name: string;
  part: StoredPart;
  end: boolean;
}
/** A block as read for writing: its cells, and how many parts it is stored in. */
interface Block {
  cells: Map<string, Cell>;
  parts: number;
}
/** One sheet's pending writes in a CellWriter: cleared, replaced wholesale, and/or changed cell by cell (block -> ref -> cell, null to delete). */
interface SheetWrites {
  clear: boolean;
  replace: Map<string, Cell> | null;
  changes: Map<number, Map<string, Cell | null>>;
}
/** A page being assembled from stored parts (readPackedPage). */
interface PageBuilder {
  refs: string[];
  values: string[];
  versions?: number[];
  styles?: number[];
  fmts?: CellFmt[];
}
/** A sheet replacement arriving in parts (stageCells), until applyOperation claims it. */
interface Upload {
  sheetId: string;
  cells: Map<string, Cell>;
  parts: Set<number>;
  at: number;
  /** About how much the staged cells hold (see stageCells). */
  chars: number;
}
/** Who a subscriber said it was, and whether it is an editor from before line ids (`legacy`, see subscribe). */
interface SubscriberInfo {
  clientId: string;
  name: string;
  color: string;
  legacy: boolean;
  /** A legacy subscriber's deliveries, chained so they stay in revision order (see broadcast). */
  delivery: Promise<unknown>;
}
/** The client's RpcTarget as the server holds it: its callbacks, plus what the RPC layer adds. */
type SubscriberStub = SubscriberCallbacks & {
  dup(): SubscriberStub;
  onRpcBroken(handler: (error: unknown) => void): void;
  [Symbol.dispose]?(): void;
};
/** A format patch for the cell API: a key set to null (or false, or "") removes it. */
type FmtPatch = { [K in keyof CellFmt]?: CellFmt[K] | null };
/** What the cell API accepts for one cell: a plain value (keeps the format), null (clears), or `{ value?, fmt? }`. */
type CellSpec = string | number | boolean | null | { value?: string | number | boolean | null; fmt?: FmtPatch | null };
/** What a cell-API write hands its `apply`: read and write cells (by A1 ref), the sheet, and what `prepare` returned. */
interface CellEditor<P> {
  read(ref: string): Cell | null;
  write(ref: string, next: { value: unknown; fmt: unknown } | null): void;
  sheet: SheetMeta;
  id: string;
  prepared: P | undefined;
}
/** What an agent write broadcasts and commits (see commitAgent). */
interface AgentCommit {
  upserts?: CellUpsert[];
  deletes?: CellDeletion[];
  replacedCells?: Record<string, CellMap | null> | null;
  hint?: AgentHint | null;
  /** Whether the write changed the structure, which the event then carries (default true). */
  structure?: boolean;
  lineOps?: LineOp[];
  /** Sheets whose order changed, as they now stand. */
  orders?: Map<string, SheetOrder>;
  /** Whether a sheet was renamed or deleted, which editors from before line ids can't follow (see legacyEvent). */
  relabel?: boolean;
}
/** A sort another sender's older edits mustn't land on (see CellOp.basis): its lines (null: every row) and the revision it landed at. */
interface SortRecord {
  sheetId: string;
  senderId: string | undefined;
  revision: number;
  rows: Set<number> | null;
  cols: Set<number>;
}
/**
 * The sorts remembered, as stored at "sorts" (lines as runs of ids), and for each sheet the
 * newest sort forgotten since: an edit made before that is refused, its cell's fate unknown.
 */
interface SortLog {
  records: { sheetId: string; senderId?: string; revision: number; rows: [number, number][] | null; cols: [number, number][] }[];
  forgotten: Record<string, number>;
}
/** What the agent's presence/subscription arguments may carry; untrusted, so read field by field. */
interface PresenceInput {
  clientId?: unknown;
  name?: unknown;
  color?: unknown;
  sheetId?: unknown;
  r1?: unknown;
  c1?: unknown;
  r2?: unknown;
  c2?: unknown;
}

export class Gadget extends DurableObject<unknown, unknown> {
  declare subscribers: SubscriberRegistry<SubscriberCallbacks, SubscriberInfo>;
  declare queue: MutationQueue;
  declare uploads: Map<string, Upload>;
  declare migration: Promise<void> | null;
  declare pageSlots: number;
  declare pageWaiters: (() => void)[];
  declare orderCache: { revision: number; orders: Map<string, SheetOrder> } | null;
  declare sorts: { records: SortRecord[]; forgotten: Record<string, number> } | null;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.ctx = ctx;
    this.subscribers = new SubscriberRegistry({
      join: (subscriber, who) => subscriber.presence({ type: "join", clientId: who.clientId, name: who.name, color: who.color }),
      leave: (subscriber, who) => subscriber.presence({ type: "leave", clientId: who.clientId }),
    });
    // Overlapping RPC calls are serialized so each observes/commits one
    // authoritative state in strict order.
    this.queue = new MutationQueue();
    // Sheet replacements and sorts too large for one message, arriving in parts (stageCells).
    this.uploads = new Map();
    this.migration = null;
    // Big pages (client loads, exports) are built at most two at a time: each holds a few MB
    // while it is assembled and sent.
    this.pageSlots = 2;
    this.pageWaiters = [];
    this.orderCache = null;
    // Recent sorts, which edits made before them mustn't land on (see sortedSince), read from
    // storage on first use.
    this.sorts = null;
  }

  async withPageSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.pageSlots > 0) this.pageSlots--;
    else await new Promise<void>((resolve) => this.pageWaiters.push(resolve));
    try { return await fn(); }
    finally { const next = this.pageWaiters.shift(); if (next) next(); else this.pageSlots++; }
  }

  newId(): string {
    return "s_" + crypto.randomUUID().slice(0, 8);
  }

  async loadMeta(): Promise<DocumentMeta> {
    let meta = await this.ctx.storage.get<DocumentMeta>("meta");
    if (!meta) {
      const id = this.newId();
      meta = {
        revision: 0,
        title: DEFAULT_TITLE,
        sheetOrder: [id],
        sheets: { [id]: sheetMeta({ id, name: "Sheet1" }) },
        lastModified: Date.now(),
        cellStorage: CELL_STORAGE,
      };
      await this.ctx.storage.put("meta", meta);
    } else if (meta.cellStorage !== CELL_STORAGE) {
      await this.migrateCellStorage();
      meta = (await this.ctx.storage.get<DocumentMeta>("meta")) as DocumentMeta; // migration rewrote it; it exists
    }
    return meta;
  }

  // Older workbooks stored cells by position: blocks of A1 refs ("b:<id>:<00012>", cellStorage 3)
  // or one "cells:<id>" map per sheet. Every line then still has the id of its position (identity
  // order), so a position names its cell's ids, and formulas and settings are converted against
  // that. The new keys are written first, then the meta that switches to them, then the old keys
  // are deleted: a migration cut short runs again from the untouched old keys.
  migrateCellStorage(): Promise<void> {
    if (!this.migration) {
      this.migration = (async () => {
        const meta = await this.ctx.storage.get<DocumentMeta>("meta");
        if (!meta || meta.cellStorage === CELL_STORAGE) return;
        const ids = Object.keys(meta.sheets || {});
        const sheets: Record<string, SheetMeta> = {};
        for (const id of ids) sheets[id] = sheetMeta({ ...meta.sheets[id], id });
        const orders = new Map(ids.map((id) => [id, SheetOrder.from(null, sheets[id].rows, sheets[id].cols)]));
        const book = new OrderBook({ ...meta, sheets }, orders);
        const copy = new WriteBatch(this.ctx.storage), old: string[] = [];
        for (const id of ids) {
          const { rows, cols } = sheets[id], ctx = book.ctx(id);
          const blocks = new Map<number, Map<string, Cell>>();
          // A cell past its sheet's edge (older versions accepted any ref) was never shown.
          const add = (ref: string, cell: Partial<Cell> | null | undefined) => {
            const p = parseCellRef(ref);
            if (!cell || !p || p.r >= rows || p.c >= cols) return;
            const key = p.r + ":" + p.c, index = Math.floor(p.r / BLOCK_ROWS);
            let cells = blocks.get(index);
            if (!cells) blocks.set(index, cells = new Map());
            cells.set(key, { value: clipValue(toStored(String(cell.value ?? ""), ctx)), fmt: sanitizeFmt(cell.fmt), version: Math.max(1, Number(cell.version) || 1) });
          };
          if (meta.cellStorage === 3) {
            const prefix = "b:" + id + ":";
            for (let startAfter = ""; ;) {
              const page = await this.ctx.storage.list<StoredPart | undefined>({ prefix, limit: 64, ...(startAfter ? { startAfter } : {}) });
              for (const [key, part] of page) {
                old.push(key); startAfter = key;
                if (!part || !Array.isArray(part.refs)) continue;
                for (let i = 0; i < part.refs.length; i++) add(part.refs[i], { value: part.values[i], fmt: part.styles[i] >= 0 ? part.fmts[part.styles[i]] : null, version: part.versions[i] });
              }
              if (page.size < 64) break;
            }
          } else {
            const blob = await this.ctx.storage.get<CellMap>("cells:" + id);
            for (const [ref, cell] of Object.entries(blob || {})) add(ref, cell);
            old.push("cells:" + id);
          }
          for (const [index, cells] of blocks) writeBlock(copy, id, index, cells, 0);
        }
        await copy.flush();
        const stored: Record<string, SheetMeta> = {};
        for (const id of ids) stored[id] = storeSheet(sheets[id], (sheetId) => orders.get(sheetId));
        await this.ctx.storage.put("meta", { ...meta, sheets: stored, cellStorage: CELL_STORAGE });
        // A cleanup cut short leaves keys nothing reads.
        const clean = new WriteBatch(this.ctx.storage);
        for (const key of old) clean.delete(key);
        await clean.flush();
      })().finally(() => { this.migration = null; });
    }
    return this.migration;
  }

  // --- Line orders --------------------------------------------------------------
  // Every sheet's line order at the meta's revision (a sheet with none stored is in identity
  // order). The result is shared: a caller that changes an order clones it first. It's cached
  // for the revision, unless a commit landed while it was read.
  async loadOrders(meta: DocumentMeta): Promise<Map<string, SheetOrder>> {
    if (this.orderCache?.revision === meta.revision) return this.orderCache.orders;
    const stored = await this.ctx.storage.list<StoredOrder>({ prefix: ORDER_PREFIX });
    const orders = new Map<string, SheetOrder>();
    for (const id of meta.sheetOrder) {
      const sheet = meta.sheets[id];
      if (sheet) orders.set(id, SheetOrder.from(stored.get(ORDER_PREFIX + id), sheet.rows, sheet.cols));
    }
    if ((await this.ctx.storage.get<DocumentMeta>("meta"))?.revision === meta.revision) this.orderCache = { revision: meta.revision, orders };
    return orders;
  }
  async book(meta: DocumentMeta): Promise<OrderBook> {
    return new OrderBook(meta, await this.loadOrders(meta));
  }

  // --- Cell storage (blocks of rows by id; see blockKey) ------------------------
  // A sheet's stored block parts in order, as { name, part, end } (`end`: the block's last
  // part). `after` (a block name), `from` and `to` (block names; `to` excluded) limit the run.
  // Reads of other work can interleave with an edit between storage calls, so a block stored
  // in several parts is read again whole, in reads issued together (readWholeBlock): its parts come
  // from one moment, and no cell can slip between them while it's repacked.
  async *blockParts(sheetId: string, { after = "", from = "", to = "" }: BlockRun = {}): AsyncGenerator<BlockStep> {
    const prefix = blockPrefix(sheetId), range: DurableObjectListOptions & { limit: number } = { prefix, limit: 64 };
    if (after) range.startAfter = prefix + after + "~￿"; else if (from) range.start = prefix + from;
    if (to) range.end = prefix + to;
    for (;;) {
      const page = await this.ctx.storage.list<StoredPart | undefined>(range);
      let relist = false;
      for (const [key, part] of page) {
        delete range.start; range.startAfter = key;
        if (!part || !Array.isArray(part.refs)) continue;
        const name = key.slice(prefix.length);
        if (name.includes("~")) continue; // a continuation part whose first part was handled
        if (!((part.parts ?? 0) > 1)) { yield { name, part, end: true }; continue; }
        const index = blockIndexOfName(name), parts = await this.readWholeBlock(sheetId, index);
        for (let p = 0; p < parts.length; p++) yield { name, part: parts[p], end: p === parts.length - 1 };
        range.startAfter = prefix + name + "~￿";
        relist = true;
        break;
      }
      if (!relist && page.size < range.limit) return;
    }
  }
  // Every part of a block ([] if the block is gone), in gets of at most STORAGE_BATCH keys issued
  // together, so no write lands between them.
  async readWholeBlock(sheetId: string, index: number): Promise<StoredPart[]> {
    let count = 2;
    for (;;) {
      const keys = Array.from({ length: count }, (_, p) => blockKey(sheetId, index, p));
      const reads: Promise<Map<string, StoredPart | undefined>>[] = [];
      for (let i = 0; i < keys.length; i += STORAGE_BATCH) reads.push(this.ctx.storage.get<StoredPart | undefined>(keys.slice(i, i + STORAGE_BATCH)));
      const map = new Map((await Promise.all(reads)).flatMap((batch) => [...batch]));
      const first = map.get(keys[0]);
      if (!first?.refs) return [];
      const want = first.parts || 1;
      if (want <= count) return keys.slice(0, want).map((key) => map.get(key)).filter((part): part is StoredPart => !!part?.refs);
      count = want;
    }
  }

  // A whole sheet as { key: cell }. Only for work that needs every cell (a snapshot by position).
  async loadCells(sheetId: string): Promise<CellMap> {
    const cells: CellMap = {};
    for await (const { part } of this.blockParts(sheetId)) {
      const { refs, values, versions, styles, fmts } = part;
      for (let i = 0; i < refs.length; i++) cells[refs[i]] = { value: values[i], fmt: styles[i] >= 0 ? fmts[styles[i]] : null, version: versions[i] };
    }
    return cells;
  }

  // Blocks by index, as Map index -> { cells: Map(ref -> cell), parts }, for those that exist.
  async readBlocks(sheetId: string, indices: number[]): Promise<Map<number, Block>> {
    const out = new Map<number, Block>(), list = [...new Set(indices)].filter((index) => index >= 0), prefix = blockPrefix(sheetId), split: number[] = [];
    const reads: Promise<Map<string, StoredPart | undefined>>[] = [];
    for (let i = 0; i < list.length; i += STORAGE_BATCH) reads.push(this.ctx.storage.get<StoredPart | undefined>(list.slice(i, i + STORAGE_BATCH).map((index) => blockKey(sheetId, index))));
    for (const map of await Promise.all(reads)) {
      for (const [key, part] of map) {
        if (!part || !Array.isArray(part.refs)) continue;
        const index = blockIndexOfName(key.slice(prefix.length));
        if ((part.parts ?? 0) > 1) split.push(index);
        else out.set(index, { cells: unpackBlockInto(part, new Map()), parts: 1 });
      }
    }
    // A block in several parts is read whole in one call (see blockParts).
    for (const index of split) {
      const parts = await this.readWholeBlock(sheetId, index);
      if (!parts.length) continue;
      const cells = new Map<string, Cell>();
      for (const part of parts) unpackBlockInto(part, cells);
      out.set(index, { cells, parts: parts.length });
    }
    return out;
  }

  // A replaced or cleared sheet. The stored blocks are compared with the new ones as they're
  // read, one block at a time, so only blocks that differ are written and the old sheet is
  // never held whole.
  async planWholeSheet(sheetId: string, s: SheetWrites, batch: WriteBatch) {
    const target = new Map<number, Map<string, Cell>>();
    const set = (ref: string, cell: Cell | null) => {
      const index = blockOfKey(ref);
      let cells = target.get(index);
      if (!cells) target.set(index, cells = new Map());
      if (cell) cells.set(ref, cell); else cells.delete(ref);
    };
    if (s.replace) for (const [ref, cell] of s.replace) if (cell) set(ref, cell);
    for (const changes of s.changes.values()) for (const [ref, cell] of changes) set(ref, cell);
    let current: { index: number; cells: Map<string, Cell>; parts: number } | null = null;
    const settle = () => {
      if (!current) return;
      const next = target.get(current.index);
      if (!next?.size) { for (let p = 0; p < current.parts; p++) batch.delete(blockKey(sheetId, current.index, p)); }
      else if (!sameCellMaps(current.cells, next)) writeBlock(batch, sheetId, current.index, next, current.parts);
      target.delete(current.index);
      current = null;
    };
    for await (const { name, part } of this.blockParts(sheetId)) {
      const index = blockIndexOfName(name);
      if (current && current.index !== index) settle();
      if (!current) current = { index, cells: new Map(), parts: 0 };
      current.parts++;
      unpackBlockInto(part, current.cells);
    }
    settle();
    for (const [index, cells] of target) if (cells.size) writeBlock(batch, sheetId, index, cells, 0);
  }

  // The given cells (those that exist) as a Map: their blocks are read, nothing else.
  async readCells(sheetId: string, refs: Iterable<string>): Promise<Map<string, Cell>> {
    return new CellWriter(this).read(sheetId, refs);
  }

  // Cells for a client or an export, packed (see appendPart), up to about `budget` characters,
  // from the parts after `after` ("" = from block `from`, or the first) up to block `to`. `next`
  // is where the following page continues, or null when the run is done: the last block sent,
  // or "<block>@<row id>" after a page that ends inside a block. Stored parts are already packed,
  // so a page is mostly concatenation.
  async readPackedPage(sheetId: string, { after = "", from = "", to = "" }: BlockRun, budget: number, { versions = true, formats = true } = {}): Promise<{ packed: PageBuilder; chars: number; next: string | null }> {
    const page: PageBuilder = { refs: [], values: [] };
    if (versions) page.versions = [];
    if (formats) { page.styles = []; page.fmts = []; }
    const fmtIndex = new Map<string, number>();
    const [resumeBlock, resumeRow] = after.split("@");
    let chars = 0, next = after, parts: StoredPart[] = [];
    for await (const { name, part, end } of this.blockParts(sheetId, resumeRow === undefined ? { after, from, to } : { from: resumeBlock, to })) {
      parts.push(part);
      if (!end) continue;
      const skip = resumeRow !== undefined && name === resumeBlock ? Number(resumeRow) : -1;
      if (skip < 0 && chars + parts.reduce((sum, p) => sum + packedChars(p, p.refs.keys()), 0) <= budget) {
        for (const p of parts) chars += appendPart(page, fmtIndex, p, formats);
        next = name;
      } else {
        // A block that would take the page past its budget (32 rows of long texts can be tens of
        // MB, over what one RPC message carries) is split between rows. Rows are read whole from
        // one moment, as blocks are, so a page read mid-edit is settled the same way.
        for (const [row, picks] of blockRows(parts, skip)) {
          let rowChars = 0;
          for (const [p, indices] of picks) rowChars += packedChars(p, indices);
          if (chars && chars + rowChars > budget) return { packed: page, chars, next };
          for (const [p, indices] of picks) chars += appendPart(page, fmtIndex, p, formats, indices);
          next = name + "@" + row;
        }
        next = name;
      }
      parts = [];
      if (chars >= budget) return { packed: page, chars, next };
    }
    return { packed: page, chars, next: null };
  }

  // Up to 8 runs of a sheet's blocks from `after` on (at least 32 blocks, about 1,000 rows,
  // each), so a client can read them a couple at a time. Blocks hold rows by id, so the runs are
  // cut where the sheet's rows have blocks.
  sheetSlices(sheetId: string, order: SheetOrder, after = ""): SheetSlice[] {
    const all = [...new Set(order.rows.live().map((id) => Math.floor(id / BLOCK_ROWS)))].sort((a, b) => a - b);
    const first = after ? blockIndexOfName(after) : -1;
    const blocks = all.filter((index) => index >= first);
    if (!blocks.length) return after ? [] : [{ sheetId, after: "", from: "", to: "" }];
    const count = Math.max(1, Math.min(8, Math.floor(blocks.length / 32))), step = Math.ceil(blocks.length / count);
    const slices: SheetSlice[] = [];
    for (let start = 0; start < blocks.length; start += step) {
      const end = start + step;
      slices.push({ sheetId, after: start === 0 ? after : "", from: blockName(blocks[start]), to: end >= blocks.length ? "" : blockName(blocks[end]) });
    }
    return slices;
  }

  async getSheetSlices({ sheetIds = [] }: { sheetIds?: unknown } = {}): Promise<{ revision: number; slices: SheetSlice[] }> {
    const meta = await this.loadMeta(), orders = await this.loadOrders(meta);
    const ids = (Array.isArray(sheetIds) ? sheetIds : []).map(String).filter((id) => orders.has(id));
    return { revision: meta.revision, slices: ids.flatMap((id) => this.sheetSlices(id, orders.get(id)!)) };
  }

  // The whole workbook by position (A1 refs, formulas as A1 text, settings by index), for
  // editors from before line ids (see subscribe) and scripts. Clients use openDocument +
  // getCellsPage, which never hold or send a big workbook at once.
  async getDocument(): Promise<SheetsDocument> {
    const meta = await this.loadMeta(), book = await this.book(meta);
    const cells: Record<string, CellMap> = {};
    for (const id of meta.sheetOrder) {
      const out: CellMap = cells[id] = {};
      for (const [key, cell] of Object.entries(await this.loadCells(id))) {
        const ref = book.a1(id, key);
        if (ref) out[ref] = book.renderCell(id, cell);
      }
    }
    return { revision: meta.revision, lastModified: meta.lastModified, ...book.viewStructure(), cells };
  }

  // Structure, line orders, plus as many cells as fit one page, packed by cell key with stored
  // values. `cursors` maps each sheet that isn't complete to where it continues, and `slices`
  // lists runs of what's left that can be read side by side (`getCellsPage({ sheetId, after,
  // from, to })`). Pages can span revisions: a client compares each page's `revision`
  // (subscribers replay the events they buffered meanwhile, which makes the result exact).
  async openDocument(): Promise<OpenedDocument> {
    return this.withPageSlot(() => this.openDocumentLocked());
  }
  async openDocumentLocked(): Promise<OpenedDocument> {
    const meta = await this.loadMeta(), orders = await this.loadOrders(meta);
    const packed: Record<string, FullPackedCells> = {}, cursors: Record<string, string> = {}, slices: SheetSlice[] = [], stored: Record<string, StoredOrder> = {};
    let budget = PAGE_BYTES;
    for (const id of meta.sheetOrder) {
      const order = orders.get(id);
      if (!order) continue;
      stored[id] = order.toStored();
      if (budget <= 0) { cursors[id] = ""; slices.push(...this.sheetSlices(id, order)); continue; }
      const page = await this.readPackedPage(id, {}, budget);
      packed[id] = page.packed as FullPackedCells; // asked with versions and formats
      budget -= page.chars;
      if (page.next != null) { cursors[id] = page.next; slices.push(...this.sheetSlices(id, order, page.next)); }
    }
    return { revision: meta.revision, title: meta.title, sheetOrder: meta.sheetOrder, sheets: meta.sheets, orders: stored, packed, slices, cursors, lastModified: meta.lastModified };
  }

  async getCellsPage({ sheetId, after = "", from = "", to = "" }: { sheetId?: unknown; after?: unknown; from?: unknown; to?: unknown } = {}): Promise<CellsPage> {
    const meta = await this.loadMeta();
    const id = String(sheetId || "");
    if (!hasSheet(meta, id)) return { revision: meta.revision, sheetId: id, packed: { refs: [], values: [], versions: [], styles: [], fmts: [] }, next: null, missing: true };
    const page = await this.withPageSlot(() => this.readPackedPage(id, { after: String(after || ""), from: String(from || ""), to: String(to || "") }, PAGE_BYTES));
    return { revision: meta.revision, sheetId: id, packed: page.packed as FullPackedCells, next: page.next };
  }

  // Cells for exports, compactly and by position: parallel `refs` (A1) / `values` (formulas as
  // A1 text), and `styles` (an index into this page's `fmts`, -1 for none). `revision` is -1 if
  // an edit landed while the page was read, so the exporter knows to read again.
  async exportPage({ sheetId, after = "", formats = true }: { sheetId?: unknown; after?: unknown; formats?: boolean } = {}): Promise<ExportPage> {
    const meta = await this.loadMeta(), id = String(sheetId || "");
    if (!hasSheet(meta, id)) return { revision: meta.revision, refs: [], values: [], ...(formats ? { styles: [], fmts: [] } : {}), next: null, missing: true };
    const book = await this.book(meta);
    const { packed, next } = await this.withPageSlot(() => this.readPackedPage(id, { after: String(after || "") }, EXPORT_PAGE_CHARS, { versions: false, formats }));
    const now = await this.ctx.storage.get<DocumentMeta>("meta");
    return { ...book.positionPage(id, packed), next, revision: now?.revision === meta.revision ? meta.revision : -1 };
  }

  // Sheet names, order and settings by position, without cells (exports, export menus).
  async getStructure(): Promise<StructureWithRevision> {
    const meta = await this.loadMeta(), book = await this.book(meta);
    return { revision: meta.revision, ...book.viewStructure() };
  }

  // A sheet replacement or a sort too large for one message arrives as numbered parts, keyed by
  // cell key, held here until the applyOperation naming its `uploadId` claims it. Re-sent parts
  // are ignored. Uploads live in memory: if the object restarts first, applyOperation answers
  // "upload-missing" and the client sends them again. One untouched for 10 minutes is dropped.
  stageCells({ uploadId, sheetId, part, cells }: { uploadId?: unknown; sheetId?: unknown; part?: unknown; cells?: unknown } = {}): { received: number } {
    const id = String(uploadId || "");
    if (!id || id.length > 80) throw new Error("Bad upload id");
    const now = Date.now();
    for (const [key, upload] of this.uploads) if (now - upload.at > 10 * 60 * 1000) this.uploads.delete(key);
    let upload = this.uploads.get(id);
    if (!upload) { upload = { sheetId: String(sheetId || ""), cells: new Map(), parts: new Set(), at: now, chars: 0 }; this.uploads.set(id, upload); }
    upload.at = now;
    const index = Math.max(0, Math.round(Number(part)) || 0);
    if (!upload.parts.has(index)) {
      const entries = sanitizeCellEntries(cells, isCellKey, true), added = cellChars(entries.values());
      // Everything staged is held in memory, so all uploads together are bounded.
      let staged = added;
      for (const other of this.uploads.values()) staged += other.chars;
      if (staged > MAX_STAGED_CHARS) {
        this.uploads.delete(id);
        throw new Error(`This change is too large to save at once: more than ${MAX_STAGED_CHARS.toLocaleString("en-US")} characters of cells are being uploaded. Make it in smaller steps.`);
      }
      upload.parts.add(index);
      upload.chars += added;
      for (const [ref, cell] of entries) upload.cells.set(ref, cell);
    }
    return { received: upload.cells.size };
  }

  async applyOperation(operation: Operation | null): Promise<OperationResult> {
    if (!isLoose(operation)) throw new Error("applyOperation takes an operation object");
    return this.queue.run(() => this.applyOperationLocked(operation));
  }
  async applyOperationLocked(operation: Operation): Promise<OperationResult> {
    const meta = await this.loadMeta();
    // An editor from before line ids names cells by position and sends settings by index; it's
    // translated by where lines are now, as it would have been applied before ids.
    const legacy = operation.lineIds !== true;
    // An operation sent again after its reply was lost is answered, not applied a second time.
    const opId = !legacy && typeof operation.id === "string" && operation.id ? operation.id.slice(0, 64) : null;
    const prior = opId ? meta.recentOps?.find((op) => op.id === opId) : undefined;
    const replacements = (Array.isArray(operation.sheetReplacements) ? operation.sheetReplacements : []).filter(isLoose);
    const sorts = legacy || !Array.isArray(operation.sorts) ? [] : operation.sorts.filter(isLoose);
    const uploads = [...replacements, ...sorts].filter((write) => write.uploadId != null).map((write) => ({ id: String(write.uploadId), write }));
    const release = () => { for (const { id } of uploads) this.uploads.delete(id); };
    if (prior) { release(); return this.replayAck(meta, operation, prior); }
    // A staged write must be complete before anything is applied.
    for (const { id, write } of uploads) {
      const upload = this.uploads.get(id);
      if (!upload || upload.sheetId !== String(write.sheetId || "") || upload.cells.size !== Number(write.count)) {
        return { status: "upload-missing", revision: meta.revision, conflicts: [] };
      }
    }
    const namesBefore = sheetNames(meta);
    const orders = new Map(await this.loadOrders(meta));
    await this.loadSorts();
    const changedOrders = new Set<string>();
    // The sheet's order, cloned the first time this operation changes it.
    const own = (id: string): SheetOrder => {
      if (!changedOrders.has(id)) { orders.set(id, (orders.get(id) as SheetOrder).clone()); changedOrders.add(id); }
      return orders.get(id) as SheetOrder;
    };
    const batch = new WriteBatch(this.ctx.storage);
    const writer = new CellWriter(this);
    const dead = new DeadLines();
    let changed = false, structureChanged = false;

    // --- Sheets this operation creates ------------------------------------
    // They exist from the start, in identity order at the size they were made with, so the
    // operation's replacements and line operations can name them.
    const created = new Set<string>();
    // A snapshot from before someone deleted a sheet still names it; it stays deleted.
    const deletedSheets = new Set(meta.deletedSheets || []);
    const structureIn = isLoose(operation.structure) ? operation.structure : null;
    if (!legacy && structureIn && Array.isArray(structureIn.sheetOrder)) {
      for (const raw of structureIn.sheetOrder) {
        const id = String(raw);
        if (hasSheet(meta, id) || created.has(id) || !SHEET_ID.test(id) || id === "__proto__" || deletedSheets.has(id)) continue;
        const incoming: Loose = (isLoose(structureIn.sheets) && Object.hasOwn(structureIn.sheets, id) && isLoose(structureIn.sheets[id]) && structureIn.sheets[id]) || {};
        orders.set(id, SheetOrder.from(null, clampInt(incoming.rows, 1, MAX_ROWS, DEFAULT_ROWS), clampInt(incoming.cols, 1, MAX_COLS, DEFAULT_COLS)));
        changedOrders.add(id); created.add(id);
      }
    }

    // --- Whole-sheet replacements -----------------------------------------
    // By id (the current client), a replacement comes before the line operations: the sheet starts
    // over, and lines changed after it apply to it. By position (an older editor), it comes after
    // the structure, as it always has.
    const replaced = new Map<string, Map<string, Cell>>(); // sheetId -> its new cells
    const replaceSheets = () => {
      for (const rep of replacements) {
        const id = String(rep.sheetId || "");
        if (legacy ? !hasSheet(meta, id) : !orders.has(id)) continue;
        const staged = rep.uploadId != null ? (this.uploads.get(String(rep.uploadId)) as Upload).cells : null; // checked above
        let next: Map<string, Cell>;
        if (legacy) {
          // By position: the cells at the lines' current places (an older editor's insert or sort).
          const order = orders.get(id)!, ctx = new OrderBook(meta, orders).ctx(id);
          next = new Map();
          for (const [ref, cell] of sanitizeCellEntries(rep.cells, isGridRef)) {
            const p = parseCellRef(ref), key = p && order.keyAt(p.r, p.c);
            if (key) next.set(key, { ...cell, value: clipValue(toStored(cell.value, ctx)) });
          }
        } else {
          // A regenerated sheet starts over in identity order at its new size.
          const size: Loose = isLoose(rep.size) ? rep.size : {}, now = orders.get(id)!;
          const rows = clampInt(size.rows, 1, MAX_ROWS, now.rows.size), cols = clampInt(size.cols, 1, MAX_COLS, now.cols.size);
          orders.set(id, SheetOrder.from(null, rows, cols)); changedOrders.add(id);
          next = new Map();
          for (const [key, cell] of staged || sanitizeCellEntries(rep.cells, isCellKey)) {
            const ids = parseCellKey(key);
            if (ids && ids.row < rows && ids.col < cols) next.set(key, { ...cell, version: Math.max(1, cell.version) });
          }
          structureChanged = true;
        }
        writer.replace(id, next);
        replaced.set(id, next);
        changed = true;
      }
    };
    if (!legacy) replaceSheets();

    // --- Line operations, by id, in order ---------------------------------
    const lineOps: LineOp[] = [], refusedLines: LineOp[] = [];
    const applyLine = (op: LineOp) => {
      own(op.sheetId).axis(op.axis).apply(op);
      if (op.kind === "delete") dead.add(op.sheetId, op.axis, op.ids);
      lineOps.push(op);
    };
    for (const raw of legacy || !Array.isArray(operation.lineOps) ? [] : operation.lineOps) {
      const sent = sanitizeLineOp(raw);
      const order = sent && orders.get(sent.sheetId);
      if (!sent) continue;
      if (!order) { refusedLines.push(sent); continue; }
      const op = remainingLineOp(sent, order.axis(sent.axis));
      if (!op) continue;
      if (order.axis(op.axis).refusal(op, op.axis === "rows" ? MAX_ROWS : MAX_COLS)) { refusedLines.push(op); continue; }
      applyLine(op);
    }

    // --- Structure (applied wholesale; omitted fields keep their values) --
    // A filter sent here was made after this operation's line changes (see afterLineChange).
    const sentFilters = new Set<string>();
    if (operation.structure) {
      const s = operation.structure;
      // An id becomes part of every key of its sheet, so a new one must be plain (a sheet "a"
      // would otherwise read the blocks of a sheet "a:b", and "__proto__" can't be a key).
      const incomingOrder = Array.isArray(s.sheetOrder) ? [...new Set(s.sheetOrder.map(String))].filter((id) => hasSheet(meta, id) || (SHEET_ID.test(id) && id !== "__proto__" && !deletedSheets.has(id))) : [];
      // A workbook always has a sheet, so an order naming none keeps the stored one.
      const order = incomingOrder.length ? incomingOrder : meta.sheetOrder.slice();
      // A snapshot built on an older revision can't name a sheet created since (by the agent or
      // another client): that sheet stays, where it was, rather than being deleted with its cells.
      const base = Number.isInteger(s.revision) ? s.revision as number : null;
      if (base !== null) {
        meta.sheetOrder.forEach((id, index) => {
          if (!order.includes(id) && (meta.sheets[id]?.created || 0) > base) order.splice(Math.min(index, order.length), 0, id);
        });
      }
      const views: Record<string, SheetMeta> = {};
      for (const id of order) {
        const incoming: Loose = (s.sheets && Object.hasOwn(s.sheets, id) && isLoose(s.sheets[id]) && s.sheets[id]) || {};
        const exists = hasSheet(meta, id);
        if (!legacy && Object.hasOwn(incoming, "filter")) sentFilters.add(id);
        if (!exists && !orders.has(id)) {
          // A new sheet starts in identity order, at the size it was made with.
          orders.set(id, SheetOrder.from(null, clampInt(incoming.rows, 1, MAX_ROWS, DEFAULT_ROWS), clampInt(incoming.cols, 1, MAX_COLS, DEFAULT_COLS)));
          changedOrders.add(id);
        } else if (exists && legacy) {
          // An editor by position grows or shrinks a sheet at its end (after an insert, its
          // replacement moved the cells).
          for (const axis of ["rows", "cols"] as Axis[]) {
            const line = orders.get(id)!.axis(axis), want = clampInt(incoming[axis], 1, axis === "rows" ? MAX_ROWS : MAX_COLS, line.size);
            if (want > line.size) applyLine({ kind: "insert", sheetId: id, axis, ids: newLineIds(want - line.size), before: null });
            else if (want < line.size) applyLine({ kind: "delete", sheetId: id, axis, ids: line.live().slice(want) });
          }
        }
        const orderOf = (sheetId: string) => orders.get(sheetId);
        // Fields are merged as editors see them (by position), then cleaned and stored by id.
        const existing = exists ? viewSheet(meta.sheets[id], orderOf) : null;
        const sent = legacy ? incoming : viewSheet(storedShape(incoming, id), orderOf);
        const field = <K extends keyof SheetMeta>(key: K): SheetMeta[K] | undefined => (Object.hasOwn(incoming, key) ? (sent as Loose)[key] : existing?.[key]) as SheetMeta[K] | undefined;
        views[id] = sheetMeta({
          id,
          name: field("name") ?? "Sheet",
          rows: orders.get(id)!.rows.size,
          cols: orders.get(id)!.cols.size,
          colWidths: field("colWidths"),
          rowHeights: field("rowHeights"),
          frozenRows: field("frozenRows"),
          frozenCols: field("frozenCols"),
          filter: field("filter"),
          charts: field("charts"),
          pivot: field("pivot"),
          created: exists ? meta.sheets[id].created : meta.revision + 1,
        });
        // A filter's row order is by position: one from a snapshot older than someone else's
        // change to the sheet's lines describes rows that have moved, so it starts over.
        const filter = views[id].filter;
        if (!legacy && filter && Object.hasOwn(incoming, "filter") && base !== null && (meta.linesChanged?.[id] ?? 0) > base) views[id].filter = { ...filter, rowOrder: [], sort: null };
      }
      // A pivot's range lives on its source sheet, which may appear later in the order.
      for (const sheet of Object.values(views)) {
        if (!sheet.pivot) continue;
        const source = Object.hasOwn(views, sheet.pivot.sourceSheetId) ? views[sheet.pivot.sourceSheetId] : null;
        sheet.pivot.sourceRange = source ? sanitizeRange(sheet.pivot.sourceRange, source.rows, source.cols, false) : "";
      }
      // Drop the cells and lines of removed sheets.
      for (const id of meta.sheetOrder) if (!Object.hasOwn(views, id)) { writer.clear(id); orders.delete(id); changedOrders.delete(id); batch.delete(ORDER_PREFIX + id); noteDeletedSheet(meta, id); }
      meta.sheetOrder = order;
      meta.sheets = Object.fromEntries(order.map((id) => [id, storeSheet(views[id], (sheetId) => orders.get(sheetId))]));
      if (typeof s.title === "string") meta.title = s.title.slice(0, 200) || DEFAULT_TITLE;
      changed = structureChanged = true;
    }

    if (legacy) replaceSheets();

    // Each sheet's cells this operation has read or written, so later steps see earlier ones.
    const working = new Map<string, Map<string, Cell>>(replaced);
    const readWorking = async (sheetId: string, keys: string[]) => {
      let cells = working.get(sheetId);
      if (!cells) working.set(sheetId, cells = new Map());
      if (replaced.has(sheetId)) return cells;
      const missing = keys.filter((key) => !cells.has(key));
      for (const [key, cell] of await writer.read(sheetId, missing)) if (!cells.has(key)) cells.set(key, cell);
      return cells;
    };
    const upserts: CellUpsert[] = [], deletes: CellDeletion[] = [];
    const write = (sheetId: string, cells: Map<string, Cell>, key: string, next: Cell | null) => {
      if (next) { cells.set(key, next); writer.put(sheetId, key, next); upserts.push({ sheetId, ref: key, cell: next }); }
      else { cells.delete(key); writer.delete(sheetId, key); deletes.push({ sheetId, ref: key }); }
    };

    // --- Sorts: all of a sort's cells, or none -----------------------------
    const conflicts: CellConflict[] = [], refusedSorts: string[] = [], sortRecords: SortRecord[] = [];
    for (const sort of sorts) {
      const id = String(sort.sheetId || "");
      if (!hasSheet(meta, id)) continue;
      const order = orders.get(id)!;
      const entries: { key: string; value: string | null; fmt: CellFmt | null; base: number }[] = [];
      if (sort.uploadId != null) {
        for (const [key, cell] of (this.uploads.get(String(sort.uploadId)) as Upload).cells) {
          entries.push(cell.value === "" && !cell.fmt ? { key, value: null, fmt: null, base: cell.version } : { key, value: cell.value, fmt: cell.fmt, base: cell.version });
        }
      } else {
        for (const op of Array.isArray(sort.cellOps) ? sort.cellOps.filter(isLoose) : []) {
          const key = String(op.ref || "");
          if (isCellKey(key)) entries.push({ key, value: op.value == null ? null : String(op.value), fmt: sanitizeFmt(op.fmt), base: Math.max(0, Number(op.baseVersion) || 0) });
        }
      }
      const cells = await readWorking(id, entries.map((entry) => entry.key));
      let ok = true;
      for (const entry of entries) {
        const cur = cells.get(entry.key);
        if (!order.liveKey(entry.key)) ok = false;
        else if ((cur?.version || 0) !== entry.base) { ok = false; if (cur) conflicts.push({ sheetId: id, ref: entry.key, cell: cur }); }
      }
      if (!ok) { refusedSorts.push(id); continue; }
      for (const entry of entries) {
        const cur = cells.get(entry.key);
        if (entry.value == null && !entry.fmt) { if (cur) write(id, cells, entry.key, null); }
        else write(id, cells, entry.key, { value: clipValue(entry.value ?? ""), fmt: entry.fmt, version: (cur?.version || 0) + 1 });
      }
      const rows = sanitizeIds(sort.rows);
      // Rows too scattered to keep cheaply are kept as every row.
      sortRecords.push({ sheetId: id, senderId: operation.senderId, revision: meta.revision + 1, rows: idRuns(new Set(rows)).length > MAX_SORT_RUNS ? null : new Set(rows), cols: new Set(sanitizeIds(sort.cols)) });
    }
    // A sort is computed from the cells as they were; with one of them changed it would put
    // someone's edit in the wrong record, so nothing is applied and the sender sorts again.
    if (refusedSorts.length) {
      release();
      return { status: "conflict", revision: meta.revision, conflicts, refusedSorts };
    }
    if (sortRecords.length) changed = true;

    // --- Per-cell operations (optimistic concurrency) --------------------
    const gone: CellDeletion[] = [], sorted: CellDeletion[] = [];
    const bySheet = new Map<string, Loose[]>();
    for (const op of Array.isArray(operation.cellOps) ? operation.cellOps : []) {
      if (!isLoose(op)) continue;
      const sid = String(op.sheetId || "");
      let ops = bySheet.get(sid);
      if (!ops) bySheet.set(sid, ops = []);
      ops.push(op);
    }
    const book = new OrderBook(meta, orders);
    for (const [sheetId, ops] of bySheet) {
      if (!hasSheet(meta, sheetId)) continue;
      const order = orders.get(sheetId)!, ctx = book.ctx(sheetId);
      // A position names the cell there now; a key names its cell wherever it is.
      const keyOf = (ref: string) => {
        if (!legacy) return isCellKey(ref) ? ref : null;
        const p = isGridRef(ref) ? parseCellRef(ref) : null;
        return p && order.keyAt(p.r, p.c);
      };
      const items = ops.map((op) => ({ op, ref: String(op.ref || ""), key: keyOf(String(op.ref || "")) }));
      const cells = await readWorking(sheetId, items.flatMap((item) => (item.key ? [item.key] : [])));
      for (const { op, ref, key } of items) {
        if (!key) continue;
        if (!order.liveKey(key)) { gone.push({ sheetId, ref }); continue; }
        if (typeof op.basis === "number" && this.sortedSince(sheetId, key, op.basis, operation.senderId)) { sorted.push({ sheetId, ref }); continue; }
        const cur = cells.get(key);
        const base = Number(op.baseVersion || 0);
        if (op.value == null && op.fmt == null) {
          if (!cur) continue;
          if (cur.version !== base) { conflicts.push({ sheetId, ref: key, cell: cur }); continue; }
          write(sheetId, cells, key, null);
        } else {
          if (cur && cur.version !== base) { conflicts.push({ sheetId, ref: key, cell: cur }); continue; }
          const text = op.value == null ? "" : String(op.value);
          write(sheetId, cells, key, { value: clipValue(legacy ? toStored(text.slice(0, MAX_VALUE_CHARS), ctx) : text), fmt: sanitizeFmt(op.fmt), version: (cur?.version || 0) + 1 });
        }
      }
    }
    if (upserts.length || deletes.length) changed = true;

    // Settings and cells on the lines this operation deleted go with them.
    if (lineOps.length) {
      for (const id of changedOrders) if (meta.sheets[id]) meta.sheets[id] = afterLineChange(meta.sheets[id], orders.get(id)!, lineOps.filter((op) => op.sheetId === id), sentFilters.has(id));
      await this.dropDeadCells(dead, writer, replaced);
      changed = structureChanged = true;
    }
    for (const id of changedOrders) if (meta.sheets[id]) Object.assign(meta.sheets[id], { rows: orders.get(id)!.rows.size, cols: orders.get(id)!.cols.size });

    const refusals = {
      ...(gone.length ? { gone } : {}), ...(sorted.length ? { sorted } : {}), ...(refusedLines.length ? { refusedLines } : {}),
    };
    // A sheet whose lines the sender changed gets its order in the reply even if nothing was left
    // to do (the operation was sent again), so the sender learns where its lines are.
    const named = new Set((legacy || !Array.isArray(operation.lineOps) ? [] : operation.lineOps).map((op) => String(isLoose(op) ? op.sheetId : "")).filter((id) => orders.has(id)));
    if (!changed) {
      const ordersOf = named.size ? { orders: Object.fromEntries([...named].map((id) => [id, orders.get(id)!.toStored()])) } : {};
      return this.ackFor(legacy, book, { status: conflicts.length ? "conflict" : "unchanged", revision: meta.revision, conflicts, ...ordersOf, ...refusals });
    }

    await writer.plan(batch);
    for (const id of changedOrders) if (orders.has(id)) batch.put(ORDER_PREFIX + id, orders.get(id)!.toStored(), 2000);
    meta.revision += 1;
    meta.lastModified = Date.now();
    noteLinesChanged(meta, [...changedOrders].filter((id) => orders.has(id)));
    if (opId) rememberOperation(meta, opId, { conflicts: conflicts.map(({ sheetId, ref }) => ({ sheetId, ref })), gone, sorted, refusedLines });
    if (sortRecords.length) this.noteSorts(sortRecords, batch);
    batch.put("meta", meta);
    await batch.flush();
    release();
    this.orderCache = { revision: meta.revision, orders };

    // The sender already has a replaced sheet's cells; peers get them in the event, or, for a
    // big sheet, `null`, which tells them to load that sheet in pages.
    const event: OperationEvent = {
      type: "operation",
      senderId: operation.senderId,
      revision: meta.revision,
      ...(lineOps.length ? { lineOps } : {}),
      ...(changedOrders.size || named.size ? { orders: Object.fromEntries([...new Set([...changedOrders, ...named])].filter((id) => orders.has(id)).map((id) => [id, orders.get(id)!.toStored()])) } : {}),
      // A filter's row order makes a big sheet's structure large, so a cell edit doesn't repeat it.
      ...(structureChanged ? { structure: { sheetOrder: meta.sheetOrder, sheets: meta.sheets, title: meta.title } } : {}),
      upserts,
      deletes,
      replacedSheets: [...replaced.keys()],
      lastModified: meta.lastModified,
    };
    if (replaced.size) {
      const replacedCells: Record<string, CellMap | null> = event.replacedCells = {}, fits = inlineAllowance();
      for (const [id, cells] of replaced) replacedCells[id] = fits(cells.values(), cells.size, INLINE_REPLACEMENT_CELLS) ? Object.fromEntries(cells) : null;
    }
    const after = new OrderBook(meta, orders);
    // Don't hold the sender's save on slow or half-open clients.
    this.broadcast(event, after, relabelled(namesBefore, meta)).catch(() => {});

    const { replacedCells: _, ...ack } = event;
    return this.ackFor(legacy, after, { status: conflicts.length ? "conflict" : "applied", ...ack, conflicts, ...refusals });
  }

  // The reply to an operation applied before (its first reply was lost), from where things are
  // now: the current state of every cell it wrote, which a later write may have changed, and the
  // orders of the sheets whose lines it changed. What it refused is refused again; a cell that
  // conflicted is a conflict again, at its version now.
  async replayAck(meta: DocumentMeta, operation: Operation, prior: RecentOperation): Promise<OperationResult> {
    const orders = await this.loadOrders(meta);
    const keys = new Map<string, Set<string>>();
    const add = (sheetId: unknown, key: unknown) => {
      const id = String(sheetId || ""), ref = String(key || "");
      if (!hasSheet(meta, id) || !isCellKey(ref)) return;
      let set = keys.get(id);
      if (!set) keys.set(id, set = new Set());
      set.add(ref);
    };
    for (const op of Array.isArray(operation.cellOps) ? operation.cellOps.filter(isLoose) : []) add(op.sheetId, op.ref);
    for (const sort of Array.isArray(operation.sorts) ? operation.sorts.filter(isLoose) : []) {
      if (Array.isArray(sort.cellOps)) for (const op of sort.cellOps.filter(isLoose)) add(sort.sheetId, op.ref);
      // A staged sort's cells are gone with its upload: they're the cells of the lines it sorted.
      else { const cols = sanitizeIds(sort.cols); for (const row of sanitizeIds(sort.rows)) for (const col of cols) add(sort.sheetId, row + ":" + col); }
    }
    const refused = prior.refused, conflicted = new Set((refused?.conflicts || []).map(({ sheetId, ref }) => sheetId + "!" + ref));
    const skipped = new Set([...(refused?.gone || []), ...(refused?.sorted || [])].map(({ sheetId, ref }) => sheetId + "!" + ref));
    const upserts: CellUpsert[] = [], deletes: CellDeletion[] = [], conflicts: CellConflict[] = [];
    for (const [sheetId, set] of keys) {
      const cells = await this.readCells(sheetId, set);
      for (const ref of set) {
        if (skipped.has(sheetId + "!" + ref)) continue;
        const cell = cells.get(ref);
        if (cell && conflicted.has(sheetId + "!" + ref)) conflicts.push({ sheetId, ref, cell });
        else if (cell) upserts.push({ sheetId, ref, cell });
        else deletes.push({ sheetId, ref });
      }
    }
    // Every sheet the operation could have made or changed the lines of: those its line
    // operations and replacements name, and those its structure lists (it may have created them).
    const structureIds = isLoose(operation.structure) && Array.isArray(operation.structure.sheetOrder) ? operation.structure.sheetOrder.map(String) : [];
    const named = new Set([
      ...(Array.isArray(operation.lineOps) ? operation.lineOps : []).filter(isLoose).map((op) => String(op.sheetId || "")),
      ...(Array.isArray(operation.sheetReplacements) ? operation.sheetReplacements : []).filter(isLoose).map((rep) => String(rep.sheetId || "")),
      ...structureIds,
    ].filter((id) => orders.has(id)));
    return {
      status: conflicts.length ? "conflict" : "applied",
      revision: meta.revision,
      lastModified: meta.lastModified,
      conflicts,
      upserts,
      deletes,
      structure: { sheetOrder: meta.sheetOrder, sheets: meta.sheets, title: meta.title },
      ...(named.size ? { orders: Object.fromEntries([...named].map((id) => [id, orders.get(id)!.toStored()])) } : {}),
      ...(refused?.gone.length ? { gone: refused.gone } : {}),
      ...(refused?.sorted.length ? { sorted: refused.sorted } : {}),
      ...(refused?.refusedLines.length ? { refusedLines: refused.refusedLines } : {}),
    };
  }

  // A reply as its sender reads it: an editor from before line ids gets cells by position.
  ackFor(legacy: boolean, book: OrderBook, result: OperationResult): OperationResult {
    if (!legacy) return result;
    const cells = <T extends { sheetId: string; ref: string; cell?: Cell }>(list: T[] | undefined) => (list || []).flatMap((item) => {
      const ref = book.a1(item.sheetId, item.ref);
      return ref ? [{ ...item, ref, ...(item.cell ? { cell: book.renderCell(item.sheetId, item.cell) } : {}) }] : [];
    });
    const { lineOps: _lines, orders: _orders, structure, ...rest } = result;
    return { ...rest, ...(structure ? { structure: book.viewStructure() } : {}), upserts: cells(result.upserts), deletes: cells(result.deletes), conflicts: cells(result.conflicts) };
  }

  // Deletes the cells on lines an operation deleted: the blocks of deleted rows, and, for deleted
  // columns, every block of the sheet.
  async dropDeadCells(dead: DeadLines, writer: CellWriter, replaced: Map<string, Map<string, Cell>>): Promise<void> {
    for (const [sheetId, lines] of dead.sheets) {
      const gone = (key: string) => { const ids = parseCellKey(key); return !!ids && (lines.rows.has(ids.row) || lines.cols.has(ids.col)); };
      const drop = (key: string) => { if (gone(key)) writer.delete(sheetId, key); };
      // A sheet replaced in this operation holds only its new cells (the writer's own map).
      const fresh = replaced.get(sheetId);
      if (fresh) { for (const key of [...fresh.keys()]) if (gone(key)) fresh.delete(key); continue; }
      if (lines.cols.size) {
        for await (const { part } of this.blockParts(sheetId)) for (const key of part.refs) drop(key);
      } else if (lines.rows.size) {
        const blocks = await this.readBlocks(sheetId, [...new Set([...lines.rows].map((id) => Math.floor(id / BLOCK_ROWS)))]);
        for (const block of blocks.values()) for (const key of block.cells.keys()) drop(key);
      }
    }
  }

  async loadSorts(): Promise<NonNullable<Gadget["sorts"]>> {
    if (this.sorts) return this.sorts;
    const stored = await this.ctx.storage.get<SortLog>("sorts");
    const toSet = (runs: [number, number][]) => new Set(runs.flatMap(([start, count]) => Array.from({ length: count }, (_, i) => start + i)));
    const records = (stored?.records || []).map((record) => ({ sheetId: record.sheetId, senderId: record.senderId, revision: record.revision, rows: record.rows && toSet(record.rows), cols: toSet(record.cols) }));
    return this.sorts = { records, forgotten: { ...(stored?.forgotten || {}) } };
  }
  // Whether a sort by someone else, landed after `basis`, rewrote this cell (or may have: a sort
  // of its sheet since forgotten). Loaded first (loadSorts).
  sortedSince(sheetId: string, key: string, basis: number, senderId: string | undefined): boolean {
    const ids = parseCellKey(key), log = this.sorts;
    if (!ids || !log) return false;
    if ((log.forgotten[sheetId] ?? -1) > basis) return true;
    return log.records.some((sort) => sort.sheetId === sheetId && sort.revision > basis && (sort.senderId === undefined || sort.senderId !== senderId) && (!sort.rows || sort.rows.has(ids.row)) && sort.cols.has(ids.col));
  }
  // The last MAX_SORT_RECORDS sorts are kept, with the operation that made them.
  noteSorts(records: SortRecord[], batch: WriteBatch): void {
    const log = this.sorts!;
    const all = [...log.records, ...records];
    for (const old of all.slice(0, Math.max(0, all.length - MAX_SORT_RECORDS))) log.forgotten[old.sheetId] = Math.max(log.forgotten[old.sheetId] ?? -1, old.revision);
    log.records = all.slice(-MAX_SORT_RECORDS);
    const stored: SortLog = {
      records: log.records.map((sort) => ({ sheetId: sort.sheetId, ...(sort.senderId === undefined ? {} : { senderId: sort.senderId }), revision: sort.revision, rows: sort.rows && idRuns(sort.rows), cols: idRuns(sort.cols) })),
      forgotten: log.forgotten,
    };
    batch.put("sorts", stored, JSON.stringify(stored).length);
  }
  // --- Cell API for agents & scripts --------------------------------------
  // Granular, name-friendly methods. Each goes through the mutation queue,
  // bumps versions only for cells whose value or format really changed,
  // persists, and broadcasts a normal operation event with senderId "agent"
  // (without waiting for slow clients), so open sheets animate the change.
  // `sheet` is a sheet id or name (case-insensitive); omitted = first sheet.
  // Rows in the API are 1-based row numbers; columns are letters ("C") or
  // 1-based numbers. Values are stored as text; begin with "=" for a formula.
  // Cells, formulas and settings are read and written by position (A1), as
  // lines stand at the moment.

  async listSheets(): Promise<{ revision: number; sheets: SheetSummary[] }> {
    const meta = await this.loadMeta(), book = await this.book(meta);
    const sheets: SheetSummary[] = [];
    for (const id of meta.sheetOrder) {
      const s = book.view(id), { used, cellCount } = await this.sheetUsage(id, book.order(id)!);
      sheets.push({
        id, name: s.name, rows: s.rows, cols: s.cols,
        usedRange: used && areaRef(used), cellCount,
        filter: s.filter ? { headerRow: s.filter.row + 1, columns: s.filter.columns.map((c) => colLetters(c)) } : null,
        charts: (s.charts || []).map((c) => ({ id: c.id, type: c.type, range: c.range, title: c.title })),
        pivot: !!s.pivot,
      });
    }
    return { revision: meta.revision, sheets };
  }

  // From A1 to the last row and column holding a value or format (null for none), and how many
  // cells are stored, read block by block.
  async sheetUsage(id: string, order: SheetOrder): Promise<{ used: Area | null; cellCount: number }> {
    let r2 = -1, c2 = -1, cellCount = 0;
    for await (const { part } of this.blockParts(id)) {
      const { refs, values, styles } = part;
      cellCount += refs.length;
      for (let i = 0; i < refs.length; i++) {
        if (values[i] === "" && styles[i] < 0) continue;
        const p = order.positionOf(refs[i]);
        if (p) { if (p.r > r2) r2 = p.r; if (p.c > c2) c2 = p.c; }
      }
    }
    return { used: r2 < 0 ? null : { r1: 0, c1: 0, r2, c2 }, cellCount };
  }

  // Stored values, formulas as their A1 text (the server doesn't evaluate).
  async readRange({ sheet, range, formats = false }: { sheet?: string; range?: string; formats?: boolean } = {}): Promise<ReadRangeResult> {
    const meta = await this.loadMeta(), book = await this.book(meta);
    const id = resolveSheetId(meta, sheet), order = book.order(id)!;
    // No range is the used range, found without holding the sheet.
    const area = range ? parseArea(range) : (await this.sheetUsage(id, order)).used || { r1: 0, c1: 0, r2: 0, c2: 0 };
    if ((area.r2 - area.r1 + 1) * (area.c2 - area.c1 + 1) > 50000) throw new Error("Range too large to read at once (max 50,000 cells); read it in parts");
    const keys = new Set<string>();
    for (let r = area.r1; r <= area.r2; r++) for (let c = area.c1; c <= area.c2; c++) { const key = order.keyAt(r, c); if (key) keys.add(key); }
    const cells = await this.readCells(id, keys);
    const values: string[][] = [], fmts: (CellFmt | null)[][] = [];
    for (let r = area.r1; r <= area.r2; r++) {
      const row: string[] = [], frow: (CellFmt | null)[] = [];
      for (let c = area.c1; c <= area.c2; c++) {
        const key = order.keyAt(r, c), cell = key ? cells.get(key) : undefined;
        row.push(cell ? book.renderValue(id, cell.value) : "");
        frow.push(cell?.fmt ?? null);
      }
      values.push(row);
      fmts.push(frow);
    }
    return {
      revision: meta.revision, sheetId: id, sheet: meta.sheets[id].name,
      range: areaRef(area), values, ...(formats ? { formats: fmts } : {}),
    };
  }
  // cells: { A1: "Revenue", B2: 42, C3: "=SUM(B1:B9)", D4: null,
  //          E5: { value?, fmt? } }. A plain value keeps the cell's format;
  // null clears the cell; `fmt` merges into the existing format (a key set
  // to null removes it; fmt: null removes all formatting).
  setCells({ sheet, cells = {} }: { sheet?: string; cells?: Record<string, CellSpec> } = {}): Promise<AgentWriteResult> {
    if (!cells || typeof cells !== "object" || Array.isArray(cells)) throw new Error('cells must be an object such as { A1: "Revenue", B2: 42 }');
    for (const spec of Object.values(cells)) if (spec && typeof spec === "object") checkFmt(spec.fmt);
    return this.mutateCells(sheet, ({ write, read }) => {
      for (const [ref, spec] of Object.entries(cells || {})) {
        const cur = read(ref);
        if (spec === null) { write(ref, null); continue; }
        if (typeof spec !== "object") { write(ref, { value: spec, fmt: cur?.fmt ?? null }); continue; }
        write(ref, {
          value: spec.value === undefined ? cur?.value ?? "" : spec.value,
          fmt: spec.fmt === undefined ? cur?.fmt ?? null : spec.fmt === null ? null : mergeFmt(cur?.fmt, spec.fmt),
        });
      }
    });
  }

  setCell({ sheet, ref, value, fmt }: { sheet?: string; ref?: string; value?: CellSpec; fmt?: FmtPatch | null } = {}): Promise<AgentWriteResult> {
    // An object `value` is a `{ value, fmt }` spec of its own, passed on as setCells reads it
    // (with `fmt`, if given, in place of its own).
    const spec = (value !== null && typeof value === "object" ? (fmt === undefined ? value : { ...value, fmt }) : fmt === undefined ? value : { value, fmt }) as CellSpec;
    return this.setCells({ sheet, cells: { [String(ref)]: spec } });
  }

  // A rectangular block of values (rows of cells) starting at `start`.
  // `fmt`, if given, is merged into every written cell; `null` clears their formatting.
  setRange({ sheet, start = "A1", values = [], fmt }: { sheet?: string; start?: string; values?: unknown[]; fmt?: FmtPatch | null } = {}): Promise<AgentWriteResult> {
    const origin = parseCellRef(start);
    if (!origin) throw new Error(`Bad start cell: ${start}`);
    if (!Array.isArray(values)) throw new Error("values must be an array of rows, such as [[1, 2], [3, 4]]");
    checkFmt(fmt);
    return this.mutateCells(sheet, ({ write, read }) => {
      values.forEach((row, dr) => {
        (Array.isArray(row) ? row : [row]).forEach((value: unknown, dc: number) => {
          const ref = colLetters(origin.c + dc) + (origin.r + dr + 1);
          const cur = read(ref);
          if (value === undefined) return;
          write(ref, { value: value ?? "", fmt: fmt === undefined ? cur?.fmt ?? null : fmt === null ? null : mergeFmt(cur?.fmt, fmt) });
        });
      });
    });
  }

  formatRange({ sheet, range, fmt }: { sheet?: string; range?: string; fmt?: FmtPatch | null } = {}): Promise<AgentWriteResult> {
    const area = parseArea(range);
    if (fmt === undefined) throw new Error("formatRange needs fmt (or fmt: null to clear formatting)");
    checkFmt(fmt);
    if ((area.r2 - area.r1 + 1) * (area.c2 - area.c1 + 1) > 50000) throw new Error("Range too large to format at once (max 50,000 cells)");
    return this.mutateCells(sheet, ({ write, read }) => {
      for (let r = area.r1; r <= area.r2; r++) for (let c = area.c1; c <= area.c2; c++) {
        const ref = colLetters(c) + (r + 1);
        const cur = read(ref);
        write(ref, { value: cur?.value ?? "", fmt: fmt === null ? null : mergeFmt(cur?.fmt, fmt) });
      }
    });
  }

  // Clears values; formatting stays unless formats: true.
  // A big area (whole columns of a long sheet) visits only the cells that exist in it.
  clearRange({ sheet, range, formats = false }: { sheet?: string; range?: string; formats?: boolean } = {}): Promise<AgentWriteResult> {
    const area = parseArea(range);
    const huge = (area.r2 - area.r1 + 1) * (area.c2 - area.c1 + 1) > 50000;
    const prepare = huge ? async (id: string, order: SheetOrder) => {
      // Blocks hold rows by id, not position, so every block is read.
      const refs: string[] = [];
      for await (const { part } of this.blockParts(id)) {
        for (const key of part.refs) {
          const p = order.positionOf(key);
          if (p && p.r >= area.r1 && p.r <= area.r2 && p.c >= area.c1 && p.c <= area.c2) refs.push(colLetters(p.c) + (p.r + 1));
        }
      }
      return refs;
    } : null;
    return this.mutateCells(sheet, ({ write, read, prepared }) => {
      const clear = (ref: string) => {
        const cur = read(ref);
        if (cur) write(ref, formats ? null : { value: "", fmt: cur.fmt });
      };
      if (prepared) { for (const ref of prepared) clear(ref); return; }
      for (let r = area.r1; r <= area.r2; r++) for (let c = area.c1; c <= area.c2; c++) clear(colLetters(c) + (r + 1));
    }, prepare);
  }

  // Rows are inserted before row number `at` (1-based). Lines keep their ids, so formula
  // references into the sheet (from any sheet), chart and pivot ranges, the filter and row
  // heights stay with the lines they name.
  insertRows({ sheet, at, count = 1 }: { sheet?: string; at?: number; count?: number } = {}): Promise<AgentWriteResult> { return this.changeLines(sheet, "rows", toRowIndex(at), lineCount(count)); }
  deleteRows({ sheet, at, count = 1 }: { sheet?: string; at?: number; count?: number } = {}): Promise<AgentWriteResult> { return this.changeLines(sheet, "rows", toRowIndex(at), -lineCount(count)); }
  insertCols({ sheet, at, count = 1 }: { sheet?: string; at?: string | number; count?: number } = {}): Promise<AgentWriteResult> { return this.changeLines(sheet, "cols", toColIndex(at), lineCount(count)); }
  deleteCols({ sheet, at, count = 1 }: { sheet?: string; at?: string | number; count?: number } = {}): Promise<AgentWriteResult> { return this.changeLines(sheet, "cols", toColIndex(at), -lineCount(count)); }

  addSheet({ name, rows, cols, index }: { name?: string; rows?: number; cols?: number; index?: number } = {}): Promise<AgentWriteResult & { sheetId: string; name: string }> {
    return this.queue.run(async () => {
      const meta = await this.loadMeta();
      const id = this.newId();
      let clean = String(name || "").trim().slice(0, 60);
      if (!clean) { let n = meta.sheetOrder.length + 1; while (findSheetByName(meta, "Sheet" + n)) n++; clean = "Sheet" + n; }
      if (findSheetByName(meta, clean)) throw new Error(`A sheet named "${clean}" already exists`);
      const sheet = meta.sheets[id] = sheetMeta({ id, name: clean, rows, cols, created: meta.revision + 1 });
      const at = Number.isInteger(index) ? Math.max(0, Math.min(meta.sheetOrder.length, index as number)) : meta.sheetOrder.length;
      meta.sheetOrder.splice(at, 0, id);
      // Its lines go out with it, so an open grid can place its cells and save edits to them.
      const order = SheetOrder.from(null, sheet.rows, sheet.cols);
      return { ...(await this.commitAgent(meta, { orders: new Map([[id, order]]) })), sheetId: id, name: clean };
    });
  }

  // Formulas name sheets by id, so they read the new name without being rewritten.
  renameSheet({ sheet, name }: { sheet?: string; name?: string } = {}): Promise<AgentWriteResult> {
    return this.queue.run(async () => {
      const meta = await this.loadMeta();
      const id = resolveSheetId(meta, sheet);
      const clean = String(name || "").trim().slice(0, 60);
      if (!clean) throw new Error("Sheet name can't be empty");
      const other = findSheetByName(meta, clean);
      if (other && other !== id) throw new Error(`A sheet named "${clean}" already exists`);
      if (meta.sheets[id].name === clean) return { status: "unchanged" as const, revision: meta.revision };
      meta.sheets[id] = { ...meta.sheets[id], name: clean };
      return this.commitAgent(meta, { relabel: true });
    });
  }

  deleteSheet({ sheet }: { sheet?: string } = {}): Promise<AgentWriteResult> {
    return this.queue.run(async () => {
      const meta = await this.loadMeta();
      const id = resolveSheetId(meta, sheet);
      if (meta.sheetOrder.length <= 1) throw new Error("A workbook needs at least one sheet");
      meta.sheetOrder = meta.sheetOrder.filter((x) => x !== id);
      delete meta.sheets[id];
      noteDeletedSheet(meta, id);
      const batch = new WriteBatch(this.ctx.storage), writer = new CellWriter(this);
      writer.clear(id);
      await writer.plan(batch);
      batch.delete(ORDER_PREFIX + id);
      return this.commitAgent(meta, { relabel: true }, batch);
    });
  }

  async addChart({ sheet, range, type = "line", title, xAxisTitle, yAxisTitle, legend, firstRowHeaders, firstColLabels, x, y, width, height }: AddChartOptions = {}): Promise<AgentWriteResult & { chartId: string }> {
    const area = parseArea(range);
    if (!CHART_TYPES.includes(type as ChartType)) throw new Error(`Unknown chart type "${type}" (use ${CHART_TYPES.join(", ")})`);
    const chartId = "chart_" + Math.random().toString(36).slice(2, 9);
    const filled = x === undefined || y === undefined ? await this.filledBeside(sheet, area) : new Set<number>();
    return this.editMeta(sheet, (s) => {
      if (s.charts.length >= MAX_CHARTS) throw new Error(`A sheet holds at most ${MAX_CHARTS} charts; delete one first`);
      // Default placement: beside the data, or under it with no room (lib/charts.ts), as the
      // grid places a chart made from a selection. 44 and 24 are its row and column headers.
      const colLeft = (c: number) => { let px = 44; for (let i = 0; i < c; i++) px += s.colWidths[i] || 92; return px; };
      const rowTop = (r: number) => { let py = 24; for (let i = 0; i < r; i++) py += s.rowHeights[i] || 24; return py; };
      const at = chartPlacement(area, { colLeft, rowTop, cols: s.cols, occupied: (c) => filled.has(c) }, typeof width === "number" && width >= 280 ? Math.min(1200, width) : 520);
      s.charts = sanitizeCharts([...s.charts, {
        id: chartId, type, range: areaRef(area), title: title ?? "", xAxisTitle, yAxisTitle, legend,
        firstRowHeaders, firstColLabels, x: x ?? at.x, y: y ?? at.y, width, height,
      }], s.rows, s.cols);
    }, { chartId });
  }

  // widths: { A: 180, C: 120 } (or 1-based column numbers as keys), in px.
  setColumnWidths({ sheet, widths = {} }: { sheet?: string; widths?: Record<string, number | null> } = {}): Promise<AgentWriteResult> {
    return this.editMeta(sheet, (s) => {
      const next: Record<string, number> = { ...s.colWidths };
      for (const [key, px] of Object.entries(widths || {})) {
        const c = toColIndex(/^\d+$/.test(key) ? Number(key) : key);
        if (px == null) delete next[c];
        else next[c] = Math.max(24, Math.min(2000, Math.round(Number(px)) || 92));
      }
      s.colWidths = sanitizeDims(next, MAX_COLS);
    });
  }

  // --- internals of the cell API --------------------------------------------
  // `prepare(id, order)`, if given, runs first (inside the queue, so nothing changes in between)
  // and its result reaches `apply` as `prepared`. `apply` reads and writes by A1 ref, values as
  // A1 text.
  mutateCells<P = undefined>(sheetRef: string | undefined, apply: (editor: CellEditor<P>) => void, prepare: ((id: string, order: SheetOrder) => Promise<P>) | null = null): Promise<AgentWriteResult> {
    return this.queue.run(async () => {
      const meta = await this.loadMeta();
      const id = resolveSheetId(meta, sheetRef);
      const orders = new Map(await this.loadOrders(meta));
      const sheet = viewSheet(meta.sheets[id], (sheetId) => orders.get(sheetId));
      const prepared = prepare ? await prepare(id, orders.get(id)!) : undefined;
      const upserts: CellUpsert[] = [], deletes: CellDeletion[] = [];
      const norm = (ref: string) => {
        const p = parseCellRef(ref);
        if (!p) throw new Error(`Bad cell: ${ref}`);
        if (p.r >= MAX_ROWS || p.c >= MAX_COLS) throw new Error(`Cell out of range: ${ref}`);
        return p;
      };
      const posKey = (p: RC) => colLetters(p.c) + (p.r + 1);
      // `apply` reads synchronously, so the cells it touches are fetched first. A dry run (every
      // cell reading as empty) lists them: which cells an edit touches never depends on what it
      // reads, and a cell past the grid's edge reads as empty either way.
      const touched = new Map<string, RC>();
      let growRows = 0, growCols = 0;
      apply({
        read: (ref) => { const p = norm(ref); touched.set(posKey(p), p); return null; },
        write: (ref, next) => {
          const p = norm(ref);
          touched.set(posKey(p), p);
          if (next && (valueText(next.value) || sanitizeFmt(next.fmt))) { growRows = Math.max(growRows, p.r + 1); growCols = Math.max(growCols, p.c + 1); }
        },
        sheet, id, prepared,
      });
      // Writing past the grid's edge grows it: new lines are added at its end.
      const lineOps: LineOp[] = [];
      let order = orders.get(id)!;
      for (const [axis, want] of [["rows", growRows], ["cols", growCols]] as [Axis, number][]) {
        const line = order.axis(axis);
        if (want <= line.size) continue;
        if (!lineOps.length) { order = order.clone(); orders.set(id, order); }
        const op: LineOp = { kind: "insert", sheetId: id, axis, ids: newLineIds(want - line.size), before: null };
        order.axis(axis).apply(op);
        lineOps.push(op);
      }
      const book = new OrderBook(meta, orders), ctx = book.ctx(id);
      const keyAt = (p: RC) => order.keyAt(p.r, p.c);
      const writer = new CellWriter(this);
      const cells = await writer.read(id, [...touched.values()].flatMap((p) => { const key = keyAt(p); return key ? [key] : []; }));
      const batch = new WriteBatch(this.ctx.storage);
      const read = (ref: string) => {
        const key = keyAt(norm(ref)), cell = key ? cells.get(key) : undefined;
        return cell ? { ...cell, value: render(cell.value, ctx) } : null;
      };
      const write = (ref: string, next: { value: unknown; fmt: unknown } | null) => {
        const key = keyAt(norm(ref));
        if (!key) return;
        const cur = cells.get(key);
        const value = next ? clipValue(toStored(valueText(next.value), ctx)) : "";
        const fmt = next ? sanitizeFmt(next.fmt) : null;
        if (!value && !fmt) {
          if (cur) { cells.delete(key); writer.delete(id, key); deletes.push({ sheetId: id, ref: key }); }
          return;
        }
        if (cur && cur.value === value && sameFmt(cur.fmt, fmt)) return;
        const cell = { value, fmt, version: (cur?.version || 0) + 1 };
        cells.set(key, cell);
        writer.put(id, key, cell);
        upserts.push({ sheetId: id, ref: key, cell });
      };
      apply({ write, read, sheet, id, prepared });
      if (!upserts.length && !deletes.length) return { status: "unchanged" as const, revision: meta.revision, updated: 0, cleared: 0 };
      if (lineOps.length) meta.sheets[id] = { ...meta.sheets[id], rows: order.rows.size, cols: order.cols.size };
      await writer.plan(batch);
      const result = await this.commitAgent(meta, { upserts, deletes, structure: lineOps.length > 0, lineOps, orders: lineOps.length ? new Map([[id, order]]) : undefined }, batch);
      return { ...result, updated: upserts.length, cleared: deletes.length };
    });
  }

  // The columns right of `area` that hold a value in its first rows, which a new chart steps past.
  async filledBeside(sheetRef: string | undefined, area: Area): Promise<Set<number>> {
    const meta = await this.loadMeta(), orders = await this.loadOrders(meta);
    const id = resolveSheetId(meta, sheetRef), order = orders.get(id)!;
    const keys = new Set<string>();
    for (let c = area.c2 + 1; c <= Math.min(area.c2 + 27, MAX_COLS - 1); c++) {
      for (let r = area.r1; r <= Math.min(area.r2, area.r1 + PLACEMENT_ROWS - 1); r++) { const key = order.keyAt(r, c); if (key) keys.add(key); }
    }
    const filled = new Set<number>();
    for (const [key, cell] of await this.readCells(id, keys)) { const p = order.positionOf(key); if (cell.value && p) filled.add(p.c); }
    return filled;
  }

  // `fn` edits the sheet's settings as editors see them (by position); they're stored by id.
  editMeta<E extends object = object>(sheetRef: string | undefined, fn: (sheet: SheetMeta, meta: DocumentMeta) => void, extra: E = {} as E): Promise<AgentWriteResult & E> {
    return this.queue.run(async () => {
      const meta = await this.loadMeta(), orders = await this.loadOrders(meta);
      const id = resolveSheetId(meta, sheetRef), orderOf = (sheetId: string) => orders.get(sheetId);
      const before = JSON.stringify(meta.sheets[id]);
      const view = sheetMeta(viewSheet(meta.sheets[id], orderOf));
      fn(view, meta);
      meta.sheets[id] = storeSheet(sheetMeta(view), orderOf);
      if (JSON.stringify(meta.sheets[id]) === before) return { status: "unchanged" as const, revision: meta.revision, ...extra };
      return { ...(await this.commitAgent(meta, {})), ...extra };
    });
  }

  // Inserts (delta > 0) or deletes lines at position `at`, as one line operation: nothing else
  // is rewritten. Deleted lines' cells and settings go with them.
  changeLines(sheetRef: string | undefined, axis: Axis, at: number, delta: number): Promise<AgentWriteResult> {
    return this.queue.run(async () => {
      const meta = await this.loadMeta(), orders = await this.loadOrders(meta);
      const id = resolveSheetId(meta, sheetRef);
      const rowsAxis = axis === "rows";
      const order = orders.get(id)!.clone(), line = order.axis(axis), size = line.size;
      if (at < 0 || at > size) throw new Error(`${rowsAxis ? "Row" : "Column"} out of range`);
      const count = Math.abs(delta);
      if (delta < 0 && (at + count > size || size - count < 1)) throw new Error(`Can't delete that many ${rowsAxis ? "rows" : "columns"}`);
      // Lines pushed past the grid's limit would hold cells no one can see.
      if (delta > 0 && size + count > (rowsAxis ? MAX_ROWS : MAX_COLS)) throw new Error(`A sheet holds at most ${rowsAxis ? "50,000 rows" : "702 columns"}`);
      const op: LineOp = delta > 0
        ? { kind: "insert", sheetId: id, axis, ids: newLineIds(count), before: line.idAt(at) ?? null }
        : { kind: "delete", sheetId: id, axis, ids: line.live().slice(at, at + count) };
      line.apply(op);
      meta.sheets[id] = { ...afterLineChange(meta.sheets[id], order, [op]), rows: order.rows.size, cols: order.cols.size };
      const batch = new WriteBatch(this.ctx.storage), writer = new CellWriter(this);
      if (op.kind === "delete") {
        const dead = new DeadLines();
        dead.add(id, axis, op.ids);
        await this.dropDeadCells(dead, writer, new Map());
        await writer.plan(batch);
      }
      return this.commitAgent(meta, {
        lineOps: [op],
        orders: new Map([[id, order]]),
        hint: { kind: rowsAxis ? "rows" : "cols", op: delta > 0 ? "insert" : "delete", sheetId: id, at, count },
      }, batch);
    });
  }

  // Commits `meta` together with any planned cell writes and changed orders, then tells clients.
  async commitAgent(meta: DocumentMeta, { upserts = [], deletes = [], replacedCells = null, hint = null, structure = true, lineOps = [], orders: changed, relabel = false }: AgentCommit, batch = new WriteBatch(this.ctx.storage)): Promise<AgentWriteResult> {
    const before = await this.loadOrders(meta);
    const orders = new Map<string, SheetOrder>();
    for (const id of meta.sheetOrder) {
      const sheet = meta.sheets[id];
      if (sheet) orders.set(id, changed?.get(id) ?? before.get(id) ?? SheetOrder.from(null, sheet.rows, sheet.cols));
    }
    for (const [id, order] of changed || []) batch.put(ORDER_PREFIX + id, order.toStored(), 2000);
    meta.revision += 1;
    meta.lastModified = Date.now();
    noteLinesChanged(meta, [...(changed?.keys() || [])]);
    batch.put("meta", meta);
    await batch.flush();
    this.orderCache = { revision: meta.revision, orders };
    // A big replaced sheet goes out as `null`: clients load it in pages.
    const fits = inlineAllowance();
    if (replacedCells) {
      for (const [sid, cells] of Object.entries(replacedCells)) if (cells && !fits(Object.values(cells), Object.keys(cells).length, INLINE_REPLACEMENT_CELLS)) replacedCells[sid] = null;
    }
    // So does a very large edit: listing every cell would make one huge message.
    if (!fits(upserts.map((upsert) => upsert.cell), upserts.length + deletes.length, INLINE_EDIT_CELLS)) {
      const nulls: Record<string, CellMap | null> = replacedCells = replacedCells || {};
      for (const x of [...upserts, ...deletes]) nulls[x.sheetId] = null;
      upserts = []; deletes = [];
    }
    const event: OperationEvent = {
      type: "operation",
      senderId: "agent",
      revision: meta.revision,
      ...(lineOps.length ? { lineOps } : {}),
      ...(changed?.size ? { orders: Object.fromEntries([...changed].map(([id, order]) => [id, order.toStored()])) } : {}),
      ...(structure || lineOps.length ? { structure: { sheetOrder: meta.sheetOrder, sheets: meta.sheets, title: meta.title } } : {}),
      upserts,
      deletes,
      lastModified: meta.lastModified,
    };
    if (replacedCells) { event.replacedSheets = Object.keys(replacedCells); event.replacedCells = replacedCells; }
    if (hint) event.agentHint = hint;
    // Don't make the caller wait on slow or half-open clients.
    this.broadcast(event, new OrderBook(meta, orders), relabel).catch(() => {});
    return { status: "applied" as const, revision: meta.revision };
  }

  // --- Presence & subscription ------------------------------------------
  async subscribe(callback: SubscriberStub, options: SubscribeOptions | null = {}): Promise<OpenedDocument> {
    const client = options || {};
    const info: SubscriberInfo = {
      clientId: presenceId(client.clientId),
      name: String(client.name || "Guest").slice(0, 40),
      color: presenceColor(client.color),
      legacy: client.lines !== true,
      delivery: Promise.resolve(),
    };
    // Registered before the read, so no edit committed meanwhile goes unheard; a failed read
    // forgets it again (the client then subscribes anew with another callback).
    const handle = this.subscribers.add(callback, info);
    try {
      // The first page of the workbook; the client loads the rest with getCellsPage. An editor
      // from before line ids (one can still be open when the gadget updates) reads the whole
      // workbook by position, as it always did.
      if (info.legacy) return { ...await this.getDocument(), cursors: {} };
      return await this.openDocument();
    } catch (e) {
      this.subscribers.remove(handle);
      throw e;
    }
  }

  async updatePresence(input: PresenceInput | null): Promise<void> {
    const presence = input || {};
    this.broadcastPresence({
      type: "cursor",
      clientId: presenceId(presence.clientId),
      name: String(presence.name || "Guest").slice(0, 40),
      color: presenceColor(presence.color),
      sheetId: presence.sheetId ? String(presence.sheetId) : null,
      r1: int(presence.r1), c1: int(presence.c1),
      r2: int(presence.r2), c2: int(presence.c2),
      at: Date.now(),
    });
  }

  async leavePresence(clientId: unknown): Promise<void> {
    this.broadcastPresence({ type: "leave", clientId: presenceId(clientId), at: Date.now() });
  }

  // Waits on no subscriber. The registry drops and releases one whose delivery fails, which lets
  // its client know (its subscriber's dispose hook subscribes again). `book` is the workbook as
  // the event left it; `relabel` says sheets were renamed or deleted (see legacyEvent).
  async broadcast(event: OperationEvent, book: OrderBook, relabel = false): Promise<void> {
    let legacy: Promise<SubscriberEvent> | null = null;
    this.subscribers.broadcast((stub, info) => {
      if (!info.legacy) return stub.operation(event);
      // A snapshot takes a moment to read, so a later event could overtake this one and then be
      // undone by it: a legacy subscriber's events are delivered one at a time.
      const prepared = legacy ??= this.legacyEvent(event, book, relabel);
      return info.delivery = info.delivery.then(() => prepared).then((e) => stub.operation(e));
    });
  }

  // An event as an editor from before line ids reads it, by position. Cell edits are translated;
  // anything that moves cells or changes how formulas read (lines inserted, deleted or moved, a
  // regenerated sheet, a sheet renamed or deleted, a sheet too big to send) comes as the whole
  // workbook instead, which it applies as it applies a reconnect.
  async legacyEvent(event: OperationEvent, book: OrderBook, relabel: boolean): Promise<SubscriberEvent> {
    const replaced = Object.keys(event.replacedCells || {}).length > 0;
    if (relabel || event.lineOps?.length || event.orders || replaced) return { type: "snapshot", document: await this.getDocument() };
    const cells = <T extends { sheetId: string; ref: string; cell?: Cell }>(list: T[]) => list.flatMap((item) => {
      const ref = book.a1(item.sheetId, item.ref);
      return ref ? [{ ...item, ref, ...(item.cell ? { cell: book.renderCell(item.sheetId, item.cell) } : {}) }] : [];
    });
    const { lineOps: _lines, orders: _orders, ...rest } = event;
    return { ...rest, ...(event.structure ? { structure: book.viewStructure() } : {}), upserts: cells(event.upserts), deletes: cells(event.deletes) };
  }

  broadcastPresence(event: SheetsPresenceEvent): void {
    this.subscribers.broadcast((stub) => stub.presence(event));
  }
}

// --- Cell API helpers -------------------------------------------------------
/** A zero-based cell position. */
interface RC { r: number; c: number }
/** A zero-based, inclusive rectangle of cells. */
interface Area { r1: number; c1: number; r2: number; c2: number }
/** One sheet as `listSheets` describes it. */
interface SheetSummary {
  id: string;
  name: string;
  rows: number;
  cols: number;
  usedRange: string | null;
  cellCount: number;
  filter: { headerRow: number; columns: string[] } | null;
  charts: { id: string; type: ChartType; range: string; title: string }[];
  pivot: boolean;
}
/** What `readRange` returns: stored values (formulas as text), and formats when asked. */
interface ReadRangeResult {
  revision: number;
  sheetId: string;
  sheet: string;
  range: string;
  values: string[][];
  formats?: (CellFmt | null)[][];
}
/** `addChart`'s options: the data range, kind, labels and (grid-pixel) placement. */
interface AddChartOptions {
  sheet?: string;
  range?: string;
  type?: string;
  title?: string;
  xAxisTitle?: string;
  yAxisTitle?: string;
  legend?: boolean;
  firstRowHeaders?: boolean;
  firstColLabels?: boolean;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}
function colLetters(c: number): string {
  let s = "";
  for (let v = c + 1; v > 0; v = Math.floor((v - 1) / 26)) s = String.fromCharCode(65 + (v - 1) % 26) + s;
  return s;
}
function lettersToCol(letters: unknown): number {
  let c = 0;
  for (const ch of String(letters).toUpperCase()) c = c * 26 + ch.charCodeAt(0) - 64;
  return c - 1;
}
function parseCellRef(ref: unknown): RC | null {
  const m = /^\$?([A-Za-z]{1,3})\$?([1-9]\d*)$/.exec(String(ref ?? "").trim());
  return m ? { r: Number(m[2]) - 1, c: lettersToCol(m[1]) } : null;
}
function parseArea(range: unknown): Area {
  const [a, b = a] = String(range ?? "").split(":");
  const p = parseCellRef(a), q = parseCellRef(b);
  if (!p || !q) throw new Error(`Bad range: ${range} (use A1 or A1:C9)`);
  return { r1: Math.min(p.r, q.r), c1: Math.min(p.c, q.c), r2: Math.max(p.r, q.r), c2: Math.max(p.c, q.c) };
}
function areaRef(a: Area): string {
  const tl = colLetters(a.c1) + (a.r1 + 1), br = colLetters(a.c2) + (a.r2 + 1);
  return tl === br ? tl : tl + ":" + br;
}
// How many rows or columns to insert or delete: a positive whole number (a negative one would do the opposite).
function lineCount(count: unknown): number {
  if (count == null) return 1;
  const n = Math.round(Number(count));
  if (!Number.isFinite(n) || n < 1) throw new Error(`Bad count: ${count} (use a positive number)`);
  return n;
}
function toRowIndex(at: unknown): number {
  const n = Math.round(Number(at));
  if (!Number.isFinite(n) || n < 1) throw new Error(`Bad row number: ${at} (rows are 1-based)`);
  return n - 1;
}
function toColIndex(at: unknown): number {
  if (typeof at === "number") { if (!Number.isFinite(at) || at < 1) throw new Error(`Bad column: ${at} (columns are letters or 1-based)`); return Math.round(at) - 1; }
  if (/^[A-Za-z]{1,3}$/.test(String(at ?? ""))) return lettersToCol(at);
  throw new Error(`Bad column: ${at} (use a letter such as "C")`);
}
function findSheetByName(meta: DocumentMeta, name: unknown): string | null {
  const want = String(name).trim().toLowerCase();
  return meta.sheetOrder.find((id) => meta.sheets[id].name.toLowerCase() === want) || null;
}
// Sheet ids the server and the client make ("s_" and a few letters or digits); new ids must look like them.
const SHEET_ID = /^[A-Za-z0-9_-]{1,64}$/;
// Whether the workbook has a sheet with this id (not a name inherited from Object.prototype).
function hasSheet(meta: DocumentMeta, id: string): boolean { return Object.hasOwn(meta.sheets, id); }
function resolveSheetId(meta: DocumentMeta, sheet: unknown): string {
  if (sheet == null || sheet === "") return meta.sheetOrder[0];
  if (hasSheet(meta, String(sheet))) return String(sheet);
  const id = findSheetByName(meta, sheet);
  if (!id) throw new Error(`No sheet "${sheet}". Sheets: ${meta.sheetOrder.map((x) => meta.sheets[x].name).join(", ")}`);
  return id;
}
// Presence fields reach every collaborator's page (the colour goes into inline styles), so they
// are bounded, and a colour is a plain hex, rgb() or hsl() value or the default.
function presenceId(v: unknown): string { return String(v || "").slice(0, 80); }
function presenceColor(v: unknown): string {
  const color = String(v || "");
  return /^(#[0-9a-f]{3,8}|(rgb|hsl)a?\([\d.%,\s/]{1,40}\))$/i.test(color) ? color : "#e1632e";
}
function valueText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  // The grid reads `1.5e-7` as text, so a very small or large number is written out in full
  // (0.00000015) to stay a number. Non-finite numbers have no such form and stay as given.
  if (typeof v === "number" && Number.isFinite(v) && /e/i.test(String(v))) {
    return v.toLocaleString("en-US", { useGrouping: false, maximumSignificantDigits: 17 });
  }
  return String(v).slice(0, 8192);
}
function mergeFmt(base: CellFmt | null | undefined, patch: FmtPatch | null | undefined): CellFmt | null {
  const out: Record<string, unknown> = { ...(base || {}) };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v == null || v === false || v === "") delete out[k];
    else out[k] = v;
  }
  // Checked by checkFmt and cleaned by sanitizeFmt before it is stored.
  return Object.keys(out).length ? out as CellFmt : null;
}
function sameFmt(a: CellFmt | null | undefined, b: CellFmt | null | undefined): boolean {
  const ka = Object.keys(a || {}) as (keyof CellFmt)[], kb = Object.keys(b || {});
  return ka.length === kb.length && ka.every((k) => (a || {})[k] === (b || {})[k]);
}
// --- Sanitizers -------------------------------------------------------------
// A sheet's largest size: 50,000 rows and 702 columns (A–ZZ).
const MAX_ROWS = 50000;
const MAX_COLS = 702;
function int(v: unknown): number { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(0, n) : 0; }
function clampInt(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}

// Sizes by line index, for lines a sheet can have (below `limit`), so the map stays bounded.
function sanitizeDims(dims: unknown, limit: number): Dims {
  const out: Dims = {};
  if (dims && typeof dims === "object") {
    for (const [k, v] of Object.entries(dims)) {
      if (!/^\d+$/.test(k) || Number(k) >= limit) continue;
      const n = Math.round(Number(v));
      if (Number.isFinite(n) && n >= 8 && n <= 2000) out[Number(k)] = n;
    }
  }
  return out;
}

// Clients walk chart and pivot ranges cell by cell, so a range outside the sheet or beyond this
// many cells would hang every client that opens the workbook. It's clamped to the sheet and
// dropped (empty) when still too large.
const MAX_RANGE_CELLS = 200000;
function sanitizeRange(text: unknown, rows: number, cols: number, allowSingle: boolean): string {
  const match = /^([A-Z]+)([1-9]\d*)(?::([A-Z]+)([1-9]\d*))?$/.exec(String(text || "").toUpperCase());
  if (!match || (!match[3] && !allowSingle)) return "";
  const first = parseCsvCellRef(match[1] + match[2]);
  const last = match[3] ? parseCsvCellRef(match[3] + match[4]) : first;
  if (!first || !last) return "";
  const top = Math.min(first.row, last.row), left = Math.min(first.column, last.column);
  const bottom = Math.min(Math.max(first.row, last.row), rows - 1), right = Math.min(Math.max(first.column, last.column), cols - 1);
  if (top > bottom || left > right || (bottom - top + 1) * (right - left + 1) > MAX_RANGE_CELLS) return "";
  return csvCellRef(top, left) + (match[3] ? ":" + csvCellRef(bottom, right) : "");
}

/** Sheet metadata as it arrives (from a client, an agent call or older storage), before sheetMeta cleans it. */
interface SheetMetaInput {
  id: unknown;
  name?: unknown;
  rows?: unknown;
  cols?: unknown;
  colWidths?: unknown;
  rowHeights?: unknown;
  frozenRows?: unknown;
  frozenCols?: unknown;
  filter?: unknown;
  charts?: unknown;
  pivot?: unknown;
  created?: unknown;
}
function sheetMeta(s: SheetMetaInput): SheetMeta {
  const rows = clampInt(s.rows, 1, MAX_ROWS, DEFAULT_ROWS), cols = clampInt(s.cols, 1, MAX_COLS, DEFAULT_COLS);
  return {
    id: String(s.id),
    name: String(s.name || "Sheet").slice(0, 60),
    rows,
    cols,
    colWidths: sanitizeDims(s.colWidths, MAX_COLS),
    rowHeights: sanitizeDims(s.rowHeights, MAX_ROWS),
    frozenRows: clampInt(s.frozenRows, 0, 50, 0),
    frozenCols: clampInt(s.frozenCols, 0, 50, 0),
    filter: sanitizeFilter(s.filter, rows, cols),
    charts: sanitizeCharts(s.charts, rows, cols),
    pivot: sanitizePivot(s.pivot),
    // The revision that created the sheet (0 for sheets older than this field); see applyOperationLocked.
    created: clampInt(s.created, 0, Number.MAX_SAFE_INTEGER, 0),
  };
}

// Headers keep the cell value limit plus the longest suffix (` (702)`) the client adds to make
// duplicate headers unique.
const MAX_PIVOT_FIELD_LENGTH = 8198;
const MAX_FILTER_SELECTIONS = 500; // the client's filter menus refuse larger selections

// Untrusted shapes (client snapshots, older storage) are read field by field through `Loose`.
type Loose = Record<string, unknown>;
const isLoose = (v: unknown): v is Loose => !!v && typeof v === "object";
function sanitizePivot(input: unknown): PivotSettings | null {
  if (!isLoose(input)) return null;
  const pivot = input;
  const aggregates = new Set<unknown>(["sum", "count", "average", "min", "max"]);
  const filterValues = Array.isArray(pivot.filterValues)
    ? [...new Set(pivot.filterValues.map((value) => String(value).slice(0, 8192)))]
    : (pivot.filterValue ? [String(pivot.filterValue).slice(0, 8192)] : []);
  return {
    sourceSheetId: String(pivot.sourceSheetId || "").slice(0, 80),
    // Shape only; applyOperationLocked bounds it against the source sheet.
    sourceRange: /^([A-Z]+[1-9]\d*):([A-Z]+[1-9]\d*)$/.test(String(pivot.sourceRange || "").toUpperCase()) ? String(pivot.sourceRange).toUpperCase() : "",
    rowField: String(pivot.rowField || "").slice(0, MAX_PIVOT_FIELD_LENGTH),
    columnField: String(pivot.columnField || "").slice(0, MAX_PIVOT_FIELD_LENGTH),
    valueField: String(pivot.valueField || "").slice(0, MAX_PIVOT_FIELD_LENGTH),
    aggregate: aggregates.has(pivot.aggregate as PivotSettings["aggregate"]) ? pivot.aggregate as PivotSettings["aggregate"] : "sum",
    showRowTotals: pivot.showRowTotals !== false,
    showColumnTotals: pivot.showColumnTotals !== false,
    filterField: String(pivot.filterField || "").slice(0, MAX_PIVOT_FIELD_LENGTH),
    // Compared exactly to cell values. An oversized set is dropped whole rather than trimmed
    // into a different filter.
    filterValues: filterValues.length <= MAX_FILTER_SELECTIONS ? filterValues : [],
  };
}

function sanitizeCharts(charts: unknown, rows: number, cols: number): Chart[] {
  if (!Array.isArray(charts)) return [];
  return charts.slice(0, MAX_CHARTS).map((chart: Loose | null | undefined, index): Chart => ({
    id: String(chart?.id || "chart_" + index).slice(0, 80),
    type: CHART_TYPES.includes(chart?.type as ChartType) ? chart?.type as ChartType : "line",
    range: sanitizeRange(chart?.range, rows, cols, true),
    title: String(chart?.title || "").slice(0, 200),
    xAxisTitle: String(chart?.xAxisTitle || "").slice(0, 120),
    yAxisTitle: String(chart?.yAxisTitle || "").slice(0, 120),
    legend: chart?.legend !== false,
    firstRowHeaders: chart?.firstRowHeaders !== false,
    firstColLabels: chart?.firstColLabels !== false,
    smooth: chart?.smooth === true,
    x: clampInt(chart?.x, CHART_BOUNDS.minX, CHART_BOUNDS.max, 96),
    y: clampInt(chart?.y, CHART_BOUNDS.minY, CHART_BOUNDS.max, 44),
    width: clampInt(chart?.width, 280, 1200, 520),
    height: clampInt(chart?.height, 200, 900, 320),
  }));
}

function sanitizeFilter(input: unknown, rows: number, cols: number): SheetFilter | null {
  if (!isLoose(input)) return null;
  const filter = input;
  const row = clampInt(filter.row, 0, Math.max(0, rows - 1), 0);
  const criteria: Record<string, string[]> = {};
  if (filter.criteria && typeof filter.criteria === "object") {
    for (const [column, values] of Object.entries(filter.criteria)) {
      if (!/^\d+$/.test(column)) continue;
      const col = Number(column);
      if (col < 0 || col >= cols || !Array.isArray(values)) continue;
      // Trimming a selection would change which rows it hides, so an oversized one is dropped
      // whole. Each token has a two-character type prefix on top of its cell's 8,192 characters.
      const clean = [...new Set(values.map((value) => String(value).slice(0, 8194)))];
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
  const sortIn = isLoose(filter.sort) ? filter.sort : null;
  const sortColumn = Number(sortIn?.column), direction = sortIn?.direction;
  const sort: FilterSort | null = Number.isInteger(sortColumn) && columns.includes(sortColumn) && (direction === "asc" || direction === "desc")
    ? { column: sortColumn, direction }
    : null;
  return { row, endRow, columns, criteria, rowOrder, sort };
}

const FMT_KEYS = new Set(["b", "i", "u", "s", "c", "bg", "a", "nf", "d", "fs", "wrap"]);
const NUMBER_FORMATS = ["auto", "text", "number", "integer", "percent", "scientific", "currency", "date", "time", "datetime"];
const CHART_TYPES: ChartType[] = ["line", "pie", "area", "stackedBar"];
// The cell API refuses a format it would otherwise drop or misread, so a caller learns why
// (sanitizeFmt still cleans whatever clients send). null values remove keys and pass.
function checkFmt(fmt: unknown): void {
  if (fmt == null) return;
  if (typeof fmt !== "object" || Array.isArray(fmt)) throw new Error("fmt must be an object such as { b: true, nf: \"currency\" }");
  for (const [k, v] of Object.entries(fmt)) {
    if (!FMT_KEYS.has(k)) throw new Error(`Unknown format key "${k}" (use ${[...FMT_KEYS].join(", ")})`);
    if (v == null || v === false) continue;
    if ((k === "c" || k === "bg") && !(typeof v === "string" && /^#[0-9a-fA-F]{3,8}$/.test(v))) throw new Error(`${k} must be a hex colour such as "#2f6fd1"`);
    if (k === "a" && !["l", "c", "r"].includes(v)) throw new Error('a must be "l", "c" or "r"');
    if (k === "nf" && !NUMBER_FORMATS.includes(v)) throw new Error(`Unknown number format "${v}" (use ${NUMBER_FORMATS.join(", ")})`);
    if (k === "d" && !(Number.isInteger(Number(v)) && v >= 0 && v <= 10)) throw new Error("d (decimals) must be 0–10");
    if (k === "fs" && !(Number(v) >= 6 && Number(v) <= 96)) throw new Error("fs (font size, px) must be 6–96");
  }
}
function sanitizeFmt(fmt: unknown): CellFmt | null {
  if (!fmt || typeof fmt !== "object") return null;
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(fmt)) {
    if (!FMT_KEYS.has(k) || v == null || v === false || v === "") continue;
    // A colour is a string or nothing: RegExp.test would stringify an array like ["#abc"].
    if (k === "c" || k === "bg") { if (typeof v === "string" && /^#[0-9a-fA-F]{3,8}$/.test(v)) out[k] = v; }
    else if (k === "a") { if (v === "l" || v === "c" || v === "r") out[k] = v; }
    else if (k === "nf") { out[k] = String(v).slice(0, 20); }
    else if (k === "d") { const n = Math.round(Number(v)); if (n >= 0 && n <= 10) out[k] = n; }
    else if (k === "fs") { const n = Math.round(Number(v)); if (n >= 6 && n <= 96) out[k] = n; }
    else out[k] = true;
  }
  return Object.keys(out).length ? out as CellFmt : null;
}

// A client's cell map ({ ref: cell }, refs that `accept` takes) as a Map of clean stored cells.
// `exact` keeps a version of 0 (a staged sort's base versions); otherwise versions start at 1.
function sanitizeCellEntries(map: unknown, accept: (ref: string) => boolean, exact = false): Map<string, Cell> {
  const out = new Map<string, Cell>();
  if (!map || typeof map !== "object") return out;
  for (const [ref, cell] of Object.entries(map as Record<string, Loose | null | undefined>)) {
    if (!accept(ref)) continue;
    const version = Math.round(Number(cell?.version)) || 0;
    out.set(ref, {
      value: cell?.value == null ? "" : clipValue(String(cell.value)),
      fmt: sanitizeFmt(cell?.fmt),
      version: exact ? Math.max(0, version) : Math.max(1, version),
    });
  }
  return out;
}

// --- Line ids --------------------------------------------------------------------
const CELL_STORAGE = 4;
const ORDER_PREFIX = "o:";

/** Every sheet's line order at one revision, and what reading the workbook by position needs. */
class OrderBook {
  declare meta: DocumentMeta;
  declare orders: Map<string, SheetOrder>;
  declare names: Map<string, string>;
  constructor(meta: DocumentMeta, orders: Map<string, SheetOrder>) {
    this.meta = meta;
    this.orders = orders;
    this.names = new Map(meta.sheetOrder.filter((id) => meta.sheets[id]).map((id) => [meta.sheets[id].name.toLowerCase(), id]));
  }
  order(sheetId: string): SheetOrder | undefined { return this.orders.get(sheetId); }
  // Reading and writing formulas on a sheet.
  ctx(sheetId: string): RefContext {
    return {
      sheetId,
      order: (id) => this.orders.get(id),
      sheetIdByName: (name) => this.names.get(name.toLowerCase()),
      sheetName: (id) => (Object.hasOwn(this.meta.sheets, id) ? this.meta.sheets[id].name : undefined),
    };
  }
  // A cell key's A1 ref now (null: its line is gone).
  a1(sheetId: string, key: string): string | null {
    const p = this.orders.get(sheetId)?.positionOf(key);
    return p ? colLetters(p.c) + (p.r + 1) : null;
  }
  renderValue(sheetId: string, value: string): string { return render(value, this.ctx(sheetId)); }
  renderCell(sheetId: string, cell: Cell): Cell { return { ...cell, value: this.renderValue(sheetId, cell.value) }; }
  view(sheetId: string): SheetMeta { return viewSheet(this.meta.sheets[sheetId], (id) => this.orders.get(id)); }
  viewStructure(): Structure {
    return { title: this.meta.title, sheetOrder: this.meta.sheetOrder, sheets: Object.fromEntries(this.meta.sheetOrder.filter((id) => this.meta.sheets[id]).map((id) => [id, this.view(id)])) };
  }
  // A stored page by position: cells on deleted lines are left out, formulas read as A1 text.
  positionPage(sheetId: string, page: PackedCells): PackedCells {
    const out: PackedCells = { refs: [], values: [], ...(page.versions ? { versions: [] } : {}), ...(page.styles ? { styles: [], fmts: page.fmts } : {}) };
    const ctx = this.ctx(sheetId);
    for (let i = 0; i < page.refs.length; i++) {
      const ref = this.a1(sheetId, page.refs[i]);
      if (!ref) continue;
      out.refs.push(ref); out.values.push(render(page.values[i], ctx));
      if (page.versions) out.versions!.push(page.versions[i]);
      if (page.styles) out.styles!.push(page.styles[i]);
    }
    return out;
  }
}

/** Lines an operation deleted, by sheet, whose cells go with them (see dropDeadCells). */
class DeadLines {
  declare sheets: Map<string, { rows: Set<number>; cols: Set<number> }>;
  constructor() { this.sheets = new Map(); }
  add(sheetId: string, axis: Axis, ids: number[]) {
    let lines = this.sheets.get(sheetId);
    if (!lines) this.sheets.set(sheetId, lines = { rows: new Set(), cols: new Set() });
    for (const id of ids) lines[axis].add(id);
  }
}

// A line id list from a client: safe whole numbers, each once.
function sanitizeIds(ids: unknown, limit = MAX_ROWS): number[] {
  if (!Array.isArray(ids) || ids.length > limit) return [];
  return [...new Set(ids.filter((id): id is number => Number.isSafeInteger(id) && id >= 0))];
}
// A line operation from a client, checked for shape (LineOrder.refusal checks it against the order).
function sanitizeLineOp(input: unknown): LineOp | null {
  if (!isLoose(input) || (input.axis !== "rows" && input.axis !== "cols")) return null;
  const sheetId = String(input.sheetId || ""), axis: Axis = input.axis;
  const ids = sanitizeIds(input.ids, axis === "rows" ? MAX_ROWS : MAX_COLS);
  if (!ids.length || (Array.isArray(input.ids) && ids.length !== input.ids.length)) return null;
  const before = input.before == null ? null : Number.isSafeInteger(input.before) ? input.before as number : undefined;
  if (input.kind === "delete") return { kind: "delete", sheetId, axis, ids };
  if ((input.kind === "insert" || input.kind === "move") && before !== undefined) return { kind: input.kind, sheetId, axis, ids, before };
  return null;
}

// Stored sheet settings from a client, given the shapes viewSheet reads (it then drops whatever
// names no live line); sheetMeta cleans the result as editors see it.
function storedShape(input: Loose, id: string): SheetMeta {
  const dims = (value: unknown): Dims => {
    const out: Dims = {};
    if (isLoose(value)) for (const [key, px] of Object.entries(value)) if (/^\d{1,16}$/.test(key) && typeof px === "number") out[key] = px;
    return out;
  };
  const filter = isLoose(input.filter) && Number.isSafeInteger(input.filter.row) && Number.isSafeInteger(input.filter.endRow) ? {
    row: input.filter.row as number,
    endRow: input.filter.endRow as number,
    columns: sanitizeIds(input.filter.columns, MAX_COLS),
    criteria: isLoose(input.filter.criteria) ? input.filter.criteria as Record<string, string[]> : {},
    rowOrder: Array.isArray(input.filter.rowOrder) ? input.filter.rowOrder as number[] : [],
    sort: isLoose(input.filter.sort) && Number.isSafeInteger(input.filter.sort.column) ? input.filter.sort as unknown as FilterSort : null,
  } : null;
  const pivot = sanitizePivotShape(input.pivot);
  return {
    id, name: String(input.name ?? "Sheet"), rows: 1, cols: 1,
    colWidths: dims(input.colWidths), rowHeights: dims(input.rowHeights),
    frozenRows: Number(input.frozenRows) || 0, frozenCols: Number(input.frozenCols) || 0,
    filter,
    charts: (Array.isArray(input.charts) ? input.charts.filter(isLoose) : []).map((chart) => ({ ...chart, range: String(chart.range ?? "") }) as unknown as Chart),
    pivot,
  };
}
function sanitizePivotShape(input: unknown): PivotSettings | null {
  if (!isLoose(input)) return null;
  return { ...(input as unknown as PivotSettings), sourceSheetId: String(input.sourceSheetId || ""), sourceRange: String(input.sourceRange || "") };
}

// A sheet's stored settings after line operations on it: a filter whose header row is gone goes,
// and a filter's row order (by position) starts over; sizes for deleted lines are dropped.
function afterLineChange(sheet: SheetMeta, order: SheetOrder, ops: LineOp[], filterSent = false): SheetMeta {
  if (!ops.length) return sheet;
  const keep = (dims: Dims, line: LineOrder): Dims => Object.fromEntries(Object.entries(dims).filter(([id]) => line.isLive(Number(id))));
  let filter = sheet.filter;
  if (filter && !order.rows.isLive(filter.row)) filter = null;
  // A filter's sort is by position, so it starts over, unless the sender sent the filter as it
  // stands after these lines changed.
  else if (filter && !filterSent) filter = { ...filter, rowOrder: [], sort: null };
  return { ...sheet, colWidths: keep(sheet.colWidths, order.cols), rowHeights: keep(sheet.rowHeights, order.rows), filter };
}

// Each sheet's name by id, to tell whether a commit renamed or deleted one.
function sheetNames(meta: DocumentMeta): Map<string, string> {
  return new Map(meta.sheetOrder.filter((id) => meta.sheets[id]).map((id) => [id, meta.sheets[id].name]));
}
function relabelled(before: Map<string, string>, meta: DocumentMeta): boolean {
  for (const [id, name] of before) if (meta.sheets[id]?.name !== name) return true;
  return false;
}

// A typed value is at most MAX_VALUE_CHARS; its stored form (references as ids) is longer. A
// reference typed in as few as 3 characters ("A1+") takes at most 38 stored (two 16-digit ids,
// their `$`s and the token's marks), so MAX_STORED_CHARS holds any typed value whole; only a
// stored value sent longer than that is cut, before a reference rather than through one.
const MAX_VALUE_CHARS = 8192;
const MAX_STORED_CHARS = 20 * MAX_VALUE_CHARS;
function clipValue(value: string): string {
  if (value.length <= MAX_STORED_CHARS) return value;
  const cut = value.slice(0, MAX_STORED_CHARS), open = cut.lastIndexOf("\uE000");
  return open > cut.lastIndexOf("\uE001") ? cut.slice(0, open) : cut;
}
// What is left to do of a line operation sent again (its save's reply was lost) or racing another
// tab's: lines already deleted aren't deleted or moved again, and an insert whose lines are all
// placed already happened. Null when nothing is.
// How many applied operations are remembered (see Operation.id), and how many refused cells each
// may keep; past that only its id is kept, and a resend takes the cells as they are.
const RECENT_OPERATIONS = 256, RECENT_REFUSALS = 2000;
function rememberOperation(meta: DocumentMeta, id: string, refused: NonNullable<RecentOperation["refused"]>) {
  const size = refused.conflicts.length + refused.gone.length + refused.sorted.length + refused.refusedLines.length;
  meta.recentOps = [...(meta.recentOps || []), { id, refused: size > RECENT_REFUSALS ? null : refused }].slice(-RECENT_OPERATIONS);
}
function noteLinesChanged(meta: DocumentMeta, sheetIds: string[]) {
  if (!sheetIds.length) return;
  const changed = meta.linesChanged = { ...(meta.linesChanged || {}) };
  for (const id of sheetIds) changed[id] = meta.revision;
  for (const id of Object.keys(changed)) if (!meta.sheets[id]) delete changed[id];
}
const DELETED_SHEETS = 500;
function noteDeletedSheet(meta: DocumentMeta, id: string) {
  meta.deletedSheets = [...(meta.deletedSheets || []).filter((x) => x !== id), id].slice(-DELETED_SHEETS);
  if (meta.linesChanged) delete meta.linesChanged[id];
}

function remainingLineOp(op: LineOp, line: LineOrder): LineOp | null {
  if (op.kind === "insert") return op.ids.length && op.ids.every((id) => line.has(id)) ? null : op;
  const ids = op.ids.filter((id) => line.isLive(id));
  return ids.length ? { ...op, ids } : null;
}
// How many recent sorts are remembered (see sortedSince), and how many runs of rows each may keep.
const MAX_SORT_RECORDS = 50, MAX_SORT_RUNS = 2000;
// Ids as runs of consecutive ones: [first, count].
function idRuns(ids: Iterable<number>): [number, number][] {
  const runs: [number, number][] = [];
  for (const id of [...ids].sort((a, b) => a - b)) {
    const last = runs.at(-1);
    if (last && id === last[0] + last[1]) last[1]++;
    else if (!last || id >= last[0] + last[1]) runs.push([id, 1]);
  }
  return runs;
}

// --- Cell storage helpers ---------------------------------------------------
// What an editor by position may write: a cell a sheet can have (A1:ZZ50000). A cell past it is
// never shown, but would still stretch every export to reach it.
const GRID_REF = /^[A-Z]{1,2}([1-9][0-9]{0,4})$/;
function isGridRef(ref: string): boolean { const m = GRID_REF.exec(ref); return !!m && Number(m[1]) <= MAX_ROWS; }
// A cell key ("rowId:colId"); whether its lines exist is checked against the sheet's order.
function isCellKey(ref: string): boolean { return parseCellKey(ref) !== null; }
const STORAGE_BATCH = 128;          // keys per storage get/put/delete call
const STORAGE_PUT_CHARS = 4_000_000; // and at most about this much data per put call
const PAGE_BYTES = 2_000_000;       // about how much cell data one page to a client carries
const INLINE_REPLACEMENT_CELLS = 5000; // larger replaced sheets are re-read by peers in pages
const INLINE_EDIT_CELLS = 20000;        // agent edits touching more cells: peers re-read those sheets
const INLINE_EVENT_CHARS = 2_000_000;  // and so are cells past about this much text in one event
const MAX_STAGED_CHARS = 40_000_000;   // what all staged uploads (stageCells) may hold together
// About how many characters cells take, in memory or a message: their values, plus their refs,
// versions and formats.
function cellChars(cells: Iterable<Cell>): number {
  let chars = 0;
  for (const cell of cells) chars += cell.value.length + 48;
  return chars;
}
// The cells one event may carry inline, shared by its sheets: `fits(cells, count, maxCells)` takes
// a sheet's (or an edit's) `count` cells from what is left, or says they go as `null` (read in pages).
function inlineAllowance(): (cells: Iterable<Cell>, count: number, maxCells: number) => boolean {
  let room = INLINE_EVENT_CHARS;
  return (cells, count, maxCells) => {
    if (count > maxCells) return false;
    const chars = cellChars(cells);
    if (chars > room) return false;
    room -= chars;
    return true;
  };
}
function sameStoredCell(a: Cell, b: Cell): boolean { return a.value === b.value && a.version === b.version && sameFmt(a.fmt, b.fmt); }

// Cells are stored in blocks of BLOCK_ROWS row ids: "c:<sheetId>:<000000000000012>" holds the
// rows with ids 384–415 (block 12), packed as parallel arrays (`refs` holding cell keys, `values`,
// `versions`, `styles` indexing the block's `fmts`; -1 for none). Block names are zero-padded, so
// keys sort by row id (not by where rows are shown). A block bigger than BLOCK_PART_CHARS
// continues in "…<…012>~1", "~2", …; part 0 then says how many parts there are (`parts`).
const BLOCK_ROWS = 32;
const BLOCK_PART_CHARS = 400_000;
const blockPrefix = (sheetId: string) => "c:" + sheetId + ":";
const blockName = (index: number) => String(index).padStart(15, "0");
const blockKey = (sheetId: string, index: number, part = 0) => blockPrefix(sheetId) + blockName(index) + (part ? "~" + part : "");
const blockIndexOfName = (name: string) => parseInt(name, 10);
function rowOfRef(key: string): number { return Number(key.slice(0, key.indexOf(":"))); }
function blockOfKey(key: string): number { return Math.floor(rowOfRef(key) / BLOCK_ROWS); }
// A block's cells by row id past row `skip`, in row order, as each part's cell indices.
function blockRows(parts: StoredPart[], skip: number): [number, Map<StoredPart, number[]>][] {
  const rows = new Map<number, Map<StoredPart, number[]>>();
  for (const part of parts) {
    for (let i = 0; i < part.refs.length; i++) {
      const row = rowOfRef(part.refs[i]);
      if (row <= skip) continue;
      let picks = rows.get(row);
      if (!picks) rows.set(row, picks = new Map());
      let indices = picks.get(part);
      if (!indices) picks.set(part, indices = []);
      indices.push(i);
    }
  }
  return [...rows].sort((a, b) => a[0] - b[0]);
}
// Packs [ref, cell] entries into one or more block parts. Returns { parts, sizes } (no parts
// for no cells).
function packBlock(entries: Iterable<[string, Cell]>): { parts: StoredPart[]; sizes: number[] } {
  const parts: StoredPart[] = [], sizes: number[] = [];
  let part: StoredPart | null = null, fmtIndex = new Map<string, number>(), chars = 0;
  for (const [ref, cell] of entries) {
    if (!part || chars >= BLOCK_PART_CHARS) {
      if (part) sizes.push(chars);
      part = { refs: [], values: [], versions: [], styles: [], fmts: [] }; fmtIndex = new Map(); chars = 0;
      parts.push(part);
    }
    const value = cell.value == null ? "" : String(cell.value);
    let style = -1;
    if (cell.fmt && typeof cell.fmt === "object") {
      const key = JSON.stringify(cell.fmt);
      const known = fmtIndex.get(key);
      if (known !== undefined) style = known;
      else { style = part.fmts.length; fmtIndex.set(key, style); part.fmts.push(cell.fmt); chars += key.length; }
    }
    part.refs.push(ref); part.values.push(value); part.versions.push(cell.version || 1); part.styles.push(style);
    chars += ref.length + value.length + 12;
  }
  if (part) sizes.push(chars);
  if (parts.length > 1) parts[0].parts = parts.length;
  return { parts, sizes };
}
// Cells of a stored part into `into` (Map ref -> cell). Cells of a part share its format
// objects; nothing on the server changes a format in place.
function unpackBlockInto(part: StoredPart, into: Map<string, Cell>): Map<string, Cell> {
  const { refs, values, versions, styles, fmts } = part;
  for (let i = 0; i < refs.length; i++) {
    into.set(refs[i], { value: values[i], fmt: styles[i] >= 0 ? fmts[styles[i]] : null, version: versions[i] });
  }
  return into;
}
function sameCellMaps(a: Map<string, Cell>, b: Map<string, Cell>): boolean {
  if (a.size !== b.size) return false;
  for (const [ref, cell] of a) { const other = b.get(ref); if (!other || !sameStoredCell(cell, other)) return false; }
  return true;
}
// What a part's cells (at `indices`) add to a page, as appendPart counts them, formats aside.
function packedChars(part: StoredPart, indices: Iterable<number>): number {
  let chars = 0;
  for (const i of indices) chars += part.refs[i].length + part.values[i].length + 12;
  return chars;
}
// Appends a stored part (or the cells of it at `indices`) to a page being assembled for a client
// or an export, re-indexing its formats into the page's (`fmtIndex`: JSON -> index). Returns the
// characters added.
function appendPart(page: PageBuilder, fmtIndex: Map<string, number>, part: StoredPart, withFormats = true, indices: Iterable<number> = part.refs.keys()): number {
  let chars = 0;
  // A page that asks for formats has `styles` and `fmts` (readPackedPage).
  const pageFmts = page.fmts as CellFmt[], pageStyles = page.styles as number[];
  const remap = withFormats ? part.fmts.map((fmt) => {
    const key = JSON.stringify(fmt);
    let index = fmtIndex.get(key);
    if (index === undefined) { index = pageFmts.length; fmtIndex.set(key, index); pageFmts.push(fmt); chars += key.length; }
    return index;
  }) : [];
  for (const i of indices) {
    page.refs.push(part.refs[i]); page.values.push(part.values[i]);
    if (page.versions) page.versions.push(part.versions[i]);
    if (withFormats) pageStyles.push(part.styles[i] >= 0 ? remap[part.styles[i]] : -1);
    chars += part.refs[i].length + part.values[i].length + 12;
  }
  return chars;
}

// Collects puts and deletes, then issues them together with no await in between, which the
// storage layer commits atomically (all of them or none). `size` (characters, roughly) keeps
// each put call to a sensible amount of data.
class WriteBatch {
  declare storage: DurableObjectStorage;
  declare puts: Map<string, { value: unknown; size: number }>;
  declare deletes: Set<string>;
  constructor(storage: DurableObjectStorage) { this.storage = storage; this.puts = new Map(); this.deletes = new Set(); }
  put(key: string, value: unknown, size = 200) { this.deletes.delete(key); this.puts.set(key, { value, size }); }
  delete(key: string) { this.puts.delete(key); this.deletes.add(key); }
  flush(): Promise<unknown[]> {
    const writes: Promise<unknown>[] = [];
    let entries: Record<string, unknown> = {}, n = 0, chars = 0;
    for (const [key, { value, size }] of this.puts) {
      if (n && (n === STORAGE_BATCH || chars + size > STORAGE_PUT_CHARS)) { writes.push(this.storage.put(entries)); entries = {}; n = 0; chars = 0; }
      entries[key] = value; n++; chars += size;
    }
    if (n) writes.push(this.storage.put(entries));
    const keys = [...this.deletes];
    for (let i = 0; i < keys.length; i += STORAGE_BATCH) writes.push(this.storage.delete(keys.slice(i, i + STORAGE_BATCH)));
    this.puts = new Map(); this.deletes = new Set();
    return Promise.all(writes);
  }
}

// One operation's cell writes, gathered by sheet and block and turned into block writes at the
// end (`plan`), so each touched block is read and written once. Blocks read through `read`
// are kept for `plan`, which then doesn't read them again. All writers run inside the mutation
// queue, so a block can't change between its read and its write.
class CellWriter {
  declare owner: Gadget;
  declare sheets: Map<string, SheetWrites>;
  declare cache: Map<string, Block | null>;
  constructor(owner: Gadget) { this.owner = owner; this.sheets = new Map(); this.cache = new Map(); }
  sheet(id: string): SheetWrites {
    let s = this.sheets.get(id);
    if (!s) this.sheets.set(id, s = { clear: false, replace: null, changes: new Map() });
    return s;
  }
  put(id: string, ref: string, cell: Cell) { this.change(id, ref, cell); }
  delete(id: string, ref: string) { this.change(id, ref, null); }
  change(id: string, ref: string, cell: Cell | null) {
    const s = this.sheet(id), index = blockOfKey(ref);
    let changes = s.changes.get(index);
    if (!changes) s.changes.set(index, changes = new Map());
    changes.set(ref, cell);
  }
  // The sheet's cells become exactly `cells` (Map ref -> cell), plus changes made after this.
  replace(id: string, cells: Map<string, Cell>) { const s = this.sheet(id); s.clear = false; s.replace = cells; s.changes.clear(); }
  clear(id: string) { const s = this.sheet(id); s.clear = true; s.replace = null; s.changes.clear(); }
  // The given cells (those that exist) as a new Map.
  async read(id: string, refs: Iterable<string>): Promise<Map<string, Cell>> {
    const byBlock = new Map<number, string[]>();
    for (const ref of refs) {
      const index = blockOfKey(ref);
      let list = byBlock.get(index);
      if (!list) byBlock.set(index, list = []);
      list.push(ref);
    }
    const blocks = await this.blocks(id, [...byBlock.keys()]);
    const out = new Map<string, Cell>();
    for (const [index, list] of byBlock) {
      const block = blocks.get(index);
      if (!block) continue;
      for (const ref of list) { const cell = block.cells.get(ref); if (cell) out.set(ref, cell); }
    }
    return out;
  }
  async blocks(id: string, indices: number[]): Promise<Map<number, Block>> {
    const missing = indices.filter((index) => !this.cache.has(id + "\u0000" + index));
    if (missing.length) {
      const read = await this.owner.readBlocks(id, missing);
      for (const index of missing) this.cache.set(id + "\u0000" + index, read.get(index) || null);
    }
    const out = new Map<number, Block>();
    for (const index of indices) { const block = this.cache.get(id + "\u0000" + index); if (block) out.set(index, block); }
    return out;
  }
  async plan(batch: WriteBatch) {
    for (const [id, s] of this.sheets) {
      if (s.clear || s.replace) await this.owner.planWholeSheet(id, s, batch);
      else {
        const blocks = await this.blocks(id, [...s.changes.keys()]);
        for (const [index, changes] of s.changes) {
          const block = blocks.get(index);
          const cells = block ? new Map(block.cells) : new Map<string, Cell>();
          for (const [ref, cell] of changes) { if (cell) cells.set(ref, cell); else cells.delete(ref); }
          writeBlock(batch, id, index, cells, block?.parts || 0);
        }
      }
    }
    this.sheets.clear(); this.cache.clear();
  }
}
// Writes a block's cells (removing it when empty), and deletes parts it no longer needs.
function writeBlock(batch: WriteBatch, sheetId: string, index: number, cells: Map<string, Cell>, oldParts: number) {
  const { parts, sizes } = packBlock(cells);
  parts.forEach((part, p) => batch.put(blockKey(sheetId, index, p), part, sizes[p]));
  for (let p = parts.length; p < oldParts; p++) batch.delete(blockKey(sheetId, index, p));
}


const CSV_FORMAT_PREFIX = "csv:";
// The platform allows 32 formats; one is the Excel workbook and one the PDF, so CSVs get 30.
const MAX_CSV_SHEETS = 30;
const MAX_EXPORT_ID_LENGTH = 128;
/** An export format as the Workshop lists it. */
interface ExportFormat {
  id: string;
  label: string;
  mode: "server" | "browser";
  contentType: string;
  fileExtension: string;
  /** The download's whole name; the Workshop names it after the gadget when this is unset. */
  fileName?: string;
}
const XLSX_FORMAT: ExportFormat = {
  id: "xlsx",
  label: "Excel workbook",
  mode: "server",
  contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  fileExtension: ".xlsx",
};
// The whole workbook, one sheet per page, using the print layout.
const PDF_FORMAT: ExportFormat = { id: "pdf", label: "PDF", mode: "browser", contentType: "application/pdf", fileExtension: ".pdf" };

// Sheet ids are client-chosen, so duplicates and over-long ids are possible in stored structure.
// Either would fail format validation and disable every export.
function csvSheetIds(document: StructureWithRevision): string[] {
  const ids = document.sheetOrder.filter((id) => document.sheets[id] && (CSV_FORMAT_PREFIX + id).length <= MAX_EXPORT_ID_LENGTH);
  return Array.from(new Set(ids)).slice(0, MAX_CSV_SHEETS);
}

// With several sheets, each CSV download is named after its sheet, so they don't all save under
// the gadget's name. A format's fileName replaces the whole name, and the gadget's own title is
// the Workshop's, not the workbook's, so the sheet's name stands alone. The Workshop accepts only
// [A-Za-z0-9._-]: other characters become "-", a name with none left is "Sheet<n>", and names that
// end up the same are told apart by a number.
function csvFileNames(sheetNames: string[]): string[] {
  const used = new Set<string>();
  return sheetNames.map((name, index) => {
    const base = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|-+$/g, "").slice(0, 200) || "Sheet" + (index + 1);
    let fileName = base + ".csv";
    for (let n = 2; used.has(fileName.toLowerCase()); n++) fileName = base + "-" + n + ".csv";
    used.add(fileName.toLowerCase());
    return fileName;
  });
}

export class ExportHandler extends WorkerEntrypoint {
  async getExportFormats(gadget: ExportGadgetStub): Promise<ExportFormat[]> {
    const document = await gadget.getStructure();
    disposeResult(document);
    const sheetIds = csvSheetIds(document);
    const fileNames = csvFileNames(sheetIds.map((sheetId) => document.sheets[sheetId].name));
    return [
      XLSX_FORMAT,
      ...sheetIds.map((sheetId, index): ExportFormat => ({
        id: CSV_FORMAT_PREFIX + sheetId,
        label: sheetIds.length === 1 ? "CSV" : "CSV (" + document.sheets[sheetId].name + ")",
        mode: "server",
        contentType: "text/csv",
        fileExtension: ".csv",
        ...(sheetIds.length > 1 ? { fileName: fileNames[index] } : {}),
      })),
      PDF_FORMAT,
    ];
  }

  // Everything is read (in pages) before this returns; the files are then generated as the
  // download reads them, row by row, never as one big string.
  async export(gadget: ExportGadgetStub, id: string): Promise<ReadableStream<Uint8Array>> {
    if (id === XLSX_FORMAT.id) {
      const workbook = await loadExportWorkbook(gadget, { formats: true });
      return workbookToXlsx(workbook, refreshExportPivots(workbook));
    }
    if (!id.startsWith(CSV_FORMAT_PREFIX)) {
      throw new Error("Unsupported spreadsheet export format: " + id);
    }
    const sheetId = id.slice(CSV_FORMAT_PREFIX.length);
    const structure = await gadget.getStructure();
    disposeResult(structure);
    if (!csvSheetIds(structure).includes(sheetId)) {
      throw new Error("The selected worksheet is unavailable for CSV export.");
    }
    // Every sheet is read: a formula on this one may read the others.
    const workbook = await loadExportWorkbook(gadget, { formats: true });
    const evaluator = refreshExportPivots(workbook), data = workbook.cells.get(sheetId);
    if (!data) throw new Error("The selected worksheet is unavailable for CSV export.");
    return textStream(csvLines(data, sheetId, evaluator, workbook.fmts));
  }
}

// One CSV line per row through the last row with a value, as wide as the widest row; commas
// for empty fields are written in runs rather than field by field. Each field is what the cell
// shows in the grid: a formula's result, a number in its format ("$1,200", "01/15/2024"). Text
// that a spreadsheet would read as a formula (`'=1+1` shows as `=1+1`; `+`, `-`, `@`, tab and CR
// start one too) gets a leading `'`, as such text is typed, so opening the file runs nothing; numbers such as
// -5 are left alone. The file starts with a byte order mark, which Excel needs to read UTF-8.
function* csvLines(data: ExportCells, sheetId: string, evaluator: ExportEvaluator, fmts: CellFmt[]): Generator<string> {
  let lastRow = -1, maxColumn = -1;
  for (let i = 0; i < data.size; ++i) {
    if (data.values[i] === "") continue;
    if (data.rows[i] > lastRow) lastRow = data.rows[i];
    if (data.cols[i] > maxColumn) maxColumn = data.cols[i];
  }
  yield "\ufeff";
  if (lastRow < 0) return;
  const order = data.order;
  let k = 0;
  for (let row = 0; row <= lastRow; ++row) {
    let line = "", column = 0;
    while (k < order.length && data.rows[order[k]] === row) {
      const i = order[k++];
      if (data.values[i] === "") continue;
      const text = csvText(evaluator, sheetId, data.rows[i], data.cols[i], data.fmtIds[i] >= 0 ? fmts[data.fmtIds[i]] : null);
      if (text === "") continue;
      line += ",".repeat(data.cols[i] - column) + escapeCsvField(text);
      column = data.cols[i];
    }
    yield line + ",".repeat(maxColumn - column) + "\r\n";
  }
}

function csvText(evaluator: ExportEvaluator, sheetId: string, row: number, column: number, fmt: CellFmt | null): string {
  const value = evaluator.value(sheetId, row, column);
  // A formula past the evaluation budget shows as its own text, marked as text like the rest.
  const shown: Display = value === EXPORT_UNKNOWN ? { text: evaluator.display(sheetId, row, column, fmt) } : displayValue(value as Scalar, fmt);
  return !shown.numeric && !shown.err && /^[=+\-@\t\r]/.test(shown.text) ? "'" + shown.text : shown.text;
}

function csvCellRef(row: number, column: number): string {
  let letters = "";
  for (let value = column + 1; value > 0; value = Math.floor((value - 1) / 26)) {
    letters = String.fromCharCode(65 + (value - 1) % 26) + letters;
  }
  return letters + (row + 1);
}

function escapeCsvField(value: unknown): string {
  const text = String(value);
  return /[",\r\n]/.test(text) ? "\"" + text.replace(/\"/g, "\"\"") + "\"" : text;
}

