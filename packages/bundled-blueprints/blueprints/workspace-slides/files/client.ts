// ─────────────────────────────────────────────────────────────────────────────
// Slides — a calm, real-time deck builder with a warm corporate house style.
//
// The app chrome (bar, menus, tooltips, panels, status, live edits) follows
// the Docs gadget's design language exactly. The slides themselves -- the
// tokens, COMPONENTS, templates and renderer -- are the slide theme and
// are deliberately untouched by the chrome.
//
// Sections:
//   1. Helpers & platform             7. Chrome primitives (tips, menus, sheet, status)
//   2. Brand & component registry     8. Shell (bar, rail, stage, inspector)
//   3. Slide templates                9. Inspector & fields
//   4. State & server calls          10. Slide list
//   5. Slide renderer & interactions 11. Commands, navigation, keyboard
//   6. Styles (app chrome)           12. Live edits  ·  13. Collaboration & boot
// ─────────────────────────────────────────────────────────────────────────────

import type {
  Block,
  BlockInput,
  BlockPatch,
  BlockPatchEntry,
  BlockProps,
  Deck,
  DeckLogo,
  DeckLogoPatch,
  DeckPatch,
  GadgetStub,
  PropValue,
  Slide,
  SlideBackground,
  SlideLayout,
  UndoState,
} from "./lib/protocol.ts";
import { highlightColorFor } from "./lib/highlight.ts";
import { clampView, isFit, stepScale, wheelPixels, wheelZoomFactor, zoomAt, type ZoomView } from "./lib/zoom.ts";
import { parseSvgMarkup, scopeSvgIds, svgArtworkSize } from "./lib/svg.ts";
import { SLIDE_LAYOUTS, type SlideTemplate } from "./lib/layouts.ts";
import { LOGO_IMAGE_TYPES, LOGO_POSITIONS, deckLogoBox, isEmptyLogoSlot, logoAlt, logoBlockBox, logoShowsOn, newLogoBlockBox } from "./lib/logo.ts";

// The bindings the Workshop's iframe bootstrap defines before this module runs: the RPC stub to
// this gadget's Durable Object, Cap'n Web's RpcTarget for the callbacks it is handed, and, in an
// export render, the id of the format being exported.
declare const gadget: GadgetStub;
declare const RpcTarget: new () => object;

/* ═════════════════════════ 1. Helpers & platform ═════════════════════════ */

/** `el()` props: attributes, `class`, `text`, `html`, a `style` object, and `on<event>` listeners. */
interface ElProps {
  [key: `on${string}`]: ((e: Event) => void) | null | undefined;
  [key: string]: unknown;
  style?: Partial<CSSStyleDeclaration>;
}
type ElChild = Node | string | number | null | undefined | false;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: ElProps = {}, children: ElChild | ElChild[] = []): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === void 0 || value === false) continue;
    if (key === "class") node.className = String(value);
    else if (key === "text") node.textContent = String(value);
    else if (key === "html") node.innerHTML = String(value);
    else if (key === "style" && typeof value === "object") Object.assign(node.style, value);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === null || child === void 0 || child === false) continue;
    node.appendChild(typeof child === "object" ? child : document.createTextNode(String(child)));
  }
  return node;
}
// SVG element builder (used by the slide renderer, e.g. arrows).
function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, unknown> = {}, children: Array<Node | null | undefined> = []): SVGElementTagNameMap[K] {
  const e = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const k in attrs) {
    const v = attrs[k];
    if (v == null) continue;
    e.setAttribute(k, String(v));
  }
  for (const c of children || []) if (c) e.appendChild(c);
  return e;
}
function hexA(hex: string, a: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}
function escapeHtml(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  } as Record<string, string>)[ch]);
}
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
// Chrome icons: one stroke weight, one grid (same as Docs).
function ico(paths: string, size = 18): string {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}
function readFileAsDataURL(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result)), { once: true });
    reader.addEventListener("error", () => reject(reader.error ?? new Error("Could not read the image.")), { once: true });
    reader.readAsDataURL(file);
  });
}
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => resolve(image), { once: true });
    image.addEventListener("error", () => reject(new Error("That file is not an image this browser can decode.")), { once: true });
    image.src = src;
  });
}
// An RpcTarget the server can call back: one method per callback.
function createSubscriber<T extends object>(RpcTarget2: new () => object, callbacks: T): T & { [Symbol.dispose]?: () => void } {
  class Subscriber extends RpcTarget2 {
  }
  for (const [name, callback] of Object.entries(callbacks)) {
    if (typeof callback !== "function") throw new TypeError(`Subscriber callback "${name}" is not a function.`);
    Object.defineProperty(Subscriber.prototype, name, { value: callback, writable: true, configurable: true });
  }
  return new Subscriber() as T;
}

