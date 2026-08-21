// ---------------------------------------------------------------------------
// Sheets — a Google-Sheets-style spreadsheet. Same suite chrome as Docs.
// Builds the entire UI in JS. See README.md for architecture.
// ---------------------------------------------------------------------------

const clientId = Math.random().toString(36).slice(2);

// ===========================================================================
// Styles — shares the Docs design tokens, adds grid-specific styling.
// ===========================================================================
const style = document.createElement("style");
style.textContent = `
:root {
  color-scheme: light;
  --bg:        #f6f6f4;
  --surface:   #ffffff;
  --surface-2: #efefec;
  --line:        rgba(20,20,25,0.10);
  --line-strong: rgba(20,20,25,0.18);
  --grid-line:   rgba(20,20,25,0.13);
  --text:   #1d1d20;
  --muted:  #6b6b73;
  --faint:  #9a9aa2;
  --accent: #e1632e;
  --accent-soft: rgba(225,99,46,0.12);
  --ok:#1f9d77; --warn:#b9842f; --bad:#c4566a;
  --ease-out: cubic-bezier(0.23, 1, 0.32, 1);
  --ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);
}
* { box-sizing: border-box; }
html, body {
  margin: 0; height: 100%;
  background: var(--bg); color: var(--text);
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Inter, sans-serif;
  font-size: 13.5px; -webkit-font-smoothing: antialiased;
  overflow: hidden;
}
::selection { background: rgba(225,99,46,0.22); }
* { scrollbar-width: thin; scrollbar-color: rgba(20,20,25,0.22) transparent; }
*::-webkit-scrollbar { width: 11px; height: 11px; }
*::-webkit-scrollbar-thumb { background: rgba(20,20,25,0.22); border-radius: 10px; border: 3px solid transparent; background-clip: content-box; }
*::-webkit-scrollbar-track { background: transparent; }

.app { display: flex; flex-direction: column; height: 100vh; }

/* --- Top bar (identical to Docs) -----------------------------------------*/
.topbar { display: flex; align-items: center; gap: 12px; padding: 8px 16px;
  background: var(--surface); border-bottom: 1px solid var(--line); flex: 0 0 auto; contain: layout style; }
.title-wrap { display: flex; flex-direction: column; min-width: 0; }
.title-input { appearance: none; background: transparent; border: 1px solid transparent; color: var(--text);
  font-size: 15px; font-weight: 600; letter-spacing: -0.01em; padding: 3px 7px; border-radius: 6px;
  width: min(46vw, 420px); transition: border-color .14s var(--ease-out), background .14s var(--ease-out); }
.title-input:hover { border-color: var(--line); }
.title-input:focus { outline: none; border-color: var(--line-strong); background: var(--bg); }
.status { display: flex; align-items: center; gap: 6px; font-size: 11px; letter-spacing: .03em;
  color: var(--faint); flex: 0 0 auto; opacity: .75; transition: opacity .2s var(--ease-out); }
.status:hover { opacity: 1; }
.dot { width: 5px; height: 5px; border-radius: 50%; background: var(--faint); flex: 0 0 auto; }
.dot.saving { background: var(--warn); animation: pulse 1s infinite var(--ease-in-out); }
.dot.saved { background: var(--ok); }
.dot.bad { background: var(--bad); }
.dot.synced { background: var(--accent); animation: pulse .6s 2 var(--ease-in-out); }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .3; } }
.spacer { flex: 1 1 auto; }
.peers { display: flex; align-items: center; gap: -6px; flex: 0 0 auto; }
.peer-badge { width: 24px; height: 24px; border-radius: 50%; display: inline-flex; align-items: center;
  justify-content: center; color: #fff; font-size: 10.5px; font-weight: 650; margin-left: -6px;
  border: 2px solid var(--surface); box-shadow: 0 1px 3px rgba(0,0,0,0.12); }

/* --- Toolbar (identical chrome to Docs) ----------------------------------*/
.toolbar { display: flex; align-items: center; flex-wrap: nowrap; gap: 0; padding: 6px 16px;
  background: var(--surface); border-bottom: 1px solid var(--line); flex: 0 0 auto;
  overflow-x: auto; scrollbar-width: none; contain: layout style; }
.toolbar::-webkit-scrollbar { display: none; }
.tgroup { display: inline-flex; align-items: center; gap: 4px; flex: 0 0 auto; }
.tdiv { width: 1px; height: 20px; background: var(--line); margin: 0 7px; flex: 0 0 auto; }
@media (max-width: 1240px) { .toolbar .p3 { display: none; } }
@media (max-width: 1020px) { .toolbar .p2 { display: none; } }
@media (max-width: 820px)  { .toolbar .p1 { display: none; } }

.icon-btn { width: 28px; height: 28px; flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center;
  background: transparent; border: 1px solid transparent; border-radius: 6px; color: var(--muted); cursor: pointer;
  transition: all .14s var(--ease-out); font-size: 12.5px; font-weight: 600; }
.icon-btn:hover { background: var(--surface-2); border-color: var(--line); color: var(--text); }
.icon-btn:active { transform: scale(0.94); }
.icon-btn.active { background: var(--accent-soft); border-color: rgba(225,99,46,0.35); color: var(--accent); }
.icon-btn svg { width: 16px; height: 16px; }
.icon-btn[disabled] { opacity: .4; pointer-events: none; }

.cselect { appearance: none; background: var(--surface); color: var(--text); border: 1px solid var(--line);
  border-radius: 6px; font-size: 12.5px; height: 28px; padding: 0 8px 0 10px; cursor: pointer;
  display: inline-flex; align-items: center; gap: 6px; flex: 0 0 auto;
  transition: border-color .14s var(--ease-out), background .14s var(--ease-out); }
.cselect:hover { border-color: var(--line-strong); background: var(--surface-2); }
.cselect:active { transform: scale(0.98); }
.cselect.open { border-color: var(--accent); background: var(--surface); }
.cs-label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1 1 auto; text-align: left; }
.cs-chev { display: inline-flex; color: var(--muted); flex: 0 0 auto; transition: transform .14s var(--ease-out); }
.cs-chev svg { width: 12px; height: 12px; }
.cselect.open .cs-chev { transform: rotate(180deg); }
.cselect.fmt-sel { width: 138px; }

.cmenu { position: fixed; z-index: 1000; background: var(--surface); border: 1px solid var(--line-strong);
  border-radius: 8px; padding: 4px; box-shadow: 0 10px 30px rgba(0,0,0,0.16), 0 2px 8px rgba(0,0,0,0.08);
  max-height: 380px; overflow-y: auto; animation: cmenu-in .12s var(--ease-out); min-width: 180px; }
@keyframes cmenu-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
.cmenu-item { padding: 6px 10px; border-radius: 5px; font-size: 13px; color: var(--text); cursor: pointer;
  white-space: nowrap; display: flex; align-items: center; justify-content: space-between; gap: 18px;
  transition: background .1s var(--ease-out); }
.cmenu-item:hover { background: var(--surface-2); }
.cmenu-item.sel { color: var(--accent); }
.cmenu-item .ex { color: var(--faint); font-size: 11.5px; }
.cmenu-sep { height: 1px; background: var(--line); margin: 4px 6px; }

.color-btn { position: relative; width: 28px; height: 28px; flex: 0 0 auto; display: inline-flex; flex-direction: column;
  align-items: center; justify-content: center; background: transparent; border: 1px solid transparent; border-radius: 6px;
  color: var(--muted); cursor: pointer; transition: all .14s var(--ease-out); }
.color-btn:hover { background: var(--surface-2); border-color: var(--line); color: var(--text); }
.color-btn:active { transform: scale(0.94); }
.color-btn svg { width: 15px; height: 15px; margin-top: -1px; }
.color-btn .bar { width: 16px; height: 3px; border-radius: 2px; margin-top: 1px; }
.color-btn input[type=color] { position: absolute; inset: 0; opacity: 0; cursor: pointer; border: none; padding: 0; }

.segment { display: inline-flex; gap: 2px; padding: 2px; background: var(--surface-2); border: 1px solid var(--line); border-radius: 7px; }
.segment .seg-btn { width: 24px; height: 22px; display: inline-flex; align-items: center; justify-content: center;
  background: transparent; border: none; border-radius: 5px; color: var(--muted); cursor: pointer; transition: all .14s var(--ease-out); }
.segment .seg-btn svg { width: 15px; height: 15px; }
.segment .seg-btn.active { background: var(--surface); color: var(--accent); box-shadow: 0 1px 2px rgba(0,0,0,0.08); }

/* --- Formula bar ---------------------------------------------------------*/
.fbar { display: flex; align-items: stretch; height: 30px; flex: 0 0 auto; background: var(--surface);
  border-bottom: 1px solid var(--line); }
.namebox { width: 96px; flex: 0 0 auto; display: flex; align-items: center; justify-content: center;
  font-size: 12.5px; font-weight: 600; color: var(--text); border-right: 1px solid var(--line);
  border: none; border-right: 1px solid var(--line); background: var(--surface); outline: none; text-align: center; }
.namebox:focus { background: var(--bg); box-shadow: inset 0 0 0 1.5px var(--accent); }
.fx { width: 34px; flex: 0 0 auto; display: flex; align-items: center; justify-content: center;
  font-style: italic; font-family: Georgia, serif; color: var(--faint); font-size: 14px; border-right: 1px solid var(--line); }
.finput { flex: 1 1 auto; border: none; outline: none; background: var(--surface); padding: 0 12px;
  font-size: 13px; color: var(--text); font-family: ui-monospace, "SF Mono", Menlo, monospace; }
.finput:focus { background: #fffdfa; }

/* --- Grid ----------------------------------------------------------------*/
.grid-scroll { flex: 1 1 auto; overflow: auto; position: relative; background: var(--surface); outline: none; }
table.grid { border-collapse: separate; border-spacing: 0; table-layout: fixed; width: max-content; }
table.grid th, table.grid td { padding: 0; margin: 0; }
.grid th.colhead, .grid th.rowhead, .grid th.corner {
  background: var(--surface-2); color: var(--muted); font-weight: 500; font-size: 11.5px;
  position: sticky; z-index: 3; user-select: none; text-align: center; vertical-align: middle;
  border-right: 1px solid var(--grid-line); border-bottom: 1px solid var(--grid-line); }
.grid th.colhead { top: 0; z-index: 4; height: 22px; }
.grid th.rowhead { left: 0; z-index: 4; }
.grid th.corner { top: 0; left: 0; z-index: 6; width: 44px; }
.grid th.colhead.hl, .grid th.rowhead.hl { background: #f0dccf; color: var(--accent); }
.grid th.colhead.full, .grid th.rowhead.full { background: var(--accent); color: #fff; }

.grid td.cell { border-right: 1px solid var(--grid-line); border-bottom: 1px solid var(--grid-line);
  height: 24px; overflow: hidden; white-space: nowrap; position: relative;
  font-size: 13px; line-height: 24px; padding: 0 4px; vertical-align: middle; cursor: cell;
  color: var(--text); }
.grid td.cell .cv { display: block; overflow: hidden; text-overflow: clip; white-space: nowrap; }
.grid td.cell.num .cv { text-align: right; }
.grid td.cell.err { color: var(--bad); }
.grid td.cell.err .cv { text-align: center; }
.grid td.cell.sel { background: var(--accent-soft); }
.grid td.cell.active { box-shadow: inset 0 0 0 2px var(--accent); z-index: 2; }
.grid td.cell.wrap { white-space: normal; line-height: 1.35; }
.grid td.cell.wrap .cv { white-space: normal; }

/* Column resize handle */
.col-resize { position: absolute; top: 0; right: -3px; width: 7px; height: 100%; cursor: col-resize; z-index: 5; }
.row-resize { position: absolute; left: 0; bottom: -3px; height: 7px; width: 100%; cursor: row-resize; z-index: 5; }

/* Cell editor overlay */
.cell-editor { position: absolute; z-index: 20; display: none; border: 2px solid var(--accent);
  background: var(--surface); font-size: 13px; line-height: 20px; padding: 1px 3px; margin: 0;
  outline: none; resize: none; overflow: hidden; box-shadow: 0 2px 12px rgba(0,0,0,0.18);
  font-family: ui-sans-serif, system-ui, sans-serif; color: var(--text); border-radius: 0;
  min-width: 60px; white-space: pre; }

/* Remote presence selection boxes */
.remote-layer { position: absolute; inset: 0; pointer-events: none; z-index: 8; }
.remote-box { position: absolute; border: 2px solid; border-radius: 2px; }
.remote-fill { position: absolute; opacity: 0.10; }
.remote-tag { position: absolute; font-size: 10px; font-weight: 650; color: #fff; padding: 1px 5px;
  border-radius: 4px 4px 4px 0; white-space: nowrap; transform: translateY(-100%); }

/* --- Sheet tabs ----------------------------------------------------------*/
.tabbar { display: flex; align-items: flex-end; gap: 3px; padding: 5px 10px 0; flex: 0 0 auto;
  background: var(--surface-2); border-top: 1px solid var(--line); overflow-x: auto; scrollbar-width: none; }
.tabbar::-webkit-scrollbar { display: none; }
.tab { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 14px;
  font-size: 12.5px; color: var(--muted); cursor: pointer; white-space: nowrap; flex: 0 0 auto;
  border-radius: 7px 7px 0 0; transition: background .12s var(--ease-out), color .12s var(--ease-out); max-width: 200px; }
.tab:hover { background: rgba(20,20,25,0.05); color: var(--text); }
.tab.active { background: var(--surface); color: var(--text); font-weight: 600;
  box-shadow: 0 -1px 2px rgba(0,0,0,0.04); }
.tab.active:hover { background: var(--surface); }
.tab .tname { overflow: hidden; text-overflow: ellipsis; }
.tab-add { width: 28px; height: 28px; flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center;
  border-radius: 7px 7px 0 0; color: var(--muted); cursor: pointer; }
.tab-add:hover { background: rgba(20,20,25,0.05); color: var(--text); }
.tab-add svg { width: 15px; height: 15px; }

/* Context menu */
.ctx { position: fixed; z-index: 1200; background: var(--surface); border: 1px solid var(--line-strong);
  border-radius: 9px; padding: 5px; min-width: 190px; box-shadow: 0 14px 40px rgba(0,0,0,0.2);
  animation: cmenu-in .1s var(--ease-out); }
.ctx-item { padding: 7px 11px; border-radius: 6px; font-size: 13px; color: var(--text); cursor: pointer;
  display: flex; align-items: center; justify-content: space-between; gap: 20px; }
.ctx-item:hover { background: var(--surface-2); }
.ctx-item.danger:hover { background: rgba(196,86,106,0.12); color: var(--bad); }
.ctx-item .k { color: var(--faint); font-size: 11px; }
.ctx-sep { height: 1px; background: var(--line); margin: 4px 6px; }

/* Inline dialog (alert/prompt blocked in sandbox) */
.overlay { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
  background: rgba(20,20,25,0.35); backdrop-filter: blur(5px); z-index: 2000; }
.dialog { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 16px;
  width: min(420px, 90vw); display: flex; flex-direction: column; gap: 12px; box-shadow: 0 12px 40px rgba(0,0,0,0.25); }
.dialog .msg { font-size: 13px; color: var(--muted); }
.dialog input { width: 100%; padding: 8px 10px; font-size: 13.5px; border: 1px solid var(--line-strong);
  border-radius: 6px; background: var(--bg); color: var(--text); outline: none; }
.dialog .row { display: flex; justify-content: flex-end; gap: 8px; }
.dialog button { padding: 6px 12px; font-size: 13px; border-radius: 6px; border: 1px solid var(--line);
  background: var(--surface); color: var(--text); cursor: pointer; }
.dialog button.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
.dialog button.danger { background: var(--bad); color: #fff; border-color: var(--bad); }

@media (max-width: 720px) { .title-input { width: 40vw; } .topbar, .toolbar { padding: 8px 12px; } }

#printWorkbook { display: none; }
@page { size: landscape; margin: 0.4in; }
@media print {
  html, body { height: auto; overflow: visible; background: #fff; }
  .app, .ctx, .overlay, .cmenu { display: none !important; }
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
    height: 20px;
    min-width: 0;
    font-size: 8pt;
    line-height: 20px;
    cursor: default;
  }
}
`;
document.head.appendChild(style);

