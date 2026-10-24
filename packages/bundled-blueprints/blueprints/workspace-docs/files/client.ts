// ─────────────────────────────────────────────────────────────────────────────
// Docs — a calm, real-time collaborative rich-text editor.
//
// Sections:
//   1. Helpers & platform        6. Menus, palette, typeface, shortcuts sheet
//   2. Styles                    7. Links, images, paste & drop
//   3. Layout                    8. Keyboard, input rules, slash menu
//   4. Selection & structure     9. Ambient UI (placeholder, outline)
//   5. Commands & toolbar       10. Collaboration (save, sync, connect)
// ─────────────────────────────────────────────────────────────────────────────

/* ═════════════════════════ 1. Helpers & platform ═════════════════════════ */

import type {
  ApplyOperationResult,
  BlockContent,
  BlockDeletion,
  BlockUpsert,
  DocFont,
  DocSettings,
  DocumentEvent,
  DocumentSnapshot,
  GadgetStub,
  MissingBlock,
  OperationEvent,
  StoredBlock,
  StoredDocument,
  SubscribeSnapshot,
  SubscriberCallbacks,
} from "./lib/protocol.ts";
import { escapeHtml, inlineMarkdown, isCodeEditorHtml, normalizeHref, parseTsv, pipeCells, sanitizePastedHtml as sanitizeHtml, textToHtml, type PasteContext } from "./lib/paste.ts";
import { MARK_TAGS, VOID_TAGS, mergeBlockHtml } from "./lib/merge.ts";
import { codeFence } from "./lib/markdown.ts";

// The bindings the Workshop's iframe bootstrap defines before this module runs: the RPC stub to
// this gadget's Durable Object, and Cap'n Web's RpcTarget for the callbacks it is handed.
declare const gadget: GadgetStub;
declare const RpcTarget: new () => object;

// The editor hands execCommand `null` where a command takes no value and a boolean for
// styleWithCSS; the DOM converts both to a string. The lib's signature admits only the string.
declare global {
  interface Document {
    execCommand(commandId: string, showUI?: boolean, value?: string | boolean | null): boolean;
  }
  // Timers start out as `null` here, and clearing a null timer is a no-op the lib's signature omits.
  function clearTimeout(id: number | null | undefined): void;
}

/** What `el` accepts as an attribute or property: falsy values are skipped. */
type ElProp = string | number | boolean | null | undefined | Partial<CSSStyleDeclaration> | EventListener;
/** What `el` accepts as children: nodes, text, and skipped falsy values. */
type ElChild = Node | string | number | null | undefined | false;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Record<string, ElProp>, children?: ElChild | ElChild[]): HTMLElementTagNameMap[K];
function el(tag: string, props?: Record<string, ElProp>, children?: ElChild | ElChild[]): HTMLElement;
function el(tag: string, props: Record<string, ElProp> = {}, children: ElChild | ElChild[] = []): HTMLElement {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === void 0 || value === false) continue;
    if (key === "class") node.className = String(value);
    else if (key === "text") node.textContent = String(value);
    else if (key === "html") node.innerHTML = String(value);
    else if (key === "style" && typeof value === "object") Object.assign(node.style, value);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === null || child === void 0 || child === false) continue;
    node.appendChild(typeof child === "object" ? child : document.createTextNode(String(child)));
  }
  return node;
}
const isElement = (n: Node | null | undefined): n is HTMLElement => !!n && n.nodeType === 1;
const isText = (n: Node | null | undefined): n is Text => !!n && n.nodeType === 3;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const ZWSP = "\u200B";
function svg(paths: string, size = 18) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || "");
const coarsePointer = matchMedia("(pointer: coarse)").matches;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const isExport = ["html", "pdf"].includes((globalThis as { gadgetExportFormatId?: string }).gadgetExportFormatId ?? "");
const clientId = Math.random().toString(36).slice(2);

// Shortcut labels in each platform's own vocabulary and modifier order.
function combo(...parts: string[]): string[] {
  const key = parts.pop()!;
  const has = (m: string) => parts.includes(m);
  if (isMac) return [...has("alt") ? ["⌥"] : [], ...has("shift") ? ["⇧"] : [], ...has("mod") ? ["⌘"] : [], key];
  return [...has("mod") ? ["Ctrl"] : [], ...has("alt") ? ["Alt"] : [], ...has("shift") ? ["Shift"] : [], key];
}
// One renderer for every shortcut on screen (menus, tooltips, the sheet).
// Mac: glyphs abut, each in a fixed-width cell. Elsewhere: "Ctrl+Alt+1".
function keysEl(keys: string[], className: string) {
  const box = el("span", { class: className });
  keys.forEach((k, i) => {
    if (!isMac && i) box.appendChild(el("span", { class: "k-plus" }, "+"));
    box.appendChild(el("span", { class: "k" + (Array.from(k).length === 1 ? " k-g" : "") }, k));
  });
  return box;
}
document.documentElement.classList.toggle("mac", isMac);

const ICONS: Record<string, string> = {
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H12"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H12"/>',
  bold: '<path d="M7 5h5.5a3.5 3.5 0 0 1 0 7H7z"/><path d="M7 12h6.5a3.5 3.5 0 0 1 0 7H7z"/>',
  italic: '<path d="M11 5h7"/><path d="M6 19h7"/><path d="M14.5 5 9.5 19"/>',
  underline: '<path d="M7 4.5V11a5 5 0 0 0 10 0V4.5"/><path d="M5.5 20h13"/>',
  strike: '<path d="M16.2 7.6C15.7 5.9 14.1 5 12 5 9.6 5 7.8 6.3 7.8 8.2c0 1.2.6 2.1 1.9 2.8"/><path d="M4.5 12h15"/><path d="M15 13.6c.9.6 1.3 1.4 1.3 2.4 0 2-1.9 3.4-4.4 3.4-2.3 0-4-1-4.6-2.8"/>',
  code: '<path d="m9 7.5-4.5 4.5L9 16.5"/><path d="m15 7.5 4.5 4.5-4.5 4.5"/>',
  color: '<path d="M6.5 16.5 12 4l5.5 12.5"/><path d="M8.6 12h6.8"/>',
  ul: '<path d="M10 6.5h10M10 12h10M10 17.5h10"/><circle cx="5" cy="6.5" r="1.1" fill="currentColor" stroke="none"/><circle cx="5" cy="12" r="1.1" fill="currentColor" stroke="none"/><circle cx="5" cy="17.5" r="1.1" fill="currentColor" stroke="none"/>',
  ol: '<path d="M10.5 6.5H20M10.5 12H20M10.5 17.5H20"/><path d="M4.2 5.2 5.5 4.5v4.2" stroke-width="1.4"/><path d="M4 14.1c.2-.7.8-1.1 1.4-1.1.8 0 1.4.5 1.4 1.2 0 1.2-2.8 1.8-2.8 3.6h2.9" stroke-width="1.4"/>',
  todo: '<rect x="3.5" y="4" width="6" height="6" rx="1.6"/><path d="m4.6 16.4 1.6 1.6 2.9-3.2"/><path d="M13 7h7.5M13 17h7.5"/>',
  link: '<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.2 1.2"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.2-1.2"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="m20.5 15.5-4.8-4.8L6 20"/>',
  more: '<circle cx="5.5" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.3" fill="currentColor" stroke="none"/>',
  alignLeft: '<path d="M4 6h16M4 12h10M4 18h13"/>',
  alignCenter: '<path d="M4 6h16M7 12h10M5.5 18h13"/>',
  alignRight: '<path d="M4 6h16M10 12h10M7 18h13"/>',
  alignJustify: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  chevron: '<path d="m7 10 5 5 5-5"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  divider: '<path d="M3.5 12h17"/><path d="M7 7h10M7 17h10" opacity=".4"/>',
  quote: '<path d="M5.5 5v14"/><path d="M10 7.5h9M10 12h9M10 16.5h6"/>',
  codeBlock: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="m10 9.5-2.5 2.5 2.5 2.5"/><path d="m14 9.5 2.5 2.5-2.5 2.5"/>',
  text: '<path d="M5.5 7V5h13v2"/><path d="M12 5v14"/><path d="M9.5 19h5"/>',
  h1: '<path d="M4 6v12M11.5 6v12M4 12h7.5"/><path d="M15.5 9.5 18 8v10"/>',
  h2: '<path d="M4 6v12M11.5 6v12M4 12h7.5"/><path d="M15 10c.3-1.2 1.2-2 2.5-2 1.4 0 2.4.9 2.4 2.2 0 2.3-4.9 3.3-4.9 7.8h5"/>',
  h3: '<path d="M4 6v12M11.5 6v12M4 12h7.5"/><path d="M15.2 9.3c.4-.8 1.2-1.3 2.2-1.3 1.3 0 2.3.8 2.3 2s-1 2-2.4 2c1.6 0 2.7.9 2.7 2.3S18.8 17 17.2 17c-1 0-1.9-.5-2.3-1.3"/>',
  clear: '<path d="M5.5 7V5h11v2"/><path d="M11 5 8.5 19"/><path d="m14.5 14.5 5 5M19.5 14.5l-5 5"/>',
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2.5"/><path d="M6.5 10h.01M10 10h.01M14 10h.01M17.5 10h.01M8 14.5h8"/>',
  external: '<path d="M13.5 4.5h6v6"/><path d="M19.5 4.5 11 13"/><path d="M18 14v4a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 5 18V8a1.5 1.5 0 0 1 1.5-1.5h4"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6A1.5 1.5 0 0 0 14 4.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/>',
  pencil: '<path d="M14.5 5.5 18.5 9.5"/><path d="M4.5 19.5 5.5 15 16 4.5a2.1 2.1 0 0 1 3 3L8.5 18z"/>',
  unlink: '<path d="M10 14a4.5 4.5 0 0 0 6.4 0l1.5-1.5"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-1.5 1.5"/><path d="m4.5 4.5 15 15"/>',
  indent: '<path d="M4 6h16M11 12h9M4 18h16"/><path d="m4 9.5 3 2.5-3 2.5"/>',
  outdent: '<path d="M4 6h16M11 12h9M4 18h16"/><path d="m7 9.5-3 2.5 3 2.5"/>',
  grip: '<circle cx="9" cy="6" r="1.45" fill="currentColor" stroke="none"/><circle cx="15" cy="6" r="1.45" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1.45" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.45" fill="currentColor" stroke="none"/><circle cx="9" cy="18" r="1.45" fill="currentColor" stroke="none"/><circle cx="15" cy="18" r="1.45" fill="currentColor" stroke="none"/>',
  plus: '<path d="M12 5.5v13M5.5 12h13"/>',
  duplicate: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6A1.5 1.5 0 0 0 14 4.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/><path d="M14 11.5v5M11.5 14h5"/>',
  clipboard: '<rect x="5.5" y="5" width="13" height="15.5" rx="2"/><path d="M9.5 5V4.2c0-.4.3-.7.7-.7h3.6c.4 0 .7.3.7.7V5"/><path d="M9 11h6M9 15h4"/>',
  trash: '<path d="M4.5 7h15"/><path d="M9.5 7V5.2c0-.4.3-.7.7-.7h3.6c.4 0 .7.3.7.7V7"/><path d="m6.5 7 .8 11.3c.1.9.8 1.7 1.8 1.7h5.8c1 0 1.7-.8 1.8-1.7L17.5 7"/>',
  arrowUp: '<path d="M12 19V5.5"/><path d="m6.5 11 5.5-5.5 5.5 5.5"/>',
  arrowDown: '<path d="M12 5v13.5"/><path d="m6.5 13 5.5 5.5 5.5-5.5"/>',
  table: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M3.5 9.5h17M3.5 14.5h17M9.5 9.5v10M14.5 9.5v10"/>',
  tableHeader: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M3.5 9.5h17M9.5 9.5v10M14.5 9.5v10"/><rect x="5" y="6" width="14" height="2.2" rx="1" fill="currentColor" stroke="none" opacity=".45"/>',
  rowAbove: '<rect x="3.5" y="12" width="17" height="7.5" rx="2"/><path d="M12 3.5v6M9 6.5h6"/>',
  rowBelow: '<rect x="3.5" y="4.5" width="17" height="7.5" rx="2"/><path d="M12 14.5v6M9 17.5h6"/>',
  colLeft: '<rect x="12" y="3.5" width="7.5" height="17" rx="2"/><path d="M3.5 12h6M6.5 9v6"/>',
  colRight: '<rect x="4.5" y="3.5" width="7.5" height="17" rx="2"/><path d="M14.5 12h6M17.5 9v6"/>',
  moreV: '<circle cx="12" cy="5.5" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="18.5" r="1.3" fill="currentColor" stroke="none"/>'
};

// Theme-aware colour palette: [light text, light highlight, dark text, dark highlight].
// Colours are stored as classes (tc-*/hl-*), never as hex, so they re-tint in dark mode.
const PALETTE: Record<string, [string, string, string, string]> = {
  gray: ["#787774", "#ebebe9", "#a3a3a3", "#3a3a3a"],
  brown: ["#9f6b53", "#f1e5df", "#c08f78", "#4a3228"],
  orange: ["#d9730d", "#fbe4cf", "#d98a52", "#5c3b23"],
  yellow: ["#b7891c", "#fbefc4", "#d1a457", "#564328"],
  green: ["#448361", "#ddede3", "#5bad7e", "#243d30"],
  blue: ["#337ea9", "#dbeaf5", "#6aa5dd", "#173b52"],
  purple: ["#9065b0", "#ebe3f3", "#ae84dc", "#3c2d49"],
  pink: ["#c14c8a", "#f6dfeb", "#d96aa5", "#4e2c3c"],
  red: ["#d44c47", "#fadedc", "#e8706b", "#522e2a"]
};
const COLORS = [{ key: "default", label: "Default" }, ...Object.keys(PALETTE).map((key) => ({ key, label: key[0].toUpperCase() + key.slice(1) }))];
const COLOR_KEYS = new Set(COLORS.map((c) => c.key));
// execCommand only knows literal colours, so each palette entry is applied as a
// unique "sentinel" colour and immediately rewritten into a class.
const sentinel = (kind: ColorKind, idx: number) => `#010${kind === "tc" ? 2 : 3}${(10 + idx).toString(16).padStart(2, "0")}`;

/** The two palette mark kinds: text colour and highlight. */
type ColorKind = "tc" | "hl";

const FONTS: { key: DocFont; label: string; stack: string }[] = [
  { key: "sans", label: "Default", stack: "var(--font-sans)" },
  { key: "serif", label: "Serif", stack: "var(--font-serif)" },
  { key: "mono", label: "Mono", stack: "var(--font-mono)" }
];

/* ═════════════════════════════ 2. Styles ═════════════════════════════════ */

const paletteCss = (() => {
  const light: string[] = [], dark: string[] = [], classes: string[] = [];
  for (const [key, [lt, lh, dt, dh]] of Object.entries(PALETTE)) {
    light.push(`--tc-${key}:${lt};--hl-${key}:${lh};`);
    dark.push(`--tc-${key}:${dt};--hl-${key}:${dh};`);
    classes.push(`.editor .tc-${key}{color:var(--tc-${key})}`);
    classes.push(`.editor .hl-${key}{background-color:var(--hl-${key});box-shadow:0 0 0 .1em var(--hl-${key})}`);
  }
  return { light: light.join(""), dark: dark.join(""), classes: classes.join("\n") };
})();

const CSS = `
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
  --font-sans: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif;
  --font-serif: "Iowan Old Style", Charter, "Bitstream Charter", "Sitka Text", Cambria, Georgia, ui-serif, serif;
  --font-mono: ui-monospace, "SF Mono", "JetBrains Mono", "Cascadia Code", Menlo, Consolas, monospace;
  --bar-h: 48px;
  ${paletteCss.light}
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
    ${paletteCss.dark}
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
button { font: inherit; color: inherit; }
* { scrollbar-width: thin; scrollbar-color: var(--line-strong) transparent; }
*::-webkit-scrollbar { width: 10px; height: 10px; }
*::-webkit-scrollbar-thumb { background: var(--line-strong); border-radius: 10px; border: 3px solid transparent; background-clip: content-box; }
*::-webkit-scrollbar-track { background: transparent; }

/* ── Canvas & top bar ───────────────────────────────────────────────────── */
.canvas {
  position: fixed; inset: 0;
  overflow-y: auto; overflow-x: hidden;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  scroll-padding: calc(var(--bar-h) + 24px) 0 96px;
}
.bar {
  position: sticky; top: 0; z-index: 30;
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
@media (max-width: 900px) {
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
.tb svg { flex: 0 0 auto; }
.tb .chev { display: inline-flex; color: var(--faint); margin-right: -3px; transition: transform .18s var(--ease); }
.tb.open .chev { transform: rotate(180deg); }
.tb:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.tb.block-type { width: 124px; justify-content: space-between; padding: 0 6px 0 10px; font-size: 13px; font-weight: 500; letter-spacing: -0.006em; }
.tb.block-type .label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tb.color .bar-swatch { position: absolute; left: 9px; right: 9px; bottom: 4px; height: 2.5px; border-radius: 2px; background: currentColor; opacity: .0; transition: opacity .15s; }
.tb.color.has-color .bar-swatch { opacity: 1; }
.tb.color .hl-swatch { position: absolute; inset: 5px 6px; border-radius: 5px; }
.tb.color svg { position: relative; }
.tb.aa { font-size: 14px; font-weight: 600; letter-spacing: -0.01em; padding: 0 8px; }
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
/* Editing paused: one small card at the bottom says why, and offers the way out.
   The document stays fully readable (and copyable); only editing stops. */
.pause-wrap {
  position: fixed; left: 0; right: 0; bottom: max(20px, env(safe-area-inset-bottom)); z-index: 65;
  display: flex; justify-content: center; padding: 0 12px; pointer-events: none;
}
.pause-pill {
  display: flex; align-items: center; gap: 2px; max-width: 100%; min-width: 0;
  padding: 5px 5px 5px 14px; border-radius: 12px;
  background: var(--raised); color: var(--text); box-shadow: var(--shadow-pop);
  font: 13px var(--font-ui);
  opacity: 0; visibility: hidden; transform: translateY(8px) scale(.98);
  transition: opacity .22s var(--ease), transform .22s var(--ease), visibility 0s linear .22s;
}
.pause-pill.show { opacity: 1; visibility: visible; transform: none; pointer-events: auto; transition: opacity .22s var(--ease), transform .22s var(--ease); }
.pp-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--bad); flex: 0 0 auto; margin-right: 8px; }
.pp-dot.live { animation: breathe 1.1s ease-in-out infinite; }
.pp-dot.calm { background: var(--accent); }
.pp-label { min-width: 0; margin-right: 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pp-btn {
  height: 28px; padding: 0 11px; border: 0; border-radius: 8px; flex: 0 0 auto;
  background: transparent; color: var(--text); font: 500 12.5px var(--font-ui); white-space: nowrap; cursor: pointer;
  transition: background-color .12s var(--ease), filter .12s var(--ease);
}
.pp-btn:hover { background: var(--hover); }
.pp-btn.primary { background: var(--accent); color: #fff; }
.pp-btn.primary:hover { filter: brightness(1.07); }
.pp-btn:disabled { cursor: default; opacity: .75; }
body.doc-paused .bar .tb { opacity: .35; pointer-events: none; }
body.doc-paused .editor { cursor: default; }
body.doc-paused .bh, body.doc-paused .blk-box, body.doc-paused .blk-drop, body.doc-paused .tbl-ui,
body.doc-paused .tbl-focus, body.doc-paused .image-controls { display: none !important; }
@media print { .pause-wrap { display: none !important; } }

@media (max-width: 900px) { .status:not(.show) { display: none; } }
@keyframes breathe { 0%, 100% { opacity: 1; } 50% { opacity: .25; } }

/* ── Page & typography ──────────────────────────────────────────────────── */
.page {
  --measure: 700px;
  --gutter: clamp(20px, 5.5vw, 52px);
  --doc-font: var(--font-sans); --doc-size: 16px; --doc-lh: 1.65;
  position: relative;
  max-width: calc(var(--measure) + 2 * var(--gutter));
  margin: 0 auto;
  transition: max-width .32s var(--ease);
}
.page.wide { --measure: 980px; }
.page[data-font="serif"] { --doc-font: var(--font-serif); --doc-size: 18px; --doc-lh: 1.6; }
.page[data-font="mono"] { --doc-font: var(--font-mono); --doc-size: 14.5px; --doc-lh: 1.7; }

.editor {
  min-height: calc(100vh - var(--bar-h));
  padding: 36px var(--gutter) 45vh;
  outline: none;
  font-family: var(--doc-font); font-size: var(--doc-size); line-height: var(--doc-lh);
  color: var(--text); caret-color: var(--accent);
  font-kerning: normal; font-variant-ligatures: common-ligatures contextual;
  font-feature-settings: "kern", "calt";
  overflow-wrap: break-word;
  hanging-punctuation: first;
}
.editor[contenteditable="false"] { caret-color: transparent; }
.editor > :first-child { margin-top: 0 !important; }
.editor p { margin: 0 0 .8em; }
.editor h1, .editor h2, .editor h3, .editor h4 { color: var(--text); scroll-margin-top: calc(var(--bar-h) + 20px); }
.editor h1 { font-size: 1.875em; line-height: 1.22; font-weight: 680; letter-spacing: -0.024em; margin: 1.5em 0 .42em; }
.editor h2 { font-size: 1.4em; line-height: 1.3; font-weight: 640; letter-spacing: -0.017em; margin: 1.45em 0 .38em; }
.editor h3, .editor h4 { font-size: 1.15em; line-height: 1.4; font-weight: 620; letter-spacing: -0.009em; margin: 1.3em 0 .3em; }
.editor h1.doc-title { font-size: 2.3em; letter-spacing: -0.028em; margin-bottom: .3em; }
.page[data-font="serif"] .editor h1, .page[data-font="serif"] .editor h2, .page[data-font="serif"] .editor h3 { font-weight: 600; letter-spacing: -0.008em; }
.page[data-font="mono"] .editor h1, .page[data-font="mono"] .editor h2, .page[data-font="mono"] .editor h3 { letter-spacing: -0.01em; font-weight: 600; }
.editor b, .editor strong { font-weight: 640; }
.page[data-font="serif"] .editor b, .page[data-font="serif"] .editor strong { font-weight: 700; }
.editor a {
  color: inherit; cursor: text;
  text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: .22em;
  text-decoration-color: color-mix(in srgb, var(--accent) 55%, transparent);
  transition: text-decoration-color .15s var(--ease);
}
.editor a:hover { text-decoration-color: var(--accent); }
.editor code {
  font-family: var(--font-mono); font-size: .86em;
  background: var(--code-bg); border-radius: .3em; padding: .12em .32em;
  -webkit-box-decoration-break: clone; box-decoration-break: clone;
}
.page[data-font="mono"] .editor code { font-size: .95em; }
.editor pre {
  margin: 0 0 1em; padding: 14px 16px;
  background: var(--code-bg); border-radius: 9px;
  /* In em, so it scales with the text in print and export: 13.5px on screen. */
  font-family: var(--font-mono); font-size: .84375em; line-height: 1.6;
  white-space: pre-wrap; overflow-wrap: anywhere; tab-size: 2;
}
.page[data-font="serif"] .editor pre { font-size: .75em; }
.page[data-font="mono"] .editor pre { font-size: .93103em; }
.editor pre code { background: none; padding: 0; font-size: inherit; }
.editor p, .editor h1, .editor h2, .editor h3, .editor h4, .editor h5, .editor h6, .editor div { --ph-x: 0px; }
.editor blockquote { --ph-x: 1em; margin: 0 0 1em; padding: 0 0 0 var(--ph-x); border-left: 2px solid var(--line-strong); color: var(--text-2); }
.editor blockquote[style*="margin"] { border-left: 0; color: inherit; }
.editor hr { border: 0; height: 1px; background: var(--line-strong); margin: 2em 0; }
.editor ul, .editor ol { margin: 0 0 .8em; padding-left: 1.55em; }
.editor li { --ph-x: .2em; margin: .22em 0; padding-left: var(--ph-x); }
.editor li > ul, .editor li > ol, .editor ul > ul, .editor ol > ol, .editor ul > ol, .editor ol > ul { margin: .22em 0 0; }
.editor li::marker { color: var(--muted); }
.editor ol > li::marker { font-variant-numeric: tabular-nums; }
.editor ul ul, .editor ul > li > ul { list-style-type: circle; }
.editor ul ul ul, .editor ul > li > ul > li > ul { list-style-type: square; }
.editor ol ol, .editor ol > li > ol { list-style-type: lower-alpha; }
.editor ol ol ol, .editor ol > li > ol > li > ol { list-style-type: lower-roman; }
.editor ul.checklist, .editor ul.checklist ul { list-style: none; padding-left: 0; }
.editor ul.checklist ul { padding-left: 1.6em; }
.editor ul.checklist li { --ph-x: 1.7em; position: relative; list-style: none; }
.editor ul.checklist li::before {
  content: ""; position: absolute; left: .1em; top: calc((var(--doc-lh) * 1em - 1.05em) / 2);
  width: 1.05em; height: 1.05em; border-radius: .3em;
  box-shadow: inset 0 0 0 1.5px var(--faint);
  background: var(--bg) no-repeat center / 0 auto;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='3.2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m5 12.5 4.5 4.5L19 7.5'/%3E%3C/svg%3E");
  cursor: pointer;
  transition: background-color .16s var(--ease), box-shadow .16s var(--ease), background-size .2s var(--ease);
}
.editor ul.checklist li:hover::before { box-shadow: inset 0 0 0 1.5px var(--muted); }
.editor ul.checklist li[data-checked="true"]::before { background-color: var(--accent); box-shadow: inset 0 0 0 1.5px var(--accent); background-size: 72% auto; }
.editor ul.checklist li[data-checked="true"] { color: var(--muted); text-decoration: line-through; text-decoration-color: var(--faint); text-decoration-thickness: 1px; }
.editor img.doc-image {
  display: block; max-width: 100%; height: auto; margin: 1.1em 0;
  border-radius: 6px; outline: 1px solid var(--line); outline-offset: -1px; cursor: default;
}
.editor img.doc-image.image-selected { outline: 2px solid var(--accent); outline-offset: 2px; }
.editor .tc-default { color: var(--text); }
.editor .hl-default { background-color: transparent; }
.editor [class*="hl-"] { border-radius: .2em; -webkit-box-decoration-break: clone; box-decoration-break: clone; }
${paletteCss.classes}
.editor.drop-target { box-shadow: inset 0 0 0 2px var(--accent-soft); border-radius: 12px; }

/* Empty-line hints. The hint is drawn by the empty line itself (data-ph), so
   it is always laid out inside that line's own box -- after a checkbox or
   bullet, never on top of it -- and disappears with the line. --ph-x is the
   line's left padding: every rule that sets a left padding on a line sets it
   through --ph-x, so the hint and the caret always start at the same x. */
.editor [data-ph] { position: relative; }
.editor [data-ph]::after {
  content: attr(data-ph);
  position: absolute; top: 0; left: var(--ph-x, 0); right: 0;
  color: var(--faint); font-weight: inherit; font-style: normal;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: inherit;
  pointer-events: none; user-select: none; -webkit-user-select: none;
}
.editor[contenteditable="true"]:empty::before { content: attr(data-empty-ph); color: var(--faint); pointer-events: none; }

.skeleton { position: absolute; left: var(--gutter); right: var(--gutter); top: 40px; pointer-events: none; opacity: 0; animation: sk-in .3s .25s var(--ease) forwards; transition: opacity .2s; }
.skeleton.gone { opacity: 0 !important; animation: none; }
.sk { height: 11px; border-radius: 6px; margin: 0 0 16px; background: linear-gradient(90deg, var(--code-bg) 0%, var(--hover) 40%, var(--code-bg) 80%); background-size: 300% 100%; animation: shimmer 1.6s linear infinite; }
.sk.h { height: 22px; width: 42%; margin-bottom: 26px; }
@keyframes shimmer { from { background-position: 100% 0; } to { background-position: -200% 0; } }
@keyframes sk-in { to { opacity: 1; } }

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
/* Menu rows: the icon is centred on the row; label, shortcut and check share
   one baseline inside .mi-text, so a shortcut set in a different size or font
   still sits exactly on the label's line. */
.mi {
  display: flex; align-items: center; gap: 10px;
  padding: 6px 10px 6px 7px; border-radius: 7px;
  cursor: pointer; user-select: none; white-space: nowrap;
}
.mi:hover, .mi.active, .mi:focus-visible { background: var(--hover); }
.mi:focus { outline: none; }
.mi-icon { width: 22px; height: 22px; flex: 0 0 auto; display: flex; align-items: center; justify-content: center; color: var(--muted); }
.mi-icon svg { display: block; }
.mi-text { flex: 1 1 auto; min-width: 0; display: flex; align-items: baseline; }
.mi-label { flex: 1 1 auto; line-height: 20px; }
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
.slash { width: 272px; }
.slash .mi { padding-top: 5px; padding-bottom: 5px; }
.slash .mi-icon { width: 30px; height: 30px; border-radius: 7px; background: var(--bg); box-shadow: inset 0 0 0 1px var(--line); color: var(--text-2); }

/* Shortcut glyphs. On a Mac each single-character key gets its own fixed-width
   cell, so ⌥⌘1 and ⇧⌘8 line up column for column down a menu. */
.k { display: inline-block; text-align: center; }
.mac .k-g { min-width: 1.12em; }
.k-plus { display: inline-block; margin: 0 .1em; opacity: .7; }
.mempty { padding: 10px; color: var(--faint); }

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

.type-pop { width: 252px; }
.tiles { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; padding: 2px; }
.tile { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 12px 4px 9px; border: 0; border-radius: 9px; background: transparent; cursor: pointer; transition: background-color .12s; }
.tile:hover { background: var(--hover); }
.tile .ag { font-size: 25px; line-height: 1; color: var(--text); transition: color .15s; }
.tile .tl { font-size: 11.5px; color: var(--muted); }
.tile.on .ag { color: var(--accent); }
.tile.on .tl { color: var(--text); font-weight: 550; }
.toggle-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 36px; padding: 0 10px; border-radius: 7px; cursor: pointer; user-select: none; }
.toggle-row:hover { background: var(--hover); }
.switch { width: 28px; height: 16px; border-radius: 8px; background: var(--line-strong); position: relative; flex: 0 0 auto; transition: background-color .2s var(--ease); }
.switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.25); transition: transform .2s var(--ease); }
.switch.on { background: var(--accent); }
.switch.on::after { transform: translateX(12px); }

.link-card { display: flex; align-items: center; gap: 2px; min-width: 0; padding: 3px; }
.pop.link-pop { min-width: 0; padding: 0; }
.link-card input { flex: 1 1 auto; width: 260px; min-width: 0; height: 30px; border: 0; outline: 0; background: transparent; color: var(--text); font: 13px var(--font-ui); padding: 0 6px; }
.link-card input::placeholder { color: var(--faint); }
.lc-icon { display: inline-flex; color: var(--muted); padding-left: 6px; }
.lc-enter { display: flex; align-items: center; height: 30px; padding: 0 9px 0 6px; font: 12px/1 var(--font-ui); color: var(--faint); }
.lc-url { display: inline-flex; align-items: baseline; max-width: 250px; padding: 0 8px 0 9px; overflow: hidden; white-space: nowrap; color: var(--text); text-decoration: none; font-size: 13px; }
.lc-url:hover .lc-host { text-decoration: underline; text-underline-offset: 3px; }
.lc-host { font-weight: 550; flex: 0 0 auto; }
.lc-path { color: var(--muted); overflow: hidden; text-overflow: ellipsis; }
.link-card .tb { height: 28px; min-width: 28px; }
/* New link with nothing selected: the address row, then the words to show. */
.link-card.lc-new { flex-direction: column; align-items: stretch; gap: 0; }
.lc-row { display: flex; align-items: center; gap: 2px; min-width: 0; }
.lc-rule { height: 1px; margin: 2px 9px; background: var(--line); }
.lc-new .lc-text-row .lc-icon { color: var(--faint); }
.lc-new .lc-text-row:focus-within .lc-icon { color: var(--muted); }
.lc-new .lc-text-row input { padding-right: 32px; }
/* The text being linked stays highlighted while focus is in the link field. */
.lc-sel-layer { position: absolute; left: 0; top: 0; width: 0; height: 0; pointer-events: none; z-index: 1; }
.lc-sel-layer > div { position: absolute; left: 0; top: 0; background: var(--selection); border-radius: 1px; }
@media print { .lc-sel-layer { display: none !important; } }
.link-card .sep { margin: 0 3px; height: 16px; }

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
.sheet { width: min(620px, 100%); max-height: min(78vh, 680px); overflow-y: auto; padding: 22px 24px 18px; background: var(--raised); border-radius: 14px; box-shadow: var(--shadow-pop); animation: pop-in .2s var(--ease); }
.sheet h2 { margin: 0 0 4px; font-size: 15px; font-weight: 620; letter-spacing: -0.01em; }
.sheet .sub { margin: 0 0 16px; color: var(--muted); font-size: 12.5px; }
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

/* ── Outline ────────────────────────────────────────────────────────────── */
.outline {
  position: fixed; right: 18px; top: 50%; transform: translateY(-50%); z-index: 20;
  display: flex; flex-direction: column; gap: 1px;
  max-height: 64vh; max-width: 260px; padding: 8px 6px; border-radius: 11px;
  overflow: hidden;
  transition: background-color .2s var(--ease), box-shadow .2s var(--ease), opacity .2s;
}
.outline.hidden { opacity: 0; pointer-events: none; }
.outline:hover { background: var(--raised); box-shadow: var(--shadow-pop); overflow-y: auto; }
.ol-item { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 22px; padding: 0 4px; border-radius: 5px; cursor: pointer; }
.ol-item:hover { background: var(--hover); }
.ol-label { max-width: 0; opacity: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 12.5px; color: var(--muted); transition: max-width .24s var(--ease), opacity .16s var(--ease); }
.outline:hover .ol-label { max-width: 220px; opacity: 1; }
.ol-item[data-level="2"] .ol-label { padding-left: 10px; }
.ol-item[data-level="3"] .ol-label { padding-left: 20px; }
.ol-item:hover .ol-label, .ol-item.active .ol-label { color: var(--text); }
.ol-dash { flex: 0 0 auto; margin-left: auto; height: 2px; border-radius: 2px; background: var(--line-strong); transition: background-color .2s var(--ease); }
.ol-item[data-level="1"] .ol-dash { width: 16px; }
.ol-item[data-level="2"] .ol-dash { width: 11px; }
.ol-item[data-level="3"] .ol-dash { width: 7px; }
.ol-item.active .ol-dash { background: var(--text-2); }

/* ── Images ─────────────────────────────────────────────────────────────── */
.image-controls { position: fixed; z-index: 25; pointer-events: none; display: none; }
.img-handle {
  position: absolute; right: -6px; top: 50%; width: 8px; height: 44px; margin-top: -22px;
  border-radius: 4px; background: var(--raised);
  box-shadow: 0 0 0 1px var(--line-strong), 0 2px 8px rgba(0,0,0,.18);
  cursor: ew-resize; pointer-events: auto; touch-action: none;
  transition: transform .12s var(--ease);
}
.img-handle:hover { transform: scaleY(1.08); }
.img-badge { position: absolute; top: 8px; right: 8px; padding: 3px 7px; border-radius: 6px; background: rgba(20,20,24,.72); color: #fff; font-size: 11px; font-variant-numeric: tabular-nums; opacity: 0; transition: opacity .15s; }
.image-controls.resizing .img-badge { opacity: 1; }

/* ── Export & print ─────────────────────────────────────────────────────── */
html.document-export, html.document-export body { height: auto; overflow: visible; background: #fff; }
html.document-export .canvas { position: static; overflow: visible; }
html.document-export .page { max-width: none; }
html.document-export .editor { min-height: 0; padding: 0; font-size: calc(var(--doc-size) * .72); }
html.document-export .editor h1, html.document-export .editor h2, html.document-export .editor h3 { break-after: avoid-page; }
html.document-export .editor img, html.document-export .editor pre, html.document-export .editor blockquote { break-inside: avoid-page; }
@media screen { html.document-export body { padding: 0.7in; } html.document-export .page { max-width: 7.1in; } }
@page { margin: 0.7in; }
@media print {
  html, body { height: auto; overflow: visible; background: #fff; }
  .canvas { position: static; overflow: visible; }
  .bar, .outline, .image-controls, .pop, .tip, .sheet-overlay, .skeleton { display: none !important; }
  .editor [data-ph]::after, .editor:empty::before { content: none !important; }
  .page { max-width: none; }
  .editor { min-height: 0; padding: 0; font-size: calc(var(--doc-size) * .72); }
  .editor h1, .editor h2, .editor h3 { break-after: avoid-page; }
  .editor img, .editor pre, .editor blockquote { break-inside: avoid-page; }
  .editor img.doc-image.image-selected { outline: 1px solid var(--line); outline-offset: -1px; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: .01ms !important; transition-duration: .01ms !important; }
}
`;
document.head.appendChild(el("style", { text: CSS }));

/* ═════════════════════════════ 3. Layout ═════════════════════════════════ */

// The editor holds HTML and nothing else (normalize() keeps every child an HTML block element), so
// its children are typed as what they are.
interface EditorElement extends HTMLDivElement {
  readonly children: HTMLCollectionOf<HTMLElement>;
  readonly firstElementChild: HTMLElement | null;
  readonly lastElementChild: HTMLElement | null;
}
const editor = el("div", { class: "editor", role: "textbox", "aria-multiline": "true", "aria-label": "Document", spellcheck: "true", contenteditable: "false" }) as EditorElement;
const skeleton = el("div", { class: "skeleton", "aria-hidden": "true" }, [
  el("div", { class: "sk h" }), el("div", { class: "sk", style: { width: "94%" } }), el("div", { class: "sk", style: { width: "88%" } }),
  el("div", { class: "sk", style: { width: "91%" } }), el("div", { class: "sk", style: { width: "56%" } })
]);
const page = el("div", { class: "page", "data-font": "sans" }, [skeleton, editor]);
const tools = el("div", { class: "tools", role: "toolbar", "aria-label": "Formatting" });
const barRight = el("div", { class: "bar-right" });
const bar = el("header", { class: "bar" }, [tools, barRight]);
const canvas = el("main", { class: "canvas" }, [bar, page]);
const outline = el("nav", { class: "outline hidden", "aria-label": "Outline" });
const imageBadge = el("div", { class: "img-badge" });
const imageHandle = el("div", { class: "img-handle", title: "Drag to resize" });
const imageControls = el("div", { class: "image-controls" }, [imageBadge, imageHandle]);
const imageInput = el("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/gif", multiple: true, style: { display: "none" } });
document.body.append(canvas, outline, imageControls, imageInput);