const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || "");
const coarsePointer = matchMedia("(pointer: coarse)").matches;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const narrowQuery = matchMedia("(max-width: 900px)");
const isNarrow = () => narrowQuery.matches;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Shortcut labels in each platform's own vocabulary and modifier order.
function combo(...parts: string[]): string[] {
  const key = parts.pop() as string; // every call names a key
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

const ICONS: Record<string, string> = {
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H12"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H12"/>',
  plus: '<path d="M12 5.5v13M5.5 12h13"/>',
  minus: '<path d="M5.5 12h13"/>',
  dashed: '<path d="M4 12h3M10.5 12h3M17 12h3"/>',
  compact: '<path d="M5 9.5h14M5 12h14M5 14.5h14"/><path d="M10 3.5 12 5.5l2-2M10 20.5l2-2 2 2"/>',
  textLeft: '<path d="M5 6.5h14M5 10.5h9M5 14.5h14M5 18.5h9"/>',
  textCenter: '<path d="M5 6.5h14M7.5 10.5h9M5 14.5h14M7.5 18.5h9"/>',
  textRight: '<path d="M5 6.5h14M10 10.5h9M5 14.5h14M10 18.5h9"/>',
  chevron: '<path d="m7 10 5 5 5-5"/>',
  chevronLeft: '<path d="m14.5 6-6 6 6 6"/>',
  chevronRight: '<path d="m9.5 6 6 6-6 6"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2.5"/><path d="M6.5 10h.01M10 10h.01M14 10h.01M17.5 10h.01M8 14.5h8"/>',
  more: '<circle cx="5.5" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.3" fill="currentColor" stroke="none"/>',
  pencil: '<path d="M14.5 5.5 18.5 9.5"/><path d="M4.5 19.5 5.5 15 16 4.5a2.1 2.1 0 0 1 3 3L8.5 18z"/>',
  play: '<path d="M8 5.8v12.4a.8.8 0 0 0 1.2.7l10-6.2a.8.8 0 0 0 0-1.4l-10-6.2A.8.8 0 0 0 8 5.8z"/>',
  collapse: '<path d="M9 4.5V9H4.5"/><path d="M15 4.5V9h4.5"/><path d="M9 19.5V15H4.5"/><path d="M15 19.5V15h4.5"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6A1.5 1.5 0 0 0 14 4.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/>',
  duplicate: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6A1.5 1.5 0 0 0 14 4.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/><path d="M14 11.5v5M11.5 14h5"/>',
  trash: '<path d="M4.5 7h15"/><path d="M9.5 7V5.2c0-.4.3-.7.7-.7h3.6c.4 0 .7.3.7.7V7"/><path d="m6.5 7 .8 11.3c.1.9.8 1.7 1.8 1.7h5.8c1 0 1.7-.8 1.8-1.7L17.5 7"/>',
  arrowUp: '<path d="M12 19V5.5"/><path d="m6.5 11 5.5-5.5 5.5 5.5"/>',
  arrowDown: '<path d="M12 5v13.5"/><path d="m6.5 13 5.5 5.5 5.5-5.5"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
  x: '<path d="M7 7l10 10M17 7 7 17"/>',
  upload: '<path d="M12 15.5V4.5"/><path d="m7.5 9 4.5-4.5L16.5 9"/><path d="M4.5 15v3a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-3"/>',
  sidebar: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M9.5 4.5v15"/>',
  pointer: '<path d="M6 3.8v14.6l3.9-3.7 2.8 6 2.4-1.1-2.8-5.9 5.4-.2z"/>',
  alignLeft: '<path d="M4.5 4v16"/><rect x="7.5" y="6.5" width="11" height="4" rx="1.2"/><rect x="7.5" y="13.5" width="7" height="4" rx="1.2"/>',
  alignCenter: '<path d="M12 4v16"/><rect x="5.5" y="6.5" width="13" height="4" rx="1.2"/><rect x="7.5" y="13.5" width="9" height="4" rx="1.2"/>',
  alignRight: '<path d="M19.5 4v16"/><rect x="5.5" y="6.5" width="11" height="4" rx="1.2"/><rect x="9.5" y="13.5" width="7" height="4" rx="1.2"/>',
  alignTop: '<path d="M4 4.5h16"/><rect x="6.5" y="7.5" width="4" height="11" rx="1.2"/><rect x="13.5" y="7.5" width="4" height="7" rx="1.2"/>',
  alignMiddle: '<path d="M4 12h16"/><rect x="6.5" y="5.5" width="4" height="13" rx="1.2"/><rect x="13.5" y="7.5" width="4" height="9" rx="1.2"/>',
  alignBottom: '<path d="M4 19.5h16"/><rect x="6.5" y="5.5" width="4" height="11" rx="1.2"/><rect x="13.5" y="9.5" width="4" height="7" rx="1.2"/>',
  distributeH: '<path d="M4.5 4v16M19.5 4v16"/><rect x="9.5" y="7" width="5" height="10" rx="1.2"/>',
  distributeV: '<path d="M4 4.5h16M4 19.5h16"/><rect x="7" y="9.5" width="10" height="5" rx="1.2"/>',
  sliders: '<path d="M4.5 7.5h8M17.5 7.5h2M4.5 16.5h2M11.5 16.5h8"/><circle cx="15" cy="7.5" r="2.2"/><circle cx="9" cy="16.5" r="2.2"/>',
  grid: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.6"/>',
  layoutTitle: '<rect x="3" y="5" width="18" height="14" rx="2.2"/><path d="M6.5 13.5h7.5"/><path d="M6.5 8.5h3" opacity=".5"/>',
  layoutContent: '<rect x="3" y="5" width="18" height="14" rx="2.2"/><path d="M6.5 8.6h8"/><path d="M6.5 12.2h11M6.5 15.2h7" opacity=".5"/>',
  layoutTwo: '<rect x="3" y="5" width="18" height="14" rx="2.2"/><path d="M6.5 8.6h11"/><path d="M6.5 12.2h4.3M13.2 12.2h4.3M6.5 15.2h4.3M13.2 15.2h4.3" opacity=".5"/>',
  layoutFour: '<rect x="3" y="5" width="18" height="14" rx="2.2"/><path d="M6.5 8.6h11"/><path d="M6.5 12.6h1.8M9.6 12.6h1.8M12.7 12.6h1.8M15.8 12.6h1.7" opacity=".5"/>'
};

/* ═══════════════════ 2. Brand & component registry ═══════════════════════ */
// Everything in this section is the slide theme. Do not restyle it
// to match the app chrome: slides must look identical on screen, in HTML/PDF
// export and (as far as the renderer allows) in PowerPoint.

// The orange cover artwork is an embedded PNG owned by the server (shared
// with the PowerPoint exporter); it is fetched at boot, before the first
// slide renders.
let COVER_ORANGE_PNG = "";

// Logos are the deck owner's own image. The deck logo (deck.logo, set in
// Slide settings or with setLogo) is drawn by renderSlide on every slide; the
// `logo` block puts one on a single slide:
//   • With an image (`src`): that picture, fitted into the block's box and
//     pinned to its left edge (right with `align: "right"`); see lib/logo.ts.
//   • Without one: a plain, editable wordmark, the owner's name in Inter Bold.
//     It is ordinary text, so it renders the same in every viewer and exports
//     to PowerPoint as a native text box (the pptx library's renderLogo
//     mirrors these numbers; keep them in sync). 24px at scale 1, line-height
//     1, tracked -0.02em, never wraps; "dark" is black (white slides),
//     "light" white (orange covers). With a width and `align: "right"` its
//     right edge is pinned. Older decks may carry `accentDot`, from when it
//     ended in a coloured full stop; that is ignored.
//   • Emptied (no image, `text: ""`, as the library inserts it): an "Add your
//     logo" slot while editing, which opens the image picker; nothing
//     anywhere else.
/** An inspector field: which prop it edits, and how. */
interface FieldDef {
  key: string;
  label: string;
  type: "text" | "multiline" | "number" | "select" | "checkbox" | "color" | "image" | "logo" | "svg";
  options?: string[];
  min?: number;
  max?: number;
  step?: number;
  advanced?: boolean;
}
/** One row of an in-place edited list (see bindInlineList). */
interface ListRow {
  row: HTMLElement;
  textEl: HTMLElement;
}
/** What a component's render() gets besides its props. */
interface RenderCtx {
  block: Block;
  /** The slide's background, which some colours are chosen against. */
  background: SlideBackground;
  editing: boolean;
  inlineText<E extends HTMLElement>(elem: E, propKey: string, transform?: ((raw: PropValue) => string) | null, placeholder?: string): E;
  inlineList<E extends HTMLElement>(list: E, propKey: string, makeRow: (item: string) => ListRow, maxItems?: number): E;
}
/** A block's position, size and props, as a component's defaultBlock() makes it. */
type BlockSeed = Omit<BlockInput, "type">;
/** A COMPONENTS entry. */
interface ComponentDef {
  name: string;
  defaultBlock?: () => BlockSeed;
  fields: FieldDef[];
  resizableW?: boolean;
  resizableH?: boolean;
  fullBleed?: boolean;
  render(props: BlockProps, ctx: RenderCtx): HTMLElement | SVGSVGElement;
}

var LOGO_FONT_PX = 24;
var LOGO_DEFAULT_TEXT = "Workspace";

var C = {
  page: "#f5f1eb",
  surface: "#fff9ef",
  surfaceSoft: "#fff4e6",
  text: "#2b0b05",
  muted: "#7b6254",
  subtle: "#a89082",
  border: "#ead6c4",
  borderLight: "#f2e3d5",
  orange: "#ff5f2e",
  orangeDark: "#c84724",
  blue: "#0a95ff",
  purple: "#9b3ff6",
  green: "#26a641",
  yellow: "#f5a623"
};
var TONES = ["neutral", "tangerine", "ruby"];
var toneFill: Record<string, string> = {
  neutral: "#FFFFFF",
  tangerine: "#FFFFFF",
  ruby: "#FFFFFF"
};
var toneColor: Record<string, string> = {
  neutral: "#747474",
  tangerine: "#F6821F",
  ruby: "#FF6633"
};
var FONT = "Inter, Arial, sans-serif";
var MONO = '"Apercu Mono Pro", ui-monospace, SFMono-Regular, Menlo, monospace';
var isSlidesExport = ["html", "pdf"].includes((globalThis as { gadgetExportFormatId?: string }).gadgetExportFormatId ?? "");
if (isSlidesExport) document.documentElement.classList.add("slides-export");

var COMPONENTS: Record<string, ComponentDef> = {
  sectionLabel: {
    name: "Section label",
    defaultBlock: () => ({
      x: 48,
      y: 38,
      props: { text: "NEW SECTION" }
    }),
    fields: [
      { key: "text", label: "Text", type: "text" }
    ],
    render(props, ctx) {
      return ctx.inlineText(el("div", {
        style: {
          color: "#FF6633",
          fontSize: "10px",
          fontWeight: "600",
          lineHeight: "1",
          letterSpacing: "0.05em",
          textTransform: "uppercase",
          whiteSpace: "nowrap"
        }
      }), "text");
    }
  },
  logo: {
    name: "Logo",
    defaultBlock: () => {
      // (Clear of the deck logo's corner, when there is one.)
      const { align, ...box } = newLogoBlockBox(deck.logo?.position);
      return { ...box, props: { src: "", text: "", alt: "", variant: "light", scale: 1, align } };
    },
    resizableW: true,
    resizableH: true,
    fields: [
      { key: "src", label: "Logo image", type: "logo" },
      { key: "text", label: "Wordmark (without an image)", type: "text" },
      {
        key: "variant",
        label: "Wordmark color",
        type: "select",
        options: ["light", "dark"]
      },
      {
        key: "scale",
        label: "Scale",
        type: "number",
        min: 0.4,
        max: 4,
        step: 0.05
      },
      { key: "alt", label: "Alt text", type: "text", advanced: true },
      {
        key: "align",
        label: "Align (with a width)",
        type: "select",
        options: ["left", "right"],
        advanced: true
      }
    ],
    render(props, ctx) {
      const scale = Number(props.scale) > 0 ? Number(props.scale) : 1;
      const raw = ctx.block.props || {};
      if (raw.src || isEmptyLogoSlot(raw)) {
        const box = logoBlockBox(ctx.block);
        const wrap = el("div", { style: { width: ctx.block.w != null ? "100%" : box.w + "px", height: ctx.block.h != null ? "100%" : box.h + "px" } });
        if (raw.src) {
          // (Empty for a moment while the image downloads.)
          if (props.src) wrap.appendChild(el("img", {
            src: props.src,
            alt: logoAlt(props.alt),
            draggable: "false",
            style: { width: "100%", height: "100%", objectFit: "contain", objectPosition: box.objectPosition, display: "block", pointerEvents: "none", userSelect: "none" }
          }));
        } else if (editMode) {
          Object.assign(wrap.style, {
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            boxSizing: "border-box",
            background: hexA(C.muted, 0.06),
            border: `1px dashed ${hexA(C.muted, 0.35)}`,
            borderRadius: "2px",
            color: C.subtle,
            fontSize: "10px",
            fontWeight: "700",
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            whiteSpace: "nowrap",
            overflow: "hidden"
          });
          wrap.textContent = "Add your logo";
        }
        return wrap;
      }
      const dark = props.variant === "dark";
      const wrap = el("div", {
        style: {
          fontFamily: FONT,
          fontSize: LOGO_FONT_PX * scale + "px",
          fontWeight: "700",
          lineHeight: "1",
          letterSpacing: "-0.02em",
          whiteSpace: "nowrap",
          textAlign: props.align === "right" ? "right" : "left",
          color: dark ? "#000000" : "#FFFFFF"
        }
      });
      // A logo saved without a name shows the default one.
      const unnamed = raw.text == null;
      wrap.appendChild(ctx.inlineText(el("span"), "text", (t) => escapeHtml(unnamed ? LOGO_DEFAULT_TEXT : t), LOGO_DEFAULT_TEXT));
      return wrap;
    }
  },
  title: {
    name: "Title",
    defaultBlock: () => ({
      x: 33,
      y: 197,
      w: 687,
      props: {
        text: "[TITLE]",
        fontSize: 58,
        weight: 700,
        color: "#FFFFFF",
        letterSpacing: "-0.03em",
        highlight: "",
        lineHeight: 1.1
      }
    }),
    resizableW: true,
    fields: [
      { key: "text", label: "Text", type: "multiline" },
      {
        key: "fontSize",
        label: "Font size",
        type: "number",
        min: 14,
        max: 120,
        step: 1
      },
      { key: "color", label: "Color", type: "color" },
      { key: "highlight", label: "Highlight (comma list)", type: "text", advanced: true },
      {
        key: "weight",
        label: "Weight",
        type: "select",
        options: ["400", "500", "600", "700"],
        advanced: true
      },
      { key: "letterSpacing", label: "Letter spacing", type: "text", advanced: true },
      {
        key: "lineHeight",
        label: "Line height",
        type: "number",
        min: 0.8,
        max: 2,
        step: 0.02,
        advanced: true
      }
    ],
    render(props, ctx) {
      const e = el("div", {
        style: {
          fontSize: (props.fontSize || 42) + "px",
          fontWeight: String(props.weight || 900),
          letterSpacing: props.letterSpacing || "-0.04em",
          lineHeight: String(props.lineHeight || 1.08),
          color: props.color || C.text,
          whiteSpace: "pre-wrap"
        }
      });
      // Highlighted words get the accent, or black or white where the accent
      // would be hard to read on this slide (lib/highlight.ts; the PowerPoint
      // export picks the same colour). They stay coloured while the title is
      // selected and as you type in it.
      const accent = highlightColorFor(ctx.background, String(props.color || C.text));
      ctx.inlineText(e, "text", (raw) => {
        // Mark the highlighted characters on the raw text first (the same
        // rule the PowerPoint exporter uses: each term in order, case-
        // sensitive, never overlapping an earlier match), then escape. Doing
        // it on the escaped HTML could match inside entities or the spans.
        const txt = String(raw);
        const words = [...new Set((props.highlight || "").split(",").map((s) => s.trim()).filter(Boolean))];
        const marks = new Uint8Array(txt.length);
        for (const w of words) {
          for (let at = txt.indexOf(w); at >= 0; at = txt.indexOf(w, at + w.length)) {
            if (!marks.subarray(at, at + w.length).includes(1)) marks.fill(1, at, at + w.length);
          }
        }
        let html = "";
        for (let i = 0; i < txt.length; ) {
          let j = i;
          while (j < txt.length && marks[j] === marks[i]) j++;
          const piece = escapeHtml(txt.slice(i, j));
          html += marks[i] ? `<span class="hl" style="color:${accent}">${piece}</span>` : piece;
          i = j;
        }
        return html.replace(/\n/g, "<br/>");
      });
      return e;
    }
  },
  subtitle: {
    name: "Subtitle",
    defaultBlock: () => ({
      x: 36,
      y: 533,
      w: 553,
      props: {
        text: "[SUBTITLE]",
        fontSize: 17,
        color: "#FFFFFF",
        lineHeight: 1.5,
        weight: 600
      }
    }),
    resizableW: true,
    fields: [
      { key: "text", label: "Text", type: "multiline" },
      {
        key: "fontSize",
        label: "Font size",
        type: "number",
        min: 10,
        max: 48,
        step: 1
      },
      { key: "color", label: "Color", type: "color" },
      {
        key: "weight",
        label: "Weight",
        type: "select",
        options: ["400", "500", "600", "700"],
        advanced: true
      },
      {
        key: "lineHeight",
        label: "Line height",
        type: "number",
        min: 0.9,
        max: 2,
        step: 0.05,
        advanced: true
      }
    ],
    render(props, ctx) {
      const e = el("div", {
        style: {
          color: props.color || C.muted,
          fontSize: (props.fontSize || 19) + "px",
          lineHeight: String(props.lineHeight || 1.5),
          fontWeight: String(props.weight || 500),
          whiteSpace: "pre-wrap"
        }
      });
      return ctx.inlineText(e, "text");
    }
  },
  text: {
    name: "Text block",
    defaultBlock: () => ({
      x: 100,
      y: 200,
      w: 400,
      props: {
        text: "Text",
        fontSize: 19,
        color: "#000000",
        weight: 400,
        family: "sans",
        align: "left",
        lineHeight: 1.6
      }
    }),
    resizableW: true,
    fields: [
      { key: "text", label: "Text", type: "multiline" },
      {
        key: "fontSize",
        label: "Font size",
        type: "number",
        min: 8,
        max: 96,
        step: 1
      },
      { key: "color", label: "Color", type: "color" },
      {
        key: "align",
        label: "Align",
        type: "select",
        options: ["left", "center", "right"]
      },
      {
        key: "weight",
        label: "Weight",
        type: "select",
        options: ["400", "500", "600", "700"],
        advanced: true
      },
      {
        key: "lineHeight",
        label: "Line height",
        type: "number",
        min: 0.9,
        max: 2,
        step: 0.05,
        advanced: true
      }
    ],
    render(props, ctx) {
      const e = el("div", {
        style: {
          fontFamily: FONT,
          fontSize: (props.fontSize || 19) + "px",
          fontWeight: String(props.weight || 400),
          color: props.color || "#000000",
          textAlign: props.align || "left",
          lineHeight: String(props.lineHeight || 1.6),
          // Not in Format, but agents set it and the exporter honours it.
          letterSpacing: props.letterSpacing || "normal",
          whiteSpace: "pre-wrap"
        }
      });
      return ctx.inlineText(e, "text");
    }
  },
  bulletList: {
    name: "Bullet list",
    defaultBlock: () => ({
      x: 36,
      y: 204,
      w: 850,
      props: {
        text: "First complete sentence.\nSecond complete sentence.\nThird complete sentence.",
        treatment: "primary"
      }
    }),
    resizableW: true,
    fields: [
      { key: "text", label: "One item per line", type: "multiline" },
      {
        key: "treatment",
        label: "Treatment",
        type: "select",
        options: ["primary", "compact"]
      }
    ],
    render(props, ctx) {
      const compact = props.treatment === "compact";
      const size = compact ? 17 : 19;
      const itemGap = compact ? 8 : 10;
      const list = el("div", {
        style: {
          width: "100%",
          display: "flex",
          flexDirection: "column",
          gap: itemGap + "px",
          fontFamily: FONT
        }
      });
      const makeRow = (item: string) => {
        const row = el("div", {
          style: {
            display: "flex",
            alignItems: "flex-start",
            gap: "12px",
            width: "100%"
          }
        });
        row.appendChild(el("span", {
          style: {
            width: "6px",
            height: "6px",
            flex: "0 0 6px",
            marginTop: compact ? "7px" : "8px",
            borderRadius: "50%",
            background: "#F6821F"
          }
        }));
        const textEl = el("div", {
          text: item,
          style: {
            flex: "1",
            minWidth: "0",
            fontSize: size + "px",
            fontWeight: "400",
            lineHeight: compact ? "1.45" : "1.5",
            color: "#000000",
            textAlign: "left"
          }
        });
        row.appendChild(textEl);
        return { row, textEl };
      };
      return ctx.inlineList(list, "text", makeRow, 6);
    }
  },
  card: {
    name: "Card",
    defaultBlock: () => ({
      x: 100,
      y: 240,
      w: 280,
      h: 260,
      props: {
        tone: "neutral",
        topStripe: false,
        eyebrow: "EYEBROW",
        title: "Card title",
        body: "Body copy goes here."
      }
    }),
    resizableW: true,
    resizableH: true,
    fields: [
      { key: "tone", label: "Tone", type: "select", options: TONES },
      { key: "topStripe", label: "Top stripe", type: "checkbox" },
      { key: "eyebrow", label: "Eyebrow", type: "text" },
      { key: "title", label: "Title", type: "text" },
      { key: "body", label: "Body", type: "multiline" }
    ],
    render(props, ctx) {
      const tone = toneFill[String(props.tone)] ? String(props.tone) : "neutral";
      const fill = toneFill[tone];
      const wrap = el("div", {
        style: {
          position: "relative",
          width: "100%",
          height: "100%",
          boxSizing: "border-box",
          padding: "20px",
          borderRadius: "2px",
          background: fill,
          border: "1px solid #E5E5E5",
          boxShadow: "none",
          display: "flex",
          flexDirection: "column",
          gap: "12px",
          overflow: "hidden"
        }
      });
      if (props.eyebrow || ctx.editing) {
        wrap.appendChild(ctx.inlineText(el("div", {
          style: {
            color: "#FF6633",
            fontSize: "10px",
            fontWeight: "600",
            letterSpacing: "0.05em",
            textTransform: "uppercase",
            lineHeight: "1.2"
          }
        }), "eyebrow", null, "Eyebrow"));
      }
      wrap.appendChild(ctx.inlineText(el("div", {
        style: {
          fontSize: "18px",
          fontWeight: "600",
          letterSpacing: "-0.02em",
          lineHeight: "1.3",
          color: "#000000"
        }
      }), "title", null, "Card title"));
      wrap.appendChild(ctx.inlineText(el("div", {
        style: {
          fontSize: "15px",
          lineHeight: "1.5",
          color: "#747474",
          fontWeight: "400",
          whiteSpace: "pre-wrap"
        }
      }), "body", null, "Body copy"));
      return wrap;
    }
  },
  box: {
    name: "Diagram box",
    defaultBlock: () => ({
      x: 200,
      y: 320,
      w: 220,
      h: 110,
      props: { tone: "neutral", title: "Box", body: "", dashed: false }
    }),
    resizableW: true,
    resizableH: true,
    fields: [
      { key: "tone", label: "Tone", type: "select", options: TONES },
      { key: "dashed", label: "Dashed border", type: "checkbox" },
      { key: "title", label: "Title", type: "text" },
      { key: "body", label: "Body", type: "multiline" }
    ],
    render(props, ctx) {
      const tone = toneFill[String(props.tone)] ? String(props.tone) : "neutral";
      const fill = toneFill[tone];
      const wrap = el("div", {
        style: {
          width: "100%",
          height: "100%",
          boxSizing: "border-box",
          padding: "14px",
          borderRadius: "2px",
          background: fill,
          border: `${props.dashed ? "1px dashed" : "1px solid"} #E5E5E5`,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center"
        }
      });
      wrap.appendChild(ctx.inlineText(el("div", {
        style: {
          fontSize: "16px",
          fontWeight: "600",
          letterSpacing: "-0.02em",
          color: "#000000",
          lineHeight: "1.3"
        }
      }), "title", null, "Box title"));
      if (props.body || ctx.editing) {
        wrap.appendChild(ctx.inlineText(el("div", {
          style: {
            marginTop: "6px",
            fontSize: "14px",
            color: "#747474",
            fontWeight: "400",
            lineHeight: "1.45"
          }
        }), "body", null, "Body"));
      }
      return wrap;
    }
  },
  tonePill: {
    name: "Tone pill",
    defaultBlock: () => ({
      x: 100,
      y: 200,
      props: { tone: "tangerine", text: "LABEL" }
    }),
    fields: [
      { key: "tone", label: "Tone", type: "select", options: TONES },
      { key: "text", label: "Text", type: "text" }
    ],
    render(props, ctx) {
      // Unknown tones (e.g. from an agent or an older deck) fall back, like
      // the PowerPoint exporter's.
      const tone = toneColor[String(props.tone)] ? String(props.tone) : "tangerine";
      const e = el("div", {
        style: {
          display: "inline-block",
          padding: "5px 12px",
          borderRadius: "999px",
          background: hexA(toneColor[tone], 0.12),
          color: toneColor[tone],
          fontSize: "11px",
          fontWeight: "850",
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          whiteSpace: "nowrap"
        }
      });
      return ctx.inlineText(e, "text");
    }
  },
  divider: {
    name: "Divider",
    defaultBlock: () => ({
      x: 100,
      y: 360,
      w: 400,
      h: 2,
      props: { color: C.border, opacity: 1 }
    }),
    resizableW: true,
    resizableH: true,
    fields: [
      { key: "color", label: "Color", type: "color" },
      {
        key: "opacity",
        label: "Opacity",
        type: "number",
        min: 0,
        max: 1,
        step: 0.05
      }
    ],
    render(props) {
      return el("div", {
        style: {
          width: "100%",
          height: "100%",
          background: props.color || C.border,
          opacity: String(props.opacity ?? 1),
          borderRadius: "1px"
        }
      });
    }
  },
  shape: {
    name: "Shape",
    defaultBlock: () => ({
      x: 200,
      y: 200,
      w: 200,
      h: 200,
      props: {
        kind: "rect",
        fill: "#FFFFFF",
        stroke: "#E5E5E5",
        strokeWidth: 1,
        radius: 2,
        opacity: 1
      }
    }),
    resizableW: true,
    resizableH: true,
    fields: [
      {
        key: "kind",
        label: "Kind",
        type: "select",
        options: ["rect", "ellipse"]
      },
      { key: "fill", label: "Fill", type: "color" },
      { key: "stroke", label: "Stroke", type: "color" },
      {
        key: "opacity",
        label: "Opacity",
        type: "number",
        min: 0,
        max: 1,
        step: 0.05
      },
      {
        key: "strokeWidth",
        label: "Stroke width",
        type: "number",
        min: 0,
        max: 12,
        step: 1,
        advanced: true
      },
      {
        key: "radius",
        label: "Corner radius",
        type: "number",
        min: 0,
        max: 200,
        step: 1,
        advanced: true
      }
    ],
    render(props) {
      return el("div", {
        style: {
          width: "100%",
          height: "100%",
          background: props.fill || "transparent",
          border: `${props.strokeWidth || 0}px solid ${props.stroke || "transparent"}`,
          borderRadius: props.kind === "ellipse" ? "50%" : (props.radius || 0) + "px",
          opacity: String(props.opacity ?? 1),
          boxSizing: "border-box"
        }
      });
    }
  },
  image: {
    name: "Image",
    defaultBlock: () => ({
      x: 600,
      y: 0,
      w: 600,
      h: 675,
      props: { src: "", fit: "cover", radius: 0, alt: "" }
    }),
    resizableW: true,
    resizableH: true,
    fields: [
      // Custom field type — implemented in renderField(). Renders a
      // preview + upload button + data: URI input + clear, and writes the
      // resulting data: URL into `src`.
      { key: "src", label: "Source", type: "image" },
      {
        key: "fit",
        label: "Fit",
        type: "select",
        options: ["contain", "cover", "fill"]
      },
      {
        key: "radius",
        label: "Radius",
        type: "number",
        min: 0,
        max: 200,
        step: 1,
        advanced: true
      },
      { key: "alt", label: "Alt text", type: "text", advanced: true }
    ],
    render(props) {
      const wrap = el("div", {
        style: {
          width: "100%",
          height: "100%",
          overflow: "hidden",
          borderRadius: (props.radius || 0) + "px",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: props.src ? "transparent" : hexA(C.muted, 0.06),
          border: props.src ? "none" : `1px dashed ${hexA(C.muted, 0.35)}`,
          boxSizing: "border-box"
        }
      });
      if (props.src) {
        wrap.appendChild(el("img", {
          src: props.src,
          alt: props.alt || "",
          draggable: "false",
          style: {
            width: "100%",
            height: "100%",
            objectFit: props.fit || "contain",
            display: "block",
            pointerEvents: "none",
            userSelect: "none"
          }
        }));
      } else {
        wrap.appendChild(el("div", {
          text: "No image",
          style: {
            color: C.subtle,
            fontSize: "11px",
            fontWeight: "700",
            letterSpacing: "0.08em",
            textTransform: "uppercase"
          }
        }));
      }
      return wrap;
    }
  },
  svg: {
    name: "SVG",
    defaultBlock: () => ({
      x: 100,
      y: 180,
      w: 600,
      h: 337.5,
      props: { markup: "", fit: "contain", background: "" }
    }),
    resizableW: true,
    resizableH: true,
    fields: [
      { key: "markup", label: "SVG markup", type: "svg" },
      {
        key: "fit",
        label: "Fit",
        type: "select",
        options: ["contain", "stretch"]
      },
      { key: "background", label: "Background", type: "color", advanced: true }
    ],
    render(props) {
      const wrap = el("div", {
        style: {
          width: "100%",
          height: "100%",
          background: props.background || "transparent",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
          boxSizing: "border-box",
          borderRadius: "2px"
        }
      });
      const raw = (props.markup || "").trim();
      const isBrandBar = isBrandBarMarkup(raw);
      if (isBrandBar) {
        wrap.style.background = "linear-gradient(90deg, #FF6633 0%, #F6821F 50%, #FBAD41 100%)";
      }
      if (!raw) {
        wrap.style.border = `1px dashed ${hexA(C.muted, 0.35)}`;
        wrap.style.background = hexA(C.muted, 0.06);
        wrap.appendChild(el("div", {
          text: "Paste SVG markup",
          style: {
            color: C.subtle,
            fontSize: "11px",
            fontWeight: "700",
            letterSpacing: "0.08em",
            textTransform: "uppercase"
          }
        }));
        return wrap;
      }
      const node = parseSvgMarkup(raw);
      if (!node) {
        wrap.appendChild(el("div", {
          text: "Invalid SVG",
          style: { color: C.orange, fontSize: "12px", fontWeight: "700" }
        }));
        return wrap;
      }
      scopeSvgIds(node);
      svgArtworkSize(node);
      node.setAttribute("width", "100%");
      node.setAttribute("height", "100%");
      node.setAttribute(
        "preserveAspectRatio",
        props.fit === "stretch" ? "none" : "xMidYMid meet"
      );
      node.style.display = "block";
      node.style.pointerEvents = "none";
      wrap.appendChild(node);
      return wrap;
    }
  },
  arrow: {
    name: "Arrow",
    // Arrows live in a full-bleed SVG; x/y are ignored but the endpoints
    // are in props.
    fullBleed: true,
    defaultBlock: () => ({
      x: 0,
      y: 0,
      props: {
        x1: 200,
        y1: 400,
        x2: 600,
        y2: 400,
        color: "muted",
        label: "",
        dashed: false,
        width: 2
      }
    }),
    fields: [
      { key: "label", label: "Label", type: "text" },
      {
        key: "color",
        label: "Color",
        type: "select",
        options: ["muted", "tangerine", "ruby"]
      },
      { key: "dashed", label: "Dashed", type: "checkbox" },
      {
        key: "width",
        label: "Width",
        type: "number",
        min: 1,
        max: 8,
        step: 0.5,
        advanced: true
      },
      {
        key: "x1",
        label: "From X",
        type: "number",
        min: 0,
        max: 1200,
        advanced: true
      },
      {
        key: "y1",
        label: "From Y",
        type: "number",
        min: 0,
        max: 675,
        advanced: true
      },
      {
        key: "x2",
        label: "To X",
        type: "number",
        min: 0,
        max: 1200,
        advanced: true
      },
      {
        key: "y2",
        label: "To Y",
        type: "number",
        min: 0,
        max: 675,
        advanced: true
      }
    ],
    render(props) {
      const color = ({
        muted: "#747474",
        tangerine: "#F6821F",
        ruby: "#FF6633"
      } as Record<string, string>)[String(props.color)] || "#747474";
      const svgEl = svg("svg", {
        width: 1200,
        height: 675,
        viewBox: "0 0 1200 675",
        style: "position:absolute;left:0;top:0;pointer-events:none;width:1200px;height:675px;"
      });
      const defs = svg("defs");
      const marker = svg("marker", {
        id: "ah-" + Math.random().toString(36).slice(2, 8),
        markerWidth: "10",
        markerHeight: "10",
        refX: "8",
        refY: "3",
        orient: "auto",
        markerUnits: "strokeWidth"
      }, [svg("path", { d: "M0,0 L0,6 L9,3 z", fill: color })]);
      defs.appendChild(marker);
      svgEl.appendChild(defs);
      const line = svg("line", {
        x1: props.x1,
        y1: props.y1,
        x2: props.x2,
        y2: props.y2,
        stroke: color,
        "stroke-width": String(props.width || 2),
        opacity: "0.85",
        "marker-end": `url(#${marker.getAttribute("id")})`,
        "stroke-linecap": "round"
      });
      if (props.dashed) line.setAttribute("stroke-dasharray", "6 6");
      svgEl.appendChild(line);
      if (props.label) {
        const mx = (Number(props.x1) + Number(props.x2)) / 2;
        const my = (Number(props.y1) + Number(props.y2)) / 2 - 8;
        const t = svg("text", {
          x: mx,
          y: my,
          "text-anchor": "middle",
          fill: color,
          "font-size": "12",
          "font-weight": "800",
          "font-family": FONT,
          "letter-spacing": "0.02em"
        });
        t.textContent = props.label;
        svgEl.appendChild(t);
      }
      return svgEl;
    }
  }
};
var PALETTE_ORDER = [
  "title",
  "subtitle",
  "text",
  "bulletList",
  "sectionLabel",
  "card",
  "box",
  "image",
  "svg",
  "logo",
  "tonePill",
  "divider",
  "shape",
  "arrow"
];
var COMPONENT_CATEGORIES = [
  { name: "Text", types: ["title", "subtitle", "text", "bulletList", "sectionLabel"] },
  { name: "Containers", types: ["card", "box"] },
  { name: "Media", types: ["image", "svg", "logo"] },
  { name: "Decoration", types: ["tonePill", "divider", "shape"] },
  { name: "Diagram", types: ["arrow"] }
];
var COMP_DESC: Record<string, string> = {
  title: "Display headline",
  subtitle: "Supporting copy",
  text: "Free-form text",
  bulletList: "Corporate bullet list",
  sectionLabel: "Section eyebrow",
  card: "Tonal card",
  box: "Diagram block",
  image: "Uploaded picture",
  svg: "Pasted SVG markup",
  tonePill: "Inline pill",
  divider: "Horizontal rule",
  shape: "Rect or ellipse",
  arrow: "Connector",
  logo: "Your logo image"
};
var COMP_ICON: Record<string, string> = {
  logo: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><rect x="2" y="4.5" width="12" height="7" rx="1.5" stroke-dasharray="2 1.6"/><path d="M5.5 9.5 8 6.5l2.5 3"/></svg>`,
  title: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M2.5 4h11M8 4v9"/></svg>`,
  subtitle: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 6.5h8M8 6.5v5.5"/></svg>`,
  text: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M3 5h10M3 8h10M3 11h6"/></svg>`,
  bulletList: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="3" cy="4.5" r=".8" fill="currentColor" stroke="none"/><circle cx="3" cy="8" r=".8" fill="currentColor" stroke="none"/><circle cx="3" cy="11.5" r=".8" fill="currentColor" stroke="none"/><path d="M6 4.5h7M6 8h7M6 11.5h7"/></svg>`,
  sectionLabel: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="3.5" cy="8" r="0.9" fill="currentColor" stroke="none"/><path d="M6.5 8h7"/></svg>`,
  card: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><rect x="2.5" y="2.5" width="11" height="11" rx="1.8"/><path d="M2.5 6h11"/></svg>`,
  box: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-dasharray="2 1.6"><rect x="2.5" y="3.5" width="11" height="9" rx="1.5"/></svg>`,
  tonePill: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="1.5" y="5.5" width="13" height="5" rx="2.5"/></svg>`,
  divider: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M2 8h12"/></svg>`,
  shape: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="8" cy="8" r="5"/></svg>`,
  arrow: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 8h10"/><path d="M9 4.5 12.5 8 9 11.5"/></svg>`,
  image: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><rect x="2" y="3" width="12" height="10" rx="1.5"/><circle cx="6" cy="7" r="1.2"/><path d="m2.5 12 3.5-3 3 2.5 2-1.5 2.5 2"/></svg>`,
  svg: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4.5 2.5 8 6 11.5"/><path d="M10 4.5 13.5 8 10 11.5"/></svg>`
};
// The content-slide brand bar (drawn natively, as a gradient, everywhere).
function isBrandBarMarkup(raw: string): boolean {
  return /viewBox=["']0 0 1200 12["']/.test(raw) && raw.includes("#FF6633") && raw.includes("#F6821F") && raw.includes("#FBAD41");
}

/* ═════════════════════════ 3. Slide templates ════════════════════════════ */
// The "New slide" menu: each layout (lib/layouts.ts) as the editor offers it.
const LAYOUTS: Array<{ key: SlideLayout; label: string; sub: string; icon: string }> = [
  { key: "title", label: "Title slide", sub: "Orange cover", icon: "layoutTitle" },
  { key: "content", label: "Narrative", sub: "Standard content slide", icon: "layoutContent" },
  { key: "twoColumn", label: "Two columns", sub: "Side-by-side comparison", icon: "layoutTwo" },
  { key: "fourColumn", label: "Four columns", sub: "Compact structured overview", icon: "layoutFour" }
];
function DotGrid(opacity = 0.42): HTMLDivElement {
  return el("div", {
    style: {
      position: "absolute",
      inset: "0",
      opacity: String(opacity),
      backgroundImage: "radial-gradient(circle, #fff7ef 1.5px, transparent 1.5px)",
      backgroundSize: "38px 36px",
      backgroundPosition: "30px 18px",
      pointerEvents: "none"
    }
  });
}

/* ═══════════════════════ 4. State & server calls ═════════════════════════ */

var deck: Deck = { slides: [] };
var currentIndex = 0;
var editMode = false;
var presenting = false;
var selectedBlockId: string | null = null;
var stageScale = 1;
// The editor's zoom (lib/zoom.ts): null shows the whole slide (fit); else the
// slide's on-screen scale and pan. It stays as you move between slides and
// resize the window (never below fit); presenting always fits.
var zoomView: ZoomView | null = null;
var fitScale = 1;
var advancedOpen = false;
var librarySearch = "";
var libActive = 0;
var slideSearch = "";
var clipboardBlocks: BlockInput[] = [];
// Selection: `selection` holds every selected block id. `selectedBlockId` is
// that id when exactly one block is selected (inline text editing, resize
// handles and the Format panel work on one block), and null otherwise.
var selection = new Set<string>();
// The Format panel opens only when asked (the floating bar's Format button
// or Enter) and closes again on deselect.
var inspectorOpen = false;
// Select tool (V): plain clicks add to / remove from the selection and
// text is not editable in place, so blocks are easy to grab and group.
var selectTool = false;
function setSelection(ids: Iterable<string>): void {
  selection = new Set(ids);
  selectedBlockId = selection.size === 1 ? [...selection][0] : null;
  if (!selection.size) inspectorOpen = false;
}
function selectedBlocks(slide: Slide | null = currentSlide()): Block[] {
  return slide ? slide.blocks.filter((b) => selection.has(b.id)) : [];
}
var canUndo = false;
var canRedo = false;
var stageRef: { el: HTMLDivElement | null; wrap: HTMLElement | null } = { el: null, wrap: null };
/** The shell's long-lived elements, filled in by mountShell(). */
interface ShellRefs {
  root?: HTMLDivElement;
  bar?: HTMLElement;
  tools?: HTMLDivElement;
  rail?: HTMLElement;
  inspector?: HTMLElement;
  inspectorBody?: HTMLDivElement;
  slideList?: HTMLDivElement;
  railCount?: HTMLSpanElement;
  railFoot?: HTMLDivElement;
  stage?: HTMLDivElement;
  stageWrap?: HTMLElement;
  plate?: HTMLDivElement;
  exitBtn?: HTMLButtonElement;
  presentNote?: HTMLDivElement;
  printDeck?: HTMLDivElement;
  undoBtn?: HTMLButtonElement;
  redoBtn?: HTMLButtonElement;
  railBtn?: HTMLButtonElement;
  selectBtn?: HTMLButtonElement;
  insertBtn?: HTMLButtonElement;
  editBtn?: HTMLButtonElement;
  editLabel?: HTMLSpanElement;
  presentBtn?: HTMLButtonElement;
  counterNow?: HTMLSpanElement;
  counterOf?: HTMLSpanElement;
  updateToolFades?: () => void;
  fit?: () => void;
  zoomCtl?: HTMLDivElement;
  zoomLabel?: HTMLSpanElement;
}
var shellRef: ShellRefs = {};
let ready = false;
let lastUserNav = 0;
let stageStale = false, inspectorStale = false;
const THUMB_W = 108;
let railOpen = true;

// Every mutation goes through `api.<method>(...)`. It is the server method of
// the same name, plus two things: the quiet sync status, and a count of this
// tab's own calls in flight. A deck change that arrives while none of ours is
// in flight came from somewhere else -- an agent, or another tab -- and is
// shown landing (see "12. Live edits").
let localPending = 0;
// Calls that don't add an undo step. Everything else is an edit.
const NON_EDIT_METHODS = new Set(["undo", "redo", "subscribe", "listSlides"]);
const isEditMethod = (method: string) => !NON_EDIT_METHODS.has(method) && !method.startsWith("get");

// ── Media assets ──
// Big media (inlined images, large SVG markup) is kept out of the deck: the
// server stores it once, by content hash, and the block's prop holds
// "asset:<hash>". The bytes are fetched once per session (getAsset) and
// resolved at render time. What counts as big must match server.ts's
// `shouldExternalize`.
const ASSET_REF = "asset:";
const ASSET_MIN_LENGTH = 2048;
const assetCache = new Map<string, string>(); // hash -> the media itself
const assetLoads = new Map<string, Promise<void>>(); // hash -> in-flight fetch
const assetSeeds = new Set<Promise<void>>(); // in-flight hashing of media this tab is saving
const refHash = (v: unknown) => typeof v === "string" && v.startsWith(ASSET_REF) ? v.slice(ASSET_REF.length) : null;
const shouldExternalize = (key: string, v: unknown): v is string => typeof v === "string" && v.length >= ASSET_MIN_LENGTH && !v.startsWith(ASSET_REF) && (key === "src" || key === "markup" || v.startsWith("data:"));
async function hashString(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  let hex = "";
  for (const byte of new Uint8Array(digest, 0, 16)) hex += byte.toString(16).padStart(2, "0");
  return hex;
}
// A prop value as stored (refs become their data; anything else is as-is).
function assetRaw(v: string): string;
function assetRaw(v: PropValue | null | undefined): PropValue | null | undefined;
function assetRaw(v: PropValue | null | undefined): PropValue | null | undefined {
  const h = refHash(v);
  return h ? assetCache.get(h) ?? "" : v;
}
// Block props with asset refs resolved, for rendering (same object if none).
function resolveProps(props: BlockProps): BlockProps {
  let out: BlockProps | null = null;
  for (const k in props) {
    const v = props[k];
    if (!refHash(v)) continue;
    out ??= { ...props };
    out[k] = String(assetRaw(v));
  }
  return out || props;
}
// The deck logo's image, as the media walks below take it: a slide of one image.
function logoMedia(logo: DeckLogo | null | undefined): Slide[] {
  return logo ? [{ id: "", background: {}, blocks: [{ id: "", type: "image", x: 0, y: 0, props: { src: logo.src } }] }] : [];
}
function missingAssets(slides: Array<Slide | null | undefined>): Set<string> {
  const need = new Set<string>();
  for (const s of slides) {
    for (const b of s?.blocks || []) {
      const p = b?.props;
      if (!p || typeof p !== "object") continue;
      for (const k in p) {
        const h = refHash(p[k]);
        if (h && !assetCache.has(h)) need.add(h);
      }
    }
  }
  return need;
}
// Fetch whatever these slides reference that this tab doesn't have yet.
async function ensureAssets(slides: Array<Slide | null | undefined>): Promise<void> {
  if (assetSeeds.size) await Promise.allSettled([...assetSeeds]);
  await Promise.all([...missingAssets(slides)].map((h) => {
    let load = assetLoads.get(h);
    if (!load) {
      load = gadget.getAsset(ASSET_REF + h).then(
        (raw) => { if (!assetCache.has(h)) assetCache.set(h, typeof raw === "string" ? raw : ""); },
        (e) => console.error(e)
      ).finally(() => assetLoads.delete(h));
      assetLoads.set(h, load);
    }
    return load;
  }));
}
// Media this tab is about to save is cached under the hash the server will
// give it, so the change coming back doesn't download it again.
function seedAssets(value: unknown, key = "", depth = 0): void {
  if (value == null || depth > 8) return;
  if (typeof value === "string") {
    if (!shouldExternalize(key, value) || !globalThis.crypto?.subtle) return;
    const seed = hashString(value)
      .then((h) => { if (!assetCache.has(h)) assetCache.set(h, value); })
      .catch(() => {})
      .finally(() => assetSeeds.delete(seed));
    assetSeeds.add(seed);
    return;
  }
  if (typeof value !== "object") return;
  if (Array.isArray(value)) for (const v of value) seedAssets(v, key, depth + 1);
  else for (const k in value) seedAssets((value as Record<string, unknown>)[k], k, depth + 1);
}

/** A server method's reply through `call()`: null when the call failed. */
type CallResult<K extends keyof GadgetStub> = Awaited<ReturnType<GadgetStub[K]>> | null;

async function call<K extends keyof GadgetStub>(method: K, ...args: Parameters<GadgetStub[K]>): Promise<CallResult<K>> {
  // Nudges waiting to be saved go first (see nudgeSelected).
  if (nudgePending.size) flushNudges();
  // Any other change, undo included, supersedes where nudges put blocks: the
  // broadcasts from here on are the server's word.
  if (!sendingNudges && (isEditMethod(method) || method === "undo" || method === "redo")) nudgeLocal.clear();
  if (isEditMethod(method)) seedAssets(args);
  localPending++;
  // An edit is undoable the moment it is made: light up undo now rather than
  // waiting for the server's broadcast (which corrects it if need be).
  if (isEditMethod(method)) {
    canUndo = true;
    canRedo = false;
    updateUndoButtons();
  }
  setSync("saving");
  let ok = true;
  try {
    // (TypeScript can't relate a method to its own parameter list through a key union.)
    return await (gadget[method] as (...a: Parameters<GadgetStub[K]>) => ReturnType<GadgetStub[K]>)(...args);
  } catch (e) {
    // The gadget stub waits out reconnects, so a failed call was refused
    // (e.g. a file too large to store). Nothing retries it: say so, and
    // re-read the deck so what's on screen is what was saved, not the local
    // change that wasn't.
    ok = false;
    console.error(e);
    setSync("failed");
    if (isEditMethod(method) || method === "undo" || method === "redo") {
      refreshUndoState();
      if (ready) resync();
    }
    return null;
  } finally {
    // The broadcast for our own change can trail the reply by a moment.
    setTimeout(() => {
      localPending = Math.max(0, localPending - 1);
      if (ok && localPending === 0) setSync("saved");
    }, 150);
  }
}
const api = new Proxy({}, {
  // (Each method's own parameters are checked by the type below; `call` sees them as a list.)
  get: (_, method) => (...args: unknown[]) => (call as (m: keyof GadgetStub, ...a: unknown[]) => Promise<unknown>)(method as keyof GadgetStub, ...args)
}) as { [K in keyof GadgetStub]: (...args: Parameters<GadgetStub[K]>) => Promise<CallResult<K>> };

/* ═══════════════════ 5. Slide renderer & interactions ════════════════════ */

function currentSlide(): Slide | null {
  return deck.slides[currentIndex] || null;
}
function slideText(slide: Slide): string {
  const parts: string[] = [];
  for (const b of slide.blocks || []) {
    const p = b.props || {};
    for (const k in p) {
      const v = p[k];
      if (typeof v === "string" && v.trim() && !v.startsWith(ASSET_REF)) parts.push(v);
    }
  }
  return parts.join(" ").toLowerCase();
}
function slideLabel(slide: Slide): string {
  const priority = ["title", "subtitle", "text", "sectionLabel"];
  for (const type of priority) {
    for (const b of slide.blocks || []) {
      if (b.type !== type) continue;
      const t = String(b.props?.text || "").trim();
      if (t) return t.replace(/\s+/g, " ");
    }
  }
  for (const b of slide.blocks || []) {
    const t = String(b.props?.text || b.props?.title || "").trim();
    if (t) return t.replace(/\s+/g, " ");
  }
  return "Untitled";
}
function filteredSlideIndices() {
  const q = slideSearch.trim().toLowerCase();
  if (!q) return deck.slides.map((_, i) => i);
  return deck.slides.map((s, i) => slideText(s).includes(q) ? i : -1).filter((i) => i >= 0);
}
function renderSlide(slide: Slide): HTMLDivElement {
  const frame = el("div", {
    class: "slide-frame",
    style: {
      position: "relative",
      overflow: "hidden",
      width: "1200px",
      height: "675px",
      background: slide.background && slide.background.color || C.page,
      fontFamily: FONT,
      color: C.text
    }
  });
  if (slide.background && slide.background.coverOrange) {
    frame.appendChild(el("div", {
      style: {
        position: "absolute",
        inset: "0",
        backgroundImage: `url("${COVER_ORANGE_PNG}")`,
        backgroundSize: "cover",
        backgroundPosition: "center",
        pointerEvents: "none"
      }
    }));
  }
  if (!slide.background || slide.background.inset !== false) {
    frame.appendChild(el("div", {
      style: {
        position: "absolute",
        inset: "16px",
        borderRadius: "16px",
        background: C.surface,
        border: `1px solid ${C.borderLight}`,
        pointerEvents: "none"
      }
    }));
  }
  if (slide.background && slide.background.dotGrid) {
    frame.appendChild(DotGrid(slide.background.dotGrid));
  }
  if (logoShowsOn(deck.logo, slide)) {
    const logo = renderDeckLogo(deck.logo);
    if (logo) frame.appendChild(logo);
  }
  for (const block of slide.blocks) {
    const wrap = renderBlock(slide, block);
    if (wrap) frame.appendChild(wrap);
  }
  if (editMode) {
    frame.addEventListener("pointerdown", (e) => {
      if (e.target === frame || e.target instanceof Element && e.target.classList.contains("slide-bg-hit")) {
        e.stopPropagation();
        startMarquee(e);
      }
    });
    const insetChild = frame.children[0];
    if (insetChild) insetChild.classList.add("slide-bg-hit");
  }
  return frame;
}
// The deck logo: the same corner and size on every slide, above the
// background and below the blocks. It isn't a block: nothing on the slide
// selects or moves it (Slide settings sets it).
function renderDeckLogo(logo: DeckLogo): HTMLDivElement | null {
  const src = assetRaw(logo.src);
  if (!src) return null;
  const box = deckLogoBox(logo.position);
  return el("div", {
    class: "deck-logo",
    style: { position: "absolute", left: box.x + "px", top: box.y + "px", width: box.w + "px", height: box.h + "px", pointerEvents: "none" }
  }, [el("img", {
    src,
    alt: logoAlt(logo.alt),
    draggable: "false",
    style: { width: "100%", height: "100%", objectFit: "contain", objectPosition: box.objectPosition, display: "block", userSelect: "none" }
  })]);
}
function renderBlock(slide: Slide, block: Block): HTMLElement | SVGSVGElement {
  try {
    return renderBlockUnsafe(slide, block);
  } catch (e) {
    // One block with props its component can't draw must not take the whole
    // slide (and the app) down with it: show it as an unknown block.
    // It stays selectable, so Format or Delete can still fix it.
    console.error("Could not render block", block?.id, e);
    // (A type no component has renders as a plain div.)
    const node = renderBlockUnsafe(slide, { ...block, type: "?" + block?.type }) as HTMLElement;
    node.dataset.blockId = block.id;
    if (editMode) attachBlockInteractions(node, slide, block);
    return node;
  }
}
function renderBlockUnsafe(slide: Slide, block: Block): HTMLElement | SVGSVGElement {
  const def = COMPONENTS[block.type];
  if (!def) {
    return el("div", {
      style: {
        position: "absolute",
        left: (block.x || 0) + "px",
        top: (block.y || 0) + "px",
        padding: "6px 10px",
        color: "#fff",
        background: "#b00",
        borderRadius: "4px",
        fontSize: "12px"
      },
      text: `?: ${block.type}`
    });
  }
  const ctx: RenderCtx = {
    block,
    background: slide.background || {},
    // True while this block's text is editable in place (single selection,
    // edit mode, not the Select tool): optional fields show an empty slot.
    editing: inlineEditing(block),
    inlineText: (elem, propKey, transform, placeholder) => bindInlineText(elem, slide, block, propKey, transform, placeholder),
    inlineList: (list, propKey, makeRow, maxItems) => bindInlineList(list, slide, block, propKey, makeRow, maxItems)
  };
  if (def.fullBleed) {
    const content2 = def.render(resolveProps(block.props || {}), ctx);
    if (editMode) {
      content2.style.pointerEvents = "none";
      const onSelect = (e: PointerEvent) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        beginBlockPress(e, slide, block);
      };
      if (block.type === "arrow") {
        const p = block.props || {};
        const groupSelected = selection.has(block.id) && block.id !== selectedBlockId;
        const hit = svg("line", {
          x1: p.x1,
          y1: p.y1,
          x2: p.x2,
          y2: p.y2,
          stroke: groupSelected ? hexA(C.orange, 0.3) : "transparent",
          "stroke-width": "18",
          "stroke-linecap": "round",
          style: "cursor:pointer;pointer-events:stroke;"
        });
        hit.addEventListener("pointerdown", onSelect);
        content2.appendChild(hit);
      }
      for (const node of content2.querySelectorAll("text")) {
        node.style.pointerEvents = "auto";
        node.style.cursor = "pointer";
        node.addEventListener("pointerdown", onSelect);
      }
      if (block.id === selectedBlockId) {
        const handles = renderArrowHandles(slide, block);
        const layer = el("div", { style: {
          position: "absolute",
          left: "0",
          top: "0",
          width: "1200px",
          height: "675px",
          pointerEvents: "none"
        } });
        layer.appendChild(content2);
        for (const h of handles) layer.appendChild(h);
        layer.dataset.blockId = block.id;
        return layer;
      }
    }
    content2.dataset.blockId = block.id;
    return content2;
  }
  const wrap = el("div", {
    style: {
      position: "absolute",
      left: (block.x ?? 0) + "px",
      top: (block.y ?? 0) + "px",
      ...block.w != null ? { width: block.w + "px" } : {},
      ...block.h != null ? { height: block.h + "px" } : {},
      boxSizing: "border-box"
    }
  });
  wrap.dataset.blockId = block.id;
  const content = def.render(resolveProps(block.props || {}), ctx);
  wrap.appendChild(content);
  if (editMode) {
    wrap.style.cursor = "move";
    attachBlockInteractions(wrap, slide, block, def);
    if (selection.has(block.id)) {
      wrap.style.outline = `2px solid ${C.orange}`;
      wrap.style.outlineOffset = "2px";
      wrap.style.zIndex = "5";
      // Resize handles are for a single selection.
      if (block.id === selectedBlockId && (def.resizableW || def.resizableH)) addResizeHandle(wrap, slide, block, def);
    } else {
      wrap.addEventListener("mouseenter", () => {
        if (!selection.has(block.id) && !shellRef.root?.classList.contains("dragging"))
          wrap.style.outline = `1px dashed ${hexA(C.orange, 0.55)}`;
      });
      wrap.addEventListener("mouseleave", () => {
        if (!selection.has(block.id)) wrap.style.outline = "none";
      });
    }
  }
  return wrap;
}
// Text is edited in place on a single selection, except with the Select
// tool, where a press always grabs the block.
function inlineEditing(block: Block): boolean {
  return editMode && block.id === selectedBlockId && !selectTool;
}
// "plaintext-only" isn't supported everywhere (older Firefox throws on it).
function makeEditable(elem: HTMLElement, placeholder?: string): void {
  try {
    elem.contentEditable = "plaintext-only";
  } catch {
    elem.contentEditable = "true";
  }
  if (elem.contentEditable !== "plaintext-only") elem.contentEditable = "true";
  elem.spellcheck = false;
  elem.style.outline = "none";
  elem.style.cursor = "text";
  // An empty field still needs somewhere to click and type.
  elem.classList.add("inline-edit");
  if (placeholder) elem.dataset.ph = placeholder;
  elem.addEventListener("pointerdown", (e) => e.stopPropagation());
}
// Sets a prop an in-place editor saves on the deck's current copy of its block:
// a patch may have replaced the block the editor was drawn from, and commands
// that follow (Duplicate, Copy) read the deck.
// The block as the deck holds it now: a broadcast replaces block objects, so one captured when
// a field was drawn may be stale.
function liveBlock(slideId: string, blockId: string): Block | undefined {
  return deck.slides.find((s) => s.id === slideId)?.blocks.find((b) => b.id === blockId);
}
function setLiveProp(slideId: string, blockId: string, key: string, value: PropValue): void {
  const live = liveBlock(slideId, blockId);
  if (live) live.props = { ...live.props || {}, [key]: value };
}
// A key an input method is using (Enter confirming a candidate, say): it isn't
// a command. Some browsers report it only as keyCode 229.
const imeKey = (e: KeyboardEvent) => e.isComposing || e.keyCode === 229;
// ⌘/Ctrl S in a field being edited in place: save it (in-place fields keep
// their keys from the page's shortcuts). Returns whether it was that key.
function saveKey(e: KeyboardEvent): boolean {
  if (!(e.metaKey || e.ctrlKey) || e.altKey || e.key.toLowerCase() !== "s") return false;
  e.preventDefault();
  saveNow();
  return true;
}
function bindInlineText<E extends HTMLElement>(elem: E, slide: Slide, block: Block, propKey: string, transform?: ((raw: PropValue) => string) | null, placeholder = "Type here"): E {
  const raw = (block.props || {})[propKey] ?? "";
  if (inlineEditing(block)) {
    // The value last saved: the field can outlive a save while another field
    // is being edited (renderWhenIdle), and typing the old text back must save.
    let saved = String(raw);
    makeEditable(elem, placeholder);
    // Markup a transform adds (a title's highlighted words) stays while the
    // text is selected and edited, and follows the text as you type, so the
    // block looks the same in every state. Other transforms only apply when
    // not editing.
    const marked = (text: string) => {
      const html = transform ? transform(text) : "";
      return /<span\b/.test(html) ? html : null;
    };
    const html = marked(String(raw));
    if (html) elem.innerHTML = html;
    else elem.textContent = String(raw);
    const show = (text: string, next = marked(text)) => {
      // (A text ending in a line break needs a placeholder <br> to show that empty last line.)
      if (next) elem.innerHTML = next + (text.endsWith("\n") ? '<br data-tail="">' : "");
      else elem.textContent = text;
    };
    elem.addEventListener("input", (e) => {
      if (!transform || (e instanceof InputEvent && e.isComposing)) return;
      const next = marked(editableText(elem));
      if (!next && !elem.querySelector("span")) return;
      const caret = caretOffset(elem);
      show(editableText(elem), next);
      if (caret != null) placeCaret(elem, caret);
    });
    // Multi-line text (pasted, dropped) goes in as text and line breaks: a
    // browser may insert its lines as <div>s, which the markup above would join.
    elem.addEventListener("beforeinput", (e) => {
      if (!transform || e.isComposing) return;
      const data = (e.data ?? e.dataTransfer?.getData("text/plain") ?? "").replace(/\r\n?/g, "\n");
      const at = data.includes("\n") ? selectionOffsets(elem) : null;
      if (!at) return;
      e.preventDefault();
      const text = editableText(elem);
      show(text.slice(0, at.start) + data + text.slice(at.end));
      placeCaret(elem, at.start + data.length);
    });
    elem.addEventListener("compositionend", () => elem.dispatchEvent(new Event("input")));
    elem.addEventListener("focus", () => {
      elem.style.outline = `1px dashed ${hexA(C.orange, 0.55)}`;
      elem.style.outlineOffset = "2px";
    });
    elem.addEventListener("blur", async () => {
      elem.style.outline = "none";
      let v = (elem.querySelector("span") ? editableText(elem) : elem.innerText).replace(/\u00A0/g, " ");
      // A field cleared to nothing can leave a stray line break behind.
      if (!v.trim()) v = "";
      if (v === saved) return;
      saved = v;
      setLiveProp(slide.id, block.id, propKey, v);
      await api.updateBlock(slide.id, block.id, { props: { [propKey]: v } });
      renderWhenIdle();
    });
    elem.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (imeKey(e) || saveKey(e)) return;
      if ((e.key === "Enter" && !e.shiftKey) || e.key === "Escape") {
        e.preventDefault();
        elem.blur();
      }
    });
  } else {
    if (transform) elem.innerHTML = transform(raw);
    else elem.textContent = String(raw);
  }
  return elem;
}
// The text of an element being edited, as a string: text nodes, with each
// <br> a line break (the offsets caretOffset / placeCaret use).
function editableText(root: Node): string {
  let out = "";
  const walk = (n: Node) => {
    if (n.nodeType === Node.TEXT_NODE) out += n.nodeValue ?? "";
    else if (n.nodeName === "BR") out += n instanceof HTMLElement && n.dataset.tail != null ? "" : "\n";
    else n.childNodes.forEach(walk);
  };
  root.childNodes.forEach(walk);
  return out;
}
// The selection's start and end as offsets into editableText(root), or null
// without one inside it.
function selectionOffsets(root: HTMLElement): { start: number; end: number } | null {
  const sel = getSelection();
  if (!sel || !sel.rangeCount || !root.contains(sel.anchorNode)) return null;
  const r = sel.getRangeAt(0);
  const upTo = (node: Node, offset: number) => {
    const pre = document.createRange();
    pre.selectNodeContents(root);
    pre.setEnd(node, offset);
    return editableText(pre.cloneContents()).length;
  };
  return { start: upTo(r.startContainer, r.startOffset), end: upTo(r.endContainer, r.endOffset) };
}
// The caret's offset into editableText(root), or null without one inside it.
function caretOffset(root: HTMLElement): number | null {
  return selectionOffsets(root)?.end ?? null;
}
function placeCaret(root: HTMLElement, offset: number): void {
  let left = offset;
  const range = document.createRange();
  const find = (n: Node): boolean => {
    if (n.nodeType === Node.TEXT_NODE) {
      const len = n.nodeValue?.length ?? 0;
      if (left <= len) { range.setStart(n, left); return true; }
      left -= len;
    } else if (n.nodeName === "BR") {
      if (left === 0) { range.setStartBefore(n); return true; }
      left -= 1;
    } else {
      for (const c of Array.from(n.childNodes)) if (find(c)) return true;
    }
    return false;
  };
  if (!find(root)) range.selectNodeContents(root), range.collapse(false);
  else range.collapse(true);
  const sel = getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}