// ===========================================================================
// Small DOM + reference helpers
// ===========================================================================
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c) node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  return node;
}
function icon(paths) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
}
const ICONS = {
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H9"/>',
  redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H15"/>',
  bold: '<path d="M6 4h7a4 4 0 0 1 0 8H6z"/><path d="M6 12h8a4 4 0 0 1 0 8H6z"/>',
  italic: '<line x1="19" y1="4" x2="10" y2="4"/><line x1="14" y1="20" x2="5" y2="20"/><line x1="15" y1="4" x2="9" y2="20"/>',
  underline: '<path d="M6 3v7a6 6 0 0 0 12 0V3"/><line x1="4" y1="21" x2="20" y2="21"/>',
  strike: '<path d="M16 4H9a3 3 0 0 0-2.83 4"/><path d="M14 12a4 4 0 0 1 0 8H6"/><line x1="4" y1="12" x2="20" y2="12"/>',
  textcolor: '<path d="M4 20h16"/><path d="M7 16l5-12 5 12"/><path d="M9 11h6"/>',
  fill: '<path d="M4 20h16"/><path d="M11 4l7 7-7 7-7-7z"/><path d="M11 4l0 0"/>',
  alignLeft: '<line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="14" y2="12"/><line x1="4" y1="18" x2="18" y2="18"/>',
  alignCenter: '<line x1="4" y1="6" x2="20" y2="6"/><line x1="7" y1="12" x2="17" y2="12"/><line x1="5" y1="18" x2="19" y2="18"/>',
  alignRight: '<line x1="4" y1="6" x2="20" y2="6"/><line x1="10" y1="12" x2="20" y2="12"/><line x1="6" y1="18" x2="20" y2="18"/>',
  currency: '<line x1="12" y1="2" x2="12" y2="22"/><path d="M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
  percent: '<line x1="19" y1="5" x2="5" y2="19"/><circle cx="7" cy="7" r="2.2"/><circle cx="17" cy="17" r="2.2"/>',
  decDec: '<path d="M4 8l4 4-4 4"/><text x="11" y="16" font-size="11" fill="currentColor" stroke="none">.0</text>',
  incDec: '<path d="M12 8l-4 4 4 4"/><text x="1" y="16" font-size="11" fill="currentColor" stroke="none">.00</text>',
  wrap: '<line x1="4" y1="6" x2="20" y2="6"/><path d="M4 12h13a3 3 0 0 1 0 6h-3"/><polyline points="16 16 14 18 16 20"/><line x1="4" y1="18" x2="9" y2="18"/>',
  sigma: '<path d="M17 5H7l6 7-6 7h10"/>',
  fx: '<path d="M8 7c0-2 1-3 3-3M6 12h6"/><path d="M14 20c3 0 3-3 5-8s2-8 5-8" transform="translate(-6 -4) scale(0.9)"/>',
  sortAsc: '<path d="M6 4v16"/><path d="M3 8l3-4 3 4"/><line x1="11" y1="6" x2="20" y2="6"/><line x1="11" y1="12" x2="17" y2="12"/><line x1="11" y1="18" x2="14" y2="18"/>',
  sortDesc: '<path d="M6 4v16"/><path d="M3 16l3 4 3-4"/><line x1="11" y1="6" x2="14" y2="6"/><line x1="11" y1="12" x2="17" y2="12"/><line x1="11" y1="18" x2="20" y2="18"/>',
  insRow: '<rect x="3" y="4" width="18" height="6" rx="1"/><line x1="12" y1="14" x2="12" y2="20"/><line x1="9" y1="17" x2="15" y2="17"/>',
  insCol: '<rect x="4" y="3" width="6" height="18" rx="1"/><line x1="17" y1="9" x2="17" y2="15"/><line x1="14" y1="12" x2="20" y2="12"/>',
  trash: '<path d="M4 7h16"/><path d="M9 7V5h6v2"/><path d="M6 7l1 13h10l1-13"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  clear: '<path d="M4 7V5h12v2"/><path d="M9 5l-2 14"/><line x1="14" y1="13" x2="20" y2="19"/><line x1="20" y1="13" x2="14" y2="19"/>',
};

// A1 <-> (row, col) — both zero-based internally.
function colToLetter(c) {
  let s = "";
  c += 1;
  while (c > 0) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); }
  return s;
}
function letterToCol(s) {
  let c = 0;
  for (const ch of s.toUpperCase()) c = c * 26 + (ch.charCodeAt(0) - 64);
  return c - 1;
}
function rcToRef(r, c) { return colToLetter(c) + (r + 1); }
function parseRef(ref) {
  const m = /^\$?([A-Za-z]+)\$?(\d+)$/.exec(ref);
  if (!m) return null;
  return { r: parseInt(m[2], 10) - 1, c: letterToCol(m[1]) };
}

// ===========================================================================
// Formula engine — tokenizer, Pratt parser, evaluator, function library.
// ===========================================================================
class CellError {
  constructor(v) { this.value = v; }
  toString() { return this.value; }
}
const ERR = {
  DIV0: () => new CellError("#DIV/0!"),
  VALUE: () => new CellError("#VALUE!"),
  REF: () => new CellError("#REF!"),
  NAME: () => new CellError("#NAME?"),
  NA: () => new CellError("#N/A"),
  NUM: () => new CellError("#NUM!"),
  CYCLE: () => new CellError("#CYCLE!"),
};
const isErr = (v) => v instanceof CellError;

// --- Tokenizer ---
function tokenize(src) {
  const tokens = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") { i++; continue; }
    if (ch === '"') {
      let j = i + 1, str = "";
      while (j < n) {
        if (src[j] === '"') { if (src[j + 1] === '"') { str += '"'; j += 2; continue; } j++; break; }
        str += src[j++];
      }
      tokens.push({ t: "str", v: str }); i = j; continue;
    }
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(src[i + 1] || ""))) {
      let j = i;
      while (j < n && /[0-9.]/.test(src[j])) j++;
      if (src[j] === "e" || src[j] === "E") { j++; if (src[j] === "+" || src[j] === "-") j++; while (j < n && /[0-9]/.test(src[j])) j++; }
      tokens.push({ t: "num", v: parseFloat(src.slice(i, j)) }); i = j; continue;
    }
    const two = src.slice(i, i + 2);
    if (two === "<=" || two === ">=" || two === "<>") { tokens.push({ t: "op", v: two }); i += 2; continue; }
    if ("+-*/^&=<>%".includes(ch)) { tokens.push({ t: "op", v: ch }); i++; continue; }
    if (ch === "(") { tokens.push({ t: "lp" }); i++; continue; }
    if (ch === ")") { tokens.push({ t: "rp" }); i++; continue; }
    if (ch === ",") { tokens.push({ t: "comma" }); i++; continue; }
    if (ch === ":") { tokens.push({ t: "colon" }); i++; continue; }
    // word: letters/digits/$/./! and quoted sheet names 'My Sheet'!
    if (/[A-Za-z_$]/.test(ch) || ch === "'") {
      let j = i, word = "";
      if (ch === "'") { // 'Sheet Name'!Ref
        j++;
        while (j < n && src[j] !== "'") word += src[j++];
        j++; word = "'" + word + "'";
      } else {
        while (j < n && /[A-Za-z0-9_$.]/.test(src[j])) word += src[j++];
      }
      if (src[j] === "!") { word += "!"; j++; while (j < n && /[A-Za-z0-9_$]/.test(src[j])) word += src[j++]; }
      tokens.push({ t: "word", v: word }); i = j; continue;
    }
    i++; // skip unknown
  }
  return tokens;
}

// --- Parser (produces AST) ---
function parseFormula(src) {
  const tokens = tokenize(src);
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function parseExpr(minbp = 0) {
    let left = parseUnary();
    while (true) {
      const tk = peek();
      if (!tk || tk.t !== "op") break;
      const bp = BP[tk.v];
      if (bp == null || bp.lbp <= minbp) break;
      next();
      const right = parseExpr(bp.lbp - (bp.right ? 1 : 0));
      left = { k: "bin", op: tk.v, a: left, b: right };
    }
    return left;
  }
  function parseUnary() {
    const tk = peek();
    if (tk && tk.t === "op" && (tk.v === "-" || tk.v === "+")) { next(); return { k: "un", op: tk.v, a: parseUnary() }; }
    let node = parsePrimary();
    // postfix percent
    while (peek() && peek().t === "op" && peek().v === "%") { next(); node = { k: "pct", a: node }; }
    return node;
  }
  function parsePrimary() {
    const tk = next();
    if (!tk) throw ERR.VALUE();
    if (tk.t === "num") return { k: "num", v: tk.v };
    if (tk.t === "str") return { k: "str", v: tk.v };
    if (tk.t === "lp") { const e = parseExpr(0); if (peek() && peek().t === "rp") next(); return e; }
    if (tk.t === "word") {
      if (peek() && peek().t === "lp") {
        next();
        const args = [];
        if (!(peek() && peek().t === "rp")) {
          args.push(parseExpr(0));
          while (peek() && peek().t === "comma") { next(); args.push(parseExpr(0)); }
        }
        if (peek() && peek().t === "rp") next();
        return { k: "call", name: tk.v.toUpperCase(), args };
      }
      const up = tk.v.toUpperCase();
      if (up === "TRUE") return { k: "bool", v: true };
      if (up === "FALSE") return { k: "bool", v: false };
      // reference — possibly a range with colon
      let ref = { k: "ref", ref: tk.v };
      if (peek() && peek().t === "colon") { next(); const r2 = next(); ref = { k: "range", a: tk.v, b: r2 ? r2.v : "" }; }
      return ref;
    }
    throw ERR.VALUE();
  }
  const ast = parseExpr(0);
  return ast;
}
const BP = {
  "=": { lbp: 1 }, "<>": { lbp: 1 }, "<": { lbp: 1 }, ">": { lbp: 1 }, "<=": { lbp: 1 }, ">=": { lbp: 1 },
  "&": { lbp: 2 },
  "+": { lbp: 3 }, "-": { lbp: 3 },
  "*": { lbp: 4 }, "/": { lbp: 4 },
  "^": { lbp: 5, right: true },
};

// --- Serializer (AST -> string), used for ref adjustment on insert/delete ---
function serializeAst(node) {
  switch (node.k) {
    case "num": return String(node.v);
    case "str": return '"' + node.v.replace(/"/g, '""') + '"';
    case "bool": return node.v ? "TRUE" : "FALSE";
    case "ref": return node.ref;
    case "range": return node.a + ":" + node.b;
    case "un": return node.op + serializeAst(node.a);
    case "pct": return serializeAst(node.a) + "%";
    case "bin": return serializeAst(node.a) + node.op + serializeAst(node.b);
    case "call": return node.name + "(" + node.args.map(serializeAst).join(",") + ")";
  }
  return "";
}

// ===========================================================================
// Number coercion + formatting
// ===========================================================================
const DATE_EPOCH = Date.UTC(1899, 11, 30);
function serialToDate(s) { return new Date(DATE_EPOCH + Math.round(s * 86400000)); }
function dateToSerial(d) { return (d.getTime() - DATE_EPOCH) / 86400000; }

function toNum(v) {
  if (isErr(v)) throw v;
  if (v == null || v === "") return 0;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  const s = String(v).trim();
  if (s === "") return 0;
  const n = Number(s.replace(/,/g, "").replace(/%$/, ""));
  if (!Number.isFinite(n)) throw ERR.VALUE();
  return s.endsWith("%") ? n / 100 : n;
}
function toStr(v) {
  if (isErr(v)) throw v;
  if (v == null) return "";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return String(v);
}
function toBool(v) {
  if (isErr(v)) throw v;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (v == null || v === "") return false;
  const s = String(v).toUpperCase();
  if (s === "TRUE") return true;
  if (s === "FALSE") return false;
  return toNum(v) !== 0;
}

function fmtNumber(n, decimals, thousands) {
  const opts = { minimumFractionDigits: decimals, maximumFractionDigits: decimals };
  if (!thousands) opts.useGrouping = false;
  return n.toLocaleString("en-US", opts);
}
function fmtGeneral(n) {
  if (!Number.isFinite(n)) return n > 0 ? "#NUM!" : "#NUM!";
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n);
  const abs = Math.abs(n);
  if (abs !== 0 && (abs >= 1e11 || abs < 1e-6)) return n.toExponential(5).replace(/\.?0+e/, "e");
  let s = n.toPrecision(11);
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s;
}
function pad2(x) { return String(x).padStart(2, "0"); }
function fmtDate(serial) {
  const d = serialToDate(serial);
  return `${pad2(d.getUTCMonth() + 1)}/${pad2(d.getUTCDate())}/${d.getUTCFullYear()}`;
}
function fmtTime(serial) {
  const d = serialToDate(serial);
  let h = d.getUTCHours(); const ap = h >= 12 ? "PM" : "AM"; h = h % 12 || 12;
  return `${h}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())} ${ap}`;
}

// Returns { text, numeric, err } for a computed value + format.
function displayValue(computed, fmt) {
  if (isErr(computed)) return { text: computed.value, err: true };
  if (computed == null || computed === "") return { text: "" };
  const nf = fmt?.nf;
  const d = fmt?.d;
  if (typeof computed === "boolean") return { text: computed ? "TRUE" : "FALSE", center: true };
  if (typeof computed === "number") {
    if (!Number.isFinite(computed)) return { text: "#NUM!", err: true };
    let text;
    switch (nf) {
      case "number": text = fmtNumber(computed, d ?? 2, true); break;
      case "integer": text = fmtNumber(Math.round(computed), 0, true); break;
      case "currency": text = (computed < 0 ? "-$" : "$") + fmtNumber(Math.abs(computed), d ?? 2, true); break;
      case "percent": text = fmtNumber(computed * 100, d ?? 2, true) + "%"; break;
      case "scientific": text = computed.toExponential(d ?? 2); break;
      case "date": text = fmtDate(computed); break;
      case "time": text = fmtTime(computed); break;
      case "datetime": text = fmtDate(computed) + " " + fmtTime(computed); break;
      case "text": text = fmtGeneral(computed); break;
      default: text = d != null ? fmtNumber(computed, d, false) : fmtGeneral(computed);
    }
    return { text, numeric: true };
  }
  // string
  if (nf === "text") return { text: String(computed) };
  return { text: String(computed) };
}

// ===========================================================================
// Evaluation context — resolves refs across sheets with memoization + cycles.
// ===========================================================================
// `engine` is rebuilt (cache cleared) whenever the model changes.
function makeEngine(model) {
  const cache = new Map(); // "sheetId!REF" -> value
  const inProgress = new Set();
  const astCache = new Map(); // formula string -> ast|error

  function sheetByName(name) {
    name = name.replace(/^'|'$/g, "");
    for (const id of model.sheetOrder) if (model.sheets[id].name.toLowerCase() === name.toLowerCase()) return id;
    return null;
  }
  function splitRef(ref, defSheet) {
    let sheetId = defSheet;
    let cellPart = ref;
    const bang = ref.indexOf("!");
    if (bang >= 0) {
      const sid = sheetByName(ref.slice(0, bang));
      if (!sid) return null;
      sheetId = sid;
      cellPart = ref.slice(bang + 1);
    }
    const rc = parseRef(cellPart);
    if (!rc) return null;
    return { sheetId, r: rc.r, c: rc.c };
  }

  function rawCellValue(sheetId, r, c) {
    const cells = model.cells[sheetId];
    if (!cells) return null;
    const cell = cells[rcToRef(r, c)];
    if (!cell || cell.value === "" || cell.value == null) return null;
    return cell.value;
  }

  function evalCellRef(sheetId, r, c) {
    const key = sheetId + "!" + rcToRef(r, c);
    if (cache.has(key)) return cache.get(key);
    if (inProgress.has(key)) return ERR.CYCLE();
    const raw = rawCellValue(sheetId, r, c);
    if (raw == null) { cache.set(key, null); return null; }
    let result;
    if (raw[0] === "=") {
      inProgress.add(key);
      try {
        let ast = astCache.get(raw);
        if (ast === undefined) { try { ast = parseFormula(raw.slice(1)); } catch (e) { ast = e instanceof CellError ? e : ERR.VALUE(); } astCache.set(raw, ast); }
        result = isErr(ast) ? ast : evalNode(ast, { sheetId, r, c });
      } catch (e) { result = isErr(e) ? e : ERR.VALUE(); }
      finally { inProgress.delete(key); }
    } else {
      result = literalValue(raw);
    }
    cache.set(key, result);
    return result;
  }

  function literalValue(raw) {
    if (raw[0] === "'") return raw.slice(1);
    const s = raw.trim();
    if (s === "") return "";
    if (/^(TRUE|FALSE)$/i.test(s)) return /^true$/i.test(s);
    // numeric (incl. leading +, %, thousands)
    if (/^[-+]?\$?[\d,]*\.?\d+%?$/.test(s) && /\d/.test(s)) {
      const neg = s.startsWith("-");
      const cleaned = s.replace(/[$,+%-]/g, "");
      let n = Number(cleaned);
      if (Number.isFinite(n)) { if (s.endsWith("%")) n /= 100; return neg ? -n : n; }
    }
    return raw;
  }

  // Matrix wrapper for ranges.
  function makeMatrix(sheetId, r1, c1, r2, c2) {
    return { matrix: true, sheetId, r1, c1, r2, c2,
      get(i, j) { return evalCellRef(sheetId, r1 + i, c1 + j); },
      rows: r2 - r1 + 1, cols: c2 - c1 + 1 };
  }

  function evalNode(node, ctx) {
    switch (node.k) {
      case "num": return node.v;
      case "str": return node.v;
      case "bool": return node.v;
      case "pct": return divSafe(toNum(evalNode(node.a, ctx)), 100);
      case "ref": {
        const p = splitRef(node.ref, ctx.sheetId);
        if (!p) return ERR.REF();
        return evalCellRef(p.sheetId, p.r, p.c);
      }
      case "range": {
        const a = splitRef(node.a, ctx.sheetId);
        const b = splitRef(node.b, ctx.sheetId);
        if (!a || !b) return ERR.REF();
        return makeMatrix(a.sheetId, Math.min(a.r, b.r), Math.min(a.c, b.c), Math.max(a.r, b.r), Math.max(a.c, b.c));
      }
      case "un": {
        const v = evalNode(node.a, ctx);
        if (isErr(v)) return v;
        try { return node.op === "-" ? -toNum(v) : +toNum(v); } catch (e) { return e; }
      }
      case "bin": return evalBin(node, ctx);
      case "call": return callFn(node, ctx);
    }
    return ERR.VALUE();
  }

  function evalBin(node, ctx) {
    const op = node.op;
    let a = evalNode(node.a, ctx), b = evalNode(node.b, ctx);
    if (a && a.matrix) a = a.get(0, 0);
    if (b && b.matrix) b = b.get(0, 0);
    if (isErr(a)) return a;
    if (isErr(b)) return b;
    try {
      if (op === "&") return toStr(a) + toStr(b);
      if ("=<>".includes(op[0]) || op === "<=" || op === ">=" || op === "<>") return compare(a, b, op);
      const x = toNum(a), y = toNum(b);
      switch (op) {
        case "+": return x + y;
        case "-": return x - y;
        case "*": return x * y;
        case "/": return y === 0 ? ERR.DIV0() : x / y;
        case "^": { const r = Math.pow(x, y); return Number.isFinite(r) ? r : ERR.NUM(); }
      }
    } catch (e) { return isErr(e) ? e : ERR.VALUE(); }
    return ERR.VALUE();
  }

  function compare(a, b, op) {
    let x = a == null ? "" : a, y = b == null ? "" : b;
    let cmp;
    if (typeof x === "number" && typeof y === "number") cmp = x - y;
    else if (typeof x === "boolean" || typeof y === "boolean") cmp = (toNum(x) ? 1 : 0) - (toNum(y) ? 1 : 0);
    else cmp = String(x).toLowerCase() < String(y).toLowerCase() ? -1 : String(x).toLowerCase() > String(y).toLowerCase() ? 1 : 0;
    switch (op) {
      case "=": return cmp === 0;
      case "<>": return cmp !== 0;
      case "<": return cmp < 0;
      case ">": return cmp > 0;
      case "<=": return cmp <= 0;
      case ">=": return cmp >= 0;
    }
  }

  // Helpers exposed to builtins.
  const H = {
    evalNode, isErr, ERR, toNum, toStr, toBool, compare, serialToDate, dateToSerial,
    // flat list of scalar values from arg nodes (ranges expanded)
    flatVals(args, ctx) {
      const out = [];
      for (const node of args) collectVals(evalNode(node, ctx), out);
      return out;
    },
    // flat list of numbers, ignoring blanks & non-numeric text (aggregation style)
    flatNums(args, ctx) {
      const out = [];
      for (const node of args) {
        const v = evalNode(node, ctx);
        collectNums(v, out);
      }
      return out;
    },
    scalar(node, ctx) { let v = evalNode(node, ctx); if (v && v.matrix) v = v.get(0, 0); return v; },
    matrixOf(node, ctx) { const v = evalNode(node, ctx); return v && v.matrix ? v : { matrix: true, rows: 1, cols: 1, get: () => v }; },
  };
  function collectVals(v, out) {
    if (v && v.matrix) { for (let i = 0; i < v.rows; i++) for (let j = 0; j < v.cols; j++) out.push(v.get(i, j)); }
    else out.push(v);
  }
  function collectNums(v, out) {
    if (v && v.matrix) {
      for (let i = 0; i < v.rows; i++) for (let j = 0; j < v.cols; j++) {
        const c = v.get(i, j);
        if (isErr(c)) throw c;
        if (typeof c === "number") out.push(c);
        else if (typeof c === "boolean") { /* ranges ignore booleans */ }
      }
    } else {
      if (isErr(v)) throw v;
      if (typeof v === "number") out.push(v);
      else if (typeof v === "boolean") out.push(v ? 1 : 0);
      else if (typeof v === "string" && v.trim() !== "") { const n = Number(v.replace(/,/g, "")); if (Number.isFinite(n)) out.push(n); }
    }
  }

  function callFn(node, ctx) {
    const fn = FUNCTIONS[node.name];
    if (!fn) return ERR.NAME();
    try {
      const r = fn(node.args, ctx, H, { evalCellRef, splitRef, makeMatrix, model });
      return r === undefined ? null : r;
    } catch (e) { return isErr(e) ? e : ERR.VALUE(); }
  }

  return {
    computeRef(sheetId, ref) { const rc = parseRef(ref); return rc ? evalCellRef(sheetId, rc.r, rc.c) : ERR.REF(); },
  };
}
function divSafe(a, b) { return b === 0 ? ERR.DIV0() : a / b; }

