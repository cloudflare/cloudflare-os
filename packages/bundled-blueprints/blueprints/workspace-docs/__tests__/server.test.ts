// @vitest-environment node
import { describe, expect, it } from "vitest";
import { ExportHandler, Gadget, upgradeStoredDocument } from "../files/server.ts";
import type { DocumentEvent, GadgetStub, StoredDocument, SubscriberCallbacks } from "../files/lib/protocol.ts";

// The Doc's Durable Object over in-memory storage: a real instance, over a state that is only the
// storage the gadget reads and writes -- the `cloudflare:workers` stub vitest.config.ts aliases in
// accepts it, where the runtime's base would refuse a state that is not a real DurableObjectState.
// `ready` settles once the constructor's blockConcurrencyWhile (the stored-document upgrade) has.
function inMemoryGadget(entries: Record<string, unknown> | Map<string, unknown> = {}) {
  const stored = entries instanceof Map ? entries : new Map<string, unknown>(Object.entries(entries));
  let ready: Promise<unknown> = Promise.resolve();
  const state = {
    storage: {
      get: async (key: string) => structuredClone(stored.get(key)),
      put: async (key: string, value: unknown) => { stored.set(key, structuredClone(value)); },
    },
    blockConcurrencyWhile: (fn: () => Promise<unknown>) => (ready = fn()),
  } as unknown as DurableObjectState;
  return { gadget: new Gadget(state, {}), stored, ready };
}

// A subscriber as the RPC layer delivers it: the client's callbacks plus the stub's own methods.
function subscriber() {
  const events: DocumentEvent[] = [];
  const callbacks: SubscriberCallbacks & { dup(): unknown; onRpcBroken(): void; [Symbol.dispose](): void } = {
    operation: (event) => { events.push(event); },
    presence: () => {},
    dup() { return this; },
    onRpcBroken: () => {},
    [Symbol.dispose]: () => {},
  };
  return { callbacks, events };
}

const stored = (map: Map<string, unknown>) => map.get("document:v2") as StoredDocument;
const init = { blocks: [{ id: "a", html: "<p>one</p>" }, { id: "b", html: "<p>two</p>" }], title: "Doc", senderId: "c1" };

