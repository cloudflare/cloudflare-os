// The capabilities gadgets hold: one session type for every scope, plus a handle per list. Every
// operation follows the same order: prove the objects it touches are inside the binding
// (sharepoint-scope.ts), read them, apply the changes awaiting approval (sharepoint-overlay.ts),
// authorize the observation with the access units it revealed (sharepoint-observers.ts), and only
// then return. Writes are checked as reads are, then staged for approval (sharepoint-actions.ts).
//
// `SharePointReaderImpl` is what a read-only deployment hands out; `SharePointSessionImpl` adds the
// write methods. Being separate classes, a read-only session has no write methods to call at all,
// whatever the agent tries over RPC.

import { RpcTarget, type RpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { ActionFileReference } from "@gadgets/gatekeeper-kit/action-files";
import type { ActionSubmitter, JournalEntry } from "@gadgets/gatekeeper-kit/actions";
import { ArrayCursor, TokenCursor } from "@gadgets/gatekeeper-kit/cursors";
import { ObservationGate, escapeObservationValue, type ObserverStrategy } from "@gadgets/gatekeeper-kit/observers";
import type { ApprovalQueue, Cursor } from "@gadgets/workshop-shared/gatekeeper";
import { isProvisional } from "./binding";
import { convertToText } from "./content/index";
import { GraphApiError, type GraphApi } from "./graph-api";
import { parseCanvas, splitSiteId, type GraphColumn, type GraphDrive, type GraphDriveItem, type GraphList, type GraphListItem, type GraphSite, type GraphSitePage } from "./graph-parse";
import type { StoredIdentity } from "./microsoft-credentials";
import type { SharePointAccess, SharePointSites } from "./microsoft-env";
import { editDocx } from "./content/docx-edit";
import { editPptx } from "./content/pptx-edit";
import { MAX_CELL_CHARS, checkFormula } from "./content/xlsx-write";
import {
  SLIDE_IMAGE_TYPES, checkTemplate, encodeContent, featuresLost, isOfficeName, presentationStructure, slideImageRefs, writtenAs,
  type Encoded, type PptxImages, type Template,
} from "./office-write";
import {
  cellAt, pathSegment, showableText, shownChanges, shownTexts, type EditChange, type FolderTarget, type ItemTarget, type ListTarget,
  type SharePointAction, type SharePointActions,
} from "./sharepoint-actions";
import {
  DEFAULT_MAX_CELLS, DEFAULT_MAX_CHARS, MAX_MAX_CELLS, MAX_MAX_CHARS, MAX_READ_BYTES, MAX_UPLOAD_BYTES, MIN_MAX_CHARS,
  convertFile, extensionOf, isWorkbook, pageMarkdown, readWorkbookSheets, type Converted,
} from "./sharepoint-content";
import {
  ListQueryError, compileQuery, requireRequired, toColumnInfo, validateFieldValues, visibleColumns,
} from "./sharepoint-lists";
import { units } from "./sharepoint-observers";
import {
  Overlay, drivePath, itemSiteId, join, parentPath, toEntry, toLibraryInfo, toListInfo, toListItem, toPageInfo, toSiteInfo,
  type PathBase,
} from "./sharepoint-overlay";
import * as reads from "./sharepoint-reads";
import { UnresolvableUrlError, checkSharePointUrl, resolveSharePointUrl } from "./sharepoint-resolve";
import { OutsideScopeError, ScopeGuard, decodeItemRef, decodeListRef, decodePageRef, decodeSiteId, encodeItemRef, encodeListRef, encodePageRef, scopeNoun, type ItemRef, type ListRef, type PageRef, type SharePointScope } from "./sharepoint-scope";
import { allUrl } from "./sharepoint-urls";
import { checkShape, formatRange, parseRange as parseCellRange, rangeColumns, rangeRows, withPendingCells } from "./workbook-ranges";
import type {
  ColumnInfo, DriveEntry, FieldValue, FileContent, FileVersion, ItemQuery, ListInfo, ListItem, ListOptions,
  PageContent, PageInfo, PresentationContent, ReadFileOptions, ReadWorkbookOptions, ResolvedLink, SearchOptions,
  SharePointList, SharePointListReader, SharePointReader, SharePointScopeInfo, SharePointSession, SiteContents,
  SiteInfo, WorkbookContent,
  CellValue, ChangeOptions, DocumentEdit, EditDocumentOptions, PresentationEdit, WorkbookRows, WriteOptions,
} from "./types";

/** How long a site's, drive's or list's metadata is reused across operations. */
const METADATA_TTL_MS = 5 * 60 * 1000;
/** How long converted file text is reused. Keyed by the content tag, so an edit misses it. */
const TEXT_TTL_MS = 60 * 60 * 1000;
/** Converted text over this size is not cached: Durable Object values are capped. */
const MAX_CACHED_TEXT = 100_000;
/** The largest current file a replace reads to show the approver what changes and what is lost. */
const MAX_COMPARED_BYTES = 10 * 1024 * 1024;
const MAX_COMPARED_CHARS = 100_000;
/** The most edits one `editDocument` or `editPresentation` call takes. */
const MAX_EDITS = 50;
/** The most pictures one write places, and how large each may be. */
const MAX_SLIDE_IMAGES = 20;
const MAX_SLIDE_IMAGE_BYTES = 10 * 1024 * 1024;
/** The most cells one `updateCells` call sets. */
const MAX_UPDATED_CELLS = 10_000;

/** What the facet gives every session: its connection, its journal, and its storage. */
export type SessionHost = {
  scope: SharePointScope;
  access: SharePointAccess;
  /** Whether the grant reaches every site the user can open, or only those granted to the app. */
  sites: SharePointSites;
  owner(): Promise<StoredIdentity>;
  /** Runs a read as the connection, replayed once on a credential refresh. */
  read<T>(op: (api: GraphApi) => Promise<T>): Promise<T>;
  cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T>;
  pending(): JournalEntry<SharePointAction>[];
  /** A temporary ID's real one once its action applied, else the temporary ID. */
  resolve(id: string): string;
  allocate(kind: string): string;
  submit<K extends keyof SharePointActions>(queue: ActionSubmitter, kind: K, payload: SharePointActions[K]): Promise<number>;
  /**
   * Runs a write's preparation, from its checks against what is pending through its submission,
   * after every other's: a check that passed can't be overtaken by a submission it didn't see.
   */
  prepareExclusively<T>(body: () => Promise<T>): Promise<T>;
  capture(bytes: Uint8Array): Promise<ActionFileReference>;
  readCaptured(file: ActionFileReference): Promise<Uint8Array>;
  ai?: Ai;
};

/**
 * The binding's own metadata reads: its scope, its top object, and cached sites and drives. What
 * describes a binding to its owner, and what every session builds on.
 */
export class ScopeReader {
  readonly host: SessionHost;
  readonly guard: ScopeGuard;
  #root?: Promise<ScopeRoot>;

  constructor(host: SessionHost) {
    this.host = host;
    this.guard = new ScopeGuard(host.scope, {
      item: ref => host.read(api => reads.getItem(api, ref)),
      drive: driveId => this.drive(driveId),
    });
  }

  /** The binding's top object, read once. */
  root(): Promise<ScopeRoot> {
    this.#root ??= readScopeRoot(this);
    this.#root.catch(() => { this.#root = undefined; });
    return this.#root;
  }

  /** A site, through the metadata cache. */
  site(siteId: string): Promise<GraphSite | null> {
    return this.host.cached(`site:${siteId}`, METADATA_TTL_MS, () => this.host.read(api => reads.getSite(api, siteId)));
  }

  /** A drive, through the metadata cache. */
  drive(driveId: string): Promise<GraphDrive | null> {
    return this.host.cached(`drive:${driveId}`, METADATA_TTL_MS, () => this.host.read(api => reads.getDrive(api, driveId)));
  }
}

/**
 * What one capability holds besides the binding: its own approval-queue stub, and an observation
 * gate over another. Disposing the capability releases both.
 */
export class SessionContext extends ScopeReader implements Disposable {
  readonly queue: RpcStub<ApprovalQueue>;
  readonly gate: ObservationGate;
  readonly #observers: ObserverStrategy;

  constructor(host: SessionHost, queue: RpcStub<ApprovalQueue>, observers: ObserverStrategy) {
    super(host);
    this.queue = queue;
    this.#observers = observers;
    this.gate = new ObservationGate(queue.dup(), observers);
  }

  /** A context of its own for a capability this one hands out, which may outlive it. */
  fork(): SessionContext {
    return new SessionContext(this.host, this.queue.dup(), this.#observers);
  }

  [Symbol.dispose](): void {
    this.gate[Symbol.dispose]();
    this.queue[Symbol.dispose]();
  }

  /** Authorizes an observation of what a read revealed. No units means it revealed nothing shareable. */
  async observe(title: string, description: string, revealed: readonly string[]): Promise<void> {
    await this.gate.authorize({ title, description },
      revealed.length > 0 ? { kind: "collections", ids: [...new Set(revealed)] } : { kind: "baseline" });
  }
}

/** The binding's top object: its name, where it is, and where paths are measured from. */
export type ScopeRoot = {
  name: string;
  webUrl: string;
  description: string;
  /** "Engineering › Documents › Specs", for sentences. */
  location: string;
  ids: Pick<SharePointScopeInfo, "siteId" | "libraryId" | "folderId" | "fileId" | "listId" | "pageId">;
  /** For a library, folder or file binding: where entry paths start. */
  base?: PathBase;
  /** The access units of the top object, for observations that reveal nothing narrower. */
  units?: string[];
  siteUrl?: string;
};

/** Display text, escaped for an observation's Markdown. */
const md = (text: string) => escapeObservationValue(text);

/** "Engineering › Documents" for a library in a site; "OneDrive" for a personal one. */
function libraryLocation(site: GraphSite | null, drive: GraphDrive): string {
  if (site === null || site.personal) return drive.driveType === "business" ? "OneDrive" : drive.name;
  return `${site.name} › ${drive.name}`;
}

/** A path as a breadcrumb: "Specs › Deep". */
function crumbs(path: string): string {
  return path.split("/").filter(Boolean).join(" › ");
}

async function readScopeRoot(ctx: ScopeReader): Promise<ScopeRoot> {
  const scope = ctx.host.scope;
  const gone = (what: string) => new Error(`The ${what} this connection is for no longer exists, or you can no longer open it.`);
  switch (scope.kind) {
    case "all": {
      const owner = await ctx.host.owner();
      return {
        name: "SharePoint & OneDrive",
        webUrl: owner.sharePointTenant ? allUrl(owner.sharePointTenant) : "",
        description: ctx.host.sites === "selected"
          ? "Every SharePoint site your organization has added to this app that you can open, and your own OneDrive if it's included."
          : "Everything you can open in SharePoint and OneDrive.",
        location: "SharePoint & OneDrive",
        ids: {},
      };
    }
    case "site": {
      const site = await ctx.site(scope.siteId);
      if (site === null) throw gone("site");
      return {
        name: site.name, webUrl: site.webUrl, siteUrl: site.webUrl,
        description: `The ${site.name} site: its libraries, lists and pages. Not its subsites.`,
        location: site.name, ids: { siteId: site.id }, units: [units.site(site.id)],
      };
    }
    case "library": {
      const [site, drive, root] = await Promise.all([
        ctx.site(scope.siteId), ctx.drive(scope.driveId), ctx.host.read(api => reads.getRoot(api, scope.driveId)),
      ]);
      if (drive === null || root === null) throw gone("library");
      const location = libraryLocation(site, drive);
      return {
        name: drive.name, webUrl: drive.webUrl, siteUrl: site?.webUrl,
        description: `The ${location} library, and everything in it.`,
        location, ids: { siteId: scope.siteId, libraryId: drive.id, folderId: encodeItemRef({ driveId: drive.id, itemId: root.id }) },
        base: { driveId: drive.id, path: "", itemId: root.id }, units: [units.drive(drive.id)],
      };
    }
    case "folder":
    case "file": {
      const [site, drive, item] = await Promise.all([
        ctx.site(scope.siteId), ctx.drive(scope.driveId),
        ctx.host.read(api => reads.getItem(api, { driveId: scope.driveId, itemId: scope.itemId })),
      ]);
      if (item === null) throw gone(scope.kind);
      const library = drive ? libraryLocation(site, drive) : "";
      const full = drivePath(item) ?? item.name;
      const container = scope.kind === "folder" ? full : (item.parentPath ?? "");
      const location = [library, crumbs(container)].filter(Boolean).join(" › ");
      const ref = encodeItemRef({ driveId: item.driveId, itemId: item.id });
      return {
        name: item.name, webUrl: item.webUrl, siteUrl: site?.webUrl,
        description: scope.kind === "folder"
          ? `The ${item.name} folder in ${library || "its library"}, and everything in it.`
          : `The file ${item.name} in ${location || "its library"}.`,
        location,
        ids: { siteId: scope.siteId, libraryId: item.driveId, ...(scope.kind === "folder" ? { folderId: ref } : { fileId: ref }) },
        base: scope.kind === "folder"
          ? { driveId: item.driveId, path: full, itemId: item.id }
          : { driveId: item.driveId, path: item.parentPath ?? "", itemId: item.id },
        units: [units.item({ driveId: item.driveId, itemId: item.id })],
      };
    }
    case "list": {
      const [site, list] = await Promise.all([ctx.site(scope.siteId), ctx.host.read(api => reads.getList(api, scope))]);
      if (list === null) throw gone("list");
      return {
        name: list.name, webUrl: list.webUrl, siteUrl: site?.webUrl,
        description: `The ${list.name} list${site ? ` in ${site.name}` : ""}: its items and columns.`,
        location: site ? `${site.name} › ${list.name}` : list.name,
        ids: { siteId: scope.siteId, listId: encodeListRef(scope) }, units: [units.list(scope)],
      };
    }
    case "page": {
      const [site, page] = await Promise.all([ctx.site(scope.siteId), ctx.host.read(api => reads.getPage(api, scope))]);
      if (page === null) throw gone("page");
      const info = toPageInfo(page.page, scope.siteId, site?.webUrl);
      return {
        name: info.title, webUrl: info.webUrl, siteUrl: site?.webUrl,
        description: `The page "${info.title}"${site ? ` in ${site.name}` : ""}.`,
        location: site ? `${site.name} › ${info.title}` : info.title,
        // A page's title is its current version's, which a draft changes: the unit pins that version, as reading the page does.
        ids: { siteId: scope.siteId, pageId: encodePageRef(scope) }, units: units.pageRead(scope, page.page.state, page.page.version),
      };
    }
  }
}

/** A refusal for a method the binding's scope cannot use. */
function notInScope(what: string, scope: SharePointScope): Error {
  return new Error(`This connection covers one ${scopeNoun(scope.kind)}, so it can't ${what}. Call getScope() to see what it covers.`);
}

/** Clamps an optional page size. */
function pageSize(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) throw new Error(`pageSize must be a whole number from 1 to ${max}.`);
  return Math.min(value, max);
}

/** SharePoint's rules for file and folder names. */
export function checkName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "") throw new Error("A name is required.");
  if (trimmed !== name) throw new Error("A name can't start or end with a space.");
  if (name.length > 255) throw new Error("A name can be at most 255 characters.");
  // oxlint-disable-next-line no-control-regex -- SharePoint refuses control characters in names
  if (/["*:<>?/\\|\u0000-\u001f]/.test(name)) throw new Error("A name can't contain \" * : < > ? / \\ | or control characters.");
  if (name.endsWith(".")) throw new Error("A name can't end with a period.");
  if (name.startsWith("~$")) throw new Error("A name can't start with ~$, which Office reserves for lock files.");
  // Device names are reserved with any extension; the others only as whole names.
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(name.replace(/\.[^.]*$/, "")) || /^(desktop\.ini|\.lock)$/i.test(name)
    || /_vti_/i.test(name)) {
    throw new Error(`"${name}" is a name SharePoint reserves.`);
  }
  return name;
}

