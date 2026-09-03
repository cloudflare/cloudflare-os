import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

const DEFAULT_TITLE = "Untitled document";

export class Gadget extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.subscribers = new Map();
    // RPC calls may overlap at await points. Chain mutations so each operation
    // observes and commits one authoritative document state in strict order.
    this.mutationQueue = Promise.resolve();
  }

  enqueueMutation(fn) {
    const result = this.mutationQueue.then(fn);
    this.mutationQueue = result.catch(() => {});
    return result;
  }

  async loadDocument() {
    let doc = await this.ctx.storage.get("document:v2");
    if (doc) return doc;

    // Keep old documents readable. The first v2 client converts the legacy HTML
    // into stable top-level blocks and calls initializeBlocks().
    const [content, title, lastModified] = await Promise.all([
      this.ctx.storage.get("content"),
      this.ctx.storage.get("title"),
      this.ctx.storage.get("lastModified"),
    ]);
    return {
      revision: 0,
      title: title ?? DEFAULT_TITLE,
      blocks: null,
      legacyContent: content ?? "",
      lastModified: lastModified ?? null,
    };
  }

  async getDocument() {
    return this.loadDocument();
  }

  initializeBlocks(args) {
    return this.enqueueMutation(() => this.initializeBlocksLocked(args));
  }

  async initializeBlocksLocked({ blocks, title, senderId }) {
    let current = await this.ctx.storage.get("document:v2");
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
    await this.broadcast({
      type: "snapshot",
      senderId,
      document: current,
    });
    return current;
  }

  // Explicit full-document writer for agents/importers. Unlike initializeBlocks,
  // this always applies, so callers never need to inspect revision state or
  // construct per-block applyOperation payloads just to populate a document.
  setDocument(args) {
    return this.enqueueMutation(() => this.setDocumentLocked(args));
  }

  async setDocumentLocked({ blocks, title, senderId }) {
    const previous = await this.ctx.storage.get("document:v2");
    const previousById = new Map((previous?.blocks || []).map((block) => [block.id, block]));
    const cleanBlocks = sanitizeBlocks(blocks);
    const document = {
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
    await this.broadcast({ type: "snapshot", senderId, document });
    return document;
  }

  // Apply a compact batch of block changes. The mutation queue is the single
  // authoritative order for all collaborators.
  applyOperation(operation) {
    return this.enqueueMutation(() => this.applyOperationLocked(operation));
  }

  async applyOperationLocked(operation) {
    let doc = await this.ctx.storage.get("document:v2");
    if (!doc) throw new Error("Document must be initialized first.");

    const byId = new Map(doc.blocks.map((block) => [block.id, block]));
    const accepted = [];
    const conflicts = [];

    for (const incoming of sanitizeBlocks(operation.upserts || [])) {
      const current = byId.get(incoming.id);
      const expected = Number(incoming.baseVersion || 0);
      if (current && expected !== current.version) {
        conflicts.push(current);
        continue;
      }
      if (!current && expected !== 0) continue;
      const next = { id: incoming.id, html: incoming.html, version: (current?.version || 0) + 1 };
      byId.set(next.id, next);
      accepted.push(next);
    }

    const deletedIds = [];
    for (const deletion of operation.deletes || []) {
      const id = String(deletion?.id || "");
      const current = byId.get(id);
      if (!current) continue;
      if (Number(deletion.baseVersion || 0) !== current.version) {
        conflicts.push(current);
        continue;
      }
      byId.delete(id);
      deletedIds.push(id);
    }

    // Ordering is intentionally last-writer-wins. Text/content remains guarded
    // by per-block versions, while inserts, moves and list restructuring stay
    // responsive and deterministic.
    const requestedOrder = Array.isArray(operation.order) ? operation.order.map(String) : [];
    const order = [];
    const seen = new Set();
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
    const changed = accepted.length || deletedIds.length || titleChanged ||
      order.join("\n") !== doc.blocks.map((b) => b.id).join("\n");

    if (!changed) {
      return { status: conflicts.length ? "conflict" : "unchanged", revision: doc.revision, conflicts };
    }

    doc = {
      revision: doc.revision + 1,
      title: typeof operation.title === "string" ? operation.title : doc.title,
      blocks: order.map((id) => byId.get(id)),
      lastModified: Date.now(),
    };
    await this.ctx.storage.put("document:v2", doc);

    const event = {
      type: "operation",
      senderId: operation.senderId,
      revision: doc.revision,
      title: doc.title,
      upserts: accepted,
      deletedIds,
      order,
      lastModified: doc.lastModified,
    };
    await this.broadcast(event);
    return {
      status: conflicts.length ? "conflict" : "applied",
      ...event,
      conflicts,
    };
  }

  async subscribe(callback, client = {}) {
    const dup = callback.dup();
    const existing = Array.from(this.subscribers.values());
    const info = {
      callback: dup,
      clientId: String(client.clientId || ""),
      name: String(client.name || "Guest").slice(0, 40),
      color: String(client.color || "#e1632e"),
    };
    this.subscribers.set(dup, info);
    dup.onRpcBroken(() => {
      this.subscribers.delete(dup);
      this.broadcastPresence({ type: "leave", clientId: info.clientId });
    });
    queueMicrotask(async () => {
      // Seed the newcomer with collaborators who were already connected.
      for (const person of existing) {
        try {
          await dup.presence({ type: "join", clientId: person.clientId, name: person.name, color: person.color, blockId: null });
        } catch (e) { break; }
      }
      await this.broadcastPresence({
        type: "join", clientId: info.clientId, name: info.name, color: info.color, blockId: null,
      });
    });
    return this.loadDocument();
  }

  async updatePresence(presence) {
    const event = {
      type: "cursor",
      clientId: String(presence.clientId || ""),
      name: String(presence.name || "Guest").slice(0, 40),
      color: String(presence.color || "#e1632e"),
      // Anchor/focus endpoints let clients render both a caret and highlighted
      // selections, including selections spanning multiple top-level blocks.
      anchorBlockId: presence.anchorBlockId ? String(presence.anchorBlockId) : null,
      anchorOffset: Math.max(0, Number(presence.anchorOffset || 0)),
      focusBlockId: presence.focusBlockId ? String(presence.focusBlockId) : null,
      focusOffset: Math.max(0, Number(presence.focusOffset || 0)),
      at: Date.now(),
    };
    await this.broadcastPresence(event);
  }

  // Best-effort fast path for pagehide. Clients also expire stale presence via
  // heartbeats because browsers cannot guarantee that unload RPC completes.
  async leavePresence(clientId) {
    await this.broadcastPresence({
      type: "leave",
      clientId: String(clientId || ""),
      at: Date.now(),
    });
  }

  async broadcast(event) {
    const calls = [];
    for (const [stub] of this.subscribers) {
      calls.push(Promise.resolve(stub.operation(event)).catch(() => this.subscribers.delete(stub)));
    }
    await Promise.all(calls);
  }

  async broadcastPresence(event) {
    const calls = [];
    for (const [stub] of this.subscribers) {
      calls.push(Promise.resolve(stub.presence(event)).catch(() => this.subscribers.delete(stub)));
    }
    await Promise.all(calls);
  }

  async getGoogleDocInfo() {
    if (!this.env.GOOGLE_DOC) return null;
    const metadata = await this.env.GOOGLE_DOC.getMetadata();
    return { title: metadata.title, lastModified: metadata.lastModified };
  }

  async syncToGoogleDoc({ markdown }) {
    if (!this.env.GOOGLE_DOC) throw new Error("GOOGLE_DOC binding is not configured.");
    const next = String(markdown || "").trim() || " ";
    const current = await this.env.GOOGLE_DOC.getContent();
    if ((current || "").trim() === next.trim()) return { status: "unchanged" };
    if (!(current || "").trim()) await this.env.GOOGLE_DOC.appendText(next);
    else await this.env.GOOGLE_DOC.replaceText(current, next);
    return { status: "synced", metadata: await this.env.GOOGLE_DOC.getMetadata() };
  }
}

