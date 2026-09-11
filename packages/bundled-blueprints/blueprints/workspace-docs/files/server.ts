// The document's Durable Object. The collaboration plumbing -- the mutation
// queue, the subscribed browsers, and the per-block optimistic concurrency --
// is the sync library's; the block model, the ordering rule, the legacy
// conversion and the Markdown export are this gadget's own.
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import {
  type Collaborator,
  MutationQueue,
  SubscriberRegistry,
  type VersionConflict,
  applyVersioned,
  normalizeBaseVersion,
  normalizeCollaborator,
  operationStatus,
} from "@gadgets/bundled-blueprints/libraries/sync/server";
import type {
  ApplyOperationResult,
  BlockUpsert,
  DocPresenceEvent,
  DocumentEvent,
  DocumentInit,
  DocumentSnapshot,
  GadgetStub,
  GoogleDocInfo,
  GoogleDocMetadata,
  GoogleDocSyncResult,
  Operation,
  OperationEvent,
  PresenceUpdate,
  StoredBlock,
  StoredDocument,
  SubscriberCallbacks,
} from "./lib/protocol.ts";

const DEFAULT_TITLE = "Untitled document";

// The optional Google Doc binding a deployment may configure, as this gadget uses it: a Doc's
// metadata and its Markdown content, and the two writes that replace or extend that content.
interface GoogleDocBinding {
  getMetadata(): Promise<GoogleDocMetadata>;
  getContent(): Promise<string>;
  appendText(markdown: string): Promise<unknown>;
  replaceText(oldMarkdown: string, newMarkdown: string): Promise<unknown>;
}

/** The bindings this Durable Object may be given; there are none it requires. */
interface GadgetEnv {
  GOOGLE_DOC?: GoogleDocBinding;
}