describe("editor protocol", () => {
  it("initializes once, and lets seed content replace only the blank bootstrap", async () => {
    const { gadget } = inMemoryGadget();
    const blank = await gadget.initializeBlocks({ blocks: [], title: "", senderId: "c1" });
    expect(blank).toMatchObject({ revision: 1, title: "Untitled document", blocks: [] });

    const seeded = await gadget.initializeBlocks(init);
    expect(seeded).toMatchObject({ revision: 2, title: "Doc", blocks: [{ id: "a", version: 1 }, { id: "b", version: 1 }] });

    const again = await gadget.initializeBlocks({ blocks: [{ id: "z", html: "<p>late</p>" }], title: "Other", senderId: "c2" });
    expect(again).toEqual(seeded);
  });

  it("applies a versioned edit, broadcasts it, and reports a stale or missing block as a conflict", async () => {
    const { gadget } = inMemoryGadget();
    await gadget.initializeBlocks(init);
    const { callbacks, events } = subscriber();
    const snapshot = await gadget.subscribe(callbacks);
    expect(snapshot).toMatchObject({ revision: 1, settings: { font: "sans", wide: false } });

    const applied = await gadget.applyOperation({ senderId: "c1", upserts: [{ id: "a", html: "<p>ONE</p>", baseVersion: 1 }], order: ["a", "b"] });
    expect(applied).toMatchObject({ status: "applied", revision: 2, upserts: [{ id: "a", html: "<p>ONE</p>", version: 2 }], conflicts: [] });
    expect(events).toEqual([expect.objectContaining({ type: "operation", senderId: "c1", revision: 2, order: ["a", "b"] })]);

    const conflict = await gadget.applyOperation({
      senderId: "c2",
      upserts: [{ id: "a", html: "<p>stale</p>", baseVersion: 1 }, { id: "ghost", html: "<p>g</p>", baseVersion: 4 }],
    });
    expect(conflict).toEqual({
      status: "conflict",
      revision: 2,
      conflicts: [{ id: "a", html: "<p>ONE</p>", version: 2 }, { id: "ghost", html: null, version: 0, missing: true }],
    });
  });

  // The reply is how a client learns which version its draft rests on, so even an upsert whose
  // HTML matches what is stored takes a new version.
  it("versions every accepted upsert, changed or not", async () => {
    const { gadget } = inMemoryGadget();
    await gadget.initializeBlocks(init);
    const result = await gadget.applyOperation({ senderId: "c1", upserts: [{ id: "a", html: "<p>one</p>", baseVersion: 1 }] });
    expect(result).toMatchObject({ status: "applied", upserts: [{ id: "a", version: 2 }] });
  });

  // A block another collaborator added a moment ago keeps its place after the block it followed,
  // rather than falling to the end of the order the sender asked for.
  it("keeps blocks the sender didn't know about where they were", async () => {
    const { gadget, stored: map } = inMemoryGadget();
    await gadget.initializeBlocks(init);
    await gadget.applyOperation({ senderId: "c2", upserts: [{ id: "n", html: "<p>new</p>", baseVersion: 0 }], order: ["a", "n", "b"] });
    await gadget.applyOperation({ senderId: "c1", order: ["b", "a"] });
    expect(stored(map).blocks.map((block) => block.id)).toEqual(["b", "a", "n"]);
  });

  // The editor scrubs a block on display; what is stored is scrubbed too, for the exports.
  it("stores block HTML without unsafe markup, from every writer", async () => {
    const { gadget, stored: map } = inMemoryGadget();
    const unsafe = '<p onclick="x()" id="i">a<script>bad()</script><img src="data:image/png;base64,AA" onerror="y()"></p>';
    const clean = '<p>a<img src="data:image/png;base64,AA"></p>';
    await gadget.initializeBlocks({ blocks: [{ id: "a", html: unsafe }], title: "Doc", senderId: "c1" });
    expect(stored(map).blocks[0].html).toBe(clean);
    const applied = await gadget.applyOperation({ senderId: "c1", upserts: [{ id: "b", html: '<p><a href="javascript:x()">l</a></p>', baseVersion: 0 }], order: ["a", "b"] });
    expect(applied).toMatchObject({ upserts: [{ id: "b", html: "<p><a>l</a></p>", version: 1 }] });
    await gadget.setDocument({ blocks: [{ id: "a", html: unsafe }], title: "Doc", senderId: "c1" });
    expect(stored(map).blocks).toEqual([{ id: "a", html: clean, version: 2 }]);
  });

  it("changes the title, capped, and reports an operation that changes nothing as unchanged", async () => {
    const { gadget } = inMemoryGadget();
    await gadget.initializeBlocks(init);
    const titled = await gadget.applyOperation({ senderId: "c1", title: "x".repeat(600) });
    expect(titled.title).toHaveLength(500);
    expect(await gadget.applyOperation({ senderId: "c1", order: ["a", "b"] })).toEqual({ status: "unchanged", revision: 2, conflicts: [] });
  });

  it("refuses an operation on a document that was never initialized", async () => {
    const { gadget } = inMemoryGadget();
    await expect(gadget.applyOperation({ senderId: "c1" })).rejects.toThrow("Document must be initialized first.");
  });

  it("replaces the whole document with setDocument, dropping duplicate and empty ids", async () => {
    const { gadget } = inMemoryGadget();
    await gadget.initializeBlocks(init);
    const document = await gadget.setDocument({
      blocks: [{ id: "a", html: "<p>A</p>" }, { id: "a", html: "<p>dup</p>" }, { id: "", html: "<p>x</p>" }, { id: "c", html: "<p>C</p>" }],
      title: "",
      senderId: "agent",
    });
    expect(document).toMatchObject({ revision: 2, title: "Untitled document", blocks: [{ id: "a", html: "<p>A</p>", version: 2 }, { id: "c", version: 1 }] });
  });

  it("caps the title of a whole document, and ignores deletions that are not a list", async () => {
    const { gadget } = inMemoryGadget();
    expect((await gadget.initializeBlocks({ ...init, title: "x".repeat(600) })).title).toHaveLength(500);
    expect((await gadget.setDocument({ ...init, title: "y".repeat(600) })).title).toHaveLength(500);
    const deletes = "a" as unknown as [];
    expect(await gadget.applyOperation({ senderId: "c1", deletes, order: ["a", "b"] })).toMatchObject({ status: "unchanged" });
  });

  it("keeps shared settings clean, an invalid field keeping the stored value, and tells the other editors", async () => {
    const { gadget } = inMemoryGadget();
    const { callbacks, events } = subscriber();
    await gadget.subscribe(callbacks);
    expect(await gadget.setSettings({ font: "serif", senderId: "c1" })).toEqual({ font: "serif", wide: false });
    expect(await gadget.setSettings({ font: "comic" as "sans", wide: true })).toEqual({ font: "serif", wide: true });
    expect(events).toEqual([
      { type: "settings", senderId: "c1", settings: { font: "serif", wide: false } },
      { type: "settings", senderId: undefined, settings: { font: "serif", wide: true } },
    ]);
    expect(await gadget.getSettings()).toEqual({ font: "serif", wide: true });
  });

  // No presence (README); an editor from before that keeps calling it and must not fail.
  it("accepts and drops presence from older editors", async () => {
    const { gadget } = inMemoryGadget();
    await expect(gadget.updatePresence()).resolves.toBeUndefined();
    await expect(gadget.leavePresence()).resolves.toBeUndefined();
  });

  // One with content is converted as the object starts (see "documents from earlier editors").
  it("serves an empty document from before blocks as legacy content", async () => {
    const { gadget, ready } = inMemoryGadget({ title: "Old", lastModified: 5 });
    await ready;
    expect(await gadget.getDocument()).toEqual({ revision: 0, title: "Old", blocks: null, legacyContent: "", lastModified: 5 });
  });
});

