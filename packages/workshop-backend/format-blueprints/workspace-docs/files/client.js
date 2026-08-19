// ---------------------------------------------------------------------------
// Docs — a Google-Docs-style editor. Builds the entire UI in JS.
// ---------------------------------------------------------------------------

const clientId = Math.random().toString(36).slice(2);
const isDocumentExport = ["html", "pdf"].includes(globalThis.gadgetExportFormatId);

// --- Styles ----------------------------------------------------------------
const style = document.createElement("style");
style.textContent = `
:root {
  color-scheme: light;
  --bg:        #f6f6f4;
  --surface:   #ffffff;
  --surface-2: #efefec;
  --line:        rgba(20,20,25,0.10);
  --line-strong: rgba(20,20,25,0.18);
  --text:   #1d1d20;
  --muted:  #6b6b73;
  --faint:  #9a9aa2;
  --accent: #e1632e;
  --ok:#1f9d77; --warn:#b9842f; --bad:#c4566a;
  --ease-out: cubic-bezier(0.23, 1, 0.32, 1);
  --ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);
}

* { box-sizing: border-box; }

html, body {
  margin: 0; height: 100%;
  background: var(--bg);
  color: var(--text);
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Inter, sans-serif;
  font-size: 13.5px;
  -webkit-font-smoothing: antialiased;
}

::selection { background: rgba(225,99,46,0.22); }

/* Thin scrollbars */
* { scrollbar-width: thin; scrollbar-color: rgba(20,20,25,0.22) transparent; }
*::-webkit-scrollbar { width: 10px; height: 10px; }
*::-webkit-scrollbar-thumb {
  background: rgba(20,20,25,0.22); border-radius: 10px;
  border: 3px solid transparent; background-clip: content-box;
}
*::-webkit-scrollbar-track { background: transparent; }

.app { display: flex; flex-direction: column; height: 100vh; }

/* --- Top bar --------------------------------------------------------------*/
.topbar {
  display: flex; align-items: center; gap: 12px;
  padding: 8px 16px;
  background: var(--surface);
  border-bottom: 1px solid var(--line);
  flex: 0 0 auto;
  contain: layout style;       /* isolate from editor reflows */
}
.title-wrap { display: flex; flex-direction: column; min-width: 0; }
.title-input {
  appearance: none; background: transparent; border: 1px solid transparent;
  color: var(--text); font-size: 15px; font-weight: 600; letter-spacing: -0.01em;
  padding: 3px 7px; border-radius: 6px; width: min(46vw, 420px);
  transition: border-color .14s var(--ease-out), background .14s var(--ease-out);
}
.title-input:hover { border-color: var(--line); }
.title-input:focus { outline: none; border-color: var(--line-strong); background: var(--bg); }
.status {
  display: flex; align-items: center; gap: 6px;
  font-size: 11px; letter-spacing: .03em;
  color: var(--faint); flex: 0 0 auto;
  opacity: .75; transition: opacity .2s var(--ease-out);
}
.status:hover { opacity: 1; }
.dot { width: 5px; height: 5px; border-radius: 50%; background: var(--faint); flex: 0 0 auto; }
.dot.saving { background: var(--warn); animation: pulse 1s infinite var(--ease-in-out); }
.dot.saved { background: var(--ok); }
.dot.bad { background: var(--bad); }
.dot.synced { background: var(--accent); animation: pulse .6s 2 var(--ease-in-out); }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .3; } }

.spacer { flex: 1 1 auto; }

/* --- Toolbar --------------------------------------------------------------*/
.toolbar {
  display: flex; align-items: center; flex-wrap: nowrap; gap: 0;
  padding: 6px 16px;
  background: var(--surface);
  border-bottom: 1px solid var(--line);
  flex: 0 0 auto;
  overflow-x: auto;            /* last-resort scroll on very tiny widths */
  scrollbar-width: none;
  contain: layout style;       /* isolate from editor reflows */
}
.toolbar::-webkit-scrollbar { display: none; }
.tgroup { display: inline-flex; align-items: center; gap: 4px; flex: 0 0 auto; }
.tdiv { width: 1px; height: 20px; background: var(--line); margin: 0 7px; flex: 0 0 auto; }

/* Progressive collapse: drop lower-priority groups as width shrinks, so the
   toolbar always stays on a single line. */
@media (max-width: 1180px) { .toolbar .p3 { display: none; } }
@media (max-width: 980px)  { .toolbar .p2 { display: none; } }
@media (max-width: 780px)  { .toolbar .p1 { display: none; } }

.icon-btn {
  width: 28px; height: 28px; flex: 0 0 auto;
  display: inline-flex; align-items: center; justify-content: center;
  background: transparent; border: 1px solid transparent; border-radius: 6px;
  color: var(--muted); cursor: pointer;
  transition: all .14s var(--ease-out);
}
.icon-btn:hover { background: var(--surface-2); border-color: var(--line); color: var(--text); }
.icon-btn:active { transform: scale(0.94); }
.icon-btn.active { background: rgba(225,99,46,0.12); border-color: rgba(225,99,46,0.35); color: var(--accent); }
.icon-btn svg { width: 16px; height: 16px; }
.icon-btn[disabled] { opacity: .4; pointer-events: none; }

.cselect {
  appearance: none; background: var(--surface); color: var(--text);
  border: 1px solid var(--line); border-radius: 6px;
  font-size: 12.5px; height: 28px; padding: 0 8px 0 10px; cursor: pointer;
  display: inline-flex; align-items: center; gap: 6px; flex: 0 0 auto;
  transition: border-color .14s var(--ease-out), background .14s var(--ease-out);
}
.cselect:hover { border-color: var(--line-strong); background: var(--surface-2); }
.cselect:active { transform: scale(0.98); }
.cselect.open { border-color: var(--accent); background: var(--surface); }
.cs-label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1 1 auto; text-align: left; }
.cs-chev { display: inline-flex; color: var(--muted); flex: 0 0 auto; transition: transform .14s var(--ease-out); }
.cs-chev svg { width: 12px; height: 12px; }
.cselect.open .cs-chev { transform: rotate(180deg); }
.cselect.style-sel { width: 116px; }
.cselect.font-sel { width: 132px; }
.cselect.size-sel { width: 66px; }

.cmenu {
  position: fixed; z-index: 1000;
  background: var(--surface);
  border: 1px solid var(--line-strong);
  border-radius: 8px; padding: 4px;
  box-shadow: 0 10px 30px rgba(0,0,0,0.16), 0 2px 8px rgba(0,0,0,0.08);
  max-height: 340px; overflow-y: auto;
  animation: cmenu-in .12s var(--ease-out);
}
@keyframes cmenu-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
.cmenu-item {
  padding: 6px 10px; border-radius: 5px; font-size: 13px; color: var(--text);
  cursor: pointer; white-space: nowrap; display: flex; align-items: center;
  justify-content: space-between; gap: 18px;
  transition: background .1s var(--ease-out);
}
.cmenu-item:hover { background: var(--surface-2); }
.cmenu-item.sel { color: var(--accent); }
.cmenu-item.sel::after {
  content: ""; width: 13px; height: 13px; flex: 0 0 auto;
  background: no-repeat center/contain url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23e1632e' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='20 6 9 17 4 12'/%3E%3C/svg%3E");
}

/* Color buttons */
.color-btn {
  position: relative; width: 28px; height: 28px; flex: 0 0 auto;
  display: inline-flex; flex-direction: column; align-items: center; justify-content: center;
  background: transparent; border: 1px solid transparent; border-radius: 6px;
  color: var(--muted); cursor: pointer; transition: all .14s var(--ease-out);
}
.color-btn:hover { background: var(--surface-2); border-color: var(--line); color: var(--text); }
.color-btn:active { transform: scale(0.94); }
.color-btn svg { width: 15px; height: 15px; margin-top: -1px; }
.color-btn .bar { width: 16px; height: 3px; border-radius: 2px; margin-top: 1px; }
.color-btn input[type=color] {
  position: absolute; inset: 0; opacity: 0; cursor: pointer; border: none; padding: 0;
}

/* Segmented control for alignment */
.segment {
  display: inline-flex; gap: 2px; padding: 2px;
  background: var(--surface-2); border: 1px solid var(--line); border-radius: 7px;
}
.segment .seg-btn {
  width: 24px; height: 22px; display: inline-flex; align-items: center; justify-content: center;
  background: transparent; border: none; border-radius: 5px; color: var(--muted);
  cursor: pointer; transition: all .14s var(--ease-out);
}
.segment .seg-btn svg { width: 15px; height: 15px; }
.segment .seg-btn.active {
  background: var(--surface); color: var(--accent);
  box-shadow: 0 1px 2px rgba(0,0,0,0.08);
}

/* --- Canvas / page (pageless mode) ----------------------------------------*/
/* One continuous bright-white writing surface that fills the available space,
   Google-Docs "pageless" style. No floating page card or page breaks. */
.canvas {
  flex: 1 1 auto; overflow-y: auto;
  background: var(--surface);
}

.doc-page {
  background: var(--surface);
  color: var(--text);
  width: 100%;
  max-width: 900px;          /* cap line length for comfortable reading */
  margin: 0 auto;
  /* Generous side gutters that shrink gracefully on narrow screens. */
  padding: clamp(28px, 4vw, 56px) clamp(20px, 6vw, 80px) 200px;
  min-height: 100%;
  outline: none;
  font-size: 16px; line-height: 1.6;
}

/* Document typography */
.doc-page > :first-child { margin-top: 0; }
.doc-page h1.doc-title { font-size: 30px; font-weight: 600; letter-spacing: -0.02em; margin: 0 0 4px; }
.doc-page h1 { font-size: 26px; font-weight: 600; letter-spacing: -0.01em; margin: 22px 0 8px; }
.doc-page h2 { font-size: 21px; font-weight: 600; letter-spacing: -0.01em; margin: 18px 0 6px; }
.doc-page h3 { font-size: 17px; font-weight: 600; margin: 16px 0 6px; }
.doc-page p { margin: 0 0 12px; }
.doc-page a { color: var(--accent); }
.doc-page ul, .doc-page ol { margin: 0 0 12px; padding-left: 28px; }
.doc-page li { margin: 2px 0; }
.doc-page blockquote {
  margin: 0 0 12px; padding: 4px 16px; border-left: 3px solid var(--accent);
  color: var(--muted);
}
.doc-page pre {
  margin: 0 0 12px; padding: 14px 16px; background: #f3f3f1;
  border: 1px solid var(--line); border-radius: 8px; overflow-x: auto;
  font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 13.5px; line-height: 1.5;
}
.doc-page hr { border: none; border-top: 1px solid var(--line); margin: 22px 0; }
.doc-page img.doc-image {
  display: block;
  max-width: 100%;
  height: auto;
  margin: 12px 0;
  border-radius: 6px;
  cursor: pointer;
}
.doc-page img.doc-image.image-selected {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.image-controls {
  position: fixed;
  z-index: 999;
  pointer-events: none;
  border: 2px solid var(--accent);
  border-radius: 7px;
  display: none;
}
.image-controls .resize-handle {
  position: absolute;
  right: -7px;
  bottom: -7px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--accent);
  border: 2px solid var(--surface);
  box-shadow: 0 2px 8px rgba(0,0,0,0.22);
  cursor: nwse-resize;
  pointer-events: auto;
}
.drop-target {
  box-shadow: inset 0 0 0 3px rgba(225,99,46,0.28);
}
.doc-page:empty:before {
  content: "Start writing…"; color: var(--faint);
}

/* --- Link popover ---------------------------------------------------------*/
.link-pop {
  position: fixed; z-index: 1000;
  display: flex; align-items: center; gap: 6px;
  background: var(--surface); border: 1px solid var(--line-strong);
  border-radius: 8px; padding: 5px 6px 5px 11px;
  box-shadow: 0 10px 30px rgba(0,0,0,0.16), 0 2px 8px rgba(0,0,0,0.08);
  font-size: 12.5px; max-width: 380px;
  animation: cmenu-in .12s var(--ease-out);
}
.link-pop .lp-url {
  color: var(--accent); text-decoration: none;
  max-width: 210px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.link-pop .lp-url:hover { text-decoration: underline; }
.link-pop .lp-div { width: 1px; height: 18px; background: var(--line); margin: 0 2px; flex: 0 0 auto; }
.link-pop .lp-btn {
  appearance: none; background: transparent; border: 1px solid transparent;
  border-radius: 6px; color: var(--muted); cursor: pointer;
  font-size: 12px; padding: 4px 9px; white-space: nowrap;
  transition: all .14s var(--ease-out);
}
.link-pop .lp-btn:hover { background: var(--surface-2); border-color: var(--line); color: var(--text); }
.link-pop .lp-btn.lp-danger:hover { background: rgba(196,86,106,0.12); border-color: rgba(196,86,106,0.35); color: var(--bad); }

@media (max-width: 720px) {
  .title-input { width: 42vw; }
  .topbar { padding: 8px 12px; }
  .toolbar { padding: 6px 12px; }
}

html.document-export, html.document-export body {
  height: auto; background: #fff; overflow: visible;
}
html.document-export .app { display: block; height: auto; }
html.document-export .canvas { overflow: visible; }
html.document-export .doc-page {
  max-width: none;
  min-height: 0;
  padding: 0;
  font-size: 11pt;
  line-height: 1.5;
}
html.document-export .doc-page h1,
html.document-export .doc-page h2,
html.document-export .doc-page h3 { break-after: avoid-page; }
html.document-export .doc-page img,
html.document-export .doc-page pre,
html.document-export .doc-page blockquote { break-inside: avoid-page; }
html.document-export .doc-page:empty::before { content: none; }
html.document-export .doc-page img.doc-image { cursor: default; }
html.document-export .doc-page img.doc-image.image-selected { outline: none; }
@media screen {
  html.document-export body { padding: 0.65in; }
  html.document-export .app { max-width: 7.2in; margin: 0 auto; }
}

@page { margin: 0.65in; }
@media print {
  html, body { height: auto; background: #fff; overflow: visible; }
  .app { display: block; height: auto; }
  .topbar, .toolbar, .image-controls, .link-pop, .cmenu { display: none !important; }
  .canvas { overflow: visible; }
  .doc-page {
    max-width: none;
    min-height: 0;
    padding: 0;
    font-size: 11pt;
    line-height: 1.5;
  }
  .doc-page h1, .doc-page h2, .doc-page h3 { break-after: avoid-page; }
  .doc-page img, .doc-page pre, .doc-page blockquote { break-inside: avoid-page; }
  .doc-page:empty::before { content: none; }
  .doc-page img.doc-image { cursor: default; }
  .doc-page img.doc-image.image-selected { outline: none; }
}
`;
document.head.appendChild(style);

