// What a SharePoint binding covers, and the proofs that an object is inside it. A binding is one of
// seven scopes, each held by stable IDs baked into the facet's props when the resource was granted;
// a rename or move can therefore neither break a binding nor widen it. Every object an operation
// touches, and every row a listing or search returns, passes through `ScopeGuard` first.
//
// The agent never sees Graph's raw IDs. It sees opaque references (`ItemRef`, `ListRef`, `PageRef`)
// that carry the container as well as the object, because a Graph item ID is only addressable
// within its drive, and a list or page only within its site.

import { isProvisional, OutsideBindingError } from "./binding";
import { GraphApiError } from "./graph-api";
import { GUID, canonicalSiteId, splitSiteId, type GraphDrive, type GraphDriveItem } from "./graph-parse";

/** What one binding covers. Site IDs are Graph's composite `host,siteCollectionId,webId`. */
export type SharePointScope =
  | { kind: "all" }
  | { kind: "site"; siteId: string }
  | { kind: "library"; siteId: string; driveId: string }
  | { kind: "folder"; siteId: string; driveId: string; itemId: string }
  | { kind: "file"; siteId: string; driveId: string; itemId: string }
  | { kind: "list"; siteId: string; listId: string }
  | { kind: "page"; siteId: string; pageId: string };

/** A scope's kind. */
export type ScopeKind = SharePointScope["kind"];

/**
 * Refuses props whose scope this version does not know, rather than letting an unrecognized kind
 * fall through every narrow check and be served as everything.
 */
export function requireScope(scope: SharePointScope): SharePointScope {
  switch (scope.kind) {
    case "all":
    case "site":
    case "library":
    case "folder":
    case "file":
    case "list":
    case "page":
      return scope;
  }
  throw new Error("This SharePoint connection was made by a newer version of the gatekeeper. Remove it " +
    "and connect it again.");
}

/**
 * The one refusal for anything outside the binding, malformed, or missing. One wording for all of
 * them: a message that named the kind of object, or told a malformed ID from a real one elsewhere,
 * would let a probe map what the owner can open beyond the binding.
 */
export class OutsideScopeError extends OutsideBindingError {
  constructor() {
    super("SharePoint", "That");
  }
}

// -- references --------------------------------------------------------------------------------

/** A file or folder: the drive it lives in and its ID there. */
export type ItemRef = { driveId: string; itemId: string };
/** A list in a site. */
export type ListRef = { siteId: string; listId: string };
/** A page in a site. */
export type PageRef = { siteId: string; pageId: string };

// Graph drive IDs are `b!` plus base64url; item IDs are upper-case base32ish. Neither contains `/`,
// so a slash separates them unambiguously. A provisional item (created by an action still awaiting
// approval) is `~N`.
const DRIVE_ID = /^b![A-Za-z0-9_-]{20,200}$/;
const ITEM_ID = /^[A-Za-z0-9!_-]{1,200}$/;

/** The opaque reference an agent sees for an item. */
export function encodeItemRef(ref: ItemRef): string {
  return isProvisional(ref.itemId) ? ref.itemId : `${ref.driveId}/${ref.itemId}`;
}

/**
 * Parses an item reference. A provisional `~N` comes back with no drive: the overlay resolves it.
 * @throws OutsideScopeError for anything malformed.
 */
export function decodeItemRef(id: string): ItemRef | { provisional: string } {
  if (typeof id !== "string") throw new OutsideScopeError();
  const trimmed = id.trim();
  if (isProvisional(trimmed)) return { provisional: trimmed };
  const slash = trimmed.indexOf("/");
  const driveId = trimmed.slice(0, slash);
  const itemId = trimmed.slice(slash + 1);
  if (slash < 0 || !DRIVE_ID.test(driveId) || !ITEM_ID.test(itemId)) {
    throw new OutsideScopeError();
  }
  return { driveId, itemId };
}