try { document.execCommand("styleWithCSS", false, false); } catch {}
try { document.execCommand("defaultParagraphSeparator", false, "p"); } catch {}

/* ══════════════════════ 4. Selection & structure ════════════════════════ */

let composing = false;
let applyingRule = false;
// Block editing state (see section 8½); declared early because the toolbar
// and change pipeline consult it.
let blockSel: { anchor: Element; focus: Element } | null = null; // { anchor, focus } -- units; the selection is the run between them
let blockOpDepth = 0;
const blockHistory: { undo: BlockState[]; redo: BlockState[] } = { undo: [], redo: [] };
let lastRange: Range | null = null;

/** A selection boundary that survives DOM surgery: a node and offset, or (on the editor itself) the child it sat before. */
interface SavedPoint {
  node?: Node;
  offset?: number;
  ref?: Node | null;
  end?: boolean;
}
/** A saved selection: its anchor and focus. */
interface SavedSelection {
  a: SavedPoint;
  f: SavedPoint;
}
/** A DOM position: a node and an offset in it. */
type Point = [Node, number];

function getRange() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  return editor.contains(range.startContainer) && editor.contains(range.endContainer) ? range : null;
}
function setRange(range: Range) {
  if (document.activeElement !== editor) editor.focus({ preventScroll: true });
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
}
function placeCaret(node: Node, offset = 0) {
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  setRange(range);
}
// The last caret position inside `node`: the end of its last text, or just
// before a trailing <br>, so the caret lands on a real line rather than
// between elements.
function endPoint(node: Element): Point {
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  let last: Text | null = null;
  for (let t = walker.nextNode() as Text | null; t; t = walker.nextNode() as Text | null) if (t.data.replace(/\u200B/g, "")) last = t;
  if (last) return [last, last.data.length];
  let host: Element = node;
  while (host.lastElementChild && !/^(BR|IMG|HR)$/.test(host.lastElementChild.tagName)) host = host.lastElementChild;
  const br = host.lastChild;
  if (isElement(br) && br.tagName === "BR") return [host, host.childNodes.length - 1];
  return [host, host.childNodes.length];
}
function placeCaretAtEnd(node: Element = editor) {
  const [n, o] = endPoint(node);
  placeCaret(n, o);
}
// Make sure toolbar commands act on the user's last selection in the document,
// even if focus wandered to a menu or the page has just loaded.
function ensureSelection() {
  if (getRange() && document.activeElement === editor) return;
  editor.focus({ preventScroll: true });
  if (lastRange && editor.contains(lastRange.startContainer)) setRange(lastRange);
  else {
    if (!editor.firstElementChild) editor.appendChild(emptyParagraph());
    placeCaretAtEnd(editor.lastElementChild!);
  }
}
function closestEl(node: Node | null | undefined, selector: string): HTMLElement | null {
  const start = isElement(node) ? node : node?.parentElement;
  const found = start?.closest<HTMLElement>(selector);
  return found && found !== editor && editor.contains(found) ? found : null;
}
function topBlockOf(node: Node | null | undefined): HTMLElement | null {
  if (!node || !editor.contains(node) || node === editor) return null;
  let n: HTMLElement | null = isElement(node) ? node : node.parentElement;
  while (n && n.parentElement !== editor) n = n.parentElement;
  return n && n.parentElement === editor ? n : null;
}
const caretNode = () => getRange()?.startContainer ?? null;
const currentTopBlock = () => topBlockOf(caretNode());
const currentList = () => closestEl(caretNode(), "ul, ol");
const emptyParagraph = () => el("p", {}, [document.createElement("br")]);
function rangeRect(range: Range): DOMRect {
  const rects = range.getClientRects();
  if (rects.length) return rects[rects.length - 1];
  const r = range.getBoundingClientRect();
  if (r.width || r.height) return r;
  const host = (isElement(range.startContainer) ? range.startContainer : range.startContainer.parentElement)!;
  const hr = host.getBoundingClientRect();
  const lh = parseFloat(getComputedStyle(host).lineHeight) || 24;
  return new DOMRect(hr.left + (parseFloat(getComputedStyle(host).paddingLeft) || 0), hr.top, 1, Math.min(hr.height, lh));
}
function textBefore(block: Node, range: Range) {
  const r = document.createRange();
  r.selectNodeContents(block);
  r.setEnd(range.startContainer, range.startOffset);
  return r.toString();
}
// Text with <br> rendered as "\n" -- needed inside code blocks.
function textWithBreaks(fragmentOrNode: Node) {
  let out = "";
  const walk = (n: Node) => {
    if (isText(n)) out += n.data;
    else if (isElement(n) && n.tagName === "BR") out += "\n";
    else n.childNodes?.forEach(walk);
  };
  walk(fragmentOrNode);
  return out;
}
// Moves the parts of `wrapper` before and after `range` into copies of it beside it.
function splitAtRange(wrapper: Element, range: Range) {
  for (const after of [true, false]) {
    const boundary: Point = after ? [range.endContainer, range.endOffset] : [range.startContainer, range.startOffset];
    if (!wrapper.contains(boundary[0])) continue;
    const part = document.createRange();
    part.selectNodeContents(wrapper);
    if (after) part.setStart(...boundary);
    else part.setEnd(...boundary);
    if (part.collapsed) continue;
    const copy = wrapper.cloneNode(false) as Element;
    copy.appendChild(part.extractContents());
    if (copy.textContent || copy.querySelector("img, br")) {
      if (after) wrapper.after(copy);
      else wrapper.before(copy);
    }
  }
}
function unwrap(node: ChildNode) {
  const parent = node.parentNode;
  if (!parent) return;
  while (node.firstChild) parent.insertBefore(node.firstChild, node);
  node.remove();
}

// Selection snapshots survive DOM surgery as long as the boundary nodes do.
function savePoint(node: Node, offset: number): SavedPoint {
  if (node === editor) return { ref: editor.childNodes[offset] || null, end: offset >= editor.childNodes.length };
  return { node, offset };
}
function saveSelection(): SavedSelection | null {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !editor.contains(sel.anchorNode) || !editor.contains(sel.focusNode)) return null;
  return { a: savePoint(sel.anchorNode!, sel.anchorOffset), f: savePoint(sel.focusNode!, sel.focusOffset) };
}
function resolvePoint(p: SavedPoint): Point | null {
  if (p.node) {
    if (!p.node.isConnected || !editor.contains(p.node)) return null;
    return [p.node, Math.min(p.offset!, isText(p.node) ? p.node.data.length : p.node.childNodes.length)];
  }
  if (p.end) return [editor, editor.childNodes.length];
  if (!p.ref || !p.ref.isConnected || !editor.contains(p.ref)) return null;
  const parent = p.ref.parentNode!;
  return [parent, Array.prototype.indexOf.call(parent.childNodes, p.ref)];
}
function restoreSelection(saved: SavedSelection | null) {
  if (!saved || document.activeElement !== editor) return;
  const a = resolvePoint(saved.a), f = resolvePoint(saved.f);
  if (!a || !f) return;
  const sel = window.getSelection()!;
  if (sel.rangeCount && sel.anchorNode === a[0] && sel.anchorOffset === a[1] && sel.focusNode === f[0] && sel.focusOffset === f[1]) return;
  try { sel.setBaseAndExtent(a[0], a[1], f[0], f[1]); } catch {}
}
function keepSelection<T>(fn: () => T): T {
  const saved = saveSelection();
  try { return fn(); } finally { restoreSelection(saved); }
}

// ── Block model ──────────────────────────────────────────────────────────
// Every direct child of the editor is a block with a stable data-block-id.
const BLOCK_LEVEL = new Set(["P", "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "BLOCKQUOTE", "PRE", "HR", "DIV", "TABLE", "FIGURE", "SECTION", "ARTICLE", "HEADER", "FOOTER", "ASIDE", "NAV", "DL", "ADDRESS", "DETAILS", "MAIN"]);
function newBlockId() {
  if (typeof globalThis.crypto?.randomUUID === "function") return "b_" + crypto.randomUUID();
  return "b_" + Date.now().toString(36) + Math.random().toString(36).slice(2);
}
const blockId = (node: Node | null | undefined) => isElement(node) ? node.getAttribute("data-block-id") : null;
function findBlock(id: string | null) {
  for (const node of editor.children) if (blockId(node) === id) return node;
  return null;
}

// The first caret position inside `node`: the start of its first line of text,
// or just inside the innermost first container (e.g. an empty list item).
function startPoint(node: Element): Point {
  let host: Element = node;
  while (host.firstElementChild && !/^(BR|IMG|HR)$/.test(host.firstElementChild.tagName) && !host.firstChild?.nodeValue?.replace(/[\u200B\s]/g, "")) host = host.firstElementChild;
  const w = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  for (let t = w.nextNode() as Text | null; t; t = w.nextNode() as Text | null) if (t.data.replace(/\u200B/g, "")) return [t, 0];

  return [host, 0];
}
const hasContent = (n: Node) => isText(n)
  ? !!n.data.replace(/[\u200B\s\u00a0]/g, "")
  : isElement(n) && (n.tagName === "IMG" || !!n.querySelector("img") || !!n.textContent.replace(/[\u200B\s\u00a0]/g, ""));

// Chrome sometimes builds a list (or quote, code block…) *inside* a paragraph,
// e.g. when turning an empty line into a list. That is invalid HTML: it looks
// almost right on screen, but the browser's selection can sit in the
// paragraph's empty, invisible part, and after saving and reloading the list
// falls out of the paragraph leaving stray empty lines behind. Hoist such
// blocks to the top level right away, keep any real text around them as its
// own line, and move the caret along with the content it belonged to.
const LINE_TAGS = /^(P|H[1-6])$/;
const nestsBlocks = (n: Element) => LINE_TAGS.test(n.tagName) && Array.from(n.children).some((c) => BLOCK_LEVEL.has(c.tagName));
function unnestBlocks(saved: SavedSelection | null) {
  for (const outer of Array.from(editor.children)) {
    if (!nestsBlocks(outer)) continue;
    const pieces: { node: HTMLElement; index: number }[] = []; // { node, index } -- index: position of its first child within outer
    const removed: { node: ChildNode; index: number }[] = []; // { node, index }
    let run: ChildNode[] = [], runIndex = 0;
    const flushRun = () => {
      if (!run.length) return;
      if (run.some(hasContent)) {
        const line = document.createElement(outer.tagName);
        for (const a of Array.from(outer.attributes)) if (a.name !== "data-block-id" && a.name !== "data-ph") line.setAttribute(a.name, a.value);
        for (const n of run) line.appendChild(n);
        pieces.push({ node: line, index: runIndex });
      } else {
        for (const n of run) removed.push({ node: n, index: runIndex });
      }
      run = [];
    };
    Array.from(outer.childNodes).forEach((c, i) => {
      if (isElement(c) && BLOCK_LEVEL.has(c.tagName)) { flushRun(); pieces.push({ node: c, index: i }); }
      else { if (!run.length) runIndex = i; run.push(c); }
    });
    flushRun();
    // Where a caret point would be lost (on the wrapper itself, or in an empty
    // stretch that is dropped), send it to the start of the next piece.
    const pieceAt = (index: number) => (pieces.find((p) => p.index >= index) || pieces[pieces.length - 1]).node;
    if (saved) for (const p of [saved.a, saved.f]) {
      if (p.ref === outer) { p.ref = pieces[0].node; continue; }
      let index: number | null = null;
      if (p.node === outer) index = p.offset!;
      else {
        const hit = removed.find((r) => r.node === p.node || r.node.contains?.(p.node ?? null));
        if (hit) index = hit.index;
      }
      if (index !== null) {
        const [node, offset] = startPoint(pieceAt(index));
        p.node = node;
        p.offset = offset;
      }
    }
    for (const r of removed) r.node.remove();
    pieces[0].node.setAttribute("data-block-id", blockId(outer) || newBlockId());
    for (const p of pieces.slice(1)) if (p.node.parentElement === outer) p.node.removeAttribute("data-block-id");
    outer.replaceWith(...pieces.map((p) => p.node));
  }
}
// Loose text and inline nodes at the root (e.g. after removing a list) are
// gathered into paragraphs -- one per line -- moving the original nodes so the
// caret stays put.
function wrapLooseNodes(saved: SavedSelection | null) {
  const holdsCaret = (n: Node) => saved && (saved.a.node === n || saved.f.node === n);
  let line: ChildNode[] = [];
  const flush = (before: Node | null) => {
    if (!line.length) return;
    const p = document.createElement("p");
    editor.insertBefore(p, before);
    for (const n of line) p.appendChild(n);
    line = [];
    if (!p.textContent && !p.querySelector("br, img")) p.appendChild(document.createElement("br"));
  };
  for (const n of Array.from(editor.childNodes)) {
    if (isText(n)) {
      if (!n.data.trim() && !n.data.includes("\u00a0") && !holdsCaret(n)) { n.remove(); continue; }
      line.push(n);
    } else if (!isElement(n)) {
      (n as ChildNode).remove();
    } else if (BLOCK_LEVEL.has(n.tagName)) {
      flush(n);
    } else {
      const next = n.nextSibling;
      line.push(n);
      if (n.tagName === "BR") flush(next);
    }
  }
  flush(null);
}
// A line with no children at all has no height, so the caret can't be shown in
// it -- yet it would reappear as an empty line after a reload. Give it the
// <br> that makes it a real, visible line.
const CHILDLESS = ":scope > p:empty, :scope > h1:empty, :scope > h2:empty, :scope > h3:empty, :scope > h4:empty, :scope > h5:empty, :scope > h6:empty, :scope > div:empty, :scope > blockquote:empty, :scope > pre:empty, li:empty, td:empty, th:empty";
function fillChildless() {
  for (const n of editor.querySelectorAll(CHILDLESS)) n.appendChild(document.createElement("br"));
}

// Keep the document's structure valid after every change, then give every
// block a unique id (Enter clones the id onto the new paragraph).
function normalize() {
  if (composing || isExport) return;
  const needsUnnest = Array.from(editor.children).some(nestsBlocks);
  let needsWrap = false;
  for (const n of editor.childNodes) {
    if (!isElement(n) || !BLOCK_LEVEL.has(n.tagName)) { needsWrap = true; break; }
  }
  if (needsUnnest || needsWrap) {
    const saved = saveSelection();
    if (needsUnnest) unnestBlocks(saved);
    if (needsWrap) wrapLooseNodes(saved);
    restoreSelection(saved);
  }
  fillChildless();
  const seen = new Set();
  for (const n of editor.children) {
    const id = n.getAttribute("data-block-id");
    if (!id || seen.has(id)) {
      const fresh = newBlockId();
      n.setAttribute("data-block-id", fresh);
      seen.add(fresh);
    } else seen.add(id);
  }
}

function canonicalBlockHtml(node: Element): string {
  const clone = node.cloneNode(true) as Element;
  for (const n of clone.querySelectorAll("[data-block-id]")) n.removeAttribute("data-block-id");
  for (const n of clone.querySelectorAll(".image-selected")) n.classList.remove("image-selected");
  for (const n of clone.querySelectorAll("[data-reencode]")) n.removeAttribute("data-reencode");
  // Placeholder hints are display-only.
  for (const n of [clone, ...clone.querySelectorAll("[data-ph]")]) n.removeAttribute("data-ph");
  for (const n of [clone, ...clone.querySelectorAll("[class]")]) if (n.getAttribute("class") === "") n.removeAttribute("class");
  const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
  const empties: Text[] = [];
  for (let t = walker.nextNode() as Text | null; t; t = walker.nextNode() as Text | null) {
    if (t.data.includes(ZWSP)) {
      t.data = t.data.replace(/\u200B/g, "");
      if (!t.data) empties.push(t);
    }
  }
  for (const t of empties) t.remove();
  if (/^(P|H[1-6]|DIV|BLOCKQUOTE|PRE)$/.test(clone.tagName) && !clone.textContent && !clone.querySelector("br, img, hr")) clone.appendChild(document.createElement("br"));
  return clone.outerHTML;
}

// Some DOM shapes a browser can build (a list inside a paragraph, a heading in a
// heading) don't survive being saved as HTML and parsed again -- after a reload
// part of the block would silently vanish. Rebuild such a block from its own
// HTML now, while the caret can still be carried across.
function repairBlock(node: Element, html: string): boolean {
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  let parsed = Array.from(tpl.content.childNodes).filter((n) => isElement(n) || isText(n) && n.data.trim());
  if (parsed.length === 1 && isElement(parsed[0]) && parsed[0].outerHTML === html) return false;
  // The HTML parser leaves empty <p></p> husks where it splits an invalid
  // paragraph; they are not content.
  const husk = (n: Node) => isElement(n) && LINE_TAGS.test(n.tagName) && !hasContent(n) && !n.querySelector("br");
  if (parsed.some((n) => !husk(n))) parsed = parsed.filter((n) => !husk(n));
  // Parsing again can yield markup the live DOM didn't hold, so it is scrubbed like any remote block.
  parsed = parsed.filter((n) => !(isElement(n) && n.matches(UNSAFE_TAGS)));
  if (!parsed.length) return false;
  const caret = textOffsetsWithin(node);
  const nodes = parsed.map((n) => isElement(n) ? scrubElement(n) : el("p", {}, [n]));
  nodes.forEach((n, i) => i === 0 ? n.setAttribute("data-block-id", blockId(node) || newBlockId()) : n.removeAttribute("data-block-id"));
  node.replaceWith(...nodes);
  if (caret) restoreTextOffsets(nodes, caret);
  return true;
}
function textOffsetsWithin(node: Node): TextOffsets | null {
  const sel = window.getSelection();
  if (!sel?.rangeCount || document.activeElement !== editor) return null;
  if (!node.contains(sel.anchorNode) || !node.contains(sel.focusNode)) return null;
  const at = (n: Node, o: number) => { const r = document.createRange(); r.selectNodeContents(node); r.setEnd(n, o); return r.toString().length; };
  return { a: at(sel.anchorNode!, sel.anchorOffset), f: at(sel.focusNode!, sel.focusOffset) };
}
/** A selection as character offsets into a block's text: anchor and focus. */
interface TextOffsets {
  a: number;
  f: number;
}
function restoreTextOffsets(nodes: Element[], { a, f }: TextOffsets) {
  const find = (offset: number): Point => {
    let remaining = offset, last: Text | null = null;
    for (const root of nodes) {
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let t = w.nextNode() as Text | null; t; t = w.nextNode() as Text | null) {
        last = t;
        if (remaining <= t.data.length) return [t, remaining];
        remaining -= t.data.length;
      }
    }
    return last ? [last, last.data.length] : startPoint(nodes[0]);
  };
  const [an, ao] = find(a), [fn, fo] = find(f);
  try { window.getSelection()!.setBaseAndExtent(an, ao, fn, fo); } catch {}
}

// <noscript> parses as markup in an inert template but serializes its text verbatim in the live
// page, so text inside it could come back as live elements the next time the block is parsed.
const UNSAFE_TAGS = "script,style,iframe,frame,frameset,object,embed,link,meta,base,form,input,button,textarea,select,svg,math,noscript,template";
const URL_ATTRIBUTES = new Set(["href", "src", "xlink:href", "action", "formaction"]);
// `id` and `name` would make an element a named property of window or document, shadowing the
// DOM methods the editor calls (`<img name="createElement">`); the editor uses neither.
const NAMING_ATTRIBUTES = new Set(["id", "name"]);
function scrubElement<T extends Element>(root: T): T {
  root.querySelectorAll(UNSAFE_TAGS).forEach((node) => node.remove());
  for (const node of [root, ...root.querySelectorAll("*")]) {
    for (const attr of Array.from(node.attributes)) {
      const name = attr.name.toLowerCase();
      const compact = attr.value.replace(/[\s\u0000-\u001f]+/g, "").toLowerCase();
      if (name.startsWith("on") || name === "srcdoc" || name === "contenteditable" || NAMING_ATTRIBUTES.has(name) || URL_ATTRIBUTES.has(name) && /^(javascript|vbscript|data:text)/.test(compact)) {
        node.removeAttribute(attr.name);
      }
    }
  }
  return root;
}
function parseBlock(block: { id: string; html: string }): HTMLElement {
  const tpl = document.createElement("template");
  tpl.innerHTML = block.html;
  // An HTML template parses HTML elements.
  let node = tpl.content.firstElementChild as HTMLElement | null;
  if (!node || node.matches(UNSAFE_TAGS)) node = emptyParagraph();
  scrubElement(node);
  // The re-encode mark is this page's own and never saved; from elsewhere it would make every
  // page re-encode the image and save its own copy.
  for (const n of node.querySelectorAll("[data-reencode]")) n.removeAttribute("data-reencode");
  // Fill childless lines now, as normalize() would once the block is in the
  // editor. Otherwise the block's saved form changes later without anyone
  // typing, and the next remote edit to it looks like a local edit and is lost.
  for (const n of [node, ...node.querySelectorAll("li, td, th")]) {
    if (!n.firstChild && /^(P|H[1-6]|DIV|BLOCKQUOTE|PRE|LI|TD|TH)$/.test(n.tagName)) n.appendChild(document.createElement("br"));
  }
  node.setAttribute("data-block-id", block.id);
  return node;
}
function loadLegacyContent(html: string) {
  const tpl = document.createElement("template");
  tpl.innerHTML = html || "";
  tpl.content.querySelectorAll(UNSAFE_TAGS).forEach((node) => node.remove());
  for (const child of Array.from(tpl.content.children)) scrubElement(child);
  editor.replaceChildren(tpl.content);
  normalize();
}

/* ══════════════════════ 5. Commands & toolbar ═══════════════════════════ */

function exec(command: string, value: string | boolean | null = null) {
  if (editor.contentEditable !== "true") return false;
  ensureSelection();
  const line = command === "insertHTML" ? nestedLineAtCaret() : null;
  let ok = false;
  try { ok = document.execCommand(command, false, value); } catch {}
  if (line) rejoinLine(line);
  return ok;
}
// Chrome's insertHTML at the end of a line nested in another block (an
// indented paragraph is <blockquote style="margin…"><p>…</p></blockquote>)
// drops the inserted content *after* the <p>, loose in the wrapper: the line
// splits in two and the loose run is saved outside any line. Move the run
// that now follows the line back to its end.
function nestedLineAtCaret() {
  const range = getRange();
  const line = range && closestEl(range.endContainer, "p, h1, h2, h3, h4, h5, h6");
  return line && line.parentElement !== editor ? line : null;
}
function rejoinLine(line: HTMLElement) {
  if (!line.isConnected) return;
  const run: ChildNode[] = [];
  for (let n = line.nextSibling; n && !(isElement(n) && BLOCK_LEVEL.has(n.tagName)); n = n.nextSibling) run.push(n);
  // Anything not an element in the run is character data (text, or a comment).
  if (!run.some((n) => isElement(n) || (n as CharacterData).data.trim())) return;
  const top = topBlockOf(line);
  const caret = top && textOffsetsWithin(top);
  line.append(...run);
  if (caret) restoreTextOffsets([top!], caret);
}

/** The block types the toolbar, the slash menu and the block menu offer. */
type BlockKind = "p" | "h1" | "h2" | "h3" | "ul" | "ol" | "todo" | "quote" | "code";
/** The three kinds of list. */
type ListKind = "ul" | "ol" | "todo";
interface BlockType {
  key: BlockKind;
  label: string;
  icon: string;
  keys?: string[];
  md?: string;
}
const BLOCK_TYPES: BlockType[] = [
  { key: "p", label: "Text", icon: "text", keys: combo("mod", "alt", "0") },
  { key: "h1", label: "Heading 1", icon: "h1", keys: combo("mod", "alt", "1"), md: "#" },
  { key: "h2", label: "Heading 2", icon: "h2", keys: combo("mod", "alt", "2"), md: "##" },
  { key: "h3", label: "Heading 3", icon: "h3", keys: combo("mod", "alt", "3"), md: "###" },
  { key: "ul", label: "Bulleted list", icon: "ul", keys: combo("mod", "shift", "8"), md: "-" },
  { key: "ol", label: "Numbered list", icon: "ol", keys: combo("mod", "shift", "7"), md: "1." },
  { key: "todo", label: "To-do list", icon: "todo", keys: combo("mod", "shift", "9"), md: "[]" },
  { key: "quote", label: "Quote", icon: "quote", md: ">" },
  { key: "code", label: "Code block", icon: "codeBlock", md: "```" }
];
const BLOCK_TAG: Record<Exclude<BlockKind, ListKind>, string> = { p: "p", h1: "h1", h2: "h2", h3: "h3", quote: "blockquote", code: "pre" };

function listKind(list: Element | null): ListKind | null {
  if (!list) return null;
  if (list.closest("ul.checklist")) return "todo";
  return list.tagName === "OL" ? "ol" : "ul";
}
function currentKind(): BlockKind | null {
  const node = caretNode();
  const list = closestEl(node, "ul, ol");
  if (list) return listKind(list);
  const top = topBlockOf(node);
  if (!top) return "p";
  switch (top.tagName) {
    case "H1": return "h1";
    case "H2": return "h2";
    case "H3": case "H4": case "H5": case "H6": return "h3";
    case "BLOCKQUOTE": return top.getAttribute("style")?.includes("margin") ? "p" : "quote";
    case "PRE": return "code";
    default: return "p";
  }
}
function cleanClass(node: Element) {
  if (node.getAttribute("class") === "") node.removeAttribute("class");
}
function stripChecks(list: Element | null) {
  if (!list) return;
  list.classList.remove("checklist");
  cleanClass(list);
  for (const n of list.querySelectorAll("[data-checked], .checklist")) {
    n.removeAttribute("data-checked");
    n.classList.remove("checklist");
    cleanClass(n);
  }
}
// ── Lists ────────────────────────────────────────────────────────────────
// Plain bulleted/numbered lists go through execCommand (undo history, multi-
// paragraph selections). To-do lists are built directly: execCommand only
// knows plain lists, and the "make a bullet list, then find it again and tag
// it" approach is unreliable -- the browser may merge the new item into a
// neighbouring list or leave the caret where it can't be traced back.

// Move every child of `from` to the end of `to`, carrying any saved selection
// point that pointed into `from` itself.
function moveChildren(from: Node, to: Node, saved: SavedSelection | null) {
  const base = to.childNodes.length;
  if (saved) for (const p of [saved.a, saved.f]) {
    if (p.node === from) { p.node = to; p.offset! += base; }
    if (p.ref === from) p.ref = to;
  }
  while (from.firstChild) to.appendChild(from.firstChild);
}
// Put the saved selection back; if it can't be (its node was replaced), drop
// the caret at the end of `target` so typing continues where the user expects.
function restoreOrPlace(saved: SavedSelection | null, container: Element | null, target: Element | null = container) {
  restoreSelection(saved);
  const range = getRange();
  if (target?.isConnected && (!range || !container?.isConnected || !container.contains(range.startContainer))) placeCaretAtEnd(target);
}
// Swap a list element for another tag/kind, keeping its items and id.
function retagList(list: Element, tag: string, checklist: boolean, saved: SavedSelection | null) {
  const next = document.createElement(tag);
  for (const a of Array.from(list.attributes)) if (a.name !== "class") next.setAttribute(a.name, a.value);
  for (const c of list.classList) if (c !== "checklist") next.classList.add(c);
  if (checklist) next.classList.add("checklist");
  list.before(next);
  moveChildren(list, next, saved);
  list.remove();
  if (!checklist) stripChecks(next);
  cleanClass(next);
  return next;
}
// Lift one item out of its list into a list of its own, splitting the rest.
function splitItem(li: Element, tag: string, checklist: boolean, saved: SavedSelection | null) {
  const list = li.parentElement!;
  const own = document.createElement(tag);
  if (checklist) own.className = "checklist";
  const tail = document.createElement(list.tagName);
  for (const c of list.classList) tail.classList.add(c);
  while (li.nextSibling) tail.appendChild(li.nextSibling);
  list.after(own);
  own.appendChild(li);
  if (tail.firstChild) own.after(tail);
  if (!list.firstElementChild) {
    if (list.hasAttribute("data-block-id")) own.setAttribute("data-block-id", list.getAttribute("data-block-id")!);
    if (saved) for (const p of [saved.a, saved.f]) if (p.ref === list) p.ref = own;
    list.remove();
  }
  if (!checklist) { li.removeAttribute("data-checked"); stripChecks(own); }
  return own;
}
// Join a checklist with checklists directly above and below it.
function mergeChecklists(ul: Element, saved: SavedSelection | null) {
  const prev = ul.previousElementSibling;
  if (prev && prev.matches("ul.checklist")) {
    moveChildren(ul, prev, saved);
    if (saved) for (const p of [saved.a, saved.f]) if (p.ref === ul) p.ref = prev;
    ul.remove();
    ul = prev;
  }
  const next = ul.nextElementSibling;
  if (next && next.matches("ul.checklist")) {
    moveChildren(next, ul, saved);
    if (saved) for (const p of [saved.a, saved.f]) if (p.ref === next) p.ref = ul.nextElementSibling || null;
    next.remove();
  }
  return ul;
}
const TEXT_BLOCK = /^(P|DIV|H[1-6])$/;
// Turn the selected paragraphs (and any plain lists among them) into one to-do list.
function makeChecklist() {
  const range = getRange();
  const first = range && topBlockOf(range.startContainer);
  if (!first) return null;
  const last = topBlockOf(range.endContainer) || first;
  let blocks: Element[] = [];
  for (let n: Element | null = first; n; n = n.nextElementSibling) { blocks.push(n); if (n === last) break; }
  const convertible = (b: Element) => TEXT_BLOCK.test(b.tagName) || b.tagName === "UL" || b.tagName === "OL";
  if (!blocks.every(convertible)) blocks = [first];
  if (!convertible(first)) return null;
  const saved = saveSelection();
  const ul = document.createElement("ul");
  ul.className = "checklist";
  ul.setAttribute("data-block-id", blockId(first) || newBlockId());
  first.before(ul);
  for (const b of blocks) {
    if (b.tagName === "UL" || b.tagName === "OL") {
      stripChecks(b);
      moveChildren(b, ul, saved);
    } else {
      const li = document.createElement("li");
      moveChildren(b, li, saved);
      if (!li.textContent.replace(/\u200B/g, "") && !li.querySelector("br, img")) li.appendChild(document.createElement("br"));
      ul.appendChild(li);
    }
    if (saved) for (const p of [saved.a, saved.f]) if (p.ref === b) p.ref = ul;
    b.remove();
  }
  const merged = mergeChecklists(ul, saved);
  restoreOrPlace(saved, merged, merged.lastElementChild);
  return merged;
}
// Turn one existing list item into a to-do (used by the "- [ ] " shortcut).
function itemToTodo(li: Element, checked: boolean) {
  const saved = saveSelection();
  const list = li.parentElement!;
  let ul: Element;
  if (list.children.length === 1) ul = list.tagName === "UL" ? (list.classList.add("checklist"), list) : retagList(list, "ul", true, saved);
  else ul = splitItem(li, "ul", true, saved);
  if (ul.parentElement === editor) mergeChecklists(ul, saved);
  if (checked) li.setAttribute("data-checked", "true");
  restoreOrPlace(saved, li);
}
function setList(kind: ListKind) {
  ensureSelection();
  if (cellOf(caretNode())) return; // a table cell holds text, not blocks
  const list = currentList();
  const current = listKind(list);
  if (!list) {
    const top = currentTopBlock();
    if (top && /^(H[1-6]|BLOCKQUOTE|PRE)$/.test(top.tagName)) {
      top.classList.remove("doc-title");
      cleanClass(top);
      exec("formatBlock", "<p>");
    }
  }
  const root = list && list.closest("ul.checklist");
  if (current === kind) {
    // Toggle off: the item goes back to being a paragraph.
    exec(kind === "ol" ? "insertOrderedList" : "insertUnorderedList");
  } else if (kind === "todo") {
    if (!list) makeChecklist();
    else {
      const saved = saveSelection();
      const li = closestEl(caretNode(), "li");
      const ul = list.tagName === "UL" ? (list.classList.add("checklist"), list) : retagList(list, "ul", true, saved);
      const merged = ul.parentElement === editor ? mergeChecklists(ul, saved) : ul;
      restoreOrPlace(saved, merged, li || merged.lastElementChild);
    }
  } else if (current === "todo") {
    const saved = saveSelection();
    if (kind === "ul") stripChecks(root);
    else retagList(root!, "ol", false, saved);
    restoreSelection(saved);
  } else {
    exec(kind === "ol" ? "insertOrderedList" : "insertUnorderedList");
    // A new bulleted item can be merged into a to-do list sitting right next
    // to it; lift it back out into a plain list of its own.
    const li = closestEl(caretNode(), "li");
    if (kind === "ul" && li?.closest("ul.checklist")) {
      const saved = saveSelection();
      splitItem(li, "ul", false, saved);
      restoreOrPlace(saved, li);
    }
  }
  changed();
}
function setBlockType(key: BlockKind) {
  if (key === "ul" || key === "ol" || key === "todo") return setList(key);
  ensureSelection();
  if (cellOf(caretNode())) return;
  const list = currentList();
  if (list) exec(listKind(list) === "ol" ? "insertOrderedList" : "insertUnorderedList");
  const top = currentTopBlock();
  if (top) top.classList.remove("doc-title"), cleanClass(top);
  exec("formatBlock", `<${BLOCK_TAG[key]}>`);
  changed();
}
// Undone by ⌘Z like a block move (the browser's own undo doesn't see it).
function toggleCheck(li: Element) {
  recordBlockStep();
  if (li.getAttribute("data-checked") === "true") li.removeAttribute("data-checked");
  else li.setAttribute("data-checked", "true");
  blockChanged();
}

function toggleCode() {
  ensureSelection();
  const range = getRange();
  if (!range || closestEl(range.startContainer, "pre")) return;
  const code = closestEl(range.commonAncestorContainer, "code");
  if (code) {
    // At the end of the code, toggling it off leaves it: what is typed next is
    // plain text. The caret goes after a ZWSP, or Chrome would put it back inside.
    const rest = document.createRange();
    rest.selectNodeContents(code);
    rest.setStart(range.endContainer, range.endOffset);
    if (range.collapsed && !rest.toString().replace(/\u200B/g, "")) {
      const after = document.createTextNode(ZWSP);
      code.after(after);
      placeCaret(after, 1);
      refreshToolbar();
      return;
    }
    // A selection inside the code takes off only its own words: the code's
    // other words are split off first and stay code.
    if (!range.collapsed) {
      splitAtRange(code, range);
      setRange(range);
    }
    keepSelection(() => unwrap(code));
    changed();
    return;
  }
  if (range.collapsed) return;
  const text = range.toString();
  if (!text || /\n/.test(text)) return;
  exec("insertHTML", `<code>${escapeHtml(text)}</code>`);
}
// Chrome writes inline code it inserts or carries over (insertHTML of a
// <code>, typing where a code run was deleted, Enter at its end) as a <span>
// or <font face> carrying the code's computed style. That element is turned
// back into <code>, merged with a neighbouring one, so inline code is always
// the element and toggling it off works.
const CODE_STYLES = ["font-family", "font-size", "background-color", "background", "border-radius", "padding"];
function fixCodeSpans(scope: Element = editor) {
  const marks = Array.from(scope.querySelectorAll<HTMLElement>('span[style*="monospace"], font[face*="monospace"]')).filter((s) => !s.closest("pre"));
  if (!marks.length) return;
  const saved = saveSelection();
  for (const mark of marks) {
    let code = mark.closest("code");
    if (!code) {
      code = document.createElement("code");
      mark.replaceWith(code);
      code.appendChild(mark);
    }
    // The code's own look, on the mark and on the spans Chrome nests in it.
    for (const n of [mark, ...mark.querySelectorAll<HTMLElement>("span, font")]) {
      for (const prop of CODE_STYLES) n.style.removeProperty(prop);
      if (!n.getAttribute("style")) n.removeAttribute("style");
      n.removeAttribute("face");
      if (n.attributes.length === 0) unwrap(n);
    }
    for (const sib of [code.previousSibling, code.nextSibling]) {
      if (sib?.nodeName !== "CODE" || code.parentNode !== sib.parentNode) continue;
      if (sib === code.previousSibling) code.prepend(...sib.childNodes);
      else code.append(...sib.childNodes);
      sib.remove();
    }
  }
  restoreSelection(saved);
}

// Rewrite sentinel colours produced by execCommand into theme-aware classes.
/** A palette colour as a mark: its kind and its index in COLORS. */
interface ColorMark {
  kind: ColorKind;
  idx: number;
}
function sentinelOf(value: string | null): ColorMark | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  let m = v.match(/^rgba?\(\s*1,\s*([23]),\s*(\d+)/);
  if (m) return { kind: m[1] === "2" ? "tc" : "hl", idx: Number(m[2]) - 10 };
  m = v.match(/^#010([23])([0-9a-f]{2})$/);
  if (m) return { kind: m[1] === "2" ? "tc" : "hl", idx: parseInt(m[2], 16) - 10 };
  return null;
}
// Chrome re-creates the formatting at the caret from computed styles: type
// over (or press Enter after) coloured text and the new text gets the palette
// colour as a literal (`<font color="#337ea9">`, `background-color: rgb(…)`).
// Those literals, in either theme, are read back as their palette entry.
const rgbKey = (value: string | null | undefined) => {
  const v = String(value || "").trim().toLowerCase();
  let m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/.exec(v);
  if (m) return m.slice(1).map((x) => parseInt(x, 16)).join(",");
  m = /^rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)\s*(?:,\s*1\s*)?\)$/.exec(v);
  return m ? m.slice(1).join(",") : null;
};
const PALETTE_LITERALS: Record<ColorKind, Map<string | null, ColorMark>> = { tc: new Map(), hl: new Map() };
for (const [key, [lt, lh, dt, dh]] of Object.entries(PALETTE)) {
  const idx = COLORS.findIndex((c) => c.key === key);
  for (const v of [lt, dt]) PALETTE_LITERALS.tc.set(rgbKey(v), { kind: "tc", idx });
  for (const v of [lh, dh]) PALETTE_LITERALS.hl.set(rgbKey(v), { kind: "hl", idx });
}
const colorMarkOf = (value: string | null, kind: ColorKind) => sentinelOf(value) || PALETTE_LITERALS[kind].get(rgbKey(value)) || null;
function removeKindClass(node: Element, kind: ColorKind) {
  for (const c of Array.from(node.classList)) if (c.startsWith(kind + "-")) node.classList.remove(c);
}
function fixColorMarkers(scope: Element = editor) {
  if (!scope) return;
  const nodes = scope.querySelectorAll<HTMLElement>('font[color], [style*="color"]');
  if (!nodes.length) return;
  const saved = saveSelection();
  let moved = false;
  for (const node of nodes) {
    const marks: ColorMark[] = [];
    if (node.tagName === "FONT" && node.hasAttribute("color")) {
      const s = colorMarkOf(node.getAttribute("color"), "tc");
      if (s) { marks.push(s); node.removeAttribute("color"); }
    }
    const c = colorMarkOf(node.style.color, "tc");
    if (c) { marks.push(c); node.style.removeProperty("color"); }
    const b = colorMarkOf(node.style.backgroundColor, "hl");
    if (b) { marks.push(b); node.style.removeProperty("background-color"); }
    for (const { kind, idx } of marks) {
      const name = COLORS[idx]?.key;
      if (!name) continue;
      for (const d of node.querySelectorAll(`[class*="${kind}-"]`)) { removeKindClass(d, kind); cleanClass(d); }
      removeKindClass(node, kind);
      if (name === "default") {
        const ancestor = node.parentElement?.closest(`[class*="${kind}-"]`);
        if (ancestor && editor.contains(ancestor) && !ancestor.classList.contains(`${kind}-default`)) node.classList.add(`${kind}-default`);
      } else node.classList.add(`${kind}-${name}`);
    }
    if (!node.getAttribute("style")) node.removeAttribute("style");
    cleanClass(node);
    if ((node.tagName === "SPAN" || node.tagName === "FONT") && node.attributes.length === 0) { unwrap(node); moved = true; }
  }
  if (moved) restoreSelection(saved);
}
function applyColor(kind: ColorKind, idx: number) {
  ensureSelection();
  if (kind === "hl") {
    try { document.execCommand("styleWithCSS", false, true); } catch {}
    document.execCommand("hiliteColor", false, sentinel("hl", idx));
    try { document.execCommand("styleWithCSS", false, false); } catch {}
  } else {
    document.execCommand("foreColor", false, sentinel("tc", idx));
  }
  fixColorMarkers(editor);
  changed();
}
function currentColors() {
  const node = caretNode();
  const tcEl = closestEl(node, '[class*="tc-"]');
  const hlEl = closestEl(node, '[class*="hl-"]');
  const pick = (n: Element | null, kind: ColorKind) => {

    const c = n && Array.from(n.classList).find((x) => x.startsWith(kind + "-"));
    return c ? c.slice(3) : "default";
  };
  return { tc: pick(tcEl, "tc"), hl: pick(hlEl, "hl") };
}
function toggleHighlight() {
  const { hl } = currentColors();
  applyColor("hl", hl === "yellow" ? 0 : COLORS.findIndex((c) => c.key === "yellow"));
}
function clearFormatting() {
  ensureSelection();
  exec("removeFormat");
  const range = getRange();
  if (range) {
    const inline = (n: Element) => /^(SPAN|FONT|CODE|U|S|STRIKE)$/.test(n.tagName);
    const found = Array.from(editor.querySelectorAll('[class*="tc-"], [class*="hl-"], code, font, u, s, strike'))
      .filter((n) => !n.closest("pre") && range.intersectsNode(n));
    // A wrapper reaching past the selection is split at its edges first, so
    // the words around the selection keep their formatting. The selection's
    // range follows the split; what is left inside it is then unwrapped.
    for (const n of found) if (inline(n) && n.isConnected && range.intersectsNode(n)) splitAtRange(n, range);
    const hits = found.filter((n) => n.isConnected && range.intersectsNode(n));
    setRange(range);
    keepSelection(() => {
      for (const n of hits) {
        if (inline(n)) unwrap(n);
        else { removeKindClass(n, "tc"); removeKindClass(n, "hl"); cleanClass(n); }
      }
    });
  }
  const top = currentTopBlock();
  if (top && /^(H[1-6]|BLOCKQUOTE|PRE)$/.test(top.tagName)) exec("formatBlock", "<p>");
  changed();
}
function insertDivider() {
  ensureSelection();
  const top = currentTopBlock();
  const hr = document.createElement("hr");
  if (top && top.tagName === "P" && !top.textContent.replace(/\u200B/g, "").trim() && !top.querySelector("img")) top.replaceWith(hr);
  else if (top) top.after(hr);
  else editor.appendChild(hr);
  let next = hr.nextElementSibling;
  if (!next || !/^(P|H[1-6]|DIV)$/.test(next.tagName)) { next = emptyParagraph(); hr.after(next); }
  placeCaret(next, 0);
  changed();
}

