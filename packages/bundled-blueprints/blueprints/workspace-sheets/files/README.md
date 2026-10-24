# Sheets — real-time collaborative spreadsheet Gadget

A spreadsheet with formulas, formatting, filters, charts, pivot tables and multiple sheets. The workbook is stored in the gadget's Durable Object with a version per cell; every open grid syncs live, and concurrent edits to different cells never overwrite each other. Exports to Excel, CSV and PDF.

## How agents should edit this sheet (read this first)

The people using this sheet watch it change live: each cell API call appears in their grid as its own animated step (new values fade in, changed characters light up, cleared cells fade out). So:

1. **Read first.** `listSheets()` gives sheet names, sizes and used ranges; `readRange({ sheet, range })` gives the stored values (formulas as text, e.g. `"=SUM(B2:B9)"`). The server doesn't evaluate formulas for `readRange` (only exports do), so compute results yourself if you need them.
2. **One cell, row or small range per call.** `setCell` / `setCells` for scattered cells, `setRange` for a row or small block, `formatRange` for styling. Several calls can go in one `executeCode` run: loop and `await` each one. For a table, write the header row, then one row per call, top to bottom.
3. **Pause briefly between calls**, about `await new Promise(r => setTimeout(r, 150))`, so each change lands as a distinct step.
4. **Change only what changed.** Writing a cell with the same value and format is a no-op, but don't rewrite whole ranges to fix one cell. For a small edit, keep the rest of the cell's text so only the changed characters light up.
5. **Never replace a whole sheet** (`applyOperation({ sheetReplacements })`) when it already has content: that path skips per-cell version checks and isn't animated. Use the cell API.
6. **Leave the cell the user is typing in alone.** Their open editor keeps their text and their commit then wins.

**Reaching this gadget.** In `executeCode` a gadget is `env.<NAME>`, where `<NAME>` is the binding name the workspace gave it, derived from the gadget's title (e.g. `LAUNCH_PLAN`, or `GADGET` when none could be made). Read it from the chat's binding list rather than guessing. The methods below are on its `.rpc` stub (`env.<NAME>.rpc.listSheets()`), and `env.<NAME>.exports` exports it as a file. The examples call it `MY_SHEET`.

Example: add a small table with a total, then style it.

```js
const sheet = env.MY_SHEET.rpc; // the binding's name varies: see above
const pause = () => new Promise((r) => setTimeout(r, 150));
const { sheets } = await sheet.listSheets();
const name = sheets[0].name;
const rows = [["Region", "Q1", "Q2"], ["North", 1200, 1350], ["South", 980, 1110], ["West", 1430, 1520]];
for (let i = 0; i < rows.length; i++) {
  await sheet.setRange({ sheet: name, start: `A${i + 1}`, values: [rows[i]] });
  await pause();
}
await sheet.setCells({ sheet: name, cells: { A5: "Total", B5: "=SUM(B2:B4)", C5: "=SUM(C2:C4)" } }); await pause();
await sheet.formatRange({ sheet: name, range: "A1:C1", fmt: { b: true, bg: "#fbf0c2" } }); await pause();
await sheet.formatRange({ sheet: name, range: "B2:C5", fmt: { nf: "currency", d: 0 } });
```

## Cell API

Every write runs in the Durable Object's mutation queue, bumps versions only for cells whose value or format changed, and, when anything changed, persists and broadcasts an `operation` event with `senderId: "agent"` (which is what the grid animates). Writes return `{ status: "applied" | "unchanged", revision, updated?, cleared? }`. Bad input throws a readable error (bad ref or range, unknown sheet, non-object `cells`, non-array `values`, missing or invalid `fmt`, unknown chart type, out-of-range sizes).

**Addressing.** `sheet` is a sheet id or name (case-insensitive); omitted means the first sheet. Cells are A1 refs (`$` allowed); ranges are `"A1:C9"`. Row arguments are 1-based numbers; column arguments are letters (`"C"`) or 1-based numbers. Writing past a sheet's edge grows it, up to 50,000 rows and 702 columns (`ZZ`).

**Values** are stored as text, at most 8,192 characters: numbers are stringified (written out in full, since the grid reads `1.5e-7` as text), booleans become `TRUE`/`FALSE`, a leading `=` makes a formula, and a leading `'` forces text. Text such as `1,200`, `$1,200` and `15%` reads as a number; dates do not (`2024-01-15` stays text), so write dates as `=DATE(2024,1,15)` or a 1900-based serial with `nf: "date"`.