/** The media type a new file is uploaded with, from its extension. */
function mimeTypeFor(name: string, content: unknown): string {
  const types: Record<string, string> = {
    txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json", xml: "application/xml",
    html: "text/html", htm: "text/html", yaml: "application/yaml", yml: "application/yaml", log: "text/plain",
    pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", svg: "image/svg+xml",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    zip: "application/zip",
  };
  return types[extensionOf(name)] ?? (typeof content === "string" ? "text/plain" : "application/octet-stream");
}

/** A cell value `updateCells` may write, checked as Excel and this gatekeeper's formula policy would. */
function checkCell(value: CellValue, at: string): void {
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error(`${at}: ${value} isn't a number Excel can hold.`);
  if (typeof value !== "string") return;
  if (value.length > MAX_CELL_CHARS) throw new Error(`${at}: a cell can hold at most ${MAX_CELL_CHARS.toLocaleString("en-US")} characters.`);
  // Excel reads a string starting with "=", "+" or "-" as a formula, so each is checked as one.
  if (/^[=+-]/.test(value)) {
    try {
      checkFormula(value);
    } catch (error) {
      throw new Error(`${at}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
}

/** A writer's or editor's failure, as the agent sees it: its message, which says what to change. */
function editFailure(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(`The file couldn't be written: ${String(error)}`);
}

/** The shape of Graph's eTags and cTags: a quoted token, weak or not. */
const VERSION_TAG = /^(W\/)?"[^"\r\n]{1,200}"$/;

/**
 * The version a change is fenced on, as the agent passed it. It becomes Graph's If-Match header
 * verbatim, so only a tag is accepted: a bare `*` would match any version and quietly remove the
 * fence it asks for, and a line break would make the request itself fail at apply, forever retried.
 */
function ifUnchanged(options: { ifUnchanged?: string } | undefined): string | undefined {
  const tag = options?.ifUnchanged;
  if (tag !== undefined && !VERSION_TAG.test(tag)) throw new Error("ifUnchanged takes the eTag or cTag a read returned.");
  return tag;
}

/** `ifUnchanged` as an action's If-Match field. */
function fenceOf(options: { ifUnchanged?: string } | undefined): { ifMatch?: string } {
  const tag = ifUnchanged(options);
  return tag ? { ifMatch: tag } : {};
}

/** The temporary ID of a pending creation, if `id` is one. */
function provisional(id: string): string | undefined {
  const decoded = decodeItemRef(id);
  return "provisional" in decoded ? decoded.provisional : undefined;
}

/** Read access to what a binding covers. */
/**
 * Cap'n Web lets a stub's holder call every method on an `RpcTarget`'s prototype, `protected` or
 * not (the keyword is erased), and only `#private` or instance members are out of reach. The
 * helpers the session subclasses share are therefore instance members, which RPC never sees.
 */
@validateRpc()
export class SharePointReaderImpl extends RpcTarget implements SharePointReader {
  protected readonly ctx: SessionContext;

  constructor(ctx: SessionContext) {
    super();
    this.ctx = ctx;
  }

  [Symbol.dispose](): void {
    this.ctx[Symbol.dispose]();
  }

  /** An ID as given, or the real one a temporary ID became once its action applied. */
  protected readonly resolved = ((id?: string) => typeof id === "string" ? this.ctx.host.resolve(id) : id) as {
    (id: string): string;
    (id: string | undefined): string | undefined;
  };

  async getScope(): Promise<SharePointScopeInfo> {
    const root = await this.ctx.root();
    const guard = this.ctx.guard;
    await this.ctx.observe("Read SharePoint connection scope", `Read what this connection covers: ${md(root.description)}`,
      root.units ?? []);
    return {
      kind: this.ctx.host.scope.kind,
      name: root.name,
      webUrl: root.webUrl,
      description: root.description,
      ...root.ids,
      can: {
        sites: guard.coversSites, files: guard.coversFiles, lists: guard.coversLists, pages: guard.coversPages,
        // Pages have no write methods, whatever the deployment allows.
        write: this.ctx.host.access === "write" && this.ctx.host.scope.kind !== "page",
      },
    };
  }

  // -- sites ------------------------------------------------------------------------------------

  async listSites(options?: { query?: string }): Promise<Cursor<SiteInfo>> {
    const scope = this.ctx.host.scope;
    if (scope.kind === "site") {
      const site = await this.ctx.site(scope.siteId);
      if (site === null) throw new OutsideScopeError();
      await this.ctx.observe("Listed SharePoint sites", `Listed the site ${md(site.name)}.`, [units.site(site.id)]);
      return new ArrayCursor([toSiteInfo(site)], 1);
    }
    if (scope.kind !== "all") throw notInScope("list sites", scope);
    const query = options?.query?.trim() || undefined;
    const walk = this.ctx.gate.lease();
    const described = query ? `Searched sites for ${md(query)}` : "Listed sites";
    return new TokenCursor<SiteInfo>({
      pageSize: 50,
      remotePageSize: 50,
      dispose: () => walk[Symbol.dispose](),
      fetchPage: async (token, perPage) => {
        const from = token === undefined ? 0 : Number(token);
        // The user's own OneDrive heads the first page: it is a personal site, which site search
        // and followed sites leave out, and otherwise nothing names it.
        const [page, oneDrive] = await this.ctx.host.read(api => Promise.all([
          reads.browseSites(api, query, from, perPage, this.ctx.host.sites === "selected"),
          from === 0 ? reads.myOneDriveSite(api) : Promise.resolve(null),
        ]));
        const sites = oneDrive !== null && (query === undefined || /one\s*drive/i.test(query) || oneDrive.name.toLowerCase().includes(query.toLowerCase()))
          ? [oneDrive, ...page.sites.filter(site => site.id !== oneDrive.id)]
          : page.sites;
        // With search down, the home and followed sites are still worth returning; the agent is told.
        if (page.searchError !== undefined && sites.length === 0) throw searchFailure(page.searchError, "Site search");
        return { items: sites.map(toSiteInfo), ...(page.nextFrom !== undefined ? { nextToken: String(page.nextFrom) } : {}) };
      },
      authorizePage: (items, { terminal }) => items.length === 0
        ? walk.authorize({ title: "Listed SharePoint sites", description: `${described}${terminal ? "; there were no more" : ""}.` }, { kind: "baseline" })
        : walk.authorize({
          title: "Listed SharePoint sites",
          description: `${described}: ${items.slice(0, 20).map(site => md(site.name)).join(", ")}${items.length > 20 ? ", …" : ""}.`,
        }, { kind: "collections", ids: items.map(site => units.site(site.id)) }),
    });
  }

  async getSite(siteId?: string): Promise<SiteContents> {
    const scope = this.ctx.host.scope;
    const id = siteId === undefined ? (scope.kind === "site" ? scope.siteId : undefined) : decodeSiteId(siteId);
    if (id === undefined) {
      throw new Error(scope.kind === "all" ? "Pass a site ID; listSites() lists them." : notInScope("read sites", scope).message);
    }
    if (!this.ctx.guard.coversSites) throw notInScope("read sites", scope);
    this.ctx.guard.site(id);
    const site = await this.ctx.site(id);
    if (site === null) throw new OutsideScopeError();
    const [drives, lists, subsites] = await this.ctx.host.read(api => Promise.all([
      reads.listDrives(api, id), reads.listLists(api, id), reads.listSubsites(api, id).catch(() => []),
    ]));
    const contents: SiteContents = {
      ...toSiteInfo(site),
      libraries: drives.map(drive => toLibraryInfo(drive, id)),
      lists: lists.lists.map(list => toListInfo(list, id)),
      hasPages: lists.hasPages,
      subsites: subsites.map(toSiteInfo),
    };
    await this.ctx.observe("Read a SharePoint site", `Read what the site ${md(site.name)} holds: ` +
      `${drives.length} libraries, ${lists.lists.length} lists, ${subsites.length} subsites.`, [
      units.site(id), ...drives.map(drive => units.drive(drive.id)),
      ...lists.lists.map(list => units.list({ siteId: id, listId: list.id })), ...subsites.map(sub => units.site(sub.id)),
    ]);
    return contents;
  }

  async resolveUrl(url: string): Promise<ResolvedLink> {
    const owner = await this.ctx.host.owner();
    const tenant = owner.sharePointTenant;
    if (tenant === undefined) throw new Error("This Microsoft 365 account has no SharePoint.");
    const scope = this.ctx.host.scope;
    let parsed: URL;
    try {
      parsed = checkSharePointUrl(url, tenant);
    } catch (error) {
      if (error instanceof UnresolvableUrlError) throw new Error(error.message, { cause: error });
      throw error;
    }
    // A binding narrower than "all" is one site's, whose host the link must share. Past this point
    // Graph is asked with the owner's token, so every refusal is the guard's one wording: a link
    // the owner can't open and one outside the binding read alike, or a narrow binding would be an
    // oracle for what the owner can open across the tenant.
    if ("siteId" in scope && splitSiteId(scope.siteId)?.host !== parsed.hostname) throw new OutsideScopeError();
    let resolved;
    try {
      resolved = await this.ctx.host.read(api => resolveSharePointUrl(api, url, tenant, { selected: this.ctx.host.sites === "selected" }));
    } catch (error) {
      if (!(error instanceof UnresolvableUrlError)) throw error;
      // "all" covers whatever the owner can open, so there the reason gives nothing away.
      if (scope.kind === "all") throw new Error(error.message, { cause: error });
      throw new OutsideScopeError();
    }
    const target = resolved.scope;
    const guard = this.ctx.guard;
    let link: ResolvedLink;
    let revealed: string[] = [];
    switch (target.kind) {
      case "all":
        if (scope.kind !== "all") throw new OutsideScopeError();
        link = { kind: "all", name: resolved.name, webUrl: resolved.webUrl };
        break;
      case "site":
        guard.site(target.siteId);
        link = { kind: "site", id: target.siteId, name: resolved.name, webUrl: resolved.webUrl };
        revealed = [units.site(target.siteId)];
        break;
      case "library":
        await guard.drive(target.driveId);
        // What list() and getEntry() take is a folder: the library's root, by the alias LibraryInfo.rootFolderId uses.
        link = { kind: "library", id: encodeItemRef({ driveId: target.driveId, itemId: "root" }), name: resolved.name, webUrl: resolved.webUrl };
        revealed = [units.drive(target.driveId)];
        break;
      case "folder":
      case "file": {
        const ref = { driveId: target.driveId, itemId: target.itemId };
        await guard.item(ref);
        link = { kind: target.kind, id: encodeItemRef(ref), name: resolved.name, webUrl: resolved.webUrl };
        revealed = [units.item(ref)];
        break;
      }
      case "list":
        guard.list(target);
        link = { kind: "list", id: encodeListRef(target), name: resolved.name, webUrl: resolved.webUrl };
        revealed = [units.list(target)];
        break;
      case "page": {
        guard.page(target);
        link = { kind: "page", id: encodePageRef(target), name: resolved.name, webUrl: resolved.webUrl };
        // The title is the current version's, which a draft changes: pinned to it, as reading the page is.
        const page = await this.ctx.host.read(api => reads.getPage(api, target));
        revealed = page === null ? [units.page(target)] : units.pageRead(target, page.page.state, page.page.version);
        break;
      }
    }
    await this.ctx.observe("Resolved a SharePoint link", `Looked up a link: the ${link.kind} ${md(link.name)}.`, revealed);
    return link;
  }

  // -- files ------------------------------------------------------------------------------------

  /** The path base for entries of a drive: the binding's own, or the drive's root. */
  protected readonly baseFor = async (driveId: string): Promise<PathBase> => {
    const root = await this.ctx.root();
    return root.base && root.base.driveId === driveId ? root.base : { driveId, path: "" };
  };

  /**
   * A real item, proven in scope; the drive-root alias `driveId/root` is resolved to the root's ID
   * first, so the guard compares real IDs.
   */
  protected readonly item = async (id: string): Promise<GraphDriveItem> => {
    const decoded = decodeItemRef(id);
    if ("provisional" in decoded) throw new Error("That file or folder is still awaiting approval, so it can't be read from SharePoint yet.");
    let ref = decoded;
    if (ref.itemId === "root") {
      const root = await this.ctx.host.read(api => reads.getRoot(api, ref.driveId));
      if (root === null) throw new OutsideScopeError();
      ref = { driveId: ref.driveId, itemId: root.id };
    }
    return await this.ctx.guard.item(ref);
  };

  /** An entry as the agent sees it, pending changes applied. */
  protected readonly entry = async (item: GraphDriveItem, overlay: Overlay): Promise<DriveEntry> => {
    return overlay.apply(toEntry(item, await this.baseFor(item.driveId)))!;
  };

  protected readonly overlay = (): Overlay => {
    return new Overlay(this.ctx.host.pending(), id => this.ctx.host.resolve(id));
  };

  /** The folder a listing opens: the one named, or the top of the binding. */
  async #listingFolder(folderId: string | undefined): Promise<GraphDriveItem> {
    const scope = this.ctx.host.scope;
    if (folderId !== undefined) {
      const folder = await this.item(folderId);
      if (folder.kind !== "folder") throw new Error("That ID is a file, not a folder. Use getEntry or readFile for files.");
      // Graph can't list through a shortcut, so its target is listed, guarded as its own ID would be.
      return folder.remote ? await this.item(encodeItemRef({ driveId: folder.remote.driveId, itemId: folder.remote.id })) : folder;
    }
    const top = this.ctx.guard.defaultFolder();
    if (top === null) {
      if (scope.kind === "file") throw new Error("This connection covers one file, so there is no folder to list. Use getScope() for its ID.");
      if (!this.ctx.guard.coversFiles) throw notInScope("list files", scope);
      throw new Error("Pass a folderId: a library's rootFolderId from getSite(), or a folder's id.");
    }
    return await this.item(encodeItemRef(top));
  }

  async list(options?: ListOptions): Promise<Cursor<DriveEntry>> {
    const folderId = this.resolved(options?.folderId);
    const orderBy = options?.orderBy ?? "name";
    const size = pageSize(options?.pageSize, 50, 200);
    const pending = folderId === undefined ? undefined : provisional(folderId);
    const overlay = this.overlay();
    if (pending !== undefined) {
      // A folder awaiting approval holds only what is also awaiting approval.
      const created = overlay.created(pending);
      if (created === undefined || created.kind !== "folder") throw new OutsideScopeError();
      return new ArrayCursor(overlay.addedTo(pending, created.path, created.libraryId, created.siteId), size);
    }
    const folder = await this.#listingFolder(folderId);
    const folderRef: ItemRef = { driveId: folder.driveId, itemId: folder.id };
    const folderEntry = await this.entry(folder, overlay);
    const base = await this.baseFor(folder.driveId);
    const added = overlay.addedTo(folderEntry.id, folderEntry.path, folder.driveId, itemSiteId(folder));
    const walk = this.ctx.gate.lease();
    const guard = this.ctx.guard;
    const describeFolder = md(folderEntry.path === "" ? folder.name : folderEntry.path);
    return new TokenCursor<DriveEntry>({
      pageSize: size,
      remotePageSize: size,
      dispose: () => walk[Symbol.dispose](),
      inject: { items: added, compare: () => -1, identity: entry => entry.id },
      fetchPage: async (token, perPage) => {
        // The folder is proved still the binding's for every page: a cursor may outlive a move of it.
        await guard.item(folderRef);
        const page = await this.ctx.host.read(api => reads.listChildren(api, folderRef, token, perPage, orderBy));
        const entries = page.items
          .filter(child => guard.childOf(child, folderRef))
          .map(child => overlay.apply(toEntry(child, base), folderEntry.id))
          .filter((entry): entry is DriveEntry => entry !== null);
        return { items: entries, ...(page.nextLink ? { nextToken: page.nextLink } : {}) };
      },
      authorizePage: (items, { terminal }) => walk.authorize({
        title: "Listed a SharePoint folder",
        description: items.length === 0
          ? `Listed the folder ${describeFolder}${terminal ? "; it holds nothing more" : ""}.`
          : `Listed ${items.length} item${items.length === 1 ? "" : "s"} in the folder ${describeFolder}: ` +
            `${items.slice(0, 20).map(entry => md(entry.name)).join(", ")}${items.length > 20 ? ", …" : ""}.`,
      }, { kind: "collections", ids: [units.item(folderRef), ...items.map(entry => units.item(decodeItemRef(entry.id) as ItemRef))] }),
    });
  }

  async getEntry(id: string): Promise<DriveEntry> {
    id = this.resolved(id);
    const overlay = this.overlay();
    const pending = provisional(id);
    if (pending !== undefined) {
      const created = overlay.created(pending);
      if (created === undefined) throw new OutsideScopeError();
      return created;
    }
    const item = await this.item(id);
    const entry = await this.entry(item, overlay);
    await this.ctx.observe("Read SharePoint file details", `Read the details of ${md(entry.path || entry.name)}.`,
      [units.item({ driveId: item.driveId, itemId: item.id })]);
    return entry;
  }

  async search(query: string, options?: SearchOptions): Promise<Cursor<DriveEntry>> {
    if (query.trim() === "") throw new Error("Search for at least one word.");
    if (query.length > 500) throw new Error("A search can be at most 500 characters.");
    const scope = this.ctx.host.scope;
    if (!this.ctx.guard.coversFiles || scope.kind === "file") throw notInScope("search files", scope);
    const size = pageSize(options?.pageSize, 25, 50);
    const kind = options?.kind;

    // A folder to search within narrows the guard: hits are kept only if inside it as well.
    let within: ScopeGuard = this.ctx.guard;
    let withinItem: GraphDriveItem | undefined;
    if (options?.folderId !== undefined) {
      withinItem = await this.item(this.resolved(options.folderId));
      if (withinItem.kind !== "folder") throw new Error("folderId must be a folder.");
      const siteId = itemSiteId(withinItem) ?? (scope.kind === "all" ? "" : scope.siteId);
      within = new ScopeGuard(withinItem.isRoot
        ? { kind: "library", siteId, driveId: withinItem.driveId }
        : { kind: "folder", siteId, driveId: withinItem.driveId, itemId: withinItem.id }, {
        item: ref => this.ctx.host.read(api => reads.getItem(api, ref)),
        drive: driveId => this.ctx.drive(driveId),
      });
    }
    const root = await this.ctx.root();
    const overlay = this.overlay();
    // Where the provider is asked to look: a whole library through its own search; a folder, named
    // or bound, or a site through Microsoft Search's `path:` filter, so that most of what the guard
    // would only read and drop is never returned.
    const wholeDrive = withinItem !== undefined ? (withinItem.isRoot ? withinItem.driveId : undefined)
      : scope.kind === "library" ? scope.driveId : undefined;
    const pathFilter = withinItem !== undefined ? (withinItem.isRoot ? undefined : withinItem.webUrl)
      : scope.kind === "folder" ? root.webUrl : scope.kind === "site" ? root.siteUrl : undefined;
    const walk = this.ctx.gate.lease();
    const keep = async (items: (GraphDriveItem | null)[]): Promise<DriveEntry[]> => {
      const kept: DriveEntry[] = [];
      for (const item of items) {
        if (item === null || (kind !== undefined && item.kind !== kind)) continue;
        if (!(await this.ctx.guard.contains(item)) || !(await within.contains(item))) continue;
        const entry = overlay.apply(toEntry(item, await this.baseFor(item.driveId)), undefined);
        if (entry !== null && entry.pending !== "delete") kept.push(entry);
      }
      return kept;
    };
    return new TokenCursor<DriveEntry>({
      pageSize: size,
      remotePageSize: size,
      // Each provider page is re-read and re-checked, so a sparse page costs extra requests; three
      // windows per call bounds that before answering "ask again".
      maxProviderPagesPerCall: 3,
      dispose: () => walk[Symbol.dispose](),
      fetchPage: async (token, perPage) => {
        try {
          if (wholeDrive !== undefined) {
            const page = await this.ctx.host.read(api => reads.searchDrive(api, wholeDrive, query, token, perPage));
            return { items: await keep(page.items), ...(page.nextLink ? { nextToken: page.nextLink } : {}) };
          }
          const from = token === undefined ? 0 : Number(token);
          const hits = await this.ctx.host.read(api => reads.searchAll(api, query, pathFilter, from, perPage));
          const items = await this.ctx.host.read(api => reads.getItems(api, hits.hits));
          return { items: await keep(items), ...(hits.nextFrom !== undefined ? { nextToken: String(hits.nextFrom) } : {}) };
        } catch (error) {
          throw searchFailure(error, "Search");
        }
      },
      authorizePage: (items, { terminal }) => items.length === 0
        ? walk.authorize({
          title: "Searched SharePoint",
          description: `Searched for ${md(query)}${terminal ? "; there were no more results" : ""}.`,
        }, root.units ? { kind: "collections", ids: root.units } : { kind: "baseline" })
        : walk.authorize({
          title: "Searched SharePoint",
          description: `Searched for ${md(query)}: ${items.slice(0, 20).map(entry => md(entry.name)).join(", ")}${items.length > 20 ? ", …" : ""}.`,
        }, { kind: "collections", ids: items.map(entry => units.item(decodeItemRef(entry.id) as ItemRef)) }),
    });
  }

  async readFile(id: string, options?: ReadFileOptions): Promise<FileContent> {
    id = this.resolved(id);
    const maxChars = options?.maxChars ?? DEFAULT_MAX_CHARS;
    if (!Number.isInteger(maxChars) || maxChars < MIN_MAX_CHARS || maxChars > MAX_MAX_CHARS) {
      throw new Error(`maxChars must be a whole number from ${MIN_MAX_CHARS.toLocaleString("en-US")} to ${MAX_MAX_CHARS.toLocaleString("en-US")}.`);
    }
    const overlay = this.overlay();
    const copied = this.#copied(id, overlay);
    if (copied !== undefined) return { ...await this.readFile(copied.source, options), entry: copied.entry };
    const staged = await this.#stagedContent(id, overlay);
    if (staged !== undefined) {
      const converted = await convertStaged(staged.bytes, staged.name, staged.mimeType, maxChars);
      return { entry: staged.entry, ...converted };
    }
    const item = await this.item(id);
    if (item.kind !== "file") throw new Error("That ID is a folder. Use list({ folderId }) to see what it holds.");
    const entry = await this.entry(item, overlay);
    const key = `text:${item.driveId}:${item.id}:${item.cTag ?? item.eTag ?? item.modifiedAt ?? ""}:${maxChars}`;
    const [converted, shown] = await Promise.all([
      this.ctx.host.cached<Converted>(key, TEXT_TTL_MS, () =>
        this.ctx.host.read(api => convertFile({ api, ...(this.ctx.host.ai ? { ai: this.ctx.host.ai } : {}) }, item, maxChars))
          .then(result => result.content.length > MAX_CACHED_TEXT ? Promise.reject(new UncachedResult(result)) : result))
        .catch(error => {
          if (error instanceof UncachedResult) return error.result;
          throw error;
        }),
      this.fileVersion(item),
    ]);
    await this.ctx.observe("Read a SharePoint file", `Read the content of ${md(entry.path || entry.name)}.`,
      units.fileRead({ driveId: item.driveId, itemId: item.id }, shown.version, shown.moderation));
    return { entry, ...converted };
  }

  /**
   * The version of a file this read is shown, and whether it awaits approval, so an observer is
   * admitted to a draft only if they would be shown the same draft. Read uncached: a cached label
   * could vouch for a newer draft.
   */
  protected readonly fileVersion = async (item: GraphDriveItem): Promise<{ version?: string; moderation?: number }> => {
    return await this.ctx.host.read(api => reads.fileVersion(api, { driveId: item.driveId, itemId: item.id }));
  };

  /** For a copy awaiting approval, the file it copies, which is what reading the copy reads. */
  #copied(id: string, overlay: Overlay): { source: string; entry: DriveEntry } | undefined {
    const pending = provisional(id);
    const source = pending !== undefined ? overlay.copySource(pending) : undefined;
    const entry = pending !== undefined ? overlay.created(pending) : undefined;
    return source !== undefined && entry !== undefined ? { source: encodeItemRef(source), entry } : undefined;
  }

  /** The bytes a pending upload or replace will write, when `id` has one, for reading before approval. */
  async #stagedContent(id: string, overlay: Overlay): Promise<{ bytes: Uint8Array; name: string; mimeType: string; entry: DriveEntry } | undefined> {
    const pending = provisional(id);
    if (pending === undefined && overlay.pendingContent(id) === undefined) return undefined;
    const key = pending ?? id;
    const content = overlay.pendingContent(key);
    if (content === undefined) throw new OutsideScopeError();
    const entry = pending !== undefined ? overlay.created(pending) : await this.entry(await this.item(id), overlay);
    if (entry === undefined) throw new OutsideScopeError();
    return { bytes: await this.ctx.host.readCaptured(content.file), name: content.name, mimeType: content.mimeType, entry };
  }

  async readBytes(id: string): Promise<Uint8Array> {
    id = this.resolved(id);
    const overlay = this.overlay();
    const copied = this.#copied(id, overlay);
    if (copied !== undefined) return await this.readBytes(copied.source);
    const staged = await this.#stagedContent(id, overlay);
    if (staged !== undefined) return staged.bytes;
    const item = await this.item(id);
    if (item.kind !== "file") throw new Error("That ID is a folder, which has no bytes.");
    if (item.size !== undefined && item.size > MAX_READ_BYTES) {
      throw new Error(`The file is larger than the ${MAX_READ_BYTES / (1024 * 1024)} MB readBytes can return.`);
    }
    const [download, shown] = await Promise.all([
      this.ctx.host.read(api => api.download(`/drives/${item.driveId}/items/${item.id}/content`, MAX_READ_BYTES)),
      this.fileVersion(item),
    ]);
    const entry = await this.entry(item, overlay);
    await this.ctx.observe("Downloaded a SharePoint file", `Downloaded ${md(entry.path || entry.name)} (${download.bytes.byteLength.toLocaleString("en-US")} bytes).`,
      units.fileRead({ driveId: item.driveId, itemId: item.id }, shown.version, shown.moderation));
    return download.bytes;
  }

  async readWorkbook(id: string, options?: ReadWorkbookOptions): Promise<WorkbookContent> {
    id = this.resolved(id);
    const maxCells = options?.maxCells ?? DEFAULT_MAX_CELLS;
    if (!Number.isInteger(maxCells) || maxCells < 1 || maxCells > MAX_MAX_CELLS) {
      throw new Error(`maxCells must be a whole number from 1 to ${MAX_MAX_CELLS.toLocaleString("en-US")}.`);
    }
    let range: string | undefined;
    if (options?.range !== undefined) {
      if (options.sheet === undefined) throw new Error("Pass sheet with range: the worksheet the range is on.");
      const parsed = parseCellRange(options.range);
      if (rangeRows(parsed) * rangeColumns(parsed) > maxCells) {
        throw new Error(`${options.range} has more than maxCells (${maxCells.toLocaleString("en-US")}) cells. Read a smaller range, or raise maxCells.`);
      }
      range = formatRange(parsed);
    }
    const overlay = this.overlay();
    const copied = this.#copied(id, overlay);
    if (copied !== undefined) return { ...await this.readWorkbook(copied.source, options), entry: copied.entry };
    if (provisional(id) !== undefined || overlay.pendingContent(id) !== undefined) {
      throw new Error("This workbook is awaiting approval, and can be read with readWorkbook once it is in SharePoint. Use readFile to read it meanwhile.");
    }
    const item = await this.item(id);
    if (!isWorkbook(item)) throw new Error("readWorkbook reads Excel workbooks (.xlsx, .xlsm, .xlsb). Use readFile for other files.");
    const [sheets, shown] = await Promise.all([
      this.ctx.host.read(api => readWorkbookSheets(api, { driveId: item.driveId, itemId: item.id },
        { ...(options?.sheet !== undefined ? { sheet: options.sheet } : {}), ...(range !== undefined ? { range } : {}), maxCells })),
      this.fileVersion(item),
    ]);
    const entry = await this.entry(item, overlay);
    // Pending cell changes, shown as made, as every read shows what awaits approval.
    const cells = overlay.pendingCells(id);
    const worksheets = sheets.worksheets.map(sheet =>
      withPendingCells(sheet, cells.filter(change => change.worksheet.toLowerCase() === sheet.name.toLowerCase()), { maxCells, within: range !== undefined }));
    await this.ctx.observe("Read a SharePoint workbook", `Read ${sheets.worksheets.length} worksheet${sheets.worksheets.length === 1 ? "" : "s"} of ${md(entry.path || entry.name)}.`,
      units.fileRead({ driveId: item.driveId, itemId: item.id }, shown.version, shown.moderation));
    return { entry, worksheets, otherWorksheets: sheets.otherWorksheets };
  }

  async readPresentation(id: string): Promise<PresentationContent> {
    id = this.resolved(id);
    const entry = await this.getEntry(id);
    if (extensionOf(entry.name) !== "pptx") throw new Error("readPresentation reads PowerPoint decks (.pptx). Use readFile for other files.");
    const bytes = await this.readBytes(id);
    let structure: Awaited<ReturnType<typeof presentationStructure>>;
    try {
      structure = await presentationStructure(bytes);
    } catch (error) {
      throw new Error(`This deck can't be read: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    return { entry, ...structure };
  }

  async listVersions(id: string): Promise<FileVersion[]> {
    id = this.resolved(id);
    const item = await this.item(id);
    if (item.kind !== "file") throw new Error("Only files have versions.");
    const versions = await this.ctx.host.read(api => reads.listVersions(api, { driveId: item.driveId, itemId: item.id }));
    await this.ctx.observe("Read SharePoint file versions", `Read the version history of ${md(item.name)}.`,
      units.versions({ driveId: item.driveId, itemId: item.id }));
    return versions.map(version => ({
      id: version.id,
      ...(version.modifiedAt ? { modifiedAt: version.modifiedAt } : {}),
      ...(version.modifiedBy ? { modifiedBy: version.modifiedBy } : {}),
      ...(version.size !== undefined ? { size: version.size } : {}),
    }));
  }

  // -- lists ------------------------------------------------------------------------------------

  /** The list a call names, or the binding's own; proven in scope and read. */
  protected readonly listTarget = async (listId?: string): Promise<{ ref: ListRef; list: GraphList }> => {
    const scope = this.ctx.host.scope;
    if (!this.ctx.guard.coversLists) throw notInScope("open lists", scope);
    let ref: ListRef;
    if (listId === undefined) {
      if (scope.kind !== "list") throw new Error("Pass a list ID; getSite() lists a site's lists.");
      ref = { siteId: scope.siteId, listId: scope.listId };
    } else {
      ref = decodeListRef(listId);
    }
    this.ctx.guard.list(ref);
    const list = await this.ctx.host.cached(`list:${ref.siteId}:${ref.listId}`, METADATA_TTL_MS,
      () => this.ctx.host.read(api => reads.getList(api, ref)));
    if (list === null) throw new OutsideScopeError();
    if (list.template === "documentLibrary") throw new Error("That is a document library; read its files with list({ folderId }).");
    return { ref, list };
  };

  async openList(listId?: string): Promise<SharePointListReader> {
    const { ref, list } = await this.listTarget(listId);
    return new SharePointListReaderImpl(this.ctx.fork(), ref, list);
  }

  // -- pages ------------------------------------------------------------------------------------

  async listPages(siteId?: string): Promise<Cursor<PageInfo>> {
    const scope = this.ctx.host.scope;
    if (!this.ctx.guard.coversPages) throw notInScope("list pages", scope);
    if (scope.kind === "page" && siteId === undefined) {
      const page = await this.ctx.host.read(api => reads.getPage(api, scope));
      if (page === null) throw new OutsideScopeError();
      const site = await this.ctx.site(scope.siteId);
      await this.ctx.observe("Listed SharePoint pages", `Listed the page ${md(page.page.title)}.`,
        units.pageRead(scope, page.page.state, page.page.version));
      return new ArrayCursor([toPageInfo(page.page, scope.siteId, site?.webUrl)], 1);
    }
    const id = siteId === undefined ? (scope.kind === "site" ? scope.siteId : undefined) : decodeSiteId(siteId);
    if (id === undefined) throw new Error("Pass a site ID; listSites() lists them.");
    this.ctx.guard.site(id);
    const site = await this.ctx.site(id);
    if (site === null) throw new OutsideScopeError();
    const walk = this.ctx.gate.lease();
    // What each listed page was shown as, so a draft's title is shared only with its editors.
    const shown = new Map<string, GraphSitePage>();
    return new TokenCursor({
      pageSize: 50,
      dispose: () => walk[Symbol.dispose](),
      fetchPage: async (token, perPage) => {
        const page = await this.ctx.host.read(api => reads.listPages(api, id, token, perPage));
        const items = page.items.map(item => {
          const info = toPageInfo(item, id, site.webUrl);
          shown.set(info.id, item);
          return info;
        });
        return { items, ...(page.nextLink ? { nextToken: page.nextLink } : {}) };
      },
      authorizePage: (items, { terminal }) => walk.authorize({
        title: "Listed SharePoint pages",
        description: items.length === 0
          ? `Listed the pages of ${md(site.name)}${terminal ? "; there were no more" : ""}.`
          : `Listed pages of ${md(site.name)}: ${items.slice(0, 20).map(page => md(page.title)).join(", ")}.`,
      }, { kind: "collections", ids: [units.site(id), ...items.flatMap(page =>
        units.pageRead(decodePageRef(page.id), shown.get(page.id)?.state, shown.get(page.id)?.version))] }),
    });
  }

  async readPage(pageId?: string): Promise<PageContent> {
    const scope = this.ctx.host.scope;
    if (!this.ctx.guard.coversPages) throw notInScope("read pages", scope);
    let ref: PageRef;
    if (pageId === undefined) {
      if (scope.kind !== "page") throw new Error("Pass a page ID; listPages() lists a site's pages.");
      ref = { siteId: scope.siteId, pageId: scope.pageId };
    } else {
      ref = decodePageRef(pageId);
    }
    this.ctx.guard.page(ref);
    const [page, site] = await Promise.all([this.ctx.host.read(api => reads.getPage(api, ref)), this.ctx.site(ref.siteId)]);
    if (page === null) throw new OutsideScopeError();
    const info = toPageInfo(page.page, ref.siteId, site?.webUrl);
    const rendered = pageMarkdown(info.title, parseCanvas(page.body));
    await this.ctx.observe("Read a SharePoint page", `Read the page ${md(info.title)}.`,
      units.pageRead(ref, page.page.state, page.page.version));
    return { page: info, markdown: rendered.markdown, ...(rendered.note ? { note: rendered.note } : {}) };
  }
}

/** A conversion result too large to cache, carried out of the cache's loader. */
class UncachedResult {
  constructor(readonly result: Converted) {}
}

/** Pending content read back as text, for a file whose upload or replace awaits approval. */
async function convertStaged(bytes: Uint8Array, name: string, mimeType: string, maxChars: number): Promise<Omit<FileContent, "entry">> {
  try {
    const converted = await convertToText({ bytes, name, mimeType, maxChars });
    if (converted === null) return { format: "none", content: "", truncated: false, note: "This pending file can't be read as text." };
    return { format: converted.format, content: converted.content, truncated: converted.truncated };
  } catch (error) {
    return { format: "none", content: "", truncated: false, note: error instanceof Error ? error.message : "Unreadable." };
  }
}

/** Search failing on SharePoint's side, explained: a new tenant's index takes a while to build. */
function searchFailure(error: unknown, what: string): unknown {
  if (error instanceof GraphApiError && error.status >= 500) {
    return new Error(`${what} isn't available in SharePoint right now${error.code ? ` (${error.code})` : ""}. On a new Microsoft 365 ` +
      "organization, search can take a day to start working. Browse with list() and getSite() meanwhile.");
  }
  return error;
}