/** The opaque reference an agent sees for a list. */
export function encodeListRef(ref: ListRef): string {
  return `${ref.siteId}/${ref.listId}`;
}

/** Parses a list reference. */
export function decodeListRef(id: string): ListRef {
  const parts = typeof id === "string" ? id.trim().split("/") : [];
  const siteId = parts.length === 2 ? canonicalSiteId(parts[0]) : null;
  if (siteId === null || !GUID.test(parts[1])) throw new OutsideScopeError();
  return { siteId, listId: parts[1].toLowerCase() };
}

/** The opaque reference an agent sees for a page. */
export function encodePageRef(ref: PageRef): string {
  return `${ref.siteId}/${ref.pageId}`;
}

/** Parses a page reference. */
export function decodePageRef(id: string): PageRef {
  const parts = typeof id === "string" ? id.trim().split("/") : [];
  const siteId = parts.length === 2 ? canonicalSiteId(parts[0]) : null;
  if (siteId === null || !GUID.test(parts[1])) throw new OutsideScopeError();
  return { siteId, pageId: parts[1].toLowerCase() };
}

/** Parses a site ID an agent passed. */
export function decodeSiteId(id: string): string {
  const siteId = typeof id === "string" ? canonicalSiteId(id.trim()) : null;
  if (siteId === null) throw new OutsideScopeError();
  return siteId;
}

// -- the guard ---------------------------------------------------------------------------------

/** The Graph reads the guard needs, as the connection makes them. */
export type ScopeLookups = {
  /** The item, or null when it does not exist or the user cannot see it. */
  item(ref: ItemRef): Promise<GraphDriveItem | null>;
  /** The drive, or null likewise. */
  drive(driveId: string): Promise<GraphDrive | null>;
};

/** How deep an ancestry walk goes before giving up. SharePoint's URL length limit caps real depth well below. */
const MAX_DEPTH = 64;
/** How long a proven ancestry is trusted within one guard: long enough for a listing, short enough for a move. */
const PROOF_TTL_MS = 60_000;

const FILE_SCOPES = new Set<ScopeKind>(["all", "site", "library", "folder", "file"]);
const LIST_SCOPES = new Set<ScopeKind>(["all", "site", "list"]);
const PAGE_SCOPES = new Set<ScopeKind>(["all", "site", "page"]);

/** Whether an item's `sharepointIds` place it in `siteId`. */
function inSite(item: { siteCollectionId?: string; webId?: string }, siteId: string): boolean {
  const site = splitSiteId(siteId);
  return site !== null && item.siteCollectionId === site.siteCollectionId && item.webId === site.webId;
}

/**
 * Decides whether objects are inside one binding's scope. Checks are by ID, never by name or path,
 * and every refusal is the same `OutsideScopeError`, so the guard is not an oracle for what exists
 * elsewhere.
 */
export class ScopeGuard {
  readonly scope: SharePointScope;
  readonly #lookups: ScopeLookups;
  /** Folder items proven to be the bound folder or inside it, and when. */
  readonly #insideFolder = new Map<string, number>();
  /** Folder items proven to reach the drive's root without passing the bound folder, and when. */
  readonly #outsideFolder = new Map<string, number>();

  constructor(scope: SharePointScope, lookups: ScopeLookups) {
    this.scope = requireScope(scope);
    this.#lookups = lookups;
  }

  /** Whether the binding can reach files at all. */
  get coversFiles(): boolean {
    return FILE_SCOPES.has(this.scope.kind);
  }

  /** Whether the binding can reach lists. */
  get coversLists(): boolean {
    return LIST_SCOPES.has(this.scope.kind);
  }

  /** Whether the binding can reach pages. */
  get coversPages(): boolean {
    return PAGE_SCOPES.has(this.scope.kind);
  }

  /** Whether the binding can discover sites. */
  get coversSites(): boolean {
    return this.scope.kind === "all" || this.scope.kind === "site";
  }