| Method | Notes |
| --- | --- |
| `listSheets()` | `{ revision, sheets: [{ id, name, rows, cols, usedRange, cellCount, filter, charts, pivot }] }`. `filter` is `{ headerRow, columns }` or null; `charts` are `{ id, type, range, title }`; `pivot` is a boolean. |
| `readRange({ sheet?, range?, formats? })` | `{ revision, sheetId, sheet, range, values: [[…]], formats? }`; empty cells read as `""`. No range reads the used range. At most 50,000 cells per call. |
| `setCells({ sheet?, cells })` | `cells` maps refs to values: `{ A1: "Revenue", B2: 42, C3: "=SUM(B1:B9)", D4: null, E5: { value?, fmt? } }`. A plain value keeps the cell's format; `null` clears the cell; `fmt` merges into the existing format (a key set to `null` removes it; `fmt: null` removes all formatting). |
| `setCell({ sheet?, ref, value, fmt? })` | One cell, same rules. |
| `setRange({ sheet?, start = "A1", values: [[…], …], fmt? })` | A rectangular block; `undefined` entries are skipped; `fmt` merges into every written cell. |
| `formatRange({ sheet?, range, fmt })` | Merges `fmt` into every cell (`fmt: null` clears formatting). At most 50,000 cells. |
| `clearRange({ sheet?, range, formats = false })` | Clears values; formatting stays unless `formats: true`. Any size. |
| `insertRows({ sheet?, at, count = 1 })` / `deleteRows(…)` | Inserts before row `at`. As in the grid, formula references from every sheet move, references into deleted lines become `#REF!`, ranges shrink, and chart ranges, pivot sources, the filter and row heights follow. A sheet keeps at least one row. |
| `insertCols({ sheet?, at, count = 1 })` / `deleteCols(…)` | Same, with `at` a column letter or number. |
| `addSheet({ name?, rows?, cols?, index? })` | Returns `{ sheetId, name }`. Names are trimmed to 60 characters and must be unique (default `SheetN`). New sheets default to 100 × 26. |
| `renameSheet({ sheet, name })` | Rewrites references to the sheet in every formula. |
| `deleteSheet({ sheet })` | Never the last sheet. |
| `addChart({ sheet?, range, type = "line", title?, xAxisTitle?, yAxisTitle?, legend?, firstRowHeaders?, firstColLabels?, x?, y?, width?, height? })` | Returns `{ chartId }`. `type` is `line`, `pie`, `area` or `stackedBar`. `legend`, `firstRowHeaders` and `firstColLabels` default to true. Size is clamped to 280–1200 × 200–900 px (default 520 × 320). Without `x`/`y` it's placed beside the data, past any filled columns next to it, or under it when there's no room. At most 50 charts per sheet. |
| `setColumnWidths({ sheet?, widths: { A: 180, C: 120 } })` | In px, 24–2000; `null` resets a column to the default (92). |

There is no agent API for filters, pivot tables, row heights or deleting charts; those are edited in the grid (or through the structure snapshot of the low-level `applyOperation`, which the client uses).

**Formats** (`fmt`):

- `b`, `i`, `u`, `s`, `wrap`: `true`.
- `c` text colour and `bg` fill: hex such as `#2f6fd1`. Palette fills: `#ececee #fbdedb #fde6d2 #fbf0c2 #d9f0e2 #d4eeed #dbe6fa #e8defa #f9ddeb`; palette text colours: `#6b6b73 #d0473f #d9731f #b48a00 #2f9e66 #13898a #2f6fd1 #7c4dcc #c94a8c`. A filled cell without a text colour gets legible ink automatically, in light and dark mode.
- `a`: `"l" | "c" | "r"`.
- `nf`: `auto`, `text`, `number`, `integer`, `percent`, `scientific`, `currency` (`$`), `date` (`MM/DD/YYYY`), `time`, `datetime`. `d`: decimals, 0–10. `text` keeps what a person types into the cell as text; through the API, write `'00123` to keep a number-like value as text.
- `fs`: font size in px, 6–96 (13 is the default).

## Formulas

The engine (`lib/formula.ts`) has 100+ functions across math, statistics, logic, text, lookup, date/time and information, and follows Excel's results so exported workbooks recalculate the same. What matters when writing formulas:

