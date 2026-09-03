# Docs — real-time collaborative rich-text Gadget

A single-document, Google-Docs-style rich-text editor with Durable Object persistence, live block updates, collaborator presence, and conflict-safe concurrent editing.

## Architecture

- **server.js** is the authoritative collaboration coordinator. It stores one atomic `document:v2` snapshot containing the title, global revision, ordered blocks, per-block versions, and modification time.
- **client.js** builds the entire UI around a `contenteditable` surface. Every top-level document element has a stable `data-block-id`. Local typing is optimistic and changed blocks are sent after a short ~220 ms debounce.
- **docx.js** parses a plain document snapshot into a bounded export-only semantic model and streams a deterministic WordprocessingML package through the blueprint-local **zip.js** writer.
- Clients subscribe with a Cap'n Web `RpcTarget`. The server broadcasts accepted block operations and ephemeral presence events to every connected client.

## Real-time data model

The persisted document resembles:

```js
{
  revision: 42,
  title: "Project plan",
  blocks: [
    { id: "b_…", html: "<h1 data-block-id=\"b_…\">Project plan</h1>", version: 3 },
    { id: "b_…", html: "<p data-block-id=\"b_…\">Draft…</p>", version: 8 }
  ],
  lastModified: 1700000000000
}
```

Clients send compact operation batches containing only changed/upserted blocks, version-checked deletions, the current block order, and title. The Durable Object:

1. checks each changed block's `baseVersion`;
2. accepts non-conflicting changes;
3. increments accepted block versions and the document revision;
4. persists the resulting authoritative snapshot; and
5. broadcasts only the accepted operation.

A remote operation patches only affected DOM blocks. The whole editor is not replaced, so typing and selection in unrelated paragraphs remain stable. Ordering is last-writer-wins, while content and deletion changes use per-block optimistic concurrency.

### Same-block concurrency

A remote update to the block currently being edited is queued rather than replacing the user's caret and draft. If the local block is clean on blur, the remote version is applied. If it is locally dirty, the draft is rebased onto the latest server block version and saved as the next version. Server conflicts return the authoritative block/version, and the client automatically retries its visible local draft—no local text is silently discarded.

This is block-granularity collaboration rather than a character-level CRDT. It provides smooth simultaneous editing across paragraphs with much less complexity. A CRDT/OT layer would still be required for merged character-by-character edits by multiple people inside the exact same paragraph.

## Presence

Selection changes are throttled to ~70 ms and sent as ephemeral presence messages containing collaborator ID, name, color, and anchor/focus block-and-text offsets. Presence is never persisted. A collaborator appears as a slim named caret; selected text is shown with a subtle translucent highlight, including selections spanning multiple blocks. Both are rendered in a fixed overlay without modifying document HTML. There are no header avatars or active-block outlines. Page close uses a best-effort leave message, RPC disconnects broadcast leave events, and client heartbeats expire stale cursors when browsers do not complete unload networking.

Remote carets and selection highlights live in a separate overlay, so presence decoration never enters the editable DOM or persisted document HTML. Serialization also strips transient local image-selection decoration.

## Programmatic population and backward compatibility

Agents and importers should call `setDocument({ title, blocks, senderId })` to populate or replace the document atomically. It works whether the editor has already been opened or not, persists the full snapshot, increments the revision, and broadcasts the result to connected clients. This avoids requiring callers to choose between initialization and incremental operations.

`initializeBlocks()` remains the idempotent bootstrap/migration API. It also handles the startup race where a newly opened browser creates an empty revision-1 shell just before generated content arrives: that exact untouched shell can be replaced by a non-empty initialization payload. It will not overwrite later empty documents, which may represent an intentional user edit.

If only the former `content`, `title`, and `lastModified` KV keys exist, the first v2 client loads that HTML, normalizes its top-level nodes, assigns stable block IDs, and calls `initializeBlocks()`. Existing documents therefore migrate without data loss.

## Formatting and media

The toolbar supports paragraph styles, font family/size, bold, italic, underline, strikethrough, text/highlight color, alignment, lists, indentation, links, images, horizontal rules, clear formatting, and undo/redo.

Pasted Google Docs/Word HTML is rebuilt into clean semantic markup. Images from file selection, drag/drop, and clipboard are downscaled and embedded as data URLs. Because collaboration transmits changed blocks, an embedded image is no longer resent when unrelated paragraphs change. A future asset store could replace data URLs with image IDs if very large media-heavy documents are needed.

## Google Doc sync

`syncToGoogleDoc()` remains an explicit full-document integration because the current binding API exposes content replacement rather than range operations. It is separate from the efficient local real-time collaboration path.

## Implementation notes

- Durable Object storage is the source of truth; in-memory subscriber and presence maps are intentionally ephemeral.
- Structural DOM normalization handles root text and `<br>` nodes and repairs duplicate/missing block IDs.
- Remote ordering moves only blocks that are out of place, avoiding unnecessary selection disruption.
- `execCommand` is deprecated but remains the compact, broadly compatible formatting mechanism for this sandboxed editor.

## Export formats

- **Markdown** exports the persisted rich-text blocks as Markdown, preserving headings, emphasis,
  links, images, lists, block quotes, code, and horizontal rules.
- **HTML** and **PDF** use the editor's print layout and omit editing chrome and presence UI.
- **Word Document (DOCX)** is a one-way semantic export intended for continued editing in Word or
  another compatible office application. It converts the persisted HTML blocks directly rather than
  going through Markdown, so it can retain underline, fonts, sizes, colors, highlights, alignment,
  indentation, links, image dimensions, and nested inline formatting.

DOCX uses US Letter pages with 0.65-inch margins, 11-point Normal text, approximately 1.5 line
spacing, and paragraph/heading styles based on the editor's renderer. It emits editable native lists,
external hyperlinks, inline images, quotes, code blocks, and horizontal rules. PNG, JPEG, GIF, and
WebP data-URL images are embedded after signature and dimension validation; animated GIF and WebP
rendering depends on the Word version. External and blob images are not fetched and become visible
alt text or an unavailable-image placeholder.

Only absolute `http:`, `https:`, `mailto:`, and `tel:` hyperlink targets become external DOCX
relationships. Relative links, fragment-only links, malformed URLs, and unsupported or active
schemes remain visible text without a relationship.

Tables are not a first-class editor feature. Incidental table HTML is flattened to one paragraph per
row with tab-separated cells rather than exported as native Word tables.

DOCX is not a lossless round-trip or visual-pagination format. HTML and PDF remain the
visual-fidelity exports; Word pagination, font availability, and application-specific rendering can
differ from the browser. DOCX import, native tables, multiple sections, explicit page/section breaks,
headers and footers, page numbers, footnotes/endnotes, citations, comments/tracked changes,
bookmarks/cross-references, equations, captions, floating images/text wrapping, custom themes,
embedded fonts, arbitrary CSS, and pixel-perfect browser pagination are intentionally deferred.