// --- Icon helper -----------------------------------------------------------
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
  highlight: '<path d="M9 11l-4 4v3h3l4-4"/><path d="M13 7l4 4"/><path d="M11 9l5-5 4 4-5 5z"/>',
  alignLeft: '<line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="14" y2="12"/><line x1="4" y1="18" x2="18" y2="18"/>',
  alignCenter: '<line x1="4" y1="6" x2="20" y2="6"/><line x1="7" y1="12" x2="17" y2="12"/><line x1="5" y1="18" x2="19" y2="18"/>',
  alignRight: '<line x1="4" y1="6" x2="20" y2="6"/><line x1="10" y1="12" x2="20" y2="12"/><line x1="6" y1="18" x2="20" y2="18"/>',
  alignJustify: '<line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/>',
  ul: '<line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/><circle cx="4.5" cy="6" r="1.2" fill="currentColor"/><circle cx="4.5" cy="12" r="1.2" fill="currentColor"/><circle cx="4.5" cy="18" r="1.2" fill="currentColor"/>',
  ol: '<line x1="10" y1="6" x2="20" y2="6"/><line x1="10" y1="12" x2="20" y2="12"/><line x1="10" y1="18" x2="20" y2="18"/><path d="M4 10V5L2.7 6" stroke-width="1.5"/><path d="M3 14.5c.4-.6 2-.6 2 .5s-2 1.4-2 2.5h2.2" stroke-width="1.5"/>',
  outdent: '<line x1="20" y1="6" x2="4" y2="6"/><line x1="20" y1="18" x2="4" y2="18"/><line x1="20" y1="12" x2="11" y2="12"/><polyline points="7 9 4 12 7 15"/>',
  indent: '<line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="18" x2="20" y2="18"/><line x1="13" y1="12" x2="20" y2="12"/><polyline points="6 9 9 12 6 15"/>',
  link: '<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5"/>',
  hr: '<line x1="4" y1="12" x2="20" y2="12"/>',
  clear: '<path d="M4 7V5h12v2"/><path d="M9 5l-2 14"/><line x1="14" y1="13" x2="20" y2="19"/><line x1="20" y1="13" x2="14" y2="19"/>',
  image: '<rect x="4" y="5" width="16" height="14" rx="2"/><circle cx="8.5" cy="9.5" r="1.4"/><path d="M20 15l-4.5-4.5L7 19"/><path d="M13 19l-3.2-3.2"/>',
};

// --- DOM helpers -----------------------------------------------------------
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c) node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

