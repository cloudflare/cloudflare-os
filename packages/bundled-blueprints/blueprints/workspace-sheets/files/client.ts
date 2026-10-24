// ─────────────────────────────────────────────────────────────────────────────
// Sheets — a calm, real-time collaborative spreadsheet. Same family as Docs:
// one quiet bar, invisible sync, delayed tooltips, soft popovers, live edits.
//
// Sections:
//   1. Helpers & platform        7. Save, undo & edits
//   2. Styles                    8. Rendering (pivots, charts, filters, grid)
//   3. Formula engine            9. Editing, keyboard, clipboard, find
//   4. Model & accessors        10. Live edits (agent API)
//   5. Chrome                   11. Collaboration (sync, connect)
//   6. Menus, palette, shortcuts sheet
// See README.md for architecture and for how agents should edit a sheet.
// ─────────────────────────────────────────────────────────────────────────────
import {
  type Ast,
  type CellChange,
  type Display,
  type Engine,
  type Scalar,
  FUNCTIONS,
  FUNCTION_NAMES,
  HyperlinkValue,
  colToLetter,
  displayValue,
  fmtGeneral,
  formulaReferences,
  functionHelp,
  isErr,
  letterToCol,
  makeEngine,
  parseFormula,
  parseRef,
  rcToRef,
  readableInk,
  safeHyperlinkUrl,
  shiftFormulaReferences,
  tokenize,
} from "./lib/formula.ts";
import { CHART_BOUNDS, MAX_CHARTS, PLACEMENT_ROWS, chartPlacement, valueAxis } from "./lib/charts.ts";
import type {
  AgentHint,
  Align,
  Cell,
  CellFmt,
  CellMap,
  CellOp,
  CellsPage,
  Chart,
  ChartType,
  Dims,
  FilterSort,
  FullPackedCells,
  GadgetStub,
  OpenedDocument,
  OperationEvent,
  OperationResult,
  PivotAggregate,
  PivotSettings,
  SheetFilter,
  SheetMeta,
  SheetReplacement,
  SheetSlice,
  SheetsDocument,
  SheetsPresenceEvent,
  Structure,
  SubscriberCallbacks,
  SubscriberEvent,
} from "./lib/protocol.ts";

// The bindings the Workshop's iframe bootstrap defines before this module runs: the RPC stub to
// this gadget's Durable Object, and Cap'n Web's RpcTarget for the callbacks it is handed.
declare const gadget: GadgetStub;
declare const RpcTarget: { new (): object };
declare global {
  // Set by the export renderer before this module loads, to the browser-mode format being made.
  var gadgetExportFormatId: string | undefined;
}


/* ═════════════════════════ 1. Helpers & platform ═════════════════════════ */

/** What `el` accepts as children: nodes, text, or nothing (skipped). */
type ElChild = Node | string | number | null | undefined | false;
/** `el` props: `class`, `text`, `html`, a `style` object, `on<event>` listeners, and attributes (`true` = present, null/false = absent). */
type ElProps = Record<string, unknown>;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, props?: ElProps | null, children?: ElChild | ElChild[]): HTMLElementTagNameMap[K];
function el(tag: string, props?: ElProps | null, children?: ElChild | ElChild[]): HTMLElement;
function el(tag: string, props: ElProps | null = {}, children: ElChild | ElChild[] = []): HTMLElement {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === void 0 || value === false) continue;
    if (key === "class") node.className = String(value);
    else if (key === "text") node.textContent = String(value);
    else if (key === "html") node.innerHTML = String(value);
    else if (key === "style" && typeof value === "object") Object.assign(node.style, value);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of ([] as ElChild[]).concat(children)) {
    if (child === null || child === void 0 || child === false || child === "") continue;
    node.appendChild(typeof child === "object" ? child : document.createTextNode(String(child)));
  }
  return node;
}
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
function svg(paths: string, size = 18): string {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || "");
const coarsePointer = matchMedia("(pointer: coarse)").matches;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const isExport = ["html", "pdf"].includes(globalThis.gadgetExportFormatId ?? "");
const clientId = Math.random().toString(36).slice(2);

// Shortcut labels in each platform's own vocabulary and modifier order.
function combo(...parts: string[]): string[] {
  const key = parts.pop() as string;
  const has = (m: string) => parts.includes(m);
  if (isMac) return [...has("alt") ? ["⌥"] : [], ...has("shift") ? ["⇧"] : [], ...has("mod") ? ["⌘"] : [], key];
  return [...has("mod") ? ["Ctrl"] : [], ...has("alt") ? ["Alt"] : [], ...has("shift") ? ["Shift"] : [], key];
}
// One renderer for every shortcut on screen (menus, tooltips, the sheet).
function keysEl(keys: string[], className: string): HTMLSpanElement {
  const box = el("span", { class: className });
  keys.forEach((k, i) => {
    if (!isMac && i) box.appendChild(el("span", { class: "k-plus" }, "+"));
    box.appendChild(el("span", { class: "k" + (Array.from(k).length === 1 ? " k-g" : "") }, k));
  });
  return box;
}
document.documentElement.classList.toggle("mac", isMac);

/* ══════════════════════════════ 2. Styles ════════════════════════════════ */

const STYLES = `
:root {
  color-scheme: light;
  --bg: #ffffff;
  --chrome: rgba(255,255,255,0.8);
  --raised: #ffffff;
  --text: #1b1b1f;
  --text-2: #46464e;
  --muted: #7b7b84;
  --faint: #ababb3;
  --hover: rgba(24,24,32,0.055);
  --press: rgba(24,24,32,0.085);
  --line: rgba(24,24,32,0.08);
  --line-strong: rgba(24,24,32,0.15);
  --accent: #e1632e;
  --accent-soft: rgba(225,99,46,0.12);
  --selection: rgba(225,99,46,0.2);
  --code-bg: rgba(24,24,32,0.05);
  --tip-bg: #1d1d21;
  --tip-text: #f4f4f5;
  --ok: #2f9e66;
  --bad: #d0473f;
  --shadow-pop: 0 0 0 0.5px rgba(24,24,32,0.14), 0 2px 6px -1px rgba(24,24,32,0.06), 0 14px 36px -8px rgba(24,24,32,0.2);
  --ease: cubic-bezier(0.2, 0.8, 0.2, 1);
  --font-ui: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif;
  --font-serif: "Iowan Old Style", Charter, "Bitstream Charter", "Sitka Text", Cambria, Georgia, ui-serif, serif;
  --font-mono: ui-monospace, "SF Mono", "JetBrains Mono", "Cascadia Code", Menlo, Consolas, monospace;
  --bar-h: 48px;
  /* Grid */
  --grid-line: rgba(24,24,32,0.075);
  --head-bg: #f9f9fa;
  --cell-sel: color-mix(in srgb, var(--accent) 8%, transparent);
  --filter-row: color-mix(in srgb, var(--accent) 4.5%, var(--bg));
  --link: #2f6fd1;
  --ref: #3478c7;
  --ref-soft: rgba(52,120,199,0.12);
}
@media screen and (prefers-color-scheme: dark) {
  :root:not(.document-export) {
    color-scheme: dark;
    --bg: #19191c;
    --chrome: rgba(25,25,28,0.8);
    --raised: #242428;
    --text: #ececef;
    --text-2: #c5c5cb;
    --muted: #8f8f98;
    --faint: #5d5d66;
    --hover: rgba(255,255,255,0.06);
    --press: rgba(255,255,255,0.1);
    --line: rgba(255,255,255,0.08);
    --line-strong: rgba(255,255,255,0.15);
    --accent: #f0743d;
    --accent-soft: rgba(240,116,61,0.16);
    --selection: rgba(240,116,61,0.32);
    --code-bg: rgba(255,255,255,0.07);
    --tip-bg: #f1f1f3;
    --tip-text: #19191c;
    --shadow-pop: 0 0 0 0.5px rgba(255,255,255,0.12), 0 14px 36px -6px rgba(0,0,0,0.6);
    --grid-line: rgba(255,255,255,0.065);
    --head-bg: #1e1e22;
    --cell-sel: color-mix(in srgb, var(--accent) 13%, transparent);
    --link: #7aa7ec;
    --ref: #6aa5dd;
    --ref-soft: rgba(106,165,221,0.16);
  }
}

* { box-sizing: border-box; }
html, body {
  margin: 0; height: 100%;
  background: var(--bg); color: var(--text);
  font: 13px/1.4 var(--font-ui);
  -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;
  text-rendering: optimizeLegibility;
}
body { overflow: hidden; }
::selection { background: var(--selection); }
button, input, select, textarea { font: inherit; color: inherit; }
* { scrollbar-width: thin; scrollbar-color: var(--line-strong) transparent; }
*::-webkit-scrollbar { width: 10px; height: 10px; }
*::-webkit-scrollbar-thumb { background: var(--line-strong); border-radius: 10px; border: 3px solid transparent; background-clip: content-box; }
*::-webkit-scrollbar-track, *::-webkit-scrollbar-corner { background: transparent; }

.app { display: flex; flex-direction: column; height: 100vh; height: 100dvh; }

/* ── Top bar ────────────────────────────────────────────────────────────── */
.bar {
  position: relative; z-index: 30; flex: 0 0 auto;
  height: var(--bar-h);
  display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 8px;
  padding: 0 10px;
  background: var(--chrome);
  -webkit-backdrop-filter: saturate(1.8) blur(16px); backdrop-filter: saturate(1.8) blur(16px);
  box-shadow: 0 1px 0 transparent;
  transition: box-shadow .24s var(--ease);
}
.bar.scrolled { box-shadow: 0 1px 0 var(--line); }
.tools { grid-column: 2; display: flex; align-items: center; gap: 1px; min-width: 0; }
.bar-right { grid-column: 3; justify-self: end; display: flex; align-items: center; gap: 2px; }
@media (max-width: 1180px) {
  .bar { display: flex; padding: 0 6px 0 4px; }
  .tools { flex: 1 1 auto; overflow-x: auto; scrollbar-width: none; padding: 0 6px; }
  .tools::-webkit-scrollbar { display: none; }
  .tools.fade-r { -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 28px), transparent); mask-image: linear-gradient(to right, #000 calc(100% - 28px), transparent); }
  .tools.fade-l { -webkit-mask-image: linear-gradient(to right, transparent, #000 28px); mask-image: linear-gradient(to right, transparent, #000 28px); }
  .tools.fade-l.fade-r { -webkit-mask-image: linear-gradient(to right, transparent, #000 28px, #000 calc(100% - 28px), transparent); mask-image: linear-gradient(to right, transparent, #000 28px, #000 calc(100% - 28px), transparent); }
  .bar-right { flex: 0 0 auto; }
}

.tb {
  position: relative; flex: 0 0 auto;
  height: 30px; min-width: 30px; padding: 0 6px;
  display: inline-flex; align-items: center; justify-content: center; gap: 2px;
  border: 0; border-radius: 7px; background: transparent;
  color: var(--text-2); cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  transition: background-color .12s var(--ease), color .12s var(--ease), transform .12s var(--ease);
}
.tb:hover { background: var(--hover); color: var(--text); }
.tb:active { transform: scale(0.94); background: var(--press); }
.tb.on, .tb.open { background: var(--press); color: var(--text); }
.tb.disabled { color: var(--faint); }
.tb.disabled:hover { background: transparent; color: var(--faint); }
.tb.disabled:active { transform: none; }
.tb svg { flex: 0 0 auto; }
.tb .chev { display: inline-flex; color: var(--faint); margin-right: -3px; transition: transform .18s var(--ease); }
.tb.open .chev { transform: rotate(180deg); }
.tb:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.tb.txt { font: 600 13px/1 var(--font-ui); letter-spacing: -0.01em; padding: 0 7px; font-variant-numeric: tabular-nums; }
.tb.txt.fx { font: italic 500 14px/1 var(--font-serif); }
.tb.fmt { width: 112px; justify-content: space-between; padding: 0 6px 0 10px; font-size: 13px; font-weight: 500; letter-spacing: -0.006em; }
.tb.fmt .label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tb.color .bar-swatch { position: absolute; left: 9px; right: 9px; bottom: 4px; height: 2.5px; border-radius: 2px; background: currentColor; opacity: 0; transition: opacity .15s; }
.tb.color.has-color .bar-swatch { opacity: 1; }
.tb.color .hl-swatch { position: absolute; inset: 5px 6px; border-radius: 5px; }
.tb.color svg { position: relative; }
.sep { width: 1px; height: 18px; background: var(--line); margin: 0 6px; flex: 0 0 auto; }
@media (pointer: coarse) { .tb { height: 36px; min-width: 36px; } :root { --bar-h: 52px; } }

/* Sync status: invisible while everything is fine; it appears only when a save
   is slow, when you press ⌘S, or when the connection drops. */
.status {
  height: 30px; padding: 0 8px;
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 12.5px; color: var(--muted); white-space: nowrap; user-select: none;
  opacity: 0; transform: translateY(3px); pointer-events: none;
  transition: opacity .22s var(--ease), transform .22s var(--ease);
}
.status.show { opacity: 1; transform: none; }
.s-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--faint); flex: 0 0 auto; }
.status.saving .s-dot { animation: breathe 1.1s ease-in-out infinite; }
.status.saved .s-dot { background: var(--ok); }
.status.offline .s-dot { background: var(--bad); }
.status.offline { color: var(--bad); }
@media (max-width: 1180px) { .status:not(.show) { display: none; } }
@keyframes breathe { 0%, 100% { opacity: 1; } 50% { opacity: .25; } }

/* A short word after an action that has no visible result of its own
   ("Link copied"). Same voice as a tooltip; never stacks, never lingers. */
.toast {
  position: fixed; left: 50%; bottom: 52px; z-index: 95; pointer-events: none;
  display: inline-flex; align-items: center; gap: 7px;
  padding: 6px 11px; border-radius: 9px;
  background: var(--tip-bg); color: var(--tip-text);
  font: 500 12.5px/18px var(--font-ui); white-space: nowrap;
  opacity: 0; transform: translate(-50%, 4px);
  transition: opacity .16s var(--ease), transform .16s var(--ease);
}
.toast.show { opacity: 1; transform: translate(-50%, 0); }
.toast .t-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--ok); }
.toast.bad .t-dot { background: var(--bad); }

/* ── Formula bar ────────────────────────────────────────────────────────── */
.fbar { display: flex; align-items: center; gap: 2px; height: 36px; flex: 0 0 auto; padding: 0 10px 0 6px;
  background: var(--bg); border-bottom: 1px solid var(--line); }
.namebox { width: 88px; height: 28px; flex: 0 0 auto; border: 0; border-radius: 7px; outline: none; background: transparent;
  font: 550 12.5px/28px var(--font-ui); font-variant-numeric: tabular-nums; color: var(--text-2); text-align: center;
  transition: background-color .12s var(--ease), box-shadow .12s var(--ease); }
.namebox:hover { background: var(--hover); }
.namebox:focus { background: var(--bg); box-shadow: inset 0 0 0 1.5px var(--accent); color: var(--text); }
.fx-sep { width: 1px; height: 18px; background: var(--line); margin: 0 6px; flex: 0 0 auto; }
.fx-label { width: 22px; flex: 0 0 auto; text-align: center; font: italic 14px/1 var(--font-serif); color: var(--faint); user-select: none; transition: color .15s var(--ease); }
.fbar:focus-within .fx-label { color: var(--accent); }
.finput { flex: 1 1 auto; min-width: 0; height: 28px; border: 0; outline: none; background: transparent; padding: 0 8px; border-radius: 7px;
  font: 13px/28px var(--font-mono); color: var(--text); caret-color: var(--accent); transition: background-color .12s var(--ease); }
.finput:hover { background: var(--hover); }
/* The cell a formula belongs to, while its cells are picked on another sheet. */
.fbar-origin { flex: 0 1 auto; min-width: 0; max-width: 220px; height: 22px; margin: 0 2px 0 4px; padding: 0 8px 0 6px; border: 0; border-radius: 6px;
  display: inline-flex; align-items: center; gap: 4px; cursor: pointer; white-space: nowrap;
  background: var(--accent-soft); color: var(--accent); font: 550 12px/22px var(--font-ui); font-variant-numeric: tabular-nums;
  transition: background-color .12s var(--ease), transform .12s var(--ease); animation: pop-in .16s var(--ease); }
.fbar-origin[hidden] { display: none; }
.fbar-origin:hover { background: color-mix(in srgb, var(--accent) 20%, transparent); }
.fbar-origin:active { transform: scale(.96); }
.fbar-origin:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.fbar-origin .origin-icon { display: inline-flex; flex: 0 0 auto; margin-right: 1px; }
.fbar-origin .origin-sheet { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.fbar-origin .origin-ref { flex: 0 0 auto; }
.finput:focus { background: transparent; }

/* ── Grid ───────────────────────────────────────────────────────────────── */
.workarea { flex: 1 1 auto; min-height: 0; display: flex; position: relative; }
.grid-scroll { flex: 1 1 auto; min-width: 0; overflow: auto; position: relative; background: var(--bg); outline: none; overscroll-behavior: contain; }
table.grid { border-collapse: separate; border-spacing: 0; table-layout: fixed; width: max-content; }
table.grid th, table.grid td { padding: 0; margin: 0; }
.grid th.colhead, .grid th.rowhead, .grid th.corner {
  background: var(--head-bg); color: var(--muted);
  font: 500 11.5px/1 var(--font-ui); font-variant-numeric: tabular-nums;
  position: sticky; z-index: 12; user-select: none; text-align: center; vertical-align: middle;
  border-right: 1px solid var(--grid-line); border-bottom: 1px solid var(--grid-line);
  transition: background-color .12s var(--ease), color .12s var(--ease), box-shadow .2s var(--ease); }
.grid th.colhead { top: 0; height: 24px; }
.grid th.rowhead { left: 0; }
.grid th.corner { top: 0; left: 0; z-index: 13; width: 44px; }
.grid th.colhead:hover, .grid th.rowhead:hover { color: var(--text-2); }
.grid th.colhead.hl, .grid th.rowhead.hl { background: color-mix(in srgb, var(--accent) 9%, var(--head-bg)); color: var(--text); }
.grid th.colhead.full, .grid th.rowhead.full { background: color-mix(in srgb, var(--accent) 18%, var(--head-bg)); color: var(--accent); font-weight: 650; }
/* The headers lift off the cells only once there is something underneath them. */
.grid-scroll.sy th.colhead, .grid-scroll.sy th.corner { box-shadow: 0 1px 0 var(--line), 0 6px 12px -10px rgba(0,0,0,.4); }
.grid-scroll.sx th.rowhead, .grid-scroll.sx th.corner { box-shadow: 1px 0 0 var(--line), 6px 0 12px -10px rgba(0,0,0,.4); }
.grid-scroll.sx.sy th.corner { box-shadow: 0 1px 0 var(--line), 1px 0 0 var(--line), 4px 4px 12px -8px rgba(0,0,0,.4); }
/* Spacers for the rows and columns that aren't drawn (only those near the view are). They keep
   the header strips continuous, so a fast scroll shows plain header and paper, never a hole. */
.grid th.head-space { position: sticky; top: 0; z-index: 12; height: 24px; padding: 0; background: var(--head-bg); border-bottom: 1px solid var(--grid-line); }
.grid tr.row-space > th.row-space-head { position: sticky; left: 0; z-index: 12; padding: 0; background: var(--head-bg); border-right: 1px solid var(--grid-line); }
.grid tr.row-space > td, .grid td.col-space { padding: 0; border: 0; }
.grid-scroll.sy th.head-space { box-shadow: 0 1px 0 var(--line), 0 6px 12px -10px rgba(0,0,0,.4); }
.grid-scroll.sx tr.row-space > th.row-space-head { box-shadow: 1px 0 0 var(--line), 6px 0 12px -10px rgba(0,0,0,.4); }

.grid td.cell { border-right: 1px solid var(--grid-line); border-bottom: 1px solid var(--grid-line);
  height: 24px; overflow: hidden; white-space: nowrap; position: relative;
  font-size: 13px; line-height: 23px; padding: 0 5px; vertical-align: middle; cursor: cell;
  color: var(--text); }
.grid td.cell .cv { display: block; overflow: hidden; text-overflow: clip; white-space: nowrap; }
.grid td.cell.num .cv { text-align: right; font-variant-numeric: tabular-nums; }
.grid td.cell a.cell-link { color: var(--link); text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: .2em;
  text-decoration-color: color-mix(in srgb, var(--link) 45%, transparent); cursor: pointer; transition: text-decoration-color .15s var(--ease); }
.grid td.cell a.cell-link:hover { text-decoration-color: var(--link); }
.grid td.cell.err { color: var(--bad); }
.grid td.cell.err .cv { text-align: center; font-weight: 550; }
.grid td.cell.has-error-detail { overflow: visible; z-index: 6; }
.formula-error-tooltip { display: none; position: absolute; left: calc(100% + 6px); top: -6px; z-index: 40; width: 300px; padding: 10px 12px;
  border-radius: 11px; background: var(--raised); color: var(--text); box-shadow: var(--shadow-pop);
  white-space: normal; line-height: 1.45; text-align: left; font-weight: 400; font-style: normal; font-size: 12.5px; cursor: default; animation: pop-in .16s var(--ease); }
.grid td.cell.has-error-detail:hover > .formula-error-tooltip { display: block; }
.formula-error-tooltip strong { display: block; color: var(--bad); margin-bottom: 3px; font-weight: 600; }
.formula-error-preview { margin-top: 8px; padding: 6px 8px; border-radius: 7px; background: var(--code-bg); color: var(--text-2); font: 12px/1.5 var(--font-mono); overflow-wrap: anywhere; }
.formula-error-preview mark { background: color-mix(in srgb, var(--bad) 20%, transparent); color: var(--bad); border-radius: 3px; padding: 1px 2px; }
/* Selection: a soft tint laid over any fill, plus a ring that glides from cell to cell. */
.grid td.cell.sel { background-image: linear-gradient(var(--cell-sel), var(--cell-sel)); }
.sel-range, .sel-ring { position: absolute; left: 0; top: 0; pointer-events: none; opacity: 0; border-radius: 2px;
  transition: opacity .12s var(--ease), transform .09s var(--ease), width .09s var(--ease), height .09s var(--ease); }
.sel-range { z-index: 5; box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 70%, transparent); }
.sel-ring { z-index: 5; box-shadow: inset 0 0 0 2px var(--accent); }
.sel-range.show, .sel-ring.show { opacity: 1; }
/* Moving rows/columns: selected whole headers can be picked up; while dragging, a soft copy of
   the block follows the pointer and an accent bar marks where it lands. */
.grid th.colhead.movable, .grid th.rowhead.movable { cursor: grab; }
body.header-moving, body.header-moving * { cursor: grabbing !important; user-select: none; }
.move-ghost, .move-line { position: absolute; left: 0; top: 0; display: none; pointer-events: none; }
.move-ghost { z-index: 15; border-radius: 3px; background: color-mix(in srgb, var(--accent) 9%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 45%, transparent), 0 10px 28px -14px rgba(0,0,0,.45); }
.move-line { z-index: 16; border-radius: 2px; background: var(--accent); opacity: 0;
  transition: opacity .1s var(--ease); }
.move-ghost.show { display: block; }
body.header-moving .move-line { display: block; }
.move-line.show { opacity: 1; }
.sel-range.jump, .sel-ring.jump { transition: opacity .12s var(--ease); }
.grid td.cell.wrap { white-space: normal; line-height: 1.35; height: auto; padding-top: 3px; padding-bottom: 3px; }
.grid td.cell.wrap .cv { white-space: pre-line; overflow: visible; overflow-wrap: anywhere; word-break: break-word; line-height: 1.35; }
.grid td.cell.text-overflow { overflow: visible; z-index: 1; }
.grid td.cell.text-overflow .cv { position: absolute; left: 5px; top: 0; overflow: hidden; white-space: nowrap; z-index: 2; pointer-events: none; }
.grid td.cell.text-overflow a.cell-link { pointer-events: auto; }
.grid td.cell.editing .cv { visibility: hidden; }
.grid tr.filter-row td.cell.filter-cell { background-color: var(--filter-row); font-weight: 600; padding-right: 27px; }
.grid tr.filter-row th.rowhead:not(.hl):not(.full) { color: var(--accent); box-shadow: inset 2px 0 var(--accent); }
.filter-trigger { position: absolute; right: 3px; top: 3px; width: 18px; height: 18px; border: 0; border-radius: 5px;
  background: transparent; color: var(--faint); display: inline-flex; align-items: center; justify-content: center;
  cursor: pointer; padding: 0; z-index: 3; transition: background-color .12s var(--ease), color .12s var(--ease); }
.filter-trigger:hover { background: var(--hover); color: var(--text); }
.filter-trigger.active { color: var(--accent); background: var(--accent-soft); }
.filter-trigger svg { width: 12px; height: 12px; }

/* Fill handle, resize handles, previews */
.fill-handle { position: absolute; z-index: 11; width: 7px; height: 7px; border-radius: 2px; background: var(--accent);
  box-shadow: 0 0 0 1.5px var(--bg); cursor: crosshair; display: none; transition: transform .12s var(--ease); }
.fill-handle:hover { transform: scale(1.35); }
.grid td.cell.fill-preview { background-image: linear-gradient(var(--cell-sel), var(--cell-sel)); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 55%, transparent); }
.col-resize { position: absolute; top: 0; right: -3px; width: 7px; height: 100%; cursor: col-resize; z-index: 5; }
.row-resize { position: absolute; left: 0; bottom: -3px; height: 7px; width: 100%; cursor: row-resize; z-index: 5; }
.col-resize::after, .row-resize::after { content: ""; position: absolute; background: var(--accent); border-radius: 1px; opacity: 0; transition: opacity .12s var(--ease); }
.col-resize::after { left: 3px; top: 4px; bottom: 4px; width: 1.5px; }
.row-resize::after { top: 3px; left: 6px; right: 6px; height: 1.5px; }
.col-resize:hover::after, .row-resize:hover::after { opacity: 1; }

/* Cell editor */
.cell-editor { position: absolute; z-index: 20; display: none; border: 0; border-radius: 2px;
  background: var(--raised); font: 13px/20px var(--font-ui); padding: 2px 5px; margin: 0;
  outline: none; resize: none; overflow: hidden; color: var(--text); caret-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent), 0 8px 24px -8px rgba(0,0,0,.3);
  min-width: 60px; white-space: pre; }
/* While cells are picked on another sheet the formula is typed in the formula bar; the in-cell
   editor keeps its text and caret but steps out of sight. */
.cell-editor.away { visibility: hidden; pointer-events: none; }
.cell-editor.capture { display: block; opacity: 0; width: 1px !important; min-width: 1px; height: 1px !important;
  min-height: 1px; padding: 0; border: 0; box-shadow: none; pointer-events: none; overflow: hidden; }

/* Formula assist */
.formula-assist { position: fixed; z-index: 70; width: min(360px, calc(100vw - 20px)); max-height: 260px; overflow: auto; padding: 5px;
  border-radius: 11px; background: var(--raised); color: var(--text); box-shadow: var(--shadow-pop); display: none; animation: pop-in .14s var(--ease); }
.formula-suggestion { padding: 6px 9px; border-radius: 7px; cursor: pointer; }
.formula-suggestion.active, .formula-suggestion:hover { background: var(--hover); }
.formula-suggestion strong { display: block; font: 550 12.5px/18px var(--font-mono); }
.formula-suggestion.active strong { color: var(--accent); }
.formula-suggestion span { display: block; color: var(--muted); font-size: 11.5px; margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.formula-syntax { padding: 7px 9px; }
.formula-syntax-code { font: 550 12.5px/1.6 var(--font-mono); color: var(--text-2); }
.formula-syntax-code .current { color: var(--accent); background: var(--accent-soft); border-radius: 4px; padding: 1px 3px; }
.formula-syntax-desc { color: var(--muted); font-size: 11.5px; margin-top: 3px; }
.formula-error { margin: 2px; padding: 8px 10px; border-radius: 7px; color: var(--bad); background: color-mix(in srgb, var(--bad) 9%, transparent); font-size: 12px; line-height: 1.4; }
/* Range outlines are inset shadows (plus the cell's own grid line on the right and bottom), so
   highlighting a reference never adds border width and nudges rows or text while you type. */
.grid td.cell.formula-ref { background-image: linear-gradient(var(--ref-soft), var(--ref-soft)); z-index: 5;
  box-shadow: inset 0 var(--ref-t, 0px) 0 var(--ref), inset 0 calc(-1 * var(--ref-b, 0px)) 0 var(--ref),
    inset var(--ref-l, 0px) 0 0 var(--ref), inset calc(-1 * var(--ref-r, 0px)) 0 0 var(--ref); }
.grid td.cell.formula-ref-top { --ref-t: 2px; }
.grid td.cell.formula-ref-bottom { --ref-b: 1px; border-bottom-color: var(--ref); }
.grid td.cell.formula-ref-left { --ref-l: 2px; }
.grid td.cell.formula-ref-right { --ref-r: 1px; border-right-color: var(--ref); }
.grid td.cell.formula-ref:not(.formula-ref-right) { border-right-color: transparent; }
.grid td.cell.formula-ref:not(.formula-ref-bottom) { border-bottom-color: transparent; }
.formula-range-handle { position: absolute; z-index: 11; width: 9px; height: 9px; border-radius: 50%; background: var(--ref); box-shadow: 0 0 0 1.5px var(--bg); cursor: nwse-resize; display: none; touch-action: none; }

/* Loading: a few shimmering rows where the grid will be. */
.skeleton { position: absolute; left: 56px; right: 24px; top: 40px; pointer-events: none; opacity: 0; z-index: 14; animation: sk-in .3s .25s var(--ease) forwards; transition: opacity .2s; }
.skeleton.gone { opacity: 0 !important; animation: none; }
.sk-row { display: flex; gap: 10px; margin: 0 0 14px; }
.sk { height: 11px; border-radius: 6px; background: linear-gradient(90deg, var(--code-bg) 0%, var(--hover) 40%, var(--code-bg) 80%); background-size: 300% 100%; animation: shimmer 1.6s linear infinite; }
@keyframes shimmer { from { background-position: 100% 0; } to { background-position: -200% 0; } }
@keyframes sk-in { to { opacity: 1; } }
/* A big workbook's load counts up under the rows, once it has taken a moment. */
.sk-note { margin: 4px 0 0; font: 500 12px/1.4 var(--font-ui); color: var(--muted); font-variant-numeric: tabular-nums; opacity: 0; transition: opacity .3s var(--ease); }
.sk-note.show { opacity: 1; }

/* ── Charts ─────────────────────────────────────────────────────────────── */
/* Charts float over everything drawn on the cells (selection, fill handle, live-edit marks) but
   still scroll under the sticky headers (12) and below the cell editor (20). */
.chart-layer { position: absolute; left: 0; top: 0; width: 100%; min-height: 100%; pointer-events: none; z-index: 11; }
.chart-card { position: absolute; background: var(--raised); border-radius: 12px; box-shadow: var(--shadow-pop); pointer-events: auto; overflow: hidden;
  transition: box-shadow .16s var(--ease); }
/* Only a just-created chart pops in; redraws (moving, editing cells, settings) stay still. */
.chart-card.chart-new { animation: pop-in .2s var(--ease); }
.chart-card.selected { box-shadow: 0 0 0 1.5px var(--accent), var(--shadow-pop); }
.chart-card-head { height: 34px; display: flex; align-items: center; gap: 8px; padding: 0 6px 0 12px; border-bottom: 1px solid var(--line); cursor: grab; user-select: none; touch-action: none; }
.chart-card-head:active { cursor: grabbing; }
.chart-card-head strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; font-weight: 600; letter-spacing: -0.005em; }
.chart-card-range { flex: 0 0 auto; color: var(--faint); font-size: 11px; margin-left: auto; font-variant-numeric: tabular-nums; white-space: nowrap; }
.chart-card-menu { flex: 0 0 auto; width: 26px; height: 26px; border: 0; border-radius: 7px; background: transparent; color: var(--muted); padding: 0; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center; transition: background-color .12s var(--ease), color .12s var(--ease), transform .12s var(--ease); }
.chart-card-menu:hover, .chart-card-menu.open { background: var(--hover); color: var(--text); }
.chart-card-menu:active { transform: scale(.94); }
.chart-card-body { height: calc(100% - 34px); padding: 8px; cursor: pointer; }
.chart-card svg { width: 100%; height: 100%; display: block; }
/* Chart drawings use fixed light-theme inks (the copied SVG keeps them); on screen in dark mode
   the gridlines, labels and slice separators follow the theme instead. */
@media screen and (prefers-color-scheme: dark) {
  :root:not(.document-export) .chart-card svg [stroke="#e4e4e1"] { stroke: var(--line-strong); }
  :root:not(.document-export) .chart-card svg [stroke="#9a9aa2"] { stroke: var(--faint); }
  :root:not(.document-export) .chart-card svg [stroke="#fff"] { stroke: var(--raised); }
  :root:not(.document-export) .chart-card svg [fill="#77777f"] { fill: var(--muted); }
  :root:not(.document-export) .chart-card svg [fill="#55555d"], :root:not(.document-export) .chart-card svg [fill="#66666e"] { fill: var(--text-2); }
}
.chart-empty { height: 100%; display: flex; align-items: center; justify-content: center; color: var(--faint); text-align: center; padding: 24px; }
/* Chart and pivot settings: a menu-sized pop, not a sidebar. */
.pop.settings-pop { width: 288px; min-width: 0; max-height: min(560px, calc(100vh - 24px)); padding: 0 12px 12px; display: flex; flex-direction: column; gap: 11px; }
.settings-head { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 8px; margin: 0 -12px; padding: 10px 12px 8px; background: var(--raised); }
.settings-head strong { flex: 1 1 auto; min-width: 0; font-size: 13px; font-weight: 600; letter-spacing: -0.006em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.settings-head .settings-sub { color: var(--faint); font-size: 11.5px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.settings-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.settings-checks { display: flex; flex-direction: column; gap: 0; margin: -2px 0; }
.chart-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.chart-field > span { color: var(--muted); font-size: 11.5px; font-weight: 550; }
.chart-field input[type=text], .chart-field select {
  width: 100%; height: 32px; border: 0; border-radius: 8px; padding: 0 10px; outline: none; color: var(--text); background: var(--bg);
  box-shadow: inset 0 0 0 1px var(--line-strong); transition: box-shadow .12s var(--ease); }
.chart-field select { appearance: none; -webkit-appearance: none; padding-right: 30px; cursor: pointer;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%238f8f98' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m7 10 5 5 5-5'/%3E%3C/svg%3E");
  background-repeat: no-repeat; background-position: right 9px center; background-size: 14px; }
.chart-field input[type=text]:hover, .chart-field select:hover { box-shadow: inset 0 0 0 1px var(--faint); }
.chart-field input[type=text]:focus, .chart-field select:focus { box-shadow: inset 0 0 0 1.5px var(--accent); }
.chart-check { display: flex; align-items: center; gap: 8px; color: var(--text); min-height: 28px; cursor: pointer; }
.chart-check input, .pivot-filter-option input, .filter-option input { accent-color: var(--accent); width: 14px; height: 14px; margin: 0; }
.settings-actions { display: flex; align-items: center; gap: 6px; border-top: 1px solid var(--line); margin: 0 -12px; padding: 10px 12px 0; }
.settings-actions .grow { flex: 1 1 auto; }
/* Buttons in popovers and sheets share one calm shape. */
.settings-actions button, .filter-actions button, .sheet .row button {
  height: 30px; padding: 0 12px; border: 0; border-radius: 8px; background: var(--hover); color: var(--text); cursor: pointer;
  font-size: 12.5px; font-weight: 500; white-space: nowrap;
  transition: background-color .12s var(--ease), color .12s var(--ease), transform .12s var(--ease); }
.settings-actions button:hover, .filter-actions button:hover, .sheet .row button:hover { background: var(--press); }
.settings-actions button:active, .filter-actions button:active, .sheet .row button:active { transform: scale(.96); }
.filter-actions button.primary, .sheet .row button.primary { background: var(--accent); color: #fff; }
.filter-actions button.primary:hover, .sheet .row button.primary:hover { background: color-mix(in srgb, var(--accent) 88%, #000); }
.settings-actions button.danger, .sheet .row button.danger { color: var(--bad); background: color-mix(in srgb, var(--bad) 9%, transparent); }
.settings-actions button.danger:hover, .sheet .row button.danger:hover { background: color-mix(in srgb, var(--bad) 15%, transparent); }
.pivot-note { color: var(--faint); font-size: 11.5px; line-height: 1.45; }
.pivot-filter-values { border-radius: 9px; box-shadow: inset 0 0 0 1px var(--line); max-height: 150px; overflow: auto; padding: 4px; }
.pivot-filter-option { display: flex; align-items: center; gap: 8px; padding: 5px 6px; border-radius: 6px; cursor: pointer; }
.pivot-filter-option span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pivot-filter-option:hover { background: var(--hover); }

/* ── Sheet tabs ─────────────────────────────────────────────────────────── */
.tabbar { display: flex; align-items: center; gap: 2px; height: 40px; padding: 0 8px; flex: 0 0 auto;
  background: var(--bg); border-top: 1px solid var(--line); overflow-x: auto; scrollbar-width: none; }
.tabbar::-webkit-scrollbar { display: none; }
.tab { position: relative; display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 12px;
  font-size: 12.5px; font-weight: 500; color: var(--muted); cursor: pointer; white-space: nowrap; flex: 0 0 auto; user-select: none;
  border-radius: 7px; transition: background-color .12s var(--ease), color .12s var(--ease), transform .12s var(--ease); max-width: 200px; }
.tab:hover { background: var(--hover); color: var(--text); }
.tab:active { transform: scale(.97); }
.tab.active { background: var(--press); color: var(--text); }
.tab .tname { overflow: hidden; text-overflow: ellipsis; }
/* The sheet whose cell is being edited, while picking cells on another sheet. */
.tab.editing-home { color: var(--accent); }
.tab.editing-home::before { content: ""; position: absolute; left: 12px; right: 12px; bottom: 2px; height: 2px; border-radius: 2px; background: var(--accent); }
/* Renaming: the tab itself becomes the field. Same size, same text position;
   it just lifts onto the raised surface with an accent ring. */
.tab.renaming { background: var(--raised); color: var(--text); cursor: text; max-width: 240px;
  box-shadow: 0 0 0 1.5px var(--accent), 0 0 0 4.5px var(--accent-soft), 0 2px 8px -3px rgba(0,0,0,.18);
  transition: box-shadow .16s var(--ease), background-color .16s var(--ease); }
.tab.renaming:active { transform: none; }
.tab-rename { width: 1ch; min-width: 2ch; max-width: 216px; height: 20px; padding: 0; margin: 0; border: 0; outline: none;
  background: transparent; color: inherit; font: inherit; letter-spacing: inherit; caret-color: var(--accent); transition: width .08s var(--ease); }
.tab-rename::selection { background: var(--accent-soft); }
.tab-measure { position: absolute; visibility: hidden; white-space: pre; pointer-events: none; font-size: 12.5px; font-weight: 500; }
.tab.renaming.invalid { box-shadow: 0 0 0 1.5px var(--bad), 0 0 0 4.5px color-mix(in srgb, var(--bad) 14%, transparent); }
.tab.renamed { animation: tab-renamed .6s var(--ease); }
@keyframes tab-renamed { 0% { background: var(--accent-soft); color: var(--accent); } 100% { } }
.tab-new { animation: tab-rise .26s var(--ease); }
@keyframes tab-rise { from { opacity: 0; transform: translateY(6px) scale(.96); } }
.tab.touched::after { content: ""; position: absolute; top: 5px; right: 5px; width: 5px; height: 5px; border-radius: 50%; background: var(--accent); animation: tab-touch 1.6s var(--ease) forwards; }
@keyframes tab-touch { 0% { opacity: 0; transform: scale(.4); } 15% { opacity: 1; transform: none; } 70% { opacity: 1; } 100% { opacity: 0; } }
.tab-add { width: 28px; height: 28px; flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center;
  border-radius: 7px; color: var(--muted); cursor: pointer; transition: background-color .12s var(--ease), color .12s var(--ease), transform .12s var(--ease); }
.tab-add:hover { background: var(--hover); color: var(--text); }
.tab-add:active { transform: scale(.94); }
.tab-add svg { width: 16px; height: 16px; }

/* ── Popovers & menus ───────────────────────────────────────────────────── */
.pop {
  position: fixed; z-index: 60;
  min-width: 190px; max-width: min(360px, calc(100vw - 16px)); max-height: min(440px, calc(100vh - 80px));
  overflow-y: auto; padding: 5px;
  background: var(--raised); color: var(--text); border-radius: 11px; box-shadow: var(--shadow-pop);
  font-size: 13px; transform-origin: var(--origin, top left);
  animation: pop-in .16s var(--ease);
}
.pop.closing { animation: pop-out .1s ease-in forwards; pointer-events: none; }
@keyframes pop-in { from { opacity: 0; transform: scale(.96); } }
@keyframes pop-out { to { opacity: 0; transform: scale(.98); } }
.mi {
  display: flex; align-items: center; gap: 10px;
  padding: 6px 10px 6px 7px; border-radius: 7px;
  cursor: pointer; user-select: none; white-space: nowrap;
}
.mi:hover, .mi.active, .mi:focus-visible { background: var(--hover); outline: none; }
.mi.disabled { color: var(--faint); pointer-events: none; }
.mi.disabled .mi-icon { color: var(--faint); }
.mi.danger:hover, .mi.danger:hover .mi-icon { color: var(--bad); }
.mi-icon { width: 22px; height: 22px; flex: 0 0 auto; display: flex; align-items: center; justify-content: center; color: var(--muted); }
.mi-icon svg { display: block; }
.mi-text { flex: 1 1 auto; min-width: 0; display: flex; align-items: baseline; }
.mi-label { flex: 1 1 auto; line-height: 20px; overflow: hidden; text-overflow: ellipsis; }
.mi-keys, .mi-md { flex: 0 0 auto; padding-left: 24px; color: var(--faint); line-height: 20px; transition: color .12s var(--ease); }
.mi-keys { font: 12.5px/20px var(--font-ui); font-variant-numeric: tabular-nums; }
.mi-md { font: 12px/20px var(--font-mono); letter-spacing: .02em; }
.mi:hover .mi-keys, .mi.active .mi-keys, .mi:hover .mi-md, .mi.active .mi-md { color: var(--muted); }
.mi-check { flex: 0 0 auto; align-self: center; width: 16px; height: 16px; margin-left: 10px; display: flex; align-items: center; justify-content: center; color: var(--accent); visibility: hidden; }
.mi-check.on { visibility: visible; }
.mi-check svg { display: block; }
.mi-keys + .mi-check, .mi-md + .mi-check { margin-left: 12px; }
.msep { height: 1px; background: var(--line); margin: 5px -5px; }
.mhead { padding: 7px 8px 5px; font-size: 11.5px; font-weight: 550; color: var(--muted); }
.mempty { padding: 10px; color: var(--faint); }
.k { display: inline-block; text-align: center; }
.mac .k-g { min-width: 1.12em; }
.k-plus { display: inline-block; margin: 0 .1em; opacity: .7; }

.palette { width: 248px; padding: 4px 8px 10px; }
.swatches { display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px; padding: 0 2px; }
.sw {
  aspect-ratio: 1; border: 0; border-radius: 8px; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  font-weight: 620; font-size: 14px; background: var(--bg);
  box-shadow: inset 0 0 0 1px var(--line);
  transition: transform .12s var(--ease), box-shadow .12s var(--ease);
}
.sw:hover { transform: scale(1.07); }
.sw:active { transform: scale(.96); }
.sw.on { box-shadow: inset 0 0 0 1px var(--line), 0 0 0 2px var(--raised), 0 0 0 3.5px var(--accent); }
.sw.none { background: linear-gradient(135deg, transparent calc(50% - .75px), var(--faint) calc(50% - .75px), var(--faint) calc(50% + .75px), transparent calc(50% + .75px)), var(--bg); }
.custom-row { display: flex; align-items: center; gap: 6px; margin: 10px 2px 0; padding-top: 9px; border-top: 1px solid var(--line); color: var(--muted); font-size: 12px; }
.custom-row .grow { flex: 1 1 auto; }
.custom-pick { position: relative; height: 26px; padding: 0 8px 0 6px; display: inline-flex; align-items: center; gap: 6px; border-radius: 7px; cursor: pointer; color: var(--text-2); transition: background-color .12s var(--ease); }
.custom-pick:hover { background: var(--hover); }
.custom-pick i { width: 14px; height: 14px; border-radius: 4px; box-shadow: inset 0 0 0 1px var(--line-strong); background: conic-gradient(#e5484d, #f5a524, #46a758, #3e8ed0, #8e4ec6, #e5484d); }
.custom-pick input { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; border: 0; padding: 0; }

/* Function picker & filter menu live inside .pop */
.pop.fn-menu { width: 300px; max-height: min(540px, 78vh); padding: 0 5px 5px; }
.pop-search { position: sticky; top: 0; z-index: 3; display: flex; align-items: center; gap: 4px; margin: 0 -5px 4px; padding: 5px 5px 4px 10px; background: var(--raised); border-bottom: 1px solid var(--line); color: var(--muted); }
.pop-search > span, .filter-search-row > span { display: inline-flex; flex: 0 0 auto; }
.pop-search input, .fn-search, .filter-search { flex: 1 1 auto; width: 100%; min-width: 0; height: 30px; border: 0; outline: 0; background: transparent; color: var(--text); font: 13px var(--font-ui); padding: 0 6px; }
.pop-search input::placeholder, .filter-search::placeholder { color: var(--faint); }
.fn-group + .fn-group { border-top: 1px solid var(--line); margin-top: 2px; padding-top: 2px; }
.fn-head { width: 100%; min-height: 30px; border: 0; border-radius: 7px; background: transparent; color: var(--muted); padding: 5px 8px; display: flex; align-items: center; justify-content: space-between; cursor: pointer; text-align: left; transition: background-color .12s var(--ease), color .12s var(--ease); }
.fn-head:hover { background: var(--hover); color: var(--text); }
.fn-head-label { font-size: 11.5px; font-weight: 550; }
.fn-head-count { margin-left: auto; margin-right: 6px; color: var(--faint); font-size: 11px; font-variant-numeric: tabular-nums; }
.fn-chev { display: inline-flex; color: var(--faint); transition: transform .16s var(--ease); }
.fn-group.open .fn-chev { transform: rotate(180deg); }
.fn-items { display: none; padding-bottom: 3px; }
.fn-group.open .fn-items { display: block; animation: fade-in .14s var(--ease); }
.fn-items .mi-label { font: 12.5px/20px var(--font-mono); }
.fn-no-results { padding: 18px 10px; text-align: center; color: var(--faint); }
.pop.filter-menu { width: 260px; min-width: 0; padding: 5px; }
.filter-sort { display: flex; flex-direction: column; }
.filter-links { display: flex; align-items: center; justify-content: space-between; padding: 2px 4px 4px; }
.filter-links button { border: 0; background: transparent; color: var(--accent); padding: 3px 6px; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 500; }
.filter-links button:hover { background: var(--accent-soft); }
.filter-search-row { display: flex; align-items: center; gap: 4px; margin: 0 0 4px; padding: 0 4px 0 8px; border-radius: 8px; box-shadow: inset 0 0 0 1px var(--line); color: var(--faint); }
.filter-search-row:focus-within { box-shadow: inset 0 0 0 1.5px var(--accent); }
.filter-options { max-height: 220px; overflow: auto; padding: 0; }
.filter-option { display: flex; align-items: center; gap: 9px; padding: 5px 8px; border-radius: 7px; cursor: pointer; }
.filter-option:hover { background: var(--hover); }
.filter-option span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.filter-actions { display: flex; justify-content: flex-end; gap: 6px; padding: 8px 2px 2px; margin-top: 4px; border-top: 1px solid var(--line); }
.filter-actions .grow { flex: 1 1 auto; }
.filter-empty { padding: 10px; color: var(--faint); }

.tip {
  position: fixed; z-index: 90; pointer-events: none;
  display: flex; align-items: baseline; gap: 7px;
  padding: 4px 8px; border-radius: 7px;
  background: var(--tip-bg); color: var(--tip-text);
  font: 500 12px/18px var(--font-ui); white-space: nowrap;
  opacity: 0; transform: translateY(-2px);
  transition: opacity .12s var(--ease), transform .12s var(--ease);
}
.tip.show { opacity: 1; transform: none; }
.tip-keys { font-weight: 450; font-variant-numeric: tabular-nums; color: color-mix(in srgb, var(--tip-text) 58%, transparent); }

.sheet-overlay { position: fixed; inset: 0; z-index: 80; display: flex; align-items: center; justify-content: center; padding: 16px; background: rgba(12,12,16,.28); -webkit-backdrop-filter: blur(3px); backdrop-filter: blur(3px); animation: fade-in .16s var(--ease); }
@keyframes fade-in { from { opacity: 0; } }
.sheet { width: min(640px, 100%); max-height: min(80vh, 700px); overflow-y: auto; padding: 22px 24px 18px; background: var(--raised); border-radius: 14px; box-shadow: var(--shadow-pop); animation: pop-in .2s var(--ease); }
.sheet h2 { margin: 0 0 4px; font-size: 15px; font-weight: 620; letter-spacing: -0.01em; }
.sheet .sub { margin: 0 0 16px; color: var(--muted); font-size: 12.5px; }
.sheet .row { display: flex; justify-content: flex-end; gap: 6px; margin-top: 14px; }
.sheet-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 0 32px; }
@media (max-width: 580px) { .sheet-cols { grid-template-columns: 1fr; } }
.sheet h3 { margin: 14px 0 4px; font-size: 11.5px; font-weight: 550; color: var(--muted); }
.krow { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 32px; border-bottom: 1px solid var(--line); font-size: 13px; line-height: 20px; color: var(--text-2); }
.krow:last-child { border-bottom: 0; }
.chips { display: flex; align-items: center; gap: 4px; flex: 0 0 auto; }
.chip {
  display: inline-flex; align-items: center; justify-content: center;
  height: 22px; min-width: 22px; padding: 0 6px; border-radius: 6px;
  background: var(--hover); box-shadow: inset 0 -1px 0 var(--line-strong);
  font: 500 12px/22px var(--font-ui); font-variant-numeric: tabular-nums; color: var(--text-2);
}
.chip.md { font: 400 11.5px/22px var(--font-mono); letter-spacing: .02em; }

/* ── Export & print ─────────────────────────────────────────────────────── */
html.document-export, html.document-export body { height: auto; overflow: visible; background: #fff; }
html.document-export .app { display: none; }
@media screen { html.document-export body { padding: 0.5in; } html.document-export #printWorkbook { display: block; } html.document-export .print-sheet + .print-sheet { margin-top: 36px; } }
html.document-export .print-grid th.colhead, html.document-export .print-grid th.rowhead, html.document-export .print-grid th.corner { position: static; }
#printWorkbook { display: none; }
@page { size: landscape; margin: 0.4in; }
@media print {
  html, body { height: auto; overflow: visible; background: #fff; }
  .app, .pop, .tip, .toast, .sheet-overlay, .formula-assist { display: none !important; }
  #printWorkbook { display: block; color: var(--text); }
  .print-sheet { break-after: page; }
  .print-sheet:last-child { break-after: auto; }
  .print-sheet-title {
    margin: 0 0 12px;
    font-size: 16pt;
    font-weight: 650;
    letter-spacing: -0.01em;
  }
  .print-sheet-error { font-size: 11pt; color: var(--muted); }
  table.print-grid {
    width: 100% !important;
    border-collapse: collapse;
    table-layout: fixed;
  }
  .print-grid thead { display: table-header-group; }
  .print-grid tr { break-inside: avoid; }
  .print-grid th.colhead, .print-grid th.rowhead, .print-grid th.corner {
    position: static;
    height: 18px;
    font-size: 8pt;
  }
  .print-grid th.rowhead, .print-grid th.corner { width: 32px; }
  .print-grid td.cell {
    height: auto;
    min-width: 0;
    font-size: 8pt;
    line-height: 1.25;
    padding-top: 0; padding-bottom: 0;
    cursor: default;
  }
  .print-grid td.cell.wrap { line-height: 1.3; padding-top: 2px; padding-bottom: 2px; }
  .print-grid td.cell.wrap .cv { white-space: pre-line; }
  .print-grid td.cell a.cell-link { text-decoration-color: currentColor; }
  .print-part { margin: 0 0 6px; font-size: 8pt; color: var(--muted); }
  .print-part-next { break-before: page; }
  .print-chart { margin: 18px 0 0; width: 520px; break-inside: avoid; }
  .print-chart figcaption { font-size: 10pt; font-weight: 600; margin: 0 0 6px; }
  .print-chart svg { display: block; width: 520px; height: 270px; font-family: var(--font-ui); }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: .01ms !important; transition-duration: .01ms !important; }
}
`;
document.head.appendChild(el("style", { text: STYLES }));

const ICONS = {
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H12"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H12"/>',
  bold: '<path d="M7 5h5.5a3.5 3.5 0 0 1 0 7H7z"/><path d="M7 12h6.5a3.5 3.5 0 0 1 0 7H7z"/>',
  italic: '<path d="M11 5h7"/><path d="M6 19h7"/><path d="M14.5 5 9.5 19"/>',
  underline: '<path d="M7 4.5V11a5 5 0 0 0 10 0V4.5"/><path d="M5.5 20h13"/>',
  strike: '<path d="M16.2 7.6C15.7 5.9 14.1 5 12 5 9.6 5 7.8 6.3 7.8 8.2c0 1.2.6 2.1 1.9 2.8"/><path d="M4.5 12h15"/><path d="M15 13.6c.9.6 1.3 1.4 1.3 2.4 0 2-1.9 3.4-4.4 3.4-2.3 0-4-1-4.6-2.8"/>',
  color: '<path d="M6.5 16.5 12 4l5.5 12.5"/><path d="M8.6 12h6.8"/>',
  alignLeft: '<path d="M4 6h16M4 12h10M4 18h13"/>',
  alignCenter: '<path d="M4 6h16M7 12h10M5.5 18h13"/>',
  alignRight: '<path d="M4 6h16M10 12h10M7 18h13"/>',
  wrap: '<path d="M4 6h16"/><path d="M4 12h12.5a3 3 0 0 1 0 6H13"/><path d="m15 16-2 2 2 2"/><path d="M4 18h5"/>',
  sigma: '<path d="M17.5 6V4.5h-11l6 7.5-6 7.5h11V18"/>',
  currency: '<path d="M12 3.5v17"/><path d="M16.5 7.5c-.6-1.4-2.2-2.3-4.4-2.3-2.6 0-4.3 1.3-4.3 3.2 0 4.4 9 2.4 9 7 0 1.9-1.9 3.4-4.6 3.4-2.4 0-4.1-1-4.8-2.7"/>',
  percent: '<path d="M18.5 5.5 5.5 18.5"/><circle cx="7.5" cy="7.5" r="2.2"/><circle cx="16.5" cy="16.5" r="2.2"/>',
  sortAsc: '<path d="M7 4.5v15"/><path d="m4 7.5 3-3 3 3"/><path d="M13 7h7M13 12h5M13 17h3"/>',
  sortDesc: '<path d="M7 4.5v15"/><path d="m4 16.5 3 3 3-3"/><path d="M13 7h3M13 12h5M13 17h7"/>',
  rowAbove: '<rect x="3.5" y="12" width="17" height="7.5" rx="2"/><path d="M12 3.5v6M9 6.5h6"/>',
  rowBelow: '<rect x="3.5" y="4.5" width="17" height="7.5" rx="2"/><path d="M12 14.5v6M9 17.5h6"/>',
  colLeft: '<rect x="12" y="3.5" width="7.5" height="17" rx="2"/><path d="M3.5 12h6M6.5 9v6"/>',
  fitWidth: '<path d="M4 4.5v15M20 4.5v15"/><path d="M7.5 12h9"/><path d="m10 9.5-2.5 2.5 2.5 2.5M14 9.5l2.5 2.5-2.5 2.5"/>',
  fitHeight: '<path d="M4.5 4h15M4.5 20h15"/><path d="M12 7.5v9"/><path d="m9.5 10 2.5-2.5 2.5 2.5M9.5 14l2.5 2.5 2.5-2.5"/>',
  colRight: '<rect x="4.5" y="3.5" width="7.5" height="17" rx="2"/><path d="M14.5 12h6M17.5 9v6"/>',
  rowDelete: '<rect x="3.5" y="8" width="17" height="8" rx="2"/><path d="m10 10.5 4 3M14 10.5l-4 3"/>',
  colDelete: '<rect x="8" y="3.5" width="8" height="17" rx="2"/><path d="m10.5 10 3 4M13.5 10l-3 4"/>',
  trash: '<path d="M4.5 7h15"/><path d="M9.5 7V5.2c0-.4.3-.7.7-.7h3.6c.4 0 .7.3.7.7V7"/><path d="m6.5 7 .8 11.3c.1.9.8 1.7 1.8 1.7h5.8c1 0 1.7-.8 1.8-1.7L17.5 7"/>',
  plus: '<path d="M12 5.5v13M5.5 12h13"/>',
  clear: '<path d="M5.5 7V5h11v2"/><path d="M11 5 8.5 19"/><path d="m14.5 14.5 5 5M19.5 14.5l-5 5"/>',
  eraser: '<path d="m8.5 19.5-4-4a1.5 1.5 0 0 1 0-2.1l8.9-8.9a1.5 1.5 0 0 1 2.1 0l4 4a1.5 1.5 0 0 1 0 2.1L12 19.5z"/><path d="M8.5 19.5h11"/><path d="m9 9 6 6"/>',
  filter: '<path d="M4.5 5.5h15l-5.8 6.8v5.2l-3.4 1.7v-6.9z"/>',
  chart: '<path d="M4.5 4.5v15h15"/><path d="m8 14.5 3.5-4 3 2.5 4.5-5.5"/>',
  pivot: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M3.5 9.5h17M9 4.5v15"/><path d="M13 13.5h4.5M15.2 11.3v4.5"/>',
  chevron: '<path d="m7 10 5 5 5-5"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  more: '<circle cx="5.5" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.3" fill="currentColor" stroke="none"/>',
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2.5"/><path d="M6.5 10h.01M10 10h.01M14 10h.01M17.5 10h.01M8 14.5h8"/>',
  external: '<path d="M13.5 4.5h6v6"/><path d="M19.5 4.5 11 13"/><path d="M18 14v4a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 5 18V8a1.5 1.5 0 0 1 1.5-1.5h4"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6A1.5 1.5 0 0 0 14 4.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/>',
  cut: '<circle cx="6.5" cy="17" r="2.5"/><circle cx="17.5" cy="17" r="2.5"/><path d="M8.3 15.2 17 4.5M15.7 15.2 7 4.5"/>',
  clipboard: '<rect x="5.5" y="5" width="13" height="15.5" rx="2"/><path d="M9.5 5V4.2c0-.4.3-.7.7-.7h3.6c.4 0 .7.3.7.7V5"/><path d="M9 11h6M9 15h4"/>',
  pasteText: '<rect x="5.5" y="5" width="13" height="15.5" rx="2"/><path d="M9.5 5V4.2c0-.4.3-.7.7-.7h3.6c.4 0 .7.3.7.7V5"/><path d="M9 10.5h6M12 10.5v6"/>',
  link: '<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.2 1.2"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.2-1.2"/>',
  pencil: '<path d="M14.5 5.5 18.5 9.5"/><path d="M4.5 19.5 5.5 15 16 4.5a2.1 2.1 0 0 1 3 3L8.5 18z"/>',
  duplicate: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6A1.5 1.5 0 0 0 14 4.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/><path d="M14 11.5v5M11.5 14h5"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5"/>',
  back: '<path d="m14.5 6-6 6 6 6"/>',
  close: '<path d="m6.5 6.5 11 11M17.5 6.5l-11 11"/>',
  lineChart: '<path d="M4.5 4.5v15h15"/><path d="m8 14.5 3.5-4 3 2.5 4.5-5.5"/>',
  pieChart: '<path d="M12 3.5v8.5h8.5"/><path d="M19.5 15A8.5 8.5 0 1 1 9 3.9"/>',
  areaChart: '<path d="M4.5 4.5v15h15"/><path d="M7.5 17.5v-4l3.5-3.5 3 2.5 4.5-5v10z" fill="currentColor" fill-opacity=".14"/>',
  barChart: '<path d="M4.5 19.5h15"/><rect x="6" y="11" width="3" height="8.5" rx=".8"/><rect x="10.5" y="6" width="3" height="13.5" rx=".8"/><rect x="15" y="13.5" width="3" height="6" rx=".8"/>',
  freeze: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M3.5 9.5h17M9 4.5v15" stroke-width="2.4"/>',
};

/* 3. Formula engine: lib/formula.ts (shared with server.ts) */

/* ═════════════════════════ 4. Model & accessors ══════════════════════════ */
const MAX_ROWS = 50000, MAX_COLS = 702; // the server's limits too
const DEFAULT_COL_W = 92;
const DEFAULT_ROW_H = 24;
const HEAD_W = 44;
const MAX_PRINT_CELLS = 100000;

/** The workbook as this browser holds it: the server's structure plus every sheet's cells. */
interface Model {
  revision: number;
  title: string;
  sheetOrder: string[];
  sheets: Record<string, SheetMeta>;
  cells: Record<string, CellMap>;
}
const model: Model = {
  revision: 0,
  title: "Untitled spreadsheet",
  sheetOrder: [],
  sheets: {},
  cells: {},
};
// "" until the first snapshot names a sheet.
let activeSheetId = "";
let engine: Engine = makeEngine(model);
// Cells edited here since the last recalculation; a local edit path passes `rebuildEngine([])`
// and its edits come from this list.
let editedSinceRecalc: CellChange[] = [], editedOverflow = false;
function noteEditedCell(sheetId: string, ref: string) {
  if (editedOverflow) return;
  editedSinceRecalc.push({ sheetId, ref });
  if (editedSinceRecalc.length > 250000) { editedOverflow = true; editedSinceRecalc = []; }
}
// Without `changes`, results are all thrown away and worked out again as cells are shown (any
// change the engine can't trace: structure, sheet names, reloads). With `changes`, only those
// cells and the formulas that depend on them are recalculated.
function rebuildEngine(changes?: CellChange[]) {
  const edited = editedSinceRecalc, overflow = editedOverflow;
  editedSinceRecalc = []; editedOverflow = false;
  const names = sheetNamesKey();
  const incremental = Array.isArray(changes) && !overflow && engine?.model === model && engine.namesKey === names
    && engine.invalidate(edited.length ? changes.concat(edited) : changes);
  if (!incremental) { engine = makeEngine(model); engine.namesKey = names; }
  findModelChanged();
}
// Sheet names (and which sheets exist) decide what a reference means; when they change, every
// result is worked out again.
function sheetNamesKey() { return model.sheetOrder.map((id) => id + "\u0000" + (model.sheets[id]?.name || "")).join("\u0001"); }

// Selection: anchor + focus (row/col). The visible rectangle is selRange().
/** A zero-based cell position. */
interface RC { r: number; c: number }
/** A zero-based, inclusive rectangle of cells (r1 <= r2, c1 <= c2). */
interface Area { r1: number; c1: number; r2: number; c2: number }
let anchor: RC = { r: 0, c: 0 };
let extraRanges: Area[] = [];
function selRange(): Area {
  return { r1: Math.min(anchor.r, focus.r), c1: Math.min(anchor.c, focus.c), r2: Math.max(anchor.r, focus.r), c2: Math.max(anchor.c, focus.c) };
}
function selectionRanges(): Area[] { return [...extraRanges, selRange()]; }
function addCurrentRangeToSelection() {
  const range = selRange();
  if (!extraRanges.some((item) => item.r1 === range.r1 && item.c1 === range.c1 && item.r2 === range.r2 && item.c2 === range.c2)) extraRanges.push(range);
}
function cellInSelection(row: number, column: number) {
  return selectionRanges().some((range) => row >= range.r1 && row <= range.r2 && column >= range.c1 && column <= range.c2);
}
function isWholeHeaderRange(range: Area, sheet = curSheet()) {
  return (range.r1 === 0 && range.r2 === sheet.rows - 1) || (range.c1 === 0 && range.c2 === sheet.cols - 1);
}
function prepareHeaderSelection(additive: boolean) {
  if (!additive) { extraRanges = []; return; }
  const retained = selectionRanges().filter((range) => isWholeHeaderRange(range));
  extraRanges = retained.filter((range, index) => retained.findIndex((item) => item.r1 === range.r1 && item.c1 === range.c1 && item.r2 === range.r2 && item.c2 === range.c2) === index);
}
let focus: RC = { r: 0, c: 0 };
// A run of Tab moves along a row, as Excel and Google Sheets keep it: the column it began in
// (`startC`) and the cell it left active (`at`). Enter that commits the cell at `at` goes to
// `startC` on the next row. Any other selection change ends the run: moveActive and
// setSelection clear it, and a change made any other way leaves the active cell off `at`.
let tabRun: { sheetId: string; startC: number; at: RC } | null = null;

const collaboratorName = "Guest " + clientId.slice(0, 4).toUpperCase();
const collaboratorColor = `hsl(${parseInt(clientId.slice(0, 6), 36) % 360} 62% 48%)`;

// ===========================================================================
// Sheet accessors
// ===========================================================================
function curSheet(): SheetMeta { return model.sheets[activeSheetId]; }
function curCells(): CellMap { return model.cells[activeSheetId] || (model.cells[activeSheetId] = {}); }
function getCell(ref: string): Cell | null { return curCells()[ref] || null; }
// The format a cell is drawn with: typed text with a line break (⌥Enter) wraps, as Excel wraps
// it when one is typed, and the Excel export writes it so.
function shownFmt(cell: Cell | null | undefined): CellFmt | null | undefined {
  const fmt = cell?.fmt;
  return !fmt?.wrap && typeof cell?.value === "string" && cell.value[0] !== "=" && cell.value.includes("\n") ? { ...fmt, wrap: true } : fmt;
}
function cellRaw(ref: string): string { const c = getCell(ref); return c ? c.value : ""; }
function colWidth(c: number): number { return curSheet().colWidths[c] || DEFAULT_COL_W; }
function rowHeight(r: number): number { return curSheet().rowHeights[r] || DEFAULT_ROW_H; }

/* ═══════════════════════════════ 5. Chrome ═══════════════════════════════ */

// ── Tooltips (delayed, then instant while moving along the toolbar) ───────
const tip = el("div", { class: "tip", role: "tooltip" });
/** A tooltip's text and optional shortcut keys. */
interface TipInfo { label: string; keys?: string[] | null }
/** An element with a tooltip: `attachTip` / `setTip` keep its text on the element itself. */
type TipTarget = HTMLElement & { _tip?: TipInfo };
let tipTimer: ReturnType<typeof setTimeout> | undefined = undefined, tipOwner: TipTarget | null = null, tipWarmUntil = 0;
function showTip(target: TipTarget, override: TipInfo | null = null) {
  if (!override && (openPop?.owner === target || !target._tip)) return;
  const { label, keys } = override || target._tip!;
  tip.replaceChildren(el("span", {}, label));
  if (keys?.length) tip.appendChild(keysEl(keys, "tip-keys"));
  tip.classList.remove("show");
  document.body.appendChild(tip);
  const r = target.getBoundingClientRect();
  const w = tip.offsetWidth, h = tip.offsetHeight;
  tip.style.left = clamp(r.left + r.width / 2 - w / 2, 6, innerWidth - w - 6) + "px";
  // Below by default; above when there's no room (the sheet tabs sit at the bottom).
  tip.style.top = (r.bottom + 7 + h > innerHeight - 4 ? r.top - 7 - h : r.bottom + 7) + "px";
  tipOwner = target;
  requestAnimationFrame(() => tip.classList.add("show"));
}
// A one-off message in the tooltip style, pinned to an element until hideTip().
function showTipText(target: TipTarget, label: string) { clearTimeout(tipTimer); showTip(target, { label }); }
function hideTip() {
  clearTimeout(tipTimer);
  if (!tipOwner) return;
  tipOwner = null;
  tip.classList.remove("show");
  tipWarmUntil = Date.now() + 350;
}
// A button's tooltip can change later (e.g. "Pivot table" / "Pivot table settings").
function setTip(target: TipTarget, label: string, keys?: string[] | null) {
  target._tip = { label, keys };
  target.setAttribute("aria-label", label);
  if (tipOwner === target) showTip(target);
}
function attachTip(target: TipTarget, label: string, keys?: string[] | null) {
  setTip(target, label, keys);
  if (coarsePointer) return;
  target.addEventListener("pointerenter", () => {
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => showTip(target), Date.now() < tipWarmUntil ? 0 : 520);
  });
  target.addEventListener("pointerleave", hideTip);
  target.addEventListener("pointerdown", () => { hideTip(); tipWarmUntil = 0; });
}

// ── Toolbar ────────────────────────────────────────────────────────────────
/** The name of an icon in ICONS. */
type IconName = keyof typeof ICONS;
/** A toolbar button's click handler: the click and the button. */
type ToolHandler = (e: MouseEvent, b: HTMLButtonElement) => void;
function tb(iconName: IconName | null, label: string, keys: string[] | null, onClick: ToolHandler, className = ""): HTMLButtonElement {
  // Icon buttons are named for screen readers by their tooltip label.
  const b = el("button", { class: "tb " + className, type: "button", "aria-label": label || null, html: iconName ? svg(ICONS[iconName]) : "" });
  b.addEventListener("mousedown", (e) => e.preventDefault());
  b.addEventListener("click", (e) => { if (!b.classList.contains("disabled")) onClick(e, b); });
  if (label) attachTip(b, label, keys);
  return b;
}
function tbText(text: string, label: string, keys: string[] | null, onClick: ToolHandler, className = ""): HTMLButtonElement {
  const b = tb(null, label, keys, onClick, "txt " + className);
  b.append(text);
  return b;
}
const sep = () => el("span", { class: "sep", "aria-hidden": "true" });
const setDisabled = (b: HTMLElement, off: unknown) => {
  b.classList.toggle("disabled", !!off);
  b.setAttribute("aria-disabled", String(!!off));
};
const arrowL = '<svg viewBox="0 0 12 12" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 6H2.5M5 3 2 6l3 3"/></svg>';
const arrowR = '<svg viewBox="0 0 12 12" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 6h7.5M7 3l3 3-3 3"/></svg>';

/** A number-format menu row (value, label, example, short toolbar label), or a separator. */
type NumberFormatOption = { sep: true; value?: undefined; label?: undefined; ex?: undefined; short?: undefined } | { sep?: undefined; value: string; label: string; ex?: string; short: string };
const NUMBER_FORMATS: NumberFormatOption[] = [
  { value: "auto", label: "Automatic", short: "Automatic" },
  { value: "text", label: "Plain text", short: "Plain text" },
  { sep: true },
  { value: "number", label: "Number", ex: "1,000.12", short: "Number" },
  { value: "integer", label: "Whole number", ex: "1,000", short: "Whole" },
  { value: "percent", label: "Percent", ex: "10.12%", short: "Percent" },
  { value: "scientific", label: "Scientific", ex: "1.01E+03", short: "Scientific" },
  { value: "currency", label: "Currency", ex: "$1,000.12", short: "Currency" },
  { sep: true },
  { value: "date", label: "Date", ex: "09/26/2008", short: "Date" },
  { value: "time", label: "Time", ex: "3:59:00 PM", short: "Time" },
  { value: "datetime", label: "Date time", ex: "09/26/2008 3:59:00 PM", short: "Date time" },
];
const ALIGNS: { key: Align; label: string; icon: IconName }[] = [
  { key: "l", label: "Align left", icon: "alignLeft" },
  { key: "c", label: "Center", icon: "alignCenter" },
  { key: "r", label: "Align right", icon: "alignRight" },
];

const undoBtn = tb("undo", "Undo", combo("mod", "Z"), () => undo());
const redoBtn = tb("redo", "Redo", isMac ? combo("mod", "shift", "Z") : combo("mod", "Y"), () => redo());
const sumBtn = tb("sigma", "Sum", null, () => autoSum());
const fxBtn = tbText("ƒx", "Insert function", null, (e, b) => toggleMenu(b, openFunctionMenu), "fx");
const absoluteRefBtn = tbText("$", "Lock reference ($A$1 → A$1 → $A1 → A1)", combo("mod", "shift", "L"), () => cycleAbsoluteReference());
setDisabled(absoluteRefBtn, true);

const fmtLabel = el("span", { class: "label" }, "Automatic");
const fmtBtn = tb(null, "Number format", null, (e, b) => toggleMenu(b, numberFormatMenu), "fmt");
fmtBtn.append(fmtLabel, el("span", { class: "chev", html: svg(ICONS.chevron, 13) }));
let shownNf: string = "auto";
// refreshToolbarState() reports the active cell's number format here.
function showNumberFormat(v: string) { if (v === shownNf) return; shownNf = v; fmtLabel.textContent = NUMBER_FORMATS.find((o) => o.value === v)?.short || "Automatic"; }
// Toggles, like bold: pressed again (when the whole selection already has it) the cells go back
// to Automatic, dropping any decimal places chosen with it.
function toggleNumberFormat(nf: string) {
  const on = !selectionNumberFormatAllIs(nf);
  setFmtOnSelection((f) => { if (on) f.nf = nf; else if (f.nf === nf) { delete f.nf; delete f.d; } });
}
function selectionNumberFormatAllIs(nf: string) { return selectionAllFmt((fmt) => fmt?.nf === nf); }
const currencyBtn = tb("currency", "Currency", null, () => toggleNumberFormat("currency"));
const percentBtn = tb("percent", "Percent", null, () => toggleNumberFormat("percent"));
const decDecBtn = tb(null, "Fewer decimals", null, () => changeDecimals(-1), "txt");
decDecBtn.innerHTML = arrowL + "<span>.0</span>";
const incDecBtn = tb(null, "More decimals", null, () => changeDecimals(1), "txt");
incDecBtn.innerHTML = "<span>.00</span>" + arrowR;

const boldBtn = tb("bold", "Bold", combo("mod", "B"), () => toggleFmt("b"));
const italicBtn = tb("italic", "Italic", combo("mod", "I"), () => toggleFmt("i"));
const underlineBtn = tb("underline", "Underline", combo("mod", "U"), () => toggleFmt("u"));
const strikeBtn = tb("strike", "Strikethrough", combo("mod", "shift", "X"), () => toggleFmt("s"));
const colorBtn = tb("color", "Text & fill color", null, (e, b) => toggleMenu(b, colorMenu), "color");
const colorHl = el("span", { class: "hl-swatch" });
const colorBar = el("span", { class: "bar-swatch" });
colorBtn.prepend(colorHl);
colorBtn.append(colorBar);

const alignBtn = tb("alignLeft", "Alignment", null, (e, b) => toggleMenu(b, alignMenu), "align");
const wrapBtn = tb("wrap", "Wrap text", null, () => toggleFmt("wrap"));

const filterBtn = tb("filter", "Filter", null, () => toggleFilterRow());
const chartBtn = tb("chart", "Chart", null, (e, b) => toggleMenu(b, openCreateChartMenu));
// On a pivot sheet the button opens that pivot's settings; elsewhere it makes one from the selection.
const pivotBtn = tb("pivot", "Pivot table", null, (e, b) => curSheet()?.pivot ? toggleMenu(b, () => openPivotMenu(activeSheetId)) : createPivotTable());
const moreBtn = tb("more", "More", null, (e, b) => toggleMenu(b, moreMenu));

const tools = el("div", { class: "tools", role: "toolbar", "aria-label": "Formatting" }, [
  undoBtn, redoBtn, sep(),
  sumBtn, fxBtn, absoluteRefBtn, sep(),
  fmtBtn, currencyBtn, percentBtn, decDecBtn, incDecBtn, sep(),
  boldBtn, italicBtn, underlineBtn, strikeBtn, colorBtn, sep(),
  alignBtn, wrapBtn, sep(),
  filterBtn, chartBtn, pivotBtn, moreBtn,
]);
const statusLabel = el("span", { class: "s-label" });
const statusEl = el("span", { class: "status", role: "status", "aria-live": "polite" }, [el("span", { class: "s-dot" }), statusLabel]);
const barRight = el("div", { class: "bar-right" }, [statusEl]);
const bar = el("header", { class: "bar" }, [tools, barRight]);

// Narrow screens: the toolbar scrolls sideways and fades only the edge that has more.
function updateToolFades() {
  const max = tools.scrollWidth - tools.clientWidth;
  tools.classList.toggle("fade-l", tools.scrollLeft > 2);
  tools.classList.toggle("fade-r", max > 2 && tools.scrollLeft < max - 2);
}
tools.addEventListener("scroll", updateToolFades, { passive: true });
window.addEventListener("resize", updateToolFades);

// ── Formula bar ────────────────────────────────────────────────────────────
const nameBox = el("input", { class: "namebox", value: "A1", spellcheck: "false", "aria-label": "Cell reference" });
const formulaInput = el("input", { class: "finput", spellcheck: "false", placeholder: "", "aria-label": "Cell contents" });
// While picking cells on another sheet: which cell the formula belongs to (click to go back).
const originSheet = el("span", { class: "origin-sheet" });
const originRef = el("span", { class: "origin-ref" });
const editingOrigin = el("button", { class: "fbar-origin", type: "button", hidden: true }, [
  el("span", { class: "origin-icon", html: svg(ICONS.pencil, 13) }), originSheet, originRef,
]);
attachTip(editingOrigin, "Back to the cell");
// Keeps the formula bar focused (and its caret where it was) through the click.
editingOrigin.addEventListener("mousedown", (e) => e.preventDefault());
editingOrigin.addEventListener("click", () => returnToEditingCell());
const fbar = el("div", { class: "fbar" }, [
  nameBox, el("span", { class: "fx-sep", "aria-hidden": "true" }), el("span", { class: "fx-label", "aria-hidden": "true" }, "ƒx"), editingOrigin, formulaInput,
]);

// ── Grid ───────────────────────────────────────────────────────────────────
const gridTable = el("table", { class: "grid", role: "grid", "aria-label": "Cells" });
const chartLayer = el("div", { class: "chart-layer" });
const fillHandle = el("div", { class: "fill-handle", title: "Drag to fill" });
const formulaRangeHandle = el("div", { class: "formula-range-handle", title: "Drag to resize formula range" });
// rows=1: a textarea is two lines tall by default, taller than its cell; this one grows only
// for real line breaks.
const cellEditor = el("textarea", { class: "cell-editor", spellcheck: "false", wrap: "off", rows: "1" });
// The selection is drawn on top of the cells: a tint on the range (a class on
// each cell) plus an outline and an active-cell ring that glide between cells.
const selRangeEl = el("div", { class: "sel-range", "aria-hidden": "true" });
const selRing = el("div", { class: "sel-ring", "aria-hidden": "true" });
const skeletonNote = el("div", { class: "sk-note" });
const skeleton = el("div", { class: "skeleton", "aria-hidden": "true" }, [...[0.92, 0.78, 0.86, 0.64, 0.82, 0.7, 0.88, 0.5].map((w, i) =>
  el("div", { class: "sk-row" }, [
    el("div", { class: "sk", style: { width: `${Math.round(w * 22)}%` } }),
    el("div", { class: "sk", style: { width: `${Math.round(w * 16 + (i % 3) * 4)}%` } }),
    el("div", { class: "sk", style: { width: `${Math.round(w * 26)}%` } }),
  ])), skeletonNote]);
const gridScroll = el("div", { class: "grid-scroll", tabindex: "0", "aria-label": "Spreadsheet grid" }, [gridTable, selRangeEl, selRing, fillHandle, formulaRangeHandle, chartLayer, cellEditor, skeleton]);

// Chart and pivot settings open as pop-ups next to what they edit; there is no sidebar.
const workarea = el("div", { class: "workarea" }, [gridScroll]);

// ── Sheet tabs ─────────────────────────────────────────────────────────────
const tabbar = el("div", { class: "tabbar", role: "tablist", "aria-label": "Sheets" });

const app = el("div", { class: "app" }, [bar, fbar, workarea, tabbar]);
const printWorkbook = el("div", { id: "printWorkbook", "data-print-root": "workbook" });
const formulaAssist = el("div", { class: "formula-assist", role: "listbox", "aria-label": "Formula suggestions" });
const toastLabel = el("span");
const toastEl = el("div", { class: "toast", role: "status", "aria-live": "polite" }, [el("span", { class: "t-dot" }), toastLabel]);
document.body.append(app, printWorkbook, formulaAssist, toastEl);

// The bar's hairline and the headers' lift appear only once the grid scrolls.
gridScroll.addEventListener("scroll", () => {
  const y = gridScroll.scrollTop > 2, x = gridScroll.scrollLeft > 2;
  bar.classList.toggle("scrolled", y);
  gridScroll.classList.toggle("sy", y);
  gridScroll.classList.toggle("sx", x);
}, { passive: true });

// ── Toast: a quiet word after an action with no visible result of its own ──
let toastTimer: ReturnType<typeof setTimeout> | undefined = undefined;
function toast(text: string, kind = "ok") {
  clearTimeout(toastTimer);
  toastLabel.textContent = text;
  toastEl.classList.toggle("bad", kind === "bad");
  toastEl.classList.add("show");
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), kind === "bad" ? 2200 : 1500);
}
// setStatus(kind, text): save progress goes to the (normally invisible) sync status; anything
// else is a one-off message.
function setStatus(kind: string, text: string) {
  if (kind === "saving") setSync("saving");
  else if (kind === "saved" && text === "Saved") setSync("saved");
  else if (kind === "bad" && /^(Offline|Save failed)/.test(text)) setSync("offline");
  else toast(text, kind === "bad" ? "bad" : "ok");
}

// ── Sync status ─────────────────────────────────────────────────────────────
/** What the sync status says: saving, saved, offline (failing) or reconnecting. */
type SyncKind = "saving" | "saved" | "offline" | "reconnecting";
let syncTimer: ReturnType<typeof setTimeout> | undefined = undefined, syncShown: string | null = null, forceSavedFlash = false;
function showSync(kind: string, text: string) {
  clearTimeout(syncTimer);
  syncShown = kind;
  statusEl.className = "status show " + kind;
  statusLabel.textContent = text;
}
function hideSync() {
  clearTimeout(syncTimer);
  syncShown = null;
  statusEl.classList.remove("show");
}
function setSync(kind: SyncKind) {
  if (kind === "saving") {
    if (syncShown === "offline" || syncShown === "saving") return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => showSync("saving", "Saving…"), 900);
  } else if (kind === "saved") {
    clearTimeout(syncTimer);
    if (syncShown || forceSavedFlash) {
      forceSavedFlash = false;
      showSync("saved", "Saved");
      syncTimer = setTimeout(hideSync, 1300);
    }
  } else if (kind === "offline") {
    // Online but failing means the save itself is the problem, not the connection.
    showSync("offline", navigator.onLine === false ? "Offline · retrying" : "Not saved · retrying");
  } else if (kind === "reconnecting") {
    showSync("offline", "Reconnecting…");
  }
}
function hasPendingSave() { return !!(saveTimer || saveInFlight || pendingCellOps.size || pendingStructure || pendingReplacements.size); }
function saveNow() {
  // The open cell is saved too; an invalid formula keeps its editor open with the error.
  if (editing) { commitEdit("none"); if (editing) return; }
  forceSavedFlash = true;
  if (hasPendingSave()) { showSync("saving", "Saving…"); if (!saveInFlight) doSave(); }
  else setSync("saved");
}

/* ══════════════════ 6. Menus, palette, shortcuts sheet ═══════════════════ */
// (Defined here, next to the bar they serve; menus for the grid, tabs, filters
// and functions are built further down with the same pieces.)

/** How a popover is placed against the rectangle it opens from. */
type PopAlign = "start" | "end" | "center";
/** Options for showPop: extra classes, the element it belongs to, its role, and what to do on close. */
interface PopOptions { className?: string; owner?: HTMLElement | null; kind?: string; onClose?: (() => void) | null; align?: PopAlign }
/** The popover on screen, if any. */
interface OpenPop { pop: HTMLDivElement; owner: HTMLElement | null; kind: string; onClose: (() => void) | null; align: PopAlign; chartId?: string }
let openPop: OpenPop | null = null;
function showPop(content: ElChild | ElChild[], rect: DOMRect, { className = "", owner = null, kind = "menu", onClose = null, align = "start" }: PopOptions = {}): HTMLDivElement {
  closePop(true);
  hideTip();
  const pop = el("div", { class: "pop " + className, role: kind === "menu" ? "menu" : "dialog" }, content);
  pop.addEventListener("mousedown", (e) => { if (!(e.target as Element).closest("input, textarea, select, label, a")) e.preventDefault(); });
  document.body.appendChild(pop);
  openPop = { pop, owner, kind, onClose, align };
  owner?.classList.add("open");
  placePop(pop, rect, align);
  return pop;
}
function placePop(pop: HTMLElement, r: DOMRect, align: PopAlign = "start") {
  const m = 8, gap = 6;
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  let left = align === "end" ? r.right - pw : align === "center" ? r.left + r.width / 2 - pw / 2 : r.left;
  left = clamp(left, m, innerWidth - pw - m);
  let top = r.bottom + gap, originY = "top";
  if (top + ph > innerHeight - m && r.top - gap - ph > m) { top = r.top - gap - ph; originY = "bottom"; }
  pop.style.left = Math.round(left) + "px";
  pop.style.top = Math.round(clamp(top, m, Math.max(m, innerHeight - ph - m))) + "px";
  pop.style.setProperty("--origin", `${Math.round(clamp(r.left + r.width / 2 - left, 0, pw))}px ${originY}`);
}
function closePop(immediate = false) {
  if (!openPop) return;
  const { pop, owner, onClose } = openPop;
  openPop = null;
  owner?.classList.remove("open");
  onClose?.();
  if (immediate || reducedMotion.matches) pop.remove();
  else { pop.classList.add("closing"); setTimeout(() => pop.remove(), 110); }
}
function toggleMenu(owner: HTMLElement, build: (owner: HTMLElement) => void) {
  if (openPop?.owner === owner) return closePop();
  build(owner);
}
document.addEventListener("mousedown", (e) => {
  if (!openPop) return;
  if (openPop.pop.contains(e.target as Node) || openPop.owner?.contains(e.target as Node)) return;
  closePop();
}, true);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && openPop) {
    e.preventDefault();
    e.stopPropagation();
    // A menu opened from the find bar gives focus back to the bar, not the grid.
    const fromFind = !!openPop.owner?.closest?.(".findbar");
    closePop();
    if (fromFind) findInput.focus({ preventScroll: true });
    else if (!editing) armEditorCapture(true);
  }
}, true);
// A menu works from the keyboard: the arrows, from the button that opened it or inside it, move
// through its rows, and Enter or Space picks one. In a dialog with rows (a filter's sort rows),
// they work once a row has focus.
document.addEventListener("keydown", (e) => {
  if (!openPop) return;
  const { pop, owner } = openPop;
  const inPop = pop.contains(document.activeElement);
  const rows = Array.from(pop.querySelectorAll<HTMLElement>(".mi"));
  const i = rows.indexOf(document.activeElement as HTMLElement);
  if (openPop.kind === "menu" ? !inPop && document.activeElement !== owner : i < 0) return;
  if (!rows.length) return;
  const move = (to: number) => rows[(to + rows.length) % rows.length].focus();
  if (e.key === "ArrowDown") move(i + 1);
  else if (e.key === "ArrowUp") move(i < 0 ? -1 : i - 1);
  else if (e.key === "Home" && inPop) move(0);
  else if (e.key === "End" && inPop) move(-1);
  else if ((e.key === "Enter" || e.key === " ") && i >= 0) rows[i].click();
  else if (e.key === "Tab" && inPop && openPop.kind === "menu") { closePop(); owner?.focus(); }
  else return;
  e.preventDefault();
});
window.addEventListener("resize", () => closePop(true));

// Row anatomy: [icon] [label ……… shortcut | example] [check slot]. Menus that
// can show a check reserve the slot on every row, so the right column stays put.
/** A menu row: icon, label, shortcut keys or an example (`md`), and an optional check. */
interface MenuItemSpec {
  icon?: IconName | null;
  label: string;
  keys?: string[] | null;
  md?: string;
  checked?: boolean;
  checkSlot?: boolean;
  disabled?: boolean;
  role?: string;
  onSelect: () => void;
}
function menuItem({ icon: iconName, label, keys, md, checked, checkSlot = false, disabled = false, role = "menuitem", onSelect }: MenuItemSpec): HTMLDivElement {
  const showKeys = keys?.length && !coarsePointer;
  const text = el("span", { class: "mi-text" }, [
    el("span", { class: "mi-label" }, label),
    showKeys ? keysEl(keys, "mi-keys") : md ? el("span", { class: "mi-md" }, md) : null,
    checkSlot ? el("span", { class: "mi-check" + (checked ? " on" : ""), html: svg(ICONS.check, 15) }) : null,
  ]);
  const item = el("div", { class: "mi" + (disabled ? " disabled" : ""), tabindex: "-1", role: checkSlot ? "menuitemradio" : role, "aria-checked": checkSlot ? String(!!checked) : null, "aria-disabled": disabled ? "true" : null }, [
    iconName ? el("span", { class: "mi-icon", html: svg(ICONS[iconName], 17) }) : null,
    text,
  ]);
  item.addEventListener("click", () => { if (disabled) return; closePop(); onSelect(); });
  return item;
}
function numberFormatMenu(owner: HTMLElement) {
  const now = shownNf;
  showPop(NUMBER_FORMATS.map((o) => o.sep ? el("div", { class: "msep" }) : menuItem({
    label: o.label, md: o.ex, checked: o.value === now, checkSlot: true,
    // Automatic is a full reset: decimal places chosen earlier would otherwise still apply.
    onSelect: () => setFmtOnSelection((f) => { if (o.value === "auto") { delete f.nf; delete f.d; } else f.nf = o.value; }),
  })), owner.getBoundingClientRect(), { owner, className: "fmt-menu" });
}
function alignMenu(owner: HTMLElement) {
  const now = shownAlign;
  showPop(ALIGNS.map((a) => menuItem({
    icon: a.icon, label: a.label, checked: a.key === now, checkSlot: true,
    // Left is stored too: numbers default to the right, so "no alignment" isn't left for them.
    onSelect: () => setFmtOnSelection((f) => { f.a = a.key; }),
  })), owner.getBoundingClientRect(), { owner });
}
function moreMenu(owner: HTMLElement) {
  const r = selRange(), rows = r.r2 - r.r1 + 1, cols = r.c2 - r.c1 + 1;
  const plural = (n: number, word: string) => n > 1 ? `${n} ${word}s` : word;
  const danger = (node: HTMLElement) => { node.classList.add("danger"); return node; };
  showPop([
    menuItem({ icon: "rowAbove", label: `Insert ${plural(rows, "row")} above`, onSelect: () => insertRows(selRange().r1, rows) }),
    menuItem({ icon: "rowBelow", label: `Insert ${plural(rows, "row")} below`, onSelect: () => insertRows(selRange().r2 + 1, rows) }),
    menuItem({ icon: "colLeft", label: `Insert ${plural(cols, "column")} left`, onSelect: () => insertCols(selRange().c1, cols) }),
    menuItem({ icon: "colRight", label: `Insert ${plural(cols, "column")} right`, onSelect: () => insertCols(selRange().c2 + 1, cols) }),
    el("div", { class: "msep" }),
    danger(menuItem({ icon: "rowDelete", label: `Delete ${plural(rows, "row")}`, onSelect: () => deleteRows() })),
    danger(menuItem({ icon: "colDelete", label: `Delete ${plural(cols, "column")}`, onSelect: () => deleteCols() })),
    el("div", { class: "msep" }),
    menuItem({ icon: "sortAsc", label: "Sort range A → Z", onSelect: () => sortSelection(true) }),
    menuItem({ icon: "sortDesc", label: "Sort range Z → A", onSelect: () => sortSelection(false) }),
    menuItem({ icon: "clear", label: "Clear formatting", keys: combo("mod", "\\"), onSelect: () => clearFormatting() }),
    el("div", { class: "msep" }),
    menuItem({ icon: "keyboard", label: "Keyboard shortcuts", keys: combo("mod", "/"), onSelect: openShortcuts }),
  ], owner.getBoundingClientRect(), { owner, align: "end" });
}

// Colors are stored as hex on each cell (fmt.c / fmt.bg), so they survive CSV
// round trips and look the same to everyone.
/** A palette colour: its hex (null for automatic / no fill) and name. */
interface ColorChoice { hex: string | null; label: string }
const TEXT_COLORS: ColorChoice[] = [
  { hex: null, label: "Automatic" }, { hex: "#6b6b73", label: "Gray" }, { hex: "#d0473f", label: "Red" },
  { hex: "#d9731f", label: "Orange" }, { hex: "#b48a00", label: "Ochre" }, { hex: "#2f9e66", label: "Green" },
  { hex: "#13898a", label: "Teal" }, { hex: "#2f6fd1", label: "Blue" }, { hex: "#7c4dcc", label: "Purple" },
  { hex: "#c94a8c", label: "Pink" },
];
const FILL_COLORS: ColorChoice[] = [
  { hex: null, label: "No fill" }, { hex: "#ececee", label: "Gray" }, { hex: "#fbdedb", label: "Red" },
  { hex: "#fde6d2", label: "Orange" }, { hex: "#fbf0c2", label: "Yellow" }, { hex: "#d9f0e2", label: "Green" },
  { hex: "#d4eeed", label: "Teal" }, { hex: "#dbe6fa", label: "Blue" }, { hex: "#e8defa", label: "Purple" },
  { hex: "#f9ddeb", label: "Pink" },
];
function colorMenu(owner: HTMLElement) {
  const f: CellFmt = getCell(rcToRef(focus.r, focus.c))?.fmt || {};
  const same = (a: string | null | undefined, b: string | null | undefined) => a && b ? a.toLowerCase() === b.toLowerCase() : !a && !b;
  const apply = (key: "c" | "bg", hex: string | null) => setFmtOnSelection((fmt) => { if (hex) fmt[key] = hex; else delete fmt[key]; });
  const swatches = (key: "c" | "bg", list: ColorChoice[]) => el("div", { class: "swatches" }, list.map((c) => {
    const s = el("button", { type: "button", class: "sw" + (same(f[key], c.hex) ? " on" : "") + (key === "bg" && !c.hex ? " none" : ""), title: c.label, "aria-label": (key === "bg" ? "Fill " : "Text ") + c.label });
    if (key === "c") { s.textContent = "A"; s.style.color = c.hex || "var(--text)"; }
    else if (c.hex) s.style.background = c.hex;
    s.addEventListener("click", () => { closePop(); apply(key, c.hex); });
    return s;
  }));
  const custom = (key: "c" | "bg", label: string) => {
    const input = el("input", { type: "color", value: /^#[0-9a-f]{6}$/i.test(f[key] || "") ? f[key] : key === "c" ? "#1b1b1f" : "#fbf0c2", "aria-label": `Custom ${label.toLowerCase()} color` });
    input.addEventListener("change", () => { closePop(); apply(key, input.value); });
    return el("label", { class: "custom-pick" }, [el("i"), el("span", {}, label), input]);
  };
  showPop([
    el("div", { class: "mhead" }, "Text"), swatches("c", TEXT_COLORS),
    el("div", { class: "mhead", style: { marginTop: "6px" } }, "Fill"), swatches("bg", FILL_COLORS),
    el("div", { class: "custom-row" }, [el("span", { class: "grow" }, "Custom"), custom("c", "Text"), custom("bg", "Fill")]),
  ], owner.getBoundingClientRect(), { owner, kind: "dialog", className: "palette" });
}

function openShortcuts() {
  closePop(true);
  if (document.querySelector(".sheet-overlay.shortcuts")) return;
  const row = (label: string, ...combos: string[][]) => el("div", { class: "krow" }, [
    el("span", {}, label), el("span", { class: "chips" }, combos.map((c) => keysEl(c, "chip"))),
  ]);
  const md = (label: string, ...tokens: string[]) => el("div", { class: "krow" }, [
    el("span", {}, label), el("span", { class: "chips" }, tokens.map((t) => el("span", { class: "chip md" }, t))),
  ]);
  const overlay = el("div", { class: "sheet-overlay shortcuts" }, [
    el("div", { class: "sheet", role: "dialog", "aria-label": "Keyboard shortcuts" }, [
      el("h2", {}, "Keyboard shortcuts"),
      el("p", { class: "sub" }, "Start typing in any cell to replace it. Begin with = for a formula, then click cells to reference them."),
      el("div", { class: "sheet-cols" }, [
        el("div", {}, [
          el("h3", {}, "Moving around"),
          row("Move · extend selection", combo("↑"), combo("shift", "↑")),
          row("Jump to edge of data", combo("mod", "↑"), combo("mod", "→")),
          row("Next · previous cell", combo("Tab"), combo("shift", "Tab")),
          row("Row start · end", combo("Home"), combo("End")),
          row("Page down · up", combo("PgDn"), combo("PgUp")),
          row("Select all", combo("mod", "A")),
          el("h3", {}, "Editing"),
          row("Edit cell", combo("↵"), combo("F2")),
          row("Confirm · move down", combo("↵")), row("Line break in a cell", combo("alt", "↵")),
          row("Cancel", combo("Esc")), row("Clear contents", combo(isMac ? "⌫" : "Del")),
          row("Cut · copy · paste", combo("mod", "X"), combo("mod", "C"), combo("mod", "V")),
          row("Paste values only", combo("mod", "shift", "V")),
          row("Undo · redo", combo("mod", "Z"), isMac ? combo("mod", "shift", "Z") : combo("mod", "Y")),
          md("Move rows · columns", "Drag selected headers"),
          md("Fit column to data", "Double-click its edge"),
        ]),
        el("div", {}, [
          el("h3", {}, "Formatting"),
          row("Bold · italic · underline", combo("mod", "B"), combo("mod", "I"), combo("mod", "U")),
          row("Strikethrough", combo("mod", "shift", "X")),
          row("Clear formatting", combo("mod", "\\")),
          el("h3", {}, "Formulas"),
          md("Start a formula", "="), md("Sum", "=SUM(A1:A9)"),
          row("Auto-sum", combo("alt", "=")),
          row("Accept suggestion", combo("Tab")),
          row("Lock reference ($)", combo("mod", "shift", "L")),
          md("Cells on another sheet", "Click its tab"),
          el("h3", {}, "General"),
          row("Find", combo("mod", "F")),
          row("Next · previous match", combo("↵"), combo("shift", "↵")),
          row("Save now", combo("mod", "S")),
          row("Open link in cell", combo("mod", "Click")),
          row("This sheet", combo("mod", "/")),
        ]),
      ]),
    ]),
  ]);
  const close = () => { overlay.remove(); document.removeEventListener("keydown", onKey, true); armEditorCapture(true); };
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" || (isMac ? e.metaKey : e.ctrlKey) && e.key === "/") { e.preventDefault(); e.stopPropagation(); close(); } };
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  document.addEventListener("keydown", onKey, true);
  document.body.appendChild(overlay);
}

// App-wide shortcuts. Grid-only ones (arrows, B/I/U, undo…) live in handleGridKeydown.
document.addEventListener("keydown", (e) => {
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (document.querySelector(".sheet-overlay")) return;
  if (mod && !e.altKey && e.code === "KeyS") { e.preventDefault(); saveNow(); return; }
  if (mod && !e.altKey && e.key === "/") { e.preventDefault(); openShortcuts(); return; }
  // Our own find: the browser's can't see rows that aren't drawn.
  if (mod && !e.altKey && !e.shiftKey && e.code === "KeyF") { e.preventDefault(); e.stopPropagation(); openFind(); return; }
  if (mod && !e.altKey && e.code === "KeyG" && findState?.open) { e.preventDefault(); e.stopPropagation(); stepFind(e.shiftKey ? -1 : 1); return; }
  const onGrid = !editing && (document.activeElement === gridScroll || document.activeElement === cellEditor || document.activeElement === document.body);
  if (!onGrid || e.isComposing) return;
  if (mod && !e.altKey && !e.shiftKey && e.key === "\\") { e.preventDefault(); e.stopPropagation(); clearFormatting(); }
  else if (mod && e.shiftKey && !e.altKey && e.code === "KeyX") { e.preventDefault(); e.stopPropagation(); toggleFmt("s"); }
  else if (e.altKey && !mod && !e.shiftKey && (e.key === "=" || e.code === "Equal")) { e.preventDefault(); e.stopPropagation(); autoSum(); }
}, true);
// Menus that belong to a place in the grid would drift away from it, so they close on scroll.
gridScroll.addEventListener("scroll", () => { if (openPop && !openPop.pop.contains(document.activeElement)) closePop(true); }, { passive: true });
tabbar.addEventListener("scroll", () => closePop(true), { passive: true });

/* ═════════════════════════ 7. Save, undo & edits ═════════════════════════ */

// ===========================================================================
// Save / operations queue (optimistic, per-cell versions, conflict rebase)
// ===========================================================================

let applyingRemote = false;
let saveInFlight = false;
let saveTimer: ReturnType<typeof setTimeout> | undefined = undefined;
let saveFailures = 0;
// Connection state (see section 10). Saves wait until the first snapshot lands.
let ready = false, buffered: SubscriberEvent[] = [];
// Events held while `ready` is false are replayed if newer than this: the revision the hold began
// at, or that of a snapshot applied during it. Not model.revision, which a save reply can raise
// past remote events still waiting in `buffered`.
let replayFloor = 0;
function holdEvents() {
  if (ready) replayFloor = model.revision;
  ready = false;
}
/**
 * A local cell edit waiting to be saved; `baseVersion` unset means "the cell's version when sent".
 * `layout`: a reference rewrite on another sheet that belongs to a pending row or column change,
 * and is discarded with it if that change is refused.
 */
interface PendingCellOp { sheetId: string; ref: string; value: string | null; fmt: CellFmt | null; baseVersion?: number; layout?: true }
/** A whole-workbook structure snapshot, with the revision it was built on. */
type StructureSnapshot = Structure & { revision: number };
const pendingCellOps = new Map<string, PendingCellOp>();
let pendingStructure: StructureSnapshot | null = null;      // latest complete structure snapshot to send
const pendingReplacements = new Map<string, CellMap>(); // sheetId -> cells (full)
// The revision the model held when the first pending structure snapshot or sheet replacement
// was built. A replacement (a sort, an inserted row) is only valid on that layout, so it's sent
// with this revision and the server refuses it if the sheet has moved on. null while neither
// is pending.
let wholesaleBaseRevision: number | null = null;
// Set when a save failed, so the next attempt first asks the server where the sheet stands: a
// failure says nothing about whether the commit landed.
let resyncBeforeSave = false;
// Set when that check (or a refused save) reloaded the sheet, so the user is told once.
let reloadedAfterFailure = false;
// Structure is saved as a whole-workbook snapshot. `ackedStructure` (what the server last held)
// lets a remote update be merged with local changes still pending, field by field.
let ackedStructure: Structure | null = null;
let ackedStructureRevision = -1;
let inFlightStructure: StructureSnapshot | null = null; // structure sent in the save awaiting its response

function queueCellOp(sheetId: string, ref: string, value: string | null, fmt: CellFmt | null, baseVersion?: number, layout = false) {
  pendingCellOps.set(sheetId + "!" + ref, { sheetId, ref, value, fmt, baseVersion, ...(layout ? { layout: true as const } : {}) });
  noteEditedCell(sheetId, ref);
  scheduleSave();
}
// `revision` is the one the snapshot was built on: the server keeps a sheet created after it
// (by the agent or a peer) that the snapshot couldn't have known, instead of deleting it.
function structureSnapshot(): StructureSnapshot {
  return { title: model.title, sheetOrder: model.sheetOrder.slice(), sheets: JSON.parse(JSON.stringify(model.sheets)), revision: model.revision };
}
function queueStructure() {
  if (wholesaleBaseRevision === null) wholesaleBaseRevision = model.revision;
  pendingStructure = structureSnapshot();
  scheduleSave();
}
// The replacement is the sheet's whole cell map, local edits included, so a cell op still queued
// for that sheet is redundant -- and, since the caller has just moved the cells (an inserted row,
// a sort), keyed by a position that no longer names the cell it edited.
function queueReplacement(sheetId: string) {
  dropCellOpsFor(sheetId);
  if (wholesaleBaseRevision === null) wholesaleBaseRevision = model.revision;
  pendingReplacements.set(sheetId, copyCellMap(model.cells[sheetId] || {}));
  scheduleSave();
}
// A detached copy of a sheet's cells (faster than a JSON round trip on a big sheet).
function copyCellMap(cells: CellMap): CellMap {
  const out: CellMap = {};
  for (const ref in cells) { const cell = cells[ref]; out[ref] = { value: cell.value, fmt: cell.fmt ? { ...cell.fmt } : null, version: cell.version }; }
  return out;
}
function dropCellOpsFor(sheetId: string) {
  for (const [key, op] of pendingCellOps) if (op.sheetId === sheetId) pendingCellOps.delete(key);
}
// Forgets refused sheet replacements, with every edit that depends on their layout: edits on
// those sheets, and the reference rewrites they made on others. Other edits stay queued.
function dropPendingLayouts() {
  for (const sheetId of pendingReplacements.keys()) dropCellOpsFor(sheetId);
  for (const [key, op] of pendingCellOps) if (op.layout) pendingCellOps.delete(key);
  pendingReplacements.clear();
}
// Cells read from the server for a sheet, with this tab's unsaved edits laid back on top.
function layPendingCellOps(sheetId: string, cells: CellMap) {
  for (const op of pendingCellOps.values()) {
    if (op.sheetId !== sheetId) continue;
    if (op.value == null && op.fmt == null) delete cells[op.ref];
    else cells[op.ref] = { value: op.value ?? "", fmt: op.fmt ?? null, version: cells[op.ref]?.version || 0 };
  }
}
// After a reload throws away a layout this client had built, its undo history no longer
// describes the sheet, and the user hears about it once.
function noteReloadedAfterFailure() {
  undoStack.length = 0; redoStack.length = 0; updateUndoButtons();
  reloadedAfterFailure = true;
}

function scheduleSave(delay = 180) {
  if (applyingRemote || isExport || !ready) return;
  setSync("saving");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(doSave, delay);
}

async function doSave() {
  clearTimeout(saveTimer);
  saveTimer = undefined;
  if (saveInFlight) return;
  if (!pendingCellOps.size && !pendingStructure && !pendingReplacements.size) { setSync("saved"); return; }
  saveInFlight = true;
  try {
    await sendPendingOperation();
    saveFailures = 0;
  } catch (e) {
    console.error(e);
    saveFailures++;
    // Nothing typed is lost: everything stays queued and is retried with backoff, after first
    // checking whether the failed save landed (resyncBeforeSave).
    setSync("offline");
    // A save that keeps failing while online is said out loud once, not left to the badge.
    if (saveFailures === 4 && navigator.onLine !== false) toast("Recent changes aren't saved yet. Still trying — keep this tab open.", "bad");
  } finally {
    saveInFlight = false;
    if (pendingCellOps.size || pendingStructure || pendingReplacements.size) {
      setSync(saveFailures ? "offline" : "saving");
      scheduleSave(saveFailures ? Math.min(1e4, 40 * 2 ** (saveFailures - 1)) : 40);
    } else if (!saveFailures) {
      setSync("saved");
      if (reloadedAfterFailure) { reloadedAfterFailure = false; toast("Reloaded the latest version after a save couldn't be applied", "bad"); }
    }
  }
}

// ── Big workbooks travel in pieces ─────────────────────────────────────────
// One message has a size limit, so a large sheet is never sent or received whole: the server
// pages cells out (openDocument, getCellsPage), a big replacement (a sort, an inserted row) is
// uploaded in parts (stageCells), and cell edits go out in rounds of about OP_BYTES.
const OP_BYTES = 4_000_000;
const SAVE_TIMEOUT_MS = 45_000;
const UPLOAD_PART_BYTES = 1_500_000;
let uploadRetries = 0, uploadCounter = 0;
function approxCellBytes(ref: string, cell: { value?: string | null; fmt?: CellFmt | null } | undefined): number { return ref.length + String(cell?.value ?? "").length + (cell?.fmt ? 80 : 0) + 40; }
// Size of a cell map, counted up to `stopAt`.
function cellMapBytes(cells: CellMap, stopAt = Infinity): number {
  let bytes = 0;
  for (const ref in cells) { bytes += approxCellBytes(ref, cells[ref]); if (bytes > stopAt) break; }
  return bytes;
}
async function stageReplacement(sheetId: string, cells: CellMap): Promise<SheetReplacement> {
  const uploadId = `${clientId}-${Date.now().toString(36)}-${++uploadCounter}`;
  let part = 0, chunk: CellMap = {}, bytes = 0, count = 0;
  for (const ref in cells) {
    chunk[ref] = cells[ref]; count++;
    bytes += approxCellBytes(ref, cells[ref]);
    if (bytes >= UPLOAD_PART_BYTES) { await gadget.stageCells({ uploadId, sheetId, part: part++, cells: chunk }); chunk = {}; bytes = 0; }
  }
  if (bytes || part === 0) await gadget.stageCells({ uploadId, sheetId, part: part++, cells: chunk });
  return { sheetId, uploadId, count };
}
// Pages arrive packed (parallel arrays; each format once per page, see the server's
// readPackedPage). Every cell gets its own copy of its format, as edits may change it in place.
function unpackCells(packed: FullPackedCells, into: CellMap): CellMap {
  const { refs, values, versions, styles, fmts } = packed;
  for (let i = 0; i < refs.length; i++) {
    const style = styles[i];
    into[refs[i]] = { value: values[i], fmt: style >= 0 ? { ...fmts[style] } : null, version: versions[i] };
  }
  return into;
}
function pageCellsInto(page: CellsPage, into: CellMap): CellMap { return page.packed ? unpackCells(page.packed, into) : Object.assign(into, page.cells || {}); }
// A big sheet is read as a few runs of row blocks ("slices", chosen by the server: the
// `slices` of openDocument, or getSheetSlices), two at a time: one page travels while the
// server builds the next. More doesn't help (the server does one thing at a time) and costs it
// memory.
async function readSlices(slices: SheetSlice[], onPage: (sheetId: string, page: CellsPage) => void) {
  let next = 0;
  const worker = async () => {
    while (next < slices.length) {
      const slice = slices[next++];
      for (let after = slice.after; ;) {
        const page = await gadget.getCellsPage({ sheetId: slice.sheetId, after, from: slice.from, to: slice.to, packed: true });
        onPage(slice.sheetId, page);
        if (page.missing || page.next == null) break;
        after = page.next;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(2, slices.length) }, worker));
}
// Fills in the cells `openDocument` left for later (and unpacks the first page). True when
// every page came from the document's own revision. `progress(cellsSoFar)` follows along.
/** A document whose cells have all been read and unpacked (see loadRemainingPages). */
type LoadedDocument = OpenedDocument & { cells: Record<string, CellMap> };
async function loadRemainingPages(doc: OpenedDocument, progress: ((count: number) => void) | null = null): Promise<boolean> {
  let count = 0;
  if (doc.packed) {
    doc.cells = {};
    for (const [sheetId, packed] of Object.entries(doc.packed)) { doc.cells[sheetId] = unpackCells(packed, {}); count += packed.refs.length; }
    delete doc.packed;
  }
  doc.cells ||= {};
  let stable = true;
  await readSlices(doc.slices || [], (sheetId, page) => {
    if (page.revision !== doc.revision) stable = false;
    if (page.missing) return;
    pageCellsInto(page, doc.cells![sheetId] || (doc.cells![sheetId] = {}));
    count += page.packed ? page.packed.refs.length : Object.keys(page.cells || {}).length;
    progress?.(count);
  });
  return stable;
}
// The whole workbook, read again (a few times at most) until it comes from one revision.
async function fetchDocument(): Promise<LoadedDocument> {
  for (let attempt = 0; ; attempt++) {
    const doc = await gadget.openDocument({ packed: true });
    // loadRemainingPages has filled in `cells`.
    if ((await loadRemainingPages(doc)) || attempt >= 3) return doc as LoadedDocument;
  }
}
// Live events wait while a reload is read and applied, then are replayed if newer, so a
// reload that takes a moment can't overwrite an edit that arrived meanwhile.
async function reloadHoldingEvents(apply: (doc: LoadedDocument) => void) {
  holdEvents();
  try { apply(await fetchDocument()); }
  finally { if (!connecting && !sheetReloads) { ready = true; replayBuffered(); } }
}
// A big sheet someone else replaced arrives without its cells (`null`): they're read in pages
// while live events wait, and edits typed here meanwhile stay on top until they're saved.
//
// A snapshot applied meanwhile (a reconnect) is newer than the pages, so a reload started
// before it is dropped. This tab's own saves acknowledged during the reload are kept in
// `reloadAcks` and laid over pages read before they landed.
let sheetReloads = 0, snapshotGeneration = 0;
/** A cell as one of this tab's saves left it (`cell: null` when deleted), at that save's revision. */
interface ReloadAck { sheetId: string; ref: string; cell: Cell | null; revision: number }
const reloadAcks: ReloadAck[] = [];
async function reloadSheets(ids: string[]) {
  holdEvents(); sheetReloads++;
  const generation = snapshotGeneration;
  try {
    for (let attempt = 0; generation === snapshotGeneration; attempt++) {
      try {
        const loaded = new Map<string, CellMap>(ids.map((id) => [id, {}]));
        const { revision, slices } = await gadget.getSheetSlices({ sheetIds: ids });
        await readSlices(slices, (id, page) => { if (!page.missing) pageCellsInto(page, loaded.get(id)!); });
        if (generation !== snapshotGeneration) break;
        // Every page is at least as new as `revision`; a save acknowledged after it may be missing.
        for (const ack of reloadAcks) {
          const cells = loaded.get(ack.sheetId);
          if (!cells || ack.revision <= revision) continue;
          if (ack.cell) cells[ack.ref] = { ...ack.cell }; else delete cells[ack.ref];
        }
        for (const id of ids) {
          const cells = loaded.get(id)!;
          if (!model.sheets[id]) continue;
          layPendingCellOps(id, cells);
          model.cells[id] = cells;
        }
        rebuildEngine(); renderGrid();
        break;
      } catch (e) {
        console.error(e);
        await new Promise((resolve) => setTimeout(resolve, Math.min(1e4, 500 * 2 ** attempt)));
      }
    }
  } finally {
    sheetReloads--;
    if (!sheetReloads) reloadAcks.length = 0;
    if (!connecting && !sheetReloads) { ready = true; replayBuffered(); if (hasPendingSave()) scheduleSave(40); }
  }
}
function noteReloadAck(sheetId: string, ref: string, cell: Cell | null, revision: number) {
  if (sheetReloads) reloadAcks.push({ sheetId, ref, cell: cell && { ...cell }, revision });
}

// Sends everything queued as one operation and adopts what the server acknowledged.
//
// Cell versions keep local intent across retries. Whole-sheet replacements also carry the
// revision their layout was built on: replaying a sort or an insertion on another layout would
// silently overwrite someone else's changes. After an unclear failure the sheet is reloaded
// before such payloads are retried, and they're dropped if that revision moved on.
async function sendPendingOperation(): Promise<"saved" | "retry" | "conflict"> {
  if (resyncBeforeSave && wholesaleBaseRevision === null) {
    // Nothing wholesale is pending, and a stale cell op is refused on its own version.
    resyncBeforeSave = false;
  } else if (resyncBeforeSave) {
    // Throwing here leaves the flag set; the retry tries again.
    await reloadHoldingEvents((doc) => {
      resyncBeforeSave = false;
      if (doc.revision === wholesaleBaseRevision) return;
      pendingStructure = null;
      wholesaleBaseRevision = null;
      // A cell op queued after a replacement is keyed by the layout the replacement built, which
      // the server may not have. Losing an edit after a failed save is something the user sees
      // and can redo; writing into the wrong cell isn't.
      dropPendingLayouts();
      applySnapshot(doc, true);
      noteReloadedAfterFailure();
    });
  }
  // One message carries at most about OP_BYTES of cell edits (a huge paste goes out over a few
  // rounds; each round is saved as it lands).
  const sentCellOps: [string, PendingCellOp][] = [];
  let opBytes = 0;
  for (const entry of pendingCellOps) {
    const bytes = approxCellBytes(entry[1].ref, entry[1]);
    if (sentCellOps.length && opBytes + bytes > OP_BYTES) break;
    opBytes += bytes; sentCellOps.push(entry);
  }
  const sentStructure = pendingStructure;
  const sentReplacements = [...pendingReplacements];
  if (!sentCellOps.length && !sentStructure && !sentReplacements.length) return "saved";

  const cellOps: CellOp[] = sentCellOps.map(([, op]) => {
    const cur = (model.cells[op.sheetId] || {})[op.ref];
    return { sheetId: op.sheetId, ref: op.ref, value: op.value, fmt: op.fmt, baseVersion: op.baseVersion ?? (cur ? cur.version : 0) };
  });
  // A big replaced sheet is uploaded in parts first; the operation then names the upload.
  const sheetReplacements: SheetReplacement[] = [];
  for (const [sheetId, cells] of sentReplacements) {
    sheetReplacements.push(cellMapBytes(cells, UPLOAD_PART_BYTES) > UPLOAD_PART_BYTES ? await stageReplacement(sheetId, cells) : { sheetId, cells });
  }
  // A pivot sheet is rebuilt by every client that sees its source change, so a refresh isn't
  // guarded: one racing an edit elsewhere would otherwise be refused and reload the workbook.
  const sentBaseRevision = sentReplacements.some(([sheetId]) => !model.sheets[sheetId]?.pivot) ? wholesaleBaseRevision : null;
  const sentRevision = model.revision;
  inFlightStructure = sentStructure;
  let result: OperationResult;
  try {
    // A half-open connection can leave a call unanswered forever, which would stall every later
    // save behind it. Past SAVE_TIMEOUT_MS the call counts as failed (its outcome unknown, like
    // any failure: the retry resyncs first, and versions make a repeated cell edit harmless);
    // a late reply is ignored.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const call = gadget.applyOperation({
      senderId: clientId, structure: sentStructure, cellOps, sheetReplacements,
      ...(sentReplacements.length && sentBaseRevision !== null ? { baseRevision: sentBaseRevision } : {}),
    });
    call.catch(() => {});
    result = await Promise.race([call, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Save timed out")), SAVE_TIMEOUT_MS); })])
      .finally(() => clearTimeout(timer));
  } catch (e) {
    inFlightStructure = null;
    resyncBeforeSave = true;
    throw e;
  }
  inFlightStructure = null;
  if (result.status === "upload-missing") {
    // The server lost the staged parts (it restarted) before nothing was applied: send again,
    // backing off if that keeps happening.
    if (++uploadRetries > 3) { uploadRetries = 0; throw new Error("Staged upload kept going missing"); }
    return "retry";
  }
  uploadRetries = 0;
  if (result.staleRevision) {
    // The server refused the whole payload; cell edits on sheets that weren't replaced stay queued.
    const newerStructure = pendingStructure && pendingStructure !== sentStructure ? localStructureChanges(pendingStructure) : null;
    const rejectedLayoutSheets = new Set(pendingReplacements.keys());
    await reloadHoldingEvents((doc) => {
      dropPendingLayouts(); pendingStructure = null; wholesaleBaseRevision = null;
      applySnapshot(doc, true);
      noteReloadedAfterFailure();
    });
    // Edits made while this save was out weren't refused. Keep independent settings, but not
    // ones tied to a discarded layout (ranges on a replaced sheet).
    let retained = false;
    if (newerStructure?.title != null && newerStructure.title !== sentStructure?.title) { model.title = newerStructure.title; retained = true; }
    for (const [id, fields] of Object.entries<Partial<SheetMeta>>(newerStructure?.sheets || {})) {
      if (!model.sheets[id]) continue;
      for (const key of Object.keys(fields) as (keyof SheetMeta)[]) {
        if (key !== "name" && rejectedLayoutSheets.has(id)) continue;
        if (JSON.stringify(fields[key]) === JSON.stringify(sentStructure?.sheets[id]?.[key])) continue;
        Object.assign(model.sheets[id], { [key]: fields[key] }); retained = true;
      }
    }
    if (retained) queueStructure();
    rebuildEngine(); renderTabs(); renderGrid(); refreshToolbarState();
    return "conflict";
  }

  // Only what this call carried leaves the queue: an edit made while it was out replaced its
  // entry and stays pending.
  for (const [key, op] of sentCellOps) if (pendingCellOps.get(key) === op) pendingCellOps.delete(key);
  if (pendingStructure === sentStructure) pendingStructure = null;
  for (const [sheetId, cells] of sentReplacements) if (pendingReplacements.get(sheetId) === cells) pendingReplacements.delete(sheetId);
  if (pendingStructure === null && pendingReplacements.size === 0) {
    wholesaleBaseRevision = null;
    // The layout they belong to has landed, so they are ordinary edits now.
    for (const op of pendingCellOps.values()) delete op.layout;
  }

  model.revision = Math.max(model.revision, result.revision || 0);
  // A late reply mustn't replace a newer structure already received from someone else.
  if (sentStructure && result.structure && result.revision >= ackedStructureRevision) {
    ackedStructure = result.structure;
    ackedStructureRevision = result.revision;
  }
  // Only our own next commit certifies a snapshot built while this call was out; a later
  // remote revision doesn't certify the replacement's older cells.
  if ((pendingStructure !== null || pendingReplacements.size) && wholesaleBaseRevision === sentRevision
      && result.type === "operation" && result.revision === sentRevision + 1) wholesaleBaseRevision = result.revision;
  // An acknowledgment advances versions but doesn't overwrite an edit typed while it was out.
  const noteCommits = (result.upserts?.length || 0) + (result.deletes?.length || 0) <= RACE_NOTICE_CELLS;
  for (const up of result.upserts || []) {
    const cells = model.cells[up.sheetId] || (model.cells[up.sheetId] = {});
    const pending = pendingCellOps.get(up.sheetId + "!" + up.ref);
    if (!pending && noteCommits) noteCommit(up.sheetId, up.ref, up.cell.value, up.cell.version);
    noteReloadAck(up.sheetId, up.ref, up.cell, result.revision);
    if (!pending) cells[up.ref] = { ...up.cell };
    else {
      pending.baseVersion = up.cell.version;
      if (pending.value == null && pending.fmt == null) delete cells[up.ref];
      else cells[up.ref] = { value: pending.value ?? "", fmt: pending.fmt ?? null, version: up.cell.version };
    }
  }
  for (const del of result.deletes || []) {
    const cells = model.cells[del.sheetId] || (model.cells[del.sheetId] = {});
    const pending = pendingCellOps.get(del.sheetId + "!" + del.ref);
    if (!pending && noteCommits) noteCommit(del.sheetId, del.ref, null, 0);
    noteReloadAck(del.sheetId, del.ref, null, result.revision);
    if (!pending) delete cells[del.ref];
    else {
      pending.baseVersion = 0;
      if (pending.value == null && pending.fmt == null) delete cells[del.ref];
      else cells[del.ref] = { value: pending.value ?? "", fmt: pending.fmt ?? null, version: 0 };
    }
  }
  const conflicts = result.status === "conflict" && result.conflicts ? result.conflicts : [];
  // Rebase the refused intent (not the visible cell) onto the current version.
  const intents = new Map(cellOps.map((op) => [op.sheetId + "!" + op.ref, op]));
  for (const cf of conflicts) {
    const key = cf.sheetId + "!" + cf.ref;
    const intent = pendingCellOps.get(key) || intents.get(key);
    const cells = model.cells[cf.sheetId] || (model.cells[cf.sheetId] = {});
    noteReloadAck(cf.sheetId, cf.ref, cf.cell, result.revision);
    if (!intent) { cells[cf.ref] = { ...cf.cell }; continue; }
    const rebased = { ...intent, baseVersion: cf.cell?.version || 0 };
    pendingCellOps.set(key, rebased);
    if (rebased.value == null && rebased.fmt == null) delete cells[cf.ref];
    else cells[cf.ref] = { value: rebased.value ?? "", fmt: rebased.fmt ?? null, version: cf.cell?.version || 0 };
  }
  // Only the cells this reply touched need working out again.
  rebuildEngine([...(result.upserts || []), ...(result.deletes || []), ...conflicts].map((x) => ({ sheetId: x.sheetId, ref: x.ref })));
  // Our own broadcasts are ignored; conflicts and reloads need a redraw after rebasing.
  if (reloadedAfterFailure || conflicts.length) renderGrid();
  return conflicts.length ? "conflict" : "saved";
}
// Leaving or hiding the page saves immediately rather than after the debounce.
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden" && ready && hasPendingSave() && !saveInFlight) doSave(); });
window.addEventListener("pagehide", () => { if (ready && hasPendingSave() && !saveInFlight) doSave(); });

// ===========================================================================
// Undo / redo (local history of inverse cell/structure snapshots)
// ===========================================================================
/** One cell's state before a change (null: it didn't exist). */
interface CellRecord { sheetId: string; ref: string; prev: Cell | null }
/** An undoable batch of cell edits: each cell's state before it, by "sheetId!REF". */
interface CellHistory { kind?: undefined; cells: Map<string, CellRecord>; sheetId: string }
/** An undoable row/column move: the inverse move, and the filter as it was (see moveLines). */
interface MoveHistory { kind: "move"; sheetId: string; rows: boolean; from: number; count: number; to: number; restoreFilter: SheetFilter | null }
type HistoryEntry = CellHistory | MoveHistory;
const undoStack: HistoryEntry[] = [];
const redoStack: HistoryEntry[] = [];
let historyBatch: CellHistory | null = null;

function beginBatch() { historyBatch = { cells: new Map(), sheetId: activeSheetId }; }
function recordCell(sheetId: string, ref: string) {
  if (!historyBatch) beginBatch();
  const key = sheetId + "!" + ref;
  if (!historyBatch!.cells.has(key)) {
    const cur = (model.cells[sheetId] || {})[ref];
    historyBatch!.cells.set(key, { sheetId, ref, prev: cur ? { ...cur } : null });
  }
}
function commitBatch() {
  if (!historyBatch || !historyBatch.cells.size) { historyBatch = null; return; }
  undoStack.push(historyBatch);
  if (undoStack.length > 200) undoStack.shift();
  redoStack.length = 0;
  historyBatch = null;
  updateUndoButtons();
}
function applyHistory(entry: CellHistory, into: HistoryEntry[]) {
  const inverse: CellHistory = { cells: new Map(), sheetId: entry.sheetId };
  for (const [key, rec] of entry.cells) {
    const cells = model.cells[rec.sheetId] || (model.cells[rec.sheetId] = {});
    const now = cells[rec.ref] ? { ...cells[rec.ref] } : null;
    inverse.cells.set(key, { sheetId: rec.sheetId, ref: rec.ref, prev: now });
    // The restored content is an edit of the cell as it is now, so it carries the current version.
    const version = now ? now.version : 0;
    if (rec.prev) { cells[rec.ref] = { ...rec.prev, version }; }
    else delete cells[rec.ref];
    queueCellOp(rec.sheetId, rec.ref, rec.prev ? rec.prev.value : null, rec.prev ? rec.prev.fmt : null, version);
  }
  into.push(inverse);
  rebuildEngine([]);
  renderGrid();
  updateUndoButtons();
}
function undo() { if (!undoStack.length) return; const entry = undoStack.pop()!; if (entry.kind === "move") applyMoveHistory(entry, redoStack); else applyHistory(entry, redoStack); }
function redo() { if (!redoStack.length) return; const entry = redoStack.pop()!; if (entry.kind === "move") applyMoveHistory(entry, undoStack); else applyHistory(entry, undoStack); }
function updateUndoButtons() { setDisabled(undoBtn, !undoStack.length); setDisabled(redoBtn, !redoStack.length); }
// History is kept by cell ref, so it can't follow someone else's insert, delete, sort or move.
function forgetHistoryOf(sheetId: string) {
  for (const stack of [undoStack, redoStack]) {
    const kept = stack.filter((entry) => entry.kind === "move" ? entry.sheetId !== sheetId : ![...entry.cells.values()].some((rec) => rec.sheetId === sheetId));
    stack.splice(0, stack.length, ...kept);
  }
  updateUndoButtons();
}

// ===========================================================================
// Cell mutation primitives
// ===========================================================================
function setCellValue(ref: string, value: string | number | null | undefined, { batch = true } = {}) {
  const sheetId = activeSheetId;
  if (batch) recordCell(sheetId, ref);
  const cells = curCells();
  const cur = cells[ref];
  if ((value == null || value === "") && (!cur || !cur.fmt)) {
    if (cur) { const baseVersion = cur.version || 0; delete cells[ref]; queueCellOp(sheetId, ref, null, null, baseVersion); schedulePivotRefreshes(); }
    return;
  }
  const fmt = cur ? cur.fmt : null;
  cells[ref] = { value: value == null ? "" : String(value), fmt: fmt || null, version: cur ? cur.version : 0 };
  queueCellOp(sheetId, ref, cells[ref].value, cells[ref].fmt);
  schedulePivotRefreshes();
}
function setCellFmt(ref: string, mutator: (fmt: CellFmt) => void) {
  const sheetId = activeSheetId;
  recordCell(sheetId, ref);
  const cells = curCells();
  const cur = cells[ref];
  const fmt: CellFmt = cur && cur.fmt ? { ...cur.fmt } : {};
  mutator(fmt);
  const clean = Object.keys(fmt).length ? fmt : null;
  const value = cur ? cur.value : "";
  if ((value == null || value === "") && !clean) { if (cur) { const baseVersion = cur.version || 0; delete cells[ref]; queueCellOp(sheetId, ref, null, null, baseVersion); } return; }
  cells[ref] = { value: value || "", fmt: clean, version: cur ? cur.version : 0 };
  queueCellOp(sheetId, ref, cells[ref].value, clean);
}

// ===========================================================================
// Formatting actions over the selection
// ===========================================================================
// ── Walking a selection ──────────────────────────────────────────────────────
// Whole columns of a long sheet (or ⌘A) cover millions of positions, most of them empty. Work
// that only touches existing cells walks those instead; formatting, which also lands on empty
// cells, stays within the part of the sheet in use when the selection is that big.
const SELECTION_WALK_LIMIT = 250000, FORMAT_CELL_LIMIT = 1000000;
function selectionArea(ranges: Area[]): number { return ranges.reduce((n, r) => n + (r.r2 - r.r1 + 1) * (r.c2 - r.c1 + 1), 0); }
function inAnyRange(ranges: Area[], row: number, col: number): boolean { return ranges.some((r) => row >= r.r1 && row <= r.r2 && col >= r.c1 && col <= r.c2); }
// Calls fn(ref, row, col) once per selected position (or existing cell, with existingOnly).
// Returns false (after saying why) when the selection is too large to work through.
/** Visits one selected position: its ref, row and column. */
type CellVisitor = (ref: string, row: number, col: number) => void;
function walkSelection(fn: CellVisitor, { existingOnly = false } = {}): boolean {
  const ranges = selectionRanges(), area = selectionArea(ranges);
  if (existingOnly && area > SELECTION_WALK_LIMIT) {
    for (const ref of Object.keys(curCells())) { const p = parseRef(ref); if (p && inAnyRange(ranges, p.r, p.c)) fn(ref, p.r, p.c); }
    return true;
  }
  let walk = ranges;
  if (area > SELECTION_WALK_LIMIT) {
    const used = printBounds(activeSheetId);
    walk = ranges.map((r) => ({ ...r, r2: Math.min(r.r2, used.rows - 1), c2: Math.min(r.c2, used.cols - 1) })).filter((r) => r.r1 <= r.r2 && r.c1 <= r.c2);
    if (selectionArea(walk) > FORMAT_CELL_LIMIT) { toast(`That's more than ${FORMAT_CELL_LIMIT.toLocaleString()} cells at once; select a smaller range`, "bad"); return false; }
    if (walk.length && selectionArea(walk) < area) toast(`Applied to the part of the sheet in use (A1:${rcToRef(used.rows - 1, used.cols - 1)})`);
  }
  const seen = walk.length > 1 ? new Set<string>() : null;
  for (const range of walk) for (let row = range.r1; row <= range.r2; row++) for (let col = range.c1; col <= range.c2; col++) {
    const ref = rcToRef(row, col);
    if (seen) { if (seen.has(ref)) continue; seen.add(ref); }
    fn(ref, row, col);
  }
  return true;
}
function forEachSelected(fn: CellVisitor) {
  // While picking cells on another sheet, its selection is only a place to point at.
  if (editingAway()) return;
  beginBatch();
  walkSelection(fn);
  commitBatch();
  rebuildEngine([]);
  renderGrid();
}
/** The on/off format flags toggleFmt switches. */
type FmtFlag = "b" | "i" | "u" | "s" | "wrap";
function selectionFmtAllHave(key: FmtFlag) { return selectionAllFmt((fmt) => !!fmt?.[key]); }
// Whether every selected cell's format passes `test`. Over a huge selection it's judged by the
// cells that exist (an empty sheet's million blank positions would always say no).
function selectionAllFmt(test: (fmt: CellFmt | null | undefined) => boolean): boolean {
  const ranges = selectionRanges();
  if (selectionArea(ranges) > SELECTION_WALK_LIMIT) {
    let any = false;
    for (const [ref, c] of Object.entries(curCells())) {
      const p = parseRef(ref); if (!p || !inAnyRange(ranges, p.r, p.c)) continue;
      any = true; if (!test(c.fmt)) return false;
    }
    return any;
  }
  for (const range of ranges) for (let row = range.r1; row <= range.r2; row++) for (let col = range.c1; col <= range.c2; col++) {
    if (!test(getCell(rcToRef(row, col))?.fmt)) return false;
  }
  return true;
}
function toggleFmt(key: FmtFlag) {
  const on = !selectionFmtAllHave(key);
  forEachSelected((ref) => setCellFmt(ref, (f) => { if (on) f[key] = true; else delete f[key]; }));
  refreshToolbarState();
}
function setFmtOnSelection(mutator: (fmt: CellFmt) => void) {
  forEachSelected((ref) => setCellFmt(ref, mutator));
  refreshToolbarState();
}
function changeDecimals(delta: number) {
  forEachSelected((ref) => setCellFmt(ref, (f) => {
    // Dates, times and plain text have no decimal places to change.
    if (["date", "time", "datetime", "text"].includes(f.nf ?? "")) return;
    // Whole numbers ignore decimals, so they become Number, starting from none.
    if (f.nf === "integer") { f.nf = "number"; f.d = 0; }
    let d = f.d != null ? f.d : (["currency", "percent", "number", "scientific"].includes(f.nf ?? "") ? 2 : defaultDecimalsFor(ref));
    d = Math.max(0, Math.min(10, d + delta));
    f.d = d;
    if (!f.nf) f.nf = "number";
  }));
  refreshToolbarState();
}
// Counted from what the cell shows now, so "more" always adds a place and "fewer" removes one
// (3.14159 goes to 3.141 or 3.1415927, not to 3.14 / 3.15).
function defaultDecimalsFor(ref: string): number {
  const v = engine.computeRef(activeSheetId, ref);
  if (typeof v !== "number" || !Number.isFinite(v) || Number.isInteger(v)) return 0;
  const text = fmtGeneral(v);
  if (/e/i.test(text)) return 2;
  const fraction = /\.(\d+)$/.exec(text);
  return fraction ? Math.min(10, fraction[1].length) : 0;
}
function clearFormatting() {
  forEachSelected((ref) => setCellFmt(ref, (f) => { for (const k of Object.keys(f) as (keyof CellFmt)[]) delete f[k]; }));
  refreshToolbarState();
}

function autoSum() {
  if (editingFormula()) { insertFunction("SUM"); return; }
  if (editing) { commitEdit("none"); if (editing) return; }
  const r = selRange();
  // If single cell, sum the contiguous numbers above (or to the left).
  let target: string | undefined, rangeStr: string | undefined;
  if (r.r1 === r.r2 && r.c1 === r.c2) {
    const col = r.c1; let top = r.r1 - 1;
    while (top >= 0 && isNumericCell(rcToRef(top, col))) top--;
    top++;
    if (top <= r.r1 - 1) { rangeStr = rcToRef(top, col) + ":" + rcToRef(r.r1 - 1, col); target = rcToRef(r.r1, col); }
    else {
      let left = r.c1 - 1; while (left >= 0 && isNumericCell(rcToRef(r.r1, left))) left--; left++;
      if (left <= r.c1 - 1) { rangeStr = rcToRef(r.r1, left) + ":" + rcToRef(r.r1, r.c1 - 1); target = rcToRef(r.r1, r.c1); }
    }
  } else {
    // Put totals below each column of the selection.
    if (r.r2 + 1 >= curSheet().rows) { setStatus("bad", "No room below the selection for totals"); return; }
    beginBatch();
    for (let col = r.c1; col <= r.c2; col++) {
      const rangeS = rcToRef(r.r1, col) + ":" + rcToRef(r.r2, col);
      setCellValue(rcToRef(r.r2 + 1, col), "=SUM(" + rangeS + ")");
    }
    commitBatch(); rebuildEngine(); renderGrid();
    return;
  }
  if (rangeStr && target) {
    beginBatch(); setCellValue(target, "=SUM(" + rangeStr + ")"); commitBatch();
    rebuildEngine(); renderGrid();
    moveActive(r.r1, r.c1); startEdit(target, false);
  } else {
    // No numbers above or to the left: start a SUM with the caret inside, ready to pick cells.
    insertFunction("SUM");
  }
}
function isNumericCell(ref: string): boolean { const v = engine.computeRef(activeSheetId, ref); return typeof v === "number"; }

// ===========================================================================
// Insert / delete rows & columns (adjusts formula references)
// ===========================================================================
// The sheet name a reference prefix names, folded for comparison: `'Owner''s Sheet'!` and
// `'Owner\'s Sheet'!` both name "owner's sheet".
function referenceSheetName(prefix: string): string {
  const name = prefix.endsWith("!") ? prefix.slice(0, -1) : prefix;
  return (name.startsWith("'") ? name.slice(1, -1).replace(/\\'|''/g, "'") : name).toLowerCase();
}
// Rewrites references to the sheet named `oldName` with `prefix` (the new name's own prefix,
// quoted as needed), so formulas keep pointing at a renamed sheet. Everything else stays as typed.
function renameFormulaSheet(value: string, oldName: string, prefix: string): string {
  const target = String(oldName).toLowerCase();
  let result = "", start = 0;
  for (const endpoint of formulaReferences(value, true)) {
    const bang = endpoint.text.lastIndexOf("!");
    if (bang < 0 || referenceSheetName(endpoint.text.slice(0, bang + 1)) !== target) continue;
    result += value.slice(start, endpoint.start) + prefix + endpoint.text.slice(bang + 1);
    start = endpoint.end;
  }
  return result + value.slice(start);
}
/** A line map: where line `i` goes, or null if it was deleted. */
type LineMap = (i: number) => number | null;
// Rewrites a formula's text for rows or columns of the sheet named `sheetName` moved through
// `map` (inserted, deleted or reordered). Only references into that sheet move: unqualified ones
// when the formula lives there (`ownSheet`), qualified ones from anywhere. A reference into
// deleted lines becomes #REF!; a range shrinks around them, and follows its two corners when
// lines are reordered (so it keeps its extent when lines move within it, and is written
// low-to-high). Everything else in the formula (spacing, quoted text, number spelling, `$`
// locks) is left exactly as typed.
/** One endpoint of a reference, parsed: where it sits in the reference's text, its sheet prefix, `$` locks and position. */
interface RefPart { start: number; end: number; prefix: string; fc: string; col: number; fr: string; row: number }
function remapFormulaLines(value: string, { rows, map, sheetName, ownSheet }: { rows: boolean; map: LineMap; sheetName: string; ownSheet: boolean }): string {
  const target = String(sheetName).toLowerCase();
  let result = "", start = 0;
  for (const reference of formulaReferences(value)) {
    const parts = [...formulaReferences("=" + reference.text, true)].map((endpoint): RefPart | null => {
      const bang = endpoint.text.lastIndexOf("!");
      const m = /^(\$?)([A-Z]{1,2})(\$?)([1-9]\d*)$/i.exec(endpoint.text.slice(bang + 1));
      return m && { start: endpoint.start - 1, end: endpoint.end - 1, prefix: endpoint.text.slice(0, bang + 1), fc: m[1], col: letterToCol(m[2].toUpperCase()), fr: m[3], row: Number(m[4]) - 1 };
    });
    if (!parts.length || !parts.every((part): part is RefPart => !!part)) continue;
    const onTarget = parts[0].prefix ? referenceSheetName(parts[0].prefix) === target : ownSheet;
    if (!onTarget) continue;
    const index = (part: RefPart) => rows ? part.row : part.col;
    const lo = Math.min(...parts.map(index)), hi = Math.max(...parts.map(index));
    let nlo: number | null = null, nhi: number | null = null;
    for (let i = lo; i <= hi && nlo == null; i++) nlo = map(i);
    for (let i = hi; i >= lo && nhi == null; i--) nhi = map(i);
    if (nlo != null && nhi != null && nlo > nhi) [nlo, nhi] = [nhi, nlo];
    let replacement = "#REF!";
    if (nlo != null && (parts.length > 1 || lo === hi)) {
      replacement = ""; let cursor = 0;
      for (const part of parts) {
        // nhi is found whenever nlo is: both scans cross the line nlo came from.
        const n = (index(part) === lo ? nlo : nhi)!;
        replacement += reference.text.slice(cursor, part.start) + part.prefix + part.fc + colToLetter(rows ? part.col : n) + part.fr + ((rows ? n : part.row) + 1);
        cursor = part.end;
      }
      replacement += reference.text.slice(cursor);
    }
    result += value.slice(start, reference.start) + replacement;
    start = reference.end;
  }
  return result + value.slice(start);
}
// Applies a row/column edit on the active sheet to formulas across the workbook. The edited
// sheet's cells are saved by its whole-sheet replacement; formulas elsewhere that point into it
// are saved as ordinary cell edits.
function rewriteFormulasForAxis(rows: boolean, at: number, delta: number) {
  const count = Math.abs(delta);
  rewriteFormulasByMap(rows, (i) => delta > 0 ? (i >= at ? i + delta : i) : (i < at ? i : i < at + count ? null : i - count));
}
function rewriteFormulasByMap(rows: boolean, map: LineMap) {
  const sheetName = curSheet().name;
  for (const sheetId of model.sheetOrder) {
    const own = sheetId === activeSheetId;
    for (const [ref, cell] of Object.entries(model.cells[sheetId] || {})) {
      if (!cell.value || cell.value[0] !== "=") continue;
      const next = remapFormulaLines(cell.value, { rows, map, sheetName, ownSheet: own });
      if (next === cell.value) continue;
      cell.value = next;
      if (!own) queueCellOp(sheetId, ref, next, cell.fmt, cell.version || 0, true);
    }
  }
}

// Moves every cell and range-bearing piece of metadata through the row and column maps
// (`index -> index | null` for deleted). Chart ranges and pivot sources that read this sheet
// shrink around deleted lines and grow around inserted ones.
function rebuildSheetCells(mapRow: LineMap, mapCol: LineMap) {
  const next: CellMap = {};
  for (const [ref, cell] of Object.entries(curCells())) {
    const rc = parseRef(ref); if (!rc) continue;
    const r = mapRow(rc.r), c = mapCol(rc.c);
    if (r == null || c == null) continue;
    next[rcToRef(r, c)] = { ...cell, version: cell.version };
  }
  model.cells[activeSheetId] = next;
  for (const chart of curSheet().charts || []) chart.range = remapRange(chart.range, mapRow, mapCol);
  for (const id of pivotSheets()) {
    const pivot = model.sheets[id].pivot;
    if (pivot?.sourceSheetId === activeSheetId) pivot.sourceRange = remapRange(pivot.sourceRange, mapRow, mapCol);
  }
}
function remapRange(text: string, mapRow: LineMap, mapCol: LineMap): string {
  const range = parseRangeText(text); if (!range) return text;
  const first = (from: number, to: number, map: LineMap) => { for (let i = from; i <= to; i++) { const m = map(i); if (m != null) return m; } return null; };
  const last = (from: number, to: number, map: LineMap) => { for (let i = to; i >= from; i--) { const m = map(i); if (m != null) return m; } return null; };
  let r1 = first(range.r1, range.r2, mapRow), r2 = last(range.r1, range.r2, mapRow);
  let c1 = first(range.c1, range.c2, mapCol), c2 = last(range.c1, range.c2, mapCol);
  if (r1 == null || r2 == null || c1 == null || c2 == null) return "";
  // A move can carry one corner past the other.
  if (r1 > r2) [r1, r2] = [r2, r1];
  if (c1 > c2) [c1, c2] = [c2, c1];
  return text.includes(":") || r1 !== r2 || c1 !== c2 ? `${rcToRef(r1, c1)}:${rcToRef(r2, c2)}` : rcToRef(r1, c1);
}
const sameIndex = (i: number) => i;

function insertRows(at: number, count: number) {
  const sh = curSheet();
  // Lines pushed past the grid's limit would carry their cells out of sight.
  if (sh.rows + count > MAX_ROWS) { toast(`A sheet holds up to ${MAX_ROWS.toLocaleString()} rows`, "bad"); return; }
  if (sh.filter) {
    if (at <= sh.filter.row) { sh.filter.row += count; sh.filter.endRow = (sh.filter.endRow ?? sh.rows - 1) + count; }
    else if (at <= (sh.filter.endRow ?? sh.rows - 1)) sh.filter.endRow = (sh.filter.endRow ?? sh.rows - 1) + count;
  }
  rewriteFormulasForAxis(true, at, count);
  rebuildSheetCells((r) => r >= at ? r + count : r, sameIndex);
  sh.rows += count;
  shiftDims(sh.rowHeights, at, count);
  commitStructuralChange();
  moveActive(at, selRange().c1);
}
function insertCols(at: number, count: number) {
  const sh = curSheet();
  // Lines pushed past the grid's limit would carry their cells out of sight.
  if (sh.cols + count > MAX_COLS) { toast(`A sheet holds up to ${MAX_COLS.toLocaleString()} columns`, "bad"); return; }
  if (sh.filter) {
    const next: Record<string, string[]> = {};
    for (const [column, values] of Object.entries(sh.filter.criteria || {})) next[Number(column) >= at ? Number(column) + count : Number(column)] = values;
    sh.filter.criteria = next;
    const shifted = filterColumns(sh.filter).map((column) => column >= at ? column + count : column);
    // Columns inserted inside the table belong to its records.
    const inside = shifted.length && at > Math.min(...shifted) && at <= Math.max(...shifted);
    sh.filter.columns = inside ? [...shifted, ...Array.from({ length: count }, (_, index) => at + index)].sort((a, b) => a - b) : shifted;
  }
  rewriteFormulasForAxis(false, at, count);
  rebuildSheetCells(sameIndex, (c) => c >= at ? c + count : c);
  sh.cols += count;
  shiftDims(sh.colWidths, at, count);
  commitStructuralChange();
  moveActive(selRange().r1, at);
}
function deleteRows() {
  const r = selRange();
  const at = r.r1, count = r.r2 - r.r1 + 1;
  const sh = curSheet();
  if (sh.rows - count < 1) return;
  if (sh.filter) {
    const deletionEnd = at + count - 1;
    if (sh.filter.row >= at && sh.filter.row <= deletionEnd) sh.filter = null;
    else {
      if (deletionEnd < sh.filter.row) sh.filter.row -= count;
      const endRow = sh.filter.endRow ?? sh.rows - 1;
      if (at <= endRow) sh.filter.endRow = endRow - Math.min(count, endRow - at + 1);
    }
  }
  rewriteFormulasForAxis(true, at, -count);
  rebuildSheetCells((row) => (row >= at && row < at + count) ? null : (row > at ? row - count : row), sameIndex);
  sh.rows -= count;
  removeDims(sh.rowHeights, at, count);
  commitStructuralChange();
  moveActive(Math.min(at, sh.rows - 1), r.c1);
}
function deleteCols() {
  const r = selRange();
  const at = r.c1, count = r.c2 - r.c1 + 1;
  const sh = curSheet();
  if (sh.cols - count < 1) return;
  if (sh.filter) {
    const next: Record<string, string[]> = {};
    for (const [column, values] of Object.entries(sh.filter.criteria || {})) {
      const col = Number(column);
      if (col >= at && col < at + count) continue;
      next[col >= at + count ? col - count : col] = values;
    }
    sh.filter.criteria = next;
    sh.filter.columns = filterColumns(sh.filter)
      .filter((column) => column < at || column >= at + count)
      .map((column) => column >= at + count ? column - count : column);
    if (!sh.filter.columns.length) sh.filter = null;
  }
  rewriteFormulasForAxis(false, at, -count);
  rebuildSheetCells(sameIndex, (c) => (c >= at && c < at + count) ? null : (c > at ? c - count : c));
  sh.cols -= count;
  removeDims(sh.colWidths, at, count);
  commitStructuralChange();
  moveActive(r.r1, Math.min(at, sh.cols - 1));
}
// Moves `count` rows (or columns) starting at `from` so they sit before line `to` (an index in
// the current layout, 0…n; `to` inside the block is no move). Like a cut and insert in Excel:
// every formula in the workbook follows the cells it points at (a range follows its corners),
// as do charts, pivot sources, the filter, and row heights / column widths. Undoable: the
// history gets the inverse move (see applyMoveHistory).
function lineMoveMap(from: number, count: number, to: number): (i: number) => number {
  const dest = to < from ? to : to - count;
  return (i) => {
    if (i >= from && i < from + count) return dest + (i - from);
    if (to < from) return i >= to && i < from ? i + count : i;
    return i >= from + count && i < to ? i - count : i;
  };
}
function moveLines(rows: boolean, from: number, count: number, to: number, { restoreFilter, fromHistory = null }: { restoreFilter?: SheetFilter | null; fromHistory?: HistoryEntry[] | null } = {}): boolean {
  const sh = curSheet(); if (!sh) return false;
  const total = rows ? sh.rows : sh.cols;
  if (count < 1 || from < 0 || from + count > total || to < 0 || to > total || (to >= from && to <= from + count)) return false;
  if (sh.pivot) { setStatus("bad", "A pivot table arranges its own rows and columns"); return false; }
  if (rows && sh.filter && sh.filter.row >= from && sh.filter.row < from + count && restoreFilter === undefined) {
    setStatus("bad", "The filter's header row can't move. Remove the filter first."); return false;
  }
  const map = lineMoveMap(from, count, to), dest = to < from ? to : to - count;
  const filterBefore: SheetFilter | null = sh.filter ? JSON.parse(JSON.stringify(sh.filter)) : null;
  rewriteFormulasByMap(rows, map);
  rebuildSheetCells(rows ? map : sameIndex, rows ? sameIndex : map);
  const dims = rows ? sh.rowHeights : sh.colWidths, moved: Dims = {};
  for (const [k, v] of Object.entries(dims)) moved[map(Number(k))] = v;
  for (const k of Object.keys(dims)) delete dims[k];
  Object.assign(dims, moved);
  if (restoreFilter !== undefined) sh.filter = restoreFilter ? JSON.parse(JSON.stringify(restoreFilter)) : null;
  else if (sh.filter && rows) {
    // The table keeps its records wherever they went inside it, and stretches to keep any
    // that were dragged past its end.
    const filter = sh.filter, end = filter.endRow ?? sh.rows - 1;
    filter.row = map(filter.row);
    let last = filter.row;
    for (let row = filterBefore!.row + 1; row <= end; row++) last = Math.max(last, map(row));
    filter.endRow = last;
  } else if (sh.filter) {
    const filter = sh.filter, criteria: Record<string, string[]> = {};
    for (const [column, values] of Object.entries(filter.criteria || {})) criteria[map(Number(column))] = values;
    filter.criteria = criteria;
    if (filter.columns?.length) filter.columns = filter.columns.map(map).sort((a, b) => a - b);
  }
  commitStructuralChange({ keepHistory: true });
  // The way back: the block, now at `dest`, returns to where it was.
  const inverse: MoveHistory = { kind: "move", sheetId: activeSheetId, rows, from: dest, count, to: from < dest ? from : from + count, restoreFilter: filterBefore };
  if (fromHistory) fromHistory.push(inverse);
  else { undoStack.push(inverse); if (undoStack.length > 200) undoStack.shift(); redoStack.length = 0; }
  updateUndoButtons();
  if (rows) setSelection({ r: dest, c: 0 }, { r: dest + count - 1, c: sh.cols - 1 });
  else setSelection({ r: 0, c: dest }, { r: sh.rows - 1, c: dest + count - 1 });
  return true;
}
// Undoing (or redoing) a move is the inverse move, shown on its sheet.
function applyMoveHistory(entry: MoveHistory, into: HistoryEntry[]) {
  if (!model.sheets[entry.sheetId]) return;
  if (entry.sheetId !== activeSheetId) { switchSheet(entry.sheetId); if (entry.sheetId !== activeSheetId) return; }
  if (!moveLines(entry.rows, entry.from, entry.count, entry.to, { restoreFilter: entry.restoreFilter, fromHistory: into })) updateUndoButtons();
}
function shiftDims(dims: Dims, at: number, count: number) {
  const entries = Object.entries(dims).map(([k, v]): [number, number] => [Number(k), v]);
  for (const k of Object.keys(dims)) delete dims[k];
  for (const [k, v] of entries) dims[k >= at ? k + count : k] = v;
}
function removeDims(dims: Dims, at: number, count: number) {
  const entries = Object.entries(dims).map(([k, v]): [number, number] => [Number(k), v]);
  for (const k of Object.keys(dims)) delete dims[k];
  for (const [k, v] of entries) { if (k >= at && k < at + count) continue; dims[k > at ? k - count : k] = v; }
}
function commitStructuralChange({ keepHistory = false } = {}) {
  // Structural row/col changes establish a new natural row order.
  resetFilterSortBaseline();
  measuredRowHeights.delete(activeSheetId); // rows moved: what was measured where is stale
  layout = null;
  queueStructure();
  queueReplacement(activeSheetId);
  rebuildEngine();
  renderGrid();
  // Inserts and deletes aren't locally undoable (moves are: they record their own inverse).
  if (!keepHistory) { undoStack.length = 0; redoStack.length = 0; updateUndoButtons(); }
  schedulePivotRefreshes();
}

// ===========================================================================
// Sort
// ===========================================================================
// Sort order for computed values, as spreadsheets sort: numbers, then text (case-insensitive,
// digits by value), then booleans, then errors; blanks go last either way.
function compareSortValues(a: Scalar, b: Scalar, ascending: boolean): number {
  const blank = (v: Scalar) => v == null || v === "";
  if (blank(a) || blank(b)) return blank(a) === blank(b) ? 0 : blank(a) ? 1 : -1;
  const rank = (v: Scalar) => typeof v === "number" ? 0 : typeof v === "boolean" ? 2 : isErr(v) ? 3 : 1;
  let cmp = rank(a) - rank(b);
  if (!cmp) {
    if (typeof a === "number" || typeof a === "boolean") cmp = Number(a) - Number(b);
    else cmp = String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
  }
  return ascending ? cmp : -cmp;
}
function sortSelection(asc: boolean) {
  const r = { ...selRange() };
  // Whole columns (or ⌘A) sort the part of the sheet in use; the empty rest stays put.
  const used = printBounds(activeSheetId);
  r.r2 = Math.min(r.r2, Math.max(r.r1, used.rows - 1)); r.c2 = Math.min(r.c2, Math.max(r.c1, used.cols - 1));
  if (r.r1 === r.r2) return;
  const cells = curCells();
  const rows: { rowCells: Record<number, Cell>; keyVal: Scalar; sourceRow: number }[] = [];
  for (let row = r.r1; row <= r.r2; row++) {
    const rowCells: Record<number, Cell> = {};
    for (let col = r.c1; col <= r.c2; col++) { const c = cells[rcToRef(row, col)]; if (c) rowCells[col] = { ...c }; }
    let keyVal = engine.computeRef(activeSheetId, rcToRef(row, r.c1));
    if (keyVal instanceof HyperlinkValue) keyVal = keyVal.label;
    rows.push({ rowCells, keyVal, sourceRow: row });
  }
  rows.sort((x, y) => compareSortValues(x.keyVal, y.keyVal, asc));
  measuredRowHeights.delete(activeSheetId);
  // Write back. Formulas move with their rows and shift their relative references, as Excel does.
  for (let i = 0; i < rows.length; i++) {
    const row = r.r1 + i;
    for (let col = r.c1; col <= r.c2; col++) {
      const src = rows[i].rowCells[col];
      const ref = rcToRef(row, col);
      if (src) cells[ref] = { value: shiftedCopyFormula(src.value, rcToRef(rows[i].sourceRow, col), ref, false), fmt: src.fmt, version: (cells[ref]?.version || 0) };
      else delete cells[ref];
    }
  }
  resetFilterSortBaseline();
  queueStructure();
  queueReplacement(activeSheetId);
  rebuildEngine();
  renderGrid();
  undoStack.length = 0; redoStack.length = 0; updateUndoButtons();
  schedulePivotRefreshes();
}

/* ═════════════ 8. Rendering (pivots, charts, filters, grid) ══════════════ */

// ===========================================================================
// Pivot tables
// ===========================================================================
let pivotRefreshTimer: ReturnType<typeof setTimeout> | undefined;
function pivotSheets(): string[] { return model.sheetOrder.filter((id) => model.sheets[id]?.pivot); }
function pivotCellValue(sheetId: string, row: number, column: number): Scalar { return engine.computeRef(sheetId, rcToRef(row, column)); }
function pivotDisplay(value: Scalar): string { return value == null || value === "" ? "(Blank)" : (isErr(value) ? value.value : String(value)); }
function pivotSourceRange(): string {
  let range: Area = selRange();
  if (range.r1 === range.r2 && range.c1 === range.c2) {
    const detected = detectFilterRange();
    if (detected) range = { r1: detected.row, c1: Math.min(...detected.columns), r2: detected.endRow, c2: Math.max(...detected.columns) };
  }
  let r1 = Infinity, c1 = Infinity, r2 = -1, c2 = -1;
  for (const [ref, cell] of Object.entries(curCells())) {
    if (cell.value == null || cell.value === "") continue;
    const position = parseRef(ref); if (!position) continue;
    if (position.r >= range.r1 && position.r <= range.r2 && position.c >= range.c1 && position.c <= range.c2) {
      r1 = Math.min(r1, position.r); c1 = Math.min(c1, position.c); r2 = Math.max(r2, position.r); c2 = Math.max(c2, position.c);
    }
  }
  return r2 > r1 && c2 >= c1 ? `${rcToRef(r1, c1)}:${rcToRef(r2, c2)}` : "";
}
/** A pivot source column, named by its header (made unique). */
interface PivotField { name: string; column: number }
function pivotFields(pivot: PivotSettings): PivotField[] {
  const range = parseChartRange(pivot.sourceRange, model.sheets[pivot.sourceSheetId]); if (!range) return [];
  const fields: PivotField[] = [], used = new Set<string>();
  for (let column = range.c1; column <= range.c2; column++) {
    let name = pivotDisplay(pivotCellValue(pivot.sourceSheetId, range.r1, column)).slice(0, 8192);
    if (name === "(Blank)") name = `Column ${colToLetter(column)}`;
    // Generated names are reserved too, so headers `A`, `A (2)`, `A` stay distinct.
    let unique = name; for (let count = 2; used.has(unique); count++) unique = `${name} (${count})`;
    used.add(unique);
    fields.push({ name: unique, column });
  }
  return fields;
}
const MAX_PIVOT_CELLS = 100000;
const MAX_FILTER_SELECTIONS = 500; // mirrors the server's bound on filter and pivot selections
/** A running summary of one pivot cell's values. */
interface AggregateState { sum: number; count: number; numericCount: number; min: number; max: number }
function aggregateState(): AggregateState { return { sum: 0, count: 0, numericCount: 0, min: Infinity, max: -Infinity }; }
function addAggregate(state: AggregateState, value: Scalar) {
  // A blank isn't a value: it counts as nothing, not as 0.
  if (value == null || value === "" || isErr(value)) return;
  state.count++;
  const number = typeof value === "number" ? value : Number(value);
  if (Number.isFinite(number)) { state.sum += number; state.numericCount++; state.min = Math.min(state.min, number); state.max = Math.max(state.max, number); }
}
function finishAggregate(state: AggregateState, kind: PivotAggregate): number {
  if (kind === "count") return state.count;
  if (!state.numericCount) return 0;
  if (kind === "average") return state.sum / state.numericCount;
  if (kind === "min") return state.min;
  if (kind === "max") return state.max;
  return state.sum;
}
/** What a pivot sheet holds: its cells and the size it needs. */
interface PivotOutput { cells: CellMap; rows: number; cols: number }
function buildPivotOutput(pivot: PivotSettings): PivotOutput {
  const range = parseChartRange(pivot.sourceRange, model.sheets[pivot.sourceSheetId]), fields = pivotFields(pivot);
  if (!range || !fields.length) return { cells: {}, rows: 20, cols: 8 };
  const byName = new Map(fields.map((field) => [field.name, field.column]));
  const rowColumn = byName.get(pivot.rowField), columnColumn = byName.get(pivot.columnField), valueColumn = byName.get(pivot.valueField);
  const missingField = [pivot.rowField, pivot.columnField, pivot.valueField, pivot.filterField].find((field) => field && !byName.has(field));
  if (missingField) return { cells: { A1: { value: `Pivot field not found: ${missingField.slice(0, 200)}. Choose a current source field.`, fmt: { b: true }, version: 1 } }, rows: 20, cols: 8 };
  const records: { row: string; column: string; value: Scalar }[] = [];
  for (let row = range.r1 + 1; row <= range.r2; row++) {
    if (pivot.filterField) {
      const filterColumn = byName.get(pivot.filterField);
      // `filterValue`: the single value older pivots stored.
      const legacy = (pivot as PivotSettings & { filterValue?: string }).filterValue;
      const selectedValues = pivot.filterValues || (legacy ? [legacy] : []);
      if (filterColumn != null && selectedValues.length && !selectedValues.includes(pivotDisplay(pivotCellValue(pivot.sourceSheetId, row, filterColumn)))) continue;
    }
    records.push({
      row: rowColumn == null ? "Values" : pivotDisplay(pivotCellValue(pivot.sourceSheetId, row, rowColumn)),
      column: columnColumn == null ? (pivot.valueField || "Value") : pivotDisplay(pivotCellValue(pivot.sourceSheetId, row, columnColumn)),
      value: valueColumn == null ? 1 : pivotCellValue(pivot.sourceSheetId, row, valueColumn),
    });
  }
  const rowKeys = [...new Set(records.map((record) => record.row))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const columnKeys = [...new Set(records.map((record) => record.column))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  // The output is every row value × every column value plus headers and totals; past the cell
  // cap or the sheet's limits it can't be laid out, so the pivot says so instead of freezing.
  const outputRows = rowKeys.length + 2, outputColumns = columnKeys.length + 2;
  if (outputRows * outputColumns > MAX_PIVOT_CELLS || outputRows > 50000 || outputColumns > 702) {
    return { cells: { A1: { value: `Pivot table too large: ${rowKeys.length.toLocaleString()} row values × ${columnKeys.length.toLocaleString()} column values. Choose fields with fewer distinct values.`, fmt: { b: true, c: "#b42318" }, version: 1 } }, rows: 20, cols: 8 };
  }
  const states = new Map<string, AggregateState>(), rowTotals = new Map<string, AggregateState>(), columnTotals = new Map<string, AggregateState>(), grandTotal = aggregateState();
  const stateFor = (map: Map<string, AggregateState>, key: string) => { if (!map.has(key)) map.set(key, aggregateState()); return map.get(key) as AggregateState; };
  for (const record of records) {
    addAggregate(stateFor(states, record.row + "\u0000" + record.column), record.value);
    addAggregate(stateFor(rowTotals, record.row), record.value); addAggregate(stateFor(columnTotals, record.column), record.value); addAggregate(grandTotal, record.value);
  }
  const cells: CellMap = {}, put = (row: number, column: number, value: string | number, fmt: CellFmt | null = null) => { cells[rcToRef(row, column)] = { value: String(value ?? ""), fmt, version: 1 }; };
  // Labels are text taken from computed values; one the grid would re-read as something else
  // (a formula, a number, a boolean, an apostrophe) is stored with the literal-text prefix.
  const label = (text: string) => /^[='+\-$.\d]|^(true|false)$/i.test(text) ? "'" + text : text;
  const headerFmt = { b: true, bg: "#e1632e", c: "#ffffff" };
  const rowHeaderFmt = { b: true, bg: "#fff7f2", c: "#3f332e" };
  const totalFmt = { b: true, bg: "#fde9dc", c: "#3f332e" };
  put(0, 0, label(pivot.rowField || "Rows"), headerFmt);
  columnKeys.forEach((key, index) => put(0, index + 1, label(key), headerFmt));
  if (pivot.showRowTotals !== false) put(0, columnKeys.length + 1, "Grand Total", totalFmt);
  rowKeys.forEach((rowKey, rowIndex) => {
    put(rowIndex + 1, 0, label(rowKey), rowHeaderFmt);
    columnKeys.forEach((columnKey, columnIndex) => put(rowIndex + 1, columnIndex + 1, finishAggregate(states.get(rowKey + "\u0000" + columnKey) || aggregateState(), pivot.aggregate), pivot.aggregate === "average" ? { nf: "number", d: 2 } : null));
    if (pivot.showRowTotals !== false) put(rowIndex + 1, columnKeys.length + 1, finishAggregate(rowTotals.get(rowKey) || aggregateState(), pivot.aggregate), totalFmt);
  });
  if (pivot.showColumnTotals !== false) {
    const totalRow = rowKeys.length + 1; put(totalRow, 0, "Grand Total", totalFmt);
    columnKeys.forEach((key, index) => put(totalRow, index + 1, finishAggregate(columnTotals.get(key) || aggregateState(), pivot.aggregate), totalFmt));
    if (pivot.showRowTotals !== false) put(totalRow, columnKeys.length + 1, finishAggregate(grandTotal, pivot.aggregate), totalFmt);
  }
  return { cells, rows: Math.min(50000, Math.max(20, rowKeys.length + 4)), cols: Math.min(702, Math.max(8, columnKeys.length + 3)) };
}
function refreshPivot(sheetId: string, save = true) {
  const sheet = model.sheets[sheetId]; if (!sheet?.pivot) return;
  const output = buildPivotOutput(sheet.pivot);
  // Unchanged output isn't rewritten, so a refresh doesn't save (or bump versions) for nothing.
  const current: CellMap = {};
  for (const [ref, cell] of Object.entries(model.cells[sheetId] || {})) current[ref] = { value: cell.value, fmt: cell.fmt ?? null, version: 1 };
  if (JSON.stringify(output.cells) === JSON.stringify(current)) return;
  model.cells[sheetId] = output.cells; sheet.rows = Math.max(sheet.rows, output.rows); sheet.cols = Math.max(sheet.cols, output.cols);
  const widths: Record<number, number> = {};
  for (const [ref, cell] of Object.entries(output.cells)) {
    const position = parseRef(ref); if (!position) continue;
    const minimum = position.c === 0 ? 150 : 110;
    widths[position.c] = Math.max(widths[position.c] || minimum, Math.min(320, String(cell.value || "").length * 8 + 30));
  }
  sheet.colWidths = { ...sheet.colWidths, ...widths };
  sheet.rowHeights = { ...sheet.rowHeights, 0: 30 };
  if (save) { queueStructure(); queueReplacement(sheetId); }
  rebuildEngine();
  if (activeSheetId === sheetId) renderGrid();
}
// A pivot's source may hold formulas that read other sheets, so any edit refreshes every pivot
// after a short pause rather than tracing dependencies. Refreshing writes only pivot sheets and
// doesn't reschedule itself.
function schedulePivotRefreshes() {
  if (!pivotSheets().length) return;
  clearTimeout(pivotRefreshTimer);
  pivotRefreshTimer = setTimeout(() => {
    rebuildEngine();
    for (const id of pivotSheets()) refreshPivot(id);
  }, 320);
}
function createPivotTable() {
  if (!finishEditBeforeSheetChange()) return;
  const sourceSheetId = activeSheetId, sourceRange = pivotSourceRange();
  if (!sourceRange) { setStatus("bad", "Select data with a header row"); return; }
  const id = "s_" + Math.random().toString(36).slice(2, 8);
  let number = 1; while (model.sheetOrder.some((sheetId) => model.sheets[sheetId].name.toLowerCase() === `pivot table ${number}`)) number++;
  const pivot: PivotSettings = { sourceSheetId, sourceRange, rowField: "", columnField: "", valueField: "", aggregate: "sum", showRowTotals: true, showColumnTotals: true, filterField: "", filterValues: [] };
  const fields = pivotFields(pivot); pivot.rowField = fields[0]?.name || "";
  pivot.valueField = fields.find((field) => {
    const range = parseChartRange(sourceRange); if (!range) return false;
    for (let row = range.r1 + 1; row <= range.r2; row++) if (typeof pivotCellValue(sourceSheetId, row, field.column) === "number") return true;
    return false;
  })?.name || fields[1]?.name || fields[0]?.name || "";
  // `created` is the server's to assign (it ignores what a client sends).
  const pivotSheet: Omit<SheetMeta, "created"> = { id, name: `Pivot table ${number}`, rows: 100, cols: 26, colWidths: {}, rowHeights: {}, frozenRows: 0, frozenCols: 0, filter: null, charts: [], pivot };
  model.sheets[id] = pivotSheet as SheetMeta;
  model.cells[id] = {}; model.sheetOrder.push(id); refreshPivot(id, false);
  queueStructure(); queueReplacement(id); switchSheet(id);
  // The new pivot's settings open under the button, ready to pick rows and values.
  requestAnimationFrame(() => openPivotMenu(id));
}
const PIVOT_AGGREGATES: [PivotAggregate, string][] = [["sum", "Sum"], ["count", "Count"], ["average", "Average"], ["min", "Min"], ["max", "Max"]];
function pivotSelectField(label: string, value: string, options: (string | [string, string])[], onChange: (value: string) => void, allowNone = true): HTMLLabelElement {
  const select = el("select", { "aria-label": label });
  if (allowNone) select.appendChild(el("option", { value: "" }, "None"));
  for (const entry of options) {
    const [optionValue, optionLabel] = Array.isArray(entry) ? entry : [entry, entry];
    const option = el("option", { value: optionValue }, optionLabel); if (optionValue === value) option.selected = true; select.appendChild(option);
  }
  select.addEventListener("change", () => onChange(select.value));
  return el("label", { class: "chart-field" }, [el("span", {}, label), select]);
}
// Pivot settings: a pop under the Pivot button. Changes apply as they are made; picking a
// field rebuilds the pop so dependent choices (columns, filter values) stay in step.
function openPivotMenu(sheetId: string) {
  const sheet = model.sheets[sheetId], pivot = sheet?.pivot; if (!pivot) return;
  if (sheetId !== activeSheetId) switchSheet(sheetId);
  if (sheetId !== activeSheetId) return;
  const fields = pivotFields(pivot).map((field) => field.name);
  const change = <K extends keyof PivotSettings>(key: K, value: PivotSettings[K]) => { updatePivot(sheetId, key, value); openPivotMenu(sheetId); };
  const source = model.sheets[pivot.sourceSheetId];
  const rangeInput = el("input", { type: "text", value: pivot.sourceRange, placeholder: "A1:D100", spellcheck: "false" });
  rangeInput.addEventListener("change", () => change("sourceRange", rangeInput.value.trim().toUpperCase()));
  rangeInput.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); rangeInput.blur(); } });
  const checks = el("div", { class: "settings-checks" }, ([["Row totals", "showRowTotals"], ["Column totals", "showColumnTotals"]] as const).map(([label, key]) => {
    const input = el("input", { type: "checkbox" }); input.checked = pivot[key] !== false;
    input.addEventListener("change", () => updatePivot(sheetId, key, input.checked));
    return el("label", { class: "chart-check" }, [input, el("span", {}, label)]);
  }));
  const refresh = el("button", { type: "button" }, "Refresh");
  refresh.addEventListener("click", () => { refreshPivot(sheetId); toast("Pivot table refreshed"); });
  const remove = el("button", { type: "button", class: "danger" }, "Delete");
  remove.addEventListener("click", () => { closePop(); deleteSheet(sheetId); });
  const content = [
    el("div", { class: "settings-head" }, [el("strong", {}, sheet.name), el("span", { class: "settings-sub" }, `${source?.name || "Missing sheet"}`)]),
    el("label", { class: "chart-field" }, [el("span", {}, "Source range"), rangeInput]),
    el("div", { class: "settings-pair" }, [
      pivotSelectField("Rows", pivot.rowField, fields, (value) => change("rowField", value)),
      pivotSelectField("Columns", pivot.columnField, fields.filter((field) => field !== pivot.rowField), (value) => change("columnField", value)),
    ]),
    el("div", { class: "settings-pair" }, [
      pivotSelectField("Values", pivot.valueField, fields, (value) => change("valueField", value), false),
      pivotSelectField("Summarize by", pivot.aggregate, PIVOT_AGGREGATES, (value) => change("aggregate", value as PivotAggregate), false),
    ]),
    checks,
    pivotSelectField("Filter by", pivot.filterField, fields, (value) => change("filterField", value)),
    pivot.filterField ? pivotFilterMultiSelect(sheetId, pivot) : null,
    el("div", { class: "pivot-note" }, "This sheet is rebuilt from the source whenever it changes, so edits made here directly are replaced."),
    el("div", { class: "settings-actions" }, [refresh, el("span", { class: "grow" }), remove]),
  ];
  const anchor = pivotBtn.isConnected && pivotBtn.offsetParent ? pivotBtn : gridScroll;
  const pop = showPop(content, anchor.getBoundingClientRect(), { owner: anchor === pivotBtn ? pivotBtn : null, kind: "dialog", className: "settings-pop" });
  return pop;
}
function updatePivot<K extends keyof PivotSettings>(sheetId: string, key: K, value: PivotSettings[K]) {
  const pivot = model.sheets[sheetId]?.pivot; if (!pivot) return;
  pivot[key] = value; if (key === "filterField") pivot.filterValues = [];
  if (key === "sourceRange") {
    const fields = pivotFields(pivot).map((field) => field.name);
    if (!fields.includes(pivot.rowField)) pivot.rowField = fields[0] || "";
    if (!fields.includes(pivot.valueField)) pivot.valueField = fields[1] || fields[0] || "";
    if (!fields.includes(pivot.columnField)) pivot.columnField = "";
    if (!fields.includes(pivot.filterField)) { pivot.filterField = ""; pivot.filterValues = []; }
  }
  // Settings are saved even when a different choice happens to produce identical cells.
  queueStructure(); refreshPivot(sheetId);
}
function pivotFilterValues(pivot: PivotSettings): string[] {
  if (!pivot.filterField) return [];
  const range = parseChartRange(pivot.sourceRange, model.sheets[pivot.sourceSheetId]), field = pivotFields(pivot).find((item) => item.name === pivot.filterField);
  if (!range || !field) return [];
  const values: string[] = []; for (let row = range.r1 + 1; row <= range.r2; row++) values.push(pivotDisplay(pivotCellValue(pivot.sourceSheetId, row, field.column)));
  return [...new Set(values)].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}
// A source column can hold tens of thousands of distinct values; only a page of them is drawn,
// narrowed by the search box, so the pop never builds an unbounded list.
const MAX_PIVOT_FILTER_OPTIONS = 200;
function pivotFilterMultiSelect(sheetId: string, pivot: PivotSettings): HTMLDivElement {
  const options = pivotFilterValues(pivot), selected = pivot.filterValues || [];
  const allSelected = !selected.length, wrap = el("div", { class: "chart-field" });
  wrap.appendChild(el("span", {}, "Show values"));
  const chosen = new Set(allSelected ? options : selected);
  const list = el("div", { class: "pivot-filter-values" });
  const note = el("div", { class: "pivot-note" });
  let query = "";
  const apply = () => {
    const next = chosen.size === options.length ? [] : (chosen.size ? [...chosen] : ["__PIVOT_NONE__"]);
    // The server drops a larger selection outright, so it's refused here instead of silently changing.
    const oversized = next.some((value) => value.length > 8192);
    if (next.length > MAX_FILTER_SELECTIONS || oversized) {
      toast(oversized ? "Selected values are limited to 8,192 characters" : `Select at most ${MAX_FILTER_SELECTIONS} values, or clear the filter instead`, "bad");
      chosen.clear(); for (const value of pivot.filterValues?.length ? pivot.filterValues : options) chosen.add(value);
      render(); return;
    }
    pivot.filterValues = next;
    queueStructure(); refreshPivot(sheetId);
  };
  const render = (): void => {
    list.replaceChildren();
    const matching = query ? options.filter((value) => value.toLowerCase().includes(query)) : options;
    for (const value of matching.slice(0, MAX_PIVOT_FILTER_OPTIONS)) {
      const input = el("input", { type: "checkbox" }); input.checked = chosen.has(value);
      input.addEventListener("change", () => { if (input.checked) chosen.add(value); else chosen.delete(value); apply(); });
      list.appendChild(el("label", { class: "pivot-filter-option", title: value }, [input, el("span", {}, value)]));
    }
    note.textContent = !options.length ? "No values available"
      : matching.length > MAX_PIVOT_FILTER_OPTIONS ? `Showing ${MAX_PIVOT_FILTER_OPTIONS} of ${matching.length.toLocaleString()} values; search to narrow` : "";
    note.style.display = note.textContent ? "" : "none";
  };
  if (options.length > MAX_PIVOT_FILTER_OPTIONS) {
    const search = el("input", { class: "filter-search", type: "search", placeholder: "Search values…", "aria-label": "Search pivot filter values" });
    search.addEventListener("input", () => { query = search.value.trim().toLowerCase(); render(); });
    wrap.appendChild(el("div", { class: "filter-search-row" }, [search]));
  }
  render();
  wrap.appendChild(list); wrap.appendChild(note); return wrap;
}

// ===========================================================================
// Charts
// ===========================================================================
let selectedChartId: string | null = null;
let newChartId: string | null = null; // a just-created chart pops in once
const CHART_COLORS = ["#e1632e", "#3478c7", "#1f9d77", "#8b5fbf", "#c49324", "#c4566a"];
function sheetCharts(): Chart[] { return curSheet().charts || (curSheet().charts = []); }
const MAX_RANGE_CELLS = 200000; // mirrors the server's bound on chart and pivot ranges
// "A1:C9" as a rectangle, without bounds (used when moving ranges with inserted rows).
function parseRangeText(value: unknown): Area | null {
  const match = /^([A-Z]+[1-9]\d*)(?::([A-Z]+[1-9]\d*))?$/.exec(String(value || "").trim().toUpperCase());
  if (!match) return null;
  const a = parseRef(match[1]), b = parseRef(match[2] || match[1]);
  if (!a || !b) return null;
  return { r1: Math.min(a.r, b.r), c1: Math.min(a.c, b.c), r2: Math.max(a.r, b.r), c2: Math.max(a.c, b.c) };
}
// A chart or pivot range, clipped to the sheet it reads, as the server stores it. A range past
// the sheet or over the cell cap is nothing, so a typo can't make the page walk millions of cells.
function parseChartRange(value: unknown, sheet: SheetMeta | undefined = curSheet()): Area | null {
  const parsed = parseRangeText(value);
  if (!parsed || !sheet) return null;
  const range = { ...parsed, r2: Math.min(parsed.r2, sheet.rows - 1), c2: Math.min(parsed.c2, sheet.cols - 1) };
  if (range.r1 > range.r2 || range.c1 > range.c2 || (range.r2 - range.r1 + 1) * (range.c2 - range.c1 + 1) > MAX_RANGE_CELLS) return null;
  return range;
}
function rangeHasData(range: Area, cells: CellMap = curCells()): boolean {
  // Walks whichever is smaller: the range, or the sheet's cells.
  const area = (range.r2 - range.r1 + 1) * (range.c2 - range.c1 + 1);
  let count = 0;
  for (const _ in cells) if (++count > area) break;
  if (count > area) {
    for (let r = range.r1; r <= range.r2; r++) for (let c = range.c1; c <= range.c2; c++) {
      const value = cells[rcToRef(r, c)]?.value;
      if (value != null && value !== "") return true;
    }
    return false;
  }
  return Object.entries(cells).some(([ref, cell]) => {
    if (cell.value == null || cell.value === "") return false;
    const position = parseRef(ref);
    return position !== null && position.r >= range.r1 && position.r <= range.r2 && position.c >= range.c1 && position.c <= range.c2;
  });
}
function defaultChartRange(): string {
  const range = selRange();
  return rangeHasData(range) ? rcToRef(range.r1, range.c1) + (range.r1 === range.r2 && range.c1 === range.c2 ? "" : ":" + rcToRef(range.r2, range.c2)) : "";
}
function inferChartLayout(rangeText: string): { firstRowHeaders: boolean; firstColLabels: boolean } {
  const range = parseChartRange(rangeText);
  if (!range) return { firstRowHeaders: true, firstColLabels: true };
  let firstRowHeaders = false, firstColLabels = false;
  if (range.r2 > range.r1) {
    for (let column = range.c1; column <= range.c2; column++) {
      const value = engine.computeRef(activeSheetId, rcToRef(range.r1, column));
      if (typeof value === "string" && value !== "") { firstRowHeaders = true; break; }
    }
  }
  if (range.c2 > range.c1) {
    let textCount = 0, populated = 0;
    for (let row = range.r1 + (firstRowHeaders ? 1 : 0); row <= range.r2; row++) {
      const value = engine.computeRef(activeSheetId, rcToRef(row, range.c1));
      if (value != null && value !== "") { populated++; if (typeof value === "string") textCount++; }
    }
    firstColLabels = populated > 0 && textCount >= Math.ceil(populated / 2);
  }
  return { firstRowHeaders, firstColLabels };
}
const CHART_TYPES: { value: ChartType; label: string; icon: keyof typeof ICONS }[] = [
  { value: "line", label: "Line chart", icon: "lineChart" },
  { value: "pie", label: "Pie chart", icon: "pieChart" },
  { value: "area", label: "Area chart", icon: "areaChart" },
  { value: "stackedBar", label: "Stacked bar chart", icon: "barChart" },
];
function chartTypeLabel(type: string): string { return CHART_TYPES.find((item) => item.value === type)?.label || "Chart"; }
function openCreateChartMenu(owner: HTMLElement = chartBtn) {
  const r = defaultChartRange();
  showPop([
    el("div", { class: "mhead" }, r ? `Chart from ${r}` : "Insert chart"),
    ...CHART_TYPES.map((type) => menuItem({ icon: type.icon, label: type.label, onSelect: () => createChart(type.value) })),
  ], owner.getBoundingClientRect(), { owner });
}
function createChart(type: ChartType = "line") {
  if (sheetCharts().length >= MAX_CHARTS) { toast(`A sheet holds at most ${MAX_CHARTS} charts`, "bad"); return; }
  const range = defaultChartRange();
  const inferred = inferChartLayout(range);
  const area = parseChartRange(range);
  // Beside its data (lib/charts.ts), as addChart places one; with no data, in view.
  const occupied = (c: number) => {
    const col = colToLetter(c), cells = curCells();
    for (let r = area!.r1; r <= Math.min(area!.r2, area!.r1 + PLACEMENT_ROWS - 1); r++) if (cells[col + (r + 1)]?.value) return true;
    return false;
  };
  const at = area ? chartPlacement(area, { colLeft: colX, rowTop: rowY, cols: curSheet().cols, occupied }, 520) : { x: Math.max(60, gridScroll.scrollLeft + 80), y: Math.max(32, gridScroll.scrollTop + 40) };
  // `smooth` is left for the server to default.
  const chart = {
    id: "chart_" + Math.random().toString(36).slice(2, 9), type, range,
    title: chartTypeLabel(type), xAxisTitle: "", yAxisTitle: "", legend: true,
    firstRowHeaders: inferred.firstRowHeaders, firstColLabels: inferred.firstColLabels,
    x: at.x, y: at.y, width: 520, height: 320,
  } as Chart;
  sheetCharts().push(chart);
  newChartId = chart.id;
  queueStructure(); renderCharts();
}
function updateChart<K extends keyof Chart>(chartId: string, key: K, value: Chart[K]) {
  const chart = sheetCharts().find((item) => item.id === chartId); if (!chart) return;
  if (chart[key] === value) return;
  chart[key] = value; queueStructure(); renderCharts();
}
function chartTextField(label: string, key: "range" | "title" | "xAxisTitle" | "yAxisTitle", chart: Chart, placeholder = ""): HTMLLabelElement {
  const input = el("input", { type: "text", value: chart[key] || "", placeholder, spellcheck: key === "range" ? "false" : null });
  input.addEventListener("input", () => {
    if (key === "range") { const at = input.selectionStart; input.value = input.value.toUpperCase(); input.setSelectionRange(at, at); }
    updateChart(chart.id, key, key === "range" ? input.value.trim() : input.value);
  });
  input.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); closePop(); armEditorCapture(true); } });
  return el("label", { class: "chart-field" }, [el("span", {}, label), input]);
}
function chartTypeField(chart: Chart): HTMLLabelElement {
  const select = el("select", { "aria-label": "Chart type" });
  for (const type of CHART_TYPES) {
    const option = el("option", { value: type.value }, type.label);
    if (type.value === chart.type) option.selected = true;
    select.appendChild(option);
  }
  // Pie charts have no axes, so the pop is rebuilt to show or hide the axis titles.
  select.addEventListener("change", () => { updateChart(chart.id, "type", select.value as ChartType); openChartMenu(chart.id); });
  return el("label", { class: "chart-field" }, [el("span", {}, "Type"), select]);
}
function chartCheckbox(label: string, key: "firstRowHeaders" | "firstColLabels" | "legend", chart: Chart): HTMLLabelElement {
  const input = el("input", { type: "checkbox" }); input.checked = chart[key] !== false;
  input.addEventListener("change", () => updateChart(chart.id, key, input.checked));
  return el("label", { class: "chart-check" }, [input, el("span", {}, label)]);
}
function deleteChart(chartId: string) {
  curSheet().charts = sheetCharts().filter((item) => item.id !== chartId);
  if (selectedChartId === chartId) selectedChartId = null;
  queueStructure(); renderCharts();
}
// Chart settings: a pop beside the chart (below its title bar, or above when there's no room).
// Every change shows on the chart at once; Esc or a click elsewhere closes it.
function openChartMenu(chartId: string) {
  const chart = sheetCharts().find((item) => item.id === chartId); if (!chart) return;
  const card = chartLayer.querySelector<HTMLElement>(`.chart-card[data-chart-id="${CSS.escape(chartId)}"]`);
  if (!card) return;
  selectedChartId = chartId;
  chartLayer.querySelectorAll(".chart-card").forEach((node) => node.classList.toggle("selected", node === card));
  const copy = el("button", { type: "button" }, "Copy SVG");
  copy.addEventListener("click", () => copyChartImage(chart));
  attachTip(copy, "Copies a picture of the chart for Slides, PowerPoint or Keynote");
  const remove = el("button", { type: "button", class: "danger" }, "Delete");
  remove.addEventListener("click", () => { closePop(); deleteChart(chart.id); armEditorCapture(true); });
  const content = [
    el("div", { class: "settings-head" }, [el("strong", {}, "Chart"), el("span", { class: "settings-sub" }, curSheet().name)]),
    el("div", { class: "settings-pair" }, [chartTypeField(chart), chartTextField("Data range", "range", chart, "A1:C10")]),
    chartTextField("Title", "title", chart),
    chart.type !== "pie" ? el("div", { class: "settings-pair" }, [
      chartTextField("Horizontal axis", "xAxisTitle", chart),
      chartTextField("Vertical axis", "yAxisTitle", chart),
    ]) : null,
    el("div", { class: "settings-checks" }, [
      chartCheckbox("First row is headers", "firstRowHeaders", chart),
      chartCheckbox("First column is labels", "firstColLabels", chart),
      chartCheckbox("Show legend", "legend", chart),
    ]),
    el("div", { class: "settings-actions" }, [copy, el("span", { class: "grow" }), remove]),
  ];
  const head = card.querySelector(".chart-card-head") || card;
  const rect = head.getBoundingClientRect();
  const owner = card.querySelector<HTMLElement>(".chart-card-menu");
  showPop(content, owner ? owner.getBoundingClientRect() : rect, {
    owner, kind: "dialog", className: "settings-pop", align: owner ? "end" : "start",
    onClose: () => { if (selectedChartId === chartId) { selectedChartId = null; chartLayer.querySelectorAll(".chart-card.selected").forEach((node) => node.classList.remove("selected")); } },
  });
  openPop!.chartId = chartId; // showPop has just opened it
}
function chartCellLabel(row: number, column: number, sheetId: string = activeSheetId): string {
  const cell = model.cells[sheetId]?.[rcToRef(row, column)];
  if (!cell) return "";
  return displayValue(engine.computeRef(sheetId, rcToRef(row, column)), cell.fmt).text;
}
/** A chart's labels and number series (null for a blank or non-numeric point). */
interface ChartData { labels: string[]; series: { name: string; values: (number | null)[] }[] }
// A chart's labels and series, from its sheet (the active one unless given; print draws all).
function chartData(chart: Chart, sheetId: string = activeSheetId): ChartData | null {
  const range = parseChartRange(chart.range, model.sheets[sheetId]);
  if (!range || !rangeHasData(range, model.cells[sheetId] || {})) return null;
  const dataRow = range.r1 + (chart.firstRowHeaders && range.r2 > range.r1 ? 1 : 0);
  let seriesColumn = range.c1 + (chart.firstColLabels && range.c2 > range.c1 ? 1 : 0);
  if (seriesColumn > range.c2 || dataRow > range.r2) return null;
  const labels: string[] = [];
  for (let row = dataRow; row <= range.r2; row++) labels.push(chart.firstColLabels ? chartCellLabel(row, range.c1, sheetId) : String(row - dataRow + 1));
  const series: ChartData["series"] = [];
  for (let column = seriesColumn; column <= range.c2; column++) {
    const values: (number | null)[] = [];
    for (let row = dataRow; row <= range.r2; row++) {
      const value = engine.computeRef(sheetId, rcToRef(row, column));
      values.push(typeof value === "number" && Number.isFinite(value) ? value : null);
    }
    if (values.some((value) => value != null)) series.push({
      name: chart.firstRowHeaders ? (chartCellLabel(range.r1, column, sheetId) || colToLetter(column)) : colToLetter(column), values,
    });
  }
  return series.length ? { labels, series } : null;
}
function svgNode<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, text: string | null = null): SVGElementTagNameMap[K] {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  if (text != null) node.textContent = text;
  return node;
}
function renderLineChartSvg(chart: Chart, data: ChartData): SVGSVGElement {
  const svg = svgNode("svg", { viewBox: "0 0 520 270", role: "img", "aria-label": chart.title || "Line chart" });
  const left = 54, top = 18, right = chart.legend ? 118 : 24, bottom = 48;
  const width = 520 - left - right, height = 270 - top - bottom;
  // Folded rather than spread into Math.min/max: a range can hold more values than a call takes arguments.
  let low = Infinity, high = -Infinity;
  for (const series of data.series) for (const value of series.values) if (value != null) { low = Math.min(low, value); high = Math.max(high, value); }
  // An area is filled down to zero, so its axis always reaches zero.
  const area = chart.type === "area";
  const { min, max, ticks } = valueAxis(area ? Math.min(0, low) : low, area ? Math.max(0, high) : high);
  const y = (value: number) => top + height - (value - min) / (max - min) * height;
  const x = (index: number) => left + (data.labels.length <= 1 ? width / 2 : index / (data.labels.length - 1) * width);
  for (const value of ticks) {
    const yy = y(value);
    svg.appendChild(svgNode("line", { x1: left, y1: yy, x2: left + width, y2: yy, stroke: "#e4e4e1", "stroke-width": 1 }));
    svg.appendChild(svgNode("text", { x: left - 7, y: yy + 4, "text-anchor": "end", fill: "#77777f", "font-size": 10 }, fmtGeneral(value)));
  }
  svg.appendChild(svgNode("line", { x1: left, y1: top, x2: left, y2: top + height, stroke: "#9a9aa2" }));
  svg.appendChild(svgNode("line", { x1: left, y1: top + height, x2: left + width, y2: top + height, stroke: "#9a9aa2" }));
  const labelStep = Math.max(1, Math.ceil(data.labels.length / 7));
  data.labels.forEach((label, index) => { if (index % labelStep === 0 || index === data.labels.length - 1) svg.appendChild(svgNode("text", { x: x(index), y: top + height + 17, "text-anchor": "middle", fill: "#77777f", "font-size": 10 }, String(label).slice(0, 16))); });
  data.series.forEach((series, seriesIndex) => {
    const color = CHART_COLORS[seriesIndex % CHART_COLORS.length];
    const segments: { index: number; value: number }[][] = []; let segment: { index: number; value: number }[] = [];
    series.values.forEach((value, index) => {
      if (value == null) { if (segment.length) segments.push(segment); segment = []; }
      else segment.push({ index, value });
    });
    if (segment.length) segments.push(segment);
    const path = segments.map((points) => points.map((point, index) => (index ? "L " : "M ") + x(point.index).toFixed(2) + " " + y(point.value).toFixed(2)).join(" ")).join(" ");
    if (chart.type === "area") {
      const baseline = y(Math.max(min, Math.min(max, 0)));
      for (const points of segments) {
        const areaPath = `M ${x(points[0].index)} ${baseline} ` + points.map((point) => `L ${x(point.index)} ${y(point.value)}`).join(" ") + ` L ${x(points[points.length - 1].index)} ${baseline} Z`;
        svg.appendChild(svgNode("path", { d: areaPath, fill: color, opacity: .18 }));
      }
    }
    svg.appendChild(svgNode("path", { d: path, fill: "none", stroke: color, "stroke-width": 2.2, "stroke-linecap": "round", "stroke-linejoin": "round" }));
    // Past a few hundred points the markers would merge into the line.
    if (data.labels.length <= 300) series.values.forEach((value, index) => { if (value != null) svg.appendChild(svgNode("circle", { cx: x(index), cy: y(value), r: 2.5, fill: color })); });
    if (chart.legend) {
      const legendY = top + 10 + seriesIndex * 19;
      svg.appendChild(svgNode("line", { x1: left + width + 15, y1: legendY, x2: left + width + 31, y2: legendY, stroke: color, "stroke-width": 3 }));
      svg.appendChild(svgNode("text", { x: left + width + 37, y: legendY + 4, fill: "#55555d", "font-size": 10 }, series.name.slice(0, 15)));
    }
  });
  if (chart.xAxisTitle) svg.appendChild(svgNode("text", { x: left + width / 2, y: 266, "text-anchor": "middle", fill: "#55555d", "font-size": 11 }, chart.xAxisTitle));
  if (chart.yAxisTitle) { const title = svgNode("text", { x: 12, y: top + height / 2, "text-anchor": "middle", fill: "#55555d", "font-size": 11, transform: `rotate(-90 12 ${top + height / 2})` }, chart.yAxisTitle); svg.appendChild(title); }
  return svg;
}
function renderPieChartSvg(chart: Chart, data: ChartData): SVGSVGElement {
  const svg = svgNode("svg", { viewBox: "0 0 520 270", role: "img", "aria-label": chart.title || "Pie chart" });
  const series = data.series[0];
  const slices = series.values.map((value, index) => ({ value: value != null && value > 0 ? value : 0, label: data.labels[index] || String(index + 1) })).filter((slice) => slice.value > 0);
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  if (!total) return svg;
  const cx = chart.legend ? 175 : 260, cy = 135, radius = 100;
  let angle = -Math.PI / 2;
  slices.forEach((slice, index) => {
    const next = angle + slice.value / total * Math.PI * 2;
    const color = CHART_COLORS[index % CHART_COLORS.length];
    if (slices.length === 1) svg.appendChild(svgNode("circle", { cx, cy, r: radius, fill: color }));
    else {
      const x1 = cx + Math.cos(angle) * radius, y1 = cy + Math.sin(angle) * radius;
      const x2 = cx + Math.cos(next) * radius, y2 = cy + Math.sin(next) * radius;
      const large = next - angle > Math.PI ? 1 : 0;
      svg.appendChild(svgNode("path", { d: `M ${cx} ${cy} L ${x1} ${y1} A ${radius} ${radius} 0 ${large} 1 ${x2} ${y2} Z`, fill: color, stroke: "#fff", "stroke-width": 2 }));
    }
    if (chart.legend) {
      const ly = 35 + index * 22;
      svg.appendChild(svgNode("rect", { x: 310, y: ly - 9, width: 12, height: 12, rx: 2, fill: color }));
      svg.appendChild(svgNode("text", { x: 329, y: ly + 1, fill: "#55555d", "font-size": 11 }, `${slice.label}`.slice(0, 18)));
      svg.appendChild(svgNode("text", { x: 493, y: ly + 1, "text-anchor": "end", fill: "#77777f", "font-size": 10 }, `${Math.round(slice.value / total * 100)}%`));
    }
    angle = next;
  });
  return svg;
}
function renderStackedBarChartSvg(chart: Chart, data: ChartData): SVGSVGElement {
  const svg = svgNode("svg", { viewBox: "0 0 520 270", role: "img", "aria-label": chart.title || "Stacked bar chart" });
  const left = 78, top = 18, right = chart.legend ? 112 : 24, bottom = 42;
  const width = 520 - left - right, height = 270 - top - bottom;
  const totals = data.labels.map((_, index) => data.series.reduce((sum, series) => sum + Math.max(0, series.values[index] || 0), 0));
  const { max, ticks } = valueAxis(0, totals.reduce((most, total) => Math.max(most, total), 0));
  const rowHeight = height / Math.max(1, data.labels.length);
  for (const value of ticks) {
    const xx = left + width * value / max;
    svg.appendChild(svgNode("line", { x1: xx, y1: top, x2: xx, y2: top + height, stroke: "#e4e4e1" }));
    svg.appendChild(svgNode("text", { x: xx, y: top + height + 15, "text-anchor": "middle", fill: "#77777f", "font-size": 10 }, fmtGeneral(value)));
  }
  data.labels.forEach((label, row) => {
    const barY = top + row * rowHeight + rowHeight * .18, barHeight = Math.max(3, rowHeight * .64);
    svg.appendChild(svgNode("text", { x: left - 7, y: barY + barHeight / 2 + 4, "text-anchor": "end", fill: "#66666e", "font-size": 10 }, String(label).slice(0, 12)));
    let offset = 0;
    data.series.forEach((series, index) => {
      const value = Math.max(0, series.values[row] || 0), barWidth = value / max * width;
      svg.appendChild(svgNode("rect", { x: left + offset, y: barY, width: barWidth, height: barHeight, fill: CHART_COLORS[index % CHART_COLORS.length] }));
      offset += barWidth;
    });
  });
  if (chart.legend) data.series.forEach((series, index) => {
    const ly = top + 10 + index * 19, color = CHART_COLORS[index % CHART_COLORS.length];
    svg.appendChild(svgNode("rect", { x: left + width + 15, y: ly - 8, width: 12, height: 12, rx: 2, fill: color }));
    svg.appendChild(svgNode("text", { x: left + width + 33, y: ly + 2, fill: "#55555d", "font-size": 10 }, series.name.slice(0, 14)));
  });
  if (chart.xAxisTitle) svg.appendChild(svgNode("text", { x: left + width / 2, y: 268, "text-anchor": "middle", fill: "#55555d", "font-size": 11 }, chart.xAxisTitle));
  if (chart.yAxisTitle) svg.appendChild(svgNode("text", { x: 12, y: top + height / 2, "text-anchor": "middle", fill: "#55555d", "font-size": 11, transform: `rotate(-90 12 ${top + height / 2})` }, chart.yAxisTitle));
  return svg;
}
function renderChartSvg(chart: Chart, data: ChartData): SVGSVGElement {
  if (chart.type === "pie") return renderPieChartSvg(chart, data);
  if (chart.type === "stackedBar") return renderStackedBarChartSvg(chart, data);
  return renderLineChartSvg(chart, data);
}
function selectChart(chart: Chart, card: HTMLElement | null = null) {
  selectedChartId = chart.id;
  chartLayer.querySelectorAll(".chart-card.selected").forEach((element) => element.classList.remove("selected"));
  if (card) card.classList.add("selected");
}
// Dragging the title bar moves the chart; a click without movement opens its settings. The card
// is redrawn whenever someone else edits the sheet, so the drag's position is kept here.
let chartDrag: { id: string; x: number; y: number } | null = null;
function startChartDrag(chart: Chart, card: HTMLElement, event: PointerEvent) {
  if (event.button !== 0 || (event.target as Element).closest("button")) return;
  event.preventDefault(); event.stopPropagation();
  const wasOpen = openPop?.pop.classList.contains("settings-pop") && selectedChartId === chart.id;
  if (openPop) closePop(true);
  selectChart(chart, card);
  const startClientX = event.clientX, startClientY = event.clientY;
  const startX = chart.x ?? 96, startY = chart.y ?? 44;
  const drag = chartDrag = { id: chart.id, x: startX, y: startY };
  const move = (moveEvent: PointerEvent) => {
    // The server's bounds, so a drop doesn't jump when it echoes back.
    drag.x = Math.max(CHART_BOUNDS.minX, Math.min(CHART_BOUNDS.max, Math.round(startX + moveEvent.clientX - startClientX)));
    drag.y = Math.max(CHART_BOUNDS.minY, Math.min(CHART_BOUNDS.max, Math.round(startY + moveEvent.clientY - startClientY)));
    const shown = chartLayer.querySelector<HTMLElement>(`.chart-card[data-chart-id="${CSS.escape(chart.id)}"]`) ?? card;
    shown.style.left = drag.x + "px"; shown.style.top = drag.y + "px";
  };
  const up = () => {
    window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", up);
    if (chartDrag === drag) chartDrag = null;
    const current = sheetCharts().find((c) => c.id === chart.id);
    if (drag.x !== startX || drag.y !== startY) { if (current) { current.x = drag.x; current.y = drag.y; queueStructure(); } renderCharts(); }
    else if (!wasOpen) openChartMenu(chart.id);
  };
  window.addEventListener("pointermove", move); window.addEventListener("pointerup", up); window.addEventListener("pointercancel", up);
}
function chartClipboardSvg(chart: Chart): SVGSVGElement | null {
  const data = chartData(chart);
  if (!data) return null;
  const output = svgNode("svg", { xmlns: "http://www.w3.org/2000/svg", width: 560, height: 330, viewBox: "0 0 560 330" });
  output.appendChild(svgNode("rect", { x: 0, y: 0, width: 560, height: 330, fill: "#ffffff" }));
  output.appendChild(svgNode("text", { x: 20, y: 28, fill: "#1d1d20", "font-size": 18, "font-weight": 650, "font-family": "Arial, sans-serif" }, chart.title || chartTypeLabel(chart.type)));
  const group = svgNode("g", { transform: "translate(20 45)", "font-family": "Arial, sans-serif" });
  const graph = renderChartSvg(chart, data);
  for (const child of [...graph.childNodes]) group.appendChild(child.cloneNode(true));
  output.appendChild(group);
  return output;
}
function copyChartSvgSelection(svgMarkup: string): boolean {
  // The iframe's Permissions Policy blocks the asynchronous Clipboard API.
  // A selected rich-HTML image can still use the browser's synchronous copy
  // command and paste into Slides, PowerPoint, Keynote, and similar tools.
  const host = el("div", { contenteditable: "true", "aria-hidden": "true" });
  host.style.cssText = "position:fixed;left:-10000px;top:0;width:560px;height:330px;overflow:hidden;background:white";
  const image = el("img", {
    src: "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svgMarkup),
    width: "560", height: "330", alt: "Chart",
  });
  host.appendChild(image);
  document.body.appendChild(host);
  host.focus({ preventScroll: true });
  const selection = window.getSelection();
  if (!selection) { host.remove(); return false; }
  const saved = selection.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
  const range = document.createRange(); range.selectNode(image);
  selection.removeAllRanges(); selection.addRange(range);
  let copied = false;
  try { copied = document.execCommand("copy"); }
  catch (error) { const e = error as Error | null; console.error("Chart rich-copy failed:", e?.name || "Error", e?.message || String(error)); }
  selection.removeAllRanges(); if (saved) selection.addRange(saved);
  host.remove(); armEditorCapture(true);
  return copied;
}
function copyChartImage(chart: Chart) {
  const svg = chartClipboardSvg(chart);
  if (!svg) { setStatus("bad", "Chart has no data"); return; }
  const markup = new XMLSerializer().serializeToString(svg);
  if (copyChartSvgSelection(markup)) setStatus("saved", "Chart SVG copied");
  else setStatus("bad", "Browser blocked chart copy");
}
function renderCharts() {
  if (!curSheet()) return;
  chartLayer.replaceChildren();
  let maxX = gridScroll.clientWidth, maxY = gridScroll.clientHeight;
  for (const chart of sheetCharts()) {
    const card = el("div", { class: "chart-card" + (chart.id === selectedChartId ? " selected" : "") + (chart.id === newChartId ? " chart-new" : ""), "data-chart-id": chart.id });
    if (chart.id === newChartId) newChartId = null;
    const at = chartDrag?.id === chart.id ? chartDrag : { x: chart.x ?? 96, y: chart.y ?? 44 };
    card.style.cssText += `left:${at.x}px;top:${at.y}px;width:${chart.width ?? 520}px;height:${chart.height ?? 320}px`;
    const menuButton = el("button", { class: "chart-card-menu", type: "button", "aria-label": "Chart settings", html: svg(ICONS.more, 16) });
    attachTip(menuButton, "Chart settings");
    // A redraw while this chart's settings are open hands the pop to the new button.
    if (openPop?.chartId === chart.id) { openPop.owner = menuButton; menuButton.classList.add("open"); }
    menuButton.addEventListener("pointerdown", (event) => event.stopPropagation());
    menuButton.addEventListener("mousedown", (event) => event.stopPropagation());
    menuButton.addEventListener("click", (event) => {
      event.stopPropagation();
      if (openPop?.owner === menuButton) { closePop(); return; }
      selectChart(chart, card); openChartMenu(chart.id);
    });
    const head = el("div", { class: "chart-card-head" }, [
      el("strong", {}, chart.title || chartTypeLabel(chart.type)), el("span", { class: "chart-card-range" }, chart.range || "No data range"), menuButton,
    ]);
    attachTip(head, "Drag to move · click for settings");
    head.addEventListener("pointerdown", (event) => startChartDrag(chart, card, event));
    const body = el("div", { class: "chart-card-body" });
    const data = chartData(chart);
    if (data) body.appendChild(renderChartSvg(chart, data));
    else body.appendChild(el("div", { class: "chart-empty" }, "Choose a data range in this chart's settings."));
    // pointerdown comes before the outside-click handler closes an open pop, so a click on
    // the chart whose settings are showing closes them instead of reopening.
    let settingsWereOpen = false;
    body.addEventListener("pointerdown", () => { settingsWereOpen = !!openPop && openPop.pop.classList.contains("settings-pop") && selectedChartId === chart.id; });
    body.addEventListener("click", () => { if (!settingsWereOpen) openChartMenu(chart.id); });
    card.append(head, body);
    card.addEventListener("mousedown", (event) => { event.stopPropagation(); if (selectedChartId !== chart.id) selectChart(chart, card); });
    chartLayer.appendChild(card);
    maxX = Math.max(maxX, (chart.x ?? 96) + (chart.width ?? 520) + 30);
    maxY = Math.max(maxY, (chart.y ?? 44) + (chart.height ?? 320) + 30);
  }
  chartLayer.style.width = maxX + "px"; chartLayer.style.height = maxY + "px";
}

// ===========================================================================
// Filter rows
// ===========================================================================
function filterToken(value: Scalar): string {
  if (isErr(value)) return "e:" + value.value;
  if (value == null || value === "") return "z:";
  if (typeof value === "number") return "n:" + String(value);
  if (typeof value === "boolean") return "b:" + (value ? "1" : "0");
  return "s:" + String(value);
}
function filterColumns(filter: SheetFilter | null | undefined): number[] {
  return filter?.columns?.length ? filter.columns : Array.from({ length: curSheet().cols }, (_, column) => column);
}
function rowPassesFilter(row: number, sheetId: string = activeSheetId): boolean {
  const sheet = model.sheets[sheetId], filter = sheet?.filter;
  if (!filter || row <= filter.row || row > (filter.endRow ?? sheet.rows - 1)) return true;
  for (const [column, selected] of filterCriteriaSets(filter)) {
    const token = filterToken(engine.computeRef(sheetId, rcToRef(row, column)));
    if (!selected.has(token)) return false;
  }
  return true;
}
// A filter's chosen values as Sets (a column can have thousands of distinct values, and every
// row is tested), built once per criteria object.
const criteriaSetCache = new WeakMap<SheetFilter["criteria"], [number, Set<string>][]>();
function filterCriteriaSets(filter: SheetFilter): [number, Set<string>][] {
  const criteria = filter.criteria || {};
  let sets = criteriaSetCache.get(criteria);
  if (!sets) {
    sets = Object.entries(criteria).filter(([, selected]) => selected?.length).map(([column, selected]): [number, Set<string>] => [Number(column), new Set(selected)]);
    criteriaSetCache.set(criteria, sets);
  }
  return sets;
}
function hasCellData(row: number, column: number): boolean {
  const value = cellRaw(rcToRef(row, column));
  return value != null && value !== "";
}
function detectFilterRange(): SheetFilter | null {
  const sheet = curSheet();
  const selection = selRange();
  const explicit = selection.r2 > selection.r1;
  if (explicit) {
    const columns: number[] = [];
    for (let column = selection.c1; column <= selection.c2; column++) {
      let populated = false;
      for (let row = selection.r1; row <= selection.r2; row++) if (hasCellData(row, column)) { populated = true; break; }
      if (populated) columns.push(column);
    }
    return columns.length && selection.r2 > selection.r1
      ? { row: selection.r1, endRow: selection.r2, columns, criteria: {}, rowOrder: Array.from({ length: selection.r2 - selection.r1 }, (_, index) => selection.r1 + 1 + index), sort: null }
      : null;
  }

  let minRow = sheet.rows, maxRow = -1, minColumn = sheet.cols, maxColumn = -1;
  for (const [ref, cell] of Object.entries(curCells())) {
    if (cell.value == null || cell.value === "") continue;
    const position = parseRef(ref);
    if (!position || position.r >= sheet.rows || position.c >= sheet.cols) continue;
    minRow = Math.min(minRow, position.r); maxRow = Math.max(maxRow, position.r);
    minColumn = Math.min(minColumn, position.c); maxColumn = Math.max(maxColumn, position.c);
  }
  if (maxRow <= minRow || maxColumn < minColumn) return null;

  // Prefer the contiguous table around the active cell when a sheet contains
  // several independent tables. Fully blank rows/columns act as boundaries.
  if (focus.r >= minRow && focus.r <= maxRow && focus.c >= minColumn && focus.c <= maxColumn && hasCellData(focus.r, focus.c)) {
    const rowHasData = (row: number) => {
      for (let column = minColumn; column <= maxColumn; column++) if (hasCellData(row, column)) return true;
      return false;
    };
    let tableTop = focus.r, tableBottom = focus.r;
    while (tableTop > minRow && rowHasData(tableTop - 1)) tableTop--;
    while (tableBottom < maxRow && rowHasData(tableBottom + 1)) tableBottom++;
    const columnHasData = (column: number) => {
      for (let row = tableTop; row <= tableBottom; row++) if (hasCellData(row, column)) return true;
      return false;
    };
    let tableLeft = focus.c, tableRight = focus.c;
    while (tableLeft > minColumn && columnHasData(tableLeft - 1)) tableLeft--;
    while (tableRight < maxColumn && columnHasData(tableRight + 1)) tableRight++;
    minRow = tableTop; maxRow = tableBottom; minColumn = tableLeft; maxColumn = tableRight;
  }

  let best: { row: number; score: number } | null = null;
  const lastCandidate = Math.min(maxRow - 1, minRow + 12);
  for (let row = minRow; row <= lastCandidate; row++) {
    let headerCells = 0, supportedColumns = 0;
    for (let column = minColumn; column <= maxColumn; column++) {
      if (hasCellData(row, column)) headerCells++;
      let hasBelow = false;
      for (let dataRow = row + 1; dataRow <= maxRow; dataRow++) if (hasCellData(dataRow, column)) { hasBelow = true; break; }
      if (hasBelow) supportedColumns++;
    }
    if (!headerCells || !supportedColumns) continue;
    const score = headerCells * 5 + supportedColumns * 3 - (row - minRow) * 2;
    if (!best || score > best.score) best = { row, score };
  }
  if (!best) return null;
  const header = best;
  const columns: number[] = [];
  for (let column = minColumn; column <= maxColumn; column++) {
    let populated = false;
    for (let row = best.row; row <= maxRow; row++) if (hasCellData(row, column)) { populated = true; break; }
    if (populated) columns.push(column);
  }
  return columns.length ? { row: best.row, endRow: maxRow, columns, criteria: {}, rowOrder: Array.from({ length: maxRow - best.row }, (_, index) => header.row + 1 + index), sort: null } : null;
}
function resetFilterSortBaseline() {
  const filter = curSheet()?.filter;
  if (!filter) return;
  const endRow = filter.endRow ?? curSheet().rows - 1;
  filter.rowOrder = Array.from({ length: Math.max(0, endRow - filter.row) }, (_, index) => filter.row + 1 + index);
  filter.sort = null;
}
function toggleFilterRow() {
  const sheet = curSheet();
  if (!sheet) return;
  if (sheet.filter) sheet.filter = null;
  else {
    const detected = detectFilterRange();
    if (!detected) { setStatus("bad", "Select data with a header row"); return; }
    sheet.filter = detected;
  }
  queueStructure();
  renderGrid();
  refreshToolbarState();
}
/** One table row as a filter sort moves it: its cells by column, where it began, and where it is. */
interface FilterRow { rowCells: Record<number, Cell>; originalOrder: number; currentRow: number }
function reorderFilteredRows(compare: (left: FilterRow, right: FilterRow) => number, nextSort: FilterSort | null) {
  const filter = curSheet()?.filter;
  if (!filter) return;
  const columns = filterColumns(filter);
  const rows: FilterRow[] = [];
  const endRow = filter.endRow ?? curSheet().rows - 1;
  const baseline = filter.rowOrder?.length === endRow - filter.row
    ? filter.rowOrder
    : Array.from({ length: endRow - filter.row }, (_, index) => filter.row + 1 + index);
  for (let row = filter.row + 1; row <= endRow; row++) {
    const rowCells: Record<number, Cell> = {};
    for (const col of columns) {
      const cell = getCell(rcToRef(row, col));
      if (cell) rowCells[col] = { ...cell };
    }
    rows.push({ rowCells, originalOrder: baseline[row - filter.row - 1], currentRow: row });
  }
  rows.sort(compare);
  for (let index = 0; index < rows.length; index++) {
    const row = filter.row + 1 + index;
    for (const col of columns) {
      const ref = rcToRef(row, col), source = rows[index].rowCells[col];
      // Rows move as in Excel's sort: relative references travel with the formula.
      if (source) curCells()[ref] = { value: shiftedCopyFormula(source.value, rcToRef(rows[index].currentRow, col), ref, false), fmt: source.fmt, version: getCell(ref)?.version || 0 };
      else delete curCells()[ref];
    }
  }
  filter.rowOrder = rows.map((entry) => entry.originalOrder);
  filter.sort = nextSort;
  queueStructure(); queueReplacement(activeSheetId); rebuildEngine(); renderGrid();
  undoStack.length = 0; redoStack.length = 0; updateUndoButtons();
  schedulePivotRefreshes();
}
function sortFilteredRange(column: number, ascending: boolean) {
  const values = new Map<number, Scalar>();
  const filter = curSheet()?.filter;
  if (!filter) return;
  for (let row = filter.row + 1; row <= (filter.endRow ?? curSheet().rows - 1); row++) values.set(row, engine.computeRef(activeSheetId, rcToRef(row, column)));
  const key = (row: number) => { const v = values.get(row) as Scalar; /* every filtered row was read above */ return v instanceof HyperlinkValue ? v.label : v; };
  reorderFilteredRows((left, right) => compareSortValues(key(left.currentRow), key(right.currentRow), ascending), { column, direction: ascending ? "asc" : "desc" });
}
function clearFilteredSort() {
  reorderFilteredRows((left, right) => left.originalOrder - right.originalOrder, null);
}
function openFilterMenu(column: number, trigger: HTMLElement) {
  const filter = curSheet()?.filter;
  if (!filter) return;
  // Each value is listed as its first cell shows it (a date as a date), in sort order.
  const options = new Map<string, { label: string; value: Scalar }>();
  for (let row = filter.row + 1; row <= (filter.endRow ?? curSheet().rows - 1); row++) {
    const ref = rcToRef(row, column), value = engine.computeRef(activeSheetId, ref);
    const token = filterToken(value);
    if (!options.has(token)) options.set(token, { label: token === "z:" ? "(Blanks)" : displayValue(value, getCell(ref)?.fmt).text, value });
  }
  const sorted = [...options.entries()].sort((a, b) => compareSortValues(a[1].value, b[1].value, true)).map(([token, option]) => [token, option.label] as const);
  const current = filter.criteria?.[column] || [];
  const allSelected = !current.length;
  const menu: (HTMLElement | null)[] = [];
  menu.push(el("div", { class: "mhead" }, `Column ${colToLetter(column)}`));
  const sortedBy = filter.sort?.column === column ? filter.sort.direction : null;
  menu.push(el("div", { class: "filter-sort" }, [
    menuItem({ icon: "sortAsc", label: "Sort A → Z", checked: sortedBy === "asc", checkSlot: true, onSelect: () => sortFilteredRange(column, true) }),
    menuItem({ icon: "sortDesc", label: "Sort Z → A", checked: sortedBy === "desc", checkSlot: true, onSelect: () => sortFilteredRange(column, false) }),
    menuItem({ icon: "clear", label: "Original order", disabled: !filter.sort, checkSlot: true, onSelect: () => clearFilteredSort() }),
  ]));
  menu.push(el("div", { class: "msep" }));
  const list = el("div", { class: "filter-options" });
  const checks: { token: string; label: string; checkbox: HTMLInputElement; option: HTMLLabelElement }[] = [];
  if (!sorted.length) list.appendChild(el("div", { class: "filter-empty" }, "No values below this row"));
  for (const [token, label] of sorted) {
    const checkbox = el("input", { type: "checkbox" });
    checkbox.checked = allSelected || current.includes(token);
    const option = el("label", { class: "filter-option", title: label }, [checkbox, el("span", {}, label)]);
    checks.push({ token, label, checkbox, option });
    list.appendChild(option);
  }
  const selectAll = el("button", {}, `Select all ${checks.length}`);
  const selectNone = el("button", {}, "Clear");
  selectAll.addEventListener("click", () => checks.forEach((entry) => { entry.checkbox.checked = true; }));
  selectNone.addEventListener("click", () => checks.forEach((entry) => { entry.checkbox.checked = false; }));
  const search = el("input", { class: "filter-search", type: "search", placeholder: "Search values", "aria-label": "Search filter values" });
  search.addEventListener("input", () => {
    const query = search.value.trim().toLowerCase();
    for (const entry of checks) entry.option.style.display = !query || entry.label.toLowerCase().includes(query) ? "" : "none";
  });
  search.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); apply.click(); } });
  if (checks.length > 6) menu.push(el("div", { class: "filter-search-row" }, [el("span", { html: svg(ICONS.search, 15) }), search]));
  if (checks.length > 1) menu.push(el("div", { class: "filter-links" }, [selectAll, selectNone]));
  menu.push(list);
  const clear = el("button", { type: "button" }, "Reset");
  const apply = el("button", { type: "button", class: "primary" }, "Apply");
  // The filter may have been replaced by a collaborator while the menu was open, so it's read
  // when a button is clicked rather than when the menu opened.
  const liveFilter = () => curSheet()?.filter;
  clear.addEventListener("click", () => {
    const now = liveFilter(); closePop();
    if (!now) return;
    // A new criteria object (never edited in place: rowPassesFilter caches by it).
    const next = { ...now.criteria }; delete next[column]; now.criteria = next;
    queueStructure(); renderGrid(); refreshToolbarState();
  });
  apply.addEventListener("click", () => {
    const now = liveFilter();
    if (!now) { closePop(); return; }
    const selected = checks.filter((entry) => entry.checkbox.checked).map((entry) => entry.token);
    // The server drops a column's selection outright past this size, so it's refused here
    // instead of silently changing.
    if (selected.length !== checks.length && selected.length > MAX_FILTER_SELECTIONS) {
      toast(`Select at most ${MAX_FILTER_SELECTIONS} values, or deselect fewer values instead`, "bad"); return;
    }
    if (selected.length !== checks.length && selected.some((token) => token.length > 8194)) {
      toast("Selected filter values are limited to 8,192 characters", "bad"); return;
    }
    closePop();
    const next = { ...now.criteria };
    if (selected.length === checks.length) delete next[column];
    else next[column] = selected.length ? selected : ["x:__none__"];
    now.criteria = next;
    queueStructure(); renderGrid(); refreshToolbarState();
  });
  menu.push(el("div", { class: "filter-actions" }, [current.length ? clear : null, el("span", { class: "grow" }), apply]));
  showPop(menu, trigger.getBoundingClientRect(), { owner: trigger, kind: "dialog", className: "filter-menu", onClose: () => gridScroll.focus({ preventScroll: true }) });
  if (checks.length > 6 && !coarsePointer) search.focus({ preventScroll: true });
}

// ===========================================================================
// Grid rendering
// ===========================================================================
let renderScheduled = false;
function renderGrid() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => { if (!renderScheduled) return; renderScheduled = false; doRenderGrid(); });
}
// Draws a pending render now. Scrolling needs the table at the size of the sheet now on
// screen: set against the previous sheet's (smaller) table, a scroll position would be clipped.
function flushRender() {
  if (renderScheduled || !win || win.sheetId !== activeSheetId) { renderScheduled = false; if (curSheet()) doRenderGrid(); }
}

// ── Layout: where every row and column sits, without asking the DOM ─────────
// Only the rows and columns near the viewport are in the DOM (renderWindow), so positions come
// from prefix sums instead of from cells. Rows hidden by the filter take no space. Coordinates
// are the scroller's content box: (0, 0) is the table's top-left corner, under the sticky
// headers, so a cell's box here equals its td's offsetLeft/offsetTop when it's rendered.
/**
 * Where every row and column of the sheet on screen sits: `rowH` each row's height (0 when a
 * filter hides it), `rowTop` / `colLeft` prefix sums (length rows + 1 / cols + 1), and `headH`
 * the column-header height as last measured.
 */
interface Layout {
  sheetId: string;
  rows: number;
  cols: number;
  rowH: Float64Array;
  rowTop: Float64Array;
  colLeft: Float64Array;
  headH: number;
}
let layout: Layout | null = null;
// Rows rendered taller than their set height (wrapped text): sheetId -> { rows, heights: Map }.
const measuredRowHeights = new Map<string, { rows: number; heights: Map<number, number> }>();
function measuredHeights(sheetId: string, create: true): Map<number, number>;
function measuredHeights(sheetId: string, create?: boolean): Map<number, number> | null;
function measuredHeights(sheetId: string, create = false): Map<number, number> | null {
  const rows = model.sheets[sheetId]?.rows ?? 0;
  let entry = measuredRowHeights.get(sheetId);
  if (entry && entry.rows !== rows) { measuredRowHeights.delete(sheetId); entry = undefined; }
  if (!entry && create) { entry = { rows, heights: new Map() }; measuredRowHeights.set(sheetId, entry); }
  return entry?.heights || null;
}
function buildLayout(): Layout {
  const sh = curSheet();
  const rows = sh.rows, cols = sh.cols, heights = measuredHeights(activeSheetId);
  const rowH = new Float64Array(rows), rowTop = new Float64Array(rows + 1), colLeft = new Float64Array(cols + 1);
  const filtered = !!sh.filter;
  for (let r = 0; r < rows; r++) {
    rowH[r] = filtered && !rowPassesFilter(r) ? 0 : (heights?.get(r) ?? rowHeight(r));
    rowTop[r + 1] = rowTop[r] + rowH[r];
  }
  for (let c = 0; c < cols; c++) colLeft[c + 1] = colLeft[c] + colWidth(c);
  layout = { sheetId: activeSheetId, rows, cols, rowH, rowTop, colLeft, headH: layout?.headH || 24 };
  return layout;
}
// The layout of the sheet on screen, rebuilt if the sheet or its size changed since it was made.
function geo(): Layout {
  const sh = curSheet();
  if (!layout || layout.sheetId !== activeSheetId || layout.rows !== sh.rows || layout.cols !== sh.cols) return buildLayout();
  return layout;
}
// Only called while a layout exists (after a render).
function sumRowsFrom(r: number) { const L = layout!; for (let i = Math.max(0, r); i < L.rows; i++) L.rowTop[i + 1] = L.rowTop[i] + L.rowH[i]; }
function sumColsFrom(c: number) { const L = layout!; for (let i = Math.max(0, c); i < L.cols; i++) L.colLeft[i + 1] = L.colLeft[i] + colWidth(i); }
function rowY(r: number): number { const L = geo(); return L.headH + L.rowTop[clamp(r, 0, L.rows)]; }
function colX(c: number): number { const L = geo(); return HEAD_W + L.colLeft[clamp(c, 0, L.cols)]; }
function rowHidden(r: number): boolean { const L = geo(); return r < 0 || r >= L.rows || !L.rowH[r]; }
/** A box in the scroller's content coordinates. */
interface Box { left: number; top: number; width: number; height: number }
function rangeRect(r1: number, c1: number, r2: number, c2: number): Box {
  const left = colX(c1), top = rowY(r1);
  return { left, top, width: colX(c2 + 1) - left, height: rowY(r2 + 1) - top };
}
function cellRect(r: number, c: number): Box { return rangeRect(r, c, r, c); }
// Largest index i in [0, n) with arr[i] <= v (arr non-decreasing).
function lastAtOrBelow(arr: Float64Array, n: number, v: number): number {
  let lo = 0, hi = n - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (arr[mid] <= v) lo = mid; else hi = mid - 1; }
  return lo;
}
// The row at a vertical offset into the body (0 = top of row 1), skipping rows hidden there.
function rowAtBody(y: number): number {
  const L = geo(); if (!L.rows) return 0;
  let r = lastAtOrBelow(L.rowTop, L.rows, y);
  while (r > 0 && !L.rowH[r]) r--;
  return r;
}
function colAtBody(x: number): number { const L = geo(); return L.cols ? lastAtOrBelow(L.colLeft, L.cols, x) : 0; }
function nextVisibleRow(r: number): number { const L = geo(); while (r < L.rows && !L.rowH[r]) r++; return r; }

// ── The rendered window ──────────────────────────────────────────────────────
// The table holds the rows and columns around the viewport; spacers stand in for the rest, so
// the scrollbars and every position are those of the whole sheet. Scrolling past what's drawn
// redraws the window (within the same frame). A 50,000-row sheet costs what its visible part does.
/** The rows and columns the table draws (inclusive). */
interface WindowSpan { r0: number; r1: number; c0: number; c1: number }
/** What the table currently shows: a window of one sheet. */
interface RenderWindow extends WindowSpan { sheetId: string }
let win: RenderWindow | null = null; // { sheetId, r0, r1, c0, c1 }: what the table currently shows
const renderedCells = new Map<number, HTMLTableCellElement>(); // (r << 10) | c -> td
const renderedRows = new Map<number, HTMLTableRowElement>(), renderedCols = new Map<number, HTMLTableColElement>(), renderedColHeads = new Map<number, HTMLTableCellElement>(), renderedRowHeads = new Map<number, HTMLTableCellElement>();
/** The spacers standing in for what the window leaves out, when there are any. */
interface WindowSpacers { leftCol?: HTMLTableColElement; rightCol?: HTMLTableColElement; topRow?: HTMLTableRowElement; bottomRow?: HTMLTableRowElement }
let winEls: WindowSpacers = {};
const cellKeyOf = (r: number, c: number) => (r << 10) | c;
function cellEl(r: number, c: number): HTMLTableCellElement | null { return win && win.sheetId === activeSheetId ? renderedCells.get(cellKeyOf(r, c)) || null : null; }
// The visible part of the body, in body coordinates (under the sticky headers).
function viewportBody(): { top: number; bottom: number; left: number; right: number } {
  const L = geo();
  const top = gridScroll.scrollTop, left = gridScroll.scrollLeft;
  return { top, bottom: top + Math.max(0, gridScroll.clientHeight - L.headH), left, right: left + Math.max(0, gridScroll.clientWidth - HEAD_W) };
}
function wantedWindow(): WindowSpan {
  const L = geo(), v = viewportBody();
  const oy = Math.max(240, (v.bottom - v.top) * 0.6), ox = Math.max(320, (v.right - v.left) * 0.5);
  const r0 = rowAtBody(v.top - oy), r1 = Math.max(r0, rowAtBody(v.bottom + oy));
  let c0 = colAtBody(v.left - ox);
  const c1 = Math.max(c0, colAtBody(v.right + ox));
  // Text from a cell left of the window can flow into it: that cell is drawn too.
  if (c0 > 0) c0 = overflowSourceColumn(r0, r1, c0);
  return { r0, r1: Math.min(L.rows - 1, r1), c0, c1: Math.min(L.cols - 1, c1) };
}
// Redraw only when the viewport (with a small margin) has reached the edge of what's drawn.
function windowStale(): boolean {
  if (!win || win.sheetId !== activeSheetId || !layout) return true;
  const L = layout, v = viewportBody(), my = 60, mx = 80;
  const r0 = rowAtBody(v.top - my), r1 = rowAtBody(v.bottom + my), c0 = colAtBody(v.left - mx), c1 = colAtBody(v.right + mx);
  return (r0 < win.r0 && win.r0 > 0) || (r1 > win.r1 && win.r1 < L.rows - 1) || (c0 < win.c0 && win.c0 > 0) || (c1 > win.c1 && win.c1 < L.cols - 1);
}
let windowScheduled = false;
function scheduleWindow() {
  if (windowScheduled || renderScheduled) return;
  windowScheduled = true;
  requestAnimationFrame(() => { windowScheduled = false; if (!renderScheduled && curSheet()) { renderWindow(); afterWindowRender(); } });
}
gridScroll.addEventListener("scroll", () => { if (curSheet() && windowStale()) scheduleWindow(); }, { passive: true });
if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => { if (curSheet() && windowStale()) scheduleWindow(); }).observe(gridScroll);

function doRenderGrid() {
  const sh = curSheet();
  if (!sh) return;
  buildLayout();
  renderWindow();
  renderCharts();
  afterWindowRender();
}
// Everything drawn over the cells follows the newly drawn window.
function afterWindowRender() {
  markMovableHeaders();
  positionActiveOverlays();
  if (formulaPick || editingFormula()) renderFormulaPickHighlight();
  if (fillDrag) decorateFillPreview();
  decorateFind();
  if (!editing && cellEditor.classList.contains("capture")) armEditorCapture(false);
  if (editing && !editingAway()) placeCellEditor();
}

function renderWindow() {
  const sh = curSheet(), L = geo();
  const w = wantedWindow();
  renderedCells.clear(); renderedRows.clear(); renderedCols.clear(); renderedColHeads.clear(); renderedRowHeads.clear();
  const frag = document.createDocumentFragment();
  const leftW = L.colLeft[w.c0], rightW = L.colLeft[L.cols] - L.colLeft[w.c1 + 1];
  const span = 1 + Number(leftW > 0) + (w.c1 - w.c0 + 1) + Number(rightW > 0);
  winEls = {};

  // Column widths, with one spacer column for each side that isn't drawn.
  const colgroup = el("colgroup");
  colgroup.appendChild(el("col", { style: `width:${HEAD_W}px` }));
  if (leftW > 0) colgroup.appendChild(winEls.leftCol = el("col", { style: `width:${leftW}px` }));
  for (let c = w.c0; c <= w.c1; c++) { const col = el("col", { style: `width:${colWidth(c)}px` }); renderedCols.set(c, col); colgroup.appendChild(col); }
  if (rightW > 0) colgroup.appendChild(winEls.rightCol = el("col", { style: `width:${rightW}px` }));
  frag.appendChild(colgroup);
  // Pinned to the sheet's full width, so columns keep their size and the grid scrolls sideways
  // instead of squeezing them as the window narrows.
  gridTable.style.width = HEAD_W + L.colLeft[L.cols] + "px";
  gridTable.setAttribute("aria-rowcount", String(L.rows + 1));
  gridTable.setAttribute("aria-colcount", String(L.cols + 1));

  const thead = el("thead");
  const hr = el("tr", { role: "row", "aria-rowindex": "1" });
  hr.appendChild(el("th", { class: "corner", role: "columnheader", "aria-colindex": "1" }));
  if (leftW > 0) hr.appendChild(el("th", { class: "head-space", "aria-hidden": "true" }));
  for (let c = w.c0; c <= w.c1; c++) {
    const th = el("th", { class: "colhead", "data-col": c, role: "columnheader", "aria-colindex": String(c + 2) }, colToLetter(c));
    th.appendChild(el("div", { class: "col-resize", "data-col": c }));
    renderedColHeads.set(c, th); hr.appendChild(th);
  }
  if (rightW > 0) hr.appendChild(el("th", { class: "head-space", "aria-hidden": "true" }));
  thead.appendChild(hr);
  frag.appendChild(thead);

  const tbody = el("tbody");
  const spacerRow = (height: number) => el("tr", { class: "row-space", "aria-hidden": "true", style: `height:${height}px` }, [
    el("th", { class: "row-space-head" }), el("td", { colspan: String(span - 1) }),
  ]);
  const topH = L.rowTop[w.r0], bottomH = L.rowTop[L.rows] - L.rowTop[w.r1 + 1];
  if (topH > 0) tbody.appendChild(winEls.topRow = spacerRow(topH));
  for (let r = w.r0; r <= w.r1; r++) {
    if (!L.rowH[r]) continue; // hidden by the filter
    const isFilterRow = sh.filter?.row === r;
    const tr = el("tr", { class: isFilterRow ? "filter-row" : "", style: `height:${rowHeight(r)}px`, role: "row", "aria-rowindex": String(r + 2) });
    const rh = el("th", { class: "rowhead", "data-row": r, role: "rowheader", "aria-colindex": "1", title: isFilterRow ? "Filter header row" : "" }, String(r + 1));
    rh.appendChild(el("div", { class: "row-resize", "data-row": r }));
    renderedRowHeads.set(r, rh); tr.appendChild(rh);
    if (leftW > 0) tr.appendChild(el("td", { class: "col-space", "aria-hidden": "true" }));
    for (let c = w.c0; c <= w.c1; c++) {
      const td = renderCell(rcToRef(r, c), r, c);
      td.setAttribute("role", "gridcell"); td.setAttribute("aria-colindex", String(c + 2));
      renderedCells.set(cellKeyOf(r, c), td);
      tr.appendChild(td);
    }
    if (rightW > 0) tr.appendChild(el("td", { class: "col-space", "aria-hidden": "true" }));
    renderedRows.set(r, tr);
    tbody.appendChild(tr);
  }
  if (bottomH > 0) tbody.appendChild(winEls.bottomRow = spacerRow(bottomH));
  frag.appendChild(tbody);

  gridTable.replaceChildren(frag);
  win = { sheetId: activeSheetId, ...w };
  decorateSelection();
  measureWindow();
}
// Rows drawn taller than the layout assumed (wrapped text) are remembered, so positions below
// them are right. If such rows sit above what's in view, the view is kept where it was.
function measureWindow() {
  const L = layout!; // just built by renderWindow
  L.headH = gridTable.tHead?.offsetHeight || L.headH;
  const viewTop = gridScroll.scrollTop;
  let shiftAbove = 0, first = -1;
  for (const [r, tr] of renderedRows) {
    const actual = tr.offsetHeight, expected = L.rowH[r];
    if (!actual || Math.abs(actual - expected) < 0.5) continue;
    const heights = measuredHeights(activeSheetId, true);
    if (Math.abs(actual - rowHeight(r)) < 0.5) heights.delete(r); else heights.set(r, actual);
    if (L.rowTop[r + 1] <= viewTop) shiftAbove += actual - expected;
    L.rowH[r] = actual;
    if (first < 0) first = r;
  }
  if (first < 0) return;
  sumRowsFrom(first);
  // The spacer above the window doesn't change (only drawn rows were measured); the one below
  // keeps its height too, since it stands for rows after the window.
  if (shiftAbove) gridScroll.scrollTop = viewTop + shiftAbove;
}
// Spacer sizes after a column or row was resized in place.
function syncSpacers() {
  if (!win || !layout) return;
  const L = layout;
  if (winEls.leftCol) winEls.leftCol.style.width = L.colLeft[win.c0] + "px";
  if (winEls.rightCol) winEls.rightCol.style.width = L.colLeft[L.cols] - L.colLeft[win.c1 + 1] + "px";
  if (winEls.topRow) winEls.topRow.style.height = L.rowTop[win.r0] + "px";
  if (winEls.bottomRow) winEls.bottomRow.style.height = L.rowTop[L.rows] - L.rowTop[win.r1 + 1] + "px";
  gridTable.style.width = HEAD_W + L.colLeft[L.cols] + "px";
}

function isVisuallyEmptyCell(row: number, column: number): boolean {
  const cell = getCell(rcToRef(row, column));
  if (!cell || cell.value == null || cell.value === "") return true;
  const value = engine.computeRef(activeSheetId, rcToRef(row, column));
  return displayValue(value, cell.fmt).text === "";
}
// How wide a cell's text is drawn, measured with canvas (cached).
const textMeasureCanvas = document.createElement("canvas").getContext("2d");
const textWidthCache = new Map<string, number>();
let cellFontFamily: string | null = null;
function cellTextWidth(text: string, fmt: CellFmt | null | undefined): number {
  if (!textMeasureCanvas) return String(text).length * (fmt?.fs || 13) * 0.62;
  cellFontFamily ||= getComputedStyle(document.body).fontFamily;
  const font = `${fmt?.i ? "italic " : ""}${fmt?.b ? 700 : 400} ${fmt?.fs || 13}px ${cellFontFamily}`;
  const key = font + "\u0000" + text;
  let width = textWidthCache.get(key);
  if (width === undefined) {
    if (textWidthCache.size > 20000) textWidthCache.clear();
    textMeasureCanvas.font = font;
    width = textMeasureCanvas.measureText(String(text).replace(/\n/g, " ")).width;
    textWidthCache.set(key, width);
  }
  return width;
}
// Text that may flow into empty neighbours: left-aligned, unwrapped, not a number, error or
// filter header. Returns the room it needs (text plus padding), or 0.
function overflowNeed(row: number, disp: Display, fmt: CellFmt | null | undefined): number {
  if (!disp.text || disp.numeric || disp.err || disp.center || fmt?.wrap || (fmt?.a && fmt.a !== "l") || curSheet()?.filter?.row === row) return 0;
  return cellTextWidth(disp.text, fmt) + 12;
}
// Room for a cell's text: its own width plus the empty cells to its right, up to `need`.
function availableOverflowWidth(row: number, column: number, need = Infinity): number {
  let width = colWidth(column);
  for (let next = column + 1; next < curSheet().cols && width < need; next++) {
    if (!isVisuallyEmptyCell(row, next)) break;
    width += colWidth(next);
  }
  return width;
}
// The leftmost column (≥ about 2,000px back) whose text flows into column `c0` in rows r0…r1.
function overflowSourceColumn(r0: number, r1: number, c0: number): number {
  const L = geo();
  let start = c0;
  for (let r = r0; r <= r1; r++) {
    if (!L.rowH[r]) continue;
    for (let c = c0 - 1; c >= 0 && L.colLeft[c0] - L.colLeft[c] < 2000; c--) {
      const cell = getCell(rcToRef(r, c));
      if (!cell || cell.value == null || cell.value === "") continue;
      const disp = displayValue(engine.computeRef(activeSheetId, rcToRef(r, c)), cell.fmt);
      if (!disp.text) continue;
      if (overflowNeed(r, disp, shownFmt(cell)) > L.colLeft[c0] - L.colLeft[c]) start = Math.min(start, c);
      break; // the first cell with text stops anything further left
    }
  }
  return start;
}

/** Why a formula errs, as the hover explains it, and the part of its text to highlight. */
interface FormulaDiagnosis { message: string; segment: string | null }
function diagnoseFormulaError(formula: string, errorValue: string): FormulaDiagnosis {
  let ast: Ast | null = null; try { ast = parseFormula(formula.slice(1)); } catch (error) {
    return { message: "The formula syntax could not be parsed. Check separators, quotes, and parentheses.", segment: null };
  }
  let diagnosis: FormulaDiagnosis | null = null;
  const inspect = (node: Ast | null): void => {
    if (!node || diagnosis) return;
    if (node.k === "call") {
      if (!FUNCTIONS[node.name]) diagnosis = { message: `Unknown function ${node.name}.`, segment: node.name };
      if (!diagnosis && ["VLOOKUP", "HLOOKUP"].includes(node.name) && node.args[3]?.k === "ref" && !parseRef(node.args[3].ref)) {
        diagnosis = { message: `${node.name}’s fourth argument should usually be TRUE, FALSE, 1, or 0—not unquoted text.`, segment: node.args[3].ref };
      }
      if (!diagnosis && ["VLOOKUP", "HLOOKUP"].includes(node.name) && node.args[2]?.k === "num" && node.args[1]?.k === "range") {
        const first = parseRef(node.args[1].a.split("!").pop() as string), last = parseRef(node.args[1].b.split("!").pop() as string);
        const size = first && last ? (node.name === "VLOOKUP" ? Math.abs(last.c - first.c) + 1 : Math.abs(last.r - first.r) + 1) : null;
        if (size && (node.args[2].v < 1 || node.args[2].v > size)) diagnosis = { message: `${node.name} requests index ${node.args[2].v}, but the lookup range only contains ${size}.`, segment: String(node.args[2].v) };
      }
      node.args.forEach((argument) => inspect(argument));
    } else if (node.k === "ref") {
      const refText = node.ref, cellPart = refText.split("!").pop() as string;
      if (!parseRef(cellPart)) diagnosis = { message: `“${refText}” looks like text or an invalid cell reference. Put text in quotes, or choose a valid cell.`, segment: refText };
      else if (refText.includes("!")) {
        const prefix = refText.slice(0, refText.lastIndexOf("!"));
        const sheetName = /^'.*'$/.test(prefix) ? prefix.slice(1, -1).replace(/''/g, "'") : prefix;
        if (!model.sheetOrder.some((id) => model.sheets[id].name.toLowerCase() === sheetName.toLowerCase())) diagnosis = { message: `The referenced sheet “${sheetName}” does not exist.`, segment: prefix };
      }
    } else if (node.k === "range") {
      inspect({ k: "ref", ref: node.a }); inspect({ k: "ref", ref: node.b });
    } else if (node.k === "paren" || node.k === "un" || node.k === "pct") inspect(node.a);
    else if (node.k === "bin") { if (node.a) inspect(node.a); if (node.b) inspect(node.b); }
  };
  inspect(ast);
  if (diagnosis) return diagnosis;
  const messages: Record<string, string> = {
    "#REF!": "A reference is invalid or a lookup index points outside its selected range.",
    "#DIV/0!": "This formula divides by zero or by an empty value.",
    "#VALUE!": "One of the highlighted arguments may have the wrong value type.",
    "#N/A": "No matching value was found. Check the lookup value, range, and match mode.",
    "#NAME?": "A function or name in this formula is not recognized.",
    "#NUM!": "A numeric argument is outside the supported range.",
    "#CYCLE!": "This formula refers back to itself, directly or indirectly.",
  };
  return { message: messages[errorValue] || "This formula could not be evaluated.", segment: null };
}
function formulaErrorTooltip(formula: string, errorValue: string): HTMLDivElement {
  const diagnosis = diagnoseFormulaError(formula, errorValue);
  const tooltip = el("div", { class: "formula-error-tooltip" }, [el("strong", {}, `${errorValue} — Possible issue`), el("div", {}, diagnosis.message)]);
  const preview = el("div", { class: "formula-error-preview" });
  if (diagnosis.segment) {
    const index = formula.toLowerCase().indexOf(String(diagnosis.segment).toLowerCase());
    if (index >= 0) {
      preview.append(document.createTextNode(formula.slice(0, index)), el("mark", {}, formula.slice(index, index + String(diagnosis.segment).length)), document.createTextNode(formula.slice(index + String(diagnosis.segment).length)));
    } else preview.textContent = formula;
  } else preview.textContent = formula;
  tooltip.appendChild(preview); return tooltip;
}

function renderCell(ref: string, r: number, c: number): HTMLTableCellElement {
  const cell = getCell(ref);
  const td = el("td", { class: "cell", "data-ref": ref, "data-r": r, "data-c": c });
  const fmt = shownFmt(cell);
  const computed = (cell && cell.value !== "" && cell.value != null) ? engine.computeRef(activeSheetId, ref) : (cell ? "" : null);
  const disp = displayValue(computed, fmt);
  const cv = disp.link
    ? el("a", { class: "cv cell-link", href: disp.link, target: "_blank", rel: "noopener noreferrer", title: disp.link })
    : el("span", { class: "cv" });
  cv.textContent = disp.text;
  if (disp.link) {
    let openedOnMouseDown = false;
    cv.addEventListener("mousedown", (event) => {
      if (event.button !== 0 || !(event.ctrlKey || event.metaKey)) return;
      event.preventDefault(); event.stopPropagation();
      openedOnMouseDown = true; openExternalLink(disp.link as string);
    });
    cv.addEventListener("click", (event) => {
      event.preventDefault(); event.stopPropagation();
      if ((event.ctrlKey || event.metaKey) && !openedOnMouseDown) openExternalLink(disp.link as string);
      openedOnMouseDown = false;
    });
  }
  td.appendChild(cv);
  const filter = curSheet()?.filter;
  if (filter?.row === r && filterColumns(filter).includes(c)) {
    td.classList.add("filter-cell");
    const active = !!filter.criteria?.[c]?.length;
    const trigger = el("button", { class: "filter-trigger" + (active ? " active" : ""), type: "button", "aria-label": active ? `Change filter on column ${colToLetter(c)}` : `Filter column ${colToLetter(c)}`, html: svg(ICONS.filter, 12) });
    td.appendChild(trigger);
  }
  if (disp.numeric) td.classList.add("num");
  if (disp.err) {
    td.classList.add("err");
    if (cell?.value?.startsWith("=")) {
      td.classList.add("has-error-detail");
      const detail = formulaErrorTooltip(cell.value, disp.text); td.appendChild(detail);
    }
  }
  // formatting styles
  if (fmt) {
    if (fmt.b) td.style.fontWeight = "700";
    if (fmt.i) td.style.fontStyle = "italic";
    // Set on the text itself: decorations on the cell don't reach text that flows into
    // neighbouring cells (it's positioned absolutely). A link keeps its underline.
    if (fmt.u || fmt.s) cv.style.textDecorationLine = [fmt.u || disp.link ? "underline" : "", fmt.s ? "line-through" : ""].filter(Boolean).join(" ");
    if (fmt.c) td.style.color = fmt.c;
    // A fill keeps the selection tint (a background image) and gets legible
    // ink when no text color was chosen, in light and dark mode alike.
    if (fmt.bg) { td.style.backgroundColor = fmt.bg; if (!fmt.c && !disp.err) td.style.color = readableInk(fmt.bg); }
    if (fmt.fs) td.style.fontSize = fmt.fs + "px";
    if (fmt.a) cv.style.textAlign = fmt.a === "l" ? "left" : fmt.a === "c" ? "center" : "right";
    if (fmt.wrap) td.classList.add("wrap");
    if (disp.center && !fmt.a) cv.style.textAlign = "center";
  } else if (disp.center) cv.style.textAlign = "center";
  // Left-aligned text flows across empty cells as far as it needs, and is clipped before the next filled one.
  const need = overflowNeed(r, disp, fmt);
  if (need > colWidth(c)) {
    const overflowWidth = Math.min(need, availableOverflowWidth(r, c, need));
    if (overflowWidth > colWidth(c)) {
      td.classList.add("text-overflow");
      cv.style.width = Math.max(0, overflowWidth - 8) + "px";
    }
  }
  // The cell being edited hides its old text, so none of it lingers beside the editor.
  if (editing && editing.r === r && editing.c === c && editing.sheetId === activeSheetId) td.classList.add("editing");
  return td;
}

function printBounds(sheetId: string): { rows: number; cols: number } {
  let maxRow = 0, maxCol = 0;
  for (const [ref, cell] of Object.entries(model.cells[sheetId] || {})) {
    if ((cell.value === "" || cell.value == null) && !cell.fmt) continue;
    const position = parseRef(ref);
    if (!position) continue;
    maxRow = Math.max(maxRow, position.r);
    maxCol = Math.max(maxCol, position.c);
  }
  const sheet = model.sheets[sheetId];
  return {
    rows: Math.min(sheet.rows, maxRow + 1),
    cols: Math.min(sheet.cols, maxCol + 1),
  };
}

// Print draws the grid at 8pt rather than 13px, so widths, heights and font sizes shrink alike.
const PRINT_SCALE = 8 * 96 / 72 / 13;
// The width a page holds: landscape Letter (the narrower of Letter and A4) less its margins.
const PRINT_PAGE_WIDTH = (11 - 0.8) * 96;
const PRINT_HEAD_W = 32;
/** A cell as print shows it: the stored cell (if any) and how its value displays. */
interface PrintShown { cell: Cell | null; disp: Display }
function printCellDisplay(sheetId: string, ref: string): PrintShown {
  const cell = model.cells[sheetId]?.[ref] || null;
  const computed = cell && cell.value !== "" && cell.value != null ? engine.computeRef(sheetId, ref) : (cell ? "" : null);
  return { cell, disp: displayValue(computed, cell?.fmt) };
}
function renderPrintCell(sheetId: string, ref: string, r: number, c: number, shown: PrintShown = printCellDisplay(sheetId, ref)): HTMLTableCellElement {
  const { cell, disp } = shown;
  const fmt = shownFmt(cell);
  // Links stay links (blue and underlined, as on screen), and can be clicked in the PDF.
  const cv = disp.link ? el("a", { class: "cv cell-link", href: disp.link }, disp.text) : el("span", { class: "cv" }, disp.text);
  const td = el("td", { class: "cell", "data-ref": ref, "data-r": r, "data-c": c }, cv);
  if (disp.numeric) td.classList.add("num");
  if (disp.err) td.classList.add("err");
  if (fmt) {
    if (fmt.b) td.style.fontWeight = "700";
    if (fmt.i) td.style.fontStyle = "italic";
    if (fmt.u || fmt.s) cv.style.textDecorationLine = [fmt.u ? "underline" : "", fmt.s ? "line-through" : ""].filter(Boolean).join(" ");
    if (fmt.c) td.style.color = fmt.c;
    // Same legible ink on a fill as on screen.
    if (fmt.bg) { td.style.background = fmt.bg; if (!fmt.c && !disp.err) td.style.color = readableInk(fmt.bg); }
    if (fmt.fs) td.style.fontSize = (fmt.fs * PRINT_SCALE).toFixed(2) + "px";
    if (fmt.a) cv.style.textAlign = fmt.a === "l" ? "left" : fmt.a === "c" ? "center" : "right";
    if (fmt.wrap) td.classList.add("wrap");
    if (disp.center && !fmt.a) cv.style.textAlign = "center";
  } else if (disp.center) {
    cv.style.textAlign = "center";
  }
  return td;
}

// Columns in page-wide groups: a sheet wider than the page prints in several parts, each with
// the row numbers, one after another (as spreadsheets print "down, then over").
function printColumnGroups(widths: number[]): { c0: number; c1: number }[] {
  const groups: { c0: number; c1: number }[] = [];
  let group: { c0: number; c1: number } | null = null, used = 0;
  widths.forEach((width, c) => {
    if (!group || used + width > PRINT_PAGE_WIDTH - PRINT_HEAD_W) { group = { c0: c, c1: c }; groups.push(group); used = 0; }
    group.c1 = c; used += width;
  });
  return groups;
}

function renderPrintSheet(sheetId: string): HTMLElement {
  const sheet = model.sheets[sheetId];
  const bounds = printBounds(sheetId);
  const section = el("section", { class: "print-sheet" });
  section.appendChild(el("h1", { class: "print-sheet-title" }, sheet.name));
  if (bounds.rows * bounds.cols > MAX_PRINT_CELLS) {
    section.appendChild(el("p", { class: "print-sheet-error" },
      `This sheet's used range is too large to export (${bounds.rows.toLocaleString()} rows × ${bounds.cols.toLocaleString()} columns).`));
    return section;
  }
  const widths = Array.from({ length: bounds.cols }, (_, c) =>
    Math.min(PRINT_PAGE_WIDTH - PRINT_HEAD_W, Math.round((sheet.colWidths[c] || DEFAULT_COL_W) * PRINT_SCALE)));
  const groups = printColumnGroups(widths);
  groups.forEach((group, index) => {
    if (groups.length > 1) section.appendChild(el("div", { class: "print-part" + (index ? " print-part-next" : "") },
      `Columns ${colToLetter(group.c0)}–${colToLetter(group.c1)}` + (index ? ` · ${sheet.name}` : "")));
    section.appendChild(renderPrintTable(sheetId, bounds, widths, group));
  });
  // Charts follow the cells, each drawn as on screen.
  for (const chart of sheet.charts || []) {
    const data = chartData(chart, sheetId);
    if (!data) continue;
    section.appendChild(el("figure", { class: "print-chart" }, [
      el("figcaption", {}, chart.title || chartTypeLabel(chart.type)),
      renderChartSvg(chart, data),
    ]));
  }
  return section;
}

function renderPrintTable(sheetId: string, bounds: { rows: number; cols: number }, widths: number[], { c0, c1 }: { c0: number; c1: number }): HTMLTableElement {
  const sheet = model.sheets[sheetId];
  const table = el("table", { class: "grid print-grid" });
  const colgroup = el("colgroup");
  colgroup.appendChild(el("col", { style: `width:${PRINT_HEAD_W}px` }));
  let total = PRINT_HEAD_W;
  for (let c = c0; c <= c1; c++) { colgroup.appendChild(el("col", { style: `width:${widths[c]}px` })); total += widths[c]; }
  table.style.width = total + "px";
  table.appendChild(colgroup);
  const thead = el("thead");
  const header = el("tr");
  header.appendChild(el("th", { class: "corner" }));
  for (let c = c0; c <= c1; c++) header.appendChild(el("th", { class: "colhead" }, colToLetter(c)));
  thead.appendChild(header);
  table.appendChild(thead);

  const tbody = el("tbody");
  for (let r = 0; r < bounds.rows; r++) {
    if (sheet.filter && !rowPassesFilter(r, sheetId)) continue; // rows a filter hides don't print, as they don't show
    const height = Math.max(16, Math.min(160, Math.round((sheet.rowHeights[r] || DEFAULT_ROW_H) * PRINT_SCALE)));
    const row = el("tr", { style: `height:${height}px` });
    row.appendChild(el("th", { class: "rowhead" }, String(r + 1)));
    for (let c = c0; c <= c1; c++) {
      const ref = rcToRef(r, c);
      const shown = printCellDisplay(sheetId, ref);
      const td = renderPrintCell(sheetId, ref, r, c, shown);
      row.appendChild(td);
      // Text wider than its column runs on over empty neighbours, as on screen.
      const fmt = shownFmt(shown.cell);
      if (!shown.disp.text || shown.disp.numeric || shown.disp.err || shown.disp.center || fmt?.wrap || (fmt?.a && fmt.a !== "l")) continue;
      const need = cellTextWidth(shown.disp.text, fmt) * PRINT_SCALE + 8;
      let span = 1, room = widths[c];
      while (room < need && c + span <= c1 && printCellIsEmpty(sheetId, r, c + span)) { room += widths[c + span]; span++; }
      if (span > 1) { td.colSpan = span; td.classList.add("print-overflow"); c += span - 1; }
    }
    tbody.appendChild(row);
  }
  table.appendChild(tbody);
  return table;
}
function printCellIsEmpty(sheetId: string, r: number, c: number): boolean {
  const { cell, disp } = printCellDisplay(sheetId, rcToRef(r, c));
  return !disp.text && !cell?.fmt?.bg;
}

// "beforeprint" and the print media query both fire for one print; the second, moments
// later, would draw the whole workbook again for nothing.
let printRenderedAt = -Infinity;
function renderPrintWorkbook() {
  if (performance.now() - printRenderedAt < 1000) return;
  printRenderedAt = performance.now();
  printWorkbook.replaceChildren(...model.sheetOrder
    .filter((sheetId) => model.sheets[sheetId])
    .map(renderPrintSheet));
}

window.addEventListener("beforeprint", renderPrintWorkbook);
window.matchMedia("print").addEventListener("change", (event) => {
  if (event.matches) renderPrintWorkbook();
});

// The selection outline and active-cell ring glide from cell to cell; a jump
// to a different sheet, or the ring's first appearance, snaps without motion.
let ringSheet: string | null = null;
function placeBox(node: HTMLElement, left: number, top: number, width: number, height: number, show: boolean) {
  if (!show) { node.classList.remove("show"); return; }
  const snap = !node.classList.contains("show") || ringSheet !== activeSheetId;
  if (snap) node.classList.add("jump");
  node.style.transform = `translate(${left}px, ${top}px)`;
  node.style.width = width + "px";
  node.style.height = height + "px";
  if (snap) { void node.offsetWidth; node.classList.remove("jump"); }
  node.classList.add("show");
}
// Placed from the layout, so they're right even when their cells aren't drawn (a selection
// reaching far below the window, an active cell scrolled out of view).
function positionSelectionRing() {
  if (!curSheet()) return;
  if (!editing && !isExport && !rowHidden(focus.r)) {
    const b = cellRect(focus.r, focus.c);
    placeBox(selRing, b.left - 1, b.top - 1, b.width + 1, b.height + 1, true);
  } else placeBox(selRing, 0, 0, 0, 0, false);
  const range = selRange();
  const multi = !editing && !extraRanges.length && (range.r1 !== range.r2 || range.c1 !== range.c2);
  const box = multi ? rangeRect(range.r1, range.c1, range.r2, range.c2) : null;
  if (box && box.height > 0) placeBox(selRangeEl, box.left - 1, box.top - 1, box.width + 1, box.height + 1, true);
  else placeBox(selRangeEl, 0, 0, 0, 0, false);
  ringSheet = activeSheetId;
}
function positionActiveOverlays() {
  positionSelectionRing();
  if (editing || extraRanges.length || !curSheet()) { fillHandle.style.display = "none"; return; }
  const range = selRange();
  if (rowHidden(range.r2)) { fillHandle.style.display = "none"; return; }
  const b = cellRect(range.r2, range.c2);
  fillHandle.style.left = (b.left + b.width - 4.5) + "px";
  fillHandle.style.top = (b.top + b.height - 4.5) + "px";
  fillHandle.style.display = "block";
}
/** The source cell a fill copies from, as it was when the drag began. */
type FillSnapshot = { value: string; fmt: CellFmt | null } | null;
/** A fill-handle drag in progress: the selection it started from, the range it would fill, and the source cells. */
interface FillDrag { source: Area; target: Area; snapshots: Record<string, FillSnapshot>; sheetId: string }
let fillDrag: FillDrag | null = null;
function modulo(value: number, divisor: number): number { return ((value % divisor) + divisor) % divisor; }
function clearFillPreview() { for (const td of renderedCells.values()) td.classList.remove("fill-preview"); }
function decorateFillPreview() {
  if (!fillDrag) return;
  const { source, target } = fillDrag;
  for (const [key, td] of renderedCells) {
    const r = key >> 10, c = key & 1023;
    const on = r >= target.r1 && r <= target.r2 && c >= target.c1 && c <= target.c2 && (r < source.r1 || r > source.r2 || c < source.c1 || c > source.c2);
    td.classList.toggle("fill-preview", on);
  }
}
function updateFillPreview(row: number, column: number) {
  if (!fillDrag) return;
  const source = fillDrag.source;
  const rowDistance = row < source.r1 ? source.r1 - row : row > source.r2 ? row - source.r2 : 0;
  const columnDistance = column < source.c1 ? source.c1 - column : column > source.c2 ? column - source.c2 : 0;
  if (!rowDistance && !columnDistance) fillDrag.target = { ...source };
  else if (rowDistance >= columnDistance) fillDrag.target = { r1: Math.min(row, source.r1), c1: source.c1, r2: Math.max(row, source.r2), c2: source.c2 };
  else fillDrag.target = { r1: source.r1, c1: Math.min(column, source.c1), r2: source.r2, c2: Math.max(column, source.c2) };
  decorateFillPreview();
}
// A series the fill can continue, from one line of the source (a column when filling down or
// up, a row when filling across), as spreadsheets do: two or more plain numbers continue
// their trend (1, 2 → 3, 4; least squares, so 1, 3, 4 works too), and text ending in a number
// counts on ("Item 1" → "Item 2"; with several, by their common step). Anything else, and a
// lone number, is copied. Returns k -> value (k: position from the line's first source cell).
function fillSeries(values: (string | undefined)[]): ((k: number) => string | null) | null {
  if (values.some((v) => v == null || v === "" || v[0] === "=")) return null;
  const texts = values as string[]; // every value is present (checked above)
  const n = texts.length;
  const fit = (ys: number[]) => {
    const mx = (n - 1) / 2, my = ys.reduce((t, y) => t + y, 0) / n;
    let sxy = 0, sxx = 0;
    ys.forEach((y, x) => { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; });
    const slope = sxx ? sxy / sxx : 0;
    return (k: number) => Number((my + slope * (k - mx)).toPrecision(12));
  };
  if (n >= 2 && texts.every((v) => /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(v.trim()))) {
    const at = fit(texts.map(Number));
    return (k: number) => String(at(k));
  }
  // Any other number ("1.5", "$5", "1,200", "15%") is copied, as a lone number is.
  if (texts.some((v) => /^[-+]?\$?[\d,]*\.?\d+%?$/.test(v.trim()))) return null;
  const matched = texts.map((v) => /^(.*?)(\d+)$/.exec(v));
  if (matched.some((m) => !m || m[1] !== matched[0]?.[1])) return null;
  const parts = matched as RegExpExecArray[];
  const numbers = parts.map((m) => Number(m[2]));
  const step = n === 1 ? 1 : numbers[1] - numbers[0];
  if (numbers.some((x, i) => x !== numbers[0] + step * i)) return null;
  const width = parts[0][2].length;
  return (k: number) => { const x = numbers[0] + step * k; return x < 0 ? null : parts[0][1] + String(x).padStart(parts[0][2].startsWith("0") ? width : 1, "0"); };
}
function applyFillDrag() {
  if (!fillDrag) return;
  const { source, target, snapshots, sheetId } = fillDrag;
  fillDrag = null; clearFillPreview();
  // (Someone else may have deleted the sheet mid-drag.)
  if (!model.sheets[sheetId] || target.r1 === source.r1 && target.r2 === source.r2 && target.c1 === source.c1 && target.c2 === source.c2) { positionActiveOverlays(); return; }
  const sourceRows = source.r2 - source.r1 + 1, sourceColumns = source.c2 - source.c1 + 1;
  const vertical = target.r1 !== source.r1 || target.r2 !== source.r2;
  const series = new Map<number, ReturnType<typeof fillSeries>>(); // line -> fillSeries result
  const seriesFor = (line: number) => {
    if (!series.has(line)) {
      const values: (string | undefined)[] = [];
      if (vertical) for (let row = source.r1; row <= source.r2; row++) values.push(snapshots[rcToRef(row, line)]?.value);
      else for (let column = source.c1; column <= source.c2; column++) values.push(snapshots[rcToRef(line, column)]?.value);
      series.set(line, fillSeries(values));
    }
    return series.get(line);
  };
  beginBatch();
  for (let row = target.r1; row <= target.r2; row++) for (let column = target.c1; column <= target.c2; column++) {
    if (row >= source.r1 && row <= source.r2 && column >= source.c1 && column <= source.c2) continue;
    const sourceRow = source.r1 + modulo(row - source.r1, sourceRows);
    const sourceColumn = source.c1 + modulo(column - source.c1, sourceColumns);
    const sourceRef = rcToRef(sourceRow, sourceColumn), destinationRef = rcToRef(row, column);
    const snapshot = snapshots[sourceRef], existing = (model.cells[sheetId] || {})[destinationRef];
    recordCell(sheetId, destinationRef);
    if (snapshot) {
      const continued = seriesFor(vertical ? column : row)?.(vertical ? row - source.r1 : column - source.c1);
      const value = continued ?? shiftedCopyFormula(snapshot.value, sourceRef, destinationRef, false);
      model.cells[sheetId][destinationRef] = { value, fmt: snapshot.fmt ? { ...snapshot.fmt } : null, version: existing?.version || 0 };
      queueCellOp(sheetId, destinationRef, value, snapshot.fmt || null);
    } else clearStoredCell(sheetId, destinationRef);
  }
  commitBatch(); rebuildEngine([]); setSelection({ r: target.r1, c: target.c1 }, { r: target.r2, c: target.c2 }); renderGrid(); schedulePivotRefreshes();
}
fillHandle.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || editing) return;
  event.preventDefault(); event.stopPropagation();
  const source = selRange(), snapshots: Record<string, FillSnapshot> = {};
  for (let row = source.r1; row <= source.r2; row++) for (let column = source.c1; column <= source.c2; column++) {
    const ref = rcToRef(row, column), cell = getCell(ref); snapshots[ref] = cell ? { value: cell.value, fmt: cell.fmt ? { ...cell.fmt } : null } : null;
  }
  fillDrag = { source: { ...source }, target: { ...source }, snapshots, sheetId: activeSheetId };
  fillHandle.setPointerCapture?.(event.pointerId);
});
fillHandle.addEventListener("pointermove", (event) => {
  if (!fillDrag) return;
  const target = document.elementFromPoint(event.clientX, event.clientY)?.closest?.<HTMLElement>("td.cell");
  if (target) updateFillPreview(+(target.dataset.r as string), +(target.dataset.c as string));
});
fillHandle.addEventListener("pointerup", (event) => { if (fillDrag) applyFillDrag(); fillHandle.releasePointerCapture?.(event.pointerId); });
fillHandle.addEventListener("pointercancel", () => { fillDrag = null; clearFillPreview(); positionActiveOverlays(); });

// ===========================================================================
// Selection & navigation
// ===========================================================================
function clampRC(r: number, c: number): RC {
  const sh = curSheet();
  return { r: Math.max(0, Math.min(sh.rows - 1, r)), c: Math.max(0, Math.min(sh.cols - 1, c)) };
}
function moveActive(r: number, c: number, extend = false, preserveExtra = false) {
  tabRun = null;
  const p = clampRC(r, c);
  focus = { r: p.r, c: p.c };
  if (!extend) { anchor = { r: p.r, c: p.c }; if (!preserveExtra) extraRanges = []; }
  updateSelectionUI();
  scrollActiveIntoView();
  armEditorCapture(false);
  sendPresence();
}
function setSelection(a: RC, f: RC, preserveExtra = false) { tabRun = null; if (!preserveExtra) extraRanges = []; anchor = { ...a }; focus = { ...f }; updateSelectionUI(); sendPresence(); }

// Selection tint and header highlights on the drawn cells only, so selecting a whole column of
// a huge sheet costs no more than selecting one cell.
function decorateSelection() {
  const sh = curSheet(); if (!sh) return;
  const ranges = selectionRanges();
  for (const [key, td] of renderedCells) {
    const r = key >> 10, c = key & 1023;
    const inSel = ranges.some((range) => r >= range.r1 && r <= range.r2 && c >= range.c1 && c <= range.c2);
    const active = inSel && r === focus.r && c === focus.c;
    td.classList.toggle("active", active);
    td.classList.toggle("sel", inSel && !active);
    if (inSel !== td.hasAttribute("aria-selected")) { if (inSel) td.setAttribute("aria-selected", "true"); else td.removeAttribute("aria-selected"); }
  }
  for (const [c, th] of renderedColHeads) {
    const matches = ranges.filter((range) => c >= range.c1 && c <= range.c2);
    const full = matches.some((range) => range.r1 === 0 && range.r2 === sh.rows - 1);
    th.classList.toggle("full", full); th.classList.toggle("hl", !!matches.length && !full);
  }
  for (const [r, th] of renderedRowHeads) {
    const matches = ranges.filter((range) => r >= range.r1 && r <= range.r2);
    const full = matches.some((range) => range.c1 === 0 && range.c2 === sh.cols - 1);
    th.classList.toggle("full", full); th.classList.toggle("hl", !!matches.length && !full);
  }
}
function updateSelectionUI() {
  const rng = selRange();
  if (win && win.sheetId === activeSheetId) decorateSelection();
  // name box + formula bar
  nameBox.value = extraRanges.length ? `${selectionRanges().length} ranges` : (rng.r1 === rng.r2 && rng.c1 === rng.c2 ? rcToRef(focus.r, focus.c)
    : rcToRef(rng.r1, rng.c1) + ":" + rcToRef(rng.r2, rng.c2));
  // While editing, the formula bar shows the formula being typed, not the cell under the selection.
  if (!editing) { const active = getCell(rcToRef(focus.r, focus.c)); formulaInput.value = active ? active.value : ""; }
  markMovableHeaders();
  refreshToolbarState(); positionActiveOverlays();
}
function scrollActiveIntoView() { scrollCellIntoView(focus.r, focus.c); }
// Scrolls just enough to show a cell clear of the sticky headers (its top-left if it's bigger
// than the view). Works for cells that aren't drawn yet; the window follows the scroll.
function scrollCellIntoView(r: number, c: number) {
  if (!curSheet()) return;
  let b = cellRect(r, c);
  // Only when the scroll has to move past what the table's current size allows.
  if (b.top + b.height > gridTable.offsetHeight || b.left + b.width > gridTable.offsetWidth) { flushRender(); b = cellRect(r, c); }
  const L = geo();
  const viewH = gridScroll.clientHeight - L.headH, viewW = gridScroll.clientWidth - HEAD_W;
  const top = b.top - L.headH, left = b.left - HEAD_W; // in scroll offsets
  if (top < gridScroll.scrollTop) gridScroll.scrollTop = top;
  else if (top + b.height > gridScroll.scrollTop + viewH) gridScroll.scrollTop = Math.min(top, top + b.height - viewH);
  if (left < gridScroll.scrollLeft) gridScroll.scrollLeft = left;
  else if (left + b.width > gridScroll.scrollLeft + viewW) gridScroll.scrollLeft = Math.min(left, left + b.width - viewW);
}

// ===========================================================================
// Toolbar live state
// ===========================================================================
let shownAlign: string = "l", shownColor = "", shownPivotTip = "";
function refreshToolbarState() {
  const active = getCell(rcToRef(focus.r, focus.c));
  const f = active?.fmt || {};
  boldBtn.classList.toggle("on", !!f.b);
  italicBtn.classList.toggle("on", !!f.i);
  underlineBtn.classList.toggle("on", !!f.u);
  strikeBtn.classList.toggle("on", !!f.s);
  wrapBtn.classList.toggle("on", !!f.wrap);
  currencyBtn.classList.toggle("on", f.nf === "currency");
  percentBtn.classList.toggle("on", f.nf === "percent");
  filterBtn.classList.toggle("on", !!curSheet()?.filter);
  const onPivot = !!curSheet()?.pivot;
  pivotBtn.classList.toggle("on", onPivot);
  const pivotTip = onPivot ? "Pivot table settings" : "Pivot table";
  if (pivotTip !== shownPivotTip) { shownPivotTip = pivotTip; setTip(pivotBtn, pivotTip); }
  // With no alignment chosen, show how the cell actually sits: numbers right, TRUE/FALSE centred.
  let align = f.a === "l" || f.a === "c" || f.a === "r" ? f.a : "l";
  if (!f.a && active?.value) {
    const value = engine.computeRef(activeSheetId, rcToRef(focus.r, focus.c));
    if (typeof value === "number") align = "r"; else if (typeof value === "boolean") align = "c";
  }
  if (align !== shownAlign) { shownAlign = align; alignBtn.innerHTML = svg(ICONS[ALIGNS.find((a) => a.key === align)!.icon]); }
  const colorKey = (f.c || "") + "/" + (f.bg || "");
  if (colorKey !== shownColor) {
    shownColor = colorKey;
    colorBar.style.background = f.c || "";
    colorBtn.classList.toggle("has-color", !!f.c);
    colorHl.style.background = f.bg || "";
    colorBtn.style.color = f.bg && !f.c ? readableInk(f.bg) : "";
  }
  showNumberFormat(f.nf || "auto");
}

/* ═════════════════ 9. Editing, keyboard, clipboard, find ═════════════════ */

// ===========================================================================
// Cell editing + formula guidance
// ===========================================================================
let formulaAssistItems: string[] = [], formulaAssistIndex = 0, formulaAssistReplaceStart = 0;
function closeFormulaAssist() { formulaAssist.style.display = "none"; formulaAssist.replaceChildren(); formulaAssistItems = []; }
// The suggestions follow where you're typing: under the cell when editing in
// the grid, under the formula bar (at the caret) when typing up there.
const assistMeasure = document.createElement("canvas").getContext("2d");
function formulaBarCaretX() {
  const r = formulaInput.getBoundingClientRect();
  if (!assistMeasure) return r.left;
  const style = getComputedStyle(formulaInput);
  assistMeasure.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  // Anchor at the start of the word being completed (or the caret), so the list lines up with the text.
  const caret = formulaInput.selectionStart ?? formulaInput.value.length;
  const before = formulaInput.value.slice(0, caret);
  const word = /[A-Za-z_][A-Za-z0-9_.]*$/.exec(before);
  const upto = word ? before.slice(0, before.length - word[0].length) : before;
  const x = r.left + parseFloat(style.paddingLeft || "0") + assistMeasure.measureText(upto).width - formulaInput.scrollLeft;
  return clamp(x - 10, r.left - 4, r.right - 40);
}
function positionFormulaAssist() {
  const inBar = document.activeElement === formulaInput;
  formulaAssist.classList.toggle("in-bar", inBar);
  const anchor = inBar ? fbar.getBoundingClientRect() : cellEditor.getBoundingClientRect();
  const left = inBar ? formulaBarCaretX() : anchor.left;
  const h = formulaAssist.offsetHeight;
  // Under the anchor; above it only when the cell is near the bottom.
  let top = anchor.bottom + 4;
  if (!inBar && top + h > window.innerHeight - 8 && anchor.top - 4 - h > 8) top = anchor.top - 4 - h;
  formulaAssist.style.left = Math.max(8, Math.min(window.innerWidth - formulaAssist.offsetWidth - 8, left)) + "px";
  formulaAssist.style.top = Math.max(8, Math.min(window.innerHeight - h - 8, top)) + "px";
}
/** The innermost function call the caret is inside, and which of its arguments it is in. */
interface FormulaCall { name: string; argument: number }
function activeFormulaCall(text: string, cursor: number): FormulaCall | null {
  const stack: FormulaCall[] = []; let quote: string | null = null, braces = 0;
  for (let index = 1; index < cursor; index++) {
    const char = text[index];
    if (quote) {
      if (char === "\\" && text[index + 1] === quote) { index++; continue; }
      if (char === quote) { if (text[index + 1] === quote) { index++; continue; } quote = null; }
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    // An array constant's commas separate its items, not the call's arguments.
    if (char === "{") { braces++; continue; }
    if (char === "}") { braces = Math.max(0, braces - 1); continue; }
    if (braces) continue;
    if (char === "(") {
      const match = /([A-Za-z][A-Za-z0-9_.]*)\s*$/.exec(text.slice(0, index));
      stack.push({ name: match ? match[1].toUpperCase() : "", argument: 0 });
    } else if (char === "," && stack.length) stack[stack.length - 1].argument++;
    else if (char === ")" && stack.length) stack.pop();
  }
  return stack.length ? stack[stack.length - 1] : null;
}
function formulaCursorInQuote(value: string, cursor: number | null): boolean {
  let quote: string | null = null;
  for (let index = 1; index < (cursor ?? 0); index++) {
    const char = value[index];
    if (quote) {
      if (char === "\\" && value[index + 1] === quote) { index++; continue; }
      if (char === quote) { if (value[index + 1] === quote) { index++; continue; } quote = null; }
    } else if (char === '"' || char === "'") quote = char;
  }
  return !!quote;
}
// A comma typed in a formula ends any reference being picked. It is written as typed, with no
// space after it (as Excel and Google Sheets do), so the formula keeps the user's own spacing in
// the cell and in an exported workbook.
function insertFormulaComma() {
  const start = cellEditor.selectionStart ?? cellEditor.value.length, end = cellEditor.selectionEnd ?? start;
  clearFormulaPick();
  cellEditor.value = cellEditor.value.slice(0, start) + "," + cellEditor.value.slice(end);
  const next = start + 1; cellEditor.setSelectionRange(next, next);
  formulaInput.value = cellEditor.value; formulaInput.setSelectionRange(next, next); syncEditorSize(); updateFormulaAssist();
}
function renderFormulaSuggestions(matches: string[]) {
  formulaAssist.replaceChildren(); formulaAssistItems = matches; formulaAssistIndex = Math.min(formulaAssistIndex, matches.length - 1);
  matches.forEach((name, index) => {
    const help = functionHelp(name);
    const item = el("div", { class: "formula-suggestion" + (index === formulaAssistIndex ? " active" : ""), role: "option" }, [el("strong", {}, name), el("span", {}, help[1])]);
    item.addEventListener("mousedown", (event) => { event.preventDefault(); formulaAssistIndex = index; acceptFormulaSuggestion(); });
    formulaAssist.appendChild(item);
  });
  formulaAssist.style.display = "block"; requestAnimationFrame(positionFormulaAssist);
}
function renderFormulaSyntax(call: FormulaCall) {
  const [signature, description] = functionHelp(call.name);
  const match = /^([^()]+)\((.*)\)$/.exec(signature);
  const code = el("div", { class: "formula-syntax-code" });
  if (!match) code.textContent = signature;
  else {
    code.appendChild(document.createTextNode(match[1] + "("));
    const args = match[2] ? match[2].split(/,\s*/) : [];
    args.forEach((argument, index) => {
      if (index) code.appendChild(document.createTextNode(", "));
      code.appendChild(el("span", { class: index === Math.min(call.argument, args.length - 1) ? "current" : "" }, argument));
    });
    code.appendChild(document.createTextNode(")"));
  }
  formulaAssist.replaceChildren(el("div", { class: "formula-syntax" }, [code, el("div", { class: "formula-syntax-desc" }, description)]));
  formulaAssistItems = []; formulaAssist.style.display = "block"; requestAnimationFrame(positionFormulaAssist);
}
function updateFormulaAssist() {
  setDisabled(absoluteRefBtn, !currentFormulaReferenceBounds());
  if (!editing || imeComposing || !cellEditor.value.startsWith("=")) { closeFormulaAssist(); renderFormulaPickHighlight(); return; }
  renderFormulaPickHighlight();
  const cursor = cellEditor.selectionStart ?? cellEditor.value.length;
  const before = cellEditor.value.slice(0, cursor);
  if (before === "=") { formulaAssistReplaceStart = 1; formulaAssistIndex = 0; renderFormulaSuggestions(["SUM", "AVERAGE", "IF", "COUNTIF", "VLOOKUP", "HYPERLINK"]); return; }
  const call = activeFormulaCall(cellEditor.value, cursor);
  if (formulaReferenceBoundsAtCaret(cellEditor.value, cursor)) {
    if (call?.name && FUNCTIONS[call.name]) renderFormulaSyntax(call); else closeFormulaAssist();
    return;
  }
  const token = /([A-Za-z][A-Za-z0-9_.]*)$/.exec(before);
  if (token) {
    const start = cursor - token[1].length, previous = before[start - 1] || "";
    if (start === 1 || "(,+-*/^&=<>".includes(previous)) {
      const query = token[1].toUpperCase();
      const matches = FUNCTION_NAMES.filter((name) => name.startsWith(query)).slice(0, 7);
      if (matches.length) { formulaAssistReplaceStart = start; formulaAssistIndex = 0; renderFormulaSuggestions(matches); return; }
    }
  }
  if (call?.name && FUNCTIONS[call.name]) renderFormulaSyntax(call); else closeFormulaAssist();
}
function acceptFormulaSuggestion() {
  const name = formulaAssistItems[formulaAssistIndex]; if (!name || !editing) return;
  const cursor = cellEditor.selectionStart ?? cellEditor.value.length;
  cellEditor.value = cellEditor.value.slice(0, formulaAssistReplaceStart) + name + "()" + cellEditor.value.slice(cursor);
  const next = formulaAssistReplaceStart + name.length + 1;
  cellEditor.setSelectionRange(next, next); formulaInput.value = cellEditor.value; formulaInput.setSelectionRange(next, next); syncEditorSize(); updateFormulaAssist();
}
function moveFormulaSuggestion(delta: number): boolean {
  if (!formulaAssistItems.length) return false;
  formulaAssistIndex = (formulaAssistIndex + delta + formulaAssistItems.length) % formulaAssistItems.length;
  renderFormulaSuggestions(formulaAssistItems); return true;
}

/**
 * The reference being picked in the formula: where its text sits in the editor, and the cells it
 * covers (r1/c1 is where the pick started, so it may be below or right of r2/c2).
 */
interface FormulaPick { textStart: number; textEnd: number; r1: number; c1: number; r2: number; c2: number }
/** A run of the edited text, [start, end). */
interface TextSpan { start: number; end: number }
let formulaPick: FormulaPick | null = null;
function clearFormulaPick() {
  formulaPick = null; formulaRangeHandle.style.display = "none";
  gridTable.querySelectorAll("td.formula-ref").forEach((cell) => cell.classList.remove("formula-ref", "formula-ref-top", "formula-ref-bottom", "formula-ref-left", "formula-ref-right"));
}
function formulaRangeText(r1: number, c1: number, r2: number, c2: number): string {
  const first = rcToRef(Math.min(r1, r2), Math.min(c1, c2));
  const last = rcToRef(Math.max(r1, r2), Math.max(c1, c2));
  return first === last ? first : first + ":" + last;
}
// The sheet a reference in the formula being edited points into. Unprefixed references belong
// to the formula's own sheet, which isn't the one on screen while picking cells elsewhere.
function formulaRefSheetId(ref: string): string | null {
  const bang = ref.lastIndexOf("!");
  if (bang < 0) return editing?.sheetId || activeSheetId;
  const raw = ref.slice(0, bang);
  const name = (/^'.*'$/.test(raw) ? raw.slice(1, -1).replace(/\\'|''/g, "'") : raw).toLowerCase();
  return model.sheetOrder.find((id) => model.sheets[id].name.toLowerCase() === name) || null;
}
// A reference's cell when it points into the sheet on screen, else null. A range's second
// endpoint is read on its first endpoint's sheet (`Sheet2!A1:B5`), as the engine does.
function localFormulaPosition(ref: string, sheetRef = ref): RC | null {
  if (formulaRefSheetId(sheetRef) !== activeSheetId) return null;
  return parseRef(ref.slice(ref.lastIndexOf("!") + 1));
}
// `Sheet2!`, or `'Q1 Sales'!` when the name needs quoting to read back as a sheet name.
function sheetRefPrefix(sheetId: string): string {
  const name = model.sheets[sheetId]?.name || "";
  const bare = /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) && !/^[A-Za-z]{1,3}\d+$/.test(name) && !/^(true|false)$/i.test(name);
  return (bare ? name : "'" + name.replace(/'/g, "''") + "'") + "!";
}
function formulaReferencedRanges(value: string = cellEditor.value): Area[] {
  const ranges: Area[] = [];
  const addRange = (firstRef: string, lastRef = firstRef) => {
    const first = localFormulaPosition(firstRef), last = localFormulaPosition(lastRef, firstRef); if (!first || !last) return;
    const range = {
      r1: Math.max(0, Math.min(first.r, last.r)), r2: Math.min(curSheet().rows - 1, Math.max(first.r, last.r)),
      c1: Math.max(0, Math.min(first.c, last.c)), c2: Math.min(curSheet().cols - 1, Math.max(first.c, last.c)),
    };
    if (!ranges.some((item) => item.r1 === range.r1 && item.r2 === range.r2 && item.c1 === range.c1 && item.c2 === range.c2)) ranges.push(range);
  };
  let ast: Ast;
  try { ast = parseFormula(value.startsWith("=") ? value.slice(1) : value); }
  catch (error) {
    const tokens = tokenize(value.startsWith("=") ? value.slice(1) : value);
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index], end = tokens[index + 2];
      if (token.t !== "word") continue;
      if (tokens[index + 1]?.t === "colon" && end?.t === "word") { addRange(token.v, end.v); index += 2; }
      else addRange(token.v);
    }
    return ranges;
  }
  const visit = (node: Ast | undefined) => {
    if (!node) return;
    if (node.k === "ref") addRange(node.ref);
    else if (node.k === "range") addRange(node.a, node.b);
    else if (node.k === "call") node.args.forEach(visit);
    else { if ("a" in node) visit(node.a); if ("b" in node) visit(node.b); }
  };
  visit(ast); return ranges;
}
function positionFormulaRangeHandle() {
  if (!formulaPick || !editing) { formulaRangeHandle.style.display = "none"; return; }
  const row = Math.max(formulaPick.r1, formulaPick.r2), column = Math.max(formulaPick.c1, formulaPick.c2);
  if (rowHidden(row)) { formulaRangeHandle.style.display = "none"; return; }
  const b = cellRect(row, column);
  formulaRangeHandle.style.left = (b.left + b.width - 5) + "px";
  formulaRangeHandle.style.top = (b.top + b.height - 5) + "px";
  formulaRangeHandle.style.display = "block";
}
// Outlines on the drawn cells of every range the formula uses (redone as the window moves).
function renderFormulaPickHighlight() {
  const edgeClasses = ["formula-ref", "formula-ref-top", "formula-ref-bottom", "formula-ref-left", "formula-ref-right"];
  const ranges = editing && cellEditor.value.startsWith("=") ? formulaReferencedRanges() : [];
  if (formulaPick) ranges.push({
    r1: Math.min(formulaPick.r1, formulaPick.r2), r2: Math.max(formulaPick.r1, formulaPick.r2),
    c1: Math.min(formulaPick.c1, formulaPick.c2), c2: Math.max(formulaPick.c1, formulaPick.c2),
  });
  for (const [key, cell] of renderedCells) {
    const row = key >> 10, column = key & 1023;
    let on = false, top = false, bottom = false, left = false, right = false;
    for (const range of ranges) {
      if (row < range.r1 || row > range.r2 || column < range.c1 || column > range.c2) continue;
      on = true;
      top ||= row === range.r1; bottom ||= row === range.r2; left ||= column === range.c1; right ||= column === range.c2;
    }
    if (!on) { if (cell.classList.contains("formula-ref")) cell.classList.remove(...edgeClasses); continue; }
    cell.classList.add("formula-ref");
    cell.classList.toggle("formula-ref-top", top); cell.classList.toggle("formula-ref-bottom", bottom);
    cell.classList.toggle("formula-ref-left", left); cell.classList.toggle("formula-ref-right", right);
  }
  positionFormulaRangeHandle();
}
function formulaReferenceBoundsAtCaret(value: string, caret: number): TextSpan | null {
  const pattern = /(?:(?:'(?:[^']|'')+'|[A-Za-z_][A-Za-z0-9_.]*)!)?\$?[A-Z]{1,3}\$?[1-9]\d*(?::(?:(?:'(?:[^']|'')+'|[A-Za-z_][A-Za-z0-9_.]*)!)?\$?[A-Z]{1,3}\$?[1-9]\d*)?/gi;
  for (const match of value.matchAll(pattern)) {
    const start = match.index, end = start + match[0].length;
    if (caret >= start && caret <= end) return { start, end };
  }
  return null;
}
function cycleReferenceToken(text: string): string {
  return text.replace(/(?<![A-Z0-9_])(\$?)([A-Z]{1,3})(\$?)([1-9]\d*)(?![A-Z0-9_])/gi, (_match, fixedColumn: string, column: string, fixedRow: string, row: string) => {
    const state = { column: !!fixedColumn, row: !!fixedRow };
    let next;
    if (!state.column && !state.row) next = { column: true, row: true };
    else if (state.column && state.row) next = { column: false, row: true };
    else if (!state.column && state.row) next = { column: true, row: false };
    else next = { column: false, row: false };
    return (next.column ? "$" : "") + column.toUpperCase() + (next.row ? "$" : "") + row;
  });
}
function formulaEndpointBoundsAtCaret(value: string, caret: number): TextSpan | null {
  const pattern = /(?:(?:'(?:[^']|'')+'|[A-Za-z_][A-Za-z0-9_.]*)!)?\$?[A-Z]{1,3}\$?[1-9]\d*/gi;
  for (const match of value.matchAll(pattern)) {
    if (!match[0].startsWith("'") && formulaCursorInQuote(value, match.index + 1)) continue;
    const start = match.index, end = start + match[0].length;
    if (caret >= start && caret <= end) return { start, end };
  }
  return null;
}
function currentFormulaReferenceBounds() {
  if (!editing || !cellEditor.value.startsWith("=")) return null;
  const caret = cellEditor.selectionStart ?? cellEditor.value.length;
  return formulaEndpointBoundsAtCaret(cellEditor.value, caret);
}
function cycleAbsoluteReference() {
  const bounds = currentFormulaReferenceBounds();
  if (!bounds) { setStatus("bad", "Place the caret in a cell reference"); return false; }
  // Only the cell part cycles: a sheet name like 'Q1 Data' must not gain $ signs.
  const original = cellEditor.value.slice(bounds.start, bounds.end), bang = original.lastIndexOf("!") + 1;
  const replacement = original.slice(0, bang) + cycleReferenceToken(original.slice(bang));
  if (replacement === original) { setStatus("bad", "No cell reference selected"); return false; }
  cellEditor.value = cellEditor.value.slice(0, bounds.start) + replacement + cellEditor.value.slice(bounds.end);
  const end = bounds.start + replacement.length;
  cellEditor.setSelectionRange(end, end); formulaInput.value = cellEditor.value; formulaInput.setSelectionRange(end, end);
  const rangeBounds = formulaReferenceBoundsAtCaret(cellEditor.value, end);
  formulaPick = formulaReferenceFromBounds(cellEditor.value, rangeBounds);
  syncEditorSize(); updateFormulaAssist(); renderFormulaPickHighlight();
  return true;
}
function formulaReferenceFromBounds(value: string, bounds: TextSpan | null): FormulaPick | null {
  if (!bounds) return null;
  const text = value.slice(bounds.start, bounds.end), parts = text.split(":");
  const first = localFormulaPosition(parts[0]), last = localFormulaPosition(parts[1] || parts[0], parts[0]);
  if (!first || !last) return null;
  return {
    textStart: bounds.start, textEnd: bounds.end,
    r1: Math.min(first.r, last.r), r2: Math.max(first.r, last.r),
    c1: Math.min(first.c, last.c), c2: Math.max(first.c, last.c),
  };
}
function syncFormulaPickFromCaret() {
  if (!editing || !cellEditor.value.startsWith("=")) { clearFormulaPick(); return; }
  const start = cellEditor.selectionStart ?? cellEditor.value.length;
  const end = cellEditor.selectionEnd ?? start;
  let bounds = formulaReferenceBoundsAtCaret(cellEditor.value, start === end ? start : Math.min(start + 1, end));
  if (!bounds) {
    const span = activeFormulaArgumentSpans(cellEditor.value, start).find((item) => start >= item.start && start <= item.end);
    if (span) {
      const raw = cellEditor.value.slice(span.start, span.end), leading = raw.length - raw.trimStart().length, trimmed = raw.trim();
      if (/^(?:(?:'(?:[^']|'')+'|[A-Za-z_][A-Za-z0-9_.]*)!)?\$?[A-Z]{1,3}\$?[1-9]\d*(?::(?:(?:'(?:[^']|'')+'|[A-Za-z_][A-Za-z0-9_.]*)!)?\$?[A-Z]{1,3}\$?[1-9]\d*)?$/i.test(trimmed)) bounds = { start: span.start + leading, end: span.start + leading + trimmed.length };
    }
  }
  const reference = formulaReferenceFromBounds(cellEditor.value, bounds);
  if (reference) activateFormulaReference(reference, false);
  else { formulaPick = null; renderFormulaPickHighlight(); }
}
function updatePickedFormulaRange(r1: number, c1: number, r2 = r1, c2 = c1, reset = false) {
  if (!editing || !cellEditor.value.startsWith("=")) return;
  if (!formulaPick || reset) {
    let start = cellEditor.selectionStart ?? cellEditor.value.length;
    let end = cellEditor.selectionEnd ?? start;
    if (start === end) {
      const bounds = formulaReferenceBoundsAtCaret(cellEditor.value, start);
      if (bounds) { start = bounds.start; end = bounds.end; }
    }
    // A pick never replaces the leading "=": it goes before any trailing auto-closed parentheses.
    if (start < 1) {
      let insertion = cellEditor.value.length;
      while (insertion > 1 && cellEditor.value[insertion - 1] === ")") insertion--;
      start = end = insertion;
    }
    formulaPick = { textStart: start, textEnd: end, r1, c1, r2, c2 };
  } else { formulaPick.r2 = r2; formulaPick.c2 = c2; }
  // Cells picked on another sheet are written with that sheet's name: Sheet2!A1:B5.
  const prefix = editingAway() ? sheetRefPrefix(activeSheetId) : "";
  const reference = prefix + formulaRangeText(formulaPick.r1, formulaPick.c1, formulaPick.r2, formulaPick.c2);
  cellEditor.value = cellEditor.value.slice(0, formulaPick.textStart) + reference + cellEditor.value.slice(formulaPick.textEnd);
  formulaPick.textEnd = formulaPick.textStart + reference.length;
  cellEditor.setSelectionRange(formulaPick.textEnd, formulaPick.textEnd);
  formulaInput.value = cellEditor.value; formulaInput.setSelectionRange(formulaPick.textEnd, formulaPick.textEnd); syncEditorSize(); updateFormulaAssist(); renderFormulaPickHighlight();
}
function activeFormulaArgumentSpans(value: string, cursor: number): TextSpan[] {
  const opens: number[] = []; let quote: string | null = null;
  for (let index = 1; index < cursor; index++) {
    const char = value[index];
    if (quote) {
      if (char === "\\" && value[index + 1] === quote) { index++; continue; }
      if (char === quote) { if (value[index + 1] === quote) { index++; continue; } quote = null; }
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "(") opens.push(index);
    else if (char === ")") opens.pop();
  }
  if (!opens.length) return [];
  const open = opens[opens.length - 1], spans: TextSpan[] = []; let start = open + 1, depth = 0; quote = null;
  for (let index = start; index <= value.length; index++) {
    const char = value[index];
    if (quote) {
      if (char === "\\" && value[index + 1] === quote) { index++; continue; }
      if (char === quote) { if (value[index + 1] === quote) { index++; continue; } quote = null; }
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "(") depth++;
    else if (char === ")") { if (depth === 0) { spans.push({ start, end: index }); break; } depth--; }
    else if (char === "," && depth === 0) { spans.push({ start, end: index }); start = index + 1; }
    else if (index === value.length) spans.push({ start, end: index });
  }
  return spans;
}
function removeFormulaReferenceArgument(row: number, column: number): boolean {
  const spans = activeFormulaArgumentSpans(cellEditor.value, cellEditor.selectionStart ?? cellEditor.value.length);
  const index = spans.findIndex((span) => {
    const text = cellEditor.value.slice(span.start, span.end).trim();
    if (text.includes(":")) return false;
    const position = localFormulaPosition(text);
    return position?.r === row && position?.c === column;
  });
  if (index < 0) return false;
  let removeStart = spans[index].start, removeEnd = spans[index].end;
  if (spans.length > 1 && index < spans.length - 1) {
    removeEnd = spans[index + 1].start;
    while (removeEnd < cellEditor.value.length && cellEditor.value[removeEnd] === " ") removeEnd++;
  } else if (spans.length > 1) removeStart = spans[index - 1].end;
  const bridge = index > 0 && index < spans.length - 1 ? " " : "";
  cellEditor.value = cellEditor.value.slice(0, removeStart) + bridge + cellEditor.value.slice(removeEnd);
  const caret = removeStart + bridge.length;
  cellEditor.setSelectionRange(caret, caret); formulaInput.value = cellEditor.value; formulaInput.setSelectionRange(caret, caret);
  clearFormulaPick(); syncEditorSize(); updateFormulaAssist(); return true;
}
function beginAdditionalFormulaReference() {
  let insertion = formulaPick ? formulaPick.textEnd : (cellEditor.selectionStart ?? cellEditor.value.length);
  if (!formulaPick) while (insertion > 1 && cellEditor.value[insertion - 1] === ")") insertion--;
  const previous = cellEditor.value[insertion - 1] || "";
  const separator = previous && previous !== "(" && previous !== "," ? ", " : "";
  cellEditor.value = cellEditor.value.slice(0, insertion) + separator + cellEditor.value.slice(insertion);
  insertion += separator.length;
  clearFormulaPick(); cellEditor.setSelectionRange(insertion, insertion); formulaInput.value = cellEditor.value; formulaInput.setSelectionRange(insertion, insertion);
}
function formulaReferenceAtCell(row: number, column: number): FormulaPick | null {
  const value = cellEditor.value;
  const pattern = /(?:(?:'(?:[^']|'')+'|[A-Za-z_][A-Za-z0-9_.]*)!)?\$?[A-Z]{1,3}\$?[1-9]\d*(?::(?:(?:'(?:[^']|'')+'|[A-Za-z_][A-Za-z0-9_.]*)!)?\$?[A-Z]{1,3}\$?[1-9]\d*)?/gi;
  const matches: FormulaPick[] = [];
  for (const match of value.matchAll(pattern)) {
    // (A quoted sheet name starts with its own quote; that isn't quoted text.)
    if (!match[0].startsWith("'") && formulaCursorInQuote(value, match.index + 1)) continue;
    const parts = match[0].split(":");
    const first = localFormulaPosition(parts[0]), last = localFormulaPosition(parts[1] || parts[0], parts[0]);
    if (!first || !last) continue;
    const range = { r1: Math.min(first.r, last.r), r2: Math.max(first.r, last.r), c1: Math.min(first.c, last.c), c2: Math.max(first.c, last.c) };
    if (row >= range.r1 && row <= range.r2 && column >= range.c1 && column <= range.c2) matches.push({ ...range, textStart: match.index, textEnd: match.index + match[0].length });
  }
  matches.sort((a, b) => (a.r2 - a.r1 + 1) * (a.c2 - a.c1 + 1) - (b.r2 - b.r1 + 1) * (b.c2 - b.c1 + 1));
  return matches[0] || null;
}
function activateFormulaReference(reference: FormulaPick, moveCaret = true) {
  formulaPick = { ...reference };
  if (moveCaret) {
    cellEditor.setSelectionRange(reference.textEnd, reference.textEnd);
    formulaInput.value = cellEditor.value; formulaInput.setSelectionRange(reference.textEnd, reference.textEnd);
  }
  renderFormulaPickHighlight(); updateFormulaAssist();
}
function startFormulaMousePick(row: number, column: number, event: MouseEvent) {
  const modifier = event.ctrlKey || event.metaKey;
  const caret = cellEditor.selectionStart ?? cellEditor.value.length;
  // A range selected for an inner function must not remain the active resize
  // target after the caret moves into an outer function or sibling argument.
  if (formulaPick && (caret < formulaPick.textStart || caret > formulaPick.textEnd)) clearFormulaPick();
  const beforeCaret = cellEditor.value.slice(0, caret);
  const afterSeparator = /[,;(]\s*$/.test(beforeCaret);
  const call = activeFormulaCall(cellEditor.value, cellEditor.selectionStart ?? cellEditor.value.length);
  const dedupeSelection = ["SUM", "AVERAGE", "COUNT", "COUNTA", "MIN", "MAX", "PRODUCT", "MEDIAN", "STDEV", "VAR"].includes(call?.name ?? "");
  const existing = formulaReferenceAtCell(row, column);
  // Named as the formula writes it, so a cell on another sheet reads Sheet2!B3.
  const cellLabel = (editingAway() ? sheetRefPrefix(activeSheetId) : "") + rcToRef(row, column);
  if (modifier && dedupeSelection && existing) {
    if (removeFormulaReferenceArgument(row, column)) setStatus("saved", `${cellLabel} removed from formula`);
    else setStatus("saved", `${cellLabel} is part of an existing range`);
    renderFormulaPickHighlight(); mouseSelecting = false; return;
  }
  if (!modifier && !afterSeparator && existing) { activateFormulaReference(existing); mouseSelecting = false; return; }
  if (dedupeSelection && afterSeparator && existing) {
    setStatus("saved", `${cellLabel} is already referenced`); renderFormulaPickHighlight(); mouseSelecting = false; return;
  }
  if (modifier) beginAdditionalFormulaReference();
  if (formulaPick) {
    if (!event.shiftKey) { formulaPick.r1 = row; formulaPick.c1 = column; }
    updatePickedFormulaRange(formulaPick.r1, formulaPick.c1, row, column, false);
  } else updatePickedFormulaRange(row, column, row, column, true);
  mouseSelecting = "formula";
}
// Arrows point at cells only where the caret can take a reference: right after "=", "(", ",",
// an operator, or a reference just picked. Elsewhere they move the caret.
function caretTakesReference(text: string, caret: number, end: number) {
  if (formulaPick && caret === formulaPick.textEnd) return true;
  return caret === end && /[=(,+\-*\/^&<>]\s*$/.test(text.slice(0, caret));
}
function moveFormulaPickByKeyboard(rowDelta: number, columnDelta: number, extend: boolean) {
  if (!formulaPick) {
    // On another sheet there's no edited cell to step from; start at that sheet's selection.
    const origin = editingAway() ? focus : editing!; // only called while editing
    const row = Math.max(0, Math.min(curSheet().rows - 1, origin.r + rowDelta));
    const column = Math.max(0, Math.min(curSheet().cols - 1, origin.c + columnDelta));
    updatePickedFormulaRange(row, column, row, column, true);
  } else {
    const row = Math.max(0, Math.min(curSheet().rows - 1, formulaPick.r2 + rowDelta));
    const column = Math.max(0, Math.min(curSheet().cols - 1, formulaPick.c2 + columnDelta));
    if (extend) updatePickedFormulaRange(formulaPick.r1, formulaPick.c1, row, column, false);
    else { formulaPick.r1 = row; formulaPick.c1 = column; updatePickedFormulaRange(row, column, row, column, false); }
  }
  scrollCellIntoView(formulaPick!.r2, formulaPick!.c2); // set by updatePickedFormulaRange
}
let resizingFormulaRange = false;
formulaRangeHandle.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || !formulaPick || !editing) return;
  event.preventDefault(); event.stopPropagation(); resizingFormulaRange = true;
  const r1 = Math.min(formulaPick.r1, formulaPick.r2), r2 = Math.max(formulaPick.r1, formulaPick.r2);
  const c1 = Math.min(formulaPick.c1, formulaPick.c2), c2 = Math.max(formulaPick.c1, formulaPick.c2);
  formulaPick.r1 = r1; formulaPick.c1 = c1; formulaPick.r2 = r2; formulaPick.c2 = c2;
  formulaRangeHandle.setPointerCapture?.(event.pointerId);
});
formulaRangeHandle.addEventListener("pointermove", (event) => {
  if (!resizingFormulaRange || !formulaPick) return;
  const target = document.elementsFromPoint(event.clientX, event.clientY).map((element) => element.closest?.("td.cell")).find(Boolean) as HTMLElement | undefined;
  if (target) {
    const row = Number(target.dataset.r), column = Number(target.dataset.c), rect = target.getBoundingClientRect();
    const threshold = 7;
    if (column > formulaPick.c2 && event.clientX < rect.left + threshold) return;
    if (row > formulaPick.r2 && event.clientY < rect.top + threshold) return;
    updatePickedFormulaRange(formulaPick.r1, formulaPick.c1, Math.max(formulaPick.r1, row), Math.max(formulaPick.c1, column), false);
  }
});
const finishFormulaRangeResize = (event: PointerEvent) => {
  if (!resizingFormulaRange) return;
  resizingFormulaRange = false;
  formulaRangeHandle.releasePointerCapture?.(event?.pointerId); renderFormulaPickHighlight();
};
formulaRangeHandle.addEventListener("pointerup", finishFormulaRangeResize);
formulaRangeHandle.addEventListener("pointercancel", finishFormulaRangeResize);

/** The view to restore when coming back to the edited cell's sheet. */
interface HomeView { anchor: RC; focus: RC; extraRanges: Area[]; scrollTop: number; scrollLeft: number }
/** The cell being edited; `sheetId` is its sheet, which isn't always the one on screen. */
interface EditingState { ref: string; r: number; c: number; sheetId: string; home: HomeView | null }
let editing: EditingState | null = null;
let imeComposing = false;
function armEditorCapture(focusCapture = false) {
  if (editing || !curSheet()) return;
  const b = cellRect(focus.r, focus.c);
  cellEditor.value = "";
  cellEditor.style.left = b.left + "px";
  cellEditor.style.top = b.top + "px";
  cellEditor.style.display = "block";
  cellEditor.classList.add("capture");
  if (focusCapture) cellEditor.focus({ preventScroll: true });
}
gridScroll.addEventListener("focus", () => armEditorCapture(true));

function startEdit(ref: string, replace = false, seed: string | null = null, fromCapture = false, keepInputFocus = false) {
  clearFormulaPick();
  if (!fromCapture) imeComposing = false;
  const rc = parseRef(ref);
  if (!rc || !curSheet() || rc.r >= curSheet().rows || rc.c >= curSheet().cols) return;
  editing = { ref, r: rc.r, c: rc.c, sheetId: activeSheetId, home: null };
  // Typing into a cell scrolled out of view brings it back first (the window follows).
  if (!rowHidden(rc.r)) scrollCellIntoView(rc.r, rc.c);
  cellEl(rc.r, rc.c)?.classList.add("editing");
  fillHandle.style.display = "none";
  const cell = getCell(ref);
  let text = seed != null ? seed : (replace ? "" : (cell ? cell.value : ""));
  cellEditor.classList.remove("capture", "away");
  placeCellEditor();
  cellEditor.style.width = cellRect(rc.r, rc.c).width + "px";
  if (!fromCapture) cellEditor.value = text;
  else text = cellEditor.value;
  cellEditor.style.display = "block";
  const f = cell?.fmt || {};
  cellEditor.style.fontWeight = f.b ? "700" : "400";
  cellEditor.style.fontStyle = f.i ? "italic" : "normal";
  cellEditor.style.textAlign = f.a === "c" ? "center" : f.a === "r" ? "right" : "left";
  // A cell with a custom size is edited at that size, so text doesn't shrink while typing.
  cellEditor.style.fontSize = f.fs ? f.fs + "px" : "";
  cellEditor.style.lineHeight = f.fs ? Math.max(20, Math.round(f.fs * 1.35)) + "px" : "";
  if (!fromCapture && !keepInputFocus) {
    cellEditor.focus();
    if (replace || seed != null || cellEditor.value.startsWith("=")) { const L = cellEditor.value.length; cellEditor.setSelectionRange(L, L); }
    else cellEditor.select();
  }
  syncEditorSize();
  formulaInput.value = text;
  updateFormulaAssist();
  positionActiveOverlays();
}
// The editor sits on its cell; re-placed after every redraw so a column resized meanwhile (or a
// return from another sheet) doesn't leave it hanging over the wrong spot.
function placeCellEditor() {
  if (!editing || editing.sheetId !== activeSheetId) return;
  const b = cellRect(editing.r, editing.c);
  cellEditor.style.left = b.left + "px";
  cellEditor.style.top = b.top + "px";
  cellEditor.style.minWidth = b.width + "px";
  cellEditor.style.minHeight = (b.height || DEFAULT_ROW_H) + "px";
}

// ── Picking cells on other sheets ───────────────────────────────────────────
// While a formula is being typed, clicking another sheet's tab doesn't end the edit: the sheet
// comes up for picking, the formula carries on in the formula bar (a chip there names the cell
// it belongs to, and that cell's tab is marked), and clicked cells go in as Sheet2!A1:B5.
// Enter or Tab saves into the original cell and Esc cancels, both returning to its sheet;
// clicking its tab (or the chip) goes back to keep typing in the cell.
function editingAway() { return !!editing && editing.sheetId !== activeSheetId; }
function editingFormula() { return !!editing && cellEditor.value.startsWith("="); }
// Where the caret is typed: the formula bar while away, else whichever of the two has focus.
function editingSurface() { return editingAway() || document.activeElement === formulaInput ? formulaInput : cellEditor; }
function focusEditingSurface() {
  const surface = editingSurface(), start = cellEditor.selectionStart, end = cellEditor.selectionEnd;
  surface.focus({ preventScroll: true });
  if (surface === formulaInput && start != null) formulaInput.setSelectionRange(start, end);
}
function captureHomeView(): HomeView {
  return { anchor: { ...anchor }, focus: { ...focus }, extraRanges: extraRanges.map((range) => ({ ...range })), scrollTop: gridScroll.scrollTop, scrollLeft: gridScroll.scrollLeft };
}
// Puts the formula's own sheet back on screen, with the selection and scroll it was left with.
function restoreEditingSheet() {
  const edit = editing!; // only called while editing
  const home = edit.home;
  activeSheetId = edit.sheetId;
  if (home) { anchor = home.anchor; focus = home.focus; extraRanges = home.extraRanges; }
  edit.home = null;
  selectedChartId = null;
  if (openPop?.pop.classList.contains("settings-pop")) closePop(true);
  cellEditor.classList.remove("away");
  clearFormulaPick();
  renderTabs(); renderGrid(); updateSelectionUI(); refreshToolbarState(); updateEditingOrigin();
  if (home) {
    gridScroll.scrollTop = home.scrollTop; gridScroll.scrollLeft = home.scrollLeft;
    // The redraw happens on the next frame; the scroll is set again once the rows exist (and
    // nudged if a save just moved the selection to a cell out of view).
    requestAnimationFrame(() => { gridScroll.scrollTop = home.scrollTop; gridScroll.scrollLeft = home.scrollLeft; scrollActiveIntoView(); });
  }
  sendPresence();
}
function showSheetWhileEditing(id: string) {
  if (!editing || !model.sheets[id] || id === activeSheetId) return;
  if (id === editing.sheetId) { returnToEditingCell(); return; }
  const start = cellEditor.selectionStart, end = cellEditor.selectionEnd;
  if (!editingAway()) editing.home = captureHomeView();
  activeSheetId = id;
  if (model.sheets[id]?.pivot) refreshPivot(id);
  anchor = { r: 0, c: 0 }; focus = { r: 0, c: 0 }; extraRanges = [];
  selectedChartId = null;
  if (openPop?.pop.classList.contains("settings-pop")) closePop(true);
  // A range picked on the last sheet is finished; the next click adds or replaces at the caret.
  clearFormulaPick();
  cellEditor.classList.add("away");
  formulaInput.focus({ preventScroll: true });
  formulaInput.setSelectionRange(start, end);
  renderTabs(); renderGrid(); updateSelectionUI(); refreshToolbarState(); updateEditingOrigin(); updateFormulaAssist();
  // Opens at the top, where its selection is, rather than at the scroll left on the last sheet.
  gridScroll.scrollTop = 0; gridScroll.scrollLeft = 0;
  sendPresence();
}
// Back on the formula's own sheet, typing carries on in the cell where it left off.
function returnToEditingCell() {
  if (!editingAway()) { focusEditingSurface(); return; }
  const start = cellEditor.selectionStart, end = cellEditor.selectionEnd;
  restoreEditingSheet();
  cellEditor.focus({ preventScroll: true });
  cellEditor.setSelectionRange(start, end);
  requestAnimationFrame(() => { syncEditorSize(); updateFormulaAssist(); });
}
// The chip in the formula bar naming the cell the formula belongs to, shown only while away.
function updateEditingOrigin() {
  const away = editingAway();
  editingOrigin.hidden = !away;
  if (!away) return;
  const edit = editing!; // away implies editing
  const name = model.sheets[edit.sheetId]?.name || "";
  originSheet.textContent = name; originRef.textContent = "!" + edit.ref;
  setTip(editingOrigin, `Editing ${name}!${edit.ref} · click to go back`);
}

const editorMeasureCanvas = document.createElement("canvas");
function syncEditorSize() {
  if (!editing || editingAway()) return;
  cellEditor.style.height = "auto";
  cellEditor.style.height = Math.max(cellEditor.scrollHeight, DEFAULT_ROW_H) + "px";
  const baseWidth = cellRect(editing.r, editing.c).width || 60;
  const context = editorMeasureCanvas.getContext("2d");
  let measuredWidth = baseWidth;
  if (context) {
    const style = getComputedStyle(cellEditor);
    context.font = style.font || `${style.fontSize} ${style.fontFamily}`;
    for (const line of cellEditor.value.split("\n")) measuredWidth = Math.max(measuredWidth, Math.ceil(context.measureText(line || " ").width) + 12);
  }
  cellEditor.style.width = Math.min(2400, measuredWidth) + "px";
}
function completeFormulaParentheses(value: string): string | null {
  if (!value.startsWith("=")) return value;
  const bare = /^=\s*([A-Za-z][A-Za-z0-9_.]*)\s*$/.exec(value);
  if (bare && FUNCTIONS[bare[1].toUpperCase()] && !["TRUE", "FALSE"].includes(bare[1].toUpperCase())) return `=${bare[1].toUpperCase()}()`;
  let depth = 0, quote: string | null = null;
  for (let index = 1; index < value.length; index++) {
    const char = value[index];
    if (quote) {
      if (char === "\\" && value[index + 1] === quote) { index++; continue; }
      if (char === quote) { if (value[index + 1] === quote) { index++; continue; } quote = null; }
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (/[A-Za-z_]/.test(char)) {
      let end = index + 1; while (end < value.length && /[A-Za-z0-9_.]/.test(value[end])) end++;
      const name = value.slice(index, end).toUpperCase();
      let next = end; while (next < value.length && /\s/.test(value[next])) next++;
      if (FUNCTIONS[name] && !["TRUE", "FALSE"].includes(name) && value[next] !== "(" && value[next] !== "!") return null;
      index = end - 1; continue;
    }
    if (char === "(") depth++;
    else if (char === ")") { depth--; if (depth < 0) return null; }
  }
  if (quote) return null;
  return value + ")".repeat(depth);
}
const FORMULA_ARGUMENT_RULES: Record<string, [number, number]> = {
  VLOOKUP: [3, 4], HLOOKUP: [3, 4], INDEX: [2, 3], MATCH: [2, 3],
  IF: [2, 3], IFERROR: [2, 2], IFNA: [2, 2], COUNTIF: [2, 2], SUMIF: [2, 3], AVERAGEIF: [2, 3],
  HYPERLINK: [1, 2], LEFT: [1, 2], RIGHT: [1, 2], MID: [3, 3], ROUND: [2, 2],
  DATE: [3, 3], DATEDIF: [3, 3], EDATE: [2, 2], CHOOSE: [2, Infinity],
};
function validateFormula(value: string): string | null {
  if (!value.startsWith("=")) return null;
  let ast: Ast;
  try { ast = parseFormula(value.slice(1)); }
  catch (error) { return "This formula has invalid syntax. Check separators, quotes, and parentheses."; }
  let problem: string | null = null;
  const visit = (node: Ast | undefined) => {
    if (!node || problem) return;
    if (node.k === "call") {
      if (!FUNCTIONS[node.name]) { problem = `Unknown function ${node.name}.`; return; }
      const rule = FORMULA_ARGUMENT_RULES[node.name];
      if (rule && (node.args.length < rule[0] || node.args.length > rule[1])) {
        const expected = rule[0] === rule[1] ? String(rule[0]) : `${rule[0]}–${rule[1] === Infinity ? "more" : rule[1]}`;
        problem = `${node.name} expects ${expected} argument${rule[1] === 1 ? "" : "s"}; received ${node.args.length}.`; return;
      }
      if (node.name === "SUMIFS" && (node.args.length < 3 || node.args.length % 2 === 0)) { problem = "SUMIFS requires a sum range followed by range/criterion pairs."; return; }
      if (node.name === "COUNTIFS" && (node.args.length < 2 || node.args.length % 2 !== 0)) { problem = "COUNTIFS requires range/criterion pairs."; return; }
      if (node.name === "IFS" && (node.args.length < 2 || node.args.length % 2 !== 0)) { problem = "IFS requires condition/value pairs."; return; }
      node.args.forEach(visit);
    } else {
      // (A range's endpoints are text, not nodes.)
      if ("a" in node && typeof node.a === "object") visit(node.a); if ("b" in node && typeof node.b === "object") visit(node.b);
    }
  };
  visit(ast); return problem;
}
function showFormulaError(message: string) {
  formulaAssist.replaceChildren(el("div", { class: "formula-error" }, message));
  formulaAssistItems = []; formulaAssist.style.display = "block"; requestAnimationFrame(positionFormulaAssist);
  // A small shake says "not yet" without another message on screen.
  if (!reducedMotion.matches) editingSurface().animate([{ transform: "translateX(0)" }, { transform: "translateX(-3px)" }, { transform: "translateX(3px)" }, { transform: "translateX(-2px)" }, { transform: "translateX(0)" }], { duration: 260, easing: "ease-out" });
}
function commitEdit(advance: "down" | "up" | "right" | "left" | "none" = "down") {
  if (!editing) return;
  const { ref, r, c } = editing;
  let value = completeFormulaParentheses(cellEditor.value);
  if (value == null) { focusEditingSurface(); showFormulaError("Formula quotes and parentheses must be balanced."); return; }
  if (value !== cellEditor.value) { cellEditor.value = value; formulaInput.value = value; }
  const formulaError = validateFormula(value);
  if (formulaError) { focusEditingSurface(); showFormulaError(formulaError); return; }
  // A Plain text cell keeps what's typed, as in Excel: "00123" stays text rather than becoming 123.
  if (model.cells[editing.sheetId]?.[ref]?.fmt?.nf === "text" && /^\s*([-+]?\$?[\d,]*\.?\d+%?|true|false)\s*$/i.test(value)) value = "'" + value;
  // Cells were picked on another sheet: the formula goes into its own cell, on its own sheet.
  if (editingAway()) restoreEditingSheet();
  imeComposing = false;
  editing = null; setDisabled(absoluteRefBtn, true);
  closeFormulaAssist(); clearFormulaPick();
  cellEditor.style.display = "none";
  cellEditor.classList.remove("away");
  updateEditingOrigin();
  beginBatch();
  setCellValue(ref, value === "" ? null : value);
  commitBatch();
  rebuildEngine([]);
  renderGrid();
  if (advance === "down") moveActive(r + 1, tabRunAt(r, c) ? tabRun!.startC : c);
  else if (advance === "up") moveActive(r - 1, c);
  else if (advance === "right") tabAlong(r, c, 1);
  else if (advance === "left") tabAlong(r, c, -1);
  else moveActive(r, c);
  gridScroll.focus();
}
// Whether a Tab run left (r, c) active on this sheet.
function tabRunAt(r: number, c: number): boolean {
  return !!tabRun && tabRun.sheetId === activeSheetId && tabRun.at.r === r && tabRun.at.c === c;
}
// Tab (dir 1) or Shift+Tab (-1) from (r, c), continuing the run that left it active or starting one.
function tabAlong(r: number, c: number, dir: number) {
  const startC = tabRunAt(r, c) ? tabRun!.startC : c;
  moveActive(r, c + dir);
  tabRun = { sheetId: activeSheetId, startC, at: { ...focus } };
}
function cancelEdit() {
  if (!editing) return;
  // Esc while picking on another sheet goes back to the cell, which keeps its old value.
  // (If that sheet was just deleted by someone else, there's nothing to go back to.)
  const homeGone = !model.sheets[editing.sheetId];
  if (editingAway() && !homeGone) restoreEditingSheet();
  const { r, c } = editing;
  imeComposing = false;
  editing = null; setDisabled(absoluteRefBtn, true);
  closeFormulaAssist(); clearFormulaPick();
  cellEditor.style.display = "none";
  cellEditor.classList.remove("away");
  updateEditingOrigin();
  cellEl(r, c)?.classList.remove("editing");
  formulaInput.value = homeGone ? "" : getCell(rcToRef(r, c))?.value || "";
  positionActiveOverlays();
  gridScroll.focus();
}
cellEditor.addEventListener("compositionstart", () => {
  imeComposing = true;
  if (!editing) startEdit(rcToRef(focus.r, focus.c), true, cellEditor.value, true);
});
cellEditor.addEventListener("compositionend", () => {
  imeComposing = false;
  if (editing) { syncEditorSize(); formulaInput.value = cellEditor.value; formulaInput.setSelectionRange(cellEditor.selectionStart, cellEditor.selectionEnd); updateFormulaAssist(); }
});
cellEditor.addEventListener("input", () => {
  if (formulaPick) clearFormulaPick();
  if (!editing && cellEditor.classList.contains("capture")) startEdit(rcToRef(focus.r, focus.c), true, cellEditor.value, true);
  if (editing) { syncEditorSize(); formulaInput.value = cellEditor.value; formulaInput.setSelectionRange(cellEditor.selectionStart, cellEditor.selectionEnd); updateFormulaAssist(); }
});
cellEditor.addEventListener("click", () => { syncFormulaPickFromCaret(); updateFormulaAssist(); });
cellEditor.addEventListener("keyup", (event) => { if (editing && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) { syncFormulaPickFromCaret(); updateFormulaAssist(); } });
cellEditor.addEventListener("keydown", (e) => {
  if (imeComposing || e.isComposing || e.keyCode === 229) { e.stopPropagation(); return; }
  if (!editing) {
    const meta = e.ctrlKey || e.metaKey;
    if (e.key.length === 1 && !meta && !e.altKey) return;
    handleGridKeydown(e);
    e.stopPropagation();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "l") { e.preventDefault(); cycleAbsoluteReference(); e.stopPropagation(); return; }
  if (formulaAssistItems.length && e.key === "ArrowDown") { e.preventDefault(); moveFormulaSuggestion(1); e.stopPropagation(); return; }
  if (formulaAssistItems.length && e.key === "ArrowUp") { e.preventDefault(); moveFormulaSuggestion(-1); e.stopPropagation(); return; }
  if (formulaAssistItems.length && (e.key === "Tab" || e.key === "Enter")) { e.preventDefault(); acceptFormulaSuggestion(); e.stopPropagation(); return; }
  if (cellEditor.value.startsWith("=") && e.key === "," && !formulaCursorInQuote(cellEditor.value, cellEditor.selectionStart)) {
    e.preventDefault(); insertFormulaComma(); e.stopPropagation(); return;
  }
  if (cellEditor.value.startsWith("=") && e.key === "(" && !formulaCursorInQuote(cellEditor.value, cellEditor.selectionStart)) {
    e.preventDefault(); clearFormulaPick();
    const start = cellEditor.selectionStart, end = cellEditor.selectionEnd;
    cellEditor.value = cellEditor.value.slice(0, start) + "()" + cellEditor.value.slice(end);
    cellEditor.setSelectionRange(start + 1, start + 1); formulaInput.value = cellEditor.value; syncEditorSize(); updateFormulaAssist(); e.stopPropagation(); return;
  }
  if (cellEditor.value.startsWith("=") && e.key === ")" && cellEditor.value[cellEditor.selectionStart] === ")") {
    e.preventDefault();
    const next = cellEditor.selectionStart + 1;
    cellEditor.setSelectionRange(next, next);
    formulaInput.setSelectionRange(next, next);
    // Stepping over an auto-closed ")" leaves the inner call, so the next click targets the outer argument.
    syncFormulaPickFromCaret();
    updateFormulaAssist();
    e.stopPropagation();
    return;
  }
  if (!formulaAssistItems.length && cellEditor.value.startsWith("=") && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)
      && caretTakesReference(cellEditor.value, cellEditor.selectionStart, cellEditor.selectionEnd)) {
    e.preventDefault();
    const directions: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    moveFormulaPickByKeyboard(directions[e.key][0], directions[e.key][1], e.shiftKey); e.stopPropagation(); return;
  }
  if (formulaAssist.style.display !== "none" && e.key === "Escape") { e.preventDefault(); closeFormulaAssist(); e.stopPropagation(); return; }
  if (e.key === "Enter" && !e.altKey) { e.preventDefault(); commitEdit(e.shiftKey ? "up" : "down"); }
  else if (e.key === "Enter" && e.altKey) { e.preventDefault(); const s = cellEditor.selectionStart; cellEditor.value = cellEditor.value.slice(0, s) + "\n" + cellEditor.value.slice(cellEditor.selectionEnd); cellEditor.setSelectionRange(s + 1, s + 1); formulaInput.value = cellEditor.value; syncEditorSize(); updateFormulaAssist(); }
  else if (e.key === "Tab") { e.preventDefault(); commitEdit(e.shiftKey ? "left" : "right"); }
  else if (e.key === "Escape") { e.preventDefault(); cancelEdit(); }
  e.stopPropagation();
});

// ===========================================================================
// Mouse interaction on grid
// ===========================================================================
// What a drag across the grid is selecting: cells, whole columns or rows, or a formula reference.
let mouseSelecting: false | "cell" | "col" | "row" | "formula" = false;
// A plain click ends an edit first. Returns true when the click should go no further: the edit
// was still open on another sheet (its formula no longer starts with "="), so saving it went
// back to its own cell, where the clicked position means nothing.
function commitBeforeGridClick() {
  if (!editing) return false;
  const away = editingAway();
  commitEdit("none");
  return away;
}

gridTable.addEventListener("mousedown", (e) => {
  const target = e.target as Element; // events on the table come from its cells and headers
  if (e.button !== 0) return;
  if (target.closest<HTMLElement>("a.cell-link") && (e.ctrlKey || e.metaKey)) { e.stopPropagation(); return; }
  const filterTrigger = target.closest<HTMLElement>(".filter-trigger");
  if (filterTrigger) { e.preventDefault(); e.stopPropagation(); return; }
  // Column/row resize handles
  const colResize = target.closest<HTMLElement>(".col-resize");
  if (colResize) { startColResize(Number(colResize.dataset.col), e); e.preventDefault(); return; }
  const rowResize = target.closest<HTMLElement>(".row-resize");
  if (rowResize) { startRowResize(Number(rowResize.dataset.row), e); e.preventDefault(); return; }

  if (editing && cellEditor.value.startsWith("=")) {
    const formulaCell = target.closest<HTMLElement>("td.cell");
    const formulaColumn = target.closest<HTMLElement>("th.colhead");
    const formulaRow = target.closest<HTMLElement>("th.rowhead");
    if (formulaCell) { startFormulaMousePick(Number(formulaCell.dataset.r), Number(formulaCell.dataset.c), e); e.preventDefault(); return; }
    if (formulaColumn) {
      if (e.ctrlKey || e.metaKey) beginAdditionalFormulaReference();
      const column = Number(formulaColumn.dataset.col), reset = !formulaPick;
      if (formulaPick) { formulaPick.r1 = 0; formulaPick.c1 = column; }
      updatePickedFormulaRange(0, column, curSheet().rows - 1, column, reset); e.preventDefault(); return;
    }
    if (formulaRow) {
      if (e.ctrlKey || e.metaKey) beginAdditionalFormulaReference();
      const row = Number(formulaRow.dataset.row), reset = !formulaPick;
      if (formulaPick) { formulaPick.r1 = row; formulaPick.c1 = 0; }
      updatePickedFormulaRange(row, 0, row, curSheet().cols - 1, reset); e.preventDefault(); return;
    }
  }

  // A plain press on a header of the selected whole columns (or rows) may pick them up to move.
  const plainPress = !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey;
  const pressedHead = target.closest<HTMLElement>("th.colhead, th.rowhead");
  if (pressedHead && plainPress) {
    const rows = pressedHead.classList.contains("rowhead"), index = rows ? Number(pressedHead.dataset.row) : Number(pressedHead.dataset.col);
    const r = selRange();
    if (movableHeaderAxis() === (rows ? "row" : "col") && (rows ? index >= r.r1 && index <= r.r2 : index >= r.c1 && index <= r.c2) && beginHeaderMove(rows, index, e)) { e.preventDefault(); return; }
  }
  const colhead = target.closest<HTMLElement>("th.colhead");
  if (colhead) {
    const c = Number(colhead.dataset.col); const sh = curSheet();
    if (commitBeforeGridClick()) { e.preventDefault(); return; }
    const additive = e.ctrlKey || e.metaKey;
    prepareHeaderSelection(additive);
    const startColumn = e.shiftKey ? anchor.c : c;
    anchor = { r: 0, c: startColumn };
    focus = { r: sh.rows - 1, c };
    updateSelectionUI(); sendPresence();
    mouseSelecting = "col"; e.preventDefault(); return;
  }
  const rowhead = target.closest<HTMLElement>("th.rowhead");
  if (rowhead) {
    const r = Number(rowhead.dataset.row); const sh = curSheet();
    if (commitBeforeGridClick()) { e.preventDefault(); return; }
    const additive = e.ctrlKey || e.metaKey;
    prepareHeaderSelection(additive);
    const startRow = e.shiftKey ? anchor.r : r;
    anchor = { r: startRow, c: 0 };
    focus = { r, c: sh.cols - 1 };
    updateSelectionUI(); sendPresence();
    mouseSelecting = "row"; e.preventDefault(); return;
  }
  const td = target.closest<HTMLElement>("td.cell");
  if (td) {
    const r = Number(td.dataset.r), c = Number(td.dataset.c);
    if (commitBeforeGridClick()) { e.preventDefault(); return; }
    if (e.ctrlKey || e.metaKey) { addCurrentRangeToSelection(); moveActive(r, c, false, true); }
    else if (e.shiftKey) { focus = { r, c }; updateSelectionUI(); sendPresence(); }
    else moveActive(r, c);
    mouseSelecting = "cell";
    gridScroll.focus();
    e.preventDefault();
  }
});
gridTable.addEventListener("mousemove", (e) => {
  const target = e.target as Element; // events on the table come from its cells and headers
  if (!mouseSelecting) return;
  const td = target.closest<HTMLElement>("td.cell") || target.closest<HTMLElement>("th");
  let r, c;
  if (td && td.classList.contains("cell")) { r = Number(td.dataset.r); c = Number(td.dataset.c); }
  else return;
  if (mouseSelecting === "formula" && formulaPick) { updatePickedFormulaRange(formulaPick.r1, formulaPick.c1, r, c, false); return; }
  const sh = curSheet();
  if (mouseSelecting === "col") { focus = { r: sh.rows - 1, c }; anchor = { r: 0, c: anchor.c }; }
  else if (mouseSelecting === "row") { focus = { r, c: sh.cols - 1 }; anchor = { r: anchor.r, c: 0 }; }
  else { focus = { r, c }; }
  updateSelectionUI();
});
window.addEventListener("mouseup", () => {
  if (mouseSelecting) {
    mouseSelecting = false; sendPresence();
  }
});

gridTable.addEventListener("click", (e) => {
  const target = e.target as Element; // events on the table come from its cells and headers
  const trigger = target.closest<HTMLElement>(".filter-trigger");
  if (!trigger) return;
  const td = trigger.closest<HTMLElement>("td.cell");
  if (td) openFilterMenu(Number(td.dataset.c), trigger);
});

gridTable.addEventListener("dblclick", (e) => {
  const target = e.target as Element; // events on the table come from its cells and headers
  if (target.closest<HTMLElement>(".filter-trigger")) return;
  // Double-clicking a header's edge fits it to its data (every selected one, if it's selected).
  const edge = target.closest<HTMLElement>(".col-resize, .row-resize");
  if (edge) {
    const rows = edge.classList.contains("row-resize"), index = rows ? Number(edge.dataset.row) : Number(edge.dataset.col);
    const selected = selectedHeaderLines(rows);
    const lines = selected.includes(index) ? selected : [index];
    rows ? fitRows(lines) : fitColumns(lines);
    return;
  }
  const td = target.closest<HTMLElement>("td.cell");
  // Mid-formula, a double-click is two picks, not a request to edit the clicked cell instead.
  if (td && !editing) startEdit(td.dataset.ref!, false); // every cell carries its ref
});

// Dragging a header's edge resizes its column or row.
function startColResize(col: number, e: MouseEvent) {
  const startX = e.clientX; const startW = colWidth(col);
  const move = (ev: MouseEvent) => { const w = Math.max(30, startW + ev.clientX - startX); curSheet().colWidths[col] = Math.round(w); applyColWidth(col); };
  // Done: text that flows into neighbours is measured again.
  const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); queueStructure(); renderGrid(); };
  window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
}
// Resizing in place, while dragging: the column, the layout and the spacers, without a redraw.
function applyColWidth(col: number) {
  geo(); sumColsFrom(col);
  const element = renderedCols.get(col);
  if (element) element.style.width = colWidth(col) + "px";
  // The pinned table width follows, so resizing doesn't reintroduce squeezing.
  syncSpacers();
  snapOverlays();
  if (editing && !editingAway()) placeCellEditor();
}
// While dragging a column or row edge the ring follows exactly, without gliding.
function snapOverlays() {
  selRing.classList.add("jump"); selRangeEl.classList.add("jump");
  positionActiveOverlays();
  void selRing.offsetWidth;
  selRing.classList.remove("jump"); selRangeEl.classList.remove("jump");
}
function startRowResize(row: number, e: MouseEvent) {
  const startY = e.clientY; const startH = rowHeight(row);
  const move = (ev: MouseEvent) => { const h = Math.max(18, startH + ev.clientY - startY); curSheet().rowHeights[row] = Math.round(h); applyRowHeight(row); };
  const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); queueStructure(); renderGrid(); };
  window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
}
function applyRowHeight(row: number) {
  const L = geo(), tr = renderedRows.get(row);
  measuredHeights(activeSheetId)?.delete(row);
  if (tr) tr.style.height = rowHeight(row) + "px";
  if (L.rowH[row]) { L.rowH[row] = tr ? tr.offsetHeight || rowHeight(row) : rowHeight(row); sumRowsFrom(row); }
  syncSpacers();
  snapOverlays();
  if (editing && !editingAway()) placeCellEditor();
}

// ── Fit to data ─────────────────────────────────────────────────────────────
// A column fits the widest text it shows (as displayed: formatted numbers, formula results),
// in each cell's own weight and size, plus the cell's padding and any filter button. An empty
// column goes back to the default width. Rows fit by dropping a custom height: wrapped text
// already sizes its row, so only cells with a larger font size need a taller one.
const fitMeasure = document.createElement("canvas").getContext("2d");
const FIT_MAX_W = 640;
function selectedHeaderLines(rows: boolean): number[] {
  const sh = curSheet(), lines = new Set<number>();
  for (const range of selectionRanges()) {
    const whole = rows ? range.c1 === 0 && range.c2 === sh.cols - 1 : range.r1 === 0 && range.r2 === sh.rows - 1;
    if (!whole) continue;
    for (let i = rows ? range.r1 : range.c1; i <= (rows ? range.r2 : range.c2); i++) lines.add(i);
  }
  return [...lines].sort((a, b) => a - b);
}
function fitColumns(columns: number[]) {
  const sh = curSheet(); if (!sh || !columns.length || !fitMeasure) return;
  const family = getComputedStyle(gridTable.querySelector("td.cell") || gridTable).fontFamily;
  const widest = new Map<number, number>();
  for (const [ref, cell] of Object.entries(curCells())) {
    if (cell.value == null || cell.value === "") continue;
    const rc = parseRef(ref); if (!rc || !columns.includes(rc.c) || rc.r >= sh.rows) continue;
    const fmt = shownFmt(cell) || {};
    const disp = displayValue(engine.computeRef(activeSheetId, ref), fmt);
    if (!disp.text) continue;
    fitMeasure.font = `${fmt.i ? "italic " : ""}${fmt.b ? 700 : disp.err ? 550 : 400} ${fmt.fs || 13}px ${family}`;
    // Unwrapped text shows a line break as a space; wrapped text is as wide as its longest line.
    const lines = fmt.wrap ? String(disp.text).split("\n") : [String(disp.text).replace(/\n/g, " ")];
    let width = 0;
    for (const line of lines) width = Math.max(width, fitMeasure.measureText(line).width);
    if (sh.filter?.row === rc.r && filterColumns(sh.filter).includes(rc.c)) width += 22;
    widest.set(rc.c, Math.max(widest.get(rc.c) || 0, width));
  }
  // An empty filter header still needs room for its button.
  if (sh.filter) for (const column of columns) if (!widest.has(column) && filterColumns(sh.filter).includes(column)) widest.set(column, 22);
  let changed = false;
  for (const column of columns) {
    const before = sh.colWidths[column];
    if (!widest.has(column)) delete sh.colWidths[column];
    else {
      const width = clamp(Math.ceil((widest.get(column) as number) + 10 + 8), 36, FIT_MAX_W);
      if (width === DEFAULT_COL_W) delete sh.colWidths[column]; else sh.colWidths[column] = width;
    }
    if (sh.colWidths[column] !== before) changed = true;
  }
  if (!changed) return;
  queueStructure();
  renderGrid(); // text that spills into neighbours is re-measured
}
function fitRows(rows: number[]) {
  const sh = curSheet(); if (!sh || !rows.length) return;
  const tallest = new Map<number, number>();
  for (const [ref, cell] of Object.entries(curCells())) {
    if (!cell.fmt?.fs || cell.value == null || cell.value === "") continue;
    const rc = parseRef(ref); if (!rc || !rows.includes(rc.r)) continue;
    tallest.set(rc.r, Math.max(tallest.get(rc.r) || 0, Math.ceil(cell.fmt.fs * 1.35) + 4));
  }
  let changed = false;
  for (const row of rows) {
    const before = sh.rowHeights[row], need = tallest.get(row) || 0;
    if (need > DEFAULT_ROW_H) sh.rowHeights[row] = need; else delete sh.rowHeights[row];
    if (sh.rowHeights[row] !== before) changed = true;
  }
  if (!changed) return;
  queueStructure();
  renderGrid();
}

// ── Moving rows and columns by their headers ──────────────────────────────
// Select whole columns (click, Shift-click, or drag across headers), then drag any selected
// header: a soft copy of the block follows the pointer and an accent bar shows where it will
// land; the sheet scrolls near its edges and Esc cancels. A click without a drag just selects
// that one column. Rows work the same way.
const moveGhost = el("div", { class: "move-ghost", "aria-hidden": "true" });
const moveLine = el("div", { class: "move-line", "aria-hidden": "true" });
gridScroll.append(moveGhost, moveLine);
/** A header drag in progress: the block of lines picked up, where the pointer is, and where it would land (`to`; null for nowhere new). */
interface HeaderMove {
  rows: boolean; from: number; count: number; index: number; blockStart: number; blockSize: number; grab: number;
  startX: number; startY: number; lastX: number; lastY: number; dragging: boolean; to: number | null; raf: number;
}
let headerMove: HeaderMove | null = null;
// "col" or "row" when the selection is one block of whole columns or rows that can be dragged.
function movableHeaderAxis(): "col" | "row" | null {
  const sh = curSheet();
  if (!sh || editing || extraRanges.length || sh.pivot) return null;
  const r = selRange();
  const allRows = r.r1 === 0 && r.r2 === sh.rows - 1, allCols = r.c1 === 0 && r.c2 === sh.cols - 1;
  return allRows && !allCols ? "col" : allCols && !allRows ? "row" : null;
}
function markMovableHeaders() {
  const axis = movableHeaderAxis(), r = selRange();
  for (const [c, th] of renderedColHeads) th.classList.toggle("movable", axis === "col" && c >= r.c1 && c <= r.c2);
  for (const [row, th] of renderedRowHeads) th.classList.toggle("movable", axis === "row" && row >= r.r1 && row <= r.r2);
}
function gridContentPoint(clientX: number, clientY: number): { x: number; y: number } {
  const rect = gridScroll.getBoundingClientRect();
  return { x: clientX - rect.left - gridScroll.clientLeft + gridScroll.scrollLeft, y: clientY - rect.top - gridScroll.clientTop + gridScroll.scrollTop };
}
function beginHeaderMove(rows: boolean, index: number, e: MouseEvent): boolean {
  const r = selRange();
  const from = rows ? r.r1 : r.c1, count = rows ? r.r2 - r.r1 + 1 : r.c2 - r.c1 + 1;
  // Positions come from the layout, in scroll-content coordinates (rows hidden by a filter take
  // no space), so the block can travel to lines that aren't drawn yet.
  const start = rows ? rowY : colX;
  const blockStart = start(from), blockSize = start(from + count) - blockStart;
  if (blockSize <= 0) return false;
  const p = gridContentPoint(e.clientX, e.clientY);
  headerMove = {
    rows, from, count, index, blockStart, blockSize, grab: (rows ? p.y : p.x) - blockStart,
    startX: e.clientX, startY: e.clientY, lastX: e.clientX, lastY: e.clientY, dragging: false, to: null, raf: 0,
  };
  window.addEventListener("mousemove", onHeaderMoveMove);
  window.addEventListener("mouseup", onHeaderMoveUp);
  window.addEventListener("keydown", onHeaderMoveKey, true);
  window.addEventListener("blur", cancelHeaderMove);
  gridScroll.addEventListener("scroll", updateHeaderMove, { passive: true });
  return true;
}
function onHeaderMoveMove(e: MouseEvent) {
  const m = headerMove; if (!m) return;
  m.lastX = e.clientX; m.lastY = e.clientY;
  if (!m.dragging) {
    if (Math.hypot(e.clientX - m.startX, e.clientY - m.startY) < 4) return;
    m.dragging = true;
    hideTip(); closePop(true);
    document.body.classList.add("header-moving");
    moveGhost.classList.add("show");
    m.raf = requestAnimationFrame(headerMoveAutoScroll);
  }
  updateHeaderMove();
}
function updateHeaderMove() {
  const m = headerMove; if (!m?.dragging) return;
  const p = gridContentPoint(m.lastX, m.lastY), along = m.rows ? p.y : p.x;
  const L = geo(), n = m.rows ? L.rows : L.cols, start = m.rows ? rowY : colX;
  const firstStart = start(0), end = start(n);
  const lead = clamp(along - m.grab, firstStart, Math.max(firstStart, end - m.blockSize));
  // Across the visible part of the grid only (not past a short sheet's last row or column).
  const spanTop = gridScroll.scrollTop, spanHeight = Math.max(0, Math.min(gridScroll.clientHeight, gridTable.offsetHeight - spanTop));
  const spanLeft = gridScroll.scrollLeft, spanWidth = Math.max(0, Math.min(gridScroll.clientWidth, gridTable.offsetWidth - spanLeft));
  if (m.rows) Object.assign(moveGhost.style, { left: spanLeft + "px", width: spanWidth + "px", top: lead + "px", height: m.blockSize + "px" });
  else Object.assign(moveGhost.style, { top: spanTop + "px", height: spanHeight + "px", left: lead + "px", width: m.blockSize + "px" });
  // The block lands before the line whose middle the pointer hasn't passed yet (past the last
  // line: after it; rows hidden by a filter are stepped over).
  const lastLine = m.rows ? rowAtBody(L.rowTop[L.rows]) : n - 1;
  const lineUnder = m.rows ? rowAtBody(along - L.headH) : colAtBody(along - HEAD_W);
  let to, at;
  if (along < start(lineUnder) + (start(lineUnder + 1) - start(lineUnder)) / 2) { to = lineUnder; at = start(lineUnder); }
  else {
    to = m.rows ? nextVisibleRow(lineUnder + 1) : lineUnder + 1;
    if (to >= n) to = lastLine + 1;
    at = start(to);
  }
  const noMove = to >= m.from && to <= m.from + m.count;
  m.to = noMove ? null : to;
  moveLine.classList.toggle("show", !noMove);
  if (m.rows) Object.assign(moveLine.style, { left: spanLeft + "px", width: spanWidth + "px", top: at - 1.5 + "px", height: "3px" });
  else Object.assign(moveLine.style, { top: spanTop + "px", height: spanHeight + "px", left: at - 1.5 + "px", width: "3px" });
}
// Near an edge of the grid (past the sticky headers) the sheet scrolls, faster closer in.
function headerMoveAutoScroll() {
  const m = headerMove; if (!m?.dragging) return;
  const rect = gridScroll.getBoundingClientRect(), zone = 36;
  const headTop = geo().headH;
  const speed = (distance: number) => Math.max(2, Math.round(((zone - distance) / zone) * 20));
  let dx = 0, dy = 0;
  if (m.rows) {
    if (m.lastY < rect.top + headTop + zone) dy = -speed(Math.max(0, m.lastY - rect.top - headTop));
    else if (m.lastY > rect.bottom - zone) dy = speed(Math.max(0, rect.bottom - m.lastY));
  } else {
    if (m.lastX < rect.left + HEAD_W + zone) dx = -speed(Math.max(0, m.lastX - rect.left - HEAD_W));
    else if (m.lastX > rect.right - zone) dx = speed(Math.max(0, rect.right - m.lastX));
  }
  if (dx) gridScroll.scrollLeft += dx;
  if (dy) gridScroll.scrollTop += dy;
  m.raf = requestAnimationFrame(headerMoveAutoScroll);
}
function endHeaderMove(): HeaderMove | null {
  const m = headerMove; if (!m) return null;
  headerMove = null;
  cancelAnimationFrame(m.raf);
  window.removeEventListener("mousemove", onHeaderMoveMove);
  window.removeEventListener("mouseup", onHeaderMoveUp);
  window.removeEventListener("keydown", onHeaderMoveKey, true);
  window.removeEventListener("blur", cancelHeaderMove);
  gridScroll.removeEventListener("scroll", updateHeaderMove);
  document.body.classList.remove("header-moving");
  moveGhost.classList.remove("show"); moveLine.classList.remove("show");
  return m;
}
function cancelHeaderMove() { endHeaderMove(); }
function onHeaderMoveKey(e: KeyboardEvent) {
  if (e.key !== "Escape") return;
  e.preventDefault(); e.stopPropagation();
  endHeaderMove();
}
function onHeaderMoveUp() {
  const m = endHeaderMove(); if (!m) return;
  const sh = curSheet();
  if (m.dragging) { if (m.to != null) moveLines(m.rows, m.from, m.count, m.to); return; }
  // No drag: a plain click on a selected header selects just that line.
  if (m.rows) setSelection({ r: m.index, c: 0 }, { r: m.index, c: sh.cols - 1 });
  else setSelection({ r: 0, c: m.index }, { r: sh.rows - 1, c: m.index });
}

// ===========================================================================
// Keyboard navigation & shortcuts
// ===========================================================================
function handleGridKeydown(e: KeyboardEvent) {
  if (editing || e.isComposing || e.keyCode === 229) return;
  const meta = e.ctrlKey || e.metaKey;
  const r = selRange();
  if (meta) {
    switch (e.key.toLowerCase()) {
      case "b": e.preventDefault(); toggleFmt("b"); return;
      case "i": e.preventDefault(); toggleFmt("i"); return;
      case "u": e.preventDefault(); toggleFmt("u"); return;
      case "z": e.preventDefault(); e.shiftKey ? redo() : undo(); return;
      case "y": e.preventDefault(); redo(); return;
      case "c": return; // handled by the clipboard copy event
      case "x": return; // handled by the clipboard cut event
      case "v": if (e.shiftKey) { pasteWithoutFormattingPending = true; clearTimeout(pasteModeTimer); pasteModeTimer = setTimeout(() => { pasteWithoutFormattingPending = false; }, 1200); } return; // handled by the native paste event
      case "a": e.preventDefault(); { const sh = curSheet(); setSelection({ r: sh.rows - 1, c: sh.cols - 1 }, { r: 0, c: 0 }); } return;
      case "arrowdown": e.preventDefault(); moveActive(jumpEdge(focus.r, focus.c, 1), focus.c, e.shiftKey); return;
      case "arrowup": e.preventDefault(); moveActive(jumpEdge(focus.r, focus.c, -1), focus.c, e.shiftKey); return;
      case "arrowright": e.preventDefault(); moveActive(focus.r, jumpEdgeCol(focus.r, focus.c, 1), e.shiftKey); return;
      case "arrowleft": e.preventDefault(); moveActive(focus.r, jumpEdgeCol(focus.r, focus.c, -1), e.shiftKey); return;
    }
  }
  // Alt+↓ on a filter's header opens that column's filter, as in Excel.
  if (e.altKey && e.key === "ArrowDown") {
    const trigger = gridScroll.querySelector<HTMLElement>(`td.cell[data-ref="${rcToRef(focus.r, focus.c)}"] .filter-trigger`);
    if (trigger) {
      e.preventDefault(); openFilterMenu(focus.c, trigger);
      openPop?.pop.querySelector<HTMLElement>("input, button, .mi")?.focus();
      return;
    }
  }
  switch (e.key) {
    case "ArrowUp": e.preventDefault(); moveActive(focus.r - 1, focus.c, e.shiftKey); break;
    case "ArrowDown": e.preventDefault(); moveActive(focus.r + 1, focus.c, e.shiftKey); break;
    case "ArrowLeft": e.preventDefault(); moveActive(focus.r, focus.c - 1, e.shiftKey); break;
    case "ArrowRight": e.preventDefault(); moveActive(focus.r, focus.c + 1, e.shiftKey); break;
    case "Tab": e.preventDefault(); moveWithinSelection(e.shiftKey ? -1 : 1, "h"); break;
    case "Enter": e.preventDefault(); if (r.r1 !== r.r2 || r.c1 !== r.c2) moveWithinSelection(e.shiftKey ? -1 : 1, "v"); else { startEdit(rcToRef(focus.r, focus.c), false); } break;
    case "F2": e.preventDefault(); startEdit(rcToRef(focus.r, focus.c), false); break;
    case "Home": e.preventDefault(); moveActive(focus.r, 0, e.shiftKey); break;
    case "End": e.preventDefault(); moveActive(focus.r, curSheet().cols - 1, e.shiftKey); break;
    case "PageDown": e.preventDefault(); moveActive(focus.r + pageRows(), focus.c, e.shiftKey); break;
    case "PageUp": e.preventDefault(); moveActive(focus.r - pageRows(), focus.c, e.shiftKey); break;
    case "Delete": case "Backspace": e.preventDefault(); deleteSelectionContents(); break;
    case "Escape": clearCopyMarquee(); if (findState?.open) closeFind(false); break;
    default:
      if (e.key.length === 1 && !meta && !e.altKey) { e.preventDefault(); startEdit(rcToRef(focus.r, focus.c), true, e.key); }
  }
}
gridScroll.addEventListener("keydown", handleGridKeydown);
// About one screenful of rows (at the default height), keeping a row of context.
function pageRows() { return Math.max(1, Math.floor((gridScroll.clientHeight - geo().headH) / DEFAULT_ROW_H) - 1); }
function jumpEdge(r: number, c: number, dr: number): number {
  const sh = curSheet();
  let nr = r + dr;
  const has = (rr: number) => { const v = cellRaw(rcToRef(rr, c)); return v !== "" && v != null; };
  if (nr < 0 || nr >= sh.rows) return r;
  if (has(r) && has(nr)) { while (nr + dr >= 0 && nr + dr < sh.rows && has(nr + dr)) nr += dr; return nr; }
  while (nr >= 0 && nr < sh.rows && !has(nr)) nr += dr;
  if (nr < 0 || nr >= sh.rows) return dr > 0 ? sh.rows - 1 : 0;
  return nr;
}
function jumpEdgeCol(r: number, c: number, dc: number): number {
  const sh = curSheet();
  let nc = c + dc;
  const has = (cc: number) => { const v = cellRaw(rcToRef(r, cc)); return v !== "" && v != null; };
  if (nc < 0 || nc >= sh.cols) return c;
  if (has(c) && has(nc)) { while (nc + dc >= 0 && nc + dc < sh.cols && has(nc + dc)) nc += dc; return nc; }
  while (nc >= 0 && nc < sh.cols && !has(nc)) nc += dc;
  if (nc < 0 || nc >= sh.cols) return dc > 0 ? sh.cols - 1 : 0;
  return nc;
}
function moveWithinSelection(dir: number, mode: "h" | "v") {
  const rng = selRange();
  const single = rng.r1 === rng.r2 && rng.c1 === rng.c2;
  if (single) { if (mode === "h") tabAlong(focus.r, focus.c, dir); else moveActive(focus.r + dir, focus.c); return; }
  let { r, c } = focus;
  if (mode === "h") { c += dir; if (c > rng.c2) { c = rng.c1; r++; if (r > rng.r2) r = rng.r1; } if (c < rng.c1) { c = rng.c2; r--; if (r < rng.r1) r = rng.r2; } }
  else { r += dir; if (r > rng.r2) { r = rng.r1; c++; if (c > rng.c2) c = rng.c1; } if (r < rng.r1) { r = rng.r2; c--; if (c < rng.c1) c = rng.c2; } }
  focus = { r, c }; updateSelectionUI(); scrollActiveIntoView(); sendPresence();
}
function deleteSelectionContents() {
  beginBatch();
  walkSelection((ref: string) => {
    const cell = getCell(ref);
    if (cell) { recordCell(activeSheetId, ref); if (cell.fmt) { setCellValue(ref, null); } else { const baseVersion = cell.version || 0; delete curCells()[ref]; queueCellOp(activeSheetId, ref, null, null, baseVersion); } }
  }, { existingOnly: true });
  commitBatch(); rebuildEngine([]); renderGrid(); schedulePivotRefreshes();
}

// ===========================================================================
// Copy / paste (TSV via clipboard)
// ===========================================================================
/** One copied cell as the clipboard snapshot holds it (`value: null` for an empty source). */
interface ClipboardCell { value: string | null; fmt: CellFmt | null; sourceRef: string }
/** What this tab last copied or cut: the text it wrote, the cells behind it, and the private token. */
interface ClipboardSnapshot {
  tsv: string;
  cells: (ClipboardCell | null)[][];
  refs: (string | null)[][];
  trimmed: "rows" | "columns" | "both" | null;
  sheetId: string;
  cut: boolean;
  cancelled: boolean;
  token: string;
}
let copyFallback: ClipboardSnapshot | null = null;
// Whole-row and whole-column selections are trimmed to the populated extent (a whole-sheet
// selection in both directions); `trimmed` records which axis, so a paste doesn't mistake the trimmed block for a pattern to repeat.
function clipboardReferenceMatrix(): { refs: (string | null)[][]; trimmed: ClipboardSnapshot["trimmed"] } {
  const ranges = selectionRanges();
  const sheet = curSheet();
  const allRows = ranges.every((range) => range.c1 === 0 && range.c2 === sheet.cols - 1);
  const allColumns = ranges.every((range) => range.r1 === 0 && range.r2 === sheet.rows - 1);
  return { refs: clipboardReferences(ranges, sheet, allRows, allColumns), trimmed: allRows && allColumns ? "both" : allRows ? "rows" : allColumns ? "columns" : null };
}
function clipboardReferences(ranges: Area[], sheet: SheetMeta, allRows: boolean, allColumns: boolean): (string | null)[][] {
  // The populated extent comes from the cells that exist: walking every position of a whole
  // row or column selection on a big sheet would take tens of millions of steps.
  const shownPositions = () => Object.keys(curCells()).map(parseRef)
    .filter((p): p is RC => !!p && p.r < sheet.rows && p.c < sheet.cols && !isVisuallyEmptyCell(p.r, p.c));
  if (allRows && allColumns) {
    let lastRow = 0, lastColumn = 0;
    for (const p of shownPositions()) { lastRow = Math.max(lastRow, p.r); lastColumn = Math.max(lastColumn, p.c); }
    return Array.from({ length: lastRow + 1 }, (_, row) => Array.from({ length: lastColumn + 1 }, (_, column) => rcToRef(row, column)));
  }
  if (allRows) {
    const rows = [...new Set(ranges.flatMap((range) => Array.from({ length: range.r2 - range.r1 + 1 }, (_, index) => range.r1 + index)))].sort((a, b) => a - b);
    const selected = new Set(rows);
    let lastColumn = 0;
    for (const p of shownPositions()) if (selected.has(p.r)) lastColumn = Math.max(lastColumn, p.c);
    return rows.map((row) => Array.from({ length: lastColumn + 1 }, (_, column) => rcToRef(row, column)));
  }
  if (allColumns) {
    const columns = [...new Set(ranges.flatMap((range) => Array.from({ length: range.c2 - range.c1 + 1 }, (_, index) => range.c1 + index)))].sort((a, b) => a - b);
    const selected = new Set(columns);
    let lastRow = 0;
    for (const p of shownPositions()) if (selected.has(p.c)) lastRow = Math.max(lastRow, p.r);
    return Array.from({ length: lastRow + 1 }, (_, row) => columns.map((column) => rcToRef(row, column)));
  }
  if (ranges.length === 1) {
    const range = ranges[0];
    return Array.from({ length: range.r2 - range.r1 + 1 }, (_, row) => Array.from({ length: range.c2 - range.c1 + 1 }, (_, column) => rcToRef(range.r1 + row, range.c1 + column)));
  }
  const bounds = ranges.reduce((out, range) => ({ r1: Math.min(out.r1, range.r1), c1: Math.min(out.c1, range.c1), r2: Math.max(out.r2, range.r2), c2: Math.max(out.c2, range.c2) }), { r1: Infinity, c1: Infinity, r2: -1, c2: -1 });
  return Array.from({ length: bounds.r2 - bounds.r1 + 1 }, (_, row) => Array.from({ length: bounds.c2 - bounds.c1 + 1 }, (_, column) => {
    const r = bounds.r1 + row, c = bounds.c1 + column;
    return ranges.some((range) => r >= range.r1 && r <= range.r2 && c >= range.c1 && c <= range.c2) ? rcToRef(r, c) : null;
  }));
}
// The clipboard gets what each cell shows, as Excel and Google Sheets put it there: a field
// holding a tab or line break (or starting with a quote) is quoted, with its quotes doubled.
function clipboardCellText(ref: string | null): string {
  if (!ref) return "";
  const cell = getCell(ref); if (!cell) return "";
  const text = displayValue(engine.computeRef(activeSheetId, ref), cell.fmt).text;
  return /[\t\n]|^"/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
/** Tab-separated rows, with fields quoted as `clipboardCellText` (and Excel) write them. */
function parseClipboardText(text: string): string[][] {
  const rows: string[][] = [[]];
  let i = 0;
  for (;;) {
    let field = "", quoted = false;
    if (text[i] === '"') {
      let j = i + 1, inner = "";
      for (; j < text.length; j++) {
        if (text[j] !== '"') inner += text[j];
        else if (text[j + 1] === '"') { inner += '"'; j++; }
        else break;
      }
      // Only a closing quote at the field's end makes it quoted; otherwise the quote is text.
      if (j < text.length && (j + 1 === text.length || text[j + 1] === "\t" || text[j + 1] === "\n")) { field = inner; i = j + 1; quoted = true; }
    }
    if (!quoted) {
      let end = i;
      while (end < text.length && text[end] !== "\t" && text[end] !== "\n") end++;
      field = text.slice(i, end); i = end;
    }
    rows[rows.length - 1].push(field);
    if (i >= text.length) return rows;
    if (text[i++] === "\n") rows.push([]);
  }
}
function prepareClipboard(cut = false) {
  const { refs, trimmed } = clipboardReferenceMatrix();
  const cells = refs.map((row) => row.map((ref) => {
    const cell = ref ? getCell(ref) : null;
    return cell && ref ? { value: cell.value, fmt: cell.fmt, sourceRef: ref } : (ref ? { value: null, fmt: null, sourceRef: ref } : null);
  }));
  const tsv = refs.map((row) => row.map(clipboardCellText).join("\t")).join("\n");
  copyFallback = { tsv, cells, refs, trimmed, sheetId: activeSheetId, cut, cancelled: false, token: Math.random().toString(36).slice(2) };
  return tsv;
}
// Our own clipboard writes carry a token in a private type: a paste whose text merely equals
// the last cut isn't enough to make that cut move (and delete) cells.
const CLIPBOARD_TOKEN_TYPE = "application/x-workspace-sheets";
function writeGridClipboard(event: ClipboardEvent, cut: boolean) {
  if (editing || !event.clipboardData) return;
  event.preventDefault();
  event.clipboardData.setData("text/plain", prepareClipboard(cut));
  const clipboard = copyFallback;
  if (clipboard) try { event.clipboardData.setData(CLIPBOARD_TOKEN_TYPE, clipboard.token); } catch (e) { /* custom types unsupported */ }
}
function invalidateMissingCutSource() {
  // The token is kept so a native paste can't reinterpret a cancelled cut as an outside copy.
  if (copyFallback?.cut && !model.sheets[copyFallback.sheetId]) copyFallback.cancelled = true;
}
function requestGridClipboard(cut = false) {
  armEditorCapture(true);
  try { document.execCommand(cut ? "cut" : "copy"); }
  catch (error) { setStatus("bad", "Clipboard unavailable"); }
}
function pasteFromMenu(keepFormatting: boolean) {
  if (copyFallback?.tsv != null) {
    pasteText(copyFallback.tsv, { keepFormatting, token: copyFallback.token });
    return;
  }
  // Permissions Policy prevents menu-click handlers from reading the system
  // clipboard. Native keyboard paste still supplies ClipboardEvent data.
  toast(`Press ${combo(...(keepFormatting ? ["mod", "V"] : ["mod", "shift", "V"])).join(isMac ? "" : "+")} to paste from outside`, "bad");
}
gridScroll.addEventListener("copy", (event) => writeGridClipboard(event, false));
gridScroll.addEventListener("cut", (event) => writeGridClipboard(event, true));
function clearCopyMarquee() { copyFallback = null; }

let pasteWithoutFormattingPending = false;
let pasteModeTimer: ReturnType<typeof setTimeout> | undefined;
gridScroll.addEventListener("paste", (e) => {
  if (editing) return;
  e.preventDefault();
  const text = (e.clipboardData && e.clipboardData.getData("text/plain")) || "";
  let token: string | null = null;
  try { token = (e.clipboardData && e.clipboardData.getData(CLIPBOARD_TOKEN_TYPE)) || null; } catch (err) { token = null; }
  const keepFormatting = !pasteWithoutFormattingPending;
  pasteWithoutFormattingPending = false; clearTimeout(pasteModeTimer);
  pasteText(text, { keepFormatting, token });
});
function shiftedCopyFormula(value: string, sourceRef: string, targetRef: string, isCut: boolean): string {
  if (isCut || !value?.startsWith("=") || !sourceRef) return value;
  const source = parseRef(sourceRef), target = parseRef(targetRef);
  if (!source || !target) return value;
  return shiftFormulaReferences(value, target.r - source.r, target.c - source.c);
}
// The sheet a reference endpoint points into: its own prefix, or the formula's sheet. A prefix
// naming no sheet resolves to "".
function formulaReferenceSheetId(ref: string, defaultSheetId: string): string {
  const bang = ref.lastIndexOf("!");
  if (bang < 0) return defaultSheetId;
  const name = referenceSheetName(ref.slice(0, bang + 1));
  return model.sheetOrder.find((id) => model.sheets[id].name.toLowerCase() === name) || "";
}
/** Where a cut cell lands. */
interface CutTarget { sheetId: string; ref: string }
/** A cut cell's source position and how far (and to which sheet) it moves. */
interface CutRangeMove { r: number; c: number; sheetId: string; rowDelta: number; columnDelta: number }
function indexCutRangeMoves(cutSheetId: string, moves: Map<string, CutTarget>, unchangedSources: Set<string>): Map<string, CutRangeMove> {
  const index = new Map<string, CutRangeMove>();
  for (const [ref, target] of moves) {
    if (!unchangedSources.has(ref) || target.sheetId === cutSheetId && target.ref === ref) continue;
    const source = parseRef(ref), destination = parseRef(target.ref);
    if (source && destination) index.set(ref, { ...source, sheetId: target.sheetId, rowDelta: destination.r - source.r, columnDelta: destination.c - source.c });
  }
  return index;
}
// Formulas have rectangles, not unions of separately moved cells. A range is accepted only when
// none of its cells move, or every one follows the same move to the same sheet.
function formulaRangesFollowCut(value: string, formulaSheetId: string, cutSheetId: string, moves: Map<string, CutRangeMove>, checks: Map<string, boolean>): boolean {
  for (const reference of formulaReferences(value)) {
    const endpoints = [...formulaReferences("=" + reference.text, true)];
    if (endpoints.length !== 2) continue;
    const sheetId = formulaReferenceSheetId(endpoints[0].text, formulaSheetId);
    if (sheetId !== cutSheetId) continue;
    const first = parseRef(endpoints[0].text.slice(endpoints[0].text.lastIndexOf("!") + 1));
    const last = parseRef(endpoints[1].text.slice(endpoints[1].text.lastIndexOf("!") + 1));
    if (!first || !last) continue;
    const r1 = Math.min(first.r, last.r), r2 = Math.max(first.r, last.r), c1 = Math.min(first.c, last.c), c2 = Math.max(first.c, last.c);
    const lastSheetId = formulaReferenceSheetId(endpoints[1].text, sheetId);
    const area = (r2 - r1 + 1) * (c2 - c1 + 1), key = `${r1}:${r2}:${c1}:${c2}:${lastSheetId}`;
    const checked = checks.get(key);
    if (checked !== undefined) { if (!checked) return false; continue; }
    let count = 0, targetSheetId = "", rowDelta = 0, columnDelta = 0;
    let coherent = lastSheetId === sheetId;
    const includeMove = (move: CutRangeMove) => {
      if (count === 0) { targetSheetId = move.sheetId; rowDelta = move.rowDelta; columnDelta = move.columnDelta; }
      else if (move.sheetId !== targetSheetId || move.rowDelta !== rowDelta || move.columnDelta !== columnDelta) coherent = false;
      count++;
    };
    // Small ranges look cells up directly; a huge one visits only the cut's cells. Identical
    // ranges in other formulas reuse the result.
    if (area <= moves.size) {
      for (let row = r1; row <= r2; row++) for (let column = c1; column <= c2; column++) {
        const move = moves.get(rcToRef(row, column));
        if (move) includeMove(move);
      }
    } else for (const move of moves.values()) {
      if (move.r >= r1 && move.r <= r2 && move.c >= c1 && move.c <= c2) includeMove(move);
    }
    const valid = count === 0 || coherent && count === area;
    checks.set(key, valid);
    if (!valid) return false;
  }
  return true;
}
// A cut follows the cells themselves, not relative offsets: references into moved cells point
// at their new home (on whichever sheet), and `$` locks are kept for later copies and fills.
function remapCutFormula(value: string, formulaSourceSheetId: string, formulaTargetSheetId: string, cutSheetId: string, moves: Map<string, CutTarget>, unchangedSources: Set<string>): string {
  let result = "", start = 0;
  for (const reference of formulaReferences(value)) {
    let replacement = "", end = 0, referencedSheetId = formulaSourceSheetId, resultSheetId = formulaTargetSheetId;
    for (const endpoint of formulaReferences("=" + reference.text, true)) {
      const bang = endpoint.text.lastIndexOf("!");
      referencedSheetId = formulaReferenceSheetId(endpoint.text, referencedSheetId);
      const body = endpoint.text.slice(bang + 1), position = parseRef(body.replace(/\$/g, ""));
      const sourceRef = position ? rcToRef(position.r, position.c) : "";
      const destination = referencedSheetId === cutSheetId && unchangedSources.has(sourceRef) ? moves.get(sourceRef) : undefined;
      let text = endpoint.text;
      if (destination || bang < 0 && referencedSheetId && referencedSheetId !== resultSheetId) {
        const sheetId = destination?.sheetId || referencedSheetId;
        const ref = parseRef(destination?.ref || sourceRef);
        const locks = /^(\$?)[A-Z]+(\$?)\d+$/i.exec(body);
        if (ref && locks && model.sheets[sheetId]) {
          const prefix = sheetId === resultSheetId && bang < 0 ? "" : "'" + model.sheets[sheetId].name.replace(/'/g, "''") + "'!";
          text = prefix + locks[1] + colToLetter(ref.c) + locks[2] + (ref.r + 1);
        }
      }
      resultSheetId = destination?.sheetId || referencedSheetId;
      replacement += reference.text.slice(end, endpoint.start - 1) + text;
      end = endpoint.end - 1;
    }
    result += value.slice(start, reference.start) + replacement + reference.text.slice(end);
    start = reference.end;
  }
  return result + value.slice(start);
}
// A cut source is removed only while it still holds what was cut; an edit made in between wins.
function cutSourceUnchanged(sheetId: string, snapshot: ClipboardCell): boolean {
  const current = model.cells[sheetId]?.[snapshot.sourceRef];
  return (current?.value ?? null) === snapshot.value && JSON.stringify(current?.fmt ?? null) === JSON.stringify(snapshot.fmt ?? null);
}
function clearStoredCell(sheetId: string, ref: string) {
  const cells = model.cells[sheetId] || (model.cells[sheetId] = {});
  const existing = cells[ref]; if (!existing) return;
  recordCell(sheetId, ref);
  const baseVersion = existing.version || 0;
  delete cells[ref]; queueCellOp(sheetId, ref, null, null, baseVersion);
}
function pasteText(text: string, { keepFormatting = true, token = null }: { keepFormatting?: boolean; token?: string | null } = {}) {
  const normalized = text.replace(/\r/g, "");
  invalidateMissingCutSource();
  // Matching text identifies our own copy; a cut (which removes its source) needs the token.
  const clipboard = copyFallback;
  const useSnapshot = clipboard && (token ? token === clipboard.token
    : !clipboard.cut && clipboard.tsv.replace(/\r/g, "") === normalized) ? clipboard : null;
  if (useSnapshot?.cut && useSnapshot.cancelled) { toast("That sheet was deleted; copy or cut again", "bad"); return; }
  const moving = !!useSnapshot?.cut;
  const moves = new Map<string, CutTarget>();
  // Checked before any destination is written: overlapping moves overwrite other sources.
  const unchangedSources = new Set<string>();
  if (useSnapshot && moving) for (const row of useSnapshot.cells) for (const snapshot of row) {
    if (snapshot && cutSourceUnchanged(useSnapshot.sheetId, snapshot)) unchangedSources.add(snapshot.sourceRef);
  }
  // Our own cells may contain tabs or line breaks; only outside text sets the dimensions.
  const values = useSnapshot ? null : parseClipboardText(normalized.replace(/\n$/, ""));
  const sourceHeight = useSnapshot ? useSnapshot.cells.length : (values as string[][]).length;
  const sourceWidth = (useSnapshot ? useSnapshot.cells : values as string[][]).reduce((widest, row) => Math.max(widest, row.length), 1);
  const targetRanges = selectionRanges();
  // Pasting into one place grows the sheet to fit what's pasted, up to the grid's limits.
  if (targetRanges.length === 1) {
    const sh = curSheet(), target = targetRanges[0];
    const needRows = Math.min(MAX_ROWS, target.r1 + sourceHeight), needCols = Math.min(MAX_COLS, target.c1 + sourceWidth);
    if (needRows > sh.rows || needCols > sh.cols) {
      sh.rows = Math.max(sh.rows, needRows); sh.cols = Math.max(sh.cols, needCols);
      queueStructure();
    }
    if (target.r1 + sourceHeight > MAX_ROWS || target.c1 + sourceWidth > MAX_COLS) {
      toast(`A sheet holds up to ${MAX_ROWS.toLocaleString()} rows and ${MAX_COLS} columns; the rest wasn't pasted`, "bad");
    }
  }
  const destinationRefs = new Set<string>();
  if (useSnapshot && moving) {
    // The exact, single-use move map, clipped to the grid, before touching anything.
    for (const target of targetRanges) for (let i = 0; i < sourceHeight; i++) for (let j = 0; j < sourceWidth; j++) {
      const row = target.r1 + i, column = target.c1 + j;
      if (row > target.r2 && targetRanges.length > 1 || column > target.c2 && targetRanges.length > 1) continue;
      if (row >= curSheet().rows || column >= curSheet().cols) continue;
      const snapshot = useSnapshot.cells[i]?.[j];
      if (!snapshot || moves.has(snapshot.sourceRef)) continue;
      const ref = rcToRef(row, column);
      if (destinationRefs.has(activeSheetId + "!" + ref)) { toast("Those paste areas overlap; choose separate ones", "bad"); return; }
      destinationRefs.add(activeSheetId + "!" + ref);
      moves.set(snapshot.sourceRef, { sheetId: activeSheetId, ref });
    }
    const rangeMoves = indexCutRangeMoves(useSnapshot.sheetId, moves, unchangedSources);
    const rangeChecks = new Map<string, boolean>();
    let safe = true;
    for (const row of useSnapshot.cells) for (const snapshot of row) {
      if (snapshot?.value?.startsWith("=") && moves.has(snapshot.sourceRef) && !formulaRangesFollowCut(snapshot.value, useSnapshot.sheetId, useSnapshot.sheetId, rangeMoves, rangeChecks)) safe = false;
    }
    for (const sheetId of model.sheetOrder) for (const [ref, cell] of Object.entries(model.cells[sheetId] || {})) {
      if (destinationRefs.has(sheetId + "!" + ref) || sheetId === useSnapshot.sheetId && unchangedSources.has(ref) && moves.has(ref)) continue;
      if (cell.value?.startsWith("=") && !formulaRangesFollowCut(cell.value, sheetId, useSnapshot.sheetId, rangeMoves, rangeChecks)) safe = false;
    }
    if (!safe) { toast("A formula uses part of what you cut; move the whole range together", "bad"); return; }
  }
  beginBatch();
  for (const target of targetRanges) {
    const targetHeight = target.r2 - target.r1 + 1, targetWidth = target.c2 - target.c1 + 1;
    // A trimmed whole-row copy keeps its own width (and a whole-column copy its height): the
    // trim isn't a pattern to repeat across the destination.
    const trimmed = useSnapshot?.trimmed;
    const trimmedRows = trimmed === "rows" || trimmed === "both", trimmedColumns = trimmed === "columns" || trimmed === "both";
    const widthFits = trimmedRows || (targetWidth >= sourceWidth && targetWidth % sourceWidth === 0);
    const heightFits = trimmedColumns || (targetHeight >= sourceHeight && targetHeight % sourceHeight === 0);
    // A cut moves its cells once; it never repeats them across a larger destination.
    const repeat = !moving && ((sourceHeight === 1 && sourceWidth === 1 && !trimmedRows && !trimmedColumns) || (widthFits && heightFits));
    const pasteHeight = repeat && !trimmedColumns ? targetHeight : sourceHeight;
    const pasteWidth = repeat && !trimmedRows ? targetWidth : sourceWidth;
    for (let i = 0; i < pasteHeight; i++) for (let j = 0; j < pasteWidth; j++) {
      const row = target.r1 + i, column = target.c1 + j;
      if (row > target.r2 && targetRanges.length > 1 || column > target.c2 && targetRanges.length > 1) continue;
      if (row >= curSheet().rows || column >= curSheet().cols) continue;
      const sourceRow = i % sourceHeight, sourceColumn = j % sourceWidth;
      const ref = rcToRef(row, column);
      const snapshot = useSnapshot?.cells[sourceRow]?.[sourceColumn];
      if (moving && (!snapshot || moves.get(snapshot.sourceRef)?.ref !== ref)) continue;
      destinationRefs.add(activeSheetId + "!" + ref);
      if (useSnapshot && keepFormatting) {
        recordCell(activeSheetId, ref);
        if (snapshot && snapshot.value != null) {
          const existing = getCell(ref);
          const value = shiftedCopyFormula(snapshot.value, snapshot.sourceRef, ref, useSnapshot.cut);
          curCells()[ref] = { value, fmt: snapshot.fmt, version: existing?.version || 0 };
          queueCellOp(activeSheetId, ref, value, snapshot.fmt, curCells()[ref].version);
        } else clearStoredCell(activeSheetId, ref);
      } else if (useSnapshot && !keepFormatting) {
        const value = snapshot && snapshot.value != null ? shiftedCopyFormula(snapshot.value, snapshot.sourceRef, ref, useSnapshot.cut) : "";
        setCellValue(ref, value === "" ? null : value);
      } else {
        const value = (values as string[][])[sourceRow]?.[sourceColumn] ?? "";
        setCellValue(ref, value === "" ? null : value);
      }
    }
  }
  if (useSnapshot && moving) {
    // Only unchanged sources that were actually pasted are cleared, never an overlapping destination.
    for (const sourceRef of moves.keys()) {
      if (unchangedSources.has(sourceRef) && !destinationRefs.has(useSnapshot.sheetId + "!" + sourceRef)) clearStoredCell(useSnapshot.sheetId, sourceRef);
    }
    // With every destination written, moved formulas and formulas elsewhere in the workbook
    // follow references into the cells that moved.
    for (const sheetId of model.sheetOrder) for (const [ref, cell] of Object.entries(model.cells[sheetId] || {})) {
      if (!cell.value?.startsWith("=")) continue;
      const formulaSourceSheetId = destinationRefs.has(sheetId + "!" + ref) ? useSnapshot.sheetId : sheetId;
      const value = remapCutFormula(cell.value, formulaSourceSheetId, sheetId, useSnapshot.sheetId, moves, unchangedSources);
      if (value === cell.value) continue;
      recordCell(sheetId, ref);
      cell.value = value;
      queueCellOp(sheetId, ref, value, cell.fmt, cell.version || 0);
    }
    copyFallback = null;
  }
  commitBatch(); rebuildEngine([]); renderGrid(); schedulePivotRefreshes();
}

// ===========================================================================
// Name box & formula bar interactions
// ===========================================================================
nameBox.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    const v = nameBox.value.trim().toUpperCase();
    const range = /^([A-Z]+\d+):([A-Z]+\d+)$/.exec(v);
    if (range) { const a = parseRef(range[1]), b = parseRef(range[2]); if (a && b) { setSelection({ r: b.r, c: b.c }, { r: a.r, c: a.c }); scrollActiveIntoView(); } }
    else { const rc = parseRef(v); if (rc) moveActive(rc.r, rc.c); }
    // Mid-edit, typing goes back to the formula, not to a grid that ignores keys while editing.
    if (editing) focusEditingSurface(); else gridScroll.focus();
  }
});
formulaInput.addEventListener("focus", () => {
  if (!editing) startEdit(rcToRef(focus.r, focus.c), false, null, false, true);
  else if (formulaAssist.style.display !== "none") requestAnimationFrame(positionFormulaAssist); // follow the caret up here
});
// …and back down to the cell when you return to typing there.
cellEditor.addEventListener("focus", () => { if (formulaAssist.style.display !== "none") requestAnimationFrame(positionFormulaAssist); });
function syncFormulaInputCaretToEditor() {
  if (!editing || document.activeElement !== formulaInput) return;
  const start = formulaInput.selectionStart ?? formulaInput.value.length;
  const end = formulaInput.selectionEnd ?? start;
  cellEditor.setSelectionRange(start, end); syncFormulaPickFromCaret(); updateFormulaAssist();
}
formulaInput.addEventListener("input", () => {
  if (editing) {
    clearFormulaPick(); cellEditor.value = formulaInput.value;
    const start = formulaInput.selectionStart ?? formulaInput.value.length, end = formulaInput.selectionEnd ?? start;
    cellEditor.setSelectionRange(start, end); syncEditorSize(); updateFormulaAssist();
  }
});
formulaInput.addEventListener("click", syncFormulaInputCaretToEditor);
formulaInput.addEventListener("select", syncFormulaInputCaretToEditor);
// Set when an arrow key moved a picked reference rather than the caret (see keydown below), so
// the keyup doesn't re-read the pick from the text and lose which corner a Shift+arrow anchors.
let formulaBarArrowPicked = false;
formulaInput.addEventListener("keyup", (e) => {
  // Letting go of a modifier moves nothing.
  if (["Shift", "Control", "Meta", "Alt"].includes(e.key)) return;
  if (formulaBarArrowPicked) { formulaBarArrowPicked = false; return; }
  // Moving through the suggestions isn't a caret move; don't rebuild the list.
  if (formulaAssistItems.length && ["ArrowUp", "ArrowDown"].includes(e.key)) return;
  syncFormulaInputCaretToEditor();
});
formulaInput.addEventListener("keydown", (e) => {
  if (imeComposing || e.isComposing || e.keyCode === 229) return;
  // The suggestions under the formula bar work the same as under a cell.
  if (editing && formulaAssistItems.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) { e.preventDefault(); moveFormulaSuggestion(e.key === "ArrowDown" ? 1 : -1); return; }
  if (editing && formulaAssistItems.length && (e.key === "Tab" || e.key === "Enter")) {
    e.preventDefault();
    cellEditor.setSelectionRange(formulaInput.selectionStart, formulaInput.selectionEnd);
    acceptFormulaSuggestion();
    return;
  }
  if (e.key === "Escape" && formulaAssist.style.display !== "none") { e.preventDefault(); e.stopPropagation(); closeFormulaAssist(); return; }
  if (editing && (e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "l") {
    e.preventDefault(); cellEditor.setSelectionRange(formulaInput.selectionStart, formulaInput.selectionEnd); syncFormulaPickFromCaret(); cycleAbsoluteReference(); return;
  }
  if (editing && formulaInput.value.startsWith("=") && e.key === "," && !formulaCursorInQuote(formulaInput.value, formulaInput.selectionStart)) {
    e.preventDefault(); cellEditor.setSelectionRange(formulaInput.selectionStart, formulaInput.selectionEnd); insertFormulaComma(); return;
  }
  if (editing && formulaInput.value.startsWith("=") && e.key === ")" && formulaInput.value[formulaInput.selectionStart!] === ")") {
    e.preventDefault();
    const next = formulaInput.selectionStart! + 1;
    formulaInput.setSelectionRange(next, next);
    cellEditor.setSelectionRange(next, next);
    syncFormulaPickFromCaret();
    updateFormulaAssist();
    return;
  }
  // On another sheet, arrows point at cells there, as in the cell itself.
  if (editingAway() && editingFormula() && !e.altKey && !e.ctrlKey && !e.metaKey && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) {
    const caret = formulaInput.selectionStart ?? formulaInput.value.length;
    if (caretTakesReference(formulaInput.value, caret, formulaInput.selectionEnd ?? caret)) {
      e.preventDefault();
      cellEditor.setSelectionRange(caret, caret);
      const directions: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
      moveFormulaPickByKeyboard(directions[e.key][0], directions[e.key][1], e.shiftKey);
      formulaBarArrowPicked = true;
      return;
    }
  }
  if (e.key === "Enter") { e.preventDefault(); commitEdit("down"); }
  else if (e.key === "Tab" && editing) { e.preventDefault(); commitEdit(e.shiftKey ? "left" : "right"); }
  else if (e.key === "Escape") { e.preventDefault(); cancelEdit(); }
});

// The browser tab shows the workbook, or the active sheet when it's untitled.
function updateTabTitle() {
  const title = model.title && model.title !== "Untitled spreadsheet" ? model.title : curSheet()?.name;
  document.title = title ? String(title).slice(0, 60) : "Untitled spreadsheet";
}

// ===========================================================================
// Insert-function menu
// ===========================================================================
function openFunctionMenu(owner: HTMLElement = fxBtn) {
  const groups = {
    "Math": ["SUM", "AVERAGE", "COUNT", "MAX", "MIN", "PRODUCT", "ROUND", "ABS", "SQRT", "MOD", "POWER"],
    "Statistical": ["MEDIAN", "STDEV", "VAR", "COUNTA", "COUNTIF", "SUMIF", "SUMIFS", "COUNTIFS", "RANK", "LARGE"],
    "Logical": ["IF", "IFS", "IFERROR", "AND", "OR", "NOT", "SWITCH"],
    "Text": ["CONCAT", "TEXTJOIN", "LEFT", "RIGHT", "MID", "LEN", "UPPER", "LOWER", "TRIM", "SUBSTITUTE", "TEXT", "HYPERLINK"],
    "Lookup": ["VLOOKUP", "HLOOKUP", "INDEX", "MATCH", "CHOOSE", "LOOKUP"],
    "Date": ["TODAY", "NOW", "DATE", "YEAR", "MONTH", "DAY", "WEEKDAY", "EDATE", "DATEDIF"],
  };
  const menu = el("div", { class: "fn-wrap" });
  const search = el("input", { class: "fn-search", type: "search", placeholder: "Search functions", "aria-label": "Search functions" });
  menu.appendChild(el("div", { class: "pop-search" }, [el("span", { html: svg(ICONS.search, 15) }), search]));
  const groupRecords: { group: HTMLElement; header: HTMLButtonElement; items: { name: string; element: HTMLElement }[] }[] = [];
  for (const [name, functions] of Object.entries(groups)) {
    const group = el("section", { class: "fn-group" });
    const header = el("button", { class: "fn-head", type: "button", "aria-expanded": "false" }, [
      el("span", { class: "fn-head-label" }, name),
      el("span", { class: "fn-head-count" }, String(functions.length)),
      el("span", { class: "fn-chev", html: svg(ICONS.chevron, 13) }),
    ]);
    const items = el("div", { class: "fn-items" });
    const itemRecords: { name: string; element: HTMLElement }[] = [];
    for (const fn of functions) {
      const item = menuItem({ label: fn, md: (functionHelp(fn)?.[0] || "").replace(/^[^(]*/, "").slice(0, 26), onSelect: () => insertFunction(fn) });
      items.appendChild(item); itemRecords.push({ name: fn, element: item });
    }
    header.addEventListener("click", () => {
      if (search.value.trim()) return;
      const open = !group.classList.contains("open");
      group.classList.toggle("open", open); header.setAttribute("aria-expanded", String(open));
    });
    group.append(header, items); menu.appendChild(group);
    groupRecords.push({ group, header, items: itemRecords });
  }
  const empty = el("div", { class: "fn-no-results" }, "No matching functions"); empty.style.display = "none"; menu.appendChild(empty);
  search.addEventListener("input", () => {
    const query = search.value.trim().toUpperCase(); let matches = 0;
    for (const record of groupRecords) {
      let groupMatches = 0;
      for (const item of record.items) {
        const visible = !query || item.name.includes(query);
        item.element.style.display = visible ? "" : "none";
        if (visible) groupMatches++;
      }
      record.group.style.display = groupMatches ? "" : "none";
      record.group.classList.toggle("open", !!query);
      record.header.setAttribute("aria-expanded", String(!!query));
      matches += groupMatches;
    }
    empty.style.display = matches ? "none" : "block";
  });
  // Enter inserts the first visible match.
  search.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const first = groupRecords.flatMap((g) => g.items).find((item) => item.element.style.display !== "none" && search.value.trim());
    if (first) { closePop(true); insertFunction(first.name); }
  });
  groupRecords[0]?.group.classList.add("open");
  groupRecords[0]?.header.setAttribute("aria-expanded", "true");
  showPop([menu], owner.getBoundingClientRect(), { owner, kind: "dialog", className: "fn-menu" });
  if (!coarsePointer) requestAnimationFrame(() => search.focus({ preventScroll: true }));
}
function insertFunction(name: string) {
  // Mid-formula (on any sheet), the function goes in at the caret instead of starting over.
  if (editingFormula()) {
    const start = cellEditor.selectionStart ?? cellEditor.value.length, end = cellEditor.selectionEnd ?? start;
    clearFormulaPick();
    cellEditor.value = cellEditor.value.slice(0, start) + name + "()" + cellEditor.value.slice(end);
    const caret = start + name.length + 1;
    cellEditor.setSelectionRange(caret, caret);
    formulaInput.value = cellEditor.value;
    focusEditingSurface(); formulaInput.setSelectionRange(caret, caret);
    syncEditorSize(); updateFormulaAssist();
    return;
  }
  // Typing plain text: the function replaces it (back on its own sheet if need be).
  if (editingAway()) returnToEditingCell();
  const ref = rcToRef(focus.r, focus.c);
  startEdit(ref, true, "=" + name + "()");
  const cursor = name.length + 2;
  cellEditor.setSelectionRange(cursor, cursor); updateFormulaAssist();
}

// ===========================================================================
// Links + context menu
// ===========================================================================
function linkForRef(ref: string): string | null {
  const cell = getCell(ref); if (!cell) return null;
  const value = engine.computeRef(activeSheetId, ref);
  if (value instanceof HyperlinkValue) return value.url;
  return typeof value === "string" ? safeHyperlinkUrl(value) : null;
}
function openExternalLink(url: string) {
  const safe = safeHyperlinkUrl(url); if (!safe) return;
  const anchor = el("a", { href: safe, target: "_blank", rel: "noopener noreferrer" });
  document.body.appendChild(anchor); anchor.click(); anchor.remove();
}
function copyPlainText(text: string) {
  const input = el("textarea", { "aria-hidden": "true" }); input.value = text;
  input.style.cssText = "position:fixed;left:-10000px;top:0"; document.body.appendChild(input);
  input.focus(); input.select();
  let copied = false; try { copied = document.execCommand("copy"); } catch (error) {}
  input.remove(); armEditorCapture(true);
  toast(copied ? "Link copied" : "Clipboard unavailable", copied ? "ok" : "bad");
}

// ===========================================================================
// Context menu (right-click on grid)
// ===========================================================================
const pointRect = (x: number, y: number) => new DOMRect(x, y, 0, 0);
gridTable.addEventListener("contextmenu", (e) => {
  // Right-clicks land on an element inside the table.
  const target = e.target as Element;
  const td = target.closest<HTMLElement>("td.cell");
  const colhead = target.closest<HTMLElement>("th.colhead");
  const rowhead = target.closest<HTMLElement>("th.rowhead");
  if (!td && !colhead && !rowhead) return;
  e.preventDefault();
  if (td) {
    const r = Number(td.dataset.r), c = Number(td.dataset.c);
    if (!cellInSelection(r, c)) moveActive(r, c);
  } else if (colhead) {
    const c = Number(colhead.dataset.col), sheet = curSheet();
    const selected = selectionRanges().some((range) => range.r1 === 0 && range.r2 === sheet.rows - 1 && c >= range.c1 && c <= range.c2);
    if (!selected) setSelection({ r: 0, c }, { r: sheet.rows - 1, c });
  } else if (rowhead) {
    const r = Number(rowhead.dataset.row), sheet = curSheet();
    const selected = selectionRanges().some((range) => range.c1 === 0 && range.c2 === sheet.cols - 1 && r >= range.r1 && r <= range.r2);
    if (!selected) setSelection({ r, c: 0 }, { r, c: sheet.cols - 1 });
  }
  const menu: HTMLElement[] = [];
  const item = (iconName: IconName, label: string, keys: string[] | null, onSelect: () => void, danger?: boolean) => {
    const it = menuItem({ icon: iconName, label, keys, onSelect });
    if (danger) it.classList.add("danger");
    menu.push(it);
  };
  const sep = () => menu.push(el("div", { class: "msep" }));
  const activeLink = td ? linkForRef(td.dataset.ref as string) : null;
  if (activeLink) {
    item("external", "Open link", combo("mod", "Click"), () => openExternalLink(activeLink));
    item("link", "Copy link", null, () => copyPlainText(activeLink));
    sep();
  }
  item("cut", "Cut", combo("mod", "X"), () => requestGridClipboard(true));
  item("copy", "Copy", combo("mod", "C"), () => requestGridClipboard(false));
  item("clipboard", "Paste", combo("mod", "V"), () => pasteFromMenu(true));
  item("pasteText", "Paste values only", combo("mod", "shift", "V"), () => pasteFromMenu(false));
  sep();
  const r = selRange(), rows = r.r2 - r.r1 + 1, cols = r.c2 - r.c1 + 1;
  if (!colhead) {
    item("rowAbove", rows > 1 ? `Insert ${rows} rows above` : "Insert row above", null, () => insertRows(selRange().r1, rows));
    item("rowBelow", rows > 1 ? `Insert ${rows} rows below` : "Insert row below", null, () => insertRows(selRange().r2 + 1, rows));
  }
  if (!rowhead) {
    item("colLeft", cols > 1 ? `Insert ${cols} columns left` : "Insert column left", null, () => insertCols(selRange().c1, cols));
    item("colRight", cols > 1 ? `Insert ${cols} columns right` : "Insert column right", null, () => insertCols(selRange().c2 + 1, cols));
  }
  // On a header: size the selected columns (or rows) to what they hold.
  if (colhead) { const lines = selectedHeaderLines(false); item("fitWidth", lines.length > 1 ? `Fit ${lines.length} columns to data` : "Fit column to data", null, () => fitColumns(lines)); }
  if (rowhead) { const lines = selectedHeaderLines(true); item("fitHeight", lines.length > 1 ? `Fit ${lines.length} rows to data` : "Fit row to data", null, () => fitRows(lines)); }
  sep();
  if (curSheet().pivot) item("pivot", "Pivot table settings", null, () => openPivotMenu(activeSheetId));
  else item("pivot", "Pivot table", null, () => createPivotTable());
  const filter = curSheet().filter;
  item("filter", filter ? "Remove filter" : "Create a filter", null, () => toggleFilterRow());
  sep();
  if (!colhead) item("rowDelete", rows > 1 ? `Delete ${rows} rows` : "Delete row", null, () => deleteRows(), true);
  if (!rowhead) item("colDelete", cols > 1 ? `Delete ${cols} columns` : "Delete column", null, () => deleteCols(), true);
  item("eraser", "Clear contents", combo(isMac ? "⌫" : "Del"), () => deleteSelectionContents());
  showPop(menu, pointRect(e.clientX, e.clientY), { className: "ctx-menu" });
});

// ===========================================================================
// Sheet tabs
// ===========================================================================
let newTabId: string | null = null; // a just-added tab rises into place once
// Double-click renames. Delegated, because the first click of a double-click
// on another sheet switches to it and re-renders the tabs.
tabbar.addEventListener("dblclick", (e) => {
  const tab = (e.target as Element).closest<HTMLElement>(".tab") || document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>(".tab");
  if (tab && !tab.classList.contains("renaming") && !editingFormula() && !editingAway()) renameSheet(tab.dataset.id as string);
});
function renderTabs() {
  // A remote change mustn't wipe a name being typed; renaming re-renders when done.
  if (tabbar.querySelector(".tab-rename")) return;
  tabbar.replaceChildren();
  for (const id of model.sheetOrder) {
    const sh = model.sheets[id];
    const touchedAt = touchedTabs.get(id);
    const touched = id !== activeSheetId && touchedAt && Date.now() - touchedAt < 1500;
    if (!touched) touchedTabs.delete(id);
    const editingHome = editingAway() && id === editing?.sheetId;
    const tab = el("div", { class: "tab" + (id === activeSheetId ? " active" : "") + (touched ? " touched" : "") + (id === newTabId ? " tab-new" : "") + (editingHome ? " editing-home" : ""), "data-id": id, role: "tab", "aria-selected": String(id === activeSheetId) }, [el("span", { class: "tname" }, sh.name)]);
    if (id === newTabId) { newTabId = null; requestAnimationFrame(() => tab.scrollIntoView({ block: "nearest", inline: "nearest", behavior: reducedMotion.matches ? "auto" : "smooth" })); }
    // Touch has no double-click or right-click, so tapping the sheet you're
    // already on opens its menu (Rename, Duplicate, Delete).
    tab.addEventListener("click", (e) => {
      // Mid-formula, another tab opens that sheet for picking cells; the edit stays open.
      // (Also while away with the "=" since deleted: the edit belongs to its own sheet either way.)
      if (editingFormula() || editingAway()) { if (id !== activeSheetId) showSheetWhileEditing(id); else focusEditingSurface(); }
      else if (id !== activeSheetId) switchSheet(id);
      else if (coarsePointer && !tab.classList.contains("renaming")) sheetTabMenu(id, e);
    });
    tab.addEventListener("mousedown", (e) => {
      // Keeps focus (and the caret) in the formula while its tabs are clicked.
      if (editingFormula() || editingAway() || (tab.classList.contains("renaming") && e.target !== tab.querySelector(".tab-rename"))) e.preventDefault();
    });
    tab.addEventListener("contextmenu", (e) => { e.preventDefault(); if (editingFormula() || editingAway()) return; if (!tab.classList.contains("renaming")) sheetTabMenu(id, e); });
    tabbar.appendChild(tab);
  }
  const add = el("div", { class: "tab-add", role: "button", html: svg(ICONS.plus, 16) });
  attachTip(add, "Add sheet");
  add.addEventListener("click", addSheet);
  tabbar.appendChild(add);
  updateTabTitle();
}
// An edit is saved before the grid changes sheet. If it can't be saved (an unfinished formula),
// the switch doesn't happen: the editor stays open on its own sheet, showing what's wrong,
// rather than its text later landing in the same cell of a different sheet.
function finishEditBeforeSheetChange() {
  if (editing) commitEdit("none");
  return !editing;
}
function switchSheet(id: string) {
  if (!finishEditBeforeSheetChange()) return;
  activeSheetId = id;
  if (model.sheets[id]?.pivot) refreshPivot(id);
  anchor = { r: 0, c: 0 }; focus = { r: 0, c: 0 }; extraRanges = [];
  selectedChartId = null;
  if (openPop?.pop.classList.contains("settings-pop")) closePop(true);
  renderTabs(); renderGrid(); updateSelectionUI(); refreshToolbarState();
  sendPresence();
}
function addSheet() {
  if (!finishEditBeforeSheetChange()) return;
  const id = "s_" + Math.random().toString(36).slice(2, 8);
  let n = model.sheetOrder.length + 1;
  while (model.sheetOrder.some((sid) => model.sheets[sid].name.toLowerCase() === "sheet" + n)) n++;
  model.sheets[id] = { id, name: "Sheet" + n, rows: 100, cols: 26, colWidths: {}, rowHeights: {}, frozenRows: 0, frozenCols: 0, filter: null, charts: [], pivot: null };
  model.sheetOrder.push(id);
  model.cells[id] = {};
  activeSheetId = id;
  queueStructure();
  newTabId = id;
  switchSheet(id);
}
// Renaming happens right on the tab: its label turns into a field that grows
// with the text. Enter or clicking away saves; Esc puts the old name back.
// The text stays exactly where it was (the field is measured to fit, with no
// padding of its own); the tab lifts with an accent ring while you type.
// A name another sheet already uses turns the ring red and gives a small
// shake instead of saving; an empty name just puts the old one back.
function renameSheet(id: string) {
  if (editing) commitEdit("none");
  closePop(true);
  hideTip();
  const tab = tabbar.querySelector<HTMLElement>(`.tab[data-id="${CSS.escape(id)}"]`);
  const label = tab?.querySelector(".tname");
  if (!tab || !label || !model.sheets[id]) return;
  const original = model.sheets[id].name;
  const input = el("input", { class: "tab-rename", value: original, spellcheck: "false", autocomplete: "off", "aria-label": "Sheet name", maxlength: "60", enterkeyhint: "done" });
  const measure = el("span", { class: "tab-measure", "aria-hidden": "true" });
  const fit = () => { measure.textContent = input.value || " "; input.style.width = Math.ceil(measure.getBoundingClientRect().width) + 2 + "px"; };
  tab.classList.add("renaming");
  tab.classList.remove("touched");
  label.replaceWith(input);
  tab.appendChild(measure);
  fit();
  input.focus({ preventScroll: true });
  input.select();
  tab.scrollIntoView({ block: "nearest", inline: "nearest" });
  const nameTaken = (name: string) => model.sheetOrder.some((sid) => sid !== id && model.sheets[sid]?.name.toLowerCase() === name.toLowerCase());
  let done = false;
  const finish = (save: boolean) => {
    if (done) return;
    const clean = input.value.trim().slice(0, 60);
    if (save && clean && clean !== original && nameTaken(clean)) {
      // Not saved: say why, right where you're looking.
      tab.classList.add("invalid");
      showTipText(tab, "Another sheet already has that name");
      if (!reducedMotion.matches) tab.animate([{ transform: "translateX(0)" }, { transform: "translateX(-3px)" }, { transform: "translateX(3px)" }, { transform: "translateX(-2px)" }, { transform: "translateX(0)" }], { duration: 260, easing: "ease-out" });
      requestAnimationFrame(() => input.focus({ preventScroll: true }));
      return false;
    }
    done = true;
    hideTip();
    input.remove();
    const changed = save && clean && clean !== original && model.sheets[id];
    if (changed) {
      model.sheets[id].name = clean;
      // Formulas anywhere that name the sheet follow it (saved with the new name, as one operation).
      const prefix = sheetRefPrefix(id);
      for (const sheetId of model.sheetOrder) {
        for (const [ref, cell] of Object.entries(model.cells[sheetId] || {})) {
          if (!cell.value || cell.value[0] !== "=") continue;
          const next = renameFormulaSheet(cell.value, original, prefix);
          if (next !== cell.value) { cell.value = next; queueCellOp(sheetId, ref, next, cell.fmt, cell.version || 0); }
        }
      }
      queueStructure(); rebuildEngine(); renderGrid();
    }
    renderTabs();
    if (changed && !reducedMotion.matches) tabbar.querySelector(`.tab[data-id="${CSS.escape(id)}"]`)?.classList.add("renamed");
    armEditorCapture(true);
    return true;
  };
  input.addEventListener("input", () => {
    fit();
    if (tab.classList.contains("invalid")) { tab.classList.remove("invalid"); hideTip(); }
  });
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); finish(true); }
    else if (e.key === "Escape") { e.preventDefault(); finish(false); }
  });
  // Clicking away saves, unless the name is taken; then it reverts quietly.
  input.addEventListener("blur", () => setTimeout(() => {
    if (done || document.activeElement === input) return;
    if (!finish(true)) finish(false);
  }, 0));
  for (const type of ["mousedown", "click", "dblclick", "contextmenu"]) input.addEventListener(type, (e) => e.stopPropagation());
}
function sheetTabMenu(id: string, e: MouseEvent) {
  const menu = [
    menuItem({ icon: "pencil", label: "Rename", onSelect: () => renameSheet(id) }),
    menuItem({ icon: "duplicate", label: "Duplicate", onSelect: () => duplicateSheet(id) }),
  ];
  if (model.sheetOrder.length > 1) {
    const del = menuItem({ icon: "trash", label: "Delete sheet", onSelect: () => deleteSheet(id) });
    del.classList.add("danger");
    menu.push(el("div", { class: "msep" }), del);
  }
  const tab = (e.target as Element).closest?.<HTMLElement>(".tab");
  const rect = tab ? tab.getBoundingClientRect() : pointRect(e.clientX, e.clientY);
  // Tabs sit at the bottom, so the menu opens upward from the tab.
  showPop(menu, rect, { owner: tab || null });
}
function duplicateSheet(id: string) {
  if (!finishEditBeforeSheetChange()) return;
  const src = model.sheets[id];
  const nid = "s_" + Math.random().toString(36).slice(2, 8);
  // Names must stay unique (formulas find sheets by name) and within the 60-character limit.
  const taken = (name: string) => model.sheetOrder.some((sid) => model.sheets[sid]?.name.toLowerCase() === name.toLowerCase());
  let copyName = src.name.slice(0, 55) + " copy";
  for (let n = 2; taken(copyName); n++) { const suffix = ` copy ${n}`; copyName = src.name.slice(0, 60 - suffix.length) + suffix; }
  model.sheets[nid] = { ...JSON.parse(JSON.stringify(src)), id: nid, name: copyName };
  model.cells[nid] = copyCellMap(model.cells[id] || {});
  const idx = model.sheetOrder.indexOf(id);
  model.sheetOrder.splice(idx + 1, 0, nid);
  queueStructure(); queueReplacement(nid);
  newTabId = nid;
  switchSheet(nid);
}
function deleteSheet(id: string) {
  if (model.sheetOrder.length <= 1) return;
  if (!finishEditBeforeSheetChange()) return;
  const idx = model.sheetOrder.indexOf(id);
  model.sheetOrder.splice(idx, 1);
  delete model.sheets[id]; delete model.cells[id];
  if (activeSheetId === id) activeSheetId = model.sheetOrder[Math.max(0, idx - 1)];
  queueStructure();
  switchSheet(activeSheetId);
}

// ===========================================================================
// Presence
// ===========================================================================
// This tab's selection is announced to the server, but nothing is drawn for others' selections,
// so presence events are ignored.
let presenceTimer: ReturnType<typeof setTimeout> | undefined;
function sendPresence() {
  if (isExport) return;
  clearTimeout(presenceTimer);
  presenceTimer = setTimeout(() => {
    const rng = selRange();
    gadget.updatePresence({ clientId, name: collaboratorName, color: collaboratorColor, sheetId: activeSheetId, r1: rng.r1, c1: rng.c1, r2: rng.r2, c2: rng.c2 }).catch(() => {});
  }, 60);
}
gridScroll.addEventListener("scroll", () => { if (formulaAssist.style.display !== "none") positionFormulaAssist(); });
setInterval(sendPresence, 4000);
window.addEventListener("pagehide", () => { if (!isExport) gadget.leavePresence(clientId).catch(() => {}); });

// ===========================================================================
// Find (⌘F / Ctrl+F)
// ===========================================================================
// Only the rows near the view are in the page, so the browser's own find can't see the sheet.
// This one searches the model: what each cell shows (a formula's result, a number in its
// format) and what was typed, optionally formula text too, on this sheet or every sheet.
// Matches get a soft tint; the current one is the selection. Typing jumps to the first match
// at or after the active cell; Enter / ⇧Enter (⌘G / ⇧⌘G) step; Esc closes. Matches in rows a
// filter hides are counted but skipped. Big sheets are searched in slices, so typing never stalls.
document.head.appendChild(el("style", { text: `
:root { --find-hit: color-mix(in srgb, #f0bf2c 30%, transparent); --find-current: color-mix(in srgb, #f0bf2c 55%, transparent); }
.findbar { position: absolute; top: 10px; right: 18px; z-index: 30; display: flex; align-items: center; gap: 1px;
  max-width: calc(100% - 24px); padding: 3px 3px 3px 10px; border-radius: 12px;
  background: var(--raised); color: var(--text); box-shadow: var(--shadow-pop); font-size: 13px;
  transform-origin: top right; animation: pop-in .16s var(--ease); }
.findbar[hidden] { display: none; }
.findbar.closing { animation: pop-out .1s ease-in forwards; pointer-events: none; }
.findbar .find-icon { display: inline-flex; flex: 0 0 auto; color: var(--faint); margin-right: 6px; }
.findbar input { flex: 1 1 auto; width: 210px; min-width: 60px; height: 30px; border: 0; outline: none; padding: 0;
  background: transparent; color: var(--text); font: 13px/1 var(--font-ui); }
.findbar input::placeholder { color: var(--faint); }
.findbar .find-count { flex: 0 0 auto; min-width: 58px; padding: 0 8px 0 4px; text-align: right; white-space: nowrap;
  color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; transition: color .12s var(--ease); }
.findbar .find-count.none { color: var(--bad); }
.findbar .find-sep { width: 1px; height: 18px; margin: 0 3px; background: var(--line); flex: 0 0 auto; }
.findbar .tb.find-prev svg { transform: rotate(180deg); }
.grid td.cell.find-hit { background-image: linear-gradient(var(--find-hit), var(--find-hit)); }
.grid td.cell.find-hit.sel, .grid td.cell.find-hit.active { background-image: linear-gradient(var(--find-current), var(--find-current)); }
@media (max-width: 560px) { .findbar { left: 8px; right: 8px; top: 8px; max-width: none; } .findbar input { width: auto; } }
@media print { .findbar { display: none !important; } }
` }));
/** A match: a cell on a sheet. */
interface FindMatch { sheetId: string; r: number; c: number }
/** The options a search ran with (`sheets`: the searched sheet ids, joined). */
interface FindOptions { matchCase: boolean; wholeCell: boolean; formulas: boolean; sheets: string }
/** The last finished search, so a longer query only rechecks its matches. */
interface FindLast { query: string; options: FindOptions; found: FindMatch[] }
/** Everything the find bar knows. */
interface FindState {
  open: boolean;
  query: string;
  matchCase: boolean;
  wholeCell: boolean;
  formulas: boolean;
  allSheets: boolean;
  results: FindMatch[];
  hidden: number;
  index: number;
  scanning: boolean;
  token: number;
  hits: Map<string, Set<number>>;
  scanSheet: string | null;
  last: FindLast | null;
  typingTimer: ReturnType<typeof setTimeout> | undefined;
  refreshTimer: ReturnType<typeof setTimeout> | undefined;
  busyTimer: ReturnType<typeof setTimeout> | undefined;
  closeTimer: ReturnType<typeof setTimeout> | undefined;
}
var findState: FindState = {
  open: false, query: "", matchCase: false, wholeCell: false, formulas: false, allSheets: false,
  results: [],   // [{ sheetId, r, c }] in reading order (sheet order, then rows, then columns)
  hidden: 0,     // matches in rows a filter hides
  index: -1, scanning: false, token: 0, hits: new Map() /* sheetId -> Set(cell key) */,
  scanSheet: null, last: null, typingTimer: undefined, refreshTimer: undefined, busyTimer: undefined, closeTimer: undefined,
};
const findInput = el("input", { type: "text", placeholder: "Find in sheet", spellcheck: "false", autocomplete: "off", "aria-label": "Find", enterkeyhint: "search" });
const findCount = el("span", { class: "find-count", role: "status", "aria-live": "polite" });
const findPrev = tb("chevron", "Previous match", combo("shift", "↵"), () => stepFind(-1), "find-prev");
const findNext = tb("chevron", "Next match", combo("↵"), () => stepFind(1), "find-next");
const findOptions = tb("more", "Search options", null, (e: MouseEvent, b: HTMLButtonElement) => toggleMenu(b, openFindOptions), "find-options");
const findClose = tb("close", "Close", combo("Esc"), () => closeFind(true), "find-close");
const findBar = el("div", { class: "findbar", role: "search", hidden: "" }, [
  el("span", { class: "find-icon", "aria-hidden": "true", html: svg(ICONS.search, 15) }),
  findInput, findCount, el("span", { class: "find-sep", "aria-hidden": "true" }), findPrev, findNext, findOptions, findClose,
]);
if (!isExport) workarea.appendChild(findBar);

function openFind() {
  if (isExport) return;
  // The search moves the selection, so an open edit is saved first (as a click elsewhere would).
  if (editing) { commitEdit("none"); if (editing) return; }
  clearTimeout(findState.closeTimer);
  const wasOpen = findState.open;
  findState.open = true;
  findBar.classList.remove("closing");
  findBar.hidden = false;
  if (!wasOpen) { findInput.value = findState.query; findState.last = null; refreshFind(false); }
  findInput.focus({ preventScroll: true });
  findInput.select();
}
function closeFind(refocus = true) {
  if (!findState.open) return;
  findState.open = false; findState.token++;
  clearTimeout(findState.typingTimer); clearTimeout(findState.refreshTimer); clearTimeout(findState.busyTimer);
  findState.hits = new Map(); findState.results = []; findState.index = -1;
  closePop(true);
  if (reducedMotion.matches) findBar.hidden = true;
  else { findBar.classList.add("closing"); findState.closeTimer = setTimeout(() => { findBar.hidden = true; findBar.classList.remove("closing"); }, 110); }
  decorateFind();
  if (refocus) gridScroll.focus({ preventScroll: true });
}
findInput.addEventListener("input", () => {
  findState.query = findInput.value;
  clearTimeout(findState.typingTimer);
  // Small workbooks are searched on every keystroke; big ones once typing pauses briefly.
  let size = 0;
  counting: for (const id of findSheets()) for (const ref in model.cells[id] || {}) if (++size > 30000) break counting;
  if (size > 30000) findState.typingTimer = setTimeout(() => { findState.typingTimer = undefined; refreshFind(true); }, 140);
  else { findState.typingTimer = undefined; refreshFind(true); }
});
findInput.addEventListener("keydown", (e) => {
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === "Enter") {
    e.preventDefault();
    // A search still waiting for typing to pause runs now, so Enter acts on what was typed.
    if (findState.typingTimer) { clearTimeout(findState.typingTimer); findState.typingTimer = undefined; refreshFind(true); return; }
    stepFind(e.shiftKey ? -1 : 1);
  }
  else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeFind(true); }
});
function openFindOptions(owner: HTMLElement) {
  const toggle = (key: "matchCase" | "wholeCell" | "formulas") => () => { findState[key] = !findState[key]; findState.last = null; refreshFind(true); };
  const scope = (all: boolean) => () => { if (findState.allSheets !== all) { findState.allSheets = all; findState.last = null; refreshFind(true); } };
  showPop([
    menuItem({ label: "Match case", checked: findState.matchCase, checkSlot: true, onSelect: toggle("matchCase") }),
    menuItem({ label: "Match entire cell", checked: findState.wholeCell, checkSlot: true, onSelect: toggle("wholeCell") }),
    menuItem({ label: "Also search formulas", checked: findState.formulas, checkSlot: true, onSelect: toggle("formulas") }),
    el("div", { class: "msep" }),
    menuItem({ label: "This sheet", checked: !findState.allSheets, checkSlot: true, onSelect: scope(false) }),
    menuItem({ label: "All sheets", checked: findState.allSheets, checkSlot: true, onSelect: scope(true) }),
  ], owner.getBoundingClientRect(), { owner, align: "end", onClose: () => { if (findState.open) findInput.focus({ preventScroll: true }); } });
}
function syncFindOptionsButton() {
  findOptions.classList.toggle("on", findState.matchCase || findState.wholeCell || findState.formulas || findState.allSheets);
  findInput.placeholder = findState.allSheets ? "Find in all sheets" : "Find in sheet";
}

// A test for one piece of text, following the options.
function findMatcher(): (s: string) => boolean {
  const q = findState.matchCase ? findState.query : findState.query.toLocaleLowerCase();
  const norm = findState.matchCase ? (s: string) => s : (s: string) => s.toLocaleLowerCase();
  return findState.wholeCell ? (s: string) => norm(s) === q : (s: string) => norm(s).includes(q);
}
function findCellMatches(sheetId: string, ref: string, cell: Cell, test: (s: string) => boolean): boolean {
  const raw = cell.value;
  if (raw == null || raw === "") return false;
  const formula = raw[0] === "=";
  if (formula ? findState.formulas && test(raw) : test(raw)) return true;
  // What the cell shows, when that can differ from what was typed: a formula's result, or a
  // number, date or truth value in its format. Plain text shows as typed.
  if (!formula && !/\d/.test(raw) && !/^\s*(true|false)\s*$/i.test(raw)) return false;
  const shown = String(displayValue(engine.computeRef(sheetId, ref), cell.fmt).text ?? "");
  return shown !== raw && shown !== "" && test(shown);
}
function findSheets(): string[] { return findState.allSheets ? model.sheetOrder.filter((id) => model.sheets[id]) : [activeSheetId]; }
function sameFindOptions(a: FindOptions | null | undefined, b: FindOptions | null | undefined) {
  return a && b && a.matchCase === b.matchCase && a.wholeCell === b.wholeCell && a.formulas === b.formulas && a.sheets === b.sheets;
}
// Searches again. `move`: go to the first match at or after the active cell (as you type);
// otherwise the current match stays current if it still matches (after an edit).
function refreshFind(move: boolean) {
  if (!findState.open) return;
  syncFindOptionsButton();
  const token = ++findState.token;
  clearTimeout(findState.refreshTimer); clearTimeout(findState.busyTimer);
  const query = findState.query;
  const sheets = findSheets();
  findState.scanSheet = activeSheetId;
  const options: FindOptions = { matchCase: findState.matchCase, wholeCell: findState.wholeCell, formulas: findState.formulas, sheets: sheets.join("|") };
  if (!query) { findState.last = null; finishFind([], move, null); return; }
  const test = findMatcher();
  // A longer query with the same options only has to look at what the shorter one matched.
  const last = findState.last;
  if (last && !findState.wholeCell && sameFindOptions(last.options, options) && query.startsWith(last.query)) {
    const found = last.found.filter((m) => { const cell = model.cells[m.sheetId]?.[rcToRef(m.r, m.c)]; return cell && findCellMatches(m.sheetId, rcToRef(m.r, m.c), cell, test); });
    finishFind(found, move, { query, options, found });
    return;
  }
  findState.scanning = true;
  // "Searching…" only for a search that takes a moment, so quick ones don't flicker.
  findState.busyTimer = setTimeout(() => { if (findState.scanning && token === findState.token) updateFindCount(); }, 160);
  const found: FindMatch[] = [];
  let s = 0, refs: string[] | null = null, i = 0;
  const step = () => {
    if (token !== findState.token || !findState.open) return;
    const deadline = performance.now() + 10;
    while (s < sheets.length) {
      const sheetId = sheets[s], cells = model.cells[sheetId] || {}, sheet = model.sheets[sheetId];
      if (!refs) { refs = sheet ? Object.keys(cells) : []; i = 0; }
      while (i < refs.length) {
        const ref = refs[i++], cell = cells[ref];
        if (cell && findCellMatches(sheetId, ref, cell, test)) {
          const p = parseRef(ref);
          if (p && p.r < sheet.rows && p.c < sheet.cols) found.push({ sheetId, r: p.r, c: p.c });
        }
        if ((i & 255) === 0 && performance.now() > deadline) { setTimeout(step, 0); return; }
      }
      s++; refs = null;
    }
    findState.scanning = false;
    finishFind(found, move, { query, options, found });
  };
  step();
}
function finishFind(found: FindMatch[], move: boolean, last: FindLast | null) {
  clearTimeout(findState.busyTimer);
  findState.scanning = false;
  const order = new Map(model.sheetOrder.map((id, index) => [id, index]));
  found.sort((a, b) => ((order.get(a.sheetId) as number) - (order.get(b.sheetId) as number)) || (a.r - b.r) || (a.c - b.c));
  if (last) last.found = found;
  findState.last = last;
  const previous = findState.results[findState.index];
  const visible: FindMatch[] = [];
  let hidden = 0;
  for (const m of found) (rowPassesFilter(m.r, m.sheetId) ? visible.push(m) : hidden++);
  findState.results = visible; findState.hidden = hidden;
  findState.hits = new Map();
  for (const m of visible) {
    let set = findState.hits.get(m.sheetId);
    if (!set) findState.hits.set(m.sheetId, set = new Set());
    set.add(cellKeyOf(m.r, m.c));
  }
  if (move) {
    findState.index = visible.length ? firstFindAtOrAfter(activeSheetId, focus.r, focus.c) : -1;
    if (findState.index >= 0) gotoFind(findState.index, false);
  } else {
    findState.index = previous ? visible.findIndex((m) => m.sheetId === previous.sheetId && m.r === previous.r && m.c === previous.c) : -1;
  }
  updateFindCount(); decorateFind();
}
// The first match at or after a cell, in reading order (wrapping around).
function firstFindAtOrAfter(sheetId: string, r: number, c: number): number {
  const list = findState.results, order = new Map(model.sheetOrder.map((id, index) => [id, index]));
  const s = order.get(sheetId) ?? 0;
  const before = (m: FindMatch) => { const ms = order.get(m.sheetId) as number; return ms < s || (ms === s && (m.r < r || (m.r === r && m.c < c))); };
  let lo = 0, hi = list.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (before(list[mid])) lo = mid + 1; else hi = mid; }
  return lo < list.length ? lo : 0;
}
function stepFind(direction: number) {
  if (!findState.open) { openFind(); return; }
  const n = findState.results.length;
  if (!n) { if (findState.query) shakeFindCount(); return; }
  let index: number;
  // After clicking elsewhere, the next match is the one after where you are now.
  const current = findState.results[findState.index];
  if (current && !(current.sheetId === activeSheetId && current.r === focus.r && current.c === focus.c)) findState.index = -1;
  if (findState.index < 0) {
    index = firstFindAtOrAfter(activeSheetId, focus.r, focus.c);
    // Going back from a cell that isn't a match: the match before it.
    if (direction < 0) { const m = findState.results[index]; if (!(m.sheetId === activeSheetId && m.r === focus.r && m.c === focus.c)) index = (index - 1 + n) % n; }
  } else index = (findState.index + direction + n) % n;
  findState.index = index;
  gotoFind(index, true);
  updateFindCount(); decorateFind();
}
function shakeFindCount() {
  if (reducedMotion.matches) return;
  findCount.animate([{ transform: "none" }, { transform: "translateX(-3px)" }, { transform: "translateX(3px)" }, { transform: "none" }], { duration: 220, easing: "ease-out" });
}
// Shows a match: its sheet, then the cell, centred if it was out of view.
function gotoFind(index: number, keepFocus: boolean) {
  const m = findState.results[index]; if (!m) return;
  if (m.sheetId !== activeSheetId) {
    switchSheet(m.sheetId);
    if (activeSheetId !== m.sheetId) return;
    findState.scanSheet = activeSheetId;
  }
  revealCell(m.r, m.c);
  moveActive(m.r, m.c);
  if (keepFocus || document.activeElement !== findInput) findInput.focus({ preventScroll: true });
}
function revealCell(r: number, c: number) {
  flushRender();
  const L = geo(), b = cellRect(r, c);
  const viewH = gridScroll.clientHeight - L.headH, viewW = gridScroll.clientWidth - HEAD_W;
  const top = b.top - L.headH, left = b.left - HEAD_W;
  // A match out of view is brought to the middle (clear of the find bar in the top corner),
  // so the rows around it can be read.
  if (top < gridScroll.scrollTop || top + b.height > gridScroll.scrollTop + viewH) gridScroll.scrollTop = Math.max(0, top - (viewH - b.height) / 2);
  if (left < gridScroll.scrollLeft || left + b.width > gridScroll.scrollLeft + viewW) gridScroll.scrollLeft = Math.max(0, left - (viewW - b.width) / 2);
}
function updateFindCount() {
  const n = findState.results.length, hidden = findState.hidden;
  let text = "", tip = "";
  if (findState.scanning) text = "Searching…";
  else if (!findState.query) text = "";
  else if (!n) { text = hidden ? "Filtered out" : "No results"; tip = hidden ? `${hidden.toLocaleString()} ${hidden === 1 ? "match is" : "matches are"} in rows a filter hides` : ""; }
  else {
    text = findState.index >= 0 ? `${(findState.index + 1).toLocaleString()} of ${n.toLocaleString()}` : `${n.toLocaleString()} found`;
    if (hidden) tip = `${hidden.toLocaleString()} more in rows a filter hides`;
  }
  findCount.textContent = text;
  findCount.classList.toggle("none", !!findState.query && !findState.scanning && !n);
  findCount.title = tip;
  for (const b of [findPrev, findNext]) b.classList.toggle("disabled", !n);
}
// Tints the drawn cells that match (called after every redraw of the window).
function decorateFind() {
  if (findState?.open && !findState.allSheets && findState.scanSheet && findState.scanSheet !== activeSheetId) { refreshFind(false); return; }
  const set = findState?.open ? findState.hits.get(activeSheetId) : null;
  for (const [key, td] of renderedCells) td.classList.toggle("find-hit", !!set?.has(key));
}
// After any edit, the matches are worked out again (shortly, once edits settle).
function findModelChanged() {
  if (!findState?.open || !findState.query) return;
  clearTimeout(findState.refreshTimer);
  findState.refreshTimer = setTimeout(() => { findState.last = null; refreshFind(false); }, 250);
}

/* ══════════════════════ 10. Live edits (agent API) ═══════════════════════ */
// Changes made through the server's cell API (senderId "agent") land with a
// light touch, so you can watch the sheet being worked on:
//   • a value appearing in an empty cell rises into place over a faint wash;
//   • an edited value highlights just the characters that changed (a hairline
//     tick marks where something was taken out), then the highlight fades;
//   • a value that is mostly rewritten, or only re-formatted, washes softly;
//   • a cleared cell's old value fades where it stood;
//   • formulas that recalculate because of the change glow once, more faintly;
//   • a slim accent ring follows the latest change and fades when it stops;
//   • a change on another sheet puts a small dot on that sheet's tab.
// Several cells in one change cascade in reading order. Everything is drawn in
// an overlay inside the grid's scroller, so it scrolls with the cells and can
// never reach saved content.
document.head.appendChild(el("style", { text: `
.ag-layer { position: absolute; left: 0; top: 0; width: 0; height: 0; pointer-events: none; z-index: 9; }
.ag-layer > * { position: absolute; left: 0; top: 0; pointer-events: none; }
.ag-mark { border-radius: 3px; background: color-mix(in srgb, var(--accent) 20%, transparent); }
.ag-wash { border-radius: 3px; background: color-mix(in srgb, var(--accent) 10%, transparent); }
.ag-recalc { border-radius: 3px; background: color-mix(in srgb, var(--accent) 6%, transparent); }
.ag-tick { border-radius: 1px; background: color-mix(in srgb, var(--accent) 70%, transparent); }
.ag-ghost { overflow: hidden; white-space: nowrap; font-size: 13px; line-height: 23px; padding: 0 5px; color: var(--text); }
.ag-pen {
  border-radius: 3px; box-shadow: 0 0 0 1.5px var(--accent), 0 0 0 4px color-mix(in srgb, var(--accent) 14%, transparent); opacity: 0;
  transition: opacity .35s var(--ease), transform .28s cubic-bezier(.2,.8,.2,1), width .28s cubic-bezier(.2,.8,.2,1), height .28s cubic-bezier(.2,.8,.2,1);
}
.ag-pen.show { opacity: .9; transition: opacity .12s var(--ease), transform .28s cubic-bezier(.2,.8,.2,1), width .28s cubic-bezier(.2,.8,.2,1), height .28s cubic-bezier(.2,.8,.2,1); }
.ag-pen.jump { transition: opacity .12s var(--ease); }
@media print { .ag-layer { display: none !important; } }
` }));
const agentLayer = el("div", { class: "ag-layer", "aria-hidden": "true" });
const agentPen = el("div", { class: "ag-pen" });
if (!isExport) { agentLayer.appendChild(agentPen); gridScroll.appendChild(agentLayer); }
let penTimer: ReturnType<typeof setTimeout> | undefined;
const liveEffectsOn = () => ready && !isExport && document.visibilityState === "visible";
const touchedTabs = new Map<string, number>(); // sheetId -> time its tab dot started

// Rects are converted from the viewport into the scroller's content box, so
// an overlay stays on its cell however the grid scrolls afterwards.
function toLayer(rect: DOMRect): DOMRect {
  const g = gridScroll.getBoundingClientRect();
  return new DOMRect(rect.left - g.left - gridScroll.clientLeft + gridScroll.scrollLeft, rect.top - g.top - gridScroll.clientTop + gridScroll.scrollTop, rect.width, rect.height);
}
function cellBox(td: HTMLElement): DOMRect { return new DOMRect(td.offsetLeft, td.offsetTop, td.offsetWidth, td.offsetHeight); }
function placeOnLayer(node: HTMLElement, r: DOMRect): HTMLElement {
  node.style.transform = `translate(${Math.round(r.left * 2) / 2}px, ${Math.round(r.top * 2) / 2}px)`;
  node.style.width = Math.max(0, r.width) + "px";
  node.style.height = Math.max(0, r.height) + "px";
  return node;
}
function flashOnLayer(className: string, rect: DOMRect, keyframes: Keyframe[], options: KeyframeAnimationOptions): HTMLElement {
  const n = placeOnLayer(el("div", { class: className }), rect);
  agentLayer.appendChild(n);
  const a = n.animate(keyframes, { fill: "both", ...options });
  const done = () => n.remove();
  a.finished.then(done, done);
  return n;
}
const WASH = [{ opacity: 0 }, { opacity: 1, offset: 0.2 }, { opacity: 0 }];

// Character-level diff of a cell's shown text: which stretches of the new text
// are new, and where old text was removed with nothing in its place. (Numbers
// and short values change a digit at a time, so tokens are words, digit runs
// and single symbols.)
const DIFF_TOKEN = /[\p{L}_'’]+|\p{N}|\s+|[^\s]/gu;
/** Which stretches of the new text are new (`added`, [start, end) offsets), where text was removed (`removedAt`), and how much changed. */
interface TextDiff { added: [number, number][]; removedAt: number[]; ratio: number }
function textDiff(a: string, b: string): TextDiff | null {
  const A = a.match(DIFF_TOKEN) || [], B = b.match(DIFF_TOKEN) || [];
  let p = 0;
  while (p < A.length && p < B.length && A[p] === B[p]) p++;
  let s = 0;
  while (s < A.length - p && s < B.length - p && A[A.length - 1 - s] === B[B.length - 1 - s]) s++;
  const a2 = A.slice(p, A.length - s), b2 = B.slice(p, B.length - s);
  const n = a2.length, m = b2.length, w = m + 1;
  if ((n + 1) * w > 300000) return null;
  const dp = new Uint16Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    dp[i * w + j] = a2[i] === b2[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
  }
  const added: [number, number][] = [], removedAt: number[] = [];
  let pos = B.slice(0, p).join("").length, addStart = -1, removed = false;
  const flush = () => {
    if (addStart >= 0) added.push([addStart, pos]);
    else if (removed) removedAt.push(pos);
    addStart = -1;
    removed = false;
  };
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a2[i] === b2[j]) { flush(); pos += b2[j].length; i++; j++; }
    else if (j < m && (i >= n || dp[i * w + j + 1] >= dp[(i + 1) * w + j])) { if (addStart < 0) addStart = pos; pos += b2[j].length; j++; }
    else { removed = true; i++; }
  }
  flush();
  const spans: [number, number][] = [];
  for (let [x, y] of added) {
    while (x < y && /\s/.test(b[x])) x++;
    while (y > x && /\s/.test(b[y - 1])) y--;
    if (y > x) spans.push([x, y]);
  }
  const visible = b.replace(/\s/g, "").length || 1;
  const changed = spans.reduce((t, [x, y]) => t + b.slice(x, y).replace(/\s/g, "").length, 0);
  return { added: spans, removedAt, ratio: changed / visible };
}
function textRange(root: Node, start: number, end: number): Range | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const r = document.createRange();
  let pos = 0, started = false;
  // A SHOW_TEXT walker visits only Text nodes.
  for (let t = walker.nextNode() as Text | null; t; t = walker.nextNode() as Text | null) {
    const len = t.data.length;
    if (!started && start <= pos + len) { r.setStart(t, start - pos); started = true; }
    if (started && end <= pos + len) { r.setEnd(t, end - pos); return r; }
    pos += len;
  }
  return null;
}
// Only the part of a range that is visible inside its cell.
function clippedRects(range: Range, td: HTMLElement): DOMRect[] {
  const box = td.getBoundingClientRect(), out: DOMRect[] = [];
  for (const r of range.getClientRects()) {
    const left = Math.max(r.left - 1.5, box.left + 1), right = Math.min(r.right + 1.5, box.right - 1);
    const top = Math.max(r.top + 2, box.top + 2), bottom = Math.min(r.bottom - 2, box.bottom - 2);
    if (right - left >= 1 && bottom - top >= 1) out.push(toLayer(new DOMRect(left, top, right - left, bottom - top)));
  }
  return out;
}
function movePen(box: DOMRect | null | undefined) {
  if (!box) return;
  const shown = agentPen.classList.contains("show");
  if (!shown) agentPen.classList.add("jump");
  placeOnLayer(agentPen, new DOMRect(box.left - 0.5, box.top - 0.5, box.width, box.height));
  if (!shown) { void agentPen.offsetWidth; agentPen.classList.remove("jump"); }
  agentPen.classList.add("show");
  clearTimeout(penTimer);
  penTimer = setTimeout(() => agentPen.classList.remove("show"), 1400);
}

const shownText = (td: HTMLElement | null | undefined) => td?.querySelector(".cv")?.textContent ?? "";
/** A cell cleared by a live edit, as it looked: where, what it said, and how. */
interface GoneCell { ref: string; box: DOMRect; text: string; align: string; style: { fontWeight: string; fontStyle: string; color: string } }
/** What the active sheet showed before a live (agent) change, so the change can be drawn once applied. */
interface LiveEditPrior {
  hint?: AgentHint;
  sheetId: string;
  texts: Map<string, string>;
  touched: Set<string>;
  formatOnly: Set<string>;
  gone: GoneCell[];
  otherSheets: Set<string>;
}
function captureLiveEdit(event: OperationEvent): LiveEditPrior {
  // Inserted or deleted rows/columns: one band of light rather than a glow on
  // every cell that moved.
  if (event.agentHint) {
    const h = event.agentHint;
    return { hint: h, sheetId: activeSheetId, texts: new Map(), touched: new Set(), formatOnly: new Set(), gone: [], otherSheets: new Set(h.sheetId !== activeSheetId ? [h.sheetId] : []) };
  }
  const texts = new Map<string, string>(), boxes = new Map<string, HTMLElement>();
  for (const td of gridTable.querySelectorAll<HTMLElement>("td.cell")) {
    texts.set(td.dataset.ref as string, shownText(td));
    boxes.set(td.dataset.ref as string, td);
  }
  const touched = new Set<string>(), formatOnly = new Set<string>(), gone: GoneCell[] = [];
  for (const up of event.upserts || []) {
    if (up.sheetId !== activeSheetId) continue;
    touched.add(up.ref);
    const before = model.cells[activeSheetId]?.[up.ref];
    if (before && before.value === up.cell?.value) formatOnly.add(up.ref);
  }
  for (const del of event.deletes || []) {
    if (del.sheetId !== activeSheetId) continue;
    touched.add(del.ref);
    const td = boxes.get(del.ref), text = texts.get(del.ref);
    if (td && text) gone.push({ ref: del.ref, box: cellBox(td), text, align: getComputedStyle(td.querySelector(".cv") as Element).textAlign, style: { fontWeight: td.style.fontWeight, fontStyle: td.style.fontStyle, color: td.style.color } });
  }
  const otherSheets = new Set([...(event.upserts || []), ...(event.deletes || [])].map((c) => c.sheetId).filter((id) => id !== activeSheetId));
  return { sheetId: activeSheetId, texts, touched, formatOnly, gone, otherSheets };
}
function showLiveEdit(prior: LiveEditPrior) {
  const now = Date.now();
  for (const id of prior.otherSheets) {
    touchedTabs.set(id, now);
    tabbar.querySelector(`.tab[data-id="${CSS.escape(id)}"]`)?.classList.add("touched");
  }
  if (prior.sheetId !== activeSheetId) return;
  if (prior.hint) { showStructuralHint(prior.hint); return; }
  const motion = !reducedMotion.matches;
  const editingRef = editing && !editingAway() ? editing.ref : null;
  // Cleared cells: the old value fades where it stood.
  for (const g of prior.gone) {
    if (g.ref === editingRef) continue;
    const ghost = flashOnLayer("ag-ghost", g.box, [{ opacity: 0.85 }, { opacity: 0, filter: "blur(1.5px)" }], { duration: 260, easing: "ease-out" });
    Object.assign(ghost.style, g.style, { textAlign: g.align });
    ghost.textContent = g.text;
  }
  const changes: { td: HTMLElement; before: string; after: string; kind: "format" | "new" | "edit" | "recalc" }[] = [];
  for (const td of gridTable.querySelectorAll<HTMLElement>("td.cell")) {
    const ref = td.dataset.ref as string;
    if (ref === editingRef) continue;
    const before = prior.texts.get(ref) ?? "", after = shownText(td);
    if (prior.touched.has(ref)) {
      if (!after && !prior.formatOnly.has(ref)) continue; // cleared: handled by its ghost
      changes.push({ td, before, after, kind: prior.formatOnly.has(ref) && before === after ? "format" : !before ? "new" : "edit" });
    } else if (before !== after && after) changes.push({ td, before, after, kind: "recalc" });
  }
  if (!changes.length) return;
  changes.sort((a, b) => (Number(a.td.dataset.r) - Number(b.td.dataset.r)) || (Number(a.td.dataset.c) - Number(b.td.dataset.c)));
  const step = Math.min(70, 560 / changes.length);
  changes.slice(0, 40).forEach(({ td, before, after, kind }, k) => {
    const delay = Math.round(k * step);
    const box = cellBox(td), cv = td.querySelector<HTMLElement>(".cv");
    if (kind === "recalc") {
      flashOnLayer("ag-recalc", box, WASH, { duration: 1500, delay: delay + 120, easing: "ease-out" });
      return;
    }
    if (kind === "new") {
      flashOnLayer("ag-wash", box, WASH, { duration: 1300, delay, easing: "ease-out" });
      cv?.animate(motion ? [{ opacity: 0, transform: "translateY(4px)" }, { opacity: 1, transform: "none" }] : [{ opacity: 0 }, { opacity: 1 }], { duration: 260, delay, easing: "cubic-bezier(.2,.8,.2,1)", fill: "backwards" });
    } else if (kind === "format") {
      flashOnLayer("ag-wash", box, WASH, { duration: 1100, delay, easing: "ease-out" });
    } else {
      const diff = before && after ? textDiff(before, after) : null;
      if (!diff || diff.ratio > 0.6 || !cv) {
        // Mostly new: a soft rewrite rather than a highlighter storm.
        flashOnLayer("ag-wash", box, WASH, { duration: 1300, delay, easing: "ease-out" });
        cv?.animate([{ opacity: 0.25 }, { opacity: 1 }], { duration: 380, delay, easing: "ease-out", fill: "backwards" });
      } else {
        // Edited: just the new characters light up, then fade.
        diff.added.forEach(([x, y], i) => {
          const range = textRange(cv, x, y);
          if (range) for (const rect of clippedRects(range, td)) flashOnLayer("ag-mark", rect, [{ opacity: 0 }, { opacity: 1, offset: 0.1 }, { opacity: 1, offset: 0.5 }, { opacity: 0 }], { duration: 1900, delay: delay + i * 45, easing: "ease-out" });
        });
        for (const at of diff.removedAt) {
          const range = textRange(cv, at, at);
          const rect = range?.getBoundingClientRect();
          if (rect && rect.height) flashOnLayer("ag-tick", toLayer(new DOMRect(rect.left - 1, rect.top + 3, 2, rect.height - 6)), [{ opacity: 0 }, { opacity: 1, offset: 0.15 }, { opacity: 0 }], { duration: 1100, delay, easing: "ease-out" });
        }
      }
    }
    setTimeout(() => { if (td.isConnected || prior.sheetId === activeSheetId) movePen(box); }, delay);
  });
}

function showStructuralHint(h: AgentHint) {
  if (h.sheetId !== activeSheetId) return;
  const rows = h.kind === "rows";
  const L = geo(), n = rows ? L.rows : L.cols, start = rows ? rowY : colX;
  const firstIndex = h.at, lastIndex = h.op === "insert" ? h.at + h.count - 1 : h.at;
  if (rows && ((firstIndex < n && rowHidden(firstIndex)) || (lastIndex < n && rowHidden(lastIndex)))) return; // filtered out of view
  const width = gridTable.offsetWidth, height = gridTable.offsetHeight;
  if (h.op === "insert" && lastIndex < n) {
    const a = start(firstIndex), b = start(lastIndex + 1);
    const box = rows ? new DOMRect(0, a, width, b - a) : new DOMRect(a, 0, b - a, height);
    flashOnLayer("ag-wash", box, WASH, { duration: 1400, easing: "ease-out" });
    movePen(rows ? new DOMRect(0, box.top, Math.min(width, gridScroll.clientWidth + gridScroll.scrollLeft), box.height) : new DOMRect(box.left, 0, box.width, Math.min(height, gridScroll.clientHeight + gridScroll.scrollTop)));
  } else if (h.op === "delete") {
    // Where the rows or columns were: a hairline that fades.
    const edge = firstIndex < n ? start(firstIndex) : rows ? height : width;
    const line = rows ? new DOMRect(0, edge - 1, width, 2) : new DOMRect(edge - 1, 0, 2, height);
    flashOnLayer("ag-tick", line, [{ opacity: 0 }, { opacity: 1, offset: 0.15 }, { opacity: 0 }], { duration: 1200, easing: "ease-out" });
  }
}

// ===========================================================================
// Remote operations
// ===========================================================================
// Two tabs that commit the same cell at once: the second is refused, rebased and resent, so its
// text replaces the first's (see "Data model" in README.md). The first tab hears that
// as someone else's edit arriving just after its own save, and says so in a toast, rather than
// letting its text silently change. Its saved cells are remembered for RACE_WINDOW_MS for that.
// Agent edits are left out: they are animated, so they never change a cell unseen.
const RACE_WINDOW_MS = 3000;
const RACE_NOTICE_CELLS = 100; // a bigger save (a paste) isn't followed cell by cell
const recentCommits = new Map<string, { value: string | null; version: number; at: number }>();
function noteCommit(sheetId: string, ref: string, value: string | null, version: number) {
  const now = Date.now();
  for (const [key, commit] of recentCommits) if (now - commit.at > RACE_WINDOW_MS) recentCommits.delete(key);
  recentCommits.set(sheetId + "!" + ref, { value, version, at: now });
}
// Whether a remote write to this cell replaces what this tab saved there a moment ago.
function replacesRecentCommit(sheetId: string, ref: string, value: string | null, version: number): boolean {
  const key = sheetId + "!" + ref, commit = recentCommits.get(key);
  if (!commit || Date.now() - commit.at > RACE_WINDOW_MS || (commit.value != null && version <= commit.version)) return false;
  recentCommits.delete(key);
  return (commit.value ?? "") !== (value ?? "");
}
function noticeReplacedCommits(cells: { sheetId: string; ref: string }[]) {
  if (!cells.length) return;
  const { sheetId, ref } = cells[0];
  const name = sheetId === activeSheetId ? ref : (model.sheets[sheetId]?.name || "another sheet") + "!" + ref;
  toast(cells.length === 1 ? `${name} was also edited elsewhere just now, and that edit replaced yours` : `${cells.length} cells you just edited were also edited elsewhere, and those edits replaced yours`, "bad");
}
function applyRemoteOperation(event: OperationEvent) {
  if (!event || event.senderId === clientId) return;
  const live = event.senderId === "agent" && liveEffectsOn() ? captureLiveEdit(event) : null;
  const replaced: { sheetId: string; ref: string }[] = [];
  applyingRemote = true;
  const namesBefore = sheetNamesKey();
  model.revision = Math.max(model.revision, event.revision || 0);
  if (event.structure) {
    const known = new Set(model.sheetOrder);
    applyStructure(event.structure, event.revision || 0);
    // A sheet someone else just added rises into the tab bar.
    const added = model.sheetOrder.find((id) => !known.has(id));
    if (added && known.size && liveEffectsOn()) newTabId = added;
  }
  for (const up of event.upserts || []) {
    // A local edit that hasn't been saved yet stays on screen; it is sent (and
    // rebased onto this version) by the next save.
    if (pendingCellOps.has(up.sheetId + "!" + up.ref)) continue;
    if (event.senderId !== "agent" && replacesRecentCommit(up.sheetId, up.ref, up.cell.value, up.cell.version)) replaced.push(up);
    const cells = model.cells[up.sheetId] || (model.cells[up.sheetId] = {});
    cells[up.ref] = { ...up.cell };
  }
  for (const del of event.deletes || []) {
    if (pendingCellOps.has(del.sheetId + "!" + del.ref)) continue;
    if (event.senderId !== "agent" && replacesRecentCommit(del.sheetId, del.ref, null, Infinity)) replaced.push(del);
    const cells = model.cells[del.sheetId]; if (cells) delete cells[del.ref];
  }
  const reload: string[] = [];
  if (event.replacedCells) for (const [sid, cells] of Object.entries(event.replacedCells)) {
    if (!model.sheets[sid]) continue;
    forgetHistoryOf(sid);
    if (cells) { layPendingCellOps(sid, cells); model.cells[sid] = cells; } else reload.push(sid);
  }
  applyingRemote = false;
  if (reload.length) reloadSheets(reload);
  // Someone's cell edits: only those cells and what depends on them are recalculated.
  if (!event.replacedCells && sheetNamesKey() === namesBefore) {
    rebuildEngine([...(event.upserts || []), ...(event.deletes || [])].map((x) => ({ sheetId: x.sheetId, ref: x.ref })));
  } else rebuildEngine();
  // Someone else deleted a sheet involved in an edit: the formula's own sheet ends it; the sheet
  // being picked from just sends the edit back to its cell.
  if (editing && !model.sheets[editing.sheetId]) cancelEdit();
  else if (editingAway() && !model.sheets[activeSheetId]) returnToEditingCell();
  if (!model.sheets[activeSheetId]) { if (editing) cancelEdit(); activeSheetId = model.sheetOrder[0]; }
  // A merged structure (local changes replayed on a remote one) still has to be sent.
  if (pendingStructure && !saveInFlight && !saveTimer) scheduleSave(40);
  // A remote edit to a pivot's source re-materializes the pivots reading it.
  schedulePivotRefreshes();
  if (selectedChartId && !(curSheet().charts || []).some((chart) => chart.id === selectedChartId)) selectedChartId = null;
  // Settings left open for a chart or pivot someone else just removed have nothing to edit.
  if (openPop?.pop.classList.contains("settings-pop") && !selectedChartId && !curSheet().pivot) closePop(true);
  renderTabs(); renderGrid(); refreshToolbarState(); updateEditingOrigin(); // (a sheet may have been renamed)
  if (!editing) requestAnimationFrame(() => { const active = getCell(rcToRef(focus.r, focus.c)); if (document.activeElement !== formulaInput) formulaInput.value = active ? active.value : ""; refreshToolbarState(); });
  noticeReplacedCommits(replaced);
  // The grid re-renders on the next frame; the live touch is drawn right after.
  if (live) requestAnimationFrame(() => { try { showLiveEdit(live); } catch (e) { console.error(e); } });
}
// Remote structure replaces the model's (the server keeps the last one written). Local changes
// still pending are diffed against `ackedStructure` and replayed on top, field by field, so a
// remote chart and a local filter on the same sheet both survive.
function applyStructure(s: Structure, revision: number) {
  // A late event mustn't undo a newer structure already applied.
  if (revision < ackedStructureRevision) return;
  // A structure awaiting its save reply is local too: the server applies it after this remote
  // one, so it's replayed here as well (and re-sent merged, since the server holds only ours).
  const localSource = pendingStructure || inFlightStructure;
  const local = localSource ? localStructureChanges(localSource, s) : null;
  if (s.title != null) model.title = s.title;
  model.sheetOrder = s.sheetOrder.slice();
  for (const id of model.sheetOrder) model.sheets[id] = { ...model.sheets[id], ...s.sheets[id] };
  const added = new Set(local?.added);
  for (const id of Object.keys(model.sheets)) if (!model.sheetOrder.includes(id) && !added.has(id)) { delete model.sheets[id]; delete model.cells[id]; }
  ackedStructure = { title: model.title, sheetOrder: model.sheetOrder.slice(), sheets: JSON.parse(JSON.stringify(Object.fromEntries(model.sheetOrder.map((id) => [id, model.sheets[id]])))) };
  ackedStructureRevision = revision;
  if (!local) { invalidateMissingCutSource(); return; }
  if (local.title != null) model.title = local.title;
  for (const id of local.removed) {
    const index = model.sheetOrder.indexOf(id);
    if (index >= 0) { model.sheetOrder.splice(index, 1); delete model.sheets[id]; delete model.cells[id]; }
  }
  for (const [id, fields] of Object.entries(local.sheets)) {
    if (added.has(id) && localSource?.sheets[id]) {
      model.sheets[id] = JSON.parse(JSON.stringify(localSource.sheets[id]));
      if (!model.sheetOrder.includes(id)) model.sheetOrder.push(id);
      if (!model.cells[id]) model.cells[id] = {};
    } else if (model.sheetOrder.includes(id)) Object.assign(model.sheets[id], fields);
    // A sheet deleted remotely while edited here stays deleted.
  }
  if (local.sheetOrder) {
    const order = local.sheetOrder.filter((id) => model.sheetOrder.includes(id));
    model.sheetOrder = [...order, ...model.sheetOrder.filter((id) => !order.includes(id))];
  }
  pendingStructure = structureSnapshot();
  if (pendingReplacements.size === 0) wholesaleBaseRevision = model.revision;
  invalidateMissingCutSource();
}
// What a local structure snapshot changed relative to what the server last acknowledged.
/** What a local structure snapshot changed relative to the last acknowledged one: `null` title/order when unchanged, sheets added and removed, and each sheet's changed fields. */
interface StructureChanges {
  title: string | null;
  sheetOrder: string[] | null;
  added: string[];
  removed: string[];
  sheets: Record<string, Partial<SheetMeta>>;
}
function localStructureChanges(snapshot: Structure, remote?: Structure | null): StructureChanges {
  const base: Structure = ackedStructure || { title: snapshot.title, sheetOrder: [], sheets: {} };
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const changes: StructureChanges = {
    title: snapshot.title !== base.title ? snapshot.title : null,
    sheetOrder: same(snapshot.sheetOrder, base.sheetOrder) ? null : snapshot.sheetOrder,
    added: Object.keys(snapshot.sheets).filter((id) => !base.sheets[id] && !remote?.sheets[id]),
    removed: base.sheetOrder.filter((id) => !snapshot.sheets[id]),
    sheets: {},
  };
  for (const [id, sheet] of Object.entries(snapshot.sheets)) {
    // A new sheet may already have been committed before its reply arrives. Only edits made
    // since the sent snapshot are still local; its first settings mustn't replace the remote ones.
    const baseSheet: SheetMeta | undefined = base.sheets[id] || (remote?.sheets[id] ? inFlightStructure?.sheets[id] || sheet : undefined);
    if (!baseSheet) { changes.sheets[id] = sheet; continue; }
    const fields: Partial<Record<keyof SheetMeta, unknown>> = {};
    for (const key of new Set([...Object.keys(sheet), ...Object.keys(baseSheet)] as (keyof SheetMeta)[])) {
      if (!same(sheet[key], baseSheet[key])) fields[key] = sheet[key];
    }
    // Each field was copied from `sheet` under its own key.
    if (Object.keys(fields).length) changes.sheets[id] = fields as Partial<SheetMeta>;
  }
  return changes;
}

// A snapshot replaces the model. After a reconnect, local edits that were never saved are laid
// back on top (structure merged field by field) so nothing typed is lost.
function applySnapshot(doc: OpenedDocument | SheetsDocument, reconcile = false) {
  applyingRemote = true;
  snapshotGeneration++; reloadAcks.length = 0;
  model.revision = doc.revision || 0;
  model.cells = doc.cells || {};
  const structure = { title: doc.title || "Untitled spreadsheet", sheetOrder: doc.sheetOrder || [], sheets: doc.sheets || {} };
  if (reconcile && ackedStructure) {
    model.sheets = {};
    ackedStructureRevision = -1;
    applyStructure(structure, model.revision);
  } else {
    model.title = structure.title;
    model.sheetOrder = structure.sheetOrder.slice();
    model.sheets = structure.sheets;
    ackedStructure = structureSnapshot();
    ackedStructureRevision = model.revision;
    invalidateMissingCutSource();
  }
  for (const id of model.sheetOrder) if (!model.cells[id]) model.cells[id] = {};
  if (reconcile) {
    for (const [sheetId, cells] of Object.entries(model.cells)) layPendingCellOps(sheetId, cells);
    for (const [sheetId, cells] of pendingReplacements) if (model.sheets[sheetId]) model.cells[sheetId] = copyCellMap(cells);
  }
  replayFloor = model.revision;
  // (As for live updates: a sheet involved in an open edit may be gone after a reconnect.)
  if (editing && !model.sheets[editing.sheetId]) cancelEdit();
  else if (editingAway() && !model.sheets[activeSheetId]) returnToEditingCell();
  if (!activeSheetId || !model.sheets[activeSheetId]) activeSheetId = model.sheetOrder[0];
  applyingRemote = false;
  rebuildEngine();
  renderTabs(); renderGrid();
  updateSelectionUI(); refreshToolbarState(); updateEditingOrigin();
  if (isExport) renderPrintWorkbook();
}

/* ═══════════════════ 11. Collaboration: sync, connect ════════════════════ */

// Events that arrive before the initial (or reconnect) snapshot is applied are
// held back and replayed afterwards, so a snapshot read a moment earlier can't
// overwrite a newer edit.
function replayBuffered() {
  const events = buffered;
  buffered = [];
  for (const event of events) if ((event.revision || 0) > replayFloor) applyRemoteOperation(event);
}
class SheetCallbacks extends RpcTarget implements SubscriberCallbacks {
  // The server's handle on this subscriber is dropped when the connection breaks; subscribe
  // again so live updates keep flowing.
  [Symbol.dispose]() {
    if (subscription === this) subscription = null;
    if (isExport) return;
    ready = false;
    setSync("reconnecting");
    ensureConnected();
  }
  operation(event: SubscriberEvent) {
    if (!ready) { buffered.push(event); return; }
    applyRemoteOperation(event);
  }
  // Nothing is drawn for other people's selections (see sendPresence).
  presence(_event: SheetsPresenceEvent) {}
}
// The subscriber the server holds, until it drops it. A connect attempt that fails after
// subscribing retries without subscribing a second one.
let subscription: SheetCallbacks | null = null;

if (isExport) document.documentElement.classList.add("document-export");

let connectedOnce = false, connecting: Promise<void> | null = null;
async function connect() {
  ready = false;
  for (let attempt = 0; ; attempt++) {
    try {
      let doc: OpenedDocument;
      if (subscription) doc = await gadget.openDocument({ packed: true });
      else {
        // Held before the call returns, so a drop during it is seen.
        const sub = subscription = new SheetCallbacks();
        try { doc = await gadget.subscribe(sub, { clientId, name: collaboratorName, color: collaboratorColor, packed: true }); }
        catch (e) { if (subscription === sub) subscription = null; throw e; }
      }
      // The rest of a big workbook loads page by page; edits made meanwhile are buffered as
      // events and replayed below, which settles any page read mid-edit.
      let noteTimer: ReturnType<typeof setTimeout> | undefined;
      if (!connectedOnce && doc.cursors && Object.keys(doc.cursors).length) {
        // Only a load that takes a moment says how far along it is, so quick ones stay quiet.
        noteTimer = setTimeout(() => skeletonNote.classList.add("show"), 900);
      }
      try {
        await loadRemainingPages(doc, connectedOnce ? null : (n: number) => { skeletonNote.textContent = `Loading… ${n.toLocaleString()} cells`; });
      } finally { clearTimeout(noteTimer); }
      if (!connectedOnce && skeletonNote.classList.contains("show")) {
        // Laying out and calculating the first screen can take a moment more on a big sheet.
        skeletonNote.textContent = "Calculating…";
        await new Promise((resolve) => setTimeout(resolve, 20)); // lets that label paint (no rAF: it pauses in background tabs)
      }
      // The subscriber was dropped meanwhile: subscribe again and re-read.
      if (!subscription) continue;
      applySnapshot(doc, connectedOnce);
      ready = true;
      if (!connectedOnce) {
        connectedOnce = true;
        skeleton.classList.add("gone");
        setTimeout(() => skeleton.remove(), 300);
        updateUndoButtons();
        updateToolFades();
        if (!isExport) gridScroll.focus({ preventScroll: true });
      }
      replayBuffered();
      if (hasPendingSave()) scheduleSave(20);
      else if (syncShown === "offline") hideSync();
      sendPresence();
      return;
    } catch (e) {
      console.error(e);
      buffered = [];
      if (isExport) return;
      setSync("offline");
      await new Promise((resolve) => setTimeout(resolve, Math.min(1e4, 500 * 2 ** attempt)));
    }
  }
}
function ensureConnected(): Promise<void> {
  if (!connecting) connecting = connect().finally(() => { connecting = null; });
  return connecting;
}

await ensureConnected();