// A one-item-per-line prop (bullet lists) edited in place, one editable row
// per item. Enter splits the item at the caret into a new row (on an empty
// last row, or at the item limit, it finishes); Backspace at the start of a
// row joins it onto the one above; Esc or clicking away saves. ⌘/Ctrl Z undoes
// a split, join or multi-line paste when nothing was typed after it (the
// browser's own undo covers typing).
function bindInlineList<E extends HTMLElement>(list: E, slide: Slide, block: Block, propKey: string, makeRow: (item: string) => ListRow, maxItems = Infinity): E {
  const raw = String((block.props || {})[propKey] ?? "");
  const allItems = raw.split("\n").map((s) => s.trim()).filter(Boolean);
  const items = allItems.slice(0, maxItems);
  // Items past the limit aren't shown; keep them when saving.
  const hidden = allItems.slice(maxItems);
  if (!inlineEditing(block)) {
    for (const item of items) list.appendChild(makeRow(item).row);
    return list;
  }
  const fields = () => [...list.querySelectorAll<HTMLElement>(".inline-edit")];
  const caretAt = (node: HTMLElement, offset: number) => {
    node.focus();
    const r = document.createRange();
    const t = node.firstChild;
    if (t instanceof Text) r.setStart(t, Math.min(offset, t.length));
    else r.setStart(node, 0);
    r.collapse(true);
    const sel = getSelection();
    sel?.removeAllRanges();
    sel?.addRange(r);
  };
  const offsetIn = (node: Node, container: Node, offset: number) => {
    const r = document.createRange();
    r.selectNodeContents(node);
    r.setEnd(container, offset);
    return r.toString().length;
  };
  // Splits, joins and multi-line pastes rebuild rows, which the browser's undo can't follow.
  type ListState = { texts: string[]; caret: [number, number] };
  const undone: Array<{ before: ListState; after: ListState }> = [], redone: typeof undone = [];
  const state = (): ListState => {
    const all = fields(), sel = getSelection();
    const at = all.findIndex((f) => sel?.anchorNode && f.contains(sel.anchorNode));
    return { texts: all.map((f) => f.textContent ?? ""), caret: at < 0 || !sel?.anchorNode ? [0, 0] : [at, offsetIn(all[at], sel.anchorNode, sel.anchorOffset)] };
  };
  const structural = (change: () => void) => {
    const before = state();
    change();
    undone.push({ before, after: state() });
    redone.length = 0;
  };
  const restore = (to: ListState) => {
    let all = fields();
    for (let i = all.length - 1; i >= to.texts.length; i--) [...list.children].find((c) => c.contains(all[i]))?.remove();
    all = fields();
    for (let i = 0; i < to.texts.length; i++) {
      if (all[i]) all[i].textContent = to.texts[i];
      else all.push(addRow(to.texts[i], [...list.children].find((c) => c.contains(all[i - 1])) as HTMLElement));
    }
    caretAt(all[to.caret[0]] ?? all[0], to.caret[1]);
  };
  // Undoes (or redoes) the last structural edit if the rows still show its result.
  const step = (redo: boolean): boolean => {
    const from = redo ? redone : undone, entry = from[from.length - 1];
    if (!entry || state().texts.join("\n") !== (redo ? entry.before : entry.after).texts.join("\n")) return false;
    from.pop();
    restore(redo ? entry.after : entry.before);
    (redo ? undone : redone).push(entry);
    return true;
  };
  const addRow = (text: string, after: HTMLElement | null): HTMLElement => {
    const { row, textEl } = makeRow(text);
    makeEditable(textEl, "List item");
    textEl.addEventListener("input", () => { redone.length = 0; });
    textEl.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (imeKey(e) || saveKey(e)) return;
      const sel = getSelection();
      const range = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "z") {
        if (step(e.shiftKey)) e.preventDefault();
      } else if (e.key === "Escape") {
        e.preventDefault();
        textEl.blur();
      } else if (e.key === "Enter") {
        e.preventDefault();
        const all = fields();
        const isLast = all[all.length - 1] === textEl;
        if (all.length >= maxItems || (isLast && !textEl.textContent?.trim()) || !range) {
          textEl.blur();
          return;
        }
        const text = textEl.textContent ?? "";
        const start = offsetIn(textEl, range.startContainer, range.startOffset);
        const end = offsetIn(textEl, range.endContainer, range.endOffset);
        structural(() => {
          textEl.textContent = text.slice(0, start);
          caretAt(addRow(text.slice(end), row), 0);
        });
      } else if (e.key === "Backspace" && range && range.collapsed && offsetIn(textEl, range.startContainer, range.startOffset) === 0) {
        const all = fields();
        const i = all.indexOf(textEl);
        if (i <= 0) return;
        e.preventDefault();
        const prev = all[i - 1];
        const at = prev.textContent?.length ?? 0;
        structural(() => {
          prev.textContent += textEl.textContent;
          row.remove();
          caretAt(prev, at);
        });
      }
    });
    // Pasted (or dropped) lines become rows from the caret on; lines past the
    // item limit stay together on the last row.
    textEl.addEventListener("beforeinput", (e) => {
      if (e.isComposing) return;
      const data = (e.data ?? e.dataTransfer?.getData("text/plain") ?? "").replace(/\r\n?/g, "\n");
      const sel = getSelection();
      const range = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
      if (!data.includes("\n") || !range || !textEl.contains(range.startContainer)) return;
      e.preventDefault();
      const text = textEl.textContent ?? "";
      const start = offsetIn(textEl, range.startContainer, range.startOffset);
      const end = offsetIn(textEl, range.endContainer, range.endOffset);
      const lines = data.split("\n");
      const room = Math.max(1, maxItems - fields().length + 1);
      const parts = [...lines.slice(0, room - 1), lines.slice(room - 1).join(" ")];
      structural(() => {
        textEl.textContent = text.slice(0, start) + parts[0];
        let last = textEl, after = row;
        for (const line of parts.slice(1)) {
          last = addRow(line, after);
          after = [...list.children].find((c) => c.contains(last)) as HTMLElement;
        }
        const at = last.textContent?.length ?? 0;
        last.textContent += text.slice(end);
        caretAt(last, at);
      });
    });
    if (after) after.after(row);
    else list.appendChild(row);
    return textEl;
  };
  for (const item of items.length ? items : [""]) addRow(item, null);
  let saved = items.join("\n");
  const save = () => {
    if (flushListEdit === save) flushListEdit = null;
    list.style.outline = "none";
    const edited = fields().map((f) => (f.textContent ?? "").replace(/\u00A0/g, " ").replace(/\s*\n\s*/g, "\n").trim()).filter(Boolean);
    if (edited.join("\n") === saved) return;
    saved = edited.join("\n");
    const v = [...edited, ...hidden].join("\n");
    setLiveProp(slide.id, block.id, propKey, v);
    void api.updateBlock(slide.id, block.id, { props: { [propKey]: v } }).then(renderWhenIdle);
  };
  list.addEventListener("focusin", () => {
    flushListEdit = save;
    list.style.outline = `1px dashed ${hexA(C.orange, 0.55)}`;
    list.style.outlineOffset = "2px";
  });
  // Save once focus has left the whole list (not when moving between rows),
  // or sooner through commitInlineEdit.
  list.addEventListener("focusout", () => {
    setTimeout(() => {
      if (flushListEdit === save && !list.contains(document.activeElement)) save();
    });
  });
  return list;
}
var SNAP_THRESHOLD = 6;
function attachBlockInteractions(wrap: HTMLElement, slide: Slide, block: Block, def?: ComponentDef): void {
  wrap.addEventListener("pointerdown", (e: PointerEvent) => {
    if (e.button !== 0) return;
    if (e.target instanceof HTMLElement && e.target.isContentEditable) return;
    e.stopPropagation();
    beginBlockPress(e, slide, block);
  });
}
function setDragging(on: boolean): void {
  shellRef.root?.classList.toggle("dragging", on);
  if (on) { hideTip(); closePop(true); }
  else if (stageStale) render();
}
function blockNode(id: string): HTMLElement | null {
  return stageRef.el?.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(id)}"]`) || null;
}
// A block's box in slide coordinates. Blocks without an explicit size are
// measured; arrows use the bounds of their two endpoints.
/** A block's box in slide coordinates; `full` for a full-bleed block (an arrow). */
interface SlideBox {
  x: number;
  y: number;
  w: number;
  h: number;
  full: boolean;
}
function slideBox(b: Block, node: HTMLElement | null = blockNode(b.id)): SlideBox {
  if (COMPONENTS[b.type]?.fullBleed) {
    const p = b.props || {};
    const x = Math.min(p.x1 ?? 0, p.x2 ?? 0), y = Math.min(p.y1 ?? 0, p.y2 ?? 0);
    return { x, y, w: Math.abs((p.x2 ?? 0) - (p.x1 ?? 0)), h: Math.abs((p.y2 ?? 0) - (p.y1 ?? 0)), full: true };
  }
  return { x: b.x ?? 0, y: b.y ?? 0, w: b.w ?? (node ? node.offsetWidth : 0), h: b.h ?? (node ? node.offsetHeight : 0), full: false };
}
// Press on a block: select it (Shift, ⌘/Ctrl or the Select tool add to or
// remove from the selection), or drag it -- together with the rest of the
// selection when it is part of one. Snapping uses the group's bounding box;
// Alt/⌥ skips it. A group move is saved as one change (one undo step).
function beginBlockPress(e: PointerEvent, slide: Slide, block: Block): void {
  const additive = e.shiftKey || e.metaKey || e.ctrlKey || selectTool;
  const wasSelected = selection.has(block.id);
  const groupIds = wasSelected ? [...selection] : additive ? [...selection, block.id] : [block.id];
  const members: Array<{ b: Block; node: HTMLElement | null; box: SlideBox; p: BlockProps | null }> = [];
  for (const id of groupIds) {
    const b = slide.blocks.find((x) => x.id === id);
    if (!b) continue;
    const node = blockNode(id);
    const box = slideBox(b, node);
    members.push({ b, node, box, p: box.full ? { ...b.props } : null });
  }
  const boxes = members.filter((m) => !m.box.full).map((m) => m.box);
  let bbox: { x: number; y: number; w: number; h: number } | null = null;
  if (boxes.length) {
    const L = Math.min(...boxes.map((r) => r.x)), T = Math.min(...boxes.map((r) => r.y));
    bbox = { x: L, y: T, w: Math.max(...boxes.map((r) => r.x + r.w)) - L, h: Math.max(...boxes.map((r) => r.y + r.h)) - T };
  }
  const targets = bbox ? computeSnapTargets(slide, new Set(groupIds)) : null;
  const frame = stageRef.el?.querySelector<HTMLElement>(".slide-frame") ?? null;
  const startX = e.clientX, startY = e.clientY;
  let dragged = false;
  const onMove = (ev: PointerEvent) => {
    const dx = (ev.clientX - startX) / stageScale;
    const dy = (ev.clientY - startY) / stageScale;
    if (!dragged && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
      dragged = true;
      setDragging(true);
    }
    if (!dragged) return;
    let ddx = Math.round(dx), ddy = Math.round(dy);
    let guidesV: number[] = [], guidesH: number[] = [];
    if (bbox && targets && !ev.altKey) {
      const snap = applySnap(bbox.x + ddx, bbox.y + ddy, bbox.w, bbox.h, targets);
      ddx = snap.x - bbox.x;
      ddy = snap.y - bbox.y;
      guidesV = snap.guidesV;
      guidesH = snap.guidesH;
    }
    drawSnapGuides(frame, guidesV, guidesH);
    for (const m of members) {
      if (m.box.full && m.p) {
        if (m.node) m.node.style.transform = `translate(${ddx}px, ${ddy}px)`;
        m.b.props = { ...m.b.props, x1: Number(m.p.x1) + ddx, y1: Number(m.p.y1) + ddy, x2: Number(m.p.x2) + ddx, y2: Number(m.p.y2) + ddy };
      } else {
        m.b.x = m.box.x + ddx;
        m.b.y = m.box.y + ddy;
        if (m.node) {
          m.node.style.left = m.b.x + "px";
          m.node.style.top = m.b.y + "px";
        }
      }
    }
    if (members.length === 1) updateInspectorPositionFields(members[0].b);
  };
  // (A cancelled press -- the browser took the touch -- ends a drag where it is, but is no click.)
  const onUp = async (ev: PointerEvent) => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    clearSnapGuides();
    if (dragged) {
      setDragging(false);
      const patches: BlockPatchEntry[] = members.map((m) => m.box.full
        ? { id: m.b.id, patch: { props: { x1: m.b.props.x1, y1: m.b.props.y1, x2: m.b.props.x2, y2: m.b.props.y2 } } }
        : { id: m.b.id, patch: { x: m.b.x, y: m.b.y } });
      setSelection(groupIds);
      render();
      renderInspector();
      if (patches.length === 1) await api.updateBlock(slide.id, patches[0].id, patches[0].patch);
      else await api.updateBlocks(slide.id, patches);
      return;
    }
    if (ev.type === "pointercancel") return;
    // A click.
    if (additive) {
      const next = new Set(selection);
      if (wasSelected) next.delete(block.id);
      else next.add(block.id);
      setSelection(next);
    } else {
      // A click on an empty logo slot asks for the image.
      if (block.type === "logo" && isEmptyLogoSlot(block.props)) pickImageFor(block.id);
      if (wasSelected && selection.size === 1) return;
      setSelection([block.id]);
    }
    render();
    renderInspector();
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
}
// Drag on empty canvas (on or around the slide) to select every block the
// box touches. Shift / ⌘ adds to the current selection; a plain click on
// empty canvas clears it.
function startMarquee(e: PointerEvent): void {
  if (e.button !== 0 || !editMode || presenting) return;
  const stage = stageRef.el, wrap = stageRef.wrap;
  const slide = currentSlide();
  if (!stage || !wrap || !slide) return;
  closePop();
  if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) document.activeElement.blur();
  const additive = e.shiftKey || e.metaKey || e.ctrlKey;
  const base = additive ? new Set(selection) : new Set<string>();
  const sr = stage.getBoundingClientRect(), wr = wrap.getBoundingClientRect();
  const toSlide = (cx: number, cy: number) => [(cx - sr.left) / stageScale, (cy - sr.top) / stageScale];
  const items = slide.blocks.map((b) => {
    const node = blockNode(b.id);
    return { id: b.id, node: COMPONENTS[b.type]?.fullBleed ? null : node, box: slideBox(b, node) };
  });
  let box: HTMLDivElement | null = null, hits = new Set(base);
  const onMove = (ev: PointerEvent) => {
    if (!box) {
      if (Math.abs(ev.clientX - e.clientX) < 4 && Math.abs(ev.clientY - e.clientY) < 4) return;
      box = el("div", { class: "marquee" });
      wrap.appendChild(box);
      setDragging(true);
    }
    const l = Math.min(e.clientX, ev.clientX), t = Math.min(e.clientY, ev.clientY);
    const r = Math.max(e.clientX, ev.clientX), btm = Math.max(e.clientY, ev.clientY);
    box.style.left = l - wr.left + "px";
    box.style.top = t - wr.top + "px";
    box.style.width = r - l + "px";
    box.style.height = btm - t + "px";
    const [ax, ay] = toSlide(l, t), [bx, by] = toSlide(r, btm);
    hits = new Set(base);
    for (const it of items) {
      const q = it.box;
      if (q.x <= bx && q.x + q.w >= ax && q.y <= by && q.y + q.h >= ay) hits.add(it.id);
    }
    for (const it of items) {
      if (!it.node) continue;
      it.node.style.outline = hits.has(it.id) ? `2px solid ${C.orange}` : "none";
      it.node.style.outlineOffset = "2px";
    }
  };
  const onUp = (ev: PointerEvent) => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    if (box) {
      box.remove();
      setDragging(false);
      setSelection(hits);
    } else if (!additive && ev.type !== "pointercancel") {
      if (!selection.size) return;
      setSelection([]);
    } else return;
    render();
    renderInspector();
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
}
// Snap targets from every block not being dragged (`exclude`: a Set of ids).
function computeSnapTargets(slide: Slide, exclude: Set<string>): SnapTargets {
  const verts: number[] = [], horiz: number[] = [];
  verts.push(0, 600, 1200);
  horiz.push(0, 337.5, 675);
  for (const b of slide.blocks) {
    if (exclude.has(b.id)) continue;
    const bdef = COMPONENTS[b.type];
    if (!bdef || bdef.fullBleed) continue;
    const node = blockNode(b.id);
    const x = b.x ?? 0;
    const y = b.y ?? 0;
    const w = b.w ?? (node ? node.offsetWidth : 0);
    const h = b.h ?? (node ? node.offsetHeight : 0);
    if (w > 0) {
      verts.push(x);
      verts.push(x + w);
      verts.push(x + w / 2);
    }
    if (h > 0) {
      horiz.push(y);
      horiz.push(y + h);
      horiz.push(y + h / 2);
    }
  }
  return { verts, horiz };
}
/** Edges and centres a dragged box snaps to, in slide coordinates. */
interface SnapTargets {
  verts: number[];
  horiz: number[];
}
function applySnap(nx: number, ny: number, bw: number, bh: number, targets: SnapTargets) {
  const xCands = [
    { pos: nx, offset: 0 },
    { pos: nx + bw / 2, offset: -bw / 2 },
    { pos: nx + bw, offset: -bw }
  ];
  const yCands = [
    { pos: ny, offset: 0 },
    { pos: ny + bh / 2, offset: -bh / 2 },
    { pos: ny + bh, offset: -bh }
  ];
  let bestX: { d: number; x: number; guide: number } | null = null;
  for (const c of xCands) {
    for (const t of targets.verts) {
      const d = Math.abs(t - c.pos);
      if (d <= SNAP_THRESHOLD && (!bestX || d < bestX.d)) {
        bestX = { d, x: t + c.offset, guide: t };
      }
    }
  }
  let bestY: { d: number; y: number; guide: number } | null = null;
  for (const c of yCands) {
    for (const t of targets.horiz) {
      const d = Math.abs(t - c.pos);
      if (d <= SNAP_THRESHOLD && (!bestY || d < bestY.d)) {
        bestY = { d, y: t + c.offset, guide: t };
      }
    }
  }
  return {
    x: bestX ? Math.round(bestX.x) : nx,
    y: bestY ? Math.round(bestY.y) : ny,
    guidesV: bestX ? [bestX.guide] : [],
    guidesH: bestY ? [bestY.guide] : []
  };
}
function drawSnapGuides(frame: HTMLElement | null, xs: number[], ys: number[]): void {
  if (!frame) return;
  let layer = frame.querySelector("[data-snap-layer]");
  if (!layer) {
    layer = el("div", {
      "data-snap-layer": "1",
      style: {
        position: "absolute",
        inset: "0",
        pointerEvents: "none",
        zIndex: "100"
      }
    });
    frame.appendChild(layer);
  }
  layer.innerHTML = "";
  for (const x of xs) {
    layer.appendChild(el("div", {
      style: {
        position: "absolute",
        left: x + "px",
        top: "0",
        width: "1px",
        height: "675px",
        marginLeft: "-0.5px",
        background: C.orange,
        opacity: "0.9"
      }
    }));
  }
  for (const y of ys) {
    layer.appendChild(el("div", {
      style: {
        position: "absolute",
        left: "0",
        top: y + "px",
        width: "1200px",
        height: "1px",
        marginTop: "-0.5px",
        background: C.orange,
        opacity: "0.9"
      }
    }));
  }
}
function clearSnapGuides() {
  const layer = stageRef.el?.querySelector("[data-snap-layer]");
  if (layer) layer.remove();
}
function addResizeHandle(wrap: HTMLElement, slide: Slide, block: Block, def: ComponentDef): void {
  const handle = el("div", {
    style: {
      position: "absolute",
      right: "-6px",
      bottom: "-6px",
      width: "12px",
      height: "12px",
      background: "#fff",
      border: `2px solid ${C.orange}`,
      borderRadius: "3px",
      cursor: "nwse-resize",
      zIndex: "10"
    }
  });
  handle.addEventListener("pointerdown", (e: PointerEvent) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    const startX = e.clientX, startY = e.clientY;
    const origW = block.w ?? wrap.offsetWidth;
    const origH = block.h ?? wrap.offsetHeight;
    let moved = false;
    setDragging(true);
    const onMove = (ev: PointerEvent) => {
      moved = true;
      const dx = (ev.clientX - startX) / stageScale;
      const dy = (ev.clientY - startY) / stageScale;
      if (def.resizableW) {
        const nw = Math.max(40, Math.round(origW + dx));
        wrap.style.width = nw + "px";
        block.w = nw;
      }
      if (def.resizableH) {
        const nh = Math.max(24, Math.round(origH + dy));
        wrap.style.height = nh + "px";
        block.h = nh;
      }
      updateInspectorPositionFields(block);
    };
    const onUp = async () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      setDragging(false);
      // A click on the handle without a drag changes nothing: no save, no undo step.
      if (!moved) return;
      const patch: BlockPatch = {};
      if (def.resizableW) patch.w = block.w;
      if (def.resizableH) patch.h = block.h;
      await api.updateBlock(slide.id, block.id, patch);
      renderWhenIdle();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  });
  wrap.appendChild(handle);
}
function renderArrowHandles(slide: Slide, block: Block): HTMLDivElement[] {
  const handles: HTMLDivElement[] = [];
  for (const which of ["1", "2"]) {
    const x = Number(block.props["x" + which]), y = Number(block.props["y" + which]);
    const h = el("div", {
      style: {
        position: "absolute",
        left: x - 7 + "px",
        top: y - 7 + "px",
        width: "14px",
        height: "14px",
        background: "#fff",
        border: `2px solid ${C.orange}`,
        borderRadius: "50%",
        cursor: "grab",
        pointerEvents: "auto",
        zIndex: "8"
      }
    });
    h.addEventListener("pointerdown", (e: PointerEvent) => {
      e.stopPropagation();
      if (e.button !== 0) return;
      h.style.cursor = "grabbing";
      setDragging(true);
      const startX = e.clientX, startY = e.clientY;
      const ox = x, oy = y;
      let moved = false;
      const onMove = (ev: PointerEvent) => {
        moved = true;
        const nx = Math.round(ox + (ev.clientX - startX) / stageScale);
        const ny = Math.round(oy + (ev.clientY - startY) / stageScale);
        block.props["x" + which] = nx;
        block.props["y" + which] = ny;
        render();
      };
      const onUp = async () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        setDragging(false);
        updateFloatBar();
        if (!moved) return;
        await api.updateBlock(slide.id, block.id, {
          props: {
            ["x" + which]: block.props["x" + which],
            ["y" + which]: block.props["y" + which]
          }
        });
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    });
    handles.push(h);
  }
  return handles;
}
function selectBlock(id: string | null): void {
  const next = id ? [id] : [];
  if (next.length === selection.size && next.every((x) => selection.has(x))) return;
  setSelection(next);
  render();
  renderInspector();
}
function renderSlideThumbnail(slide: Slide, width = THUMB_W): HTMLDivElement {
  const prevEdit = editMode, prevSel = selectedBlockId;
  editMode = false;
  selectedBlockId = null;
  let frame: HTMLDivElement;
  try {
    frame = renderSlide(slide);
  } finally {
    editMode = prevEdit;
    selectedBlockId = prevSel;
  }
  const scale = width / 1200;
  const height = 675 * scale;
  const container = el("div", {
    class: "thumb-canvas",
    style: {
      width: width + "px",
      height: height + "px",
      overflow: "hidden",
      background: slide.background && slide.background.color || C.page,
      position: "relative",
      pointerEvents: "none"
    }
  });
  frame.style.transform = `scale(${scale})`;
  frame.style.transformOrigin = "0 0";
  frame.style.flex = "none";
  container.appendChild(frame);
  return container;
}
function render(): void {
  if (!stageRef.el) return;
  stageStale = false;
  stageRef.el.innerHTML = "";
  const slide = currentSlide();
  if (slide) stageRef.el.appendChild(renderSlide(slide));
  updateFloatBar();
}
function renderPrintDeck(): void {
  const printDeck = shellRef.printDeck;
  if (!printDeck) return;
  const prevEdit = editMode, prevSelection = selectedBlockId;
  editMode = false;
  selectedBlockId = null;
  try {
    printDeck.replaceChildren(...deck.slides.map((slide) => {
      const page = el("section", { class: "print-slide" });
      page.appendChild(renderSlide(slide));
      return page;
    }));
  } finally {
    editMode = prevEdit;
    selectedBlockId = prevSelection;
  }
}
window.addEventListener("beforeprint", renderPrintDeck);
window.matchMedia("print").addEventListener("change", (event) => {
  if (event.matches) renderPrintDeck();
});

/* ═════════════════════════ 6. Styles (app chrome) ════════════════════════ */
// The same tokens, surfaces and motion as Docs. Dark mode re-tints the chrome
// only; the slide canvas is always the slide theme.