// --- Build UI --------------------------------------------------------------
const editor = el("div", { class: "doc-page", contenteditable: "true", spellcheck: "true" });

const titleInput = el("input", { class: "title-input", value: "Untitled document", "aria-label": "Document title" });
const statusDot = el("span", { class: "dot saved" });
const statusText = el("span", {}, "Saved");

const topbar = el("div", { class: "topbar" }, [
  el("div", { class: "title-wrap" }, [titleInput]),
  el("div", { class: "spacer" }),
  el("div", { class: "status", title: "Save status" }, [statusDot, statusText]),
]);

// Toolbar
function iconBtn(name, title, onClick) {
  const b = el("button", { class: "icon-btn", title, html: icon(ICONS[name]) });
  b.addEventListener("mousedown", (e) => e.preventDefault());
  b.addEventListener("click", onClick);
  return b;
}

// A toolbar group. `prio` (p1/p2/p3 or null) controls when it collapses on
// narrow screens — null groups always stay visible. The leading divider is
// part of the group so it hides together with the group.
function group(prio, items, first = false) {
  const children = first ? [] : [el("div", { class: "tdiv" })];
  children.push(...items);
  return el("div", { class: "tgroup" + (prio ? " " + prio : "") }, children);
}

// Custom dropdown matching the app's design. `options` is [{value,label,style?}].
const chevSvg = icon('<polyline points="6 9 12 15 18 9"/>');
function customSelect({ className, title, options, value, onChange }) {
  let current;
  const labelSpan = el("span", { class: "cs-label" });
  const btn = el("button", { type: "button", class: "cselect " + (className || ""), title }, [
    labelSpan, el("span", { class: "cs-chev", html: chevSvg }),
  ]);
  const menu = el("div", { class: "cmenu" });
  const items = options.map((o) => {
    const item = el("div", { class: "cmenu-item", "data-value": String(o.value) }, o.label);
    if (o.style) item.style.cssText += o.style;
    item.addEventListener("mousedown", (e) => e.preventDefault());
    item.addEventListener("click", () => { closeMenu(); setValue(o.value); onChange(o.value); });
    menu.appendChild(item);
    return item;
  });
  let open = false;

  function setValue(v) {
    if (v === current) return;          // skip redundant DOM work on hot path
    current = v;
    const opt = options.find((o) => o.value === v) || options[0];
    labelSpan.textContent = opt ? opt.label : "";
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
  function closeMenu() {
    if (menu.parentNode) menu.parentNode.removeChild(menu);
    open = false; btn.classList.remove("open");
  }
  btn.addEventListener("mousedown", (e) => { e.preventDefault(); savedRange = getRange(); });
  btn.addEventListener("click", () => { open ? closeMenu() : openMenu(); });
  document.addEventListener("mousedown", (e) => {
    if (open && !menu.contains(e.target) && !btn.contains(e.target)) closeMenu();
  });
  window.addEventListener("scroll", () => { if (open) closeMenu(); }, true);
  window.addEventListener("resize", () => { if (open) closeMenu(); });

  setValue(value);
  return { el: btn, setValue, getValue: () => current };
}

// Style selector
const styleSel = customSelect({
  className: "style-sel", title: "Paragraph style",
  options: [
    { value: "P", label: "Normal text" },
    { value: "TITLE", label: "Title" },
    { value: "H1", label: "Heading 1" },
    { value: "H2", label: "Heading 2" },
    { value: "H3", label: "Heading 3" },
    { value: "BLOCKQUOTE", label: "Quote" },
    { value: "PRE", label: "Code block" },
  ],
  value: "P",
  onChange: (value) => {
    restoreRange();
    if (value === "TITLE") {
      document.execCommand("formatBlock", false, "H1");
      const block = currentBlock();
      if (block && block.tagName === "H1") block.classList.add("doc-title");
    } else {
      const block = currentBlock();
      if (block) block.classList.remove("doc-title");
      document.execCommand("formatBlock", false, value);
    }
    editor.focus();
    scheduleSave();
  },
});

// Font family
const fontSel = customSelect({
  className: "font-sel", title: "Font",
  options: [
    ["Sans serif", "ui-sans-serif, system-ui, Inter, sans-serif"],
    ["Serif", "Georgia, 'Times New Roman', serif"],
    ["Mono", "ui-monospace, 'SF Mono', Menlo, monospace"],
    ["Inter", "Inter, system-ui, sans-serif"],
    ["Georgia", "Georgia, serif"],
    ["Courier", "'Courier New', monospace"],
  ].map(([label, val]) => ({ value: val, label, style: "font-family:" + val + ";" })),
  value: "ui-sans-serif, system-ui, Inter, sans-serif",
  onChange: (value) => {
    restoreRange();
    document.execCommand("fontName", false, value);
    editor.focus();
    scheduleSave();
  },
});

// Font size
const sizeSel = customSelect({
  className: "size-sel", title: "Font size",
  options: [11, 12, 13, 14, 16, 18, 20, 24, 28, 32, 40, 48].map((s) => ({ value: s, label: String(s) })),
  value: 16,
  onChange: (value) => {
    restoreRange();
    applyFontSize(parseInt(value, 10));
    editor.focus();
    scheduleSave();
  },
});

function applyFontSize(px) {
  document.execCommand("fontSize", false, "7");
  editor.querySelectorAll('font[size="7"]').forEach((f) => {
    f.removeAttribute("size");
    f.style.fontSize = px + "px";
  });
}

// Simple command buttons
function cmdBtn(name, title, command, value = null) {
  return iconBtn(name, title, () => {
    document.execCommand(command, false, value);
    editor.focus();
    refreshToolbarState();
    scheduleSave();
  });
}

const boldBtn = cmdBtn("bold", "Bold (Ctrl+B)", "bold");
const italicBtn = cmdBtn("italic", "Italic (Ctrl+I)", "italic");
const underlineBtn = cmdBtn("underline", "Underline (Ctrl+U)", "underline");
const strikeBtn = cmdBtn("strike", "Strikethrough", "strikeThrough");

// Color buttons (text + highlight)
function colorBtn(name, title, command, defaultColor) {
  const bar = el("span", { class: "bar" });
  bar.style.background = defaultColor;
  const input = el("input", { type: "color", value: defaultColor });
  const btn = el("div", { class: "color-btn", title }, [
    el("span", { html: icon(ICONS[name]) }),
    bar,
    input,
  ]);
  btn.addEventListener("mousedown", (e) => { e.preventDefault(); savedRange = getRange(); });
  input.addEventListener("input", () => {
    bar.style.background = input.value;
    restoreRange();
    document.execCommand(command, false, input.value);
    editor.focus();
    scheduleSave();
  });
  return btn;
}
const textColorBtn = colorBtn("textcolor", "Text color", "foreColor", "#1d1d20");
const highlightBtn = colorBtn("highlight", "Highlight color", "hiliteColor", "#fff3a3");

// Alignment segmented control
const alignBtns = {};
function segBtn(name, title, command) {
  const b = el("button", { class: "seg-btn", title, html: icon(ICONS[name]) });
  b.addEventListener("mousedown", (e) => e.preventDefault());
  b.addEventListener("click", () => {
    document.execCommand(command, false, null);
    editor.focus();
    refreshToolbarState();
    scheduleSave();
  });
  return b;
}
alignBtns.left = segBtn("alignLeft", "Align left", "justifyLeft");
alignBtns.center = segBtn("alignCenter", "Align center", "justifyCenter");
alignBtns.right = segBtn("alignRight", "Align right", "justifyRight");
alignBtns.justify = segBtn("alignJustify", "Justify", "justifyFull");
const alignSegment = el("div", { class: "segment" }, [alignBtns.left, alignBtns.center, alignBtns.right, alignBtns.justify]);

const ulBtn = cmdBtn("ul", "Bulleted list", "insertUnorderedList");
const olBtn = cmdBtn("ol", "Numbered list", "insertOrderedList");
const outdentBtn = cmdBtn("outdent", "Decrease indent", "outdent");
const indentBtn = cmdBtn("indent", "Increase indent", "indent");

const linkBtn = iconBtn("link", "Insert link", () => insertLink());
const imageInput = el("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/gif", multiple: "true" });
imageInput.style.display = "none";
document.body.appendChild(imageInput);
const imageBtn = iconBtn("image", "Insert image", () => {
  savedRange = getRange();
  imageInput.value = "";
  imageInput.click();
});
imageInput.addEventListener("change", () => insertImageFiles(Array.from(imageInput.files || [])));
const hrBtn = cmdBtn("hr", "Horizontal line", "insertHorizontalRule");
const clearBtn = iconBtn("clear", "Clear formatting", () => {
  document.execCommand("removeFormat", false, null);
  const block = currentBlock();
  if (block) block.classList.remove("doc-title");
  document.execCommand("formatBlock", false, "P");
  editor.focus();
  refreshToolbarState();
  scheduleSave();
});

