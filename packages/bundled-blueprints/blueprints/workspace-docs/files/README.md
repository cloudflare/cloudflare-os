# Docs — real-time collaborative rich-text Gadget

A single-document rich-text editor (headings, lists, to-dos, quotes, code, tables, images). The document is stored in the gadget's Durable Object as an ordered list of versioned blocks; every open editor updates live, and concurrent edits are merged rather than overwritten. Exports to Markdown, HTML, PDF and Word.

## Files

- `server.js` — Durable Object that stores the document as versioned blocks, broadcasts changes to open editors, serves the block API below, and writes the Markdown and Word exports. Every stored block's HTML is filtered on write.
- `client.js` — The editor around one `contenteditable`: toolbar, "/" menu, block handles and drag, tables, paste cleanup, word-level merging of concurrent edits, and the live animation of agent edits.

## How agents should edit this document (read this first)

The people using this doc watch it change live: each block API call appears in their editor as its own animated step (new blocks fade in, changed words light up, removed blocks fade out). So:

1. **Edit one block per call.** Use `updateBlock` (rewrite a block), `insertBlocks({ afterId, … })` (add blocks), `deleteBlocks` and `moveBlocks`. Several calls can go in one `executeCode` run: loop and `await` each one.
2. **Pause briefly between calls**, about `await new Promise(r => setTimeout(r, 150))`, so each change lands as a distinct step. For new content, insert blocks one after another, each `afterId` the block just created, so text appears in reading order.
3. **Change only what needs changing.** Read first (`listBlocks()` gives ids, types and Markdown), then touch only blocks whose content changes. Don't rewrite a block whose text is the same. For a small edit, keep the rest of the block's wording so only the changed words light up.
4. **Never replace the whole document** (`setMarkdown`) when it already has content. `setMarkdown` is for filling an empty document; on one with content it throws unless you pass `replace: true`, which only a user's request to replace everything justifies. (It applies as a diff: unchanged blocks keep their ids.)
5. **Prefer blocks the user isn't typing in.** An edit to a block someone is typing in is merged word by word with their unsaved typing: where you both changed the same words, theirs win. So `status: "applied"` means the server stored your version, not that every word survives a concurrent edit; read the block back (`getBlocks`) later if that matters.

Example: rewrite two paragraphs and add a section.

```js
const doc = env.MY_DOC.rpc; // use this gadget's binding name
const { blocks } = await doc.listBlocks();
const pause = () => new Promise((r) => setTimeout(r, 150));
await doc.updateBlock({ id: blocks[2].id, text: "Launch moves to **April 14**, pending legal review." }); await pause();
await doc.updateBlock({ id: blocks[3].id, text: "Owners: Ada (eng), Bob (legal)." }); await pause();
let after = blocks[3].id;
for (const spec of [{ type: "h2", text: "Risks" }, { type: "ul", items: ["Legal sign-off", "Load testing"] }]) {
  const { ids } = await doc.insertBlocks({ blocks: [spec], afterId: after });
  after = ids[0];
  await pause();
}
```

## Block API

Every write runs in the Durable Object's mutation queue. One that changes the document bumps the version of each block whose HTML changed, persists, and broadcasts an `operation` event with `senderId: "agent"` (which is what the editor animates). The first write to a document never saved before broadcasts a `snapshot` instead. Writes return `{ status: "applied" | "unchanged", revision, ids }`, where `ids` are the blocks created or changed: the moved ones for `moveBlocks`, every block of the new document for `setMarkdown`, and none for `deleteBlocks`. Errors throw with a readable message, e.g. `Unknown block id: …`.

