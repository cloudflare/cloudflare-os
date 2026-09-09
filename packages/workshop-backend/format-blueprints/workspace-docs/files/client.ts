// ---------------------------------------------------------------------------
// Docs — a Google-Docs-style editor. Builds the entire UI in JS.
//
// Built on the shared gadget libraries (packages/gadget-libraries), which the
// build inlines: `ui` draws the chrome (elements, icons, toolbar controls, the
// prompt, the status dot, image downscaling) and `sync` runs the collaboration
// loop (save scheduling, presence, the callback target). The editing commands,
// the paste sanitizer, the block model and the export are this gadget's own.
// ---------------------------------------------------------------------------

import {
  ICONS as UI_ICONS,
  PROMPT_STYLES,
  colorBtn,
  customSelect,
  el,
  group,
  iconBtn,
  imageFilesFrom,
  isImageFile,
  prepareImage,
  promptInline,
  segBtn,
  statusIndicator,
} from "gadgets:ui/client";
import {
  PresenceReporter,
  PresenceRoster,
  type SaveOutcome,
  SaveScheduler,
  type SyncHost,
  collaboratorFor,
  createSubscriber,
} from "gadgets:sync/client";
import type { CustomSelect, CustomSelectOptions, PreparedImage, PromptOptions } from "gadgets:ui/client";
import type {
  BlockContent,
  DocCursor,
  DocPresenceEvent,
  GadgetStub,
  OperationEvent,
  PresenceUpdate,
  StoredBlock,
  StoredDocument,
  SubscriberCallbacks,
} from "./lib/protocol.ts";

// The bindings the Workshop's iframe bootstrap defines before this module runs: the RPC stub to
// this gadget's Durable Object, and Cap'n Web's RpcTarget for the callbacks it is handed.
declare const gadget: GadgetStub;
declare const RpcTarget: SyncHost["RpcTarget"];

// The editor hands execCommand `null` where a command takes no value and a boolean for
// styleWithCSS; the DOM converts both to a string. The lib's signature admits only the string.
declare global {
  interface Document {
    execCommand(commandId: string, showUI?: boolean, value?: string | boolean | null): boolean;
  }
}

// Node-type guards: the `nodeType` comparisons the editor makes, as narrowings.
function isElement(node: Node | null | undefined): node is Element {
  return !!node && node.nodeType === 1;
}
function isText(node: Node | null | undefined): node is Text {
  return !!node && node.nodeType === 3;
}

