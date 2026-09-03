# Sheets

A lightweight, persistent spreadsheet Gadget with a familiar grid interface, formulas, formatting, multiple sheets, and live synchronization.

## Features

- Editable spreadsheet title and multiple sheet tabs
- Add, rename, duplicate, and delete sheets
- Cell and range selection with keyboard navigation
- Formula bar and A1-style references
- Cross-sheet references such as `Sheet2!A1` and `'Sales Data'!B4`
- 100+ spreadsheet functions across math, statistics, logic, text, lookup, date/time, and information categories
- Number, currency, percent, scientific, date, and time formatting
- Bold, italic, underline, strikethrough, text color, fill color, alignment, and wrapping
- Row and column insertion, deletion, and resizing
- Range sorting, AutoSum, copy/paste via TSV, and local undo/redo for cell edits
- Automatic persistent saving with optimistic per-cell conflict detection
- Real-time operation and presence synchronization in the server architecture

## Using the spreadsheet

- Click a cell to select it.
- Double-click a cell, press **F2**, or begin typing to edit it.
- Start formulas with `=`, for example:
  - `=SUM(A1:A10)`
  - `=IF(B2>100,"High","Low")`
  - `=VLOOKUP(E2,A2:C20,3,FALSE)`
  - `=Sheet2!A1*2`
- Use the name box to jump to a cell or range such as `D12` or `A1:C8`.
- Right-click the grid for cut/copy/paste and row or column actions.
- Double-click a sheet tab to rename it; right-click it to duplicate or delete it.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| Arrow keys | Move the active cell |
| Shift + Arrow | Extend the selection |
| Enter / F2 | Edit the active cell |
| Tab / Shift + Tab | Move right / left |
| Delete / Backspace | Clear selected cells |
| Ctrl/Cmd + C, X, V | Copy, cut, paste |
| Ctrl/Cmd + Z | Undo |
| Ctrl/Cmd + Y or Ctrl/Cmd + Shift + Z | Redo |
| Ctrl/Cmd + B | Bold |
| Ctrl/Cmd + I | Italic |
| Ctrl/Cmd + U | Underline |
| Ctrl/Cmd + A | Select the whole sheet |
| Ctrl/Cmd + Arrow | Jump across populated or empty regions |
| Alt + Enter | Insert a line break while editing |

## Programmatic population

The spreadsheet can be read and populated through the Gadget's server RPC methods. This is useful for scripts, agents, migrations, or seeding a workbook without using the grid UI.

### Read the workbook

Call `getDocument()` to retrieve the complete persisted workbook:

```js
const doc = await gadget.getDocument();
```

The returned object contains `revision`, `title`, `sheetOrder`, `sheets`, `cells`, and `lastModified`. Cells are grouped by sheet ID and keyed by A1 reference:

```js
const firstSheetId = doc.sheetOrder[0];
const a1 = doc.cells[firstSheetId].A1;
// { value: "Revenue", fmt: { b: true }, version: 1 }
```

### Write cells

Use `applyOperation()` with per-cell operations. For a new cell, use `baseVersion: 0`; when replacing or deleting an existing cell, use its current `version` from `getDocument()`.

```js
const doc = await gadget.getDocument();
const sheetId = doc.sheetOrder[0];
const cells = doc.cells[sheetId];

const result = await gadget.applyOperation({
  senderId: "seed-script",
  cellOps: [
    {
      sheetId,
      ref: "A1",
      value: "Revenue",
      fmt: { b: true, bg: "#fff3a3" },
      baseVersion: cells.A1?.version ?? 0,
    },
    {
      sheetId,
      ref: "B1",
      value: "=SUM(B2:B10)",
      fmt: { nf: "currency", d: 2 },
      baseVersion: cells.B1?.version ?? 0,
    },
  ],
});
```

A cell's `value` is always stored as text. Begin a value with `=` to create a formula. To delete a cell completely, send both `value: null` and `fmt: null` with the current `baseVersion`.

Check `result.status` after writing. It is `applied`, `unchanged`, or `conflict`. On a conflict, inspect `result.conflicts`, re-read the document, and retry against the latest cell versions rather than overwriting blindly.

### Replace a whole sheet

For bulk imports, `sheetReplacements` is more efficient than sending many individual cell operations:

