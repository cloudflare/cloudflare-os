import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { CHART_BOUNDS, MAX_CHARTS, PLACEMENT_ROWS, chartPlacement } from "./lib/charts.ts";
import { formulaReferences } from "./lib/formula.ts";
import { DEFAULT_COLS, DEFAULT_ROWS, EXPORT_PAGE_CHARS, ExportEvaluator, type ExportCells, disposeResult, loadExportWorkbook, parseCsvCellRef, textStream } from "./lib/export-data.ts";
import { workbookToXlsx } from "./lib/xlsx.ts";
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
  SheetFilter,
  SheetMeta,
  SheetSlice,
  SheetsDocument,
  SheetsPresenceEvent,
  StructureWithRevision,
  SubscribeOptions,
  SubscriberCallbacks,
} from "./lib/protocol.ts";

const DEFAULT_TITLE = "Untitled spreadsheet";

// ---------------------------------------------------------------------------
// Sheets — authoritative collaboration coordinator.
//
// Storage layout:
//   "meta"                -> { revision, title, sheetOrder:[id], sheets:{id:{...}}, lastModified, cellStorage: 3 }
//   "b:<sheetId>:<00012>" -> block 12: the cells of rows 385–416, packed (see blockKey)
//
// Blocks of rows keep stored values small, let an edit rewrite only the blocks it touches, load
// top to bottom, and keep a big sheet to a few thousand keys. Older workbooks (one
// "cells:<id>" value per sheet) are converted the first time they load (migrateCellStorage).
//
// Cell content uses per-cell optimistic concurrency (like Docs blocks).
// Structure (sheet list, names, dimensions, column widths, row heights, title)
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
}
/**
 * A subscriber as stored: its callbacks (kept past the call that delivered them), who it said it
 * was, and whether it is an editor from before paged loading (`legacy`, see subscribe).
 */