// ── Tooltips (delayed, then instant while moving along the toolbar) ───────
const tip = el("div", { class: "tip", role: "tooltip" });
let tipTimer: number | null = null, tipOwner: HTMLElement | null = null, tipWarmUntil = 0;
function showTip(target: HTMLElement, label: string, keys: string[] | null | undefined) {
  if (openPop?.owner === target) return;
  tip.replaceChildren(el("span", {}, label));
  if (keys?.length) tip.appendChild(keysEl(keys, "tip-keys"));
  tip.classList.remove("show");
  document.body.appendChild(tip);
  const r = target.getBoundingClientRect();
  const w = tip.offsetWidth;
  tip.style.left = clamp(r.left + r.width / 2 - w / 2, 6, innerWidth - w - 6) + "px";
  tip.style.top = r.bottom + 7 + "px";
  tipOwner = target;
  requestAnimationFrame(() => tip.classList.add("show"));
}
function hideTip() {
  clearTimeout(tipTimer);
  if (!tipOwner) return;
  tipOwner = null;
  tip.classList.remove("show");
  tipWarmUntil = Date.now() + 350;
}
function attachTip(target: HTMLElement, label: string, keys?: string[] | null) {
  target.setAttribute("aria-label", label);
  if (coarsePointer) return;
  target.addEventListener("pointerenter", () => {
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => showTip(target, label, keys), Date.now() < tipWarmUntil ? 0 : 520);
  });
  target.addEventListener("pointerleave", hideTip);
  target.addEventListener("pointerdown", () => { hideTip(); tipWarmUntil = 0; });
}

function tb(icon: string | null, label: string | null, keys: string[] | null, onClick: (e: MouseEvent, b: HTMLButtonElement) => void, className = "") {
  const b = el("button", { class: "tb " + className, type: "button", html: icon ? svg(ICONS[icon]) : "" });
  b.addEventListener("mousedown", (e) => e.preventDefault());
  b.addEventListener("click", (e) => onClick(e, b));
  if (label) attachTip(b, label, keys);
  return b;
}
const sep = () => el("span", { class: "sep", "aria-hidden": "true" });

type ToolbarButton = "undo" | "redo" | "block" | "bold" | "italic" | "underline" | "strike" | "code" | "color" | "ul" | "ol" | "todo" | "align" | "link" | "image" | "table" | "more" | "aa";
// Filled in right below, one button at a time.
const btn = {} as Record<ToolbarButton, HTMLButtonElement>;
btn.undo = tb("undo", "Undo", combo("mod", "Z"), () => undoAny());
btn.redo = tb("redo", "Redo", isMac ? combo("mod", "shift", "Z") : combo("mod", "Y"), () => redoAny());
btn.block = tb(null, "Text style", null, (_, b) => toggleMenu(b, blockTypeMenu), "block-type");
const blockLabel = el("span", { class: "label" }, "Text");
btn.block.append(blockLabel, el("span", { class: "chev", html: svg(ICONS.chevron, 13) }));
btn.bold = tb("bold", "Bold", combo("mod", "B"), () => exec("bold"));
btn.italic = tb("italic", "Italic", combo("mod", "I"), () => exec("italic"));
btn.underline = tb("underline", "Underline", combo("mod", "U"), () => exec("underline"));
btn.strike = tb("strike", "Strikethrough", combo("mod", "shift", "X"), () => exec("strikeThrough"));
btn.code = tb("code", "Inline code", combo("mod", "E"), () => toggleCode());
btn.color = tb("color", "Color", null, (_, b) => toggleMenu(b, colorMenu), "color");
const colorHl = el("span", { class: "hl-swatch" });
const colorBar = el("span", { class: "bar-swatch" });
btn.color.prepend(colorHl);
btn.color.append(colorBar);
btn.ul = tb("ul", "Bulleted list", combo("mod", "shift", "8"), () => setList("ul"));
btn.ol = tb("ol", "Numbered list", combo("mod", "shift", "7"), () => setList("ol"));
btn.todo = tb("todo", "To-do list", combo("mod", "shift", "9"), () => setList("todo"));
btn.align = tb("alignLeft", "Alignment", null, (_, b) => toggleMenu(b, alignMenu), "align");
btn.link = tb("link", "Link", combo("mod", "K"), () => openLinkEditor());
btn.image = tb("image", "Image", null, () => pickImage());
btn.table = tb("table", "Table", null, (_, b) => toggleMenu(b, tablePicker));
btn.more = tb("more", "More", null, (_, b) => toggleMenu(b, moreMenu));
tools.append(
  btn.undo, btn.redo, sep(),
  btn.block, sep(),
  btn.bold, btn.italic, btn.underline, btn.strike, btn.code, btn.color, sep(),
  btn.ul, btn.ol, btn.todo, btn.align, sep(),
  btn.link, btn.image, btn.table, btn.more
);

const statusLabel = el("span", { class: "s-label" });
const statusEl = el("span", { class: "status", role: "status", "aria-live": "polite" }, [el("span", { class: "s-dot" }), statusLabel]);
btn.aa = tb(null, "Typeface & width", null, (_, b) => toggleMenu(b, typeMenu), "aa");
btn.aa.textContent = "Aa";
barRight.append(statusEl, btn.aa);

// Narrow screens: the toolbar scrolls sideways and fades only the edge that has more.
function updateToolFades() {
  const max = tools.scrollWidth - tools.clientWidth;
  tools.classList.toggle("fade-l", tools.scrollLeft > 2);
  tools.classList.toggle("fade-r", max > 2 && tools.scrollLeft < max - 2);
}
tools.addEventListener("scroll", updateToolFades, { passive: true });
window.addEventListener("resize", updateToolFades);

const ALIGNS: { key: string; label: string; icon: string; cmd: string }[] = [
  { key: "left", label: "Align left", icon: "alignLeft", cmd: "justifyLeft" },
  { key: "center", label: "Center", icon: "alignCenter", cmd: "justifyCenter" },
  { key: "right", label: "Align right", icon: "alignRight", cmd: "justifyRight" },
  { key: "justify", label: "Justify", icon: "alignJustify", cmd: "justifyFull" }
];
let shownAlign = "left", shownKind: BlockKind | null = null, shownColor = "";
function currentAlign() {
  const line = closestEl(caretNode(), "li, p, h1, h2, h3, h4, blockquote, pre, div");
  const ta = line ? getComputedStyle(line).textAlign : "left";
  return ta === "center" ? "center" : ta === "right" || ta === "end" ? "right" : ta === "justify" ? "justify" : "left";
}
function refreshToolbar() {
  const inDoc = !!getRange();
  const q = (c: string) => { try { return inDoc && document.queryCommandState(c); } catch { return false; } };
  const en = (c: string) => { try { return document.queryCommandEnabled(c); } catch { return true; } };
  btn.bold.classList.toggle("on", q("bold"));
  btn.italic.classList.toggle("on", q("italic"));
  btn.underline.classList.toggle("on", q("underline"));
  btn.strike.classList.toggle("on", q("strikeThrough"));
  const node = caretNode();
  btn.code.classList.toggle("on", !!closestEl(node, "code") && !closestEl(node, "pre"));
  const kind = inDoc ? currentKind() : "p";
  btn.ul.classList.toggle("on", kind === "ul");
  btn.ol.classList.toggle("on", kind === "ol");
  btn.todo.classList.toggle("on", kind === "todo");
  if (kind !== shownKind) {
    shownKind = kind;
    blockLabel.textContent = BLOCK_TYPES.find((t) => t.key === kind)?.label ?? "Text";
  }
  const align = inDoc ? currentAlign() : "left";
  if (align !== shownAlign) {
    shownAlign = align;
    btn.align.innerHTML = svg(ICONS[ALIGNS.find((a) => a.key === align)!.icon]);
  }
  const { tc, hl } = inDoc ? currentColors() : { tc: "default", hl: "default" };
  const colorKey = tc + "/" + hl;
  if (colorKey !== shownColor) {
    shownColor = colorKey;
    colorBar.style.background = tc === "default" ? "" : `var(--tc-${tc})`;
    btn.color.classList.toggle("has-color", tc !== "default");
    colorHl.style.background = hl === "default" ? "" : `var(--hl-${hl})`;
  }
  if (inDoc || blockSel) {
    btn.undo.classList.toggle("disabled", !blockHistory.undo.length && !en("undo"));
    btn.redo.classList.toggle("disabled", !blockHistory.redo.length && !en("redo"));
  }
}

/* ══════════════ 6. Menus, palette, typeface, shortcuts sheet ═════════════ */

/** Where a pop lines up with the rect it opens from. */
type PopAlign = "start" | "center" | "end";
/** The open popover: a menu, a dialog, the slash menu or a link card ("menu", "slash", "link-edit", "link-view"…). */
interface OpenPop {
  pop: HTMLElement;
  owner: HTMLElement | null;
  kind: string;
  /** Measures the rect to follow on scroll; without one the pop closes when the page scrolls. */
  reposition: (() => DOMRect | null) | null;
  onClose: (() => void) | null;
  align: PopAlign;
}
interface PopOptions {
  className?: string;
  owner?: HTMLElement | null;
  kind?: string;
  reposition?: (() => DOMRect | null) | null;
  onClose?: (() => void) | null;
  align?: PopAlign;
}
let openPop: OpenPop | null = null;
function showPop(content: ElChild | ElChild[], rect: DOMRect, { className = "", owner = null, kind = "menu", reposition = null, onClose = null, align = "start" }: PopOptions = {}) {
  closePop(true);
  hideTip();
  const pop = el("div", { class: "pop " + className, role: kind === "menu" ? "menu" : "dialog" }, content);
  // A mousedown inside the pop lands on one of its elements.
  pop.addEventListener("mousedown", (e) => { if (!(e.target as Element).closest("input, textarea, a")) e.preventDefault(); });
  document.body.appendChild(pop);
  openPop = { pop, owner, kind, reposition, onClose, align };
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
  pop.style.top = Math.round(Math.max(m, top)) + "px";
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
  if (getRange()) lastRange = getRange()!.cloneRange();
  build(owner);
}
document.addEventListener("mousedown", (e) => {
  if (!openPop) return;
  if (openPop.pop.contains(e.target as Node) || openPop.owner?.contains(e.target as Node)) return;
  closePop();
}, true);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && openPop && openPop.kind !== "slash") {
    const wasLinkEdit = openPop.kind === "link-edit";
    closePop();
    // Closing a block's menu keeps its blocks selected.
    if (blockSel) sink.focus({ preventScroll: true });
    else if (!wasLinkEdit) editor.focus({ preventScroll: true });
  }
});
// A menu works from the keyboard: the arrows, from the button that opened it or
// inside it, move through its rows, and Enter or Space picks one. Its action
// puts back the editor selection the menu was opened from (toggleMenu).
document.addEventListener("keydown", (e) => {
  if (openPop?.kind !== "menu") return;
  const { pop, owner } = openPop;
  const inPop = pop.contains(document.activeElement);
  if (!inPop && document.activeElement !== owner) return;
  const rows = Array.from(pop.querySelectorAll<HTMLElement>(".mi"));
  if (!rows.length) return;
  const i = rows.indexOf(document.activeElement as HTMLElement);
  const move = (to: number) => rows[(to + rows.length) % rows.length].focus();
  if (e.key === "ArrowDown") move(i + 1);
  else if (e.key === "ArrowUp") move(i < 0 ? -1 : i - 1);
  else if (e.key === "Home" && inPop) move(0);
  else if (e.key === "End" && inPop) move(-1);
  else if ((e.key === "Enter" || e.key === " ") && i >= 0) rows[i].click();
  else if (e.key === "Tab" && inPop) { closePop(); owner?.focus(); }
  else return;
  e.preventDefault();
});
canvas.addEventListener("scroll", () => {
  if (!openPop) return;
  if (openPop.reposition) {
    const r = openPop.reposition();
    const barBottom = bar.getBoundingClientRect().bottom;
    if (!r || r.bottom < barBottom || r.top > innerHeight) closePop(true);
    else placePop(openPop.pop, r, openPop.align);
  } else closePop(true);
}, { passive: true });
window.addEventListener("resize", () => closePop(true));

// Row anatomy: [icon] [label ……… shortcut | markdown] [check slot]. Menus that
// can show a check reserve the slot on every row, so the shortcut column stays
// put whichever row is ticked.
interface MenuItemOptions {
  icon?: string | null;
  label: string;
  keys?: string[] | null;
  md?: string;
  checked?: boolean;
  checkSlot?: boolean;
  role?: string;
  onSelect: () => void;
}
function menuItem({ icon, label, keys, md, checked, checkSlot = false, role = "menuitem", onSelect }: MenuItemOptions) {
  const showKeys = keys?.length && !coarsePointer;
  const text = el("span", { class: "mi-text" }, [
    el("span", { class: "mi-label" }, label),
    showKeys ? keysEl(keys!, "mi-keys") : md ? el("span", { class: "mi-md" }, md) : null,
    checkSlot ? el("span", { class: "mi-check" + (checked ? " on" : ""), html: svg(ICONS.check, 15) }) : null
  ]);
  const item = el("div", { class: "mi", role: checkSlot ? "menuitemradio" : role, "aria-checked": checkSlot ? String(!!checked) : null }, [
    icon ? el("span", { class: "mi-icon", html: svg(ICONS[icon], 17) }) : null,
    text
  ]);
  item.tabIndex = -1;
  item.addEventListener("click", () => { closePop(); onSelect(); });
  return item;
}
function blockTypeMenu(owner: HTMLElement) {
  const kind = currentKind();
  showPop(BLOCK_TYPES.map((t) => menuItem({ icon: t.icon, label: t.label, keys: t.keys, checked: t.key === kind, checkSlot: true, onSelect: () => setBlockType(t.key) })), owner.getBoundingClientRect(), { owner, className: "block-menu" });
}
function alignMenu(owner: HTMLElement) {
  const now = currentAlign();
  showPop(ALIGNS.map((a) => menuItem({ icon: a.icon, label: a.label, checked: a.key === now, checkSlot: true, onSelect: () => { exec(a.cmd); changed(); } })), owner.getBoundingClientRect(), { owner });
}
function moreMenu(owner: HTMLElement) {
  showPop([
    menuItem({ icon: "divider", label: "Divider", onSelect: insertDivider }),
    menuItem({ icon: "indent", label: "Indent", keys: combo("Tab"), onSelect: () => { exec("indent"); changed(); } }),
    menuItem({ icon: "outdent", label: "Outdent", keys: combo("shift", "Tab"), onSelect: () => { exec("outdent"); changed(); } }),
    menuItem({ icon: "clear", label: "Clear formatting", keys: combo("mod", "\\"), onSelect: clearFormatting }),
    el("div", { class: "msep" }),
    menuItem({ icon: "keyboard", label: "Keyboard shortcuts", keys: combo("mod", "/"), onSelect: openShortcuts })
  ], owner.getBoundingClientRect(), { owner, align: "end" });
}
function colorMenu(owner: HTMLElement) {
  const now = currentColors();
  const swatches = (kind: ColorKind) => el("div", { class: "swatches" }, COLORS.map((c, i) => {
    const s = el("button", { type: "button", class: "sw" + (now[kind] === c.key ? " on" : "") + (kind === "hl" && c.key === "default" ? " none" : ""), title: kind === "hl" && c.key === "default" ? "No highlight" : c.label, "aria-label": (kind === "hl" ? "Highlight " : "Text ") + c.label });
    if (kind === "tc") {
      s.textContent = "A";
      s.style.color = c.key === "default" ? "var(--text)" : `var(--tc-${c.key})`;
    } else if (c.key !== "default") {
      s.style.background = `var(--hl-${c.key})`;
    }
    s.addEventListener("click", () => { closePop(); applyColor(kind, i); });
    return s;
  }));
  showPop([
    el("div", { class: "mhead" }, "Text"), swatches("tc"),
    el("div", { class: "mhead", style: { marginTop: "6px" } }, "Highlight"), swatches("hl")
  ], owner.getBoundingClientRect(), { owner, className: "palette" });
}

let settings: DocSettings = { font: "sans", wide: false };
function applySettings(next: Partial<DocSettings> | null | undefined) {
  settings = { font: FONTS.some((f) => f.key === next?.font) ? next!.font! : "sans", wide: next?.wide === true };
  page.dataset.font = settings.font;
  page.classList.toggle("wide", settings.wide);
  btn.aa.style.fontFamily = FONTS.find((f) => f.key === settings.font)!.stack;
  requestAnimationFrame(() => scheduleOutline());
}
function updateSettings(patch: Partial<DocSettings>) {
  applySettings({ ...settings, ...patch });
  gadget.setSettings({ ...patch, senderId: clientId }).catch((error) => console.error(error));
}
function typeMenu(owner: HTMLElement) {
  const render = () => [
    el("div", { class: "tiles" }, FONTS.map((f) => {
      const t = el("button", { type: "button", class: "tile" + (settings.font === f.key ? " on" : "") }, [
        el("span", { class: "ag", style: { fontFamily: f.stack } }, "Ag"), el("span", { class: "tl" }, f.label)
      ]);
      t.addEventListener("click", () => { updateSettings({ font: f.key }); openPop?.pop.replaceChildren(...render()); });
      return t;
    })),
    el("div", { class: "msep" }),
    (() => {
      const row = el("div", { class: "toggle-row" }, [el("span", {}, "Full width"), el("span", { class: "switch" + (settings.wide ? " on" : "") })]);
      row.addEventListener("click", () => { updateSettings({ wide: !settings.wide }); openPop?.pop.replaceChildren(...render()); });
      return row;
    })()
  ];
  showPop(render(), owner.getBoundingClientRect(), { owner, className: "type-pop", align: "end" });
}

function openShortcuts() {
  closePop(true);
  // row(label, ...combos): each combo is one chip. md(label, ...tokens): literal syntax chips.
  const row = (label: string, ...combos: string[][]) => el("div", { class: "krow" }, [
    el("span", {}, label), el("span", { class: "chips" }, combos.map((c) => keysEl(c, "chip")))
  ]);
  const md = (label: string, ...tokens: string[]) => el("div", { class: "krow" }, [
    el("span", {}, label), el("span", { class: "chips" }, tokens.map((t) => el("span", { class: "chip md" }, t)))
  ]);
  const overlay = el("div", { class: "sheet-overlay" }, [
    el("div", { class: "sheet", role: "dialog", "aria-label": "Keyboard shortcuts" }, [
      el("h2", {}, "Keyboard shortcuts"),
      el("p", { class: "sub" }, "Type / on an empty line for every block type. Drag a block by its handle to rearrange."),
      el("div", { class: "sheet-cols" }, [
        el("div", {}, [
          el("h3", {}, "Formatting"),
          row("Bold", combo("mod", "B")), row("Italic", combo("mod", "I")), row("Underline", combo("mod", "U")),
          row("Strikethrough", combo("mod", "shift", "X")), row("Inline code", combo("mod", "E")),
          row("Highlight", combo("mod", "shift", "H")), row("Link", combo("mod", "K")),
          row("Clear formatting", combo("mod", "\\")),
          el("h3", {}, "Blocks"),
          row("Text", combo("mod", "alt", "0")),
          row("Heading 1 · 2 · 3", combo("mod", "alt", "1"), combo("mod", "alt", "2"), combo("mod", "alt", "3")),
          row("Bulleted list", combo("mod", "shift", "8")), row("Numbered list", combo("mod", "shift", "7")),
          row("To-do list", combo("mod", "shift", "9")), row("Check · uncheck", combo("mod", "↵")),
          row("Indent · outdent", combo("Tab"), combo("shift", "Tab")),
          el("h3", {}, "Arrange"),
          row("Select block", combo("Esc")), row("Extend selection", combo("shift", "↑"), combo("shift", "↓")),
          row("Move up · down", combo("alt", "shift", "↑"), combo("alt", "shift", "↓")),
          row("Duplicate", combo("mod", "D")), row("Delete selected", combo(isMac ? "⌫" : "Del"))
        ]),
        el("div", {}, [
          el("h3", {}, "Markdown, as you type"),
          md("Heading 1 · 2 · 3", "#", "##", "###"), md("Bulleted list", "-"), md("Numbered list", "1."),
          md("To-do list", "[]", "- [ ]"), md("Quote", ">"), md("Code block", "```"), md("Divider", "---"),
          md("Bold · italic", "**text**", "*text*"), md("Code · strike", "`code`", "~~text~~"),
          md("Arrows · em dash", "->", "--"), md("Table, then ↵", "| a | b |"),
          el("h3", {}, "Tables"),
          row("Next · previous cell", combo("Tab"), combo("shift", "Tab")),
          row("Cell below · new row", combo("↵")), row("Line break in a cell", combo("shift", "↵")),
          el("h3", {}, "General"),
          md("Commands", "/"), row("Save now", combo("mod", "S")),
          row("Undo · redo", combo("mod", "Z"), isMac ? combo("mod", "shift", "Z") : combo("mod", "Y")),
          row("This sheet", combo("mod", "/"))
        ])
      ])
    ])
  ]);
  const close = () => { overlay.remove(); document.removeEventListener("keydown", onKey, true); editor.focus({ preventScroll: true }); };
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" || (isMac ? e.metaKey : e.ctrlKey) && e.key === "/") { e.preventDefault(); e.stopPropagation(); close(); } };
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  document.addEventListener("keydown", onKey, true);
  document.body.appendChild(overlay);
}

/* ═════════════════════ 7. Links, images, paste & drop ═══════════════════ */

const looksLikeUrl = (s: string | null | undefined) => /^(https?:\/\/|www\.)[^\s]+$/i.test(String(s || "").trim()) || /^[a-z0-9-]+(\.[a-z0-9-]+)+\.[a-z]{2,}(\/[^\s]*)?$/i.test(String(s || "").trim());
function splitUrl(href: string): [string, string] {
  try {
    const u = new URL(href);
    if (u.protocol === "mailto:") return [u.pathname, ""];
    const path = (u.pathname === "/" ? "" : u.pathname) + u.search + u.hash;
    return [u.hostname.replace(/^www\./, ""), path];
  } catch { return [href, ""]; }
}
function openUrl(href: string) {
  const a = el("a", { href, target: "_blank", rel: "noopener noreferrer" });
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// The boxes a range's text occupies, one per text run and line. Element boxes
// are left out: a range spanning paragraphs would otherwise report each
// paragraph's full-width box.
function textRects(range: Range) {
  const out: DOMRect[] = [];
  const root = range.commonAncestorContainer;
  const w = document.createTreeWalker(isText(root) ? root.parentNode! : root, NodeFilter.SHOW_TEXT);
  for (let t = w.nextNode() as Text | null; t; t = w.nextNode() as Text | null) {
    if (!range.intersectsNode(t)) continue;
    const r = document.createRange();
    r.selectNodeContents(t);
    if (t === range.startContainer) r.setStart(t, range.startOffset);
    if (t === range.endContainer) r.setEnd(t, range.endOffset);
    for (const rect of r.getClientRects()) if (rect.width >= 1 && rect.height >= 1) out.push(rect);
  }
  return out;
}
function openLinkEditor() {
  ensureSelection();
  const range = getRange();
  if (!range) return;
  const anchor = closestEl(range.startContainer, "a") || closestEl(range.endContainer, "a");
  const saved = range.cloneRange();
  const input = el("input", { type: "text", placeholder: "Paste or type a link", value: anchor?.getAttribute("href") || "", spellcheck: "false", autocomplete: "off", "aria-label": "Link address" });
  const linkRow = [el("span", { class: "lc-icon", html: svg(ICONS.link, 16) }), input, el("span", { class: "lc-enter" }, "↵")];
  // Nothing selected and not in a link: the link is new text, so a second row
  // asks what it should say. Left empty, the address itself is shown, and the
  // placeholder previews exactly that.
  const fresh = !anchor && saved.collapsed;
  const TEXT_HINT = "Text to show (optional)";
  const textInput = fresh ? el("input", { type: "text", placeholder: TEXT_HINT, spellcheck: "true", autocomplete: "off", "aria-label": "Text to show" }) : null;
  const card = fresh
    ? el("div", { class: "link-card lc-new" }, [
        el("div", { class: "lc-row" }, linkRow),
        el("div", { class: "lc-rule" }),
        el("div", { class: "lc-row lc-text-row" }, [el("span", { class: "lc-icon", html: svg(ICONS.text, 16) }), textInput])
      ])
    : el("div", { class: "link-card" }, linkRow);
  const shownFor = (raw: string) => raw.replace(/^mailto:/i, "");
  if (textInput) input.addEventListener("input", () => { textInput.placeholder = input.value.trim() ? shownFor(input.value.trim()) : TEXT_HINT; });
  const restore = () => { if (saved.startContainer.isConnected) setRange(saved); };
  // Focus moves into the card, which takes the browser's selection with it.
  // So the text being linked (or the link being edited) is painted with the
  // selection colour until the card closes, and it never looks deselected.
  let marked: Range | null = null;
  if (!saved.collapsed) marked = saved;
  else if (anchor) { marked = document.createRange(); marked.selectNodeContents(anchor); }
  const selLayer = marked ? el("div", { class: "lc-sel-layer", "aria-hidden": "true" }) : null;
  const paintSel = () => {
    if (!selLayer || !marked!.startContainer.isConnected) return;
    const pr = page.getBoundingClientRect();
    selLayer.replaceChildren(...textRects(marked!).map((r) => {
      const d = el("div");
      d.style.transform = `translate(${r.left - pr.left}px, ${r.top - pr.top}px)`;
      d.style.width = r.width + "px";
      d.style.height = r.height + "px";
      return d;
    }));
  };
  if (selLayer) { page.appendChild(selLayer); paintSel(); }
  showPop(card, anchor ? anchor.getBoundingClientRect() : rangeRect(saved), {
    kind: "link-edit", className: "link-pop",
    reposition: () => { paintSel(); return saved.startContainer.isConnected ? (anchor?.isConnected ? anchor.getBoundingClientRect() : rangeRect(saved)) : null; },
    onClose: () => selLayer?.remove()
  });
  input.focus();
  input.select();
  const apply = () => {
    const raw = input.value.trim();
    const href = normalizeHref(raw);
    closePop();
    restore();
    if (anchor && editor.contains(anchor)) {
      if (!href) { const r = document.createRange(); r.selectNodeContents(anchor); setRange(r); exec("unlink"); }
      else anchor.setAttribute("href", href);
      changed();
    } else if (href) {
      if (saved.collapsed) {
        const text = textInput?.value.replace(/\s+/g, " ").trim() || shownFor(raw);
        exec("insertHTML", `<a href="${escapeHtml(href)}">${escapeHtml(text)}</a>${ZWSP}`);
      } else exec("createLink", href);
    }
  };
  const fields = textInput ? [input, textInput] : [input];
  for (const field of fields) {
    field.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); apply(); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closePop(); restore(); }
      // Tab moves between the two rows and stays inside the card.
      else if (e.key === "Tab" && fields.length > 1) {
        e.preventDefault();
        const next = fields[(fields.indexOf(field) + (e.shiftKey ? fields.length - 1 : 1)) % fields.length];
        next.focus();
        next.select();
      }
    });
  }
}

let linkViewAnchor: HTMLElement | null = null;
function updateLinkView() {
  const range = getRange();
  const a = range && range.collapsed && document.activeElement === editor ? closestEl(range.startContainer, "a") : null;
  if (a && a === linkViewAnchor && openPop?.kind === "link-view") return;
  if (openPop?.kind === "link-view") closePop(true);
  linkViewAnchor = null;
  if (!a || openPop) return;
  linkViewAnchor = a;
  const href = a.getAttribute("href") || "";
  const [host, path] = splitUrl(href);
  const url = el("a", { class: "lc-url", href, target: "_blank", rel: "noopener noreferrer", title: href }, [el("span", { class: "lc-host" }, host), el("span", { class: "lc-path" }, path)]);
  const copyBtn = tb("copy", "Copy link", null, () => {
    navigator.clipboard?.writeText(href).then(() => {
      copyBtn.innerHTML = svg(ICONS.check);
      setTimeout(() => { copyBtn.innerHTML = svg(ICONS.copy); }, 1200);
    }).catch(() => {});
  });
  const card = el("div", { class: "link-card" }, [
    url, el("span", { class: "sep" }),
    copyBtn,
    tb("pencil", "Edit link", combo("mod", "K"), () => { closePop(true); openLinkEditor(); }),
    tb("unlink", "Remove link", null, () => {
      closePop(true);
      keepSelection(() => unwrap(a));
      changed();
    })
  ]);
  showPop(card, a.getBoundingClientRect(), { kind: "link-view", className: "link-pop", reposition: () => a.isConnected ? a.getBoundingClientRect() : null, onClose: () => { linkViewAnchor = null; } });
}

// ── Images ────────────────────────────────────────────────────────────────
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const isImageFile = (f: File | null | undefined): f is File => !!f && IMAGE_TYPES.has(f.type);
function imageFilesFrom(transfer: DataTransfer | null | undefined): File[] {
  if (!transfer) return [];
  const files = Array.from(transfer.files ?? []).filter(isImageFile);
  if (files.length) return files;
  return Array.from(transfer.items ?? []).filter((i: DataTransferItem) => i.kind === "file" && IMAGE_TYPES.has(i.type)).map((i: DataTransferItem) => i.getAsFile()).filter(isImageFile);
}
function readFileAsDataURL(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result)), { once: true });
    reader.addEventListener("error", () => reject(reader.error ?? new Error("Could not read the image.")), { once: true });
    reader.readAsDataURL(file);
  });
}
function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => resolve(image), { once: true });
    image.addEventListener("error", () => reject(new Error("That file is not an image this browser can decode.")), { once: true });
    image.src = src;
  });
}
// Stored images are always PNG, JPEG or GIF: those open everywhere a document
// goes (Word and Pages show a WebP inside a .docx as a blank box). Opaque
// pictures become JPEG; anything with a transparent pixel stays PNG, which has
// no quality knob, so it shrinks instead until it fits.
const IMAGE_MAX_DIMENSION = 1600, IMAGE_MAX_LENGTH = 14e5, IMAGE_MAX_GIF = 27e5;
function hasTransparency(image: HTMLImageElement, w0: number, h0: number) {
  const s = Math.min(1, 96 / Math.max(w0, h0, 1));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w0 * s)); c.height = Math.max(1, Math.round(h0 * s));
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(image, 0, 0, c.width, c.height);
  const { data } = ctx.getImageData(0, 0, c.width, c.height);
  for (let i = 3; i < data.length; i += 4) if (data[i] < 255) return true;
  return false;
}
function encodeImage(image: HTMLImageElement): { src: string; width: number } {
  const w0 = image.naturalWidth || image.width, h0 = image.naturalHeight || image.height;
  const alpha = hasTransparency(image, w0, h0);
  let scale = Math.min(1, IMAGE_MAX_DIMENSION / Math.max(w0, h0, 1));
  for (let attempt = 0; attempt < 8; attempt++) {
    const width = Math.max(1, Math.round(w0 * scale)), height = Math.max(1, Math.round(h0 * scale));
    const c = document.createElement("canvas");
    c.width = width; c.height = height;
    const ctx = c.getContext("2d")!;
    // JPEG has no alpha: a picture that is opaque everywhere loses nothing,
    // and the white keeps any stray edge from turning black.
    if (!alpha) { ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, width, height); }
    ctx.drawImage(image, 0, 0, width, height);
    if (alpha) {
      const src = c.toDataURL("image/png");
      if (src.length <= IMAGE_MAX_LENGTH) return { src, width };
    } else {
      for (const quality of [0.86, 0.74, 0.62, 0.5]) {
        const src = c.toDataURL("image/jpeg", quality);
        if (src.length <= IMAGE_MAX_LENGTH) return { src, width };
      }
    }
    scale *= alpha ? 0.8 : 0.7;
  }
  throw new Error("That image is too large to embed.");
}
async function prepareImage(file: File) {
  const original = await readFileAsDataURL(file);
  const image = await loadImage(original);
  const w0 = image.naturalWidth || image.width, h0 = image.naturalHeight || image.height;
  const alt = (file.name || "").replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " ").trim() || "Image";
  if (file.type === "image/gif" && original.length <= IMAGE_MAX_GIF && Math.max(w0, h0) <= IMAGE_MAX_DIMENSION) return { src: original, alt, width: w0 };
  return { ...encodeImage(image), alt };
}
// Pasted or dropped HTML can carry a WebP (or an oversized) data URL. It goes
// in as it is, marked, and is re-encoded right after (changed() calls this);
// the mark is never saved. Images already in the document are left alone.
const needsReencode = (src: string) => /^data:image\/webp/i.test(src) || src.length > IMAGE_MAX_LENGTH && !/^data:image\/gif/i.test(src);
let reencoding = false;
async function reencodeMarkedImages() {
  if (reencoding || !editor.querySelector("img[data-reencode]")) return;
  reencoding = true;
  try {
    for (let img; (img = editor.querySelector("img[data-reencode]")); ) {
      const from = img.getAttribute("src") || "";
      let src = null;
      try { src = encodeImage(await loadImage(from)).src; } catch {}
      if (!img.isConnected) continue;
      img.removeAttribute("data-reencode");
      if (src && img.getAttribute("src") === from) img.setAttribute("src", src);
      changed();
    }
  } finally { reencoding = false; }
}
const isSafeImageDataUrl = (src: string | null | undefined) => /^data:image\/(png|jpe?g|webp|gif);base64,/i.test(src || "");
function editorContentWidth() {
  const cs = getComputedStyle(editor);
  return editor.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
}
function pickImage() {
  if (getRange()) lastRange = getRange()!.cloneRange();
  imageInput.value = "";
  imageInput.click();
}
imageInput.addEventListener("change", () => insertImageFiles(Array.from(imageInput.files || [])));
async function insertImageFiles(files: File[]) {
  const images = files.filter(isImageFile);
  if (!images.length) return;
  closePop(true);
  hideImageControls();
  showSync("saving", "Adding image…");
  try {
    for (const file of images) {
      const { src, width, alt } = await prepareImage(file);
      if (!isSafeImageDataUrl(src)) continue;
      ensureSelection();
      const display = Math.round(Math.min(width || 520, Math.max(240, editorContentWidth())));
      exec("insertHTML", `<img class="doc-image" draggable="true" src="${src}" alt="${escapeHtml(alt)}" style="width:${display}px;height:auto;">`);
      if (getRange()) lastRange = getRange()!.cloneRange();
    }
    // Nothing to save (no image went in): don't leave "Adding image…" up.
    if (!saver.busy) setSync("saved");
  } catch {
    showSync("offline", "Couldn’t add image");
    setTimeout(() => setSync(saver.busy ? "saving" : "saved"), 2400);
  }
}
function setCaretFromPoint(x: number, y: number) {
  let range: Range | null = null;
  if (document.caretRangeFromPoint) range = document.caretRangeFromPoint(x, y);
  else if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(x, y);
    if (pos) { range = document.createRange(); range.setStart(pos.offsetNode, pos.offset); range.collapse(true); }
  }
  if (!range || !editor.contains(range.startContainer)) {
    range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
  }
  setRange(range);
}