const APP_CSS = `
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
  --field: rgba(24,24,32,0.045);
  --accent: #e1632e;
  --accent-soft: rgba(225,99,46,0.12);
  --selection: rgba(225,99,46,0.2);
  --tip-bg: #1d1d21;
  --tip-text: #f4f4f5;
  --ok: #2f9e66;
  --bad: #d0473f;
  --canvas: #f3f3f5;
  --shadow-pop: 0 0 0 0.5px rgba(24,24,32,0.14), 0 2px 6px -1px rgba(24,24,32,0.06), 0 14px 36px -8px rgba(24,24,32,0.2);
  --shadow-slide: 0 0 0 0.5px rgba(24,24,32,0.1), 0 2px 6px -2px rgba(24,24,32,0.08), 0 24px 56px -18px rgba(24,24,32,0.28);
  --ease: cubic-bezier(0.2, 0.8, 0.2, 1);
  --font-ui: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif;
  --font-mono: ui-monospace, "SF Mono", "JetBrains Mono", "Cascadia Code", Menlo, Consolas, monospace;
  --bar-h: 48px;
  --rail-w: 160px;
  --insp-w: 288px;
}
@media screen and (prefers-color-scheme: dark) {
  :root:not(.slides-export) {
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
    --field: rgba(255,255,255,0.055);
    --accent: #f0743d;
    --accent-soft: rgba(240,116,61,0.16);
    --selection: rgba(240,116,61,0.32);
    --tip-bg: #f1f1f3;
    --tip-text: #19191c;
    --canvas: #111113;
    --shadow-pop: 0 0 0 0.5px rgba(255,255,255,0.12), 0 14px 36px -6px rgba(0,0,0,0.6);
    --shadow-slide: 0 0 0 0.5px rgba(255,255,255,0.08), 0 24px 56px -14px rgba(0,0,0,0.75);
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
button { font: inherit; color: inherit; -webkit-tap-highlight-color: transparent; }
* { scrollbar-width: thin; scrollbar-color: var(--line-strong) transparent; }
*::-webkit-scrollbar { width: 10px; height: 10px; }
*::-webkit-scrollbar-thumb { background: var(--line-strong); border-radius: 10px; border: 3px solid transparent; background-clip: content-box; }
*::-webkit-scrollbar-track { background: transparent; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }

/* ── App frame ──────────────────────────────────────────────────────────── */
#root { position: fixed; inset: 0; display: flex; flex-direction: column; }
.bar {
  position: relative; z-index: 30; flex: 0 0 auto;
  height: var(--bar-h); margin-top: 0;
  display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 8px;
  padding: 0 10px;
  background: var(--chrome);
  -webkit-backdrop-filter: saturate(1.8) blur(16px); backdrop-filter: saturate(1.8) blur(16px);
  box-shadow: 0 1px 0 var(--line);
  transition: margin-top .34s var(--ease), opacity .2s var(--ease);
}
.presenting .bar { margin-top: calc(-1 * var(--bar-h)); opacity: 0; pointer-events: none; }
.bar-left { grid-column: 1; min-width: 0; }
.tools { grid-column: 2; display: flex; align-items: center; gap: 1px; min-width: 0; }
.bar-right { grid-column: 3; justify-self: end; display: flex; align-items: center; gap: 2px; }
#root:not(.editing) .edit-only { display: none; }
@media (max-width: 900px) {
  .bar { display: flex; padding: 0 6px 0 4px; }
  .bar-left { display: none; }
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
.tb.labeled { gap: 6px; padding: 0 10px 0 8px; font-size: 13px; font-weight: 500; letter-spacing: -0.006em; }
.tb.labeled.on { color: var(--accent); background: var(--accent-soft); }
.tb.danger:hover { color: var(--bad); }
.tb.counter { min-width: 66px; padding: 0 5px 0 10px; gap: 3px; font-size: 13px; font-weight: 500; font-variant-numeric: tabular-nums; }
.tb.counter .of { color: var(--faint); }
.sep { width: 1px; height: 18px; background: var(--line); margin: 0 6px; flex: 0 0 auto; }
@media (pointer: coarse) { .tb { height: 36px; min-width: 36px; } :root { --bar-h: 52px; } }
@media (max-width: 900px) { .tb.labeled .lbl { display: none; } .tb.labeled { padding: 0 6px; } }

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
@media (max-width: 900px) { .status:not(.show) { display: none; } }
@keyframes breathe { 0%, 100% { opacity: 1; } 50% { opacity: .25; } }

/* ── Workspace: rail · stage · inspector ───────────────────────────────── */
.workspace { position: relative; flex: 1 1 auto; min-height: 0; display: flex; }
.panel { position: relative; z-index: 2; flex: 0 0 auto; width: 0; overflow: hidden; background: var(--bg); transition: width .32s var(--ease), height .32s var(--ease), box-shadow .32s var(--ease); }
.panel-inner { height: 100%; display: flex; flex-direction: column; opacity: 0; transition: opacity .18s var(--ease); }
.rail .panel-inner { width: var(--rail-w); }
.inspector .panel-inner { width: var(--insp-w); }
/* Only what you need is open: the slide list (hideable with ⌘\\) and, while
   a block is selected, its inspector. Everything else lives in menus. */
.editing:not(.rail-hidden) .rail { width: var(--rail-w); box-shadow: 1px 0 0 var(--line); }
.editing.has-sel .inspector { width: var(--insp-w); box-shadow: -1px 0 0 var(--line); }
.editing:not(.rail-hidden) .rail .panel-inner, .editing.has-sel .inspector .panel-inner { opacity: 1; transition-delay: .08s; }
.presenting .panel { width: 0 !important; box-shadow: none !important; }

.stage-wrap { position: relative; flex: 1 1 auto; min-width: 0; min-height: 0; overflow: hidden; background: var(--canvas); transition: background-color .34s var(--ease); }
.presenting .stage-wrap { background: #000; }
.presenting:not(.chrome-awake) .stage-wrap { cursor: none; }
.stage-plate { position: absolute; left: 50%; top: 50%; border-radius: 10px; box-shadow: var(--shadow-slide); transform: translate(-50%, -50%); pointer-events: none; transition: opacity .3s var(--ease); }
.presenting .stage-plate { opacity: 0; }
.zoom-ctl { position: absolute; right: 12px; bottom: 12px; z-index: 6; display: flex; align-items: center; gap: 1px; padding: 3px; border-radius: 10px; background: color-mix(in srgb, var(--raised) 92%, transparent); -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); box-shadow: var(--shadow-pop); opacity: 0; transform: translateY(4px); pointer-events: none; transition: opacity .16s var(--ease), transform .16s var(--ease); }
.zoomed .zoom-ctl { opacity: 1; transform: none; pointer-events: auto; }
.presenting .zoom-ctl { display: none; }
.zoom-ctl .tb { width: 28px; height: 28px; }
.zoom-ctl .zoom-pct { min-width: 44px; text-align: center; font-size: 12px; font-weight: 550; font-variant-numeric: tabular-nums; color: var(--text-2); }
.zoom-ctl .zoom-fit { width: auto; padding: 0 9px; font-size: 12px; font-weight: 550; }
.zoom-ctl .sep { margin: 0 3px; }
#stage { position: absolute; top: 50%; left: 50%; width: 1200px; height: 675px; transform-origin: center center; overflow: hidden; }
#stage.loading { background: var(--raised); }
.sk { position: absolute; border-radius: 10px; opacity: 0; background: linear-gradient(90deg, var(--field) 0%, var(--hover) 40%, var(--field) 80%); background-size: 300% 100%; animation: shimmer 1.6s linear infinite, sk-in .3s var(--ease) .25s forwards; }
@keyframes shimmer { from { background-position: 100% 0; } to { background-position: -200% 0; } }
@keyframes sk-in { to { opacity: 1; } }

@media (max-width: 900px) {
  .workspace { flex-direction: column; }
  .stage-wrap { order: 1; min-height: 200px; }
  .rail { order: 2; }
  .inspector { order: 3; }
  .panel { width: auto !important; height: 0; }
  .rail .panel-inner, .inspector .panel-inner { width: auto; }
  .editing .rail { height: 104px; box-shadow: 0 -1px 0 var(--line); }
  .editing .rail .panel-inner { opacity: 1; }
  .editing.has-sel .inspector { height: 40vh; box-shadow: 0 -1px 0 var(--line); }
  .presenting .panel { height: 0 !important; }
  .rail .search, .rail-foot { display: none; }
}

/* ── Rail: slide search, thumbnails, add slide ─────────────────────────── */
.search {
  display: flex; align-items: center; gap: 7px; height: 32px; padding: 0 6px 0 9px;
  border-radius: 8px; background: var(--field); color: var(--muted);
  transition: background-color .12s var(--ease), box-shadow .12s var(--ease);
}
.search:hover { background: var(--hover); }
.search:focus-within { background: var(--raised); box-shadow: inset 0 0 0 1px var(--accent), 0 0 0 3px var(--accent-soft); }
.search svg { flex: 0 0 auto; }
.search input { flex: 1 1 auto; min-width: 0; height: 100%; border: 0; outline: 0; background: transparent; color: var(--text); font: 13px var(--font-ui); padding: 0; }
.search input::placeholder { color: var(--faint); }
.search .clear { width: 20px; height: 20px; border: 0; border-radius: 5px; padding: 0; display: inline-flex; align-items: center; justify-content: center; background: transparent; color: var(--faint); cursor: pointer; opacity: 0; pointer-events: none; transition: opacity .12s var(--ease), background-color .12s, color .12s; }
.search.has-q .clear { opacity: 1; pointer-events: auto; }
.search .clear:hover { background: var(--hover); color: var(--text); }
/* The slide list is quiet by design: no row backgrounds, just the slides.
   Thumbnails are sized to the exact column width (--tw), so every slide is
   a true 16:9 with no slack. A hairline drawn *over* each thumbnail keeps
   white slides legible on the white rail. */
.rail .search { margin: 10px 8px 4px; height: 30px; }
.search .count { flex: 0 0 auto; padding: 0 1px; font-size: 11.5px; color: var(--faint); font-variant-numeric: tabular-nums; opacity: 0; transition: opacity .12s var(--ease), color .12s var(--ease); }
.search.has-q .count { opacity: 1; }
.search .count.none { color: var(--bad); }
.slide-list {
  position: relative; flex: 1 1 auto; overflow-y: auto; overflow-x: hidden;
  padding: 6px 8px 16px; scrollbar-gutter: stable; outline: none;
  --fade-t: 0px; --fade-b: 0px;
  -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 var(--fade-t), #000 calc(100% - var(--fade-b)), transparent 100%);
  mask-image: linear-gradient(to bottom, transparent 0, #000 var(--fade-t), #000 calc(100% - var(--fade-b)), transparent 100%);
}
.slide-list.fade-t { --fade-t: 16px; }
.slide-list.fade-b { --fade-b: 22px; }
.srow {
  position: relative; display: grid; grid-template-columns: 16px var(--tw, 108px); column-gap: 6px; align-items: start;
  padding: 4px 0 9px; cursor: pointer; outline: none; -webkit-tap-highlight-color: transparent;
  transition: opacity .16s var(--ease);
}
.srow .num { grid-column: 1; grid-row: 1; padding-top: 2px; text-align: right; font-size: 11px; line-height: 14px; color: var(--faint); font-variant-numeric: tabular-nums; letter-spacing: -0.01em; transition: color .12s var(--ease); }
.srow:hover .num { color: var(--muted); }
.srow.active .num { color: var(--accent); font-weight: 600; }
.thumb { grid-column: 2; grid-row: 1; position: relative; border-radius: 5px; overflow: hidden; background: var(--raised); transition: box-shadow .18s var(--ease), transform .12s var(--ease); }
/* Off-screen thumbnails skip style, layout and paint. Their size is fixed inline. */
.thumb-canvas { content-visibility: auto; }
.thumb::after { content: ""; position: absolute; inset: 0; z-index: 1; border-radius: inherit; pointer-events: none; box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--text) 10%, transparent); transition: box-shadow .18s var(--ease); }
.srow:hover .thumb::after { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--text) 20%, transparent); }
.srow:hover:not(.active) .thumb { box-shadow: 0 1px 2px rgba(24,24,32,.06), 0 4px 12px -6px rgba(24,24,32,.18); }
.srow:active .thumb { transform: scale(.985); }
.srow.active .thumb { box-shadow: 0 0 0 2px var(--bg), 0 0 0 3.5px var(--accent); }
.srow:focus-visible:not(.active) .thumb { box-shadow: 0 0 0 2px var(--bg), 0 0 0 3.5px color-mix(in srgb, var(--accent) 45%, transparent); }
.srow .lbl { grid-column: 2; grid-row: 2; margin-top: 5px; min-width: 0; font-size: 11.5px; line-height: 15px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; transition: color .12s var(--ease); }
.srow.active .lbl { color: var(--text); }
.srow .lbl.placeholder { color: var(--faint); }
.srow.active .lbl.placeholder { color: var(--muted); }
.srow.dragging { opacity: .35; }
.thumb-actions { position: absolute; top: 4px; right: 4px; z-index: 2; display: flex; gap: 2px; opacity: 0; transform: translateY(-2px); pointer-events: none; transition: opacity .14s var(--ease), transform .14s var(--ease); }
.srow:hover .thumb-actions, .srow:focus-visible .thumb-actions, .thumb-actions:focus-within { opacity: 1; transform: none; pointer-events: auto; }
.slide-list.reordering .thumb-actions { opacity: 0 !important; pointer-events: none !important; }
.mini { width: 22px; height: 22px; padding: 0; border: 0; border-radius: 6px; display: inline-flex; align-items: center; justify-content: center; background: color-mix(in srgb, var(--raised) 90%, transparent); -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); color: var(--text-2); box-shadow: var(--shadow-pop); cursor: pointer; transition: color .12s var(--ease), transform .12s var(--ease); }
.mini:hover { color: var(--text); }
.mini:active { transform: scale(.9); }
.mini.danger:hover { color: var(--bad); }
.inline-edit:empty { min-width: 4ch; }
.inline-edit:empty::before { content: attr(data-ph); opacity: .4; pointer-events: none; }
.thumb-wash { position: absolute; inset: 0; z-index: 1; background: color-mix(in srgb, var(--accent) 14%, transparent); box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--accent) 55%, transparent); border-radius: inherit; pointer-events: none; }
.drop-line { position: absolute; left: 0; top: 0; height: 2px; border-radius: 2px; background: var(--accent); pointer-events: none; z-index: 3; transition: transform .1s var(--ease); }
.drop-line::before { content: ""; position: absolute; left: -5px; top: -3px; width: 4px; height: 4px; border-radius: 50%; border: 2px solid var(--accent); background: var(--bg); }
.list-empty { padding: 28px 8px; text-align: center; color: var(--muted); font-size: 12.5px; }
.list-empty .q { margin-top: 4px; color: var(--faint); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rail-foot { flex: 0 0 auto; padding: 6px 8px 8px; box-shadow: 0 -1px 0 transparent; transition: box-shadow .2s var(--ease); }
.rail-foot.lifted { box-shadow: 0 -1px 0 var(--line); }
/* One control with two halves: a hairline ring at rest (so it reads as a
   button, not loose text), a short inset divider that never touches the
   edges, and hover/press tints that fill exactly the half you're on, with
   the ring firming up as you approach. */
.split { position: relative; display: flex; align-items: stretch; height: 30px; border-radius: 8px; overflow: hidden; box-shadow: inset 0 0 0 1px var(--line); transition: box-shadow .14s var(--ease); }
.split:hover, .split:has(.caret.open) { box-shadow: inset 0 0 0 1px var(--line-strong); }
.split button { position: relative; border: 0; padding: 0; background: transparent; color: var(--text-2); cursor: pointer; display: inline-flex; align-items: center; gap: 7px; font-size: 12.5px; font-weight: 500; letter-spacing: -0.006em; transition: background-color .12s var(--ease), color .12s var(--ease); }
.split button:hover { background: var(--hover); color: var(--text); }
.split button:active { background: var(--press); }
.split button:focus-visible { outline: none; background: var(--hover); box-shadow: inset 0 0 0 1.5px var(--accent); }
.split .main { flex: 1 1 auto; justify-content: flex-start; padding: 0 8px 0 8px; }
.split .main svg { color: var(--muted); transition: color .12s var(--ease); }
.split .main:hover svg { color: var(--text-2); }
.split .caret { width: 28px; flex: 0 0 28px; justify-content: center; color: var(--muted); }
.split .caret::before { content: ""; position: absolute; left: 0; top: 8px; bottom: 8px; width: 1px; background: var(--line-strong); transition: opacity .12s var(--ease); }
.split .main:hover + .caret::before, .split .caret:hover::before, .split .caret.open::before { opacity: 0; }
.split .caret:hover { color: var(--text); }
.split .caret.open { background: var(--press); color: var(--text); }
.split .caret .chev { display: inline-flex; transition: transform .18s var(--ease); }
.split .caret.open .chev { transform: rotate(180deg); }
@media (max-width: 900px) {
  .slide-list { display: flex; gap: 6px; overflow-x: auto; overflow-y: hidden; padding: 10px 12px; scrollbar-gutter: auto; -webkit-mask-image: none; mask-image: none; }
  .srow { flex: 0 0 auto; grid-template-columns: var(--tw, 120px); padding: 2px; }
  .srow .num, .srow .lbl { display: none; }
  .thumb { grid-column: 1; }
}

/* ── Inspector ──────────────────────────────────────────────────────────── */
.insp-scroll { flex: 1 1 auto; overflow-y: auto; overflow-x: hidden; padding-bottom: 36px; }
.sec { padding: 12px 14px 14px; }
.sec + .sec { border-top: 1px solid var(--line); }
.sec-head { display: flex; align-items: center; gap: 8px; padding: 2px 2px 8px; font-size: 11.5px; font-weight: 550; color: var(--muted); }
.pop.lib-pop { width: 300px; padding: 0; overflow: hidden; display: flex; flex-direction: column; max-height: min(480px, calc(100vh - 80px)); }
.lib-pop .search { margin: 6px; flex: 0 0 auto; }
.lib-list { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 0 5px 5px; }
.pop.slide-pop { width: 280px; padding: 8px 12px 10px; max-height: min(680px, calc(100vh - 80px)); }
.slide-pop .mhead { padding: 2px 0 6px; }
.mhead { padding: 7px 8px 5px; font-size: 11.5px; font-weight: 550; color: var(--muted); }
.lib .mhead { padding: 8px 6px 4px; }
.lib-item { display: flex; align-items: center; gap: 10px; width: 100%; padding: 5px 6px; border: 0; border-radius: 7px; background: transparent; color: var(--text); text-align: left; cursor: pointer; transition: background-color .1s var(--ease); }
.lib-item:hover, .lib-item.active { background: var(--hover); }
.lib-ico { width: 30px; height: 30px; flex: 0 0 30px; border-radius: 7px; background: var(--bg); box-shadow: inset 0 0 0 1px var(--line); color: var(--text-2); display: flex; align-items: center; justify-content: center; transition: color .12s var(--ease), box-shadow .12s var(--ease); }
.lib-item:hover .lib-ico, .lib-item.active .lib-ico { color: var(--accent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 35%, transparent); }
.lib-text { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }
.lib-name { font-size: 13px; line-height: 18px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lib-desc { font-size: 11.5px; line-height: 15px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lib-plus { display: inline-flex; color: var(--faint); opacity: 0; transform: translateX(-3px); transition: opacity .14s var(--ease), transform .14s var(--ease), color .14s; }
.lib-item:hover .lib-plus, .lib-item.active .lib-plus { opacity: 1; transform: none; color: var(--accent); }
.mempty { padding: 14px 10px; text-align: center; color: var(--faint); }

.fields { display: flex; flex-direction: column; gap: 2px; }
.frow { display: grid; grid-template-columns: 86px minmax(0, 1fr); align-items: center; gap: 10px; min-height: 32px; }
.frow > label { font-size: 12.5px; color: var(--text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.frow.stacked { display: block; padding: 5px 0 3px; }
.frow.stacked > label { display: block; margin-bottom: 6px; }
.field-input {
  width: 100%; min-width: 0; height: 28px; padding: 0 8px;
  border: 0; border-radius: 7px; background: var(--field); color: var(--text);
  font: 13px var(--font-ui); outline: none; box-shadow: inset 0 0 0 1px transparent;
  transition: background-color .12s var(--ease), box-shadow .12s var(--ease);
}
.field-input::placeholder { color: var(--faint); }
.field-input:hover { background: var(--hover); }
.field-input:focus, .field-input:focus-visible { outline: none; background: var(--raised); box-shadow: inset 0 0 0 1px var(--accent), 0 0 0 3px var(--accent-soft); }
.field-textarea { display: block; height: auto; min-height: 72px; padding: 7px 8px; line-height: 1.45; resize: vertical; }
.field-mono { min-height: 120px; font: 11.5px/1.5 var(--font-mono); white-space: pre; overflow-wrap: normal; overflow-x: auto; }
.field-select { appearance: none; -webkit-appearance: none; padding-right: 26px; cursor: pointer; background-image: url("data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%238f8f98' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m7 10 5 5 5-5'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 8px center; }
.field-select option { background: var(--raised); color: var(--text); }
.field-input[type="number"] { font-variant-numeric: tabular-nums; -moz-appearance: textfield; }
.field-input[type="number"]::-webkit-outer-spin-button, .field-input[type="number"]::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
.color-ctl { display: flex; gap: 6px; align-items: center; min-width: 0; }
.swatch { position: relative; width: 28px; height: 28px; flex: 0 0 28px; border-radius: 7px; box-shadow: inset 0 0 0 1px var(--line-strong); cursor: pointer; transition: transform .12s var(--ease); }
.swatch:hover { transform: scale(1.07); }
.swatch:active { transform: scale(.96); }
.swatch input { position: absolute; inset: 0; width: 100%; height: 100%; padding: 0; border: 0; opacity: 0; cursor: pointer; }
.color-ctl .field-input { font: 12px var(--font-mono); letter-spacing: .02em; text-transform: uppercase; }
.toggle-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 32px; margin: 0 -6px; padding: 0 6px; border-radius: 7px; cursor: pointer; user-select: none; font-size: 12.5px; color: var(--text-2); transition: background-color .12s var(--ease); }
.toggle-row:hover { background: var(--hover); }
.switch { width: 28px; height: 16px; border-radius: 8px; background: var(--line-strong); position: relative; flex: 0 0 auto; transition: background-color .2s var(--ease); }
.switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.25); transition: transform .2s var(--ease); }
.switch.on { background: var(--accent); }
.switch.on::after { transform: translateX(12px); }

.sel-head { display: flex; align-items: center; gap: 10px; margin: 2px 0 10px; }
.sel-ico { width: 30px; height: 30px; flex: 0 0 30px; border-radius: 8px; background: var(--accent-soft); color: var(--accent); display: flex; align-items: center; justify-content: center; }
.sel-name { font-size: 13.5px; font-weight: 600; letter-spacing: -0.008em; line-height: 18px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sel-sub { font-size: 11.5px; line-height: 15px; color: var(--muted); }
.sel-head .tb { margin-left: auto; height: 26px; min-width: 26px; color: var(--muted); }
.actions { display: flex; gap: 2px; margin-top: 10px; padding: 3px; border-radius: 9px; background: var(--field); }
.actions .tb { flex: 1 1 0; height: 28px; }
.adv { margin-top: 12px; border-top: 1px solid var(--line); }
.adv-toggle { width: 100%; display: flex; align-items: center; gap: 4px; padding: 10px 0 6px; border: 0; background: transparent; color: var(--muted); font-size: 11.5px; font-weight: 550; cursor: pointer; transition: color .12s var(--ease); }
.adv-toggle:hover { color: var(--text-2); }
.adv-toggle .chev { display: inline-flex; transform: rotate(-90deg); transition: transform .18s var(--ease); }
.adv.open .adv-toggle .chev { transform: none; }
.adv-body { display: flex; flex-direction: column; gap: 2px; animation: adv-in .18s var(--ease); }
@keyframes adv-in { from { opacity: 0; transform: translateY(-3px); } }
.xy { display: grid; grid-template-columns: 1fr 1fr; gap: 2px 8px; margin-bottom: 2px; }
.xy .frow { grid-template-columns: 14px minmax(0, 1fr); gap: 6px; }
.xy .frow > label { color: var(--muted); font-size: 11.5px; }
.empty { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 26px 22px 30px; text-align: center; color: var(--muted); }
.empty-ico { width: 34px; height: 34px; margin-bottom: 4px; border-radius: 9px; background: var(--field); color: var(--faint); display: flex; align-items: center; justify-content: center; }
.empty b { font-size: 13px; font-weight: 550; color: var(--text-2); }
.empty p { margin: 0; max-width: 220px; font-size: 12px; line-height: 1.5; }
.img-ctl { display: flex; flex-direction: column; gap: 6px; }
.img-prev { aspect-ratio: 16 / 9; border-radius: 8px; overflow: hidden; display: flex; align-items: center; justify-content: center; color: var(--faint); font-size: 12px; box-shadow: inset 0 0 0 1px var(--line); background: repeating-conic-gradient(var(--field) 0% 25%, transparent 0% 50%) 0 0 / 16px 16px; }
.img-prev img { width: 100%; height: 100%; object-fit: contain; display: block; }
.img-prev.logo-prev { aspect-ratio: 7 / 2; }
.img-prev.drop { box-shadow: inset 0 0 0 1.5px var(--accent); }
.slide-pop .logo-fields { margin-top: 10px; padding-top: 6px; border-top: 1px solid var(--line); }
.img-btns { display: grid; gap: 6px; }
.btn { height: 30px; border: 0; border-radius: 7px; padding: 0 10px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; background: var(--field); color: var(--text-2); font-size: 12.5px; font-weight: 500; cursor: pointer; transition: background-color .12s var(--ease), color .12s var(--ease), transform .12s var(--ease); }
.btn:hover { background: var(--hover); color: var(--text); }
.btn:active { transform: scale(.97); background: var(--press); }
.btn.danger:hover { color: var(--bad); }
.img-note { font-size: 11.5px; color: var(--muted); }
.img-note.err { color: var(--bad); }

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
.mi { display: flex; align-items: center; gap: 10px; padding: 6px 10px 6px 7px; border-radius: 7px; cursor: pointer; user-select: none; white-space: nowrap; }
.mi:hover, .mi.active, .mi:focus-visible { background: var(--hover); }
.mi:focus { outline: none; }
.mi.danger:hover, .mi.danger:hover .mi-icon { color: var(--bad); }
.mi-icon { width: 22px; height: 22px; flex: 0 0 auto; display: flex; align-items: center; justify-content: center; color: var(--muted); }
.mi-icon svg { display: block; }
.mi-num { width: 22px; flex: 0 0 auto; text-align: right; font-size: 12px; color: var(--faint); font-variant-numeric: tabular-nums; }
.mi-text { flex: 1 1 auto; min-width: 0; display: flex; align-items: baseline; }
.mi-label { flex: 1 1 auto; min-width: 0; line-height: 20px; overflow: hidden; text-overflow: ellipsis; }
.mi-stack { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }
.mi-sub { font-size: 11.5px; line-height: 15px; color: var(--muted); }
.mi-keys { flex: 0 0 auto; padding-left: 24px; color: var(--faint); font: 12.5px/20px var(--font-ui); font-variant-numeric: tabular-nums; transition: color .12s var(--ease); }
.mi:hover .mi-keys, .mi.active .mi-keys { color: var(--muted); }
.mi-check { flex: 0 0 auto; align-self: center; width: 16px; height: 16px; margin-left: 10px; display: flex; align-items: center; justify-content: center; color: var(--accent); visibility: hidden; }
.mi-check.on { visibility: visible; }
.mi-keys + .mi-check { margin-left: 12px; }
.msep { height: 1px; background: var(--line); margin: 5px -5px; }
.slash { width: 272px; }
.slash .mi { padding-top: 5px; padding-bottom: 5px; }
.slash .mi-icon { width: 30px; height: 30px; border-radius: 7px; background: var(--bg); box-shadow: inset 0 0 0 1px var(--line); color: var(--text-2); }
.slash .mi:hover .mi-icon { color: var(--accent); }
.jump-pop { width: 290px; }
.jump-pop .mi.current .mi-label { font-weight: 550; }

/* Shortcut glyphs: on a Mac each single-character key gets a fixed-width cell. */
.k { display: inline-block; text-align: center; }
.mac .k-g { min-width: 1.12em; }
.k-plus { display: inline-block; margin: 0 .1em; opacity: .7; }

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
.chip.md { font: 400 11.5px/22px var(--font-ui); }

/* ── Present mode ───────────────────────────────────────────────────────── */
.present-exit {
  position: absolute; top: 14px; right: 14px; z-index: 12;
  width: 36px; height: 36px; padding: 0; border: 0; border-radius: 10px;
  display: none; align-items: center; justify-content: center;
  background: rgba(28,28,32,.62); color: #f4f4f5; cursor: pointer;
  -webkit-backdrop-filter: saturate(1.6) blur(14px); backdrop-filter: saturate(1.6) blur(14px);
  opacity: 0; transform: translateY(-4px);
  transition: opacity .22s var(--ease), transform .22s var(--ease), background-color .12s;
}
.presenting .present-exit { display: inline-flex; }
.presenting.chrome-awake .present-exit { opacity: 1; transform: none; }
.present-exit:hover { background: rgba(52,52,58,.78); }
.present-exit:active { transform: scale(.94); }
.present-note {
  position: absolute; left: 50%; bottom: 22px; z-index: 12;
  display: flex; align-items: center; gap: 8px;
  padding: 6px 10px; border-radius: 10px;
  background: rgba(28,28,32,.66); color: #e9e9ec; font-size: 12.5px; white-space: nowrap;
  -webkit-backdrop-filter: saturate(1.6) blur(14px); backdrop-filter: saturate(1.6) blur(14px);
  opacity: 0; transform: translate(-50%, 6px); pointer-events: none;
  transition: opacity .3s var(--ease), transform .3s var(--ease);
}
.present-note.show { opacity: 1; transform: translate(-50%, 0); }
.present-note .chip { background: rgba(255,255,255,.12); box-shadow: inset 0 -1px 0 rgba(255,255,255,.2); color: #f4f4f5; }
.present-note .dim { color: rgba(233,233,236,.55); }
.present-note.count { font-variant-numeric: tabular-nums; font-weight: 500; }

/* ── Selection: floating block bar, marquee, Select tool ───────────────── */
.blockbar {
  position: absolute; left: 0; top: 0; z-index: 9;
  display: flex; align-items: center; gap: 1px; padding: 3px;
  border-radius: 10px; background: var(--raised); box-shadow: var(--shadow-pop);
  white-space: nowrap; transform-origin: var(--origin, center bottom);
  transition: opacity .12s var(--ease);
}
/* The bar is placed with transform: translate(), so it animates with the
   separate scale property. Animating transform would drop the translate
   and send it flying from / to the stage's top-left corner. It grows from,
   and shrinks back toward, the selection (--origin). */
.blockbar.enter { animation: bb-in .16s var(--ease); }
.blockbar.closing { animation: bb-out .1s ease-in forwards; pointer-events: none; }
@keyframes bb-in { from { opacity: 0; scale: .96; } }
@keyframes bb-out { to { opacity: 0; scale: .98; } }
.blockbar .tb { height: 28px; min-width: 28px; }
.blockbar .tb.labeled { padding: 0 9px 0 7px; }
.blockbar .sep { height: 16px; margin: 0 3px; }
.bb-count { padding: 0 6px 0 8px; font-size: 12.5px; font-weight: 550; color: var(--text); font-variant-numeric: tabular-nums; }
/* Quick text style: [− 28 +] [● ▾] */
.bb-size { display: inline-flex; align-items: center; gap: 0; }
.blockbar .tb.bb-step { min-width: 24px; width: 24px; padding: 0; color: var(--muted); }
.blockbar .tb.bb-step:hover { color: var(--text); }
.bb-size-input {
  width: 34px; height: 24px; padding: 0; border: 0; border-radius: 6px;
  background: var(--field); color: var(--text); text-align: center;
  font: 500 12.5px/24px var(--font-ui); font-variant-numeric: tabular-nums;
  transition: background-color .12s var(--ease), box-shadow .12s var(--ease);
}
.bb-size-input:hover { background: var(--hover); }
.bb-size-input:focus { outline: none; background: var(--raised); box-shadow: inset 0 0 0 1.5px var(--accent); }
.bb-size-input::placeholder { color: var(--faint); }
.blockbar .tb.bb-color { gap: 4px; padding: 0 6px 0 7px; }
.bb-dot { width: 16px; height: 16px; flex: 0 0 16px; border-radius: 50%; box-shadow: inset 0 0 0 1px var(--line-strong); }
.bb-dot.mixed { background: conic-gradient(#000 0 25%, #FF6633 0 50%, #FFF 0 75%, #F6821F 0); }
.bb-dot.none, .csw.none { background: linear-gradient(to top right, transparent calc(50% - 1px), var(--bad) calc(50% - 1px) calc(50% + 1px), transparent calc(50% + 1px)), #fff; }
.blockbar .tb.bb-menu { gap: 1px; padding: 0 5px 0 4px; }
.blockbar .tb[aria-pressed="true"] { color: var(--accent); background: var(--accent-soft); }
/* Fixed choices as dots: [● ● ●] */
.bb-dots { display: inline-flex; align-items: center; gap: 1px; padding: 0 2px; }
.bb-tdot { width: 26px; height: 28px; padding: 0; border: 0; border-radius: 7px; background: transparent; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; transition: background-color .12s var(--ease); }
.bb-tdot:hover { background: var(--hover); }
.bb-tdot span { width: 14px; height: 14px; border-radius: 50%; box-shadow: inset 0 0 0 1px var(--line-strong); transition: transform .12s var(--ease), box-shadow .12s var(--ease); }
.bb-tdot:active span { transform: scale(.88); }
.bb-tdot.on span { box-shadow: inset 0 0 0 1px var(--line-strong), 0 0 0 2px var(--raised), 0 0 0 3.5px var(--accent); }
.pop.color-pop { min-width: 0; padding: 4px 8px 10px; }
.color-pop .mhead { padding: 6px 0 6px; }
.cgrid { display: grid; grid-template-columns: repeat(7, 26px); gap: 6px; }
.csw {
  position: relative; width: 26px; height: 26px; padding: 0; border: 0; border-radius: 50%;
  box-shadow: inset 0 0 0 1px var(--line-strong); cursor: pointer;
  transition: transform .12s var(--ease), box-shadow .12s var(--ease);
}
.csw:hover { transform: scale(1.08); }
.csw:active { transform: scale(.95); }
.csw.on { box-shadow: inset 0 0 0 1px var(--line-strong), 0 0 0 2px var(--raised), 0 0 0 3.5px var(--accent); }
.csw.none.on { box-shadow: inset 0 0 0 1px var(--line-strong), 0 0 0 2px var(--raised), 0 0 0 3.5px var(--accent); }
.csw.custom:not(.on) { background: conic-gradient(from 90deg, #ff5f5f, #ffd25f, #6fe07a, #5fc8ff, #8b6bff, #ff5fd2, #ff5f5f); }
.csw input { position: absolute; inset: 0; width: 100%; height: 100%; padding: 0; border: 0; opacity: 0; cursor: pointer; }
/* Narrow screens: the reorder buttons stay in the Format panel. */
@media (max-width: 480px) { .blockbar.has-style .bb-order { display: none; } }
@media (max-width: 400px) { .blockbar.has-style .bb-dup { display: none; } }
@media (pointer: coarse) { .blockbar .tb.bb-step { width: 32px; min-width: 32px; } .bb-size-input { height: 30px; width: 38px; font-size: 16px; } }
.dragging .blockbar { opacity: 0; pointer-events: none; }
.presenting .blockbar { display: none; }
.marquee { position: absolute; z-index: 7; pointer-events: none; border-radius: 2px; background: color-mix(in srgb, var(--accent) 9%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 75%, transparent); }
.editing.select-tool .stage-wrap { cursor: crosshair; }
.dragging, .dragging * { user-select: none; -webkit-user-select: none; }

/* ── Live edits (agent changes landing) ─────────────────────────────────── */
.ag-layer { position: absolute; left: 0; top: 0; width: 0; height: 0; pointer-events: none; z-index: 6; }
.ag-layer > * { position: absolute; left: 0; top: 0; pointer-events: none; }
.ag-mark { border-radius: 3px; background: color-mix(in srgb, var(--accent) 22%, transparent); }
.ag-wash { border-radius: 7px; background: color-mix(in srgb, var(--accent) 6.5%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 22%, transparent); }
.ag-tick { width: 2px !important; border-radius: 1px; background: color-mix(in srgb, var(--accent) 70%, transparent); }
.ag-pen {
  width: 2px; border-radius: 1px; background: var(--accent); opacity: 0;
  transition: opacity .35s var(--ease), transform .28s cubic-bezier(.2,.8,.2,1), height .28s cubic-bezier(.2,.8,.2,1);
}
.ag-pen.show { opacity: .85; transition: opacity .12s var(--ease), transform .28s cubic-bezier(.2,.8,.2,1), height .28s cubic-bezier(.2,.8,.2,1); }
.ag-pen.jump { transition: opacity .12s var(--ease); }

/* ── Export & print ─────────────────────────────────────────────────────── */
@media screen {
  html.slides-export, html.slides-export body {
    height: auto !important;
    min-height: 100%;
    overflow: visible !important;
    background: #f5f1eb !important;
  }
  html.slides-export body { padding: 24px; }
  html.slides-export #root { display: none !important; }
  html.slides-export #printDeck { display: block; }
  html.slides-export .print-slide {
    width: 1200px;
    height: 675px;
    margin: 0 auto 24px;
    overflow: hidden;
    box-shadow: 0 12px 36px rgba(43, 28, 20, 0.16);
  }
  html.slides-export .print-slide:last-child { margin-bottom: 0; }
  html.slides-export .print-slide > .slide-frame { border-radius: 0 !important; }
}
#printDeck { display: none; }
@page { size: 12.5in 7.03125in; margin: 0; }
@media print {
  html, body {
    width: 1200px;
    height: auto !important;
    margin: 0;
    overflow: visible !important;
    background: #fff !important;
  }
  #root, .tip, .pop, .sheet-overlay { display: none !important; }
  #printDeck { display: block; }
  .print-slide {
    width: 1200px;
    height: 675px;
    overflow: hidden;
    break-after: page;
  }
  .print-slide:last-child { break-after: auto; }
  .print-slide > .slide-frame { border-radius: 0 !important; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: .01ms !important; transition-duration: .01ms !important; }
}
`;
document.head.appendChild(el("style", { text: APP_CSS }));

/* ═══════════════ 7. Chrome primitives: tips, menus, sheet, status ════════ */

// ── Tooltips (delayed, then instant while moving along the toolbar) ───────
/** An element with a tooltip: attachTip() / setTip() keep its label and shortcut on it. */
type TipTarget = HTMLElement & { _tip?: { label: string; keys?: string[] | null } };

const tip = el("div", { class: "tip", role: "tooltip" });
let tipTimer: ReturnType<typeof setTimeout> | undefined, tipOwner: HTMLElement | null = null, tipWarmUntil = 0;
function showTip(target: HTMLElement, label: string, keys?: string[] | null): void {
  if (openPop?.owner === target || !target.isConnected) return;
  tip.replaceChildren(el("span", {}, label));
  if (keys?.length) tip.appendChild(keysEl(keys, "tip-keys"));
  tip.classList.remove("show");
  document.body.appendChild(tip);
  const r = target.getBoundingClientRect();
  const w = tip.offsetWidth, h = tip.offsetHeight;
  tip.style.left = clamp(r.left + r.width / 2 - w / 2, 6, innerWidth - w - 6) + "px";
  tip.style.top = (r.bottom + 7 + h > innerHeight - 6 ? r.top - 7 - h : r.bottom + 7) + "px";
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
function attachTip(target: TipTarget, label: string, keys?: string[] | null): void {
  target.setAttribute("aria-label", label);
  target._tip = { label, keys };
  if (coarsePointer) return;
  target.addEventListener("pointerenter", () => {
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => showTip(target, target._tip?.label ?? label, target._tip?.keys), Date.now() < tipWarmUntil ? 0 : 520);
  });
  target.addEventListener("pointerleave", hideTip);
  target.addEventListener("pointerdown", () => { hideTip(); tipWarmUntil = 0; });
}
function setTip(target: TipTarget, label: string, keys?: string[] | null): void {
  target.setAttribute("aria-label", label);
  target._tip = { label, keys };
}
function tb(icon: string | null, label: string | null, keys: string[] | null, onClick: (e: MouseEvent, b: HTMLButtonElement) => void, className = ""): HTMLButtonElement {
  const b = el("button", { class: "tb " + className, type: "button", html: icon ? ico(ICONS[icon]) : "" });
  b.addEventListener("click", (e) => onClick(e, b));
  if (label) attachTip(b, label, keys);
  return b;
}
const sep = (className = "") => el("span", { class: "sep " + className, "aria-hidden": "true" });