- Cross-sheet references: `Sheet2!A1`, `'Sales Data'!B4`; a name with an apostrophe is `'Owner\'s Sheet'!A1` (or `''`). `HYPERLINK(url, label)` and plain `http(s)` values are links.
- Not supported (the formula is invalid): whole-column/row references (`A:A`, `1:1`), structured references (`[ ]`), `@`, and `;` outside an array constant.
- Array constants `{1,2;3,4}` work wherever a range does. Nothing spills: a formula returning an array shows its first item. Where one value is expected, a range gives the cell in the formula's own row or column (implicit intersection), else `#VALUE!`. Only `SUMPRODUCT` evaluates operators over ranges item by item, so `=SUMPRODUCT((A2:A9="North")*B2:B9)` works; elsewhere use `SUMIFS`/`COUNTIFS`/`AVERAGEIFS`.
- Criteria such as `">1"` match only numbers; a single cell reference in `SUM`/`AVERAGE` counts only a number.
- Dates are Excel 1900 serials (including its fictional 29 February 1900). `NOW()`/`TODAY()` use the browser's clock in the grid and UTC in exports.
- Cycles show `#CYCLE!`.

## Data model

- `meta`: revision, title, sheet order, and per-sheet metadata (`rows`, `cols`, `colWidths`, `rowHeights`, frozen panes, `filter`, `charts`, `pivot`). `title` isn't shown or edited; the browser tab shows the active sheet's name. Frozen panes exist in the model but have no UI.
- Cells are `{ value, fmt, version }`, stored in blocks of 32 rows (`b:<sheetId>:<block>`), packed as parallel arrays.
- Clients send per-cell edits with the version they rest on; conflicts are rebased and resent, so when two people commit the same cell, the later commit wins. Layout-changing edits (sort, row/column insert or delete) are sent as whole-sheet replacements guarded by `baseRevision`, refused if the document moved on.
- Presence events flow between clients, but no remote cursors are drawn.
- Older storage layouts are converted to blocks the first time a workbook loads.

## Export formats

Excel and CSV are computed on the server with the grid's own formula engine, so they show what the grid shows (evaluation is capped at about 60 million cell reads per export; past it, remaining formulas export without a cached result).

- **Excel** (`.xlsx`): every sheet with values, formulas (rewritten for Excel) and cached results, number formats, fonts, colours, alignment, wrap, column widths, row heights, frozen panes, filters, hyperlinks and native Excel charts. Excel recalculates on open. Sheet names are made Excel-safe (31 characters, no `:\/?*[]`). Rows the grid grew to fit wrapped text are written at Excel's default height.
- **CSV**: one format per sheet (up to 30): displayed values through the used range, UTF-8 with BOM, CRLF. Rows hidden by a filter are included. With several sheets each file is named after its sheet.
- **PDF** (browser): the whole workbook in the print layout, light palette, wide sheets split into column groups, filtered rows left out, charts included. A sheet whose used range exceeds 100,000 cells gets a note instead of its table; use Excel or CSV for those.

## Limitations

- No file import; the clipboard uses tab-separated text.
- No Replace in Find.
- A filter covers the rows it had when it was turned on, plus rows inserted inside it; rows written below it aren't filtered or sorted until it is turned off and on again.
- Structural edits and sorting clear local undo history.
- The whole workbook is held in the browser's memory; about a million filled cells is the practical ceiling.

## Code map

The gadget is `client.js` (the grid) and `server.js` (the Durable Object and exports). Both are self-contained bundles: each inlined module starts with a `// lib/<name>.ts` comment.

- `server.js` — the `Gadget` Durable Object: storage (`CellWriter`, 32-row blocks), the client RPC (`subscribe`, `openDocument`, `getCellsPage`, `getSheetSlices`, `applyOperation`, `stageCells`, presence), the cell API above, input sanitizers, and `ExportHandler`; inlined are `lib/formula.ts`, `lib/export-data.ts` (paged export reader, `ExportEvaluator`), `lib/xlsx.ts` (Excel writer), `lib/charts.ts` (chart placement, value axis) and a streaming ZIP writer.
- `client.js` — the whole UI. Numbered sections indexed at the top of the file: helpers, styles, formula engine, model, chrome, menus, save queue and undo, rendering (pivots, charts, filters, the windowed grid, print), editing/keyboard/clipboard/find, live-edit animation, collaboration.
- The formula engine (`lib/formula.ts`: `makeEngine`, `FUNCTIONS`, `FUNCTION_HELP`, `displayValue`) is inlined into **both** files, so the grid and the exports compute alike; a change to it must be made in both.