// ===========================================================================
// Function library (70+ functions). Signature: (args, ctx, H, R) -> value
// H = helpers, R = raw resolvers { evalCellRef, splitRef, makeMatrix, model }
// ===========================================================================
const FUNCTIONS = (() => {
  const F = {};
  const numArgs = (args, ctx, H) => H.flatNums(args, ctx);
  const s = (args, ctx, H, i) => H.scalar(args[i], ctx);

  // ---- Math / aggregation ----
  F.SUM = (a, c, H) => numArgs(a, c, H).reduce((x, y) => x + y, 0);
  F.SUMSQ = (a, c, H) => numArgs(a, c, H).reduce((x, y) => x + y * y, 0);
  F.PRODUCT = (a, c, H) => { const n = numArgs(a, c, H); return n.length ? n.reduce((x, y) => x * y, 1) : 0; };
  F.AVERAGE = (a, c, H) => { const n = numArgs(a, c, H); if (!n.length) return ERR.DIV0(); return n.reduce((x, y) => x + y, 0) / n.length; };
  F.AVERAGEA = F.AVERAGE;
  F.COUNT = (a, c, H) => numArgs(a, c, H).length;
  F.COUNTA = (a, c, H) => H.flatVals(a, c).filter((v) => v != null && v !== "").length;
  F.COUNTBLANK = (a, c, H) => H.flatVals(a, c).filter((v) => v == null || v === "").length;
  F.MAX = (a, c, H) => { const n = numArgs(a, c, H); return n.length ? Math.max(...n) : 0; };
  F.MIN = (a, c, H) => { const n = numArgs(a, c, H); return n.length ? Math.min(...n) : 0; };
  F.MEDIAN = (a, c, H) => { const n = numArgs(a, c, H).sort((x, y) => x - y); if (!n.length) return ERR.NUM(); const m = n.length >> 1; return n.length % 2 ? n[m] : (n[m - 1] + n[m]) / 2; };
  F.MODE = (a, c, H) => { const n = numArgs(a, c, H); const m = {}; let best = null, bc = 0; for (const x of n) { m[x] = (m[x] || 0) + 1; if (m[x] > bc) { bc = m[x]; best = x; } } return bc > 1 ? best : ERR.NA(); };
  F.ABS = (a, c, H) => Math.abs(H.toNum(s(a, c, H, 0)));
  F.SIGN = (a, c, H) => Math.sign(H.toNum(s(a, c, H, 0)));
  F.SQRT = (a, c, H) => { const x = H.toNum(s(a, c, H, 0)); return x < 0 ? ERR.NUM() : Math.sqrt(x); };
  F.POWER = (a, c, H) => Math.pow(H.toNum(s(a, c, H, 0)), H.toNum(s(a, c, H, 1)));
  F.EXP = (a, c, H) => Math.exp(H.toNum(s(a, c, H, 0)));
  F.LN = (a, c, H) => { const x = H.toNum(s(a, c, H, 0)); return x <= 0 ? ERR.NUM() : Math.log(x); };
  F.LOG10 = (a, c, H) => { const x = H.toNum(s(a, c, H, 0)); return x <= 0 ? ERR.NUM() : Math.log10(x); };
  F.LOG = (a, c, H) => { const x = H.toNum(s(a, c, H, 0)); const b = a.length > 1 ? H.toNum(s(a, c, H, 1)) : 10; return x <= 0 ? ERR.NUM() : Math.log(x) / Math.log(b); };
  F.MOD = (a, c, H) => { const y = H.toNum(s(a, c, H, 1)); if (y === 0) return ERR.DIV0(); const x = H.toNum(s(a, c, H, 0)); return x - Math.floor(x / y) * y; };
  F.INT = (a, c, H) => Math.floor(H.toNum(s(a, c, H, 0)));
  F.TRUNC = (a, c, H) => { const x = H.toNum(s(a, c, H, 0)); const d = a.length > 1 ? H.toNum(s(a, c, H, 1)) : 0; const f = Math.pow(10, d); return Math.trunc(x * f) / f; };
  F.ROUND = (a, c, H) => { const x = H.toNum(s(a, c, H, 0)); const d = a.length > 1 ? H.toNum(s(a, c, H, 1)) : 0; const f = Math.pow(10, d); return Math.round((x * f + (x >= 0 ? 1e-9 : -1e-9))) / f; };
  F.ROUNDUP = (a, c, H) => { const x = H.toNum(s(a, c, H, 0)); const d = a.length > 1 ? H.toNum(s(a, c, H, 1)) : 0; const f = Math.pow(10, d); return (x < 0 ? -1 : 1) * Math.ceil(Math.abs(x) * f) / f; };
  F.ROUNDDOWN = (a, c, H) => { const x = H.toNum(s(a, c, H, 0)); const d = a.length > 1 ? H.toNum(s(a, c, H, 1)) : 0; const f = Math.pow(10, d); return (x < 0 ? -1 : 1) * Math.floor(Math.abs(x) * f) / f; };
  F.MROUND = (a, c, H) => { const x = H.toNum(s(a, c, H, 0)); const m = H.toNum(s(a, c, H, 1)); return m === 0 ? 0 : Math.round(x / m) * m; };
  F.CEILING = (a, c, H) => { const x = H.toNum(s(a, c, H, 0)); const m = a.length > 1 ? H.toNum(s(a, c, H, 1)) : 1; return m === 0 ? 0 : Math.ceil(x / m) * m; };
  F.FLOOR = (a, c, H) => { const x = H.toNum(s(a, c, H, 0)); const m = a.length > 1 ? H.toNum(s(a, c, H, 1)) : 1; return m === 0 ? 0 : Math.floor(x / m) * m; };
  F.PI = () => Math.PI;
  F.SQRTPI = (a, c, H) => Math.sqrt(H.toNum(s(a, c, H, 0)) * Math.PI);
  F.RAND = () => Math.random();
  F.RANDBETWEEN = (a, c, H) => { const lo = Math.ceil(H.toNum(s(a, c, H, 0))); const hi = Math.floor(H.toNum(s(a, c, H, 1))); return lo + Math.floor(Math.random() * (hi - lo + 1)); };
  F.GCD = (a, c, H) => { const n = numArgs(a, c, H).map((x) => Math.abs(Math.trunc(x))); const g = (x, y) => y ? g(y, x % y) : x; return n.reduce((x, y) => g(x, y), 0); };
  F.LCM = (a, c, H) => { const n = numArgs(a, c, H).map((x) => Math.abs(Math.trunc(x))); const g = (x, y) => y ? g(y, x % y) : x; return n.reduce((x, y) => (x && y ? x * y / g(x, y) : 0), 1); };
  F.FACT = (a, c, H) => { let x = Math.floor(H.toNum(s(a, c, H, 0))); if (x < 0) return ERR.NUM(); let r = 1; for (let i = 2; i <= x; i++) r *= i; return r; };
  F.RADIANS = (a, c, H) => H.toNum(s(a, c, H, 0)) * Math.PI / 180;
  F.DEGREES = (a, c, H) => H.toNum(s(a, c, H, 0)) * 180 / Math.PI;
  for (const fn of ["SIN", "COS", "TAN", "ASIN", "ACOS", "ATAN", "SINH", "COSH", "TANH"]) F[fn] = (a, c, H) => Math[fn.toLowerCase()](H.toNum(s(a, c, H, 0)));
  F.ATAN2 = (a, c, H) => Math.atan2(H.toNum(s(a, c, H, 1)), H.toNum(s(a, c, H, 0)));

  // ---- Conditional aggregation ----
  function matchCriteria(val, crit) {
    if (crit == null) return val == null || val === "";
    let c = typeof crit === "string" ? crit : String(crit);
    const m = /^(<=|>=|<>|=|<|>)(.*)$/.exec(c);
    let op = "=", rhs = c;
    if (m) { op = m[1]; rhs = m[2]; }
    const rn = Number(rhs);
    const rhsNum = rhs.trim() !== "" && Number.isFinite(rn);
    if (op === "=" || op === "<>") {
      let eq;
      if (rhsNum && typeof val === "number") eq = val === rn;
      else if (/[*?]/.test(rhs)) { const re = wildToRe(rhs); eq = re.test(String(val ?? "")); }
      else eq = String(val ?? "").toLowerCase() === rhs.toLowerCase();
      return op === "=" ? eq : !eq;
    }
    const vn = typeof val === "number" ? val : Number(val);
    if (!Number.isFinite(vn) || !rhsNum) {
      const a = String(val ?? "").toLowerCase(), b = rhs.toLowerCase();
      const cmp = a < b ? -1 : a > b ? 1 : 0;
      return op === "<" ? cmp < 0 : op === ">" ? cmp > 0 : op === "<=" ? cmp <= 0 : cmp >= 0;
    }
    return op === "<" ? vn < rn : op === ">" ? vn > rn : op === "<=" ? vn <= rn : vn >= rn;
  }
  function wildToRe(p) { return new RegExp("^" + p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i"); }
  function matVals(m) { const o = []; for (let i = 0; i < m.rows; i++) for (let j = 0; j < m.cols; j++) o.push(m.get(i, j)); return o; }

  F.SUMIF = (a, c, H) => {
    const range = matVals(H.matrixOf(a[0], c));
    const crit = a.length > 1 ? H.scalar(a[1], c) : null;
    const sumRange = a.length > 2 ? matVals(H.matrixOf(a[2], c)) : range;
    let t = 0; for (let i = 0; i < range.length; i++) if (matchCriteria(range[i], crit)) { const v = sumRange[i]; if (typeof v === "number") t += v; }
    return t;
  };
  F.COUNTIF = (a, c, H) => { const range = matVals(H.matrixOf(a[0], c)); const crit = a.length > 1 ? H.scalar(a[1], c) : null; return range.filter((v) => matchCriteria(v, crit)).length; };
  F.AVERAGEIF = (a, c, H) => {
    const range = matVals(H.matrixOf(a[0], c));
    const crit = a.length > 1 ? H.scalar(a[1], c) : null;
    const avgRange = a.length > 2 ? matVals(H.matrixOf(a[2], c)) : range;
    let t = 0, n = 0; for (let i = 0; i < range.length; i++) if (matchCriteria(range[i], crit)) { const v = avgRange[i]; if (typeof v === "number") { t += v; n++; } }
    return n ? t / n : ERR.DIV0();
  };
  function ifsMatch(a, c, H, startIdx) {
    // returns boolean array over first criteria range
    const pairs = [];
    for (let i = startIdx; i + 1 < a.length; i += 2) pairs.push([matVals(H.matrixOf(a[i], c)), H.scalar(a[i + 1], c)]);
    const len = pairs.length ? pairs[0][0].length : 0;
    const mask = [];
    for (let i = 0; i < len; i++) mask.push(pairs.every(([rng, cr]) => matchCriteria(rng[i], cr)));
    return mask;
  }
  F.SUMIFS = (a, c, H) => { const sum = matVals(H.matrixOf(a[0], c)); const mask = ifsMatch(a, c, H, 1); let t = 0; for (let i = 0; i < mask.length; i++) if (mask[i] && typeof sum[i] === "number") t += sum[i]; return t; };
  F.COUNTIFS = (a, c, H) => ifsMatch(a, c, H, 0).filter(Boolean).length;
  F.AVERAGEIFS = (a, c, H) => { const avg = matVals(H.matrixOf(a[0], c)); const mask = ifsMatch(a, c, H, 1); let t = 0, n = 0; for (let i = 0; i < mask.length; i++) if (mask[i] && typeof avg[i] === "number") { t += avg[i]; n++; } return n ? t / n : ERR.DIV0(); };
  F.SUMPRODUCT = (a, c, H) => {
    const mats = a.map((nd) => H.matrixOf(nd, c));
    const rows = mats[0].rows, cols = mats[0].cols;
    let t = 0;
    for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) {
      let p = 1; for (const m of mats) { const v = m.get(i, j); p *= (typeof v === "number" ? v : (typeof v === "boolean" ? (v ? 1 : 0) : 0)); } t += p;
    }
    return t;
  };

  // ---- Statistics ----
  function stdVar(vals, pop, variance) {
    if (vals.length < (pop ? 1 : 2)) return ERR.DIV0();
    const mean = vals.reduce((x, y) => x + y, 0) / vals.length;
    const ss = vals.reduce((x, y) => x + (y - mean) ** 2, 0);
    const v = ss / (vals.length - (pop ? 0 : 1));
    return variance ? v : Math.sqrt(v);
  }
  F.STDEV = (a, c, H) => stdVar(numArgs(a, c, H), false, false);
  F.STDEVP = (a, c, H) => stdVar(numArgs(a, c, H), true, false);
  F.VAR = (a, c, H) => stdVar(numArgs(a, c, H), false, true);
  F.VARP = (a, c, H) => stdVar(numArgs(a, c, H), true, true);
  F.LARGE = (a, c, H) => { const n = matVals(H.matrixOf(a[0], c)).filter((v) => typeof v === "number").sort((x, y) => y - x); const k = H.toNum(s(a, c, H, 1)); return n[k - 1] ?? ERR.NUM(); };
  F.SMALL = (a, c, H) => { const n = matVals(H.matrixOf(a[0], c)).filter((v) => typeof v === "number").sort((x, y) => x - y); const k = H.toNum(s(a, c, H, 1)); return n[k - 1] ?? ERR.NUM(); };
  F.RANK = (a, c, H) => { const x = H.toNum(s(a, c, H, 0)); const arr = matVals(H.matrixOf(a[1], c)).filter((v) => typeof v === "number"); const asc = a.length > 2 && H.toBool(s(a, c, H, 2)); const sorted = arr.slice().sort((p, q) => asc ? p - q : q - p); const i = sorted.indexOf(x); return i < 0 ? ERR.NA() : i + 1; };
  F.PERCENTILE = (a, c, H) => { const arr = matVals(H.matrixOf(a[0], c)).filter((v) => typeof v === "number").sort((x, y) => x - y); const p = H.toNum(s(a, c, H, 1)); if (!arr.length) return ERR.NUM(); const idx = p * (arr.length - 1); const lo = Math.floor(idx); return arr[lo] + (arr[Math.min(lo + 1, arr.length - 1)] - arr[lo]) * (idx - lo); };

  // ---- Logical ----
  F.IF = (a, c, H) => { const t = H.toBool(H.scalar(a[0], c)); if (t) return a.length > 1 ? H.scalar(a[1], c) : true; return a.length > 2 ? H.scalar(a[2], c) : false; };
  F.IFS = (a, c, H) => { for (let i = 0; i + 1 < a.length; i += 2) if (H.toBool(H.scalar(a[i], c))) return H.scalar(a[i + 1], c); return ERR.NA(); };
  F.IFERROR = (a, c, H) => { const v = H.scalar(a[0], c); return isErr(v) ? (a.length > 1 ? H.scalar(a[1], c) : "") : v; };
  F.IFNA = (a, c, H) => { const v = H.scalar(a[0], c); return isErr(v) && v.value === "#N/A" ? H.scalar(a[1], c) : v; };
  F.AND = (a, c, H) => { for (const v of H.flatVals(a, c)) { if (isErr(v)) return v; if (v != null && v !== "" && !H.toBool(v)) return false; } return true; };
  F.OR = (a, c, H) => { let any = false; for (const v of H.flatVals(a, c)) { if (isErr(v)) return v; if (v != null && v !== "" && H.toBool(v)) any = true; } return any; };
  F.XOR = (a, c, H) => { let cnt = 0; for (const v of H.flatVals(a, c)) if (H.toBool(v)) cnt++; return cnt % 2 === 1; };
  F.NOT = (a, c, H) => !H.toBool(H.scalar(a[0], c));
  F.TRUE = () => true;
  F.FALSE = () => false;
  F.SWITCH = (a, c, H) => { const target = H.scalar(a[0], c); let i = 1; for (; i + 1 < a.length; i += 2) { if (H.compare(target, H.scalar(a[i], c), "=")) return H.scalar(a[i + 1], c); } return i < a.length ? H.scalar(a[i], c) : ERR.NA(); };

  // ---- Text ----
  F.CONCAT = (a, c, H) => H.flatVals(a, c).map((v) => v == null ? "" : H.toStr(v)).join("");
  F.CONCATENATE = F.CONCAT;
  F.TEXTJOIN = (a, c, H) => { const delim = H.toStr(H.scalar(a[0], c)); const skip = H.toBool(H.scalar(a[1], c)); const vals = H.flatVals(a.slice(2), c).map((v) => v == null ? "" : H.toStr(v)); return (skip ? vals.filter((v) => v !== "") : vals).join(delim); };
  F.LEFT = (a, c, H) => { const t = H.toStr(H.scalar(a[0], c)); const n = a.length > 1 ? H.toNum(H.scalar(a[1], c)) : 1; return t.slice(0, Math.max(0, n)); };
  F.RIGHT = (a, c, H) => { const t = H.toStr(H.scalar(a[0], c)); const n = a.length > 1 ? H.toNum(H.scalar(a[1], c)) : 1; return n <= 0 ? "" : t.slice(-n); };
  F.MID = (a, c, H) => { const t = H.toStr(H.scalar(a[0], c)); const start = H.toNum(H.scalar(a[1], c)); const len = H.toNum(H.scalar(a[2], c)); return t.slice(Math.max(0, start - 1), Math.max(0, start - 1) + Math.max(0, len)); };
  F.LEN = (a, c, H) => H.toStr(H.scalar(a[0], c)).length;
  F.LOWER = (a, c, H) => H.toStr(H.scalar(a[0], c)).toLowerCase();
  F.UPPER = (a, c, H) => H.toStr(H.scalar(a[0], c)).toUpperCase();
  F.PROPER = (a, c, H) => H.toStr(H.scalar(a[0], c)).replace(/\b\w/g, (m) => m.toUpperCase()).replace(/\B\w/g, (m) => m.toLowerCase());
  F.TRIM = (a, c, H) => H.toStr(H.scalar(a[0], c)).replace(/\s+/g, " ").trim();
  F.CLEAN = (a, c, H) => H.toStr(H.scalar(a[0], c)).replace(/[\x00-\x1F]/g, "");
  F.SUBSTITUTE = (a, c, H) => { const t = H.toStr(H.scalar(a[0], c)); const oldT = H.toStr(H.scalar(a[1], c)); const newT = H.toStr(H.scalar(a[2], c)); if (a.length > 3) { const inst = H.toNum(H.scalar(a[3], c)); let k = 0; let idx = -1; while ((idx = t.indexOf(oldT, idx + 1)) >= 0) { if (++k === inst) return t.slice(0, idx) + newT + t.slice(idx + oldT.length); } return t; } return oldT === "" ? t : t.split(oldT).join(newT); };
  F.REPLACE = (a, c, H) => { const t = H.toStr(H.scalar(a[0], c)); const start = H.toNum(H.scalar(a[1], c)); const len = H.toNum(H.scalar(a[2], c)); const newT = H.toStr(H.scalar(a[3], c)); return t.slice(0, start - 1) + newT + t.slice(start - 1 + len); };
  F.FIND = (a, c, H) => { const find = H.toStr(H.scalar(a[0], c)); const within = H.toStr(H.scalar(a[1], c)); const start = a.length > 2 ? H.toNum(H.scalar(a[2], c)) : 1; const i = within.indexOf(find, start - 1); return i < 0 ? ERR.VALUE() : i + 1; };
  F.SEARCH = (a, c, H) => { const find = H.toStr(H.scalar(a[0], c)).toLowerCase(); const within = H.toStr(H.scalar(a[1], c)).toLowerCase(); const start = a.length > 2 ? H.toNum(H.scalar(a[2], c)) : 1; const i = within.indexOf(find, start - 1); return i < 0 ? ERR.VALUE() : i + 1; };
  F.REPT = (a, c, H) => H.toStr(H.scalar(a[0], c)).repeat(Math.max(0, H.toNum(H.scalar(a[1], c))));
  F.EXACT = (a, c, H) => H.toStr(H.scalar(a[0], c)) === H.toStr(H.scalar(a[1], c));
  F.CHAR = (a, c, H) => String.fromCharCode(H.toNum(H.scalar(a[0], c)));
  F.UNICHAR = (a, c, H) => String.fromCodePoint(H.toNum(H.scalar(a[0], c)));
  F.CODE = (a, c, H) => { const t = H.toStr(H.scalar(a[0], c)); return t ? t.charCodeAt(0) : ERR.VALUE(); };
  F.UNICODE = (a, c, H) => { const t = H.toStr(H.scalar(a[0], c)); return t ? t.codePointAt(0) : ERR.VALUE(); };
  F.T = (a, c, H) => { const v = H.scalar(a[0], c); return typeof v === "string" ? v : ""; };
  F.VALUE = (a, c, H) => H.toNum(H.scalar(a[0], c));
  F.TEXT = (a, c, H) => { const v = H.toNum(H.scalar(a[0], c)); const f = H.toStr(H.scalar(a[1], c)); return applyTextFormat(v, f); };

  function applyTextFormat(v, f) {
    if (/%/.test(f)) { const dec = (f.split(".")[1] || "").length; return (v * 100).toFixed(dec) + "%"; }
    if (/[$]/.test(f)) { const dec = (f.split(".")[1] || "").replace(/[^0#]/g, "").length; return "$" + v.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec }); }
    if (/yy|mm|dd|hh/i.test(f)) return formatDatePattern(v, f);
    if (/0|#/.test(f)) { const dec = (f.split(".")[1] || "").replace(/[^0#]/g, "").length; const grp = /[#0],[#0]/.test(f) || /,/.test(f.split(".")[0]); return v.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec, useGrouping: grp }); }
    return String(v);
  }
  function formatDatePattern(serial, f) {
    const d = serialToDate(serial);
    const M = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    const D = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    let h12 = d.getUTCHours() % 12 || 12;
    return f
      .replace(/yyyy/gi, d.getUTCFullYear())
      .replace(/yy/gi, String(d.getUTCFullYear()).slice(-2))
      .replace(/mmmm/gi, M[d.getUTCMonth()])
      .replace(/mmm/gi, M[d.getUTCMonth()].slice(0, 3))
      .replace(/mm/g, pad2(d.getUTCMonth() + 1))
      .replace(/dddd/gi, D[d.getUTCDay()])
      .replace(/ddd/gi, D[d.getUTCDay()].slice(0, 3))
      .replace(/dd/gi, pad2(d.getUTCDate()))
      .replace(/hh/gi, pad2(d.getUTCHours()))
      .replace(/ss/gi, pad2(d.getUTCSeconds()));
  }

  // ---- Lookup / reference ----
  F.CHOOSE = (a, c, H) => { const i = H.toNum(H.scalar(a[0], c)); return i >= 1 && i < a.length ? H.scalar(a[i], c) : ERR.VALUE(); };
  F.ROW = (a, c, H, R) => { if (!a.length) return c.r + 1; const nd = a[0]; if (nd.k === "ref") { const p = R.splitRef(nd.ref, c.sheetId); return p ? p.r + 1 : ERR.REF(); } if (nd.k === "range") { const p = R.splitRef(nd.a, c.sheetId); return p ? p.r + 1 : ERR.REF(); } return ERR.REF(); };
  F.COLUMN = (a, c, H, R) => { if (!a.length) return c.c + 1; const nd = a[0]; if (nd.k === "ref") { const p = R.splitRef(nd.ref, c.sheetId); return p ? p.c + 1 : ERR.REF(); } if (nd.k === "range") { const p = R.splitRef(nd.a, c.sheetId); return p ? p.c + 1 : ERR.REF(); } return ERR.REF(); };
  F.ROWS = (a, c, H) => H.matrixOf(a[0], c).rows;
  F.COLUMNS = (a, c, H) => H.matrixOf(a[0], c).cols;
  F.MATCH = (a, c, H) => {
    const target = H.scalar(a[0], c);
    const m = H.matrixOf(a[1], c);
    const type = a.length > 2 ? H.toNum(H.scalar(a[2], c)) : 1;
    const arr = matVals(m);
    if (type === 0) {
      for (let i = 0; i < arr.length; i++) {
        if (typeof target === "string" && /[*?]/.test(target)) { if (wildToRe(target).test(String(arr[i] ?? ""))) return i + 1; }
        else if (H.compare(arr[i], target, "=")) return i + 1;
      }
      return ERR.NA();
    }
    // 1: largest <= target (asc); -1: smallest >= target (desc)
    let best = -1;
    for (let i = 0; i < arr.length; i++) {
      const cmp = type === 1 ? H.compare(arr[i], target, "<=") : H.compare(arr[i], target, ">=");
      if (cmp) best = i;
    }
    return best < 0 ? ERR.NA() : best + 1;
  };
  F.INDEX = (a, c, H) => {
    const m = H.matrixOf(a[0], c);
    let row = a.length > 1 ? H.toNum(H.scalar(a[1], c)) : 0;
    let col = a.length > 2 ? H.toNum(H.scalar(a[2], c)) : 0;
    if (m.rows === 1 && a.length === 2) { col = row; row = 1; }
    if (col === 0 && m.cols === 1) col = 1;
    if (row === 0 && m.rows === 1) row = 1;
    if (row < 1 || row > m.rows || col < 1 || col > m.cols) return ERR.REF();
    return m.get(row - 1, col - 1);
  };
  F.VLOOKUP = (a, c, H) => {
    const target = H.scalar(a[0], c);
    const m = H.matrixOf(a[1], c);
    const colIdx = H.toNum(H.scalar(a[2], c));
    const approx = a.length > 3 ? H.toBool(H.scalar(a[3], c)) : true;
    if (colIdx < 1 || colIdx > m.cols) return ERR.REF();
    let found = -1;
    for (let i = 0; i < m.rows; i++) {
      const v = m.get(i, 0);
      if (!approx) { if (typeof target === "string" && /[*?]/.test(target) ? wildToRe(target).test(String(v ?? "")) : H.compare(v, target, "=")) { found = i; break; } }
      else { if (H.compare(v, target, "<=")) found = i; else break; }
    }
    return found < 0 ? ERR.NA() : m.get(found, colIdx - 1);
  };
  F.HLOOKUP = (a, c, H) => {
    const target = H.scalar(a[0], c);
    const m = H.matrixOf(a[1], c);
    const rowIdx = H.toNum(H.scalar(a[2], c));
    const approx = a.length > 3 ? H.toBool(H.scalar(a[3], c)) : true;
    if (rowIdx < 1 || rowIdx > m.rows) return ERR.REF();
    let found = -1;
    for (let j = 0; j < m.cols; j++) {
      const v = m.get(0, j);
      if (!approx) { if (H.compare(v, target, "=")) { found = j; break; } }
      else { if (H.compare(v, target, "<=")) found = j; else break; }
    }
    return found < 0 ? ERR.NA() : m.get(rowIdx - 1, found);
  };
  F.LOOKUP = (a, c, H) => {
    const target = H.scalar(a[0], c);
    const m = H.matrixOf(a[1], c);
    const vec = matVals(m);
    const result = a.length > 2 ? matVals(H.matrixOf(a[2], c)) : vec;
    let found = -1;
    for (let i = 0; i < vec.length; i++) { if (H.compare(vec[i], target, "<=")) found = i; else break; }
    return found < 0 ? ERR.NA() : (result[found] ?? ERR.NA());
  };

  // ---- Date & time ----
  F.TODAY = () => { const n = new Date(); return Math.floor(dateToSerial(new Date(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate())))); };
  F.NOW = () => { const n = new Date(); return dateToSerial(new Date(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate(), n.getHours(), n.getMinutes(), n.getSeconds()))); };
  F.DATE = (a, c, H) => { const y = H.toNum(s(a, c, H, 0)); const m = H.toNum(s(a, c, H, 1)); const d = H.toNum(s(a, c, H, 2)); return dateToSerial(new Date(Date.UTC(y, m - 1, d))); };
  F.TIME = (a, c, H) => { const h = H.toNum(s(a, c, H, 0)); const m = H.toNum(s(a, c, H, 1)); const sec = H.toNum(s(a, c, H, 2)); return (h * 3600 + m * 60 + sec) / 86400; };
  F.YEAR = (a, c, H) => serialToDate(H.toNum(s(a, c, H, 0))).getUTCFullYear();
  F.MONTH = (a, c, H) => serialToDate(H.toNum(s(a, c, H, 0))).getUTCMonth() + 1;
  F.DAY = (a, c, H) => serialToDate(H.toNum(s(a, c, H, 0))).getUTCDate();
  F.HOUR = (a, c, H) => serialToDate(H.toNum(s(a, c, H, 0))).getUTCHours();
  F.MINUTE = (a, c, H) => serialToDate(H.toNum(s(a, c, H, 0))).getUTCMinutes();
  F.SECOND = (a, c, H) => serialToDate(H.toNum(s(a, c, H, 0))).getUTCSeconds();
  F.WEEKDAY = (a, c, H) => { const d = serialToDate(H.toNum(s(a, c, H, 0))).getUTCDay(); const type = a.length > 1 ? H.toNum(s(a, c, H, 1)) : 1; if (type === 2) return d === 0 ? 7 : d; if (type === 3) return (d + 6) % 7; return d + 1; };
  F.WEEKNUM = (a, c, H) => { const d = serialToDate(H.toNum(s(a, c, H, 0))); const start = Date.UTC(d.getUTCFullYear(), 0, 1); return Math.floor(((d - start) / 86400000 + new Date(start).getUTCDay()) / 7) + 1; };
  F.DAYS = (a, c, H) => H.toNum(s(a, c, H, 0)) - H.toNum(s(a, c, H, 1));
  F.EDATE = (a, c, H) => { const d = serialToDate(H.toNum(s(a, c, H, 0))); const mo = H.toNum(s(a, c, H, 1)); return dateToSerial(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + mo, d.getUTCDate()))); };
  F.EOMONTH = (a, c, H) => { const d = serialToDate(H.toNum(s(a, c, H, 0))); const mo = H.toNum(s(a, c, H, 1)); return dateToSerial(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + mo + 1, 0))); };
  F.DATEDIF = (a, c, H) => { const s1 = serialToDate(H.toNum(s(a, c, H, 0))); const s2 = serialToDate(H.toNum(s(a, c, H, 1))); const unit = H.toStr(H.scalar(a[2], c)).toUpperCase(); const days = (s2 - s1) / 86400000; if (unit === "D") return Math.round(days); if (unit === "M") return (s2.getUTCFullYear() - s1.getUTCFullYear()) * 12 + (s2.getUTCMonth() - s1.getUTCMonth()); if (unit === "Y") return s2.getUTCFullYear() - s1.getUTCFullYear(); return ERR.NUM(); };

  // ---- Information ----
  F.ISBLANK = (a, c, H) => { const v = H.scalar(a[0], c); return v == null || v === ""; };
  F.ISNUMBER = (a, c, H) => typeof H.scalar(a[0], c) === "number";
  F.ISTEXT = (a, c, H) => typeof H.scalar(a[0], c) === "string";
  F.ISNONTEXT = (a, c, H) => typeof H.scalar(a[0], c) !== "string";
  F.ISLOGICAL = (a, c, H) => typeof H.scalar(a[0], c) === "boolean";
  F.ISERROR = (a, c, H) => isErr(H.scalar(a[0], c));
  F.ISERR = (a, c, H) => { const v = H.scalar(a[0], c); return isErr(v) && v.value !== "#N/A"; };
  F.ISNA = (a, c, H) => { const v = H.scalar(a[0], c); return isErr(v) && v.value === "#N/A"; };
  F.ISEVEN = (a, c, H) => Math.trunc(H.toNum(H.scalar(a[0], c))) % 2 === 0;
  F.ISODD = (a, c, H) => Math.abs(Math.trunc(H.toNum(H.scalar(a[0], c))) % 2) === 1;
  F.N = (a, c, H) => { const v = H.scalar(a[0], c); if (typeof v === "number") return v; if (typeof v === "boolean") return v ? 1 : 0; return 0; };
  F.NA = () => ERR.NA();
  F.ERRORTYPE = (a, c, H) => { const v = H.scalar(a[0], c); if (!isErr(v)) return ERR.NA(); const map = { "#NULL!": 1, "#DIV/0!": 2, "#VALUE!": 3, "#REF!": 4, "#NAME?": 5, "#NUM!": 6, "#N/A": 7 }; return map[v.value] || ERR.NA(); };

  return F;
})();

