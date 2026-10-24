// The contract between this gadget's two sides: what the Durable Object stores and broadcasts, what
// the browser sends it, the block API an agent calls, and the RPC surface each side sees of the
// other. Type-only -- both entries import it with `import type`, so nothing here reaches the
// bundled client.js or server.js.
import type { OperationStatus } from "@gadgets/bundled-blueprints/libraries/sync/server";

/* ── Document ───────────────────────────────────────────────────────────── */

/** A top-level block's identity and content, as the client serializes it from the DOM. */
export interface BlockContent {
  /** The stable `data-block-id`, minted by the client (or `b_<uuid>` by the block API). */
  id: string;
  /** The block's outer HTML, `data-block-id` included when the editor wrote it. */
  html: string;
}

/** A block as the server stores and broadcasts it: content plus the version of that content. */
export interface StoredBlock extends BlockContent {
  version: number;
}

/** A block as a client sends it in an operation: content plus the version the draft rests on (0 for a new block). */
export interface BlockUpsert extends BlockContent {
  baseVersion: number;
}

/** A version-checked deletion: the block goes only if it is still at the version the client saw. */
export interface BlockDeletion {
  id: string;
  baseVersion: number;
}

/** The document as stored under `document:v2`: ordered, versioned blocks under a global revision. */
export interface StoredDocument {
  revision: number;
  title: string;
  blocks: StoredBlock[];
  /** Epoch milliseconds of the last accepted change. */
  lastModified: number;
}

/**
 * What the server returns for a document that has not been converted to blocks yet: the former
 * HTML snapshot under the legacy `content`/`title`/`lastModified` keys, with `blocks: null`. It is
 * returned only when converting at startup failed: the first editor then converts it and calls
 * `initializeBlocks` (the block API converts it itself).
 */
export interface LegacyDocument {
  revision: 0;
  title: string;
  blocks: null;
  legacyContent: string;
  lastModified: number | null;
}

/** What `getDocument` returns: the stored document, or the legacy one before conversion. */
export type DocumentSnapshot = StoredDocument | LegacyDocument;

/** The document-level presentation settings every collaborator shares, stored under `settings`. */
export interface DocSettings {
  font: DocFont;
  /** Full width: the page's measure widens from 700px to 980px. */
  wide: boolean;
}

/** The three typefaces a document can be set in. */
export type DocFont = "sans" | "serif" | "mono";

/** What `subscribe` returns: the document as `getDocument` would, with the shared settings. */
export type SubscribeSnapshot = DocumentSnapshot & { settings: DocSettings };

/** The arguments of `initializeBlocks` and `setDocument`: a whole document as unversioned blocks. */
export interface DocumentInit {
  blocks: BlockContent[];
  title: string;
  /** The client's id, so it can tell the resulting snapshot event from a remote one. */
  senderId: string;
}

/** A change to the settings, as `setSettings` receives it: any of the fields, and the sender's id. */
export type SettingsPatch = Partial<DocSettings> & { senderId?: string };

/* ── Operations and events ──────────────────────────────────────────────── */

/** One client's batch of block changes, as `applyOperation` receives it. */
export interface Operation {
  senderId: string;
  /** The revision the client last saw. Carried for diagnostics; blocks are checked by version, not by revision. */
  baseRevision?: number;
  upserts?: BlockUpsert[];
  deletes?: BlockDeletion[];
  /** The full block order the client wants; ordering is last-writer-wins. */
  order?: string[];
  title?: string;
}

/** A broadcast accepted operation: only the blocks that changed, the ids that went, and the new order. */
export interface OperationEvent {
  type: "operation";
  /** The client that made the change, or `"agent"` for the block API. */
  senderId: string;
  revision: number;
  title: string;
  upserts: StoredBlock[];
  deletedIds: string[];
  order: string[];
  lastModified: number;
}

/** A broadcast whole document, after `initializeBlocks`, `setDocument` or a block-API conversion. */
export interface SnapshotEvent {
  type: "snapshot";
  senderId: string;
  document: StoredDocument;
}

/** Broadcast shared settings, after `setSettings`. */
export interface SettingsEvent {
  type: "settings";
  /** Whatever id the patch carried, so its sender can skip its own change. */
  senderId: string | undefined;
  settings: DocSettings;
}

