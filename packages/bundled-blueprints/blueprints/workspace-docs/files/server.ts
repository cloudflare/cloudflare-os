// The document's Durable Object. The collaboration plumbing -- the mutation
// queue, the subscribed browsers, and the per-block optimistic concurrency --
// is the sync library's; the block model and its ordering rule, the legacy
// conversion, the block API (./lib/blocks.ts) and the exports (Markdown,
// ./lib/markdown.ts, and Word, ./lib/docx.ts) are this gadget's own.
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import {
  MutationQueue,
  SubscriberRegistry,
  applyVersioned,
  normalizeBaseVersion,
  operationStatus,
} from "@gadgets/bundled-blueprints/libraries/sync/server";
import type {
  ApplyOperationResult,
  BlockContent,
  BlockDescription,
  BlockEditResult,
  BlockPosition,
  BlockSource,
  BlockUpsert,
  DocFont,
  DocSettings,
  DocumentEvent,
  DocumentInit,
  DocumentSnapshot,
  GadgetStub,
  MissingBlock,
  Operation,
  OperationEvent,
  SettingsPatch,
  StoredBlock,
  StoredDocument,
  SubscribeSnapshot,
  SubscriberCallbacks,
  UpdateBlockArgs,
} from "./lib/protocol.ts";
import {
  CONTENT_FIELDS,
  TYPE_ALIASES,
  blockTypeOf,
  describeBlock,
  fallbackKind,
  indexOfBlock,
  isEmptyLine,
  isRecord,
  mergeBlockList,
  sameBlockHtml,
  newBlockId,
  repairBlockHtml,
  resolvePosition,
  retypeSpec,
  setItemChecked,
  specHtml,
  specsFrom,
  splitTopLevelHtml,
  stripUnsafe,
} from "./lib/blocks.ts";
import { DOCX_CONTENT_TYPE, documentToDocx } from "./lib/docx.ts";
import { expandImageRefs, htmlToMarkdown } from "./lib/markdown.ts";

const DEFAULT_TITLE = "Untitled document";
const MAX_TITLE_LENGTH = 500;

/**
 * The document the block API edits: the stored one, or -- for a legacy document with no content --
 * an empty one at revision 0 that is stored only once an edit changes it.
 */
type BlockDocument = Omit<StoredDocument, "lastModified"> & { lastModified: number | null };

