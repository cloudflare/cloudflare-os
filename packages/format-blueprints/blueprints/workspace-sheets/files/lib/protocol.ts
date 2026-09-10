// ---------------------------------------------------------------------------
// The contract between the Sheets client and its Durable Object: what is stored,
// what an operation carries, what comes back, and what the server calls the
// client with. Types only; both entries import it with `import type`.
// ---------------------------------------------------------------------------

/**
 * A cell's formatting. Every key is optional and absent when off: `b`, `i`, `u`, `s` and `wrap`
 * are flags; `c`/`bg` are hex colours; `a` is the horizontal alignment; `nf` a number-format name
 * (`number`, `integer`, `currency`, `percent`, `scientific`, `date`, `time`, `datetime`, `text`);
 * `d` the decimal places; `fs` the font size in CSS pixels.
 */
export interface CellFmt {
  b?: boolean;
  i?: boolean;
  u?: boolean;
  s?: boolean;
  wrap?: boolean;
  c?: string;
  bg?: string;
  a?: "l" | "c" | "r";
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

/** A sheet's structure: identity, name, size and sizing metadata. */
export interface SheetMeta {
  id: string;
  name: string;
  rows: number;
  cols: number;
  colWidths: Dims;
  rowHeights: Dims;
  frozenRows: number;
  frozenCols: number;
}

/** The `meta` record the server stores: everything about the workbook except the cells. */
export interface DocumentMeta {
  revision: number;
  title: string;
  sheetOrder: string[];
  sheets: Record<string, SheetMeta>;
  lastModified: number;
}

/** A complete workbook snapshot, as `getDocument()` and `subscribe()` return it: the meta plus every sheet's cells by sheet id. */
export interface SheetsDocument extends DocumentMeta {
  cells: Record<string, CellMap>;
}

/** The workbook structure as a client sends it: last-writer-wins, applied wholesale; anything omitted keeps its stored value. */
export interface StructureUpdate {
  title?: string;
  sheetOrder?: string[];
  sheets?: Record<string, Partial<SheetMeta>>;
}

/** The workbook structure as the server repeats it after an operation. */
export interface Structure {
  title: string;
  sheetOrder: string[];
  sheets: Record<string, SheetMeta>;
}

/** One cell edit: the new content and the version it was based on (0 for a new cell); `value` and `fmt` both `null` deletes the cell. */
export interface CellOp {
  sheetId: string;
  ref: string;
  value: string | null;
  fmt: CellFmt | null;
  baseVersion: number;
}

/** A whole-sheet cell replacement, used for sort, insert/delete and other operations that move many cells at once. */
export interface SheetReplacement {
  sheetId: string;
  cells: CellMap;
}

/** What a client sends to `applyOperation`: any combination of a structure snapshot, sheet replacements and per-cell edits. */
export interface Operation {
  senderId?: string;
  structure?: StructureUpdate | null;
  cellOps?: CellOp[];
  sheetReplacements?: SheetReplacement[];
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

/** The first thing a client reads in a reply: `applied` if anything changed, `conflict` if anything was rejected, else `unchanged`. */
export type OperationStatus = "applied" | "conflict" | "unchanged";

/**
 * A committed operation as the server broadcasts it to every subscriber: the new revision, the
 * structure after it, the per-cell diffs, and for each replaced sheet its full new cell map.
 */
export interface OperationEvent {
  type: "operation";
  senderId: string | undefined;
  revision: number;
  structure: Structure;
  upserts: CellUpsert[];
  deletes: CellDeletion[];
  replacedSheets: string[];
  replacedCells?: Record<string, CellMap>;
  lastModified: number;
}

/** A full snapshot delivered over the `operation` callback; the client accepts it though the current server never sends one. */
export interface SnapshotEvent {
  type: "snapshot";
  document: SheetsDocument;
}

/** What the server delivers to a subscriber's `operation` callback. */
export type SubscriberEvent = OperationEvent | SnapshotEvent;

/** What `applyOperation` returns: the status and rejected cells, plus the committed event's fields when anything changed. */
export interface OperationResult extends Partial<OperationEvent> {
  status: OperationStatus;
  revision: number;
  conflicts: CellConflict[];
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

/**
 * The client's view of the Durable Object's RPC surface: every method it calls on the `gadget`
 * stub. A view rather than the class's own signature (`Gadget` does not `implements` it): the
 * server's `updatePresence` and `leavePresence` return synchronously, since their broadcasts run
 * outside the mutation queue and are not awaited, while over RPC every call resolves to a promise.
 */
export interface GadgetStub {
  getDocument(): Promise<SheetsDocument>;
  applyOperation(operation: Operation): Promise<OperationResult>;
  subscribe(callback: SubscriberCallbacks, client?: CollaboratorInfo): Promise<SheetsDocument>;
  updatePresence(presence: PresenceUpdate): Promise<void>;
  leavePresence(clientId: string): Promise<void>;
}