let selectedImage: HTMLElement | null = null, resizingImage = false, draggedImage: HTMLElement | null = null, textDragFromEditor = false;
function positionImageControls() {
  if (!selectedImage || !editor.contains(selectedImage)) return hideImageControls();
  const r = selectedImage.getBoundingClientRect();
  const top = bar.getBoundingClientRect().bottom;
  if (r.bottom < top || r.top > innerHeight) { imageControls.style.display = "none"; return; }
  imageControls.style.clipPath = `inset(${Math.max(0, Math.round(top - r.top))}px -20px -20px -20px)`;
  Object.assign(imageControls.style, { display: "block", left: Math.round(r.left) + "px", top: Math.round(r.top) + "px", width: Math.round(r.width) + "px", height: Math.round(r.height) + "px" });
}
function selectImage(img: HTMLElement) {
  if (selectedImage !== img) {
    selectedImage?.classList.remove("image-selected");
    selectedImage = img;
    img.classList.add("image-selected");
  }
  positionImageControls();
}
function hideImageControls() {
  selectedImage?.classList.remove("image-selected");
  selectedImage = null;
  imageControls.style.display = "none";
}
imageHandle.addEventListener("pointerdown", (e) => {
  if (!selectedImage) return;
  e.preventDefault();
  e.stopPropagation();
  resizingImage = true;
  imageControls.classList.add("resizing");
  const img = selectedImage;
  const startX = e.clientX, startW = img.getBoundingClientRect().width;
  const maxW = Math.max(80, editorContentWidth());
  const move = (ev: PointerEvent) => {
    const next = Math.round(clamp(startW + ev.clientX - startX, 80, maxW));
    img.style.width = next + "px";
    img.style.height = "auto";
    imageBadge.textContent = Math.round(next / maxW * 100) + "%";
    positionImageControls();
  };
  // A release outside the frame never reaches it: the drag also ends when the
  // handle loses its pointer capture or the frame loses focus.
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    window.removeEventListener("blur", up);
    imageHandle.removeEventListener("lostpointercapture", up);
    resizingImage = false;
    imageControls.classList.remove("resizing");
    changed();
  };
  imageBadge.textContent = Math.round(startW / maxW * 100) + "%";
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
  window.addEventListener("blur", up);
  try {
    imageHandle.setPointerCapture(e.pointerId);
    imageHandle.addEventListener("lostpointercapture", up);
  } catch {}
});
editor.addEventListener("dragstart", (e) => {
  const img = e.target instanceof Element && e.target.closest<HTMLElement>("img.doc-image");
  // Dragging selected text within the document: the browser's own drop moves it.
  textDragFromEditor = !img && e.target instanceof Node && editor.contains(e.target);
  if (!img || !editor.contains(img)) return;
  draggedImage = img;
  hideImageControls();
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("application/x-doc-image-move", "1");
    e.dataTransfer.setData("text/plain", "");
  }
});
editor.addEventListener("dragend", () => { draggedImage = null; textDragFromEditor = false; editor.classList.remove("drop-target"); });
editor.addEventListener("dragover", (e) => {
  const types = Array.from(e.dataTransfer?.types || []);
  if (draggedImage || types.includes("Files") || types.includes("text/html") || types.includes("text/plain")) {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = draggedImage ? "move" : "copy";
    editor.classList.toggle("drop-target", types.includes("Files"));
  }
});
editor.addEventListener("dragleave", () => editor.classList.remove("drop-target"));
editor.addEventListener("drop", (e) => {
  editor.classList.remove("drop-target");
  if (draggedImage && editor.contains(draggedImage)) {
    e.preventDefault();
    const img = draggedImage;
    draggedImage = null;
    setCaretFromPoint(e.clientX, e.clientY);
    const range = getRange();
    if (range) {
      range.insertNode(img);
      const after = document.createRange();
      after.setStartAfter(img);
      after.collapse(true);
      setRange(after);
    }
    selectImage(img);
    changed();
    return;
  }
  const files = imageFilesFrom(e.dataTransfer);
  if (files.length) {
    e.preventDefault();
    setCaretFromPoint(e.clientX, e.clientY);
    insertImageFiles(files);
    return;
  }
  // Text dragged within the document: let the browser move it. Inserting a
  // copy here would leave the original behind, duplicating the text.
  if (textDragFromEditor) { textDragFromEditor = false; return; }
  const html = e.dataTransfer?.getData("text/html");
  const text = e.dataTransfer?.getData("text/plain");
  if (html?.trim() || text) {
    e.preventDefault();
    setCaretFromPoint(e.clientX, e.clientY);
    // Dropped on a table cell, it fills the cells as a paste there does.
    const range = getRange();
    const cell = range && cellOf(range.startContainer);
    if (cell) pasteIntoCell(cell, html || "", text || "");
    else insertPasted(clipboardHtml(html, text));
  }
});

// ── Paste ────────────────────────────────────────────────────────────────
function sanitizeImageElement(src: Element) {
  const url = src.getAttribute("src") || "";
  if (!isSafeImageDataUrl(url)) return null;
  const img = el("img", { class: "doc-image", draggable: "true", src: url, alt: src.getAttribute("alt") || "Image", "data-reencode": needsReencode(url) });
  const sw = (src.getAttribute("style") || "").match(/width\s*:\s*([0-9.]+)px/i);
  const w = sw ? parseFloat(sw[1]) : parseInt(src.getAttribute("width") || "", 10);
  if (w > 0) img.style.width = clamp(Math.round(w), 40, 1200) + "px";
  img.style.height = "auto";
  return img;
}
// The conversions themselves are in lib/paste.ts.
const pasteContext: PasteContext = { colorKeys: COLOR_KEYS, image: sanitizeImageElement };
const sanitizePastedHtml = (html: string) => sanitizeHtml(html, pasteContext);
// Clipboard HTML and text as the editor's markup. A code editor's HTML is only
// its text, syntax-coloured, so the text is pasted (and read as Markdown).
const clipboardHtml = (html: string | undefined, text: string | undefined) =>
  html?.trim() && !isCodeEditorHtml(html) ? sanitizePastedHtml(html) : textToHtml(text);
// There is always a line after a table, so a pasted table at the end of the
// document can be typed after.
function insertPasted(html: string) {
  exec("insertHTML", html);
  const last = editor.lastElementChild;
  if (last?.tagName === "TABLE") { last.after(emptyParagraph()); changed(); }
}
editor.addEventListener("paste", (e) => {
  const cb = e.clipboardData;
  if (!cb) return;
  const images = imageFilesFrom(cb);
  if (images.length) {
    e.preventDefault();
    insertImageFiles(images);
    return;
  }
  e.preventDefault();
  const range = getRange();
  const text = cb.getData("text/plain") || "";
  const html = cb.getData("text/html");
  if (range && closestEl(range.startContainer, "pre")) { exec("insertHTML", escapeHtml(text)); return; }
  if (range && closestEl(range.startContainer, "code")) { exec("insertText", text.replace(/\s*\n\s*/g, " ")); return; }
  // Pasting a URL over selected text turns the text into a link.
  if (range && !range.collapsed && looksLikeUrl(text) && !/\n/.test(range.toString())) { exec("createLink", normalizeHref(text)); return; }
  const cell = range && cellOf(range.startContainer);
  if (cell) { pasteIntoCell(cell, html, text); return; }
  if (looksLikeUrl(text) && !(html?.trim() && !isCodeEditorHtml(html))) exec("insertHTML", `<a href="${escapeHtml(normalizeHref(text))}">${escapeHtml(text.trim())}</a>`);
  else insertPasted(clipboardHtml(html, text));
});

/* ═══════════════════ 8. Keyboard, input rules, slash menu ═══════════════ */

function atBlockStart(block: Node, range: Range) {
  const r = document.createRange();
  r.selectNodeContents(block);
  r.setEnd(range.startContainer, range.startOffset);
  return !r.toString().replace(/\u200B/g, "").length && !r.cloneContents().querySelector?.("img");
}

// ── Leaving a list item ──────────────────────────────────────────────────
// Backspace at the start of an item, Enter on an empty item, and Shift+Tab on
// a top-level item all mean "this line is no longer a list item": a nested
// item moves out one level; a top-level item becomes a plain paragraph in
// place, splitting the list around it. Nothing above it is ever deleted.
const isNestedItem = (li: Element) => /^(LI|UL|OL)$/.test(li.parentElement?.parentElement?.tagName || "");
function leaveListItem(li: HTMLElement) {
  if (isNestedItem(li)) { exec("outdent"); changed(); return; }
  const list = li.parentElement!;
  const p = document.createElement("p");
  if (li.style.textAlign) p.style.textAlign = li.style.textAlign;
  const nested: HTMLElement[] = [];
  for (const c of Array.from(li.childNodes)) {
    if (isElement(c) && (c.tagName === "UL" || c.tagName === "OL")) nested.push(c);
    else if (isElement(c) && LINE_TAGS.test(c.tagName)) { while (c.firstChild) p.appendChild(c.firstChild); c.remove(); }
    else p.appendChild(c);
  }
  if (!hasContent(p) && !p.querySelector("br")) p.appendChild(document.createElement("br"));
  // Items under it come out one level too, keeping their own list type.
  const isTodo = list.classList.contains("checklist");
  for (const n of nested) if (isTodo && n.tagName === "UL") n.classList.add("checklist");
  const tail = list.cloneNode(false) as HTMLElement;
  tail.removeAttribute("data-block-id");
  while (li.nextSibling) tail.appendChild(li.nextSibling);
  li.remove();
  list.after(p);
  let last: HTMLElement = p;
  for (const n of nested) { last.after(n); last = n; }
  if (tail.querySelector("li")) last.after(tail);
  if (!list.querySelector("li")) {
    if (list.hasAttribute("data-block-id")) p.setAttribute("data-block-id", list.getAttribute("data-block-id")!);
    list.remove();
  }
  const [node, offset] = startPoint(p);
  placeCaret(node, offset);
  changed();
}
function handlePreEnter(e: KeyboardEvent, pre: HTMLElement) {
  e.preventDefault();
  const range = getRange()!;

  const before = document.createRange();
  before.selectNodeContents(pre);
  before.setEnd(range.startContainer, range.startOffset);
  const after = document.createRange();
  after.selectNodeContents(pre);
  after.setStart(range.endContainer, range.endOffset);
  const beforeText = textWithBreaks(before.cloneContents());
  const afterText = textWithBreaks(after.cloneContents());
  // Enter on an empty last line leaves the code block.
  if (range.collapsed && !afterText.replace(/\n+$/, "") && /\n$/.test(beforeText)) {
    for (let last = pre.lastChild; last; last = pre.lastChild) {
      if (isElement(last) && last.tagName === "BR") { last.remove(); continue; }
      if (isText(last)) {
        const trimmed = last.data.replace(/\n+$/, "");
        if (!trimmed) { last.remove(); continue; }
        last.data = trimmed;
      }
      break;
    }
    if (!pre.firstChild) pre.appendChild(document.createElement("br"));
    const p = emptyParagraph();
    pre.after(p);
    placeCaret(p, 0);
    changed();
    return;
  }
  if (!exec("insertLineBreak")) exec("insertHTML", "\n");
}

// Triple-clicking a line (and on some platforms double-clicking its only word)
// selects to the very start of the *next* line. Deleting or typing over that
// selection then merges the next line into this one: a heading below a
// bullet folds into the bullet. A selection that ends at the start of a line,
// with nothing of that line selected, is pulled back to the end of the line
// before it, so only what's visibly highlighted is replaced.
const LINE_SEL = "li, p, h1, h2, h3, h4, h5, h6, blockquote, pre, td, th, div";
function trimSelectionToLine() {
  const range = getRange();
  if (!range || range.collapsed) return;
  const c = range.endContainer, o = range.endOffset;
  const at = isElement(c) && c.childNodes[o] ? c.childNodes[o] : c;
  const line = at === editor ? null : closestEl(at, LINE_SEL);
  if (!line || line.contains(range.startContainer)) return;
  const head = document.createRange();
  head.selectNodeContents(line);
  try { head.setEnd(c, o); } catch { return; }
  if (head.toString().replace(/\u200B/g, "") || head.cloneContents().querySelector?.("img, hr, br")) return;
  const sel = window.getSelection()!;
  if (typeof sel.modify !== "function") return;
  sel.setBaseAndExtent(range.startContainer, range.startOffset, c, o);
  sel.modify("extend", "backward", "character");
  // Only the line break itself was selected (e.g. ⇧→ at the end of a line):
  // then joining the lines is exactly what's asked for, so keep it.
  const now = getRange();
  if (!now || now.collapsed) sel.setBaseAndExtent(range.startContainer, range.startOffset, c, o);
}
editor.addEventListener("keydown", (e) => {
  if (e.isComposing || composing) return;
  const mod = isMac ? e.metaKey : e.ctrlKey;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const replaces = k === "Backspace" || k === "Delete" || k === "Enter" ||
    (e.key.length === 1 && !mod && !(isMac ? e.ctrlKey : e.metaKey)) || (mod && !e.altKey && (k === "x" || k === "v"));
  if (replaces) trimSelectionToLine();
}, true);

editor.addEventListener("keydown", (e) => {
  if (slash && handleSlashKey(e)) return;
  if (e.isComposing || composing) return;
  if (handleTableKey(e)) return;
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (selectedImage && (e.key === "Backspace" || e.key === "Delete")) {
    e.preventDefault();
    const parent = selectedImage.parentElement;
    selectedImage.remove();
    hideImageControls();
    if (parent && parent !== editor && !parent.textContent.trim() && !parent.querySelector("img, br")) parent.appendChild(document.createElement("br"));
    changed();
    return;
  }
  if (selectedImage && !["Shift", "Meta", "Control", "Alt"].includes(e.key)) hideImageControls();
  if (mod && !e.altKey) {
    const k = e.key.toLowerCase();
    if (k === "k" && !e.shiftKey) { e.preventDefault(); openLinkEditor(); return; }
    if (k === "e" && !e.shiftKey) { e.preventDefault(); toggleCode(); return; }
    if (k === "s" && !e.shiftKey) { e.preventDefault(); saveNow(); return; }
    if (e.code === "Backslash" && !e.shiftKey) { e.preventDefault(); clearFormatting(); return; }
    if (k === "x" && e.shiftKey) { e.preventDefault(); exec("strikeThrough"); return; }
    if (k === "h" && e.shiftKey) { e.preventDefault(); toggleHighlight(); return; }
    if (e.shiftKey && e.code === "Digit7") { e.preventDefault(); setList("ol"); return; }
    if (e.shiftKey && e.code === "Digit8") { e.preventDefault(); setList("ul"); return; }
    if (e.shiftKey && e.code === "Digit9") { e.preventDefault(); setList("todo"); return; }
    if (e.code === "Slash") { e.preventDefault(); openShortcuts(); return; }
    if (e.key === "Enter") {
      const li = closestEl(caretNode(), "li");
      if (li && li.closest("ul.checklist")) { e.preventDefault(); toggleCheck(li); }
      return;
    }
  }
  if (mod && e.altKey && /^Digit[0-3]$/.test(e.code)) {
    e.preventDefault();
    setBlockType((["p", "h1", "h2", "h3"] as const)[Number(e.code.slice(5))]);
    return;
  }
  const range = getRange();
  if (!range) return;
  if (e.key === "Tab" && !mod && !e.altKey) {
    if (closestEl(range.startContainer, "pre")) { e.preventDefault(); if (!e.shiftKey) exec("insertText", "  "); return; }
    e.preventDefault();
    const li = closestEl(range.startContainer, "li");
    if (e.shiftKey && li && !isNestedItem(li) && range.collapsed) { leaveListItem(li); return; }
    exec(e.shiftKey ? "outdent" : "indent");
    changed();
    return;
  }
  if (e.key === "Enter" && !e.shiftKey && !mod && !e.altKey) {
    if (pipeRowToTable(range)) { e.preventDefault(); return; }
    const pre = closestEl(range.startContainer, "pre");
    if (pre) { handlePreEnter(e, pre); return; }
    const li = range.collapsed && closestEl(range.startContainer, "li");
    if (li && !hasContent(li)) { e.preventDefault(); leaveListItem(li); return; }
    const quote = closestEl(range.startContainer, "blockquote");
    if (quote && quote.parentElement === editor && range.collapsed && !quote.getAttribute("style")) {
      const rest = document.createRange();
      rest.selectNodeContents(quote);
      rest.setStart(range.endContainer, range.endOffset);
      if (!rest.toString().replace(/\u200B/g, "").length) {
        e.preventDefault();
        const p = emptyParagraph();
        quote.after(p);
        placeCaret(p, 0);
        changed();
        return;
      }
    }
  }
  if (e.key === "Backspace" && !mod && !e.altKey && range.collapsed) {
    const li = closestEl(range.startContainer, "li");
    if (li && atBlockStart(li, range)) { e.preventDefault(); leaveListItem(li); return; }
    const top = topBlockOf(range.startContainer);
    // An indented paragraph outdents first.
    if (top && top.tagName === "BLOCKQUOTE" && top.getAttribute("style") && atBlockStart(top, range)) {
      e.preventDefault();
      exec("outdent");
      changed();
      return;
    }
    if (top && /^(H[1-6]|BLOCKQUOTE|PRE)$/.test(top.tagName) && atBlockStart(top, range)) {
      e.preventDefault();
      top.classList.remove("doc-title");
      cleanClass(top);
      exec("formatBlock", "<p>");
      return;
    }
  }
  // Delete on an empty line removes just that line; the block below (a list,
  // heading, quote…) moves up unchanged, with the caret at its start.
  if (e.key === "Delete" && !mod && !e.altKey && range.collapsed) {
    const top = topBlockOf(range.startContainer);
    const next = top?.nextElementSibling;
    if (top && next && top.tagName === "P" && !hasContent(top) && !closestEl(range.startContainer, "li")) {
      e.preventDefault();
      top.remove();
      const [node, offset] = startPoint(next);
      placeCaret(node, offset);
      changed();
      return;
    }
  }
  // → at the very end of inline code steps out of it.
  if (e.key === "ArrowRight" && !e.shiftKey && !mod && range.collapsed) {
    const code = closestEl(range.startContainer, "code");
    if (code && !closestEl(code, "pre")) {
      const rest = document.createRange();
      rest.selectNodeContents(code);
      rest.setStart(range.startContainer, range.startOffset);
      if (!rest.toString().length) {
        e.preventDefault();
        let next = code.nextSibling;
        if (!isText(next) || !next.data.startsWith(ZWSP)) { next = document.createTextNode(ZWSP); code.after(next); }
        placeCaret(next, 1);
      }
    }
  }
});

editor.addEventListener("compositionstart", () => { composing = true; syncPlaceholder(); });
editor.addEventListener("compositionend", () => {
  composing = false;
  normalize();
  changed();
  // A remote change held back from the block while it was being composed in
  // is merged in now, once the browser has finished with the composition.
  if (pendingByBlock.size) setTimeout(() => { if (!composing && ready && settlePendingBlocks()) scheduleSave(); }, 0);
});

let deletedSelection = false;
editor.addEventListener("beforeinput", (e) => { deletedSelection = e.inputType.startsWith("delete") && getRange()?.collapsed === false; });
editor.addEventListener("input", (e) => {
  if (e.isComposing || composing) { scheduleSave(); return; }
  normalize();
  // Deleting a selection that spans a table (⌘A, ⌫) leaves Chrome's merge of
  // two empty lines, <p><br><br></p>: an empty line that is two lines tall.
  if (e.inputType?.startsWith("delete") && deletedSelection) {
    const top = currentTopBlock();
    if (top && LINE_TAGS.test(top.tagName) && top.childNodes.length === 2 && Array.from(top.childNodes).every((n) => isElement(n) && n.tagName === "BR")) {
      top.firstChild!.remove();
      placeCaret(top, 0);
    }
  }
  if (!applyingRule) {
    if (e.inputType === "insertText" && e.data) runInputRules(e.data);
    if (e.inputType === "insertParagraph") afterParagraph();
  }
  changed({ typing: true });
});

function afterParagraph() {
  const li = closestEl(caretNode(), "li");
  if (li && li.closest("ul.checklist") && li.getAttribute("data-checked") === "true" && !li.textContent.replace(/\u200B/g, "").trim()) li.removeAttribute("data-checked");
}