// ── Popovers ─────────────────────────────────────────────────────────────
/** Where a popover sits against its anchor's rect. */
type PopAlign = "start" | "center" | "end";
interface PopOptions {
  className?: string;
  owner?: HTMLElement | null;
  kind?: "menu" | "dialog";
  align?: PopAlign | string;
}
let openPop: { pop: HTMLDivElement; owner: HTMLElement | null; kind: string; align: string } | null = null;
function showPop(content: ElChild | ElChild[], rect: DOMRect, { className = "", owner = null, kind = "menu", align = "start" }: PopOptions = {}): HTMLDivElement {
  closePop(true);
  hideTip();
  const pop = el("div", { class: "pop " + className, role: kind === "menu" ? "menu" : "dialog" }, content);
  pop.addEventListener("mousedown", (e) => { if (!(e.target instanceof Element && e.target.closest("input, textarea, select"))) e.preventDefault(); });
  document.body.appendChild(pop);
  openPop = { pop, owner, kind, align };
  owner?.classList.add("open");
  placePop(pop, rect, align);
  if (kind === "menu") wireMenuKeys(pop, owner);
  return pop;
}
// Menu rows work from the keyboard: the current (or first) row takes focus,
// arrows and Home/End move between rows, Enter or Space picks one, and Esc or
// Tab closes the menu back onto its button. The keys stop here, so they don't
// also drive the slide. A menu with a search box keeps its own keys, and one
// opened while text is being edited leaves the focus in that text.
function wireMenuKeys(pop: HTMLDivElement, owner: HTMLElement | null): void {
  const rows = () => Array.from(pop.querySelectorAll<HTMLElement>(".mi"));
  for (const row of rows()) row.tabIndex = -1;
  if (pop.querySelector("input")) return;
  pop.addEventListener("keydown", (e) => {
    const list = rows(), i = list.indexOf(document.activeElement as HTMLElement);
    const move = (to: number) => list[(to + list.length) % list.length]?.focus();
    if (e.key === "ArrowDown") move(i + 1);
    else if (e.key === "ArrowUp") move(i < 0 ? -1 : i - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(-1);
    else if ((e.key === "Enter" || e.key === " ") && i >= 0) list[i].click();
    else if (e.key === "Escape" || e.key === "Tab") { closePop(); owner?.focus(); }
    else return;
    e.preventDefault();
    e.stopPropagation();
  });
  if (!isEditingInline()) (pop.querySelector<HTMLElement>(".mi.current") ?? rows()[0])?.focus({ preventScroll: true });
}
function placePop(pop: HTMLElement, r: DOMRect, align = "start"): void {
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
  const { pop, owner } = openPop;
  openPop = null;
  owner?.classList.remove("open");
  if (immediate || reducedMotion.matches) pop.remove();
  else { pop.classList.add("closing"); setTimeout(() => pop.remove(), 110); }
}
function toggleMenu(owner: HTMLElement, build: (owner: HTMLElement) => void): void {
  if (openPop?.owner === owner) return closePop();
  build(owner);
}
document.addEventListener("mousedown", (e) => {
  if (!openPop) return;
  const target = e.target instanceof Node ? e.target : null;
  if (openPop.pop.contains(target) || openPop.owner?.contains(target)) return;
  closePop();
}, true);
window.addEventListener("resize", () => closePop(true));

// Row anatomy: [icon | number] [label (+ sub) ……… shortcut] [check slot].
/** A menu row: see menuItem(). */
interface MenuItemSpec {
  icon?: string;
  num?: number;
  label: string;
  sub?: string;
  keys?: string[];
  checked?: boolean;
  checkSlot?: boolean;
  danger?: boolean;
  className?: string;
  onSelect: () => void;
}
function menuItem({ icon, num, label, sub, keys, checked, checkSlot = false, danger = false, className = "", onSelect }: MenuItemSpec): HTMLDivElement {
  const showKeys = keys?.length && !coarsePointer;
  const labelEl = sub
    ? el("span", { class: "mi-stack" }, [el("span", { class: "mi-label" }, label), el("span", { class: "mi-sub" }, sub)])
    : el("span", { class: "mi-label" }, label);
  const text = el("span", { class: "mi-text" }, [
    labelEl,
    showKeys && keys ? keysEl(keys, "mi-keys") : null,
    checkSlot ? el("span", { class: "mi-check" + (checked ? " on" : ""), html: ico(ICONS.check, 15) }) : null
  ]);
  const item = el("div", { class: "mi" + (danger ? " danger" : "") + (className ? " " + className : ""), role: checkSlot ? "menuitemradio" : "menuitem", "aria-checked": checkSlot ? String(!!checked) : null }, [
    icon ? el("span", { class: "mi-icon", html: ico(ICONS[icon], 17) }) : num != null ? el("span", { class: "mi-num" }, String(num)) : null,
    text
  ]);
  item.addEventListener("click", () => { closePop(); onSelect(); });
  return item;
}
function layoutMenu(owner: HTMLElement, align: PopAlign = "start"): void {
  showPop([
    el("div", { class: "mhead" }, "New slide after this one"),
    ...LAYOUTS.map((l) => menuItem({ icon: l.icon, label: l.label, sub: l.sub, onSelect: () => addSlide(SLIDE_LAYOUTS[l.key]()) }))
  ], owner.getBoundingClientRect(), { owner, className: "slash", align });
}
function jumpMenu(owner: HTMLElement): void {
  const pop = showPop([
    el("div", { class: "mhead" }, "Go to slide"),
    ...deck.slides.map((s, i) => menuItem({ num: i + 1, label: slideLabel(s), checked: i === currentIndex, checkSlot: true, className: i === currentIndex ? "current" : "", onSelect: () => go(i) }))
  ], owner.getBoundingClientRect(), { owner, className: "jump-pop", align: "center" });
  pop.querySelector(".mi.current")?.scrollIntoView({ block: "nearest" });
}
// Insert: the component library as a menu, like Docs' insert menu. Type to
// filter, arrow keys move the highlight, Enter inserts, Esc clears / closes.
function insertMenu(owner: HTMLElement): void {
  const list = el("div", { class: "lib-list", role: "listbox", "aria-label": "Components" });
  const pick = (type: string) => {
    librarySearch = "";
    libActive = 0;
    closePop();
    addBlockOfType(type);
  };
  const refresh = () => populateLibraryList(list, pick);
  const search = searchField({
    placeholder: "Search components",
    value: librarySearch,
    dataKey: "libSearch",
    onInput: (v) => { librarySearch = v; libActive = 0; refresh(); },
    onEscapeEmpty: () => closePop(),
    onKey: (e) => {
      const order = libraryOrder();
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (!order.length) return;
        libActive = (libActive + (e.key === "ArrowDown" ? 1 : -1) + order.length) % order.length;
        refresh();
        list.querySelector(".lib-item.active")?.scrollIntoView({ block: "nearest" });
      } else if (e.key === "Enter") {
        e.preventDefault();
        const type = order[clamp(libActive, 0, order.length - 1)];
        if (type) pick(type);
      }
    }
  });
  refresh();
  const pop = showPop([search, list], owner.getBoundingClientRect(), { owner, className: "lib-pop", kind: "dialog", align: owner.dataset.align || "start" });
  requestAnimationFrame(() => pop.querySelector("input")?.focus());
}
// Slide settings: the current slide's background, and the deck logo every
// slide shows, in a small popover.
function slideMenu(owner: HTMLElement): void {
  const slide = currentSlide();
  if (!slide) return;
  showPop([
    el("div", { class: "mhead" }, `Slide ${currentIndex + 1}`),
    el("div", { class: "fields" }, [
      colorField("Page color", slide.background?.color || C.page, async (v) => {
        slide.background = { ...slide.background, color: v };
        await api.updateSlide(slide.id, { background: { color: v } });
        renderWhenIdle();
      }),
      numberField("Dot grid", slide.background?.dotGrid ?? 0, async (v) => {
        slide.background = { ...slide.background, dotGrid: v };
        await api.updateSlide(slide.id, { background: { dotGrid: v } });
        renderWhenIdle();
      }, { min: 0, max: 1, step: 0.05 }),
      checkField("Inset surface", slide.background?.inset !== false, async (v) => {
        slide.background = { ...slide.background, inset: v };
        await api.updateSlide(slide.id, { background: { inset: v } });
        renderWhenIdle();
      })
    ]),
    deckLogoSettings()
  ], owner.getBoundingClientRect(), { owner, className: "slide-pop", kind: "dialog", align: "center" });
}
var LOGO_POSITION_LABELS: Record<string, string> = { "top-left": "Top left", "top-right": "Top right", "bottom-left": "Bottom left", "bottom-right": "Bottom right" };
// The deck logo: your image, at one corner of every slide (and of the cover
// slides, unless they're left out). Redrawn in place after each change.
function deckLogoSettings(): HTMLDivElement {
  const logo = deck.logo || null;
  const section = el("div", { class: "fields logo-fields" });
  const set = async (patch: DeckLogoPatch | null) => {
    const stored = await api.setLogo(patch);
    // (A failed call re-reads the deck, which puts the logo right.)
    if (stored || !patch || patch.src === "") deck = { ...deck, logo: stored };
    renderWhenIdle();
    renderSlideList();
    if (section.isConnected) section.replaceWith(deckLogoSettings());
  };
  section.append(
    el("div", { class: "mhead" }, "Logo on every slide"),
    imageField("Logo", logo?.src ?? "", (v) => set(v ? { src: v } : null), LOGO_IMAGE_FIELD)
  );
  if (logo) {
    section.append(
      selectField("Position", logo.position, (v) => set({ position: LOGO_POSITIONS.find((p) => p === v) }), [...LOGO_POSITIONS], LOGO_POSITION_LABELS),
      checkField("Show on cover slides", logo.onCover !== false, (v) => set({ onCover: v })),
      textField("Alt text", logo.alt ?? "", (v) => set({ alt: v }))
    );
  }
  return section;
}
function moreMenu(owner: HTMLElement): void {
  const s = currentSlide();
  const items: HTMLElement[] = [];
  if (s) {
    items.push(
      menuItem({ icon: "duplicate", label: "Duplicate slide", onSelect: () => duplicateSlideById(s.id) }),
      menuItem({ icon: "trash", label: "Delete slide", danger: true, onSelect: () => removeSlideById(s.id) }),
      el("div", { class: "msep" })
    );
  }
  if (editMode) {
    items.push(
      menuItem({ icon: "sidebar", label: railOpen ? "Hide slide list" : "Show slide list", keys: combo("mod", "\\"), onSelect: toggleRail }),
      el("div", { class: "msep" })
    );
  }
  items.push(
    menuItem({ icon: "pencil", label: editMode ? "Done editing" : "Edit slides", keys: ["E"], onSelect: toggleEdit }),
    menuItem({ icon: "play", label: "Present", keys: ["F"], onSelect: togglePresent }),
    el("div", { class: "msep" }),
    menuItem({ icon: "keyboard", label: "Keyboard shortcuts", keys: combo("mod", "/"), onSelect: openShortcuts })
  );
  showPop(items, owner.getBoundingClientRect(), { owner, align: "end" });
}

// ── Shortcuts sheet ──────────────────────────────────────────────────────
let sheetOpen = false;
function openShortcuts() {
  closePop(true);
  if (sheetOpen) return;
  sheetOpen = true;
  const row = (label: string, ...combos: string[][]) => el("div", { class: "krow" }, [
    el("span", {}, label), el("span", { class: "chips" }, combos.map((c) => keysEl(c, "chip")))
  ]);
  const note = (label: string, text: string) => el("div", { class: "krow" }, [el("span", {}, label), el("span", { class: "chips" }, [el("span", { class: "chip md" }, text)])]);
  const overlay = el("div", { class: "sheet-overlay" }, [
    el("div", { class: "sheet", role: "dialog", "aria-label": "Keyboard shortcuts" }, [
      el("h2", {}, "Keyboard shortcuts"),
      el("p", { class: "sub" }, "Press E to edit and F to present. Press / to insert a component. Click a block to select it; Shift-click or drag a box to select several. Drag to move, drag the corner to resize."),
      el("div", { class: "sheet-cols" }, [
        el("div", {}, [
          el("h3", {}, "Slides"),
          row("Next slide", combo("→"), combo("Space")),
          row("Previous slide", combo("←")),
          note("…arrows, while editing", "nothing selected"),
          row("First · last", combo("Home"), combo("End")),
          row("Edit mode", combo("E")),
          row("Present", combo("F")),
          row("Close · deselect · exit", combo("Esc")),
          el("h3", {}, "General"),
          row("Undo · redo", combo("mod", "Z"), isMac ? combo("mod", "shift", "Z") : combo("mod", "Y")),
          row("Save now", combo("mod", "S")),
          row("Zoom in · out · fit", combo("mod", "+"), combo("mod", "−"), combo("mod", "0")),
          note("Zoom · pan", "pinch · two-finger scroll"),
          row("This sheet", combo("mod", "/"))
        ]),
        el("div", {}, [
          el("h3", {}, "Edit mode"),
          row("Insert component", combo("/")),
          row("Show · hide slide list", combo("mod", "\\")),
          el("h3", {}, "Selecting"),
          row("Select tool", combo("V")),
          row("Add to selection", combo("shift", "Click")),
          note("Box-select", "drag on empty canvas"),
          row("Select all", combo("mod", "A")),
          row("Format panel", combo("↵")),
          row("Nudge · nudge 10px", combo("←"), combo("shift", "→")),
          el("h3", {}, "Blocks"),
          row("Copy · cut · paste", combo("mod", "C"), combo("mod", "X"), combo("mod", "V")),
          row("Duplicate", combo("mod", "D")),
          row("Larger · smaller text", combo("mod", "shift", "."), combo("mod", "shift", ",")),
          row("Delete selected", combo(isMac ? "⌫" : "Del")),
          row("Skip snapping", combo(isMac ? "⌥" : "Alt")),
          note("…while dragging", "hold"),
          row("Finish text edit", combo("↵")),
          row("New line in text", combo("shift", "↵")),
          el("h3", {}, "Search"),
          row("Jump to first match", combo("↵")),
          row("Clear search", combo("Esc"))
        ])
      ])
    ])
  ]);
  const close = () => { sheetOpen = false; overlay.remove(); document.removeEventListener("keydown", onKey, true); };
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" || (e.metaKey || e.ctrlKey) && e.key === "/") { e.preventDefault(); e.stopPropagation(); close(); } };
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  document.addEventListener("keydown", onKey, true);
  document.body.appendChild(overlay);
}

// ── Sync status ──────────────────────────────────────────────────────────
// Deliberately quiet: quick saves never flash anything. It speaks up only when
// a save is slow, when you ask (⌘S), or when the connection drops.
const statusLabel = el("span", { class: "s-label" });
const statusEl = el("span", { class: "status", role: "status", "aria-live": "polite" }, [el("span", { class: "s-dot" }), statusLabel]);
/** What the sync pill says: see setSync(). */
type SyncKind = "saving" | "saved" | "offline" | "failed" | "reconnecting";
let syncTimer: ReturnType<typeof setTimeout> | undefined, syncShown: string | null = null, forceSavedFlash = false;
function showSync(kind: string, text: string): void {
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
function setSync(kind: SyncKind): void {
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
    showSync("offline", "Offline · retrying");
  } else if (kind === "failed") {
    clearTimeout(syncTimer);
    showSync("offline", "Couldn't save that change");
    syncTimer = setTimeout(hideSync, 4000);
  } else if (kind === "reconnecting") {
    showSync("offline", "Reconnecting…");
  }
}
function saveNow() {
  // Every change is saved the moment it is made, except text being edited in
  // place (saved when it's left): ⌘S saves that, then says so.
  commitInlineEdit();
  forceSavedFlash = true;
  if (localPending > 0) showSync("saving", "Saving…");
  else setSync("saved");
}

/* ═══════════════ 8. Shell: bar, rail, stage, inspector ═══════════════════ */

function miniBtn(icon: string, label: string, onClick: () => void, danger = false): HTMLButtonElement {
  const b = el("button", { class: "mini" + (danger ? " danger" : ""), type: "button", html: ico(ICONS[icon], 14) });
  b.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
  b.addEventListener("pointerdown", (e) => e.stopPropagation());
  b.draggable = false;
  attachTip(b, label);
  return b;
}
// A Docs-style search field. `onInput(value)`, `onKey(e, input)`.
interface SearchFieldSpec {
  placeholder: string;
  value: string;
  onInput: (value: string) => void;
  onKey?: (e: KeyboardEvent, input: HTMLInputElement) => void;
  dataKey?: string;
  onEscapeEmpty?: () => void;
}
function searchField({ placeholder, value, onInput, onKey, dataKey, onEscapeEmpty }: SearchFieldSpec): HTMLDivElement {
  const input = el("input", { type: "text", placeholder, value, spellcheck: "false", "aria-label": placeholder });
  if (dataKey) input.dataset[dataKey] = "1";
  const box = el("div", { class: "search" + (value ? " has-q" : "") }, [el("span", { html: ico(ICONS.search, 15), style: { display: "inline-flex" } }), input]);
  const clear = el("button", { class: "clear", type: "button", "aria-label": "Clear search", html: ico(ICONS.x, 13) });
  clear.addEventListener("mousedown", (e) => e.preventDefault());
  clear.addEventListener("click", () => { input.value = ""; box.classList.remove("has-q"); onInput(""); input.focus(); });
  box.appendChild(clear);
  input.addEventListener("input", () => { box.classList.toggle("has-q", !!input.value); onInput(input.value); });
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      if (input.value) { input.value = ""; box.classList.remove("has-q"); onInput(""); }
      else if (onEscapeEmpty) onEscapeEmpty();
      else input.blur();
      return;
    }
    onKey?.(e, input);
  });
  return box;
}

function mountShell(): void {
  const btn: Record<string, HTMLButtonElement> = {};
  btn.undo = tb("undo", "Undo", combo("mod", "Z"), () => doUndo(), "edit-only disabled");
  btn.redo = tb("redo", "Redo", isMac ? combo("mod", "shift", "Z") : combo("mod", "Y"), () => doRedo(), "edit-only disabled");
  btn.select = tb("pointer", "Select tool: click to pick several blocks", ["V"], () => toggleSelectTool(), "edit-only");
  btn.add = tb("plus", "New slide", null, (e, b) => toggleMenu(b, (o) => layoutMenu(o, "center")), "edit-only");
  btn.add.appendChild(el("span", { class: "chev", html: ico(ICONS.chevron, 13) }));
  btn.insert = tb("grid", "Insert component", ["/"], (e, b) => toggleMenu(b, insertMenu), "labeled edit-only");
  btn.insert.append(el("span", { class: "lbl" }, "Insert"), el("span", { class: "chev", html: ico(ICONS.chevron, 13) }));
  btn.slideSettings = tb("sliders", "Slide background & logo", null, (e, b) => toggleMenu(b, slideMenu), "edit-only");
  btn.rail = tb("sidebar", "Hide slide list", combo("mod", "\\"), () => toggleRail(), "edit-only on");
  btn.prev = tb("chevronLeft", "Previous slide", combo("←"), () => go(currentIndex - 1));
  btn.counter = tb(null, "Go to slide", null, (e, b) => toggleMenu(b, jumpMenu), "counter");
  const counterNow = el("span", {}, "1");
  const counterOf = el("span", { class: "of" }, "/ 1");
  btn.counter.append(counterNow, el("span", { class: "of" }, "\u2009"), counterOf, el("span", { class: "chev", html: ico(ICONS.chevron, 13) }));
  btn.next = tb("chevronRight", "Next slide", combo("→"), () => go(currentIndex + 1));
  btn.more = tb("more", "More", null, (e, b) => toggleMenu(b, moreMenu));
  const tools = el("div", { class: "tools", role: "toolbar", "aria-label": "Slides" }, [
    btn.undo, btn.redo, sep("edit-only"),
    btn.select, btn.add, btn.insert, btn.slideSettings, sep("edit-only"),
    btn.prev, btn.counter, btn.next, sep(),
    btn.more
  ]);
  btn.edit = tb("pencil", "Edit slides", ["E"], () => toggleEdit(), "labeled");
  const editLabel = el("span", { class: "lbl" }, "Edit");
  btn.edit.appendChild(editLabel);
  btn.present = tb("play", "Present", ["F"], () => togglePresent(), "labeled");
  btn.present.appendChild(el("span", { class: "lbl" }, "Present"));
  const barRight = el("div", { class: "bar-right" }, [statusEl, btn.edit, btn.present]);
  const bar = el("header", { class: "bar" }, [el("div", { class: "bar-left" }, [btn.rail]), tools, barRight]);

  // Narrow screens: the toolbar scrolls sideways and fades only the edge that has more.
  const updateToolFades = () => {
    const max = tools.scrollWidth - tools.clientWidth;
    tools.classList.toggle("fade-l", tools.scrollLeft > 2);
    tools.classList.toggle("fade-r", max > 2 && tools.scrollLeft < max - 2);
  };
  tools.addEventListener("scroll", updateToolFades, { passive: true });
  window.addEventListener("resize", updateToolFades);

  // Rail
  const slideList = el("div", { class: "slide-list", role: "list", "aria-label": "Slides" });
  const railSearch = searchField({
    placeholder: "Search slides",
    value: slideSearch,
    onInput: (v) => { slideSearch = v; renderSlideList(); },
    onKey: (e) => {
      if (e.key === "Enter") {
        const idxs = filteredSlideIndices();
        if (idxs.length > 0) go(idxs[0]);
      }
    }
  });
  const railCount = el("span", { class: "count", "aria-live": "polite" });
  railSearch.insertBefore(railCount, railSearch.querySelector(".clear"));
  slideList.setAttribute("role", "listbox");
  slideList.addEventListener("keydown", onSlideListKey);
  slideList.addEventListener("scroll", updateListFades, { passive: true });
  new ResizeObserver(updateListFades).observe(slideList);
  const addMain = el("button", { class: "main", type: "button", html: ico(ICONS.plus, 15) }, []);
  addMain.appendChild(el("span", {}, "New slide"));
  addMain.addEventListener("click", () => addSlide(SLIDE_LAYOUTS.content()));
  attachTip(addMain, "New narrative slide after this one");
  const addCaret = el("button", { class: "caret", type: "button" }, [el("span", { class: "chev", html: ico(ICONS.chevron, 14) })]);
  addCaret.addEventListener("click", () => toggleMenu(addCaret, (o) => layoutMenu(o, "end")));
  attachTip(addCaret, "Choose a layout");
  const railFoot = el("div", { class: "rail-foot" }, [el("div", { class: "split" }, [addMain, addCaret])]);
  const rail = el("aside", { class: "panel rail", "aria-label": "Slide list" }, [
    el("div", { class: "panel-inner" }, [railSearch, slideList, railFoot])
  ]);

  // Stage
  const stage = el("div", { id: "stage", class: "loading" }, [
    el("div", { class: "sk", style: { left: "36px", top: "40px", width: "120px", height: "14px" } }),
    el("div", { class: "sk", style: { left: "36px", top: "84px", width: "620px", height: "36px" } }),
    el("div", { class: "sk", style: { left: "36px", top: "210px", width: "720px", height: "18px" } }),
    el("div", { class: "sk", style: { left: "36px", top: "250px", width: "680px", height: "18px" } }),
    el("div", { class: "sk", style: { left: "36px", top: "290px", width: "420px", height: "18px" } })
  ]);
  const plate = el("div", { class: "stage-plate", "aria-hidden": "true" });
  const exitBtn = el("button", { class: "present-exit", type: "button", html: ico(ICONS.collapse, 18) });
  exitBtn.addEventListener("click", togglePresent);
  attachTip(exitBtn, "Exit presentation", combo("Esc"));
  const presentNote = el("div", { class: "present-note", "aria-hidden": "true" });
  const stageWrap = el("main", { class: "stage-wrap" }, [plate, stage, agentLayer, exitBtn, presentNote]);
  stageRef.el = stage;
  stageRef.wrap = stageWrap;
  // Drag on the canvas around the slide to box-select too.
  stageWrap.addEventListener("pointerdown", (e) => {
    if (e.target === stageWrap || e.target === plate || e.target === stage) startMarquee(e);
  });

  // Inspector
  const inspectorBody = el("div", { class: "insp-scroll" });
  const inspector = el("aside", { class: "panel inspector", "aria-label": "Inspector" }, [el("div", { class: "panel-inner" }, [inspectorBody])]);
  inspectorBody.addEventListener("focusout", () => {
    setTimeout(() => { if (inspectorStale && !isEditingField(inspectorBody)) renderInspector(); }, 0);
  });
  stage.addEventListener("focusout", () => {
    setTimeout(() => { if (stageStale && !isEditingInline()) render(); }, 0);
  });

  const workspace = el("div", { class: "workspace" }, [rail, stageWrap, inspector]);
  const root = el("div", { id: "root" }, [bar, workspace]);
  const printDeck = el("div", { id: "printDeck", "data-print-root": "slides" });
  document.body.append(root, printDeck);

  Object.assign(shellRef, {
    root, bar, tools, rail, inspector, inspectorBody, slideList, railCount, railFoot, stage, stageWrap, plate, exitBtn, presentNote, printDeck,
    undoBtn: btn.undo, redoBtn: btn.redo, railBtn: btn.rail, selectBtn: btn.select, insertBtn: btn.insert, editBtn: btn.edit, editLabel, presentBtn: btn.present,
    counterNow, counterOf, updateToolFades
  });

  // The slide scales to fit, continuously: panels sliding in, present mode
  // and window resizes all reflow it smoothly. Zoomed in, it keeps its zoom
  // (clamped to the new stage).
  const zoomOut = tb("minus", "Zoom out", combo("mod", "−"), () => stepZoom(-1));
  const zoomIn = tb("plus", "Zoom in", combo("mod", "+"), () => stepZoom(1));
  const zoomLabel = el("span", { class: "zoom-pct", "aria-live": "polite" }, "100%");
  const zoomFit = tb(null, "Show the whole slide", combo("mod", "0"), () => setZoom(null), "zoom-fit");
  zoomFit.textContent = "Fit";
  const zoomCtl = el("div", { class: "zoom-ctl", role: "toolbar", "aria-label": "Zoom" }, [zoomOut, zoomLabel, zoomIn, sep(), zoomFit]);
  zoomCtl.addEventListener("pointerdown", (e) => e.stopPropagation());
  stageWrap.appendChild(zoomCtl);
  shellRef.zoomCtl = zoomCtl;
  shellRef.zoomLabel = zoomLabel;
  const fit = () => {
    const w = stageWrap.clientWidth, h = stageWrap.clientHeight;
    if (!w || !h) return;
    // Editing keeps a tighter margin so the slide gets the room.
    const pad = presenting ? 0 : isNarrow() ? 24 : editMode ? 40 : 64;
    const padX = pad, padY = pad;
    fitScale = Math.max(0.05, Math.min((w - padX) / 1200, (h - padY) / 675));
    let view: ZoomView = { scale: fitScale, panX: 0, panY: 0 };
    if (zoomView && !presenting) {
      view = clampView(zoomView, fitScale, { w, h });
      zoomView = isFit(view.scale, fitScale) ? null : view;
      if (!zoomView) view = { scale: fitScale, panX: 0, panY: 0 };
    }
    stageScale = view.scale;
    const move = `translate(calc(-50% + ${view.panX}px), calc(-50% + ${view.panY}px))`;
    stage.style.transform = `${move} scale(${stageScale})`;
    plate.style.transform = move;
    plate.style.width = 1200 * stageScale + "px";
    plate.style.height = 675 * stageScale + "px";
    // ~10px corners on screen, whatever the scale.
    stage.style.borderRadius = presenting ? "0" : 10 / stageScale + "px";
    root.classList.toggle("zoomed", !!zoomView);
    zoomLabel.textContent = Math.round(stageScale * 100) + "%";
    updateFloatBar();
  };
  shellRef.fit = fit;
  new ResizeObserver(fit).observe(stageWrap);
  fit();
  attachZoomGestures(stageWrap);
  narrowQuery.addEventListener("change", () => { renderSlideList(); fit(); });

  // Present mode: the exit control wakes with the pointer and sleeps when idle.
  let awakeTimer: ReturnType<typeof setTimeout> | undefined;
  stageWrap.addEventListener("pointermove", () => {
    if (!presenting) return;
    root.classList.add("chrome-awake");
    clearTimeout(awakeTimer);
    awakeTimer = setTimeout(() => root.classList.remove("chrome-awake"), 1800);
  });

  document.addEventListener("keydown", onKeyDown);
  updateUndoButtons();
  updateToolFades();
}
// ── Zoom ──
// Pinch (a ⌘/Ctrl + wheel to the page; gesture events in Safari) zooms
// around the fingers, two-finger scroll pans once zoomed, ⌘/Ctrl + / − step
// and ⌘/Ctrl 0 fits. During a gesture the stage is moved as one layer and
// redrawn sharp a moment after it stops.
function stageViewport(): { w: number; h: number; rect: DOMRect } | null {
  const wrap = stageRef.wrap;
  if (!wrap) return null;
  return { w: wrap.clientWidth, h: wrap.clientHeight, rect: wrap.getBoundingClientRect() };
}
function currentView(): ZoomView {
  return zoomView ?? { scale: fitScale, panX: 0, panY: 0 };
}
// Set the zoom (null: fit), and show it.
function setZoom(view: ZoomView | null): void {
  const vp = stageViewport();
  zoomView = view && vp && !isFit(view.scale, fitScale) ? clampView(view, fitScale, vp) : null;
  shellRef.fit?.();
}
// Zoom to `scale` around a point on screen (default: the stage's centre).
function zoomTo(scale: number, clientX?: number, clientY?: number): void {
  const vp = stageViewport();
  if (!vp || presenting) return;
  const anchor = clientX == null || clientY == null ? { x: 0, y: 0 } : { x: clientX - vp.rect.left - vp.w / 2, y: clientY - vp.rect.top - vp.h / 2 };
  setZoom(zoomAt(currentView(), scale, anchor, fitScale, vp));
}
function stepZoom(dir: 1 | -1): void {
  zoomTo(stepScale(stageScale, fitScale, dir));
}
let gestureTimer: ReturnType<typeof setTimeout> | undefined;
// While a gesture runs the stage is one composited layer (smooth); after it
// stops, it is drawn again at its new size (sharp).
function gesturing(): void {
  const stage = stageRef.el;
  if (!stage) return;
  stage.style.willChange = "transform";
  clearTimeout(gestureTimer);
  gestureTimer = setTimeout(() => { stage.style.willChange = ""; }, 160);
}
function attachZoomGestures(wrap: HTMLElement): void {
  wrap.addEventListener("wheel", (e) => {
    // ⌘/Ctrl + wheel would zoom the whole page: the slide zooms instead.
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      if (presenting || safariScale != null) return;
      gesturing();
      zoomTo(stageScale * wheelZoomFactor(e.deltaY, e.deltaMode), e.clientX, e.clientY);
      return;
    }
    if (!zoomView || presenting) return;
    e.preventDefault();
    gesturing();
    const dx = wheelPixels(e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX, e.deltaMode);
    const dy = e.shiftKey && !e.deltaX ? 0 : wheelPixels(e.deltaY, e.deltaMode);
    setZoom({ ...zoomView, panX: zoomView.panX - dx, panY: zoomView.panY - dy });
  }, { passive: false });
  // Safari: pinch arrives as gesture events, with the scale since the gesture began.
  let safariScale: number | null = null;
  type GestureLike = Event & { scale?: number; clientX?: number; clientY?: number };
  wrap.addEventListener("gesturestart", (e: GestureLike) => {
    e.preventDefault();
    safariScale = presenting ? null : stageScale;
  });
  wrap.addEventListener("gesturechange", (e: GestureLike) => {
    e.preventDefault();
    if (safariScale == null || !e.scale) return;
    gesturing();
    zoomTo(safariScale * e.scale, e.clientX, e.clientY);
  });
  wrap.addEventListener("gestureend", (e) => {
    e.preventDefault();
    safariScale = null;
  });
}
function isEditingField(scope: HTMLElement): boolean {
  const a = document.activeElement;
  return a instanceof HTMLElement && scope.contains(a) && a.matches("input, textarea, select") && !a.dataset.libSearch;
}
function isEditingInline(): boolean {
  const a = document.activeElement;
  return a instanceof HTMLElement && a.isContentEditable && !!stageRef.el?.contains(a);
}
// Redraws the stage now, or once the text being edited on it loses focus.
function renderWhenIdle(): void {
  if (isEditingInline()) stageStale = true;
  else render();
}

/* ═════════════════════════ 9. Inspector & fields ═════════════════════════ */

function renderInspector(): void {
  const panel = shellRef.inspectorBody;
  if (!panel) return;
  inspectorStale = false;
  const slide = currentSlide();
  const block = editMode && inspectorOpen && slide ? slide.blocks.find((b) => b.id === selectedBlockId) : null;
  // The Format panel opens only on request (Format in the floating bar, or
  // Enter) for a single selected block; the stage gets the room back the
  // moment it closes or you deselect.
  shellRef.root?.classList.toggle("has-sel", !!block);
  if (!block || !slide) {
    // Keep the last contents while the panel slides closed.
    return;
  }
  const scroll = panel.dataset.blockId === block.id ? panel.scrollTop : 0;
  panel.dataset.blockId = block.id;
  panel.replaceChildren(renderSelectedBlock(slide, block, COMPONENTS[block.type]));
  panel.scrollTop = scroll;
}
function filteredComponents(): string[] {
  const q = librarySearch.trim().toLowerCase();
  if (!q) return PALETTE_ORDER.slice();
  return PALETTE_ORDER.filter((t) => {
    const def = COMPONENTS[t];
    const name = (def?.name || "").toLowerCase();
    const desc = (COMP_DESC[t] || "").toLowerCase();
    return name.includes(q) || desc.includes(q) || t.toLowerCase().includes(q);
  });
}
// The order rows appear in (and arrow keys walk): grouped by category when
// browsing, flat when searching.
function libraryOrder(): string[] {
  const matches = filteredComponents();
  if (librarySearch.trim()) return matches;
  return COMPONENT_CATEGORIES.flatMap((cat) => cat.types.filter((t) => matches.includes(t)));
}
function populateLibraryList(list: HTMLElement, onPick: (type: string) => void): void {
  list.replaceChildren();
  const order = libraryOrder();
  if (order.length === 0) {
    list.appendChild(el("div", { class: "mempty" }, "No matches"));
    return;
  }
  // The highlighted row is what Enter inserts (like Docs' insert menu).
  const activeType = order[clamp(libActive, 0, order.length - 1)];
  if (librarySearch.trim()) {
    for (const t of order) list.appendChild(libraryItem(t, t === activeType, onPick));
  } else {
    for (const cat of COMPONENT_CATEGORIES) {
      const types = cat.types.filter((t) => order.includes(t));
      if (types.length === 0) continue;
      list.appendChild(el("div", { class: "mhead" }, cat.name));
      for (const t of types) list.appendChild(libraryItem(t, t === activeType, onPick));
    }
  }
}
function libraryItem(type: string, active: boolean, onPick: (type: string) => void): HTMLButtonElement {
  const def = COMPONENTS[type];
  const item = el("button", { class: "lib-item" + (active ? " active" : ""), type: "button", role: "option", "aria-selected": String(active) }, [
    el("span", { class: "lib-ico", html: COMP_ICON[type] || "" }),
    el("span", { class: "lib-text" }, [el("span", { class: "lib-name" }, def.name), el("span", { class: "lib-desc" }, COMP_DESC[type] || "")]),
    el("span", { class: "lib-plus", html: ico(ICONS.plus, 15) })
  ]);
  item.addEventListener("click", () => onPick(type));
  item.addEventListener("pointerenter", () => {
    const order = libraryOrder();
    const i = order.indexOf(type);
    if (i < 0 || i === libActive) return;
    libActive = i;
    item.parentElement?.querySelectorAll(".lib-item.active").forEach((n) => { n.classList.remove("active"); n.setAttribute("aria-selected", "false"); });
    item.classList.add("active");
    item.setAttribute("aria-selected", "true");
  });
  return item;
}
function renderSelectedBlock(slide: Slide, block: Block, def: ComponentDef | undefined): HTMLElement {
  const wrap = el("section", { class: "sec" });
  wrap.appendChild(el("div", { class: "sel-head" }, [
    el("span", { class: "sel-ico", html: COMP_ICON[block.type] || COMP_ICON.shape }),
    el("div", { style: { minWidth: "0" } }, [
      el("div", { class: "sel-name" }, def?.name || block.type),
      el("div", { class: "sel-sub" }, COMP_DESC[block.type] || "Selected block")
    ]),
    tb("x", "Close format panel", null, () => toggleInspector(false))
  ]));
  const basicFields = (def?.fields || []).filter((f) => !f.advanced);
  const advancedFields = (def?.fields || []).filter((f) => f.advanced);
  const propDefaults: BlockProps = def?.defaultBlock ? def.defaultBlock().props || {} : {};
  if (basicFields.length > 0) {
    const fieldsWrap = el("div", { class: "fields" });
    for (const f of basicFields) {
      const v = (block.props || {})[f.key] ?? propDefaults[f.key];
      const cb = (nv: PropValue) => patchBlockProp(slide, block, f.key, nv);
      fieldsWrap.appendChild(renderField(f, v, cb));
    }
    wrap.appendChild(fieldsWrap);
  }
  wrap.appendChild(renderBlockActions(slide, block));
  const hasAdvanced = !def?.fullBleed || advancedFields.length > 0;
  if (hasAdvanced) wrap.appendChild(renderAdvancedDisclosure(slide, block, def, advancedFields));
  return wrap;
}
async function reorderBlockBy(slide: Slide, block: Block, dir: number): Promise<void> {
  commitInlineEdit();
  // The floating bar can outlive a deck update; work on the live slide.
  slide = deck.slides.find((s) => s.id === slide.id) || slide;
  const i = slide.blocks.findIndex((b) => b.id === block.id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= slide.blocks.length) return;
  const [b] = slide.blocks.splice(i, 1);
  slide.blocks.splice(j, 0, b);
  render();
  await api.reorderBlock(slide.id, block.id, j);
}
function renderBlockActions(slide: Slide, block: Block): HTMLDivElement {
  return el("div", { class: "actions" }, [
    tb("duplicate", "Duplicate", combo("mod", "D"), () => duplicateSelectedBlock()),
    tb("arrowUp", "Bring forward", null, () => reorderBlockBy(slide, block, 1)),
    tb("arrowDown", "Send backward", null, () => reorderBlockBy(slide, block, -1)),
    tb("trash", "Delete", combo(isMac ? "⌫" : "Del"), () => deleteSelectedBlock(), "danger")
  ]);
}
function toggleInspector(force?: boolean): void {
  inspectorOpen = force ?? !inspectorOpen;
  if (!selectedBlockId) inspectorOpen = false;
  renderInspector();
  updateFloatBar();
}

