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
.workarea { flex: 1 1 auto; min-height: 0; display: flex; position: relative; }
.grid-scroll { flex: 1 1 auto; min-width: 0; overflow: auto; position: relative; background: var(--surface); outline: none; }
.chart-layer { position: absolute; left: 0; top: 0; width: 100%; min-height: 100%; pointer-events: none; z-index: 7; }
.chart-card { position: absolute; background: var(--surface); border: 1px solid var(--line-strong); border-radius: 9px;
  box-shadow: 0 8px 24px rgba(0,0,0,.14); pointer-events: auto; overflow: hidden; }
.chart-card.selected { box-shadow: 0 0 0 2px var(--accent), 0 8px 24px rgba(0,0,0,.16); }
.chart-card-head { height: 32px; display: flex; align-items: center; gap: 8px; padding: 0 7px 0 10px; border-bottom: 1px solid var(--line); cursor: move; user-select: none; touch-action: none; }
.chart-card-head strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; }
.chart-card-range { color: var(--faint); font-size: 11px; margin-left: auto; }
.chart-card-copy { flex: 0 0 auto; border: 0; border-radius: 5px; background: transparent; color: var(--muted); padding: 4px 6px; cursor: pointer; font-size: 11px; }
.chart-card-copy:hover { background: var(--surface-2); color: var(--text); }
.chart-card-body { height: calc(100% - 32px); padding: 8px; }
.chart-card svg { width: 100%; height: 100%; display: block; }
.chart-empty { height: 100%; display: flex; align-items: center; justify-content: center; color: var(--faint); text-align: center; padding: 24px; }
.chart-panel { width: 330px; flex: 0 0 330px; border-left: 1px solid var(--line); background: var(--surface); overflow-y: auto;
  transition: width .18s var(--ease-out), flex-basis .18s var(--ease-out); }