/** Read access to one list. */
@validateRpc()
export class SharePointListReaderImpl extends RpcTarget implements SharePointListReader {
  protected readonly ctx: SessionContext;
  protected readonly ref: ListRef;
  protected readonly list: GraphList;

  constructor(ctx: SessionContext, ref: ListRef, list: GraphList) {
    super();
    this.ctx = ctx;
    this.ref = ref;
    this.list = list;
  }

  [Symbol.dispose](): void {
    this.ctx[Symbol.dispose]();
  }

  /** The list's visible columns. An instance member, kept off the RPC surface; see SharePointReaderImpl. */
  protected readonly columns = (): Promise<GraphColumn[]> => {
    return this.ctx.host.cached(`columns:${this.ref.siteId}:${this.ref.listId}`, METADATA_TTL_MS,
      async () => visibleColumns(await this.ctx.host.read(api => reads.listColumns(api, this.ref))));
  };

  protected readonly overlay = (): Overlay => {
    return new Overlay(this.ctx.host.pending(), id => this.ctx.host.resolve(id));
  };

  async getInfo(): Promise<ListInfo> {
    await this.ctx.observe("Read a SharePoint list", `Read the details of the list ${md(this.list.name)}.`, [units.list(this.ref)]);
    return toListInfo(this.list, this.ref.siteId);
  }