interface SubscriberInfo {
  callback: SubscriberStub;
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
  declare subscribers: Map<SubscriberStub, SubscriberInfo>;
  declare mutationQueue: Promise<unknown>;
  declare uploads: Map<string, Upload>;
  declare migration: Promise<void> | null;
  declare pageSlots: number;
  declare pageWaiters: (() => void)[];

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.ctx = ctx;
    this.subscribers = new Map();
    // Overlapping RPC calls are serialized so each observes/commits one
    // authoritative state in strict order.
    this.mutationQueue = Promise.resolve();
    // Sheet replacements too large for one message, arriving in parts (stageCells).
    this.uploads = new Map();
    this.migration = null;
    // Big pages (client loads, exports) are built at most two at a time: each holds a few MB
    // while it is assembled and sent.
    this.pageSlots = 2;
    this.pageWaiters = [];
  }

  async withPageSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.pageSlots > 0) this.pageSlots--;
    else await new Promise<void>((resolve) => this.pageWaiters.push(resolve));
    try { return await fn(); }
    finally { const next = this.pageWaiters.shift(); if (next) next(); else this.pageSlots++; }
  }

  enqueueMutation<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(fn);
    this.mutationQueue = result.catch(() => {});
    return result;
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
        cellStorage: 3,
      };
      await this.ctx.storage.put("meta", meta);
    } else if (meta.cellStorage !== 3) {
      await this.migrateCellStorage();
      meta = (await this.ctx.storage.get<DocumentMeta>("meta")) as DocumentMeta; // migration rewrote it; it exists
    }
    return meta;
  }

  // The previous layout, one "cells:<id>" value per sheet, becomes blocks; the blocks and the new
  // meta are written at once.
  migrateCellStorage(): Promise<void> {
    if (!this.migration) {
      this.migration = (async () => {
        const meta = await this.ctx.storage.get<DocumentMeta>("meta");
        if (!meta || meta.cellStorage === 3) return;
        const batch = new WriteBatch(this.ctx.storage);
        for (const id of Object.keys(meta.sheets || {})) {
          const blocks = new Map<number, Map<string, Cell>>();
          const add = (ref: string, cell: Cell | undefined) => {
            // A cell past a sheet's edge (older versions accepted any ref) is never shown.
            if (!isGridRef(ref) || !cell) return;
            const index = blockOfRef(ref);
            let cells = blocks.get(index);
            if (!cells) blocks.set(index, cells = new Map());
            cells.set(ref, cell);
          };
          const blob = await this.ctx.storage.get<CellMap>("cells:" + id);
          for (const [ref, cell] of Object.entries(blob || {})) add(ref, cell);
          batch.delete("cells:" + id);
          for (const [index, cells] of blocks) writeBlock(batch, id, index, cells, 0);
        }
        meta.cellStorage = 3;
        batch.put("meta", meta);
        await batch.flush();
      })().finally(() => { this.migration = null; });
    }
    return this.migration;
  }

  // --- Cell storage (blocks of rows; see blockKey) ----------------------------
  // A sheet's stored block parts in order, as { name, part, end } (`end`: the block's last
  // part). `after` (a block name), `from` and `to` (block names; `to` excluded) limit the run.
  // Reads of other work can interleave with an edit between storage calls, so a block stored
  // in several parts is read again whole, in one call (readWholeBlock): its parts always come
  // from one moment, and no cell can slip between them while it's repacked.
  async *blockParts(sheetId: string, { after = "", from = "", to = "" }: BlockRun = {}): AsyncGenerator<BlockStep> {
    const prefix = blockPrefix(sheetId), range: DurableObjectListOptions & { limit: number } = { prefix, limit: 64 };
    if (after) range.startAfter = prefix + after + "~\uffff"; else if (from) range.start = prefix + from;
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
        range.startAfter = prefix + name + "~\uffff";
        relist = true;
        break;
      }
      if (!relist && page.size < range.limit) return;
    }
  }

  // Every part of a block from one storage read ([] if the block is gone).
  async readWholeBlock(sheetId: string, index: number): Promise<StoredPart[]> {
    let count = 2;
    for (;;) {
      const keys = Array.from({ length: count }, (_, p) => blockKey(sheetId, index, p));
      const map = await this.ctx.storage.get<StoredPart | undefined>(keys);
      const first = map.get(keys[0]);
      if (!first?.refs) return [];
      const want = first.parts || 1;
      if (want <= count) return keys.slice(0, want).map((key) => map.get(key)).filter((part): part is StoredPart => !!part?.refs);
      count = want;
    }
  }

  // A whole sheet as { ref: cell }. Only for work that needs every cell (row inserts, scripts).
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
      const index = blockOfRef(ref);
      let cells = target.get(index);
      if (!cells) target.set(index, cells = new Map());
      if (cell) cells.set(ref, cell); else cells.delete(ref);
    };
    if (s.replace) for (const [ref, cell] of s.replace) if (isGridRef(ref) && cell) set(ref, cell);
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
  // from the parts after `after` ("" = from block `from`, or the top) up to block `to`. `next`
  // is the last part sent (where the following page continues), or null when the run is done.
  // Stored parts are already packed, so a page is mostly concatenation.
  async readPackedPage(sheetId: string, { after = "", from = "", to = "" }: BlockRun, budget: number, { versions = true, formats = true } = {}): Promise<{ packed: PageBuilder; chars: number; next: string | null }> {
    const page: PageBuilder = { refs: [], values: [] };
    if (versions) page.versions = [];
    if (formats) { page.styles = []; page.fmts = []; }
    const fmtIndex = new Map<string, number>();
    let chars = 0;
    for await (const { name, part, end } of this.blockParts(sheetId, { after, from, to })) {
      chars += appendPart(page, fmtIndex, part, formats);
      // Pages end between blocks, so a page never holds half a block.
      if (end && chars >= budget) return { packed: page, chars, next: name };
    }
    return { packed: page, chars, next: null };
  }

  // The same as { ref: cell }, for callers that don't ask for packed pages.
  async readPage(sheetId: string, after: string, budget: number): Promise<{ cells: CellMap; bytes: number; next: string | null }> {
    const { packed: page, chars, next } = await this.readPackedPage(sheetId, { after }, budget);
    const packed = page as FullPackedCells; // asked with versions and formats
    const cells: CellMap = {};
    for (let i = 0; i < packed.refs.length; i++) {
      cells[packed.refs[i]] = { value: packed.values[i], fmt: packed.styles[i] >= 0 ? packed.fmts[packed.styles[i]] : null, version: packed.versions[i] };
    }
    return { cells, bytes: chars, next };
  }

  // Up to 8 runs of blocks covering a sheet from `after` on (at least 32 blocks, about 1,000
  // rows, each), so a client can read them a couple at a time.
  sheetSlices(meta: DocumentMeta, sheetId: string, after = ""): SheetSlice[] {
    const blocks = Math.max(1, Math.ceil((meta.sheets[sheetId]?.rows || 1) / BLOCK_ROWS));
    const first = Math.min(after ? blockIndexOfName(after) : 0, blocks - 1);
    const count = Math.max(1, Math.min(8, Math.floor((blocks - first) / 32))), step = Math.ceil((blocks - first) / count);
    const slices: SheetSlice[] = [];
    for (let start = first; start < blocks; start += step) {
      const end = start + step;
      slices.push({ sheetId, after: start === first ? after : "", from: blockName(start), to: end >= blocks ? "" : blockName(end) });
    }
    return slices;
  }

  async getSheetSlices({ sheetIds = [] }: { sheetIds?: unknown } = {}): Promise<{ revision: number; slices: SheetSlice[] }> {
    const meta = await this.loadMeta();
    const ids = (Array.isArray(sheetIds) ? sheetIds : []).map(String).filter((id) => hasSheet(meta, id));
    return { revision: meta.revision, slices: ids.flatMap((id) => this.sheetSlices(meta, id)) };
  }

  async assembleDocument(meta: DocumentMeta): Promise<SheetsDocument> {
    const cells: Record<string, CellMap> = {};
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

  // The whole workbook in one value, for editors from before paged loading (see subscribe) and
  // scripts. Clients use openDocument + getCellsPage, which never hold or send a big workbook at once.
  async getDocument(): Promise<SheetsDocument> {
    return this.assembleDocument(await this.loadMeta());
  }

  // Structure, plus as many cells as fit one page. `cursors` maps each sheet that isn't
  // complete to where it continues (`getCellsPage({ after })`; "" = from its start). Pages can
  // span revisions: a client compares each page's `revision` (subscribers replay the events
  // they buffered meanwhile, which makes the result exact).
  // `packed: true` (the client): cells come as `packed` (sheetId -> packed page, see
  // readPackedPage) instead of `cells`, and `slices` lists runs of what's left that can be read
  // side by side (`getCellsPage({ sheetId, after, from, to, packed })`).
  async openDocument(options: { packed?: boolean } = {}): Promise<OpenedDocument> {
    return this.withPageSlot(() => this.openDocumentLocked(options));
  }
  async openDocumentLocked({ packed = false } = {}): Promise<OpenedDocument> {
    const meta = await this.loadMeta();
    const cells: Record<string, CellMap | FullPackedCells> = {}, cursors: Record<string, string> = {}, slices: SheetSlice[] = [];
    let budget = PAGE_BYTES;
    for (const id of meta.sheetOrder) {
      if (budget <= 0) {
        cursors[id] = "";
        if (packed) slices.push(...this.sheetSlices(meta, id)); else cells[id] = {};
        continue;
      }
      let next: string | null;
      if (packed) { const page = await this.readPackedPage(id, {}, budget); cells[id] = page.packed as FullPackedCells; budget -= page.chars; next = page.next; }
      else { const page = await this.readPage(id, "", budget); cells[id] = page.cells; budget -= page.bytes; next = page.next; }
      if (next != null) { cursors[id] = next; if (packed) slices.push(...this.sheetSlices(meta, id, next)); }
    }
    return {
      revision: meta.revision, title: meta.title, sheetOrder: meta.sheetOrder, sheets: meta.sheets,
      // Each entry was read in the form `packed` asked for.
      ...(packed ? { packed: cells as Record<string, FullPackedCells>, slices } : { cells: cells as Record<string, CellMap> }), cursors, lastModified: meta.lastModified,
    };
  }

  async getCellsPage({ sheetId, after = "", from = "", to = "", packed = false }: { sheetId?: unknown; after?: unknown; from?: unknown; to?: unknown; packed?: boolean } = {}): Promise<CellsPage> {
    const meta = await this.loadMeta();
    const id = String(sheetId || "");
    if (!hasSheet(meta, id)) return { revision: meta.revision, sheetId: id, cells: {}, next: null, missing: true };
    if (packed) {
      const page = await this.withPageSlot(() => this.readPackedPage(id, { after: String(after || ""), from: String(from || ""), to: String(to || "") }, PAGE_BYTES));
      return { revision: meta.revision, sheetId: id, packed: page.packed as FullPackedCells, next: page.next };
    }
    const page = await this.withPageSlot(() => this.readPage(id, String(after || ""), PAGE_BYTES));
    return { revision: meta.revision, sheetId: id, cells: page.cells, next: page.next };
  }

  // Cells for exports, compactly: parallel `refs` / `values` (and `styles`, an index into this
  // page's `fmts`, -1 for none) in storage order. `revision` is -1 if an edit landed while
  // the page was read, so the exporter knows to read again.
  async exportPage({ sheetId, after = "", formats = true }: { sheetId?: unknown; after?: unknown; formats?: boolean } = {}): Promise<ExportPage> {
    const meta = await this.loadMeta(), id = String(sheetId || "");
    if (!hasSheet(meta, id)) return { revision: meta.revision, refs: [], values: [], ...(formats ? { styles: [], fmts: [] } : {}), next: null, missing: true };
    const { packed, next } = await this.withPageSlot(() => this.readPackedPage(id, { after: String(after || "") }, EXPORT_PAGE_CHARS, { versions: false, formats }));
    const now = await this.ctx.storage.get<DocumentMeta>("meta");
    return { ...packed, next, revision: now?.revision === meta.revision ? meta.revision : -1 };
  }

  // Sheet names and order, without cells (export menus).
  async getStructure(): Promise<StructureWithRevision> {
    const meta = await this.loadMeta();
    return { revision: meta.revision, title: meta.title, sheetOrder: meta.sheetOrder, sheets: meta.sheets };
  }

  // A sheet replacement too large for one message arrives as numbered parts, held here until
  // the applyOperation naming its `uploadId` claims it. Re-sent parts are ignored. Uploads
  // live in memory: if the object restarts first, applyOperation answers "upload-missing"
  // and the client sends them again.
  stageCells({ uploadId, sheetId, part, cells }: { uploadId?: unknown; sheetId?: unknown; part?: unknown; cells?: unknown } = {}): { received: number } {
    const id = String(uploadId || "");
    if (!id || id.length > 80) throw new Error("Bad upload id");
    const now = Date.now();
    for (const [key, upload] of this.uploads) if (now - upload.at > 10 * 60 * 1000) this.uploads.delete(key);
    let upload = this.uploads.get(id);
    if (!upload) { upload = { sheetId: String(sheetId || ""), cells: new Map(), parts: new Set(), at: now }; this.uploads.set(id, upload); }
    upload.at = now;
    const index = Math.max(0, Math.round(Number(part)) || 0);
    if (!upload.parts.has(index)) {
      upload.parts.add(index);
      for (const [ref, cell] of sanitizeCellEntries(cells)) upload.cells.set(ref, cell);
    }
    return { received: upload.cells.size };
  }

  async applyOperation(operation: Operation | null): Promise<OperationResult> {
    if (!isLoose(operation)) throw new Error("applyOperation takes an operation object");
    return this.enqueueMutation(() => this.applyOperationLocked(operation));
  }

  async applyOperationLocked(operation: Operation): Promise<OperationResult> {
    const meta = await this.loadMeta();
    // Structure and replacement payloads may have been built from an earlier snapshot. With a
    // baseRevision, reject the whole operation before touching storage so a stale sort or row
    // insert can't erase another client's (or the agent's) edits.
    if (operation.baseRevision !== undefined && operation.baseRevision !== null && Number(operation.baseRevision) !== meta.revision) {
      return { status: "conflict", revision: meta.revision, conflicts: [], staleRevision: true };
    }
    // A staged replacement must be complete before anything is applied.
    for (const rep of Array.isArray(operation.sheetReplacements) ? operation.sheetReplacements : []) {
      if (rep?.uploadId == null) continue;
      const upload = this.uploads.get(String(rep.uploadId));
      if (!upload || upload.sheetId !== String(rep.sheetId || "") || upload.cells.size !== Number(rep.count)) {
        return { status: "upload-missing", revision: meta.revision, conflicts: [] };
      }
    }
    // Every write is planned first and committed at once, with the new meta, at the end.
    const batch = new WriteBatch(this.ctx.storage);
    const writer = new CellWriter(this);
    let changed = false;

    // --- Structure (applied wholesale; omitted fields keep their values) --
    if (operation.structure) {
      const s = operation.structure;
      // An id becomes part of every block key of its sheet, so a new one must be plain (a sheet
      // "a" would otherwise read the blocks of a sheet "a:b", and "__proto__" can't be a key).
      const incomingOrder = Array.isArray(s.sheetOrder) ? [...new Set(s.sheetOrder.map(String))].filter((id) => hasSheet(meta, id) || (SHEET_ID.test(id) && id !== "__proto__")) : [];
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
      const nextSheets: Record<string, SheetMeta> = {};
      for (const id of order) {
        const incoming: Partial<SheetMeta> = (s.sheets && Object.hasOwn(s.sheets, id) && s.sheets[id]) || {};
        const existing: Partial<SheetMeta> = hasSheet(meta, id) ? meta.sheets[id] : {};
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
          pivot: Object.prototype.hasOwnProperty.call(incoming, "pivot") ? incoming.pivot : existing.pivot,
          created: hasSheet(meta, id) ? existing.created : meta.revision + 1,
        });
      }
      // A pivot's range lives on its source sheet, which may appear later in the order.
      for (const sheet of Object.values(nextSheets)) {
        if (!sheet.pivot) continue;
        const source = Object.hasOwn(nextSheets, sheet.pivot.sourceSheetId) ? nextSheets[sheet.pivot.sourceSheetId] : null;
        sheet.pivot.sourceRange = source ? sanitizeRange(sheet.pivot.sourceRange, source.rows, source.cols, false) : "";
      }
      // Drop cells for removed sheets.
      for (const id of meta.sheetOrder) if (!Object.hasOwn(nextSheets, id)) writer.clear(id);
      meta.sheetOrder = order;
      meta.sheets = nextSheets;
      if (typeof s.title === "string") meta.title = s.title.slice(0, 200) || DEFAULT_TITLE;
      changed = true;
    }

    // Whole-sheet cell replacement (used by sort / clear / insert-delete). Only cells that
    // differ are written.
    const replaced = new Map<string, Map<string, Cell>>(); // sheetId -> Map(ref -> cell): the sheet's new cells
    const claimedUploads: string[] = [];
    if (Array.isArray(operation.sheetReplacements)) {
      for (const rep of operation.sheetReplacements) {
        if (!isLoose(rep)) continue;
        const id = String(rep.sheetId || "");
        if (!hasSheet(meta, id)) continue;
        let next: Map<string, Cell>;
        // Checked above: every named upload is here and complete.
        if (rep.uploadId != null) { next = (this.uploads.get(String(rep.uploadId)) as Upload).cells; claimedUploads.push(String(rep.uploadId)); }
        else next = sanitizeCellEntries(rep.cells);
        writer.replace(id, next);
        replaced.set(id, next);
        changed = true;
      }
    }

    // --- Per-cell operations (optimistic concurrency) --------------------
    const upserts: CellUpsert[] = [];
    const deletes: CellDeletion[] = [];
    const conflicts: CellConflict[] = [];
    const bySheet = new Map<string, CellOp[]>();
    for (const op of Array.isArray(operation.cellOps) ? operation.cellOps : []) {
      if (!isLoose(op)) continue;
      const sid = String(op.sheetId || "");
      let ops = bySheet.get(sid);
      if (!ops) bySheet.set(sid, ops = []);
      ops.push(op);
    }
    for (const [sheetId, ops] of bySheet) {
      if (!hasSheet(meta, sheetId)) continue;
      // Only the cells the ops name are read (a replaced sheet's are already in hand).
      const cells = replaced.get(sheetId) || await writer.read(sheetId, ops.map((op) => String(op.ref || "")).filter(isGridRef));
      for (const op of ops) {
        const ref = String(op.ref || "");
        if (!isGridRef(ref)) continue;
        const cur = cells.get(ref);
        const base = Number(op.baseVersion || 0);
        const isDelete = op.value == null && op.fmt == null;
        if (isDelete) {
          if (!cur) continue;
          if (cur.version !== base) { conflicts.push({ sheetId, ref, cell: cur }); continue; }
          cells.delete(ref);
          writer.delete(sheetId, ref);
          deletes.push({ sheetId, ref });
        } else {
          if (cur && cur.version !== base) { conflicts.push({ sheetId, ref, cell: cur }); continue; }
          const next: Cell = {
            value: op.value == null ? "" : String(op.value).slice(0, 8192),
            fmt: sanitizeFmt(op.fmt),
            version: (cur?.version || 0) + 1,
          };
          cells.set(ref, next);
          writer.put(sheetId, ref, next);
          upserts.push({ sheetId, ref, cell: next });
        }
      }
    }
    if (upserts.length || deletes.length) changed = true;

    if (!changed) {
      return { status: conflicts.length ? "conflict" : "unchanged", revision: meta.revision, conflicts };
    }

    await writer.plan(batch);
    meta.revision += 1;
    meta.lastModified = Date.now();
    batch.put("meta", meta);
    await batch.flush();
    for (const id of claimedUploads) this.uploads.delete(id);

    // The sender already has a replaced sheet's cells; peers get them in the event, or, for a
    // big sheet, `null`, which tells them to load that sheet in pages.
    const event: OperationEvent = {
      type: "operation",
      senderId: operation.senderId,
      revision: meta.revision,
      // A filter's row order makes a big sheet's structure large, so a cell edit doesn't repeat it.
      ...(operation.structure ? { structure: { sheetOrder: meta.sheetOrder, sheets: meta.sheets, title: meta.title } } : {}),
      upserts,
      deletes,
      replacedSheets: [...replaced.keys()],
      lastModified: meta.lastModified,
    };
    if (replaced.size) {
      const replacedCells: Record<string, CellMap | null> = event.replacedCells = {};
      for (const [id, cells] of replaced) replacedCells[id] = cells.size <= INLINE_REPLACEMENT_CELLS ? Object.fromEntries(cells) : null;
    }
    // Don't hold the sender's save on slow or half-open clients.
    this.broadcast(event).catch(() => {});

    const { replacedCells: _, ...ack } = event;
    return { status: conflicts.length ? "conflict" : "applied", ...ack, conflicts };
  }

  // --- Cell API for agents & scripts --------------------------------------
  // Granular, name-friendly methods. Each goes through the mutation queue,
  // bumps versions only for cells whose value or format really changed,
  // persists, and broadcasts a normal operation event with senderId "agent"
  // (without waiting for slow clients), so open sheets animate the change.
  // `sheet` is a sheet id or name (case-insensitive); omitted = first sheet.
  // Rows in the API are 1-based row numbers; columns are letters ("C") or
  // 1-based numbers. Values are stored as text; begin with "=" for a formula.

  async listSheets(): Promise<{ revision: number; sheets: SheetSummary[] }> {
    const meta = await this.loadMeta();
    const sheets: SheetSummary[] = [];
    for (const id of meta.sheetOrder) {
      const s = meta.sheets[id];
      let r2 = -1, c2 = -1, cellCount = 0;
      for await (const { part } of this.blockParts(id)) {
        const { refs, values, styles } = part;
        cellCount += refs.length;
        for (let i = 0; i < refs.length; i++) {
          if (values[i] === "" && styles[i] < 0) continue;
          const p = parseCellRef(refs[i]);
          if (p) { if (p.r > r2) r2 = p.r; if (p.c > c2) c2 = p.c; }
        }
      }
      sheets.push({
        id, name: s.name, rows: s.rows, cols: s.cols,
        usedRange: r2 < 0 ? null : areaRef({ r1: 0, c1: 0, r2, c2 }), cellCount,
        filter: s.filter ? { headerRow: s.filter.row + 1, columns: s.filter.columns.map((c) => colLetters(c)) } : null,
        charts: (s.charts || []).map((c) => ({ id: c.id, type: c.type, range: c.range, title: c.title })),
        pivot: !!s.pivot,
      });
    }
    return { revision: meta.revision, sheets };
  }

  // Raw stored values (formulas as their text; the server doesn't evaluate).
  async readRange({ sheet, range, formats = false }: { sheet?: string; range?: string; formats?: boolean } = {}): Promise<ReadRangeResult> {
    const meta = await this.loadMeta();
    const id = resolveSheetId(meta, sheet);
    let area: Area, cells: Map<string, Cell>;
    if (range) {
      area = parseArea(range);
      if ((area.r2 - area.r1 + 1) * (area.c2 - area.c1 + 1) > 50000) throw new Error("Range too large to read at once (max 50,000 cells); read it in parts");
      const refs = new Set<string>();
      for (let r = area.r1; r <= area.r2; r++) for (let c = area.c1; c <= area.c2; c++) refs.add(colLetters(c) + (r + 1));
      cells = await this.readCells(id, refs);
    } else {
      const all = await this.loadCells(id);
      area = parseArea(usedRange(all) || "A1");
      if ((area.r2 - area.r1 + 1) * (area.c2 - area.c1 + 1) > 50000) throw new Error("Range too large to read at once (max 50,000 cells); read it in parts");
      cells = new Map(Object.entries(all));
    }
    const values: string[][] = [], fmts: (CellFmt | null)[][] = [];
    for (let r = area.r1; r <= area.r2; r++) {
      const row: string[] = [], frow: (CellFmt | null)[] = [];
      for (let c = area.c1; c <= area.c2; c++) {
        const cell = cells.get(colLetters(c) + (r + 1));
        row.push(cell?.value ?? "");
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
    // An object `value` is a `{ value, fmt }` spec of its own, passed on as setCells reads it.
    const spec = fmt === undefined && (value === null || typeof value !== "object") ? value as CellSpec : { value, fmt } as CellSpec;
    return this.setCells({ sheet, cells: { [String(ref)]: spec } });
  }

  // A rectangular block of values (rows of cells) starting at `start`.
  // `fmt`, if given, is merged into every written cell.
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
          write(ref, { value: value ?? "", fmt: fmt ? mergeFmt(cur?.fmt, fmt) : cur?.fmt ?? null });
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
    const prepare = huge ? async (id: string) => {
      // Only the blocks holding the area's rows.
      const refs: string[] = [], rows = { from: blockName(Math.floor(area.r1 / BLOCK_ROWS)), to: blockName(Math.floor(area.r2 / BLOCK_ROWS) + 1) };
      for await (const { part } of this.blockParts(id, rows)) {
        for (const ref of part.refs) {
          const p = parseCellRef(ref);
          if (p && p.r >= area.r1 && p.r <= area.r2 && p.c >= area.c1 && p.c <= area.c2) refs.push(ref);
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

  // Rows are inserted before row number `at` (1-based). Formula references
  // into the sheet (from any sheet), chart and pivot ranges, the filter and
  // row heights move with the rows.
  insertRows({ sheet, at, count = 1 }: { sheet?: string; at?: number; count?: number } = {}): Promise<AgentWriteResult> { return this.shiftAxis(sheet, "rows", toRowIndex(at), lineCount(count)); }
  deleteRows({ sheet, at, count = 1 }: { sheet?: string; at?: number; count?: number } = {}): Promise<AgentWriteResult> { return this.shiftAxis(sheet, "rows", toRowIndex(at), -lineCount(count)); }
  insertCols({ sheet, at, count = 1 }: { sheet?: string; at?: string | number; count?: number } = {}): Promise<AgentWriteResult> { return this.shiftAxis(sheet, "cols", toColIndex(at), lineCount(count)); }
  deleteCols({ sheet, at, count = 1 }: { sheet?: string; at?: string | number; count?: number } = {}): Promise<AgentWriteResult> { return this.shiftAxis(sheet, "cols", toColIndex(at), -lineCount(count)); }

  addSheet({ name, rows, cols, index }: { name?: string; rows?: number; cols?: number; index?: number } = {}): Promise<AgentWriteResult & { sheetId: string; name: string }> {
    return this.enqueueMutation(async () => {
      const meta = await this.loadMeta();
      const id = this.newId();
      let clean = String(name || "").trim().slice(0, 60);
      if (!clean) { let n = meta.sheetOrder.length + 1; while (findSheetByName(meta, "Sheet" + n)) n++; clean = "Sheet" + n; }
      if (findSheetByName(meta, clean)) throw new Error(`A sheet named "${clean}" already exists`);
      meta.sheets[id] = sheetMeta({ id, name: clean, rows, cols, created: meta.revision + 1 });
      const at = Number.isInteger(index) ? Math.max(0, Math.min(meta.sheetOrder.length, index as number)) : meta.sheetOrder.length;
      meta.sheetOrder.splice(at, 0, id);
      return { ...(await this.commitAgent(meta, {})), sheetId: id, name: clean };
    });
  }

  // Formulas anywhere that name the sheet are rewritten to the new name, as the grid does.
  renameSheet({ sheet, name }: { sheet?: string; name?: string } = {}): Promise<AgentWriteResult> {
    return this.enqueueMutation(async () => {
      const meta = await this.loadMeta();
      const id = resolveSheetId(meta, sheet);
      const clean = String(name || "").trim().slice(0, 60);
      if (!clean) throw new Error("Sheet name can't be empty");
      const other = findSheetByName(meta, clean);
      if (other && other !== id) throw new Error(`A sheet named "${clean}" already exists`);
      const oldName = meta.sheets[id].name;
      if (oldName === clean) return { status: "unchanged" as const, revision: meta.revision };
      meta.sheets[id] = sheetMeta({ ...meta.sheets[id], name: clean });
      const prefix = sheetRefPrefix(clean), upserts: CellUpsert[] = [];
      const batch = new WriteBatch(this.ctx.storage), writer = new CellWriter(this);
      for (const sheetId of meta.sheetOrder) {
        for await (const { part } of this.blockParts(sheetId)) {
          for (let i = 0; i < part.refs.length; i++) {
            const old = part.values[i];
            if (old[0] !== "=") continue;
            const value = renameFormulaSheet(old, oldName, prefix);
            if (value === old) continue;
            const cell = { value, fmt: part.styles[i] >= 0 ? part.fmts[part.styles[i]] : null, version: (part.versions[i] || 0) + 1 };
            writer.put(sheetId, part.refs[i], cell);
            upserts.push({ sheetId, ref: part.refs[i], cell });
          }
        }
      }
      await writer.plan(batch);
      return this.commitAgent(meta, { upserts }, batch);
    });
  }

  deleteSheet({ sheet }: { sheet?: string } = {}): Promise<AgentWriteResult> {
    return this.enqueueMutation(async () => {
      const meta = await this.loadMeta();
      const id = resolveSheetId(meta, sheet);
      if (meta.sheetOrder.length <= 1) throw new Error("A workbook needs at least one sheet");
      meta.sheetOrder = meta.sheetOrder.filter((x) => x !== id);
      delete meta.sheets[id];
      const batch = new WriteBatch(this.ctx.storage), writer = new CellWriter(this);
      writer.clear(id);
      await writer.plan(batch);
      return this.commitAgent(meta, {}, batch);
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
  // `prepare(id)`, if given, runs first (inside the queue, so nothing changes in between) and its
  // result reaches `apply` as `prepared`.
  mutateCells<P = undefined>(sheetRef: string | undefined, apply: (editor: CellEditor<P>) => void, prepare: ((id: string) => Promise<P>) | null = null): Promise<AgentWriteResult> {
    return this.enqueueMutation(async () => {
      const meta = await this.loadMeta();
      const id = resolveSheetId(meta, sheetRef);
      const sheet = meta.sheets[id];
      const prepared = prepare ? await prepare(id) : undefined;
      const upserts: CellUpsert[] = [], deletes: CellDeletion[] = [];
      let maxR = -1, maxC = -1;
      const norm = (ref: string) => {
        const p = parseCellRef(ref);
        if (!p) throw new Error(`Bad cell: ${ref}`);
        if (p.r >= MAX_ROWS || p.c >= MAX_COLS) throw new Error(`Cell out of range: ${ref}`);
        return p;
      };
      const keyOf = (ref: string) => { const p = norm(ref); return colLetters(p.c) + (p.r + 1); };
      // `apply` reads synchronously, so the cells it touches are fetched first. A dry run (every
      // cell reading as empty) lists them: which cells an edit touches never depends on what it reads.
      const touched = new Set<string>();
      apply({ read: (ref) => { touched.add(keyOf(ref)); return null; }, write: (ref) => { touched.add(keyOf(ref)); }, sheet, id, prepared });
      const writer = new CellWriter(this);
      const cells = await writer.read(id, touched);
      const batch = new WriteBatch(this.ctx.storage);
      const read = (ref: string) => cells.get(keyOf(ref)) || null;
      const write = (ref: string, next: { value: unknown; fmt: unknown } | null) => {
        const p = norm(ref);
        const key = colLetters(p.c) + (p.r + 1);
        const cur = cells.get(key);
        const value = next ? valueText(next.value) : "";
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
        maxR = Math.max(maxR, p.r); maxC = Math.max(maxC, p.c);
      };
      apply({ write, read, sheet, id, prepared });
      if (!upserts.length && !deletes.length) return { status: "unchanged" as const, revision: meta.revision, updated: 0, cleared: 0 };
      // Writing past the grid's edge grows it.
      const grows = maxR >= sheet.rows || maxC >= sheet.cols;
      if (maxR >= sheet.rows) sheet.rows = Math.min(MAX_ROWS, maxR + 1);
      if (maxC >= sheet.cols) sheet.cols = Math.min(MAX_COLS, maxC + 1);
      await writer.plan(batch);
      const result = await this.commitAgent(meta, { upserts, deletes, structure: grows }, batch);
      return { ...result, updated: upserts.length, cleared: deletes.length };
    });
  }

  // The columns right of `area` that hold a value in its first rows, which a new chart steps past.
  async filledBeside(sheetRef: string | undefined, area: Area): Promise<Set<number>> {
    const meta = await this.loadMeta();
    const id = resolveSheetId(meta, sheetRef);
    const refs = new Set<string>();
    for (let c = area.c2 + 1; c <= Math.min(area.c2 + 27, MAX_COLS - 1); c++) {
      for (let r = area.r1; r <= Math.min(area.r2, area.r1 + PLACEMENT_ROWS - 1); r++) refs.add(colLetters(c) + (r + 1));
    }
    const filled = new Set<number>();
    for (const [ref, cell] of await this.readCells(id, refs)) if (cell.value) filled.add(lettersToCol(ref.match(/^[A-Z]+/)![0]));
    return filled;
  }

  editMeta<E extends object = object>(sheetRef: string | undefined, fn: (sheet: SheetMeta, meta: DocumentMeta) => void, extra: E = {} as E): Promise<AgentWriteResult & E> {
    return this.enqueueMutation(async () => {
      const meta = await this.loadMeta();
      const id = resolveSheetId(meta, sheetRef);
      meta.sheets[id] = sheetMeta(meta.sheets[id]);
      const before = JSON.stringify(meta.sheets[id]);
      fn(meta.sheets[id], meta);
      meta.sheets[id] = sheetMeta(meta.sheets[id]);
      if (JSON.stringify(meta.sheets[id]) === before) return { status: "unchanged" as const, revision: meta.revision, ...extra };
      return { ...(await this.commitAgent(meta, {})), ...extra };
    });
  }

  // Mirrors the client's insert/delete row/column logic.
  shiftAxis(sheetRef: string | undefined, axis: "rows" | "cols", at: number, delta: number): Promise<AgentWriteResult> {
    return this.enqueueMutation(async () => {
      const meta = await this.loadMeta();
      const id = resolveSheetId(meta, sheetRef);
      const s = meta.sheets[id] = sheetMeta(meta.sheets[id]);
      const rowsAxis = axis === "rows";
      const size = rowsAxis ? s.rows : s.cols;
      if (at < 0 || at > size) throw new Error(`${rowsAxis ? "Row" : "Column"} out of range`);
      const count = Math.abs(delta);
      if (delta < 0 && (at + count > size || size - count < 1)) throw new Error(`Can't delete that many ${rowsAxis ? "rows" : "columns"}`);
      // Lines pushed past the grid's limit would hold cells no one can see.
      if (delta > 0 && size + count > (rowsAxis ? MAX_ROWS : MAX_COLS)) throw new Error(`A sheet holds at most ${rowsAxis ? "50,000 rows" : "702 columns"}`);
      const cells = await this.loadCells(id);
      const edge = delta > 0 ? at : at + count;
      // index -> new index, or null for a deleted line.
      const mapIndex = (v: number) => delta < 0 && v >= at && v < at + count ? null : v >= edge ? v + delta : v;
      const same = (v: number): number | null => v;
      const mapRow = rowsAxis ? mapIndex : same, mapCol = rowsAxis ? same : mapIndex;
      const move = (r: number, c: number) => {
        const nr = mapRow(r), nc = mapCol(c);
        return nr == null || nc == null ? null : { r: nr, c: nc };
      };
      const axisInfo = { rows: rowsAxis, at, delta, sheetName: s.name };
      const next: CellMap = {};
      for (const [ref, cell] of Object.entries(cells)) {
        const p = parseCellRef(ref);
        if (!p) continue;
        const to = move(p.r, p.c);
        if (!to) continue;
        const value = cell.value?.[0] === "=" ? adjustFormulaForAxis(cell.value, { ...axisInfo, ownSheet: true }) : cell.value;
        next[colLetters(to.c) + (to.r + 1)] = { ...cell, value, version: (cell.version || 0) + 1 };
      }
      // Formulas on other sheets that point into this one follow too, as ordinary cell edits.
      const upserts: CellUpsert[] = [];
      const batch = new WriteBatch(this.ctx.storage), writer = new CellWriter(this);
      for (const otherId of meta.sheetOrder) {
        if (otherId === id) continue;
        for await (const { part } of this.blockParts(otherId)) {
          for (let i = 0; i < part.refs.length; i++) {
            const old = part.values[i];
            if (old[0] !== "=") continue;
            const value = adjustFormulaForAxis(old, { ...axisInfo, ownSheet: false });
            if (value === old) continue;
            const ref = part.refs[i];
            const moved = { value, fmt: part.styles[i] >= 0 ? part.fmts[part.styles[i]] : null, version: (part.versions[i] || 0) + 1 };
            writer.put(otherId, ref, moved);
            upserts.push({ sheetId: otherId, ref, cell: moved });
          }
        }
      }
      // Chart ranges on this sheet and pivot sources reading it shrink or grow with the lines.
      for (const chart of s.charts) chart.range = remapRangeText(chart.range, mapRow, mapCol);
      for (const otherId of meta.sheetOrder) {
        const pivot = meta.sheets[otherId]?.pivot;
        if (pivot?.sourceSheetId === id) pivot.sourceRange = remapRangeText(pivot.sourceRange, mapRow, mapCol);
      }
      const dims = rowsAxis ? s.rowHeights : s.colWidths;
      const nextDims: Dims = {};
      for (const [k, v] of Object.entries(dims)) {
        const n = Number(k);
        if (delta < 0 && n >= at && n < at + count) continue;
        nextDims[n >= edge ? n + delta : n] = v;
      }
      if (rowsAxis) { s.rowHeights = nextDims; s.rows += delta; } else { s.colWidths = nextDims; s.cols += delta; }
      if (s.filter) {
        const f = s.filter;
        if (rowsAxis) {
          const endRow = f.endRow ?? size - 1;
          if (delta > 0) {
            if (at <= f.row) { f.row += count; f.endRow = endRow + count; }
            else if (at <= endRow) f.endRow = endRow + count;
          } else {
            const deletionEnd = at + count - 1;
            if (f.row >= at && f.row <= deletionEnd) s.filter = null;
            else {
              if (deletionEnd < f.row) f.row -= count;
              if (at <= endRow) f.endRow = endRow - Math.min(count, endRow - at + 1);
            }
          }
        } else {
          const criteria: Record<string, string[]> = {};
          for (const [column, values] of Object.entries(f.criteria || {})) {
            const to = move(0, Number(column));
            if (to) criteria[to.c] = values;
          }
          f.criteria = criteria;
          const shifted = f.columns.map((c) => move(0, c)).filter((p): p is RC => p !== null).map((p) => p.c);
          // Columns inserted inside the table belong to its records.
          const inside = delta > 0 && shifted.length && at > Math.min(...shifted) && at <= Math.max(...shifted);
          f.columns = inside ? [...shifted, ...Array.from({ length: count }, (_, i) => at + i)].sort((a, b) => a - b) : shifted;
          if (!f.columns.length) s.filter = null;
        }
        // A structural change establishes a new natural row order (sheetMeta replaces an empty one).
        if (s.filter) { s.filter.sort = null; s.filter.rowOrder = []; }
      }
      meta.sheets[id] = sheetMeta(s);
      writer.replace(id, new Map(Object.entries(next)));
      await writer.plan(batch);
      return this.commitAgent(meta, {
        upserts,
        replacedCells: { [id]: next },
        hint: { kind: rowsAxis ? "rows" : "cols", op: delta > 0 ? "insert" : "delete", sheetId: id, at, count },
      }, batch);
    });
  }

  // Commits `meta` together with any planned cell writes, then tells clients.
  async commitAgent(meta: DocumentMeta, { upserts = [], deletes = [], replacedCells = null, hint = null, structure = true }: AgentCommit, batch = new WriteBatch(this.ctx.storage)): Promise<AgentWriteResult> {
    meta.revision += 1;
    meta.lastModified = Date.now();
    batch.put("meta", meta);
    await batch.flush();
    // A big replaced sheet goes out as `null`: clients load it in pages.
    if (replacedCells) {
      for (const [sid, cells] of Object.entries(replacedCells)) if (cells && Object.keys(cells).length > INLINE_REPLACEMENT_CELLS) replacedCells[sid] = null;
    }
    // So does a very large edit: listing every cell would make one huge message.
    if (upserts.length + deletes.length > INLINE_EDIT_CELLS) {
      const nulls: Record<string, CellMap | null> = replacedCells = replacedCells || {};
      for (const x of [...upserts, ...deletes]) nulls[x.sheetId] = null;
      upserts = []; deletes = [];
    }
    const event: OperationEvent = {
      type: "operation",
      senderId: "agent",
      revision: meta.revision,
      ...(structure ? { structure: { sheetOrder: meta.sheetOrder, sheets: meta.sheets, title: meta.title } } : {}),
      upserts,
      deletes,
      lastModified: meta.lastModified,
    };
    if (replacedCells) { event.replacedSheets = Object.keys(replacedCells); event.replacedCells = replacedCells; }
    if (hint) event.agentHint = hint;
    // Don't make the caller wait on slow or half-open clients.
    this.broadcast(event).catch(() => {});
    return { status: "applied" as const, revision: meta.revision };
  }

  // --- Presence & subscription ------------------------------------------
  async subscribe(callback: SubscriberStub, options: SubscribeOptions | null = {}): Promise<OpenedDocument> {
    const client = options || {};
    const dup = callback.dup();
    const existing = Array.from(this.subscribers.values());
    const info: SubscriberInfo = {
      callback: dup,
      clientId: presenceId(client.clientId),
      name: String(client.name || "Guest").slice(0, 40),
      color: presenceColor(client.color),
      legacy: !client.packed,
      delivery: Promise.resolve(),
    };
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
      await this.broadcastPresence({ type: "join", clientId: info.clientId, name: info.name, color: info.color });
    });
    // The first page of the workbook; the client loads the rest with getCellsPage. An editor
    // from before paged loading (it doesn't ask for `packed`; one can still be open when the
    // gadget updates) reads only `cells` and would take a first page for the whole workbook,
    // so it gets every cell, as it always did.
    if (info.legacy) return { ...await this.getDocument(), cursors: {} };
    return this.openDocument({ packed: true });
  }

  async updatePresence(input: PresenceInput | null): Promise<void> {
    const presence = input || {};
    await this.broadcastPresence({
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
    await this.broadcastPresence({ type: "leave", clientId: presenceId(clientId), at: Date.now() });
  }

  // Forgets a subscriber whose connection broke or whose callback failed. Releasing the handle
  // lets the client know (its subscriber's dispose hook subscribes again).
  dropSubscriber(stub: SubscriberStub): void {
    if (!this.subscribers.delete(stub)) return;
    try { stub[Symbol.dispose]?.(); } catch { /* already broken */ }
  }

  async broadcast(event: OperationEvent): Promise<void> {
    const calls: Promise<unknown>[] = [];
    let legacyEvent: Promise<OperationEvent> | null = null;
    for (const [stub, info] of this.subscribers) {
      if (!info.legacy) {
        calls.push(Promise.resolve(stub.operation(event)).catch(() => this.dropSubscriber(stub)));
        continue;
      }
      // Reading a replaced sheet's cells takes a moment, so a later event could overtake this
      // one and then be undone by it: a legacy subscriber's events are delivered one at a time.
      const prepared = legacyEvent ??= this.legacyOperationEvent(event);
      const delivered = info.delivery.then(() => prepared).then((e) => stub.operation(e)).catch(() => this.dropSubscriber(stub));
      info.delivery = delivered;
      calls.push(delivered);
    }
    await Promise.all(calls);
  }

  // An event as an editor from before paged loading reads it: a replaced sheet always comes
  // with its cells (it would take `null`, "load it in pages", for an empty sheet), as an
  // edit too large to list does (an agent edit then lists no cells at all).
  async legacyOperationEvent(event: OperationEvent): Promise<OperationEvent> {
    const missing = Object.entries(event.replacedCells || {}).filter(([, cells]) => cells === null).map(([id]) => id);
    if (!missing.length) return event;
    const replacedCells: Record<string, CellMap | null> = { ...event.replacedCells };
    for (const id of missing) replacedCells[id] = await this.loadCells(id);
    return { ...event, replacedCells };
  }

  async broadcastPresence(event: SheetsPresenceEvent): Promise<void> {
    const calls: Promise<unknown>[] = [];
    for (const [stub] of this.subscribers) {
      calls.push(Promise.resolve(stub.presence(event)).catch(() => this.dropSubscriber(stub)));
    }
    await Promise.all(calls);
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
function usedRange(cells: CellMap): string | null {
  let r2 = -1, c2 = -1;
  for (const [ref, cell] of Object.entries(cells || {})) {
    if ((cell?.value ?? "") === "" && !cell?.fmt) continue;
    const p = parseCellRef(ref);
    if (p) { r2 = Math.max(r2, p.r); c2 = Math.max(c2, p.c); }
  }
  return r2 < 0 ? null : areaRef({ r1: 0, c1: 0, r2, c2 });
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
// --- Formula references (text-level; formulaReferences is the engine's own, lib/formula.ts) --
// The sheet name a reference prefix names, folded for comparison: `'Owner''s Sheet'!` and
// `'Owner\'s Sheet'!` both name "owner's sheet".
function referenceSheetName(prefix: string): string {
  const name = prefix.endsWith("!") ? prefix.slice(0, -1) : prefix;
  return (name.startsWith("'") ? name.slice(1, -1).replace(/\\'|''/g, "'") : name).toLowerCase();
}
// A sheet name as formulas write it before `!` (client.js sheetRefPrefix): bare when it can be,
// otherwise quoted with '' for an apostrophe.
function sheetRefPrefix(name: string): string {
  const bare = /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) && !/^[A-Za-z]{1,3}\d+$/.test(name) && !/^(true|false)$/i.test(name);
  return (bare ? name : "'" + name.replace(/'/g, "''") + "'") + "!";
}
// Rewrites references to the sheet named `oldName` with `prefix` (client.js renameFormulaSheet).
function renameFormulaSheet(value: string, oldName: string, prefix: string): string {
  const target = String(oldName).toLowerCase();
  let result = "", start = 0;
  for (const endpoint of formulaReferences(value, true)) {
    const bang = endpoint.text.lastIndexOf("!");
    if (bang < 0 || referenceSheetName(endpoint.text.slice(0, bang + 1)) !== target) continue;
    result += value.slice(start, endpoint.start) + prefix + endpoint.text.slice(bang + 1);
    start = endpoint.end;
  }
  return result + value.slice(start);
}
/** One endpoint of a reference, split for rewriting: where it sits in the reference, its sheet prefix, `$` marks and position. */
interface EndpointPart { start: number; end: number; prefix: string; fc: string; col: number; fr: string; row: number }
// Rewrites a formula's text for rows or columns inserted (delta > 0) or deleted (delta < 0) at
// `at` on the sheet named `sheetName`. Only references into that sheet move: unqualified ones
// when the formula lives there (`ownSheet`), qualified ones from anywhere. A reference into
// deleted lines becomes #REF!; a range shrinks around them. Everything else is left as typed.
function adjustFormulaForAxis(value: string, { rows, at, delta, sheetName, ownSheet }: { rows: boolean; at: number; delta: number; sheetName: string; ownSheet: boolean }): string {
  const target = String(sheetName).toLowerCase(), count = Math.abs(delta);
  const map = (i: number) => delta > 0 ? (i >= at ? i + delta : i) : (i < at ? i : i < at + count ? null : i - count);
  let result = "", start = 0;
  for (const reference of formulaReferences(value)) {
    const parts = [...formulaReferences("=" + reference.text, true)].map((endpoint) => {
      const bang = endpoint.text.lastIndexOf("!");
      const m = /^(\$?)([A-Z]{1,2})(\$?)([1-9]\d*)$/i.exec(endpoint.text.slice(bang + 1));
      return m && { start: endpoint.start - 1, end: endpoint.end - 1, prefix: endpoint.text.slice(0, bang + 1), fc: m[1], col: lettersToCol(m[2]), fr: m[3], row: Number(m[4]) - 1 };
    });
    if (!parts.length || !parts.every((part): part is EndpointPart => !!part)) continue;
    const onTarget = parts[0].prefix ? referenceSheetName(parts[0].prefix) === target : ownSheet;
    if (!onTarget) continue;
    const index = (part: EndpointPart) => rows ? part.row : part.col;
    const lo = Math.min(...parts.map(index)), hi = Math.max(...parts.map(index));
    let nlo: number | null = null, nhi: number | null = null;
    for (let i = lo; i <= hi && nlo == null; i++) nlo = map(i);
    for (let i = hi; i >= lo && nhi == null; i--) nhi = map(i);
    let replacement = "#REF!";
    if (nlo != null && (parts.length > 1 || lo === hi)) {
      replacement = ""; let cursor = 0;
      for (const part of parts) {
        const n = (index(part) === lo ? nlo : nhi) as number; // found whenever nlo is: the same lines, scanned from the other end
        replacement += reference.text.slice(cursor, part.start) + part.prefix + part.fc + colLetters(rows ? part.col : n) + part.fr + ((rows ? n : part.row) + 1);
        cursor = part.end;
      }
      replacement += reference.text.slice(cursor);
    }
    result += value.slice(start, reference.start) + replacement;
    start = reference.end;
  }
  return result + value.slice(start);
}
// Moves a chart or pivot range through row and column maps (index -> index, or null when
// deleted): it shrinks around deleted lines, grows around inserted ones, and empties when
// every line it covered is gone.
function remapRangeText(text: string, mapRow: (i: number) => number | null, mapCol: (i: number) => number | null): string {
  const m = /^([A-Z]+[1-9]\d*)(?::([A-Z]+[1-9]\d*))?$/.exec(String(text || ""));
  if (!m) return text;
  const p = parseCellRef(m[1]), q = parseCellRef(m[2] || m[1]);
  if (!p || !q) return text;
  const first = (from: number, to: number, map: (i: number) => number | null) => { for (let i = from; i <= to; i++) { const v = map(i); if (v != null) return v; } return null; };
  const last = (from: number, to: number, map: (i: number) => number | null) => { for (let i = to; i >= from; i--) { const v = map(i); if (v != null) return v; } return null; };
  const r1 = Math.min(p.r, q.r), r2 = Math.max(p.r, q.r), c1 = Math.min(p.c, q.c), c2 = Math.max(p.c, q.c);
  const nr1 = first(r1, r2, mapRow), nr2 = last(r1, r2, mapRow), nc1 = first(c1, c2, mapCol), nc2 = last(c1, c2, mapCol);
  if (nr1 == null || nr2 == null || nc1 == null || nc2 == null) return "";
  const a = colLetters(nc1) + (nr1 + 1), b = colLetters(nc2) + (nr2 + 1);
  return m[2] || a !== b ? a + ":" + b : a;
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

// A client's cell map ({ ref: cell }) as a Map of clean stored cells.
function sanitizeCellEntries(map: unknown): Map<string, Cell> {
  const out = new Map<string, Cell>();
  if (!map || typeof map !== "object") return out;
  for (const [ref, cell] of Object.entries(map as Record<string, Loose | null | undefined>)) {
    if (!isGridRef(ref)) continue;
    out.set(ref, {
      value: cell?.value == null ? "" : String(cell.value).slice(0, 8192),
      fmt: sanitizeFmt(cell?.fmt),
      version: Math.max(1, Math.round(Number(cell?.version)) || 1),
    });
  }
  return out;
}

// --- Cell storage helpers ---------------------------------------------------
// What clients may write: a cell a sheet can have (A1:ZZ50000). A cell past it is never shown, but
// would still stretch every export to reach it (a CSV through ZZZ999999 is 18 GB of commas).
const GRID_REF = /^[A-Z]{1,2}([1-9][0-9]{0,4})$/;
function isGridRef(ref: string): boolean { const m = GRID_REF.exec(ref); return !!m && Number(m[1]) <= MAX_ROWS; }
const STORAGE_BATCH = 128;          // keys per storage get/put/delete call
const STORAGE_PUT_CHARS = 4_000_000; // and at most about this much data per put call
const PAGE_BYTES = 2_000_000;       // about how much cell data one page to a client carries
const INLINE_REPLACEMENT_CELLS = 5000; // larger replaced sheets are re-read by peers in pages
const INLINE_EDIT_CELLS = 20000;        // agent edits touching more cells: peers re-read those sheets
function sameStoredCell(a: Cell, b: Cell): boolean { return a.value === b.value && a.version === b.version && sameFmt(a.fmt, b.fmt); }

// Cells are stored in blocks of BLOCK_ROWS rows: "b:<sheetId>:<00012>" holds rows 385–416 (block
// 12), packed as parallel arrays (`refs`, `values`, `versions`, `styles` indexing the block's
// `fmts`; -1 for none). Block names are zero-padded, so keys sort top to bottom. A block bigger
// than BLOCK_PART_CHARS continues in "…<00012>~1", "~2", …; part 0 then says how many parts
// there are (`parts`).
const BLOCK_ROWS = 32;
const BLOCK_PART_CHARS = 400_000;
const blockPrefix = (sheetId: string) => "b:" + sheetId + ":";
const blockName = (index: number) => String(index).padStart(5, "0");
const blockKey = (sheetId: string, index: number, part = 0) => blockPrefix(sheetId) + blockName(index) + (part ? "~" + part : "");
const blockIndexOfName = (name: string) => parseInt(name, 10);
function blockOfRef(ref: string): number {
  let i = 0;
  while (i < ref.length && ref.charCodeAt(i) > 57) i++;
  return Math.floor((Number(ref.slice(i)) - 1) / BLOCK_ROWS);
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
// Appends a stored part to a page being assembled for a client or an export, re-indexing its
// formats into the page's (`fmtIndex`: JSON -> index). Returns the characters added.
function appendPart(page: PageBuilder, fmtIndex: Map<string, number>, part: StoredPart, withFormats = true): number {
  let chars = 0;
  // A page that asks for formats has `styles` and `fmts` (readPackedPage).
  const pageFmts = page.fmts as CellFmt[], pageStyles = page.styles as number[];
  const remap = withFormats ? part.fmts.map((fmt) => {
    const key = JSON.stringify(fmt);
    let index = fmtIndex.get(key);
    if (index === undefined) { index = pageFmts.length; fmtIndex.set(key, index); pageFmts.push(fmt); chars += key.length; }
    return index;
  }) : [];
  for (let i = 0; i < part.refs.length; i++) {
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
    const s = this.sheet(id), index = blockOfRef(ref);
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
      const index = blockOfRef(ref);
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
      return workbookToXlsx(workbook, new ExportEvaluator(workbook));
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
    const data = workbook.cells.get(sheetId);
    if (!data) throw new Error("The selected worksheet is unavailable for CSV export.");
    return textStream(csvLines(data, sheetId, new ExportEvaluator(workbook), workbook.fmts));
  }
}

// One CSV line per row through the last row with a value, as wide as the widest row; commas
// for empty fields are written in runs rather than field by field. Each field is what the cell
// shows in the grid: a formula's result, a number in its format ("$1,200", "01/15/2024").
// The file starts with a byte order mark, which Excel needs to read UTF-8.
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
      const text = evaluator.display(sheetId, data.rows[i], data.cols[i], data.fmtIds[i] >= 0 ? fmts[data.fmtIds[i]] : null);
      if (text === "") continue;
      line += ",".repeat(data.cols[i] - column) + escapeCsvField(text);
      column = data.cols[i];
    }
    yield line + ",".repeat(maxColumn - column) + "\r\n";
  }
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