// Full list of function names for the insert-function menu / documentation.
const FUNCTION_NAMES = Object.keys(FUNCTIONS).sort();

// ===========================================================================
// Client model + collaboration state
// ===========================================================================
const DEFAULT_COL_W = 92;
const DEFAULT_ROW_H = 24;
const HEAD_W = 44;
const MAX_PRINT_CELLS = 100000;

const model = {
  revision: 0,
  title: "Untitled spreadsheet",
  sheetOrder: [],
  sheets: {},           // id -> { id, name, rows, cols, colWidths, rowHeights, frozenRows, frozenCols }
  cells: {},            // id -> { REF -> { value, fmt, version } }
};
let activeSheetId = null;
let engine = makeEngine(model);
function rebuildEngine() { engine = makeEngine(model); }

// Selection: anchor + focus (row/col). The visible rectangle is selRange().
let anchor = { r: 0, c: 0 };
function selRange() {
  return { r1: Math.min(anchor.r, focus.r), c1: Math.min(anchor.c, focus.c), r2: Math.max(anchor.r, focus.r), c2: Math.max(anchor.c, focus.c) };
}
let focus = { r: 0, c: 0 };

const collaboratorName = "Guest " + clientId.slice(0, 4).toUpperCase();
const collaboratorColor = `hsl(${parseInt(clientId.slice(0, 6), 36) % 360} 62% 48%)`;
const collaborators = new Map();