  async getColumns(): Promise<ColumnInfo[]> {
    const columns = await this.columns();
    await this.ctx.observe("Read a SharePoint list's columns", `Read the columns of the list ${md(this.list.name)}.`, [units.list(this.ref)]);
    return columns.map(toColumnInfo);
  }

  async queryItems(query?: ItemQuery): Promise<Cursor<ListItem>> {
    const columns = await this.columns();
    let compiled;
    try {
      compiled = compileQuery(columns, query ?? {});
    } catch (error) {
      if (error instanceof ListQueryError) throw new Error(error.message, { cause: error });
      throw error;
    }
    const size = pageSize(query?.pageSize, 50, 200);
    const overlay = this.overlay();
    const filtered = (query?.where?.length ?? 0) > 0;
    const walk = this.ctx.gate.lease();
    const listUnit = units.list(this.ref);
    // The version each item was read at, so a draft or an unapproved change is shared only with
    // those shown the same.
    const versions = new Map<string, Pick<GraphListItem, "version" | "moderation">>();
    return new TokenCursor<ListItem>({
      pageSize: size,
      remotePageSize: size,
      dispose: () => walk[Symbol.dispose](),
      // A filtered query shows a pending new item only if it would match; that is the agent's own
      // data, so rather than guess, new items join unfiltered queries only.
      inject: filtered ? undefined : { items: overlay.createdItems(this.ref, true), compare: () => -1, identity: item => item.id },
      fetchPage: async (token, perPage) => {
        let page;
        try {
          page = await this.ctx.host.read(api => reads.listItems(api, this.ref, compiled.query, token, perPage, compiled.unindexed.length > 0));
        } catch (error) {
          throw tooLarge(error, compiled.unindexed);
        }
        for (const item of page.items) versions.set(item.id, item);
        const items = page.items.map(toListItem).map(item => overlay.applyItem(this.ref, item, true)).filter((item): item is ListItem => item !== null);
        return { items, ...(page.nextLink ? { nextToken: page.nextLink } : {}) };
      },
      authorizePage: (items, { terminal }) => walk.authorize({
        title: "Queried a SharePoint list",
        description: items.length === 0
          ? `Queried the list ${md(this.list.name)}${terminal ? "; no more items matched" : ""}.`
          : `Read ${items.length} item${items.length === 1 ? "" : "s"} of the list ${md(this.list.name)}.`,
      }, { kind: "collections", ids: [listUnit, ...items.flatMap(item =>
        units.listItemRead(this.ref, item.id, versions.get(item.id)?.version, versions.get(item.id)?.moderation))] }),
    });
  }