| Method | Notes |
| --- | --- |
| `listBlocks()` | `{ revision, blocks: [{ id, type, markdown, version }] }`. `type` is `p`, `h1`–`h3`, `quote`, `code`, `divider`, `ul`, `ol`, `todo`, `image`, `table` (or another tag's name). |
| `getBlocks({ ids? })` | The listed blocks (all if `ids` omitted), each also with its stored `html`. |
| `getMarkdown()` | The whole document as Markdown. |
| `insertBlocks({ blocks?, markdown?, afterId? \| beforeId? \| index? })` | Inserts at the end by default. `index` is 0-based; negative counts from the end (-1 is the end). Into a brand-new doc (one empty line) with no position, the empty line is replaced. Throws `Nothing to insert` when given no content. |
| `updateBlock({ id, ...spec })` or `updateBlock({ id, markdown })` | Replaces the block's content. Text without a `type` keeps the block's type (a heading stays a heading), except that an image, a divider or another tag's block becomes a paragraph; untyped `items` keep the list kind (`ul` from a non-list), `rows` make a table (a table needs them: text alone throws), `src` an image, block-level `html` an html block. If the Markdown or html yields several blocks, the extra ones are inserted after it. No fields at all throws rather than emptying the block. |
| `updateBlock({ id, type })` | Converts the block, keeping its content: between `p`/`h1`–`h3`/`quote`/`code`, from those into a list, and between list kinds. Other conversions throw and ask for the content. |
| `setChecked({ id, item = 0, checked = true })` | Ticks the `item`-th (0-based) top-level item of a to-do list. Throws if the block isn't a to-do list or has no such item. |
| `deleteBlocks({ ids })` | `ids` is an id or an array. Deleting every block leaves one empty paragraph. |
| `moveBlocks({ ids, afterId? \| beforeId? \| index? })` | Keeps the moved blocks' relative order. A block can't be positioned relative to itself. |
| `setMarkdown({ markdown?, blocks?, title?, replace? })` | Replaces the whole document. Throws on a document with content unless `replace: true` (see rule 4) or the call changes nothing. Unchanged blocks keep their ids, changed ones update in place. |

**Images in reads are abbreviated.** A long `data:` image appears in `listBlocks`, `getBlocks` Markdown and `getMarkdown` as `![alt](data:image/jpeg;… 57 KB #1a2b3c4d)` (type, size, hash). The full URI is in `getBlocks`' `html`. Pass the reference back unchanged in any write (`markdown`, `text`, `src` or `html`) and it stands for that same image, so editing around or copying an image keeps it. A reference to an image no longer in the document throws.

### Block specs

`blocks` is an array of specs. A plain string is a paragraph; `{ markdown }` expands into several blocks.

- `{ type: "p" | "h1" | "h2" | "h3" | "quote", text }` — `text` is inline Markdown: `**bold**`, `*italic*`, `` `code` ``, `~~strike~~`, `[link](https://…)`, bare URLs, `![alt](src)` images. Alternatively pass inline `html` instead of `text`.
- `{ type: "code", text }` (or `code`) — plain text, line breaks kept.
- `{ type: "divider" }`.
- `{ type: "image", src, alt?, width? }` — `src` must be `https://` or a PNG, JPEG, GIF, WebP or AVIF `data:` URI; `width` in px.
- `{ type: "ul" | "ol" | "todo", items }` — each item a string or `{ text, checked?, items?, listType? }` (nested `items` make a sub-list, of the same kind unless `listType` says otherwise). Or `text` with one item per line.
- `{ type: "table", rows: [[cell, …], …], header?, widths? }` — cells are inline Markdown, `"\n"` is a line break. The first row is the header unless `header: false`. Short rows are padded. `widths` are relative numbers, one per column.
- `{ type: "html", html }` — the editor holds one element per block, so several top-level elements become several blocks, and loose text or inline tags are wrapped in `<p>`. Scripts, styles, frames, forms, `svg`/`math`, event handlers, `id`/`name` and `javascript:` URLs are removed (the server filters all stored HTML this way).
- Type aliases are accepted (`text`, `heading` → h2, `bullets`, `numbered`, `checklist`, `tasks`, `hr`, `img`, `grid`, …). An unknown type throws with the list of valid ones.

**Markdown** (`markdown` arguments) supports headings (h4+ become h3), paragraphs (line breaks kept), nested `-` / `1.` / `- [ ]` lists (one block per run of the same kind), `>` quotes, fenced code, `---`, `![alt](https://…)` images and GFM pipe tables.

**Editor markup**, if you write `html` directly: bold `<b>`, italic `<i>`, `<u>`, `<s>`, `<code>`; to-do lists `<ul class="checklist"><li data-checked="true">…`; images `<p><img class="doc-image" src="…" alt="…"></p>`; tables `<table>[<colgroup><col style="width:30%">…</colgroup>]<thead><tr><th>…</thead><tbody><tr><td>…</tbody></table>` with inline content and `<br>` only in cells. Colours are classes, never hex, so they adapt to dark mode: text `<span class="tc-blue">`, highlight `<span class="hl-yellow">`, with `gray`, `brown`, `orange`, `yellow`, `green`, `blue`, `purple`, `pink`, `red`.

## Document model and settings

- Stored under `document:v2`: `{ revision, title, blocks: [{ id, html, version }], lastModified }`. Each top-level element in the editor is one block with a stable `data-block-id`; a whole list or table is one block.
- Clients send only changed blocks with the version they rest on; the server accepts non-conflicting changes and returns the authoritative block for stale ones, which the client merges word by word with its draft and resends. Two people changing different words of one paragraph both keep their changes; where both changed the same words, the later save's words win.
- `title` exists in storage but isn't shown or edited (the gadget has its own title; the browser tab shows the first non-empty line).
- Shared presentation settings, stored under `settings`: `{ font: "sans" | "serif" | "mono", wide: boolean }` (`wide` widens the page from 700px to 980px). Read and write them with `getSettings()` / `setSettings({ font?, wide? })`. There is deliberately no per-run font or size; text styles come from the block type.
- Documents from before blocks (a legacy `content` HTML key) are converted to blocks on first load.

## Export formats

- **Markdown** (server): the stored blocks, including `- [ ]` checklists and GFM tables (column alignment kept). Underline, colour, size and alignment become plain text. Full image data URIs are kept.
- **HTML** and **PDF** (browser): the print layout, light palette, no chrome; trailing empty lines are hidden; table rows don't split across pages.
- **Word** (`.docx`, server): converted from the block HTML to native Word: Heading 1–3 styles (usable for Word's navigation and table of contents), Quote style, native numbered/bulleted lists, clickable to-do checkboxes, code in a shaded monospace box, native tables (header row repeats across pages), palette colours, embedded images at their page width, `http(s)`/`mailto:`/`tel:` links. The document font follows the shared typeface (Arial / Georgia / Courier New) on US Letter. Remote, SVG or AVIF images export as their alt text. Limits: 64 MB of HTML, 20,000 blocks, 400,000 nodes, nesting 200 deep, 400,000 table cells, 500 images (16 MB each, 96 MB total).

## Limitations

- No real-time cursors or presence.
- Images added in the editor are embedded in the document (downscaled to 1600px and under about 1.4 MB each, or 2.7 MB for a GIF), so many large images make it heavy.