// ===========================================================================
// Sheet accessors
// ===========================================================================
function curSheet() { return model.sheets[activeSheetId]; }
function curCells() { return model.cells[activeSheetId] || (model.cells[activeSheetId] = {}); }
function getCell(ref) { return curCells()[ref] || null; }
function cellRaw(ref) { const c = getCell(ref); return c ? c.value : ""; }
function colWidth(c) { return curSheet().colWidths[c] || DEFAULT_COL_W; }
function rowHeight(r) { return curSheet().rowHeights[r] || DEFAULT_ROW_H; }

// ===========================================================================
// Build chrome: topbar, toolbar, formula bar, grid container, tabs
// ===========================================================================
const titleInput = el("input", { class: "title-input", value: "Untitled spreadsheet", "aria-label": "Spreadsheet title" });
const statusDot = el("span", { class: "dot saved" });
const statusText = el("span", {}, "Saved");
const peersEl = el("div", { class: "peers" });
const topbar = el("div", { class: "topbar" }, [
  el("div", { class: "title-wrap" }, [titleInput]),
  el("div", { class: "spacer" }),
  el("div", { class: "status", title: "Save status" }, [statusDot, statusText]),
]);

// --- Toolbar builders (reuse Docs patterns) ---
function iconBtn(name, title, onClick, label) {
  const b = el("button", { class: "icon-btn", title });
  if (label) b.textContent = label; else b.innerHTML = icon(ICONS[name]);
  b.addEventListener("mousedown", (e) => e.preventDefault());
  b.addEventListener("click", onClick);
  return b;
}
function group(prio, items, first = false) {
  const children = first ? [] : [el("div", { class: "tdiv" })];
  children.push(...items);
  return el("div", { class: "tgroup" + (prio ? " " + prio : "") }, children);
}
const chevSvg = icon('<polyline points="6 9 12 15 18 9"/>');
function customSelect({ className, title, options, value, onChange, width }) {
  let current;
  const labelSpan = el("span", { class: "cs-label" });
  const btn = el("button", { type: "button", class: "cselect " + (className || ""), title }, [labelSpan, el("span", { class: "cs-chev", html: chevSvg })]);
  const menu = el("div", { class: "cmenu" });
  const items = options.map((o) => {
    if (o.sep) { const sp = el("div", { class: "cmenu-sep" }); menu.appendChild(sp); return null; }
    const item = el("div", { class: "cmenu-item", "data-value": String(o.value) }, [
      el("span", {}, o.label), o.ex ? el("span", { class: "ex" }, o.ex) : null,
    ]);
    item.addEventListener("mousedown", (e) => e.preventDefault());
    item.addEventListener("click", () => { closeMenu(); setValue(o.value); onChange(o.value); });
    menu.appendChild(item);
    return item;
  }).filter(Boolean);
  let open = false;
  function setValue(v) {
    current = v;
    const opt = options.find((o) => o.value === v);
    labelSpan.textContent = opt ? opt.label : (options.find(o=>!o.sep)?.label || "");
    items.forEach((it) => it.classList.toggle("sel", it.dataset.value === String(v)));
  }
  function openMenu() {
    const r = btn.getBoundingClientRect();
    menu.style.left = Math.round(r.left) + "px";
    menu.style.top = Math.round(r.bottom + 4) + "px";
    menu.style.minWidth = Math.round(r.width) + "px";
    document.body.appendChild(menu);
    open = true; btn.classList.add("open");
  }
  function closeMenu() { if (menu.parentNode) menu.parentNode.removeChild(menu); open = false; btn.classList.remove("open"); }
  btn.addEventListener("click", () => { open ? closeMenu() : openMenu(); });
  document.addEventListener("mousedown", (e) => { if (open && !menu.contains(e.target) && !btn.contains(e.target)) closeMenu(); });
  window.addEventListener("scroll", () => { if (open) closeMenu(); }, true);
  window.addEventListener("resize", () => { if (open) closeMenu(); });
  setValue(value);
  return { el: btn, setValue, getValue: () => current };
}

// Number format dropdown
const NUMBER_FORMATS = [
  { value: "auto", label: "Automatic", ex: "" },
  { value: "text", label: "Plain text", ex: "" },
  { sep: true },
  { value: "number", label: "Number", ex: "1,000.12" },
  { value: "integer", label: "Number (int)", ex: "1,000" },
  { value: "percent", label: "Percent", ex: "10.12%" },
  { value: "scientific", label: "Scientific", ex: "1.01E+03" },
  { sep: true },
  { value: "currency", label: "Currency", ex: "$1,000.12" },
  { sep: true },
  { value: "date", label: "Date", ex: "9/26/2008" },
  { value: "time", label: "Time", ex: "3:59:00 PM" },
  { value: "datetime", label: "Date time", ex: "9/26/2008 15:59:00" },
];
const fmtSel = customSelect({
  className: "fmt-sel", title: "Number format", options: NUMBER_FORMATS, value: "auto",
  onChange: (v) => setFmtOnSelection((f) => { if (v === "auto") delete f.nf; else f.nf = v; }),
});

const undoBtn = iconBtn("undo", "Undo (Ctrl+Z)", () => undo());
const redoBtn = iconBtn("redo", "Redo (Ctrl+Y)", () => redo());
const sumBtn = iconBtn("sigma", "Sum (auto)", () => autoSum());
const fxBtn = iconBtn(null, "Insert function", (e) => openFunctionMenu(e), "ƒx");

const currencyBtn = iconBtn("currency", "Format as currency", () => setFmtOnSelection((f) => { f.nf = "currency"; }));
const percentBtn = iconBtn("percent", "Format as percent", () => setFmtOnSelection((f) => { f.nf = "percent"; }));
const decDecBtn = iconBtn(null, "Decrease decimals", () => changeDecimals(-1), "-.0");
const incDecBtn = iconBtn(null, "Increase decimals", () => changeDecimals(1), ".00");

const boldBtn = iconBtn("bold", "Bold (Ctrl+B)", () => toggleFmt("b"));
const italicBtn = iconBtn("italic", "Italic (Ctrl+I)", () => toggleFmt("i"));
const underlineBtn = iconBtn("underline", "Underline (Ctrl+U)", () => toggleFmt("u"));
const strikeBtn = iconBtn("strike", "Strikethrough", () => toggleFmt("s"));

function colorBtn(name, title, key, defaultColor) {
  const bar = el("span", { class: "bar" });
  bar.style.background = defaultColor;
  const input = el("input", { type: "color", value: defaultColor });
  const btn = el("div", { class: "color-btn", title }, [el("span", { html: icon(ICONS[name]) }), bar, input]);
  btn.addEventListener("mousedown", (e) => e.preventDefault());
  input.addEventListener("input", () => { bar.style.background = input.value; setFmtOnSelection((f) => { f[key] = input.value; }); });
  return btn;
}
const textColorBtn = colorBtn("textcolor", "Text color", "c", "#1d1d20");
const fillColorBtn = colorBtn("fill", "Fill color", "bg", "#fff3a3");

const alignBtns = {};
function segBtn(name, title, val) {
  const b = el("button", { class: "seg-btn", title, html: icon(ICONS[name]) });
  b.addEventListener("mousedown", (e) => e.preventDefault());
  b.addEventListener("click", () => setFmtOnSelection((f) => { if (val === "l") delete f.a; else f.a = val; }));
  return b;
}
alignBtns.l = segBtn("alignLeft", "Align left", "l");
alignBtns.c = segBtn("alignCenter", "Align center", "c");
alignBtns.r = segBtn("alignRight", "Align right", "r");
const alignSegment = el("div", { class: "segment" }, [alignBtns.l, alignBtns.c, alignBtns.r]);

const wrapBtn = iconBtn("wrap", "Wrap text", () => toggleFmt("wrap"));

const insRowBtn = iconBtn("insRow", "Insert row above", () => insertRows(selRange().r1, 1));
const insColBtn = iconBtn("insCol", "Insert column left", () => insertCols(selRange().c1, 1));
const delRowBtn = iconBtn("trash", "Delete row(s)", () => deleteRows());
const sortAscBtn = iconBtn("sortAsc", "Sort range A→Z", () => sortSelection(true));
const sortDescBtn = iconBtn("sortDesc", "Sort range Z→A", () => sortSelection(false));
const clearBtn = iconBtn("clear", "Clear formatting", () => clearFormatting());

const toolbar = el("div", { class: "toolbar" }, [
  group(null, [undoBtn, redoBtn], true),
  group(null, [sumBtn, fxBtn]),
  group("p2", [fmtSel.el]),
  group("p2", [currencyBtn, percentBtn, decDecBtn, incDecBtn]),
  group(null, [boldBtn, italicBtn, underlineBtn, strikeBtn]),
  group("p1", [textColorBtn, fillColorBtn]),
  group("p1", [alignSegment, wrapBtn]),
  group("p2", [insRowBtn, insColBtn, delRowBtn]),
  group("p3", [sortAscBtn, sortDescBtn]),
  group("p3", [clearBtn]),
]);

// --- Formula bar ---
const nameBox = el("input", { class: "namebox", value: "A1", spellcheck: "false" });
const formulaInput = el("input", { class: "finput", spellcheck: "false", placeholder: "" });
const fbar = el("div", { class: "fbar" }, [
  nameBox, el("div", { class: "fx" }, "ƒx"), formulaInput,
]);

// --- Grid container ---
const gridTable = el("table", { class: "grid" });
const remoteLayer = el("div", { class: "remote-layer" });
const cellEditor = el("textarea", { class: "cell-editor", spellcheck: "false", wrap: "off" });
const gridScroll = el("div", { class: "grid-scroll", tabindex: "0" }, [gridTable, remoteLayer, cellEditor]);

// --- Tab bar ---
const tabbar = el("div", { class: "tabbar" });

const app = el("div", { class: "app" }, [topbar, toolbar, fbar, gridScroll, tabbar]);
const printWorkbook = el("div", { id: "printWorkbook", "data-print-root": "workbook" });
document.body.appendChild(app);
document.body.appendChild(printWorkbook);

// ===========================================================================
// Save / operations queue (mirrors Docs optimistic model)
// ===========================================================================
let curStatusKind = null, curStatusText = null;
function setStatus(kind, text) {
  if (kind === curStatusKind && text === curStatusText) return;
  curStatusKind = kind; curStatusText = text;
  statusDot.className = "dot " + kind;
  statusText.textContent = text;
}

let applyingRemote = false;
let saveInFlight = false;
let saveTimer = null;
// Pending local ops keyed to flush together.
let pendingCellOps = new Map(); // "sheetId!REF" -> { sheetId, ref, value, fmt }
let pendingStructure = null;    // latest structure snapshot to send
let pendingReplacements = new Map(); // sheetId -> cells (full)

function queueCellOp(sheetId, ref, value, fmt) {
  pendingCellOps.set(sheetId + "!" + ref, { sheetId, ref, value, fmt });
  scheduleSave();
}
function queueStructure() {
  pendingStructure = {
    title: model.title,
    sheetOrder: model.sheetOrder.slice(),
    sheets: JSON.parse(JSON.stringify(model.sheets)),
  };
  scheduleSave();
}
function queueReplacement(sheetId) {
  pendingReplacements.set(sheetId, JSON.parse(JSON.stringify(model.cells[sheetId] || {})));
  scheduleSave();
}

function scheduleSave(delay = 180) {
  if (applyingRemote) return;
  setStatus("saving", "Saving…");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(doSave, delay);
}

async function doSave() {
  clearTimeout(saveTimer);
  if (saveInFlight) return;
  if (!pendingCellOps.size && !pendingStructure && !pendingReplacements.size) { setStatus("saved", "Saved"); return; }

  const cellOps = [];
  for (const op of pendingCellOps.values()) {
    const cur = (model.cells[op.sheetId] || {})[op.ref];
    cellOps.push({ sheetId: op.sheetId, ref: op.ref, value: op.value, fmt: op.fmt, baseVersion: op.baseVersion || (cur ? cur.version : 0) });
  }
  const structure = pendingStructure;
  const sheetReplacements = Array.from(pendingReplacements.entries()).map(([sheetId, cells]) => ({ sheetId, cells }));
  pendingCellOps = new Map();
  pendingStructure = null;
  pendingReplacements = new Map();

  saveInFlight = true;
  try {
    const result = await gadget.applyOperation({ senderId: clientId, structure, cellOps, sheetReplacements });
    model.revision = Math.max(model.revision, result.revision || 0);
    // Adopt acknowledged versions.
    for (const up of result.upserts || []) {
      const cells = model.cells[up.sheetId] || (model.cells[up.sheetId] = {});
      cells[up.ref] = { ...up.cell };
    }
    for (const del of result.deletes || []) { const cells = model.cells[del.sheetId]; if (cells) delete cells[del.ref]; }
    if (result.status === "conflict" && result.conflicts) {
      // Rebase: adopt server versions, then re-queue our local intents.
      for (const cf of result.conflicts) {
        const cells = model.cells[cf.sheetId] || (model.cells[cf.sheetId] = {});
        cells[cf.ref] = { ...cf.cell };
      }
      setStatus("synced", "Resolving edit…");
      scheduleSave(40);
    } else {
      setStatus("saved", "Saved");
    }
    rebuildEngine();
  } catch (e) {
    console.error(e);
    setStatus("bad", "Save failed");
  } finally {
    saveInFlight = false;
    if (pendingCellOps.size || pendingStructure || pendingReplacements.size) scheduleSave(40);
  }
}

// ===========================================================================
// Undo / redo (local history of inverse cell/structure snapshots)
// ===========================================================================
const undoStack = [];
const redoStack = [];
let historyBatch = null;