.chart-panel.collapsed { width: 38px; flex-basis: 38px; overflow: hidden; }
.chart-panel-head { height: 42px; display: flex; align-items: center; gap: 8px; padding: 0 10px; border-bottom: 1px solid var(--line); position: sticky; top: 0; background: var(--surface); z-index: 2; }
.chart-panel-head strong { white-space: nowrap; }
.chart-panel-toggle, .chart-panel-back { width: 26px; height: 26px; flex: 0 0 auto; border: 0; border-radius: 5px; background: transparent; cursor: pointer; color: var(--muted); font-size: 17px; }
.chart-panel-toggle { margin-left: auto; }
.chart-panel-toggle:hover, .chart-panel-back:hover { background: var(--surface-2); }
.chart-panel.collapsed .chart-panel-head strong, .chart-panel.collapsed .chart-panel-content, .chart-panel.collapsed .chart-panel-back { display: none; }
.chart-panel-content { padding: 14px; display: flex; flex-direction: column; gap: 13px; }
.chart-field { display: flex; flex-direction: column; gap: 5px; }
.chart-field > span { color: var(--muted); font-size: 11.5px; font-weight: 600; }
.chart-field input[type=text], .chart-field select { width: 100%; border: 1px solid var(--line-strong); border-radius: 6px; padding: 7px 8px; outline: none; color: var(--text); background: var(--surface); }
.chart-field input[type=text]:focus, .chart-field select:focus { border-color: var(--accent); }
.chart-check { display: flex; align-items: center; gap: 8px; color: var(--text); }
.chart-check input { accent-color: var(--accent); }
.chart-panel-actions { display: flex; justify-content: space-between; gap: 8px; border-top: 1px solid var(--line); padding-top: 12px; }
.chart-copy { border: 1px solid var(--line-strong); background: var(--surface); color: var(--text); border-radius: 6px; padding: 6px 10px; cursor: pointer; }
.chart-copy:hover { background: var(--surface-2); }
.chart-delete { border: 1px solid rgba(196,86,106,.35); background: rgba(196,86,106,.08); color: var(--bad); border-radius: 6px; padding: 6px 10px; cursor: pointer; }
.chart-copy-note { margin: -5px 1px 0; color: var(--faint); font-size: 10.5px; line-height: 1.4; }
.sidebar-menu { display: flex; flex-direction: column; gap: 8px; }
.sidebar-menu-item { width: 100%; display: flex; align-items: center; gap: 10px; padding: 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); color: var(--text); cursor: pointer; text-align: left; }
.sidebar-menu-item:hover { background: var(--surface-2); border-color: var(--line-strong); }
.sidebar-menu-icon { width: 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center; border-radius: 7px; background: var(--accent-soft); color: var(--accent); }
.sidebar-menu-icon svg { width: 15px; height: 15px; }
.sidebar-menu-label { font-weight: 650; }
.sidebar-menu-count { margin-left: auto; color: var(--faint); }
.sidebar-menu-arrow { color: var(--faint); font-size: 17px; }
.chart-list { display: flex; flex-direction: column; gap: 8px; }
.chart-list-item { width: 100%; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); padding: 10px; cursor: pointer; text-align: left; color: var(--text); }
.chart-list-item:hover { background: var(--surface-2); border-color: var(--line-strong); }
.chart-list-item strong { display: block; margin-bottom: 3px; }
.chart-list-item span { color: var(--faint); font-size: 11px; }
.pivot-note { color: var(--faint); font-size: 11px; line-height: 1.4; }
.pivot-filter-values { border: 1px solid var(--line); border-radius: 7px; max-height: 180px; overflow: auto; padding: 5px; }
.pivot-filter-option { display: flex; align-items: center; gap: 7px; padding: 5px; border-radius: 5px; cursor: pointer; }
.pivot-filter-option:hover { background: var(--surface-2); }
.pivot-filter-option input { accent-color: var(--accent); }
.pivot-actions { display: flex; gap: 8px; padding-top: 4px; }
.pivot-actions button { border: 1px solid var(--line-strong); border-radius: 6px; padding: 6px 10px; background: var(--surface); color: var(--text); cursor: pointer; }
.pivot-actions button:hover { background: var(--surface-2); }
.pivot-actions button.danger { margin-left: auto; color: var(--bad); border-color: rgba(196,86,106,.35); background: rgba(196,86,106,.08); }
.comments-section { display: flex; flex-direction: column; gap: 8px; }
.comments-section:first-child { border-top: 0; padding-top: 0; }
.comments-heading { display: flex; align-items: center; justify-content: space-between; color: var(--muted); font-size: 11.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .045em; }
.comment-card { border: 1px solid var(--line); border-radius: 7px; padding: 8px; cursor: pointer; background: var(--surface); }
.comment-card:hover { border-color: var(--line-strong); background: #fffdfa; }
.comment-card-ref { color: var(--accent); font-weight: 700; font-size: 11px; margin-bottom: 4px; }
.comment-card-text { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.4; }
.comment-card-actions { display: flex; gap: 6px; margin-top: 8px; }
.comment-card-actions button { border: 1px solid var(--line); border-radius: 5px; padding: 4px 7px; background: var(--surface); color: var(--muted); cursor: pointer; font-size: 11px; }
.comment-card-actions button:hover { background: var(--surface-2); color: var(--text); }
.comment-card-actions button.danger:hover { color: var(--bad); background: rgba(196,86,106,.08); }
@media (max-width: 760px) { .chart-panel { position: absolute; right: 0; top: 0; bottom: 0; z-index: 30; box-shadow: -8px 0 24px rgba(0,0,0,.12); } }
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
.grid td.cell a.cell-link { color: #1967d2; text-decoration: underline; cursor: pointer; }
.grid td.cell a.cell-link:hover { color: #174ea6; }
.grid td.cell.num .cv { text-align: right; }
.grid td.cell.err { color: var(--bad); }
.grid td.cell.err .cv { text-align: center; }
.grid td.cell.has-error-detail { overflow: visible; z-index: 6; }
.formula-error-tooltip { display: none; position: absolute; left: calc(100% + 4px); top: -5px; z-index: 40; width: 300px; padding: 9px 10px; border: 1px solid rgba(196,86,106,.35); border-radius: 7px; background: #fff8f9; color: var(--text); box-shadow: 0 9px 24px rgba(0,0,0,.17); white-space: normal; line-height: 1.4; text-align: left; font-weight: 400; }
.grid td.cell.has-error-detail:hover > .formula-error-tooltip { display: block; }
.formula-error-tooltip strong { display: block; color: var(--bad); margin-bottom: 4px; }
.formula-error-preview { margin-top: 7px; padding: 6px 7px; border-radius: 5px; background: #fff; color: var(--muted); font-family: ui-monospace, "SF Mono", Menlo, monospace; overflow-wrap: anywhere; }
.formula-error-preview mark { background: rgba(196,86,106,.22); color: #9d3048; border-radius: 3px; padding: 1px 2px; }
.grid td.cell.sel { background: var(--accent-soft); }
.grid td.cell.active { box-shadow: inset 0 0 0 2px var(--accent); z-index: 2; }
.grid td.cell.wrap { white-space: normal; line-height: 1.35; height: auto; padding-top: 3px; padding-bottom: 3px; }
.grid td.cell.wrap .cv {
  white-space: normal;
  overflow: visible;
  overflow-wrap: anywhere;
  word-break: break-word;
  line-height: 1.35;
}
.grid td.cell.text-overflow { overflow: visible; z-index: 1; }
.grid td.cell.text-overflow .cv { position: absolute; left: 4px; top: 0; overflow: hidden; white-space: nowrap; z-index: 2; pointer-events: none; }
.grid td.cell.text-overflow a.cell-link { pointer-events: auto; }
.grid td.cell.has-comment { overflow: visible; z-index: 4; }
.comment-marker { position: absolute; right: 0; top: 0; width: 0; height: 0; border-top: 9px solid var(--accent); border-left: 9px solid transparent; z-index: 5; cursor: pointer; }
.filter-cell .comment-marker { right: auto; left: 0; border-left: 0; border-right: 9px solid transparent; }
.cell-comment-tooltip { display: none; position: absolute; z-index: 30; left: 100%; top: -4px; width: 230px; max-height: 150px; overflow: auto; white-space: normal; line-height: 1.4; padding: 9px 10px; border: 1px solid var(--line-strong); border-radius: 7px; background: var(--surface); color: var(--text); box-shadow: 0 8px 22px rgba(0,0,0,.17); font-weight: 400; }
.grid td.cell:hover > .cell-comment-tooltip { display: block; }
.comment-popover { position: fixed; z-index: 1500; width: min(320px, calc(100vw - 20px)); padding: 10px; border: 1px solid var(--line-strong); border-radius: 9px; background: var(--surface); box-shadow: 0 12px 32px rgba(0,0,0,.2); }
.comment-popover textarea { width: 100%; min-height: 84px; resize: vertical; border: 1px solid var(--line-strong); border-radius: 6px; padding: 8px; outline: none; color: var(--text); font: inherit; }
.comment-popover textarea:focus { border-color: var(--accent); }
.comment-popover-actions { display: flex; justify-content: flex-end; gap: 7px; margin-top: 8px; }
.comment-popover button { border: 1px solid var(--line); border-radius: 6px; background: var(--surface); color: var(--text); padding: 5px 9px; cursor: pointer; }
.comment-popover button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.grid tr.filter-row td.cell.filter-cell { background: #fff8f3; font-weight: 600; padding-right: 27px; }
.grid tr.filter-row th.rowhead:not(.hl):not(.full) { background: #edf3ef; color: #52715f; box-shadow: inset 3px 0 #7ba889; }
.filter-trigger { position: absolute; right: 3px; top: 3px; width: 18px; height: 18px; border: 1px solid var(--line);
  border-radius: 4px; background: var(--surface); color: var(--muted); display: inline-flex; align-items: center;
  justify-content: center; cursor: pointer; padding: 0; z-index: 3; }
.filter-trigger:hover, .filter-trigger.active { color: var(--accent); border-color: rgba(225,99,46,.5); background: var(--accent-soft); }
.filter-trigger svg { width: 11px; height: 11px; }
.filter-menu { min-width: 230px; max-width: min(320px, 90vw); }
.filter-menu-title { padding: 7px 9px 5px; font-size: 11px; font-weight: 700; color: var(--faint); text-transform: uppercase; letter-spacing: .05em; }
.filter-sort { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 5px; padding: 2px 5px 7px; border-bottom: 1px solid var(--line); }
.filter-sort button, .filter-links button { border: 0; background: transparent; color: var(--text); padding: 6px; border-radius: 5px; cursor: pointer; text-align: left; }
.filter-sort button:hover, .filter-links button:hover { background: var(--surface-2); }
.filter-sort button[disabled] { color: var(--faint); cursor: default; background: transparent; }
.filter-links { display: flex; align-items: center; justify-content: space-between; padding: 5px; }
.filter-links button { color: var(--accent); padding: 4px; }
.filter-search { margin: 0 5px 5px; width: calc(100% - 10px); border: 1px solid var(--line-strong); border-radius: 6px; padding: 7px 9px; outline: none; }
.filter-search:focus { border-color: var(--accent); }
.filter-options { max-height: 240px; overflow: auto; padding: 2px 4px; }
.filter-option { display: flex; align-items: center; gap: 8px; padding: 6px; border-radius: 5px; cursor: pointer; }
.filter-option:hover { background: var(--surface-2); }
.filter-option input { accent-color: var(--accent); }
.filter-option span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.filter-actions { display: flex; justify-content: space-between; gap: 8px; padding: 7px 5px 3px; border-top: 1px solid var(--line); }
.filter-actions button { border: 1px solid var(--line); border-radius: 5px; background: var(--surface); color: var(--text); padding: 5px 9px; cursor: pointer; }
.filter-actions button.primary { background: var(--accent); color: white; border-color: var(--accent); }
.filter-empty { padding: 10px; color: var(--faint); }

/* Fill handle + resize handles */
.fill-handle { position: absolute; z-index: 22; width: 8px; height: 8px; border: 1px solid #fff; border-radius: 2px; background: var(--accent); cursor: crosshair; display: none; }
.grid td.cell.fill-preview { background: rgba(52,120,199,.10); box-shadow: inset 0 0 0 1px #3478c7; }

/* Column resize handle */
.col-resize { position: absolute; top: 0; right: -3px; width: 7px; height: 100%; cursor: col-resize; z-index: 5; }
.row-resize { position: absolute; left: 0; bottom: -3px; height: 7px; width: 100%; cursor: row-resize; z-index: 5; }

/* Cell editor overlay */
.cell-editor { position: absolute; z-index: 20; display: none; border: 2px solid var(--accent);
  background: var(--surface); font-size: 13px; line-height: 20px; padding: 1px 3px; margin: 0;
  outline: none; resize: none; overflow: hidden; box-shadow: 0 2px 12px rgba(0,0,0,0.18);
  font-family: ui-sans-serif, system-ui, sans-serif; color: var(--text); border-radius: 0;
  min-width: 60px; white-space: pre; }
.cell-editor.capture { display: block; opacity: 0; width: 1px !important; min-width: 1px; height: 1px !important;
  min-height: 1px; padding: 0; border: 0; box-shadow: none; pointer-events: none; overflow: hidden; }
.formula-assist { position: fixed; z-index: 1400; width: min(360px, calc(100vw - 20px)); max-height: 250px; overflow: auto; border: 1px solid var(--line-strong); border-radius: 8px; background: var(--surface); box-shadow: 0 10px 28px rgba(0,0,0,.18); display: none; }
.formula-suggestion { padding: 7px 10px; cursor: pointer; border-bottom: 1px solid var(--line); }
.formula-suggestion:last-child { border-bottom: 0; }
.formula-suggestion.active, .formula-suggestion:hover { background: var(--accent-soft); }
.formula-suggestion strong { display: block; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 12.5px; }
.formula-suggestion span { display: block; color: var(--muted); font-size: 11px; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.formula-syntax { padding: 9px 11px; }
.formula-syntax-code { font-family: ui-monospace, "SF Mono", Menlo, monospace; color: #24733f; font-weight: 650; line-height: 1.5; }
.formula-syntax-code .current { color: #fff; background: #2b8a4b; border-radius: 4px; padding: 1px 3px; }
.formula-syntax-desc { color: var(--muted); font-size: 11px; margin-top: 4px; }
.formula-error { padding: 9px 11px; color: var(--bad); background: rgba(196,86,106,.08); font-size: 12px; line-height: 1.4; }
.grid td.cell.formula-ref { background: rgba(52,120,199,.12); z-index: 5; }
.grid td.cell.formula-ref-top { border-top: 2px solid #3478c7; }
.grid td.cell.formula-ref-bottom { border-bottom: 2px solid #3478c7; }
.grid td.cell.formula-ref-left { border-left: 2px solid #3478c7; }
.grid td.cell.formula-ref-right { border-right: 2px solid #3478c7; }
.grid td.cell.formula-ref:not(.formula-ref-right) { border-right-color: transparent; }
.grid td.cell.formula-ref:not(.formula-ref-bottom) { border-bottom-color: transparent; }
.formula-range-handle { position: absolute; z-index: 24; width: 9px; height: 9px; border: 1px solid #fff; border-radius: 50%; background: #3478c7; cursor: nwse-resize; display: none; touch-action: none; }

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
.fn-menu { width: 286px; max-height: min(540px, 78vh); overflow-y: auto; padding: 6px; }
.fn-search-wrap { position: sticky; top: -6px; z-index: 3; background: var(--surface); padding: 5px 3px 8px; }
.fn-search { width: 100%; border: 1px solid var(--line-strong); border-radius: 7px; padding: 8px 10px; outline: none; color: var(--text); background: var(--surface); }
.fn-search:focus { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft); }
.fn-group { border-top: 1px solid var(--line); }
.fn-group:first-of-type { border-top: 0; }
.fn-head { width: 100%; min-height: 34px; border: 0; background: transparent; color: var(--muted); padding: 7px 8px; display: flex; align-items: center; justify-content: space-between; cursor: pointer; text-align: left; }
.fn-head:hover { background: var(--surface-2); border-radius: 6px; color: var(--text); }
.fn-head-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .055em; }
.fn-head-count { margin-left: auto; margin-right: 8px; color: var(--faint); font-size: 10.5px; }
.fn-chev { transition: transform .14s var(--ease-out); }
.fn-group.open .fn-chev { transform: rotate(90deg); }
.fn-items { display: none; padding-bottom: 4px; }
.fn-group.open .fn-items { display: block; }
.fn-no-results { padding: 18px 10px; text-align: center; color: var(--faint); }

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
  filter: '<path d="M4 5h16l-6.5 7.5V19l-3 1v-7.5z"/>',
  chart: '<path d="M4 19V5"/><path d="M4 19h16"/><polyline points="6 15 10 10 14 13 20 6"/>',
  comment: '<path d="M5 5h14v11H9l-4 4z"/><line x1="8" y1="9" x2="16" y2="9"/><line x1="8" y1="12" x2="14" y2="12"/>',
  pivot: '<rect x="3" y="4" width="18" height="16" rx="1"/><path d="M3 9h18M9 4v16"/><path d="M13 13h5M15.5 10.5V16"/>',
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
class HyperlinkValue {
  constructor(url, label) { this.url = url; this.label = label || url; }
  toString() { return this.label; }
}
function safeHyperlinkUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch (error) { return null; }
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
    const singleQuotedSheet = ch === "'" && (() => {
      let j = i + 1;
      while (j < n) {
        if (src[j] === "'") { if (src[j + 1] === "'") { j += 2; continue; } return src[j + 1] === "!"; }
        j++;
      }
      return false;
    })();
    if (ch === '"' || (ch === "'" && !singleQuotedSheet)) {
      const quote = ch;
      let j = i + 1, str = "";
      while (j < n) {
        if (src[j] === quote) { if (src[j + 1] === quote) { str += quote; j += 2; continue; } j++; break; }
        if (src[j] === "\\" && src[j + 1] === quote) { str += quote; j += 2; continue; }
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
        while (j < n) {
          if (src[j] === "'") { if (src[j + 1] === "'") { word += "'"; j += 2; continue; } break; }
          word += src[j++];
        }
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
  if (pos !== tokens.length) throw ERR.VALUE();
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
  if (v instanceof HyperlinkValue) return v.label;
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
  if (computed instanceof HyperlinkValue) return { text: computed.label, link: computed.url };
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
  const text = String(computed);
  const link = safeHyperlinkUrl(text);
  return link ? { text, link } : { text };
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
  F.HYPERLINK = (a, c, H) => {
    const rawUrl = H.toStr(H.scalar(a[0], c));
    const url = safeHyperlinkUrl(rawUrl); if (!url) return ERR.VALUE();
    const label = a.length > 1 ? H.toStr(H.scalar(a[1], c)) : rawUrl;
    return new HyperlinkValue(url, label);
  };

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
const FUNCTION_HELP = {
  SUM: ["SUM(value1, [value2, …])", "Adds numbers or ranges."],
  AVERAGE: ["AVERAGE(value1, [value2, …])", "Returns the arithmetic mean."],
  COUNT: ["COUNT(value1, [value2, …])", "Counts numeric values."],
  COUNTA: ["COUNTA(value1, [value2, …])", "Counts non-empty values."],
  COUNTIF: ["COUNTIF(range, criterion)", "Counts cells matching a condition."],
  COUNTIFS: ["COUNTIFS(range1, criterion1, …)", "Counts rows matching multiple conditions."],
  SUMIF: ["SUMIF(range, criterion, [sum_range])", "Sums values matching a condition."],
  SUMIFS: ["SUMIFS(sum_range, range1, criterion1, …)", "Sums values matching multiple conditions."],
  AVERAGEIF: ["AVERAGEIF(range, criterion, [average_range])", "Averages values matching a condition."],
  MIN: ["MIN(value1, [value2, …])", "Returns the smallest number."],
  MAX: ["MAX(value1, [value2, …])", "Returns the largest number."],
  MEDIAN: ["MEDIAN(value1, [value2, …])", "Returns the median value."],
  ROUND: ["ROUND(value, [places])", "Rounds a number to a specified precision (default 0)."],
  ROUNDUP: ["ROUNDUP(value, places)", "Rounds a number away from zero."],
  ROUNDDOWN: ["ROUNDDOWN(value, places)", "Rounds a number toward zero."],
  IF: ["IF(condition, value_if_true, [value_if_false])", "Returns values based on a condition."],
  IFS: ["IFS(condition1, value1, [condition2, value2, …])", "Tests multiple conditions in order."],
  IFERROR: ["IFERROR(value, [fallback])", "Returns a fallback (default blank) when a value is an error."],
  IFNA: ["IFNA(value, fallback)", "Returns a fallback for #N/A."],
  AND: ["AND(condition1, [condition2, …])", "Returns TRUE when every condition is true."],
  OR: ["OR(condition1, [condition2, …])", "Returns TRUE when any condition is true."],
  NOT: ["NOT(condition)", "Reverses a logical value."],
  CONCAT: ["CONCAT(value1, [value2, …])", "Joins text values."],
  TEXTJOIN: ["TEXTJOIN(delimiter, ignore_empty, text1, …)", "Joins text with a delimiter."],
  LEFT: ["LEFT(text, [characters])", "Returns characters from the beginning of text."],
  RIGHT: ["RIGHT(text, [characters])", "Returns characters from the end of text."],
  MID: ["MID(text, start, length)", "Returns characters from the middle of text."],
  LEN: ["LEN(text)", "Returns the number of characters."],
  TEXT: ["TEXT(value, format)", "Formats a number as text."],
  HYPERLINK: ["HYPERLINK(url, [link_label])", "Creates a clickable HTTP or HTTPS link."],
  VLOOKUP: ["VLOOKUP(search_key, range, column, [approximate])", "Looks down the first column of a range."],
  HLOOKUP: ["HLOOKUP(search_key, range, row, [approximate])", "Looks across the first row of a range."],
  INDEX: ["INDEX(reference, row, [column])", "Returns a value at a row and column."],
  MATCH: ["MATCH(search_key, range, [search_type])", "Returns the position of a matching value."],
  LOOKUP: ["LOOKUP(search_key, search_range, [result_range])", "Finds a value in a sorted range."],
  TODAY: ["TODAY()", "Returns the current date."],
  NOW: ["NOW()", "Returns the current date and time."],
  DATE: ["DATE(year, month, day)", "Builds a date from year, month, and day."],
  YEAR: ["YEAR(date)", "Returns the year of a date."],
  MONTH: ["MONTH(date)", "Returns the month of a date."],
  DAY: ["DAY(date)", "Returns the day of the month."],
  PRODUCT: ["PRODUCT(value1, [value2, …])", "Multiplies numbers or ranges."],
  ABS: ["ABS(value)", "Returns the absolute value."],
  SQRT: ["SQRT(value)", "Returns the positive square root."],
  MOD: ["MOD(dividend, divisor)", "Returns the remainder after division."],
  POWER: ["POWER(base, exponent)", "Raises a number to a power."],
  STDEV: ["STDEV(value1, [value2, …])", "Estimates sample standard deviation."],
  VAR: ["VAR(value1, [value2, …])", "Estimates sample variance."],
  RANK: ["RANK(value, range, [ascending])", "Returns a value’s rank in a range."],
  LARGE: ["LARGE(range, rank)", "Returns the nth largest value."],
  SWITCH: ["SWITCH(expression, case1, value1, [default])", "Matches an expression to cases."],
  UPPER: ["UPPER(text)", "Converts text to uppercase."],
  LOWER: ["LOWER(text)", "Converts text to lowercase."],
  TRIM: ["TRIM(text)", "Removes repeated and surrounding spaces."],
  SUBSTITUTE: ["SUBSTITUTE(text, old_text, new_text, [instance])", "Replaces matching text."],
  CHOOSE: ["CHOOSE(index, choice1, [choice2, …])", "Returns a choice by numeric index."],
  WEEKDAY: ["WEEKDAY(date, [type])", "Returns the weekday number."],
  EDATE: ["EDATE(start_date, months)", "Moves a date by a number of months."],
  DATEDIF: ["DATEDIF(start_date, end_date, unit)", "Returns the difference between two dates."],
};
function functionHelp(name) { return FUNCTION_HELP[name] || [`${name}(value, …)`, "Spreadsheet function."]; }

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
  sheets: {},           // id -> { id, name, rows, cols, colWidths, rowHeights, frozenRows, frozenCols, filter, charts, comments }
  cells: {},            // id -> { REF -> { value, fmt, version } }
};
let activeSheetId = null;
let engine = makeEngine(model);
function rebuildEngine() { engine = makeEngine(model); }

// Selection: anchor + focus (row/col). The visible rectangle is selRange().
let anchor = { r: 0, c: 0 };
let extraRanges = [];
function selRange() {
  return { r1: Math.min(anchor.r, focus.r), c1: Math.min(anchor.c, focus.c), r2: Math.max(anchor.r, focus.r), c2: Math.max(anchor.c, focus.c) };
}
function selectionRanges() { return [...extraRanges, selRange()]; }
function addCurrentRangeToSelection() {
  const range = selRange();
  if (!extraRanges.some((item) => item.r1 === range.r1 && item.c1 === range.c1 && item.r2 === range.r2 && item.c2 === range.c2)) extraRanges.push(range);
}
function cellInSelection(row, column) {
  return selectionRanges().some((range) => row >= range.r1 && row <= range.r2 && column >= range.c1 && column <= range.c2);
}
function isWholeHeaderRange(range, sheet = curSheet()) {
  return (range.r1 === 0 && range.r2 === sheet.rows - 1) || (range.c1 === 0 && range.c2 === sheet.cols - 1);
}
function prepareHeaderSelection(additive) {
  if (!additive) { extraRanges = []; return; }
  const retained = selectionRanges().filter((range) => isWholeHeaderRange(range));
  extraRanges = retained.filter((range, index) => retained.findIndex((item) => item.r1 === range.r1 && item.c1 === range.c1 && item.r2 === range.r2 && item.c2 === range.c2) === index);
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
const absoluteRefBtn = iconBtn(null, "Cycle absolute reference (Ctrl/Cmd+Shift+L)", () => cycleAbsoluteReference(), "$");
absoluteRefBtn.disabled = true;

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
const filterBtn = iconBtn("filter", "Detect and filter the current data table", () => toggleFilterRow());
const chartBtn = iconBtn("chart", "Create a chart from the selected data", (event) => openCreateChartMenu(event));
const commentBtn = iconBtn("comment", "Add a comment to the active cell", () => openCommentEditor(rcToRef(focus.r, focus.c)));
const pivotBtn = iconBtn("pivot", "Create a pivot table from the selected data", () => createPivotTable());

const toolbar = el("div", { class: "toolbar" }, [
  group(null, [undoBtn, redoBtn], true),
  group(null, [sumBtn, fxBtn, absoluteRefBtn]),
  group("p2", [fmtSel.el]),
  group("p2", [currencyBtn, percentBtn, decDecBtn, incDecBtn]),
  group(null, [boldBtn, italicBtn, underlineBtn, strikeBtn]),
  group("p1", [textColorBtn, fillColorBtn]),
  group("p1", [alignSegment, wrapBtn]),
  group("p2", [insRowBtn, insColBtn, delRowBtn]),
  group("p3", [sortAscBtn, sortDescBtn]),
  group(null, [filterBtn, chartBtn, pivotBtn, commentBtn]),
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
const chartLayer = el("div", { class: "chart-layer" });
const fillHandle = el("div", { class: "fill-handle", title: "Drag to fill" });
const formulaRangeHandle = el("div", { class: "formula-range-handle", title: "Drag to resize formula range" });
const cellEditor = el("textarea", { class: "cell-editor", spellcheck: "false", wrap: "off" });
const gridScroll = el("div", { class: "grid-scroll", tabindex: "0" }, [gridTable, remoteLayer, chartLayer, fillHandle, formulaRangeHandle, cellEditor]);

const chartPanelBack = el("button", { class: "chart-panel-back", title: "Back", "aria-label": "Back" }, "‹");
const chartPanelTitle = el("strong", {}, "Details");
const chartPanelToggle = el("button", { class: "chart-panel-toggle", title: "Expand sidebar", "aria-label": "Expand sidebar" }, "‹");
const chartPanelContent = el("div", { class: "chart-panel-content" });
const chartPanel = el("aside", { class: "chart-panel collapsed" }, [
  el("div", { class: "chart-panel-head" }, [chartPanelBack, chartPanelTitle, chartPanelToggle]), chartPanelContent,
]);
chartPanelBack.addEventListener("click", navigateSidebarBack);
chartPanelToggle.addEventListener("click", () => setChartPanelCollapsed(!chartPanel.classList.contains("collapsed")));
const workarea = el("div", { class: "workarea" }, [gridScroll, chartPanel]);

// --- Tab bar ---
const tabbar = el("div", { class: "tabbar" });

const app = el("div", { class: "app" }, [topbar, toolbar, fbar, workarea, tabbar]);
const printWorkbook = el("div", { id: "printWorkbook", "data-print-root": "workbook" });
const formulaAssist = el("div", { class: "formula-assist", role: "listbox", "aria-label": "Formula suggestions" });
document.body.appendChild(app);
document.body.appendChild(printWorkbook);
document.body.appendChild(formulaAssist);

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

function queueCellOp(sheetId, ref, value, fmt, baseVersion) {
  pendingCellOps.set(sheetId + "!" + ref, { sheetId, ref, value, fmt, baseVersion });
  scheduleSave();
}
// Structure is saved as a whole-workbook snapshot, so `ackedStructure` (what the server last held)
// lets a remote update be merged with the local changes still pending.
let ackedStructure = null;
function structureSnapshot() {
  return { title: model.title, sheetOrder: model.sheetOrder.slice(), sheets: JSON.parse(JSON.stringify(model.sheets)) };
}
function queueStructure() {
  pendingStructure = structureSnapshot();
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
    cellOps.push({ sheetId: op.sheetId, ref: op.ref, value: op.value, fmt: op.fmt, baseVersion: op.baseVersion ?? (cur ? cur.version : 0) });
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
    if (structure) ackedStructure = structure;
    // Adopt acknowledged versions without overwriting a newer local edit that
    // was queued while this save was in flight.
    for (const up of result.upserts || []) {
      const cells = model.cells[up.sheetId] || (model.cells[up.sheetId] = {});
      const key = up.sheetId + "!" + up.ref;
      const newer = pendingCellOps.get(key);
      if (!newer) cells[up.ref] = { ...up.cell };
      else {
        newer.baseVersion = up.cell.version;
        if (newer.value == null && newer.fmt == null) delete cells[up.ref];
        else cells[up.ref] = { value: newer.value ?? "", fmt: newer.fmt ?? null, version: up.cell.version };
      }
    }
    for (const del of result.deletes || []) {
      const cells = model.cells[del.sheetId];
      const key = del.sheetId + "!" + del.ref;
      const newer = pendingCellOps.get(key);
      if (!newer) { if (cells) delete cells[del.ref]; }
      else {
        newer.baseVersion = 0;
        if (cells && !(newer.value == null && newer.fmt == null)) cells[del.ref] = { value: newer.value ?? "", fmt: newer.fmt ?? null, version: 0 };
      }
    }
    if (result.status === "conflict" && result.conflicts) {
      // Rebase each rejected local intent onto the latest server version. An edit queued while
      // this save was in flight is the newer intent: the model already shows it, so only its base
      // version moves.
      const intents = new Map(cellOps.map((op) => [op.sheetId + "!" + op.ref, op]));
      for (const cf of result.conflicts) {
        const key = cf.sheetId + "!" + cf.ref;
        const newer = pendingCellOps.get(key);
        if (newer) { newer.baseVersion = cf.cell?.version || 0; continue; }
        const cells = model.cells[cf.sheetId] || (model.cells[cf.sheetId] = {});
        const intent = intents.get(key);
        if (!intent) { cells[cf.ref] = { ...cf.cell }; continue; }
        if (intent.value == null && intent.fmt == null) delete cells[cf.ref];
        else cells[cf.ref] = { value: intent.value ?? "", fmt: intent.fmt ?? null, version: cf.cell?.version || 0 };
        pendingCellOps.set(key, { ...intent, baseVersion: cf.cell?.version || 0 });
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
    if (cur) { const baseVersion = cur.version || 0; delete cells[ref]; queueCellOp(sheetId, ref, null, null, baseVersion); schedulePivotRefreshes(sheetId); }
    return;
  }
  const fmt = cur ? cur.fmt : null;
  cells[ref] = { value: value == null ? "" : String(value), fmt: fmt || null, version: cur ? cur.version : 0 };
  queueCellOp(sheetId, ref, cells[ref].value, cells[ref].fmt);
  schedulePivotRefreshes(sheetId);
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
  if ((value == null || value === "") && !clean) { if (cur) { const baseVersion = cur.version || 0; delete cells[ref]; queueCellOp(sheetId, ref, null, null, baseVersion); } return; }
  cells[ref] = { value: value || "", fmt: clean, version: cur ? cur.version : 0 };
  queueCellOp(sheetId, ref, cells[ref].value, clean);
}

// ===========================================================================
// Formatting actions over the selection
// ===========================================================================
function forEachSelected(fn) {
  const seen = new Set();
  beginBatch();
  for (const range of selectionRanges()) for (let row = range.r1; row <= range.r2; row++) for (let col = range.c1; col <= range.c2; col++) {
    const ref = rcToRef(row, col); if (!seen.has(ref)) { seen.add(ref); fn(ref, row, col); }
  }
  commitBatch();
  rebuildEngine();
  renderGrid();
}
function selectionFmtAllHave(key) {
  for (const range of selectionRanges()) for (let row = range.r1; row <= range.r2; row++) for (let col = range.c1; col <= range.c2; col++) {
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

// Moves every cell and range-bearing piece of metadata through the row and column maps
// (`index -> index | null` for deleted). Chart ranges and pivot sources that reference this sheet
// shrink around deleted lines and grow around inserted ones.
function rebuildSheetCells(mapRow, mapCol) {
  const old = curCells();
  const next = {};
  for (const [ref, cell] of Object.entries(old)) {
    const rc = parseRef(ref); if (!rc) continue;
    const r = mapRow(rc.r), c = mapCol(rc.c);
    if (r == null || c == null) continue;
    next[rcToRef(r, c)] = { ...cell, version: cell.version };
  }
  model.cells[activeSheetId] = next;
  if (Array.isArray(curSheet().comments)) {
    curSheet().comments = curSheet().comments.flatMap((comment) => {
      const position = parseRef(comment.ref); if (!position) return [];
      const r = mapRow(position.r), c = mapCol(position.c); if (r == null || c == null) return [];
      return [{ ...comment, ref: rcToRef(r, c) }];
    });
  }
  for (const chart of curSheet().charts || []) chart.range = remapRange(chart.range, mapRow, mapCol);
  for (const id of pivotSheets()) {
    const pivot = model.sheets[id].pivot;
    if (pivot.sourceSheetId === activeSheetId) pivot.sourceRange = remapRange(pivot.sourceRange, mapRow, mapCol);
  }
}
function remapRange(text, mapRow, mapCol) {
  const range = parseChartRange(text); if (!range) return text;
  const first = (from, to, map) => { for (let i = from; i <= to; i++) { const m = map(i); if (m != null) return m; } return null; };
  const last = (from, to, map) => { for (let i = to; i >= from; i--) { const m = map(i); if (m != null) return m; } return null; };
  const r1 = first(range.r1, range.r2, mapRow), r2 = last(range.r1, range.r2, mapRow);
  const c1 = first(range.c1, range.c2, mapCol), c2 = last(range.c1, range.c2, mapCol);
  if (r1 == null || c1 == null) return "";
  return text.includes(":") || r1 !== r2 || c1 !== c2 ? `${rcToRef(r1, c1)}:${rcToRef(r2, c2)}` : rcToRef(r1, c1);
}

function insertRows(at, count) {
  const sh = curSheet();
  if (sh.filter) {
    if (at <= sh.filter.row) { sh.filter.row += count; sh.filter.endRow = (sh.filter.endRow ?? sh.rows - 1) + count; }
    else if (at <= (sh.filter.endRow ?? sh.rows - 1)) sh.filter.endRow = (sh.filter.endRow ?? sh.rows - 1) + count;
  }
  rewriteAllFormulas(at, count, 0, 0);
  rebuildSheetCells((r) => r >= at ? r + count : r, (c) => c);
  sh.rows += count;
  shiftDims(sh.rowHeights, at, count);
  commitStructuralChange();
  moveActive(at, selRange().c1);
}
function insertCols(at, count) {
  const sh = curSheet();
  if (sh.filter) {
    const next = {};
    for (const [column, values] of Object.entries(sh.filter.criteria || {})) next[Number(column) >= at ? Number(column) + count : Number(column)] = values;
    sh.filter.criteria = next;
    sh.filter.columns = filterColumns(sh.filter).map((column) => column >= at ? column + count : column);
  }
  rewriteAllFormulas(0, 0, at, count);
  rebuildSheetCells((r) => r, (c) => c >= at ? c + count : c);
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
  rewriteAllFormulas(at + count, -count, 0, 0);
  rebuildSheetCells((row) => (row >= at && row < at + count) ? null : (row > at ? row - count : row), (c) => c);
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
    const next = {};
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
  rewriteAllFormulas(0, 0, at + count, -count);
  rebuildSheetCells((row) => row, (c) => (c >= at && c < at + count) ? null : (c > at ? c - count : c));
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
  // Structural row/col changes establish a new natural row order.
  resetFilterSortBaseline();
  queueStructure();
  queueReplacement(activeSheetId);
  rebuildEngine();
  renderGrid();
  undoStack.length = 0; redoStack.length = 0; updateUndoButtons(); // structural ops aren't locally undoable
  schedulePivotRefreshes(activeSheetId);
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
    const rowComments = sheetComments().filter((comment) => { const position = parseRef(comment.ref); return position?.r === row && position.c >= r.c1 && position.c <= r.c2; });
    rows.push({ rowCells, keyVal, rowComments, sourceRow: row });
  }
  rows.sort((x, y) => {
    let a = x.keyVal, b = y.keyVal;
    a = a == null ? "" : a; b = b == null ? "" : b;
    let cmp;
    if (typeof a === "number" && typeof b === "number") cmp = a - b;
    else cmp = String(a).toLowerCase() < String(b).toLowerCase() ? -1 : String(a).toLowerCase() > String(b).toLowerCase() ? 1 : 0;
    return asc ? cmp : -cmp;
  });
  // Write back, keeping comments attached to the cells that moved.
  curSheet().comments = sheetComments().filter((comment) => { const position = parseRef(comment.ref); return !position || position.r < r.r1 || position.r > r.r2 || position.c < r.c1 || position.c > r.c2; });
  for (let i = 0; i < rows.length; i++) {
    const row = r.r1 + i;
    for (let col = r.c1; col <= r.c2; col++) {
      const src = rows[i].rowCells[col];
      const ref = rcToRef(row, col);
      if (src) cells[ref] = { value: shiftedCopyFormula(src.value, rcToRef(rows[i].sourceRow, col), ref, false), fmt: src.fmt, version: (cells[ref]?.version || 0) };
      else delete cells[ref];
    }
    for (const comment of rows[i].rowComments) {
      const position = parseRef(comment.ref); if (position) curSheet().comments.push({ ...comment, ref: rcToRef(row, position.c) });
    }
  }
  resetFilterSortBaseline();
  queueStructure();
  queueReplacement(activeSheetId);
  rebuildEngine();
  renderGrid();
  undoStack.length = 0; redoStack.length = 0; updateUndoButtons();
  schedulePivotRefreshes(activeSheetId);
}

// ===========================================================================
// Pivot tables
// ===========================================================================
let pivotRefreshTimer = null;
function pivotSheets() { return model.sheetOrder.filter((id) => model.sheets[id]?.pivot); }
function pivotCellValue(sheetId, row, column) { return engine.computeRef(sheetId, rcToRef(row, column)); }
function pivotDisplay(value) { return value == null || value === "" ? "(Blank)" : (isErr(value) ? value.value : String(value)); }
function pivotSourceRange() {
  let range = selRange();
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
function pivotFields(pivot) {
  const range = parseChartRange(pivot.sourceRange); if (!range || !model.sheets[pivot.sourceSheetId]) return [];
  const fields = [], used = new Map();
  for (let column = range.c1; column <= range.c2; column++) {
    let name = pivotDisplay(pivotCellValue(pivot.sourceSheetId, range.r1, column));
    if (name === "(Blank)") name = `Column ${colToLetter(column)}`;
    const count = (used.get(name) || 0) + 1; used.set(name, count);
    fields.push({ name: count > 1 ? `${name} (${count})` : name, column });
  }
  return fields;
}
function aggregateState() { return { sum: 0, count: 0, numericCount: 0, min: Infinity, max: -Infinity }; }
function addAggregate(state, value) {
  if (value != null && value !== "" && !isErr(value)) state.count++;
  const number = typeof value === "number" ? value : Number(value);
  if (value != null && value !== "" && Number.isFinite(number)) { state.sum += number; state.numericCount++; state.min = Math.min(state.min, number); state.max = Math.max(state.max, number); }
}
function finishAggregate(state, kind) {
  if (kind === "count") return state.count;
  if (!state.numericCount) return 0;
  if (kind === "average") return state.sum / state.numericCount;
  if (kind === "min") return state.min;
  if (kind === "max") return state.max;
  return state.sum;
}
function buildPivotOutput(pivot) {
  const range = parseChartRange(pivot.sourceRange), fields = pivotFields(pivot);
  if (!range || !fields.length) return { cells: {}, rows: 20, cols: 8 };
  const byName = new Map(fields.map((field) => [field.name, field.column]));
  const rowColumn = byName.get(pivot.rowField), columnColumn = byName.get(pivot.columnField), valueColumn = byName.get(pivot.valueField);
  const records = [];
  for (let row = range.r1 + 1; row <= range.r2; row++) {
    if (pivot.filterField) {
      const filterColumn = byName.get(pivot.filterField);
      const selectedValues = pivot.filterValues || (pivot.filterValue ? [pivot.filterValue] : []);
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
  const states = new Map(), rowTotals = new Map(), columnTotals = new Map(), grandTotal = aggregateState();
  const stateFor = (map, key) => { if (!map.has(key)) map.set(key, aggregateState()); return map.get(key); };
  for (const record of records) {
    addAggregate(stateFor(states, record.row + "\u0000" + record.column), record.value);
    addAggregate(stateFor(rowTotals, record.row), record.value); addAggregate(stateFor(columnTotals, record.column), record.value); addAggregate(grandTotal, record.value);
  }
  const cells = {}, put = (row, column, value, fmt = null) => { cells[rcToRef(row, column)] = { value: String(value ?? ""), fmt, version: 1 }; };
  const headerFmt = { b: true, bg: "#e1632e", c: "#ffffff" };
  const rowHeaderFmt = { b: true, bg: "#fff7f2", c: "#3f332e" };
  const totalFmt = { b: true, bg: "#fde9dc", c: "#3f332e" };
  put(0, 0, pivot.rowField || "Rows", headerFmt);
  columnKeys.forEach((key, index) => put(0, index + 1, key, headerFmt));
  if (pivot.showRowTotals !== false) put(0, columnKeys.length + 1, "Grand Total", totalFmt);
  rowKeys.forEach((rowKey, rowIndex) => {
    put(rowIndex + 1, 0, rowKey, rowHeaderFmt);
    columnKeys.forEach((columnKey, columnIndex) => put(rowIndex + 1, columnIndex + 1, finishAggregate(states.get(rowKey + "\u0000" + columnKey) || aggregateState(), pivot.aggregate), pivot.aggregate === "average" ? { nf: "number", d: 2 } : null));
    if (pivot.showRowTotals !== false) put(rowIndex + 1, columnKeys.length + 1, finishAggregate(rowTotals.get(rowKey) || aggregateState(), pivot.aggregate), totalFmt);
  });
  if (pivot.showColumnTotals !== false) {
    const totalRow = rowKeys.length + 1; put(totalRow, 0, "Grand Total", totalFmt);
    columnKeys.forEach((key, index) => put(totalRow, index + 1, finishAggregate(columnTotals.get(key) || aggregateState(), pivot.aggregate), totalFmt));
    if (pivot.showRowTotals !== false) put(totalRow, columnKeys.length + 1, finishAggregate(grandTotal, pivot.aggregate), totalFmt);
  }
  return { cells, rows: Math.max(20, rowKeys.length + 4), cols: Math.max(8, columnKeys.length + 3) };
}
function refreshPivot(sheetId, save = true) {
  const sheet = model.sheets[sheetId]; if (!sheet?.pivot) return;
  const output = buildPivotOutput(sheet.pivot);
  model.cells[sheetId] = output.cells; sheet.rows = Math.max(sheet.rows, output.rows); sheet.cols = Math.max(sheet.cols, output.cols);
  const widths = {};
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
// Edits to several source sheets inside the debounce window refresh every one of their pivots.
const pendingPivotSources = new Set();
function schedulePivotRefreshes(sourceSheetId) {
  pendingPivotSources.add(sourceSheetId);
  clearTimeout(pivotRefreshTimer);
  pivotRefreshTimer = setTimeout(() => {
    const sources = new Set(pendingPivotSources); pendingPivotSources.clear();
    rebuildEngine();
    for (const id of pivotSheets()) if (sources.has(model.sheets[id].pivot.sourceSheetId)) refreshPivot(id);
  }, 320);
}
function createPivotTable() {
  const sourceSheetId = activeSheetId, sourceRange = pivotSourceRange();
  if (!sourceRange) { setStatus("bad", "Select data with a header row"); return; }
  const id = "s_" + Math.random().toString(36).slice(2, 8);
  let number = 1; while (model.sheetOrder.some((sheetId) => model.sheets[sheetId].name === `Pivot table ${number}`)) number++;
  const pivot = { sourceSheetId, sourceRange, rowField: "", columnField: "", valueField: "", aggregate: "sum", showRowTotals: true, showColumnTotals: true, filterField: "", filterValues: [] };
  const fields = pivotFields(pivot); pivot.rowField = fields[0]?.name || "";
  pivot.valueField = fields.find((field) => {
    const range = parseChartRange(sourceRange); if (!range) return false;
    for (let row = range.r1 + 1; row <= range.r2; row++) if (typeof pivotCellValue(sourceSheetId, row, field.column) === "number") return true;
    return false;
  })?.name || fields[1]?.name || fields[0]?.name || "";
  model.sheets[id] = { id, name: `Pivot table ${number}`, rows: 100, cols: 26, colWidths: {}, rowHeights: {}, frozenRows: 0, frozenCols: 0, filter: null, charts: [], comments: [], pivot };
  model.cells[id] = {}; model.sheetOrder.push(id); refreshPivot(id, false);
  queueStructure(); queueReplacement(id); switchSheet(id); selectedPivotSheetId = id; sidebarView = "pivot"; setChartPanelCollapsed(false); renderChartPanel();
}
function pivotSelectField(label, value, options, onChange, allowNone = true) {
  const select = el("select");
  if (allowNone) select.appendChild(el("option", { value: "" }, "None"));
  for (const optionValue of options) { const option = el("option", { value: optionValue }, optionValue); if (optionValue === value) option.selected = true; select.appendChild(option); }
  select.addEventListener("change", () => onChange(select.value));
  return el("label", { class: "chart-field" }, [el("span", {}, label), select]);
}
function updatePivot(sheetId, key, value) {
  const pivot = model.sheets[sheetId]?.pivot; if (!pivot) return;
  pivot[key] = value; if (key === "filterField") pivot.filterValues = [];
  if (key === "sourceRange") {
    const fields = pivotFields(pivot).map((field) => field.name);
    if (!fields.includes(pivot.rowField)) pivot.rowField = fields[0] || "";
    if (!fields.includes(pivot.valueField)) pivot.valueField = fields[1] || fields[0] || "";
    if (!fields.includes(pivot.columnField)) pivot.columnField = "";
    if (!fields.includes(pivot.filterField)) { pivot.filterField = ""; pivot.filterValues = []; }
  }
  refreshPivot(sheetId); renderChartPanel();
}
function pivotFilterValues(pivot) {
  if (!pivot.filterField) return [];
  const range = parseChartRange(pivot.sourceRange), field = pivotFields(pivot).find((item) => item.name === pivot.filterField);
  if (!range || !field) return [];
  const values = []; for (let row = range.r1 + 1; row <= range.r2; row++) values.push(pivotDisplay(pivotCellValue(pivot.sourceSheetId, row, field.column)));
  return [...new Set(values)].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}
function pivotFilterMultiSelect(sheetId, pivot) {
  const options = pivotFilterValues(pivot), selected = pivot.filterValues || (pivot.filterValue ? [pivot.filterValue] : []);
  const allSelected = !selected.length, wrap = el("div", { class: "chart-field" });
  wrap.appendChild(el("span", {}, "Filter values"));
  const list = el("div", { class: "pivot-filter-values" }), checks = [];
  for (const value of options) {
    const input = el("input", { type: "checkbox" }); input.checked = allSelected || selected.includes(value);
    const option = el("label", { class: "pivot-filter-option" }, [input, el("span", {}, value)]);
    checks.push({ value, input }); list.appendChild(option);
  }
  const apply = () => {
    const values = checks.filter((item) => item.input.checked).map((item) => item.value);
    pivot.filterValues = values.length === options.length ? [] : (values.length ? values : ["__PIVOT_NONE__"]);
    refreshPivot(sheetId);
  };
  checks.forEach((item) => item.input.addEventListener("change", apply));
  if (!options.length) list.appendChild(el("div", { class: "pivot-note" }, "No values available"));
  wrap.appendChild(list); return wrap;
}

// ===========================================================================
// Cell comments
// ===========================================================================
let commentPopover = null;
function sheetComments() { return curSheet().comments || (curSheet().comments = []); }
function activeComments() { return sheetComments().filter((comment) => !comment.resolved); }
function commentsForRef(ref) { return activeComments().filter((comment) => comment.ref === ref); }
function closeCommentEditor() { if (commentPopover) { commentPopover.remove(); commentPopover = null; } }
document.addEventListener("mousedown", (event) => { if (commentPopover && !commentPopover.contains(event.target)) closeCommentEditor(); });
function openCommentEditor(ref) {
  closeCommentEditor();
  const cell = gridTable.querySelector(`td.cell[data-ref="${ref}"]`);
  if (!cell) return;
  const textarea = el("textarea", { placeholder: `Comment on ${ref}`, "aria-label": `Comment on ${ref}` });
  const cancel = el("button", {}, "Cancel");
  const save = el("button", { class: "primary" }, "Comment");
  const popover = el("div", { class: "comment-popover" }, [textarea, el("div", { class: "comment-popover-actions" }, [cancel, save])]);
  document.body.appendChild(popover); commentPopover = popover;
  const rect = cell.getBoundingClientRect();
  const width = popover.offsetWidth, height = popover.offsetHeight;
  popover.style.left = Math.max(10, Math.min(window.innerWidth - width - 10, rect.right + 6)) + "px";
  popover.style.top = Math.max(10, Math.min(window.innerHeight - height - 10, rect.top)) + "px";
  const done = () => {
    const text = textarea.value.trim();
    if (!text) return;
    sheetComments().push({ id: "comment_" + Math.random().toString(36).slice(2, 10), ref, text, createdAt: Date.now(), resolved: false });
    closeCommentEditor(); sidebarView = "comments"; queueStructure(); renderGrid(); renderChartPanel(); setChartPanelCollapsed(false); refreshToolbarState();
  };
  cancel.addEventListener("click", closeCommentEditor); save.addEventListener("click", done);
  textarea.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); closeCommentEditor(); }
    else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); done(); }
  });
  requestAnimationFrame(() => textarea.focus());
}
function resolveComment(id) {
  const comment = sheetComments().find((item) => item.id === id); if (!comment) return;
  comment.resolved = true; if (!activeComments().length) sidebarView = "home"; queueStructure(); renderGrid(); renderChartPanel(); refreshToolbarState();
}
function deleteComment(id) {
  curSheet().comments = sheetComments().filter((item) => item.id !== id);
  if (!activeComments().length) sidebarView = "home";
  queueStructure(); renderGrid(); renderChartPanel(); refreshToolbarState();
}
function renderCommentsSection() {
  const comments = activeComments();
  if (!comments.length) return null;
  const section = el("section", { class: "comments-section" });
  for (const comment of comments.sort((a, b) => b.createdAt - a.createdAt)) {
    const card = el("article", { class: "comment-card" }, [
      el("div", { class: "comment-card-ref" }, comment.ref),
      el("div", { class: "comment-card-text" }, comment.text),
    ]);
    card.addEventListener("click", () => { const position = parseRef(comment.ref); if (position) moveActive(position.r, position.c); });
    const resolve = el("button", {}, "Resolve");
    const remove = el("button", { class: "danger" }, "Delete");
    resolve.addEventListener("click", (event) => { event.stopPropagation(); resolveComment(comment.id); });
    remove.addEventListener("click", (event) => { event.stopPropagation(); deleteComment(comment.id); });
    card.appendChild(el("div", { class: "comment-card-actions" }, [resolve, remove]));
    section.appendChild(card);
  }
  return section;
}

// ===========================================================================
// Charts
// ===========================================================================
let selectedChartId = null;
let selectedPivotSheetId = null;
let sidebarView = "home"; // home | charts | chart | pivots | pivot | comments
const CHART_COLORS = ["#e1632e", "#3478c7", "#1f9d77", "#8b5fbf", "#c49324", "#c4566a"];
function sheetCharts() { return curSheet().charts || (curSheet().charts = []); }
function selectedChart() { return sheetCharts().find((chart) => chart.id === selectedChartId) || null; }
function parseChartRange(value) {
  const match = /^([A-Z]+[1-9]\d*)(?::([A-Z]+[1-9]\d*))?$/.exec(String(value || "").trim().toUpperCase());
  if (!match) return null;
  const a = parseRef(match[1]), b = parseRef(match[2] || match[1]);
  if (!a || !b) return null;
  return { r1: Math.min(a.r, b.r), c1: Math.min(a.c, b.c), r2: Math.max(a.r, b.r), c2: Math.max(a.c, b.c) };
}
function rangeHasData(range) {
  for (let row = range.r1; row <= range.r2; row++) for (let column = range.c1; column <= range.c2; column++) {
    if (hasCellData(row, column)) return true;
  }
  return false;
}
function defaultChartRange() {
  const range = selRange();
  return rangeHasData(range) ? rcToRef(range.r1, range.c1) + (range.r1 === range.r2 && range.c1 === range.c2 ? "" : ":" + rcToRef(range.r2, range.c2)) : "";
}
function inferChartLayout(rangeText) {
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
const CHART_TYPES = [
  { value: "line", label: "Line chart" },
  { value: "pie", label: "Pie chart" },
  { value: "area", label: "Area chart" },
  { value: "stackedBar", label: "Stacked bar chart" },
];
function chartTypeLabel(type) { return CHART_TYPES.find((item) => item.value === type)?.label || "Chart"; }
function openCreateChartMenu(event) {
  const menu = el("div", { class: "ctx" });
  for (const type of CHART_TYPES) {
    const item = el("div", { class: "ctx-item" }, [el("span", {}, type.label)]);
    item.addEventListener("click", () => { closeCtx(); createChart(type.value); });
    menu.appendChild(item);
  }
  const rect = chartBtn.getBoundingClientRect();
  showCtx(menu, rect.left, rect.bottom + 4);
}
function createChart(type = "line") {
  const range = defaultChartRange();
  const inferred = inferChartLayout(range);
  const chart = {
    id: "chart_" + Math.random().toString(36).slice(2, 9), type, range,
    title: chartTypeLabel(type), xAxisTitle: "", yAxisTitle: "", legend: true,
    firstRowHeaders: inferred.firstRowHeaders, firstColLabels: inferred.firstColLabels,
    x: Math.max(60, gridScroll.scrollLeft + 80), y: Math.max(32, gridScroll.scrollTop + 40), width: 520, height: 320,
  };
  sheetCharts().push(chart);
  selectedChartId = chart.id; sidebarView = "chart";
  queueStructure(); renderCharts(); renderChartPanel(); setChartPanelCollapsed(false);
}
function setChartPanelCollapsed(collapsed) {
  chartPanel.classList.toggle("collapsed", collapsed);
  chartPanelToggle.textContent = collapsed ? "‹" : "×";
  chartPanelToggle.title = collapsed ? "Expand sidebar" : "Close sidebar";
  chartPanelToggle.setAttribute("aria-label", chartPanelToggle.title);
}
function updateSelectedChart(key, value) {
  const chart = selectedChart(); if (!chart) return;
  chart[key] = value; queueStructure(); renderCharts();
}
function chartTextField(label, key, chart, placeholder = "") {
  const input = el("input", { type: "text", value: chart[key] || "", placeholder });
  input.addEventListener("input", () => updateSelectedChart(key, key === "range" ? input.value.toUpperCase() : input.value));
  return el("label", { class: "chart-field" }, [el("span", {}, label), input]);
}
function chartTypeField(chart) {
  const select = el("select", { "aria-label": "Chart type" });
  for (const type of CHART_TYPES) {
    const option = el("option", { value: type.value }, type.label);
    if (type.value === chart.type) option.selected = true;
    select.appendChild(option);
  }
  select.addEventListener("change", () => { updateSelectedChart("type", select.value); renderChartPanel(); });
  return el("label", { class: "chart-field" }, [el("span", {}, "Chart type"), select]);
}
function chartCheckbox(label, key, chart) {
  const input = el("input", { type: "checkbox" }); input.checked = chart[key] !== false;
  input.addEventListener("change", () => updateSelectedChart(key, input.checked));
  return el("label", { class: "chart-check" }, [input, el("span", {}, label)]);
}
function navigateSidebarBack() {
  if (sidebarView === "chart") { sidebarView = sheetCharts().length ? "charts" : "home"; selectedChartId = null; renderCharts(); }
  else if (sidebarView === "pivot") { sidebarView = pivotSheets().length ? "pivots" : "home"; selectedPivotSheetId = null; }
  else sidebarView = "home";
  renderChartPanel();
}
function sidebarMenuItem(label, count, iconName, onClick) {
  const button = el("button", { class: "sidebar-menu-item" }, [
    el("span", { class: "sidebar-menu-icon", html: icon(ICONS[iconName]) }),
    el("span", { class: "sidebar-menu-label" }, label),
    el("span", { class: "sidebar-menu-count" }, String(count)),
    el("span", { class: "sidebar-menu-arrow" }, "›"),
  ]);
  button.addEventListener("click", onClick); return button;
}
function renderSidebarHome() {
  const menu = el("div", { class: "sidebar-menu" });
  const charts = sheetCharts(), comments = activeComments();
  if (charts.length) menu.appendChild(sidebarMenuItem("Charts", charts.length, "chart", () => { sidebarView = "charts"; renderChartPanel(); }));
  const pivots = pivotSheets();
  if (pivots.length) menu.appendChild(sidebarMenuItem("Pivot tables", pivots.length, "pivot", () => { sidebarView = "pivots"; renderChartPanel(); }));
  if (comments.length) menu.appendChild(sidebarMenuItem("Comments", comments.length, "comment", () => { sidebarView = "comments"; renderChartPanel(); }));
  return menu;
}
function renderChartList() {
  const list = el("div", { class: "chart-list" });
  for (const chart of sheetCharts()) {
    const item = el("button", { class: "chart-list-item" }, [el("strong", {}, chart.title || chartTypeLabel(chart.type)), el("span", {}, `${chartTypeLabel(chart.type)} · ${chart.range || "No data range"}`)]);
    item.addEventListener("click", () => { selectedChartId = chart.id; sidebarView = "chart"; renderCharts(); renderChartPanel(); });
    list.appendChild(item);
  }
  return list;
}
function renderPivotList() {
  const list = el("div", { class: "chart-list" });
  for (const sheetId of pivotSheets()) {
    const sheet = model.sheets[sheetId], source = model.sheets[sheet.pivot.sourceSheetId];
    const item = el("button", { class: "chart-list-item" }, [el("strong", {}, sheet.name), el("span", {}, `${source?.name || "Missing source"}!${sheet.pivot.sourceRange || "No range"}`)]);
    item.addEventListener("click", () => { switchSheet(sheetId); selectedPivotSheetId = sheetId; sidebarView = "pivot"; setChartPanelCollapsed(false); renderChartPanel(); });
    list.appendChild(item);
  }
  return list;
}
function renderPivotDetails(sheetId) {
  const sheet = model.sheets[sheetId], pivot = sheet?.pivot; if (!pivot) return null;
  const fields = pivotFields(pivot).map((field) => field.name);
  const content = el("div"); content.style.display = "contents";
  content.appendChild(el("div", { class: "pivot-note" }, `Source sheet: ${model.sheets[pivot.sourceSheetId]?.name || "Missing sheet"}`));
  const rangeInput = el("input", { type: "text", value: pivot.sourceRange, placeholder: "A1:D100" });
  rangeInput.addEventListener("change", () => updatePivot(sheetId, "sourceRange", rangeInput.value.toUpperCase()));
  content.appendChild(el("label", { class: "chart-field" }, [el("span", {}, "Source range"), rangeInput]));
  content.appendChild(pivotSelectField("Rows", pivot.rowField, fields, (value) => updatePivot(sheetId, "rowField", value)));
  content.appendChild(pivotSelectField("Columns", pivot.columnField, fields.filter((field) => field !== pivot.rowField), (value) => updatePivot(sheetId, "columnField", value)));
  content.appendChild(pivotSelectField("Values", pivot.valueField, fields, (value) => updatePivot(sheetId, "valueField", value), false));
  content.appendChild(pivotSelectField("Summarize by", pivot.aggregate, ["sum", "count", "average", "min", "max"], (value) => updatePivot(sheetId, "aggregate", value), false));
  for (const [label, key] of [["Show row totals", "showRowTotals"], ["Show column totals", "showColumnTotals"]]) {
    const input = el("input", { type: "checkbox" }); input.checked = pivot[key] !== false;
    input.addEventListener("change", () => updatePivot(sheetId, key, input.checked));
    content.appendChild(el("label", { class: "chart-check" }, [input, el("span", {}, label)]));
  }
  content.appendChild(pivotSelectField("Filter field", pivot.filterField, fields, (value) => updatePivot(sheetId, "filterField", value)));
  if (pivot.filterField) content.appendChild(pivotFilterMultiSelect(sheetId, pivot));
  content.appendChild(el("div", { class: "pivot-note" }, "Pivot output is generated on this sheet and refreshes when source cells change. Manual edits to the output may be replaced."));
  const refresh = el("button", {}, "Refresh"); refresh.addEventListener("click", () => refreshPivot(sheetId));
  const remove = el("button", { class: "danger" }, "Delete pivot");
  remove.addEventListener("click", () => { selectedPivotSheetId = null; sidebarView = "home"; deleteSheet(sheetId); renderChartPanel(); });
  content.appendChild(el("div", { class: "pivot-actions" }, [refresh, remove]));
  return content;
}
function renderChartPanel() {
  chartPanelContent.replaceChildren();
  chartPanelBack.style.display = sidebarView === "home" ? "none" : "";
  if (sidebarView === "home") {
    chartPanelTitle.textContent = "Details";
    const home = renderSidebarHome(); chartPanelContent.appendChild(home);
    if (!home.children.length) setChartPanelCollapsed(true);
    return;
  }
  if (sidebarView === "comments") {
    chartPanelTitle.textContent = `Comments (${activeComments().length})`;
    const comments = renderCommentsSection();
    if (comments) chartPanelContent.appendChild(comments); else { sidebarView = "home"; renderChartPanel(); }
    return;
  }
  if (sidebarView === "charts") {
    chartPanelTitle.textContent = "Charts";
    if (sheetCharts().length) chartPanelContent.appendChild(renderChartList()); else { sidebarView = "home"; renderChartPanel(); }
    return;
  }
  if (sidebarView === "pivots") {
    chartPanelTitle.textContent = "Pivot tables";
    if (pivotSheets().length) chartPanelContent.appendChild(renderPivotList()); else { sidebarView = "home"; renderChartPanel(); }
    return;
  }
  if (sidebarView === "pivot") {
    const details = renderPivotDetails(selectedPivotSheetId);
    if (details) { chartPanelTitle.textContent = model.sheets[selectedPivotSheetId].name; chartPanelContent.appendChild(details); }
    else { sidebarView = "home"; renderChartPanel(); }
    return;
  }
  const chart = selectedChart();
  if (!chart) { sidebarView = "home"; renderChartPanel(); return; }
  chartPanelTitle.textContent = chartTypeLabel(chart.type);
  chartPanelContent.append(
    chartTypeField(chart),
    chartTextField("Data range", "range", chart, "A1:C10"),
    chartTextField("Chart title", "title", chart)
  );
  if (chart.type !== "pie") chartPanelContent.append(
    chartTextField("Horizontal axis title", "xAxisTitle", chart),
    chartTextField("Vertical axis title", "yAxisTitle", chart)
  );
  chartPanelContent.append(
    chartCheckbox("Use first row as headers", "firstRowHeaders", chart),
    chartCheckbox("Use first column as labels", "firstColLabels", chart),
    chartCheckbox("Show legend", "legend", chart)
  );
  const copy = el("button", { class: "chart-copy", title: "Rich SVG copy; use PNG export for Google Slides" }, "Copy SVG");
  copy.addEventListener("click", () => copyChartImage(chart));
  const remove = el("button", { class: "chart-delete" }, "Delete chart");
  remove.addEventListener("click", () => {
    curSheet().charts = sheetCharts().filter((item) => item.id !== chart.id);
    selectedChartId = null; sidebarView = sheetCharts().length ? "charts" : "home"; queueStructure(); renderCharts(); renderChartPanel();
  });
  chartPanelContent.appendChild(el("div", { class: "chart-panel-actions" }, [copy, remove]));
  chartPanelContent.appendChild(el("p", { class: "chart-copy-note" }, "SVG can’t currently be pasted into a Gadget workspace or Google Slides due to security restrictions."));
}
function chartCellLabel(row, column) {
  const cell = getCell(rcToRef(row, column));
  if (!cell) return "";
  return displayValue(engine.computeRef(activeSheetId, rcToRef(row, column)), cell.fmt).text;
}
function chartData(chart) {
  const range = parseChartRange(chart.range);
  if (!range || !rangeHasData(range)) return null;
  const dataRow = range.r1 + (chart.firstRowHeaders && range.r2 > range.r1 ? 1 : 0);
  let seriesColumn = range.c1 + (chart.firstColLabels && range.c2 > range.c1 ? 1 : 0);
  if (seriesColumn > range.c2 || dataRow > range.r2) return null;
  const labels = [];
  for (let row = dataRow; row <= range.r2; row++) labels.push(chart.firstColLabels ? chartCellLabel(row, range.c1) : String(row - dataRow + 1));
  const series = [];
  for (let column = seriesColumn; column <= range.c2; column++) {
    const values = [];
    for (let row = dataRow; row <= range.r2; row++) {
      const value = engine.computeRef(activeSheetId, rcToRef(row, column));
      values.push(typeof value === "number" && Number.isFinite(value) ? value : null);
    }
    if (values.some((value) => value != null)) series.push({
      name: chart.firstRowHeaders ? (chartCellLabel(range.r1, column) || colToLetter(column)) : colToLetter(column), values,
    });
  }
  return series.length ? { labels, series } : null;
}
function svgNode(tag, attrs = {}, text = null) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  if (text != null) node.textContent = text;
  return node;
}
function renderLineChartSvg(chart, data) {
  const svg = svgNode("svg", { viewBox: "0 0 520 270", role: "img", "aria-label": chart.title || "Line chart" });
  const left = 54, top = 18, right = chart.legend ? 118 : 24, bottom = 48;
  const width = 520 - left - right, height = 270 - top - bottom;
  const all = data.series.flatMap((series) => series.values.filter((value) => value != null));
  let min = Math.min(...all), max = Math.max(...all);
  if (chart.type === "area") { min = Math.min(0, min); max = Math.max(0, max); }
  if (min === max) { min -= Math.abs(min || 1) * .5; max += Math.abs(max || 1) * .5; }
  const y = (value) => top + height - (value - min) / (max - min) * height;
  const x = (index) => left + (data.labels.length <= 1 ? width / 2 : index / (data.labels.length - 1) * width);
  for (let tick = 0; tick <= 4; tick++) {
    const yy = top + height * tick / 4;
    svg.appendChild(svgNode("line", { x1: left, y1: yy, x2: left + width, y2: yy, stroke: "#e4e4e1", "stroke-width": 1 }));
    const value = max - (max - min) * tick / 4;
    svg.appendChild(svgNode("text", { x: left - 7, y: yy + 4, "text-anchor": "end", fill: "#77777f", "font-size": 10 }, fmtGeneral(value)));
  }
  svg.appendChild(svgNode("line", { x1: left, y1: top, x2: left, y2: top + height, stroke: "#9a9aa2" }));
  svg.appendChild(svgNode("line", { x1: left, y1: top + height, x2: left + width, y2: top + height, stroke: "#9a9aa2" }));
  const labelStep = Math.max(1, Math.ceil(data.labels.length / 7));
  data.labels.forEach((label, index) => { if (index % labelStep === 0 || index === data.labels.length - 1) svg.appendChild(svgNode("text", { x: x(index), y: top + height + 17, "text-anchor": "middle", fill: "#77777f", "font-size": 10 }, String(label).slice(0, 16))); });
  data.series.forEach((series, seriesIndex) => {
    const color = CHART_COLORS[seriesIndex % CHART_COLORS.length];
    const segments = []; let segment = [];
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
    series.values.forEach((value, index) => { if (value != null) svg.appendChild(svgNode("circle", { cx: x(index), cy: y(value), r: 2.5, fill: color })); });
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
function renderPieChartSvg(chart, data) {
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
function renderStackedBarChartSvg(chart, data) {
  const svg = svgNode("svg", { viewBox: "0 0 520 270", role: "img", "aria-label": chart.title || "Stacked bar chart" });
  const left = 78, top = 18, right = chart.legend ? 112 : 24, bottom = 42;
  const width = 520 - left - right, height = 270 - top - bottom;
  const totals = data.labels.map((_, index) => data.series.reduce((sum, series) => sum + Math.max(0, series.values[index] || 0), 0));
  const max = Math.max(...totals, 1);
  const rowHeight = height / Math.max(1, data.labels.length);
  for (let tick = 0; tick <= 4; tick++) {
    const xx = left + width * tick / 4;
    svg.appendChild(svgNode("line", { x1: xx, y1: top, x2: xx, y2: top + height, stroke: "#e4e4e1" }));
    svg.appendChild(svgNode("text", { x: xx, y: top + height + 15, "text-anchor": "middle", fill: "#77777f", "font-size": 10 }, fmtGeneral(max * tick / 4)));
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
function renderChartSvg(chart, data) {
  if (chart.type === "pie") return renderPieChartSvg(chart, data);
  if (chart.type === "stackedBar") return renderStackedBarChartSvg(chart, data);
  return renderLineChartSvg(chart, data);
}
function selectChart(chart, card = null) {
  selectedChartId = chart.id; sidebarView = "chart";
  chartLayer.querySelectorAll(".chart-card.selected").forEach((element) => element.classList.remove("selected"));
  if (card) card.classList.add("selected");
  setChartPanelCollapsed(false); renderChartPanel();
}
function startChartDrag(chart, card, event) {
  if (event.button !== 0 || event.target.closest("button")) return;
  event.preventDefault(); event.stopPropagation();
  selectChart(chart, card);
  const startClientX = event.clientX, startClientY = event.clientY;
  const startX = chart.x ?? 96, startY = chart.y ?? 44;
  let nextX = startX, nextY = startY;
  const move = (moveEvent) => {
    nextX = Math.max(0, Math.round(startX + moveEvent.clientX - startClientX));
    nextY = Math.max(0, Math.round(startY + moveEvent.clientY - startClientY));
    card.style.left = nextX + "px"; card.style.top = nextY + "px";
  };
  const up = () => {
    window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", up);
    if (nextX !== startX || nextY !== startY) { chart.x = nextX; chart.y = nextY; queueStructure(); renderCharts(); }
  };
  window.addEventListener("pointermove", move); window.addEventListener("pointerup", up); window.addEventListener("pointercancel", up);
}
function chartClipboardSvg(chart) {
  const data = chartData(chart);
  if (!data) return null;
  const output = svgNode("svg", { xmlns: "http://www.w3.org/2000/svg", width: 560, height: 330, viewBox: "0 0 560 330" });
  output.appendChild(svgNode("rect", { x: 0, y: 0, width: 560, height: 330, fill: "#ffffff" }));
  output.appendChild(svgNode("text", { x: 20, y: 28, fill: "#1d1d20", "font-size": 18, "font-weight": 650, "font-family": "Arial, sans-serif" }, chart.title || "Line chart"));
  const group = svgNode("g", { transform: "translate(20 45)", "font-family": "Arial, sans-serif" });
  const graph = renderChartSvg(chart, data);
  for (const child of [...graph.childNodes]) group.appendChild(child.cloneNode(true));
  output.appendChild(group);
  return output;
}
function copyChartSvgSelection(svgMarkup) {
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
  catch (error) { console.error("Chart rich-copy failed:", error?.name || "Error", error?.message || String(error)); }
  selection.removeAllRanges(); if (saved) selection.addRange(saved);
  host.remove(); armEditorCapture(true);
  return copied;
}
function copyChartImage(chart) {
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
    const card = el("div", { class: "chart-card" + (chart.id === selectedChartId ? " selected" : ""), "data-chart-id": chart.id });
    card.style.cssText += `left:${chart.x ?? 96}px;top:${chart.y ?? 44}px;width:${chart.width ?? 520}px;height:${chart.height ?? 320}px`;
    const copyButton = el("button", { class: "chart-card-copy", title: "Copy rich SVG; use PNG export for Google Slides", "aria-label": "Copy chart as SVG" }, "Copy SVG");
    copyButton.addEventListener("pointerdown", (event) => event.stopPropagation());
    copyButton.addEventListener("click", (event) => { event.stopPropagation(); selectChart(chart, card); copyChartImage(chart); });
    const head = el("div", { class: "chart-card-head", title: "Drag to move chart" }, [
      el("strong", {}, chart.title || "Line chart"), el("span", { class: "chart-card-range" }, chart.range || "No data range"), copyButton,
    ]);
    head.addEventListener("pointerdown", (event) => startChartDrag(chart, card, event));
    const body = el("div", { class: "chart-card-body" });
    const data = chartData(chart);
    if (data) body.appendChild(renderChartSvg(chart, data));
    else body.appendChild(el("div", { class: "chart-empty" }, "Select the chart and enter a data range in Chart settings."));
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
function filterToken(value) {
  if (isErr(value)) return "e:" + value.value;
  if (value == null || value === "") return "z:";
  if (typeof value === "number") return "n:" + String(value);
  if (typeof value === "boolean") return "b:" + (value ? "1" : "0");
  return "s:" + String(value);
}
function filterTokenLabel(token) {
  if (token === "z:") return "(Blanks)";
  if (token.startsWith("b:")) return token === "b:1" ? "TRUE" : "FALSE";
  return token.slice(2);
}
function filterColumns(filter) {
  return filter?.columns?.length ? filter.columns : Array.from({ length: curSheet().cols }, (_, column) => column);
}
function rowPassesFilter(row, sheetId = activeSheetId) {
  const sheet = model.sheets[sheetId], filter = sheet?.filter;
  if (!filter || row <= filter.row || row > (filter.endRow ?? sheet.rows - 1)) return true;
  for (const [column, selected] of Object.entries(filter.criteria || {})) {
    if (!selected?.length) continue;
    const token = filterToken(engine.computeRef(sheetId, rcToRef(row, Number(column))));
    if (!selected.includes(token)) return false;
  }
  return true;
}
function hasCellData(row, column) {
  const value = cellRaw(rcToRef(row, column));
  return value != null && value !== "";
}
function detectFilterRange() {
  const sheet = curSheet();
  const selection = selRange();
  const explicit = selection.r2 > selection.r1;
  if (explicit) {
    // Every selected column belongs to the record, even one still blank, so a later sort moves
    // whole rows.
    const columns = Array.from({ length: selection.c2 - selection.c1 + 1 }, (_, index) => selection.c1 + index);
    return { row: selection.r1, endRow: selection.r2, columns, criteria: {}, rowOrder: Array.from({ length: selection.r2 - selection.r1 }, (_, index) => selection.r1 + 1 + index), sort: null };
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
    const rowHasData = (row) => {
      for (let column = minColumn; column <= maxColumn; column++) if (hasCellData(row, column)) return true;
      return false;
    };
    let tableTop = focus.r, tableBottom = focus.r;
    while (tableTop > minRow && rowHasData(tableTop - 1)) tableTop--;
    while (tableBottom < maxRow && rowHasData(tableBottom + 1)) tableBottom++;
    const columnHasData = (column) => {
      for (let row = tableTop; row <= tableBottom; row++) if (hasCellData(row, column)) return true;
      return false;
    };
    let tableLeft = focus.c, tableRight = focus.c;
    while (tableLeft > minColumn && columnHasData(tableLeft - 1)) tableLeft--;
    while (tableRight < maxColumn && columnHasData(tableRight + 1)) tableRight++;
    minRow = tableTop; maxRow = tableBottom; minColumn = tableLeft; maxColumn = tableRight;
  }

  let best = null;
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
  const columns = [];
  for (let column = minColumn; column <= maxColumn; column++) {
    let populated = false;
    for (let row = best.row; row <= maxRow; row++) if (hasCellData(row, column)) { populated = true; break; }
    if (populated) columns.push(column);
  }
  return columns.length ? { row: best.row, endRow: maxRow, columns, criteria: {}, rowOrder: Array.from({ length: maxRow - best.row }, (_, index) => best.row + 1 + index), sort: null } : null;
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
    if (!detected) return;
    sheet.filter = detected;
  }
  queueStructure();
  renderGrid();
  refreshToolbarState();
}
function reorderFilteredRows(compare, nextSort) {
  const filter = curSheet()?.filter;
  if (!filter) return;
  const columns = filterColumns(filter);
  const rows = [];
  const endRow = filter.endRow ?? curSheet().rows - 1;
  const baseline = filter.rowOrder?.length === endRow - filter.row
    ? filter.rowOrder
    : Array.from({ length: endRow - filter.row }, (_, index) => filter.row + 1 + index);
  for (let row = filter.row + 1; row <= endRow; row++) {
    const rowCells = {};
    for (const col of columns) {
      const cell = getCell(rcToRef(row, col));
      if (cell) rowCells[col] = { ...cell };
    }
    const rowComments = sheetComments().filter((comment) => { const position = parseRef(comment.ref); return position?.r === row && columns.includes(position.c); });
    rows.push({ rowCells, rowComments, originalOrder: baseline[row - filter.row - 1], currentRow: row });
  }
  rows.sort(compare);
  curSheet().comments = sheetComments().filter((comment) => { const position = parseRef(comment.ref); return !position || position.r <= filter.row || position.r > endRow || !columns.includes(position.c); });
  for (let index = 0; index < rows.length; index++) {
    const row = filter.row + 1 + index;
    for (const col of columns) {
      const ref = rcToRef(row, col), source = rows[index].rowCells[col];
      // Rows move as in Excel's sort: relative references travel with the formula.
      if (source) curCells()[ref] = { value: shiftedCopyFormula(source.value, rcToRef(rows[index].currentRow, col), ref, false), fmt: source.fmt, version: getCell(ref)?.version || 0 };
      else delete curCells()[ref];
    }
    for (const comment of rows[index].rowComments) {
      const position = parseRef(comment.ref); if (position) curSheet().comments.push({ ...comment, ref: rcToRef(row, position.c) });
    }
  }
  filter.rowOrder = rows.map((entry) => entry.originalOrder);
  filter.sort = nextSort;
  queueStructure(); queueReplacement(activeSheetId); rebuildEngine(); renderGrid();
  undoStack.length = 0; redoStack.length = 0; updateUndoButtons();
  schedulePivotRefreshes(activeSheetId);
}
function sortFilteredRange(column, ascending) {
  const values = new Map();
  const filter = curSheet()?.filter;
  if (!filter) return;
  for (let row = filter.row + 1; row <= (filter.endRow ?? curSheet().rows - 1); row++) values.set(row, engine.computeRef(activeSheetId, rcToRef(row, column)));
  reorderFilteredRows((left, right) => {
    const a = values.get(left.currentRow) ?? "", b = values.get(right.currentRow) ?? "";
    // Blank rows (the unused tail of the filter range) stay after populated rows in both directions.
    if (a === "" || b === "") return a === b ? 0 : a === "" ? 1 : -1;
    const comparison = typeof a === "number" && typeof b === "number"
      ? a - b
      : String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
    return ascending ? comparison : -comparison;
  }, { column, direction: ascending ? "asc" : "desc" });
}
function clearFilteredSort() {
  reorderFilteredRows((left, right) => left.originalOrder - right.originalOrder, null);
}
function openFilterMenu(column, trigger) {
  const filter = curSheet()?.filter;
  if (!filter) return;
  const options = new Map();
  for (let row = filter.row + 1; row <= (filter.endRow ?? curSheet().rows - 1); row++) {
    const token = filterToken(engine.computeRef(activeSheetId, rcToRef(row, column)));
    if (!options.has(token)) options.set(token, filterTokenLabel(token));
  }
  const sorted = [...options.entries()].sort((a, b) => a[1].localeCompare(b[1], undefined, { numeric: true, sensitivity: "base" }));
  const current = filter.criteria?.[column] || [];
  const allSelected = !current.length;
  const menu = el("div", { class: "ctx filter-menu" });
  menu.appendChild(el("div", { class: "filter-menu-title" }, `Filter ${colToLetter(column)}`));
  const sortUp = el("button", {}, "Sort A → Z");
  const sortDown = el("button", {}, "Sort Z → A");
  const clearSort = el("button", { title: "Restore the order from when the filter was created" }, "Clear sort");
  clearSort.disabled = !filter.sort;
  sortUp.addEventListener("click", () => { closeCtx(); sortFilteredRange(column, true); });
  sortDown.addEventListener("click", () => { closeCtx(); sortFilteredRange(column, false); });
  clearSort.addEventListener("click", () => { if (curSheet()?.filter?.sort) { closeCtx(); clearFilteredSort(); } });
  menu.appendChild(el("div", { class: "filter-sort" }, [sortUp, sortDown, clearSort]));
  const list = el("div", { class: "filter-options" });
  const checks = [];
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
  menu.appendChild(el("div", { class: "filter-links" }, [selectAll, selectNone]));
  const search = el("input", { class: "filter-search", type: "search", placeholder: "Search values…", "aria-label": "Search filter values" });
  search.addEventListener("input", () => {
    const query = search.value.trim().toLowerCase();
    for (const entry of checks) entry.option.style.display = !query || entry.label.toLowerCase().includes(query) ? "" : "none";
  });
  menu.appendChild(search);
  menu.appendChild(list);
  const clear = el("button", {}, "Clear filter");
  const apply = el("button", { class: "primary" }, "Apply");
  // Remote structure updates replace the sheet's metadata object, so the filter is resolved when
  // the button is clicked rather than when the menu opened.
  const liveFilter = () => curSheet()?.filter;
  clear.addEventListener("click", () => {
    const current = liveFilter(); closeCtx();
    if (!current) return;
    delete current.criteria[column];
    queueStructure(); renderGrid(); refreshToolbarState();
  });
  apply.addEventListener("click", () => {
    const current = liveFilter(); closeCtx();
    if (!current) return;
    const selected = checks.filter((entry) => entry.checkbox.checked).map((entry) => entry.token);
    if (selected.length === checks.length) delete current.criteria[column];
    else current.criteria[column] = selected.length ? selected : ["x:__none__"];
    queueStructure(); renderGrid(); refreshToolbarState();
  });
  menu.appendChild(el("div", { class: "filter-actions" }, [clear, apply]));
  const rect = trigger.getBoundingClientRect();
  showCtx(menu, rect.left, rect.bottom + 4);
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
  const ranges = selectionRanges();
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
    const columnRanges = ranges.filter((range) => c >= range.c1 && c <= range.c2);
    if (columnRanges.length) th.classList.add(columnRanges.some((range) => range.r1 === 0 && range.r2 === sh.rows - 1) ? "full" : "hl");
    const rz = el("div", { class: "col-resize", "data-col": c });
    th.appendChild(rz);
    hr.appendChild(th);
  }
  thead.appendChild(hr);
  frag.appendChild(thead);

  // Body
  const tbody = el("tbody");
  for (let r = 0; r < sh.rows; r++) {
    const isFilterRow = sh.filter?.row === r;
    const tr = el("tr", { class: isFilterRow ? "filter-row" : "", style: `height:${rowHeight(r)}px${rowPassesFilter(r) ? "" : ";display:none"}` });
    const rh = el("th", { class: "rowhead", "data-row": r, title: isFilterRow ? "Filter header row" : "" }, String(r + 1));
    const rowRanges = ranges.filter((range) => r >= range.r1 && r <= range.r2);
    if (rowRanges.length) rh.classList.add(rowRanges.some((range) => range.c1 === 0 && range.c2 === sh.cols - 1) ? "full" : "hl");
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
  renderCharts();
  if (formulaPick) renderFormulaPickHighlight();
  if (!editing && cellEditor.classList.contains("capture")) armEditorCapture(false);
}

function isVisuallyEmptyCell(row, column) {
  const cell = getCell(rcToRef(row, column));
  if (!cell || cell.value == null || cell.value === "") return true;
  const value = engine.computeRef(activeSheetId, rcToRef(row, column));
  return displayValue(value, cell.fmt).text === "";
}
function availableOverflowWidth(row, column) {
  let width = colWidth(column);
  for (let next = column + 1; next < curSheet().cols; next++) {
    if (!isVisuallyEmptyCell(row, next)) break;
    width += colWidth(next);
  }
  return width;
}

function diagnoseFormulaError(formula, errorValue) {
  let ast = null; try { ast = parseFormula(formula.slice(1)); } catch (error) {
    return { message: "The formula syntax could not be parsed. Check separators, quotes, and parentheses.", segment: null };
  }
  let diagnosis = null;
  const inspect = (node, parent = null, argumentIndex = -1) => {
    if (!node || diagnosis) return;
    if (node.k === "call") {
      if (!FUNCTIONS[node.name]) diagnosis = { message: `Unknown function ${node.name}.`, segment: node.name };
      if (!diagnosis && ["VLOOKUP", "HLOOKUP"].includes(node.name) && node.args[3]?.k === "ref" && !parseRef(node.args[3].ref)) {
        diagnosis = { message: `${node.name}’s fourth argument should usually be TRUE, FALSE, 1, or 0—not unquoted text.`, segment: node.args[3].ref };
      }
      if (!diagnosis && ["VLOOKUP", "HLOOKUP"].includes(node.name) && node.args[2]?.k === "num" && node.args[1]?.k === "range") {
        const first = parseRef(node.args[1].a.split("!").pop()), last = parseRef(node.args[1].b.split("!").pop());
        const size = first && last ? (node.name === "VLOOKUP" ? Math.abs(last.c - first.c) + 1 : Math.abs(last.r - first.r) + 1) : null;
        if (size && (node.args[2].v < 1 || node.args[2].v > size)) diagnosis = { message: `${node.name} requests index ${node.args[2].v}, but the lookup range only contains ${size}.`, segment: String(node.args[2].v) };
      }
      node.args.forEach((argument, index) => inspect(argument, node, index));
    } else if (node.k === "ref") {
      const refText = node.ref, cellPart = refText.split("!").pop();
      if (!parseRef(cellPart)) diagnosis = { message: `“${refText}” looks like text or an invalid cell reference. Put text in quotes, or choose a valid cell.`, segment: refText };
      else if (refText.includes("!")) {
        const sheetName = refText.slice(0, refText.indexOf("!")).replace(/^'|'$/g, "");
        if (!model.sheetOrder.some((id) => model.sheets[id].name.toLowerCase() === sheetName.toLowerCase())) diagnosis = { message: `The referenced sheet “${sheetName}” does not exist.`, segment: refText.slice(0, refText.indexOf("!")) };
      }
    } else if (node.k === "range") {
      inspect({ k: "ref", ref: node.a }, node); inspect({ k: "ref", ref: node.b }, node);
    } else { if (node.a) inspect(node.a, node); if (node.b) inspect(node.b, node); }
  };
  inspect(ast);
  if (diagnosis) return diagnosis;
  const messages = {
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
function formulaErrorTooltip(formula, errorValue) {
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

function renderCell(ref, r, c, rng) {
  const cell = getCell(ref);
  const td = el("td", { class: "cell", "data-ref": ref, "data-r": r, "data-c": c });
  const fmt = cell?.fmt;
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
      openedOnMouseDown = true; openExternalLink(disp.link);
    });
    cv.addEventListener("click", (event) => {
      event.preventDefault(); event.stopPropagation();
      if ((event.ctrlKey || event.metaKey) && !openedOnMouseDown) openExternalLink(disp.link);
      openedOnMouseDown = false;
    });
  }
  td.appendChild(cv);
  if (curSheet()?.filter?.row === r && filterColumns(curSheet().filter).includes(c)) {
    td.classList.add("filter-cell");
    const active = !!curSheet().filter.criteria?.[c]?.length;
    const trigger = el("button", { class: "filter-trigger" + (active ? " active" : ""), title: active ? "Change filter" : "Filter this column", "aria-label": `Filter column ${colToLetter(c)}`, html: icon(ICONS.filter) });
    td.appendChild(trigger);
  }
  const cellComments = commentsForRef(ref);
  if (cellComments.length) {
    td.classList.add("has-comment");
    const marker = el("span", { class: "comment-marker", title: `${cellComments.length} comment${cellComments.length === 1 ? "" : "s"}` });
    const tooltip = el("div", { class: "cell-comment-tooltip" });
    cellComments.forEach((comment, index) => {
      if (index) tooltip.appendChild(el("div", { class: "ctx-sep" }));
      tooltip.appendChild(el("div", {}, comment.text));
    });
    td.append(marker, tooltip);
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
  // Like conventional spreadsheets, left-aligned text may flow across empty
  // cells, but is clipped immediately before the next populated cell.
  if (disp.text && !disp.numeric && !disp.err && !disp.center && !fmt?.wrap && (!fmt?.a || fmt.a === "l") && curSheet()?.filter?.row !== r) {
    const overflowWidth = availableOverflowWidth(r, c);
    if (overflowWidth > colWidth(c)) {
      td.classList.add("text-overflow");
      cv.style.width = Math.max(0, overflowWidth - 8) + "px";
    }
  }
  // selection classes
  if (cellInSelection(r, c)) {
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
    if (!rowPassesFilter(r, sheetId)) continue; // rows the filter hides in the grid stay hidden in print
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
function positionActiveOverlays() {
  if (editing || extraRanges.length) { fillHandle.style.display = "none"; return; }
  const range = selRange(), target = cellEl(range.r2, range.c2);
  if (!target || target.offsetParent === null) { fillHandle.style.display = "none"; return; }
  fillHandle.style.left = (target.offsetLeft + target.offsetWidth - 5) + "px";
  fillHandle.style.top = (target.offsetTop + target.offsetHeight - 5) + "px";
  fillHandle.style.display = "block";
}
let fillDrag = null;
function modulo(value, divisor) { return ((value % divisor) + divisor) % divisor; }
function clearFillPreview() { gridTable.querySelectorAll("td.fill-preview").forEach((cell) => cell.classList.remove("fill-preview")); }
function updateFillPreview(row, column) {
  if (!fillDrag) return;
  const source = fillDrag.source;
  const rowDistance = row < source.r1 ? source.r1 - row : row > source.r2 ? row - source.r2 : 0;
  const columnDistance = column < source.c1 ? source.c1 - column : column > source.c2 ? column - source.c2 : 0;
  if (!rowDistance && !columnDistance) fillDrag.target = { ...source };
  else if (rowDistance >= columnDistance) fillDrag.target = { r1: Math.min(row, source.r1), c1: source.c1, r2: Math.max(row, source.r2), c2: source.c2 };
  else fillDrag.target = { r1: source.r1, c1: Math.min(column, source.c1), r2: source.r2, c2: Math.max(column, source.c2) };
  clearFillPreview();
  for (let r = fillDrag.target.r1; r <= fillDrag.target.r2; r++) for (let c = fillDrag.target.c1; c <= fillDrag.target.c2; c++) {
    if (r < source.r1 || r > source.r2 || c < source.c1 || c > source.c2) cellEl(r, c)?.classList.add("fill-preview");
  }
}
function applyFillDrag() {
  if (!fillDrag) return;
  const { source, target, snapshots, sheetId } = fillDrag;
  fillDrag = null; clearFillPreview();
  if (target.r1 === source.r1 && target.r2 === source.r2 && target.c1 === source.c1 && target.c2 === source.c2) { positionActiveOverlays(); return; }
  const sourceRows = source.r2 - source.r1 + 1, sourceColumns = source.c2 - source.c1 + 1;
  beginBatch();
  for (let row = target.r1; row <= target.r2; row++) for (let column = target.c1; column <= target.c2; column++) {
    if (row >= source.r1 && row <= source.r2 && column >= source.c1 && column <= source.c2) continue;
    const sourceRow = source.r1 + modulo(row - source.r1, sourceRows);
    const sourceColumn = source.c1 + modulo(column - source.c1, sourceColumns);
    const sourceRef = rcToRef(sourceRow, sourceColumn), destinationRef = rcToRef(row, column);
    const snapshot = snapshots[sourceRef], existing = (model.cells[sheetId] || {})[destinationRef];
    recordCell(sheetId, destinationRef);
    if (snapshot) {
      const value = shiftedCopyFormula(snapshot.value, sourceRef, destinationRef, false);
      model.cells[sheetId][destinationRef] = { value, fmt: snapshot.fmt ? { ...snapshot.fmt } : null, version: existing?.version || 0 };
      queueCellOp(sheetId, destinationRef, value, snapshot.fmt || null);
    } else clearStoredCell(sheetId, destinationRef);
  }
  commitBatch(); rebuildEngine(); setSelection({ r: target.r1, c: target.c1 }, { r: target.r2, c: target.c2 }); renderGrid(); schedulePivotRefreshes(sheetId);
}
fillHandle.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || editing) return;
  event.preventDefault(); event.stopPropagation();
  const source = selRange(), snapshots = {};
  for (let row = source.r1; row <= source.r2; row++) for (let column = source.c1; column <= source.c2; column++) {
    const ref = rcToRef(row, column), cell = getCell(ref); snapshots[ref] = cell ? { value: cell.value, fmt: cell.fmt ? { ...cell.fmt } : null } : null;
  }
  fillDrag = { source: { ...source }, target: { ...source }, snapshots, sheetId: activeSheetId };
  fillHandle.setPointerCapture?.(event.pointerId);
});
fillHandle.addEventListener("pointermove", (event) => {
  if (!fillDrag) return;
  const target = document.elementFromPoint(event.clientX, event.clientY)?.closest?.("td.cell");
  if (target) updateFillPreview(+target.dataset.r, +target.dataset.c);
});
fillHandle.addEventListener("pointerup", (event) => { if (fillDrag) applyFillDrag(); fillHandle.releasePointerCapture?.(event.pointerId); });
fillHandle.addEventListener("pointercancel", () => { fillDrag = null; clearFillPreview(); positionActiveOverlays(); });

// ===========================================================================
// Selection & navigation
// ===========================================================================
function clampRC(r, c) {
  const sh = curSheet();
  return { r: Math.max(0, Math.min(sh.rows - 1, r)), c: Math.max(0, Math.min(sh.cols - 1, c)) };
}
function moveActive(r, c, extend = false, preserveExtra = false) {
  const p = clampRC(r, c);
  focus = { r: p.r, c: p.c };
  if (!extend) { anchor = { r: p.r, c: p.c }; if (!preserveExtra) extraRanges = []; }
  updateSelectionUI();
  scrollActiveIntoView();
  armEditorCapture(false);
  sendPresence();
}
function setSelection(a, f, preserveExtra = false) { if (!preserveExtra) extraRanges = []; anchor = { ...a }; focus = { ...f }; updateSelectionUI(); sendPresence(); }

function updateSelectionUI() {
  const rng = selRange();
  // Update cell classes without full re-render for speed.
  const prevSel = gridTable.querySelectorAll("td.cell.sel, td.cell.active");
  prevSel.forEach((td) => td.classList.remove("sel", "active"));
  const prevHl = gridTable.querySelectorAll("th.hl, th.full");
  prevHl.forEach((th) => th.classList.remove("hl", "full"));
  const sh = curSheet();
  for (const range of selectionRanges()) for (let r = range.r1; r <= range.r2; r++) for (let c = range.c1; c <= range.c2; c++) {
    const td = cellEl(r, c);
    if (!td) continue;
    if (r === focus.r && c === focus.c) td.classList.add("active");
    else td.classList.add("sel");
  }
  // headers
  gridTable.querySelectorAll("th.colhead").forEach((th) => {
    const c = +th.dataset.col;
    const matches = selectionRanges().filter((range) => c >= range.c1 && c <= range.c2);
    if (matches.length) th.classList.add(matches.some((range) => range.r1 === 0 && range.r2 === sh.rows - 1) ? "full" : "hl");
  });
  gridTable.querySelectorAll("th.rowhead").forEach((th) => {
    const r = +th.dataset.row;
    const matches = selectionRanges().filter((range) => r >= range.r1 && r <= range.r2);
    if (matches.length) th.classList.add(matches.some((range) => range.c1 === 0 && range.c2 === sh.cols - 1) ? "full" : "hl");
  });
  // name box + formula bar
  nameBox.value = extraRanges.length ? `${selectionRanges().length} ranges` : (rng.r1 === rng.r2 && rng.c1 === rng.c2 ? rcToRef(focus.r, focus.c)
    : rcToRef(rng.r1, rng.c1) + ":" + rcToRef(rng.r2, rng.c2));
  const active = getCell(rcToRef(focus.r, focus.c));
  formulaInput.value = active ? active.value : "";
  refreshToolbarState(); positionActiveOverlays();
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
  filterBtn.classList.toggle("active", !!curSheet()?.filter);
  const commentCount = curSheet() ? commentsForRef(rcToRef(focus.r, focus.c)).length : 0;
  commentBtn.classList.toggle("active", commentCount > 0);
  commentBtn.title = commentCount ? `${commentCount} active comment${commentCount === 1 ? "" : "s"} on this cell — add another` : "Add a comment to the active cell";
  alignBtns.l.classList.toggle("active", !f.a || f.a === "l");
  alignBtns.c.classList.toggle("active", f.a === "c");
  alignBtns.r.classList.toggle("active", f.a === "r");
  fmtSel.setValue(f.nf || "auto");
}

// ===========================================================================
// Cell editing + formula guidance
// ===========================================================================
let formulaAssistItems = [], formulaAssistIndex = 0, formulaAssistReplaceStart = 0;
function closeFormulaAssist() { formulaAssist.style.display = "none"; formulaAssist.replaceChildren(); formulaAssistItems = []; }
function positionFormulaAssist() {
  const rect = cellEditor.getBoundingClientRect();
  formulaAssist.style.left = Math.max(8, Math.min(window.innerWidth - formulaAssist.offsetWidth - 8, rect.left)) + "px";
  formulaAssist.style.top = Math.max(8, Math.min(window.innerHeight - formulaAssist.offsetHeight - 8, rect.bottom + 4)) + "px";
}
function activeFormulaCall(text, cursor) {
  const stack = []; let quote = null;
  for (let index = 1; index < cursor; index++) {
    const char = text[index];
    if (quote) {
      if (char === "\\" && text[index + 1] === quote) { index++; continue; }
      if (char === quote) { if (text[index + 1] === quote) { index++; continue; } quote = null; }
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === "(") {
      const match = /([A-Za-z][A-Za-z0-9_.]*)\s*$/.exec(text.slice(0, index));
      stack.push({ name: match ? match[1].toUpperCase() : "", argument: 0 });
    } else if (char === "," && stack.length) stack[stack.length - 1].argument++;
    else if (char === ")" && stack.length) stack.pop();
  }
  return stack.length ? stack[stack.length - 1] : null;
}
function formulaCursorInQuote(value, cursor) {
  let quote = null;
  for (let index = 1; index < cursor; index++) {
    const char = value[index];
    if (quote) {
      if (char === "\\" && value[index + 1] === quote) { index++; continue; }
      if (char === quote) { if (value[index + 1] === quote) { index++; continue; } quote = null; }
    } else if (char === '"' || char === "'") quote = char;
  }
  return !!quote;
}
// Arrow keys pick grid references only in "point mode": right after a reference chosen through
// the grid, or with the caret just after an operator, separator or `(`. Elsewhere they move the
// caret, so an existing formula can be edited as text.
function formulaPointModeActive() {
  if (formulaPick?.picked) return true;
  const start = cellEditor.selectionStart ?? cellEditor.value.length;
  if (start !== (cellEditor.selectionEnd ?? start) || formulaCursorInQuote(cellEditor.value, start)) return false;
  return /[=(,+\-*/^&<>]\s*$/.test(cellEditor.value.slice(0, start));
}
function insertFormulaComma() {
  const start = cellEditor.selectionStart ?? cellEditor.value.length, end = cellEditor.selectionEnd ?? start;
  clearFormulaPick();
  cellEditor.value = cellEditor.value.slice(0, start) + ", " + cellEditor.value.slice(end);
  const next = start + 2; cellEditor.setSelectionRange(next, next);
  formulaInput.value = cellEditor.value; formulaInput.setSelectionRange(next, next); syncEditorSize(); updateFormulaAssist();
}
function renderFormulaSuggestions(matches) {
  formulaAssist.replaceChildren(); formulaAssistItems = matches; formulaAssistIndex = Math.min(formulaAssistIndex, matches.length - 1);
  matches.forEach((name, index) => {
    const help = functionHelp(name);
    const item = el("div", { class: "formula-suggestion" + (index === formulaAssistIndex ? " active" : ""), role: "option" }, [el("strong", {}, name), el("span", {}, help[1])]);
    item.addEventListener("mousedown", (event) => { event.preventDefault(); formulaAssistIndex = index; acceptFormulaSuggestion(); });
    formulaAssist.appendChild(item);
  });
  formulaAssist.style.display = "block"; requestAnimationFrame(positionFormulaAssist);
}
function renderFormulaSyntax(call) {
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
  absoluteRefBtn.disabled = !currentFormulaReferenceBounds();
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
function moveFormulaSuggestion(delta) {
  if (!formulaAssistItems.length) return false;
  formulaAssistIndex = (formulaAssistIndex + delta + formulaAssistItems.length) % formulaAssistItems.length;
  renderFormulaSuggestions(formulaAssistItems); return true;
}

let formulaPick = null;
let formulaPickGestureComplete = false;
function clearFormulaPick() {
  formulaPick = null; formulaPickGestureComplete = false; formulaRangeHandle.style.display = "none";
  gridTable.querySelectorAll("td.formula-ref").forEach((cell) => cell.classList.remove("formula-ref", "formula-ref-top", "formula-ref-bottom", "formula-ref-left", "formula-ref-right"));
}
function formulaRangeText(r1, c1, r2, c2) {
  const first = rcToRef(Math.min(r1, r2), Math.min(c1, c2));
  const last = rcToRef(Math.max(r1, r2), Math.max(c1, c2));
  return first === last ? first : first + ":" + last;
}
function localFormulaPosition(ref) {
  const bang = ref.indexOf("!");
  if (bang >= 0) {
    const sheetName = ref.slice(0, bang).replace(/^'|'$/g, "").replace(/''/g, "'");
    if (sheetName.toLowerCase() !== curSheet().name.toLowerCase()) return null;
    ref = ref.slice(bang + 1);
  }
  return parseRef(ref);
}
function formulaReferencedRanges(value = cellEditor.value) {
  const ranges = [];
  const addRange = (firstRef, lastRef = firstRef) => {
    const first = localFormulaPosition(firstRef), last = localFormulaPosition(lastRef); if (!first || !last) return;
    const range = {
      r1: Math.max(0, Math.min(first.r, last.r)), r2: Math.min(curSheet().rows - 1, Math.max(first.r, last.r)),
      c1: Math.max(0, Math.min(first.c, last.c)), c2: Math.min(curSheet().cols - 1, Math.max(first.c, last.c)),
    };
    if (!ranges.some((item) => item.r1 === range.r1 && item.r2 === range.r2 && item.c1 === range.c1 && item.c2 === range.c2)) ranges.push(range);
  };
  let ast;
  try { ast = parseFormula(value.startsWith("=") ? value.slice(1) : value); }
  catch (error) {
    const tokens = tokenize(value.startsWith("=") ? value.slice(1) : value);
    for (let index = 0; index < tokens.length; index++) {
      if (tokens[index].t !== "word") continue;
      if (tokens[index + 1]?.t === "colon" && tokens[index + 2]?.t === "word") { addRange(tokens[index].v, tokens[index + 2].v); index += 2; }
      else addRange(tokens[index].v);
    }
    return ranges;
  }
  const visit = (node) => {
    if (!node) return;
    if (node.k === "ref") addRange(node.ref);
    else if (node.k === "range") addRange(node.a, node.b);
    else if (node.k === "call") node.args.forEach(visit);
    else { if (node.a) visit(node.a); if (node.b) visit(node.b); }
  };
  visit(ast); return ranges;
}
function formulaReferencedCells(value = cellEditor.value) {
  const refs = new Set();
  for (const range of formulaReferencedRanges(value)) for (let row = range.r1; row <= range.r2; row++) for (let column = range.c1; column <= range.c2; column++) refs.add(rcToRef(row, column));
  return refs;
}
function positionFormulaRangeHandle() {
  if (!formulaPick || !editing) { formulaRangeHandle.style.display = "none"; return; }
  const row = Math.max(formulaPick.r1, formulaPick.r2), column = Math.max(formulaPick.c1, formulaPick.c2);
  const cell = cellEl(row, column);
  if (!cell || cell.offsetParent === null) { formulaRangeHandle.style.display = "none"; return; }
  formulaRangeHandle.style.left = (cell.offsetLeft + cell.offsetWidth - 5) + "px";
  formulaRangeHandle.style.top = (cell.offsetTop + cell.offsetHeight - 5) + "px";
  formulaRangeHandle.style.display = "block";
}
function renderFormulaPickHighlight() {
  const edgeClasses = ["formula-ref", "formula-ref-top", "formula-ref-bottom", "formula-ref-left", "formula-ref-right"];
  gridTable.querySelectorAll("td.formula-ref").forEach((cell) => cell.classList.remove(...edgeClasses));
  const applyRange = (range) => {
    for (let row = range.r1; row <= range.r2; row++) for (let column = range.c1; column <= range.c2; column++) {
      const cell = cellEl(row, column); if (!cell) continue;
      cell.classList.add("formula-ref");
      if (row === range.r1) cell.classList.add("formula-ref-top");
      if (row === range.r2) cell.classList.add("formula-ref-bottom");
      if (column === range.c1) cell.classList.add("formula-ref-left");
      if (column === range.c2) cell.classList.add("formula-ref-right");
    }
  };
  if (editing && cellEditor.value.startsWith("=")) formulaReferencedRanges().forEach(applyRange);
  if (formulaPick) applyRange({
    r1: Math.min(formulaPick.r1, formulaPick.r2), r2: Math.max(formulaPick.r1, formulaPick.r2),
    c1: Math.min(formulaPick.c1, formulaPick.c2), c2: Math.max(formulaPick.c1, formulaPick.c2),
  });
  positionFormulaRangeHandle();
}
function formulaReferenceBoundsAtCaret(value, caret) {
  const pattern = /(?:(?:'(?:[^']|'')+'|[A-Za-z_][A-Za-z0-9_.]*)!)?\$?[A-Z]{1,3}\$?[1-9]\d*(?::(?:(?:'(?:[^']|'')+'|[A-Za-z_][A-Za-z0-9_.]*)!)?\$?[A-Z]{1,3}\$?[1-9]\d*)?/gi;
  for (const match of value.matchAll(pattern)) {
    const start = match.index, end = start + match[0].length;
    if (caret >= start && caret <= end) return { start, end };
  }
  return null;
}
function cycleReferenceToken(text) {
  // A sheet name such as `Q1` looks like a cell; only the endpoint after `!` cycles.
  const bang = text.lastIndexOf("!");
  const prefix = text.slice(0, bang + 1);
  return prefix + text.slice(bang + 1).replace(/(?<![A-Z0-9_])(\$?)([A-Z]{1,3})(\$?)([1-9]\d*)(?![A-Z0-9_])/gi, (match, fixedColumn, column, fixedRow, row) => {
    const state = { column: !!fixedColumn, row: !!fixedRow };
    let next;
    if (!state.column && !state.row) next = { column: true, row: true };
    else if (state.column && state.row) next = { column: false, row: true };
    else if (!state.column && state.row) next = { column: true, row: false };
    else next = { column: false, row: false };
    return (next.column ? "$" : "") + column.toUpperCase() + (next.row ? "$" : "") + row;
  });
}
function formulaEndpointBoundsAtCaret(value, caret) {
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
  const original = cellEditor.value.slice(bounds.start, bounds.end), replacement = cycleReferenceToken(original);
  if (replacement === original) { setStatus("bad", "No cell reference selected"); return false; }
  cellEditor.value = cellEditor.value.slice(0, bounds.start) + replacement + cellEditor.value.slice(bounds.end);
  const end = bounds.start + replacement.length;
  cellEditor.setSelectionRange(end, end); formulaInput.value = cellEditor.value; formulaInput.setSelectionRange(end, end);
  const rangeBounds = formulaReferenceBoundsAtCaret(cellEditor.value, end);
  formulaPick = formulaReferenceFromBounds(cellEditor.value, rangeBounds); formulaPickGestureComplete = false;
  syncEditorSize(); updateFormulaAssist(); renderFormulaPickHighlight(); setStatus("saved", "Reference lock changed");
  return true;
}
function formulaReferenceFromBounds(value, bounds) {
  if (!bounds) return null;
  const text = value.slice(bounds.start, bounds.end), parts = text.split(":");
  const first = localFormulaPosition(parts[0]), last = localFormulaPosition(parts[1] || parts[0]);
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
  else { formulaPick = null; formulaPickGestureComplete = false; renderFormulaPickHighlight(); }
}
function updatePickedFormulaRange(r1, c1, r2 = r1, c2 = c1, reset = false) {
  if (!editing || !cellEditor.value.startsWith("=")) return;
  if (!formulaPick || reset) {
    let start = cellEditor.selectionStart ?? cellEditor.value.length;
    let end = cellEditor.selectionEnd ?? start;
    if (start === end) {
      const bounds = formulaReferenceBoundsAtCaret(cellEditor.value, start);
      if (bounds) { start = bounds.start; end = bounds.end; }
    }
    // Never let point-and-click reference selection replace the formula's
    // leading '=' or an automatically selected whole formula. In that case,
    // insert before trailing auto-closed parentheses instead.
    if (start < 1 || (start === 0 && end === cellEditor.value.length)) {
      let insertion = cellEditor.value.length;
      while (insertion > 1 && cellEditor.value[insertion - 1] === ")") insertion--;
      start = end = insertion;
    }
    formulaPick = { textStart: start, textEnd: end, r1, c1, r2, c2, picked: true };
  } else { formulaPick.r2 = r2; formulaPick.c2 = c2; formulaPick.picked = true; }
  const reference = formulaRangeText(formulaPick.r1, formulaPick.c1, formulaPick.r2, formulaPick.c2);
  cellEditor.value = cellEditor.value.slice(0, formulaPick.textStart) + reference + cellEditor.value.slice(formulaPick.textEnd);
  formulaPick.textEnd = formulaPick.textStart + reference.length;
  cellEditor.setSelectionRange(formulaPick.textEnd, formulaPick.textEnd);
  formulaInput.value = cellEditor.value; formulaInput.setSelectionRange(formulaPick.textEnd, formulaPick.textEnd); syncEditorSize(); updateFormulaAssist(); renderFormulaPickHighlight();
}
function activeFormulaArgumentSpans(value, cursor) {
  const opens = []; let quote = null;
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
  const open = opens[opens.length - 1], spans = []; let start = open + 1, depth = 0; quote = null;
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
function removeFormulaReferenceArgument(row, column) {
  const spans = activeFormulaArgumentSpans(cellEditor.value, cellEditor.selectionStart ?? cellEditor.value.length);
  const targetRef = rcToRef(row, column);
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
function formulaReferenceAtCell(row, column) {
  const value = cellEditor.value;
  const pattern = /(?:(?:'(?:[^']|'')+'|[A-Za-z_][A-Za-z0-9_.]*)!)?\$?[A-Z]{1,3}\$?[1-9]\d*(?::(?:(?:'(?:[^']|'')+'|[A-Za-z_][A-Za-z0-9_.]*)!)?\$?[A-Z]{1,3}\$?[1-9]\d*)?/gi;
  const matches = [];
  for (const match of value.matchAll(pattern)) {
    if (formulaCursorInQuote(value, match.index + 1)) continue;
    const parts = match[0].split(":");
    const first = localFormulaPosition(parts[0]), last = localFormulaPosition(parts[1] || parts[0]);
    if (!first || !last) continue;
    const range = { r1: Math.min(first.r, last.r), r2: Math.max(first.r, last.r), c1: Math.min(first.c, last.c), c2: Math.max(first.c, last.c) };
    if (row >= range.r1 && row <= range.r2 && column >= range.c1 && column <= range.c2) matches.push({ ...range, textStart: match.index, textEnd: match.index + match[0].length });
  }
  matches.sort((a, b) => (a.r2 - a.r1 + 1) * (a.c2 - a.c1 + 1) - (b.r2 - b.r1 + 1) * (b.c2 - b.c1 + 1));
  return matches[0] || null;
}
// `picked` marks a reference placed or chosen through the grid; a reference merely under the text
// caret leaves the arrow keys to caret navigation.
function activateFormulaReference(reference, moveCaret = true) {
  formulaPick = { ...reference, picked: moveCaret }; formulaPickGestureComplete = false;
  if (moveCaret) {
    cellEditor.setSelectionRange(reference.textEnd, reference.textEnd);
    formulaInput.value = cellEditor.value; formulaInput.setSelectionRange(reference.textEnd, reference.textEnd);
  }
  renderFormulaPickHighlight(); updateFormulaAssist();
}
function startFormulaMousePick(row, column, event) {
  const modifier = event.ctrlKey || event.metaKey;
  const caret = cellEditor.selectionStart ?? cellEditor.value.length;
  // A range selected for an inner function must not remain the active resize
  // target after the caret moves into an outer function or sibling argument.
  if (formulaPick && (caret < formulaPick.textStart || caret > formulaPick.textEnd)) clearFormulaPick();
  const beforeCaret = cellEditor.value.slice(0, caret);
  const afterSeparator = /[,;(]\s*$/.test(beforeCaret);
  const call = activeFormulaCall(cellEditor.value, cellEditor.selectionStart ?? cellEditor.value.length);
  const dedupeSelection = ["SUM", "AVERAGE", "COUNT", "COUNTA", "MIN", "MAX", "PRODUCT", "MEDIAN", "STDEV", "VAR"].includes(call?.name);
  const existing = formulaReferenceAtCell(row, column);
  if (modifier && dedupeSelection && existing) {
    if (removeFormulaReferenceArgument(row, column)) setStatus("saved", `${rcToRef(row, column)} removed from formula`);
    else setStatus("saved", `${rcToRef(row, column)} is part of an existing range`);
    renderFormulaPickHighlight(); mouseSelecting = false; return;
  }
  if (!modifier && !afterSeparator && existing) { activateFormulaReference(existing); mouseSelecting = false; return; }
  if (dedupeSelection && afterSeparator && existing) {
    setStatus("saved", `${rcToRef(row, column)} is already referenced`); renderFormulaPickHighlight(); mouseSelecting = false; return;
  }
  if (modifier) beginAdditionalFormulaReference();
  formulaPickGestureComplete = false;
  if (formulaPick) {
    if (!event.shiftKey) { formulaPick.r1 = row; formulaPick.c1 = column; }
    updatePickedFormulaRange(formulaPick.r1, formulaPick.c1, row, column, false);
  } else updatePickedFormulaRange(row, column, row, column, true);
  mouseSelecting = "formula";
}
function moveFormulaPickByKeyboard(rowDelta, columnDelta, extend) {
  if (!formulaPick) {
    const row = Math.max(0, Math.min(curSheet().rows - 1, editing.r + rowDelta));
    const column = Math.max(0, Math.min(curSheet().cols - 1, editing.c + columnDelta));
    updatePickedFormulaRange(row, column, row, column, true);
  } else {
    const row = Math.max(0, Math.min(curSheet().rows - 1, formulaPick.r2 + rowDelta));
    const column = Math.max(0, Math.min(curSheet().cols - 1, formulaPick.c2 + columnDelta));
    if (extend) updatePickedFormulaRange(formulaPick.r1, formulaPick.c1, row, column, false);
    else { formulaPick.r1 = row; formulaPick.c1 = column; updatePickedFormulaRange(row, column, row, column, false); }
  }
  formulaPickGestureComplete = true;
  const target = cellEl(formulaPick.r2, formulaPick.c2); if (target) target.scrollIntoView({ block: "nearest", inline: "nearest" });
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
  const target = document.elementsFromPoint(event.clientX, event.clientY).map((element) => element.closest?.("td.cell")).find(Boolean);
  if (target) {
    const row = +target.dataset.r, column = +target.dataset.c, rect = target.getBoundingClientRect();
    const threshold = 7;
    if (column > formulaPick.c2 && event.clientX < rect.left + threshold) return;
    if (row > formulaPick.r2 && event.clientY < rect.top + threshold) return;
    updatePickedFormulaRange(formulaPick.r1, formulaPick.c1, Math.max(formulaPick.r1, row), Math.max(formulaPick.c1, column), false);
  }
});
const finishFormulaRangeResize = (event) => {
  if (!resizingFormulaRange) return;
  resizingFormulaRange = false; formulaPickGestureComplete = true;
  formulaRangeHandle.releasePointerCapture?.(event?.pointerId); renderFormulaPickHighlight();
};
formulaRangeHandle.addEventListener("pointerup", finishFormulaRangeResize);
formulaRangeHandle.addEventListener("pointercancel", finishFormulaRangeResize);

let editing = null; // { ref, r, c, initial }
let imeComposing = false;
function armEditorCapture(focusCapture = false) {
  if (editing) return;
  const td = cellEl(focus.r, focus.c);
  if (!td) return;
  cellEditor.value = "";
  cellEditor.style.left = td.offsetLeft + "px";
  cellEditor.style.top = td.offsetTop + "px";
  cellEditor.style.display = "block";
  cellEditor.classList.add("capture");
  if (focusCapture) cellEditor.focus({ preventScroll: true });
}
gridScroll.addEventListener("focus", () => armEditorCapture(true));

function startEdit(ref, replace = false, seed = null, fromCapture = false, keepInputFocus = false) {
  clearFormulaPick();
  if (!fromCapture) imeComposing = false;
  const rc = parseRef(ref);
  const td = cellEl(rc.r, rc.c);
  if (!td) return;
  editing = { ref, r: rc.r, c: rc.c, sheetId: activeSheetId };
  fillHandle.style.display = "none";
  const cell = getCell(ref);
  let text = seed != null ? seed : (replace ? "" : (cell ? cell.value : ""));
  cellEditor.classList.remove("capture");
  const rect = td.getBoundingClientRect();
  const scRect = gridScroll.getBoundingClientRect();
  cellEditor.style.left = (td.offsetLeft) + "px";
  cellEditor.style.top = (td.offsetTop) + "px";
  cellEditor.style.minWidth = td.offsetWidth + "px";
  cellEditor.style.minHeight = td.offsetHeight + "px";
  cellEditor.style.width = td.offsetWidth + "px";
  if (!fromCapture) cellEditor.value = text;
  else text = cellEditor.value;
  cellEditor.style.display = "block";
  // font matches
  const f = cell?.fmt || {};
  cellEditor.style.fontWeight = f.b ? "700" : "400";
  cellEditor.style.fontStyle = f.i ? "italic" : "normal";
  cellEditor.style.textAlign = f.a === "c" ? "center" : f.a === "r" ? "right" : "left";
  if (!fromCapture && !keepInputFocus) {
    cellEditor.focus();
    if (replace || seed != null || cellEditor.value.startsWith("=")) { const L = cellEditor.value.length; cellEditor.setSelectionRange(L, L); }
    else cellEditor.select();
  }
  syncEditorSize();
  formulaInput.value = text;
  updateFormulaAssist();
}
const editorMeasureCanvas = document.createElement("canvas");
function syncEditorSize() {
  if (!editing) return;
  cellEditor.style.height = "auto";
  cellEditor.style.height = Math.max(cellEditor.scrollHeight, DEFAULT_ROW_H) + "px";
  const baseWidth = cellEl(editing.r, editing.c)?.offsetWidth || 60;
  const context = editorMeasureCanvas.getContext("2d");
  let measuredWidth = baseWidth;
  if (context) {
    const style = getComputedStyle(cellEditor);
    context.font = style.font || `${style.fontSize} ${style.fontFamily}`;
    for (const line of cellEditor.value.split("\n")) measuredWidth = Math.max(measuredWidth, Math.ceil(context.measureText(line || " ").width) + 12);
  }
  cellEditor.style.width = Math.min(2400, measuredWidth) + "px";
}
function completeFormulaParentheses(value) {
  if (!value.startsWith("=")) return value;
  const bare = /^=\s*([A-Za-z][A-Za-z0-9_.]*)\s*$/.exec(value);
  if (bare && FUNCTIONS[bare[1].toUpperCase()] && !["TRUE", "FALSE"].includes(bare[1].toUpperCase())) return `=${bare[1].toUpperCase()}()`;
  let depth = 0, quote = null;
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
// Argument counts the evaluator accepts; a rule is omitted where any count evaluates.
const FORMULA_ARGUMENT_RULES = {
  VLOOKUP: [3, 4], HLOOKUP: [3, 4], INDEX: [2, 3], MATCH: [2, 3],
  IF: [2, 3], IFERROR: [1, 2], IFNA: [2, 2], COUNTIF: [2, 2], SUMIF: [2, 3], AVERAGEIF: [2, 3],
  HYPERLINK: [1, 2], LEFT: [1, 2], RIGHT: [1, 2], MID: [3, 3], ROUND: [1, 2],
  DATE: [3, 3], DATEDIF: [3, 3], EDATE: [2, 2], CHOOSE: [2, Infinity],
};
function validateFormula(value) {
  if (!value.startsWith("=")) return null;
  let ast;
  try { ast = parseFormula(value.slice(1)); }
  catch (error) { return "This formula has invalid syntax. Check separators, quotes, and parentheses."; }
  let problem = null;
  const visit = (node) => {
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
      if (node.a) visit(node.a); if (node.b) visit(node.b);
    }
  };
  visit(ast); return problem;
}
function showFormulaError(message) {
  formulaAssist.replaceChildren(el("div", { class: "formula-error" }, message));
  formulaAssistItems = []; formulaAssist.style.display = "block"; requestAnimationFrame(positionFormulaAssist);
  setStatus("bad", "Fix formula error");
}
// Returns false when the value was rejected and the editor stays open, so callers that would
// navigate away (sheet switches) can stop.
function commitEdit(advance = "down") {
  if (!editing) return true;
  if (editing.sheetId !== activeSheetId) { cancelEdit(); return true; }
  const { ref, r, c } = editing;
  let value = completeFormulaParentheses(cellEditor.value);
  if (value == null) { showFormulaError("Formula quotes and parentheses must be balanced."); cellEditor.focus(); return false; }
  cellEditor.value = value;
  const formulaError = validateFormula(value);
  if (formulaError) { showFormulaError(formulaError); cellEditor.focus(); return false; }
  imeComposing = false;
  editing = null; absoluteRefBtn.disabled = true;
  closeFormulaAssist(); clearFormulaPick();
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
  return true;
}
function cancelEdit() {
  if (!editing) return;
  const { r, c } = editing;
  imeComposing = false;
  editing = null; absoluteRefBtn.disabled = true;
  closeFormulaAssist(); clearFormulaPick();
  cellEditor.style.display = "none";
  formulaInput.value = getCell(rcToRef(r, c))?.value || "";
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
  if (cellEditor.value.startsWith("=") && e.key === ")" && cellEditor.value[cellEditor.selectionStart] === ")" && !formulaCursorInQuote(cellEditor.value, cellEditor.selectionStart)) {
    e.preventDefault();
    const next = cellEditor.selectionStart + 1;
    cellEditor.setSelectionRange(next, next);
    formulaInput.setSelectionRange(next, next);
    // Moving across an auto-inserted closing parenthesis changes the active
    // nested function/argument. Drop the previous inner reference so the next
    // grid click targets the outer argument instead of resizing that range.
    syncFormulaPickFromCaret();
    updateFormulaAssist();
    e.stopPropagation();
    return;
  }
  if (!formulaAssistItems.length && cellEditor.value.startsWith("=") && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key) && formulaPointModeActive()) {
    e.preventDefault();
    const directions = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    moveFormulaPickByKeyboard(directions[e.key][0], directions[e.key][1], e.shiftKey); e.stopPropagation(); return;
  }
  if (formulaAssist.style.display !== "none" && e.key === "Escape") { e.preventDefault(); closeFormulaAssist(); e.stopPropagation(); return; }
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
  if (e.button !== 0) return;
  if (e.target.closest("a.cell-link") && (e.ctrlKey || e.metaKey)) { e.stopPropagation(); return; }
  const filterTrigger = e.target.closest(".filter-trigger");
  if (filterTrigger) { e.preventDefault(); e.stopPropagation(); return; }
  // Column/row resize handles
  const colResize = e.target.closest(".col-resize");
  if (colResize) { startColResize(+colResize.dataset.col, e); e.preventDefault(); return; }
  const rowResize = e.target.closest(".row-resize");
  if (rowResize) { startRowResize(+rowResize.dataset.row, e); e.preventDefault(); return; }

  if (editing && cellEditor.value.startsWith("=")) {
    const formulaCell = e.target.closest("td.cell");
    const formulaColumn = e.target.closest("th.colhead");
    const formulaRow = e.target.closest("th.rowhead");
    if (formulaCell) { startFormulaMousePick(+formulaCell.dataset.r, +formulaCell.dataset.c, e); e.preventDefault(); return; }
    if (formulaColumn) {
      if (e.ctrlKey || e.metaKey) beginAdditionalFormulaReference();
      const column = +formulaColumn.dataset.col, reset = !formulaPick;
      if (formulaPick) { formulaPick.r1 = 0; formulaPick.c1 = column; }
      updatePickedFormulaRange(0, column, curSheet().rows - 1, column, reset); formulaPickGestureComplete = true; e.preventDefault(); return;
    }
    if (formulaRow) {
      if (e.ctrlKey || e.metaKey) beginAdditionalFormulaReference();
      const row = +formulaRow.dataset.row, reset = !formulaPick;
      if (formulaPick) { formulaPick.r1 = row; formulaPick.c1 = 0; }
      updatePickedFormulaRange(row, 0, row, curSheet().cols - 1, reset); formulaPickGestureComplete = true; e.preventDefault(); return;
    }
  }

  const colhead = e.target.closest("th.colhead");
  if (colhead) {
    const c = +colhead.dataset.col; const sh = curSheet();
    if (editing) commitEdit("none");
    const additive = e.ctrlKey || e.metaKey;
    prepareHeaderSelection(additive);
    const startColumn = e.shiftKey ? anchor.c : c;
    anchor = { r: 0, c: startColumn };
    focus = { r: sh.rows - 1, c };
    updateSelectionUI(); sendPresence();
    mouseSelecting = "col"; e.preventDefault(); return;
  }
  const rowhead = e.target.closest("th.rowhead");
  if (rowhead) {
    const r = +rowhead.dataset.row; const sh = curSheet();
    if (editing) commitEdit("none");
    const additive = e.ctrlKey || e.metaKey;
    prepareHeaderSelection(additive);
    const startRow = e.shiftKey ? anchor.r : r;
    anchor = { r: startRow, c: 0 };
    focus = { r, c: sh.cols - 1 };
    updateSelectionUI(); sendPresence();
    mouseSelecting = "row"; e.preventDefault(); return;
  }
  const td = e.target.closest("td.cell");
  if (td) {
    const r = +td.dataset.r, c = +td.dataset.c;
    if (editing) commitEdit("none");
    if (e.ctrlKey || e.metaKey) { addCurrentRangeToSelection(); moveActive(r, c, false, true); }
    else if (e.shiftKey) { focus = { r, c }; updateSelectionUI(); sendPresence(); }
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
  if (mouseSelecting === "formula" && formulaPick) { updatePickedFormulaRange(formulaPick.r1, formulaPick.c1, r, c, false); return; }
  const sh = curSheet();
  if (mouseSelecting === "col") { focus = { r: sh.rows - 1, c }; anchor = { r: 0, c: anchor.c }; }
  else if (mouseSelecting === "row") { focus = { r, c: sh.cols - 1 }; anchor = { r: anchor.r, c: 0 }; }
  else { focus = { r, c }; }
  updateSelectionUI();
});
window.addEventListener("mouseup", () => {
  if (mouseSelecting) {
    if (mouseSelecting === "formula" && formulaPick) formulaPickGestureComplete = true;
    mouseSelecting = false; sendPresence();
  }
});

gridTable.addEventListener("click", (e) => {
  const marker = e.target.closest(".comment-marker");
  if (marker) {
    const td = marker.closest("td.cell"); if (td) { const position = parseRef(td.dataset.ref); if (position) moveActive(position.r, position.c); }
    sidebarView = "comments"; setChartPanelCollapsed(false); renderChartPanel(); return;
  }
  const trigger = e.target.closest(".filter-trigger");
  if (!trigger) return;
  const td = trigger.closest("td.cell");
  if (td) openFilterMenu(+td.dataset.c, trigger);
});

gridTable.addEventListener("dblclick", (e) => {
  if (e.target.closest(".filter-trigger")) return;
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
function handleGridKeydown(e) {
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
}
gridScroll.addEventListener("keydown", handleGridKeydown);
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
  const seen = new Set();
  beginBatch();
  for (const range of selectionRanges()) for (let row = range.r1; row <= range.r2; row++) for (let col = range.c1; col <= range.c2; col++) {
    const ref = rcToRef(row, col); if (seen.has(ref)) continue; seen.add(ref);
    const cell = getCell(ref);
    if (cell) { recordCell(activeSheetId, ref); if (cell.fmt) { setCellValue(ref, null); } else { const baseVersion = cell.version || 0; delete curCells()[ref]; queueCellOp(activeSheetId, ref, null, null, baseVersion); } }
  }
  commitBatch(); rebuildEngine(); renderGrid(); schedulePivotRefreshes(activeSheetId);
}

// ===========================================================================
// Copy / paste (TSV via clipboard)
// ===========================================================================
let copyRange = null;
let copyFallback = null;
// Whole-row and whole-column selections are trimmed to the populated extent; `trimmed` records
// which axis, so a paste does not mistake the trimmed block for a repeatable pattern.
function clipboardReferenceMatrix() {
  const ranges = selectionRanges();
  const sheet = curSheet();
  const allRows = ranges.every((range) => range.c1 === 0 && range.c2 === sheet.cols - 1);
  const allColumns = ranges.every((range) => range.r1 === 0 && range.r2 === sheet.rows - 1);
  return { refs: clipboardReferences(ranges, sheet, allRows, allColumns), trimmed: allRows ? "rows" : allColumns ? "columns" : null };
}
function clipboardReferences(ranges, sheet, allRows, allColumns) {
  if (allRows) {
    const rows = [...new Set(ranges.flatMap((range) => Array.from({ length: range.r2 - range.r1 + 1 }, (_, index) => range.r1 + index)))].sort((a, b) => a - b);
    let lastColumn = 0;
    for (const row of rows) for (let column = 0; column < sheet.cols; column++) if (!isVisuallyEmptyCell(row, column)) lastColumn = Math.max(lastColumn, column);
    return rows.map((row) => Array.from({ length: lastColumn + 1 }, (_, column) => rcToRef(row, column)));
  }
  if (allColumns) {
    const columns = [...new Set(ranges.flatMap((range) => Array.from({ length: range.c2 - range.c1 + 1 }, (_, index) => range.c1 + index)))].sort((a, b) => a - b);
    let lastRow = 0;
    for (const column of columns) for (let row = 0; row < sheet.rows; row++) if (!isVisuallyEmptyCell(row, column)) lastRow = Math.max(lastRow, row);
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
function clipboardCellText(ref) {
  if (!ref) return "";
  const cell = getCell(ref); if (!cell) return "";
  const value = engine.computeRef(activeSheetId, ref);
  return cell.value?.startsWith("=") ? (isErr(value) ? value.value : (value == null ? "" : String(value))) : (cell.value || "");
}
function prepareClipboard(cut = false) {
  const { refs, trimmed } = clipboardReferenceMatrix();
  const cells = refs.map((row) => row.map((ref) => {
    const cell = ref ? getCell(ref) : null;
    return cell ? { value: cell.value, fmt: cell.fmt, sourceRef: ref } : (ref ? { value: null, fmt: null, sourceRef: ref } : null);
  }));
  const tsv = refs.map((row) => row.map(clipboardCellText).join("\t")).join("\n");
  copyRange = { ...selRange() };
  copyFallback = { tsv, cells, refs, trimmed, sheetId: activeSheetId, cut };
  return tsv;
}
function requestGridClipboard(cut = false) {
  armEditorCapture(true);
  try { document.execCommand(cut ? "cut" : "copy"); }
  catch (error) { setStatus("bad", "Clipboard unavailable"); }
}
function pasteFromMenu(keepFormatting) {
  if (copyFallback?.tsv != null) {
    pasteText(copyFallback.tsv, { keepFormatting });
    return;
  }
  // Permissions Policy prevents menu-click handlers from reading the system
  // clipboard. Native keyboard paste still supplies ClipboardEvent data.
  setStatus("bad", keepFormatting ? "Use Ctrl+V for external content" : "Use Ctrl+Shift+V for external content");
}
gridScroll.addEventListener("copy", (event) => {
  if (editing) return;
  event.preventDefault(); event.clipboardData.setData("text/plain", prepareClipboard(false));
});
gridScroll.addEventListener("cut", (event) => {
  if (editing) return;
  event.preventDefault(); event.clipboardData.setData("text/plain", prepareClipboard(true));
});
function clearCopyMarquee() { copyRange = null; copyFallback = null; }

let pasteWithoutFormattingPending = false;
let pasteModeTimer = null;
gridScroll.addEventListener("paste", (e) => {
  if (editing) return;
  e.preventDefault();
  const text = (e.clipboardData && e.clipboardData.getData("text/plain")) || "";
  const keepFormatting = !pasteWithoutFormattingPending;
  pasteWithoutFormattingPending = false; clearTimeout(pasteModeTimer);
  pasteText(text, { keepFormatting });
});
// Applies `rewrite` to the parts of a formula outside string literals and quoted sheet names, so
// text such as `="A1"` is never mistaken for a reference.
function rewriteFormulaOutsideQuotes(value, rewrite) {
  let result = value[0], segment = "", quote = null;
  for (let index = 1; index < value.length; index++) {
    const char = value[index];
    if (quote) {
      result += char;
      if ((char === "\\" || char === quote) && value[index + 1] === quote) result += value[++index];
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'") { result += rewrite(segment) + char; segment = ""; quote = char; }
    else segment += char;
  }
  return result + rewrite(segment);
}
function shiftedCopyFormula(value, sourceRef, targetRef, isCut) {
  if (isCut || !value?.startsWith("=") || !sourceRef) return value;
  const source = parseRef(sourceRef), target = parseRef(targetRef);
  if (!source || !target) return value;
  const rowDelta = target.r - source.r, colDelta = target.c - source.c;
  // `(?!!)` leaves an unquoted sheet name such as `Q1!` alone.
  return rewriteFormulaOutsideQuotes(value, (segment) => segment.replace(/(?<![A-Z0-9_])(\$?)([A-Z]{1,2})(\$?)([1-9]\d*)(?![A-Z0-9_!])/gi, (match, fixedColumn, letters, fixedRow, rowText) => {
    let row = Number(rowText) - 1, column = letterToCol(letters);
    if (!fixedRow) row += rowDelta;
    if (!fixedColumn) column += colDelta;
    if (row < 0 || column < 0) return "#REF!";
    return fixedColumn + colToLetter(column) + fixedRow + (row + 1);
  }));
}
// A cut source is only removed while it still holds what was cut; an edit made in between wins.
function cutSourceUnchanged(sheetId, snapshot) {
  const current = model.cells[sheetId]?.[snapshot.sourceRef];
  return (current?.value ?? null) === snapshot.value && JSON.stringify(current?.fmt ?? null) === JSON.stringify(snapshot.fmt ?? null);
}
function clearStoredCell(sheetId, ref) {
  const cells = model.cells[sheetId] || (model.cells[sheetId] = {});
  const existing = cells[ref]; if (!existing) return;
  recordCell(sheetId, ref);
  const baseVersion = existing.version || 0;
  delete cells[ref]; queueCellOp(sheetId, ref, null, null, baseVersion);
}
function pasteText(text, { keepFormatting = true } = {}) {
  const normalized = text.replace(/\r/g, "");
  const useSnapshot = copyFallback && copyFallback.tsv.replace(/\r/g, "") === normalized && copyFallback.cells;
  const rows = normalized.split("\n");
  if (rows.length > 1 && rows[rows.length - 1] === "") rows.pop();
  const values = rows.map((row) => row.split("\t"));
  const sourceHeight = values.length, sourceWidth = Math.max(1, ...values.map((row) => row.length));
  const targetRanges = selectionRanges();
  const destinationRefs = new Set();
  beginBatch();
  for (const target of targetRanges) {
    const targetHeight = target.r2 - target.r1 + 1, targetWidth = target.c2 - target.c1 + 1;
    // A trimmed whole-row copy keeps its own width (and a whole-column copy its height): the trim
    // is not a pattern to tile across the destination.
    const trimmedRows = useSnapshot && copyFallback.trimmed === "rows", trimmedColumns = useSnapshot && copyFallback.trimmed === "columns";
    const widthFits = trimmedRows || (targetWidth >= sourceWidth && targetWidth % sourceWidth === 0);
    const heightFits = trimmedColumns || (targetHeight >= sourceHeight && targetHeight % sourceHeight === 0);
    const repeat = (sourceHeight === 1 && sourceWidth === 1 && !trimmedRows && !trimmedColumns) || (widthFits && heightFits);
    const pasteHeight = repeat && !trimmedColumns ? targetHeight : sourceHeight;
    const pasteWidth = repeat && !trimmedRows ? targetWidth : sourceWidth;
    for (let i = 0; i < pasteHeight; i++) for (let j = 0; j < pasteWidth; j++) {
      const row = target.r1 + i, column = target.c1 + j;
      if (row > target.r2 && targetRanges.length > 1 || column > target.c2 && targetRanges.length > 1) continue;
      if (row >= curSheet().rows || column >= curSheet().cols) continue;
      const sourceRow = i % sourceHeight, sourceColumn = j % sourceWidth;
      const ref = rcToRef(row, column); destinationRefs.add(activeSheetId + "!" + ref);
      const snapshot = useSnapshot ? copyFallback.cells[sourceRow]?.[sourceColumn] : undefined;
      if (useSnapshot && keepFormatting) {
        recordCell(activeSheetId, ref);
        if (snapshot && snapshot.value != null) {
          const existing = getCell(ref);
          const value = shiftedCopyFormula(snapshot.value, snapshot.sourceRef, ref, copyFallback.cut);
          curCells()[ref] = { value, fmt: snapshot.fmt, version: existing?.version || 0 };
          queueCellOp(activeSheetId, ref, value, snapshot.fmt);
        } else clearStoredCell(activeSheetId, ref);
      } else if (useSnapshot && !keepFormatting) {
        const value = snapshot && snapshot.value != null ? shiftedCopyFormula(snapshot.value, snapshot.sourceRef, ref, copyFallback.cut) : "";
        setCellValue(ref, value === "" ? null : value);
      } else {
        const value = values[sourceRow]?.[sourceColumn] ?? "";
        setCellValue(ref, value === "" ? null : value);
      }
    }
  }
  if (useSnapshot && copyFallback.cut) {
    for (const row of copyFallback.cells) for (const snapshot of row) {
      if (snapshot?.sourceRef && !destinationRefs.has(copyFallback.sheetId + "!" + snapshot.sourceRef) && cutSourceUnchanged(copyFallback.sheetId, snapshot)) clearStoredCell(copyFallback.sheetId, snapshot.sourceRef);
    }
    copyFallback = null; copyRange = null;
  }
  commitBatch(); rebuildEngine(); renderGrid(); schedulePivotRefreshes(activeSheetId);
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
formulaInput.addEventListener("focus", () => { if (!editing) startEdit(rcToRef(focus.r, focus.c), false, null, false, true); });
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
formulaInput.addEventListener("keyup", syncFormulaInputCaretToEditor);
formulaInput.addEventListener("keydown", (e) => {
  if (imeComposing || e.isComposing || e.keyCode === 229) return;
  if (editing && (e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "l") {
    e.preventDefault(); cellEditor.setSelectionRange(formulaInput.selectionStart, formulaInput.selectionEnd); syncFormulaPickFromCaret(); cycleAbsoluteReference(); return;
  }
  if (editing && formulaInput.value.startsWith("=") && e.key === "," && !formulaCursorInQuote(formulaInput.value, formulaInput.selectionStart)) {
    e.preventDefault(); cellEditor.setSelectionRange(formulaInput.selectionStart, formulaInput.selectionEnd); insertFormulaComma(); return;
  }
  if (editing && formulaInput.value.startsWith("=") && e.key === ")" && formulaInput.value[formulaInput.selectionStart] === ")") {
    e.preventDefault();
    const next = formulaInput.selectionStart + 1;
    formulaInput.setSelectionRange(next, next);
    cellEditor.setSelectionRange(next, next);
    syncFormulaPickFromCaret();
    updateFormulaAssist();
    return;
  }
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
    "Text": ["CONCAT", "TEXTJOIN", "LEFT", "RIGHT", "MID", "LEN", "UPPER", "LOWER", "TRIM", "SUBSTITUTE", "TEXT", "HYPERLINK"],
    "Lookup": ["VLOOKUP", "HLOOKUP", "INDEX", "MATCH", "CHOOSE", "LOOKUP"],
    "Date": ["TODAY", "NOW", "DATE", "YEAR", "MONTH", "DAY", "WEEKDAY", "EDATE", "DATEDIF"],
  };
  const menu = el("div", { class: "ctx fn-menu" });
  const search = el("input", { class: "fn-search", type: "search", placeholder: "Search functions…", "aria-label": "Search functions" });
  menu.appendChild(el("div", { class: "fn-search-wrap" }, search));
  const groupRecords = [];
  for (const [name, functions] of Object.entries(groups)) {
    const group = el("section", { class: "fn-group" });
    const header = el("button", { class: "fn-head", type: "button", "aria-expanded": "false" }, [
      el("span", { class: "fn-head-label" }, name),
      el("span", { class: "fn-head-count" }, String(functions.length)),
      el("span", { class: "fn-chev" }, "›"),
    ]);
    const items = el("div", { class: "fn-items" });
    const itemRecords = [];
    for (const fn of functions) {
      const item = el("div", { class: "ctx-item" }, [el("span", {}, fn), el("span", { class: "k" }, "ƒ")]);
      item.addEventListener("click", () => { closeCtx(); insertFunction(fn); });
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
  const rect = fxBtn.getBoundingClientRect();
  showCtx(menu, rect.left, rect.bottom + 4);
  requestAnimationFrame(() => search.focus({ preventScroll: true }));
}
function insertFunction(name) {
  const ref = rcToRef(focus.r, focus.c);
  startEdit(ref, true, "=" + name + "()");
  const cursor = name.length + 2;
  cellEditor.setSelectionRange(cursor, cursor); updateFormulaAssist();
}

// ===========================================================================
// Links + context menu
// ===========================================================================
function linkForRef(ref) {
  const cell = getCell(ref); if (!cell) return null;
  const value = engine.computeRef(activeSheetId, ref);
  if (value instanceof HyperlinkValue) return value.url;
  return typeof value === "string" ? safeHyperlinkUrl(value) : null;
}
function openExternalLink(url) {
  const safe = safeHyperlinkUrl(url); if (!safe) return;
  const anchor = el("a", { href: safe, target: "_blank", rel: "noopener noreferrer" });
  document.body.appendChild(anchor); anchor.click(); anchor.remove();
}
function copyPlainText(text) {
  const input = el("textarea", { "aria-hidden": "true" }); input.value = text;
  input.style.cssText = "position:fixed;left:-10000px;top:0"; document.body.appendChild(input);
  input.focus(); input.select();
  let copied = false; try { copied = document.execCommand("copy"); } catch (error) {}
  input.remove(); armEditorCapture(true);
  setStatus(copied ? "saved" : "bad", copied ? "Link copied" : "Clipboard unavailable");
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
  if (td) {
    const r = +td.dataset.r, c = +td.dataset.c;
    if (!cellInSelection(r, c)) moveActive(r, c);
  } else if (colhead) {
    const c = +colhead.dataset.col, sheet = curSheet();
    const selected = selectionRanges().some((range) => range.r1 === 0 && range.r2 === sheet.rows - 1 && c >= range.c1 && c <= range.c2);
    if (!selected) setSelection({ r: 0, c }, { r: sheet.rows - 1, c });
  } else if (rowhead) {
    const r = +rowhead.dataset.row, sheet = curSheet();
    const selected = selectionRanges().some((range) => range.c1 === 0 && range.c2 === sheet.cols - 1 && r >= range.r1 && r <= range.r2);
    if (!selected) setSelection({ r, c: 0 }, { r, c: sheet.cols - 1 });
  }
  const menu = el("div", { class: "ctx" });
  const item = (label, k, fn, danger) => { const it = el("div", { class: "ctx-item" + (danger ? " danger" : "") }, [el("span", {}, label), k ? el("span", { class: "k" }, k) : null]); it.addEventListener("click", () => { closeCtx(); fn(); }); menu.appendChild(it); };
  const sep = () => menu.appendChild(el("div", { class: "ctx-sep" }));
  const activeLink = td ? linkForRef(td.dataset.ref) : null;
  if (activeLink) {
    item("Open link", "Ctrl+Click", () => openExternalLink(activeLink));
    item("Copy link", "", () => copyPlainText(activeLink));
    sep();
  }
  item("Cut", "Ctrl+X", () => requestGridClipboard(true));
  item("Copy", "Ctrl+C", () => requestGridClipboard(false));
  item("Paste", "Ctrl+V", () => pasteFromMenu(true));
  item("Paste without formatting", "Ctrl+Shift+V", () => pasteFromMenu(false));
  sep();
  item("Comment", "", () => openCommentEditor(rcToRef(focus.r, focus.c)));
  item("Create pivot table", "", () => createPivotTable());
  sep();
  const filter = curSheet().filter;
  item(filter ? "Remove filter" : "Create filter for data table", "", () => toggleFilterRow());
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
  if (editing && !commitEdit("none")) return;
  activeSheetId = id;
  if (model.sheets[id]?.pivot) refreshPivot(id);
  anchor = { r: 0, c: 0 }; focus = { r: 0, c: 0 }; extraRanges = [];
  selectedChartId = null; selectedPivotSheetId = null; sidebarView = "home";
  renderTabs(); renderGrid(); updateSelectionUI(); renderChartPanel();
  sendPresence();
}
function addSheet() {
  if (editing && !commitEdit("none")) return;
  const id = "s_" + Math.random().toString(36).slice(2, 8);
  let n = model.sheetOrder.length + 1;
  while (model.sheetOrder.some((sid) => model.sheets[sid].name === "Sheet" + n)) n++;
  model.sheets[id] = { id, name: "Sheet" + n, rows: 100, cols: 26, colWidths: {}, rowHeights: {}, frozenRows: 0, frozenCols: 0, filter: null, charts: [], comments: [], pivot: null };
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
  if (editing && !commitEdit("none")) return;
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
  if (model.sheetOrder.length <= 1 || (editing && !commitEdit("none"))) return;
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
gridScroll.addEventListener("scroll", () => { renderPresence(); if (formulaAssist.style.display !== "none") positionFormulaAssist(); });
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
  if (!model.sheets[activeSheetId]) { if (editing) cancelEdit(); activeSheetId = model.sheetOrder[0]; }
  if (selectedChartId && !(curSheet().charts || []).some((chart) => chart.id === selectedChartId)) selectedChartId = null;
  renderTabs(); renderGrid(); renderChartPanel();
  setStatus("synced", "Live update");
  setTimeout(() => { if (!saveInFlight && !pendingCellOps.size) setStatus("saved", "Saved"); }, 900);
}
// Remote structure replaces the model wholesale (last writer wins on the server). Local changes
// that are still pending are diffed against `ackedStructure` and replayed on top, per sheet field,
// so a remote chart and a local comment on the same sheet both survive.
function applyStructure(s) {
  const local = pendingStructure ? localStructureChanges() : null;
  if (s.title != null && document.activeElement !== titleInput) { model.title = s.title; titleInput.value = s.title; }
  else if (s.title != null) model.title = s.title;
  model.sheetOrder = s.sheetOrder.slice();
  for (const id of model.sheetOrder) model.sheets[id] = { ...model.sheets[id], ...s.sheets[id] };
  const added = new Set(local?.added);
  for (const id of Object.keys(model.sheets)) if (!model.sheetOrder.includes(id) && !added.has(id)) { delete model.sheets[id]; delete model.cells[id]; }
  ackedStructure = { title: model.title, sheetOrder: model.sheetOrder.slice(), sheets: JSON.parse(JSON.stringify(Object.fromEntries(model.sheetOrder.map((id) => [id, model.sheets[id]])))) };
  if (!local) return;
  if (local.title != null) { model.title = local.title; if (document.activeElement !== titleInput) titleInput.value = local.title; }
  for (const id of local.removed) {
    const index = model.sheetOrder.indexOf(id);
    if (index >= 0) { model.sheetOrder.splice(index, 1); delete model.sheets[id]; delete model.cells[id]; }
  }
  for (const [id, fields] of Object.entries(local.sheets)) {
    if (added.has(id)) { model.sheets[id] = { ...model.sheets[id], ...fields }; model.sheetOrder.push(id); }
    else if (model.sheetOrder.includes(id)) Object.assign(model.sheets[id], fields);
    // A sheet deleted remotely while edited here stays deleted.
  }
  if (local.sheetOrder) {
    const order = local.sheetOrder.filter((id) => model.sheetOrder.includes(id));
    model.sheetOrder = [...order, ...model.sheetOrder.filter((id) => !order.includes(id))];
  }
  pendingStructure = structureSnapshot();
}
function localStructureChanges() {
  const base = ackedStructure || { title: pendingStructure.title, sheetOrder: [], sheets: {} };
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const changes = {
    title: pendingStructure.title !== base.title ? pendingStructure.title : null,
    sheetOrder: same(pendingStructure.sheetOrder, base.sheetOrder) ? null : pendingStructure.sheetOrder,
    added: Object.keys(pendingStructure.sheets).filter((id) => !base.sheets[id]),
    removed: base.sheetOrder.filter((id) => !pendingStructure.sheets[id]),
    sheets: {},
  };
  for (const [id, sheet] of Object.entries(pendingStructure.sheets)) {
    const baseSheet = base.sheets[id];
    if (!baseSheet) { changes.sheets[id] = sheet; continue; }
    const fields = {};
    for (const key of new Set([...Object.keys(sheet), ...Object.keys(baseSheet)])) if (!same(sheet[key], baseSheet[key])) fields[key] = sheet[key];
    if (Object.keys(fields).length) changes.sheets[id] = fields;
  }
  return changes;
}

function applySnapshot(doc) {
  applyingRemote = true;
  model.revision = doc.revision || 0;
  model.title = doc.title || "Untitled spreadsheet";
  model.sheetOrder = doc.sheetOrder || [];
  model.sheets = doc.sheets || {};
  model.cells = doc.cells || {};
  for (const id of model.sheetOrder) if (!model.cells[id]) model.cells[id] = {};
  ackedStructure = structureSnapshot();
  titleInput.value = model.title;
  if (!activeSheetId || !model.sheets[activeSheetId]) activeSheetId = model.sheetOrder[0];
  applyingRemote = false;
  rebuildEngine();
  renderTabs(); renderGrid();
  updateSelectionUI(); renderChartPanel();
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