  async getItem(itemId: string): Promise<ListItem> {
    const overlay = this.overlay();
    // A temporary ID names a real item once its creation applied, so it is resolved first.
    const resolved = this.ctx.host.resolve(itemId);
    if (isProvisional(resolved)) {
      const created = overlay.createdItems(this.ref, false).find(item => item.id === resolved);
      if (created === undefined) throw new OutsideScopeError();
      return created;
    }
    const item = await this.ctx.host.read(api => reads.getListItem(api, this.ref, resolved));
    if (item === null) throw new OutsideScopeError();
    const result = overlay.applyItem(this.ref, toListItem(item), false)!;
    await this.ctx.observe("Read a SharePoint list item", `Read item ${md(item.id)} of the list ${md(this.list.name)}.`,
      [units.list(this.ref), ...units.listItemRead(this.ref, item.id, item.version, item.moderation)]);
    return result;
  }
}

/** SharePoint's refusal of a query on a large list, explained. */
function tooLarge(error: unknown, unindexed: readonly string[]): unknown {
  if (error instanceof GraphApiError && (error.status === 400 || error.status === 500) && unindexed.length > 0
    && /threshold|not indexed|HonorNonIndexed/i.test(error.message)) {
    return new Error(`This list is too large to filter or sort on ${unindexed.map(name => `"${name}"`).join(", ")}, which ` +
      "SharePoint hasn't indexed. Filter on an indexed column (see getColumns()), or ask the list's owner to index it.");
  }
  return error;
}