function beginBatch() { historyBatch = { cells: new Map(), sheetId: activeSheetId }; }
function recordCell(sheetId, ref) {
  if (!historyBatch) beginBatch();
  const key = sheetId + "!" + ref;
  if (!historyBatch.cells.has(key)) {
    const cur = (model.cells[sheetId] || {})[ref];
    historyBatch.cells.set(key, { sheetId, ref, prev: cur ? { ...cur } : null });
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
function applyHistory(entry, into) {
  const inverse = { cells: new Map(), sheetId: entry.sheetId };
  for (const [key, rec] of entry.cells) {
    const cells = model.cells[rec.sheetId] || (model.cells[rec.sheetId] = {});
    const now = cells[rec.ref] ? { ...cells[rec.ref] } : null;
    inverse.cells.set(key, { sheetId: rec.sheetId, ref: rec.ref, prev: now });
    if (rec.prev) { cells[rec.ref] = { ...rec.prev }; }
    else delete cells[rec.ref];
    queueCellOp(rec.sheetId, rec.ref, rec.prev ? rec.prev.value : null, rec.prev ? rec.prev.fmt : null);
    // ensure base version matches server: send with adopted version handling
    const pk = rec.sheetId + "!" + rec.ref;
    const p = pendingCellOps.get(pk); if (p) p.baseVersion = now ? now.version : 0;
  }
  into.push(inverse);
  rebuildEngine();
  renderGrid();
  updateUndoButtons();
}
function undo() { if (!undoStack.length) return; applyHistory(undoStack.pop(), redoStack); }
function redo() { if (!redoStack.length) return; applyHistory(redoStack.pop(), undoStack); }
function updateUndoButtons() { undoBtn.disabled = !undoStack.length; redoBtn.disabled = !redoStack.length; }

// ===========================================================================
// Cell mutation primitives
// ===========================================================================
function setCellValue(ref, value, { batch = true } = {}) {
  const sheetId = activeSheetId;
  if (batch) recordCell(sheetId, ref);
  const cells = curCells();
  const cur = cells[ref];
  if ((value == null || value === "") && (!cur || !cur.fmt)) {
    if (cur) { delete cells[ref]; queueCellOp(sheetId, ref, null, null); }
    return;
  }
  const fmt = cur ? cur.fmt : null;
  cells[ref] = { value: value == null ? "" : String(value), fmt: fmt || null, version: cur ? cur.version : 0 };
  queueCellOp(sheetId, ref, cells[ref].value, cells[ref].fmt);
}
function setCellFmt(ref, mutator) {
  const sheetId = activeSheetId;
  recordCell(sheetId, ref);
  const cells = curCells();
  const cur = cells[ref];
  const fmt = cur && cur.fmt ? { ...cur.fmt } : {};
  mutator(fmt);
  const clean = Object.keys(fmt).length ? fmt : null;
  const value = cur ? cur.value : "";
  if ((value == null || value === "") && !clean) { if (cur) { delete cells[ref]; queueCellOp(sheetId, ref, null, null); } return; }
  cells[ref] = { value: value || "", fmt: clean, version: cur ? cur.version : 0 };
  queueCellOp(sheetId, ref, cells[ref].value, clean);
}

// ===========================================================================
// Formatting actions over the selection
// ===========================================================================
function forEachSelected(fn) {
  const r = selRange();
  beginBatch();
  for (let row = r.r1; row <= r.r2; row++) for (let col = r.c1; col <= r.c2; col++) fn(rcToRef(row, col), row, col);
  commitBatch();
  rebuildEngine();
  renderGrid();
}
function selectionFmtAllHave(key) {
  const r = selRange();
  for (let row = r.r1; row <= r.r2; row++) for (let col = r.c1; col <= r.c2; col++) {
    const c = getCell(rcToRef(row, col));
    if (!c || !c.fmt || !c.fmt[key]) return false;
  }
  return true;
}
function toggleFmt(key) {
  const on = !selectionFmtAllHave(key);
  forEachSelected((ref) => setCellFmt(ref, (f) => { if (on) f[key] = true; else delete f[key]; }));
  refreshToolbarState();
}
function setFmtOnSelection(mutator) {
  forEachSelected((ref) => setCellFmt(ref, mutator));
  refreshToolbarState();
}
function changeDecimals(delta) {
  forEachSelected((ref) => setCellFmt(ref, (f) => {
    let d = f.d != null ? f.d : (f.nf === "currency" || f.nf === "percent" || f.nf === "number" ? 2 : defaultDecimalsFor(ref));
    d = Math.max(0, Math.min(10, d + delta));
    f.d = d;
    if (!f.nf) f.nf = "number";
  }));
}
function defaultDecimalsFor(ref) {
  const v = engine.computeRef(activeSheetId, ref);
  if (typeof v === "number" && !Number.isInteger(v)) return 2;
  return 0;
}
function clearFormatting() {
  forEachSelected((ref) => setCellFmt(ref, (f) => { for (const k of Object.keys(f)) delete f[k]; }));
  refreshToolbarState();
}

function autoSum() {
  const r = selRange();
  // If single cell, sum the contiguous numbers above (or to the left).
  let target, rangeStr;
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
  }
}
function isNumericCell(ref) { const v = engine.computeRef(activeSheetId, ref); return typeof v === "number"; }

// ===========================================================================
// Insert / delete rows & columns (adjusts formula references)
// ===========================================================================
function shiftRefsInFormula(formula, fn) {
  try {
    const ast = parseFormula(formula.slice(1));
    walkRefs(ast, fn);
    return "=" + serializeAst(ast);
  } catch (e) { return formula; }
}
function walkRefs(node, fn) {
  if (!node || typeof node !== "object") return;
  if (node.k === "ref") { const nr = fn(node.ref); if (nr != null) node.ref = nr; }
  else if (node.k === "range") { const a = fn(node.a); const b = fn(node.b); if (a != null) node.a = a; if (b != null) node.b = b; }
  else { for (const key of ["a", "b"]) if (node[key]) walkRefs(node[key], fn); if (node.args) node.args.forEach((n) => walkRefs(n, fn)); }
}
function adjustRef(ref, rowAt, rowDelta, colAt, colDelta) {
  const bang = ref.indexOf("!");
  const sheetPrefix = bang >= 0 ? ref.slice(0, bang + 1) : "";
  const body = bang >= 0 ? ref.slice(bang + 1) : ref;
  if (bang >= 0) return null; // only adjust current-sheet refs for simplicity
  const rc = parseRef(body);
  if (!rc) return null;
  let { r, c } = rc;
  if (rowDelta) { if (r >= rowAt) r += rowDelta; }
  if (colDelta) { if (c >= colAt) c += colDelta; }
  if (r < 0 || c < 0) return "#REF!";
  return sheetPrefix + rcToRef(r, c);
}

function rewriteAllFormulas(rowAt, rowDelta, colAt, colDelta) {
  const cells = curCells();
  for (const [ref, cell] of Object.entries(cells)) {
    if (cell.value && cell.value[0] === "=") {
      const nf = shiftRefsInFormula(cell.value, (r) => adjustRef(r, rowAt, rowDelta, colAt, colDelta));
      if (nf !== cell.value) cell.value = nf;
    }
  }
}

function rebuildSheetCells(mapFn) {
  // mapFn(r,c) -> {r,c}|null ; moves cells to new positions.
  const old = curCells();
  const next = {};
  for (const [ref, cell] of Object.entries(old)) {
    const rc = parseRef(ref); if (!rc) continue;
    const nn = mapFn(rc.r, rc.c);
    if (!nn) continue;
    next[rcToRef(nn.r, nn.c)] = { ...cell, version: cell.version };
  }
  model.cells[activeSheetId] = next;
}

function insertRows(at, count) {
  const sh = curSheet();
  rewriteAllFormulas(at, count, 0, 0);
  rebuildSheetCells((r, c) => ({ r: r >= at ? r + count : r, c }));
  sh.rows += count;
  shiftDims(sh.rowHeights, at, count);
  commitStructuralChange();
  moveActive(at, selRange().c1);
}
function insertCols(at, count) {
  const sh = curSheet();
  rewriteAllFormulas(0, 0, at, count);
  rebuildSheetCells((r, c) => ({ r, c: c >= at ? c + count : c }));
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
  rewriteAllFormulas(at + count, -count, 0, 0);
  rebuildSheetCells((row, c) => (row >= at && row < at + count) ? null : ({ r: row > at ? row - count : row, c }));
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
  rewriteAllFormulas(0, 0, at + count, -count);
  rebuildSheetCells((row, c) => (c >= at && c < at + count) ? null : ({ r: row, c: c > at ? c - count : c }));
  sh.cols -= count;
  removeDims(sh.colWidths, at, count);
  commitStructuralChange();
  moveActive(r.r1, Math.min(at, sh.cols - 1));
}
function shiftDims(dims, at, count) {
  const entries = Object.entries(dims).map(([k, v]) => [Number(k), v]);
  for (const k of Object.keys(dims)) delete dims[k];
  for (const [k, v] of entries) dims[k >= at ? k + count : k] = v;
}
function removeDims(dims, at, count) {
  const entries = Object.entries(dims).map(([k, v]) => [Number(k), v]);
  for (const k of Object.keys(dims)) delete dims[k];
  for (const [k, v] of entries) { if (k >= at && k < at + count) continue; dims[k > at ? k - count : k] = v; }
}
function commitStructuralChange() {
  // Structural row/col changes move many cells: resend whole sheet + structure.
  queueStructure();
  queueReplacement(activeSheetId);
  rebuildEngine();
  renderGrid();
  undoStack.length = 0; redoStack.length = 0; updateUndoButtons(); // structural ops aren't locally undoable
}

// ===========================================================================
// Sort
// ===========================================================================
function sortSelection(asc) {
  const r = selRange();
  if (r.r1 === r.r2) return;
  const cells = curCells();
  const rows = [];
  for (let row = r.r1; row <= r.r2; row++) {
    const rowCells = {};
    for (let col = r.c1; col <= r.c2; col++) { const c = cells[rcToRef(row, col)]; if (c) rowCells[col] = { ...c }; }
    const keyVal = engine.computeRef(activeSheetId, rcToRef(row, r.c1));
    rows.push({ rowCells, keyVal });
  }
  rows.sort((x, y) => {
    let a = x.keyVal, b = y.keyVal;
    a = a == null ? "" : a; b = b == null ? "" : b;
    let cmp;
    if (typeof a === "number" && typeof b === "number") cmp = a - b;
    else cmp = String(a).toLowerCase() < String(b).toLowerCase() ? -1 : String(a).toLowerCase() > String(b).toLowerCase() ? 1 : 0;
    return asc ? cmp : -cmp;
  });
  // Write back.
  for (let i = 0; i < rows.length; i++) {
    const row = r.r1 + i;
    for (let col = r.c1; col <= r.c2; col++) {
      const src = rows[i].rowCells[col];
      const ref = rcToRef(row, col);
      if (src) cells[ref] = { value: src.value, fmt: src.fmt, version: (cells[ref]?.version || 0) };
      else delete cells[ref];
    }
  }
  queueReplacement(activeSheetId);
  rebuildEngine();
  renderGrid();
  undoStack.length = 0; redoStack.length = 0; updateUndoButtons();
}

// ===========================================================================
// Grid rendering
// ===========================================================================
let renderScheduled = false;
function renderGrid() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => { renderScheduled = false; doRenderGrid(); });
}

