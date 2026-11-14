// ---------------------------------------------------------------------------
// The contract between the Sheets client and its Durable Object: what is stored,
// what an operation carries, what comes back, and what the server calls the
// client with. Types only; both entries import it with `import type`.
//
// Rows and columns have ids (lib/lines.ts), and the grid speaks in them: a cell is named by its
// key, "rowId:colId", and a formula's references and a sheet's settings name lines by id
// (lib/refs.ts). Editors from before ids (an open tab when the gadget updates) still speak A1;
// the server translates for them by where lines are at the moment (see Operation.lineIds).
// ---------------------------------------------------------------------------
import type { LineOp, StoredOrder } from "./lines.ts";

/** Horizontal alignment: left, centre or right. */
export type Align = "l" | "c" | "r";

/**
 * A cell's formatting. Every key is optional and absent when off: `b`, `i`, `u`, `s` and `wrap`
 * are flags; `c`/`bg` are hex colours; `a` the horizontal alignment; `nf` a number-format name
 * (`auto`, `text`, `number`, `integer`, `percent`, `scientific`, `currency`, `date`, `time`,
 * `datetime`); `d` the decimal places (0–10); `fs` the font size in CSS pixels (6–96).
 */
export interface CellFmt {
  b?: boolean;
  i?: boolean;
  u?: boolean;
  s?: boolean;
  wrap?: boolean;
  c?: string;
  bg?: string;
  a?: Align;
  nf?: string;
  d?: number;
  fs?: number;
}

/** A stored cell: its raw text (a formula starts with `=`), its formatting, and its version for optimistic concurrency. */
export interface Cell {
  value: string;
  fmt: CellFmt | null;
  version: number;
}

/** One sheet's cells, keyed by cell key ("rowId:colId"), or by A1 reference where a type says so. */
export type CellMap = Record<string, Cell>;

/** Column widths or row heights in pixels: keyed by line id as stored, by zero-based index (as a string) as editors see them. */
export type Dims = Record<string, number>;

/** Chart kinds the grid draws and the XLSX writer exports natively. */
export type ChartType = "line" | "pie" | "area" | "stackedBar";