// ── Quick actions (floating bar) ─────────────────────────────────────────
// The one or two settings people change most on each component sit right in
// the floating bar, so Format is only needed for the rest. Each is a plain
// prop that Format also edits; the bar is just a faster way in.
//   title, subtitle  size − n + · text color
//   text             size − n + · text color · alignment
//   bullet list      compact spacing (toggle)
//   box              dashed border (toggle)
//   tone pill        tone dots          arrow  color dots · dashed (toggle)
//   divider          color              shape  fill
//   logo             add / replace logo · white / black wordmark
//   image            add / replace image
// Cards, labels and SVGs keep the plain bar. With several
// blocks selected, a control shows when every one of them has it (and
// applies to all, as one undo step); the image action is single-block only.
// − / + walk a type scale (the theme's own sizes); the number takes any size.
var TYPE_SCALE = [10, 12, 14, 16, 17, 19, 22, 24, 28, 32, 36, 42, 48, 58, 64, 72, 84, 96, 120];
// The corporate palette (README "Corporate tokens"); white is for text on
// the orange covers. Dividers add the theme's two rule colours.
/** A named colour, as the quick-action palettes list them. */
type NamedColor = [name: string, color: string];
var TEXT_COLORS: NamedColor[] = [
  ["Black", "#000000"],
  ["Muted gray", "#747474"],
  ["White", "#FFFFFF"],
  ["Ruby", "#FF6633"],
  ["Tangerine", "#F6821F"],
  ["Mango", "#FBAD41"]
];
var FILL_COLORS: NamedColor[] = [["No fill", "transparent"], ["White", "#FFFFFF"], ["Black", "#000000"], ["Muted gray", "#747474"], ["Ruby", "#FF6633"], ["Tangerine", "#F6821F"], ["Mango", "#FBAD41"]];
var RULE_COLORS: NamedColor[] = [["Warm rule", "#EAD6C4"], ["Gray rule", "#E5E5E5"], ["Black", "#000000"], ["Muted gray", "#747474"], ["Ruby", "#FF6633"], ["Tangerine", "#F6821F"], ["Mango", "#FBAD41"]];
var TONE_DOTS: NamedColor[] = [["Gray", "#747474"], ["Tangerine", "#F6821F"], ["Ruby", "#FF6633"]];
/** One quick action in the floating bar, by the kind of control it shows. */
type QuickSpec =
  | { key: string; kind: "size"; single?: false }
  | { key: string; kind: "color"; label: string; palette: NamedColor[]; single?: false }
  | { key: string; kind: "align"; single?: false }
  | { key: string; kind: "dots"; label: string; options: Array<[value: string, name: string, color: string]>; single?: false }
  | { key: string; kind: "toggle"; icon: string; label: string; on: PropValue; off: PropValue; single?: false }
  | { key: string; kind: "image"; single: true };
type QuickKind = QuickSpec["kind"];
/** QUICK[id], narrowed to the control `kind` that reads it. */
function quickSpec<K extends QuickKind>(id: string, kind: K): Extract<QuickSpec, { kind: K }> {
  const spec = QUICK[id];
  if (spec.kind !== kind) throw new Error(`Quick action ${id} is not a ${kind} control.`);
  return spec as Extract<QuickSpec, { kind: K }>;
}
var QUICK: Record<string, QuickSpec> = {
  fontSize: { key: "fontSize", kind: "size" },
  textColor: { key: "color", kind: "color", label: "Text color", palette: TEXT_COLORS },
  textAlign: { key: "align", kind: "align" },
  fill: { key: "fill", kind: "color", label: "Fill", palette: FILL_COLORS },
  ruleColor: { key: "color", kind: "color", label: "Color", palette: RULE_COLORS },
  pillTone: { key: "tone", kind: "dots", label: "Tone", options: ["neutral", "tangerine", "ruby"].map((v, i) => [v, ...TONE_DOTS[i]] as [string, string, string]) },
  arrowColor: { key: "color", kind: "dots", label: "Color", options: ["muted", "tangerine", "ruby"].map((v, i) => [v, ...TONE_DOTS[i]] as [string, string, string]) },
  logoVariant: { key: "variant", kind: "dots", label: "Wordmark", options: [["light", "White wordmark (for orange)", "#FFFFFF"], ["dark", "Black wordmark (for white)", "#000000"]] },
  dashed: { key: "dashed", kind: "toggle", icon: "dashed", label: "Dashed", on: true, off: false },
  compact: { key: "treatment", kind: "toggle", icon: "compact", label: "Compact spacing", on: "compact", off: "primary" },
  image: { key: "src", kind: "image", single: true }
};
var QUICK_BY_TYPE: Record<string, string[]> = {
  title: ["fontSize", "textColor"],
  subtitle: ["fontSize", "textColor"],
  text: ["fontSize", "textColor", "textAlign"],
  bulletList: ["compact"],
  box: ["dashed"],
  tonePill: ["pillTone"],
  arrow: ["arrowColor", "dashed"],
  divider: ["ruleColor"],
  shape: ["fill"],
  logo: ["image", "logoVariant"],
  image: ["image"]
};
// A quick action only applies where Format has the same setting.
function quickField(type: string, id: string): FieldDef | null {
  if (!QUICK_BY_TYPE[type]?.includes(id)) return null;
  return COMPONENTS[type]?.fields?.find((x) => x.key === QUICK[id].key) || null;
}
// The value Format shows: the block's own, else the component default.
function styleValue(b: Block, key: string): PropValue | null | undefined {
  return (b.props || {})[key] ?? COMPONENTS[b.type]?.defaultBlock?.().props?.[key];
}
// The blocks an action applies to: all of them, when every one has it.
function quickTargets(blocks: Block[], id: string): Block[] {
  if (!blocks.length || (QUICK[id].single && blocks.length > 1)) return [];
  return blocks.every((b) => quickField(b.type, id)) ? blocks : [];
}
// Shared actions, in the first block's order.
function quickIds(blocks: Block[]): string[] {
  return (QUICK_BY_TYPE[blocks[0]?.type] || []).filter((id) => quickTargets(blocks, id).length);
}
// Colours compare case-insensitively ("transparent" included).
const normColor = (v: unknown) => String(v || "").toUpperCase();
function commonValue<T = PropValue | null | undefined>(blocks: Block[], key: string, norm: (v: PropValue | null | undefined) => T = (v) => v as T): T | null {
  const vals = new Set(blocks.map((b) => norm(styleValue(b, key))));
  return vals.size === 1 ? [...vals][0] : null;
}
// A bullet list being edited saves once focus has left it; this saves it now.
var flushListEdit: (() => void) | null = null;
// Finish any in-place text edit first, so its typing is saved, not lost.
function commitInlineEdit() {
  const a = document.activeElement;
  // In-place text and Format text fields save when they're left. (Clicking a
  // bar button keeps focus where it is, so a command leaves them here.)
  if (a instanceof HTMLElement && (a.isContentEditable || (a.matches("input[type=text], textarea") && shellRef.inspectorBody?.contains(a)))) a.blur();
  flushListEdit?.();
}
// Set an action's prop on every selected block it applies to (one save, one
// undo step). `valueFor(block, field)` returns the new value, or null to
// leave that block as it is.
async function applyQuick(id: string, valueFor: (b: Block, f: FieldDef) => PropValue | null | undefined): Promise<void> {
  commitInlineEdit();
  const slide = currentSlide();
  if (!slide) return;
  const key = QUICK[id].key;
  const patches: BlockPatchEntry[] = [];
  for (const b of quickTargets(selectedBlocks(slide), id)) {
    const v = valueFor(b, quickField(b.type, id) as FieldDef); // quickTargets keeps only blocks that have it
    if (v == null || v === styleValue(b, key)) continue;
    b.props = { ...b.props || {}, [key]: v };
    patches.push({ id: b.id, patch: { props: { [key]: v } } });
  }
  if (!patches.length) return;
  render();
  if (inspectorOpen) renderInspector();
  if (patches.length === 1) await api.updateBlock(slide.id, patches[0].id, patches[0].patch);
  else await api.updateBlocks(slide.id, patches);
}
function clampSize(n: number, f: FieldDef): number {
  return Math.round(clamp(n, f.min ?? 1, f.max ?? 400));
}
// One step along the type scale, within the field's range.
function stepFontSize(dir: number): Promise<void> {
  return applyQuick("fontSize", (b, f) => {
    const cur = Number(styleValue(b, "fontSize")) || f.min || 12;
    const scale = TYPE_SCALE.filter((s) => s >= (f.min ?? 1) && s <= (f.max ?? 400));
    const next = dir > 0 ? scale.find((s) => s > cur) ?? f.max : [...scale].reverse().find((s) => s < cur) ?? f.min;
    return next == null ? null : clampSize(next, f);
  });
}
function sizeControl(blocks: Block[]): HTMLDivElement {
  const common = commonValue(blocks, "fontSize", Number);
  const input = el("input", {
    type: "text",
    inputmode: "numeric",
    class: "bb-size-input",
    value: common == null ? "" : String(common),
    placeholder: "–",
    "aria-label": "Font size",
    spellcheck: "false"
  });
  attachTip(input, "Font size");
  const set = () => {
    const n = Number(input.value.trim());
    if (!input.value.trim() || !Number.isFinite(n) || n <= 0) {
      input.value = common == null ? "" : String(common);
      return;
    }
    applyQuick("fontSize", (b, f) => clampSize(n, f));
  };
  // Keep typing focus on the size box across the re-render a step causes.
  const stepKeepingFocus = async (dir: number) => {
    const p = stepFontSize(dir);
    floatBar?.querySelector<HTMLInputElement>(".bb-size-input")?.focus();
    await p;
  };
  input.addEventListener("focus", () => input.select());
  input.addEventListener("change", set);
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); input.blur(); }
    else if (e.key === "Escape") { e.preventDefault(); input.value = common == null ? "" : String(common); input.blur(); }
    else if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); stepKeepingFocus(e.key === "ArrowUp" ? 1 : -1); }
  });
  return el("div", { class: "bb-size" }, [
    tb("minus", "Smaller text", combo("mod", "shift", ","), () => stepFontSize(-1), "bb-step"),
    input,
    tb("plus", "Larger text", combo("mod", "shift", "."), () => stepFontSize(1), "bb-step")
  ]);
}
// A colour swatch's look: "transparent" is drawn as a struck-through chip.
function swatchStyle(color: string): Partial<CSSStyleDeclaration> {
  return normColor(color) === "TRANSPARENT" ? {} : { background: color };
}
function colorControl(blocks: Block[], id: string): HTMLButtonElement {
  const spec = quickSpec(id, "color");
  const common = commonValue(blocks, spec.key, normColor);
  const btn = tb(null, spec.label, null, (e, b) => toggleMenu(b, (owner) => colorMenu(owner, id, common)), "bb-color");
  const kind = common == null ? " mixed" : common === "TRANSPARENT" ? " none" : "";
  btn.appendChild(el("span", { class: "bb-dot" + kind, style: common && !kind ? { background: common } : {} }));
  btn.appendChild(el("span", { class: "chev", html: ico(ICONS.chevron, 13) }));
  return btn;
}
function colorMenu(owner: HTMLElement, id: string, current: string | null): void {
  const spec = quickSpec(id, "color");
  const pick = (color: string) => { closePop(); applyQuick(id, () => color); };
  const grid = el("div", { class: "cgrid", role: "group", "aria-label": spec.label, style: { gridTemplateColumns: `repeat(${spec.palette.length + 1}, 26px)` } });
  // Buttons inside a popover: keep Enter / Space from reaching the stage keys.
  grid.addEventListener("keydown", (e) => e.stopPropagation());
  for (const [name, color] of spec.palette) {
    const on = current === normColor(color);
    const s = el("button", { type: "button", class: "csw" + (on ? " on" : "") + (normColor(color) === "TRANSPARENT" ? " none" : ""), style: swatchStyle(color), "aria-pressed": String(on) });
    attachTip(s, name);
    s.addEventListener("click", () => pick(color));
    grid.appendChild(s);
  }
  // Anything else: the system colour picker. A current off-palette colour
  // shows (checked) in this slot.
  const custom = !!current && !spec.palette.some(([, color]) => normColor(color) === current);
  const hex6 = /^#[0-9a-f]{6}$/i.test(current || "");
  const picker = el("input", {
    type: "color",
    value: hex6 && current ? current.toLowerCase() : "#000000",
    onchange: (e) => { if (e.target instanceof HTMLInputElement) pick(e.target.value.toUpperCase()); }
  });
  const slot = el("label", { class: "csw custom" + (custom ? " on" : ""), style: custom && hex6 && current ? { background: current } : {} }, [picker]);
  attachTip(slot, "Custom color…");
  grid.appendChild(slot);
  showPop([el("div", { class: "mhead" }, spec.label), grid], owner.getBoundingClientRect(), { owner, kind: "dialog", className: "color-pop", align: "center" });
}
// A few fixed choices shown as dots, e.g. a pill's tone.
function dotsControl(blocks: Block[], id: string): HTMLDivElement {
  const spec = quickSpec(id, "dots");
  const common = commonValue(blocks, spec.key);
  const group = el("div", { class: "bb-dots", role: "radiogroup", "aria-label": spec.label });
  for (const [value, name, color] of spec.options) {
    const on = common === value;
    const b = el("button", { type: "button", class: "bb-tdot" + (on ? " on" : ""), role: "radio", "aria-checked": String(on) }, [
      el("span", { style: { background: color } })
    ]);
    attachTip(b, name);
    b.addEventListener("click", () => applyQuick(id, () => value));
    group.appendChild(b);
  }
  return group;
}
// An on/off setting, e.g. a dashed border. With a mixed selection it reads
// off, and turns everything on.
function toggleControl(blocks: Block[], id: string): HTMLButtonElement {
  const spec = quickSpec(id, "toggle");
  const isOn = (b: Block) => spec.on === true ? !!styleValue(b, spec.key) : styleValue(b, spec.key) === spec.on;
  const allOn = blocks.every(isOn);
  const b = tb(spec.icon, spec.label, null, () => applyQuick(id, () => allOn ? spec.off : spec.on), allOn ? "on" : "");
  b.setAttribute("aria-pressed", String(allOn));
  return b;
}
var TEXT_ALIGNS: Array<[value: string, label: string, icon: string]> = [["left", "Align left", "textLeft"], ["center", "Align center", "textCenter"], ["right", "Align right", "textRight"]];
function alignControl(blocks: Block[], id: string): HTMLButtonElement {
  const common = commonValue(blocks, QUICK[id].key, (v) => v || "left");
  const icon = (TEXT_ALIGNS.find(([v]) => v === common) || TEXT_ALIGNS[0])[2];
  const btn = tb(icon, "Text alignment", null, (e, b) => toggleMenu(b, (owner) => showPop(
    TEXT_ALIGNS.map(([value, label, ic]) => menuItem({ icon: ic, label, checked: common === value, checkSlot: true, onSelect: () => applyQuick(id, () => value) })),
    owner.getBoundingClientRect(), { owner, align: "center" }
  )), "bb-menu");
  btn.appendChild(el("span", { class: "chev", html: ico(ICONS.chevron, 13) }));
  return btn;
}
// Add or replace an image straight from the bar. The file is read as Format
// reads it (downscaled when large) and saved onto the block that was
// selected when the button was pressed.
let quickFileInput: HTMLInputElement | null = null;
function imageControl(blocks: Block[]): HTMLButtonElement {
  const block = blocks[0];
  const has = !!styleValue(block, "src");
  const noun = block.type === "logo" ? "logo" : "image";
  const b = tb("upload", has ? `Replace ${noun}` : `Add ${noun}`, null, () => pickImageFor(block.id), "labeled");
  b.appendChild(el("span", { class: "lbl" }, has ? "Replace" : `Add ${noun}`));
  return b;
}
function pickImageFor(blockId: string): void {
  const slideId = currentSlide()?.id;
  if (!slideId) return;
  const kind = currentSlide()?.blocks.find((x) => x.id === blockId)?.type === "logo" ? LOGO_IMAGE_FIELD : IMAGE_FIELD;
  quickFileInput?.remove();
  const input = el("input", { type: "file", accept: kind.accept, style: { display: "none" } });
  quickFileInput = input;
  input.addEventListener("change", async () => {
    const f = input.files && input.files[0];
    input.remove();
    if (quickFileInput === input) quickFileInput = null;
    if (!f) return;
    let url: string;
    try {
      url = await kind.read(f);
    } catch {
      showSync("offline", "Couldn't read that image");
      setTimeout(hideSync, 2600);
      return;
    }
    const slide = deck.slides.find((s) => s.id === slideId);
    const block = slide?.blocks.find((x) => x.id === blockId);
    if (!block) return;
    block.props = { ...block.props || {}, src: url };
    render();
    if (inspectorOpen) renderInspector();
    await api.updateBlock(slideId, blockId, { props: { src: url } });
  });
  document.body.appendChild(input);
  input.click();
}
const QUICK_CONTROLS: Record<QuickKind, (blocks: Block[], id: string) => HTMLElement> = { size: sizeControl, color: colorControl, dots: dotsControl, toggle: toggleControl, align: alignControl, image: imageControl };
// The values the bar displays, so it is rebuilt when one changes.
function quickSig(b: Block): string {
  return (QUICK_BY_TYPE[b.type] || []).map((id) => {
    const k = QUICK[id].key;
    return k === "src" ? (styleValue(b, k) ? 1 : 0) : String(b.props?.[k] ?? "");
  }).join(":");
}

// ── Floating block bar ───────────────────────────────────────────────────
// A small bar that sits just above the selection (or below it, near the top
// of the slide). It holds the everyday actions, so the Format panel only
// opens when you ask for it.
//   one block:  [Format] | quick actions | duplicate · forward · backward | delete
//   several:    [n selected] | quick actions | align ▾ · duplicate | delete
// (quick actions: see "Quick actions" above; the group is left out when empty)
let floatBar: HTMLDivElement | null = null, floatSig = "";
function quickStyleControls(blocks: Block[]): HTMLElement[] {
  const out = quickIds(blocks).map((id) => QUICK_CONTROLS[QUICK[id].kind](blocks, id));
  return out.length ? [...out, sep()] : [];
}
function buildFloatBar(slide: Slide, blocks: Block[]): HTMLDivElement {
  const bar = el("div", { class: "blockbar", role: "toolbar", "aria-label": "Selection" });
  bar.addEventListener("pointerdown", (e) => e.stopPropagation());
  // Clicks keep focus where it is (e.g. in text being edited), except in the size box.
  bar.addEventListener("mousedown", (e) => { if (!(e.target instanceof Element && e.target.closest("input"))) e.preventDefault(); });
  // A focused bar button handles its own Enter / Space (not "open Format").
  bar.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target instanceof HTMLButtonElement) e.stopPropagation();
  });
  const style = quickStyleControls(blocks);
  if (style.length) bar.classList.add("has-style");
  const del = tb("trash", blocks.length > 1 ? `Delete ${blocks.length} blocks` : "Delete", combo(isMac ? "⌫" : "Del"), () => deleteSelectedBlock(), "danger");
  const dup = tb("duplicate", "Duplicate", combo("mod", "D"), () => duplicateSelectedBlock(), blocks.length === 1 ? "bb-dup" : "");
  if (blocks.length === 1) {
    const block = blocks[0];
    const fmt = tb("sliders", inspectorOpen ? "Close format panel" : "Format", ["↵"], () => toggleInspector(), "labeled" + (inspectorOpen ? " on" : ""));
    fmt.appendChild(el("span", { class: "lbl" }, "Format"));
    bar.append(
      fmt, sep(),
      ...style,
      dup,
      tb("arrowUp", "Bring forward", null, () => reorderBlockBy(slide, block, 1), "bb-order"),
      tb("arrowDown", "Send backward", null, () => reorderBlockBy(slide, block, -1), "bb-order"),
      sep(), del
    );
  } else {
    bar.append(el("span", { class: "bb-count" }, `${blocks.length} selected`), sep(), ...style);
    const boxes = blocks.filter((b) => !COMPONENTS[b.type]?.fullBleed).length;
    if (boxes >= 2) {
      const align = tb("alignLeft", "Align & distribute", null, (e, b) => toggleMenu(b, alignMenu));
      align.appendChild(el("span", { class: "chev", html: ico(ICONS.chevron, 13) }));
      bar.appendChild(align);
    }
    bar.append(dup, sep(), del);
  }
  return bar;
}
function updateFloatBar(): void {
  const wrap = stageRef.wrap;
  if (!wrap) return;
  const slide = currentSlide();
  const blocks = ready && editMode && !presenting && slide ? selectedBlocks(slide) : [];
  if (!blocks.length || !slide) {
    if (floatBar) {
      const old = floatBar;
      floatBar = null;
      floatSig = "";
      if (tipOwner && old.contains(tipOwner)) hideTip();
      if (reducedMotion.matches) old.remove();
      else { old.classList.add("closing"); setTimeout(() => old.remove(), 110); }
    }
    return;
  }
  // Rebuilt when the selection, the Format toggle, or a quick-style value changes.
  const sig = blocks.map((b) => `${b.id}:${quickSig(b)}`).join(",") + "|" + inspectorOpen;
  if (sig !== floatSig || !floatBar?.isConnected) {
    const fresh = buildFloatBar(slide, blocks);
    if (tipOwner && floatBar?.contains(tipOwner)) hideTip();
    if (floatBar?.isConnected) floatBar.replaceWith(fresh);
    else { fresh.classList.add("enter"); wrap.appendChild(fresh); }
    floatBar = fresh;
    floatSig = sig;
  }
  // Union of the selected blocks on screen (arrows: their endpoints' bounds).
  const sr = (stageRef.el as HTMLDivElement).getBoundingClientRect(), wr = wrap.getBoundingClientRect(); // mounted with wrap
  let L = Infinity, T = Infinity, R = -Infinity, B = -Infinity;
  for (const b of blocks) {
    let r: { left: number; top: number; right: number; bottom: number };
    if (COMPONENTS[b.type]?.fullBleed) {
      const q = slideBox(b);
      r = { left: sr.left + q.x * stageScale, top: sr.top + q.y * stageScale, right: sr.left + (q.x + q.w) * stageScale, bottom: sr.top + (q.y + q.h) * stageScale };
    } else {
      const node = blockNode(b.id);
      if (!node) continue;
      r = node.getBoundingClientRect();
    }
    L = Math.min(L, r.left); T = Math.min(T, r.top); R = Math.max(R, r.right); B = Math.max(B, r.bottom);
  }
  if (!isFinite(L)) return;
  const bw = floatBar.offsetWidth, bh = floatBar.offsetHeight, gap = 12;
  let top = T - wr.top - bh - gap, origin = "bottom";
  if (top < 8) { top = B - wr.top + gap; origin = "top"; }
  top = clamp(top, 8, wr.height - bh - 8);
  const cx = (L + R) / 2 - wr.left;
  const left = clamp(cx - bw / 2, 8, Math.max(8, wr.width - bw - 8));
  floatBar.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  floatBar.style.setProperty("--origin", `${Math.round(clamp(cx - left, 0, bw))}px ${origin}`);
}
/** How alignSelected() lines blocks up. */
type AlignMode = "left" | "center" | "right" | "top" | "middle" | "bottom" | "distH" | "distV";
function alignMenu(owner: HTMLElement): void {
  const n = selectedBlocks().filter((b) => !COMPONENTS[b.type]?.fullBleed).length;
  const item = (icon: string, label: string, mode: AlignMode) => menuItem({ icon, label, onSelect: () => alignSelected(mode) });
  const items = [
    item("alignLeft", "Align left", "left"),
    item("alignCenter", "Align centres", "center"),
    item("alignRight", "Align right", "right"),
    el("div", { class: "msep" }),
    item("alignTop", "Align top", "top"),
    item("alignMiddle", "Align middles", "middle"),
    item("alignBottom", "Align bottom", "bottom")
  ];
  if (n >= 3) items.push(el("div", { class: "msep" }), item("distributeH", "Distribute horizontally", "distH"), item("distributeV", "Distribute vertically", "distV"));
  showPop(items, owner.getBoundingClientRect(), { owner, align: "center" });
}
// Align or evenly space the selected blocks (arrows are left where they are).
// Saved as one change.
async function alignSelected(mode: AlignMode): Promise<void> {
  const slide = currentSlide();
  if (!slide) return;
  const items = selectedBlocks(slide).filter((b) => !COMPONENTS[b.type]?.fullBleed).map((b) => ({ b, ...slideBox(b) }));
  if (items.length < 2) return;
  const L = Math.min(...items.map((q) => q.x)), R = Math.max(...items.map((q) => q.x + q.w));
  const T = Math.min(...items.map((q) => q.y)), B = Math.max(...items.map((q) => q.y + q.h));
  const next = new Map(items.map((q) => [q.b.id, { x: q.x, y: q.y }]));
  if (mode === "distH" || mode === "distV") {
    const h = mode === "distH";
    const sorted = [...items].sort((a, b) => h ? a.x - b.x : a.y - b.y);
    const total = sorted.reduce((t, q) => t + (h ? q.w : q.h), 0);
    const space = ((h ? R - L : B - T) - total) / (sorted.length - 1);
    let cursor = h ? L : T;
    for (const q of sorted) {
      (next.get(q.b.id) as { x: number; y: number })[h ? "x" : "y"] = Math.round(cursor); // every item has an entry
      cursor += (h ? q.w : q.h) + space;
    }
  } else {
    for (const q of items) {
      const p = next.get(q.b.id) as { x: number; y: number }; // every item has an entry
      if (mode === "left") p.x = L;
      else if (mode === "center") p.x = Math.round((L + R) / 2 - q.w / 2);
      else if (mode === "right") p.x = Math.round(R - q.w);
      else if (mode === "top") p.y = T;
      else if (mode === "middle") p.y = Math.round((T + B) / 2 - q.h / 2);
      else if (mode === "bottom") p.y = Math.round(B - q.h);
    }
  }
  const patches: BlockPatchEntry[] = [];
  for (const q of items) {
    const p = next.get(q.b.id) as { x: number; y: number }; // every item has an entry
    if (p.x === (q.b.x ?? 0) && p.y === (q.b.y ?? 0)) continue;
    q.b.x = p.x;
    q.b.y = p.y;
    patches.push({ id: q.b.id, patch: { x: p.x, y: p.y } });
  }
  if (!patches.length) return;
  // Let the blocks glide to their new places.
  const before = new Map(items.map((q) => [q.b.id, blockNode(q.b.id)?.getBoundingClientRect()]));
  render();
  if (!reducedMotion.matches) {
    for (const q of items) {
      const a = before.get(q.b.id), node = blockNode(q.b.id);
      if (!a || !node) continue;
      const z = node.getBoundingClientRect();
      if (a.left === z.left && a.top === z.top) continue;
      node.animate([{ transform: `translate(${(a.left - z.left) / stageScale}px, ${(a.top - z.top) / stageScale}px)` }, { transform: "none" }], { duration: 260, easing: "cubic-bezier(.2,.8,.2,1)" });
    }
  }
  await api.updateBlocks(slide.id, patches);
}
// Arrow keys move the selection 1px (⇧: 10px). Rapid presses are saved
// together a moment after the last one.
let nudgeTimer: ReturnType<typeof setTimeout> | null = null, nudgeSlideId: string | null = null;
const nudgePending = new Map<string, BlockPatch>();
// Where nudges have put blocks, kept until every nudge save has finished: the
// broadcast of an earlier save must not move a block back, nor be where the
// next nudge starts from. Laid over each deck that arrives meanwhile.
const nudgeLocal = new Map<string, { slideId: string; patch: BlockPatch }>();
let nudgeSaves = 0, sendingNudges = false;
function applyNudge(b: Block, patch: BlockPatch): void {
  if (patch.props) b.props = { ...b.props || {}, ...patch.props };
  else Object.assign(b, patch);
}
function overlayNudges(): void {
  for (const slide of nudgeLocal.size ? deck.slides : []) {
    for (const b of slide.blocks) {
      const local = nudgeLocal.get(b.id);
      if (local?.slideId === slide.id) applyNudge(b, local.patch);
    }
  }
}
// Save any nudges still waiting. Called before every other server call, so a
// drag, undo or edit right after a nudge can't be overtaken (or undone) by
// the late nudge save.
function flushNudges(): void {
  if (nudgeTimer) clearTimeout(nudgeTimer);
  nudgeTimer = null;
  if (!nudgePending.size) return;
  const patches = [...nudgePending].map(([id, patch]) => ({ id, patch }));
  nudgePending.clear();
  if (!nudgeSlideId) return;
  nudgeSaves++;
  sendingNudges = true;
  const saved = call("updateBlocks", nudgeSlideId, patches);
  sendingNudges = false;
  void saved.finally(() => {
    if (--nudgeSaves === 0 && !nudgePending.size) nudgeLocal.clear();
  });
}
function nudgeSelected(dx: number, dy: number): void {
  const slide = currentSlide();
  const blocks = selectedBlocks(slide);
  if (!slide || !blocks.length) return;
  // Nudges are saved per slide.
  if (nudgeSlideId !== slide.id) flushNudges();
  nudgeSlideId = slide.id;
  for (const b of blocks) {
    let patch: BlockPatch;
    if (COMPONENTS[b.type]?.fullBleed) {
      const p = b.props || {};
      b.props = { ...p, x1: (p.x1 ?? 0) + dx, y1: (p.y1 ?? 0) + dy, x2: (p.x2 ?? 0) + dx, y2: (p.y2 ?? 0) + dy };
      patch = { props: { x1: b.props.x1, y1: b.props.y1, x2: b.props.x2, y2: b.props.y2 } };
    } else {
      b.x = (b.x ?? 0) + dx;
      b.y = (b.y ?? 0) + dy;
      patch = { x: b.x, y: b.y };
    }
    nudgePending.set(b.id, patch);
    nudgeLocal.set(b.id, { slideId: slide.id, patch });
  }
  render();
  if (blocks.length === 1) updateInspectorPositionFields(blocks[0]);
  if (nudgeTimer) clearTimeout(nudgeTimer);
  nudgeTimer = setTimeout(flushNudges, 400);
}
function renderAdvancedDisclosure(slide: Slide, block: Block, def: ComponentDef | undefined, advancedFields: FieldDef[]): HTMLDivElement {
  const wrap = el("div", { class: "adv" + (advancedOpen ? " open" : "") });
  const toggle = el("button", { class: "adv-toggle", type: "button", "aria-expanded": String(advancedOpen) }, [
    el("span", { class: "chev", html: ico(ICONS.chevron, 14) }),
    el("span", {}, "Advanced")
  ]);
  toggle.addEventListener("click", () => {
    advancedOpen = !advancedOpen;
    renderInspector();
  });
  wrap.appendChild(toggle);
  if (!advancedOpen) return wrap;
  const body = el("div", { class: "adv-body" });
  if (!def?.fullBleed) {
    const grid = el("div", { class: "xy" });
    grid.appendChild(numberField("X", block.x ?? 0, (v) => patchBlock(slide, block, { x: v }), { min: -100, max: 1300 }, { dataKey: "pos-x" }));
    grid.appendChild(numberField("Y", block.y ?? 0, (v) => patchBlock(slide, block, { y: v }), { min: -100, max: 800 }, { dataKey: "pos-y" }));
    if (def?.resizableW || block.w != null)
      grid.appendChild(numberField("W", block.w ?? 0, (v) => patchBlock(slide, block, { w: v }), { min: 10, max: 1300 }, { dataKey: "pos-w" }));
    if (def?.resizableH || block.h != null)
      grid.appendChild(numberField("H", block.h ?? 0, (v) => patchBlock(slide, block, { h: v }), { min: 10, max: 800 }, { dataKey: "pos-h" }));
    body.appendChild(grid);
  }
  const propDefaults: BlockProps = def?.defaultBlock ? def.defaultBlock().props || {} : {};
  for (const f of advancedFields) {
    const v = (block.props || {})[f.key] ?? propDefaults[f.key];
    const cb = (nv: PropValue) => patchBlockProp(slide, block, f.key, nv);
    body.appendChild(renderField(f, v, cb));
  }
  wrap.appendChild(body);
  return wrap;
}
// The stage is redrawn once the save is done, but not under text being edited
// in place meanwhile: that would take the field (and, where removing it fires
// no blur, its unsaved text) away.
async function patchBlock(slide: Slide, block: Block, patch: BlockPatch): Promise<void> {
  Object.assign(liveBlock(slide.id, block.id) ?? block, patch);
  await api.updateBlock(slide.id, block.id, patch);
  renderWhenIdle();
}
async function patchBlockProp(slide: Slide, block: Block, key: string, value: PropValue): Promise<void> {
  const live = liveBlock(slide.id, block.id) ?? block;
  live.props = { ...live.props || {}, [key]: value };
  await api.updateBlock(slide.id, block.id, { props: { [key]: value } });
  renderWhenIdle();
}
function updateInspectorPositionFields(block: Block): void {
  if (!shellRef.inspectorBody) return;
  for (const [k, dk] of <Array<["x" | "y" | "w" | "h", string]>>[
    ["x", "pos-x"],
    ["y", "pos-y"],
    ["w", "pos-w"],
    ["h", "pos-h"]
  ]) {
    const input = shellRef.inspectorBody.querySelector<HTMLInputElement>(`input[data-key="${dk}"]`);
    if (input) input.value = String(block[k] ?? 0);
  }
}
function fieldRow(label: string, control: HTMLElement, opts: { stacked?: boolean } = {}): HTMLDivElement {
  return el("div", { class: "frow" + (opts.stacked ? " stacked" : "") }, [el("label", { text: label }), control]);
}
/** Where a field's edits go: the new prop value (a field hands its own kind of value). */
type FieldChange = (value: PropValue) => unknown;
function renderField(f: FieldDef, v: PropValue | null | undefined, cb: FieldChange): HTMLElement {
  switch (f.type) {
    case "multiline":
      return multilineField(f.label, v ?? "", cb);
    case "number":
      return numberField(f.label, v ?? 0, cb, f);
    case "select":
      return selectField(f.label, v, cb, f.options ?? []);
    case "checkbox":
      return checkField(f.label, !!v, cb);
    case "color":
      return colorField(f.label, v ?? "#000000", cb);
    case "image":
      return imageField(f.label, v ?? "", cb);
    case "logo":
      return imageField(f.label, v ?? "", cb, LOGO_IMAGE_FIELD);
    case "svg":
      return svgField(f.label, v ?? "", cb);
    case "text":
    default:
      return textField(f.label, v ?? "", cb);
  }
}
function textField(label: string, value: PropValue, cb: (value: string) => unknown): HTMLDivElement {
  const input = el("input", {
    type: "text",
    value,
    class: "field-input",
    onblur: (e) => {
      if (e.target instanceof HTMLInputElement && e.target.value !== value) cb(e.target.value);
    },
    onkeydown: (e) => {
      e.stopPropagation();
      if (e instanceof KeyboardEvent && e.key === "Enter" && e.target instanceof HTMLInputElement) e.target.blur();
    }
  });
  return fieldRow(label, input);
}
function multilineField(label: string, value: PropValue, cb: (value: string) => unknown): HTMLDivElement {
  const ta = el("textarea", {
    class: "field-input field-textarea",
    onblur: (e) => {
      if (e.target instanceof HTMLTextAreaElement && e.target.value !== value) cb(e.target.value);
    },
    onkeydown: (e) => e.stopPropagation()
  });
  ta.value = String(value);
  return fieldRow(label, ta, { stacked: true });
}
function numberField(label: string, value: PropValue, cb: (value: number) => unknown, opts: { min?: number; max?: number; step?: number } = {}, attrs: { dataKey?: string } = {}): HTMLDivElement {
  let last = value;
  const input = el("input", {
    type: "number",
    value,
    step: opts.step ?? 1,
    min: opts.min,
    max: opts.max,
    "data-key": attrs.dataKey || "",
    class: "field-input",
    onchange: (e) => {
      if (!(e.target instanceof HTMLInputElement)) return;
      const n = Number(e.target.value);
      // Compared with the last value sent: the field can outlive its saves.
      if (!Number.isNaN(n) && n !== last) { last = n; cb(n); }
    },
    onkeydown: (e) => e.stopPropagation()
  });
  return fieldRow(label, input);
}
function selectField(label: string, value: PropValue | null | undefined, cb: (value: string) => unknown, options: string[], labels: Record<string, string> = {}): HTMLDivElement {
  const sel = el("select", {
    class: "field-input field-select",
    onchange: (e) => {
      if (e.target instanceof HTMLSelectElement) cb(e.target.value);
    },
    onkeydown: (e) => e.stopPropagation()
  });
  for (const o of options) {
    const opt = el("option", { value: o, text: labels[o] ?? o });
    if (String(o) === String(value)) opt.selected = true;
    sel.appendChild(opt);
  }
  return fieldRow(label, sel);
}
// Checkboxes are Docs-style switch rows: the whole row toggles.
function checkField(label: string, value: boolean, cb: (value: boolean) => unknown): HTMLDivElement {
  let on = !!value;
  const sw = el("span", { class: "switch" + (on ? " on" : "") });
  const row = el("div", { class: "toggle-row", role: "switch", tabindex: "0", "aria-checked": String(on), "aria-label": label }, [el("span", {}, label), sw]);
  const flip = () => {
    on = !on;
    sw.classList.toggle("on", on);
    row.setAttribute("aria-checked", String(on));
    cb(on);
  };
  row.addEventListener("click", flip);
  row.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === " " || e.key === "Enter") { e.preventDefault(); flip(); }
  });
  return row;
}
function colorField(label: string, value: PropValue, cb: (value: string) => unknown): HTMLDivElement {
  const swatch = el("label", { class: "swatch", style: { background: String(value) }, title: "Pick a color" });
  const picker = el("input", {
    type: "color",
    value: /^#[0-9a-f]{6}$/i.test(String(value)) ? value : "#000000",
    onchange: (e) => {
      if (!(e.target instanceof HTMLInputElement)) return;
      swatch.style.background = e.target.value;
      tx.value = e.target.value;
      cb(e.target.value);
    },
    oninput: (e) => {
      if (e.target instanceof HTMLInputElement) swatch.style.background = e.target.value;
    }
  });
  swatch.appendChild(picker);
  const tx = el("input", {
    type: "text",
    value,
    class: "field-input",
    spellcheck: "false",
    onblur: (e) => {
      if (e.target instanceof HTMLInputElement && e.target.value !== value) cb(e.target.value);
    },
    onkeydown: (e) => {
      e.stopPropagation();
      if (e instanceof KeyboardEvent && e.key === "Enter" && e.target instanceof HTMLInputElement) e.target.blur();
    }
  });
  return fieldRow(label, el("div", { class: "color-ctl" }, [swatch, tx]));
}
var MAX_IMAGE_DIM = 1600;
var IMAGE_DOWNSCALE_MIN = 4e5;
async function fileToImageDataURL(file: File): Promise<string> {
  if (file.type === "image/svg+xml") return await readFileAsDataURL(file);
  const original = await readFileAsDataURL(file);
  let img: HTMLImageElement;
  try {
    img = await loadImage(original);
  } catch {
    return original;
  }
  const longest = Math.max(img.naturalWidth, img.naturalHeight);
  if (longest <= MAX_IMAGE_DIM && file.size < IMAGE_DOWNSCALE_MIN) return original;
  const scale = Math.min(1, MAX_IMAGE_DIM / longest);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D; // a fresh canvas always has one
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const isPng = file.type === "image/png";
  try {
    return canvas.toDataURL(
      isPng ? "image/png" : "image/jpeg",
      isPng ? void 0 : 0.85
    );
  } catch {
    return original;
  }
}
// Logos are PNG, JPEG or SVG (what PowerPoint embeds): any other image is
// redrawn as a PNG on the way in. Same size limits as any image.
var LOGO_ACCEPT = LOGO_IMAGE_TYPES.join(",");
async function fileToLogoDataURL(file: File): Promise<string> {
  const url = await fileToImageDataURL(file);
  if (LOGO_IMAGE_TYPES.some((t) => url.startsWith(`data:${t};`) || url.startsWith(`data:${t},`))) return url;
  const img = await loadImage(url);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, img.naturalWidth);
  canvas.height = Math.max(1, img.naturalHeight);
  (canvas.getContext("2d") as CanvasRenderingContext2D).drawImage(img, 0, 0); // a fresh canvas always has one
  return canvas.toDataURL("image/png");
}
/** What kind of image an image field takes: the file types offered, how a file is read, the preview's shape. */
interface ImageFieldKind {
  accept: string;
  read: (file: File) => Promise<string>;
  empty: string;
  previewClass: string;
}
var IMAGE_FIELD: ImageFieldKind = { accept: "image/*", read: fileToImageDataURL, empty: "No image", previewClass: "img-prev" };
var LOGO_IMAGE_FIELD: ImageFieldKind = { accept: LOGO_ACCEPT, read: fileToLogoDataURL, empty: "Drop your logo here", previewClass: "img-prev logo-prev" };
// An image: upload, drop a file on the preview, paste one (or a URL or
// data URI) into the box, or clear it.
function imageField(label: string, stored: PropValue, cb: (value: string) => unknown, kind: ImageFieldKind = IMAGE_FIELD): HTMLDivElement {
  const apply = async (v: string) => {
    await cb(v);
    renderInspector();
  };
  // A stored "asset:" ref stands for its data; show and measure that.
  const value = String(assetRaw(stored));
  const note = el("div", { class: "img-note" });
  const useFile = async (f: File | null | undefined) => {
    if (!f) return;
    try {
      await apply(await kind.read(f));
    } catch {
      note.textContent = "Couldn't read that file.";
      note.classList.add("err");
      if (!note.isConnected) wrap.appendChild(note);
    }
  };
  const imageFile = (list: FileList | null | undefined) => Array.from(list || []).find((f) => f.type.startsWith("image/"));
  const preview = el("div", { class: kind.previewClass }, [
    value ? el("img", { src: assetRaw(stored), alt: "", draggable: "false" }) : el("span", {}, kind.empty)
  ]);
  preview.addEventListener("dragover", (e) => {
    if (!e.dataTransfer?.types.includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    preview.classList.add("drop");
  });
  preview.addEventListener("dragleave", () => preview.classList.remove("drop"));
  preview.addEventListener("drop", (e) => {
    preview.classList.remove("drop");
    const f = imageFile(e.dataTransfer?.files);
    if (!f) return;
    e.preventDefault();
    useFile(f);
  });
  const fileInput = el("input", {
    type: "file",
    accept: kind.accept,
    style: { display: "none" },
    onchange: async (e) => {
      if (!(e.target instanceof HTMLInputElement)) return;
      await useFile(e.target.files && e.target.files[0]);
      e.target.value = "";
    }
  });
  const upload = el("button", { class: "btn", type: "button", html: ico(ICONS.upload, 15) }, []);
  upload.appendChild(el("span", {}, value ? "Replace" : "Upload"));
  upload.addEventListener("click", () => fileInput.click());
  const btns = el("div", { class: "img-btns", style: { gridTemplateColumns: value ? "1fr 1fr" : "1fr" } }, [upload, fileInput]);
  if (value) {
    const clear = el("button", { class: "btn danger", type: "button", html: ico(ICONS.x, 14) }, []);
    clear.appendChild(el("span", {}, "Clear"));
    clear.addEventListener("click", () => apply(""));
    btns.appendChild(clear);
  }
  const shownUrl = value && value.startsWith("data:") ? "" : value;
  const urlInput = el("input", {
    type: "text",
    // Outside images can't load in the gadget frame: only data: URIs show.
    placeholder: "or paste an image or a data: URI",
    value: shownUrl,
    class: "field-input",
    onblur: (e) => {
      if (!(e.target instanceof HTMLInputElement)) return;
      const v = e.target.value.trim();
      // Compared with what the box showed, so leaving it empty doesn't
      // clear an inlined image (use Clear for that).
      if (v !== shownUrl) apply(v);
    },
    onkeydown: (e) => {
      e.stopPropagation();
      if (e instanceof KeyboardEvent && e.key === "Enter" && e.target instanceof HTMLInputElement) e.target.blur();
    },
    // A pasted image (copied from another app) rather than text.
    onpaste: (e) => {
      const f = e instanceof ClipboardEvent ? imageFile(e.clipboardData?.files) : null;
      if (!f) return;
      e.preventDefault();
      useFile(f);
    }
  });
  if (value && value.startsWith("data:")) {
    const i = value.indexOf(",");
    const bytes = i >= 0 ? Math.round((value.length - i - 1) * 3 / 4) : 0;
    if (bytes > 0) note.textContent = `Inlined · ${formatBytes(bytes)}`;
  }
  const wrap = el("div", { class: "img-ctl" }, [preview, btns, urlInput]);
  if (note.textContent) wrap.appendChild(note);
  return fieldRow(label, wrap, { stacked: true });
}
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}
function svgField(label: string, stored: PropValue, cb: (value: string) => unknown): HTMLDivElement {
  const value = String(assetRaw(stored));
  const ta = el("textarea", {
    class: "field-input field-textarea field-mono",
    placeholder: '<svg width="..." height="..." viewBox="...">...</svg>',
    spellcheck: "false",
    onblur: (e) => {
      if (e.target instanceof HTMLTextAreaElement && e.target.value !== value) cb(e.target.value);
    },
    onkeydown: (e) => e.stopPropagation()
  });
  ta.value = value;
  return fieldRow(label, ta, { stacked: true });
}

