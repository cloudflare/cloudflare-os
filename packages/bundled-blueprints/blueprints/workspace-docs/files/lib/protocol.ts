// The contract between this gadget's two sides: what the Durable Object stores and broadcasts, what
// the browser sends it, and the RPC surface each sees of the other. Type-only -- both entries import
// it with `import type`, so nothing here reaches the bundled client.js or server.js.
//
// The sync library's vocabulary (a collaborator, an operation's status) is exported from both of
// its entries; it is taken from the server's here because `OperationStatus` is only there.
import type { Collaborator, OperationStatus } from "@gadgets/bundled-blueprints/libraries/sync/server";

/** A top-level block's identity and content, as the client serializes it from the DOM. */
export interface BlockContent {
  /** The stable `data-block-id`, minted by the client. */
  id: string;
  /** The block's outer HTML, `data-block-id` included. */
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
 * HTML snapshot under the legacy `content`/`title`/`lastModified` keys, with `blocks: null`. The
 * first v2 client converts it and calls `initializeBlocks`.
 */
export interface LegacyDocument {
  revision: 0;
  title: string;
  blocks: null;
  legacyContent: string;
  lastModified: number | null;
}

/** What `getDocument` and `subscribe` return: the stored document, or the legacy one before conversion. */
export type DocumentSnapshot = StoredDocument | LegacyDocument;

/** The arguments of `initializeBlocks` and `setDocument`: a whole document as unversioned blocks. */
export interface DocumentInit {
  blocks: BlockContent[];
  title: string;
  /** The client's id, so it can tell the resulting snapshot event from a remote one. */
  senderId: string;
}

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
  senderId: string;
  revision: number;
  title: string;
  upserts: StoredBlock[];
  deletedIds: string[];
  order: string[];
  lastModified: number;
}

/** A broadcast whole document, after `initializeBlocks` or `setDocument`. */
export interface SnapshotEvent {
  type: "snapshot";
  senderId: string;
  document: StoredDocument;
}

/** What the server delivers to a subscriber's `operation` callback. */
export type DocumentEvent = OperationEvent | SnapshotEvent;

/**
 * What `applyOperation` returns: the status, the revision, and the authoritative blocks whose
 * edits were rejected as stale, for the client to rebase onto. When the operation changed the
 * document the fields of the broadcast {@link OperationEvent} are included too.
 */
export type ApplyOperationResult = Partial<OperationEvent> & {
  status: OperationStatus;
  revision: number;
  conflicts: StoredBlock[];
};

/** Where a collaborator's selection sits: its anchor and focus, each a block id and a text offset within that block. */
export interface DocCursor {
  anchorBlockId: string | null;
  anchorOffset: number;
  focusBlockId: string | null;
  focusOffset: number;
}

/** What a client sends to `updatePresence`: who it is and where its selection is. */
export type PresenceUpdate = Collaborator & DocCursor;

/**
 * A presence event as this gadget's server broadcasts it. A join carries a `blockId` of `null`
 * (this gadget's vocabulary for "here, but with no position yet") and a leave sent by the client's
 * own `leavePresence` is stamped `at`; the client's roster reads neither.
 */
export type DocPresenceEvent =
  | ({ type: "join"; blockId: null } & Collaborator)
  | ({ type: "cursor"; at: number } & Collaborator & DocCursor)
  | { type: "leave"; clientId: string; at?: number };

/** The callbacks the client's `RpcTarget` implements and the server calls. */
export interface SubscriberCallbacks {
  operation(event: DocumentEvent): void | Promise<void>;
  presence(event: DocPresenceEvent): void | Promise<void>;
}

/** The linked Google Doc's metadata, as the `GOOGLE_DOC` binding reports it. */
export interface GoogleDocMetadata {
  title: string;
  lastModified: Date;
}

/** What `getGoogleDocInfo` returns when a Google Doc is linked. */
export interface GoogleDocInfo {
  title: string;
  lastModified: Date;
}

/** What `syncToGoogleDoc` returns: whether the Doc was rewritten, and its metadata when it was. */
export type GoogleDocSyncResult =
  | { status: "unchanged" }
  | { status: "synced"; metadata: GoogleDocMetadata };

/**
 * The client's view of the server's `Gadget` class over RPC: every public method, returning a
 * promise. The first group is the API a client or an agent calls; the second is the internals the
 * RPC layer exposes as well, listed so the stub matches the class.
 */
export interface GadgetStub {
  getDocument(): Promise<DocumentSnapshot>;
  initializeBlocks(args: DocumentInit): Promise<StoredDocument>;
  setDocument(args: DocumentInit): Promise<StoredDocument>;
  applyOperation(operation: Operation): Promise<ApplyOperationResult>;
  subscribe(callback: SubscriberCallbacks, client?: Partial<Collaborator>): Promise<DocumentSnapshot>;
  updatePresence(presence: PresenceUpdate): Promise<void>;
  leavePresence(clientId: string): Promise<void>;
  getGoogleDocInfo(): Promise<GoogleDocInfo | null>;
  syncToGoogleDoc(args: { markdown: string }): Promise<GoogleDocSyncResult>;

  loadDocument(): Promise<DocumentSnapshot>;
  initializeBlocksLocked(args: DocumentInit): Promise<StoredDocument>;
  setDocumentLocked(args: DocumentInit): Promise<StoredDocument>;
  applyOperationLocked(operation: Operation): Promise<ApplyOperationResult>;
  broadcast(event: DocumentEvent): void;
  broadcastPresence(event: DocPresenceEvent): void;
}