const undoBtn = iconBtn("undo", "Undo (Ctrl+Z)", () => { document.execCommand("undo"); editor.focus(); scheduleSave(); });
const redoBtn = iconBtn("redo", "Redo (Ctrl+Y)", () => { document.execCommand("redo"); editor.focus(); scheduleSave(); });

const toolbar = el("div", { class: "toolbar" }, [
  group(null, [undoBtn, redoBtn], true),     // always
  group(null, [styleSel.el]),                 // always
  group("p2", [fontSel.el, sizeSel.el]),
  group(null, [boldBtn, italicBtn, underlineBtn, strikeBtn]), // always
  group("p2", [textColorBtn, highlightBtn]),
  group("p1", [alignSegment]),
  group("p1", [ulBtn, olBtn]),
  group("p3", [outdentBtn, indentBtn]),
  group("p2", [linkBtn, imageBtn]),
  group("p3", [hrBtn, clearBtn]),
]);

const canvas = el("div", { class: "canvas" }, [editor]);
const app = el("div", { class: "app" }, [topbar, toolbar, canvas]);
document.body.appendChild(app);

// --- Selection helpers -----------------------------------------------------
let savedRange = null;
function getRange() {
  const sel = window.getSelection();
  if (sel && sel.rangeCount && editor.contains(sel.anchorNode)) return sel.getRangeAt(0).cloneRange();
  return null;
}
function restoreRange() {
  if (!savedRange) return;
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(savedRange);
}
function currentBlock() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  let node = sel.anchorNode;
  while (node && node !== editor) {
    if (node.nodeType === 1 && /^(P|H1|H2|H3|H4|BLOCKQUOTE|PRE|LI|DIV)$/.test(node.tagName)) return node;
    node = node.parentNode;
  }
  return null;
}

// The <a> element containing the current selection, if any.
function currentLink() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  let node = sel.anchorNode;
  while (node && node !== editor) {
    if (node.nodeType === 1 && node.tagName === "A") return node;
    node = node.parentNode;
  }
  return null;
}

function selectNode(node) {
  const range = document.createRange();
  range.selectNode(node);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function normalizeHref(url) {
  let href = (url || "").trim();
  if (href && !/^(https?:|mailto:|tel:|#|\/)/i.test(href)) href = "https://" + href;
  return href;
}

function escapeAttr(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

// --- Images ---------------------------------------------------------------
// Images are embedded as compressed data URLs inside the document HTML. This is
// the most reliable option in the Gadget sandbox: local drag/drop, file picker,
// screenshots, and clipboard images all keep working after reload and multi-client sync.
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_IMAGE_DIMENSION = 1600;
const IMAGE_QUALITY = 0.86;

function isImageFile(file) {
  return file && IMAGE_TYPES.has(file.type);
}

function isSafeImageDataUrl(src) {
  return /^data:image\/(png|jpe?g|webp|gif);base64,/i.test(src || "");
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not load image"));
    img.src = src;
  });
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("Could not read image"));
    reader.readAsDataURL(file);
  });
}

async function fileToImageDataUrl(file) {
  const original = await readFileAsDataURL(file);
  const img = await loadImage(original);
  let width = img.naturalWidth || img.width;
  let height = img.naturalHeight || img.height;
  const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(width, height));
  width = Math.max(1, Math.round(width * scale));
  height = Math.max(1, Math.round(height * scale));

  // GIFs may be animated; canvas would flatten them. Preserve reasonably-sized
  // GIFs, otherwise make a static optimized preview so storage stays sane.
  if (file.type === "image/gif" && scale === 1 && file.size < 2_000_000) {
    return { src: original, width, height, alt: file.name || "Image" };
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, width, height);
  let src;
  try {
    src = canvas.toDataURL("image/webp", IMAGE_QUALITY);
    if (!src.startsWith("data:image/webp")) throw new Error("WebP unsupported");
  } catch (e) {
    src = canvas.toDataURL("image/jpeg", IMAGE_QUALITY);
  }
  return { src, width, height, alt: file.name || "Image" };
}

function insertImageDataUrl({ src, width, alt }) {
  if (!isSafeImageDataUrl(src)) return;
  restoreRange();
  const displayWidth = Math.min(width || 520, Math.max(240, editor.clientWidth - 40));
  const html = `<img class="doc-image" draggable="true" src="${src}" alt="${escapeAttr(alt || "Image")}" style="width:${Math.round(displayWidth)}px;height:auto;">`;
  document.execCommand("insertHTML", false, html);
  savedRange = getRange();
}

async function insertImageFiles(files) {
  const imageFiles = files.filter(isImageFile);
  if (!imageFiles.length) return;
  hideLinkPopover();
  hideImageControls();
  setStatus("saving", "Processing image…");
  try {
    for (const file of imageFiles) {
      const data = await fileToImageDataUrl(file);
      insertImageDataUrl(data);
    }
    editor.focus();
    refreshToolbarState();
    scheduleSave();
  } catch (e) {
    setStatus("bad", "Image failed");
  }
}

function imageFilesFromDataTransfer(dt) {
  if (!dt) return [];
  const files = Array.from(dt.files || []).filter(isImageFile);
  if (files.length) return files;
  return Array.from(dt.items || [])
    .filter((item) => item.kind === "file" && IMAGE_TYPES.has(item.type))
    .map((item) => item.getAsFile())
    .filter(isImageFile);
}

function setCaretFromPoint(x, y) {
  let range = null;
  if (document.caretRangeFromPoint) {
    range = document.caretRangeFromPoint(x, y);
  } else if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(x, y);
    if (pos) {
      range = document.createRange();
      range.setStart(pos.offsetNode, pos.offset);
      range.collapse(true);
    }
  }
  if (!range || !editor.contains(range.startContainer)) {
    range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
  }
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  savedRange = range.cloneRange();
}

let selectedImage = null;
let resizingImage = false;
let draggedImage = null;
const imageControls = el("div", { class: "image-controls" }, [el("div", { class: "resize-handle" })]);
document.body.appendChild(imageControls);
const resizeHandle = imageControls.querySelector(".resize-handle");

function positionImageControls() {
  if (!selectedImage || !editor.contains(selectedImage) || resizingImage) return;
  const r = selectedImage.getBoundingClientRect();
  imageControls.style.left = Math.round(r.left) + "px";
  imageControls.style.top = Math.round(r.top) + "px";
  imageControls.style.width = Math.round(r.width) + "px";
  imageControls.style.height = Math.round(r.height) + "px";
  imageControls.style.display = "block";
}

function selectImage(img) {
  if (selectedImage === img) {
    positionImageControls();
    return;
  }
  hideLinkPopover();
  if (selectedImage) selectedImage.classList.remove("image-selected");
  selectedImage = img;
  selectedImage.classList.add("image-selected");
  positionImageControls();
}

function hideImageControls() {
  if (selectedImage) selectedImage.classList.remove("image-selected");
  selectedImage = null;
  imageControls.style.display = "none";
}

resizeHandle.addEventListener("mousedown", (e) => {
  if (!selectedImage) return;
  e.preventDefault();
  e.stopPropagation();
  resizingImage = true;
  const img = selectedImage;
  const startX = e.clientX;
  const startWidth = img.getBoundingClientRect().width;
  const editorWidth = editor.getBoundingClientRect().width;
  imageControls.style.display = "none";

  const move = (ev) => {
    const next = Math.max(80, Math.min(editorWidth, startWidth + ev.clientX - startX));
    img.style.width = Math.round(next) + "px";
    img.style.height = "auto";
  };
  const up = () => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
    resizingImage = false;
    positionImageControls();
    scheduleSave();
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
});

editor.addEventListener("click", (e) => {
  const img = e.target.closest && e.target.closest("img.doc-image");
  if (img && editor.contains(img)) selectImage(img);
  else hideImageControls();
});

editor.addEventListener("dragstart", (e) => {
  const img = e.target.closest && e.target.closest("img.doc-image");
  if (!img || !editor.contains(img)) return;
  draggedImage = img;
  selectImage(img);
  hideImageControls();
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = "move";
    // Mark this as an internal move. Without this, contenteditable/browser
    // defaults expose the image as HTML and our drop sanitizer inserts a copy.
    e.dataTransfer.setData("application/x-doc-image-move", "1");
    e.dataTransfer.setData("text/plain", "");
    try { e.dataTransfer.setDragImage(img, Math.min(20, img.width / 2), Math.min(20, img.height / 2)); } catch (err) {}
  }
});

editor.addEventListener("dragend", () => {
  draggedImage = null;
  editor.classList.remove("drop-target");
  if (selectedImage) positionImageControls();
});