function doRenderGrid() {
  const sh = curSheet();
  if (!sh) return;
  const rng = selRange();
  const frag = document.createDocumentFragment();

  // colgroup for widths
  const colgroup = el("colgroup");
  colgroup.appendChild(el("col", { style: `width:${HEAD_W}px` }));
  let totalWidth = HEAD_W;
  for (let c = 0; c < sh.cols; c++) { const w = colWidth(c); totalWidth += w; colgroup.appendChild(el("col", { style: `width:${w}px` })); }
  frag.appendChild(colgroup);
  // Pin the table to its full natural width so columns keep a fixed size and
  // the container scrolls horizontally, instead of the columns being squeezed
  // smaller as the window narrows.
  gridTable.style.width = totalWidth + "px";

  // Header row
  const thead = el("thead");
  const hr = el("tr");
  hr.appendChild(el("th", { class: "corner" }));
  for (let c = 0; c < sh.cols; c++) {
    const th = el("th", { class: "colhead", "data-col": c }, colToLetter(c));
    if (c >= rng.c1 && c <= rng.c2) th.classList.add(rng.r1 === 0 && rng.r2 === sh.rows - 1 ? "full" : "hl");
    const rz = el("div", { class: "col-resize", "data-col": c });
    th.appendChild(rz);
    hr.appendChild(th);
  }
  thead.appendChild(hr);
  frag.appendChild(thead);

  // Body
  const tbody = el("tbody");
  for (let r = 0; r < sh.rows; r++) {
    const tr = el("tr", { style: `height:${rowHeight(r)}px` });
    const rh = el("th", { class: "rowhead", "data-row": r }, String(r + 1));
    if (r >= rng.r1 && r <= rng.r2) rh.classList.add(rng.c1 === 0 && rng.c2 === sh.cols - 1 ? "full" : "hl");
    const rrz = el("div", { class: "row-resize", "data-row": r });
    rh.appendChild(rrz);
    tr.appendChild(rh);
    for (let c = 0; c < sh.cols; c++) {
      const ref = rcToRef(r, c);
      const td = renderCell(ref, r, c, rng);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  frag.appendChild(tbody);

  gridTable.replaceChildren(frag);
  // sticky offsets for rowhead left
  positionActiveOverlays();
  renderPresence();
}

function renderCell(ref, r, c, rng) {
  const cell = getCell(ref);
  const td = el("td", { class: "cell", "data-ref": ref, "data-r": r, "data-c": c });
  const fmt = cell?.fmt;
  const computed = (cell && cell.value !== "" && cell.value != null) ? engine.computeRef(activeSheetId, ref) : (cell ? "" : null);
  const disp = displayValue(computed, fmt);
  const cv = el("span", { class: "cv" });
  cv.textContent = disp.text;
  td.appendChild(cv);
  if (disp.numeric) td.classList.add("num");
  if (disp.err) td.classList.add("err");
  // formatting styles
  if (fmt) {
    let s = "";
    if (fmt.b) td.style.fontWeight = "700";
    if (fmt.i) td.style.fontStyle = "italic";
    if (fmt.u || fmt.s) td.style.textDecoration = (fmt.u ? "underline " : "") + (fmt.s ? "line-through" : "");
    if (fmt.c) td.style.color = fmt.c;
    if (fmt.bg) td.style.background = fmt.bg;
    if (fmt.fs) td.style.fontSize = fmt.fs + "px";
    if (fmt.a) cv.style.textAlign = fmt.a === "l" ? "left" : fmt.a === "c" ? "center" : "right";
    if (fmt.wrap) td.classList.add("wrap");
    if (disp.center && !fmt.a) cv.style.textAlign = "center";
  } else if (disp.center) cv.style.textAlign = "center";
  // selection classes
  if (r >= rng.r1 && r <= rng.r2 && c >= rng.c1 && c <= rng.c2) {
    if (r === focus.r && c === focus.c) td.classList.add("active");
    else td.classList.add("sel");
  }
  return td;
}

function printBounds(sheetId) {
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

function renderPrintCell(sheetId, ref, r, c) {
  const cell = model.cells[sheetId]?.[ref] || null;
  const fmt = cell?.fmt;
  const computed = cell && cell.value !== "" && cell.value != null
    ? engine.computeRef(sheetId, ref)
    : (cell ? "" : null);
  const disp = displayValue(computed, fmt);
  const cv = el("span", { class: "cv" }, disp.text);
  const td = el("td", { class: "cell", "data-ref": ref, "data-r": r, "data-c": c }, cv);
  if (disp.numeric) td.classList.add("num");
  if (disp.err) td.classList.add("err");
  if (fmt) {
    if (fmt.b) td.style.fontWeight = "700";
    if (fmt.i) td.style.fontStyle = "italic";
    if (fmt.u || fmt.s) td.style.textDecoration = (fmt.u ? "underline " : "") + (fmt.s ? "line-through" : "");
    if (fmt.c) td.style.color = fmt.c;
    if (fmt.bg) td.style.background = fmt.bg;
    if (fmt.fs) td.style.fontSize = fmt.fs + "px";
    if (fmt.a) cv.style.textAlign = fmt.a === "l" ? "left" : fmt.a === "c" ? "center" : "right";
    if (fmt.wrap) td.classList.add("wrap");
    if (disp.center && !fmt.a) cv.style.textAlign = "center";
  } else if (disp.center) {
    cv.style.textAlign = "center";
  }
  return td;
}

function renderPrintSheet(sheetId) {
  const sheet = model.sheets[sheetId];
  const bounds = printBounds(sheetId);
  const section = el("section", { class: "print-sheet" });
  section.appendChild(el("h1", { class: "print-sheet-title" }, sheet.name));
  if (bounds.rows * bounds.cols > MAX_PRINT_CELLS) {
    section.appendChild(el("p", { class: "print-sheet-error" },
      `This sheet's used range is too large to export (${bounds.rows.toLocaleString()} rows × ${bounds.cols.toLocaleString()} columns).`));
    return section;
  }

  const table = el("table", { class: "grid print-grid" });
  const colgroup = el("colgroup");
  colgroup.appendChild(el("col", { style: "width:4%" }));
  const widths = Array.from({ length: bounds.cols }, (_, c) =>
    Math.max(40, Math.min(240, sheet.colWidths[c] || DEFAULT_COL_W)));
  const totalWidth = widths.reduce((sum, width) => sum + width, 0);
  for (const width of widths) {
    colgroup.appendChild(el("col", { style: `width:${width / totalWidth * 96}%` }));
  }
  table.appendChild(colgroup);
  const thead = el("thead");
  const header = el("tr");
  header.appendChild(el("th", { class: "corner" }));
  for (let c = 0; c < bounds.cols; c++) {
    header.appendChild(el("th", { class: "colhead" }, colToLetter(c)));
  }
  thead.appendChild(header);
  table.appendChild(thead);

  const tbody = el("tbody");
  for (let r = 0; r < bounds.rows; r++) {
    const height = Math.max(20, Math.min(120, sheet.rowHeights[r] || DEFAULT_ROW_H));
    const row = el("tr", { style: `height:${height}px` });
    row.appendChild(el("th", { class: "rowhead" }, String(r + 1)));
    for (let c = 0; c < bounds.cols; c++) {
      row.appendChild(renderPrintCell(sheetId, rcToRef(r, c), r, c));
    }
    tbody.appendChild(row);
  }
  table.appendChild(tbody);
  section.appendChild(table);
  return section;
}

function renderPrintWorkbook() {
  printWorkbook.replaceChildren(...model.sheetOrder
    .filter((sheetId) => model.sheets[sheetId])
    .map(renderPrintSheet));
}

window.addEventListener("beforeprint", renderPrintWorkbook);
window.matchMedia("print").addEventListener("change", (event) => {
  if (event.matches) renderPrintWorkbook();
});

// Position rowheads sticky-left offset already handled by CSS `left:0`.
function positionActiveOverlays() { /* active box handled via .active class */ }

// ===========================================================================
// Selection & navigation
// ===========================================================================
function clampRC(r, c) {
  const sh = curSheet();
  return { r: Math.max(0, Math.min(sh.rows - 1, r)), c: Math.max(0, Math.min(sh.cols - 1, c)) };
}
function moveActive(r, c, extend = false) {
  const p = clampRC(r, c);
  focus = { r: p.r, c: p.c };
  if (!extend) anchor = { r: p.r, c: p.c };
  updateSelectionUI();
  scrollActiveIntoView();
  sendPresence();
}
function setSelection(a, f) { anchor = { ...a }; focus = { ...f }; updateSelectionUI(); sendPresence(); }

function updateSelectionUI() {
  const rng = selRange();
  // Update cell classes without full re-render for speed.
  const prevSel = gridTable.querySelectorAll("td.cell.sel, td.cell.active");
  prevSel.forEach((td) => td.classList.remove("sel", "active"));
  const prevHl = gridTable.querySelectorAll("th.hl, th.full");
  prevHl.forEach((th) => th.classList.remove("hl", "full"));
  const sh = curSheet();
  for (let r = rng.r1; r <= rng.r2; r++) for (let c = rng.c1; c <= rng.c2; c++) {
    const td = cellEl(r, c);
    if (!td) continue;
    if (r === focus.r && c === focus.c) td.classList.add("active");
    else td.classList.add("sel");
  }
  // headers
  gridTable.querySelectorAll("th.colhead").forEach((th) => {
    const c = +th.dataset.col;
    if (c >= rng.c1 && c <= rng.c2) th.classList.add(rng.r1 === 0 && rng.r2 === sh.rows - 1 ? "full" : "hl");
  });
  gridTable.querySelectorAll("th.rowhead").forEach((th) => {
    const r = +th.dataset.row;
    if (r >= rng.r1 && r <= rng.r2) th.classList.add(rng.c1 === 0 && rng.c2 === sh.cols - 1 ? "full" : "hl");
  });
  // name box + formula bar
  nameBox.value = rng.r1 === rng.r2 && rng.c1 === rng.c2 ? rcToRef(focus.r, focus.c)
    : rcToRef(rng.r1, rng.c1) + ":" + rcToRef(rng.r2, rng.c2);
  const active = getCell(rcToRef(focus.r, focus.c));
  formulaInput.value = active ? active.value : "";
  refreshToolbarState();
}
function cellEl(r, c) { return gridTable.querySelector(`td.cell[data-r="${r}"][data-c="${c}"]`); }

function scrollActiveIntoView() {
  const td = cellEl(focus.r, focus.c);
  if (!td) return;
  const sr = gridScroll.getBoundingClientRect();
  const cr = td.getBoundingClientRect();
  const headTop = 22, headLeft = HEAD_W;
  if (cr.top < sr.top + headTop) gridScroll.scrollTop -= (sr.top + headTop - cr.top);
  else if (cr.bottom > sr.bottom) gridScroll.scrollTop += (cr.bottom - sr.bottom);
  if (cr.left < sr.left + headLeft) gridScroll.scrollLeft -= (sr.left + headLeft - cr.left);
  else if (cr.right > sr.right) gridScroll.scrollLeft += (cr.right - sr.right);
}

// ===========================================================================
// Toolbar live state
// ===========================================================================
function refreshToolbarState() {
  const active = getCell(rcToRef(focus.r, focus.c));
  const f = active?.fmt || {};
  boldBtn.classList.toggle("active", !!f.b);
  italicBtn.classList.toggle("active", !!f.i);
  underlineBtn.classList.toggle("active", !!f.u);
  strikeBtn.classList.toggle("active", !!f.s);
  wrapBtn.classList.toggle("active", !!f.wrap);
  alignBtns.l.classList.toggle("active", !f.a || f.a === "l");
  alignBtns.c.classList.toggle("active", f.a === "c");
  alignBtns.r.classList.toggle("active", f.a === "r");
  fmtSel.setValue(f.nf || "auto");
}

// ===========================================================================
// Cell editing
// ===========================================================================
let editing = null; // { ref, r, c, initial }
function startEdit(ref, replace = false, seed = null) {
  const rc = parseRef(ref);
  const td = cellEl(rc.r, rc.c);
  if (!td) return;
  editing = { ref, r: rc.r, c: rc.c };
  const cell = getCell(ref);
  let text = seed != null ? seed : (replace ? "" : (cell ? cell.value : ""));
  const rect = td.getBoundingClientRect();
  const scRect = gridScroll.getBoundingClientRect();
  cellEditor.style.left = (td.offsetLeft) + "px";
  cellEditor.style.top = (td.offsetTop) + "px";
  cellEditor.style.minWidth = td.offsetWidth + "px";
  cellEditor.style.minHeight = td.offsetHeight + "px";
  cellEditor.style.width = td.offsetWidth + "px";
  cellEditor.value = text;
  cellEditor.style.display = "block";
  // font matches
  const f = cell?.fmt || {};
  cellEditor.style.fontWeight = f.b ? "700" : "400";
  cellEditor.style.fontStyle = f.i ? "italic" : "normal";
  cellEditor.style.textAlign = f.a === "c" ? "center" : f.a === "r" ? "right" : "left";
  cellEditor.focus();
  if (replace || seed != null) { const L = cellEditor.value.length; cellEditor.setSelectionRange(L, L); }
  else cellEditor.select();
  syncEditorSize();
  formulaInput.value = text;
}
function syncEditorSize() {
  cellEditor.style.height = "auto";
  cellEditor.style.height = Math.max(cellEditor.scrollHeight, DEFAULT_ROW_H) + "px";
  const w = Math.max(cellEditor.scrollWidth + 8, cellEl(editing.r, editing.c)?.offsetWidth || 60);
  cellEditor.style.width = w + "px";
}
function commitEdit(advance = "down") {
  if (!editing) return;
  const { ref, r, c } = editing;
  const value = cellEditor.value;
  editing = null;
  cellEditor.style.display = "none";
  beginBatch();
  setCellValue(ref, value === "" ? null : value);
  commitBatch();
  rebuildEngine();
  renderGrid();
  if (advance === "down") moveActive(r + 1, c);
  else if (advance === "up") moveActive(r - 1, c);
  else if (advance === "right") moveActive(r, c + 1);
  else if (advance === "left") moveActive(r, c - 1);
  else moveActive(r, c);
  gridScroll.focus();
}
function cancelEdit() {
  if (!editing) return;
  const { r, c } = editing;
  editing = null;
  cellEditor.style.display = "none";
  formulaInput.value = getCell(rcToRef(r, c))?.value || "";
  gridScroll.focus();
}
cellEditor.addEventListener("input", () => { syncEditorSize(); formulaInput.value = cellEditor.value; });
cellEditor.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.altKey) { e.preventDefault(); commitEdit(e.shiftKey ? "up" : "down"); }
  else if (e.key === "Enter" && e.altKey) { e.preventDefault(); const s = cellEditor.selectionStart; cellEditor.value = cellEditor.value.slice(0, s) + "\n" + cellEditor.value.slice(cellEditor.selectionEnd); cellEditor.setSelectionRange(s + 1, s + 1); syncEditorSize(); }
  else if (e.key === "Tab") { e.preventDefault(); commitEdit(e.shiftKey ? "left" : "right"); }
  else if (e.key === "Escape") { e.preventDefault(); cancelEdit(); }
  e.stopPropagation();
});

// ===========================================================================
// Mouse interaction on grid
// ===========================================================================
let mouseSelecting = false;
let resizeState = null;

gridTable.addEventListener("mousedown", (e) => {
  // Column/row resize handles
  const colResize = e.target.closest(".col-resize");
  if (colResize) { startColResize(+colResize.dataset.col, e); e.preventDefault(); return; }
  const rowResize = e.target.closest(".row-resize");
  if (rowResize) { startRowResize(+rowResize.dataset.row, e); e.preventDefault(); return; }

  const colhead = e.target.closest("th.colhead");
  if (colhead) {
    const c = +colhead.dataset.col; const sh = curSheet();
    if (editing) commitEdit("none");
    setSelection({ r: 0, c }, { r: sh.rows - 1, c });
    focus = { r: 0, c }; updateSelectionUI();
    mouseSelecting = "col"; e.preventDefault(); return;
  }
  const rowhead = e.target.closest("th.rowhead");
  if (rowhead) {
    const r = +rowhead.dataset.row; const sh = curSheet();
    if (editing) commitEdit("none");
    setSelection({ r, c: 0 }, { r, c: sh.cols - 1 });
    focus = { r, c: 0 }; updateSelectionUI();
    mouseSelecting = "row"; e.preventDefault(); return;
  }
  const td = e.target.closest("td.cell");
  if (td) {
    const r = +td.dataset.r, c = +td.dataset.c;
    if (editing) commitEdit("none");
    if (e.shiftKey) { focus = { r, c }; updateSelectionUI(); sendPresence(); }
    else moveActive(r, c);
    mouseSelecting = "cell";
    gridScroll.focus();
    e.preventDefault();
  }
});
gridTable.addEventListener("mousemove", (e) => {
  if (!mouseSelecting) return;
  const td = e.target.closest("td.cell") || e.target.closest("th");
  let r, c;
  if (td && td.classList.contains("cell")) { r = +td.dataset.r; c = +td.dataset.c; }
  else return;
  const sh = curSheet();
  if (mouseSelecting === "col") { focus = { r: sh.rows - 1, c }; anchor = { r: 0, c: anchor.c }; }
  else if (mouseSelecting === "row") { focus = { r, c: sh.cols - 1 }; anchor = { r: anchor.r, c: 0 }; }
  else { focus = { r, c }; }
  updateSelectionUI();
});
window.addEventListener("mouseup", () => { if (mouseSelecting) { mouseSelecting = false; sendPresence(); } });

gridTable.addEventListener("dblclick", (e) => {
  const td = e.target.closest("td.cell");
  if (td) startEdit(td.dataset.ref, false);
});

// Column/row auto double-click resize handled minimally.
function startColResize(col, e) {
  const startX = e.clientX; const startW = colWidth(col);
  const move = (ev) => { const w = Math.max(30, startW + ev.clientX - startX); curSheet().colWidths[col] = Math.round(w); applyColWidth(col); };
  const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); queueStructure(); };
  window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
}
function applyColWidth(col) {
  const cols = gridTable.querySelectorAll("colgroup col");
  if (cols[col + 1]) cols[col + 1].style.width = colWidth(col) + "px";
  // Keep the pinned table width in sync so resizing doesn't reintroduce squeezing.
  const sh = curSheet();
  let totalWidth = HEAD_W;
  for (let c = 0; c < sh.cols; c++) totalWidth += colWidth(c);
  gridTable.style.width = totalWidth + "px";
}
function startRowResize(row, e) {
  const startY = e.clientY; const startH = rowHeight(row);
  const move = (ev) => { const h = Math.max(18, startH + ev.clientY - startY); curSheet().rowHeights[row] = Math.round(h); applyRowHeight(row); };
  const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); queueStructure(); };
  window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
}
function applyRowHeight(row) {
  const tr = gridTable.querySelectorAll("tbody tr")[row];
  if (tr) tr.style.height = rowHeight(row) + "px";
}

// ===========================================================================
// Keyboard navigation & shortcuts
// ===========================================================================
gridScroll.addEventListener("keydown", (e) => {
  if (editing) return;
  const meta = e.ctrlKey || e.metaKey;
  const r = selRange();
  if (meta) {
    switch (e.key.toLowerCase()) {
      case "b": e.preventDefault(); toggleFmt("b"); return;
      case "i": e.preventDefault(); toggleFmt("i"); return;
      case "u": e.preventDefault(); toggleFmt("u"); return;
      case "z": e.preventDefault(); e.shiftKey ? redo() : undo(); return;
      case "y": e.preventDefault(); redo(); return;
      case "c": copySelection(); return;
      case "x": copySelection(); e._cut = true; return;
      case "v": return; // handled by paste event
      case "a": e.preventDefault(); { const sh = curSheet(); setSelection({ r: 0, c: 0 }, { r: sh.rows - 1, c: sh.cols - 1 }); focus = { r: 0, c: 0 }; updateSelectionUI(); } return;
      case "arrowdown": e.preventDefault(); moveActive(jumpEdge(focus.r, focus.c, 1, 0), focus.c, e.shiftKey); return;
      case "arrowup": e.preventDefault(); moveActive(jumpEdge(focus.r, focus.c, -1, 0), focus.c, e.shiftKey); return;
      case "arrowright": e.preventDefault(); moveActive(focus.r, jumpEdgeCol(focus.r, focus.c, 1), e.shiftKey); return;
      case "arrowleft": e.preventDefault(); moveActive(focus.r, jumpEdgeCol(focus.r, focus.c, -1), e.shiftKey); return;
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
    case "PageDown": e.preventDefault(); moveActive(focus.r + 20, focus.c, e.shiftKey); break;
    case "PageUp": e.preventDefault(); moveActive(focus.r - 20, focus.c, e.shiftKey); break;
    case "Delete": case "Backspace": e.preventDefault(); deleteSelectionContents(); break;
    case "Escape": clearCopyMarquee(); break;
    default:
      if (e.key.length === 1 && !meta && !e.altKey) { e.preventDefault(); startEdit(rcToRef(focus.r, focus.c), true, e.key); }
  }
});
function jumpEdge(r, c, dr) {
  const sh = curSheet();
  let nr = r + dr;
  const has = (rr) => { const v = cellRaw(rcToRef(rr, c)); return v !== "" && v != null; };
  if (nr < 0 || nr >= sh.rows) return r;
  if (has(r) && has(nr)) { while (nr + dr >= 0 && nr + dr < sh.rows && has(nr + dr)) nr += dr; return nr; }
  while (nr >= 0 && nr < sh.rows && !has(nr)) nr += dr;
  if (nr < 0 || nr >= sh.rows) return dr > 0 ? sh.rows - 1 : 0;
  return nr;
}
function jumpEdgeCol(r, c, dc) {
  const sh = curSheet();
  let nc = c + dc;
  const has = (cc) => { const v = cellRaw(rcToRef(r, cc)); return v !== "" && v != null; };
  if (nc < 0 || nc >= sh.cols) return c;
  if (has(c) && has(nc)) { while (nc + dc >= 0 && nc + dc < sh.cols && has(nc + dc)) nc += dc; return nc; }
  while (nc >= 0 && nc < sh.cols && !has(nc)) nc += dc;
  if (nc < 0 || nc >= sh.cols) return dc > 0 ? sh.cols - 1 : 0;
  return nc;
}
function moveWithinSelection(dir, mode) {
  const rng = selRange();
  const single = rng.r1 === rng.r2 && rng.c1 === rng.c2;
  if (single) { if (mode === "h") moveActive(focus.r, focus.c + dir); else moveActive(focus.r + dir, focus.c); return; }
  let { r, c } = focus;
  if (mode === "h") { c += dir; if (c > rng.c2) { c = rng.c1; r++; if (r > rng.r2) r = rng.r1; } if (c < rng.c1) { c = rng.c2; r--; if (r < rng.r1) r = rng.r2; } }
  else { r += dir; if (r > rng.r2) { r = rng.r1; c++; if (c > rng.c2) c = rng.c1; } if (r < rng.r1) { r = rng.r2; c--; if (c < rng.c1) c = rng.c2; } }
  focus = { r, c }; updateSelectionUI(); scrollActiveIntoView(); sendPresence();
}
function deleteSelectionContents() {
  const r = selRange();
  beginBatch();
  for (let row = r.r1; row <= r.r2; row++) for (let col = r.c1; col <= r.c2; col++) {
    const ref = rcToRef(row, col); const cell = getCell(ref);
    if (cell) { recordCell(activeSheetId, ref); if (cell.fmt) { setCellValue(ref, null); } else { delete curCells()[ref]; queueCellOp(activeSheetId, ref, null, null); } }
  }
  commitBatch(); rebuildEngine(); renderGrid();
}

// ===========================================================================
// Copy / paste (TSV via clipboard)
// ===========================================================================
let copyRange = null;
function copySelection() {
  const r = selRange();
  copyRange = { ...r };
  const lines = [];
  for (let row = r.r1; row <= r.r2; row++) {
    const cols = [];
    for (let col = r.c1; col <= r.c2; col++) {
      const cell = getCell(rcToRef(row, col));
      let out = "";
      if (cell) { const v = engine.computeRef(activeSheetId, rcToRef(row, col)); out = cell.value && cell.value[0] === "=" ? (isErr(v) ? v.value : (v == null ? "" : String(v))) : cell.value; }
      cols.push(out);
    }
    lines.push(cols.join("\t"));
  }
  const tsv = lines.join("\n");
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(tsv).catch(() => {});
  copyFallback = { tsv, cells: snapshotRange(r) };
}
let copyFallback = null;
function snapshotRange(r) {
  const out = [];
  for (let row = r.r1; row <= r.r2; row++) { const line = []; for (let col = r.c1; col <= r.c2; col++) { const c = getCell(rcToRef(row, col)); line.push(c ? { value: c.value, fmt: c.fmt } : null); } out.push(line); }
  return out;
}
function clearCopyMarquee() { copyRange = null; }

gridScroll.addEventListener("paste", (e) => {
  if (editing) return;
  e.preventDefault();
  const text = (e.clipboardData && e.clipboardData.getData("text/plain")) || "";
  pasteText(text);
});
function pasteText(text) {
  const start = selRange();
  const useSnapshot = copyFallback && copyFallback.tsv === text && copyFallback.cells;
  const rows = text.replace(/\r/g, "").split("\n");
  if (rows.length && rows[rows.length - 1] === "") rows.pop();
  beginBatch();
  for (let i = 0; i < rows.length; i++) {
    const cols = rows[i].split("\t");
    for (let j = 0; j < cols.length; j++) {
      const rr = start.r1 + i, cc = start.c1 + j;
      if (rr >= curSheet().rows || cc >= curSheet().cols) continue;
      const ref = rcToRef(rr, cc);
      if (useSnapshot && copyFallback.cells[i] && copyFallback.cells[i][j] !== undefined) {
        const src = copyFallback.cells[i][j];
        recordCell(activeSheetId, ref);
        if (src) { curCells()[ref] = { value: src.value, fmt: src.fmt, version: getCell(ref)?.version || 0 }; queueCellOp(activeSheetId, ref, src.value, src.fmt); }
        else { if (getCell(ref)) { delete curCells()[ref]; queueCellOp(activeSheetId, ref, null, null); } }
      } else {
        setCellValue(ref, cols[j] === "" ? null : cols[j]);
      }
    }
  }
  commitBatch(); rebuildEngine(); renderGrid();
}

// ===========================================================================
// Name box & formula bar interactions
// ===========================================================================
nameBox.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    const v = nameBox.value.trim().toUpperCase();
    const range = /^([A-Z]+\d+):([A-Z]+\d+)$/.exec(v);
    if (range) { const a = parseRef(range[1]), b = parseRef(range[2]); if (a && b) { setSelection({ r: a.r, c: a.c }, { r: b.r, c: b.c }); focus = { r: b.r, c: b.c }; updateSelectionUI(); scrollActiveIntoView(); } }
    else { const rc = parseRef(v); if (rc) moveActive(rc.r, rc.c); }
    gridScroll.focus();
  }
});
formulaInput.addEventListener("focus", () => { if (!editing) startEdit(rcToRef(focus.r, focus.c), false); });
formulaInput.addEventListener("input", () => { if (editing) { cellEditor.value = formulaInput.value; syncEditorSize(); } });
formulaInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); commitEdit("down"); }
  else if (e.key === "Escape") { e.preventDefault(); cancelEdit(); }
});

