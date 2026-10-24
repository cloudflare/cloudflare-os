// ---------------------------------------------------------------------------
// The contract between the Sheets client and its Durable Object: what is stored,
// what an operation carries, what comes back, and what the server calls the
// client with. Types only; both entries import it with `import type`.
// ---------------------------------------------------------------------------

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

/** One sheet's cells, keyed by A1 reference. */
export type CellMap = Record<string, Cell>;

/** Column widths or row heights in pixels, keyed by zero-based index (as a string). */
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
 * A sheet's filter: the header `row` and last row of the table (zero-based), the columns it
 * covers, the chosen values per column (`criteria`, column index -> value tokens; see the
 * client's `filterToken`), the original row order (so a sort can be undone), and the sort.
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

/** A sheet's structure: identity, name, size, sizing metadata, filter, charts and pivot settings. */
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
  /** `3` marks the block layout; older workbooks are migrated on load. */
  cellStorage?: number;
}

/** A complete workbook snapshot, as `getDocument()` returns it: the meta plus every sheet's cells by sheet id. */
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

/** A run of a sheet's row blocks a client reads with `getCellsPage` (block names; `to` excluded, "" for the end). */
export interface SheetSlice {
  sheetId: string;
  after: string;
  from: string;
  to: string;
}

/**
 * What `subscribe()` / `openDocument()` return: the structure plus about one page of cells.
 * Without `packed` the cells come as `cells`; with it as `packed` plus `slices` of what is left.
 * `cursors` maps each sheet that did not fit to where it continues.
 */
export interface OpenedDocument extends Structure {
  revision: number;
  lastModified: number;
  cells?: Record<string, CellMap>;
  packed?: Record<string, FullPackedCells>;
  slices?: SheetSlice[];
  cursors: Record<string, string>;
}

/** One page of a sheet's cells (`getCellsPage`), packed or as a map; `next` is where the following page continues. */
export interface CellsPage {
  revision: number;
  sheetId: string;
  cells?: CellMap;
  packed?: FullPackedCells;
  next: string | null;
  /** Set when the sheet no longer exists. */
  missing?: true;
}

/** One page of cells for an export: packed without versions; `revision` is -1 when an edit landed mid-read. */
export interface ExportPage extends PackedCells {
  revision: number;
  next: string | null;
  missing?: true;
}

/** The workbook structure as a client sends it: last-writer-wins, applied wholesale; anything omitted keeps its stored value. */
export interface StructureUpdate {
  title?: string;
  sheetOrder?: string[];
  sheets?: Record<string, Partial<SheetMeta>>;
  /** The revision the snapshot was built on: a sheet created after it is kept rather than deleted. */
  revision?: number;
}

/** One cell edit: the new content and the version it was based on (0 for a new cell); `value` and `fmt` both `null` deletes the cell. */
export interface CellOp {
  sheetId: string;
  ref: string;
  value: string | null;
  fmt: CellFmt | null;
  baseVersion: number;
}

/** A whole-sheet cell replacement (sort, insert/delete and other operations that move many cells at once), inline or staged with `stageCells`. */
export type SheetReplacement =
  | { sheetId: string; cells: CellMap; uploadId?: undefined }
  | { sheetId: string; uploadId: string; count: number; cells?: undefined };

/** What a client sends to `applyOperation`: any combination of a structure snapshot, sheet replacements and per-cell edits. */
export interface Operation {
  senderId?: string;
  structure?: StructureUpdate | null;
  cellOps?: CellOp[];
  sheetReplacements?: SheetReplacement[];
  /** The revision a structure or replacement was built on; the whole operation is refused if the document moved on. */
  baseRevision?: number;
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
 * structure after it (only when the operation changed it), the per-cell diffs, and for each
 * replaced sheet its new cells (`null`: too many to send; reload that sheet in pages).
 */
export interface OperationEvent {
  type: "operation";
  senderId: string | undefined;
  revision: number;
  structure?: Structure;
  upserts: CellUpsert[];
  deletes: CellDeletion[];
  replacedSheets?: string[];
  replacedCells?: Record<string, CellMap | null>;
  agentHint?: AgentHint;
  lastModified: number;
}

/** What the server delivers to a subscriber's `operation` callback. */
export type SubscriberEvent = OperationEvent;

/** The first thing a client reads in a reply. `upload-missing`: a staged replacement was lost, nothing was applied. */
export type OperationStatus = "applied" | "conflict" | "unchanged" | "upload-missing";

/** What `applyOperation` returns: the status and rejected cells, plus the committed event's fields when anything changed. */
export interface OperationResult extends Partial<Omit<OperationEvent, "replacedCells">> {
  status: OperationStatus;
  revision: number;
  conflicts: CellConflict[];
  /** Set when `baseRevision` was stale and nothing was applied. */
  staleRevision?: true;
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

/** What a client says about itself when it subscribes; `packed` asks for packed pages. */
export interface SubscribeOptions extends Partial<CollaboratorInfo> {
  packed?: boolean;
}

/**
 * The client's view of the Durable Object's RPC surface: every method it calls on the `gadget`
 * stub (over RPC every call resolves to a promise).
 */
export interface GadgetStub {
  subscribe(callback: SubscriberCallbacks, client?: SubscribeOptions): Promise<OpenedDocument>;
  openDocument(options?: { packed?: boolean }): Promise<OpenedDocument>;
  getCellsPage(options: { sheetId: string; after?: string; from?: string; to?: string; packed?: boolean }): Promise<CellsPage>;
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