/* ════════════════════════════ 10. Slide list ═════════════════════════════ */

// Details worth keeping when you edit this list:
//   • Thumbnails are cached per slide, keyed by the slide object itself
//     (and width): the server sends a new object only for a slide that
//     changed, so a deck of fifty re-renders only that one, with no JSON
//     comparisons. Decks longer than LAZY_THUMBS_AFTER build far-off
//     thumbnails only as they scroll near (an IntersectionObserver).
//   • Rows glide to their new places (FLIP) when slides are added, removed,
//     reordered or filtered, so you can see where things went.
//   • Focus survives re-renders; with the list focused, ↑/↓ move between
//     slides, ⌘D duplicates, Delete removes (undo brings it back).
//   • Placeholder titles like "[TITLE]" are dimmed so real titles stand out;
//     a truncated title shows in full in a tooltip.
//   • The list fades only at an edge with more slides beyond it, and the
//     footer's hairline appears only when slides scroll beneath it.
//   • Reordering drags just the thumbnail, from where you grabbed it, and
//     an accent line marks the gap it will land in.
var dragSrcIndex: number | null = null;
/** A built thumbnail, valid while its slide object, width, cover artwork and deck logo are the same. */
interface CachedThumb {
  slide: Slide;
  width: number;
  cover: string;
  logo: DeckLogo | null | undefined;
  node: HTMLDivElement;
}
const thumbCache = new Map<string, CachedThumb>();
function freshThumb(slide: Slide, width: number): CachedThumb | null {
  const hit = thumbCache.get(slide.id);
  return hit && hit.slide === slide && hit.width === width && hit.cover === COVER_ORANGE_PNG && hit.logo === deck.logo ? hit : null;
}
function cachedThumb(slide: Slide, width: number): HTMLDivElement {
  const hit = freshThumb(slide, width);
  if (hit) return hit.node;
  const node = renderSlideThumbnail(slide, width);
  thumbCache.set(slide.id, { slide, width, cover: COVER_ORANGE_PNG, logo: deck.logo, node });
  return node;
}
// Long decks: thumbnails near the current slide are built at once; the rest
// as they scroll within LAZY_THUMB_MARGIN of view. Until then a stale
// thumbnail (if any) or a plain card of the slide's colour holds the place.
const LAZY_THUMBS_AFTER = 40;
const LAZY_THUMB_NEAR = 10;
const LAZY_THUMB_MARGIN = "600px";
let thumbObserver: IntersectionObserver | null = null;
function lazyThumb(slide: Slide, width: number): HTMLDivElement {
  const stale = thumbCache.get(slide.id);
  const node = stale && stale.width === width ? stale.node : el("div", {
    class: "thumb-canvas",
    style: { width: width + "px", height: 675 * width / 1200 + "px", background: slide.background && slide.background.color || C.page }
  });
  node.dataset.lazyId = slide.id;
  node.dataset.lazyW = String(width);
  thumbObserver ??= new IntersectionObserver(fillLazyThumbs, { root: shellRef.slideList, rootMargin: LAZY_THUMB_MARGIN });
  thumbObserver.observe(node);
  return node;
}
function fillLazyThumbs(entries: IntersectionObserverEntry[]): void {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    const node = entry.target as HTMLElement; // only lazyThumb() nodes are observed
    thumbObserver?.unobserve(node);
    if (!node.isConnected) continue;
    const slide = deck.slides.find((s) => s.id === node.dataset.lazyId);
    if (!slide) continue;
    const fresh = cachedThumb(slide, Number(node.dataset.lazyW));
    if (fresh !== node) node.replaceWith(fresh);
  }
}
// The exact column width: list content minus the number column and gap.
function thumbWidth(list: HTMLElement): number {
  if (isNarrow()) return 120;
  const w = list.clientWidth - 16 - 22;
  return w > 60 ? Math.floor(w) : THUMB_W;
}
function clearDropIndicators(list: HTMLElement): void {
  list.querySelectorAll(".drop-line").forEach((e) => e.remove());
}
function updateListFades(): void {
  const l = shellRef.slideList;
  if (!l) return;
  const more = l.scrollHeight - l.clientHeight - l.scrollTop;
  l.classList.toggle("fade-t", l.scrollTop > 2);
  l.classList.toggle("fade-b", more > 2);
  shellRef.railFoot?.classList.toggle("lifted", more > 2);
}
function updateSearchCount(n: number): void {
  const c = shellRef.railCount;
  if (!c) return;
  const q = slideSearch.trim();
  c.textContent = q ? String(n) : "";
  c.classList.toggle("none", !!q && n === 0);
  c.setAttribute("aria-label", q ? `${n} matching slide${n === 1 ? "" : "s"}` : "");
}
const isPlaceholderLabel = (t: string) => t === "Untitled" || /^\[[^\]]*\]$/.test(t.trim());
// `flash` = { added: Set, changed: Set } of slide ids changed remotely.
/** Slides a remote change added or changed, for the slide list to show landing. */
interface SlideFlash {
  added: Set<string>;
  changed: Set<string>;
}
function renderSlideList(flash: SlideFlash | null = null): void {
  const list = shellRef.slideList;
  if (!list) return;
  const hadFocus = list.contains(document.activeElement);
  const before = new Map<string | undefined, DOMRect>();
  if (ready && !reducedMotion.matches) {
    for (const r of list.querySelectorAll<HTMLElement>(".srow")) before.set(r.dataset.id, r.getBoundingClientRect());
  }
  const keepTop = list.scrollTop, keepLeft = list.scrollLeft;
  list.replaceChildren();
  const indices = filteredSlideIndices();
  const filtering = !!slideSearch.trim();
  updateSearchCount(indices.length);
  const live = new Set(deck.slides.map((s) => s.id));
  for (const id of thumbCache.keys()) if (!live.has(id)) thumbCache.delete(id);
  if (indices.length === 0) {
    list.appendChild(el("div", { class: "list-empty" }, [el("div", {}, "No slides match"), el("div", { class: "q" }, `“${slideSearch.trim()}”`)]));
    updateListFades();
    return;
  }
  const narrow = isNarrow();
  const canReorder = !filtering && !narrow && !coarsePointer;
  const width = thumbWidth(list);
  list.style.setProperty("--tw", width + "px");
  const focusIndex = indices.includes(currentIndex) ? currentIndex : indices[0];
  const labels: Array<[HTMLSpanElement, string]> = [];
  thumbObserver?.disconnect();
  const lazy = indices.length > LAZY_THUMBS_AFTER;
  for (const i of indices) {
    const s = deck.slides[i];
    const active = i === currentIndex;
    const eager = !lazy || Math.abs(i - currentIndex) <= LAZY_THUMB_NEAR || !!freshThumb(s, width);
    const thumb = el("div", { class: "thumb" }, [
      eager ? cachedThumb(s, width) : lazyThumb(s, width),
      el("div", { class: "thumb-actions" }, [
        miniBtn("duplicate", "Duplicate slide", () => duplicateSlideById(s.id)),
        miniBtn("trash", "Delete slide", () => removeSlideById(s.id), true)
      ])
    ]);
    const label = slideLabel(s);
    const lbl = el("span", { class: "lbl" + (isPlaceholderLabel(label) ? " placeholder" : "") }, label);
    labels.push([lbl, label]);
    const row = el("div", {
      class: "srow" + (active ? " active" : ""),
      role: "option",
      tabindex: i === focusIndex ? "0" : "-1",
      "data-index": String(i),
      "data-id": s.id,
      draggable: canReorder ? "true" : "false",
      "aria-label": `Slide ${i + 1}: ${label}`,
      "aria-selected": String(active)
    }, [el("span", { class: "num", "aria-hidden": "true" }, String(i + 1)), thumb, lbl]);
    row.addEventListener("click", () => { if (i !== currentIndex) go(i); });
    if (canReorder) attachSlideDragHandlers(row, list, i);
    list.appendChild(row);
    if (flash?.added.has(s.id)) riseIn(row);
    else if (flash?.changed.has(s.id)) washThumb(thumb);
  }
  list.scrollTop = keepTop;
  list.scrollLeft = keepLeft;
  if (hadFocus) list.querySelector<HTMLElement>('.srow[tabindex="0"]')?.focus({ preventScroll: true });
  // Rows glide from where they were.
  if (before.size) {
    for (const row of list.children as HTMLCollectionOf<HTMLElement>) {
      const a = before.get(row.dataset.id);
      if (!a) continue;
      const b = row.getBoundingClientRect();
      const dx = a.left - b.left, dy = a.top - b.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1 || Math.abs(dy) > 900) continue;
      row.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: 240, easing: "cubic-bezier(.2,.8,.2,1)" });
    }
  }
  // Full titles for the ones that don't fit.
  requestAnimationFrame(() => {
    for (const [lbl, label] of labels) if (lbl.isConnected && lbl.scrollWidth > lbl.clientWidth + 1) attachTip(lbl, label);
  });
  updateListFades();
}
function scrollActiveRow(): void {
  shellRef.slideList?.querySelector(".srow.active")?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: reducedMotion.matches ? "auto" : "smooth" });
}
// Keyboard, with focus in the list (Tab into it, or click a slide).
function onSlideListKey(e: KeyboardEvent): void {
  const row = e.target instanceof Element ? e.target.closest<HTMLElement>(".srow") : null;
  const list = shellRef.slideList;
  if (!row || !list) return;
  const rows = [...list.querySelectorAll<HTMLElement>(".srow")];
  const k = rows.indexOf(row);
  const id = row.dataset.id ?? "";
  const mod = e.metaKey || e.ctrlKey;
  let target: HTMLElement | null | undefined = null;
  if (!mod && (e.key === "ArrowDown" || e.key === "ArrowRight")) target = rows[k + 1];
  else if (!mod && (e.key === "ArrowUp" || e.key === "ArrowLeft")) target = rows[k - 1];
  else if (e.key === "Home") target = rows[0];
  else if (e.key === "End") target = rows[rows.length - 1];
  else if (!mod && (e.key === "Enter" || e.key === " ")) target = row;
  else if (!mod && (e.key === "Delete" || e.key === "Backspace")) {
    e.preventDefault();
    e.stopPropagation();
    removeSlideById(id);
    return;
  } else if (mod && !e.shiftKey && e.key.toLowerCase() === "d") {
    e.preventDefault();
    e.stopPropagation();
    duplicateSlideById(id);
    return;
  } else return;
  e.preventDefault();
  e.stopPropagation();
  if (!target) return;
  const i = Number(target.dataset.index);
  if (i !== currentIndex) go(i);
  else target.focus();
}
function attachSlideDragHandlers(row: HTMLElement, list: HTMLElement, i: number): void {
  row.addEventListener("dragstart", (e) => {
    dragSrcIndex = i;
    row.classList.add("dragging");
    list.classList.add("reordering");
    hideTip();
    try {
      if (!e.dataTransfer) return;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(i));
      const t = row.querySelector(".thumb") as HTMLElement; // every row has its thumbnail
      const r = t.getBoundingClientRect();
      e.dataTransfer.setDragImage(t, clamp(e.clientX - r.left, 0, r.width), clamp(e.clientY - r.top, 0, r.height));
    } catch {
    }
  });
  row.addEventListener("dragend", () => {
    row.classList.remove("dragging");
    list.classList.remove("reordering");
    clearDropIndicators(list);
    dragSrcIndex = null;
  });
  row.addEventListener("dragover", (e) => {
    if (dragSrcIndex == null) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    const rect = row.getBoundingClientRect();
    const before = e.clientY - rect.top < rect.height / 2;
    if (before && (dragSrcIndex === i || dragSrcIndex === i - 1) || !before && (dragSrcIndex === i || dragSrcIndex === i + 1)) {
      clearDropIndicators(list);
      return;
    }
    // One line, moved (not recreated) into the gap between two slides.
    const existing = list.querySelector<HTMLElement>(".drop-line");
    const fresh = !existing;
    const line = existing ?? el("div", { class: "drop-line" });
    const thumb = row.querySelector(".thumb") as HTMLElement; // every row has its thumbnail
    const y = (before ? row.offsetTop : row.offsetTop + row.offsetHeight) - 3;
    line.style.width = thumb.offsetWidth + "px";
    line.style.transform = `translate(${row.offsetLeft + thumb.offsetLeft}px, ${y}px)`;
    if (fresh) list.appendChild(line);
  });
  row.addEventListener("drop", (e) => {
    e.preventDefault();
    const from = dragSrcIndex;
    clearDropIndicators(list);
    if (from == null || from === i) return;
    const rect = row.getBoundingClientRect();
    const before = e.clientY - rect.top < rect.height / 2;
    let to = before ? i : i + 1;
    if (from < to) to -= 1;
    if (from === to) return;
    moveSlideTo(from, to);
  });
}

/* ═════════════════ 11. Commands, navigation, keyboard ════════════════════ */

// Copy, cut, paste, duplicate and delete all work on the whole selection
// (one block or many); multi-block changes are saved as one undo step.
function copySelectedBlock(): boolean {
  commitInlineEdit();
  const blocks = selectedBlocks();
  if (!blocks.length) return false;
  clipboardBlocks = blocks.map((b) => {
    const clone = JSON.parse(JSON.stringify(b));
    delete clone.id;
    // Media is held as its data, not its asset ref: once the source is gone
    // the server can delete the asset, and a paste stores the data again.
    for (const k in clone.props) {
      const h = refHash(clone.props[k]);
      if (h && assetCache.has(h)) clone.props[k] = assetCache.get(h);
    }
    return clone;
  });
  return true;
}
async function cutSelectedBlock(): Promise<void> {
  if (!copySelectedBlock()) return;
  deleteSelectedBlock();
}
// Insert copies on the current slide, offset 24px, and select them.
async function insertCopies(blocks: BlockInput[]): Promise<void> {
  const slide = currentSlide();
  if (!slide || !blocks.length) return;
  const copies = blocks.map((b) => {
    const copy = offsetCopy(JSON.parse(JSON.stringify(b)));
    delete copy.id;
    return copy;
  });
  let ids: string[] | null;
  if (copies.length === 1) {
    const id = await api.addBlock(slide.id, copies[0]);
    ids = id == null ? null : [id];
  } else {
    ids = await api.addBlocks(slide.id, copies);
  }
  if (!ids || !ids.length) return;
  // Text typed while the copies were being made is saved before the stage moves on.
  commitInlineEdit();
  const live = deck.slides.find((s) => s.id === slide.id);
  const added = ids;
  if (live) copies.forEach((c, i) => { if (!live.blocks.some((b) => b.id === added[i])) live.blocks.push({ ...c, id: added[i] }); });
  setSelection(added);
  render();
  renderInspector();
}
function offsetCopy(copy: BlockInput): BlockInput {
  if (copy.type === "arrow" && copy.props) {
    copy.props = {
      ...copy.props,
      x1: (copy.props.x1 ?? 0) + 24,
      y1: (copy.props.y1 ?? 0) + 24,
      x2: (copy.props.x2 ?? 0) + 24,
      y2: (copy.props.y2 ?? 0) + 24
    };
  } else {
    copy.x = (copy.x ?? 0) + 24;
    copy.y = (copy.y ?? 0) + 24;
  }
  return copy;
}
async function pasteClipboardBlock(): Promise<void> {
  if (!clipboardBlocks.length) return;
  await insertCopies(clipboardBlocks);
  // Paste again and the next copy lands a further step along.
  clipboardBlocks = clipboardBlocks.map((b) => offsetCopy(JSON.parse(JSON.stringify(b))));
}
async function duplicateSelectedBlock(): Promise<void> {
  commitInlineEdit();
  await insertCopies(selectedBlocks());
}
function deleteSelectedBlock(): void {
  // The text being typed is saved first, so undoing the deletion brings it back.
  commitInlineEdit();
  const slide = currentSlide();
  const ids = selectedBlocks(slide).map((b) => b.id);
  if (!slide || !ids.length) return;
  const gone = new Set(ids);
  // The blocks fade out where they stood.
  const ghosts = reducedMotion.matches ? [] : ids.map((id) => [id, blockNode(id)] as const).filter((e): e is readonly [string, HTMLElement] => !!e[1]).map(([id, node]) => {
    const ghost = node.cloneNode(true) as HTMLElement;
    ghost.removeAttribute("data-block-id");
    ghost.style.outline = "none";
    ghost.style.pointerEvents = "none";
    ghost.querySelectorAll("div[style*='nwse-resize']").forEach((h) => h.remove());
    // Arrows live in a slide-sized layer: shrink toward the arrow itself,
    // not the middle of the slide.
    const b = slide.blocks.find((x) => x.id === id);
    if (b && COMPONENTS[b.type]?.fullBleed) {
      const p = b.props || {};
      ghost.style.transformOrigin = `${((p.x1 ?? 0) + (p.x2 ?? 0)) / 2}px ${((p.y1 ?? 0) + (p.y2 ?? 0)) / 2}px`;
    }
    return ghost;
  });
  slide.blocks = slide.blocks.filter((b) => !gone.has(b.id));
  setSelection([]);
  render();
  renderInspector();
  const frame = stageRef.el?.querySelector(".slide-frame");
  for (const ghost of frame ? ghosts : []) {
    frame?.appendChild(ghost);
    const a = ghost.animate([{ opacity: 1 }, { opacity: 0, transform: "scale(.97)" }], { duration: 180, easing: "ease-out", fill: "forwards" });
    a.finished.then(() => ghost.remove(), () => ghost.remove());
  }
  if (ids.length === 1) api.removeBlock(slide.id, ids[0]);
  else api.removeBlocks(slide.id, ids);
}
// Undo / redo right after an edit must not be lost while that edit is still
// saving. Finish any in-place text edit first (its save is queued ahead of
// the undo), and don't trust a stale "nothing to undo" while our own calls
// are in flight: the server keeps calls in order, so undo lands after them.
// If the server had nothing to undo after all, refresh the buttons.
async function refreshUndoState(): Promise<void> {
  try {
    const u = await gadget.getUndoState();
    canUndo = !!u?.canUndo;
    canRedo = !!u?.canRedo;
    updateUndoButtons();
  } catch {}
}
async function doUndo(): Promise<void> {
  commitInlineEdit();
  if (nudgePending.size) flushNudges();
  if (!canUndo && localPending === 0) return;
  const ok = await api.undo();
  if (ok === false) refreshUndoState();
}
async function doRedo(): Promise<void> {
  commitInlineEdit();
  if (nudgePending.size) flushNudges();
  if (!canRedo && localPending === 0) return;
  const ok = await api.redo();
  if (ok === false) refreshUndoState();
}
function updateUndoButtons(): void {
  shellRef.undoBtn?.classList.toggle("disabled", !canUndo);
  shellRef.redoBtn?.classList.toggle("disabled", !canRedo);
}
async function addBlockOfType(type: string): Promise<void> {
  const slide = currentSlide();
  if (!slide) return;
  const def = COMPONENTS[type];
  const base: BlockSeed = def.defaultBlock ? def.defaultBlock() : { x: 100, y: 200, props: {} };
  const sameType = slide.blocks.filter((b) => b.type === type).length;
  base.x = (base.x ?? 100) + sameType * 16;
  base.y = (base.y ?? 200) + sameType * 16;
  const block: BlockInput = { type, ...base };
  const id = await api.addBlock(slide.id, block);
  if (id === null) return;
  // Text typed while the block was being added is saved before the stage moves on.
  commitInlineEdit();
  block.id = id;
  const live = deck.slides.find((s) => s.id === slide.id);
  if (live && !live.blocks.some((b) => b.id === id)) live.blocks.push({ ...block, id });
  // The new block is selected (with its floating bar), but the Format panel
  // stays as it was: it opens only when asked.
  setSelection([id]);
  render();
  renderInspector();
  const node = blockNode(id);
  if (node && !reducedMotion.matches) node.animate([{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], { duration: 260, easing: "cubic-bezier(.2,.8,.2,1)" });
  // A new logo is an empty slot: ask for the image straight away.
  if (type === "logo") pickImageFor(id);
}
async function addSlide(template?: SlideTemplate): Promise<void> {
  const seed = template ? JSON.parse(JSON.stringify(template)) : void 0;
  const id = await api.addSlide(currentIndex + 1, seed);
  await resyncUnless(() => deck.slides.some((s) => s.id === id));
  commitInlineEdit();
  const i = deck.slides.findIndex((s) => s.id === id);
  if (i >= 0) currentIndex = i;
  setSelection([]);
  lastUserNav = Date.now();
  render();
  renderSlideList();
  renderInspector();
  updateCounter();
  scrollActiveRow();
  animateSlideIn(1);
  riseIn(shellRef.slideList?.querySelector(".srow.active"));
}
async function moveSlideTo(fromIndex: number, toIndex: number): Promise<void> {
  if (fromIndex === toIndex) return;
  const slide = deck.slides[fromIndex];
  if (!slide) return;
  const [s] = deck.slides.splice(fromIndex, 1);
  deck.slides.splice(toIndex, 0, s);
  if (currentIndex === fromIndex) currentIndex = toIndex;
  else if (fromIndex < currentIndex && toIndex >= currentIndex) currentIndex--;
  else if (fromIndex > currentIndex && toIndex <= currentIndex) currentIndex++;
  renderSlideList();
  updateCounter();
  await api.moveSlide(slide.id, toIndex);
}
async function duplicateSlideById(slideId: string): Promise<void> {
  const newId = await api.duplicateSlide(slideId);
  await resyncUnless(() => deck.slides.some((s) => s.id === newId));
  commitInlineEdit();
  const i = deck.slides.findIndex((s) => s.id === newId);
  if (i >= 0) currentIndex = i;
  setSelection([]);
  lastUserNav = Date.now();
  render();
  renderSlideList();
  renderInspector();
  updateCounter();
  scrollActiveRow();
  riseIn(shellRef.slideList?.querySelector(".srow.active"));
}
async function removeSlideById(slideId: string): Promise<void> {
  const viewingId = currentSlide()?.id;
  const wasCurrent = viewingId === slideId;
  await api.removeSlide(slideId);
  await resyncUnless(() => !deck.slides.some((s) => s.id === slideId));
  // Deleting another slide (from the list) keeps you on the one you were viewing.
  const keep = wasCurrent ? -1 : deck.slides.findIndex((s) => s.id === viewingId);
  currentIndex = keep >= 0 ? keep : clamp(currentIndex, 0, Math.max(0, deck.slides.length - 1));
  setSelection([]);
  render();
  renderSlideList();
  renderInspector();
  updateCounter();
}
function updateCounter(): void {
  if (!shellRef.counterNow || !shellRef.counterOf) return;
  shellRef.counterNow.textContent = String(Math.min(currentIndex + 1, deck.slides.length || 1));
  shellRef.counterOf.textContent = `/ ${deck.slides.length || 1}`;
  if (shellRef.counterNow.parentElement) setTip(shellRef.counterNow.parentElement, `Go to slide (${deck.slides.length} total)`);
}
function go(i: number): void {
  const n = deck.slides.length;
  if (n === 0) return;
  const next = (i % n + n) % n;
  const dir = Math.sign(next - currentIndex);
  lastUserNav = Date.now();
  currentIndex = next;
  setSelection([]);
  updateCounter();
  render();
  renderSlideList();
  renderInspector();
  scrollActiveRow();
  if (dir) animateSlideIn(dir);
  if (presenting) presentNote("count");
}
// A small slide change: the next slide arrives from the side it lives on.
function animateSlideIn(dir: number): void {
  if (!ready || isSlidesExport) return;
  const frame = stageRef.el?.querySelector(".slide-frame");
  if (!frame) return;
  const motion = !reducedMotion.matches;
  frame.animate(
    motion ? [{ opacity: 0, transform: `translateX(${dir * 18}px)` }, { opacity: 1, transform: "none" }] : [{ opacity: 0 }, { opacity: 1 }],
    { duration: presenting ? 260 : 220, easing: "cubic-bezier(.2,.8,.2,1)" }
  );
}
/** The shell, once mountShell() has run (every command runs after it). */
function shell(): Required<ShellRefs> {
  return shellRef as Required<ShellRefs>;
}
function toggleEdit(): void {
  editMode = !editMode;
  if (editMode && presenting) setPresenting(false);
  setSelection([]);
  closePop(true);
  shell().root.classList.toggle("editing", editMode);
  shell().editBtn.classList.toggle("on", editMode);
  shell().editLabel.textContent = editMode ? "Done" : "Edit";
  setTip(shell().editBtn, editMode ? "Done editing" : "Edit slides", ["E"]);
  updateUndoButtons();
  shell().updateToolFades();
  shellRef.fit?.();
  render();
  renderSlideList();
  renderInspector();
  if (editMode) requestAnimationFrame(scrollActiveRow);
}
// Hide or show the slide list in edit mode (⌘\), to give the slide more room.
function toggleRail(): void {
  railOpen = !railOpen;
  shell().root.classList.toggle("rail-hidden", !railOpen);
  shell().railBtn.classList.toggle("on", railOpen);
  setTip(shell().railBtn, railOpen ? "Hide slide list" : "Show slide list", combo("mod", "\\"));
  if (railOpen) requestAnimationFrame(scrollActiveRow);
}
// Select tool (V): plain clicks build a multi-selection, and presses always
// grab blocks instead of editing their text.
function toggleSelectTool(force?: boolean): void {
  selectTool = force ?? !selectTool;
  shell().root.classList.toggle("select-tool", selectTool);
  shell().selectBtn.classList.toggle("on", selectTool);
  if (isEditingInline()) (document.activeElement as HTMLElement).blur(); // isEditingInline() checked it
  render();
}
function setPresenting(on: boolean): void {
  presenting = on;
  shell().root.classList.toggle("presenting", presenting);
  shell().root.classList.remove("chrome-awake");
}
function togglePresent(): void {
  closePop(true);
  hideTip();
  const next = !presenting;
  if (next && editMode) {
    editMode = false;
    setSelection([]);
    shell().root.classList.remove("editing");
    shell().editBtn.classList.remove("on");
    shell().editLabel.textContent = "Edit";
    setTip(shell().editBtn, "Edit slides", ["E"]);
  }
  setPresenting(next);
  shellRef.fit?.();
  render();
  renderSlideList();
  renderInspector();
  if (presenting) presentNote("hint");
  else shell().presentNote.classList.remove("show");
}
// Present-mode notes: a one-time hint on entering, then the slide number as you move.
let noteTimer: ReturnType<typeof setTimeout> | undefined;
function presentNote(kind: "hint" | "count"): void {
  const n = shellRef.presentNote;
  if (!n || !presenting) return;
  clearTimeout(noteTimer);
  if (kind === "hint") {
    n.className = "present-note";
    n.replaceChildren(
      keysEl(combo("←"), "chip"), keysEl(combo("→"), "chip"), el("span", { class: "dim" }, "to move"),
      el("span", { class: "dim" }, "·"),
      keysEl(combo("Esc"), "chip"), el("span", { class: "dim" }, "to exit")
    );
  } else {
    n.className = "present-note count";
    n.replaceChildren(el("span", {}, String(currentIndex + 1)), el("span", { class: "dim" }, `/ ${deck.slides.length}`));
  }
  requestAnimationFrame(() => n.classList.add("show"));
  noteTimer = setTimeout(() => n.classList.remove("show"), kind === "hint" ? 2400 : 900);
}
function onKeyDown(e: KeyboardEvent): void {
  if (sheetOpen) return;
  const mod = e.metaKey || e.ctrlKey;
  if (e.key === "Escape" && openPop) {
    e.preventDefault();
    closePop();
    return;
  }
  if (mod && e.key === "/") {
    e.preventDefault();
    openShortcuts();
    return;
  }
  if (mod && !e.altKey && e.key.toLowerCase() === "s") {
    e.preventDefault();
    saveNow();
    return;
  }
  if (mod && !e.altKey && e.key === "\\") {
    e.preventDefault();
    if (editMode) toggleRail();
    return;
  }
  // ⌘/Ctrl 0 · + · −: fit, zoom in, zoom out (the slide, not the page).
  if (mod && !e.altKey && !presenting && ["0", "=", "+", "-", "_"].includes(e.key)) {
    e.preventDefault();
    if (e.key === "0") setZoom(null);
    else stepZoom(e.key === "-" || e.key === "_" ? -1 : 1);
    return;
  }
  if (e.target instanceof HTMLElement && (e.target.isContentEditable || e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT")) return;
  // ⌘⇧. / ⌘⇧, : larger / smaller text (by physical key, so ">" / "<" layouts agree).
  if (editMode && mod && e.shiftKey && !e.altKey && (e.code === "Period" || e.code === "Comma")) {
    if (quickTargets(selectedBlocks(), "fontSize").length) {
      e.preventDefault();
      stepFontSize(e.code === "Period" ? 1 : -1);
    }
    return;
  }
  if (mod && !e.altKey && e.key.toLowerCase() === "z") {
    e.preventDefault();
    if (e.shiftKey) doRedo();
    else doUndo();
    return;
  }
  if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "y") {
    e.preventDefault();
    doRedo();
    return;
  }
  if (editMode && mod && !e.shiftKey && !e.altKey) {
    const k = e.key.toLowerCase();
    if (k === "a") {
      const slide = currentSlide();
      if (slide?.blocks.length) {
        e.preventDefault();
        setSelection(slide.blocks.map((b) => b.id));
        render();
        renderInspector();
      }
      return;
    }
    if (k === "c") {
      if (selection.size) {
        e.preventDefault();
        copySelectedBlock();
      }
      return;
    }
    if (k === "x") {
      if (selection.size) {
        e.preventDefault();
        cutSelectedBlock();
      }
      return;
    }
    if (k === "v") {
      if (clipboardBlocks.length) {
        e.preventDefault();
        pasteClipboardBlock();
      }
      return;
    }
    if (k === "d") {
      if (selection.size) {
        e.preventDefault();
        duplicateSelectedBlock();
      }
      return;
    }
  }
  // With blocks selected in edit mode, the arrow keys nudge them (⇧: 10px).
  if (editMode && selection.size && !mod && !e.altKey && e.key.startsWith("Arrow")) {
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    const d = ({ ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] } as Record<string, [number, number]>)[e.key];
    if (d) nudgeSelected(d[0], d[1]);
    return;
  }
  if (mod || e.altKey) return;
  // Enter opens Format, unless it is pressing a focused button or link.
  if (editMode && e.key === "Enter" && selectedBlockId && !(e.target instanceof Element && e.target.closest("button, a[href], [role=button], [role=menuitem]"))) {
    e.preventDefault();
    toggleInspector(true);
    requestAnimationFrame(() => shellRef.inspectorBody?.querySelector<HTMLElement>("input, textarea, select")?.focus());
    return;
  }
  if (editMode && (e.key === "v" || e.key === "V") && !e.shiftKey) {
    toggleSelectTool();
    return;
  }
  if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") {
    e.preventDefault();
    go(currentIndex + 1);
  } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
    e.preventDefault();
    go(currentIndex - 1);
  } else if (e.key === "Home") go(0);
  else if (e.key === "End") go(deck.slides.length - 1);
  else if (e.key === "/" && editMode) {
    e.preventDefault();
    if (shellRef.insertBtn && openPop?.owner !== shellRef.insertBtn) insertMenu(shellRef.insertBtn);
  }
  else if (e.key === "e" || e.key === "E") toggleEdit();
  else if (e.key === "f" || e.key === "F") togglePresent();
  else if ((e.key === "Delete" || e.key === "Backspace") && editMode && selection.size) {
    e.preventDefault();
    deleteSelectedBlock();
  } else if (e.key === "Escape") {
    if (selection.size) selectBlock(null);
    else if (editMode && selectTool) toggleSelectTool(false);
    else if (presenting) togglePresent();
  }
}