editor.addEventListener("dragover", (e) => {
  const types = Array.from((e.dataTransfer && e.dataTransfer.types) || []);
  if (draggedImage || imageFilesFromDataTransfer(e.dataTransfer).length || types.includes("Files") || types.includes("text/html") || types.includes("text/plain")) {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = draggedImage ? "move" : "copy";
    editor.classList.add("drop-target");
  }
});
editor.addEventListener("dragleave", () => editor.classList.remove("drop-target"));
editor.addEventListener("drop", (e) => {
  editor.classList.remove("drop-target");

  // Internal image moves must be handled before file/html drops. Otherwise the
  // browser's contenteditable drag payload looks like pasted HTML and creates a
  // duplicate image instead of moving the original.
  if (draggedImage && editor.contains(draggedImage)) {
    e.preventDefault();
    const img = draggedImage;
    draggedImage = null;
    setCaretFromPoint(e.clientX, e.clientY);
    const range = getRange();
    if (range) {
      range.insertNode(img); // insertNode moves an existing node; it doesn't clone.
      const after = document.createRange();
      after.setStartAfter(img);
      after.collapse(true);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(after);
      savedRange = after.cloneRange();
    }
    selectImage(img);
    scheduleSave();
    return;
  }

  const files = imageFilesFromDataTransfer(e.dataTransfer);
  if (files.length) {
    e.preventDefault();
    setCaretFromPoint(e.clientX, e.clientY);
    insertImageFiles(files);
    return;
  }
  // Sanitize HTML/text drops too, so dragging content from another document or
  // chat app doesn't bypass the paste sanitizer.
  const html = e.dataTransfer && e.dataTransfer.getData("text/html");
  const text = e.dataTransfer && e.dataTransfer.getData("text/plain");
  if ((html && html.trim()) || text) {
    e.preventDefault();
    setCaretFromPoint(e.clientX, e.clientY);
    if (html && html.trim()) document.execCommand("insertHTML", false, sanitizePastedHtml(html));
    else document.execCommand("insertHTML", false, escapeText(text).replace(/\r?\n/g, "<br>"));
    refreshToolbarState();
    scheduleSave();
  }
});

window.addEventListener("scroll", () => { if (selectedImage) positionImageControls(); }, true);
window.addEventListener("resize", () => { if (selectedImage) positionImageControls(); });

function sanitizeImageElement(srcImg) {
  const src = srcImg.getAttribute("src") || "";
  // Persist only embedded images. External/blob URLs are not reliable after
  // reload in the Gadget sandbox, and blob: URLs vanish immediately.
  if (!isSafeImageDataUrl(src)) return null;
  const img = document.createElement("img");
  img.className = "doc-image";
  img.draggable = true;
  img.src = src;
  img.alt = srcImg.getAttribute("alt") || "Image";
  const styleWidth = (srcImg.getAttribute("style") || "").match(/width\s*:\s*([0-9.]+)px/i);
  const attrWidth = parseInt(srcImg.getAttribute("width") || "", 10);
  const width = styleWidth ? parseFloat(styleWidth[1]) : attrWidth;
  if (width && width > 0) img.style.width = Math.min(900, Math.max(40, Math.round(width))) + "px";
  img.style.height = "auto";
  return img;
}

// The link button: edit the link under the cursor if there is one, else create.
async function insertLink() {
  const existing = currentLink();
  if (existing) return editLink(existing);
  savedRange = getRange();
  const url = await promptInline("Enter URL:");
  if (!url) return;
  restoreRange();
  document.execCommand("createLink", false, normalizeHref(url));
  editor.focus();
  scheduleSave();
}

async function editLink(anchor) {
  const url = await promptInline("Edit URL:", anchor.getAttribute("href") || "");
  if (url === null) return;
  selectNode(anchor);
  if (url.trim() === "") {
    document.execCommand("unlink", false, null);
  } else {
    document.execCommand("createLink", false, normalizeHref(url));
  }
  hideLinkPopover();
  editor.focus();
  scheduleSave();
}

// Strip the link, keeping its text.
function removeLink(anchor) {
  selectNode(anchor);
  document.execCommand("unlink", false, null);
  hideLinkPopover();
  editor.focus();
  scheduleSave();
}

// --- Link popover (Google-Docs style) --------------------------------------
let activeLink = null;
const linkPopUrl = el("a", { class: "lp-url", target: "_blank", rel: "noopener noreferrer" });
const linkPopEdit = el("button", { class: "lp-btn" }, "Edit");
const linkPopRemove = el("button", { class: "lp-btn lp-danger" }, "Remove link");
const linkPop = el("div", { class: "link-pop" }, [
  linkPopUrl, el("span", { class: "lp-div" }), linkPopEdit, linkPopRemove,
]);
linkPop.style.display = "none";
// Don't let clicks inside the popover collapse the editor selection.
linkPop.addEventListener("mousedown", (e) => { if (e.target !== linkPopUrl) e.preventDefault(); });
linkPopEdit.addEventListener("click", () => { if (activeLink) editLink(activeLink); });
linkPopRemove.addEventListener("click", () => { if (activeLink) removeLink(activeLink); });
document.body.appendChild(linkPop);

function positionLinkPopover(anchor) {
  const r = anchor.getBoundingClientRect();
  linkPop.style.visibility = "hidden";
  linkPop.style.display = "flex";
  const pw = linkPop.offsetWidth, ph = linkPop.offsetHeight;
  let left = Math.round(r.left);
  left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));
  let top = Math.round(r.bottom + 6);
  if (top + ph > window.innerHeight - 8) top = Math.round(r.top - ph - 6);
  linkPop.style.left = left + "px";
  linkPop.style.top = top + "px";
  linkPop.style.visibility = "visible";
}

function showLinkPopover(anchor) {
  activeLink = anchor;
  const href = anchor.getAttribute("href") || "";
  linkPopUrl.textContent = href.replace(/^mailto:/i, "");
  linkPopUrl.setAttribute("href", href);
  positionLinkPopover(anchor);
}

function hideLinkPopover() {
  activeLink = null;
  linkPop.style.display = "none";
}

function updateLinkPopover() {
  const a = currentLink();
  if (a && editor.contains(a)) showLinkPopover(a);
  else hideLinkPopover();
}

window.addEventListener("scroll", () => { if (activeLink) positionLinkPopover(activeLink); }, true);
window.addEventListener("resize", () => { if (activeLink) positionLinkPopover(activeLink); });

// Inline prompt (alert/prompt are blocked in the sandbox iframe)
function promptInline(message, def = "") {
  return new Promise((resolve) => {
    const overlay = el("div", {}, []);
    Object.assign(overlay.style, {
      position: "fixed", inset: "0", display: "flex", alignItems: "center",
      justifyContent: "center", background: "rgba(20,20,25,0.35)",
      backdropFilter: "blur(5px)", zIndex: "1000",
    });
    const input = el("input", { value: def, placeholder: "https://" });
    Object.assign(input.style, {
      width: "100%", padding: "8px 10px", fontSize: "13.5px",
      border: "1px solid var(--line-strong)", borderRadius: "6px",
      background: "var(--bg)", color: "var(--text)", outline: "none",
    });
    const ok = el("button", {}, "Insert");
    const cancel = el("button", {}, "Cancel");
    for (const b of [ok, cancel]) Object.assign(b.style, {
      padding: "6px 12px", fontSize: "13px", borderRadius: "6px",
      border: "1px solid var(--line)", background: "var(--surface)",
      color: "var(--text)", cursor: "pointer",
    });
    Object.assign(ok.style, { background: "var(--accent)", color: "#fff", borderColor: "var(--accent)" });
    const card = el("div", {}, [
      el("div", { html: message }), input,
      el("div", {}, [cancel, ok]),
    ]);
    Object.assign(card.style, {
      background: "var(--surface)", border: "1px solid var(--line)", borderRadius: "10px",
      padding: "16px", width: "min(420px, 90vw)", display: "flex", flexDirection: "column",
      gap: "12px", boxShadow: "0 12px 40px rgba(0,0,0,0.25)",
    });
    card.lastChild.style.display = "flex";
    card.lastChild.style.justifyContent = "flex-end";
    card.lastChild.style.gap = "8px";
    card.firstChild.style.fontSize = "13px";
    card.firstChild.style.color = "var(--muted)";
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    input.focus();
    const done = (val) => { overlay.remove(); resolve(val); };
    ok.addEventListener("click", () => done(input.value));
    cancel.addEventListener("click", () => done(null));
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) done(null); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") done(input.value);
      if (e.key === "Escape") done(null);
    });
  });
}