function selectBetween(startNode: Node, startOffset: number, endNode: Node, endOffset: number) {
  const r = document.createRange();
  r.setStart(startNode, startOffset);
  r.setEnd(endNode, endOffset);
  setRange(r);
}
function runInputRules(data: string) {
  const range = getRange();
  if (!range || !range.collapsed) return;
  const node = range.startContainer;
  if (!isText(node) || closestEl(node, "pre")) return;
  const offset = range.startOffset;
  const before = node.data.slice(0, offset);
  const inCode = !!closestEl(node, "code");
  const top = topBlockOf(node);
  // "/" opens the menu at the start of a line or after a space, judged on the
  // whole line (with soft line breaks), not just this text node -- which may
  // start right after bold text or a link.
  const slashLine = () => {
    const host = closestEl(node, "li") || top;
    if (!host) return before;
    const r = document.createRange();
    r.selectNodeContents(host);
    r.setEnd(node, offset);
    return textWithBreaks(r.cloneContents()).replace(/\u200B/g, "");
  };
  applyingRule = true;
  try {
    if (data === "/" && !inCode && !closestEl(node, "td, th") && /(^|[\s\u00a0])\/$/.test(slashLine())) {
      openSlash(node, offset - 1);
      return;
    }
    // "[ ] " or "[x] " at the start of a list item (so "- [ ] " works too)
    // turns that item into a to-do.
    const li = closestEl(node, "li");
    if (!inCode && li && data === " " && !li.closest("ul.checklist")) {
      const m = textBefore(li, range).match(/^\[([ \u00a0xX]?)\][ \u00a0]$/);
      if (m) {
        selectBetween(li, 0, node, offset);
        exec("delete");
        itemToTodo(closestEl(caretNode(), "li") || li, /x/i.test(m[1]));
        changed();
        return;
      }
    }
    // In an indented paragraph the line is the <p> inside the indent; a block
    // rule there takes the line out of the indent first (a list has its own).
    const indent = top?.tagName === "BLOCKQUOTE" && top.getAttribute("style") ? top : null;
    const host = indent ? closestEl(node, "p, div") : top;
    const unindent = () => { for (let i = 0; i < 12 && closestEl(caretNode(), 'blockquote[style*="margin"]'); i++) exec("outdent"); };
    if (!inCode && host && (host.tagName === "P" || host.tagName === "DIV") && !li) {
      const line = textBefore(host, range);
      if (data === " ") {
        const m = line.match(/^(#{1,3}|[-*•+]|1[.)]|\[[ \u00a0xX]?\]|>)[ \u00a0]$/);
        if (m) {
          selectBetween(host, 0, node, offset);
          exec("delete");
          if (indent) unindent();
          const p = m[1];
          if (p[0] === "#") setBlockType(("h" + p.length) as BlockKind); // "#" to "###": h1 to h3
          else if (p === ">") setBlockType("quote");
          else if (p[0] === "[") {
            setList("todo");
            if (/x/i.test(p)) { const li = closestEl(caretNode(), "li"); if (li) li.setAttribute("data-checked", "true"); }
          } else if (/\d/.test(p)) setList("ol");
          else setList("ul");
          return;
        }
      }
      if (data === "`" && line === "```") { selectBetween(host, 0, node, offset); exec("delete"); if (indent) unindent(); setBlockType("code"); return; }
      if (data === "-" && line === "---" && host.textContent === "---") { selectBetween(host, 0, node, offset); exec("delete"); if (indent) unindent(); insertDivider(); return; }
    }
    if (inCode) return;
    if ("*_~`".includes(data) && inlineRule(node, offset)) return;
    if (data === ">" && /-$/.test(before.slice(0, -1)) && before.endsWith("->")) { selectBetween(node, offset - 2, node, offset); exec("insertText", "→"); return; }
    if (data === "-" && before.endsWith("<-")) { selectBetween(node, offset - 2, node, offset); exec("insertText", "←"); return; }
    if (data === " " && /(^|[^-])--[ \u00a0]$/.test(before)) { selectBetween(node, offset - 3, node, offset); exec("insertText", "— "); return; }
  } finally {
    applyingRule = false;
  }
}
const INLINE_RULES: [RegExp, string, number][] = [
  [/(?:^|[^*\\])\*\*([^*\s](?:[^*]*[^*\s])?)\*\*$/, "b", 2],
  [/(?:^|[^_\w\\])__([^_\s](?:[^_]*[^_\s])?)__$/, "b", 2],
  [/(?:^|[^~])~~([^~\s](?:[^~]*[^~\s])?)~~$/, "s", 2],
  [/(?:^|[^`])`([^`\s](?:[^`]*[^`\s])?)`$/, "code", 1],
  [/(?:^|[^*\w\\])\*([^*\s](?:[^*]*[^*\s])?)\*$/, "i", 1],
  [/(?:^|[^_\w\\])_([^_\s](?:[^_]*[^_\s])?)_$/, "i", 1]
];
function inlineRule(node: Text, offset: number) {
  const text = node.data.slice(0, offset);
  for (const [re, tag, ml] of INLINE_RULES) {
    const m = text.match(re);
    if (!m) continue;
    const inner = m[1];
    const start = offset - inner.length - ml * 2;
    if (start < 0) continue;
    selectBetween(node, start, node, offset);
    exec("insertHTML", `<${tag}>${escapeHtml(inner)}</${tag}>${ZWSP}`);
    return true;
  }
  return false;
}

// ── Slash menu ──────────────────────────────────────────────────────────
/** An entry of the slash menu: a block type, or one of the inserts. */
interface SlashItem {
  key: BlockKind | "divider" | "image" | "table";
  label: string;
  icon: string;
  hint?: string;
  keywords?: string;
}
/** The open slash menu: the "/" it was typed as, what it shows, and how it was opened. */
interface SlashState {
  node: Text;
  start: number;
  active: number;
  items: SlashItem[];
  pop: HTMLElement | null;
  chosen?: boolean;
  escaped?: boolean;
  /** The line a block's "+" made (or reused) for this menu. */
  fromPlus?: Element;

  reused?: boolean;
}
const SLASH_ITEMS: SlashItem[] = [
  ...BLOCK_TYPES.map((t) => ({ ...t, hint: t.md, keywords: { p: "paragraph plain normal", h1: "title heading large", h2: "heading subtitle medium", h3: "heading small subheading", ul: "bullet unordered list", ol: "number ordered list", todo: "todo checkbox task checklist", quote: "blockquote citation", code: "pre snippet monospace" }[t.key] })),
  { key: "divider", label: "Divider", icon: "divider", hint: "---", keywords: "hr line rule separator" },
  { key: "image", label: "Image", icon: "image", keywords: "picture photo upload media" },
  { key: "table", label: "Table", icon: "table", hint: "| |", keywords: "grid rows columns cells spreadsheet" }
];
let slash: SlashState | null = null;
function slashMatches(q: string) {
  q = q.toLowerCase().trim();
  if (!q) return SLASH_ITEMS;
  return SLASH_ITEMS.map((it) => {
    const label = it.label.toLowerCase();
    const score = label.startsWith(q) ? 0 : label.split(" ").some((w) => w.startsWith(q)) ? 1 : (label + " " + (it.keywords || "")).includes(q) ? 2 : -1;
    return { it, score };
  }).filter((x) => x.score >= 0).sort((a, b) => a.score - b.score).map((x) => x.it);
}
function openSlash(node: Text, start: number) {
  slash = { node, start, active: 0, items: SLASH_ITEMS, pop: null };
  renderSlash();
}
function closeSlash() {
  if (!slash) return;
  const s = slash;
  slash = null;
  if (openPop?.pop === s.pop) closePop(true);
  slashDismissed(s);
}
// A menu opened from a block's "+" types a "/" into a fresh line. Dismissed
// without choosing anything, it leaves no trace: the line goes away again (or,
// if "+" reused an empty line, that line is simply empty again).
function slashDismissed(s: SlashState) {
  if (s.chosen || !s.fromPlus) return;
  // Esc tidies up at once. Otherwise wait until the click or arrow key that
  // closed the menu has moved the caret: if it is still on the line, the
  // user is working there, so the line stays.
  if (s.escaped) dropPlusLine(s, true);
  else requestAnimationFrame(() => dropPlusLine(s, false));
}
function dropPlusLine(s: SlashState, escaped: boolean) {
  const line = s.fromPlus;
  if (slash || !line?.isConnected || line.textContent.replace(/\u200B/g, "") !== "/") return;
  const range = getRange();
  const hadCaret = !!range && line.contains(range.startContainer);
  if (hadCaret && !escaped) return;
  if (s.reused) {
    line.replaceChildren(document.createElement("br"));
    if (hadCaret) placeCaret(line, 0);
  } else {
    const all = unitsOf();
    const i = all.indexOf(line);
    const near = [all[i - 1], all[i + 1]].find((u) => u && isTextual(u));
    const list = line.parentElement;
    line.remove();
    if (isListEl(list) && !list.querySelector("li")) list.remove();
    if (!editor.firstElementChild) editor.appendChild(emptyParagraph());
    if (hadCaret && near) placeCaretAtEnd(members(near)[0]);
  }
  changed();
}
function slashAnchorRect() {
  if (!slash || !slash.node.isConnected) return null;
  const r = document.createRange();
  r.setStart(slash.node, slash.start);
  r.setEnd(slash.node, Math.min(slash.start + 1, slash.node.data.length));
  return rangeRect(r);
}
function renderSlash() {
  if (!slash) return;
  const items = slash.items;
  const content = items.length
    ? items.map((it, i) => {
      const item = el("div", { class: "mi" + (i === slash!.active ? " active" : ""), role: "option" }, [
        el("span", { class: "mi-icon", html: svg(ICONS[it.icon], 17) }),
        el("span", { class: "mi-text" }, [el("span", { class: "mi-label" }, it.label), it.hint ? el("span", { class: "mi-md" }, it.hint) : null])
      ]);
      item.addEventListener("mousemove", () => { if (slash && slash.active !== i) { slash.active = i; renderSlash(); } });
      item.addEventListener("click", () => chooseSlash(it));
      return item;
    })
    : [el("div", { class: "mempty" }, "No matching blocks")];
  const rect = slashAnchorRect();
  if (!rect) return closeSlash();
  if (slash.pop && openPop?.pop === slash.pop) {
    slash.pop.replaceChildren(...content);
    placePop(slash.pop, rect);
  } else {
    const s = slash;
    slash.pop = showPop(content, rect, { kind: "slash", className: "slash", reposition: slashAnchorRect, onClose: () => { if (slash === s) { slash = null; slashDismissed(s); } } });
  }
  slash.pop!.querySelector(".mi.active")?.scrollIntoView({ block: "nearest" });
}
function updateSlash() {
  if (!slash) return;
  const range = getRange();
  const { node, start } = slash;
  if (!range || !range.collapsed || range.startContainer !== node || range.startOffset <= start || node.data[start] !== "/") return closeSlash();
  const q = node.data.slice(start + 1, range.startOffset);
  if (q.length > 24 || /^\s|\s\s/.test(q)) return closeSlash();
  const items = slashMatches(q);
  if (!items.length && q.length > 4) return closeSlash();
  slash.items = items;
  slash.active = clamp(slash.active, 0, Math.max(0, items.length - 1));
  renderSlash();
}
// Only called while the menu is open.
function handleSlashKey(e: KeyboardEvent) {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const n = slash!.items.length;
    if (n) slash!.active = (slash!.active + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
    renderSlash();
    return true;
  }
  if (e.key === "Enter" || e.key === "Tab") {
    const it = slash!.items[slash!.active];
    if (!it) { closeSlash(); return false; }
    e.preventDefault();
    chooseSlash(it);
    return true;
  }
  if (e.key === "Escape") { e.preventDefault(); slash!.escaped = true; closeSlash(); return true; }
  return false;
}
function chooseSlash(it: SlashItem) {
  if (!slash) return;
  const { node, start } = slash;
  const range = getRange();
  slash.chosen = true;
  closeSlash();
  if (node.isConnected) {
    const end = range && range.startContainer === node ? range.startOffset : Math.min(node.data.length, start + 1);
    applyingRule = true;
    selectBetween(node, start, node, end);
    exec("delete");
    applyingRule = false;
  }
  if (it.key === "divider") insertDivider();
  else if (it.key === "image") pickImage();
  else if (it.key === "table") insertTable(3, 3);
  else setBlockType(it.key);
}

// Clicking below the last block continues the document with a fresh paragraph
// (after lists, code, images and dividers the caret would otherwise be stuck).
editor.addEventListener("mousedown", (e) => {
  if (editor.contentEditable !== "true") return;
  const li = e.target instanceof Element && e.target.closest("ul.checklist li");
  if (li && editor.contains(li) && e.target === li) {
    const r = li.getBoundingClientRect();
    const size = parseFloat(getComputedStyle(li).fontSize) || 16;
    if (e.clientX - r.left < size * 1.6) { e.preventDefault(); toggleCheck(li); return; }
  }
  if (e.target !== editor) return;
  const last = editor.lastElementChild;
  if (!last || e.clientY <= last.getBoundingClientRect().bottom) return;
  const textual = /^(P|H[1-6]|DIV|BLOCKQUOTE)$/.test(last.tagName) && !(last.querySelector("img") && !last.textContent.trim());
  if (textual) return;
  e.preventDefault();
  const p = emptyParagraph();
  editor.appendChild(p);
  placeCaret(p, 0);
  changed();
});
editor.addEventListener("click", (e) => {
  const img = e.target instanceof Element && e.target.closest<HTMLElement>("img.doc-image");
  if (img && editor.contains(img)) selectImage(img);
  else if (!resizingImage) hideImageControls();
  const a = e.target instanceof Element && e.target.closest("a[href]");
  if (a && editor.contains(a) && (isMac ? e.metaKey : e.ctrlKey)) { e.preventDefault(); openUrl(a.getAttribute("href")!); }
});
// Typing into a completely empty editor would put bare text at the root; give
// the caret a real paragraph to land in instead.
editor.addEventListener("focus", () => {
  if (isExport || editor.firstChild) return syncPlaceholder();
  const p = emptyParagraph();
  editor.appendChild(p);
  placeCaret(p, 0);
  syncPlaceholder();
});

/* ══════════ 8½. Blocks: handles, selection, drag & drop, arranging ══════════ */

// Block editing in the Notion/Linear sense, layered on the same document. A
// *unit* is what one handle grabs: a top-level block or -- inside a top-level
// list -- one item together with anything nested under it. Units move,
// duplicate and delete whole; lists split and re-join around them, so every
// unit keeps its own type wherever it lands (a to-do stays a to-do).

document.head.appendChild(el("style", { text: `
.bh { position: absolute; left: 0; top: 0; z-index: 5; display: flex; align-items: center; gap: 1px; opacity: 0; pointer-events: none; transition: opacity .14s var(--ease); }
.bh.show { opacity: 1; pointer-events: auto; }
.bh.compact .bh-plus { display: none; }
.bh-btn {
  height: 24px; width: 22px; padding: 0; border: 0; border-radius: 6px;
  display: flex; align-items: center; justify-content: center;
  background: transparent; color: var(--faint); cursor: pointer;
  transition: background-color .12s var(--ease), color .12s var(--ease);
}
.bh-btn svg { display: block; }
.bh-btn:hover, .bh-grip.open { background: var(--hover); color: var(--muted); }
.bh-grip { width: 18px; cursor: grab; }
.blk-box { position: absolute; left: 0; top: 0; z-index: 1; pointer-events: none; border-radius: 7px; opacity: 0; transition: opacity .12s var(--ease); }
.blk-box.show { opacity: 1; }
.blk-box.sel { background: var(--accent-soft); }
.blk-box.hint { background: var(--hover); }
.blk-drop {
  position: absolute; left: 0; top: 0; z-index: 6; height: 2px; border-radius: 1px;
  background: var(--accent); pointer-events: none; opacity: 0;
  transition: opacity .1s var(--ease), transform .09s var(--ease), width .09s var(--ease);
}
.blk-drop.show { opacity: 1; }
.blk-drop::before { content: ""; position: absolute; left: -7px; top: -3px; width: 8px; height: 8px; border-radius: 50%; background: var(--bg); box-shadow: inset 0 0 0 2px var(--accent); }
.blk-ghost {
  position: fixed; left: 0; top: 0; z-index: 70; pointer-events: none;
  max-height: 240px; overflow: hidden; border-radius: 10px;
  background: var(--raised); box-shadow: var(--shadow-pop); opacity: .96;
  animation: blk-lift .18s var(--ease);
}
.blk-ghost.tall { -webkit-mask-image: linear-gradient(#000 calc(100% - 56px), transparent); mask-image: linear-gradient(#000 calc(100% - 56px), transparent); }
@keyframes blk-lift { from { box-shadow: 0 0 0 0 transparent; opacity: .4; } }
.blk-ghost .editor { min-height: 0; padding: 8px 12px; }
.blk-ghost .editor > :last-child { margin-bottom: 0; }
.blk-count {
  position: absolute; top: 7px; right: 8px; min-width: 20px; height: 20px; padding: 0 6px; border-radius: 10px;
  display: flex; align-items: center; justify-content: center;
  background: var(--accent); color: #fff; font: 600 11.5px/1 var(--font-ui); font-variant-numeric: tabular-nums;
}
body.blk-dragging, body.blk-dragging * { cursor: grabbing !important; }
body.blk-dragging, body.blk-sweeping { -webkit-user-select: none; user-select: none; }
.blk-sink { position: fixed; left: 0; top: 0; width: 1px; height: 1px; overflow: hidden; opacity: 0; pointer-events: none; outline: none; -webkit-user-select: text; user-select: text; }
.pop.block-actions { width: 252px; }
.bt-grid { display: grid; grid-template-columns: repeat(9, 1fr); gap: 1px; padding: 0 3px 3px; }
.bt { height: 26px; padding: 0; border: 0; border-radius: 6px; display: flex; align-items: center; justify-content: center; background: transparent; color: var(--muted); cursor: pointer; transition: background-color .12s var(--ease), color .12s var(--ease); }
.bt svg { display: block; }
.bt:hover { background: var(--hover); color: var(--text); }
.bt.on { background: var(--accent-soft); color: var(--accent); }
.mi.danger:hover, .mi.danger:hover .mi-icon { color: var(--bad); }
@media print { .bh, .blk-box, .blk-drop, .blk-ghost { display: none !important; } }
` }));

const plusBtn = el("button", { type: "button", class: "bh-btn bh-plus", tabindex: "-1", html: svg(ICONS.plus, 16) });
const gripBtn = el("button", { type: "button", class: "bh-btn bh-grip", tabindex: "-1", html: svg(ICONS.grip, 16) });
const handles = el("div", { class: "bh" }, [plusBtn, gripBtn]);
const selBox = el("div", { class: "blk-box sel", "aria-hidden": "true" });
const hintBox = el("div", { class: "blk-box hint", "aria-hidden": "true" });
const dropLine = el("div", { class: "blk-drop", "aria-hidden": "true" });
// Keyboard focus lives here while blocks are selected (the text caret is gone).
const sink = el("div", { class: "blk-sink", tabindex: "-1", role: "region", "aria-label": "Selected blocks" }, "\u00a0");
if (!isExport) page.append(selBox, hintBox, handles, dropLine, sink);
attachTip(plusBtn, isMac ? "Add below · ⌥-click to add above" : "Add below · Alt-click to add above");
attachTip(gripBtn, "Drag to move · Click for options");
for (const b of [plusBtn, gripBtn]) b.addEventListener("mousedown", (e) => e.preventDefault());

// ── Units ────────────────────────────────────────────────────────────────
const isListEl = (n: Node | null | undefined): n is HTMLElement => isElement(n) && (n.tagName === "UL" || n.tagName === "OL");
const sameKind = (a: Node | null | undefined, b: Node | null | undefined) => isListEl(a) && isListEl(b) && a.tagName === b.tagName && a.classList.contains("checklist") === b.classList.contains("checklist");
function unitsOf() {
  const out: Element[] = [];
  for (const b of editor.children) {
    if (!isListEl(b)) { out.push(b); continue; }
    for (const c of b.children) if (c.tagName === "LI" || !c.previousElementSibling) out.push(c);
  }
  return out;
}
// A list item plus any bare nested lists that follow it (Chrome's indent can
// produce <ul><li/><ul>…</ul></ul>).
function members(u: Element) {
  if (!u.parentElement || u.parentElement === editor) return [u];
  const out = [u];
  for (let n = u.nextElementSibling; n && n.tagName !== "LI"; n = n.nextElementSibling) out.push(n);
  return out;
}
function unitOf(node: Node | null | undefined): Element | null {
  const top = topBlockOf(node);
  if (!top || !isListEl(top)) return top;
  // node is inside top, so every ancestor up to it exists.
  let c: Element = (isElement(node) ? node : node!.parentElement)!;
  if (c === top) return top.firstElementChild;
  while (c.parentElement !== top) c = c.parentElement!;
  while (c.tagName !== "LI" && c.previousElementSibling) c = c.previousElementSibling;
  return c;
}
function unitsInRange(range: Range) {
  const at = (n: Node, o: number) => n === editor ? editor.childNodes[Math.min(o, editor.childNodes.length - 1)] : n;
  const a = unitOf(at(range.startContainer, range.startOffset));
  if (!a) return [];
  const b = range.collapsed ? a : unitOf(at(range.endContainer, range.endOffset)) || a;
  const all = unitsOf();
  const i = all.indexOf(a);
  let j = all.indexOf(b);
  if (i < 0) return [];
  if (j < 0) j = i;
  // A selection ending at the very start of a block (a triple-click) doesn't include it.
  if (j > i) {
    const r = document.createRange();
    r.selectNodeContents(b);
    r.setEnd(range.endContainer, range.endOffset);
    if (!r.toString().replace(/\u200B/g, "")) j--;
  }
  return all.slice(Math.min(i, j), Math.max(i, j) + 1);
}
function unitKind(u: Element) {
  if (u.parentElement !== editor) return listKind(u.parentElement);
  switch (u.tagName) {
    case "H1": return "h1";
    case "H2": return "h2";
    case "H3": case "H4": case "H5": case "H6": return "h3";
    case "BLOCKQUOTE": return u.getAttribute("style") ? "p" : "quote";
    case "PRE": return "code";
    case "HR": return "divider";
    default: return "p";
  }
}
const isImageOnly = (u: Element) => !u.textContent.replace(/[\u200B\s\u00a0]/g, "") && (u.tagName === "IMG" || !!u.querySelector("img"));
const isTextual = (u: Element) => u.tagName !== "HR" && !isImageOnly(u);
// A divider is a 1px line; give it a comfortable target and highlight.
function unitBounds(u: Element) {
  const m = members(u);
  const top = m[0].getBoundingClientRect().top, bottom = m[m.length - 1].getBoundingClientRect().bottom;
  return u.tagName === "HR" ? { top: top - 9, bottom: bottom + 9 } : { top, bottom };
}
function contentBox() {
  const r = editor.getBoundingClientRect(), cs = getComputedStyle(editor);
  return { left: r.left + (parseFloat(cs.paddingLeft) || 0), right: r.right - (parseFloat(cs.paddingRight) || 0) };
}
// Handles centre on a block's first line -- whatever its size -- so a heading,
// a code block and a to-do's checkbox all line up with their own text.
function firstLineMid(u: Element) {
  if (u.tagName === "HR") { const r = u.getBoundingClientRect(); return r.top + r.height / 2; }
  if (isImageOnly(u)) return (u.tagName === "IMG" ? u : u.querySelector("img")!).getBoundingClientRect().top + 14;
  // A table's handles line up with the text of its first row.
  if (u.tagName === "TABLE" && (u as HTMLTableElement).rows[0]?.cells[0]) u = (u as HTMLTableElement).rows[0].cells[0];
  const r = u.getBoundingClientRect(), cs = getComputedStyle(u);
  let lh = parseFloat(cs.lineHeight);
  if (!Number.isFinite(lh)) lh = (parseFloat(cs.fontSize) || 16) * 1.3;
  return r.top + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.paddingTop) || 0) + lh / 2;
}
// Selection and hover highlights: one continuous rounded tint over the whole
// run of blocks (not a stripe per block), spanning margins between them.
// The tint reaches BOX_INSET past the text on each side; the handles keep
// HANDLE_GAP clear of it, so the grip sits beside the highlight, never on it.
const BOX_INSET = 6, HANDLE_GAP = 6;
function placeBox(box: HTMLElement, units: Element[]) {
  if (!units.length) { box.classList.remove("show"); return; }
  const pr = page.getBoundingClientRect(), cb = contentBox();
  const top = unitBounds(units[0]).top, bottom = unitBounds(units[units.length - 1]).bottom;
  box.style.transform = `translate(${Math.round(cb.left - pr.left - BOX_INSET)}px, ${Math.round(top - pr.top - 3)}px)`;
  box.style.width = Math.round(cb.right - cb.left + 2 * BOX_INSET) + "px";
  box.style.height = Math.round(Math.max(8, bottom - top + 6)) + "px";
  box.classList.add("show");
}

// ── Motion ───────────────────────────────────────────────────────────────
// After any rearrangement every block slides from where it was to where it
// is (positions in document coordinates, so scrolling to follow the change
// doesn't distort it). Blocks that are new fade in.
function measureTops() {
  const st = canvas.scrollTop, m = new Map<Element, number>();
  for (const u of unitsOf()) for (const n of members(u)) {
    // Key-repeat moves stay crisp: a slide still in flight is finished first.
    for (const a of n.getAnimations?.() || []) if (a.id === "blk-flip") a.cancel();
    m.set(n, n.getBoundingClientRect().top + st);
  }
  return m;
}
function settle(before: Map<Element, number>, moved: Element[] = [], from: number | null = null) {
  if (reducedMotion.matches) return;
  const st = canvas.scrollTop, movedSet = new Set(moved), slides: Animation[] = [];
  const anchor = from !== null && moved.length ? moved[0].getBoundingClientRect().top + st : 0;
  for (const u of unitsOf()) for (const n of members(u)) {
    const now = n.getBoundingClientRect().top + st;
    const old = from !== null && movedSet.has(n) ? from + (now - anchor) : before.get(n);
    if (old === undefined) { n.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: "ease-out" }); continue; }
    const dy = old - now;
    if (Math.abs(dy) < 0.5) continue;
    const a = n.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: 260, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" });
    a.id = "blk-flip";
    slides.push(a);
  }
  rideAlong(slides);
}
// While blocks slide, the selection tint, hover tint and handles ride along,
// and are measured again once the blocks land. Measured only once, at the
// start, they'd be left behind where the blocks used to be.
function rideAlong(slides: Animation[]) {
  if (!slides.length) return;
  let live = true;
  const frame = () => { if (!live) return; refreshBlockUi(); requestAnimationFrame(frame); };
  requestAnimationFrame(frame);
  Promise.allSettled(slides.map((a) => a.finished)).then(() => {
    live = false;
    refreshBlockUi();
    queueHover();
  });
}
// Can't go further: a small nudge instead of nothing.
function nudge(units: Element[], dir: number) {
  if (reducedMotion.matches) return;
  for (const n of units.flatMap(members)) n.animate([{ transform: "none" }, { transform: `translateY(${dir * 3}px)` }, { transform: "none" }], { duration: 200, easing: "ease-out" });
}

// ── Block undo ───────────────────────────────────────────────────────────
// Moves, duplicates and deletes rearrange existing nodes, so a snapshot of
// the structure (which nodes, in which order) undoes them exactly while
// keeping every node -- and so the browser's own undo history for typing --
// intact. The snapshot also notes which to-do items are ticked, so ticking
// one is undone the same way. Any other edit clears these snapshots (see
// changed()).
function clearBlockHistory() { blockHistory.undo.length = 0; blockHistory.redo.length = 0; }
/** A snapshot of the block structure (which nodes, in which order) and of what was selected. */
interface BlockState {
  structure: { node: HTMLElement; kids: ChildNode[] | null }[];
  /** The to-do items that were ticked. */
  checked: Element[];
  sel: { anchor: Element; focus: Element } | null;
  caret: SavedSelection | null;
}
function captureState(): BlockState {
  return {
    structure: Array.from(editor.children, (node) => ({ node, kids: isListEl(node) ? Array.from(node.childNodes) : null })),
    checked: Array.from(editor.querySelectorAll("li[data-checked]")),
    sel: blockSel ? { anchor: blockSel.anchor, focus: blockSel.focus } : null,
    caret: !blockSel && document.activeElement === editor ? saveSelection() : null
  };
}
function restoreState(s: BlockState) {
  for (const { node, kids } of s.structure) {
    if (!kids) continue;
    const keep = new Set(kids);
    for (const c of Array.from(node.childNodes)) if (!keep.has(c)) c.remove();
    for (const k of kids) node.appendChild(k);
  }
  editor.replaceChildren(...s.structure.map((x) => x.node));
  const checked = new Set(s.checked);
  for (const li of editor.querySelectorAll("ul.checklist li")) {
    if (checked.has(li)) li.setAttribute("data-checked", "true");
    else li.removeAttribute("data-checked");
  }
  if (s.sel && s.sel.anchor.isConnected && s.sel.focus.isConnected) selectBlocks(s.sel.anchor, s.sel.focus);
  else if (s.caret) { clearBlockSel(); editor.focus({ preventScroll: true }); restoreSelection(s.caret); }
}
function recordBlockStep() {
  blockHistory.undo.push(captureState());
  if (blockHistory.undo.length > 60) blockHistory.undo.shift();
  blockHistory.redo.length = 0;
}
function stepBlockHistory(redo: boolean) {
  const from = redo ? blockHistory.redo : blockHistory.undo;
  const to = redo ? blockHistory.undo : blockHistory.redo;
  const state = from.pop();
  if (!state) return false;
  const before = measureTops();
  to.push(captureState());
  restoreState(state);
  blockChanged();
  settle(before);
  return true;
}
function undoAny() { if (!stepBlockHistory(false)) exec("undo"); }
function redoAny() { if (!stepBlockHistory(true)) exec("redo"); }
function blockChanged() {
  blockOpDepth++;
  try { changed(); } finally { blockOpDepth--; }
}

// ── Rearranging ──────────────────────────────────────────────────────────
// A "carrier" is a unit taken out of the document: its nodes, plus the list it
// came from (as the template for its kind).
/** A unit taken out of the document: its nodes, and the list it came from (null at the top level). */
interface Carrier {
  nodes: Element[];
  list: HTMLElement | null;
}
/** Where carriers go in: before `ref` in `parent` (at its end when `ref` is null). */
interface InsertCursor {
  parent: Element;
  ref: Node | null;
}
function detach(units: Element[], touched: Set<Element>): Carrier[] {
  return units.map((u) => {
    const list = u.parentElement !== editor ? u.parentElement : null;
    const nodes = members(u);
    const outer = list || u;
    if (outer.previousElementSibling) touched.add(outer.previousElementSibling);
    if (outer.nextElementSibling) touched.add(outer.nextElementSibling);
    for (const n of nodes) n.remove();
    if (list) { touched.add(list); if (!list.firstElementChild) list.remove(); }
    return { nodes, list };
  });
}
function cursorFor(target: Element | undefined, side: "before" | "after"): InsertCursor {
  if (!target) return { parent: editor, ref: null };
  if (side === "before") return { parent: target.parentElement!, ref: target };
  const m = members(target);
  return { parent: target.parentElement!, ref: m[m.length - 1].nextSibling };
}
function bareListClone(list: Element) {
  const c = list.cloneNode(false) as Element;
  c.removeAttribute("data-block-id");
  c.removeAttribute("data-ph");
  c.removeAttribute("start");
  return c;
}
// A reference node that is not an element is character data (text, or a comment).
function splitListAt(list: Element, ref: Node | null, touched: Set<Element>): InsertCursor {
  const first = ref && !isElement(ref) ? (ref as CharacterData).nextElementSibling : ref;
  if (!first) return { parent: editor, ref: list.nextSibling };
  if (!first.previousElementSibling) return { parent: editor, ref: list };
  const tail = bareListClone(list);
  for (let n: Node | null = first; n;) { const next: ChildNode | null = n.nextSibling; tail.appendChild(n); n = next; }
  list.after(tail);
  touched.add(tail);
  return { parent: editor, ref: tail };
}
function insertCarriers(carriers: Carrier[], cur: InsertCursor, touched: Set<Element>) {
  const heads: Element[] = [];
  for (const c of carriers) {
    if (cur.parent !== editor) {
      const list = cur.parent;
      touched.add(list);
      if (c.list && sameKind(c.list, list)) {
        for (const n of c.nodes) list.insertBefore(n, cur.ref);
        heads.push(c.nodes[0]);
        continue;
      }
      cur = splitListAt(list, cur.ref, touched);
    }
    if (!c.list) {
      editor.insertBefore(c.nodes[0], cur.ref);
      heads.push(c.nodes[0]);
      continue;
    }
    // A list item at the top level joins a neighbouring list of its kind, or
    // gets a list of its own.
    const prevEl = cur.ref ? (cur.ref as Element | CharacterData).previousElementSibling : editor.lastElementChild;
    const nextEl = cur.ref ? (isElement(cur.ref) ? cur.ref : (cur.ref as CharacterData).nextElementSibling) : null;
    let list: Element;
    if (prevEl && sameKind(prevEl, c.list)) { list = prevEl; cur = { parent: list, ref: null }; }
    else if (nextEl && sameKind(nextEl, c.list)) { list = nextEl; cur = { parent: list, ref: list.firstChild }; }
    else { list = bareListClone(c.list); editor.insertBefore(list, cur.ref); cur = { parent: list, ref: null }; }
    touched.add(list);
    for (const n of c.nodes) list.insertBefore(n, cur.ref);
    heads.push(c.nodes[0]);
  }
  return heads;
}
// Lists of the same kind that ended up side by side become one again.
function mergeTouched(touched: Set<Element>) {
  let n: Element | null = editor.firstElementChild;
  while (n) {
    const next = n.nextElementSibling;
    if (next && sameKind(n, next) && (touched.has(n) || touched.has(next))) {
      while (next.firstChild) n.appendChild(next.firstChild);
      next.remove();
      touched.add(n);
      continue;
    }
    n = next;
  }
}
function reveal(editing: boolean) {
  if (editing) keepCaretVisible();
  else if (blockSel) members(blockSel.focus)[0]?.scrollIntoView({ block: "nearest" });
}
function moveUnits(units: Element[], target: Element | undefined, side: "before" | "after", fromViewportTop: number | null = null) {
  const before = measureTops();
  const from = fromViewportTop === null ? null : fromViewportTop + canvas.scrollTop;
  recordBlockStep();
  const editing = document.activeElement === editor;
  const saved = editing ? saveSelection() : null;
  const touched = new Set<Element>();
  const carriers = detach(units, touched);
  insertCarriers(carriers, cursorFor(target, side), touched);
  mergeTouched(touched);
  if (saved) restoreSelection(saved);
  blockChanged();
  reveal(editing);
  settle(before, carriers.flatMap((c) => c.nodes), from);
}
function moveUnitsBy(units: Element[], dir: number) {
  const all = unitsOf();
  const i = all.indexOf(units[0]), j = all.indexOf(units[units.length - 1]);
  if (i < 0 || j < 0) return;
  const target = dir < 0 ? all[i - 1] : all[j + 1];
  if (!target) return nudge(units, dir);
  moveUnits(units, target, dir < 0 ? "before" : "after");
}
function cleanClone(n: Element) {
  const c = n.cloneNode(true) as Element;
  for (const x of [c, ...c.querySelectorAll("[data-block-id], [data-ph], .image-selected")]) {
    x.removeAttribute("data-block-id");
    x.removeAttribute("data-ph");
    x.classList.remove("image-selected");
    if (x.getAttribute("class") === "") x.removeAttribute("class");
  }
  return c;
}
function duplicateUnits(units: Element[]) {
  const before = measureTops();
  recordBlockStep();
  const saved = document.activeElement === editor ? saveSelection() : null;
  const carriers = units.map((u) => ({ nodes: members(u).map(cleanClone), list: u.parentElement !== editor ? u.parentElement : null }));
  const touched = new Set<Element>();
  const heads = insertCarriers(carriers, cursorFor(units[units.length - 1], "after"), touched);
  mergeTouched(touched);
  if (saved) restoreSelection(saved);
  blockChanged();
  settle(before);
  return heads;
}
function deleteUnits(units: Element[]) {
  const all = unitsOf();
  const i = all.indexOf(units[0]), j = all.indexOf(units[units.length - 1]);
  const above = all.slice(0, Math.max(0, i)).reverse().find(isTextual);
  const below = all.slice(j + 1).find(isTextual);
  const before = measureTops();
  recordBlockStep();
  const touched = new Set<Element>();
  detach(units, touched);
  mergeTouched(touched);
  if (!editor.firstElementChild) editor.appendChild(emptyParagraph());
  clearBlockSel();
  // The caret lands at the end of the block above (or the start of the one below).
  if (above?.isConnected) placeCaretAtEnd(members(above)[0]);
  else {
    const dest = below?.isConnected ? below : editor.firstElementChild;
    const [n, o] = startPoint(dest!);
    placeCaret(n, o);
  }
  blockChanged();
  settle(before);
  keepCaretVisible();
}
function turnUnitsInto(units: Element[], key: BlockKind) {
  if (!units.length || !units.every((u) => u.isConnected)) return;
  if (units.every((u) => unitKind(u) === key)) return; // already that; a list would toggle off
  if (units.some((u) => u.tagName === "TABLE")) return;
  clearBlockSel();
  const last = members(units[units.length - 1]);
  const [sn, so] = startPoint(units[0]);
  const [en, eo] = endPoint(last[last.length - 1]);
  const r = document.createRange();
  r.setStart(sn, so);
  r.setEnd(en, eo);
  setRange(r);
  setBlockType(key);
  // Converted blocks stay selected, as they were.
  const now = getRange();
  const after = now ? unitsInRange(now) : [];
  if (after.length) selectBlocks(after[0], after[after.length - 1]);
}

// ── Copy ─────────────────────────────────────────────────────────────────
// Copied blocks carry rich HTML, and Markdown as their plain text, so they
// paste sensibly into chat apps and code editors too.
function buildUnitsBox(units: Element[], limit = Infinity) {
  const box = el("div", { class: "editor" });
  let lastSrc: Element | null = null, current: Element | null = null;
  for (const u of units.slice(0, limit)) {
    const nodes = members(u).map(cleanClone);
    const src = u.parentElement !== editor ? u.parentElement : null;
    if (!src) { box.append(...nodes); lastSrc = null; continue; }
    if (src !== lastSrc) {
      current = bareListClone(src);
      // A numbered item keeps its own number.
      if (src.tagName === "OL") current.setAttribute("start", String(itemNumber(u)));
      box.append(current);
      lastSrc = src;
    }
    current!.append(...nodes);
  }
  return box;
}
function itemNumber(li: Element) {
  let n = parseInt(String(li.parentElement!.getAttribute("start")), 10) || 1;
  for (let p = li.previousElementSibling; p; p = p.previousElementSibling) if (p.tagName === "LI") n++;
  return n;
}
function unitPlain(u: Element) {
  // Units are HTML elements; innerText is what they show.
  const text = (n: Element) => ((n as HTMLElement).innerText ?? n.textContent).replace(/\u200B/g, "").replace(/\n+$/, "");
  if (u.parentElement !== editor) {
    const kind = listKind(u.parentElement);
    const mark = kind === "ol" ? itemNumber(u) + ". " : kind === "todo" ? (u.getAttribute("data-checked") === "true" ? "- [x] " : "- [ ] ") : "- ";
    return mark + members(u).map(text).join("\n").replace(/\n/g, "\n   ");
  }
  const t = text(u);
  switch (u.tagName) {
    case "H1": return "# " + t;
    case "H2": return "## " + t;
    case "H3": case "H4": case "H5": case "H6": return "### " + t;
    case "BLOCKQUOTE": return u.getAttribute("style") ? t : t.split("\n").map((l) => "> " + l).join("\n");
    case "PRE": {
      const code = u.textContent.replace(/\u200B/g, "").replace(/\n$/, ""), fence = codeFence(code);
      return fence + "\n" + code + "\n" + fence;
    }
    case "HR": return "---";
    case "TABLE": return tableToMarkdown(u as HTMLTableElement);
    default: return t;
  }
}
function unitsPlain(units: Element[]) {
  let out = "", prevList: Element | null = null;
  for (const u of units) {
    const list = u.parentElement !== editor ? u.parentElement : null;
    if (out) out += list && list === prevList ? "\n" : "\n\n";
    out += unitPlain(u);
    prevList = list;
  }
  return out;
}
let copyPayload: Element[] | null = null;
function flashSelection() {
  if (!reducedMotion.matches && selBox.classList.contains("show")) selBox.animate([{ opacity: 1 }, { opacity: 0.35 }, { opacity: 1 }], { duration: 320, easing: "ease-out" });
}
function copyUnits(units: Element[]) {
  copyPayload = units;
  try { document.execCommand("copy"); } catch {} finally { copyPayload = null; }
  flashSelection();
}
function writeUnitsTo(data: DataTransfer, units: Element[]) {
  data.setData("text/html", buildUnitsBox(units).innerHTML);
  data.setData("text/plain", unitsPlain(units));
}
document.addEventListener("copy", (e) => {
  const units = copyPayload || (blockSel && document.activeElement === sink ? selectedUnits() : null);
  if (!units?.length || !e.clipboardData) return;
  e.preventDefault();
  writeUnitsTo(e.clipboardData, units);
  if (!copyPayload) flashSelection();
});
document.addEventListener("cut", (e) => {
  if (!blockSel || document.activeElement !== sink || !e.clipboardData) return;
  const units = selectedUnits();
  if (!units.length) return;
  e.preventDefault();
  writeUnitsTo(e.clipboardData, units);
  deleteUnits(units);
});

// ── Block selection ──────────────────────────────────────────────────────
// Esc (or clicking a handle, or dragging in the margin) selects whole blocks.
function selectedUnits() {
  if (!blockSel) return [];
  const all = unitsOf();
  const a = all.indexOf(blockSel.anchor), f = all.indexOf(blockSel.focus);
  if (a < 0 || f < 0) { blockSel = null; selBox.classList.remove("show"); return []; }
  return all.slice(Math.min(a, f), Math.max(a, f) + 1);
}
function paintBlockSel() { placeBox(selBox, selectedUnits()); }
function selectBlocks(anchor: Element | null | undefined, focus = anchor) {
  if (!anchor?.isConnected || !focus?.isConnected) return clearBlockSel();
  blockSel = { anchor, focus };
  hintBox.classList.remove("show");
  if (document.activeElement !== sink) sink.focus({ preventScroll: true });
  const sel = window.getSelection()!;
  if (!sel.rangeCount || !sink.contains(sel.anchorNode)) { try { sel.selectAllChildren(sink); } catch {} }
  const n = selectedUnits().length;
  sink.setAttribute("aria-label", n === 1 ? "1 block selected" : `${n} blocks selected`);
  paintBlockSel();
  scheduleUi();
}
function clearBlockSel({ blur = false }: { blur?: boolean } = {}) {
  if (!blockSel) return;
  blockSel = null;
  selBox.classList.remove("show");
  if (blur && document.activeElement === sink) { sink.blur(); window.getSelection()?.removeAllRanges(); }
  scheduleUi();
}
editor.addEventListener("focus", () => { if (blockSel) clearBlockSel(); });
document.addEventListener("mousedown", (e) => {
  if (!blockSel) return;
  const t = e.target as Node | null;
  if (handles.contains(t) || openPop?.pop.contains(t)) return;
  clearBlockSel({ blur: !editor.contains(t) });
}, true);

sink.addEventListener("keydown", (e) => {
  if (!blockSel || openPop) return;
  const units = selectedUnits();
  if (!units.length) return;
  const mod = isMac ? e.metaKey : e.ctrlKey;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const vertical = k === "ArrowUp" || k === "ArrowDown";
  const dir = k === "ArrowUp" ? -1 : 1;
  const all = unitsOf();
  if (k === "Escape") { e.preventDefault(); clearBlockSel({ blur: true }); return; }
  if (k === "Enter" && !mod) {
    e.preventDefault();
    const f = blockSel.focus;
    if (!isTextual(f)) return;
    clearBlockSel();
    placeCaretAtEnd(members(f)[0]);
    keepCaretVisible();
    return;
  }
  if (vertical && e.shiftKey && (e.altKey || mod)) { e.preventDefault(); moveUnitsBy(units, dir); return; }
  if (vertical && !mod && !e.altKey) {
    e.preventDefault();
    if (e.shiftKey) selectBlocks(blockSel.anchor, all[clamp(all.indexOf(blockSel.focus) + dir, 0, all.length - 1)]);
    else selectBlocks(all[clamp(all.indexOf(dir < 0 ? units[0] : units[units.length - 1]) + dir, 0, all.length - 1)]);
    reveal(false);
    return;
  }
  if (k === "Backspace" || k === "Delete") { e.preventDefault(); deleteUnits(units); return; }
  if (mod && !e.shiftKey && !e.altKey && k === "d") {
    e.preventDefault();
    const heads = duplicateUnits(units);
    selectBlocks(heads[0], heads[heads.length - 1]);
    return;
  }
  if (mod && k === "a") { e.preventDefault(); selectBlocks(all[0], all[all.length - 1]); return; }
  if (mod && k === "z") { e.preventDefault(); if (e.shiftKey) redoAny(); else undoAny(); return; }
  if (mod && k === "y") { e.preventDefault(); redoAny(); return; }
  if (mod && e.code === "Slash") { e.preventDefault(); openShortcuts(); return; }
  if (k === "Tab") e.preventDefault();
});

// Editing keys that act on blocks.
editor.addEventListener("keydown", (e) => {
  if (!["Shift", "Meta", "Control", "Alt", "CapsLock"].includes(e.key)) hideForTyping();
  if (e.defaultPrevented || e.isComposing || composing || editor.contentEditable !== "true") return;
  const mod = isMac ? e.metaKey : e.ctrlKey;
  const range = getRange();
  if (!range) return;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (k === "Escape" && !openPop && !slash && !mod && !e.altKey && !e.shiftKey) {
    const units = unitsInRange(range);
    if (!units.length) return;
    e.preventDefault();
    selectBlocks(units[0], units[units.length - 1]);
    return;
  }
  if ((k === "ArrowUp" || k === "ArrowDown") && e.altKey && e.shiftKey && !mod) {
    e.preventDefault();
    const units = unitsInRange(range);
    if (units.length) moveUnitsBy(units, k === "ArrowUp" ? -1 : 1);
    return;
  }
  if (mod && !e.shiftKey && !e.altKey && k === "d") {
    e.preventDefault();
    duplicateAtCaret(range);
    return;
  }
  if (mod && !e.altKey && (k === "z" || k === "y")) {
    const redo = k === "y" || e.shiftKey;
    if ((redo ? blockHistory.redo : blockHistory.undo).length) { e.preventDefault(); stepBlockHistory(redo); }
  }
});
// ⌘D while typing: the caret moves to the same spot in the copy, so pressing
// it again keeps stamping out copies below.
function duplicateAtCaret(range: Range) {
  const units = unitsInRange(range);
  if (!units.length) return;
  const caretUnit = unitOf(range.startContainer);
  const offsets = range.collapsed && caretUnit ? textOffsetsWithin(caretUnit) : null;
  const idx = units.indexOf(caretUnit!);
  const heads = duplicateUnits(units);
  if (offsets && heads[idx]) restoreTextOffsets([heads[idx]], offsets);
  keepCaretVisible();
}

// ── Handles ──────────────────────────────────────────────────────────────
const handlesAllowed = () => ready && !isExport && !coarsePointer && editor.contentEditable === "true";
/** A press on the grip that may become a click or a drag. */
interface GripPress {
  x: number;
  y: number;
  unit: Element;
  shift: boolean;
  selected: boolean;
  caret: SavedSelection | null;
}
/** What `autoScroll` follows: the pointer's height, and when to stop. */
interface ScrollFollower {
  y: number;
  raf: number;
  done: boolean;
}
/** A block drag in progress. */
interface BlockDrag extends ScrollFollower {
  units: Element[];
  ghost: HTMLElement;
  dims: Animation[];
  grabY: number;
  x0: number;
  left: number;
  x: number;
  gap: number | null;
  keepSel: boolean;
  caret: SavedSelection | null;
}
/** A sweep-select from the margin in progress. */
interface MarginSweep extends ScrollFollower {
  y0: number;
  x: number;
  moved: boolean;
  inEditor: boolean;
}
let hoverUnit: Element | null = null, handlesHeld = false, typingHidden = false, hoverQueued = false;
let press: GripPress | null = null, drag: BlockDrag | null = null, sweep: MarginSweep | null = null;
const pointer = { x: -1, y: -1, inside: false };
function showHandles(u: Element) {
  const pr = page.getBoundingClientRect(), cb = contentBox();
  // Narrow windows: the "+" steps aside so the grip still fits in the margin.
  const clear = BOX_INSET + HANDLE_GAP;
  const room = cb.left - 6 - clear;
  const compact = room < 41;
  if (room < 18) return hideHandles(true);
  handles.classList.toggle("compact", compact);
  const x = cb.left - clear - (compact ? 18 : 41);
  // The grip's hover tint belongs to the unit the handles are on: it moves
  // with them, and goes once the pointer is no longer on the grip.
  if (u !== hoverUnit && hintBox.classList.contains("show")) {
    if (gripBtn.matches(":hover") && !selectedUnits().includes(u)) placeBox(hintBox, [u]);
    else hintBox.classList.remove("show");
  }
  hoverUnit = u;
  handles.style.transform = `translate(${Math.round(x - pr.left)}px, ${Math.round(firstLineMid(u) - pr.top - 12)}px)`;
  handles.classList.add("show");
}
function hideHandles(force = false) {
  if (handlesHeld && !force) return;
  handles.classList.remove("show");
  hintBox.classList.remove("show");
  if (tipOwner === plusBtn || tipOwner === gripBtn) hideTip();
  hoverUnit = null;
}
// Handles fade out as soon as you type and come back when the mouse moves.
function hideForTyping() {
  if (typingHidden) return;
  typingHidden = true;
  hideHandles();
  hideTableUi();
}
function unitAtY(y: number) {
  const all = unitsOf();
  if (!all.length) return null;
  let lo = 0, hi = all.length - 1, found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (unitBounds(all[mid]).top <= y) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  const r = unitBounds(all[found]);
  if (y < r.top) return y > r.top - 24 ? all[found] : null;
  const next = all[found + 1];
  if (next) return y > (r.bottom + unitBounds(next).top) / 2 ? next : all[found];
  return y > r.bottom + 24 ? null : all[found];
}
function updateHover() {
  if (!handlesAllowed() || handlesHeld || drag || sweep) return;
  if (typingHidden || !pointer.inside) return hideHandles();
  const cb = contentBox();
  const { x, y } = pointer;
  if (x < cb.left - 88 || x > cb.right + 32 || y < bar.getBoundingClientRect().bottom) return hideHandles();
  const u = unitAtY(y);
  if (!u) return hideHandles();
  showHandles(u);
}
function queueHover() {
  if (hoverQueued) return;
  hoverQueued = true;
  requestAnimationFrame(() => { hoverQueued = false; updateHover(); });
}
document.addEventListener("pointermove", (e) => {
  if (e.pointerType === "touch") return;
  if (e.clientX === pointer.x && e.clientY === pointer.y) return;
  pointer.x = e.clientX;
  pointer.y = e.clientY;
  pointer.inside = true;
  if (e.buttons && !press && !drag) { hideHandles(); return; } // selecting text
  typingHidden = false;
  // Over a menu, the toolbar or a dialog, nothing underneath is being pointed at.
  if (e.target instanceof Element && e.target.closest(".pop, .bar, .tip, .sheet-overlay")) { if (!handlesHeld) hideHandles(); return; }
  queueHover();
}, { passive: true });
document.documentElement.addEventListener("pointerleave", () => { pointer.inside = false; queueHover(); });
canvas.addEventListener("scroll", queueHover, { passive: true });
// Runs with every UI refresh: keeps highlights and handles on their blocks
// through edits, remote changes and resizes.
function refreshBlockUi() {
  refreshTableUi();
  if (blockSel) paintBlockSel();
  if (!hoverUnit) return;
  if (hoverUnit.isConnected && handles.classList.contains("show")) {
    showHandles(hoverUnit);
    if (hintBox.classList.contains("show")) {
      if (gripBtn.matches(":hover") && !selectedUnits().includes(hoverUnit)) placeBox(hintBox, [hoverUnit]);
      else hintBox.classList.remove("show");
    }
  } else hideHandles(true);
}

// Hovering the grip previews exactly what it will pick up (nested items too).
gripBtn.addEventListener("pointerenter", () => {
  if (hoverUnit && !drag && !selectedUnits().includes(hoverUnit)) placeBox(hintBox, [hoverUnit]);
});
gripBtn.addEventListener("pointerleave", () => hintBox.classList.remove("show"));

// "+": a new line below (⌥/Alt: above) with the block menu open on it. On an
// empty line it just opens the menu right there.
plusBtn.addEventListener("click", (e) => { if (hoverUnit) addBlockNear(hoverUnit, e.altKey); });
function addBlockNear(u: Element, above: boolean) {
  if (!u.isConnected) return;
  closePop(true);
  clearBlockSel();
  const reusable = !above && /^(P|DIV|LI)$/.test(u.tagName) && !hasContent(u) && !u.querySelector("ul, ol, img, hr");
  let line: Element = u;
  if (!reusable) {
    line = u.parentElement !== editor ? el("li", {}, [document.createElement("br")]) : emptyParagraph();
    if (above) u.before(line);
    else members(u)[members(u).length - 1].after(line);
  }
  placeCaret(line, 0);
  applyingRule = true;
  try { exec("insertText", "/"); } finally { applyingRule = false; }
  const r = getRange();
  if (r && isText(r.startContainer) && r.startContainer.data[r.startOffset - 1] === "/") {
    openSlash(r.startContainer, r.startOffset - 1);
    if (slash) { slash.fromPlus = closestEl(r.startContainer, "li, p, div") || line; slash.reused = reusable; }
  }
  keepCaretVisible();
}

// Grip: click for the block menu, drag to move.
gripBtn.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || !hoverUnit || e.pointerType === "touch") return;
  e.preventDefault();
  hideTip();
  press = {
    x: e.clientX, y: e.clientY, unit: hoverUnit, shift: e.shiftKey,
    // Whether the drag starts from an existing block selection, and where
    // the caret was, so a plain drag can hand both back when it ends.
    selected: selectedUnits().includes(hoverUnit),
    caret: document.activeElement === editor ? saveSelection() : null
  };
  window.addEventListener("pointermove", onPressMove);
  window.addEventListener("pointerup", onPressUp);
  window.addEventListener("pointercancel", onPressCancel);
});
function endPress() {
  press = null;
  window.removeEventListener("pointermove", onPressMove);
  window.removeEventListener("pointerup", onPressUp);
  window.removeEventListener("pointercancel", onPressCancel);
}
function onPressMove(e: PointerEvent) {
  if (drag) { dragMove(e); return; }
  if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 4) startDrag(e);
}
function onPressUp() {
  const p = press;
  endPress();
  if (drag) finishDrag(true);
  else if (p) gripClick(p);
}
function onPressCancel() {
  endPress();
  if (drag) finishDrag(false);
}
function gripClick(p: GripPress) {
  const u = p.unit;
  if (!u.isConnected) return;
  if (openPop?.owner === gripBtn) { closePop(); return; }
  if (p.shift && blockSel) selectBlocks(blockSel.anchor, u);
  else if (!blockSel || !selectedUnits().includes(u)) selectBlocks(u);
  openBlockMenu();
}
function openBlockMenu() {
  const units = selectedUnits();
  if (!units.length) return;
  const many = units.length > 1;
  const content: ElChild[] = [];
  const table = units.length === 1 && units[0].tagName === "TABLE" ? units[0] as HTMLTableElement : null;
  if (table) {
    content.push(
      menuItem({ icon: "tableHeader", label: "Header row", checked: hasHeader(table), checkSlot: true, onSelect: () => { const t = tableOp(table, toggleHeader); if (t) selectBlocks(t); } }),
      table.querySelector(":scope > colgroup") ? menuItem({ icon: "table", label: "Even column widths", onSelect: () => { const t = tableOp(table, (t) => { setColWidths(t, null); }); if (t) selectBlocks(t); } }) : null,
      el("div", { class: "msep" })
    );
  } else if (units.every((u) => isTextual(u) && u.tagName !== "TABLE")) {
    const kinds = new Set(units.map(unitKind));
    const kind = kinds.size === 1 ? [...kinds][0] : null;
    content.push(
      el("div", { class: "mhead" }, many ? `Turn ${units.length} blocks into` : "Turn into"),
      el("div", { class: "bt-grid" }, BLOCK_TYPES.map((t) => {
        const b = el("button", { type: "button", class: "bt" + (t.key === kind ? " on" : ""), "aria-pressed": String(t.key === kind), html: svg(ICONS[t.icon], 17) });
        attachTip(b, t.label, t.keys);
        b.addEventListener("click", () => { hideTip(); closePop(); turnUnitsInto(units, t.key); });
        return b;
      })),
      el("div", { class: "msep" })
    );
  }
  const del = menuItem({ icon: "trash", label: many ? `Delete ${units.length} blocks` : "Delete", keys: combo(isMac ? "⌫" : "Del"), onSelect: () => deleteUnits(units) });
  del.classList.add("danger");
  content.push(
    menuItem({ icon: "duplicate", label: "Duplicate", keys: combo("mod", "D"), onSelect: () => { const heads = duplicateUnits(units); selectBlocks(heads[0], heads[heads.length - 1]); } }),
    menuItem({ icon: "arrowUp", label: "Move up", keys: combo("alt", "shift", "↑"), onSelect: () => moveUnitsBy(units, -1) }),
    menuItem({ icon: "arrowDown", label: "Move down", keys: combo("alt", "shift", "↓"), onSelect: () => moveUnitsBy(units, 1) }),
    menuItem({ icon: "clipboard", label: "Copy", keys: combo("mod", "C"), onSelect: () => copyUnits(units) }),
    el("div", { class: "msep" }),
    del
  );
  showPop(content, gripBtn.getBoundingClientRect(), { owner: gripBtn, className: "block-actions", onClose: () => { handlesHeld = false; queueHover(); } });
  handlesHeld = true;
}