// Props is `unknown` so that `ctx` is the plain `DurableObjectState` the constructor receives.
export class Gadget extends DurableObject<unknown, unknown> implements GadgetStub {
  mutations: MutationQueue;
  subscribers: SubscriberRegistry<SubscriberCallbacks, Record<string, never>>;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.ctx = ctx;
    // RPC calls may overlap at await points. Chain mutations so each operation
    // observes and commits one authoritative document state in strict order.
    this.mutations = new MutationQueue();
    // No presence: collaborators' edits sync live, but cursors and names are not shared.
    this.subscribers = new SubscriberRegistry();
    // A document an earlier Docs wrote is brought up to date before anything reads it.
    ctx.blockConcurrencyWhile(() => this.mutations.run(() => this.upgradeStoredLocked()));
  }

  // Quiet and idempotent: what earlier editors stored is rewritten in the current
  // shape (see upgradeStoredDocument) in one write, which replaces the old record
  // only once it is complete; a document that needs nothing is not written. A
  // document from before blocks is converted first (its legacy keys are kept). A
  // failure leaves the document as it was, for the next start to try again.
  async upgradeStoredLocked(): Promise<void> {
    try {
      const stored = await this.ctx.storage.get<StoredDocument>("document:v2");
      const doc = stored ?? await this.migrateLegacyLocked();
      if (doc.lastModified === null) return;
      const next = upgradeStoredDocument({ ...doc, lastModified: doc.lastModified });
      if (!next) return;
      await this.ctx.storage.put("document:v2", next);
      this.broadcast({ type: "snapshot", senderId: "upgrade", document: next });
    } catch (error) {
      console.error("Docs: could not upgrade the stored document", error);
    }
  }

  async loadDocument(): Promise<DocumentSnapshot> {
    const doc = await this.ctx.storage.get<StoredDocument>("document:v2");
    if (doc) return doc;

    // Old documents are converted to blocks at startup. If that failed, the
    // first editor converts the legacy HTML and calls initializeBlocks().
    const [content, title, lastModified] = await Promise.all([
      this.ctx.storage.get<string>("content"),
      this.ctx.storage.get<string>("title"),
      this.ctx.storage.get<number>("lastModified"),
    ]);
    return {
      revision: 0,
      title: title ?? DEFAULT_TITLE,
      blocks: null,
      legacyContent: content ?? "",
      lastModified: lastModified ?? null,
    };
  }

  async getDocument(): Promise<DocumentSnapshot> {
    return this.loadDocument();
  }

  initializeBlocks(args: DocumentInit): Promise<StoredDocument> {
    return this.mutations.run(() => this.initializeBlocksLocked(args));
  }

  async initializeBlocksLocked({ blocks, title, senderId }: DocumentInit): Promise<StoredDocument> {
    let current = await this.ctx.storage.get<StoredDocument>("document:v2");
    const cleanBlocks = sanitizeBlocks(blocks);
    const cleanTitle = cleanDocumentTitle(title);

    if (current) {
      // A newly opened client may win the initialization race by creating the
      // blank revision-1 shell before an agent seeds generated content. Treat
      // only that exact shell as replaceable; later empty documents may be an
      // intentional user edit and are never overwritten by initialization.
      const isBlankBootstrap = current.revision === 1 &&
        current.title === DEFAULT_TITLE && current.blocks.length === 0;
      const hasSeedContent = cleanBlocks.length > 0 || cleanTitle !== DEFAULT_TITLE;
      if (!isBlankBootstrap || !hasSeedContent) return current;
    }

    const now = Date.now();
    current = {
      revision: current ? current.revision + 1 : 1,
      title: cleanTitle,
      blocks: cleanBlocks.map((block) => ({ id: block.id, html: block.html, version: 1 })),
      lastModified: now,
    };
    await this.ctx.storage.put("document:v2", current);
    this.broadcast({
      type: "snapshot",
      senderId,
      document: current,
    });
    return current;
  }

  // Explicit full-document writer for agents/importers. Unlike initializeBlocks,
  // this always applies, so callers never need to inspect revision state or
  // construct per-block applyOperation payloads just to populate a document.
  setDocument(args: DocumentInit): Promise<StoredDocument> {
    return this.mutations.run(() => this.setDocumentLocked(args));
  }

  async setDocumentLocked({ blocks, title, senderId }: DocumentInit): Promise<StoredDocument> {
    const previous = await this.ctx.storage.get<StoredDocument>("document:v2");
    const previousById = new Map((previous?.blocks || []).map((block) => [block.id, block]));
    const cleanBlocks = sanitizeBlocks(blocks);
    const document: StoredDocument = {
      revision: (previous?.revision || 0) + 1,
      title: cleanDocumentTitle(title),
      blocks: cleanBlocks.map((block) => ({
        id: block.id,
        html: block.html,
        version: (previousById.get(block.id)?.version || 0) + 1,
      })),
      lastModified: Date.now(),
    };
    await this.ctx.storage.put("document:v2", document);
    this.broadcast({ type: "snapshot", senderId, document });
    return document;
  }

  // Apply a compact batch of block changes. The mutation queue is the single
  // authoritative order for all collaborators.
  applyOperation(operation: Operation): Promise<ApplyOperationResult> {
    return this.mutations.run(() => this.applyOperationLocked(operation));
  }

  async applyOperationLocked(operation: Operation): Promise<ApplyOperationResult> {
    let doc = await this.ctx.storage.get<StoredDocument>("document:v2");
    if (!doc) throw new Error("Document must be initialized first.");

    const outcome = applyVersioned<StoredBlock>(doc.blocks, {
      upserts: sanitizeBlocks(operation.upserts || []),
      deletes: (Array.isArray(operation.deletes) ? operation.deletes : []).map((deletion) => ({
        id: String(deletion?.id || ""),
        baseVersion: normalizeBaseVersion(deletion?.baseVersion),
      })),
    }, {
      // Every accepted upsert takes a new version, even one whose HTML already
      // matches what is stored: the reply is how a client learns which version
      // its draft now rests on, and a block left out of it would keep looking
      // unsaved to the sender.
      isUnchanged: () => false,
    });
    const byId = outcome.items;
    const { accepted, deletedIds } = outcome;
    // A "missing" conflict means the client believes a block exists that the
    // server no longer has. Report it so the client can forget its stale
    // version and re-create the block, instead of retrying forever.
    const conflicts = outcome.conflicts.map((conflict): StoredBlock | MissingBlock =>
      conflict.reason === "stale" ? conflict.current : { id: conflict.id, html: null, version: 0, missing: true });

    const requestedOrder = Array.isArray(operation.order) ? operation.order.map(String) : [];
    const order: string[] = [];
    const seen = new Set<string>();
    for (const id of requestedOrder) {
      if (byId.has(id) && !seen.has(id)) {
        order.push(id);
        seen.add(id);
      }
    }
    // Blocks the sender didn't know about yet (another collaborator or an
    // agent added them a moment ago) keep their place: each goes right after
    // the block it followed on the server, instead of falling to the end.
    let prevId: string | null = null;
    for (const block of doc.blocks) {
      if (!byId.has(block.id)) continue;
      if (!seen.has(block.id)) {
        order.splice(prevId === null ? 0 : order.indexOf(prevId) + 1, 0, block.id);
        seen.add(block.id);
      }
      prevId = block.id;
    }
    for (const id of byId.keys()) {
      if (!seen.has(id)) order.push(id);
    }

    const nextTitle = typeof operation.title === "string" ? operation.title.slice(0, MAX_TITLE_LENGTH) : doc.title;
    const titleChanged = nextTitle !== doc.title;
    const changed = outcome.changed || titleChanged ||
      order.join("\n") !== doc.blocks.map((b) => b.id).join("\n");
    if (!changed) {
      return { status: operationStatus(false, conflicts), revision: doc.revision, conflicts };
    }

    doc = {
      revision: doc.revision + 1,
      title: nextTitle,
      // `order` holds only ids of `byId`.
      blocks: order.map((id) => byId.get(id)!),
      lastModified: Date.now(),
    };
    await this.ctx.storage.put("document:v2", doc);

    const event: OperationEvent = {
      type: "operation",
      senderId: operation.senderId,
      revision: doc.revision,
      title: doc.title,
      upserts: accepted,
      deletedIds,
      order,
      lastModified: doc.lastModified,
    };
    this.broadcast(event);
    return {
      status: operationStatus(true, conflicts),
      ...event,
      conflicts,
    };
  }

  // `_client` is what an older editor said about itself; with no presence it is not kept.
  async subscribe(callback: SubscriberCallbacks, _client: unknown = {}): Promise<SubscribeSnapshot> {
    this.subscribers.add(callback, {});
    const [doc, settings] = await Promise.all([this.loadDocument(), this.getSettings()]);
    return { ...doc, settings };
  }

  // No presence (see README). An editor page from before that, still open
  // when the gadget updates, keeps reporting its caret: accept and drop it.
  async updatePresence(): Promise<void> {}
  async leavePresence(): Promise<void> {}

  // Shared, document-level presentation settings (typeface, width).
  async getSettings(): Promise<DocSettings> {
    return cleanSettings(await this.ctx.storage.get("settings"));
  }

  setSettings(patch: SettingsPatch): Promise<DocSettings> {
    return this.mutations.run(async () => {
      // An invalid field keeps the stored value.
      const current = await this.getSettings(), p = isRecord(patch) ? patch : {};
      const next: DocSettings = { font: isFont(p.font) ? p.font : current.font, wide: typeof p.wide === "boolean" ? p.wide : current.wide };
      await this.ctx.storage.put("settings", next);
      this.broadcast({ type: "settings", senderId: isRecord(patch) ? patch.senderId : undefined, settings: next });
      return next;
    });
  }

  // Delivery is the registry's: issued at once and never awaited, so a slow or
  // failing browser holds up neither the mutation nor the other subscribers.
  broadcast(event: DocumentEvent): void {
    this.subscribers.broadcast((subscriber) => subscriber.operation(event));
  }

  // ── Block API (for agents and scripts) ──────────────────────────────────
  // Every top-level element of the document is a block with a stable id; a
  // whole list is one block. Blocks can be described as simple specs, e.g.
  //   { type: "h2", text: "Plan" }
  //   { type: "todo", items: [{ text: "Ship it", checked: true }, "Tell people"] }
  // (text accepts inline **bold**, *italic*, `code`, ~~strike~~, [links](https://…)),
  // or as Markdown: { markdown: "## Plan\n- [ ] Ship it" } (may yield several blocks).
  // Changes reach open editors live, and an editor's unsaved typing in a
  // block is never overwritten (it is merged by the usual version checks).

  /** Every block in order: `{ id, type, markdown, version }`. */
  async listBlocks(): Promise<{ revision: number; blocks: BlockDescription[] }> {
    const doc = await this.loadBlockDocument();
    return { revision: doc.revision, blocks: doc.blocks.map((b) => describeBlock(b, false)) };
  }

  /** Blocks by id (or all), including their stored HTML. */
  async getBlocks({ ids }: { ids?: unknown } = {}): Promise<BlockDescription[]> {
    const doc = await this.loadBlockDocument();
    const wanted = Array.isArray(ids) ? new Set(ids.map(String)) : null;
    return doc.blocks.filter((b) => !wanted || wanted.has(b.id)).map((b) => describeBlock(b, true));
  }

  /** Insert blocks (`blocks: [spec]` and/or `markdown`) after/before a block, at an index, or at the end. */
  insertBlocks({ blocks, markdown, afterId, beforeId, index }: BlockSource & BlockPosition = {}): Promise<BlockEditResult> {
    return this.editBlocks((list) => {
      const created = specsFrom(expandImageRefs({ blocks, markdown }, list)).map((spec) => ({ id: newBlockId(), html: specHtml(spec) }));
      if (!created.length) throw new Error("Nothing to insert: pass blocks or markdown.");
      let at = resolvePosition(list, { afterId, beforeId, index });
      // A brand-new document is a single empty line: fill it rather than add below it.
      if (at === list.length && list.length === 1 && isEmptyLine(list[0].html) && afterId == null && index == null) {
        list.splice(0, 1);
        at = 0;
      }
      list.splice(at, 0, ...created);
      return created.map((b) => b.id);
    });
  }

  /** Replace one block's content (`spec` fields or `markdown`; extra Markdown blocks follow it). */
  updateBlock({ id, ...fields }: UpdateBlockArgs = {}): Promise<BlockEditResult> {
    return this.editBlocks((list) => {
      const at = indexOfBlock(list, id);
      let rest = expandImageRefs(fields, list);
      // Nothing but a type turns the block into that type, keeping its content;
      // nothing at all is a mistake, not a request to empty the block.
      if (!CONTENT_FIELDS.some((key) => rest[key] !== undefined)) {
        if (rest.type === undefined) throw new Error("Nothing to update: pass block fields or markdown.");
        rest = retypeSpec(list[at].html, rest.type);
      }
      // New text without a type keeps the block's type (a heading stays a heading).
      // Fields that only make sense for one kind (rows, src, block-level html)
      // say what the block becomes instead.
      if (rest.markdown === undefined && rest.type === undefined) {
        const current = blockTypeOf(list[at].html);
        if (Array.isArray(rest.items)) rest.type = current === "ol" || current === "todo" ? current : "ul";
        else if (fallbackKind(rest) === "p") rest.type = TYPE_ALIASES[current] && current !== "image" && current !== "divider" ? current : "p";
      }
      const specs = specsFrom({ blocks: rest.markdown === undefined ? [rest] : undefined, markdown: rest.markdown });
      if (!specs.length) throw new Error("Nothing to update: pass block fields or markdown.");
      const [first, ...more] = specs;
      list[at] = { ...list[at], html: specHtml(first) };
      const added = more.map((spec) => ({ id: newBlockId(), html: specHtml(spec) }));
      list.splice(at + 1, 0, ...added);
      return [list[at].id, ...added.map((b) => b.id)];
    });
  }

  /** Check or uncheck one item of a to-do list block (`item` is its 0-based index among top-level items). */
  setChecked({ id, item = 0, checked = true }: { id?: unknown; item?: unknown; checked?: unknown } = {}): Promise<BlockEditResult> {
    return this.editBlocks((list) => {
      const at = indexOfBlock(list, id);
      list[at] = { ...list[at], html: setItemChecked(list[at].html, Number(item), !!checked) };
      return [list[at].id];
    });
  }

  deleteBlocks({ ids }: { ids?: unknown } = {}): Promise<BlockEditResult> {
    return this.editBlocks((list) => {
      if (ids === undefined || ids === null) throw new Error("Pass ids: the blocks to delete.");
      const gone = new Set((Array.isArray(ids) ? ids : [ids]).map(String));
      for (const id of gone) indexOfBlock(list, id);
      const kept = list.filter((b) => !gone.has(b.id));
      list.splice(0, list.length, ...(kept.length ? kept : [{ id: newBlockId(), html: "<p><br></p>" }]));
      return [];
    });
  }

  /** Move blocks (kept in their current relative order) after/before another block, or to an index. */
  moveBlocks({ ids, afterId, beforeId, index }: { ids?: unknown } & BlockPosition = {}): Promise<BlockEditResult> {
    return this.editBlocks((list) => {
      if (ids === undefined || ids === null) throw new Error("Pass ids: the blocks to move.");
      const moving = new Set((Array.isArray(ids) ? ids : [ids]).map(String));
      for (const id of moving) indexOfBlock(list, id);
      if (moving.has(String(afterId)) || moving.has(String(beforeId))) throw new Error("A block can't be moved next to itself.");
      const picked = list.filter((b) => moving.has(b.id));
      const rest = list.filter((b) => !moving.has(b.id));
      rest.splice(resolvePosition(rest, { afterId, beforeId, index }), 0, ...picked);
      list.splice(0, list.length, ...rest);
      return picked.map((b) => b.id);
    });
  }

  /** Replace the whole document with Markdown (or specs). */
  setMarkdown({ markdown, blocks, title, replace }: BlockSource & { title?: unknown; replace?: unknown } = {}): Promise<BlockEditResult> {
    return this.editBlocks((list, doc) => {
      const specs = specsFrom(expandImageRefs({ blocks, markdown }, list));
      const htmls = (specs.length ? specs : [{ type: "p", text: "" }]).map(specHtml);
      // Open editors keep no undo for it, so replacing content takes an explicit `replace: true`.
      const empty = list.every((b) => isEmptyLine(b.html));
      const same = htmls.length === list.length && htmls.every((html, i) => sameBlockHtml(list[i].html, html));
      if (!empty && !same && replace !== true) {
        throw new Error("setMarkdown replaces the whole document, which already has content. Edit it with updateBlock / insertBlocks / deleteBlocks, or pass replace: true if the user asked to replace it.");
      }
      // Not a wipe-and-replace: unchanged blocks keep their ids, changed ones
      // are updated in place, and only the rest is inserted or removed -- so
      // open editors (and anyone typing) see just what actually changed.
      const next = mergeBlockList(list, htmls);
      list.splice(0, list.length, ...next);
      if (typeof title === "string") doc.title = title.slice(0, MAX_TITLE_LENGTH);
      return next.map((b) => b.id);
    });
  }

  /** The whole document as Markdown, long `data:` images abbreviated as in `listBlocks`. */
  async getMarkdown(): Promise<string> {
    const doc = await this.loadBlockDocument();
    return htmlToMarkdown(doc.blocks.map((b) => b.html).join(""), { abbreviateImages: true });
  }

  // `locked`: already inside the mutation queue (editBlocks).
  async loadBlockDocument(locked = false): Promise<BlockDocument> {
    const doc = await this.ctx.storage.get<StoredDocument>("document:v2");
    if (doc) return doc;
    return locked ? this.migrateLegacyLocked() : this.mutations.run(() => this.migrateLegacyLocked());
  }

  // A document from before blocks (the legacy `content` HTML) is converted
  // here when the block API reaches it before any editor has: one block per
  // top-level element, as the editor's own conversion makes them.
  async migrateLegacyLocked(): Promise<BlockDocument> {
    const existing = await this.ctx.storage.get<StoredDocument>("document:v2");
    if (existing) return existing;
    const legacy = await this.loadDocument();
    const content = stripUnsafe(String((legacy.blocks === null && legacy.legacyContent) || "")).trim();
    const empty: BlockDocument = { revision: 0, title: legacy.title || DEFAULT_TITLE, blocks: [], lastModified: null };
    if (!content) return empty;
    const doc: StoredDocument = { ...empty, revision: 1, blocks: splitTopLevelHtml(content).map((html) => ({ id: newBlockId(), html, version: 1 })), lastModified: Date.now() };
    await this.ctx.storage.put("document:v2", doc);
    this.broadcast({ type: "snapshot", senderId: "agent", document: doc });
    return doc;
  }

  // Runs `edit(list, doc)` on a copy of the block list inside the mutation
  // queue, then stores and broadcasts exactly what changed, versioned like
  // any other edit.
  editBlocks(edit: (list: BlockContent[], draft: { title: string }) => string[]): Promise<BlockEditResult> {
    return this.mutations.run(async (): Promise<BlockEditResult> => {
      const doc = await this.loadBlockDocument(true);
      const before = new Map(doc.blocks.map((b) => [b.id, b]));
      const list = doc.blocks.map((b) => ({ id: b.id, html: b.html }));
      const draft = { title: doc.title };
      const ids = edit(list, draft) || [];
      const upserts: StoredBlock[] = [];
      const blocks = list.map((b) => {
        const old = before.get(b.id);
        if (old && sameBlockHtml(old.html, b.html)) return old;
        const next = { id: b.id, html: b.html, version: (old?.version || 0) + 1 };
        upserts.push(next);
        return next;
      });
      const keptIds = new Set(blocks.map((b) => b.id));
      const deletedIds = doc.blocks.filter((b) => !keptIds.has(b.id)).map((b) => b.id);
      const order = blocks.map((b) => b.id);
      const changed = upserts.length || deletedIds.length || draft.title !== doc.title ||
        order.join("\n") !== doc.blocks.map((b) => b.id).join("\n");
      if (!changed) return { status: "unchanged", revision: doc.revision, ids };
      const next: StoredDocument = { revision: doc.revision + 1, title: draft.title, blocks, lastModified: Date.now() };
      await this.ctx.storage.put("document:v2", next);
      if (doc.revision === 0) this.broadcast({ type: "snapshot", senderId: "agent", document: next });
      else this.broadcast({ type: "operation", senderId: "agent", revision: next.revision, title: next.title, upserts, deletedIds, order, lastModified: next.lastModified });
      return { status: "applied", revision: next.revision, ids };
    });
  }
}