/** Read and write access to one list. */
@validateRpc()
export class SharePointListImpl extends SharePointListReaderImpl implements SharePointList {
  async createItem(fields: Record<string, FieldValue>): Promise<ListItem> {
    const columns = await this.columns();
    let values: Record<string, FieldValue>;
    try {
      values = validateFieldValues(columns, fields);
      requireRequired(columns, values);
    } catch (error) {
      if (error instanceof ListQueryError) throw new Error(error.message, { cause: error });
      throw error;
    }
    const ref = this.ctx.host.allocate("listItem");
    const submittedAt = Date.now();
    await this.ctx.host.submit(this.ctx.queue, "createListItem", {
      ref, list: this.#target(), fields: values, labels: labelsFor(columns, values), submittedAt,
    });
    return {
      id: ref, fields: values, createdAt: new Date(submittedAt).toISOString(), modifiedAt: new Date(submittedAt).toISOString(), pending: "create",
    };
  }

  async updateItem(itemId: string, fields: Record<string, FieldValue>, options?: { ifUnchanged?: string }): Promise<ListItem> {
    const columns = await this.columns();
    let values: Record<string, FieldValue>;
    try {
      values = validateFieldValues(columns, fields);
    } catch (error) {
      if (error instanceof ListQueryError) throw new Error(error.message, { cause: error });
      throw error;
    }
    const current = await this.getItem(itemId);
    if (current.pending === "delete") throw new Error("That item is already awaiting deletion.");
    const before: Record<string, FieldValue> = {};
    for (const name of Object.keys(values)) before[name] = current.fields[name] ?? null;
    const resolved = this.ctx.host.resolve(itemId);
    // Fenced on the version this read saw. A pending change of ours would move that, and may yet be
    // rejected, so a second change waits for it rather than going unfenced.
    this.#requireNoPendingItemChange(resolved, "changing");
    const ifMatch = ifUnchanged(options) ?? (isProvisional(resolved) ? undefined : current.eTag);
    const title = typeof current.fields.Title === "string" ? current.fields.Title : undefined;
    await this.ctx.host.submit(this.ctx.queue, "updateListItem", {
      list: this.#target(), itemId: isProvisional(resolved) ? itemId : resolved, ...(title ? { title } : {}),
      fields: values, labels: labelsFor(columns, values), before, ...(ifMatch ? { ifMatch } : {}), submittedAt: Date.now(),
    });
    return { ...current, fields: { ...current.fields, ...values }, pending: current.pending === "create" ? "create" : "update" };
  }

  async deleteItem(itemId: string, options?: { ifUnchanged?: string }): Promise<void> {
    const current = await this.getItem(itemId);
    if (current.pending === "delete") return;
    const resolved = this.ctx.host.resolve(itemId);
    const title = typeof current.fields.Title === "string" ? current.fields.Title : undefined;
    this.#requireNoPendingItemChange(resolved, "deleting");
    const ifMatch = ifUnchanged(options) ?? (isProvisional(resolved) ? undefined : current.eTag);
    await this.ctx.host.submit(this.ctx.queue, "deleteListItem", {
      list: this.#target(), itemId: isProvisional(resolved) ? itemId : resolved, ...(title ? { title } : {}),
      ...(ifMatch ? { ifMatch } : {}), submittedAt: Date.now(),
    });
  }

  #target(): ListTarget {
    return { ...this.ref, name: this.list.name, webUrl: this.list.webUrl };
  }

  /**
   * An item with a change of ours awaiting approval can't take another: an existing item's version
   * fence would have to go, and a new item's second change would record a `before` the first may
   * never write, so its undo would restore the wrong values.
   */
  #requireNoPendingItemChange(resolved: string, before: "changing" | "deleting"): void {
    if (this.overlay().hasPendingItemChange(this.ref, resolved)) {
      throw new Error(`A change to this item is already awaiting approval. Wait for it to be decided before ${before} it.`);
    }
  }
}

/** Display names for the columns being written. */
function labelsFor(columns: readonly GraphColumn[], values: Record<string, FieldValue>): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const name of Object.keys(values)) labels[name] = columns.find(column => column.name === name)?.displayName ?? name;
  return labels;
}

/** Read access plus changes that need approval. */
@validateRpc()
export class SharePointSessionImpl extends SharePointReaderImpl implements SharePointSession {
  override async openList(listId?: string): Promise<SharePointList> {
    const { ref, list } = await this.listTarget(listId);
    return new SharePointListImpl(this.ctx.fork(), ref, list);
  }

  /** Where a new file or folder goes: a real folder in scope, or one awaiting approval. */
  async #folderTarget(parentId: string): Promise<FolderTarget> {
    const overlay = this.overlay();
    const pending = provisional(parentId);
    if (pending !== undefined) {
      const created = overlay.created(pending);
      if (created === undefined || created.kind !== "folder") throw new OutsideScopeError();
      const root = await this.ctx.root();
      return { id: pending, driveId: created.libraryId, name: created.name, location: [root.location, crumbs(created.path)].filter(Boolean).join(" › "), path: created.path };
    }
    const folder = await this.item(parentId);
    if (folder.kind !== "folder") throw new Error("That ID is a file; files go in folders.");
    const entry = await this.entry(folder, overlay);
    if (entry.pending === "delete") throw new Error("That folder is awaiting deletion.");
    return { id: entry.id, driveId: folder.driveId, name: entry.name, location: await this.#location(folder, entry.path), path: entry.path };
  }