// --- Paste sanitizer -------------------------------------------------------
// Pasted content (especially from Google Docs / Word) carries formatting in
// inline `style` attributes and non-semantic <span>/<font> wrappers — which
// the toolbar commands (bold/underline/link…) can't toggle or remove. We
// rebuild pasted HTML into clean semantic markup so it behaves like text the
// editor created itself.
const INLINE_ONLY = ["code", "s", "u", "i", "b"];
function wrapEl(tag, child) { const e = document.createElement(tag); e.appendChild(child); return e; }

function fmtOf(elem, ctx) {
  const cs = ((elem.getAttribute && elem.getAttribute("style")) || "").toLowerCase();
  const tag = elem.tagName;
  const n = Object.assign({}, ctx);
  if (tag === "B" || tag === "STRONG") n.bold = true;
  if (tag === "I" || tag === "EM") n.italic = true;
  if (tag === "U" || tag === "INS") n.underline = true;
  if (tag === "S" || tag === "STRIKE" || tag === "DEL") n.strike = true;
  if (tag === "CODE" || tag === "TT") n.code = true;
  if (tag === "A") n.link = elem.getAttribute("href") || ctx.link;
  // Inline styles override tag defaults (Google wraps everything in
  // <b style="font-weight:normal">, so we must honor the style).
  if (/font-weight:\s*(bold|[6-9]00)/.test(cs)) n.bold = true;
  else if (/font-weight:\s*(normal|[1-4]00)/.test(cs)) n.bold = false;
  if (/font-style:\s*italic/.test(cs)) n.italic = true;
  else if (/font-style:\s*normal/.test(cs)) n.italic = false;
  if (/text-decoration[^;]*underline/.test(cs)) n.underline = true;
  if (/text-decoration[^;]*line-through/.test(cs)) n.strike = true;
  return n;
}