/* ── Documents from earlier editors ─────────────────────────────────────── */

/**
 * `doc` as the current editor shows it, or null when it already is. Earlier Docs editors stored
 * blocks that don't survive an HTML parse: a list inside a paragraph, a bare image (see
 * repairBlockHtml). The first block a repair yields keeps the id, at a new version; the rest are
 * new blocks after it. The old title field's text is left in `title`: it named the document, like
 * the gadget's own name now does, and was never part of the page or its exports.
 */
export function upgradeStoredDocument(doc: StoredDocument): StoredDocument | null {
  let changed = false;
  const blocks: StoredBlock[] = [];
  for (const block of doc.blocks) {
    const pieces = repairBlockHtml(block.html);
    if (pieces.length === 1 && pieces[0] === block.html) {
      blocks.push(block);
      continue;
    }
    changed = true;
    pieces.forEach((html, i) => blocks.push(i ? { id: newBlockId(), html, version: 1 } : { ...block, html, version: block.version + 1 }));
  }
  return changed ? { ...doc, revision: doc.revision + 1, blocks } : null;
}

/* ── Settings and stored blocks ─────────────────────────────────────────── */

const FONTS = new Set<unknown>(["sans", "serif", "mono"] satisfies DocFont[]);
const isFont = (value: unknown): value is DocFont => FONTS.has(value);