  /** "Engineering › Documents › Specs" for an item at `path` (binding-relative) in its library. */
  async #location(item: GraphDriveItem, path: string): Promise<string> {
    const root = await this.ctx.root();
    if (root.base && root.base.driveId === item.driveId) {
      return [root.location, crumbs(path)].filter(Boolean).join(" › ");
    }
    const drive = await this.ctx.drive(item.driveId);
    const siteId = itemSiteId(item);
    const site = siteId ? await this.ctx.site(siteId) : null;
    return [drive ? libraryLocation(site, drive) : "", crumbs(path)].filter(Boolean).join(" › ");
  }

  /** An existing file or folder an action will change. */
  async #itemTarget(id: string, options: { top?: "allowed" } = {}): Promise<{ item: GraphDriveItem; target: ItemTarget; entry: DriveEntry }> {
    if (provisional(id) !== undefined) {
      throw new Error("That file or folder is still awaiting approval. Wait for it to be approved before changing it.");
    }
    const item = await this.item(id);
    const entry = await this.entry(item, this.overlay());
    if (entry.pending === "delete") throw new Error("That is already awaiting deletion.");
    const root = await this.ctx.root();
    if (options.top !== "allowed" && root.base?.itemId === item.id && root.base.driveId === item.driveId) {
      throw new Error("That is the top of what this connection covers, which can't be renamed, moved or deleted from here.");
    }
    if (item.isRoot) throw new Error("A library's top folder can't be renamed, moved or deleted.");
    // What the change returns describes the item as it is, as `getEntry` would: a read of its details.
    await this.ctx.observe("Read SharePoint file details", `Read the details of ${md(entry.path || entry.name)}, to change it.`,
      [units.item({ driveId: item.driveId, itemId: item.id })]);
    return {
      item, entry,
      target: {
        ref: { driveId: item.driveId, itemId: item.id }, name: entry.name, kind: item.kind, path: entry.path,
        location: await this.#location(item, parentPath(entry.path)), webUrl: item.webUrl,
      },
    };
  }

  /** Refuses a name already taken in a folder, by an item there or one awaiting approval. */
  async #requireFreeName(folder: FolderTarget, name: string, except?: string): Promise<void> {
    const overlay = this.overlay();
    const taken = (other: string) => other.toLowerCase() === name.toLowerCase();
    const pendingClash = overlay.addedTo(folder.id, folder.path, folder.driveId, undefined)
      .some(entry => entry.id !== except && taken(entry.name));
    if (pendingClash) throw new Error(`Something named "${name}" is already awaiting approval in ${folder.name}.`);
    if (provisional(folder.id) !== undefined) return;
    const ref = decodeItemRef(folder.id) as ItemRef;
    const existing = await this.ctx.host.read(api => api.find<{ id?: unknown }>(
      `/drives/${ref.driveId}/items/${ref.itemId}:/${pathSegment(name)}`, { query: { $select: "id" } }));
    if (existing !== null && existing.id !== (except && (decodeItemRef(except) as ItemRef).itemId)) {
      const entry = overlay.apply({ id: encodeItemRef({ driveId: ref.driveId, itemId: String(existing.id) }), name, kind: "file", webUrl: "", path: "", libraryId: ref.driveId }, folder.id);
      if (entry !== null) throw new Error(`${folder.name} already has something named "${name}". Use replaceFile to change an existing file.`);
    }
  }

  #requireWrite(): void {
    if (this.ctx.host.access !== "write") throw new Error("This deployment allows read-only access to SharePoint.");
  }

  async createFolder(parentId: string, name: string): Promise<DriveEntry> {
    parentId = this.resolved(parentId);
    this.#requireWrite();
    checkName(name);
    return await this.ctx.host.prepareExclusively(async () => {
      const parent = await this.#folderTarget(parentId);
      await this.#requireFreeName(parent, name);
      const ref = this.ctx.host.allocate("item");
      const submittedAt = Date.now();
      await this.ctx.host.submit(this.ctx.queue, "createFolder", { ref, parent, name, submittedAt });
      return {
        id: ref, name, kind: "folder", webUrl: "", path: join(parent.path, name), parentId: parent.id, libraryId: parent.driveId,
        childCount: 0, createdAt: new Date(submittedAt).toISOString(), modifiedAt: new Date(submittedAt).toISOString(), pending: "create",
      };
    });
  }

  async uploadFile(parentId: string, name: string, content: string | Uint8Array | WorkbookRows, options?: WriteOptions): Promise<DriveEntry> {
    parentId = this.resolved(parentId);
    this.#requireWrite();
    checkName(name);
    return await this.ctx.host.prepareExclusively(async () => {
      const parent = await this.#folderTarget(parentId);
      await this.#requireFreeName(parent, name);
      const encoded = await this.#encode(name, content, options?.template);
      const mimeType = mimeTypeFor(name, content);
      const file = await this.ctx.host.capture(encoded.bytes);
      const ref = this.ctx.host.allocate("item");
      const submittedAt = Date.now();
      const text = encoded.writing ? encoded.source : showableText(encoded.bytes, mimeType);
      await this.ctx.host.submit(this.ctx.queue, "uploadFile", {
        ref, parent, name, file, mimeType, ...shownTexts(text),
        ...(encoded.writing ? { writing: encoded.writing } : {}), submittedAt,
      });
      return {
        id: ref, name, kind: "file", webUrl: "", path: join(parent.path, name), parentId: parent.id, libraryId: parent.driveId,
        size: encoded.bytes.byteLength, mimeType, createdAt: new Date(submittedAt).toISOString(), modifiedAt: new Date(submittedAt).toISOString(),
        pending: "create",
      };
    });
  }

  async replaceFile(id: string, content: string | Uint8Array | WorkbookRows, options?: ChangeOptions & WriteOptions): Promise<DriveEntry> {
    id = this.resolved(id);
    this.#requireWrite();
    return await this.ctx.host.prepareExclusively(async () => {
      // A file binding's own file is its top: its content can change, though it can't move or go.
      const { item, target, entry } = await this.#itemTarget(id, { top: "allowed" });
      if (item.kind !== "file") throw new Error("Only a file's content can be replaced.");
      this.#requireNoPendingChange(entry.id, "file");
      const encoded = await this.#encode(item.name, content, options?.template);
      const mimeType = item.mimeType ?? mimeTypeFor(item.name, content);
      const text = encoded.writing ? encoded.source : showableText(encoded.bytes, mimeType);
      // For the approver: the current text to diff against, and what a rewrite of an Office file loses.
      let previousText: string | undefined;
      let loses: string[] = [];
      if (text !== undefined && (item.size ?? Infinity) <= MAX_COMPARED_BYTES) {
        try {
          const current = (await this.ctx.host.read(api => api.download(`/drives/${item.driveId}/items/${item.id}/content`, MAX_READ_BYTES))).bytes;
          if (encoded.writing) {
            loses = await featuresLost(item.name, current);
            const converted = await convertToText({ bytes: current, name: item.name, mimeType, maxChars: MAX_COMPARED_CHARS });
            if (converted !== null && !converted.truncated) previousText = converted.content;
          } else {
            previousText = showableText(current, mimeType);
          }
        } catch {
          // The diff is a courtesy; the approver still sees the full new content.
        }
      }
      const ifMatch = ifUnchanged(options) ?? item.cTag;
      const file = await this.ctx.host.capture(encoded.bytes);
      await this.ctx.host.submit(this.ctx.queue, "replaceFile", {
        target, file, mimeType, ...shownTexts(text, previousText),
        ...(encoded.writing ? { writing: encoded.writing } : {}), ...(loses.length ? { loses } : {}),
        ...(ifMatch ? { ifMatch } : {}), submittedAt: Date.now(),
      });
      return { ...entry, size: encoded.bytes.byteLength, mimeType, pending: "replace" };
    });
  }

  async editDocument(id: string, edits: DocumentEdit[], options?: EditDocumentOptions): Promise<DriveEntry> {
    const trackChanges = options?.trackChanges ?? true;
    return await this.#editInPlace(id, "document", edits, options, async (bytes, author) => {
      const result = await editDocx(bytes, edits, { trackChanges, author, date: new Date() });
      return { bytes: result.bytes, changes: result.changes, trackChanges };
    });
  }

  async editPresentation(id: string, edits: PresentationEdit[], options?: ChangeOptions): Promise<DriveEntry> {
    const markdown = edits.flatMap(edit => "addSlides" in edit ? [edit.addSlides] : "setText" in edit ? [edit.setText.markdown] : []);
    const images = await this.#slideImages(markdown.join("\n\n"));
    return await this.#editInPlace(id, "presentation", edits, options, async bytes => {
      const result = await editPptx(bytes, edits, images ? { images } : {});
      return {
        bytes: result.bytes,
        changes: result.changes.map(change => ({
          slide: change.slide, ...(change.notes ? { notes: true } : {}),
          ...(change.before !== undefined ? { before: change.before } : {}), after: change.after ?? change.summary,
        })),
      };
    });
  }

  /**
   * An in-place edit of a Word document or deck: the edit runs here, on the file's current bytes, and
   * is proposed as a replace that shows the approver only what changed. So it refuses to build on a
   * pending replace: approving it would also write that replace's content, which this one never shows.
   */
  async #editInPlace(
    id: string, kind: "document" | "presentation", edits: readonly unknown[], options: ChangeOptions | undefined,
    edit: (bytes: Uint8Array, author: string) => Promise<{ bytes: Uint8Array; changes: EditChange[]; trackChanges?: boolean }>,
  ): Promise<DriveEntry> {
    id = this.resolved(id);
    this.#requireWrite();
    const ext = kind === "document" ? "docx" : "pptx";
    if (edits.length === 0) throw new Error("Pass at least one edit.");
    if (edits.length > MAX_EDITS) throw new Error(`Pass at most ${MAX_EDITS} edits at once.`);
    return await this.ctx.host.prepareExclusively(async () => {
      const { item, target, entry } = await this.#itemTarget(id, { top: "allowed" });
      if (item.kind !== "file" || extensionOf(item.name) !== ext) {
        throw new Error(kind === "document"
          ? "editDocument edits Word documents (.docx). Use replaceFile for other files."
          : "editPresentation edits PowerPoint decks (.pptx). Use replaceFile for other files.");
      }
      if (item.size !== undefined && item.size > MAX_READ_BYTES) {
        throw new Error(`The file is larger than the ${MAX_READ_BYTES / (1024 * 1024)} MB that can be edited here.`);
      }
      this.#requireNoPendingChange(entry.id, kind);
      const [current, shown, owner] = await Promise.all([
        this.ctx.host.read(api => api.download(`/drives/${item.driveId}/items/${item.id}/content`, MAX_READ_BYTES)).then(download => download.bytes),
        this.fileVersion(item), this.ctx.host.owner(),
      ]);
      // Whether a find matched says what the file holds, so the edit counts as reading it.
      await this.ctx.observe("Read a SharePoint file", `Read the content of ${md(entry.path || entry.name)} to edit it.`,
        units.fileRead({ driveId: item.driveId, itemId: item.id }, shown.version, shown.moderation));
      const result = await edit(current, `${owner.name} (agent)`).catch(error => { throw editFailure(error); });
      if (result.bytes.byteLength > MAX_UPLOAD_BYTES) throw new Error(`Files can be at most ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB.`);
      const ifMatch = ifUnchanged(options) ?? item.cTag;
      const file = await this.ctx.host.capture(result.bytes);
      const mimeType = item.mimeType ?? mimeTypeFor(item.name, result.bytes);
      await this.ctx.host.submit(this.ctx.queue, "replaceFile", {
        target, file, mimeType,
        edit: { kind, ...shownChanges(result.changes), ...(result.trackChanges !== undefined ? { trackChanges: result.trackChanges } : {}) },
        ...(ifMatch ? { ifMatch } : {}), submittedAt: Date.now(),
      });
      return { ...entry, size: result.bytes.byteLength, mimeType, pending: "replace" };
    });
  }

  async updateCells(id: string, worksheet: string, address: string, values: CellValue[][], options?: ChangeOptions): Promise<DriveEntry> {
    id = this.resolved(id);
    this.#requireWrite();
    if (worksheet.trim() === "") throw new Error("Name the worksheet to change.");
    const range = parseCellRange(address);
    checkShape(range, values);
    if (rangeRows(range) * rangeColumns(range) > MAX_UPDATED_CELLS) {
      throw new Error(`Change at most ${MAX_UPDATED_CELLS.toLocaleString("en-US")} cells at once.`);
    }
    values.forEach((row, rowIndex) => row.forEach((value, columnIndex) => checkCell(value, cellAt(formatRange(range), rowIndex, columnIndex))));
    return await this.ctx.host.prepareExclusively(async () => {
      const { item, target, entry } = await this.#itemTarget(id, { top: "allowed" });
      if (item.kind !== "file" || extensionOf(item.name) !== "xlsx") {
        throw new Error("updateCells changes Excel workbooks (.xlsx). Use replaceFile for other files.");
      }
      this.#requireNoPendingChange(entry.id, "workbook");
      const ref = { driveId: item.driveId, itemId: item.id };
      const [sheets, shown] = await Promise.all([this.ctx.host.read(api => reads.listWorksheets(api, ref)), this.fileVersion(item)]);
      await this.ctx.observe("Read a SharePoint workbook", `Read ${md(worksheet)}!${formatRange(range)} of ${md(entry.path || entry.name)} to change it.`,
        units.fileRead(ref, shown.version, shown.moderation));
      const sheet = sheets.find(candidate => candidate.name.toLowerCase() === worksheet.toLowerCase());
      if (sheet === undefined) {
        throw new Error(`This workbook has no worksheet named "${worksheet}". Its worksheets are: ${sheets.map(candidate => candidate.name).join(", ")}.`);
      }
      const current = await this.ctx.host.read(api => reads.readRange(api, ref, sheet.id, formatRange(range)));
      const before = (current.formulas ?? current.values).map(row => row.map(value =>
        value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value ?? null : String(value)));
      const ifMatch = ifUnchanged(options) ?? item.cTag;
      await this.ctx.host.submit(this.ctx.queue, "updateCells", {
        target, worksheet: sheet.name, sheetId: sheet.id, address: formatRange(range), values, before, ...(ifMatch ? { ifMatch } : {}), submittedAt: Date.now(),
      });
      return { ...entry, pending: "update" };
    });
  }

  async copyFile(id: string, folderId: string, name?: string): Promise<DriveEntry> {
    id = this.resolved(id);
    folderId = this.resolved(folderId);
    this.#requireWrite();
    return await this.ctx.host.prepareExclusively(async () => {
      const { item, target, entry } = await this.#itemTarget(id, { top: "allowed" });
      if (item.kind !== "file") throw new Error("Only files can be copied.");
      const copyName = checkName(name ?? entry.name);
      requireNotMadeOffice(entry.name, copyName);
      const parent = await this.#folderTarget(folderId);
      await this.#requireFreeName(parent, copyName);
      const ref = this.ctx.host.allocate("item");
      const submittedAt = Date.now();
      await this.ctx.host.submit(this.ctx.queue, "copyFile", {
        ref, source: target, parent, name: copyName,
        ...(item.size !== undefined ? { size: item.size } : {}), ...(item.mimeType ? { mimeType: item.mimeType } : {}), submittedAt,
      });
      return {
        id: ref, name: copyName, kind: "file", webUrl: "", path: join(parent.path, copyName), parentId: parent.id, libraryId: parent.driveId,
        ...(item.size !== undefined ? { size: item.size } : {}), ...(item.mimeType ? { mimeType: item.mimeType } : {}),
        createdAt: new Date(submittedAt).toISOString(), modifiedAt: new Date(submittedAt).toISOString(), pending: "create",
      };
    });
  }

  /** Encodes content for a file, reading the template it names, which counts as reading that file. */
  async #encode(name: string, content: string | Uint8Array | WorkbookRows, templateId: string | undefined): Promise<Encoded> {
    let template: Template | undefined;
    if (templateId !== undefined) {
      const item = await this.item(this.resolved(templateId));
      if (item.kind !== "file") throw new Error("The template must be a file.");
      checkTemplate(name, item.name);
      if (item.size !== undefined && item.size > MAX_READ_BYTES) throw new Error("The template is too large to use.");
      const [download, shown] = await Promise.all([
        this.ctx.host.read(api => api.download(`/drives/${item.driveId}/items/${item.id}/content`, MAX_READ_BYTES)), this.fileVersion(item),
      ]);
      const entry = await this.entry(item, this.overlay());
      await this.ctx.observe("Read a SharePoint file", `Read ${md(entry.path || entry.name)} to use as a template.`,
        units.fileRead({ driveId: item.driveId, itemId: item.id }, shown.version, shown.moderation));
      template = { name: item.name, bytes: download.bytes };
    }
    const images = typeof content === "string" && writtenAs(name) === "powerpoint" ? await this.#slideImages(content) : undefined;
    const owner = await this.ctx.host.owner();
    return await encodeContent(name, content, { ...(template ? { template } : {}), ...(images ? { images } : {}), author: owner.name })
      .catch(error => { throw editFailure(error); });
  }

  /**
   * The pictures a deck's Markdown places (`![alt](fileId)`), read from files the binding covers,
   * which counts as reading them.
   */
  async #slideImages(markdown: string): Promise<PptxImages | undefined> {
    const refs = slideImageRefs(markdown);
    if (refs.length === 0) return undefined;
    if (refs.length > MAX_SLIDE_IMAGES) throw new Error(`A deck can place at most ${MAX_SLIDE_IMAGES} pictures at once.`);
    const images = new Map<string, { bytes: Uint8Array; mimeType: "image/png" | "image/jpeg" | "image/gif" }>();
    for (const ref of refs) {
      let item: GraphDriveItem;
      try {
        item = await this.item(this.resolved(ref));
      } catch (error) {
        throw new Error(`The picture "${ref}" isn't a file this connection covers. Pictures are given by file ID, as from list() or search().`, { cause: error });
      }
      const mimeType = item.mimeType ?? "";
      if (item.kind !== "file" || !SLIDE_IMAGE_TYPES.has(mimeType)) throw new Error(`"${item.name}" isn't a PNG, JPEG or GIF picture.`);
      if (item.size !== undefined && item.size > MAX_SLIDE_IMAGE_BYTES) throw new Error(`"${item.name}" is larger than the ${MAX_SLIDE_IMAGE_BYTES / (1024 * 1024)} MB a slide picture can be.`);
      const [download, shown] = await Promise.all([
        this.ctx.host.read(api => api.download(`/drives/${item.driveId}/items/${item.id}/content`, MAX_SLIDE_IMAGE_BYTES)), this.fileVersion(item),
      ]);
      const entry = await this.entry(item, this.overlay());
      await this.ctx.observe("Read a SharePoint file", `Read ${md(entry.path || entry.name)} to place it on a slide.`,
        units.fileRead({ driveId: item.driveId, itemId: item.id }, shown.version, shown.moderation));
      images.set(ref, { bytes: download.bytes, mimeType: mimeType as "image/png" | "image/jpeg" | "image/gif" });
    }
    return images;
  }

  /**
   * Refuses a second change to a file's content while one awaits approval. The second could only
   * be fenced on the first landing, and shown against content that may never land: if the first
   * were rejected, it would apply unfenced, and the approver's diff would have been against nothing.
   */
  #requireNoPendingChange(id: string, what: string): void {
    const overlay = this.overlay();
    if (overlay.pendingContent(id) !== undefined || overlay.pendingCells(id).length > 0) {
      throw new Error(`A change to this ${what} is already awaiting approval. Wait for it to be decided before changing it again.`);
    }
  }

  async rename(id: string, name: string, options?: ChangeOptions): Promise<DriveEntry> {
    id = this.resolved(id);
    this.#requireWrite();
    checkName(name);
    return await this.ctx.host.prepareExclusively(async () => {
      const { item, target, entry } = await this.#itemTarget(id);
      if (name === entry.name) return entry;
      if (item.kind === "file") requireNotMadeOffice(entry.name, name);
      const parent = parentPath(entry.path);
      if (item.parentId !== undefined) {
        const parentEntryId = entry.parentId ?? encodeItemRef({ driveId: item.driveId, itemId: item.parentId });
        await this.#requireFreeName({ id: parentEntryId, driveId: item.driveId, name: "this folder", location: "", path: parent }, name, entry.id);
      }
      await this.ctx.host.submit(this.ctx.queue, "rename", {
        target, name, ...fenceOf(options), submittedAt: Date.now(),
      });
      return { ...entry, name, path: join(parent, name), pending: "rename" };
    });
  }

  async move(id: string, folderId: string, options?: ChangeOptions): Promise<DriveEntry> {
    id = this.resolved(id);
    folderId = this.resolved(folderId);
    this.#requireWrite();
    return await this.ctx.host.prepareExclusively(async () => {
      const { item, target, entry } = await this.#itemTarget(id);
      const to = await this.#folderTarget(folderId);
      if (to.driveId !== item.driveId) throw new Error("Files can only be moved within their own library.");
      if (to.id === entry.parentId) return entry;
      if (to.id === entry.id || (item.kind === "folder" && (to.path === entry.path || to.path.startsWith(`${entry.path}/`)))) {
        throw new Error("A folder can't be moved into itself.");
      }
      await this.#requireFreeName(to, entry.name, entry.id);
      await this.ctx.host.submit(this.ctx.queue, "move", {
        target,
        from: { id: entry.parentId ?? encodeItemRef({ driveId: item.driveId, itemId: item.parentId ?? "root" }), location: target.location || parentPath(entry.path) },
        to, ...fenceOf(options), submittedAt: Date.now(),
      });
      return { ...entry, parentId: to.id, path: join(to.path, entry.name), pending: "move" };
    });
  }

  async delete(id: string, options?: ChangeOptions): Promise<void> {
    id = this.resolved(id);
    this.#requireWrite();
    return await this.ctx.host.prepareExclusively(async () => {
      const { item, target } = await this.#itemTarget(id);
      // A file is fenced on its content, so a colleague's edit since this read is never binned unseen;
      // a change of ours awaiting approval would move that, so the deletion waits for it.
      this.#requireNoPendingChange(encodeItemRef(target.ref), item.kind === "file" ? "file" : "folder");
      const ifMatch = ifUnchanged(options) ?? (item.kind === "file" ? item.cTag : undefined);
      await this.ctx.host.submit(this.ctx.queue, "deleteItem", { target, ...(ifMatch ? { ifMatch } : {}), submittedAt: Date.now() });
    });
  }
}

/**
 * A file's bytes are checked on upload as what its name says they are (`encodeContent`), so a
 * rename or copy can't turn them into an Office file unchecked: a workbook refused for a formula
 * that reaches out would otherwise go up as a .zip and be renamed.
 */
function requireNotMadeOffice(from: string, to: string): void {
  if (isOfficeName(to) && extensionOf(to) !== extensionOf(from)) {
    throw new Error(`A file can't be renamed or copied into an Office format here. To make it ${extensionOf(to) ? `a .${extensionOf(to)}` : "one"}, upload it under that name, so its content is checked as one.`);
  }
}