/* ════════════════════════════ 12. Live edits ═════════════════════════════ */
// Changes made elsewhere -- an agent working over the binding, or another tab
// -- land with a light touch, so you can watch the deck being worked on:
//   • in edit mode, the view follows the agent to the slide it is working
//     on (unless you are busy: selecting, typing, or just moved yourself);
//     viewers who aren't editing stay where they are;
//   • a new block rises into place with a faint accent wash behind it;
//   • an edited block highlights just the words that changed (a hairline
//     tick marks where words were taken out), then the highlight fades;
//   • a mostly rewritten or restyled block washes; a moved block glides;
//   • a removed block fades where it stood;
//   • a slim accent "pen" follows the latest change and fades when it stops;
//   • in the slide list, new slides rise in and changed thumbnails glow.
// Several blocks in one change cascade in reading order. Everything is drawn
// in an overlay outside the slide, so none of it can reach saved content.

const agentLayer = el("div", { class: "ag-layer", "aria-hidden": "true" });
const agentPen = el("div", { class: "ag-pen" });
agentLayer.appendChild(agentPen);
let penTimer: ReturnType<typeof setTimeout> | undefined;
const liveEffectsOn = () => ready && !isSlidesExport && document.visibilityState === "visible";

function riseIn(node: Element | null | undefined): void {
  if (!node || !liveEffectsOn()) return;
  node.animate(
    reducedMotion.matches ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }],
    { duration: 300, easing: "cubic-bezier(.2,.8,.2,1)" }
  );
}
function washThumb(thumb: HTMLElement | null | undefined): void {
  if (!thumb || !liveEffectsOn()) return;
  const w = el("div", { class: "thumb-wash" });
  thumb.appendChild(w);
  const a = w.animate([{ opacity: 0 }, { opacity: 1, offset: 0.2 }, { opacity: 0 }], { duration: 1400, easing: "ease-out", fill: "both" });
  a.finished.then(() => w.remove(), () => w.remove());
}
function placeOnLayer<E extends HTMLElement>(node: E, rect: DOMRect, base = (stageRef.wrap as HTMLElement).getBoundingClientRect()): E { // the layer lives in the mounted stage
  node.style.transform = `translate(${Math.round((rect.left - base.left) * 2) / 2}px, ${Math.round((rect.top - base.top) * 2) / 2}px)`;
  node.style.width = Math.max(0, rect.width) + "px";
  node.style.height = Math.max(0, rect.height) + "px";
  return node;
}
// Overlays follow the block they belong to: blocks glide into place, and the
// stage reflows when panels slide in or the window resizes.
/** An overlay that tracks a block: `el` moves with `node`, offset as `rect` was from `ref`. */
interface Follower {
  el: HTMLElement;
  node: Element;
  rect: DOMRect;
  rectFn?: (() => DOMRect) | null;
  ref?: DOMRect;
}
const followers = new Set<Follower>();
let followRaf = 0;
function follow(entry: Follower): Follower {
  entry.ref = entry.node.getBoundingClientRect();
  followers.add(entry);
  if (!followRaf) followRaf = requestAnimationFrame(followFrame);
  return entry;
}
function followFrame(): void {
  followRaf = 0;
  if (!stageRef.wrap) return;
  const base = stageRef.wrap.getBoundingClientRect(), moves: Array<[Follower, DOMRect]> = [];
  for (const f of followers) {
    if (!f.node.isConnected || !f.el.isConnected) { followers.delete(f); if (f.el !== agentPen) f.el.remove(); continue; }
    const now = f.node.getBoundingClientRect();
    const ref = f.ref ?? now;
    moves.push([f, f.rectFn ? f.rectFn() : new DOMRect(f.rect.left + now.left - ref.left, f.rect.top + now.top - ref.top, f.rect.width, f.rect.height)]);
  }
  for (const [f, r] of moves) placeOnLayer(f.el, r, base);
  if (followers.size) followRaf = requestAnimationFrame(followFrame);
}
function flashOnLayer(className: string, rect: DOMRect, keyframes: Keyframe[], options: KeyframeAnimationOptions, node: Element | null = null, rectFn: (() => DOMRect) | null = null): HTMLDivElement {
  const n = placeOnLayer(el("div", { class: className }), rect);
  agentLayer.appendChild(n);
  const entry = node ? follow({ el: n, node, rect, rectFn }) : null;
  const a = n.animate(keyframes, { fill: "both", ...options });
  const done = () => { n.remove(); if (entry) followers.delete(entry); };
  a.finished.then(done, done);
  return n;
}
// A block's highlight area. Arrows are full-slide SVGs, so theirs is the
// line's own bounds rather than the whole slide.
function blockRect(node: Element, block: Block | null | undefined): DOMRect {
  if (block && COMPONENTS[block.type]?.fullBleed && stageRef.el) {
    const fr = stageRef.el.getBoundingClientRect(), s = stageScale, p = block.props || {};
    const x1 = Math.min(p.x1 ?? 0, p.x2 ?? 0), x2 = Math.max(p.x1 ?? 0, p.x2 ?? 0);
    const y1 = Math.min(p.y1 ?? 0, p.y2 ?? 0), y2 = Math.max(p.y1 ?? 0, p.y2 ?? 0);
    return new DOMRect(fr.left + x1 * s - 8, fr.top + y1 * s - 14, (x2 - x1) * s + 16, (y2 - y1) * s + 22);
  }
  const r = node.getBoundingClientRect();
  return new DOMRect(r.left - 5, r.top - 4, r.width + 10, r.height + 8);
}

// Word-level diff of a block's text: which stretches of the new text are new,
// and where old words were removed with nothing in their place.
const DIFF_TOKEN = /[\p{L}\p{N}_'’]+|\s+|[^\s]/gu;
/** Where a block's text changed: added [start, end) spans, removal points, and how much changed. */
interface TextDiff {
  added: Array<[number, number]>;
  removedAt: number[];
  ratio: number;
}
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
  const added: Array<[number, number]> = [], removedAt: number[] = [];
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
  const spans: Array<[number, number]> = [];
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
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const r = document.createRange();
  let pos = 0, started = false;
  for (let t = w.nextNode() as Text | null; t; t = w.nextNode() as Text | null) { // SHOW_TEXT walks text nodes only
    const len = t.data.length;
    if (!started && start <= pos + len) { r.setStart(t, start - pos); started = true; }
    if (started && end <= pos + len) { r.setEnd(t, end - pos); return r; }
    pos += len;
  }
  return null;
}
function lineRects(range: Range): DOMRect[] {
  const out: Array<{ left: number; right: number; top: number; bottom: number }> = [];
  for (const r of range.getClientRects()) {
    if (r.width < 1 || r.height < 1) continue;
    const same = out.find((o) => Math.abs(o.top - r.top) < 2 && r.left <= o.right + 1 && r.right >= o.left - 1);
    if (same) { const l = Math.min(same.left, r.left), rt = Math.max(same.right, r.right); same.left = l; same.right = rt; }
    else out.push({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
  }
  return out.map((o) => new DOMRect(o.left - 1.5, o.top, o.right - o.left + 3, o.bottom - o.top));
}
function caretRectAt(root: Node, offset: number): DOMRect | null {
  const r = textRange(root, offset, offset);
  if (!r) return null;
  const rect = r.getClientRects()[0] || r.getBoundingClientRect();
  return rect && rect.height ? rect : null;
}
function endRect(node: Node): DOMRect | null {
  const len = node.textContent?.length ?? 0;
  return len ? caretRectAt(node, len) : null;
}
let penFollow: Follower | null = null;
function movePen(rect: DOMRect | null, node: Element | null): void {
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

// Before a live change re-renders the stage: what each block said, and the
// nodes themselves (removed blocks fade out from their old node).
/** The stage before a live change re-rendered it: what each block said, and its node. */
interface StageCapture {
  slideId: string | null;
  blocks: Map<string, { node: HTMLElement; text: string }>;
}
function captureStage(): StageCapture {
  const frame = stageRef.el?.querySelector(".slide-frame");
  const blocks = new Map<string, { node: HTMLElement; text: string }>();
  if (frame) for (const n of frame.querySelectorAll<HTMLElement>("[data-block-id]")) blocks.set(n.dataset.blockId ?? "", { node: n, text: n.textContent ?? "" });
  return { slideId: currentSlide()?.id ?? null, blocks };
}
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function showLiveEdit(prevSlide: Slide | null, capture: StageCapture): void {
  const slide = currentSlide();
  const frame = stageRef.el?.querySelector(".slide-frame");
  if (!slide || !frame) return;
  const motion = !reducedMotion.matches;
  const sameView = capture.slideId === slide.id;
  const before = new Map((prevSlide?.blocks || []).map((b) => [b.id, b]));
  // Removed blocks fade out where they stood.
  if (sameView) {
    for (const [id, was] of capture.blocks) {
      if (slide.blocks.some((b) => b.id === id)) continue;
      const ghost = was.node.cloneNode(true) as HTMLElement;
      ghost.removeAttribute("data-block-id");
      ghost.style.pointerEvents = "none";
      ghost.style.outline = "none";
      frame.appendChild(ghost);
      const a = ghost.animate([{ opacity: 0.85 }, { opacity: 0, filter: "blur(1.5px)" }], { duration: 240, easing: "ease-out", fill: "forwards" });
      a.finished.then(() => ghost.remove(), () => ghost.remove());
    }
  }
  const changes: Array<{ b: Block; node: HTMLElement; old?: Block; was?: { node: HTMLElement; text: string } | null }> = [];
  for (const b of slide.blocks) {
    const node = frame.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(b.id)}"]`);
    if (!node) continue;
    const old = before.get(b.id);
    if (!old) { changes.push({ b, node }); continue; }
    if (sameJson(old, b)) continue;
    changes.push({ b, node, old, was: sameView ? capture.blocks.get(b.id) : null });
  }
  if (!changes.length) return;
  const top = (b: Block) => b.type === "arrow" ? Math.min(b.props?.y1 ?? 0, b.props?.y2 ?? 0) : b.y ?? 0;
  const left = (b: Block) => b.type === "arrow" ? Math.min(b.props?.x1 ?? 0, b.props?.x2 ?? 0) : b.x ?? 0;
  changes.sort((p, q) => top(p.b) - top(q.b) || left(p.b) - left(q.b));
  const step = Math.min(70, 560 / changes.length);
  const wash = (c: { b: Block; node: HTMLElement }, delay: number) => flashOnLayer("ag-wash", blockRect(c.node, c.b), [{ opacity: 0 }, { opacity: 1, offset: 0.2 }, { opacity: 0 }], { duration: 1300, delay, easing: "ease-out" }, c.node, () => blockRect(c.node, c.b));
  changes.slice(0, 40).forEach((c, k) => {
    const delay = Math.round(k * step);
    const { b, node, old, was } = c;
    let penRect: DOMRect | null = null;
    if (!old) {
      // New: rises into place.
      penRect = endRect(node);
      wash(c, delay);
      node.animate(motion ? [{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "none" }] : [{ opacity: 0 }, { opacity: 1 }], { duration: 300, delay, easing: "cubic-bezier(.2,.8,.2,1)", fill: "backwards" });
    } else {
      const moved = !COMPONENTS[b.type]?.fullBleed && ((old.x ?? 0) !== (b.x ?? 0) || (old.y ?? 0) !== (b.y ?? 0));
      if (moved && motion) {
        node.animate([{ transform: `translate(${(old.x ?? 0) - (b.x ?? 0)}px, ${(old.y ?? 0) - (b.y ?? 0)}px)` }, { transform: "none" }], { duration: 420, delay, easing: "cubic-bezier(.2,.8,.2,1)", fill: "backwards" });
      }
      const text = node.textContent ?? "";
      const diff = was && text.trim() && was.text !== text ? textDiff(was.text, text) : null;
      if (!diff || diff.ratio > 0.6 || !diff.added.length && !diff.removedAt.length) {
        // Restyled, resized, moved or mostly rewritten: a soft wash.
        wash(c, delay);
        if (was && was.text !== text) node.animate([{ opacity: 0.25 }, { opacity: 1 }], { duration: 380, delay, easing: "ease-out", fill: "backwards" });
        penRect = was && was.text !== text ? endRect(node) : null;
      } else {
        // Edited: just the new words light up, one after another, then fade.
        diff.added.forEach(([x, y], i) => {
          const r = textRange(node, x, y);
          if (!r) return;
          for (const rect of lineRects(r)) {
            flashOnLayer("ag-mark", rect, [{ opacity: 0 }, { opacity: 1, offset: 0.1 }, { opacity: 1, offset: 0.5 }, { opacity: 0 }], { duration: 1900, delay: delay + i * 45, easing: "ease-out" }, node);
          }
        });
        for (const at of diff.removedAt) {
          const rect = caretRectAt(node, at);
          if (rect) flashOnLayer("ag-tick", new DOMRect(rect.left - 1, rect.top + 1, 2, rect.height - 2), [{ opacity: 0 }, { opacity: 1, offset: 0.15 }, { opacity: 0 }], { duration: 1100, delay, easing: "ease-out" }, node);
        }
        const lastEnd = diff.added.length ? diff.added[diff.added.length - 1][1] : diff.removedAt[diff.removedAt.length - 1];
        penRect = caretRectAt(node, lastEnd) || endRect(node);
      }
    }
    if (penRect) {
      const ref = node.getBoundingClientRect();
      setTimeout(() => {
        if (!node.isConnected) return;
        const now = node.getBoundingClientRect();
        movePen(new DOMRect(penRect.left + now.left - ref.left, penRect.top + now.top - ref.top, 1, penRect.height), node);
      }, delay);
    }
  });
}
// Follow the agent to the slide it is working on -- only in edit mode (the
// person working with the agent), and not while you are busy. People just
// viewing or presenting stay where they are.
function canFollow(): boolean {
  return editMode && !presenting && !selection.size && !openPop && !sheetOpen && Date.now() - lastUserNav > 2500 && !isEditingInline() && !(shellRef.inspectorBody && isEditingField(shellRef.inspectorBody));
}

/* ════════════════════ 13. Collaboration & boot ═══════════════════════════ */

// The server broadcasts each saved change as a patch:
//   { rev, base, slides: { id: slide }, order? }
// carrying only the slides that changed (and the slide order, when that
// changed). A patch applies on top of revision `base`; anything else (a gap,
// or a slide we don't know) re-reads the deck. Unchanged slides keep their
// object identity, which is what the thumbnail cache and live-edit diffing
// key on.
let deckRev = -1;
let syncing = false;
let resyncing: Promise<void> | null = null;
const stashedPatches: DeckPatch[] = []; // arrived while connecting or re-reading
/** A patch waiting its turn; `fetched` once its media download was started. */
type QueuedPatch = DeckPatch & { fetched?: boolean };
const patchQueue: QueuedPatch[] = [];
let patchWaiting = false;
function onDeckPatched(patch: DeckPatch, meta: UndoState): void {
  if (meta) {
    canUndo = !!meta.canUndo;
    canRedo = !!meta.canRedo;
    updateUndoButtons();
  }
  if (!patch || typeof patch.rev !== "number") return;
  patchQueue.push(patch);
  drainPatches();
}
// In order; a patch that brings media this tab hasn't got waits for it.
function drainPatches(): void {
  if (patchWaiting) return;
  while (patchQueue.length) {
    const head = patchQueue[0];
    const slides = [...Object.values(head.slides || {}), ...logoMedia(head.logo)];
    // Waits once: if a download failed, the change still goes through.
    if (!head.fetched && missingAssets(slides).size) {
      head.fetched = true;
      patchWaiting = true;
      ensureAssets(slides).finally(() => {
        patchWaiting = false;
        drainPatches();
      });
      return;
    }
    applyPatch(patchQueue.shift() as QueuedPatch); // the loop checked there is one
  }
}
function mergePatch(base: Deck, patch: DeckPatch): Deck | null {
  const changed = patch.slides || {};
  const byId = new Map(base.slides.map((s) => [s.id, s]));
  const order = Array.isArray(patch.order) ? patch.order : base.slides.map((s) => s.id);
  const slides: Slide[] = [];
  for (const id of order) {
    const s = Object.hasOwn(changed, id) ? changed[id] : byId.get(id);
    if (!s) return null;
    slides.push(s);
  }
  if (slides.length < Object.keys(changed).length) return null;
  return Object.hasOwn(patch, "logo") ? { ...base, slides, logo: patch.logo ?? null } : { ...base, slides };
}
function applyPatch(patch: DeckPatch): void {
  if (!ready || syncing) { stashedPatches.push(patch); return; }
  if (patch.rev <= deckRev) return; // already in a deck we read
  const next = patch.base === deckRev ? mergePatch(deck, patch) : null;
  if (!next) { resync(); return; }
  deckRev = patch.rev;
  onDeckChanged(next, patch);
}
// Re-read the whole deck (small: media is fetched separately, once).
function resync(): Promise<void> {
  if (!resyncing) {
    resyncing = (async () => {
      syncing = true;
      try {
        const fresh = await gadget.getDeck({ refs: true });
        await ensureAssets([...fresh?.slides || [], ...logoMedia(fresh?.logo)]);
        syncing = false;
        applySnapshot(fresh);
      } catch (e) {
        console.error(e);
      } finally {
        syncing = false;
      }
    })().finally(() => { resyncing = null; });
  }
  return resyncing;
}
// After an edit whose reply we act on: usually its patch is already here.
async function resyncUnless(isCurrent: () => boolean): Promise<void> {
  if (!isCurrent()) await resync();
}
function onDeckChanged(newDeck: Deck, patch: DeckPatch): void {
  const remote = localPending === 0 && liveEffectsOn();
  const prevDeck = deck;
  const prevStageSlide = currentSlide();
  const capture = remote ? captureStage() : null;
  let flash: SlideFlash | null = null;
  if (remote) {
    // Only the slides in the patch can have changed.
    const prevById = new Map(prevDeck.slides.map((s) => [s.id, s]));
    const f: SlideFlash = flash = { added: new Set(), changed: new Set() };
    for (const [id, s] of Object.entries(patch.slides || {})) {
      const was = prevById.get(id);
      if (!was) f.added.add(id);
      else if (was !== s && JSON.stringify(was) !== JSON.stringify(s)) f.changed.add(id);
    }
  }
  const prevSlideId = prevStageSlide?.id;
  deck = newDeck;
  overlayNudges();
  if (prevSlideId) {
    const i = deck.slides.findIndex((s) => s.id === prevSlideId);
    if (i >= 0) currentIndex = i;
    else currentIndex = Math.min(currentIndex, deck.slides.length - 1);
  } else {
    currentIndex = Math.min(currentIndex, deck.slides.length - 1);
  }
  currentIndex = Math.max(0, currentIndex);
  let followedDir = 0;
  const f = flash;
  if (f && (f.added.size || f.changed.size) && canFollow()) {
    const cur = currentSlide()?.id ?? "";
    if (!f.added.has(cur) && !f.changed.has(cur)) {
      const target = deck.slides.findIndex((s) => f.added.has(s.id) || f.changed.has(s.id));
      if (target >= 0) {
        followedDir = Math.sign(target - currentIndex) || 1;
        currentIndex = target;
      }
    }
  }
  if (selection.size) {
    const s = currentSlide();
    const keep = s ? s.blocks.filter((b) => selection.has(b.id)).map((b) => b.id) : [];
    if (keep.length !== selection.size) setSelection(keep);
  }
  // Never yank text out from under someone typing, or a block out from under
  // a drag: the stage and inspector catch up as soon as that ends. A change
  // that left the slide on stage untouched doesn't rebuild it at all.
  // (The deck logo is on every slide: a new one redraws the slide on stage.)
  if (currentSlide() !== prevStageSlide || deck.logo !== prevDeck.logo) {
    if (isEditingInline() || shellRef.root?.classList.contains("dragging")) stageStale = true;
    else render();
  }
  renderSlideList(flash);
  if (shellRef.inspectorBody && isEditingField(shellRef.inspectorBody)) inspectorStale = true;
  else renderInspector();
  updateCounter();
  if (followedDir) { animateSlideIn(followedDir); scrollActiveRow(); }
  if (remote && !stageStale && f && capture) {
    const cur = currentSlide();
    if (cur && (f.added.has(cur.id) || f.changed.has(cur.id))) {
      showLiveEdit(prevDeck.slides.find((s) => s.id === cur.id) || null, capture);
    }
  }
  scheduleSvgRasters();
}
function applySnapshot(fresh: Deck | null | undefined): void {
  const prevSlideId = currentSlide()?.id;
  deck = fresh && Array.isArray(fresh.slides) ? fresh : { slides: [] };
  deckRev = typeof fresh?.rev === "number" ? fresh.rev : -1;
  // Changes saved while this snapshot was on its way.
  let gap = false;
  for (const p of stashedPatches.splice(0).sort((a, b) => a.rev - b.rev)) {
    if (p.rev <= deckRev) continue;
    const next = p.base === deckRev ? mergePatch(deck, p) : null;
    if (!next) { gap = true; break; }
    deck = next;
    deckRev = p.rev;
  }
  if (gap) setTimeout(() => { if (ready) resync(); }, 0);
  overlayNudges();
  const i = prevSlideId ? deck.slides.findIndex((s) => s.id === prevSlideId) : -1;
  currentIndex = i >= 0 ? i : clamp(currentIndex, 0, Math.max(0, deck.slides.length - 1));
  if (selection.size) {
    const s = currentSlide();
    setSelection(s ? s.blocks.filter((b) => selection.has(b.id)).map((b) => b.id) : []);
  }
  // As for a patch: text being typed (saved on blur) or a drag keeps its stage.
  if (isEditingInline() || shellRef.root?.classList.contains("dragging")) stageStale = true;
  else render();
  renderSlideList();
  if (shellRef.inspectorBody && isEditingField(shellRef.inspectorBody)) inspectorStale = true;
  else renderInspector();
  updateCounter();
  scheduleSvgRasters();
}

// ── SVG rasters for PowerPoint ──
// The server can't draw SVG, and PowerPoint viewers without SVG support
// (Google Slides, older PowerPoint, Quick Look) show a picture's PNG stand-in.
// So, a little after the deck settles, this tab draws a PNG of any SVG
// artwork the server has no raster for yet and saves it (saveSvgRaster: not
// an edit, no undo step). Keys match server.ts svgKey(): the hash of the
// source, which for an asset ref is the ref's own hash.
const rasterKnown = new Set<string>();
let rasterTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleSvgRasters(): void {
  if (isSlidesExport || !globalThis.crypto?.subtle) return;
  clearTimeout(rasterTimer);
  rasterTimer = setTimeout(() => saveSvgRasters().catch((e) => console.error("Could not save SVG rasters", e)), 1500);
}
async function saveSvgRasters(): Promise<void> {
  const sources = new Map<string, string>(), live = new Set<string>();
  for (const s of [...deck.slides, ...logoMedia(deck.logo)]) {
    for (const b of s.blocks || []) {
      const p = b.props || {};
      const v = b.type === "svg" ? p.markup : b.type === "image" || b.type === "logo" ? p.src : null;
      if (typeof v !== "string" || !v.trim()) continue;
      const raw = assetRaw(v);
      if (b.type === "svg" ? isBrandBarMarkup(raw) : !/^data:image\/svg\+xml/i.test(raw)) continue;
      const key = refHash(v) || await hashString(v);
      live.add(key);
      if (!rasterKnown.has(key)) sources.set(key, raw);
    }
  }
  // Artwork that leaves the deck may lose its raster to the asset sweep, so
  // it is asked about again if it comes back.
  for (const key of rasterKnown) if (!live.has(key)) rasterKnown.delete(key);
  if (!sources.size) return;
  const missing = await gadget.missingSvgRasters([...sources.keys()]);
  for (const key of sources.keys()) if (!missing.includes(key)) rasterKnown.add(key);
  for (const key of missing) {
    rasterKnown.add(key);
    const png = await rasterizeSvg(sources.get(key) ?? "");
    if (png) await gadget.saveSvgRaster(key, png);
  }
}
// SVG markup or an SVG data URI, as a PNG data URI (longest side 1600px), or
// null when it can't be drawn.
async function rasterizeSvg(raw: string): Promise<string | null> {
  try {
    let markup = raw;
    if (/^data:/i.test(raw)) {
      const comma = raw.indexOf(",");
      const head = raw.slice(0, comma), body = raw.slice(comma + 1);
      // (A bare %, as in width="100%", is taken as itself.)
      markup = /;base64/i.test(head) ? new TextDecoder().decode(Uint8Array.from(atob(body), (c) => c.charCodeAt(0))) : decodeURIComponent(body.replace(/%(?![0-9a-f]{2})/gi, "%25"));
    }
    const node = parseSvgMarkup(markup);
    if (!node) return null;
    // (A foreignObject would taint the canvas.)
    node.querySelectorAll("foreignObject").forEach((n) => n.remove());
    let { w, h } = svgArtworkSize(node);
    const k = 1600 / Math.max(w, h);
    w = Math.max(1, Math.round(w * k));
    h = Math.max(1, Math.round(h * k));
    node.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    node.setAttribute("width", String(w));
    node.setAttribute("height", String(h));
    const xml = new XMLSerializer().serializeToString(node);
    const img = await loadImage("data:image/svg+xml;charset=utf-8," + encodeURIComponent(xml));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    (canvas.getContext("2d") as CanvasRenderingContext2D).drawImage(img, 0, 0, w, h); // a fresh canvas always has one
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}

let connectedOnce = false, connecting: Promise<void> | null = null;
// The subscriber the server holds, until it drops it. A connect attempt that
// fails after subscribing retries without subscribing a second one.
let subscription: object | null = null;
function makeSubscriber() {
  const sub = createSubscriber(RpcTarget, { deckPatched: onDeckPatched });
  // The server's handle on our subscriber is dropped when the connection
  // breaks; subscribe again so live updates keep flowing.
  sub[Symbol.dispose] = () => {
    if (subscription === sub) subscription = null;
    if (isSlidesExport) return;
    ready = false;
    setSync("reconnecting");
    ensureConnected();
  };
  return sub;
}
async function connect(): Promise<void> {
  ready = false;
  for (let attempt = 0; ; attempt++) {
    try {
      if (!isSlidesExport && !subscription) {
        // Held before the call returns, so a drop during it is seen.
        const sub = makeSubscriber();
        subscription = sub;
        try {
          await gadget.subscribe(sub, { patches: true });
        } catch (e) {
          if (subscription === sub) subscription = null;
          throw e;
        }
      }
      const fresh = await gadget.getDeck({ refs: true });
      await ensureAssets([...fresh?.slides || [], ...logoMedia(fresh?.logo)]);
      try {
        const u = await gadget.getUndoState();
        canUndo = !!u?.canUndo;
        canRedo = !!u?.canRedo;
      } catch {}
      // The subscriber was dropped meanwhile: subscribe again and re-read.
      if (!isSlidesExport && !subscription) continue;
      applySnapshot(fresh);
      updateUndoButtons();
      ready = true;
      if (!connectedOnce) {
        connectedOnce = true;
        shell().stage.classList.remove("loading");
        shell().updateToolFades();
        const frame = shell().stage.querySelector(".slide-frame");
        if (frame && !isSlidesExport) frame.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, easing: "ease-out" });
      }
      if (syncShown === "offline") hideSync();
      return;
    } catch (e) {
      console.error(e);
      if (isSlidesExport) return;
      setSync("offline");
      await sleep(Math.min(1e4, 500 * 2 ** attempt));
    }
  }
}
function ensureConnected(): Promise<void> {
  if (!connecting) connecting = connect().finally(() => { connecting = null; });
  return connecting;
}

mountShell();
try {
  const brand = await gadget.getBrandAssets();
  COVER_ORANGE_PNG = brand?.coverOrange || "";
} catch (e) {
  console.error("Could not load the slide artwork", e);
}
await ensureConnected();
if (isSlidesExport) {
  renderPrintDeck();
  shell().root.remove();
  // Exports are captured when this script finishes: let the embedded images decode first.
  await Promise.race([
    Promise.all(Array.from(shell().printDeck.querySelectorAll("img"), (img) => img.decode?.().catch(() => {}))),
    sleep(1500)
  ]);
}