// ── Dragging ─────────────────────────────────────────────────────────────
// Only called during a press.
function startDrag(e: PointerEvent) {
  const u = press!.unit;
  if (!u.isConnected) { endPress(); return; }
  let units = selectedUnits();
  if (!units.includes(u)) { selectBlocks(u); units = [u]; }
  closePop(true);
  hideTip();
  const first = members(units[0])[0].getBoundingClientRect();
  const cb = contentBox();
  // The ghost lifts off from exactly where the block sits.
  const ghost = el("div", { class: "blk-ghost", "aria-hidden": "true" }, [buildUnitsBox(units, 8)]);
  if (units.length > 1) ghost.append(el("span", { class: "blk-count" }, String(units.length)));
  ghost.style.width = Math.round(cb.right - cb.left + 24) + "px";
  page.appendChild(ghost);
  if (ghost.scrollHeight > ghost.clientHeight + 1) ghost.classList.add("tall");
  const dims = units.flatMap(members).map((n) => n.animate([{ opacity: 1 }, { opacity: 0.28 }], { duration: reducedMotion.matches ? 0 : 160, easing: "ease-out", fill: "forwards" }));
  drag = { units, ghost, dims, grabY: press!.y - first.top, x0: press!.x, left: cb.left - 12, x: e.clientX, y: e.clientY, gap: null, raf: 0, done: false, keepSel: press!.selected, caret: press!.caret };
  document.body.classList.add("blk-dragging");
  hideHandles(true);
  selBox.classList.remove("show");
  window.addEventListener("keydown", onDragKey, true);
  dragMove(e);
  autoScroll(drag, updateDropGap);
}
// Only called during a drag.
function dragMove(e: PointerEvent) {
  drag!.x = e.clientX;
  drag!.y = e.clientY;
  // On rails: it follows you vertically, with only a little sideways give.
  const give = (drag!.x - drag!.x0) * 0.1;
  drag!.ghost.style.transform = `translate(${Math.round(drag!.left + give)}px, ${Math.round(drag!.y - drag!.grabY - 8)}px)`;
  updateDropGap();
}
function updateDropGap() {
  const d = drag;
  if (!d) return;
  const all = unitsOf();
  const i0 = all.indexOf(d.units[0]), i1 = all.indexOf(d.units[d.units.length - 1]);
  if (i0 < 0 || i1 < 0) { finishDrag(false); return; }
  let best = 0, bestY = 0, bestDist = Infinity, prevBottom: number | null = null;
  for (let i = 0; i <= all.length; i++) {
    const next = all[i] ? unitBounds(all[i]) : null;
    const gy = prevBottom === null ? next!.top - 3 : next === null ? prevBottom + 3 : (prevBottom + next.top) / 2;
    const dist = Math.abs(gy - d.y);
    if (dist < bestDist) { bestDist = dist; best = i; bestY = gy; }
    if (!next || next.top > d.y + 600) break;
    prevBottom = next.bottom;
  }
  // Gaps right next to the dragged blocks would change nothing: no line there.
  if (best >= i0 && best <= i1 + 1) { d.gap = null; dropLine.classList.remove("show"); return; }
  d.gap = best;
  const pr = page.getBoundingClientRect(), cb = contentBox();
  // A line that starts at the list's text says "this joins the list".
  let left = cb.left;
  const src = d.units[0].parentElement !== editor ? d.units[0].parentElement : null;
  if (src) {
    const joins = [all[best - 1], all[best]].find((n) => n && n.parentElement !== editor && sameKind(n.parentElement, src));
    // (To-dos have no indent of their own: line up with the checkbox's inset.)
    if (joins) left = joins.getBoundingClientRect().left + (listKind(joins.parentElement) === "todo" ? (parseFloat(getComputedStyle(joins).fontSize) || 16) * 0.1 + 10 : 0);
  }
  const appearing = !dropLine.classList.contains("show");
  if (appearing) dropLine.style.transition = "none";
  dropLine.style.width = Math.round(cb.right - left) + "px";
  dropLine.style.transform = `translate(${Math.round(left - pr.left)}px, ${Math.round(bestY - pr.top - 1)}px)`;
  if (appearing) { void dropLine.offsetWidth; dropLine.style.transition = ""; }
  dropLine.classList.add("show");
}
function finishDrag(commit: boolean) {
  const d = drag;
  if (!d) return;
  drag = null;
  d.done = true;
  cancelAnimationFrame(d.raf);
  window.removeEventListener("keydown", onDragKey, true);
  document.body.classList.remove("blk-dragging");
  dropLine.classList.remove("show");
  for (const a of d.dims) a.cancel();
  const alive = d.units.every((u) => u.isConnected);
  if (commit && alive && d.gap !== null) {
    const all = unitsOf();
    const ghostTop = d.ghost.getBoundingClientRect().top + 8;
    d.ghost.remove();
    // The blocks settle from where you let go.
    moveUnits(d.units, d.gap > 0 ? all[d.gap - 1] : all[0], d.gap > 0 ? "after" : "before", ghostTop);
  } else if (alive && !reducedMotion.matches) {
    // Nothing changed: the ghost glides back home and fades.
    const r = members(d.units[0])[0].getBoundingClientRect();
    const anim = d.ghost.animate([
      { transform: d.ghost.style.transform, opacity: 0.96 },
      { transform: `translate(${Math.round(d.left)}px, ${Math.round(r.top - 8)}px)`, opacity: 0 }
    ], { duration: 180, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" });
    anim.onfinish = () => d.ghost.remove();
  } else d.ghost.remove();
  // Blocks that were selected before the drag stay selected. A block that was
  // simply grabbed by its grip isn't left highlighted once it lands: the
  // selection was only for the drag. The caret goes back where it was.
  if (alive && d.keepSel) selectBlocks(d.units[0], d.units[d.units.length - 1]);
  else {
    clearBlockSel({ blur: true });
    if (d.caret) { editor.focus({ preventScroll: true }); restoreSelection(d.caret); }
  }
  hintBox.classList.remove("show");
  queueHover();
}
function onDragKey(e: KeyboardEvent) {
  if (e.key !== "Escape") return;
  e.preventDefault();
  e.stopPropagation();
  endPress();
  finishDrag(false);
}
// Near the top or bottom edge the page scrolls, faster the closer you get.
function autoScroll(state: ScrollFollower, onScroll: () => void) {
  const tick = () => {
    if (state.done) return;
    const top = bar.getBoundingClientRect().bottom, bottom = innerHeight, zone = 64;
    let v = 0;
    if (state.y < top + zone) v = -(((top + zone - state.y) / zone) ** 2) * 22;
    else if (state.y > bottom - zone) v = (((state.y - bottom + zone) / zone) ** 2) * 22;
    v = clamp(v, -32, 32);
    if (Math.abs(v) >= 0.5) {
      const prev = canvas.scrollTop;
      canvas.scrollTop += v;
      if (canvas.scrollTop !== prev) onScroll();
    }
    state.raf = requestAnimationFrame(tick);
  };
  state.raf = requestAnimationFrame(tick);
}

// ── Sweep-select from the margin ─────────────────────────────────────────
// Press in the empty margin beside the text and drag up or down to select
// whole blocks. A plain click there still puts the caret on that line.
canvas.addEventListener("mousedown", (e) => {
  if (e.button !== 0 || !handlesAllowed() || drag) return;
  const t = e.target;
  if (t !== canvas && t !== page && t !== editor) return;
  const cr = canvas.getBoundingClientRect();
  if (e.clientX >= cr.left + canvas.clientWidth) return; // the scrollbar
  const cb = contentBox();
  if (t === editor && e.clientX >= cb.left && e.clientX <= cb.right) return;
  const all = unitsOf();
  if (!all.length) return;
  if (e.clientY < unitBounds(all[0]).top - 12 || e.clientY > unitBounds(all[all.length - 1]).bottom + 12) return;
  e.preventDefault();
  sweep = { y0: e.clientY + canvas.scrollTop, x: e.clientX, y: e.clientY, moved: false, inEditor: t === editor, raf: 0, done: false };
  window.addEventListener("mousemove", onSweepMove);
  window.addEventListener("mouseup", onSweepUp);
}, true);
function onSweepMove(e: MouseEvent) {

  const s = sweep;
  if (!s) return;
  s.x = e.clientX;
  s.y = e.clientY;
  if (!s.moved) {
    if (Math.abs(e.clientY + canvas.scrollTop - s.y0) < 6) return;
    s.moved = true;
    document.body.classList.add("blk-sweeping");
    hideHandles(true);
    autoScroll(s, updateSweep);
  }
  updateSweep();
}
function updateSweep() {
  const s = sweep;
  if (!s) return;
  const y0 = s.y0 - canvas.scrollTop;
  const lo = Math.min(y0, s.y), hi = Math.max(y0, s.y);
  const all = unitsOf();
  let a = -1, b = -1;
  for (let i = 0; i < all.length; i++) {
    const r = unitBounds(all[i]);
    if (r.top > hi) break;
    if (r.bottom >= lo) { if (a < 0) a = i; b = i; }
  }
  if (a < 0) { clearBlockSel(); return; }
  if (s.y >= y0) selectBlocks(all[a], all[b]);
  else selectBlocks(all[b], all[a]);
}
function onSweepUp(e: MouseEvent) {
  const s = sweep;
  sweep = null;
  window.removeEventListener("mousemove", onSweepMove);
  window.removeEventListener("mouseup", onSweepUp);
  if (!s) return;
  s.done = true;
  cancelAnimationFrame(s.raf);
  document.body.classList.remove("blk-sweeping");
  if (!s.moved && s.inEditor) {
    const cb = contentBox();
    setCaretFromPoint(clamp(e.clientX, cb.left + 1, cb.right - 1), e.clientY);
  }
  queueHover();
}

/* ═════════════════════════════ 8¾. Tables ═══════════════════════════════ */

// A table is one top-level block: <table>[<colgroup>][<thead>]<tbody>, with
// no spans, and cells that hold text (inline formatting, <br> lines) rather
// than blocks. Structural edits swap in an edited copy of the table, so block
// undo -- which restores nodes -- puts the original back exactly. All chrome
// (focus ring, row/column pills, add bars, resize line) lives outside the
// editor, so none of it can reach saved HTML.

document.head.appendChild(el("style", { text: `
:root { --table-head: rgba(24,24,32,.034); }
@media screen and (prefers-color-scheme: dark) { :root:not(.document-export) { --table-head: rgba(255,255,255,.045); } }
.editor table {
  width: 100%; table-layout: fixed; border-collapse: separate; border-spacing: 0;
  margin: .5em 0 1.1em; border: 1px solid var(--line-strong); border-radius: 8px;
  font-size: .9375em; line-height: 1.5; font-variant-numeric: tabular-nums;
}
.editor th, .editor td {
  padding: .42em .72em; vertical-align: top; text-align: left; overflow-wrap: anywhere;
  border: 0 solid var(--line); border-width: 0 1px 1px 0;
}
.editor tr > :last-child { border-right-width: 0; }
.editor tbody > tr:last-child > * { border-bottom-width: 0; }
.editor th { font-weight: 600; color: var(--text); }
.editor thead th { background: var(--table-head); }
.editor thead > tr:first-child > :first-child { border-top-left-radius: 7px; }
.editor thead > tr:first-child > :last-child { border-top-right-radius: 7px; }
.editor td > :last-child, .editor th > :last-child { margin-bottom: 0; }
.editor.tbl-edge td, .editor.tbl-edge th { cursor: col-resize; }

.tbl-focus { position: absolute; left: 0; top: 0; z-index: 2; pointer-events: none; opacity: 0; border-radius: 2px; box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--accent) 78%, transparent); transition: opacity .12s var(--ease), transform .1s var(--ease), width .1s var(--ease), height .1s var(--ease); }
.tbl-focus.show { opacity: 1; }
.tbl-focus.jump { transition: opacity .12s var(--ease); }
.tbl-ui { position: absolute; left: 0; top: 0; z-index: 4; opacity: 0; pointer-events: none; transition: opacity .14s var(--ease); }
.tbl-ui.show { opacity: 1; pointer-events: auto; }
.tbl-pill {
  padding: 0; border: 0; border-radius: 5px; overflow: hidden;
  display: flex; align-items: center; justify-content: center;
  background: var(--raised); color: var(--faint); cursor: pointer;
  box-shadow: 0 0 0 1px var(--line-strong), 0 1px 3px rgba(0,0,0,.06);
  transition: opacity .14s var(--ease), color .12s var(--ease), box-shadow .12s var(--ease);
}
.tbl-pill svg { display: block; flex: 0 0 auto; }
.tbl-pill:hover, .tbl-pill.open { color: var(--accent); box-shadow: 0 0 0 1px var(--accent), 0 1px 3px rgba(0,0,0,.06); }
.tbl-col { width: 24px; height: 12px; }
.tbl-row { width: 12px; height: 24px; }
.tbl-add {
  padding: 0; border: 0; border-radius: 6px; display: flex; align-items: center; justify-content: center;
  background: transparent; color: var(--faint); cursor: pointer;
  transition: opacity .14s var(--ease), background-color .12s var(--ease), color .12s var(--ease);
}
.tbl-add svg { display: block; }
.tbl-add:hover { background: var(--hover); color: var(--muted); }
.tbl-add-row { height: 18px; }
.tbl-add-col { width: 18px; }
.tbl-resize { width: 2px; border-radius: 1px; background: var(--accent); pointer-events: none !important; }
.tbl-tint { border-radius: 3px !important; }
body.tbl-resizing, body.tbl-resizing * { cursor: col-resize !important; -webkit-user-select: none; user-select: none; }
.pop.tbl-picker { min-width: 0; padding: 4px 10px 9px; }
.tp-grid { display: grid; grid-template-columns: repeat(8, 16px); gap: 3px; }
.tp-cell { width: 16px; height: 16px; border-radius: 3.5px; box-shadow: inset 0 0 0 1px var(--line-strong); cursor: pointer; transition: background-color .06s, box-shadow .06s; }
.tp-cell.on { background: var(--accent-soft); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 70%, transparent); }
.tp-label { margin-top: 8px; font: 12px/1 var(--font-ui); color: var(--muted); text-align: center; font-variant-numeric: tabular-nums; }
.tbl-picker .mhead { padding-left: 0; padding-right: 0; }
html.document-export .editor tr { break-inside: avoid; }
@media print {
  .tbl-focus, .tbl-ui, .tbl-tint { display: none !important; }
  .editor tr { break-inside: avoid; }
  /* The header row prints once, at the top of the table; it isn't repeated
     on later pages when a table splits. */
  .editor > table > thead { display: table-row-group; }
}
` }));

// ── Model helpers ────────────────────────────────────────────────────────
// The cell holding `node`, if it belongs to a top-level table.
function cellOf(node: Node | null | undefined) {
  const cell = node ? closestEl(node, "td, th") as HTMLTableCellElement | null : null;
  return cell && cell.closest("table")?.parentElement === editor ? cell : null;
}
const colCount = (t: HTMLTableElement) => Math.max(1, ...Array.from(t.rows, (r) => r.cells.length));
const hasHeader = (t: HTMLTableElement) => !!t.tHead && t.tHead.rows.length > 0;
const bodyOf = (t: HTMLTableElement) => t.tBodies[0] || t.appendChild(document.createElement("tbody"));
const newCell = (tag: "td" | "th" = "td") => el(tag, {}, [document.createElement("br")]);
const newRow = (n: number, tag: "td" | "th" = "td") => el("tr", {}, Array.from({ length: n }, () => newCell(tag)));
const isEmptyCell = (c: Element) => !c.textContent.replace(/[\u200B\s\u00a0]/g, "") && !c.querySelector("img");
function buildTable(rows: number, cols: number, header = true) {
  const t = document.createElement("table");
  if (header) t.appendChild(el("thead", {}, [newRow(cols, "th")]));
  t.appendChild(el("tbody", {}, Array.from({ length: Math.max(1, rows - (header ? 1 : 0)) }, () => newRow(cols))));
  return t;
}
function retagCells(row: HTMLTableRowElement, tag: "td" | "th") {
  for (const cell of Array.from(row.cells)) {
    if (cell.tagName.toLowerCase() === tag) continue;
    const n = document.createElement(tag);
    for (const a of Array.from(cell.attributes)) n.setAttribute(a.name, a.value);
    while (cell.firstChild) n.appendChild(cell.firstChild);
    cell.replaceWith(n);
  }
}
// Column widths live in a <colgroup> as percentages, only once someone has
// resized a column; until then columns share the width evenly.
function colWidths(t: HTMLTableElement) {
  const cg = t.querySelector(":scope > colgroup");
  return cg ? Array.from(cg.children, (c) => parseFloat((c as HTMLTableColElement).style.width) || 0) : null;
}
function setColWidths(t: HTMLTableElement, widths: number[] | null) {
  let cg = t.querySelector(":scope > colgroup");
  if (!widths || !widths.length || widths.length !== colCount(t)) { cg?.remove(); return; }
  if (!cg) { cg = document.createElement("colgroup"); t.prepend(cg); }
  const sum = widths.reduce((a, b) => a + b, 0) || 1;
  cg.replaceChildren(...widths.map((w) => { const col = document.createElement("col"); col.style.width = Math.round(w / sum * 1000) / 10 + "%"; return col; }));
}

// ── Structural operations (on the copy tableOp hands them) ──────────────
// Each returns where the caret goes ({ caret, start }), what fades in
// ({ fresh }) or flashes ({ flash }), or { replace } to swap the whole table.
interface TableOpResult {
  caret?: HTMLElement;
  start?: boolean;
  fresh?: Element[];
  flash?: Element[];
  replace?: HTMLElement;
}
function insertRowAt(t: HTMLTableElement, at: number, col = 0): TableOpResult {
  const n = colCount(t), row = newRow(n), ref = t.rows[at];
  if (ref && ref.parentElement!.tagName === "TBODY") ref.before(row);
  else if (ref) bodyOf(t).prepend(row);
  else bodyOf(t).appendChild(row);
  return { caret: row.cells[Math.min(col, n - 1)], start: true, fresh: [row] };
}
function deleteRowAt(t: HTMLTableElement, r: number, col = 0): TableOpResult {
  const row = t.rows[r];
  // A row's parent is its section.
  const section = row.parentElement as HTMLTableSectionElement;
  row.remove();
  if (section.tagName === "THEAD" && !section.rows.length) section.remove();
  if (!t.rows.length) return { replace: emptyParagraph() };
  // Only the header left: it becomes an ordinary row.
  if (!bodyOf(t).rows.length && t.tHead) {
    const rows = Array.from(t.tHead.rows);
    bodyOf(t).append(...rows);
    rows.forEach((x) => retagCells(x, "td"));
    t.tHead.remove();
  }
  const next = t.rows[Math.min(r, t.rows.length - 1)];
  return { caret: next.cells[Math.min(col, next.cells.length - 1)] };
}
function insertColumnAt(t: HTMLTableElement, at: number, row = 0): TableOpResult {
  const widths = colWidths(t);
  const fresh: HTMLTableCellElement[] = [];
  for (const tr of t.rows) {
    const cell = newCell(tr.parentElement!.tagName === "THEAD" ? "th" : "td");
    tr.insertBefore(cell, tr.cells[at] || null);
    fresh.push(cell);
  }
  if (widths) { widths.splice(at, 0, widths.reduce((a, b) => a + b, 0) / widths.length); setColWidths(t, widths); }
  return { caret: fresh[Math.min(row, fresh.length - 1)], start: true, fresh };
}
function deleteColumnAt(t: HTMLTableElement, c: number, row = 0): TableOpResult {
  if (colCount(t) <= 1) return { replace: emptyParagraph() };
  const widths = colWidths(t);
  for (const tr of t.rows) tr.cells[c]?.remove();
  if (widths) { widths.splice(c, 1); setColWidths(t, widths); }
  const tr = t.rows[Math.min(row, t.rows.length - 1)];
  return { caret: tr.cells[Math.min(c, tr.cells.length - 1)] };
}
function toggleHeader(t: HTMLTableElement) {
  if (hasHeader(t)) {
    const rows = Array.from(t.tHead!.rows);
    bodyOf(t).prepend(...rows);
    rows.forEach((r) => retagCells(r, "td"));
    t.tHead!.remove();
  } else {
    const first = bodyOf(t).rows[0];
    if (!first) return;
    t.createTHead().appendChild(first);
    retagCells(first, "th");
    if (!bodyOf(t).rows.length) bodyOf(t).appendChild(newRow(colCount(t)));
  }
}

// ── Applying operations ──────────────────────────────────────────────────
/** Where the caret is in a table: its cell, and its offsets in the cell's text. */
interface TableSpot {
  r: number;
  c: number;
  offsets: TextOffsets | null;
}
function caretSpot(table: HTMLTableElement): TableSpot | null {
  const range = document.activeElement === editor ? getRange() : null;
  const cell = range && cellOf(range.startContainer);
  if (!cell || cell.closest("table") !== table) return null;
  return { r: (cell.parentElement as HTMLTableRowElement).rowIndex, c: cell.cellIndex, offsets: textOffsetsWithin(cell) };
}
function restoreSpot(t: HTMLTableElement, spot: TableSpot) {
  const row = t.rows[Math.min(spot.r, t.rows.length - 1)];
  const cell = row?.cells[Math.min(spot.c, row.cells.length - 1)];
  if (!cell) return;
  placeCaretAtEnd(cell);
  if (spot.offsets) restoreTextOffsets([cell], spot.offsets);
}
function tableOp(table: HTMLTableElement | null | undefined, fn: (t: HTMLTableElement) => TableOpResult | void): HTMLTableElement | null {
  if (!table?.isConnected) return null;
  const spot = caretSpot(table);
  recordBlockStep();
  const copy = table.cloneNode(true) as HTMLTableElement;
  const out: TableOpResult = fn(copy) || {};
  const result = out.replace || copy;
  if (out.replace && blockId(table)) out.replace.setAttribute("data-block-id", blockId(table)!);
  table.replaceWith(result);
  if (out.replace) { const [n, o] = startPoint(result); placeCaret(n, o); }
  else if (out.caret?.isConnected) {
    if (out.start) { const [n, o] = startPoint(out.caret); placeCaret(n, o); } else placeCaretAtEnd(out.caret);
  } else if (spot) restoreSpot(copy, spot);
  blockChanged();
  if (!reducedMotion.matches) {
    for (const n of out.fresh || []) n.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: "ease-out" });
    const tint = getComputedStyle(page).getPropertyValue("--accent-soft").trim();
    for (const n of out.flash || []) n.animate([{ backgroundColor: tint, offset: 0 }], { duration: 900, easing: "ease-out" });
  }
  if (tblHover?.table === table) { if (out.replace) hideTableUi(true); else tblHover.table = copy; }
  if (!out.replace) keepCaretVisible();
  scheduleUi();
  return out.replace ? null : copy;
}

// ── Inserting ────────────────────────────────────────────────────────────
function insertTable(rows = 3, cols = 3) {
  ensureSelection();
  const range = getRange();
  const top = range ? topBlockOf(range.startContainer) : null;
  const before = measureTops();
  recordBlockStep();
  const t = buildTable(rows, cols, true);
  // An empty line becomes the table; otherwise it goes below the current block.
  if (top && /^(P|DIV)$/.test(top.tagName) && isEmptyLine(top)) {
    t.setAttribute("data-block-id", blockId(top) || newBlockId());
    top.replaceWith(t);
  } else if (top) top.after(t);
  else editor.appendChild(t);
  // Always somewhere to keep writing below.
  if (!t.nextElementSibling) t.after(emptyParagraph());
  const [n, o] = startPoint(t.rows[0].cells[0]);
  placeCaret(n, o);
  blockChanged();
  settle(before);
  keepCaretVisible();
}
// "| Name | Role |" + Enter on a line of its own: that row becomes the header
// of a new table, with the caret in the first cell below it.
function pipeRowToTable(range: Range) {
  if (!range.collapsed) return false;
  const top = topBlockOf(range.startContainer);
  if (!top || top.tagName !== "P" || cellOf(range.startContainer)) return false;
  const text = top.textContent.replace(/\u200B/g, "");
  if (!/^\s*\|.*\|\s*$/.test(text)) return false;
  const rest = document.createRange();
  rest.selectNodeContents(top);
  rest.setStart(range.startContainer, range.startOffset);
  if (rest.toString().replace(/\u200B/g, "").trim()) return false;
  const cells = pipeCells(text);
  if (cells.length < 2 || cells.length > 24) return false;
  const before = measureTops();
  recordBlockStep();
  const t = buildTable(2, cells.length, true);
  cells.forEach((c, i) => { if (c) t.rows[0].cells[i].innerHTML = inlineMarkdown(c); });
  t.setAttribute("data-block-id", blockId(top) || newBlockId());
  top.replaceWith(t);
  if (!t.nextElementSibling) t.after(emptyParagraph());
  const [n, o] = startPoint(t.rows[1].cells[0]);
  placeCaret(n, o);
  blockChanged();
  settle(before);
  return true;
}
// The toolbar's size picker: sweep across the grid, click to insert.
function tablePicker(owner: HTMLElement) {
  const R = 8, C = 8;
  let rows = 3, cols = 3;
  const label = el("div", { class: "tp-label" });
  const cells: HTMLElement[] = [];
  const paint = (r: number, c: number) => {
    rows = r; cols = c;
    cells.forEach((d, i) => d.classList.toggle("on", Math.floor(i / C) < r && i % C < c));
    label.textContent = `${c} × ${r}`;
  };
  const grid = el("div", { class: "tp-grid" });
  for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) {
    const d = el("div", { class: "tp-cell" });
    d.addEventListener("pointerenter", () => paint(r + 1, c + 1));
    d.addEventListener("click", () => { closePop(); insertTable(rows, cols); });
    cells.push(d);
    grid.appendChild(d);
  }
  paint(3, 3);
  showPop([el("div", { class: "mhead" }, "Insert table"), grid, label], owner.getBoundingClientRect(), { owner, className: "tbl-picker", align: "center" });
}

// ── Keys inside a table ──────────────────────────────────────────────────
function handleTableKey(e: KeyboardEvent) {
  if (e.key !== "Tab" && e.key !== "Enter" && e.key !== "Backspace" && e.key !== "Delete" && e.key !== "ArrowUp" && e.key !== "ArrowDown") return false;
  const range = getRange();
  if (!range) return false;
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (mod || e.altKey) return false;
  const cell = cellOf(range.startContainer);
  if (!cell) return besideTable(e, range);
  const table = cell.closest("table")!;
  const endCell = cellOf(range.endContainer);
  // A selection across cells: Backspace/Delete empties them, keeping the grid.
  if (endCell !== cell) {
    if ((e.key === "Backspace" || e.key === "Delete") && endCell?.closest("table") === table) {
      e.preventDefault();
      const all = Array.from(table.rows).flatMap((r) => Array.from(r.cells));
      const i = all.indexOf(cell), j = all.indexOf(endCell);
      tableOp(table, (t) => {
        const cs = Array.from(t.rows).flatMap((r) => Array.from(r.cells)).slice(Math.min(i, j), Math.max(i, j) + 1);
        cs.forEach((c) => c.replaceChildren(document.createElement("br")));
        return { caret: cs[0], start: true };
      });
      return true;
    }
    return false;
  }
  const row = cell.parentElement as HTMLTableRowElement, r = row.rowIndex, c = cell.cellIndex;
  if (e.key === "Tab") {
    e.preventDefault();
    const all = Array.from(table.rows).flatMap((x) => Array.from(x.cells));
    const next = all[all.indexOf(cell) + (e.shiftKey ? -1 : 1)];
    if (next) placeCaretAtEnd(next);
    else if (!e.shiftKey) tableOp(table, (t) => insertRowAt(t, t.rows.length, 0)); // Tab in the last cell adds a row
    keepCaretVisible();
    return true;
  }
  if (e.key === "Enter") {
    if (e.shiftKey) return false; // a line break inside the cell
    e.preventDefault();
    const below = table.rows[r + 1];
    if (below) { placeCaretAtEnd(below.cells[Math.min(c, below.cells.length - 1)]); keepCaretVisible(); return true; }
    // Enter on an empty last row leaves the table, as an empty list item leaves a list.
    if (row.parentElement!.tagName === "TBODY" && Array.from(row.cells).every(isEmptyCell)) {
      const next = table.nextElementSibling;
      const reuse = next && next.tagName === "P" && isEmptyLine(next) ? next : null;
      // The empty row goes, unless it is the table's only one.
      const t = bodyOf(table).rows.length > 1 ? tableOp(table, (t) => { t.rows[r].remove(); return {}; }) : table;
      if (!t) return true;
      let p = reuse;
      if (!p) { if (t === table) recordBlockStep(); p = emptyParagraph(); t.after(p); }
      placeCaret(p, 0);
      blockChanged();
      return true;
    }
    tableOp(table, (t) => insertRowAt(t, t.rows.length, c));
    return true;
  }
  if (e.key === "Backspace" && range.collapsed && atBlockStart(cell, range)) {
    e.preventDefault(); // never merge cells
    // In the first cell of a table with nothing in it, Backspace removes the table.
    if (r === 0 && c === 0 && Array.from(table.rows).every((x) => Array.from(x.cells).every(isEmptyCell))) tableOp(table, () => ({ replace: emptyParagraph() }));
    return true;
  }
  if (e.key === "Delete" && range.collapsed) {
    const rest = document.createRange();
    rest.selectNodeContents(cell);
    rest.setStart(range.startContainer, range.startOffset);
    if (!rest.toString().replace(/\u200B/g, "") && !rest.cloneContents().querySelector?.("img")) { e.preventDefault(); return true; }
    return false;
  }
  // ↑ from the first row / ↓ from the last, with nothing beyond the table:
  // make a line there instead of getting stuck.
  if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.shiftKey && range.collapsed) {
    const down = e.key === "ArrowDown";
    if ((down ? r !== table.rows.length - 1 : r !== 0) || (down ? table.nextElementSibling : table.previousElementSibling)) return false;
    const rect = rangeRect(range), cr = cell.getBoundingClientRect(), cs = getComputedStyle(cell);
    const lh = parseFloat(cs.lineHeight) || 20;
    const edgeLine = down ? rect.bottom > cr.bottom - (parseFloat(cs.paddingBottom) || 0) - lh * 0.6 : rect.top < cr.top + (parseFloat(cs.paddingTop) || 0) + lh * 0.6;
    if (!edgeLine) return false;
    e.preventDefault();
    const p = emptyParagraph();
    if (down) table.after(p); else table.before(p);
    placeCaret(p, 0);
    changed();
    return true;
  }
  return false;
}

// Just outside a table, Backspace and Delete never pour a line into a cell
// (or a cell into a line): an empty line goes away, and otherwise the caret
// steps into the table.
function besideTable(e: KeyboardEvent, range: Range) {
  if (!range.collapsed || (e.key !== "Backspace" && e.key !== "Delete")) return false;
  const top = topBlockOf(range.startContainer);
  if (!top || closestEl(range.startContainer, "li")) return false;
  const back = e.key === "Backspace";
  const table = back ? top.previousElementSibling : top.nextElementSibling;
  if (table?.tagName !== "TABLE") return false;
  if (back ? !atBlockStart(top, range) : (() => {
    const rest = document.createRange();
    rest.selectNodeContents(top);
    rest.setStart(range.startContainer, range.startOffset);
    return rest.toString().replace(/\u200B/g, "") || rest.cloneContents().querySelector?.("img");
  })()) return false;
  e.preventDefault();
  // An empty line between blocks goes away -- but not the last line of the
  // document, which is what you type into below a table.
  if (isEmptyLine(top) && top.nextElementSibling) {
    top.remove();
    changed();
  }
  // Checked to be a TABLE above.
  if (back) placeCaretAtEnd(lastCell(table as HTMLTableElement));
  else { const [n, o] = startPoint((table as HTMLTableElement).rows[0].cells[0]); placeCaret(n, o); }
  keepCaretVisible();
  return true;
}
const lastCell = (t: HTMLTableElement) => { const r = t.rows[t.rows.length - 1]; return r.cells[r.cells.length - 1]; };

// ── Paste into a cell ────────────────────────────────────────────────────
// A copied grid (a spreadsheet range, a table, tab-separated text) fills the
// cells from here, growing the table as needed; anything else is pasted as
// text into this one cell.
function clipboardGrid(html: string, text: string) {
  if (html && /<table/i.test(html)) {
    const tpl = document.createElement("template");
    tpl.innerHTML = sanitizePastedHtml(html);
    const t = tpl.content.querySelector("table");
    if (t) return Array.from(t.rows, (r) => Array.from(r.cells, (c) => c.innerHTML));
  }
  const tsv = parseTsv(text);
  if (tsv) return tsv.map((r) => r.map(escapeHtml));
  // A Markdown pipe table.
  const tpl = document.createElement("template");
  tpl.innerHTML = sanitizePastedHtml(textToHtml(text));
  // (`:scope` matches nothing in a fragment, so the one child is checked itself.)
  const only = tpl.content.children.length === 1 ? tpl.content.firstElementChild : null;
  const t = only instanceof HTMLTableElement ? only : null;
  return t ? Array.from(t.rows, (r) => Array.from(r.cells, (c) => c.innerHTML)) : null;
}
function flattenToInline(html: string) {
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  const parts: string[] = [];
  for (const n of tpl.content.childNodes) {
    if (isElement(n) && (n.tagName === "UL" || n.tagName === "OL")) {
      for (const li of n.querySelectorAll("li")) { const c = li.cloneNode(true) as HTMLLIElement; c.querySelectorAll("ul, ol").forEach((x) => x.remove()); parts.push(c.innerHTML); }
    } else if (isElement(n) && n.tagName === "PRE") parts.push(escapeHtml(n.textContent).replace(/\n/g, "<br>"));
    else if (isElement(n) && BLOCK_LEVEL.has(n.tagName)) parts.push(n.innerHTML);
    else parts.push(isElement(n) ? n.outerHTML : escapeHtml(n.textContent));
  }
  return parts.filter((p) => p.replace(/<br\s*\/?>/g, "").trim()).join("<br>");
}
function pasteIntoCell(cell: HTMLTableCellElement, html: string, text: string) {
  const grid = clipboardGrid(html, text);
  if (grid && grid.length && (grid.length > 1 || grid[0].length > 1)) {
    const table = cell.closest("table");
    const r0 = (cell.parentElement as HTMLTableRowElement).rowIndex, c0 = cell.cellIndex;
    tableOp(table, (t) => {
      const need = c0 + Math.max(...grid.map((r) => r.length));
      while (colCount(t) < need) insertColumnAt(t, colCount(t));
      while (t.rows.length < r0 + grid.length) bodyOf(t).appendChild(newRow(colCount(t)));
      const filled: HTMLTableCellElement[] = [];
      grid.forEach((cells, i) => cells.forEach((h, j) => {
        const target = t.rows[r0 + i].cells[c0 + j];
        if (!target) return;
        target.innerHTML = h && h.replace(/<br\s*\/?>/g, "").trim() ? h : "<br>";
        filled.push(target);
      }));
      return { caret: filled[filled.length - 1], flash: filled };
    });
    return;
  }
  let inline;
  if (grid) inline = grid[0][0];
  else if (html && html.trim()) inline = flattenToInline(sanitizePastedHtml(html));
  else inline = escapeHtml(String(text || "").replace(/\r\n?/g, "\n").replace(/\n+$/, "")).replace(/\n/g, "<br>");
  if (inline) exec("insertHTML", inline);
}