/** What the server delivers to a subscriber's `operation` callback. */
export type DocumentEvent = OperationEvent | SnapshotEvent | SettingsEvent;

/**
 * A rejected upsert of a block the server no longer has: the client forgets its stale version and
 * re-creates the block rather than retrying forever.
 */
export interface MissingBlock {
  id: string;
  html: null;
  version: 0;
  missing: true;
}

/**
 * What `applyOperation` returns: the status, the revision, and the authoritative blocks whose
 * edits were rejected, for the client to rebase onto. When the operation changed the document the
 * fields of the broadcast {@link OperationEvent} are included too.
 */
export type ApplyOperationResult = Partial<OperationEvent> & {
  status: OperationStatus;
  revision: number;
  conflicts: (StoredBlock | MissingBlock)[];
};

/** The callbacks the client's `RpcTarget` implements and the server calls. */
export interface SubscriberCallbacks {
  operation(event: DocumentEvent): void | Promise<void>;
  /** Unused (the document has no presence); kept so an older server that still sends it can't break. */
  presence(event?: unknown): void | Promise<void>;
}

/* ── Block API (agents and scripts) ─────────────────────────────────────── */
//
// An agent's arguments arrive unchecked, so every field it passes is `unknown` and is read the way
// the server reads it: strings and numbers are coerced, specs are interpreted by `specHtml`.

/** Where `insertBlocks` / `moveBlocks` put blocks: after or before a block, at an index, or (none) at the end. */
export interface BlockPosition {
  afterId?: unknown;
  beforeId?: unknown;
  /** 0-based; negative counts from the end (-1 is the end). */
  index?: unknown;
}

/** Content for the block API: specs (`{ type, text | items | rows | src | html | code }`), and/or Markdown. */
export interface BlockSource {
  blocks?: unknown;
  markdown?: unknown;
}

/** One block as `listBlocks` / `getBlocks` describe it. */
export interface BlockDescription {
  id: string;
  /** p, h1, h2, h3, quote, code, divider, ul, ol, todo, image, table (or another tag's name). */
  type: string;
  markdown: string;
  version: number;
  /** The stored HTML; `getBlocks` only. */
  html?: string;
}

/** What every block-API edit returns: whether it changed anything, the new revision, and the ids it touched. */
export interface BlockEditResult {
  status: "applied" | "unchanged";
  revision: number;
  ids: string[];
}

/** The arguments of `updateBlock`: the block, and spec fields or Markdown for its new content. */
export interface UpdateBlockArgs {
  id?: unknown;
  type?: unknown;
  markdown?: unknown;
  [field: string]: unknown;
}

/**
 * The client's view of the server's `Gadget` class over RPC: every public method, returning a
 * promise. The first group is what the editor calls; the second is the block API for agents.
 */
export interface GadgetStub {
  getDocument(): Promise<DocumentSnapshot>;
  initializeBlocks(args: DocumentInit): Promise<StoredDocument>;
  setDocument(args: DocumentInit): Promise<StoredDocument>;
  applyOperation(operation: Operation): Promise<ApplyOperationResult>;
  subscribe(callback: SubscriberCallbacks): Promise<SubscribeSnapshot>;
  updatePresence(): Promise<void>;
  leavePresence(): Promise<void>;
  getSettings(): Promise<DocSettings>;
  setSettings(patch: SettingsPatch): Promise<DocSettings>;

  listBlocks(): Promise<{ revision: number; blocks: BlockDescription[] }>;
  getBlocks(args?: { ids?: unknown }): Promise<BlockDescription[]>;
  insertBlocks(args?: BlockSource & BlockPosition): Promise<BlockEditResult>;
  updateBlock(args?: UpdateBlockArgs): Promise<BlockEditResult>;
  setChecked(args?: { id?: unknown; item?: unknown; checked?: unknown }): Promise<BlockEditResult>;
  deleteBlocks(args?: { ids?: unknown }): Promise<BlockEditResult>;
  moveBlocks(args?: { ids?: unknown } & BlockPosition): Promise<BlockEditResult>;
  setMarkdown(args?: BlockSource & { title?: unknown; replace?: unknown }): Promise<BlockEditResult>;
  getMarkdown(): Promise<string>;
}