const clientId = Math.random().toString(36).slice(2);
const isDocumentExport = ["html", "pdf"].includes((globalThis as { gadgetExportFormatId?: string }).gadgetExportFormatId ?? "");

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
${PROMPT_STYLES}`;
document.head.appendChild(style);

// --- Icons -----------------------------------------------------------------
// The shared table, plus the icons only this editor draws.
const ICONS = {
  ...UI_ICONS,
  highlight: '<path d="M9 11l-4 4v3h3l4-4"/><path d="M13 7l4 4"/><path d="M11 9l5-5 4 4-5 5z"/>',
  alignJustify: '<line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/>',
  outdent: '<line x1="20" y1="6" x2="4" y2="6"/><line x1="20" y1="18" x2="4" y2="18"/><line x1="20" y1="12" x2="11" y2="12"/><polyline points="7 9 4 12 7 15"/>',
  indent: '<line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="18" x2="20" y2="18"/><line x1="13" y1="12" x2="20" y2="12"/><polyline points="6 9 9 12 6 15"/>',
  hr: '<line x1="4" y1="12" x2="20" y2="12"/>',
};
type IconName = keyof typeof ICONS;

// --- Build UI --------------------------------------------------------------
const editor = el("div", { class: "doc-page", contenteditable: "true", spellcheck: "true" });

const titleInput = el("input", { class: "title-input", value: "Untitled document", "aria-label": "Document title" });
const saveStatus = statusIndicator({ title: "Save status" });

const topbar = el("div", { class: "topbar" }, [
  el("div", { class: "title-wrap" }, [titleInput]),
  el("div", { class: "spacer" }),
  saveStatus.element,
]);

// Toolbar. A dropdown must leave the editor's selection alone: the mousedown
// that opens it may not move focus out of the editor, and the range the caret
// had is what the chosen command applies to.
function toolbarSelect(options: CustomSelectOptions): CustomSelect {
  const select = customSelect(options);
  select.el.addEventListener("mousedown", (e) => { e.preventDefault(); savedRange = getRange(); });
  return select;
}

// Style selector
const styleSel = toolbarSelect({
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
const fontSel = toolbarSelect({
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
const sizeSel = toolbarSelect({
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

function applyFontSize(px: number) {
  document.execCommand("fontSize", false, "7");
  editor.querySelectorAll<HTMLFontElement>('font[size="7"]').forEach((f) => {
    f.removeAttribute("size");
    f.style.fontSize = px + "px";
  });
}

// Simple command buttons
function cmdBtn(name: IconName, title: string, command: string, value: string | null = null) {
  return iconBtn(ICONS[name], title, () => {
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

// Color buttons (text + highlight). The picker prevents its own mousedown; the
// selection it recolours is the one saved here.
function commandColorBtn(name: IconName, title: string, command: string, defaultColor: string) {
  const btn = colorBtn(ICONS[name], title, defaultColor, (color) => {
    restoreRange();
    document.execCommand(command, false, color);
    editor.focus();
    scheduleSave();
  });
  btn.addEventListener("mousedown", () => { savedRange = getRange(); });
  return btn;
}
const textColorBtn = commandColorBtn("textcolor", "Text color", "foreColor", "#1d1d20");
const highlightBtn = commandColorBtn("highlight", "Highlight color", "hiliteColor", "#fff3a3");

// Alignment segmented control
// Filled by the four calls below; typed as complete so the toolbar state can read each.
const alignBtns = {} as Record<"left" | "center" | "right" | "justify", HTMLButtonElement>;
function alignBtn(name: IconName, title: string, command: string) {
  return segBtn(ICONS[name], title, () => {
    document.execCommand(command, false, null);
    editor.focus();
    refreshToolbarState();
    scheduleSave();
  });
}
alignBtns.left = alignBtn("alignLeft", "Align left", "justifyLeft");
alignBtns.center = alignBtn("alignCenter", "Align center", "justifyCenter");
alignBtns.right = alignBtn("alignRight", "Align right", "justifyRight");
alignBtns.justify = alignBtn("alignJustify", "Justify", "justifyFull");
const alignSegment = el("div", { class: "segment" }, [alignBtns.left, alignBtns.center, alignBtns.right, alignBtns.justify]);

const ulBtn = cmdBtn("ul", "Bulleted list", "insertUnorderedList");
const olBtn = cmdBtn("ol", "Numbered list", "insertOrderedList");
const outdentBtn = cmdBtn("outdent", "Decrease indent", "outdent");
const indentBtn = cmdBtn("indent", "Increase indent", "indent");

const linkBtn = iconBtn(ICONS.link, "Insert link", () => insertLink());
const imageInput = el("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/gif", multiple: "true" });
imageInput.style.display = "none";
document.body.appendChild(imageInput);
const imageBtn = iconBtn(ICONS.image, "Insert image", () => {
  savedRange = getRange();
  imageInput.value = "";
  imageInput.click();
});
imageInput.addEventListener("change", () => insertImageFiles(Array.from(imageInput.files || [])));
const hrBtn = cmdBtn("hr", "Horizontal line", "insertHorizontalRule");
const clearBtn = iconBtn(ICONS.clear, "Clear formatting", () => {
  document.execCommand("removeFormat", false, null);
  const block = currentBlock();
  if (block) block.classList.remove("doc-title");
  document.execCommand("formatBlock", false, "P");
  editor.focus();
  refreshToolbarState();
  scheduleSave();
});

const undoBtn = iconBtn(ICONS.undo, "Undo (Ctrl+Z)", () => { document.execCommand("undo"); editor.focus(); scheduleSave(); });
const redoBtn = iconBtn(ICONS.redo, "Redo (Ctrl+Y)", () => { document.execCommand("redo"); editor.focus(); scheduleSave(); });

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
let savedRange: Range | null = null;
function getRange(): Range | null {
  const sel = window.getSelection();
  if (sel && sel.rangeCount && editor.contains(sel.anchorNode)) return sel.getRangeAt(0).cloneRange();
  return null;
}
function restoreRange() {
  if (!savedRange) return;
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(savedRange);
}
function currentBlock(): Element | null {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  let node = sel.anchorNode;
  while (node && node !== editor) {
    if (isElement(node) && /^(P|H1|H2|H3|H4|BLOCKQUOTE|PRE|LI|DIV)$/.test(node.tagName)) return node;
    node = node.parentNode;
  }
  return null;
}

// The <a> element containing the current selection, if any.
function currentLink(): Element | null {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  let node = sel.anchorNode;
  while (node && node !== editor) {
    if (isElement(node) && node.tagName === "A") return node;
    node = node.parentNode;
  }
  return null;
}

function selectNode(node: Node) {
  const range = document.createRange();
  range.selectNode(node);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
}

function normalizeHref(url: string): string {
  let href = (url || "").trim();
  if (href && !/^(https?:|mailto:|tel:|#|\/)/i.test(href)) href = "https://" + href;
  return href;
}

function escapeAttr(s: string): string {
  return String(s || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

// --- Images ---------------------------------------------------------------
// Images are embedded as compressed data URLs inside the document HTML. This is
// the most reliable option in the Gadget sandbox: local drag/drop, file picker,
// screenshots, and clipboard images all keep working after reload and multi-client sync.
// The reading, downscaling and re-encoding is the ui library's; where the image
// lands in the document is this editor's.

function isSafeImageDataUrl(src: string): boolean {
  return /^data:image\/(png|jpe?g|webp|gif);base64,/i.test(src || "");
}

function insertImageDataUrl({ src, width, alt }: PreparedImage) {
  if (!isSafeImageDataUrl(src)) return;
  restoreRange();
  const displayWidth = Math.min(width || 520, Math.max(240, editor.clientWidth - 40));
  const html = `<img class="doc-image" draggable="true" src="${src}" alt="${escapeAttr(alt || "Image")}" style="width:${Math.round(displayWidth)}px;height:auto;">`;
  document.execCommand("insertHTML", false, html);
  savedRange = getRange();
}

async function insertImageFiles(files: File[]) {
  const imageFiles = files.filter(isImageFile);
  if (!imageFiles.length) return;
  hideLinkPopover();
  hideImageControls();
  setStatus("saving", "Processing image…");
  try {
    for (const file of imageFiles) {
      insertImageDataUrl(await prepareImage(file, { alt: file.name || "Image" }));
    }
    editor.focus();
    refreshToolbarState();
    scheduleSave();
  } catch (e) {
    setStatus("bad", "Image failed");
  }
}

function setCaretFromPoint(x: number, y: number) {
  let range: Range | null = null;
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
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  savedRange = range.cloneRange();
}

let selectedImage: HTMLImageElement | null = null;
let resizingImage = false;
let draggedImage: HTMLImageElement | null = null;
const imageControls = el("div", { class: "image-controls" }, [el("div", { class: "resize-handle" })]);
document.body.appendChild(imageControls);
const resizeHandle = imageControls.querySelector<HTMLDivElement>(".resize-handle")!;

function positionImageControls() {
  if (!selectedImage || !editor.contains(selectedImage) || resizingImage) return;
  const r = selectedImage.getBoundingClientRect();
  imageControls.style.left = Math.round(r.left) + "px";
  imageControls.style.top = Math.round(r.top) + "px";
  imageControls.style.width = Math.round(r.width) + "px";
  imageControls.style.height = Math.round(r.height) + "px";
  imageControls.style.display = "block";
}

function selectImage(img: HTMLImageElement) {
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

  const move = (ev: MouseEvent) => {
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
  const img = e.target instanceof Element && e.target.closest<HTMLImageElement>("img.doc-image");
  if (img && editor.contains(img)) selectImage(img);
  else hideImageControls();
});

editor.addEventListener("dragstart", (e) => {
  const img = e.target instanceof Element && e.target.closest<HTMLImageElement>("img.doc-image");
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
  if (draggedImage || imageFilesFrom(e.dataTransfer).length || types.includes("Files") || types.includes("text/html") || types.includes("text/plain")) {
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
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(after);
      savedRange = after.cloneRange();
    }
    selectImage(img);
    scheduleSave();
    return;
  }

  const files = imageFilesFrom(e.dataTransfer);
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
    else document.execCommand("insertHTML", false, escapeText(text!).replace(/\r?\n/g, "<br>"));
    refreshToolbarState();
    scheduleSave();
  }
});

window.addEventListener("scroll", () => { if (selectedImage) positionImageControls(); }, true);
window.addEventListener("resize", () => { if (selectedImage) positionImageControls(); });

function sanitizeImageElement(srcImg: Element): HTMLImageElement | null {
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

// What the link prompt looks like: the sandbox blocks window.prompt, so the ui
// library's dialog asks instead.
const LINK_PROMPT: PromptOptions = { placeholder: "https://", okLabel: "Insert" };

// The link button: edit the link under the cursor if there is one, else create.
async function insertLink(): Promise<void> {
  const existing = currentLink();
  if (existing) return editLink(existing);
  savedRange = getRange();
  const url = await promptInline("Enter URL:", "", LINK_PROMPT);
  if (!url) return;
  restoreRange();
  document.execCommand("createLink", false, normalizeHref(url));
  editor.focus();
  scheduleSave();
}

async function editLink(anchor: Element): Promise<void> {
  const url = await promptInline("Edit URL:", anchor.getAttribute("href") || "", LINK_PROMPT);
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
function removeLink(anchor: Element) {
  selectNode(anchor);
  document.execCommand("unlink", false, null);
  hideLinkPopover();
  editor.focus();
  scheduleSave();
}

// --- Link popover (Google-Docs style) --------------------------------------
let activeLink: Element | null = null;
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

function positionLinkPopover(anchor: Element) {
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

function showLinkPopover(anchor: Element) {
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

// --- Paste sanitizer -------------------------------------------------------
// Pasted content (especially from Google Docs / Word) carries formatting in
// inline `style` attributes and non-semantic <span>/<font> wrappers — which
// the toolbar commands (bold/underline/link…) can't toggle or remove. We
// rebuild pasted HTML into clean semantic markup so it behaves like text the
// editor created itself.
const INLINE_ONLY = ["code", "s", "u", "i", "b"];
function wrapEl(tag: string, child: Node): HTMLElement { const e = document.createElement(tag); e.appendChild(child); return e; }

/** The inline formatting in force where the sanitizer stands in the pasted tree. */
interface InlineFormat {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  code?: boolean;
  link?: string | null;
}

function fmtOf(elem: Element, ctx: InlineFormat): InlineFormat {
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

function wrapInline(text: string, ctx: InlineFormat): Node {
  let node: Node = document.createTextNode(text);
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

function sanitizePastedHtml(html: string): string {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const result = document.createElement("div");

  function appendInline(src: Node, target: Node, ctx: InlineFormat) {
    src.childNodes.forEach((child) => {
      if (isText(child)) {
        if (child.textContent) target.appendChild(wrapInline(child.textContent, ctx));
      } else if (isElement(child)) {
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

  function processList(src: Element, ctx: InlineFormat): HTMLElement {
    const list = document.createElement(src.tagName === "OL" ? "ol" : "ul");
    src.childNodes.forEach((child) => {
      if (!isElement(child)) return;
      if (child.tagName === "LI") {
        const li = document.createElement("li");
        const nested: Element[] = [];
        child.childNodes.forEach((g) => {
          if (isElement(g) && (g.tagName === "UL" || g.tagName === "OL")) nested.push(g);
          else if (isText(g)) { if (g.textContent) li.appendChild(wrapInline(g.textContent, ctx)); }
          else if (isElement(g)) appendInline(g, li, fmtOf(g, ctx));
        });
        nested.forEach((n) => li.appendChild(processList(n, ctx)));
        list.appendChild(li);
      } else if (child.tagName === "UL" || child.tagName === "OL") {
        list.appendChild(processList(child, ctx));
      }
    });
    return list;
  }

  function processNodes(nodes: Node[], ctx: InlineFormat) {
    nodes.forEach((node) => {
      if (isText(node)) {
        if (node.textContent && node.textContent.trim()) {
          const p = document.createElement("p");
          p.appendChild(wrapInline(node.textContent, ctx));
          result.appendChild(p);
        }
        return;
      }
      if (!isElement(node)) return;
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
        if (block.textContent!.trim() || block.querySelector("br")) result.appendChild(block);
        return;
      }
      // Wrapper (DIV/SPAN/FONT/B-wrapper…): descend if it holds blocks,
      // otherwise treat its inline content as a paragraph.
      const newCtx = fmtOf(node, ctx);
      const hasBlockChild = Array.from(node.childNodes).some(
        (c) => isElement(c) && BLOCK_TAGS.includes(c.tagName));
      if (hasBlockChild) {
        processNodes(Array.from(node.childNodes), newCtx);
      } else {
        const p = document.createElement("p");
        appendInline(node, p, newCtx);
        if (p.textContent!.trim() || p.querySelector("br")) result.appendChild(p);
      }
    });
  }

  processNodes(Array.from(parsed.body.childNodes), {});
  return result.innerHTML;
}

function escapeText(t: string): string {
  return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}


editor.addEventListener("paste", (e) => {
  const cb = e.clipboardData;
  if (!cb) return;
  const imageFiles = imageFilesFrom(cb);
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
  const set = (btn: HTMLElement, on: boolean) => btn.classList.toggle("active", on);
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
  if (editor.contains(window.getSelection()!.anchorNode)) scheduleSelectionUpdate();
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

const me = collaboratorFor(clientId);
let applyingRemote = false;
let revision = 0;
let acknowledgedTitle = "Untitled document";
const acknowledged = new Map<string, { html: string; version: number }>(); // id -> {html, version}
// A remote change to the block being typed in, held until the caret leaves it.
type PendingBlock = { type: "upsert"; block: StoredBlock } | { type: "delete" };
const pendingByBlock = new Map<string, PendingBlock>();
const roster = new PresenceRoster<DocCursor>(clientId);

// The dot's classes are this stylesheet's. The sync library names a rejected
// save `conflict` and a failed one `offline`; both are drawn the way this
// editor has always drawn them.
const STATUS_KINDS: Record<string, string> = { conflict: "synced", offline: "bad" };
function setStatus(kind: string, text: string) {
  saveStatus.set(STATUS_KINDS[kind] ?? kind, text);
}

function newBlockId() {
  if (typeof globalThis.crypto?.randomUUID === "function") return "b_" + crypto.randomUUID();
  return "b_" + Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function blockId(node: Node | null | undefined): string | null { return isElement(node) ? node.getAttribute("data-block-id") : null; }
function findBlock(id: string): Element | null {
  return Array.from(editor.children).find((node) => blockId(node) === id) || null;
}
function activeBlockId(): string | null {
  const sel = window.getSelection();
  let node = sel?.anchorNode;
  if (!node || !editor.contains(node)) return null;
  if (!isElement(node)) node = node.parentElement;
  while (node && node.parentElement !== editor) node = node.parentElement;
  return node && node.parentElement === editor ? blockId(node) : null;
}

// contenteditable can create bare text/BR nodes at the root. Convert those to
// paragraphs and guarantee unique stable IDs before serialization.
function normalizeBlocks() {
  const selectionBlock = activeBlockId();
  for (const node of Array.from(editor.childNodes)) {
    if (isText(node) || (isElement(node) && node.tagName === "BR")) {
      const p = document.createElement("p");
      if (isText(node)) p.textContent = node.textContent;
      else p.appendChild(document.createElement("br"));
      editor.replaceChild(p, node);
    }
  }
  const seen = new Set<string>();
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
      const sel = window.getSelection()!; sel.removeAllRanges(); sel.addRange(range);
    }
  }
}

function canonicalBlockHtml(node: Element): string {
  // Presence decoration is ephemeral UI and must never enter persisted HTML.
  // A top-level block is always an HTML element: normalizeBlocks() wraps anything else in a <p>.
  const clone = node.cloneNode(true) as HTMLElement;
  clone.classList.remove("remote-editing");
  clone.style.removeProperty("--remote-color");
  clone.querySelectorAll<HTMLElement>(".remote-editing").forEach((child) => {
    child.classList.remove("remote-editing"); child.style.removeProperty("--remote-color");
  });
  clone.querySelectorAll(".image-selected").forEach((image) => image.classList.remove("image-selected"));
  return clone.outerHTML;
}
function serializeBlocks(): BlockContent[] {
  normalizeBlocks();
  // normalizeBlocks() has just given every block an id.
  return Array.from(editor.children).map((node) => ({ id: blockId(node)!, html: canonicalBlockHtml(node) }));
}
function parseBlock(block: BlockContent): Element {
  const tpl = document.createElement("template");
  tpl.innerHTML = block.html;
  const node = tpl.content.firstElementChild || document.createElement("p");
  node.setAttribute("data-block-id", block.id);
  return node;
}

// Typing stays optimistic; the scheduler debounces, serializes and retries what
// crosses RPC. Only the payload and what counts as dirty are this gadget's.
const saver = new SaveScheduler({ save: sendChanges, isDirty, onStatus: setStatus });

function scheduleSave(delay?: number) {
  if (applyingRemote) return;
  saver.schedule(delay);
}

function currentTitle(): string {
  return titleInput.value.trim() || "Untitled document";
}

function isDirty(): boolean {
  const blocks = serializeBlocks();
  return blocks.some((block) => acknowledged.get(block.id)?.html !== block.html) ||
    blocks.length !== acknowledged.size ||
    currentTitle() !== acknowledgedTitle;
}

async function sendChanges(): Promise<SaveOutcome> {
  const blocks = serializeBlocks();
  const currentIds = new Set(blocks.map((b) => b.id));
  const upserts = blocks
    .filter((block) => acknowledged.get(block.id)?.html !== block.html)
    .map((block) => ({ ...block, baseVersion: acknowledged.get(block.id)?.version || 0 }));
  const deletes = Array.from(acknowledged.entries())
    .filter(([id]) => !currentIds.has(id))
    .map(([id, block]) => ({ id, baseVersion: block.version }));
  const title = currentTitle();
  if (!upserts.length && !deletes.length && title === acknowledgedTitle) return "saved";

  const result = await gadget.applyOperation({
    senderId: clientId, baseRevision: revision, upserts, deletes,
    order: blocks.map((b) => b.id), title,
  });
  revision = Math.max(revision, result.revision || 0);
  for (const block of result.upserts || []) acknowledged.set(block.id, { html: block.html, version: block.version });
  for (const id of result.deletedIds || []) acknowledged.delete(id);
  acknowledgedTitle = result.title || title;
  if (!result.conflicts?.length) return "saved";

  // Keep the local draft visible, but rebase its next operation on the latest
  // authoritative block version. The next save intentionally preserves mine.
  for (const block of result.conflicts) acknowledged.set(block.id, { html: block.html, version: block.version });
  return "conflict";
}

editor.addEventListener("input", () => {
  if (selectedImage && !editor.contains(selectedImage)) hideImageControls();
  else if (selectedImage) positionImageControls();
  scheduleSave();
  presence.schedule();
});
titleInput.addEventListener("input", () => scheduleSave());

try { document.execCommand("styleWithCSS", false, true); } catch (e) {}
try { document.execCommand("defaultParagraphSeparator", false, "p"); } catch (e) {}

function applyOrder(order: string[] | undefined) {
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

function applyRemoteOperation(event: OperationEvent) {
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
  setTimeout(() => { if (!saver.busy) setStatus("saved", "Saved"); }, 900);
}

function applySnapshot(doc: StoredDocument) {
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
function settlePendingBlock(id: string) {
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
    presence.sendNow();
  }, 0);
});

// --- Ephemeral presence ----------------------------------------------------
// The roster and the throttled reporter are the sync library's; where a caret
// sits in a block, and how it is drawn, are this editor's.
function containingBlock(node: Node | null | undefined): Node | null {
  if (!node || !editor.contains(node)) return null;
  if (!isElement(node)) node = node.parentElement;
  if (node === editor) return null;
  while (node && node.parentElement !== editor) node = node.parentElement;
  return node?.parentElement === editor ? node : null;
}
function textOffsetForPoint(block: Node | null, node: Node | null | undefined, offset: number): number {
  if (!block || !node) return 0;
  try {
    const range = document.createRange();
    range.selectNodeContents(block);
    range.setEnd(node, offset);
    return range.toString().length;
  } catch (e) { return 0; }
}
// Anchor and focus endpoints let everyone draw both a caret and a selection,
// including one spanning several top-level blocks.
function currentPresence(): PresenceUpdate {
  const sel = window.getSelection();
  const anchorBlock = containingBlock(sel?.anchorNode);
  const focusBlock = containingBlock(sel?.focusNode);
  return {
    clientId, name: me.name, color: me.color,
    anchorBlockId: blockId(anchorBlock),
    anchorOffset: textOffsetForPoint(anchorBlock, sel?.anchorNode, sel?.anchorOffset || 0),
    focusBlockId: blockId(focusBlock),
    focusOffset: textOffsetForPoint(focusBlock, sel?.focusNode, sel?.focusOffset || 0),
  };
}
const presence = new PresenceReporter(currentPresence, (update) => gadget.updatePresence(update));
/** A place in the DOM: a node and an offset within it, as a Range endpoint. */
interface DomPoint {
  node: Node;
  offset: number;
}
function domPointAtTextOffset(block: Element, requestedOffset: number): DomPoint {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let remaining = Math.max(0, requestedOffset || 0), text: Text | null = null, last: Text | null = null;
  // The walker shows text nodes only.
  while ((text = walker.nextNode() as Text | null)) {
    last = text;
    if (remaining <= text.data.length) return { node: text, offset: remaining };
    remaining -= text.data.length;
  }
  if (last) return { node: last, offset: last.data.length };
  return { node: block, offset: 0 };
}
function caretRectAtPoint(block: Element, point: DomPoint): Pick<DOMRect, "left" | "top" | "height"> {
  try {
    const range = document.createRange();
    range.setStart(point.node, point.offset); range.collapse(true);
    const rect = range.getClientRects()[0];
    if (rect) return rect;
  } catch (e) {}
  const r = block.getBoundingClientRect();
  return { left: r.left, top: r.top + 3, height: Math.min(22, Math.max(18, r.height - 6)) };
}
function orderedSelectionRange(cursor: DocCursor) {
  const anchorBlock = cursor.anchorBlockId && findBlock(cursor.anchorBlockId);
  const focusBlock = cursor.focusBlockId && findBlock(cursor.focusBlockId);
  if (!anchorBlock || !focusBlock) return null;
  const anchor = domPointAtTextOffset(anchorBlock, cursor.anchorOffset);
  const focus = domPointAtTextOffset(focusBlock, cursor.focusOffset);
  const blockOrder = Array.from(editor.children);
  const ai = blockOrder.indexOf(anchorBlock), fi = blockOrder.indexOf(focusBlock);
  const anchorFirst = ai < fi || (ai === fi && cursor.anchorOffset <= cursor.focusOffset);
  const start = anchorFirst ? anchor : focus;
  const end = anchorFirst ? focus : anchor;
  const range = document.createRange();
  try { range.setStart(start.node, start.offset); range.setEnd(end.node, end.offset); }
  catch (e) { return null; }
  return { range, focusBlock, focus };
}
function renderPresence() {
  remoteCaretLayer.replaceChildren();
  for (const person of roster.entries()) {
    const selection = person.cursor && orderedSelectionRange(person.cursor);
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
    (caret.firstChild as HTMLElement).style.background = person.color;
    remoteCaretLayer.appendChild(caret);
  }
}
function applyPresence(event: DocPresenceEvent) {
  if (roster.apply(event)) renderPresence();
}
document.addEventListener("selectionchange", () => {
  if (editor.contains(window.getSelection()?.anchorNode ?? null)) presence.schedule();
});
window.addEventListener("scroll", () => { if (roster.entries().length) renderPresence(); }, true);
window.addEventListener("resize", () => { if (roster.entries().length) renderPresence(); });

// onRpcBroken and unload delivery can both be delayed by the browser. A small
// heartbeat makes stationary cursors live, while stale collaborators disappear
// predictably even when a tab/process is killed without a clean disconnect.
presence.startHeartbeat(() => { if (roster.expire()) renderPresence(); });

window.addEventListener("pagehide", () => {
  // This is best-effort only; stale expiry above is the guaranteed fallback.
  gadget.leavePresence(clientId).catch(() => {});
});

// The server's callbacks, on the RpcTarget the bootstrap provides.
const subscriber = createSubscriber<SubscriberCallbacks>(RpcTarget, {
  operation(event) {
    if (event.type === "snapshot") applySnapshot(event.document);
    else applyRemoteOperation(event);
  },
  presence(event) { applyPresence(event); },
});

if (isDocumentExport) {
  document.documentElement.classList.add("document-export");
  editor.removeAttribute("contenteditable");
  app.replaceChildren(canvas);
  document.body.replaceChildren(app);
}

// --- Init ------------------------------------------------------------------

  try {
    let doc = await gadget.subscribe(subscriber, { clientId, name: me.name, color: me.color });
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
    presence.sendNow();
  } catch (e) {
    console.error(e);
    setStatus("bad", "Offline");
  }
  refreshToolbarState();