  /**
   * Whether a site is reachable. A site binding reaches only itself; subsites have their own
   * permissions and are bound separately.
   */
  site(siteId: string): void {
    const scope = this.scope;
    if (scope.kind === "all") return;
    if (scope.kind === "site" && scope.siteId === siteId) return;
    throw new OutsideScopeError();
  }

  /** Whether a drive (library or OneDrive) is reachable as a whole. */
  async drive(driveId: string): Promise<GraphDrive> {
    const scope = this.scope;
    if (scope.kind === "library" && scope.driveId !== driveId) throw new OutsideScopeError();
    if (scope.kind !== "all" && scope.kind !== "site" && scope.kind !== "library") throw new OutsideScopeError();
    const drive = await this.#lookups.drive(driveId);
    if (drive === null || drive.id !== driveId) throw new OutsideScopeError();
    if (scope.kind === "site" && !inSite(drive, scope.siteId)) throw new OutsideScopeError();
    return drive;
  }

  /** Whether a list is reachable. */
  list(ref: ListRef): void {
    const scope = this.scope;
    if (scope.kind === "all") return;
    if (scope.kind === "site" && scope.siteId === ref.siteId) return;
    if (scope.kind === "list" && scope.siteId === ref.siteId && scope.listId === ref.listId) return;
    throw new OutsideScopeError();
  }

  /** Whether a page is reachable. */
  page(ref: PageRef): void {
    const scope = this.scope;
    if (scope.kind === "all") return;
    if (scope.kind === "site" && scope.siteId === ref.siteId) return;
    if (scope.kind === "page" && scope.siteId === ref.siteId && scope.pageId === ref.pageId) return;
    throw new OutsideScopeError();
  }

  /**
   * Loads an item and proves it is inside the binding.
   * @returns The item as the connection sees it now.
   * @throws OutsideScopeError when it is outside, or missing, or hidden from the user.
   */
  async item(ref: ItemRef): Promise<GraphDriveItem> {
    const scope = this.scope;
    // Cheap refusals first, before Graph is asked anything.
    if (!this.coversFiles) throw new OutsideScopeError();
    if ((scope.kind === "library" || scope.kind === "folder" || scope.kind === "file") && ref.driveId !== scope.driveId) {
      throw new OutsideScopeError();
    }
    if (scope.kind === "file" && ref.itemId !== scope.itemId) throw new OutsideScopeError();
    const item = await this.#load(ref);
    if (item.driveId !== ref.driveId || item.id !== ref.itemId) throw new OutsideScopeError();
    switch (scope.kind) {
      case "all":
      case "library":
      case "file":
        return item;
      case "site":
        if (!inSite(item, scope.siteId)) throw new OutsideScopeError();
        return item;
      case "folder":
        await this.#proveInFolder(item, scope.itemId);
        return item;
      default:
        throw new OutsideScopeError();
    }
  }

  /**
   * Whether an item, already read, belongs to the binding, given that it was listed as a child of
   * `parent`, a folder this guard has proven. A listing never needs an ancestry walk per row.
   */
  childOf(item: GraphDriveItem, parent: ItemRef): boolean {
    if (item.driveId !== parent.driveId || item.parentId !== parent.itemId) return false;
    const scope = this.scope;
    if (scope.kind === "file") return false;
    if (scope.kind === "site") return inSite(item, scope.siteId);
    if (scope.kind === "folder" && item.kind === "folder") {
      // Proven as of its parent's proof, which it rests on: the bound folder's holds by definition.
      const provenAt = parent.itemId === scope.itemId ? Date.now() : this.#insideFolder.get(parent.itemId);
      if (provenAt !== undefined) this.#insideFolder.set(item.id, provenAt);
    }
    return true;
  }