// Plain text of a table: an aligned Markdown table.
function tableToMarkdown(t: HTMLTableElement) {
  const rows = Array.from(t.rows, (r) => Array.from(r.cells, (c) => (c.innerText ?? c.textContent).replace(/\u200B/g, "").trim().replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|")));
  if (!rows.length) return "";
  const n = Math.max(...rows.map((r) => r.length));
  const widths = Array.from({ length: n }, (_, i) => Math.max(3, ...rows.map((r) => (r[i] || "").length)));
  const line = (r: string[]) => "| " + widths.map((w, i) => (r[i] || "").padEnd(w)).join(" | ") + " |";
  return [line(rows[0]), "| " + widths.map((w) => "-".repeat(w)).join(" | ") + " |", ...rows.slice(1).map(line)].join("\n");
}

// ── Table chrome ─────────────────────────────────────────────────────────
const tblFocus = el("div", { class: "tbl-focus", "aria-hidden": "true" });
const tblTint = el("div", { class: "blk-box sel tbl-tint", "aria-hidden": "true" });
const tblColBtn = el("button", { type: "button", class: "tbl-ui tbl-pill tbl-col", html: svg(ICONS.more, 16) });
const tblRowBtn = el("button", { type: "button", class: "tbl-ui tbl-pill tbl-row", html: svg(ICONS.moreV, 16) });
const tblAddRow = el("button", { type: "button", class: "tbl-ui tbl-add tbl-add-row", html: svg(ICONS.plus, 13) });
const tblAddCol = el("button", { type: "button", class: "tbl-ui tbl-add tbl-add-col", html: svg(ICONS.plus, 13) });
const tblResize = el("div", { class: "tbl-ui tbl-resize", "aria-hidden": "true" });
const tblButtons = [tblColBtn, tblRowBtn, tblAddRow, tblAddCol];
if (!isExport) page.append(tblTint, tblFocus, ...tblButtons, tblResize);
attachTip(tblColBtn, "Column");
attachTip(tblRowBtn, "Row");
attachTip(tblAddRow, "Add row");
attachTip(tblAddCol, "Add column");
for (const b of tblButtons) b.addEventListener("mousedown", (e) => e.preventDefault());

/** A column resize in progress: the table as it was, the copy being resized, and the boundary. */
interface ColumnResize {
  original: HTMLTableElement;
  t: HTMLTableElement;
  i: number;
  x0: number;
  widths: number[];
  moved: boolean;
}
let tblHover: { table: HTMLTableElement; r: number; c: number } | null = null, tblMenu = false, tblEdge: number | null = null, tblResizing: ColumnResize | null = null, ringTable: HTMLTableElement | null = null;
function hideTableUi(force = false) {
  if (!force && (tblMenu || tblResizing)) return;
  tblHover = null;
  tblEdge = null;
  editor.classList.remove("tbl-edge");
  for (const b of tblButtons) b.classList.remove("show");
  tblResize.classList.remove("show");
  tblTint.classList.remove("show");
}
function showTableUi() {
  const h = tblHover;
  if (!h || !h.table.isConnected) return hideTableUi(true);
  const t = h.table;
  const row = t.rows[Math.min(h.r, t.rows.length - 1)];
  const cell = row?.cells[Math.min(h.c, row.cells.length - 1)];
  if (!cell) return hideTableUi(true);
  const pr = page.getBoundingClientRect(), tr = t.getBoundingClientRect(), rr = row.getBoundingClientRect(), cr = cell.getBoundingClientRect();
  const at = (node: HTMLElement, x: number, y: number) => { node.style.transform = `translate(${Math.round(x - pr.left)}px, ${Math.round(y - pr.top)}px)`; };
  // Pills sit on the table's own edges, centred on the hovered column and row.
  at(tblColBtn, cr.left + cr.width / 2 - 12, tr.top - 6);
  at(tblRowBtn, tr.left - 6, rr.top + rr.height / 2 - 12);
  at(tblAddRow, tr.left, tr.bottom + 4);
  tblAddRow.style.width = Math.round(tr.width) + "px";
  at(tblAddCol, tr.right + 4, tr.top);
  tblAddCol.style.height = Math.round(tr.height) + "px";
  for (const b of tblButtons) b.classList.add("show");
  const edgeCell = tblEdge !== null ? row.cells[tblEdge] : null;
  if (edgeCell) {
    at(tblResize, edgeCell.getBoundingClientRect().right - 1.5, tr.top);
    tblResize.style.height = Math.round(tr.height) + "px";
    tblResize.classList.add("show");
  } else tblResize.classList.remove("show");
}
function tintTable(kind: "col" | "row") {
  const h = tblHover;
  if (!h?.table.isConnected) return;
  const t = h.table, pr = page.getBoundingClientRect(), tr = t.getBoundingClientRect();
  const box = kind === "col" ? (() => { const cr = t.rows[h.r].cells[h.c].getBoundingClientRect(); return { l: cr.left, tp: tr.top, w: cr.width, hh: tr.height }; })()
    : (() => { const rr = t.rows[h.r].getBoundingClientRect(); return { l: tr.left, tp: rr.top, w: tr.width, hh: rr.height }; })();
  tblTint.style.transform = `translate(${Math.round(box.l - pr.left)}px, ${Math.round(box.tp - pr.top)}px)`;
  tblTint.style.width = Math.round(box.w) + "px";
  tblTint.style.height = Math.round(box.hh) + "px";
  tblTint.classList.add("show");
}
// The focus ring follows the caret from cell to cell, centred on the grid
// lines and rounded to match the table where it meets a corner.
function refreshTableUi() {
  if (isExport) return;
  const range = document.activeElement === editor && !blockSel ? getRange() : null;
  const cell = range && cellOf(range.startContainer);
  if (cell && cellOf(range!.endContainer) === cell) {
    const table = cell.closest("table")!, row = cell.parentElement as HTMLTableRowElement;
    const pr = page.getBoundingClientRect(), cr = cell.getBoundingClientRect();
    const firstRow = row.rowIndex === 0, lastRow = row.rowIndex === table.rows.length - 1;
    const firstCol = cell.cellIndex === 0, lastCol = cell.cellIndex === row.cells.length - 1;
    const jump = ringTable !== table || !tblFocus.classList.contains("show");
    if (jump) tblFocus.classList.add("jump");
    tblFocus.style.transform = `translate(${cr.left - 1 - pr.left}px, ${cr.top - 1 - pr.top}px)`;
    tblFocus.style.width = cr.width + 1 + (lastCol ? 1 : 0) + "px";
    tblFocus.style.height = cr.height + 1 + (lastRow ? 1 : 0) + "px";
    const R = 8, q = 2;
    tblFocus.style.borderRadius = `${firstRow && firstCol ? R : q}px ${firstRow && lastCol ? R : q}px ${lastRow && lastCol ? R : q}px ${lastRow && firstCol ? R : q}px`;
    if (jump) { void tblFocus.offsetWidth; tblFocus.classList.remove("jump"); }
    tblFocus.classList.add("show");
    ringTable = table;
  } else {
    tblFocus.classList.remove("show");
    ringTable = null;
  }
  if (tblHover) { if (tblHover.table.isConnected && tblColBtn.classList.contains("show")) showTableUi(); else if (!tblHover.table.isConnected) hideTableUi(true); }
}
// Within ~5px of a column boundary, the pointer resizes instead of selecting.
function edgeAt(cell: HTMLTableCellElement, x: number) {
  const r = cell.getBoundingClientRect(), n = (cell.parentElement as HTMLTableRowElement).cells.length;
  if (r.right - x <= 5 && cell.cellIndex < n - 1) return cell.cellIndex;
  if (x - r.left <= 4 && cell.cellIndex > 0) return cell.cellIndex - 1;
  return null;
}
document.addEventListener("pointermove", (e) => {
  if (e.pointerType === "touch" || tblResizing || tblMenu || !handlesAllowed()) return;
  if (e.buttons || drag || sweep) return;
  const target = e.target instanceof Element ? e.target : null;
  if (target?.closest(".tbl-ui, .pop, .tip")) return;
  const cell = target?.closest<HTMLTableCellElement>("td, th");
  const table = cell && editor.contains(cell) ? cell.closest("table") : null;
  if (table && table.parentElement === editor) {
    tblHover = { table, r: (cell!.parentElement as HTMLTableRowElement).rowIndex, c: cell!.cellIndex };
    tblEdge = edgeAt(cell!, e.clientX);
    editor.classList.toggle("tbl-edge", tblEdge !== null);
    showTableUi();
    return;
  }
  // The add bars live just outside the table: stay up on the way to them.
  if (tblHover?.table.isConnected) {
    const r = tblHover.table.getBoundingClientRect();
    if (e.clientX > r.left - 18 && e.clientX < r.right + 28 && e.clientY > r.top - 16 && e.clientY < r.bottom + 28) {
      tblEdge = null;
      editor.classList.remove("tbl-edge");
      showTableUi();
      return;
    }
  }
  if (tblHover) hideTableUi();
}, { passive: true });
document.documentElement.addEventListener("pointerleave", () => hideTableUi());

for (const [btn, kind] of [[tblColBtn, "col"], [tblRowBtn, "row"]] as const) {
  btn.addEventListener("pointerenter", () => tintTable(kind));
  btn.addEventListener("pointerleave", () => { if (!tblMenu) tblTint.classList.remove("show"); });
}
const menuClosed = () => { tblMenu = false; tblTint.classList.remove("show"); };
tblColBtn.addEventListener("click", () => {
  const h = tblHover;
  if (!h?.table.isConnected) return;
  if (openPop?.owner === tblColBtn) { closePop(); return; }
  const { table, r, c } = h;
  const del = menuItem({ icon: "trash", label: "Delete column", onSelect: () => tableOp(table, (t) => deleteColumnAt(t, c, r)) });
  del.classList.add("danger");
  showPop([
    menuItem({ icon: "colLeft", label: "Insert left", onSelect: () => tableOp(table, (t) => insertColumnAt(t, c, r)) }),
    menuItem({ icon: "colRight", label: "Insert right", onSelect: () => tableOp(table, (t) => insertColumnAt(t, c + 1, r)) }),
    el("div", { class: "msep" }),
    del
  ], tblColBtn.getBoundingClientRect(), { owner: tblColBtn, align: "center", onClose: menuClosed });
  tblMenu = true;
  tintTable("col");
});
tblRowBtn.addEventListener("click", () => {
  const h = tblHover;
  if (!h?.table.isConnected) return;
  if (openPop?.owner === tblRowBtn) { closePop(); return; }
  const { table, r, c } = h;
  const isHead = table.rows[r]?.parentElement!.tagName === "THEAD";
  const del = menuItem({ icon: "trash", label: isHead ? "Delete header row" : "Delete row", onSelect: () => tableOp(table, (t) => deleteRowAt(t, r, c)) });
  del.classList.add("danger");
  showPop([
    isHead ? null : menuItem({ icon: "rowAbove", label: "Insert above", onSelect: () => tableOp(table, (t) => insertRowAt(t, r, c)) }),
    menuItem({ icon: "rowBelow", label: "Insert below", onSelect: () => tableOp(table, (t) => insertRowAt(t, r + 1, c)) }),
    r === 0 ? menuItem({ icon: "tableHeader", label: "Header row", checked: isHead, checkSlot: true, onSelect: () => tableOp(table, toggleHeader) }) : null,
    el("div", { class: "msep" }),
    del
  ], tblRowBtn.getBoundingClientRect(), { owner: tblRowBtn, onClose: menuClosed });
  tblMenu = true;
  tintTable("row");
});
tblAddRow.addEventListener("click", () => {
  const h = tblHover;
  if (!h?.table.isConnected) return;
  const t = tableOp(h.table, (t) => insertRowAt(t, t.rows.length, 0));
  if (t) { tblHover = { table: t, r: t.rows.length - 1, c: 0 }; showTableUi(); }
});
tblAddCol.addEventListener("click", () => {
  const h = tblHover;
  if (!h?.table.isConnected) return;
  const t = tableOp(h.table, (t) => insertColumnAt(t, colCount(t), 0));
  if (t) { tblHover = { table: t, r: 0, c: colCount(t) - 1 }; showTableUi(); }
});

// ── Column resizing ──────────────────────────────────────────────────────
// Drag a boundary: the two neighbouring columns trade width (the table keeps
// its own). Double-click a boundary to even all columns out again.
editor.addEventListener("pointerdown", (e) => {
  if (tblEdge === null || !tblHover?.table.isConnected || e.button !== 0 || e.pointerType === "touch") return;
  const table = tblHover.table;
  const ref = table.rows[tblHover.r] || table.rows[0];
  const widths = Array.from(ref.cells, (c) => c.getBoundingClientRect().width);
  if (widths.length !== colCount(table) || tblEdge >= widths.length - 1) return;
  e.preventDefault();
  hideTip();
  const spot = caretSpot(table);
  recordBlockStep();
  const t = table.cloneNode(true) as HTMLTableElement;
  table.replaceWith(t);
  setColWidths(t, widths);
  if (spot) restoreSpot(t, spot);
  tblHover.table = t;
  tblResizing = { original: table, t, i: tblEdge, x0: e.clientX, widths, moved: false };
  document.body.classList.add("tbl-resizing");
  window.addEventListener("pointermove", onResizeMove);
  window.addEventListener("pointerup", onResizeEnd);
  window.addEventListener("pointercancel", onResizeEnd);
  // A release outside the frame never reaches it.
  window.addEventListener("blur", onResizeEnd);
});
// Some browsers still start a text selection from the mouse event that follows.
editor.addEventListener("mousedown", (e) => { if (tblResizing) e.preventDefault(); }, true);
function onResizeMove(e: PointerEvent) {
  const s = tblResizing;
  if (!s) return;
  const dx = e.clientX - s.x0;
  if (Math.abs(dx) >= 1) s.moved = true;
  const w = s.widths.slice(), pair = w[s.i] + w[s.i + 1], min = 44;
  w[s.i] = clamp(w[s.i] + dx, min, pair - min);
  w[s.i + 1] = pair - w[s.i];
  setColWidths(s.t, w);
  showTableUi();
  refreshTableUi();
}
function onResizeEnd() {
  const s = tblResizing;
  tblResizing = null;
  window.removeEventListener("pointermove", onResizeMove);
  window.removeEventListener("pointerup", onResizeEnd);
  window.removeEventListener("pointercancel", onResizeEnd);
  window.removeEventListener("blur", onResizeEnd);
  document.body.classList.remove("tbl-resizing");
  if (!s) return;
  if (!s.moved) {
    // Just a click on the boundary: put the untouched original back.
    const spot = caretSpot(s.t);
    s.t.replaceWith(s.original);
    blockHistory.undo.pop();
    if (tblHover) tblHover.table = s.original;
    if (spot) restoreSpot(s.original, spot);
  } else blockChanged();
  showTableUi();
  scheduleUi();
}
editor.addEventListener("dblclick", (e) => {
  if (tblEdge === null || !tblHover?.table.isConnected || !colWidths(tblHover.table)) return;
  e.preventDefault();
  tableOp(tblHover.table, (t) => { setColWidths(t, null); });
  showTableUi();
});

/* ═══════════════ 9. Ambient UI: placeholder, outline, scroll ═════════════ */

function isEmptyLine(n: Element | null | undefined) {
  return !!n && !n.textContent.replace(/\u200B/g, "").trim() && !n.querySelector("img, hr") && !/^(UL|OL|HR|PRE|TABLE)$/.test(n.tagName);
}
// The empty line the caret is on (or the lone empty first line of a blank
// document) gets a data-ph hint; CSS draws it inside that line. Runs
// synchronously after every edit and selection change, so a line that has just
// become a list item, gained text or been split never shows a stale hint.
// data-ph is never saved: canonicalBlockHtml strips it.
const EMPTY_DOC_HINT = coarsePointer ? "Start writing…" : "Start writing, or press / for commands";
const LINE_HINTS: Record<string, string> = { P: coarsePointer ? "" : "Type / for commands", H1: "Heading 1", H2: "Heading 2", H3: "Heading 3", H4: "Heading", BLOCKQUOTE: "Quote" };
editor.setAttribute("data-empty-ph", EMPTY_DOC_HINT);
function placeholderTarget(): [HTMLElement | null, string] {
  if (!ready || isExport || composing) return [null, ""];
  const blocks = editor.children;
  if (blocks.length === 1 && blocks[0].tagName === "P" && isEmptyLine(blocks[0])) return [blocks[0], EMPTY_DOC_HINT];
  if (document.activeElement !== editor) return [null, ""];
  const range = getRange();
  if (!range?.collapsed) return [null, ""];
  const line = closestEl(range.startContainer, "li, p, h1, h2, h3, h4, blockquote");
  // Only a line that is itself the innermost block: a <p> wrapped in a list item
  // or quote, or a list item holding a nested list, gets no hint.
  if (!line || !isEmptyLine(line) || line.querySelector("p, div, li, ul, ol, blockquote, h1, h2, h3, h4, pre")) return [null, ""];
  if (line.tagName === "BLOCKQUOTE" && line.getAttribute("style")) return [null, ""]; // an indent, not a quote
  // Never hint on a line with no visible box (the caret can't really be there).
  if (!line.offsetHeight || !line.getClientRects().length) return [null, ""];
  const listHint = (li: Element) => li.closest("ul.checklist") ? "To-do" : "List";
  if (line.tagName === "LI") return [line, listHint(line)];
  // A paragraph the browser has wrapped inside a list item or a quote takes
  // that context's hint; being its own box, it is already past the checkbox,
  // bullet or quote rule.
  if (line.tagName === "P" && line.parentElement !== editor) {
    const parent = line.parentElement!;
    if (parent.tagName === "LI" && parent.children.length === 1) return [line, listHint(parent)];
    if (parent.tagName === "BLOCKQUOTE" && parent.children.length === 1 && !parent.getAttribute("style")) return [line, "Quote"];
    return [null, ""];
  }
  const text = LINE_HINTS[line.tagName] || "";
  return text ? [line, text] : [null, ""];
}
function syncPlaceholder() {
  const [target, text] = placeholderTarget();
  for (const n of editor.querySelectorAll("[data-ph]")) if (n !== target) n.removeAttribute("data-ph");
  if (target && target.getAttribute("data-ph") !== text) target.setAttribute("data-ph", text);
}

// The browser tab shows the document's first line.
let titleTimer: number | null = null;
function updateTabTitle() {
  const firstLine = Array.from(editor.children).map((n) => n.textContent.replace(/\u200B/g, "").trim()).find(Boolean);
  document.title = firstLine ? firstLine.slice(0, 60) : "Untitled";
}
function scheduleTabTitle() {
  clearTimeout(titleTimer);
  titleTimer = setTimeout(updateTabTitle, 250);
}

let outlineTimer: number | null = null, outlineHeadings: HTMLElement[] = [];
function scheduleOutline() {
  clearTimeout(outlineTimer);
  outlineTimer = setTimeout(rebuildOutline, 400);
}
function rebuildOutline() {
  if (isExport) return;
  outlineHeadings = Array.from(editor.children).filter((n) => /^H[1-3]$/.test(n.tagName) && n.textContent.trim());
  const room = (innerWidth - page.getBoundingClientRect().width) / 2;
  if (outlineHeadings.length < 2 || room < 120) { outline.classList.add("hidden"); outline.replaceChildren(); return; }
  outline.replaceChildren(...outlineHeadings.map((h) => {
    const item = el("div", { class: "ol-item", "data-level": h.tagName[1], title: h.textContent.trim() }, [el("span", { class: "ol-label" }, h.textContent.trim()), el("span", { class: "ol-dash" })]);
    item.addEventListener("mousedown", (e) => e.preventDefault());
    item.addEventListener("click", () => h.scrollIntoView({ behavior: reducedMotion.matches ? "auto" : "smooth", block: "start" }));
    return item;
  }));
  outline.classList.remove("hidden");
  updateOutlineActive();
}
function updateOutlineActive() {
  if (!outlineHeadings.length || outline.classList.contains("hidden")) return;
  const line = bar.getBoundingClientRect().bottom + 40;
  let active = 0;
  outlineHeadings.forEach((h, i) => { if (h.getBoundingClientRect().top <= line) active = i; });
  Array.from(outline.children).forEach((n, i) => n.classList.toggle("active", i === active));
}

// The translucent top bar floats over the text, so keep the caret clear of it
// (and give it some breathing room above the bottom edge while typing).
function keepCaretVisible() {
  const range = getRange();
  if (!range || !range.collapsed) return;
  const rect = rangeRect(range);
  if (!rect || !rect.height) return;
  const top = bar.getBoundingClientRect().bottom + 16, bottom = innerHeight - 80;
  if (rect.bottom > bottom) canvas.scrollTop += rect.bottom - bottom;
  else if (rect.top < top) canvas.scrollTop -= top - rect.top;
}

let uiQueued = false, caretCheckQueued = false;
function scheduleUi(typing = false) {
  if (typing) caretCheckQueued = true;
  if (uiQueued) return;
  uiQueued = true;
  requestAnimationFrame(() => {
    uiQueued = false;
    refreshToolbar();
    syncPlaceholder();
    updateLinkView();
    refreshBlockUi();
    if (caretCheckQueued) { caretCheckQueued = false; keepCaretVisible(); }
  });
}
// Everything that has to follow a change to the document, whichever way it happened.
function changed({ typing = false }: { typing?: boolean } = {}) {
  // Block-level undo only covers an unbroken run of block actions; any other
  // edit (typing, formatting, a list toggle) hands undo back to the browser.
  if (!blockOpDepth) clearBlockHistory();
  normalize();
  fixColorMarkers(currentTopBlock() || editor);
  fixCodeSpans(currentTopBlock() || editor);
  void reencodeMarkedImages();
  if (selectedImage && !editor.contains(selectedImage)) hideImageControls();
  else if (selectedImage && !resizingImage) positionImageControls();
  updateSlash();
  syncPlaceholder();
  scheduleUi(typing);
  scheduleTabTitle();
  scheduleOutline();
  scheduleSave();
}

document.addEventListener("selectionchange", () => {
  syncPlaceholder();
  const range = getRange();
  if (!range) return;
  lastRange = range.cloneRange();
  if (slash) updateSlash();
  scheduleUi();
  if (pendingByBlock.size && settlePendingBlocks()) scheduleSave(20);
});
canvas.addEventListener("scroll", () => {
  bar.classList.toggle("scrolled", canvas.scrollTop > 2);
  if (selectedImage) positionImageControls();
  requestAnimationFrame(updateOutlineActive);
  hideTip();
}, { passive: true });
window.addEventListener("resize", () => {
  if (selectedImage) positionImageControls();
  scheduleOutline();
  scheduleUi();
});

// ── Live edits (block API) ───────────────────────────────────────────────
// Changes made through the server's block API (senderId "agent") land with a
// light touch, so you can watch the document being worked on:
//   • a new block rises into place with a faint wash behind it;
//   • an edited block highlights just the words that changed (a hairline
//     tick marks where words were taken out), then the highlight fades;
//   • a block that is mostly rewritten (or changes type) washes and fades in;
//   • a removed block fades where it stood while the rest closes the gap;
//   • a slim accent "pen" follows the latest change and fades when it stops.
// Several blocks in one change cascade in document order. Everything is drawn
// in an overlay outside the editor, so none of it can reach saved content.
document.head.appendChild(el("style", { text: `
.ag-layer { position: absolute; left: 0; top: 0; width: 0; height: 0; pointer-events: none; z-index: 1; }
.ag-layer > * { position: absolute; left: 0; top: 0; pointer-events: none; }
.ag-mark { border-radius: 3px; background: color-mix(in srgb, var(--accent) 17%, transparent); }
.ag-wash { border-radius: 7px; background: color-mix(in srgb, var(--accent) 6.5%, transparent); }
.ag-tick { width: 2px !important; border-radius: 1px; background: color-mix(in srgb, var(--accent) 70%, transparent); }
.ag-ghost { overflow: hidden; }
.ag-ghost .editor { min-height: 0; padding: 0; }
.ag-ghost .editor > * { margin-top: 0 !important; margin-bottom: 0 !important; }
.ag-pen {
  width: 2px; border-radius: 1px; background: var(--accent); opacity: 0;
  transition: opacity .35s var(--ease), transform .28s cubic-bezier(.2,.8,.2,1), height .28s cubic-bezier(.2,.8,.2,1);
}
.ag-pen.show { opacity: .85; transition: opacity .12s var(--ease), transform .28s cubic-bezier(.2,.8,.2,1), height .28s cubic-bezier(.2,.8,.2,1); }
.ag-pen.jump { transition: opacity .12s var(--ease); }
@media print { .ag-layer { display: none !important; } }
` }));
const agentLayer = el("div", { class: "ag-layer", "aria-hidden": "true" });
const agentPen = el("div", { class: "ag-pen" });
if (!isExport) { agentLayer.appendChild(agentPen); page.appendChild(agentLayer); }
let penTimer: number | null = null;
const liveEffectsOn = () => ready && !isExport && document.visibilityState === "visible";

function placeOnLayer(node: HTMLElement, rect: DOMRect, pr = page.getBoundingClientRect()) {
  node.style.transform = `translate(${Math.round((rect.left - pr.left) * 2) / 2}px, ${Math.round((rect.top - pr.top) * 2) / 2}px)`;
  node.style.width = Math.max(0, rect.width) + "px";
  node.style.height = Math.max(0, rect.height) + "px";
  return node;
}
// Overlays follow the block they belong to. Blocks keep moving after an
// overlay is measured: they slide into place (FLIP), and the agent's next
// change may resize a block above. An overlay pinned where it was measured
// drifts off its block onto whatever moves under it.
/** An overlay that follows its block: where it was placed (`rect`) when the block was at `ref`. */
interface Follower {
  el: HTMLElement;
  node: Element;
  rect: DOMRect;
  rectFn?: (() => DOMRect) | null;
  ref?: DOMRect;
}
const followers = new Set<Follower>();
let followRaf = 0;
function follow(entry: Follower) {
  entry.ref = entry.node.getBoundingClientRect();
  followers.add(entry);
  if (!followRaf) followRaf = requestAnimationFrame(followFrame);
  return entry;
}
function followFrame() {
  followRaf = 0;
  const pr = page.getBoundingClientRect(), moves: [Follower, DOMRect][] = [];
  for (const f of followers) {
    // The block was replaced or removed: its overlay has nothing to mark.
    if (!f.node.isConnected || !f.el.isConnected) { followers.delete(f); if (f.el !== agentPen) f.el.remove(); continue; }
    const now = f.node.getBoundingClientRect();
    moves.push([f, f.rectFn ? f.rectFn() : new DOMRect(f.rect.left + now.left - f.ref!.left, f.rect.top + now.top - f.ref!.top, f.rect.width, f.rect.height)]);
  }
  for (const [f, r] of moves) placeOnLayer(f.el, r, pr);
  if (followers.size) followRaf = requestAnimationFrame(followFrame);
}
function flashOnLayer(className: string, rect: DOMRect, keyframes: Keyframe[], options: KeyframeAnimationOptions, node: Element | null = null, rectFn: (() => DOMRect) | null = null) {
  const n = placeOnLayer(el("div", { class: className }), rect);
  agentLayer.appendChild(n);
  const entry = node ? follow({ el: n, node, rect, rectFn }) : null;
  const a = n.animate(keyframes, { fill: "both", ...options });
  const done = () => { n.remove(); if (entry) followers.delete(entry); };
  a.finished.then(done, done);
  return n;
}
// The block's highlight area: the same box block selection uses.
function washRect(node: Element) {
  const r = node.getBoundingClientRect(), cb = contentBox();
  return new DOMRect(cb.left - BOX_INSET, r.top - 3, cb.right - cb.left + 2 * BOX_INSET, r.height + 6);
}

// Word-level diff of a block's text: which stretches of the new text are new,
// and where old words were removed with nothing in their place.
const DIFF_TOKEN = /[\p{L}\p{N}_'’]+|\s+|[^\s]/gu;
function textDiff(a: string, b: string): { added: [number, number][]; removedAt: number[]; ratio: number } | null {
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
  // Whitespace-only stretches aren't worth pointing at.
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
// A DOM range over [start, end) of `root`'s text.
function textRange(root: Node, start: number, end: number) {
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const r = document.createRange();
  let pos = 0, started = false;
  for (let t = w.nextNode() as Text | null; t; t = w.nextNode() as Text | null) {
    const len = t.data.length;
    if (!started && start <= pos + len) { r.setStart(t, start - pos); started = true; }
    if (started && end <= pos + len) { r.setEnd(t, end - pos); return r; }
    pos += len;
  }
  return null;
}
// One rect per line of a range (inline elements report duplicates).
function lineRects(range: Range) {
  const out: { left: number; right: number; top: number; bottom: number }[] = [];
  for (const r of range.getClientRects()) {
    if (r.width < 1 || r.height < 1) continue;
    const same = out.find((o) => Math.abs(o.top - r.top) < 2 && r.left <= o.right + 1 && r.right >= o.left - 1);
    if (same) { const l = Math.min(same.left, r.left), rt = Math.max(same.right, r.right); same.left = l; same.right = rt; }
    else out.push({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
  }
  return out.map((o) => new DOMRect(o.left - 1.5, o.top, o.right - o.left + 3, o.bottom - o.top));
}
function caretRectAt(root: Node, offset: number) {
  const r = textRange(root, offset, offset);
  if (!r) return null;
  const rect = rangeRect(r);
  return rect && rect.height ? rect : null;
}
function endRect(node: Element) {
  const [n, o] = endPoint(node);
  const r = document.createRange();
  try { r.setStart(n, o); r.collapse(true); } catch { return null; }
  const rect = rangeRect(r);
  return rect && rect.height ? rect : null;
}
let penFollow: Follower | null = null;
function movePen(rect: DOMRect | null, node: Element | null) {
  if (!rect) return;
  const shown = agentPen.classList.contains("show");
  if (!shown) agentPen.classList.add("jump");
  const r = new DOMRect(rect.left - 1, rect.top + 1, 2, Math.max(8, rect.height - 2));
  placeOnLayer(agentPen, r);
  if (!shown) { void agentPen.offsetWidth; agentPen.classList.remove("jump"); }
  agentPen.classList.add("show");
  if (penFollow) followers.delete(penFollow);
  penFollow = node?.isConnected ? follow({ el: agentPen, node, rect: r }) : null;
  clearTimeout(penTimer);
  penTimer = setTimeout(() => {
    agentPen.classList.remove("show");
    if (penFollow) { followers.delete(penFollow); penFollow = null; }
  }, 1400);
}

// Before a live change is applied: where everything is and what it said.
/** A block a live change is about to update: the node, its text and kind, and its document position. */
interface CapturedBlock {
  node: HTMLElement;
  text: string;
  tag: string;
  top: number;
}
/** The page as it was just before a live change: block positions, and what the changed blocks said. */
interface LiveEditCapture {
  tops: Map<Element, number>;
  ids: string[];
  old: Map<string, CapturedBlock>;
  gone: { node: HTMLElement; rect: DOMRect }[];
}
function captureLiveEdit(event: OperationEvent): LiveEditCapture {
  const st = canvas.scrollTop;
  const old = new Map<string, CapturedBlock>(), gone: LiveEditCapture["gone"] = [];
  for (const b of event.upserts || []) {
    const node = findBlock(b.id);
    if (node) old.set(b.id, { node, text: node.textContent, tag: node.tagName + (node.className || ""), top: node.getBoundingClientRect().top + st });
  }
  for (const id of event.deletedIds || []) {
    const node = findBlock(id);
    if (node) gone.push({ node, rect: node.getBoundingClientRect() });
  }
  return { tops: measureTops(), ids: (event.upserts || []).map((b) => b.id), old, gone };
}
function showLiveEdit(prior: LiveEditCapture) {
  const st = canvas.scrollTop, motion = !reducedMotion.matches;
  // Removed blocks fade out where they stood.
  for (const g of prior.gone) {
    if (g.node.isConnected) continue; // kept for now: the user is editing it
    const clone = g.node.cloneNode(true) as Element;
    clone.removeAttribute("data-block-id");
    const ghost = flashOnLayer("ag-ghost", g.rect, [{ opacity: 0.85 }, { opacity: 0, filter: "blur(1.5px)" }], { duration: 220, easing: "ease-out" });
    ghost.appendChild(el("div", { class: "editor" }, [clone]));
  }
  const changes: { node: HTMLElement; was: CapturedBlock | undefined }[] = [];
  for (const id of prior.ids) {
    const node = findBlock(id);
    const was = prior.old.get(id);
    if (!node || was?.node === node) continue; // not replaced: held through an IME composition, or the merge kept the local text
    changes.push({ node, was });
    // These animate on their own below; settle() only slides the rest.
    for (const n of [node, ...node.querySelectorAll("li")]) prior.tops.set(n, was && n === node ? was.top : n.getBoundingClientRect().top + st);
  }
  settle(prior.tops);
  if (!changes.length) return;
  changes.sort((a, b) => a.node.compareDocumentPosition(b.node) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
  const step = Math.min(70, 560 / changes.length);
  changes.slice(0, 40).forEach(({ node, was }, k) => {
    const delay = Math.round(k * step);
    const text = node.textContent;
    let penRect: DOMRect | null = null;

    // Everything is measured before anything starts moving.
    if (!was) {
      // New: rises into place.
      penRect = endRect(node);
      flashOnLayer("ag-wash", washRect(node), [{ opacity: 0 }, { opacity: 1, offset: 0.2 }, { opacity: 0 }], { duration: 1300, delay, easing: "ease-out" }, node, () => washRect(node));
      node.animate(motion ? [{ opacity: 0, transform: "translateY(5px)" }, { opacity: 1, transform: "none" }] : [{ opacity: 0 }, { opacity: 1 }], { duration: 280, delay, easing: "cubic-bezier(.2,.8,.2,1)", fill: "backwards" });
    } else {
      const sameKind = was.tag === node.tagName + (node.className || "");
      const diff = sameKind && text.trim() ? textDiff(was.text, text) : null;
      if (diff && !diff.added.length && !diff.removedAt.length) return; // only markup moved
      if (!diff || diff.ratio > 0.6) {
        // Mostly new: a soft rewrite rather than a highlighter storm.
        penRect = endRect(node);
        flashOnLayer("ag-wash", washRect(node), [{ opacity: 0 }, { opacity: 1, offset: 0.2 }, { opacity: 0 }], { duration: 1300, delay, easing: "ease-out" }, node, () => washRect(node));
        node.animate([{ opacity: 0.25 }, { opacity: 1 }], { duration: 380, delay, easing: "ease-out", fill: "backwards" });
      } else {
        // Edited: just the new words light up, one after another, then fade.
        diff.added.forEach(([x, y], i) => {
          const r = textRange(node, x, y);
          if (!r) return;
          for (const rect of lineRects(r)) {
            flashOnLayer("ag-mark", rect, [{ opacity: 0 }, { opacity: 1, offset: 0.1 }, { opacity: 1, offset: 0.5 }, { opacity: 0 }], { duration: 1900, delay: delay + i * 45, easing: "ease-out" }, node);
          }
        });
        // Words taken out with nothing in their place: a hairline where they were.
        for (const at of diff.removedAt) {
          const rect = caretRectAt(node, at);
          if (rect) flashOnLayer("ag-tick", new DOMRect(rect.left - 1, rect.top + 1, 2, rect.height - 2), [{ opacity: 0 }, { opacity: 1, offset: 0.15 }, { opacity: 0 }], { duration: 1100, delay, easing: "ease-out" }, node);
        }
        const lastEnd = diff.added.length ? diff.added[diff.added.length - 1][1] : diff.removedAt[diff.removedAt.length - 1];
        penRect = caretRectAt(node, lastEnd) || endRect(node);
      }
    }
    if (penRect) {
      // Placed relative to its block when it fires: the page may have
      // scrolled, or the block moved, since it was measured.
      const ref = node.getBoundingClientRect();
      setTimeout(() => {
        if (!node.isConnected) return;
        const now = node.getBoundingClientRect();
        movePen(new DOMRect(penRect.left + now.left - ref.left, penRect.top + now.top - ref.top, 1, penRect.height), node);
      }, delay);
    }
  });
}

/* ═════════════════ 10. Collaboration: save, sync, connect ═══════════════ */

// Every call to the server has a time limit. A connection can die without
// anyone noticing (a laptop sleeps, Wi-Fi changes, a VPN reconnects): a call
// on it neither answers nor fails, and without a limit whatever waits on it
// -- a save, a reconnect -- would wait forever.
class TimeoutError extends Error {}
class RetryNow extends Error {}
function withTimeout<T>(promise: Promise<T>, ms: number, abort: Promise<unknown> | null = null): Promise<T> {
  let timer: number | undefined;
  const limits = [new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new TimeoutError("No answer from the server")), ms); })];
  if (abort) limits.push(abort.then(() => { throw new RetryNow(); }));
  return Promise.race([promise, ...limits]).finally(() => clearTimeout(timer));
}
// Big saves (images) and big documents legitimately take longer on a slow
// line, so each retry allows more time.
const saveTimeoutMs = (failures: number) => Math.min(45e3, 12e3 * (failures + 1));
const connectTimeoutMs = (attempt: number) => Math.min(30e3, 8e3 * (attempt + 1));

/** How a save went: sent and acknowledged, partly rejected (send again), or put off until connected. */
type SaveOutcome = "saved" | "conflict" | "deferred";
/** What the save scheduler reports, and what `setSync` shows for it. */
type SyncKind = "saving" | "saved" | "offline" | "reconnecting";
interface SaveSchedulerOptions {
  save(failures: number): Promise<SaveOutcome>;
  isDirty(): boolean;
  onStatus(kind: SyncKind): void;
  onFailure(error: unknown): void;
}

// Typing saves after a pause, and at least every MAX_WAIT_MS while it goes on,
// so other pages and the agent see a long stretch of typing before it ends.
const DEBOUNCE_MS = 220, MAX_WAIT_MS = 1200, RETRY_BASE_MS = 40, RETRY_MAX_MS = 1e4;
class SaveScheduler {
  #o: SaveSchedulerOptions; #timer: number | null = null; #inFlight = false; #again = false; #failures = 0;
  // When the pending debounce started, or null when none is pending.
  #waitingSince: number | null = null;
  constructor(options: SaveSchedulerOptions) { this.#o = options; }
  get busy() { return this.#timer !== null || this.#inFlight; }
  get failing() { return this.#failures > 0; }
  schedule(delay = DEBOUNCE_MS) {
    this.#o.onStatus("saving");
    const now = Date.now();
    this.#waitingSince ??= now;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => void this.flush(), Math.min(delay, Math.max(0, this.#waitingSince + MAX_WAIT_MS - now)));
  }
  // Skip the rest of the back-off: the network is back, the tab is visible
  // again, or the user asked.
  retryNow() {
    if (!this.#failures) return;
    this.#failures = 1;
    if (!this.#inFlight) void this.flush();
  }
  async flush() {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#waitingSince = null;
    if (this.#inFlight) { this.#again = true; return; }
    this.#inFlight = true;
    let outcome: SaveOutcome | null = null;
    try {
      outcome = await this.#o.save(this.#failures);
      // "deferred": not connected. Reconnecting saves whatever is left.
      if (outcome !== "deferred") {
        this.#failures = 0;
        this.#o.onStatus(outcome === "conflict" ? "saving" : "saved");
        if (outcome === "conflict") this.#again = true;
      }
    } catch (error) {
      this.#failures++;
      this.#again = true;
      this.#o.onFailure(error);
    } finally {
      this.#inFlight = false;
      let more = this.#again;
      this.#again = false;
      if (!more && outcome !== "deferred") { try { more = this.#o.isDirty(); } catch { more = true; } }
      if (more && outcome !== "deferred") {
        const delay = this.#failures ? Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (this.#failures + 3)) : RETRY_BASE_MS;
        if (this.#timer) clearTimeout(this.#timer);
        this.#timer = setTimeout(() => void this.flush(), delay);
      }
    }
  }
}

// Sync status is deliberately quiet: quick saves never flash anything. It
// speaks up only when a save is slow, when you ask (⌘S), or when there's
// trouble -- and a blip that heals within a moment shows nothing at all.
let syncTimer: number | null = null, syncShown: string | null = null;
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
// Trouble: "link" (not connected) or "save" (connected, but saves fail).
// Edits are never lost meanwhile: they stay on the page and go out as soon
// as the server answers again.
const TROUBLE_GRACE_MS = 1200, TROUBLE_LONG_MS = 15e3;
let trouble: "link" | "save" | null = null, troubleSince = 0, troubleTimer: number | null = null;
function noteTrouble(kind: "link" | "save") {
  if (isExport) return;
  if (!trouble) troubleSince = Date.now();
  if (trouble !== "link") trouble = kind;
  clearTimeout(troubleTimer);
  troubleTimer = setTimeout(paintTrouble, Math.max(0, troubleSince + TROUBLE_GRACE_MS - Date.now()));
}
function paintTrouble() {
  clearTimeout(troubleTimer);
  if (!trouble || pausedMode === "reload") return;
  const age = Date.now() - troubleSince;
  if (age < TROUBLE_GRACE_MS) { troubleTimer = setTimeout(paintTrouble, TROUBLE_GRACE_MS - age); return; }
  // Past a short wait, editing pauses: whatever is typed from here would only
  // pile up unsaved. Retrying carries on underneath, and editing resumes by
  // itself the moment it works.
  if (age >= TROUBLE_LONG_MS || pausedMode) { pauseEditing("trouble"); return; }
  if (navigator.onLine === false) showSync("offline", "Offline · edits kept");
  else showSync("saving", trouble === "save" ? "Saving…" : connectedOnce ? "Reconnecting…" : "Connecting…");
  troubleTimer = setTimeout(paintTrouble, TROUBLE_LONG_MS - age + 20);
}
// Trouble is over. Returns whether the user could see it.
function endTrouble() {
  const shown = !!trouble && (syncShown !== null || pausedMode === "trouble");
  trouble = null;
  clearTimeout(troubleTimer);
  resumeEditing();
  return shown;
}

// ── Editing paused ───────────────────────────────────────────────────────
// Two cases, one calm card at the bottom of the page:
//   • "trouble": can't reach the server for a while. Retrying continues, and
//     editing comes back by itself (with "Saved") as soon as it works.
//   • "reload": this page can't continue (the gadget switched versions under
//     it). Only a reload helps.
// Either way the document stays readable and copyable; nothing new can be
// typed that might be lost. Edits not yet saved can be copied on the way out.
const pauseWrap = el("div", { class: "pause-wrap" });
const pausePill = el("div", { class: "pause-pill", role: "status", "aria-live": "polite" });
pauseWrap.appendChild(pausePill);
if (!isExport) document.body.appendChild(pauseWrap);
let pausedMode: "trouble" | "reload" | null = null, pausedCaret: SavedSelection | null = null;
function pauseEditing(mode: "trouble" | "reload") {
  if (isExport || pausedMode === "reload" && mode !== "reload") return;
  if (!pausedMode) {
    pausedCaret = document.activeElement === editor ? saveSelection() : null;
    closePop(true);
    clearBlockSel({ blur: true });
    hideImageControls();
    hideHandles(true);
    hideTableUi(true);
    if (connectedOnce) editor.contentEditable = "false";
    document.body.classList.add("doc-paused");
  }
  pausedMode = mode;
  hideSync();
  renderPausePill();
}
function resumeEditing() {
  if (pausedMode !== "trouble") return;
  pausedMode = null;
  document.body.classList.remove("doc-paused");
  pausePill.classList.remove("show");
  if (connectedOnce && !isExport) editor.contentEditable = "true";
  // Pick up right where you were.
  if (pausedCaret && (!document.activeElement || document.activeElement === document.body)) {
    editor.focus({ preventScroll: true });
    restoreSelection(pausedCaret);
  }
  pausedCaret = null;
}
// The blocks holding edits the server doesn't have yet.
function unsavedUnits() {
  try {
    const ids = new Set<string | null>(computeChanges().upserts.map((b) => b.id));
    return ids.size ? unitsOf().filter((u) => ids.has(blockId(topBlockOf(u)))) : [];
  } catch { return []; }
}
function renderPausePill() {
  const reloadOnly = pausedMode === "reload";
  const unsaved = connectedOnce && unsavedUnits().length > 0;
  const label = reloadOnly ? "Reload to keep editing"
    : navigator.onLine === false ? "Offline · editing paused"
    : trouble === "save" ? "Can’t save · editing paused"
    : connectedOnce ? "Can’t connect · editing paused" : "Can’t connect";
  const kids = [el("span", { class: "pp-dot" + (reloadOnly ? " calm" : " live") }), el("span", { class: "pp-label" }, label)];
  if (!reloadOnly) {
    const retry = el("button", { type: "button", class: "pp-btn" }, "Retry");
    retry.addEventListener("click", () => {
      retry.disabled = true;
      retry.textContent = "Retrying…";
      retryNow();
      setTimeout(() => { if (retry.isConnected) { retry.disabled = false; retry.textContent = "Retry"; } }, 1600);
    });
    kids.push(retry);
  }
  // With unsaved edits, reloading copies them first, so a paste brings them back.
  const reload = el("button", { type: "button", class: "pp-btn primary" }, unsaved ? "Copy edits & reload" : "Reload");
  reload.addEventListener("click", () => {
    const units = unsaved ? unsavedUnits() : [];
    if (!units.length) { location.reload(); return; }
    copyUnits(units);
    reload.disabled = true;
    reload.textContent = "Copied · paste after reload";
    setTimeout(() => location.reload(), 1400);
  });
  kids.push(reload);
  pausePill.replaceChildren(...kids);
  pausePill.classList.add("show");
}
// A tap on the card when you try to type: "here's why".
function nudgePause() {
  if (reducedMotion.matches) return;
  pausePill.animate([{ transform: "none" }, { transform: "translateY(-3px) scale(1.03)" }, { transform: "none" }], { duration: 280, easing: "cubic-bezier(.2,.8,.2,1)" });
}
function blockWhilePaused(e: Event) {
  e.preventDefault();
  e.stopPropagation();
  nudgePause();
}
// Selecting and copying text still works; everything that would change the
// document is held off.
window.addEventListener("pointerdown", (e) => {
  if (pausedMode && e.target instanceof Element && e.target.closest(".bh, .tbl-ui, .image-controls, .bar .tb")) blockWhilePaused(e);
}, true);
window.addEventListener("keydown", (e) => {
  if (!pausedMode || pausePill.contains(e.target as Node | null)) return;
  const mod = isMac ? e.metaKey : e.ctrlKey;
  const k = e.key.toLowerCase();
  if (mod && (k === "c" || k === "a" || k === "f" || k === "p")) return;
  if (mod && k === "s") { e.preventDefault(); nudgePause(); return; }
  if (e.key.length === 1 || mod || e.key === "Backspace" || e.key === "Delete" || e.key === "Enter") blockWhilePaused(e);
}, true);
for (const type of ["paste", "cut", "drop"]) window.addEventListener(type, (e) => { if (pausedMode) blockWhilePaused(e); }, true);
// Platform errors that mean this page can't carry on, however often it retries.
// An Error, or whatever else was thrown.
const needsReload = (error: unknown) => /gadget restarted|switch(ed)? back to (the )?main version/i.test(String((error as { message?: unknown } | null | undefined)?.message || error || ""));
function stopForReload() {
  trouble = null;
  clearTimeout(troubleTimer);
  ready = false;
  pauseEditing("reload");
}
function flashSaved() {
  showSync("saved", "Saved");
  syncTimer = setTimeout(hideSync, 1300);
}
let forceSavedFlash = false;
function setSync(kind: SyncKind) {
  // While there's trouble, the status keeps saying so (even after a passing
  // message such as "Adding image…").
  if (trouble && (kind === "saving" || (kind === "saved" && (trouble === "link" || !ready)))) { if (syncShown) paintTrouble(); return; }
  if (kind === "saving") {
    if (syncShown === "offline" || syncShown === "saving") return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => showSync("saving", "Saving…"), 900);
  } else if (kind === "saved") {
    if (!ready) return;
    const shown = endTrouble() || !!syncShown || forceSavedFlash;
    clearTimeout(syncTimer);
    forceSavedFlash = false;
    if (shown) flashSaved();
  } else if (kind === "offline") {
    noteTrouble("save");
  } else if (kind === "reconnecting") {
    noteTrouble("link");
  }
}
function saveNow() {
  forceSavedFlash = true;
  if (trouble) { retryNow(); return; }
  if (saver.busy || isDirty()) { showSync("saving", "Saving…"); void saver.flush(); }
  else setSync("saved");
}
// "Retry" (and ⌘S while there's trouble): try again right away.
function retryNow() {
  if (isExport || pausedMode === "reload") return;
  if (trouble && !pausedMode) { troubleSince = Date.now() - TROUBLE_GRACE_MS; paintTrouble(); }
  if (!ready) kickConnect();
  else { saver.retryNow(); void checkConnection(); }
}


/** A remote change held back from a block the user is editing, and the HTML that block was based on before it. */
type PendingChange =
  | { type: "upsert"; block: StoredBlock; baseHtml: string | undefined }
  | { type: "delete"; baseHtml: string | undefined };
let ready = false, buffered: DocumentEvent[] = [], revision = 0, applyingRemote = false;
const acknowledged = new Map<string, { html: string; version: number }>(); // id -> { html, version } the server has confirmed
let ackOrder: string[] = []; // block order the server has confirmed
let ackOrderRevision = 0; // the revision it was confirmed at
// A save's reply can arrive after a live event from a later revision: the
// order it confirms is then older, and must not replace the event's.
function confirmOrder(order: string[], rev: number) {
  if (rev < ackOrderRevision) return;
  ackOrder = order;
  ackOrderRevision = rev;
}
const pendingByBlock = new Map<string, PendingChange>(); // id -> remote change held back from a block being edited
// id -> the draft last sent for a block and the version it rested on, until the
// reply comes. If the reply is lost, the server's copy of that very draft is
// recognized as this page's own when it comes back, rather than merged.
const sentDrafts = new Map<string, { baseVersion: number; html: string }>();
// The blocks whose save (or deletion) is in flight, and the remote changes to
// them that came meanwhile (null for a deletion). A remote version may already
// include that save, so it is applied only once the reply has said which
// version the draft became: merged against the older one, the saved text would
// be added twice. A block re-created meanwhile starts again at version 1, so
// it is told apart from the deleted one only once the deletion is confirmed.
let savingIds: Set<string> | null = null;
const heldWhileSaving = new Map<string, StoredBlock | null>();

const saver = new SaveScheduler({
  save: sendChanges, isDirty, onStatus: setSync,
  onFailure: (error) => {
    // A save that gets no answer at all means the connection is gone: start
    // over on a fresh one. Any other failure is retried on this one.
    if (needsReload(error)) stopForReload();
    else if (error instanceof TimeoutError) connectionLost();
    else { console.error(error); noteTrouble("save"); }
  }
});
function scheduleSave(delay?: number) {
  if (applyingRemote || isExport || !ready) return;
  saver.schedule(delay);
}

// Serialize the document, repairing changed blocks that wouldn't round-trip
// (not under an IME composition, whose DOM must not be replaced).
function serializeForSave(): BlockContent[] {
  normalize();
  if (!composing) for (const node of Array.from(editor.children)) {
    const html = canonicalBlockHtml(node);
    if (acknowledged.get(blockId(node)!)?.html !== html) repairBlock(node, html);
  }
  normalize();
  // normalize() has just given every block its id.
  return Array.from(editor.children, (node) => ({ id: blockId(node)!, html: canonicalBlockHtml(node) }));
}
// A block with a queued remote change is not sent as it stands. A queued
// upsert (only ever held through an IME composition) is merged in when the
// composition ends, and sending the draft first would overwrite it. A block
// deleted remotely is sent only once the user has edited it (re-creating it):
// untouched, its DOM is the pre-remote text, and sending it would silently
// revert the collaborator's deletion.
function heldBack(id: string, html: string) {
  const pending = pendingByBlock.get(id);
  return !!pending && (pending.type === "upsert" || html === pending.baseHtml);
}
// isDirty and sendChanges share this so they can never disagree.
function computeChanges() {
  const blocks = serializeForSave();
  const ids = new Set(blocks.map((b) => b.id));
  const upserts: BlockUpsert[] = blocks
    .filter((b) => acknowledged.get(b.id)?.html !== b.html && !heldBack(b.id, b.html))
    .map((b) => ({ ...b, baseVersion: acknowledged.get(b.id)?.version || 0 }));
  const deletes: BlockDeletion[] = Array.from(acknowledged.entries()).filter(([id]) => !ids.has(id)).map(([id, b]) => ({ id, baseVersion: b.version }));
  // A pure rearrangement changes no block's HTML, only their order: compare
  // the relative order of the blocks both sides know about.
  const ackSet = new Set(ackOrder);
  const localOrder = blocks.map((b) => b.id).filter((id) => ackSet.has(id)).join("\n");
  const serverOrder = ackOrder.filter((id) => ids.has(id)).join("\n");
  const reordered = localOrder !== serverOrder;
  return { blocks, upserts, deletes, dirty: upserts.length > 0 || deletes.length > 0 || reordered };
}
function isDirty() {
  return ready && computeChanges().dirty;
}
async function sendChanges(failures = 0): Promise<SaveOutcome> {
  if (!ready) return "deferred";
  settlePendingBlocks();
  const { blocks, upserts, deletes, dirty } = computeChanges();
  if (!dirty) return "saved";
  const sentOrder = blocks.map((b) => b.id);
  // If this times out, a late reply is simply dropped and the page reconnects.
  // Should the server have applied it after all, the reconnect's snapshot
  // carries this very text at the next version, and sentDrafts recognizes it
  // as this page's own: nothing is merged or written twice.
  const sent = upserts.map((b) => { const draft = { baseVersion: b.baseVersion, html: b.html }; sentDrafts.set(b.id, draft); return [b.id, draft] as const; });
  savingIds = new Set([...sent.map(([id]) => id), ...deletes.map((d) => d.id)]);
  let result: ApplyOperationResult;
  try {
    result = await withTimeout(gadget.applyOperation({ senderId: clientId, baseRevision: revision, upserts, deletes, order: sentOrder }), saveTimeoutMs(failures));
    for (const [id, draft] of sent) if (sentDrafts.get(id) === draft) sentDrafts.delete(id);
    revision = Math.max(revision, result.revision || 0);
    confirmOrder(Array.isArray(result.order) ? result.order : sentOrder, result.revision || 0);
    // A newer version may already have arrived as a live event while this reply
    // was in flight; never step a block back to an older one.
    // (An unknown block's missing version compares false.)
    const acknowledge = (b: StoredBlock) => { if (!(acknowledged.get(b.id)?.version! > b.version)) acknowledged.set(b.id, { html: b.html, version: b.version }); };
    for (const b of result.upserts || []) {
      acknowledge(b);
      // A block deleted remotely while it was being typed in, and re-created by
      // this save: the deletion is settled, and the next merge rests on the save.
      if (pendingByBlock.get(b.id)?.type === "delete") pendingByBlock.delete(b.id);
    }
    for (const id of result.deletedIds || []) acknowledged.delete(id);
  } catch (error) {
    savingIds = null;
    applyHeldChanges();
    throw error;
  }
  savingIds = null;
  // The changes held while the save was in flight are newer than the reply's
  // conflicts, so they go on top of them.
  try {
    return mergeConflicts(result);
  } finally {
    applyHeldChanges();
  }
}
function mergeConflicts(result: ApplyOperationResult): SaveOutcome {
  if (!result.conflicts?.length) return "saved";
  // A stale block is merged with the server's newer version, exactly as if
  // that version had arrived as a live event; the next send saves the merge.
  const stale: StoredBlock[] = [];
  for (const b of result.conflicts) {
    if ((b as MissingBlock).missing) acknowledged.delete(b.id);
    else stale.push(b as StoredBlock);
  }
  if (stale.length) {
    const activeId = editingBlockId();
    keepSelection(() => {
      applyingRemote = true;
      for (const b of stale) remoteUpsert(b, activeId);
      applyingRemote = false;
    });
    mergedDrafts = false; // the scheduler sends again after a conflict anyway
    afterRemoteChange();
  }
  return "conflict";
}

const activeBlockId = () => blockId(topBlockOf(window.getSelection()?.anchorNode));
const editingBlockId = () => document.activeElement === editor ? activeBlockId() : null;

// Remote blocks only reorder relative to each other; blocks this client has
// created but not yet saved stay exactly where they are (with the caret).
function applyOrder(order: string[] | undefined) {
  const byId = new Map(Array.from(editor.children, (n) => [blockId(n), n]));
  const known: HTMLElement[] = [], knownSet = new Set<Element>();
  for (const id of order || []) {
    const n = byId.get(id);
    if (n && !knownSet.has(n)) { known.push(n); knownSet.add(n); }
  }
  const inDom = Array.from(editor.children).filter((n) => knownSet.has(n));
  if (inDom.length === known.length && inDom.every((n, i) => n === known[i])) return;
  let prev: HTMLElement | null = null;
  for (const node of known) {
    let ref: Element | null = prev ? prev.nextElementSibling : editor.firstElementChild;
    while (ref && ref !== node && !knownSet.has(ref)) ref = ref.nextElementSibling;
    if (ref !== node) editor.insertBefore(node, ref);
    prev = node;
  }
}
// The baseline a pending block is compared against is the HTML the local copy
// was based on *before* the remote change.
function pendingBaseline(id: string) {
  const existing = pendingByBlock.get(id);
  return existing ? existing.baseHtml : acknowledged.get(id)?.html;
}
function applyHeldChanges() {
  if (!heldWhileSaving.size) return;
  const held = Array.from(heldWhileSaving);
  heldWhileSaving.clear();
  const activeId = editingBlockId();
  keepSelection(() => {
    applyingRemote = true;
    for (const [id, block] of held) {
      if (block) remoteUpsert(block, activeId);
      else remoteDelete(id, activeId);
    }
    applyingRemote = false;
  });
  afterRemoteChange();
  saveMergedDrafts();
}
function remoteUpsert(block: StoredBlock, activeId: string | null) {
  if (savingIds?.has(block.id)) { heldWhileSaving.set(block.id, block); return; }
  // Already have this version (or a newer one): nothing to do. (An unknown
  // block's missing version compares false.)
  if (acknowledged.get(block.id)?.version! >= block.version) return;
  let baseHtml = pendingBaseline(block.id);
  const next = parseBlock(block);
  const html = canonicalBlockHtml(next);
  // This page's own save, whose reply never came: the draft already rests on it.
  const sent = sentDrafts.get(block.id);
  if (sent && sent.baseVersion + 1 === block.version && sent.html === html && !pendingByBlock.has(block.id)) baseHtml = html;
  sentDrafts.delete(block.id);
  acknowledged.set(block.id, { html, version: block.version });
  const old = findBlock(block.id);
  // The DOM under an IME composition can't be rewritten: wait for compositionend.
  if (old && composing && block.id === activeId) {
    pendingByBlock.set(block.id, { type: "upsert", block, baseHtml });
    return;
  }
  pendingByBlock.delete(block.id);
  if (old) mergeRemoteBlock(old, baseHtml, next, html);
  else insertByServerOrder(next);
}
// A block coming back that is not on the page (deleted here while the server
// kept it) goes after the nearest block before it in the confirmed order, so the
// next save doesn't move it to the end for everyone. A block the order doesn't
// know yet is placed by applyOrder, or stays at the end.
function insertByServerOrder(node: HTMLElement) {
  const at = ackOrder.indexOf(blockId(node)!);
  const onPage = new Map(Array.from(editor.children, (n) => [blockId(n), n]));
  for (let k = at - 1; k >= 0; k--) {
    const prev = onPage.get(ackOrder[k]);
    if (prev) { prev.after(node); return; }
  }
  if (at >= 0 && editor.firstElementChild) editor.firstElementChild.before(node);
  else editor.appendChild(node);
}
function remoteDelete(id: string, activeId: string | null) {
  if (savingIds?.has(id)) { heldWhileSaving.set(id, null); return; }
  const baseHtml = pendingBaseline(id);
  acknowledged.delete(id);
  const old = findBlock(id);
  if (!old) { pendingByBlock.delete(id); return; }
  if (id === activeId || canonicalBlockHtml(old) !== baseHtml) {
    pendingByBlock.set(id, { type: "delete", baseHtml });
    return;
  }
  pendingByBlock.delete(id);
  old.remove();
}
function afterRemoteChange() {
  // Block undo snapshots hold node references; after someone else's change
  // they could put back stale content, so they are dropped.
  clearBlockHistory();
  if (selectedImage && !editor.contains(selectedImage)) hideImageControls();
  else if (selectedImage) positionImageControls();
  if (linkViewAnchor && !editor.contains(linkViewAnchor)) closePop(true);
  syncPlaceholder();
  scheduleUi();
  scheduleTabTitle();
  scheduleOutline();
}
// The newest change event applied. After a reconnect the old subscription
// may still deliver for a while beside the new one: the same event twice, or
// an older one after a newer one. Those are skipped, so nothing steps back.
let lastEventRevision = 0;
function staleEvent(rev: number | undefined) {
  if (!rev) return false;
  if (rev <= lastEventRevision) return true;
  lastEventRevision = rev;
  return false;
}
function applyRemoteOperation(event: OperationEvent) {
  if (!event || staleEvent(event.revision) || event.senderId === clientId) return;
  revision = Math.max(revision, event.revision || 0);
  const activeId = editingBlockId();
  const live = event.senderId === "agent" && liveEffectsOn() ? captureLiveEdit(event) : null;
  keepSelection(() => {
    applyingRemote = true;
    for (const b of event.upserts || []) remoteUpsert(b, activeId);
    for (const id of event.deletedIds || []) remoteDelete(id, activeId);
    applyOrder(event.order);
    if (Array.isArray(event.order)) confirmOrder(event.order, event.revision || 0);
    applyingRemote = false;
  });
  afterRemoteChange();
  saveMergedDrafts();
  if (live) { try { showLiveEdit(live); } catch {} }
}
function applySnapshot(doc: DocumentSnapshot) {
  applyingRemote = true;
  closePop(true);
  hideImageControls();
  revision = doc.revision || 0;
  lastEventRevision = revision;
  acknowledged.clear();
  pendingByBlock.clear();
  sentDrafts.clear();
  heldWhileSaving.clear();
  editor.replaceChildren(...(doc.blocks || []).map(parseBlock));
  normalize();
  for (const block of doc.blocks || []) {
    const node = findBlock(block.id);
    acknowledged.set(block.id, { html: node ? canonicalBlockHtml(node) : block.html, version: block.version });
  }
  ackOrder = (doc.blocks || []).map((b: StoredBlock) => b.id);
  ackOrderRevision = revision;
  applyingRemote = false;

  afterRemoteChange();
}
// After a reconnect, or when someone replaces the document wholesale: bring in
// what changed on the server without discarding anything typed locally.
function reconcileSnapshot(doc: DocumentSnapshot) {
  revision = Math.max(revision, doc.revision || 0);
  lastEventRevision = Math.max(lastEventRevision, doc.revision || 0);
  const activeId = editingBlockId();
  keepSelection(() => {
    applyingRemote = true;
    const serverIds = new Set<string>();
    for (const block of doc.blocks || []) {
      serverIds.add(block.id);
      const known = acknowledged.get(block.id);
      if (known && known.version === block.version) continue;
      remoteUpsert(block, activeId);
    }
    for (const id of Array.from(acknowledged.keys())) if (!serverIds.has(id)) remoteDelete(id, activeId);
    applyOrder((doc.blocks || []).map((b: StoredBlock) => b.id));
    confirmOrder((doc.blocks || []).map((b: StoredBlock) => b.id), doc.revision || 0);
    applyingRemote = false;
  });
  afterRemoteChange();
  saveMergedDrafts();
}
// Returns true when the block keeps local edits still to be saved.
function settlePendingBlock(id: string) {
  const pending = pendingByBlock.get(id);
  if (!pending) return false;
  pendingByBlock.delete(id);
  const local = findBlock(id);
  if (pending.type === "delete" && local && canonicalBlockHtml(local) !== pending.baseHtml) return true;
  applyingRemote = true;
  if (pending.type === "delete") local?.remove();
  else {
    const next = parseBlock(pending.block);
    if (local) mergeRemoteBlock(local, pending.baseHtml, next, canonicalBlockHtml(next));
    else insertByServerOrder(next);
  }
  applyingRemote = false;
  afterRemoteChange();
  const kept = mergedDrafts;
  mergedDrafts = false;
  return kept;
}
function settlePendingBlocks() {
  const activeId = editingBlockId();
  let keptDraft = false;
  keepSelection(() => {
    for (const [id, pending] of Array.from(pendingByBlock)) {
      // The block being typed in: a deletion waits until the user leaves it,
      // a change only until an IME composition ends.
      if (id === activeId && (composing || pending.type === "delete")) continue;
      if (settlePendingBlock(id)) keptDraft = true;
    }
  });
  return keptDraft;
}

// ── Merging a block changed on both sides ───────────────────────────────
// When the server's version of a block moves on while this page has unsaved
// edits to it, the two are merged word by word (lib/merge.ts) against the
// version those edits started from: changes to different words both survive,
// and where both sides changed the same words the local ones win. The merge
// replaces the block at once -- the block being typed in too, with the caret
// and selection carried through it -- except under an IME composition (see
// remoteUpsert). It is then saved like any edit, on top of the server's
// version, so every page converges on it.
let mergedDrafts = false; // a merge left local edits that still need saving
function saveMergedDrafts() {
  if (!mergedDrafts) return;
  mergedDrafts = false;
  scheduleSave();
}

// A DOM point as a merge position: the units before it in `root` (one per
// character, void element, and structural element's start; see lib/merge.ts).
function unitsBefore(root: Element, node: Node, offset: number): number {
  let count = 0;
  const walk = (parent: Node): boolean => {
    const kids = parent.childNodes;
    for (let i = 0; i < kids.length; i++) {
      if (parent === node && i === offset) return true;
      const c = kids[i];
      if (isText(c)) {
        if (c === node) { count += c.data.slice(0, offset).replaceAll(ZWSP, "").length; return true; }
        count += c.data.replaceAll(ZWSP, "").length;
      } else if (isElement(c)) {
        const tag = c.tagName.toLowerCase();
        if (VOID_TAGS.has(tag)) { if (c === node) return true; count++; continue; }
        if (!MARK_TAGS.has(tag)) count++;
        if (walk(c)) return true;
      }
    }
    return parent === node;
  };
  walk(root);
  return count;
}
// The DOM point just after `units` units of `root` (a caret sticks to what is before it).
function pointAtUnits(root: Element, units: number): Point {
  if (units <= 0) return startPoint(root);
  let count = 0;
  const walk = (parent: Node): Point | null => {
    const kids = parent.childNodes;
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i];
      if (isText(c)) {
        const len = c.data.replaceAll(ZWSP, "").length;
        if (len && count + len >= units) {
          let need = units - count, k = 0;
          while (need > 0) { if (c.data[k] !== ZWSP) need--; k++; }
          return [c, k];
        }
        count += len;
      } else if (isElement(c)) {
        const tag = c.tagName.toLowerCase();
        if (VOID_TAGS.has(tag)) { if (++count >= units) return [parent, i + 1]; continue; }
        if (!MARK_TAGS.has(tag) && ++count >= units) return startPoint(c);
        const found = walk(c);
        if (found) return found;
      }
    }
    return null;
  };
  return walk(root) ?? endPoint(root);
}
// Bring the server's newer version of a block (`next`, whose canonical HTML is
// `theirs`) into the local block, which rests on `baseHtml`.
function mergeRemoteBlock(local: HTMLElement, baseHtml: string | undefined, next: HTMLElement, theirs: string) {
  const mine = canonicalBlockHtml(local);
  if (mine === theirs) return;
  // No base to merge against (the block was never acknowledged): keep the draft.
  if (baseHtml === undefined) { mergedDrafts = true; return; }
  // Selection ends inside the block move through the merge; others stay put.
  const sel = window.getSelection();
  const ends: Point[] = sel?.rangeCount && document.activeElement === editor ? [[sel.anchorNode!, sel.anchorOffset], [sel.focusNode!, sel.focusOffset]] : [];
  const inside = ends.map(([n, o]) => local.contains(n) ? unitsBefore(local, n, o) : -1);
  if (mine === baseHtml && !inside.some((u) => u >= 0)) { local.replaceWith(next); return; }
  const merge = mergeBlockHtml(baseHtml, theirs, mine);
  if (merge.html !== theirs) mergedDrafts = true;
  if (merge.html === mine) return;
  const merged = merge.html === theirs ? next : parseBlock({ id: blockId(local)!, html: merge.html });
  local.replaceWith(merged);
  if (!inside.some((u) => u >= 0)) return;
  const [a, f] = ends.map((end, k) => inside[k] < 0 ? end : pointAtUnits(merged, merge.mapPosition(inside[k])));
  try { sel!.setBaseAndExtent(a[0], a[1], f[0], f[1]); } catch {}
}
editor.addEventListener("focusout", () => {
  setTimeout(() => {
    if (openPop?.kind === "link-view") closePop(true);
    if (settlePendingBlocks()) scheduleSave(20);
    syncPlaceholder();
  }, 0);
});
// Leaving or hiding the page saves immediately rather than after the debounce.
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden" && ready && (saver.busy || isDirty())) void saver.flush(); });
window.addEventListener("pagehide", () => { if (ready && (saver.busy || isDirty())) void saver.flush(); });

// ── Subscription & connection ───────────────────────────────────────────────
// Events that arrive before the initial (or reconnect) snapshot is applied are
// held back and replayed afterwards, so a snapshot read a moment earlier can't
// overwrite a newer edit.
function handleOperation(event: DocumentEvent) {
  if (event.type === "settings") { if (event.senderId !== clientId) applySettings(event.settings); return; }
  if (event.type === "snapshot") {
    if (staleEvent(event.document?.revision)) return;
    if (event.senderId === clientId) { revision = Math.max(revision, event.document?.revision || 0); return; }
    reconcileSnapshot(event.document);
    return;
  }
  applyRemoteOperation(event);
}
function replayBuffered() {
  const events = buffered;
  buffered = [];
  // Settings carry no revision. They arrive in the order they were made, and the
  // last one buffered is at least as new as the snapshot's, so only it is applied:
  // an earlier one would briefly undo a newer change.
  const lastSettings = events.findLastIndex((event) => event.type === "settings");
  for (const [k, event] of events.entries()) {
    if (event.type === "settings") { if (k === lastSettings) handleOperation(event); continue; }
    const r = event.type === "snapshot" ? event.document?.revision : event.revision;
    if ((r || 0) > revision) handleOperation(event);
  }
}
class Subscriber extends RpcTarget implements SubscriberCallbacks {
  // Set below: the RPC layer calls it when the server drops its handle on this subscriber.
  declare [Symbol.dispose]: () => void;
  operation(event: DocumentEvent) {
    if (!ready) { buffered.push(event); return; }
    handleOperation(event);
  }
  // Kept as a no-op so an older server build that still sends presence can't break the connection.
  presence() {}
}
const subscriber = new Subscriber();

if (isExport) {
  document.documentElement.classList.add("document-export");
  bar.remove();
  outline.remove();
  skeleton.remove();
}

let connectedOnce = false, connecting: Promise<void> | null = null;
async function loadFromServer() {
  let doc: SubscribeSnapshot | StoredDocument = await gadget.subscribe(subscriber);
  // Still the subscribe() snapshot here; only it carries the settings.
  const docSettings = (doc as SubscribeSnapshot).settings;
  if (!doc.blocks) {
    loadLegacyContent(doc.legacyContent || "");
    // loadLegacyContent() normalizes, which gives every block its id.
    doc = await gadget.initializeBlocks({ blocks: Array.from(editor.children, (n) => ({ id: blockId(n)!, html: canonicalBlockHtml(n) })), title: doc.title, senderId: clientId });
  }
  return { doc, settings: docSettings };
}
// Waiting between attempts can be cut short: wakeConnect() ends a pause
// (network back, tab visible again); kickConnect() also abandons an attempt
// still waiting for an answer (the connection just dropped again, or the
// user pressed Retry).
let wakers: (() => void)[] = [], kickers: (() => void)[] = [];
const nextWake = () => new Promise<void>((resolve) => wakers.push(resolve));
const nextKick = () => new Promise<void>((resolve) => kickers.push(resolve));
function wakeConnect() { const w = wakers; wakers = []; w.forEach((r) => r()); }
function kickConnect() { wakeConnect(); const k = kickers; kickers = []; k.forEach((r) => r()); }
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function connect(settleMs = 0) {
  ready = false;
  // The old connection is still shutting down when we hear it dropped; a
  // request sent this instant can be lost with it. Give it a moment.
  if (settleMs) await sleep(settleMs);
  for (let attempt = 0; ; attempt++) {
    try {
      const { doc, settings: docSettings } = await withTimeout(loadFromServer(), isExport ? 6e4 : connectTimeoutMs(attempt), isExport ? null : nextKick());
      if (docSettings) applySettings(docSettings);
      const firstLoad = !connectedOnce;
      if (connectedOnce) reconcileSnapshot(doc);
      else applySnapshot(doc);
      ready = true;
      if (!connectedOnce) {
        connectedOnce = true;
        skeleton.classList.add("gone");
        setTimeout(() => skeleton.remove(), 300);
        if (!isExport) editor.contentEditable = "true";
        updateTabTitle();
        rebuildOutline();
        updateToolFades();
      }
      replayBuffered();
      // Back: whatever was typed meanwhile goes out now. If the trouble was
      // visible, the status follows through to "Saved", so it's clear nothing
      // was lost.
      const wasShown = endTrouble();
      if (firstLoad) { if (wasShown) hideSync(); }
      else if (isDirty()) {
        if (wasShown) showSync("saving", "Saving…");
        scheduleSave(20);
      } else if (wasShown) flashSaved();
      else if (syncShown === "offline") hideSync();
      syncPlaceholder();
      return;
    } catch (e) {
      if (!(e instanceof RetryNow)) console.error(e);
      buffered = [];
      if (isExport) return;
      // No amount of retrying gets past this one: say so right away.
      if (needsReload(e)) { stopForReload(); return; }
      noteTrouble("link");
      if (e instanceof RetryNow) continue;
      await Promise.race([sleep(Math.min(1e4, 500 * 2 ** attempt)), nextWake()]);
    }
  }
}
function ensureConnected(settleMs = 0) {
  if (!connecting) connecting = connect(settleMs).finally(() => { connecting = null; });
  return connecting;
}
// The connection is gone (it dropped, or a call got no answer): pause saving,
// keep every edit on the page, and connect again.
function connectionLost(settleMs = 0) {
  if (isExport || pausedMode === "reload") return;
  ready = false;
  noteTrouble("link");
  if (connecting) setTimeout(kickConnect, settleMs);
  else ensureConnected(settleMs);
}
// The server's handle on our subscriber is dropped when the connection breaks;
// subscribe again so live updates keep flowing.
subscriber[Symbol.dispose] = () => connectionLost(300);

// A connection can also die silently, and that's most likely right after the
// laptop wakes or the network changes. So on those moments, a quick check
// that the server still answers -- before you type into a dead connection.
let checking = false;
async function checkConnection() {
  if (isExport || !connectedOnce || pausedMode === "reload") return;
  if (!ready) { wakeConnect(); return; }
  if (checking) return;
  checking = true;
  try { await withTimeout(gadget.getSettings(), 6e3); }
  catch (e) { if (needsReload(e)) stopForReload(); else if (ready) connectionLost(); }
  finally { checking = false; }
}
function onWake() {
  if (!ready) wakeConnect();
  else { saver.retryNow(); void checkConnection(); }
}
window.addEventListener("online", () => { if (trouble) paintTrouble(); onWake(); });
window.addEventListener("offline", () => { if (trouble) paintTrouble(); });
window.addEventListener("pageshow", (e) => { if (e.persisted) onWake(); });
let hiddenAt = 0;
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") { hiddenAt = Date.now(); return; }
  // Back after a while (or with saves failing): make sure we're still connected.
  if (!ready || saver.failing || Date.now() - hiddenAt > 30e3) onWake();
});
// Sleep detection: timers stop while the computer sleeps, so a long gap
// between ticks means it just woke up.
let lastTick = Date.now();
if (!isExport) setInterval(() => {
  const now = Date.now();
  if (now - lastTick > 20e3 && document.visibilityState === "visible") onWake();
  lastTick = now;
}, 5e3);

await ensureConnected();
if (isExport) editor.removeAttribute("contenteditable");
// Exports drop trailing empty paragraphs and headings, so blank lines at the
// end of the document can't push anything onto an extra page. (Exports never
// save, so hiding them doesn't touch the document.)
if (isExport) {
  for (let n: HTMLElement | null = editor.lastElementChild; n; n = n.previousElementSibling as HTMLElement | null) {
    const blank = /^(P|H1|H2|H3|DIV)$/.test(n.tagName) && !n.textContent.replace(/[\u200B\s\u00a0]/g, "") && !n.querySelector("img, table, hr, input");
    if (!blank) break;
    n.style.display = "none";
  }
}
// Exports are captured when this script finishes: let web fonts land first so
// the PDF's text matches the screen (but never wait more than 1.5 s).
if (isExport && document.fonts) await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 1500))]);
refreshToolbar();