```js
await gadget.applyOperation({
  senderId: "csv-import",
  sheetReplacements: [{
    sheetId,
    cells: {
      A1: { value: "Name", fmt: { b: true }, version: 1 },
      B1: { value: "Total", fmt: { b: true }, version: 1 },
      A2: { value: "Example", fmt: null, version: 1 },
      B2: { value: "1250", fmt: { nf: "currency", d: 2 }, version: 1 },
    },
  }],
});
```

A whole-sheet replacement overwrites that sheet's complete cell map, so merge with existing data first if it must be preserved. It does not use per-cell conflict checks.

### Change workbook structure

Pass a complete structure snapshot to change the title, sheet order, names, dimensions, or sizing metadata. Because structure uses last-writer-wins semantics, start with the latest document and preserve every sheet that should remain:

```js
const doc = await gadget.getDocument();
const sheetId = doc.sheetOrder[0];

await gadget.applyOperation({
  senderId: "setup-script",
  structure: {
    title: "Quarterly plan",
    sheetOrder: doc.sheetOrder,
    sheets: {
      ...doc.sheets,
      [sheetId]: {
        ...doc.sheets[sheetId],
        name: "Summary",
        colWidths: { ...doc.sheets[sheetId].colWidths, 0: 180 },
      },
    },
  },
});
```

Omitting an existing sheet from `sheetOrder` deletes it and its stored cells. Adding a new sheet ID creates empty storage for it. When adding a sheet and its initial data together, include both `structure` and a matching `sheetReplacements` entry in the same operation.

Formatting keys accepted by the server are `b` (bold), `i` (italic), `u` (underline), `s` (strikethrough), `c` (text color), `bg` (fill color), `a` (`l`, `c`, or `r` alignment), `nf` (number format), `d` (decimal places), `fs` (font size), and `wrap`. Colors must be hexadecimal strings such as `#1d1d20`.

## Architecture

### `client.js`

Builds the entire browser interface in JavaScript. It contains:

- Grid rendering and selection behavior
- Cell editing, formatting, sorting, and structural operations
- Formula tokenization, parsing, evaluation, and display formatting
- Clipboard and keyboard support
- A local model with debounced saves
- RPC callbacks for live server operations and presence events

Formula evaluation happens in the browser. The engine caches computed cells, detects circular references, supports ranges and cross-sheet references, and displays standard errors including `#DIV/0!`, `#VALUE!`, `#REF!`, `#NAME?`, `#N/A`, `#NUM!`, and `#CYCLE!`.

### `server.js`

Exports the Durable Object class `Gadget`, which is the authoritative persistence and synchronization layer. It:

- Stores spreadsheet metadata and each sheet's cells in Durable Object storage
- Serializes mutations through an in-memory queue
- Applies per-cell optimistic concurrency using cell versions
- Uses last-writer-wins semantics for document structure
- Broadcasts operations and presence events to subscribed clients
- Sanitizes titles, dimensions, cell contents, references, and formatting

## Storage model

The server stores:

- `meta`: revision, title, sheet order, sheet metadata, and modification time
- `cells:<sheetId>`: a map of A1 references to `{ value, fmt, version }`

Default sheets have 100 rows and 26 columns. Server validation permits up to 50,000 rows and 702 columns per sheet. Cell values are limited to 8,192 characters, and titles are limited to 200 characters.

## Collaboration notes

The server and client synchronization code support multiple connected clients and live updates. Remote collaborator badges and selection overlays are currently disabled in the UI, so the app presents as a single-user spreadsheet even though remote operations still synchronize.

## Current limitations

- There is no file import workflow; clipboard operations use tab-separated text.
- Structural edits and sorting clear local undo/redo history.
- Formula reference adjustment during row/column changes is limited to references on the current sheet.
- Formula support is broad but is not intended to be fully compatible with Excel or Google Sheets.
- Frozen row/column metadata exists in the model, but the current UI does not expose controls for it.

## CSV export

Each worksheet is exposed as its own **CSV** export option. CSV files contain the stored cell values
through the worksheet's used range. Formula cells are exported as their raw formulas (for example,
`=SUM(A1:A10)`), not as browser-computed display values. Fields use standard CSV quoting and CRLF
line endings.