  /**
   * Whether an item from a search or a cross-drive read is inside the binding, without asking
   * Graph again for scopes that need no ancestry. A folder scope walks the ancestry.
   */
  async contains(item: GraphDriveItem): Promise<boolean> {
    const scope = this.scope;
    switch (scope.kind) {
      case "all": return true;
      case "site": return inSite(item, scope.siteId);
      case "library": return item.driveId === scope.driveId;
      case "file": return item.driveId === scope.driveId && item.id === scope.itemId;
      case "folder":
        if (item.driveId !== scope.driveId) return false;
        try {
          await this.#proveInFolder(item, scope.itemId);
          return true;
        } catch (error) {
          if (error instanceof OutsideScopeError) return false;
          throw error;
        }
      default: return false;
    }
  }

  /** The folder a listing opens when none is named: the bound folder, or the library's root. */
  defaultFolder(): ItemRef | null {
    const scope = this.scope;
    if (scope.kind === "folder") return { driveId: scope.driveId, itemId: scope.itemId };
    if (scope.kind === "library") return { driveId: scope.driveId, itemId: "root" };
    return null;
  }

  async #load(ref: ItemRef): Promise<GraphDriveItem> {
    let item: GraphDriveItem | null;
    try {
      item = await this.#lookups.item(ref);
    } catch (error) {
      // A malformed ID Graph rejects as a bad request is, to the caller, just not there.
      if (error instanceof GraphApiError && error.status === 400) throw new OutsideScopeError();
      throw error;
    }
    if (item === null) throw new OutsideScopeError();
    return item;
  }

  /**
   * Walks `item`'s parents until the bound folder, the drive's root, or the depth limit. A sharee
   * who can open only the bound folder cannot read above it, so the walk stops there and never
   * needs to. Either verdict is remembered for every folder on the way, so a search page full of
   * hits from one outside subtree costs that subtree's depth in reads, not the page's. A walk that
   * ends at a remembered folder rests on that folder's proof and is dated by it, so reuse never
   * renews a proof: every one lapses within the TTL of the read it came from.
   */
  async #proveInFolder(item: GraphDriveItem, folderId: string): Promise<void> {
    const now = Date.now();
    const fresh = (provenAt: number | undefined): provenAt is number => provenAt !== undefined && now - provenAt < PROOF_TTL_MS;
    type Verdict = { verdict: Map<string, number>; at: number };
    const verdictOf = (id: string): Verdict | undefined => {
      if (id === folderId) return { verdict: this.#insideFolder, at: now };
      const inside = this.#insideFolder.get(id);
      if (fresh(inside)) return { verdict: this.#insideFolder, at: inside };
      const outside = this.#outsideFolder.get(id);
      if (fresh(outside)) return { verdict: this.#outsideFolder, at: outside };
      return undefined;
    };
    // Ends the walk: every folder on it takes the verdict, and an outside one is refused.
    const trail: string[] = [];
    const settle = ({ verdict, at }: Verdict): void => {
      for (const id of trail) verdict.set(id, at);
      if (verdict === this.#outsideFolder) throw new OutsideScopeError();
    };
    let current: GraphDriveItem = item;
    for (let depth = 0; depth <= MAX_DEPTH; depth++) {
      // Only folders are remembered: a file is never an ancestor.
      if (current.kind === "folder") trail.push(current.id);
      const verdict = verdictOf(current.id);
      if (verdict !== undefined) return settle(verdict);
      if (current.isRoot || current.parentId === undefined) return settle({ verdict: this.#outsideFolder, at: now });
      // A remembered parent spares its read: its own ancestry was settled with it.
      const known = verdictOf(current.parentId);
      if (known !== undefined) return settle(known);
      current = await this.#load({ driveId: current.driveId, itemId: current.parentId });
    }
    throw new OutsideScopeError();
  }
}

/** The display name of a scope kind, for sentences. */
export function scopeNoun(kind: ScopeKind): string {
  switch (kind) {
    case "all": return "SharePoint and OneDrive";
    case "site": return "site";
    case "library": return "library";
    case "folder": return "folder";
    case "file": return "file";
    case "list": return "list";
    case "page": return "page";
  }
}