describe("block API", () => {
  async function withMarkdown(markdown: string) {
    const memory = inMemoryGadget();
    await memory.gadget.setMarkdown({ markdown });
    const { blocks } = await memory.gadget.listBlocks();
    return { ...memory, blocks };
  }

  it("lists blocks with their type and Markdown, and gets them with their HTML", async () => {
    const { gadget, blocks } = await withMarkdown("# Plan\n\n- [ ] Ship it\n\nBody *text*");
    expect(blocks.map(({ type, markdown, version }) => ({ type, markdown, version }))).toEqual([
      { type: "h1", markdown: "# Plan", version: 1 },
      { type: "todo", markdown: "- [ ] Ship it", version: 1 },
      { type: "p", markdown: "Body *text*", version: 1 },
    ]);
    const [got] = await gadget.getBlocks({ ids: [blocks[2].id] });
    expect(got).toMatchObject({ id: blocks[2].id, html: "<p>Body <i>text</i></p>" });
    expect(await gadget.getMarkdown()).toBe("# Plan\n\n- [ ] Ship it\n\nBody *text*\n");
  });

  // A brand-new document is one empty line, which inserted content fills rather than follows.
  it("fills a new document's empty line, and inserts after, before or at an index", async () => {
    const { gadget } = inMemoryGadget();
    await gadget.initializeBlocks({ blocks: [{ id: "e", html: "<p><br></p>" }], title: "", senderId: "c1" });
    const { ids: [first] } = await gadget.insertBlocks({ markdown: "First" });
    const { ids: [last] } = await gadget.insertBlocks({ blocks: [{ type: "h2", text: "Last" }] });
    const { ids: [middle] } = await gadget.insertBlocks({ blocks: ["Middle"], afterId: first });
    const { ids: [top] } = await gadget.insertBlocks({ blocks: ["Top"], index: 0 });
    const { blocks } = await gadget.listBlocks();
    expect(blocks.map((block) => block.id)).toEqual([top, first, middle, last]);
    await expect(gadget.insertBlocks({})).rejects.toThrow("Nothing to insert: pass blocks or markdown.");
  });

  it("treats a null position like an absent one when filling a new document's empty line", async () => {
    const { gadget } = inMemoryGadget();
    await gadget.initializeBlocks({ blocks: [{ id: "e", html: "<p><br></p>" }], title: "", senderId: "c1" });
    await gadget.insertBlocks({ markdown: "Only", afterId: null, index: null });
    expect((await gadget.listBlocks()).blocks.map((block) => block.markdown)).toEqual(["Only"]);
  });

  it("updates a block's text keeping its type, or turns it into another type keeping its text", async () => {
    const { gadget, blocks } = await withMarkdown("## Heading\n\n- a\n- b");
    await gadget.updateBlock({ id: blocks[0].id, text: "Renamed" });
    await gadget.updateBlock({ id: blocks[1].id, type: "todo" });
    const html = (await gadget.getBlocks()).map((block) => block.html);
    expect(html).toEqual(["<h2>Renamed</h2>", '<ul class="checklist"><li>a</li><li>b</li></ul>']);
    await expect(gadget.updateBlock({ id: blocks[0].id })).rejects.toThrow("Nothing to update");
    await expect(gadget.updateBlock({ id: "nope", text: "x" })).rejects.toThrow("Unknown block id: nope");
  });

  it("puts extra Markdown blocks of an update right after the block", async () => {
    const { gadget, blocks } = await withMarkdown("one\n\ntwo");
    const result = await gadget.updateBlock({ id: blocks[0].id, markdown: "# A\n\nB" });
    expect(result.ids).toHaveLength(2);
    expect(await gadget.getMarkdown()).toBe("# A\n\nB\n\ntwo\n");
  });

  it("checks a to-do item", async () => {
    const { gadget, blocks } = await withMarkdown("- [ ] a\n- [ ] b");
    await gadget.setChecked({ id: blocks[0].id, item: 1 });
    expect(await gadget.getMarkdown()).toBe("- [ ] a\n- [x] b\n");
  });

  it("deletes blocks, leaving one empty line rather than nothing", async () => {
    const { gadget, blocks } = await withMarkdown("one\n\ntwo");
    await gadget.deleteBlocks({ ids: blocks[0].id });
    expect((await gadget.listBlocks()).blocks.map((block) => block.markdown)).toEqual(["two"]);
    await gadget.deleteBlocks({ ids: [blocks[1].id] });
    expect((await gadget.getBlocks()).map((block) => block.html)).toEqual(["<p><br></p>"]);
    await expect(gadget.deleteBlocks({})).rejects.toThrow("Pass ids");
  });

  it("moves blocks in their relative order", async () => {
    const { gadget, blocks } = await withMarkdown("a\n\nb\n\nc");
    await gadget.moveBlocks({ ids: [blocks[2].id, blocks[0].id], afterId: blocks[1].id });
    expect(await gadget.getMarkdown()).toBe("b\n\na\n\nc\n");
    await expect(gadget.moveBlocks({ ids: [blocks[0].id], afterId: blocks[0].id })).rejects.toThrow("next to itself");
  });

  // Open editors see just what changed: unchanged blocks keep their ids and versions.
  // The editor saves each block with its root's data-block-id; HTML from Markdown has none.
  it("keeps editor-saved blocks that setMarkdown leaves unchanged", async () => {
    const { gadget } = inMemoryGadget();
    await gadget.initializeBlocks({ blocks: [{ id: "a", html: '<p data-block-id="a">One</p>' }, { id: "b", html: '<p data-block-id="b">Two</p>' }], title: "Doc", senderId: "c1" });
    await gadget.setMarkdown({ markdown: "New\n\nOne\n\nTwo", replace: true });
    const { blocks } = await gadget.listBlocks();
    expect(blocks.map((b) => b.markdown.trim())).toEqual(["New", "One", "Two"]);
    expect(blocks.slice(1).map((b) => [b.id, b.version])).toEqual([["a", 1], ["b", 1]]);
  });

  it("replaces the document with setMarkdown, keeping unchanged blocks", async () => {
    const { gadget, blocks } = await withMarkdown("a\n\nb\n\nc");
    const result = await gadget.setMarkdown({ markdown: "a\n\nB\n\nc", title: "New", replace: true });
    const after = (await gadget.listBlocks()).blocks;
    expect(after.map((block) => [block.id, block.version])).toEqual([[blocks[0].id, 1], [blocks[1].id, 2], [blocks[2].id, 1]]);
    expect(result).toMatchObject({ status: "applied", ids: after.map((block) => block.id) });
    expect((await gadget.getDocument()).title).toBe("New");
    expect(await gadget.setMarkdown({ markdown: "a\n\nB\n\nc" })).toMatchObject({ status: "unchanged" });
  });

  // No editor can undo an agent's edit, so one call must not silently replace a document's content.
  it("refuses to replace a document that has content unless asked to", async () => {
    const { gadget } = await withMarkdown("keep\n\nthis");
    await expect(gadget.setMarkdown({ markdown: "# replaced" })).rejects.toThrow(/replace: true/);
    expect((await gadget.listBlocks()).blocks.map((block) => block.markdown)).toEqual(["keep", "this"]);
    await gadget.setMarkdown({ markdown: "# replaced", replace: true });
    expect((await gadget.listBlocks()).blocks.map((block) => block.markdown)).toEqual(["# replaced"]);
  });

  // Clearing a document in the editor leaves one empty line, saved with its block id.
  it("fills a document cleared in the editor", async () => {
    const cleared = () => inMemoryGadget({ "document:v2": { revision: 5, title: "", lastModified: 0, blocks: [{ id: "e", html: '<p data-block-id="e"><br></p>', version: 3 }] } });
    const filled = cleared();
    await filled.ready;
    await filled.gadget.setMarkdown({ markdown: "# New document" });
    expect((await filled.gadget.listBlocks()).blocks.map((block) => block.markdown)).toEqual(["# New document"]);
    const inserted = cleared();
    await inserted.ready;
    await inserted.gadget.insertBlocks({ markdown: "First" });
    expect((await inserted.gadget.listBlocks()).blocks.map((block) => block.markdown)).toEqual(["First"]);
  });

  // An agent edits a block by changing the Markdown listBlocks gave it; what it didn't change stays.
  it("keeps an inline image and spelled-out emphasis when a listed block comes back edited", async () => {
    const src = "data:image/png;base64," + "A".repeat(4096);
    const { gadget, ready } = inMemoryGadget({ "document:v2": { revision: 1, title: "", lastModified: 0, blocks: [
      { id: "a", html: `<p>Before<img class="doc-image" src="${src}" alt="Shot [1]">after</p>`, version: 1 },
      { id: "b", html: "<p>a<b>b</b>c text</p>", version: 1 },
    ] } });
    await ready;
    const { blocks } = await gadget.listBlocks();
    expect(blocks[1].markdown).toBe("a<strong>b</strong>c text");
    for (const block of blocks) await gadget.updateBlock({ id: block.id, markdown: block.markdown.replace("Before", "Earlier").replace("text", "edited") });
    const [image, bold] = await gadget.getBlocks();
    expect(image.html).toBe(`<p>Earlier<img class="doc-image" src="${src}" alt="Shot [1]">after</p>`);
    expect(bold.html).toBe("<p>a<b>b</b>c edited</p>");
  });

  // A screenshot's data: URI would cost an agent tens of thousands of tokens per read.
  it("abbreviates long data: images in its reads, and keeps the image when the reference comes back", async () => {
    const src = "data:image/png;base64," + "A".repeat(4096);
    const { gadget, blocks } = await withMarkdown(`intro\n\n![Shot](${src})\n\n![Tiny](data:image/gif;base64,R0lGOD)`);
    const [, image, tiny] = blocks;
    expect(image.markdown).toMatch(/^!\[Shot\]\(data:image\/png;… 3 KB #[0-9a-f]{8}\)$/);
    expect(tiny.markdown).toBe("![Tiny](data:image/gif;base64,R0lGOD)");
    expect(await gadget.getMarkdown()).toBe(`intro\n\n${image.markdown}\n\n${tiny.markdown}\n`);
    expect((await gadget.getBlocks({ ids: [image.id] }))[0].html).toContain(src);

    // Everything listBlocks gave back, edited around the image: the image itself is unchanged.
    const markdown = (await gadget.listBlocks()).blocks.map((block) => block.markdown).join("\n\n").replace("intro", "Intro");
    await gadget.setMarkdown({ markdown, replace: true });
    expect((await gadget.listBlocks()).blocks.map((block) => [block.id, block.version])).toEqual([[blocks[0].id, 2], [image.id, 1], [tiny.id, 1]]);
    await gadget.updateBlock({ id: image.id, src: image.markdown.slice("![Shot](".length, -1), alt: "Screenshot" });
    expect((await gadget.getBlocks({ ids: [image.id] }))[0].html).toContain(src);
    const copy = await gadget.insertBlocks({ markdown: image.markdown });
    expect((await gadget.getBlocks({ ids: copy.ids }))[0].html).toContain(src);

    // A reference to an image the document no longer holds is refused, not stored as the image.
    await gadget.deleteBlocks({ ids: [image.id, ...copy.ids] });
    await expect(gadget.insertBlocks({ markdown: image.markdown })).rejects.toThrow("no longer in the document");
    const { ids: [exported] } = await gadget.insertBlocks({ blocks: [{ type: "image", src }] });
    expect(exported).toBeTruthy();
    const handler = new ExportHandler({} as ExecutionContext, {});
    expect(await new Response(await handler.export(gadget as unknown as GadgetStub, "markdown")).text()).toContain(src);
  });

  it("broadcasts its edits to open editors as the agent's", async () => {
    const { gadget, blocks } = await withMarkdown("a");
    const { callbacks, events } = subscriber();
    await gadget.subscribe(callbacks);
    await gadget.updateBlock({ id: blocks[0].id, text: "b" });
    expect(events).toEqual([expect.objectContaining({
      type: "operation", senderId: "agent", upserts: [{ id: blocks[0].id, html: "<p>b</p>", version: 2 }], deletedIds: [], order: [blocks[0].id],
    })]);
  });

  // A document from before blocks is converted by the block API itself when no editor has yet
  // (the object's start does it first, so here it finds it done), and its unsafe markup does not
  // survive the conversion.
  it("converts a legacy document on first use", async () => {
    const { gadget, stored: map } = inMemoryGadget({ content: "<h1>Old</h1>loose<script>bad()</script><ul><li>x</li></ul>", title: "Old" });
    const { blocks } = await gadget.listBlocks();
    expect(blocks.map((block) => block.markdown)).toEqual(["# Old", "loose", "- x"]);
    expect(stored(map)).toMatchObject({ revision: 1, title: "Old" });
    expect(map.get("content")).toContain("<h1>Old</h1>");
  });

  // An empty legacy document is left alone until an edit changes it; that edit is a snapshot.
  it("stores an empty legacy document only once it is edited", async () => {
    const { gadget, stored: map } = inMemoryGadget({ title: "Empty" });
    expect(await gadget.listBlocks()).toEqual({ revision: 0, blocks: [] });
    expect(map.has("document:v2")).toBe(false);
    const { callbacks, events } = subscriber();
    await gadget.subscribe(callbacks);
    await gadget.insertBlocks({ markdown: "hi" });
    expect(stored(map)).toMatchObject({ revision: 1, title: "Empty" });
    expect(events).toEqual([expect.objectContaining({ type: "snapshot", senderId: "agent" })]);
  });
});

// Fixtures are what the previous Docs blueprint stored, captured from its build: blocks typed and
// formatted in its editor (Chrome's list command nests the list in the paragraph; an inserted image
// is a bare top-level <img>), its title field, and its legacy keys.
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
const OLD_BLOCKS = {
  title: '<h1 class="doc-title" data-block-id="b_2f75b646-1482-4bf5-b4c7-63718fcbfbc0">Project plan</h1>',
  centered: '<p data-block-id="b_5e7fb298-86f3-423b-a0b6-d0a3d69ff80d" style="text-align: center;">Centered paragraph</p>',
  bullets: '<p data-block-id="b_7a6c0008-1227-4e05-a39d-c1ebc5c9cb43"><ul><li>Bullet one</li><li>Bullet two</li><ul><li>Nested bullet</li></ul></ul></p>',
  numbers: '<p data-block-id="b_e7667080-5e95-4c10-a557-56f738047fcc"><ol><li>Number one</li><li>Number two</li></ol></p>',
  indent: '<blockquote style="margin: 0 0 0 40px; border: none; padding: 0px;" data-block-id="b_e5555893-22d0-4158-b510-f40dfe04d722"><p data-block-id="b_69a62f32-2a6e-4fe7-a76b-f7dd9e7d10ac">Indented paragraph</p></blockquote>',
  sized: '<p data-block-id="b_59774360-6f8d-40fc-b9e7-43538630d82f">Font <font style="font-size: 30pt;">sized 30</font> run here</p>',
  rule: '<hr id="null" data-block-id="b_67118c8b-4fd4-45a1-8b1b-607a714b8be0">',
  image: `<img class="doc-image" draggable="true" src="${PNG}" alt="Chart" style="width: 320px;" data-block-id="b_abc80224-944e-424b-8666-907676f2712a">`,
};
function oldDocument(title = "Quarterly Project Plan"): StoredDocument {
  const blocks = Object.entries(OLD_BLOCKS).map(([id, html]) => ({ id, html, version: id === "title" || id === "rule" || id === "image" || id === "indent" ? 1 : 2 }));
  return { revision: 3, title, blocks, lastModified: 1_700_000_000_000 };
}

describe("documents from earlier editors", () => {
  it("rebuilds blocks the editor can't show and keeps the old title field out of the page", async () => {
    const { gadget, stored: map, ready } = inMemoryGadget({ "document:v2": oldDocument() });
    await ready;
    const doc = stored(map);
    expect(doc).toMatchObject({ revision: 4, title: "Quarterly Project Plan", lastModified: 1_700_000_000_000 });
    expect(doc.blocks.some((b) => b.html.includes("Quarterly Project Plan"))).toBe(false);
    const byId = new Map(doc.blocks.map((b) => [b.id, b]));
    expect(byId.get("bullets")).toEqual({ id: "bullets", html: "<ul><li>Bullet one</li><li>Bullet two</li><ul><li>Nested bullet</li></ul></ul>", version: 3 });
    expect(byId.get("numbers")).toEqual({ id: "numbers", html: "<ol><li>Number one</li><li>Number two</li></ol>", version: 3 });
    expect(byId.get("image")).toEqual({ id: "image", html: `<p>${OLD_BLOCKS.image}</p>`, version: 2 });
    // Sound blocks, sized runs and indents included, are left exactly as they were.
    for (const id of ["title", "centered", "indent", "sized", "rule"] as const) expect(byId.get(id)).toMatchObject({ html: OLD_BLOCKS[id] });
    expect(doc.blocks.map((b) => b.id)).toEqual(Object.keys(OLD_BLOCKS));
    expect((await gadget.listBlocks()).blocks.map((b) => b.type)).toEqual(["h1", "p", "ul", "ol", "p", "p", "divider", "image"]);
    expect(await gadget.getMarkdown()).toContain("- Bullet one\n- Bullet two\n  - Nested bullet\n\n1. Number one\n2. Number two");

    // Idempotent: the next start finds nothing to do.
    const again = inMemoryGadget(map);
    await again.ready;
    expect(stored(map)).toEqual(doc);
  });

  it("keeps inline runs around a nested block in a copy of their line", () => {
    const doc = upgradeStoredDocument({ revision: 1, title: "Untitled document", lastModified: 1, blocks: [
      { id: "a", html: '<p data-block-id="a" style="text-align: center;">Lead <b>in</b><ol><li>x</li></ol>tail</p>', version: 4 },
    ] });
    expect(doc!.blocks.map((b) => b.html)).toEqual(['<p style="text-align: center;">Lead <b>in</b></p>', "<ol><li>x</li></ol>", '<p style="text-align: center;">tail</p>']);
    expect(doc!.blocks.map((b) => [b.id === "a", b.version])).toEqual([[true, 5], [false, 1], [false, 1]]);
  });

  it("leaves a current document alone", () => {
    expect(upgradeStoredDocument({ ...oldDocument(), blocks: [{ id: "t", html: "<p>fine</p>", version: 1 }] })).toBeNull();
  });

  it("converts a document from before blocks as the object starts, keeping its legacy keys", async () => {
    const legacy = { content: `<h1>Legacy doc</h1><p>Old <b>bold</b> text<br>second line</p>text at root<ul><li>one</li></ul><img src="${PNG}" style="width:200px">`, title: "Legacy Title", lastModified: 1_690_000_000_000 };
    const { gadget, stored: map, ready } = inMemoryGadget(legacy);
    await ready;
    expect((await gadget.listBlocks()).blocks.map((b) => b.markdown)).toEqual([
      "# Legacy doc", "Old **bold** text  \nsecond line", "text at root", "- one", `![](${PNG})`,
    ]);
    expect(map.get("content")).toBe(legacy.content);
    expect(map.get("title")).toBe("Legacy Title");
  });
});

describe("ExportHandler", () => {
  const handler = new ExportHandler({} as ExecutionContext, {});
  const exporting = (gadget: Gadget) => gadget as unknown as GadgetStub;

  it("offers Markdown and Word from the server, HTML and PDF from the browser", async () => {
    expect((await handler.getExportFormats()).map(({ id, mode, fileExtension }) => [id, mode, fileExtension])).toEqual([
      ["markdown", "server", ".md"], ["html", "browser", ".html"], ["pdf", "browser", ".pdf"], ["docx", "server", ".docx"],
    ]);
  });

  it("exports Markdown, of the blocks or of legacy content", async () => {
    const { gadget } = inMemoryGadget();
    await gadget.setMarkdown({ markdown: "# T\n\n**b**" });
    expect(await new Response(await handler.export(exporting(gadget), "markdown")).text()).toBe("# T\n\n**b**\n");
    const legacy = inMemoryGadget({ content: "<p><i>old</i></p>" }).gadget;
    expect(await new Response(await handler.export(exporting(legacy), "markdown")).text()).toBe("*old*\n");
  });

  it("exports Word as a ZIP package, and refuses formats it does not produce", async () => {
    const { gadget } = inMemoryGadget();
    await gadget.setMarkdown({ markdown: "hello" });
    const bytes = new Uint8Array(await new Response(await handler.export(exporting(gadget), "docx")).arrayBuffer());
    expect([...bytes.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    await expect(handler.export(exporting(gadget), "pdf")).rejects.toThrow("Unsupported document export format: pdf");
  });
});