function wrapInline(text, ctx) {
  let node = document.createTextNode(text);
  if (ctx.code) node = wrapEl("code", node);
  if (ctx.strike) node = wrapEl("s", node);
  if (ctx.underline) node = wrapEl("u", node);
  if (ctx.italic) node = wrapEl("i", node);
  if (ctx.bold) node = wrapEl("b", node);
  if (ctx.link) {
    let href = ctx.link.trim();
    if (href && !/^(https?:|mailto:|tel:|#|\/)/i.test(href)) href = "https://" + href;
    const a = document.createElement("a");
    a.setAttribute("href", href);
    a.appendChild(node);
    node = a;
  }
  return node;
}

const BLOCK_TAGS = ["P", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "PRE", "UL", "OL", "LI", "DIV"];

function sanitizePastedHtml(html) {
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  const result = document.createElement("div");

  function appendInline(src, target, ctx) {
    src.childNodes.forEach((child) => {
      if (child.nodeType === 3) {
        if (child.textContent) target.appendChild(wrapInline(child.textContent, ctx));
      } else if (child.nodeType === 1) {
        const tag = child.tagName;
        if (tag === "BR") target.appendChild(document.createElement("br"));
        else if (tag === "IMG") {
          const img = sanitizeImageElement(child);
          if (img) target.appendChild(img);
        }
        else if (tag === "HR" || tag === "STYLE" || tag === "SCRIPT") return;
        else appendInline(child, target, fmtOf(child, ctx));
      }
    });
  }

  function processList(src, ctx) {
    const list = document.createElement(src.tagName === "OL" ? "ol" : "ul");
    src.childNodes.forEach((child) => {
      if (child.nodeType !== 1) return;
      if (child.tagName === "LI") {
        const li = document.createElement("li");
        const nested = [];
        child.childNodes.forEach((g) => {
          if (g.nodeType === 1 && (g.tagName === "UL" || g.tagName === "OL")) nested.push(g);
          else if (g.nodeType === 3) { if (g.textContent) li.appendChild(wrapInline(g.textContent, ctx)); }
          else if (g.nodeType === 1) appendInline(g, li, fmtOf(g, ctx));
        });
        nested.forEach((n) => li.appendChild(processList(n, ctx)));
        list.appendChild(li);
      } else if (child.tagName === "UL" || child.tagName === "OL") {
        list.appendChild(processList(child, ctx));
      }
    });
    return list;
  }

  function processNodes(nodes, ctx) {
    nodes.forEach((node) => {
      if (node.nodeType === 3) {
        if (node.textContent && node.textContent.trim()) {
          const p = document.createElement("p");
          p.appendChild(wrapInline(node.textContent, ctx));
          result.appendChild(p);
        }
        return;
      }
      if (node.nodeType !== 1) return;
      const tag = node.tagName;
      if (tag === "STYLE" || tag === "SCRIPT" || tag === "META" || tag === "BR") return;
      if (tag === "HR") { result.appendChild(document.createElement("hr")); return; }
      if (tag === "IMG") {
        const img = sanitizeImageElement(node);
        if (img) {
          const p = document.createElement("p");
          p.appendChild(img);
          result.appendChild(p);
        }
        return;
      }
      if (tag === "UL" || tag === "OL") { result.appendChild(processList(node, ctx)); return; }
      if (["P", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "PRE"].includes(tag)) {
        let out = tag.toLowerCase();
        if (out === "h4" || out === "h5" || out === "h6") out = "h3";
        const block = document.createElement(out);
        appendInline(node, block, ctx);
        if (block.textContent.trim() || block.querySelector("br")) result.appendChild(block);
        return;
      }
      // Wrapper (DIV/SPAN/FONT/B-wrapper…): descend if it holds blocks,
      // otherwise treat its inline content as a paragraph.
      const newCtx = fmtOf(node, ctx);
      const hasBlockChild = Array.from(node.childNodes).some(
        (c) => c.nodeType === 1 && BLOCK_TAGS.includes(c.tagName));
      if (hasBlockChild) {
        processNodes(Array.from(node.childNodes), newCtx);
      } else {
        const p = document.createElement("p");
        appendInline(node, p, newCtx);
        if (p.textContent.trim() || p.querySelector("br")) result.appendChild(p);
      }
    });
  }

  processNodes(Array.from(tpl.content.childNodes), {});
  return result.innerHTML;
}

function escapeText(t) {
  return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}


editor.addEventListener("paste", (e) => {
  const cb = e.clipboardData;
  if (!cb) return;
  const imageFiles = imageFilesFromDataTransfer(cb);
  if (imageFiles.length) {
    e.preventDefault();
    savedRange = getRange();
    insertImageFiles(imageFiles);
    return;
  }
  e.preventDefault();
  const html = cb.getData("text/html");
  if (html && html.trim()) {
    document.execCommand("insertHTML", false, sanitizePastedHtml(html));
  } else {
    const text = cb.getData("text/plain") || "";
    document.execCommand("insertHTML", false, escapeText(text).replace(/\r?\n/g, "<br>"));
  }
  refreshToolbarState();
  scheduleSave();
});

// --- Toolbar live state ----------------------------------------------------
function refreshToolbarState() {
  const set = (btn, on) => btn.classList.toggle("active", on);
  try {
    set(boldBtn, document.queryCommandState("bold"));
    set(italicBtn, document.queryCommandState("italic"));
    set(underlineBtn, document.queryCommandState("underline"));
    set(strikeBtn, document.queryCommandState("strikeThrough"));
    set(ulBtn, document.queryCommandState("insertUnorderedList"));
    set(olBtn, document.queryCommandState("insertOrderedList"));
    alignBtns.left.classList.toggle("active", document.queryCommandState("justifyLeft"));
    alignBtns.center.classList.toggle("active", document.queryCommandState("justifyCenter"));
    alignBtns.right.classList.toggle("active", document.queryCommandState("justifyRight"));
    alignBtns.justify.classList.toggle("active", document.queryCommandState("justifyFull"));
  } catch (e) {}
  // Style selector
  const block = currentBlock();
  if (block) {
    let tag = block.tagName;
    if (tag === "LI" || tag === "DIV") tag = "P";
    if (tag === "H1" && block.classList.contains("doc-title")) tag = "TITLE";
    styleSel.setValue(["P", "TITLE", "H1", "H2", "H3", "BLOCKQUOTE", "PRE"].includes(tag) ? tag : "P");
  }
}

// selectionchange fires on every keystroke and cursor move. Coalesce the work
// (layout-forcing queryCommandState calls, DOM walks, popover positioning) into
// a single rAF so a burst collapses to at most one refresh per frame.
let selUpdateQueued = false;
function scheduleSelectionUpdate() {
  if (selUpdateQueued) return;
  selUpdateQueued = true;
  requestAnimationFrame(() => {
    selUpdateQueued = false;
    refreshToolbarState();
    updateLinkPopover();
  });
}
document.addEventListener("selectionchange", () => {
  if (editor.contains(window.getSelection().anchorNode)) scheduleSelectionUpdate();
});

// --- Real-time block collaboration ----------------------------------------
// The document is persisted as versioned top-level blocks. Typing remains
// optimistic in the local contenteditable; only changed blocks cross RPC.
const realtimeCss = `
.remote-caret-layer { position:fixed; inset:0; z-index:998; pointer-events:none; }
.remote-selection { position:fixed; border-radius:2px; opacity:.22; }
.remote-caret { position:fixed; width:2px; min-height:18px; border-radius:2px; }
.remote-caret-label { position:absolute; left:0; bottom:100%; padding:2px 5px; border-radius:4px 4px 4px 0;
  color:white; font-size:10px; font-weight:650; white-space:nowrap; transform:translateY(-2px); }
`;
style.textContent += realtimeCss;
const remoteCaretLayer = el("div", { class: "remote-caret-layer", "aria-hidden": "true" });
document.body.appendChild(remoteCaretLayer);

const collaboratorName = "Guest " + clientId.slice(0, 4).toUpperCase();
const collaboratorColor = `hsl(${parseInt(clientId.slice(0, 6), 36) % 360} 62% 48%)`;
let saveTimer = null;
let saveInFlight = false;
let saveAgain = false;
let applyingRemote = false;
let revision = 0;
let acknowledgedTitle = "Untitled document";
const acknowledged = new Map(); // id -> {html, version}
const pendingByBlock = new Map();
const collaborators = new Map();

let curStatusKind = null, curStatusText = null;
function setStatus(kind, text) {
  if (kind === curStatusKind && text === curStatusText) return;
  curStatusKind = kind; curStatusText = text;
  statusDot.className = "dot " + kind;
  statusText.textContent = text;
}

function newBlockId() {
  if (globalThis.crypto?.randomUUID) return "b_" + crypto.randomUUID();
  return "b_" + Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function blockId(node) { return node?.nodeType === 1 ? node.getAttribute("data-block-id") : null; }
function findBlock(id) {
  return Array.from(editor.children).find((node) => blockId(node) === id) || null;
}
function activeBlockId() {
  const sel = window.getSelection();
  let node = sel?.anchorNode;
  if (!node || !editor.contains(node)) return null;
  if (node.nodeType !== 1) node = node.parentElement;
  while (node && node.parentElement !== editor) node = node.parentElement;
  return node && node.parentElement === editor ? blockId(node) : null;
}

// contenteditable can create bare text/BR nodes at the root. Convert those to
// paragraphs and guarantee unique stable IDs before serialization.
function normalizeBlocks() {
  const selectionBlock = activeBlockId();
  for (const node of Array.from(editor.childNodes)) {
    if (node.nodeType === 3 || (node.nodeType === 1 && node.tagName === "BR")) {
      const p = document.createElement("p");
      if (node.nodeType === 3) p.textContent = node.textContent;
      else p.appendChild(document.createElement("br"));
      editor.replaceChild(p, node);
    }
  }
  const seen = new Set();
  for (const node of Array.from(editor.children)) {
    let id = blockId(node);
    if (!id || seen.has(id)) {
      id = newBlockId();
      node.setAttribute("data-block-id", id);
    }
    seen.add(id);
  }
  // Merely adding attributes preserves the selection; wrapping a rare root text
  // node may not. Put the caret back at the end of its old block when possible.
  if (selectionBlock && !activeBlockId()) {
    const node = findBlock(selectionBlock);
    if (node) {
      const range = document.createRange(); range.selectNodeContents(node); range.collapse(false);
      const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
    }
  }
}

function canonicalBlockHtml(node) {
  // Presence decoration is ephemeral UI and must never enter persisted HTML.
  const clone = node.cloneNode(true);
  clone.classList.remove("remote-editing");
  clone.style.removeProperty("--remote-color");
  clone.querySelectorAll(".remote-editing").forEach((child) => {
    child.classList.remove("remote-editing"); child.style.removeProperty("--remote-color");
  });
  clone.querySelectorAll(".image-selected").forEach((image) => image.classList.remove("image-selected"));
  return clone.outerHTML;
}
function serializeBlocks() {
  normalizeBlocks();
  return Array.from(editor.children).map((node) => ({ id: blockId(node), html: canonicalBlockHtml(node) }));
}
function parseBlock(block) {
  const tpl = document.createElement("template");
  tpl.innerHTML = block.html;
  const node = tpl.content.firstElementChild || document.createElement("p");
  node.setAttribute("data-block-id", block.id);
  return node;
}

function scheduleSave(delay = 220) {
  if (applyingRemote) return;
  setStatus("saving", "Saving…");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(doSave, delay);
}

async function doSave() {
  clearTimeout(saveTimer);
  if (saveInFlight) { saveAgain = true; return; }
  const blocks = serializeBlocks();
  const currentIds = new Set(blocks.map((b) => b.id));
  const upserts = blocks
    .filter((block) => acknowledged.get(block.id)?.html !== block.html)
    .map((block) => ({ ...block, baseVersion: acknowledged.get(block.id)?.version || 0 }));
  const deletes = Array.from(acknowledged.entries())
    .filter(([id]) => !currentIds.has(id))
    .map(([id, block]) => ({ id, baseVersion: block.version }));
  const title = titleInput.value.trim() || "Untitled document";
  if (!upserts.length && !deletes.length && title === acknowledgedTitle) {
    setStatus("saved", "Saved");
    return;
  }

  saveInFlight = true;
  try {
    const result = await gadget.applyOperation({
      senderId: clientId, baseRevision: revision, upserts, deletes,
      order: blocks.map((b) => b.id), title,
    });
    revision = Math.max(revision, result.revision || 0);
    for (const block of result.upserts || []) acknowledged.set(block.id, { html: block.html, version: block.version });
    for (const id of result.deletedIds || []) acknowledged.delete(id);
    acknowledgedTitle = result.title || title;

    if (result.conflicts?.length) {
      // Keep the local draft visible, but rebase its next operation on the latest
      // authoritative block version. The next save intentionally preserves mine.
      for (const block of result.conflicts) acknowledged.set(block.id, { html: block.html, version: block.version });
      setStatus("synced", "Resolving concurrent edit…");
      saveAgain = true;
    } else {
      setStatus("saved", "Saved");
    }
  } catch (e) {
    setStatus("bad", "Save failed");
  } finally {
    saveInFlight = false;
    const latest = serializeBlocks();
    const stillDirty = latest.some((b) => acknowledged.get(b.id)?.html !== b.html) ||
      latest.length !== acknowledged.size ||
      (titleInput.value.trim() || "Untitled document") !== acknowledgedTitle;
    if (saveAgain || stillDirty) {
      saveAgain = false;
      scheduleSave(40);
    }
  }
}

editor.addEventListener("input", () => {
  if (selectedImage && !editor.contains(selectedImage)) hideImageControls();
  else if (selectedImage) positionImageControls();
  scheduleSave();
  schedulePresence();
});
titleInput.addEventListener("input", scheduleSave);

try { document.execCommand("styleWithCSS", false, true); } catch (e) {}
try { document.execCommand("defaultParagraphSeparator", false, "p"); } catch (e) {}

function applyOrder(order) {
  // Move only nodes that are actually out of place. Re-appending every block
  // would unnecessarily disturb a live Selection in the active block.
  let position = 0;
  for (const id of order || []) {
    const node = findBlock(id);
    if (!node) continue;
    const atPosition = editor.children[position];
    if (atPosition !== node) editor.insertBefore(node, atPosition || null);
    position++;
  }
}

function applyRemoteOperation(event) {
  if (!event || event.senderId === clientId) return;
  applyingRemote = true;
  revision = Math.max(revision, event.revision || 0);
  const activeId = activeBlockId();

  for (const block of event.upserts || []) {
    acknowledged.set(block.id, { html: block.html, version: block.version });
    if (block.id === activeId) {
      pendingByBlock.set(block.id, { type: "upsert", block });
      continue;
    }
    const old = findBlock(block.id);
    const next = parseBlock(block);
    if (old) old.replaceWith(next); else editor.appendChild(next);
  }
  for (const id of event.deletedIds || []) {
    acknowledged.delete(id);
    if (id === activeId) pendingByBlock.set(id, { type: "delete" });
    else findBlock(id)?.remove();
  }
  applyOrder(event.order);
  if (document.activeElement !== titleInput) titleInput.value = event.title || acknowledgedTitle;
  acknowledgedTitle = event.title || acknowledgedTitle;
  applyingRemote = false;
  setStatus("synced", activeId && pendingByBlock.has(activeId) ? "Concurrent edit pending" : "Live update");
  setTimeout(() => { if (!saveInFlight && !saveTimer) setStatus("saved", "Saved"); }, 900);
}

function applySnapshot(doc) {
  applyingRemote = true;
  hideLinkPopover(); hideImageControls();
  revision = doc.revision || 0;
  acknowledged.clear();
  // Server snapshots store IDs alongside HTML; imported/generated HTML is not
  // required to repeat data-block-id inside the markup. Rebuild through
  // parseBlock so the DOM always receives the authoritative IDs.
  editor.replaceChildren(...(doc.blocks || []).map(parseBlock));
  normalizeBlocks();
  for (const block of doc.blocks || []) {
    const node = findBlock(block.id);
    acknowledged.set(block.id, { html: node ? canonicalBlockHtml(node) : block.html, version: block.version });
  }
  titleInput.value = doc.title || "Untitled document";
  acknowledgedTitle = titleInput.value;
  applyingRemote = false;
}

// If a remote update arrived for the block being typed in, don't clobber the
// caret. On blur, apply it only when the local block is clean; otherwise the
// local draft is rebased and sent as the next version.
function settlePendingBlock(id) {
  const pending = pendingByBlock.get(id);
  if (!pending) return;
  pendingByBlock.delete(id);
  const local = findBlock(id);
  const base = acknowledged.get(id);
  const dirty = local && (!base || canonicalBlockHtml(local) !== base.html);
  if (dirty) { scheduleSave(20); return; }
  applyingRemote = true;
  if (pending.type === "delete") local?.remove();
  else if (pending.block.version >= (base?.version || 0)) {
    const next = parseBlock(pending.block);
    if (local) local.replaceWith(next); else editor.appendChild(next);
  }
  applyingRemote = false;
}

editor.addEventListener("focusout", () => {
  const id = activeBlockId();
  setTimeout(() => {
    if (!linkPop.contains(document.activeElement)) hideLinkPopover();
    if (id) settlePendingBlock(id);
    sendPresence();
  }, 0);
});

// --- Ephemeral presence ----------------------------------------------------
let presenceTimer = null;
function containingBlock(node) {
  if (!node || !editor.contains(node)) return null;
  if (node.nodeType !== 1) node = node.parentElement;
  if (node === editor) return null;
  while (node && node.parentElement !== editor) node = node.parentElement;
  return node?.parentElement === editor ? node : null;
}
function textOffsetForPoint(block, node, offset) {
  if (!block || !node) return 0;
  try {
    const range = document.createRange();
    range.selectNodeContents(block);
    range.setEnd(node, offset);
    return range.toString().length;
  } catch (e) { return 0; }
}
function schedulePresence() {
  clearTimeout(presenceTimer);
  presenceTimer = setTimeout(sendPresence, 70);
}
function sendPresence() {
  const sel = window.getSelection();
  const anchorBlock = containingBlock(sel?.anchorNode);
  const focusBlock = containingBlock(sel?.focusNode);
  gadget.updatePresence({
    clientId, name: collaboratorName, color: collaboratorColor,
    anchorBlockId: blockId(anchorBlock),
    anchorOffset: textOffsetForPoint(anchorBlock, sel?.anchorNode, sel?.anchorOffset || 0),
    focusBlockId: blockId(focusBlock),
    focusOffset: textOffsetForPoint(focusBlock, sel?.focusNode, sel?.focusOffset || 0),
  }).catch(() => {});
}
function domPointAtTextOffset(block, requestedOffset) {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let remaining = Math.max(0, requestedOffset || 0), text = null, last = null;
  while ((text = walker.nextNode())) {
    last = text;
    if (remaining <= text.data.length) return { node: text, offset: remaining };
    remaining -= text.data.length;
  }
  if (last) return { node: last, offset: last.data.length };
  return { node: block, offset: 0 };
}
function caretRectAtPoint(block, point) {
  try {
    const range = document.createRange();
    range.setStart(point.node, point.offset); range.collapse(true);
    const rect = range.getClientRects()[0];
    if (rect) return rect;
  } catch (e) {}
  const r = block.getBoundingClientRect();
  return { left: r.left, top: r.top + 3, height: Math.min(22, Math.max(18, r.height - 6)) };
}
function orderedSelectionRange(person) {
  const anchorBlock = person.anchorBlockId && findBlock(person.anchorBlockId);
  const focusBlock = person.focusBlockId && findBlock(person.focusBlockId);
  if (!anchorBlock || !focusBlock) return null;
  const anchor = domPointAtTextOffset(anchorBlock, person.anchorOffset);
  const focus = domPointAtTextOffset(focusBlock, person.focusOffset);
  const blockOrder = Array.from(editor.children);
  const ai = blockOrder.indexOf(anchorBlock), fi = blockOrder.indexOf(focusBlock);
  const anchorFirst = ai < fi || (ai === fi && person.anchorOffset <= person.focusOffset);
  const start = anchorFirst ? anchor : focus;
  const end = anchorFirst ? focus : anchor;
  const range = document.createRange();
  try { range.setStart(start.node, start.offset); range.setEnd(end.node, end.offset); }
  catch (e) { return null; }
  return { range, focusBlock, focus };
}
function renderPresence() {
  remoteCaretLayer.replaceChildren();
  for (const person of collaborators.values()) {
    const selection = orderedSelectionRange(person);
    if (!selection) continue;

    if (!selection.range.collapsed) {
      for (const rect of selection.range.getClientRects()) {
        if (!rect.width || !rect.height) continue;
        const highlight = el("span", { class: "remote-selection" });
        highlight.style.cssText = `left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;background:${person.color}`;
        remoteCaretLayer.appendChild(highlight);
      }
    }

    // The caret follows the focus end, matching the collaborator's actual cursor
    // even when they selected backwards from right to left.
    const r = caretRectAtPoint(selection.focusBlock, selection.focus);
    const caret = el("span", { class: "remote-caret" }, [
      el("span", { class: "remote-caret-label" }, person.name || "Guest"),
    ]);
    caret.style.cssText = `left:${Math.round(r.left)}px;top:${Math.round(r.top)}px;height:${Math.max(18, Math.round(r.height || 18))}px;background:${person.color}`;
    caret.firstChild.style.background = person.color;
    remoteCaretLayer.appendChild(caret);
  }
}
function applyPresence(event) {
  if (!event?.clientId || event.clientId === clientId) return;
  if (event.type === "leave") collaborators.delete(event.clientId);
  else collaborators.set(event.clientId, { ...event, seenAt: Date.now() });
  renderPresence();
}
document.addEventListener("selectionchange", () => {
  if (editor.contains(window.getSelection()?.anchorNode)) schedulePresence();
});
window.addEventListener("scroll", () => { if (collaborators.size) renderPresence(); }, true);
window.addEventListener("resize", () => { if (collaborators.size) renderPresence(); });

// onRpcBroken and unload delivery can both be delayed by the browser. A small
// heartbeat makes stationary cursors live, while stale collaborators disappear
// predictably even when a tab/process is killed without a clean disconnect.
const PRESENCE_HEARTBEAT_MS = 4000;
const PRESENCE_STALE_MS = 12000;
setInterval(() => {
  sendPresence();
  const cutoff = Date.now() - PRESENCE_STALE_MS;
  let changed = false;
  for (const [id, person] of collaborators) {
    if ((person.seenAt || 0) < cutoff) {
      collaborators.delete(id);
      changed = true;
    }
  }
  if (changed) renderPresence();
}, PRESENCE_HEARTBEAT_MS);

window.addEventListener("pagehide", () => {
  // This is best-effort only; stale expiry above is the guaranteed fallback.
  gadget.leavePresence(clientId).catch(() => {});
});

class DocCallbacks extends RpcTarget {
  operation(event) {
    if (event.type === "snapshot") applySnapshot(event.document);
    else applyRemoteOperation(event);
  }
  presence(event) { applyPresence(event); }
}

if (isDocumentExport) {
  document.documentElement.classList.add("document-export");
  editor.removeAttribute("contenteditable");
  app.replaceChildren(canvas);
  document.body.replaceChildren(app);
}

// --- Init ------------------------------------------------------------------

  try {
    let doc = await gadget.subscribe(new DocCallbacks(), {
      clientId, name: collaboratorName, color: collaboratorColor,
    });
    if (!doc.blocks) {
      // One-time, backwards-compatible conversion of the former HTML snapshot.
      editor.innerHTML = doc.legacyContent || "";
      normalizeBlocks();
      doc = await gadget.initializeBlocks({
        blocks: serializeBlocks(), title: doc.title, senderId: clientId,
      });
    }
    applySnapshot(doc);
    setStatus("saved", "Saved");
    sendPresence();
  } catch (e) {
    console.error(e);
    setStatus("bad", "Offline");
  }
  refreshToolbarState();