function sanitizeBlocks(blocks) {
  if (!Array.isArray(blocks)) return [];
  const result = [];
  const seen = new Set();
  for (const value of blocks) {
    const id = String(value?.id || "").slice(0, 100);
    const html = String(value?.html || "");
    if (!id || seen.has(id) || html.length > 10_000_000) continue;
    seen.add(id);
    result.push({ id, html, baseVersion: Number(value?.baseVersion || 0) });
  }
  return result;
}


const DOC_EXPORT_FORMATS = [
  { id: "markdown", label: "Markdown", mode: "server", contentType: "text/markdown", fileExtension: ".md" },
  { id: "html", label: "HTML", mode: "browser", contentType: "text/html", fileExtension: ".html" },
  { id: "pdf", label: "PDF", mode: "browser", contentType: "application/pdf", fileExtension: ".pdf" },
];

export class ExportHandler extends WorkerEntrypoint {
  async getExportFormats() {
    return DOC_EXPORT_FORMATS;
  }

  async export(gadget, id) {
    if (id !== "markdown") throw new Error("Unsupported document export format: " + id);
    const document = await gadget.getDocument();
    const html = document.blocks
      ? document.blocks.map((block) => block.html).join("")
      : document.legacyContent || "";
    return new Response(htmlToMarkdown(html)).body;
  }
}

function htmlToMarkdown(html) {
  const tokens = String(html).match(/<!--[\s\S]*?-->|<![^>]*>|<[^>]+>|[^<]+/g) || [];
  const lists = [];
  const links = [];
  const blockquotes = [];
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

function readHtmlAttribute(source, name) {
  const pattern = new RegExp(name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))", "i");
  const match = pattern.exec(source);
  return decodeHtml(match ? match[1] ?? match[2] ?? match[3] ?? "" : "");
}

function decodeHtml(value) {
  return String(value).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_, entity) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith("#x")) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
    if (lower.startsWith("#")) return String.fromCodePoint(Number.parseInt(lower.slice(1), 10));
    return { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " }[lower];
  });
}