function cleanDocumentTitle(title: unknown): string {
  return String(title || DEFAULT_TITLE).slice(0, MAX_TITLE_LENGTH);
}

function cleanSettings(value: unknown): DocSettings {
  const settings = isRecord(value) ? value : {};
  return { font: isFont(settings.font) ? settings.font : "sans", wide: settings.wide === true };
}

// The blocks of an incoming document or operation, as far as they can be
// trusted: a non-empty id (at most 100 characters) seen once, HTML under 10M
// characters with what the editor would scrub on display removed (so the
// exports, which read stored HTML, never see it), and a well-formed base
// version. The editor's own HTML passes through unchanged.
function sanitizeBlocks(blocks: unknown): BlockUpsert[] {
  if (!Array.isArray(blocks)) return [];
  const result: BlockUpsert[] = [];
  const seen = new Set<string>();
  for (const value of blocks) {
    const block = isRecord(value) ? value : null;
    const id = String(block?.id || "").slice(0, 100);
    const html = String(block?.html || "");
    if (!id || seen.has(id) || html.length > 1e7) continue;
    seen.add(id);
    result.push({ id, html: stripUnsafe(html), baseVersion: normalizeBaseVersion(block?.baseVersion) });
  }
  return result;
}

/* ── Exports ────────────────────────────────────────────────────────────── */