/** A chart floating over a sheet: its data range, labels and placement in grid pixels. */
export interface Chart {
  id: string;
  type: ChartType;
  range: string;
  title: string;
  xAxisTitle: string;
  yAxisTitle: string;
  legend: boolean;
  firstRowHeaders: boolean;
  firstColLabels: boolean;
  smooth: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A filter's sort indicator: the column it sorted on, and which way. */
export interface FilterSort {
  column: number;
  direction: "asc" | "desc";
}

/**
 * A sheet's filter: the header `row` and last row of the table, the columns it covers, the chosen
 * values per column (`criteria`, column -> value tokens; see the client's `filterToken`), the
 * original row order (so a sort can be undone; positions, reset when the sheet's rows change), and
 * the sort. Lines are named by id as stored, by zero-based position as editors see them.
 */
export interface SheetFilter {
  row: number;
  endRow: number;
  columns: number[];
  criteria: Record<string, string[]>;
  rowOrder: number[];
  sort: FilterSort | null;
}

/** How a pivot table summarises its value field. */
export type PivotAggregate = "sum" | "count" | "average" | "min" | "max";

/** A pivot sheet's settings: where its data comes from and how it is grouped and summarised. */
export interface PivotSettings {
  sourceSheetId: string;
  sourceRange: string;
  rowField: string;
  columnField: string;
  valueField: string;
  aggregate: PivotAggregate;
  showRowTotals: boolean;
  showColumnTotals: boolean;
  filterField: string;
  filterValues: string[];
}

/**
 * A sheet's structure: identity, name, size, sizing metadata, filter, charts and pivot settings.
 * As stored and sent, widths, heights and the filter name lines by id, and chart and pivot ranges
 * are stored ranges (lib/refs.ts `viewSheet` turns them into positions); `rows` and `cols` are
 * how many lines are live, which only line operations change.
 */
export interface SheetMeta {
  id: string;
  name: string;
  rows: number;
  cols: number;
  colWidths: Dims;
  rowHeights: Dims;
  frozenRows: number;
  frozenCols: number;
  filter: SheetFilter | null;
  charts: Chart[];
  pivot: PivotSettings | null;
  /** The revision that created the sheet (0 for sheets older than this field); the server assigns it, so a sheet a client adds has none yet. */
  created?: number;
}

/** The workbook structure as the server repeats it after an operation. */
export interface Structure {
  title: string;
  sheetOrder: string[];
  sheets: Record<string, SheetMeta>;
}

/** The `meta` record the server stores: everything about the workbook except the cells. */
export interface DocumentMeta extends Structure {
  revision: number;
  lastModified: number;
  /** `4` marks cells stored by line id (see the server's storage notes); older workbooks are migrated on load. */
  cellStorage?: number;
}

/** A complete workbook snapshot by position, as `getDocument()` returns it: the structure as editors see it, and every sheet's cells by A1 reference with formulas as A1 text. */
export interface SheetsDocument extends Structure {
  revision: number;
  lastModified: number;
  cells: Record<string, CellMap>;
}

/**
 * Cells as parallel arrays, as stored blocks and pages carry them: `styles[i]` indexes `fmts`
 * (-1 for none), so each format travels once. `versions` and `styles`/`fmts` are left out of a
 * page that did not ask for them.
 */
export interface PackedCells {
  refs: string[];
  values: string[];
  versions?: number[];
  styles?: number[];
  fmts?: CellFmt[];
}

/** A packed page with every field present, as clients receive it. */
export type FullPackedCells = Required<PackedCells>;

/** A run of a sheet's row blocks a client reads with `getCellsPage` (block names; `to` excluded, "" for the end). Blocks hold rows by id, so they aren't in display order. */
export interface SheetSlice {
  sheetId: string;
  after: string;
  from: string;
  to: string;
}

/**
 * What `subscribe()` / `openDocument()` return: the stored structure, every sheet's line order,
 * and about one page of cells, packed by cell key with stored values; `slices` lists what is left
 * (read with getCellsPage) and `cursors` maps each sheet that did not fit to where it continues.
 * An editor from before ids subscribes without `lines` and gets `getDocument()`'s snapshot instead
 * (`cells`, by position).
 */
export interface OpenedDocument extends Structure {
  revision: number;
  lastModified: number;
  orders?: Record<string, StoredOrder>;
  cells?: Record<string, CellMap>;
  packed?: Record<string, FullPackedCells>;
  slices?: SheetSlice[];
  cursors: Record<string, string>;
}

/** One page of a sheet's cells (`getCellsPage`), packed by cell key; `next` is where the following page continues. */
export interface CellsPage {
  revision: number;
  sheetId: string;
  packed: FullPackedCells;
  next: string | null;
  /** Set when the sheet no longer exists. */
  missing?: true;
}

/** One page of cells for an export: packed by A1 reference without versions, formulas as A1 text; `revision` is -1 when an edit landed mid-read. */
export interface ExportPage extends PackedCells {
  revision: number;
  next: string | null;
  missing?: true;
}

/**
 * The workbook structure as a client sends it (stored form): last-writer-wins, applied wholesale;
 * anything omitted keeps its stored value. `rows` and `cols` count only for a sheet it creates.
 */
export interface StructureUpdate {
  title?: string;
  sheetOrder?: string[];
  sheets?: Record<string, Partial<SheetMeta>>;
  /** The revision the snapshot was built on: a sheet created after it is kept rather than deleted. */
  revision?: number;
}

/**
 * One cell edit: the cell's key, its new content (formulas in stored form) and the version it was
 * based on (0 for a new cell); `value` and `fmt` both `null` deletes the cell. `basis` is the
 * revision the edit was made on: one made before a sort rewrote its cell is refused as `sorted`
 * rather than written over another record.
 */
export interface CellOp {
  sheetId: string;
  ref: string;
  value: string | null;
  fmt: CellFmt | null;
  baseVersion: number;
  basis?: number;
}

/**
 * A sort's cell writes, applied all together or not at all: every cell op must still match its
 * version, or none is written. `rows` and `cols` are the ids of the lines it sorted. Inline as
 * `cellOps`, or staged with `stageCells` (each staged cell's `version` is its base version, and
 * an empty value without a format deletes it).
 */
export type SortWrite =
  | { sheetId: string; rows: number[]; cols: number[]; cellOps: CellOp[]; uploadId?: undefined }
  | { sheetId: string; rows: number[]; cols: number[]; uploadId: string; count: number; cellOps?: undefined };

/**
 * A whole-sheet cell replacement, for a sheet whose content is regenerated (a pivot table) or made
 * in the same operation (a duplicate). It resets the sheet's lines to `size` in identity order
 * (ids 0..n-1), and its cells are keyed by those ids. Inline, or staged with `stageCells`.
 */
export type SheetReplacement =
  | { sheetId: string; size: { rows: number; cols: number }; cells: CellMap; uploadId?: undefined }
  | { sheetId: string; size: { rows: number; cols: number }; uploadId: string; count: number; cells?: undefined };

/**
 * What a client sends to `applyOperation`, applied in this order: line operations, the structure
 * snapshot, sheet replacements, sorts, then per-cell edits. `lineIds` says the cells and structure
 * are by id (the current client); without it they're by position, from an editor that predates
 * ids, which the server translates by where lines are now.
 */
export interface Operation {
  senderId?: string;
  lineIds?: true;
  lineOps?: LineOp[];
  structure?: StructureUpdate | null;
  sheetReplacements?: SheetReplacement[];
  sorts?: SortWrite[];
  cellOps?: CellOp[];
}

/** One part of a staged sheet replacement (`stageCells`). */
export interface StagedPart {
  uploadId: string;
  sheetId: string;
  part: number;
  cells: CellMap;
}

/** An accepted cell edit, with the version the server assigned. */
export interface CellUpsert {
  sheetId: string;
  ref: string;
  cell: Cell;
}

/** An accepted cell deletion. */
export interface CellDeletion {
  sheetId: string;
  ref: string;
}

/** A rejected cell edit: the client's base version was stale, and this is the authoritative cell to rebase on. */
export interface CellConflict {
  sheetId: string;
  ref: string;
  cell: Cell;
}

/** Rows or columns an agent inserted or deleted, so open grids can draw a hint where they went. */
export interface AgentHint {
  kind: "rows" | "cols";
  op: "insert" | "delete";
  sheetId: string;
  at: number;
  count: number;
}

/**
 * A committed operation as the server broadcasts it to every subscriber: the new revision, the
 * line operations it applied with each changed sheet's order after them, the structure after it
 * (only when the operation changed it), the per-cell diffs, and for each replaced sheet its new
 * cells (`null`: too many to send; reload that sheet in pages).
 */
export interface OperationEvent {
  type: "operation";
  senderId: string | undefined;
  revision: number;
  lineOps?: LineOp[];
  orders?: Record<string, StoredOrder>;
  structure?: Structure;
  upserts: CellUpsert[];
  deletes: CellDeletion[];
  replacedSheets?: string[];
  replacedCells?: Record<string, CellMap | null>;
  agentHint?: AgentHint;
  lastModified: number;
}

/** A whole workbook by position, sent to an editor from before ids in place of a change it can't follow (lines moved, a sheet renamed). */
export interface SnapshotEvent {
  type: "snapshot";
  document: SheetsDocument;
}

/** What the server delivers to a subscriber's `operation` callback. */
export type SubscriberEvent = OperationEvent | SnapshotEvent;

/** The first thing a client reads in a reply. `upload-missing`: a staged write was lost, nothing was applied. */
export type OperationStatus = "applied" | "conflict" | "unchanged" | "upload-missing";

/** What `applyOperation` returns: the status and rejected cells, plus the committed event's fields when anything changed. */
export interface OperationResult extends Partial<Omit<OperationEvent, "replacedCells">> {
  status: OperationStatus;
  revision: number;
  conflicts: CellConflict[];
  /** Cell edits refused because their row or column is gone. */
  gone?: CellDeletion[];
  /** Cell edits refused because a sort rewrote their cell after they were made (see CellOp.basis). */
  sorted?: CellDeletion[];
  /** Line operations refused (an id taken, a line already gone, a size limit), and so not applied. */
  refusedLines?: LineOp[];
  /** Sheets whose sort was refused because a cell it rewrote had changed; nothing in the operation was applied. */
  refusedSorts?: string[];
}

/** What a cell-API write returns. */
export interface AgentWriteResult {
  status: "applied" | "unchanged";
  revision: number;
  updated?: number;
  cleared?: number;
}

/** How a subscriber introduces itself: the id its events carry, and how to draw it. */
export interface CollaboratorInfo {
  clientId: string;
  name: string;
  color: string;
}

/** Where a collaborator is: the selected range on a sheet (`null` before any sheet is active). */
export interface SelectionCursor {
  sheetId: string | null;
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

/** What a client sends to `updatePresence`: who it is and what it has selected. */
export type PresenceUpdate = CollaboratorInfo & SelectionCursor;

/** A presence event as the server broadcasts it: someone joined, moved their selection (with when), or left. */
export type SheetsPresenceEvent =
  | ({ type: "join" } & CollaboratorInfo)
  | ({ type: "cursor"; at: number } & CollaboratorInfo & SelectionCursor)
  | { type: "leave"; clientId: string; at?: number };

/** The callbacks a subscribing client exposes on its `RpcTarget`, as the server calls them. */
export interface SubscriberCallbacks {
  operation(event: SubscriberEvent): unknown;
  presence(event: SheetsPresenceEvent): unknown;
}

/** What a client says about itself when it subscribes; `lines` says it speaks in line ids (see OpenedDocument). */
export interface SubscribeOptions extends Partial<CollaboratorInfo> {
  lines?: boolean;
}

/**
 * The client's view of the Durable Object's RPC surface: every method it calls on the `gadget`
 * stub (over RPC every call resolves to a promise).
 */
export interface GadgetStub {
  subscribe(callback: SubscriberCallbacks, client?: SubscribeOptions): Promise<OpenedDocument>;
  openDocument(): Promise<OpenedDocument>;
  getCellsPage(options: { sheetId: string; after?: string; from?: string; to?: string }): Promise<CellsPage>;
  getSheetSlices(options: { sheetIds: string[] }): Promise<{ revision: number; slices: SheetSlice[] }>;
  stageCells(part: StagedPart): Promise<{ received: number }>;
  applyOperation(operation: Operation): Promise<OperationResult>;
  updatePresence(presence: PresenceUpdate): Promise<void>;
  leavePresence(clientId: string): Promise<void>;
}

/** The structure an export reads first (`getStructure`). */
export interface StructureWithRevision extends Structure {
  revision: number;
}

/** What the export handler calls on the gadget's Durable Object. */
export interface ExportGadgetStub {
  getStructure(): Promise<StructureWithRevision>;
  exportPage(options: { sheetId: string; after?: string; formats?: boolean }): Promise<ExportPage>;
}