/** An object as it arrives over RPC, before its fields are checked. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// Props is `unknown` so that `ctx` is the plain `DurableObjectState` the constructor receives.
export class Gadget extends DurableObject<GadgetEnv, unknown> implements GadgetStub {
  mutations: MutationQueue;
  subscribers: SubscriberRegistry<SubscriberCallbacks, Collaborator>;

  constructor(ctx: DurableObjectState, env: GadgetEnv) {
    super(ctx, env);
    this.ctx = ctx;
    // RPC calls may overlap at await points. Chain mutations so each operation
    // observes and commits one authoritative document state in strict order.
    this.mutations = new MutationQueue();
    // Presence is announced in this gadget's own callback vocabulary: a caret
    // with no position yet on arrival, and a bare id on departure.
    this.subscribers = new SubscriberRegistry({
      join: (subscriber, who) => subscriber.presence({
        type: "join", clientId: who.clientId, name: who.name, color: who.color, blockId: null,
      }),
      leave: (subscriber, who) => subscriber.presence({ type: "leave", clientId: who.clientId }),
    });
  }

  async loadDocument(): Promise<DocumentSnapshot> {
    let doc = await this.ctx.storage.get<StoredDocument>("document:v2");
    if (doc) return doc;

    // Keep old documents readable. The first v2 client converts the legacy HTML
    // into stable top-level blocks and calls initializeBlocks().
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
    const cleanTitle = String(title || DEFAULT_TITLE);

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
    const previousById = new Map((previous?.blocks || []).map((block): [string, StoredBlock] => [block.id, block]));
    const cleanBlocks = sanitizeBlocks(blocks);
    const document: StoredDocument = {
      revision: (previous?.revision || 0) + 1,
      title: String(title || DEFAULT_TITLE),
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

    const outcome = applyVersioned(doc.blocks, {
      upserts: sanitizeBlocks(operation.upserts || []),
      deletes: (operation.deletes || []).map((deletion) => ({
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
    // A rejection travels as the authoritative block, which the client rebases
    // its draft onto. An upsert naming a block someone else deleted has nothing
    // to rebase onto and is dropped instead: the client re-creates it from its
    // draft on the next save, with no base version.
    const conflicts = outcome.conflicts
      .filter((conflict): conflict is Extract<VersionConflict<StoredBlock>, { reason: "stale" }> => conflict.reason === "stale")
      .map((conflict) => conflict.current);

    // Ordering is intentionally last-writer-wins. Text/content remains guarded
    // by per-block versions, while inserts, moves and list restructuring stay
    // responsive and deterministic.
    const requestedOrder = Array.isArray(operation.order) ? operation.order.map(String) : [];
    const order: string[] = [];
    const seen = new Set<string>();
    for (const id of requestedOrder) {
      if (byId.has(id) && !seen.has(id)) { order.push(id); seen.add(id); }
    }
    for (const block of doc.blocks) {
      if (byId.has(block.id) && !seen.has(block.id)) { order.push(block.id); seen.add(block.id); }
    }
    for (const id of byId.keys()) {
      if (!seen.has(id)) order.push(id);
    }

    const titleChanged = typeof operation.title === "string" && operation.title !== doc.title;
    const changed = outcome.changed || titleChanged ||
      order.join("\n") !== doc.blocks.map((b) => b.id).join("\n");

    if (!changed) {
      return { status: operationStatus(false, conflicts), revision: doc.revision, conflicts };
    }

    doc = {
      revision: doc.revision + 1,
      title: typeof operation.title === "string" ? operation.title : doc.title,
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

  async subscribe(callback: SubscriberCallbacks, client: Partial<Collaborator> = {}): Promise<DocumentSnapshot> {
    // The registry keeps the stub, seeds the newcomer with everyone already
    // connected, announces it to them, and drops it when its connection breaks.
    this.subscribers.add(callback, normalizeCollaborator(client));
    return this.loadDocument();
  }

  async updatePresence(presence: PresenceUpdate): Promise<void> {
    // The same normalization as the join, so a cursor is keyed as its join was.
    const event: DocPresenceEvent = {
      type: "cursor",
      ...normalizeCollaborator(presence),
      // Anchor/focus endpoints let clients render both a caret and highlighted
      // selections, including selections spanning multiple top-level blocks.
      anchorBlockId: presence.anchorBlockId ? String(presence.anchorBlockId) : null,
      anchorOffset: Math.max(0, Number(presence.anchorOffset || 0)),
      focusBlockId: presence.focusBlockId ? String(presence.focusBlockId) : null,
      focusOffset: Math.max(0, Number(presence.focusOffset || 0)),
      at: Date.now(),
    };
    this.broadcastPresence(event);
  }

  // Best-effort fast path for pagehide. Clients also expire stale presence via
  // heartbeats because browsers cannot guarantee that unload RPC completes.
  async leavePresence(clientId: string): Promise<void> {
    this.broadcastPresence({
      type: "leave",
      clientId: normalizeCollaborator({ clientId }).clientId,
      at: Date.now(),
    });
  }

  // Delivery is the registry's: issued at once and never awaited, so a slow or
  // failing browser holds up neither the mutation nor the other subscribers.
  broadcast(event: DocumentEvent): void {
    this.subscribers.broadcast((subscriber) => subscriber.operation(event));
  }

  broadcastPresence(event: DocPresenceEvent): void {
    this.subscribers.broadcast((subscriber) => subscriber.presence(event));
  }

  async getGoogleDocInfo(): Promise<GoogleDocInfo | null> {
    if (!this.env.GOOGLE_DOC) return null;
    const metadata = await this.env.GOOGLE_DOC.getMetadata();
    return { title: metadata.title, lastModified: metadata.lastModified };
  }

  async syncToGoogleDoc({ markdown }: { markdown: string }): Promise<GoogleDocSyncResult> {
    if (!this.env.GOOGLE_DOC) throw new Error("GOOGLE_DOC binding is not configured.");
    const next = String(markdown || "").trim() || " ";
    const current = await this.env.GOOGLE_DOC.getContent();
    if ((current || "").trim() === next.trim()) return { status: "unchanged" };
    if (!(current || "").trim()) await this.env.GOOGLE_DOC.appendText(next);
    else await this.env.GOOGLE_DOC.replaceText(current, next);
    return { status: "synced", metadata: await this.env.GOOGLE_DOC.getMetadata() };
  }
}

function sanitizeBlocks(blocks: unknown): BlockUpsert[] {
  if (!Array.isArray(blocks)) return [];
  const result: BlockUpsert[] = [];
  const seen = new Set<string>();
  for (const value of blocks as unknown[]) {
    const block = isRecord(value) ? value : null;
    const id = String(block?.id || "").slice(0, 100);
    const html = String(block?.html || "");
    if (!id || seen.has(id) || html.length > 10_000_000) continue;
    seen.add(id);
    result.push({ id, html, baseVersion: normalizeBaseVersion(block?.baseVersion) });
  }
  return result;
}


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
];

export class ExportHandler extends WorkerEntrypoint {
  async getExportFormats(): Promise<ExportFormat[]> {
    return DOC_EXPORT_FORMATS;
  }

  async export(gadget: GadgetStub, id: string): Promise<ReadableStream<Uint8Array>> {
    if (id !== "markdown") throw new Error("Unsupported document export format: " + id);
    const document = await gadget.getDocument();
    const html = document.blocks
      ? document.blocks.map((block) => block.html).join("")
      : document.legacyContent || "";
    return new Response(htmlToMarkdown(html)).body!;
  }
}

function htmlToMarkdown(html: string): string {
  const tokens = String(html).match(/<!--[\s\S]*?-->|<![^>]*>|<[^>]+>|[^<]+/g) || [];
  const lists: { type: "ul" | "ol"; count: number }[] = [];
  const links: string[] = [];
  const blockquotes: number[] = [];
  let markdown = "";
  let inPre = false;

  for (const token of tokens) {
    if (!token.startsWith("<")) {
      let text = decodeHtml(token);
      if (!inPre) {
        text = text.replace(/\s+/g, " ").replace(/([\\*_[\]])/g, "\\$1");
      }
      markdown += text;
      continue;
    }
    if (token.startsWith("<!--") || token.startsWith("<!")) continue;

    const match = /^<\s*(\/?)\s*([a-z0-9]+)([^>]*)>/i.exec(token);
    if (!match) continue;
    const closing = match[1] === "/";
    const tag = match[2].toLowerCase();
    const attributes = match[3];

    if (closing) {
      switch (tag) {
        case "h1": case "h2": case "h3": case "h4": case "h5": case "h6":
        case "p": case "div":
          markdown += "\n\n";
          break;
        case "blockquote": {
          const start = blockquotes.pop();
          const content = markdown.slice(start).trim().replace(/\n{3,}/g, "\n\n");
          const quoted = content
            ? content.split("\n").map((line) => line ? "> " + line : ">").join("\n")
            : ">";
          markdown = markdown.slice(0, start) + quoted + "\n\n";
          break;
        }
        case "strong": case "b": markdown += "**"; break;
        case "em": case "i": markdown += "*"; break;
        case "s": case "strike": case "del": markdown += "~~"; break;
        case "code": if (!inPre) markdown += "\x60"; break;
        case "pre": markdown += "\n\x60\x60\x60\n\n"; inPre = false; break;
        case "a": markdown += "](" + (links.pop() || "") + ")"; break;
        case "li": if (!markdown.endsWith("\n")) markdown += "\n"; break;
        case "ul": case "ol": lists.pop(); break;
        case "td": case "th": markdown += "\t"; break;
        case "tr": markdown += "\n"; break;
      }
      continue;
    }

    switch (tag) {
      case "h1": case "h2": case "h3": case "h4": case "h5": case "h6":
        markdown += "\n\n" + "#".repeat(Number(tag[1])) + " ";
        break;
      case "p": case "div": markdown += "\n\n"; break;
      case "br": markdown += "  \n"; break;
      case "strong": case "b": markdown += "**"; break;
      case "em": case "i": markdown += "*"; break;
      case "s": case "strike": case "del": markdown += "~~"; break;
      case "code": if (!inPre) markdown += "\x60"; break;
      case "pre": markdown += "\n\n\x60\x60\x60\n"; inPre = true; break;
      case "blockquote": markdown += "\n\n"; blockquotes.push(markdown.length); break;
      case "hr": markdown += "\n\n---\n\n"; break;
      case "ul": lists.push({ type: "ul", count: 0 }); break;
      case "ol": lists.push({ type: "ol", count: 0 }); break;
      case "li": {
        const list = lists.at(-1) || { type: "ul", count: 0 };
        list.count += 1;
        markdown += (markdown.endsWith("\n") ? "" : "\n") +
          "  ".repeat(Math.max(0, lists.length - 1)) +
          (list.type === "ol" ? list.count + ". " : "- ");
        break;
      }
      case "a": links.push(readHtmlAttribute(attributes, "href")); markdown += "["; break;
      case "img": {
        const alt = readHtmlAttribute(attributes, "alt").replace(/[\\[\]]/g, "\\$&");
        markdown += "![" + alt + "](" + readHtmlAttribute(attributes, "src") + ")";
        break;
      }
    }
  }

  const clean = markdown
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return clean ? clean + "\n" : "";
}

function readHtmlAttribute(source: string, name: string): string {
  const pattern = new RegExp(name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))", "i");
  const match = pattern.exec(source);
  return decodeHtml(match ? match[1] ?? match[2] ?? match[3] ?? "" : "");
}

function decodeHtml(value: string): string {
  return String(value).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_: string, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith("#x")) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
    if (lower.startsWith("#")) return String.fromCodePoint(Number.parseInt(lower.slice(1), 10));
    const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };
    return named[lower];
  });
}