// An export format as the Workshop lists it: a `server` format is produced by ExportHandler.export,
// a `browser` one by the client, opened with `gadgetExportFormatId` set.
interface ExportFormat {
  id: string;
  label: string;
  mode: "server" | "browser";
  contentType: string;
  fileExtension: string;
}

const DOC_EXPORT_FORMATS: ExportFormat[] = [
  { id: "markdown", label: "Markdown", mode: "server", contentType: "text/markdown", fileExtension: ".md" },
  { id: "html", label: "HTML", mode: "browser", contentType: "text/html", fileExtension: ".html" },
  { id: "pdf", label: "PDF", mode: "browser", contentType: "application/pdf", fileExtension: ".pdf" },
  { id: "docx", label: "Word", mode: "server", contentType: DOCX_CONTENT_TYPE, fileExtension: ".docx" },
];

export class ExportHandler extends WorkerEntrypoint {
  async getExportFormats(): Promise<ExportFormat[]> {
    return DOC_EXPORT_FORMATS;
  }

  async export(gadget: GadgetStub, id: string): Promise<ReadableStream<Uint8Array>> {
    if (id !== "markdown" && id !== "docx") throw new Error("Unsupported document export format: " + id);
    const document = await gadget.getDocument();
    if (id === "docx") return documentToDocx(document, await gadget.getSettings());
    const html = document.blocks ? document.blocks.map((block) => block.html).join("") : document.legacyContent || "";
    return new Response(htmlToMarkdown(html)).body!;
  }
}