// ===========================================================================
// Title
// ===========================================================================
titleInput.addEventListener("input", () => { model.title = titleInput.value.trim() || "Untitled spreadsheet"; queueStructure(); });

// ===========================================================================
// Insert-function menu
// ===========================================================================
function openFunctionMenu(e) {
  const groups = {
    "Math": ["SUM", "AVERAGE", "COUNT", "MAX", "MIN", "PRODUCT", "ROUND", "ABS", "SQRT", "MOD", "POWER"],
    "Statistical": ["MEDIAN", "STDEV", "VAR", "COUNTA", "COUNTIF", "SUMIF", "SUMIFS", "COUNTIFS", "RANK", "LARGE"],
    "Logical": ["IF", "IFS", "IFERROR", "AND", "OR", "NOT", "SWITCH"],
    "Text": ["CONCAT", "TEXTJOIN", "LEFT", "RIGHT", "MID", "LEN", "UPPER", "LOWER", "TRIM", "SUBSTITUTE", "TEXT"],
    "Lookup": ["VLOOKUP", "HLOOKUP", "INDEX", "MATCH", "CHOOSE", "LOOKUP"],
    "Date": ["TODAY", "NOW", "DATE", "YEAR", "MONTH", "DAY", "WEEKDAY", "EDATE", "DATEDIF"],
  };
  const menu = el("div", { class: "ctx" });
  for (const [g, fns] of Object.entries(groups)) {
    menu.appendChild(el("div", { class: "cmenu-item", style: "color:var(--faint);font-size:11px;pointer-events:none;text-transform:uppercase;letter-spacing:.05em;" }, g));
    for (const fn of fns) {
      const it = el("div", { class: "ctx-item" }, [el("span", {}, fn), el("span", { class: "k" }, "ƒ")]);
      it.addEventListener("click", () => { closeCtx(); insertFunction(fn); });
      menu.appendChild(it);
    }
    menu.appendChild(el("div", { class: "ctx-sep" }));
  }
  showCtx(menu, e.clientX, e.clientY);
}
function insertFunction(name) {
  const ref = rcToRef(focus.r, focus.c);
  startEdit(ref, true, "=" + name + "(");
}

// ===========================================================================
// Context menu (right-click on grid)
// ===========================================================================
let ctxEl = null;
function showCtx(menu, x, y) {
  closeCtx();
  ctxEl = menu;
  document.body.appendChild(menu);
  const w = menu.offsetWidth, h = menu.offsetHeight;
  menu.style.left = Math.min(x, window.innerWidth - w - 8) + "px";
  menu.style.top = Math.min(y, window.innerHeight - h - 8) + "px";
}
function closeCtx() { if (ctxEl) { ctxEl.remove(); ctxEl = null; } }
document.addEventListener("mousedown", (e) => { if (ctxEl && !ctxEl.contains(e.target)) closeCtx(); });
window.addEventListener("scroll", closeCtx, true);

gridTable.addEventListener("contextmenu", (e) => {
  const td = e.target.closest("td.cell");
  const colhead = e.target.closest("th.colhead");
  const rowhead = e.target.closest("th.rowhead");
  if (!td && !colhead && !rowhead) return;
  e.preventDefault();
  if (td) { const r = +td.dataset.r, c = +td.dataset.c; const rng = selRange(); if (r < rng.r1 || r > rng.r2 || c < rng.c1 || c > rng.c2) moveActive(r, c); }
  const menu = el("div", { class: "ctx" });
  const item = (label, k, fn, danger) => { const it = el("div", { class: "ctx-item" + (danger ? " danger" : "") }, [el("span", {}, label), k ? el("span", { class: "k" }, k) : null]); it.addEventListener("click", () => { closeCtx(); fn(); }); menu.appendChild(it); };
  const sep = () => menu.appendChild(el("div", { class: "ctx-sep" }));
  item("Cut", "Ctrl+X", () => { copySelection(); deleteSelectionContents(); });
  item("Copy", "Ctrl+C", () => copySelection());
  item("Paste", "Ctrl+V", async () => { try { const t = await navigator.clipboard.readText(); pasteText(t); } catch (e) {} });
  sep();
  item("Insert row above", "", () => insertRows(selRange().r1, 1));
  item("Insert row below", "", () => insertRows(selRange().r2 + 1, 1));
  item("Insert column left", "", () => insertCols(selRange().c1, 1));
  item("Insert column right", "", () => insertCols(selRange().c2 + 1, 1));
  sep();
  item("Delete row(s)", "", () => deleteRows(), true);
  item("Delete column(s)", "", () => deleteCols(), true);
  item("Clear contents", "Del", () => deleteSelectionContents());
  showCtx(menu, e.clientX, e.clientY);
});

// ===========================================================================
// Sheet tabs
// ===========================================================================
function renderTabs() {
  tabbar.replaceChildren();
  for (const id of model.sheetOrder) {
    const sh = model.sheets[id];
    const tab = el("div", { class: "tab" + (id === activeSheetId ? " active" : ""), "data-id": id }, [el("span", { class: "tname" }, sh.name)]);
    tab.addEventListener("click", () => switchSheet(id));
    tab.addEventListener("dblclick", () => renameSheet(id));
    tab.addEventListener("contextmenu", (e) => { e.preventDefault(); sheetTabMenu(id, e); });
    tabbar.appendChild(tab);
  }
  const add = el("div", { class: "tab-add", title: "Add sheet", html: icon(ICONS.plus) });
  add.addEventListener("click", addSheet);
  tabbar.appendChild(add);
}
function switchSheet(id) {
  if (editing) commitEdit("none");
  activeSheetId = id;
  anchor = { r: 0, c: 0 }; focus = { r: 0, c: 0 };
  renderTabs(); renderGrid(); updateSelectionUI();
  sendPresence();
}
function addSheet() {
  const id = "s_" + Math.random().toString(36).slice(2, 8);
  let n = model.sheetOrder.length + 1;
  while (model.sheetOrder.some((sid) => model.sheets[sid].name === "Sheet" + n)) n++;
  model.sheets[id] = { id, name: "Sheet" + n, rows: 100, cols: 26, colWidths: {}, rowHeights: {}, frozenRows: 0, frozenCols: 0 };
  model.sheetOrder.push(id);
  model.cells[id] = {};
  activeSheetId = id;
  queueStructure();
  switchSheet(id);
}
async function renameSheet(id) {
  const name = await promptInline("Rename sheet:", model.sheets[id].name);
  if (name == null) return;
  const clean = name.trim().slice(0, 60);
  if (clean) { model.sheets[id].name = clean; queueStructure(); renderTabs(); rebuildEngine(); renderGrid(); }
}
function sheetTabMenu(id, e) {
  const menu = el("div", { class: "ctx" });
  const item = (label, fn, danger) => { const it = el("div", { class: "ctx-item" + (danger ? " danger" : "") }, [el("span", {}, label)]); it.addEventListener("click", () => { closeCtx(); fn(); }); menu.appendChild(it); };
  item("Rename", () => renameSheet(id));
  item("Duplicate", () => duplicateSheet(id));
  if (model.sheetOrder.length > 1) { menu.appendChild(el("div", { class: "ctx-sep" })); item("Delete", () => deleteSheet(id), true); }
  showCtx(menu, e.clientX, e.clientY);
}
function duplicateSheet(id) {
  const src = model.sheets[id];
  const nid = "s_" + Math.random().toString(36).slice(2, 8);
  model.sheets[nid] = { ...JSON.parse(JSON.stringify(src)), id: nid, name: src.name + " copy" };
  model.cells[nid] = JSON.parse(JSON.stringify(model.cells[id] || {}));
  const idx = model.sheetOrder.indexOf(id);
  model.sheetOrder.splice(idx + 1, 0, nid);
  queueStructure(); queueReplacement(nid);
  switchSheet(nid);
}
function deleteSheet(id) {
  if (model.sheetOrder.length <= 1) return;
  const idx = model.sheetOrder.indexOf(id);
  model.sheetOrder.splice(idx, 1);
  delete model.sheets[id]; delete model.cells[id];
  if (activeSheetId === id) activeSheetId = model.sheetOrder[Math.max(0, idx - 1)];
  queueStructure();
  switchSheet(activeSheetId);
}

// ===========================================================================
// Inline prompt/dialog (alert/prompt blocked in sandbox iframe)
// ===========================================================================
function promptInline(message, def = "") {
  return new Promise((resolve) => {
    const input = el("input", { value: def });
    const ok = el("button", { class: "primary" }, "OK");
    const cancel = el("button", {}, "Cancel");
    const dialog = el("div", { class: "dialog" }, [
      el("div", { class: "msg" }, message), input,
      el("div", { class: "row" }, [cancel, ok]),
    ]);
    const overlay = el("div", { class: "overlay" }, [dialog]);
    document.body.appendChild(overlay);
    input.focus(); input.select();
    const done = (v) => { overlay.remove(); resolve(v); };
    ok.addEventListener("click", () => done(input.value));
    cancel.addEventListener("click", () => done(null));
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) done(null); });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") done(input.value); if (e.key === "Escape") done(null); });
  });
}

// ===========================================================================
// Presence
// ===========================================================================
let presenceTimer = null;
function sendPresence() {
  clearTimeout(presenceTimer);
  presenceTimer = setTimeout(() => {
    const rng = selRange();
    gadget.updatePresence({ clientId, name: collaboratorName, color: collaboratorColor, sheetId: activeSheetId, r1: rng.r1, c1: rng.c1, r2: rng.r2, c2: rng.c2 }).catch(() => {});
  }, 60);
}
function renderPeers() {
  // Presence UI disabled — single-user gadget, no collaborator badges shown.
}
function renderPresence() {
  // Presence UI disabled — no remote selection boxes shown.
  remoteLayer.replaceChildren();
  return;
  for (const p of collaborators.values()) {
    if (p.sheetId !== activeSheetId) continue;
    const r1 = Math.min(p.r1, p.r2), r2 = Math.max(p.r1, p.r2), c1 = Math.min(p.c1, p.c2), c2 = Math.max(p.c1, p.c2);
    const tdA = cellEl(r1, c1), tdB = cellEl(r2, c2);
    if (!tdA || !tdB) continue;
    const left = tdA.offsetLeft, top = tdA.offsetTop;
    const width = tdB.offsetLeft + tdB.offsetWidth - left, height = tdB.offsetTop + tdB.offsetHeight - top;
    const fill = el("div", { class: "remote-fill" });
    fill.style.cssText = `left:${left}px;top:${top}px;width:${width}px;height:${height}px;background:${p.color}`;
    const box = el("div", { class: "remote-box" });
    box.style.cssText = `left:${left}px;top:${top}px;width:${width}px;height:${height}px;border-color:${p.color}`;
    const tag = el("div", { class: "remote-tag" }, p.name);
    tag.style.cssText = `left:${left}px;top:${top}px;background:${p.color}`;
    remoteLayer.appendChild(fill); remoteLayer.appendChild(box); remoteLayer.appendChild(tag);
  }
}
function applyPresence(event) {
  if (!event?.clientId || event.clientId === clientId) return;
  if (event.type === "leave") collaborators.delete(event.clientId);
  else collaborators.set(event.clientId, { ...event, seenAt: Date.now() });
  renderPresence(); renderPeers();
}
gridScroll.addEventListener("scroll", () => { renderPresence(); });
setInterval(() => {
  sendPresence();
  const cutoff = Date.now() - 12000; let changed = false;
  for (const [id, p] of collaborators) if ((p.seenAt || 0) < cutoff) { collaborators.delete(id); changed = true; }
  if (changed) { renderPresence(); renderPeers(); }
}, 4000);
window.addEventListener("pagehide", () => { gadget.leavePresence(clientId).catch(() => {}); });

// ===========================================================================
// Remote operations
// ===========================================================================
function applyRemoteOperation(event) {
  if (!event || event.senderId === clientId) return;
  applyingRemote = true;
  model.revision = Math.max(model.revision, event.revision || 0);
  if (event.structure) applyStructure(event.structure);
  for (const up of event.upserts || []) {
    const cells = model.cells[up.sheetId] || (model.cells[up.sheetId] = {});
    cells[up.ref] = { ...up.cell };
  }
  for (const del of event.deletes || []) { const cells = model.cells[del.sheetId]; if (cells) delete cells[del.ref]; }
  if (event.replacedCells) for (const [sid, cells] of Object.entries(event.replacedCells)) model.cells[sid] = cells;
  applyingRemote = false;
  rebuildEngine();
  if (!model.sheets[activeSheetId]) activeSheetId = model.sheetOrder[0];
  renderTabs(); renderGrid();
  setStatus("synced", "Live update");
  setTimeout(() => { if (!saveInFlight && !pendingCellOps.size) setStatus("saved", "Saved"); }, 900);
}
function applyStructure(s) {
  if (s.title != null && document.activeElement !== titleInput) { model.title = s.title; titleInput.value = s.title; }
  else if (s.title != null) model.title = s.title;
  model.sheetOrder = s.sheetOrder.slice();
  for (const id of model.sheetOrder) model.sheets[id] = { ...model.sheets[id], ...s.sheets[id] };
  for (const id of Object.keys(model.sheets)) if (!model.sheetOrder.includes(id)) { delete model.sheets[id]; delete model.cells[id]; }
}

function applySnapshot(doc) {
  applyingRemote = true;
  model.revision = doc.revision || 0;
  model.title = doc.title || "Untitled spreadsheet";
  model.sheetOrder = doc.sheetOrder || [];
  model.sheets = doc.sheets || {};
  model.cells = doc.cells || {};
  for (const id of model.sheetOrder) if (!model.cells[id]) model.cells[id] = {};
  titleInput.value = model.title;
  if (!activeSheetId || !model.sheets[activeSheetId]) activeSheetId = model.sheetOrder[0];
  applyingRemote = false;
  rebuildEngine();
  renderTabs(); renderGrid();
  updateSelectionUI();
}

class SheetCallbacks extends RpcTarget {
  operation(event) { if (event.type === "snapshot") applySnapshot(event.document); else applyRemoteOperation(event); }
  presence(event) { applyPresence(event); }
}

// ===========================================================================
// Init
// ===========================================================================

  try {
    const doc = await gadget.subscribe(new SheetCallbacks(), { clientId, name: collaboratorName, color: collaboratorColor });
    applySnapshot(doc);
    setStatus("saved", "Saved");
    updateUndoButtons();
    sendPresence();
    gridScroll.focus();
  } catch (e) {
    console.error(e);
    setStatus("bad", "Offline");
  }

