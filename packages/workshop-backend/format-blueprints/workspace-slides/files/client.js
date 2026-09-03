/* =========================================================================
 *  Gadgets Slide Builder
 *  -----------------------------------------------------------------------
 *  The deck is data. Each slide is `{ id, background, blocks: [...] }`.
 *  Each block is `{ id, type, x, y, w?, h?, props }`. Components live in
 *  the COMPONENTS registry below; adding a new block type means adding a
 *  new entry there.
 *
 *  Edit mode (E) reveals:
 *    - left panel: search box + slide thumbnails (drag to reorder,
 *      hover for actions) with a one-line title under each
 *    - right panel:
 *        · filterable component library (search + grouped list)
 *        · slide background settings
 *        · inspector for the selected block (or empty hint)
 *    - draggable + resizable blocks with inline editable text
 *
 *  Present mode (F) hides all chrome and fills the viewport.
 * ========================================================================= */

/* ----------------------- Design tokens ----------------------------------- */
const C = {
  page:        "#f5f1eb",
  surface:     "#fff9ef",
  surfaceSoft: "#fff4e6",
  text:        "#2b0b05",
  muted:       "#7b6254",
  subtle:      "#a89082",
  border:      "#ead6c4",
  borderLight: "#f2e3d5",
  orange:      "#ff5f2e",
  orangeDark:  "#c84724",
  blue:        "#0a95ff",
  purple:      "#9b3ff6",
  green:       "#26a641",
  yellow:      "#f5a623",
};
// Corporate slide-facing palette. Editor chrome may use additional neutral
// values, but authored slide components are deliberately restricted to the
// branded white-slide colors.
const TONES = ["neutral", "tangerine", "ruby"];
const toneFill = {
  neutral:    "#FFFFFF",
  tangerine: "#FFFFFF",
  ruby:      "#FFFFFF",
};
const toneColor = {
  neutral:    "#747474",
  tangerine: "#F6821F",
  ruby:      "#FF6633",
};

const FONT     = 'Inter, Arial, sans-serif';
const MONO     = '"Apercu Mono Pro", ui-monospace, SFMono-Regular, Menlo, monospace';
const WORDMARK = '"FT Kunst Grotesk", Inter, Arial, sans-serif';

/* Custom easing curves — built-in CSS easings lack the punch that makes
 * UI motion feel intentional. Used everywhere via `var(--ease)`. */
const EASE        = "cubic-bezier(0.23, 1, 0.32, 1)";        // strong ease-out
const EASE_IN_OUT = "cubic-bezier(0.77, 0, 0.175, 1)";       // strong ease-in-out

const isSlidesExport = ["html", "pdf"].includes(globalThis.gadgetExportFormatId);
if (isSlidesExport) document.documentElement.classList.add("slides-export");

/* ----------------------- App state --------------------------------------- */
let deck            = { slides: [] };
let currentIndex    = 0;
let editMode        = false;
let presenting      = false;
let selectedBlockId = null;
let stageScale      = 1;
let advancedOpen    = false;   // remembered across inspector re-renders
let librarySearch   = "";      // filter text for component library
let slideSearch     = "";      // filter text for slide list
// In-memory clipboard for copy/cut/paste of a single block (edit mode only).
// We store a deep clone WITHOUT the id so paste always produces a fresh block.
// Lives only in this tab — not persisted, not shared between clients, since
// "copy a block from one deck and paste it into another" isn't a real flow.
let clipboardBlock  = null;
// Server-side undo/redo availability, refreshed whenever the deck changes
// (or via getUndoState() at boot). The undo stack lives on the server and
// is shared across all connected clients — a global history for the deck.
let canUndo         = false;
let canRedo         = false;

const stageRef = { el: null, wrap: null };
const shellRef = {};

/* ----------------------- DOM helpers ------------------------------------- */
function el(tag, props = {}, children = []) {
  const e = document.createElement(tag);
  for (const k in props) {
    const v = props[k];
    if (v == null) continue;
    if (k === "style") Object.assign(e.style, v);
    else if (k === "class") e.className = v;
    else if (k === "html") e.innerHTML = v;
    else if (k === "text") e.textContent = v;
    else if (k === "data") Object.assign(e.dataset, v);
    else if (k.startsWith("on") && typeof v === "function")
      e.addEventListener(k.slice(2).toLowerCase(), v);
    else e.setAttribute(k, v);
  }
  for (const c of (children || [])) {
    if (c == null || c === false) continue;
    if (typeof c === "string" || typeof c === "number")
      e.appendChild(document.createTextNode(String(c)));
    else e.appendChild(c);
  }
  return e;
}
function svg(tag, attrs = {}, children = []) {
  const e = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const k in attrs) {
    const v = attrs[k];
    if (v == null) continue;
    e.setAttribute(k, v);
  }
  for (const c of (children || [])) if (c) e.appendChild(c);
  return e;
}
function svgFromString(s) {
  const t = document.createElement("template");
  t.innerHTML = s.trim();
  return t.content.firstChild;
}
function hexA(hex, a) {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[ch]));
}
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* ====================== Component primitives ============================= */

/* Each component is responsible for rendering its content into a wrapper
 * the shell creates. The wrapper handles position, selection, and dragging,
 * so render() should produce content with width/height 100% of its wrapper.
 *
 * `ctx` has helpers:
 *   - inlineText(elem, propKey)  — bind contentEditable in edit mode
 *
 * Schema fields drive the inspector panel:
 *   { key, label, type: "text"|"multiline"|"number"|"select"|"checkbox", ... }
 */

const COMPONENTS = {
  sectionLabel: {
    name: "Section label",
    defaultBlock: () => ({
      x: 48, y: 38,
      props: { text: "NEW SECTION" },
    }),
    fields: [
      { key: "text", label: "Text", type: "text" },
    ],
    render(props, ctx) {
      // Eyebrow: always accent orange, uppercase, SemiBold, +5% tracking.
      return ctx.inlineText(el("div", {
        style: {
          color: "#FF6633",
          fontSize: "10px", fontWeight: "600", lineHeight: "1",
          letterSpacing: "0.05em", textTransform: "uppercase",
          whiteSpace: "nowrap",
        },
      }), "text");
    },
  },

  logo: {
    name: "Logo",
    defaultBlock: () => ({
      x: 36, y: 56, props: { variant: "light", scale: 1, text: "Workspace",
        accentDot: true },
    }),
    fields: [
      { key: "text", label: "Wordmark", type: "text" },
      { key: "variant", label: "Variant", type: "select",
        options: ["light", "dark"] },
      { key: "scale", label: "Scale", type: "number",
        min: 0.4, max: 2, step: 0.05 },
      { key: "accentDot", label: "Accent dot", type: "checkbox" },
    ],
    render(props) {
      // Clean editable wordmark. Used on both cover (light) and content
      // (dark) slides. Optionally ends with a small accent dot — a quiet,
      // intentional brand flourish rather than an arbitrary icon.
      const scale = props.scale || 1;
      const dark = props.variant === "dark";
      const textColor  = dark ? "#000000" : "#FFFFFF";
      const wrap = el("div", {
        style: {
          display: "flex", flexDirection: "row", alignItems: "baseline",
          gap: (3 * scale) + "px", whiteSpace: "nowrap",
        },
      });
      wrap.appendChild(el("div", {
        text: props.text != null ? props.text : "Workspace",
        style: {
          color: textColor,
          fontFamily: FONT,
          fontSize: (24 * scale) + "px",
          fontWeight: "700",
          lineHeight: "1",
          letterSpacing: "-0.02em",
          whiteSpace: "nowrap",
        },
      }));
      if (props.accentDot !== false) {
        wrap.appendChild(el("div", {
          style: {
            width: (6 * scale) + "px", height: (6 * scale) + "px",
            borderRadius: "50%", background: "#F6821F",
            flex: `0 0 ${6 * scale}px`,
            transform: `translateY(${-1 * scale}px)`,
          },
        }));
      }
      return wrap;
    },
  },

  gadgetsMark: {
    name: "Gadgets mark",
    defaultBlock: () => ({
      x: 48, y: 280, props: { size: "large" },
    }),
    fields: [
      { key: "size", label: "Size", type: "select",
        options: ["large", "small"] },
    ],
    render(props) {
      const conf = props.size === "small"
        ? { svg: 48, gap: 18, fs: 40 }
        : { svg: 59, gap: 26, fs: 49 };
      const wrap = el("div", {
        style: {
          display: "flex", alignItems: "center", gap: conf.gap + "px",
        },
      });
      wrap.appendChild(svgFromString(`
        <svg width="${conf.svg}" height="${conf.svg}" viewBox="0 0 86 86" xmlns="http://www.w3.org/2000/svg">
          <polygon points="43 6 77 25 77 61 43 80 9 61 9 25"
            fill="none" stroke="#ff4801" stroke-width="10" stroke-linejoin="round"/>
        </svg>`));
      wrap.appendChild(el("div", {
        text: "gadgets",
        style: {
          fontFamily: WORDMARK,
          fontSize: conf.fs + "px",
          fontWeight: "500",
          letterSpacing: "-0.055em",
          color: "#140400",
          lineHeight: "1",
        },
      }));
      return wrap;
    },
  },

  title: {
    name: "Title",
    defaultBlock: () => ({
      x: 33, y: 197, w: 687,
      props: { text: "[TITLE]", fontSize: 58, weight: 700,
               color: "#FFFFFF", letterSpacing: "-0.03em",
               highlight: "", lineHeight: 1.1 },
    }),
    resizableW: true,
    fields: [
      { key: "text", label: "Text", type: "multiline" },
      { key: "fontSize", label: "Font size", type: "number",
        min: 14, max: 120, step: 1 },
      { key: "color", label: "Color", type: "color" },
      { key: "highlight", label: "Highlight (comma list)", type: "text", advanced: true },
      { key: "weight", label: "Weight", type: "select",
        options: ["400", "500", "600", "700"], advanced: true },
      { key: "letterSpacing", label: "Letter spacing", type: "text", advanced: true },
      { key: "lineHeight", label: "Line height", type: "number",
        min: 0.8, max: 2, step: 0.02, advanced: true },
    ],
    render(props, ctx) {
      const e = el("div", {
        style: {
          fontSize: (props.fontSize || 42) + "px",
          fontWeight: String(props.weight || 900),
          letterSpacing: props.letterSpacing || "-0.04em",
          lineHeight: String(props.lineHeight || 1.08),
          color: props.color || C.text,
          whiteSpace: "pre-wrap",
        },
      });
      ctx.inlineText(e, "text", (txt) => {
        let html = escapeHtml(txt);
        const words = (props.highlight || "")
          .split(",").map(s => s.trim()).filter(Boolean);
        for (const w of words) {
          const re = new RegExp(escapeRegex(w), "g");
          html = html.replace(re, `<span style="color:${C.orange}">${escapeHtml(w)}</span>`);
        }
        return html.replace(/\n/g, "<br/>");
      });
      return e;
    },
  },

  subtitle: {
    name: "Subtitle",
    defaultBlock: () => ({
      x: 36, y: 533, w: 553,
      props: { text: "[SUBTITLE]", fontSize: 17,
               color: "#FFFFFF", lineHeight: 1.5, weight: 600 },
    }),
    resizableW: true,
    fields: [
      { key: "text", label: "Text", type: "multiline" },
      { key: "fontSize", label: "Font size", type: "number",
        min: 10, max: 48, step: 1 },
      { key: "color", label: "Color", type: "color" },
      { key: "weight", label: "Weight", type: "select",
        options: ["400", "500", "600", "700"], advanced: true },
      { key: "lineHeight", label: "Line height", type: "number",
        min: 0.9, max: 2, step: 0.05, advanced: true },
    ],
    render(props, ctx) {
      const e = el("div", {
        style: {
          color: props.color || C.muted,
          fontSize: (props.fontSize || 19) + "px",
          lineHeight: String(props.lineHeight || 1.5),
          fontWeight: String(props.weight || 500),
          whiteSpace: "pre-wrap",
        },
      });
      return ctx.inlineText(e, "text");
    },
  },

  text: {
    name: "Text block",
    defaultBlock: () => ({
      x: 100, y: 200, w: 400,
      props: { text: "Text", fontSize: 19, color: "#000000", weight: 400,
               family: "sans", align: "left", lineHeight: 1.6 },
    }),
    resizableW: true,
    fields: [
      { key: "text", label: "Text", type: "multiline" },
      { key: "fontSize", label: "Font size", type: "number",
        min: 8, max: 96, step: 1 },
      { key: "color", label: "Color", type: "color" },
      { key: "align", label: "Align", type: "select",
        options: ["left", "center", "right"] },
      { key: "weight", label: "Weight", type: "select",
        options: ["400", "500", "600", "700"], advanced: true },
      { key: "lineHeight", label: "Line height", type: "number",
        min: 0.9, max: 2, step: 0.05, advanced: true },
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
          whiteSpace: "pre-wrap",
        },
      });
      return ctx.inlineText(e, "text");
    },
  },

  bulletList: {
    name: "Bullet list",
    defaultBlock: () => ({
      x: 36, y: 204, w: 850,
      props: {
        text: "First complete sentence.\nSecond complete sentence.\nThird complete sentence.",
        treatment: "primary",
      },
    }),
    resizableW: true,
    fields: [
      { key: "text", label: "One item per line", type: "multiline" },
      { key: "treatment", label: "Treatment", type: "select",
        options: ["primary", "compact"] },
    ],
    render(props) {
      const compact = props.treatment === "compact";
      const size = compact ? 17 : 19;
      const itemGap = compact ? 8 : 10;
      const list = el("div", {
        style: {
          width: "100%",
          display: "flex", flexDirection: "column",
          gap: itemGap + "px",
          fontFamily: FONT,
        },
      });
      const items = String(props.text || "")
        .split("\n").map(s => s.trim()).filter(Boolean).slice(0, 6);
      for (const item of items) {
        const row = el("div", {
          style: {
            display: "flex", alignItems: "flex-start", gap: "12px",
            width: "100%",
          },
        });
        row.appendChild(el("span", {
          style: {
            width: "6px", height: "6px", flex: "0 0 6px",
            marginTop: compact ? "7px" : "8px",
            borderRadius: "50%", background: "#F6821F",
          },
        }));
        row.appendChild(el("div", {
          text: item,
          style: {
            flex: "1", minWidth: "0",
            fontSize: size + "px", fontWeight: "400",
            lineHeight: compact ? "1.45" : "1.5",
            color: "#000000", textAlign: "left",
          },
        }));
        list.appendChild(row);
      }
      return list;
    },
  },

  card: {
    name: "Card",
    defaultBlock: () => ({
      x: 100, y: 240, w: 280, h: 260,
      props: { tone: "neutral", topStripe: false,
               eyebrow: "EYEBROW", title: "Card title",
               body: "Body copy goes here." },
    }),
    resizableW: true, resizableH: true,
    fields: [
      { key: "tone", label: "Tone", type: "select", options: TONES },
      { key: "topStripe", label: "Top stripe", type: "checkbox" },
      { key: "eyebrow", label: "Eyebrow", type: "text" },
      { key: "title", label: "Title", type: "text" },
      { key: "body", label: "Body", type: "multiline" },
    ],
    render(props, ctx) {
      const tone = props.tone || "neutral";
      const color = toneColor[tone], fill = toneFill[tone];
      const wrap = el("div", {
        style: {
          position: "relative",
          width: "100%", height: "100%",
          boxSizing: "border-box",
          padding: "20px",
          borderRadius: "2px",
          background: fill,
          border: "1px solid #E5E5E5",
          boxShadow: "none",
          display: "flex", flexDirection: "column", gap: "12px",
          overflow: "hidden",
        },
      });
      if (props.eyebrow) {
        wrap.appendChild(ctx.inlineText(el("div", {
          style: {
            color: "#FF6633", fontSize: "10px", fontWeight: "600",
            letterSpacing: "0.05em", textTransform: "uppercase",
            lineHeight: "1.2",
          },
        }), "eyebrow"));
      }
      wrap.appendChild(ctx.inlineText(el("div", {
        style: {
          fontSize: "18px", fontWeight: "600",
          letterSpacing: "-0.02em", lineHeight: "1.3",
          color: "#000000",
        },
      }), "title"));
      wrap.appendChild(ctx.inlineText(el("div", {
        style: {
          fontSize: "15px", lineHeight: "1.5",
          color: "#747474", fontWeight: "400",
          whiteSpace: "pre-wrap",
        },
      }), "body"));
      return wrap;
    },
  },

  box: {
    name: "Diagram box",
    defaultBlock: () => ({
      x: 200, y: 320, w: 220, h: 110,
      props: { tone: "neutral", title: "Box", body: "", dashed: false },
    }),
    resizableW: true, resizableH: true,
    fields: [
      { key: "tone", label: "Tone", type: "select", options: TONES },
      { key: "dashed", label: "Dashed border", type: "checkbox" },
      { key: "title", label: "Title", type: "text" },
      { key: "body", label: "Body", type: "multiline" },
    ],
    render(props, ctx) {
      const tone = props.tone || "neutral";
      const color = toneColor[tone], fill = toneFill[tone];
      const wrap = el("div", {
        style: {
          width: "100%", height: "100%",
          boxSizing: "border-box",
          padding: "14px",
          borderRadius: "2px",
          background: fill,
          border: `${props.dashed ? "1px dashed" : "1px solid"} #E5E5E5`,
          display: "flex", flexDirection: "column",
          justifyContent: "center",
        },
      });
      wrap.appendChild(ctx.inlineText(el("div", {
        style: {
          fontSize: "16px", fontWeight: "600",
          letterSpacing: "-0.02em", color: "#000000",
          lineHeight: "1.3",
        },
      }), "title"));
      if (props.body) {
        wrap.appendChild(ctx.inlineText(el("div", {
          style: {
            marginTop: "6px",
            fontSize: "14px", color: "#747474",
            fontWeight: "400", lineHeight: "1.45",
          },
        }), "body"));
      }
      return wrap;
    },
  },

  tonePill: {
    name: "Tone pill",
    defaultBlock: () => ({
      x: 100, y: 200, props: { tone: "tangerine", text: "LABEL" },
    }),
    fields: [
      { key: "tone", label: "Tone", type: "select", options: TONES },
      { key: "text", label: "Text", type: "text" },
    ],
    render(props, ctx) {
      const tone = props.tone || "tangerine";
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
          whiteSpace: "nowrap",
        },
      });
      return ctx.inlineText(e, "text");
    },
  },

  divider: {
    name: "Divider",
    defaultBlock: () => ({
      x: 100, y: 360, w: 400, h: 2,
      props: { color: C.border, opacity: 1 },
    }),
    resizableW: true, resizableH: true,
    fields: [
      { key: "color", label: "Color", type: "color" },
      { key: "opacity", label: "Opacity", type: "number",
        min: 0, max: 1, step: 0.05 },
    ],
    render(props) {
      return el("div", {
        style: {
          width: "100%", height: "100%",
          background: props.color || C.border,
          opacity: String(props.opacity ?? 1),
          borderRadius: "1px",
        },
      });
    },
  },

  shape: {
    name: "Shape",
    defaultBlock: () => ({
      x: 200, y: 200, w: 200, h: 200,
      props: { kind: "rect", fill: "#FFFFFF", stroke: "#E5E5E5",
               strokeWidth: 1, radius: 2, opacity: 1 },
    }),
    resizableW: true, resizableH: true,
    fields: [
      { key: "kind", label: "Kind", type: "select",
        options: ["rect", "ellipse"] },
      { key: "fill", label: "Fill", type: "color" },
      { key: "stroke", label: "Stroke", type: "color" },
      { key: "opacity", label: "Opacity", type: "number",
        min: 0, max: 1, step: 0.05 },
      { key: "strokeWidth", label: "Stroke width", type: "number",
        min: 0, max: 12, step: 1, advanced: true },
      { key: "radius", label: "Corner radius", type: "number",
        min: 0, max: 200, step: 1, advanced: true },
    ],
    render(props) {
      return el("div", {
        style: {
          width: "100%", height: "100%",
          background: props.fill || "transparent",
          border: `${props.strokeWidth || 0}px solid ${props.stroke || "transparent"}`,
          borderRadius: (props.kind === "ellipse" ? "999px" : (props.radius || 0) + "px"),
          opacity: String(props.opacity ?? 1),
          boxSizing: "border-box",
        },
      });
    },
  },

  image: {
    name: "Image",
    defaultBlock: () => ({
      x: 600, y: 0, w: 600, h: 675,
      props: { src: "", fit: "cover", radius: 0, alt: "" },
    }),
    resizableW: true, resizableH: true,
    fields: [
      // Custom field type — implemented in renderField(). Renders a
      // preview + upload button + URL input + clear, and writes the
      // resulting data: URL (or external URL) into `src`.
      { key: "src", label: "Source", type: "image" },
      { key: "fit", label: "Fit", type: "select",
        options: ["contain", "cover", "fill"] },
      { key: "radius", label: "Radius", type: "number",
        min: 0, max: 200, step: 1, advanced: true },
      { key: "alt", label: "Alt text", type: "text", advanced: true },
    ],
    render(props) {
      const wrap = el("div", {
        style: {
          width: "100%", height: "100%",
          overflow: "hidden",
          borderRadius: (props.radius || 0) + "px",
          display: "flex", alignItems: "center", justifyContent: "center",
          background: props.src ? "transparent" : hexA(C.muted, 0.06),
          border: props.src ? "none" : `1px dashed ${hexA(C.muted, 0.35)}`,
          boxSizing: "border-box",
        },
      });
      if (props.src) {
        wrap.appendChild(el("img", {
          src: props.src,
          alt: props.alt || "",
          draggable: "false",
          style: {
            width: "100%", height: "100%",
            objectFit: props.fit || "contain",
            display: "block",
            pointerEvents: "none",
            userSelect: "none",
          },
        }));
      } else {
        wrap.appendChild(el("div", {
          text: "No image",
          style: {
            color: C.subtle, fontSize: "11px", fontWeight: "700",
            letterSpacing: "0.08em", textTransform: "uppercase",
          },
        }));
      }
      return wrap;
    },
  },

  svg: {
    name: "SVG",
    defaultBlock: () => ({
      x: 100, y: 180, w: 600, h: 337.5,
      props: { markup: "", fit: "contain", background: "" },
    }),
    resizableW: true, resizableH: true,
    fields: [
      { key: "markup", label: "SVG markup", type: "svg" },
      { key: "fit", label: "Fit", type: "select",
        options: ["contain", "stretch"] },
      { key: "background", label: "Background", type: "color", advanced: true },
    ],
    render(props) {
      const wrap = el("div", {
        style: {
          width: "100%", height: "100%",
          background: props.background || "transparent",
          display: "flex", alignItems: "center", justifyContent: "center",
          overflow: "hidden",
          boxSizing: "border-box",
          borderRadius: "2px",
        },
      });
      const raw = (props.markup || "").trim();
      // Brand-bar SVGs sit exactly on the bottom edge of the canvas. Give
      // them an equivalent CSS background as a rendering fallback so the
      // strip remains visible at every stage scale and outside edit mode
      // (where there is no selection/interaction layer to repaint it).
      const isBrandBar = /viewBox=["']0 0 1200 12["']/.test(raw) &&
        raw.includes("#FF6633") && raw.includes("#F6821F") &&
        raw.includes("#FBAD41");
      if (isBrandBar) {
        wrap.style.background =
          "linear-gradient(90deg, #FF6633 0%, #F6821F 50%, #FBAD41 100%)";
      }
      if (!raw) {
        wrap.style.border = `1px dashed ${hexA(C.muted, 0.35)}`;
        wrap.style.background = hexA(C.muted, 0.06);
        wrap.appendChild(el("div", {
          text: "Paste SVG markup",
          style: {
            color: C.subtle, fontSize: "11px", fontWeight: "700",
            letterSpacing: "0.08em", textTransform: "uppercase",
          },
        }));
        return wrap;
      }
      // Parse & sanitize: drop <script> tags, strip on* attributes, then
      // size the root <svg> to fill the block. The Gadget is a single-user
      // app, but it's cheap to keep pasted markup from running JS.
      let node = null;
      try {
        const tmp = document.createElement("div");
        tmp.innerHTML = raw;
        node = tmp.querySelector("svg");
      } catch (e) {}
      if (!node) {
        wrap.appendChild(el("div", {
          text: "Invalid SVG",
          style: { color: C.orange, fontSize: "12px", fontWeight: "700" },
        }));
        return wrap;
      }
      node.querySelectorAll("script").forEach(s => s.remove());
      const walk = (n) => {
        for (const a of Array.from(n.attributes || [])) {
          if (a.name.toLowerCase().startsWith("on")) n.removeAttribute(a.name);
        }
        for (const c of n.children) walk(c);
      };
      walk(node);
      // Make the SVG fill its box. Preserve aspect ratio by default; the
      // `fit` prop picks between preserveAspectRatio modes.
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
    },
  },

  arrow: {
    name: "Arrow",
    // Arrows live in a full-bleed SVG; x/y are ignored but the endpoints
    // are in props.
    fullBleed: true,
    defaultBlock: () => ({
      x: 0, y: 0,
      props: { x1: 200, y1: 400, x2: 600, y2: 400,
               color: "muted", label: "", dashed: false, width: 2 },
    }),
    fields: [
      { key: "label", label: "Label", type: "text" },
      { key: "color", label: "Color", type: "select",
        options: ["muted", "tangerine", "ruby"] },
      { key: "dashed", label: "Dashed", type: "checkbox" },
      { key: "width", label: "Width", type: "number",
        min: 1, max: 8, step: 0.5, advanced: true },
      { key: "x1", label: "From X", type: "number",
        min: 0, max: 1200, advanced: true },
      { key: "y1", label: "From Y", type: "number",
        min: 0, max: 675, advanced: true },
      { key: "x2", label: "To X",   type: "number",
        min: 0, max: 1200, advanced: true },
      { key: "y2", label: "To Y",   type: "number",
        min: 0, max: 675, advanced: true },
    ],
    render(props) {
      const color = {
        muted: "#747474", tangerine: "#F6821F", ruby: "#FF6633",
      }[props.color || "muted"];
      const svgEl = svg("svg", {
        width: 1200, height: 675, viewBox: "0 0 1200 675",
        style: "position:absolute;left:0;top:0;pointer-events:none;width:1200px;height:675px;",
      });
      const defs = svg("defs");
      const marker = svg("marker", {
        id: "ah-" + Math.random().toString(36).slice(2, 8),
        markerWidth: "10", markerHeight: "10",
        refX: "8", refY: "3", orient: "auto", markerUnits: "strokeWidth",
      }, [svg("path", { d: "M0,0 L0,6 L9,3 z", fill: color })]);
      defs.appendChild(marker);
      svgEl.appendChild(defs);
      const line = svg("line", {
        x1: props.x1, y1: props.y1, x2: props.x2, y2: props.y2,
        stroke: color,
        "stroke-width": String(props.width || 2),
        opacity: "0.85",
        "marker-end": `url(#${marker.getAttribute("id")})`,
        "stroke-linecap": "round",
      });
      if (props.dashed) line.setAttribute("stroke-dasharray", "6 6");
      svgEl.appendChild(line);
      if (props.label) {
        const mx = (props.x1 + props.x2) / 2;
        const my = (props.y1 + props.y2) / 2 - 8;
        const t = svg("text", {
          x: mx, y: my, "text-anchor": "middle",
          fill: color, "font-size": "12", "font-weight": "800",
          "font-family": FONT, "letter-spacing": "0.02em",
        });
        t.textContent = props.label;
        svgEl.appendChild(t);
      }
      return svgEl;
    },
  },
};

/* Component types shown in the library (in order). The brand marks
 * (gadgetsMark, logo) are kept in COMPONENTS so the seed deck still
 * renders, but they're intentionally not exposed as reusable building
 * blocks. */
const PALETTE_ORDER = [
  "title", "subtitle", "text", "bulletList", "sectionLabel",
  "card", "box",
  "image", "svg",
  "divider", "shape", "arrow",
];

/* Library grouping & descriptions — drive the right-sidebar component
 * library. Adding a new component requires (a) an entry in COMPONENTS,
 * (b) a slot in PALETTE_ORDER, (c) a category here, (d) a description
 * and an icon. */
const COMPONENT_CATEGORIES = [
  { name: "Text",       types: ["title", "subtitle", "text", "bulletList", "sectionLabel"] },
  { name: "Containers", types: ["card", "box"] },
  { name: "Media",      types: ["image", "svg"] },
  { name: "Decoration", types: ["tonePill", "divider", "shape"] },
  { name: "Diagram",    types: ["arrow"] },
];

const COMP_DESC = {
  title:        "Display headline",
  subtitle:     "Supporting copy",
  text:         "Free-form text",
  bulletList:   "Corporate bullet list",
  sectionLabel: "Section eyebrow",
  card:         "Tonal card",
  box:          "Diagram block",
  image:        "Uploaded picture",
  svg:          "Pasted SVG markup",
  tonePill:     "Inline pill",
  divider:      "Horizontal rule",
  shape:        "Rect or ellipse",
  arrow:        "Connector",
};

/* Tiny monochrome icons used in the library + selected-block header.
 * 14×14, currentColor-stroked so they pick up hover state. */
const COMP_ICON = {
  title:        `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M2.5 4h11M8 4v9"/></svg>`,
  subtitle:     `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 6.5h8M8 6.5v5.5"/></svg>`,
  text:         `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M3 5h10M3 8h10M3 11h6"/></svg>`,
  bulletList:   `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="3" cy="4.5" r=".8" fill="currentColor" stroke="none"/><circle cx="3" cy="8" r=".8" fill="currentColor" stroke="none"/><circle cx="3" cy="11.5" r=".8" fill="currentColor" stroke="none"/><path d="M6 4.5h7M6 8h7M6 11.5h7"/></svg>`,
  sectionLabel: `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="3.5" cy="8" r="0.9" fill="currentColor" stroke="none"/><path d="M6.5 8h7"/></svg>`,
  card:         `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><rect x="2.5" y="2.5" width="11" height="11" rx="1.8"/><path d="M2.5 6h11"/></svg>`,
  box:          `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-dasharray="2 1.6"><rect x="2.5" y="3.5" width="11" height="9" rx="1.5"/></svg>`,
  tonePill:     `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="1.5" y="5.5" width="13" height="5" rx="2.5"/></svg>`,
  divider:      `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M2 8h12"/></svg>`,
  shape:        `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="8" cy="8" r="5"/></svg>`,
  arrow:        `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 8h10"/><path d="M9 4.5 12.5 8 9 11.5"/></svg>`,
  image:        `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><rect x="2" y="3" width="12" height="10" rx="1.5"/><circle cx="6" cy="7" r="1.2"/><path d="m2.5 12 3.5-3 3 2.5 2-1.5 2.5 2"/></svg>`,
  svg:          `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4.5 2.5 8 6 11.5"/><path d="M10 4.5 13.5 8 10 11.5"/></svg>`,
};

const COVER_ORANGE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 675"><defs><linearGradient id="b" x2="1" y2="1"><stop stop-color="#ff5115"/><stop offset=".56" stop-color="#ff861f"/><stop offset="1" stop-color="#ffc02c"/></linearGradient><linearGradient id="a" x2="1" y2=".8"><stop stop-color="#ff5a16"/><stop offset="1" stop-color="#ffad25"/></linearGradient></defs><rect width="1200" height="675" fill="url(#b)"/><path d="M-42-50C374-81 699-4 886 185c171 172 157 399-13 490H0V0z" fill="#ff5a17" opacity=".64"/><path d="M7 675C126 389 380 208 694 198c256-8 427 90 506 169v308z" fill="url(#a)" opacity=".66"/><path d="M1199 98c-29 282-237 494-518 558-192 44-413 37-675 19" fill="none" stroke="#ffbe20" stroke-width="2.2" opacity=".92"/></svg>`;
const COVER_ORANGE_URL = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(COVER_ORANGE_SVG)}`;

/* Bottom brand bar: left→right Ruby → Tangerine → Mango gradient. */
const BOTTOM_BAR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 12" preserveAspectRatio="none"><defs><linearGradient id="cfbar"><stop stop-color="#FF6633"/><stop offset=".5" stop-color="#F6821F"/><stop offset="1" stop-color="#FBAD41"/></linearGradient></defs><rect width="1200" height="12" fill="url(#cfbar)"/></svg>`;

/* =====================================================================
 *  Slide templates
 *  -------------------------------------------------------------------
 *  Two ready-made slide layouts, both on the 1200×675 canvas:
 *
 *   - makeTitleSlide()   → the orange full-bleed COVER (title + subtitle
 *                          + white horizontal logo). Used for the deck's
 *                          opening slide.
 *   - makeContentSlide() → a white BASIC content slide following the
 *                          branded corporate shell: accent eyebrow,
 *                          black headline, dark horizontal logo upper-right,
 *                          a one-column body, and the bottom brand bar.
 *
 *  Both are plain `{ background, blocks }` objects with no ids — the
 *  server mints ids for every block on insert. `addSlide(template)` deep-
 *  clones and inserts one; the two footer buttons call these. Everything
 *  they produce is a normal editable block, so users can tweak freely.
 * ===================================================================== */
function makeTitleSlide() {
  return {
    background: { color: "#F6821F", inset: false, coverOrange: true },
    blocks: [
      { type: "logo", x: 36, y: 56, w: 267, props: {} },
      { type: "title", x: 33, y: 197, w: 687,
        props: { text: "[TITLE]", fontSize: 58, weight: 700,
          color: "#FFFFFF", letterSpacing: "-0.03em",
          lineHeight: 1.1, highlight: "" } },
      { type: "subtitle", x: 36, y: 533, w: 553,
        props: { text: "[SUBTITLE]", fontSize: 17, weight: 600,
          color: "#FFFFFF", lineHeight: 1.5 } },
    ],
  };
}

function makeContentSlide() {
  return {
    background: { color: "#FFFFFF", inset: false, dotGrid: 0 },
    blocks: [
      { type: "sectionLabel", x: 36, y: 35, props: { text: "SECTION" } },
      { type: "title", x: 35, y: 76, w: 984,
        props: { text: "Write the headline as a specific assertion",
          fontSize: 28, weight: 600, color: "#000000",
          letterSpacing: "-0.03em", lineHeight: 1.2, highlight: "" } },
      { type: "logo", x: 1013, y: 40,
        props: { variant: "dark", scale: 0.62 } },
      { type: "text", x: 36, y: 204, w: 760,
        props: { text: "Replace this with one or two short paragraphs of supporting evidence. Keep body copy to roughly 40–60 words and leave generous white space on the right.",
          fontSize: 19, weight: "400", color: "#000000",
          family: "sans", align: "left", lineHeight: 1.6 } },
      { type: "svg", x: 0, y: 663, w: 1200, h: 12,
        props: { markup: BOTTOM_BAR_SVG, fit: "stretch", background: "" } },
    ],
  };
}

// Compliance-first content structures. These use exact reference-canvas
// geometry so authors start from the corporate grid instead of freehand
// cards. Every element remains an ordinary editable block.
function makeTwoColumnSlide() {
  const slide = makeContentSlide();
  slide.blocks = slide.blocks.filter(b => b.type !== "text");
  for (const x of [36, 609]) {
    slide.blocks.splice(-1, 0,
      { type: "text", x, y: 204, w: 553,
        props: { text: "Column heading", fontSize: 18, weight: 600,
          color: "#000000", family: "sans", align: "left", lineHeight: 1.3 } },
      { type: "text", x, y: 252, w: 553,
        props: { text: "Add concise supporting copy. Keep both columns parallel in structure and similar in length.",
          fontSize: 19, weight: 400, color: "#000000", family: "sans",
          align: "left", lineHeight: 1.6 } });
  }
  return slide;
}

function makeFourColumnSlide() {
  const slide = makeContentSlide();
  slide.blocks = slide.blocks.filter(b => b.type !== "text");
  [34, 328, 622, 916].forEach((x, i) => {
    slide.blocks.splice(-1, 0,
      { type: "text", x, y: 194, w: 40,
        props: { text: String(i + 1).padStart(2, "0"), fontSize: 14,
          weight: 600, color: "#FF6633", family: "sans", align: "left", lineHeight: 1.2 } },
      { type: "text", x, y: 228, w: 260,
        props: { text: "Column heading", fontSize: 16, weight: 600,
          color: "#000000", family: "sans", align: "left", lineHeight: 1.3 } },
      { type: "text", x, y: 272, w: 260,
        props: { text: "Use compact supporting copy with one clear idea per column.",
          fontSize: 15, weight: 400, color: "#747474", family: "sans",
          align: "left", lineHeight: 1.5 } });
  });
  return slide;
}

/* Dot grid background. */
function DotGrid(opacity = 0.42) {
  return el("div", {
    style: {
      position: "absolute", inset: "0",
      opacity: String(opacity),
      backgroundImage: "radial-gradient(circle, #fff7ef 1.5px, transparent 1.5px)",
      backgroundSize: "38px 36px",
      backgroundPosition: "30px 18px",
      pointerEvents: "none",
    },
  });
}

/* ====================== Slide rendering ================================== */

function currentSlide() {
  return deck.slides[currentIndex] || null;
}

/* ----- Slide text extraction (for filter + row labels) -----------------
 *
 * We walk every block's props and grab any string values. Used by the
 * left-sidebar slide search (so typing matches any text in any block),
 * and by `slideLabel()` to surface the most representative line under
 * each thumbnail row. */
function slideText(slide) {
  const parts = [];
  for (const b of (slide.blocks || [])) {
    const p = b.props || {};
    for (const k in p) {
      const v = p[k];
      if (typeof v === "string" && v.trim()) parts.push(v);
    }
  }
  return parts.join(" ").toLowerCase();
}

/* Best-effort one-line label for a slide row. Priority: first non-empty
 * title → subtitle → text → sectionLabel → "Untitled". */
function slideLabel(slide) {
  const priority = ["title", "subtitle", "text", "sectionLabel"];
  for (const type of priority) {
    for (const b of (slide.blocks || [])) {
      if (b.type !== type) continue;
      const t = (b.props?.text || "").trim();
      if (t) return t.replace(/\s+/g, " ");
    }
  }
  // Fall back to any text we can find.
  for (const b of (slide.blocks || [])) {
    const t = (b.props?.text || b.props?.title || "").trim();
    if (t) return t.replace(/\s+/g, " ");
  }
  return "Untitled";
}

function filteredSlideIndices() {
  const q = slideSearch.trim().toLowerCase();
  if (!q) return deck.slides.map((_, i) => i);
  return deck.slides
    .map((s, i) => (slideText(s).includes(q) ? i : -1))
    .filter(i => i >= 0);
}

function renderSlide(slide) {
  const frame = el("div", {
    class: "slide-frame",
    style: {
      position: "relative", overflow: "hidden",
      width: "1200px", height: "675px",
      background: (slide.background && slide.background.color) || C.page,
      fontFamily: FONT, color: C.text,
    },
  });
  if (slide.background && slide.background.coverOrange) {
    frame.appendChild(el("div", {
      style: {
        position: "absolute", inset: "0",
        backgroundImage: `url("${COVER_ORANGE_URL}")`,
        backgroundSize: "cover", backgroundPosition: "center",
        pointerEvents: "none",
      },
    }));
  }
  if (!slide.background || slide.background.inset !== false) {
    frame.appendChild(el("div", {
      style: {
        position: "absolute", inset: "16px",
        borderRadius: "16px",
        background: C.surface,
        border: `1px solid ${C.borderLight}`,
        pointerEvents: "none",
      },
    }));
  }
  if (slide.background && slide.background.dotGrid) {
    frame.appendChild(DotGrid(slide.background.dotGrid));
  }
  for (const block of slide.blocks) {
    const wrap = renderBlock(slide, block);
    if (wrap) frame.appendChild(wrap);
  }
  // Click on bare slide area deselects.
  if (editMode) {
    frame.addEventListener("pointerdown", (e) => {
      if (e.target === frame ||
          (e.target.classList && e.target.classList.contains("slide-bg-hit"))) {
        selectBlock(null);
      }
    });
    // The inset surface acts as background; mark it as hit target.
    const insetChild = frame.children[0];
    if (insetChild) insetChild.classList.add("slide-bg-hit");
  }
  return frame;
}

function renderBlock(slide, block) {
  const def = COMPONENTS[block.type];
  if (!def) {
    return el("div", {
      style: {
        position: "absolute", left: (block.x || 0) + "px",
        top: (block.y || 0) + "px",
        padding: "6px 10px", color: "#fff", background: "#b00",
        borderRadius: "4px", fontSize: "12px",
      },
      text: `?: ${block.type}`,
    });
  }

  const ctx = {
    block,
    inlineText: (elem, propKey, transform) =>
      bindInlineText(elem, slide, block, propKey, transform),
  };

  // Full-bleed blocks (arrow) render their own absolutely-positioned content.
  if (def.fullBleed) {
    const content = def.render(block.props || {}, ctx);
    if (editMode) {
      // CRITICAL: a full-bleed SVG covers the entire 1200×675 stage. We
      // must NOT make the SVG itself pointer-clickable, or it will eat
      // clicks meant for blocks rendered earlier in the DOM (titles,
      // text, etc). Instead, keep the SVG transparent to clicks and add
      // an invisible wide hit-line on top of the visible graphics.
      content.style.pointerEvents = "none";
      const onSelect = (e) => {
        e.stopPropagation();
        selectBlock(block.id);
      };
      if (block.type === "arrow") {
        const p = block.props || {};
        const hit = svg("line", {
          x1: p.x1, y1: p.y1, x2: p.x2, y2: p.y2,
          stroke: "transparent",
          "stroke-width": "18",
          "stroke-linecap": "round",
          style: "cursor:pointer;pointer-events:stroke;",
        });
        hit.addEventListener("pointerdown", onSelect);
        content.appendChild(hit);
      }
      // Any visible <line>/<text> inside the bleed should also be hit
      // targets, for components other than arrow that might use bleed.
      for (const node of content.querySelectorAll("text")) {
        node.style.pointerEvents = "auto";
        node.style.cursor = "pointer";
        node.addEventListener("pointerdown", onSelect);
      }
      if (block.id === selectedBlockId) {
        // Show endpoint handles
        const handles = renderArrowHandles(slide, block);
        const layer = el("div", { style: {
          position: "absolute", left: 0, top: 0,
          width: "1200px", height: "675px", pointerEvents: "none",
        }});
        layer.appendChild(content);
        for (const h of handles) layer.appendChild(h);
        return layer;
      }
    }
    return content;
  }

  // Regular positioned wrapper.
  const wrap = el("div", {
    style: {
      position: "absolute",
      left: (block.x ?? 0) + "px",
      top: (block.y ?? 0) + "px",
      ...(block.w != null ? { width: block.w + "px" } : {}),
      ...(block.h != null ? { height: block.h + "px" } : {}),
      boxSizing: "border-box",
    },
  });
  wrap.dataset.blockId = block.id;
  const content = def.render(block.props || {}, ctx);
  wrap.appendChild(content);

  if (editMode) {
    wrap.style.cursor = "move";
    attachBlockInteractions(wrap, slide, block, def);
    if (block.id === selectedBlockId) {
      wrap.style.outline = `2px solid ${C.orange}`;
      wrap.style.outlineOffset = "2px";
      wrap.style.zIndex = "5";
      if (def.resizableW || def.resizableH) addResizeHandle(wrap, slide, block, def);
    } else {
      wrap.addEventListener("mouseenter", () => {
        if (block.id !== selectedBlockId)
          wrap.style.outline = `1px dashed ${hexA(C.orange, 0.55)}`;
      });
      wrap.addEventListener("mouseleave", () => {
        if (block.id !== selectedBlockId) wrap.style.outline = "none";
      });
    }
  }
  return wrap;
}

/* Bind an element as inline-editable text.
 *
 * Two states inside edit mode:
 *   - Block NOT selected: text renders as static. Clicks bubble up so the
 *     wrap can select the block (one click to select).
 *   - Block selected: text becomes contentEditable. Clicks stop propagation
 *     so they don't restart a drag, and focus opens the caret.
 *
 * (This two-click pattern matches Figma/Keynote and avoids re-rendering
 * the editable mid-focus.)
 */
function bindInlineText(elem, slide, block, propKey, transform) {
  const raw = (block.props || {})[propKey] ?? "";
  const isSelected = block.id === selectedBlockId;
  if (editMode && isSelected) {
    elem.contentEditable = "plaintext-only";
    elem.spellcheck = false;
    elem.textContent = raw;
    elem.style.outline = "none";
    elem.style.cursor = "text";
    elem.addEventListener("pointerdown", (e) => e.stopPropagation());
    elem.addEventListener("focus", () => {
      elem.style.outline = `1px dashed ${hexA(C.orange, 0.55)}`;
      elem.style.outlineOffset = "2px";
    });
    elem.addEventListener("blur", async () => {
      elem.style.outline = "none";
      const v = elem.innerText.replace(/\u00A0/g, " ");
      if (v === raw) return;
      block.props = { ...(block.props || {}), [propKey]: v };
      await gadget.updateBlock(slide.id, block.id, { props: { [propKey]: v } });
      render();
    });
    elem.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); elem.blur(); }
    });
  } else {
    if (transform) elem.innerHTML = transform(raw);
    else elem.textContent = raw;
  }
  return elem;
}

/* ====================== Block interactions =============================== */

/* Snap distance in slide coords. The viewport is scaled, so this is the
 * threshold *before* scaling — at typical zoom it lands around 5-8px on
 * screen, which feels like a gentle assist rather than a hard grid. */
const SNAP_THRESHOLD = 6;

/* Click-to-select + drag-to-move.
 *
 * We deliberately do NOT call selectBlock on pointerdown — that would
 * re-render the wrap and orphan the live drag. Instead: tracking starts
 * on pointerdown, position is mutated visually during pointermove without
 * any re-render, and on pointerup we (a) save the new position if the
 * user actually dragged, and (b) select the block if they only clicked.
 *
 * Dragging also computes alignment snaps against every other block's
 * edges and centers (plus the slide bounds + center). When within
 * SNAP_THRESHOLD of a target, the position locks to it and a subtle
 * orange guide line is drawn. Hold Alt/Option to disable snapping.
 */
function attachBlockInteractions(wrap, slide, block, def) {
  wrap.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    // Clicks inside contentEditable text are handled by the text element.
    if (e.target.isContentEditable) return;
    e.stopPropagation();

    const startX = e.clientX, startY = e.clientY;
    const origX = block.x ?? 0, origY = block.y ?? 0;
    // Measure block size once at drag start. For blocks without explicit
    // w/h (titles, pills, etc.) we fall back to the rendered offset, which
    // gives us accurate edges & centers for snap math.
    const bw = block.w ?? wrap.offsetWidth;
    const bh = block.h ?? wrap.offsetHeight;
    // Snap targets are static for the duration of the drag — gather once.
    const targets = computeSnapTargets(slide, block);
    const wasSelected = block.id === selectedBlockId;
    let dragged = false;

    const onMove = (ev) => {
      const dx = (ev.clientX - startX) / stageScale;
      const dy = (ev.clientY - startY) / stageScale;
      if (!dragged && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) dragged = true;
      if (!dragged) return;
      let nx = Math.round(origX + dx);
      let ny = Math.round(origY + dy);

      // Alt/Option temporarily disables snap so the user can always nudge
      // a block one pixel off a guide.
      let guidesV = [], guidesH = [];
      if (!ev.altKey) {
        const snap = applySnap(nx, ny, bw, bh, targets);
        nx = snap.x; ny = snap.y;
        guidesV = snap.guidesV; guidesH = snap.guidesH;
      }
      drawSnapGuides(wrap.parentElement, guidesV, guidesH);

      wrap.style.left = nx + "px";
      wrap.style.top  = ny + "px";
      block.x = nx; block.y = ny;
      updateInspectorPositionFields(block);
    };
    const onUp = async () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      clearSnapGuides();
      if (dragged) {
        await gadget.updateBlock(slide.id, block.id,
          { x: block.x, y: block.y });
        if (!wasSelected) selectBlock(block.id);
        // If already selected, no re-render needed — position is already
        // applied. The broadcast will arrive and idempotently re-render.
      } else if (!wasSelected) {
        selectBlock(block.id);
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });
}

/* Collect snap candidates from every other block on the slide, plus the
 * slide bounds + center. Returns lists of vertical lines (x values) and
 * horizontal lines (y values). We skip the block being dragged, and skip
 * full-bleed blocks (arrows) which don't have a meaningful bounding box. */
function computeSnapTargets(slide, draggingBlock) {
  const verts = [], horiz = [];
  // Slide bounds and center — useful for centering things on the canvas.
  verts.push(0, 600, 1200);
  horiz.push(0, 337.5, 675);

  for (const b of slide.blocks) {
    if (b.id === draggingBlock.id) continue;
    const bdef = COMPONENTS[b.type];
    if (!bdef || bdef.fullBleed) continue;
    const node = stageRef.el?.querySelector(`[data-block-id="${b.id}"]`);
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

/* Given a proposed (nx, ny) and the dragged block size, find the nearest
 * snap on each axis within SNAP_THRESHOLD. Returns the adjusted position
 * plus the guide lines (in slide coords) that should be drawn to visualize
 * the snap. We snap each axis independently so the user can pick up a
 * horizontal alignment without losing free movement vertically. */
function applySnap(nx, ny, bw, bh, targets) {
  // Candidates on the dragged block, paired with the offset needed to
  // express the result as a top-left coordinate.
  const xCands = [
    { pos: nx,           offset: 0 },
    { pos: nx + bw / 2,  offset: -bw / 2 },
    { pos: nx + bw,      offset: -bw },
  ];
  const yCands = [
    { pos: ny,           offset: 0 },
    { pos: ny + bh / 2,  offset: -bh / 2 },
    { pos: ny + bh,      offset: -bh },
  ];

  let bestX = null;
  for (const c of xCands) {
    for (const t of targets.verts) {
      const d = Math.abs(t - c.pos);
      if (d <= SNAP_THRESHOLD && (!bestX || d < bestX.d)) {
        bestX = { d, x: t + c.offset, guide: t };
      }
    }
  }
  let bestY = null;
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
    guidesH: bestY ? [bestY.guide] : [],
  };
}

/* Draw alignment guide lines on the slide frame. We render into a tagged
 * layer so we can clear it cheaply without disturbing the rest of the
 * slide. The layer is positioned inside the 1200×675 frame (NOT the
 * scaled stage), so guide coordinates are in slide units. */
function drawSnapGuides(frame, xs, ys) {
  if (!frame) return;
  let layer = frame.querySelector('[data-snap-layer]');
  if (!layer) {
    layer = el("div", {
      "data-snap-layer": "1",
      style: {
        position: "absolute", inset: "0",
        pointerEvents: "none",
        zIndex: "100",
      },
    });
    frame.appendChild(layer);
  }
  layer.innerHTML = "";
  for (const x of xs) {
    layer.appendChild(el("div", {
      style: {
        position: "absolute",
        left: x + "px", top: "0",
        width: "1px", height: "675px",
        marginLeft: "-0.5px",
        background: C.orange,
        opacity: "0.9",
      },
    }));
  }
  for (const y of ys) {
    layer.appendChild(el("div", {
      style: {
        position: "absolute",
        left: "0", top: y + "px",
        width: "1200px", height: "1px",
        marginTop: "-0.5px",
        background: C.orange,
        opacity: "0.9",
      },
    }));
  }
}

function clearSnapGuides() {
  const layer = stageRef.el?.querySelector('[data-snap-layer]');
  if (layer) layer.remove();
}

/* Bottom-right corner resize handle. */
function addResizeHandle(wrap, slide, block, def) {
  const handle = el("div", {
    style: {
      position: "absolute", right: "-6px", bottom: "-6px",
      width: "12px", height: "12px",
      background: "#fff", border: `2px solid ${C.orange}`,
      borderRadius: "3px", cursor: "nwse-resize",
      zIndex: "10",
    },
  });
  handle.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    const startX = e.clientX, startY = e.clientY;
    const origW = block.w ?? wrap.offsetWidth;
    const origH = block.h ?? wrap.offsetHeight;
    const onMove = (ev) => {
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
      const patch = {};
      if (def.resizableW) patch.w = block.w;
      if (def.resizableH) patch.h = block.h;
      await gadget.updateBlock(slide.id, block.id, patch);
      render();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });
  wrap.appendChild(handle);
}

/* Endpoint handles for an arrow block. */
function renderArrowHandles(slide, block) {
  const handles = [];
  for (const which of ["1", "2"]) {
    const x = block.props["x" + which], y = block.props["y" + which];
    const h = el("div", {
      style: {
        position: "absolute",
        left: (x - 7) + "px", top: (y - 7) + "px",
        width: "14px", height: "14px",
        background: "#fff", border: `2px solid ${C.orange}`,
        borderRadius: "50%", cursor: "grab",
        pointerEvents: "auto", zIndex: "8",
      },
    });
    h.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      if (e.button !== 0) return;
      h.style.cursor = "grabbing";
      const startX = e.clientX, startY = e.clientY;
      const ox = x, oy = y;
      const onMove = (ev) => {
        const nx = Math.round(ox + (ev.clientX - startX) / stageScale);
        const ny = Math.round(oy + (ev.clientY - startY) / stageScale);
        block.props["x" + which] = nx;
        block.props["y" + which] = ny;
        render();
      };
      const onUp = async () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        await gadget.updateBlock(slide.id, block.id, {
          props: {
            ["x" + which]: block.props["x" + which],
            ["y" + which]: block.props["y" + which],
          },
        });
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });
    handles.push(h);
  }
  return handles;
}

/* ====================== Selection ======================================== */

function selectBlock(id) {
  if (selectedBlockId === id) return;
  selectedBlockId = id;
  render();
  renderInspector();
}

/* ====================== Inspector ========================================
 *
 * Right-sidebar layout (top to bottom):
 *
 *   1. Component library — a contained, filterable card. Searches by name,
 *      groups by category. Always visible since adding is the primary
 *      action; constrained to a max-height so it never dominates.
 *   2. Slide section — compact background settings for the current slide.
 *   3. Selected block inspector — header (icon + name), schema fields,
 *      icon-row actions, advanced disclosure. Or, when nothing is
 *      selected, a quiet empty hint.
 *
 * Inputs use shared `.field-*` CSS classes defined in mountShell, so
 * hover/focus states feel consistent without per-element listeners.
 * ----------------------------------------------------------------------- */

function renderInspector() {
  const panel = shellRef.inspectorBody;
  if (!panel) return;
  panel.innerHTML = "";

  panel.appendChild(renderComponentLibrary());

  const slide = currentSlide();
  if (slide) panel.appendChild(renderSlideSection(slide));

  const block = slide && slide.blocks.find(b => b.id === selectedBlockId);
  if (block) {
    const def = COMPONENTS[block.type];
    panel.appendChild(renderSelectedBlock(slide, block, def));
  } else {
    panel.appendChild(renderEmptyHint());
  }
}

/* ---- Section helpers --------------------------------------------------- */

function sectionLabel(text, extra) {
  const row = el("div", {
    style: {
      display: "flex", alignItems: "center",
      padding: "0 4px 8px",
      fontSize: "10px", fontWeight: "750",
      letterSpacing: "0.1em", textTransform: "uppercase",
      color: "#7b6254",
    },
  });
  row.appendChild(el("span", { text }));
  if (extra) {
    extra.style.marginLeft = "auto";
    row.appendChild(extra);
  }
  return row;
}

function sectionBlock(children, opts = {}) {
  return el("div", {
    style: {
      padding: opts.padding || "18px 16px 0",
      borderTop: opts.border ? "1px solid rgba(255,245,232,0.05)" : "none",
      marginTop: opts.border ? "18px" : "0",
    },
  }, children);
}

/* ---- Component library ------------------------------------------------- */

function renderComponentLibrary() {
  const wrap = el("div", { style: { padding: "14px 12px 6px" }});
  const card = el("div", {
    style: {
      background: "rgba(255,245,232,0.025)",
      border: "1px solid rgba(255,245,232,0.06)",
      borderRadius: "12px",
      overflow: "hidden",
      display: "flex", flexDirection: "column",
    },
  });

  // --- Search row (also the section's visual title) ---
  const search = el("div", {
    style: {
      display: "flex", alignItems: "center", gap: "8px",
      padding: "9px 12px",
      borderBottom: "1px solid rgba(255,245,232,0.05)",
    },
  });
  search.appendChild(svgFromString(
    `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#8a7164" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20.5 20.5-4.3-4.3"/></svg>`));
  const input = el("input", {
    type: "text",
    placeholder: "Add component",
    value: librarySearch,
    style: {
      flex: "1",
      background: "transparent",
      border: "none", outline: "none",
      color: "#fff5e8",
      fontSize: "12px", fontFamily: FONT,
      padding: "0", letterSpacing: "0",
    },
    oninput: (e) => {
      librarySearch = e.target.value;
      refreshLibraryList();
    },
    onkeydown: (e) => {
      e.stopPropagation();
      if (e.key === "Escape") {
        if (librarySearch) {
          librarySearch = "";
          e.target.value = "";
          refreshLibraryList();
        } else {
          e.target.blur();
        }
      } else if (e.key === "Enter") {
        // Add first match
        const matches = filteredComponents();
        if (matches.length > 0) {
          librarySearch = "";
          addBlockOfType(matches[0]);
        }
      }
    },
  });
  search.appendChild(input);
  // Clear button is always present; we toggle opacity/pointer-events so we
  // never need to re-render the search row mid-typing (which would steal
  // focus from the input).
  const clear = el("button", {
    title: "Clear",
    "aria-label": "Clear search",
    "data-press": "1",
    "data-library-clear": "1",
    onclick: () => {
      librarySearch = "";
      input.value = "";
      input.focus();
      refreshLibraryList();
    },
    style: {
      background: "transparent", border: "none",
      padding: "2px", margin: "0",
      color: "#8a7164", cursor: "pointer",
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      borderRadius: "4px",
      opacity: librarySearch ? "1" : "0",
      pointerEvents: librarySearch ? "auto" : "none",
      transition:
        "color 140ms var(--ease), background 140ms var(--ease), opacity 140ms var(--ease)",
    },
  });
  clear.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M6 18 18 6"/></svg>`;
  clear.addEventListener("mouseenter", () => {
    clear.style.color = "#fff5e8";
    clear.style.background = "rgba(255,245,232,0.08)";
  });
  clear.addEventListener("mouseleave", () => {
    clear.style.color = "#8a7164";
    clear.style.background = "transparent";
  });
  search.appendChild(clear);
  card.appendChild(search);

  // --- Scrollable list ---
  const list = el("div", {
    style: {
      maxHeight: "280px",
      overflowY: "auto",
      padding: "4px 0 6px",
    },
  });
  list.dataset.libraryList = "1";
  populateLibraryList(list);
  card.appendChild(list);

  wrap.appendChild(card);
  return wrap;
}

function filteredComponents() {
  const q = librarySearch.trim().toLowerCase();
  if (!q) return PALETTE_ORDER.slice();
  return PALETTE_ORDER.filter(t => {
    const def = COMPONENTS[t];
    const name = (def?.name || "").toLowerCase();
    const desc = (COMP_DESC[t] || "").toLowerCase();
    return name.includes(q) || desc.includes(q) || t.toLowerCase().includes(q);
  });
}

function populateLibraryList(list) {
  list.innerHTML = "";
  const matches = filteredComponents();
  if (matches.length === 0) {
    list.appendChild(el("div", {
      text: "No matches",
      style: {
        padding: "18px", textAlign: "center",
        color: "#7b6254", fontSize: "11.5px",
      },
    }));
    return;
  }

  if (librarySearch) {
    // Flat list when searching — keeps results dense.
    for (const t of matches) list.appendChild(libraryItem(t));
  } else {
    for (const cat of COMPONENT_CATEGORIES) {
      const types = cat.types.filter(t => matches.includes(t));
      if (types.length === 0) continue;
      list.appendChild(el("div", {
        text: cat.name,
        style: {
          padding: "10px 14px 4px",
          fontSize: "9.5px", fontWeight: "800",
          letterSpacing: "0.12em", textTransform: "uppercase",
          color: "#6e5747",
        },
      }));
      for (const t of types) list.appendChild(libraryItem(t));
    }
  }
}

/* Surgically replace just the list children when typing — avoids
 * re-rendering the whole inspector and stealing focus from the input. */
function refreshLibraryList() {
  const list = shellRef.inspectorBody?.querySelector('[data-library-list="1"]');
  if (!list) return;
  populateLibraryList(list);
  const clear = shellRef.inspectorBody?.querySelector('[data-library-clear="1"]');
  if (clear) {
    clear.style.opacity = librarySearch ? "1" : "0";
    clear.style.pointerEvents = librarySearch ? "auto" : "none";
  }
}

function libraryItem(type) {
  const def = COMPONENTS[type];
  const item = el("button", {
    "data-press": "1",
    title: `Add ${def.name}`,
    onclick: () => {
      if (librarySearch) librarySearch = "";
      addBlockOfType(type);
    },
    style: {
      display: "flex", alignItems: "center", gap: "10px",
      width: "100%",
      padding: "7px 12px",
      background: "transparent",
      color: "#e8d6c2",
      border: "none",
      cursor: "pointer",
      fontFamily: FONT, textAlign: "left",
      transition: "background 140ms var(--ease), color 140ms var(--ease)",
    },
  });
  const iconWrap = el("div", {
    style: {
      width: "22px", height: "22px", flex: "0 0 22px",
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      borderRadius: "5px",
      background: "rgba(255,245,232,0.05)",
      color: "#b89e87",
      transition: "background 140ms var(--ease), color 140ms var(--ease)",
    },
  });
  iconWrap.innerHTML = COMP_ICON[type] || "";
  item.appendChild(iconWrap);
  item.appendChild(el("div", {
    style: { flex: "1", minWidth: "0",
             display: "flex", flexDirection: "column", gap: "1px" },
  }, [
    el("div", {
      text: def.name,
      style: {
        fontSize: "12px", fontWeight: "600",
        lineHeight: "1.2",
        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
      },
    }),
    el("div", {
      text: COMP_DESC[type] || "",
      style: {
        fontSize: "10.5px", color: "#7b6254",
        lineHeight: "1.2",
        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
      },
    }),
  ]));
  const plus = el("span", {
    html: `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`,
    style: {
      color: "#8a7164",
      display: "inline-flex",
      opacity: "0",
      transform: "translateX(-2px)",
      transition: "opacity 140ms var(--ease), transform 140ms var(--ease), color 140ms var(--ease)",
    },
  });
  item.appendChild(plus);
  item.addEventListener("mouseenter", () => {
    item.style.background = "rgba(255,245,232,0.06)";
    iconWrap.style.background = hexA(C.orange, 0.18);
    iconWrap.style.color = "#ffb18d";
    plus.style.opacity = "1";
    plus.style.transform = "translateX(0)";
    plus.style.color = "#ffb18d";
  });
  item.addEventListener("mouseleave", () => {
    item.style.background = "transparent";
    iconWrap.style.background = "rgba(255,245,232,0.05)";
    iconWrap.style.color = "#b89e87";
    plus.style.opacity = "0";
    plus.style.transform = "translateX(-2px)";
    plus.style.color = "#8a7164";
  });
  return item;
}

/* ---- Slide section ----------------------------------------------------- */

function renderSlideSection(slide) {
  const wrap = sectionBlock([
    sectionLabel("Slide"),
    el("div", { style: { display: "flex", flexDirection: "column", gap: "4px" }}, [
      colorField("Page color", slide.background?.color || C.page, async (v) => {
        slide.background = { ...slide.background, color: v };
        await gadget.updateSlide(slide.id, { background: { color: v } });
        render();
      }),
      numberField("Dot grid", slide.background?.dotGrid ?? 0, async (v) => {
        slide.background = { ...slide.background, dotGrid: v };
        await gadget.updateSlide(slide.id, { background: { dotGrid: v } });
        render();
      }, { min: 0, max: 1, step: 0.05 }),
      checkField("Inset surface", slide.background?.inset !== false, async (v) => {
        slide.background = { ...slide.background, inset: v };
        await gadget.updateSlide(slide.id, { background: { inset: v } });
        render();
      }),
    ]),
  ], { padding: "18px 16px 6px" });
  return wrap;
}

/* ---- Selected block inspector ----------------------------------------- */

function renderSelectedBlock(slide, block, def) {
  const wrap = sectionBlock([], { border: true, padding: "16px 16px 18px" });

  // --- Header: icon + name + small "selected" caption ---
  const header = el("div", {
    style: {
      display: "flex", alignItems: "center", gap: "10px",
      marginBottom: "14px",
    },
  });
  const ico = el("div", {
    style: {
      width: "26px", height: "26px",
      borderRadius: "6px",
      background: hexA(C.orange, 0.16),
      color: "#ffb18d",
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      flex: "0 0 26px",
    },
  });
  ico.innerHTML = COMP_ICON[block.type] || COMP_ICON.shape;
  header.appendChild(ico);
  header.appendChild(el("div", {
    style: { display: "flex", flexDirection: "column", minWidth: "0" },
  }, [
    el("div", {
      text: def?.name || block.type,
      style: {
        fontSize: "12.5px", fontWeight: "650", color: "#fff5e8",
        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
      },
    }),
    el("div", {
      text: "Selected",
      style: {
        fontSize: "10px", fontWeight: "700",
        color: "#7b6254", marginTop: "1px",
        letterSpacing: "0.06em", textTransform: "uppercase",
      },
    }),
  ]));
  wrap.appendChild(header);

  // --- Basic schema fields ---
  const basicFields  = (def?.fields || []).filter(f => !f.advanced);
  const advancedFields = (def?.fields || []).filter(f => f.advanced);

  // Effective-prop defaults for this component. Blocks may omit props
  // entirely (e.g. seed-deck subtitles only carry `text`); the render
  // functions fall back via `props.fontSize || 19`, so the inspector
  // should mirror that and surface the same effective value rather than
  // showing 0 / "" for a missing prop. Without this, editing one of
  // those seed blocks looks like "Font size is 0".
  const propDefaults = (def?.defaultBlock ? (def.defaultBlock().props || {}) : {});

  if (basicFields.length > 0) {
    const fieldsWrap = el("div", { style: { display: "flex",
      flexDirection: "column", gap: "4px" }});
    for (const f of basicFields) {
      const v = (block.props || {})[f.key] ?? propDefaults[f.key];
      const cb = (nv) => patchBlockProp(slide, block, f.key, nv);
      fieldsWrap.appendChild(renderField(f, v, cb));
    }
    wrap.appendChild(fieldsWrap);
  }

  // --- Compact icon-row actions ---
  wrap.appendChild(renderBlockActions(slide, block));

  // --- Advanced disclosure ---
  const hasAdvanced = !def?.fullBleed || advancedFields.length > 0;
  if (hasAdvanced) {
    wrap.appendChild(renderAdvancedDisclosure(slide, block, def, advancedFields));
  }
  return wrap;
}

function renderBlockActions(slide, block) {
  const actions = el("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "repeat(4, 1fr)",
      gap: "4px",
      marginTop: "12px",
    },
  });
  const dup = compactIconBtn(
    `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
    "Duplicate", async () => {
      const copy = JSON.parse(JSON.stringify(block));
      delete copy.id;
      copy.x = (copy.x ?? 0) + 24;
      copy.y = (copy.y ?? 0) + 24;
      const newId = await gadget.addBlock(slide.id, copy);
      slide.blocks.push({ ...copy, id: newId });
      selectedBlockId = newId;
      render(); renderInspector();
    });
  const fwd = compactIconBtn(
    `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>`,
    "Bring forward", async () => {
      const i = slide.blocks.findIndex(b => b.id === block.id);
      if (i < slide.blocks.length - 1) {
        const [b] = slide.blocks.splice(i, 1);
        slide.blocks.splice(i + 1, 0, b);
        await gadget.reorderBlock(slide.id, block.id, i + 1);
        render();
      }
    });
  const bwd = compactIconBtn(
    `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="m5 12 7 7 7-7"/></svg>`,
    "Send backward", async () => {
      const i = slide.blocks.findIndex(b => b.id === block.id);
      if (i > 0) {
        const [b] = slide.blocks.splice(i, 1);
        slide.blocks.splice(i - 1, 0, b);
        await gadget.reorderBlock(slide.id, block.id, i - 1);
        render();
      }
    });
  const del = compactIconBtn(
    `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`,
    "Delete", async () => {
      slide.blocks = slide.blocks.filter(b => b.id !== block.id);
      selectedBlockId = null;
      await gadget.removeBlock(slide.id, block.id);
      render(); renderInspector();
    }, { danger: true });

  actions.appendChild(dup);
  actions.appendChild(fwd);
  actions.appendChild(bwd);
  actions.appendChild(del);
  return actions;
}

function renderAdvancedDisclosure(slide, block, def, advancedFields) {
  const wrap = el("div", { style: { marginTop: "14px" }});
  const toggle = el("button", {
    "data-press": "1",
    onclick: () => { advancedOpen = !advancedOpen; renderInspector(); },
    style: {
      width: "100%",
      display: "inline-flex", alignItems: "center", gap: "6px",
      padding: "8px 0",
      background: "transparent",
      color: "#8a7164",
      border: "none",
      borderTop: "1px solid rgba(255,245,232,0.05)",
      borderRadius: "0",
      cursor: "pointer",
      fontSize: "10px", fontWeight: "750",
      letterSpacing: "0.1em", textTransform: "uppercase",
      fontFamily: FONT,
      transition: "color 160ms var(--ease)",
    },
  });
  const chev = el("span", {
    html: `<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>`,
    style: {
      display: "inline-flex",
      transform: advancedOpen ? "rotate(90deg)" : "rotate(0deg)",
      transition: "transform 200ms var(--ease)",
    },
  });
  toggle.appendChild(chev);
  toggle.appendChild(el("span", { text: "Advanced" }));
  toggle.addEventListener("mouseenter", () => toggle.style.color = "#c8b39c");
  toggle.addEventListener("mouseleave", () => toggle.style.color = "#8a7164");
  wrap.appendChild(toggle);

  if (!advancedOpen) return wrap;

  const body = el("div", {
    style: {
      display: "flex", flexDirection: "column", gap: "4px",
      paddingTop: "8px",
    },
  });

  if (!def?.fullBleed) {
    const grid = el("div", {
      style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px" },
    });
    grid.appendChild(numberField("X", block.x ?? 0,
      v => patchBlock(slide, block, {x: v}),
      { min: -100, max: 1300 }, { dataKey: "pos-x" }));
    grid.appendChild(numberField("Y", block.y ?? 0,
      v => patchBlock(slide, block, {y: v}),
      { min: -100, max: 800 }, { dataKey: "pos-y" }));
    if (def?.resizableW || block.w != null)
      grid.appendChild(numberField("W", block.w ?? 0,
        v => patchBlock(slide, block, {w: v}),
        { min: 10, max: 1300 }, { dataKey: "pos-w" }));
    if (def?.resizableH || block.h != null)
      grid.appendChild(numberField("H", block.h ?? 0,
        v => patchBlock(slide, block, {h: v}),
        { min: 10, max: 800 }, { dataKey: "pos-h" }));
    body.appendChild(grid);
  }

  const propDefaults = (def?.defaultBlock ? (def.defaultBlock().props || {}) : {});
  for (const f of advancedFields) {
    const v = (block.props || {})[f.key] ?? propDefaults[f.key];
    const cb = (nv) => patchBlockProp(slide, block, f.key, nv);
    body.appendChild(renderField(f, v, cb));
  }

  wrap.appendChild(body);
  return wrap;
}

function renderEmptyHint() {
  const wrap = sectionBlock([], { border: true, padding: "28px 20px 36px" });
  wrap.style.display = "flex";
  wrap.style.flexDirection = "column";
  wrap.style.alignItems = "center";
  wrap.style.gap = "10px";
  wrap.style.textAlign = "center";
  const ico = el("div", {
    style: {
      width: "30px", height: "30px",
      borderRadius: "7px",
      background: "rgba(255,245,232,0.04)",
      color: "#7b6254",
      display: "inline-flex", alignItems: "center", justifyContent: "center",
    },
    html: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>`,
  });
  wrap.appendChild(ico);
  wrap.appendChild(el("div", {
    text: "Nothing selected",
    style: { fontSize: "12px", fontWeight: "600", color: "#c8b39c" },
  }));
  wrap.appendChild(el("div", {
    text: "Click any block on the slide to inspect its properties.",
    style: {
      fontSize: "11px", color: "#7b6254",
      lineHeight: "1.5", maxWidth: "200px",
    },
  }));
  return wrap;
}

async function patchBlock(slide, block, patch) {
  Object.assign(block, patch);
  await gadget.updateBlock(slide.id, block.id, patch);
  render();
}
async function patchBlockProp(slide, block, key, value) {
  block.props = { ...(block.props || {}), [key]: value };
  await gadget.updateBlock(slide.id, block.id, { props: { [key]: value } });
  render();
}

/* Update inspector x/y/w/h while dragging without a full re-render. */
function updateInspectorPositionFields(block) {
  if (!shellRef.inspectorBody) return;
  for (const [k, dk] of [["x", "pos-x"], ["y", "pos-y"],
                          ["w", "pos-w"], ["h", "pos-h"]]) {
    const input = shellRef.inspectorBody.querySelector(`input[data-key="${dk}"]`);
    if (input) input.value = String(block[k] ?? 0);
  }
}

/* ----------- Inspector field widgets -----------
 *
 * All fields share a horizontal layout: small uppercase label on the
 * left, control on the right (multiline + color stack vertically since
 * their controls need full width). Inputs use shared CSS classes
 * defined in mountShell so hover/focus states are consistent without
 * per-element listeners. */

function fieldRow(label, control, opts = {}) {
  if (opts.stacked) {
    return el("div", { style: { padding: "4px 0" }}, [
      el("div", {
        text: label,
        style: {
          fontSize: "10px", fontWeight: "650",
          color: "#9a8273", marginBottom: "6px",
          letterSpacing: "0.04em", textTransform: "uppercase",
        },
      }),
      control,
    ]);
  }
  return el("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "78px 1fr",
      alignItems: "center",
      gap: "10px",
      minHeight: "28px",
      padding: "1px 0",
    },
  }, [
    el("label", {
      text: label,
      style: {
        fontSize: "11px", fontWeight: "500",
        color: "#9a8273", lineHeight: "1.2",
        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
      },
    }),
    control,
  ]);
}
function renderField(f, v, cb) {
  switch (f.type) {
    case "multiline":  return multilineField(f.label, v ?? "", cb);
    case "number":     return numberField(f.label, v ?? 0, cb, f);
    case "select":     return selectField(f.label, v, cb, f.options);
    case "checkbox":   return checkField(f.label, !!v, cb);
    case "color":      return colorField(f.label, v ?? "#000000", cb);
    case "image":      return imageField(f.label, v ?? "", cb);
    case "svg":        return svgField(f.label, v ?? "", cb);
    case "text":
    default:           return textField(f.label, v ?? "", cb);
  }
}
function textField(label, value, cb) {
  const input = el("input", {
    type: "text", value,
    class: "field-input",
    onblur: (e) => { if (e.target.value !== value) cb(e.target.value); },
    onkeydown: (e) => {
      e.stopPropagation();
      if (e.key === "Enter") e.target.blur();
    },
  });
  return fieldRow(label, input);
}
function multilineField(label, value, cb) {
  const ta = el("textarea", {
    class: "field-input field-textarea",
    onblur: (e) => { if (e.target.value !== value) cb(e.target.value); },
    onkeydown: (e) => e.stopPropagation(),
  });
  ta.value = value;
  return fieldRow(label, ta, { stacked: true });
}
function numberField(label, value, cb, opts = {}, attrs = {}) {
  const input = el("input", {
    type: "number", value, step: opts.step ?? 1,
    min: opts.min, max: opts.max,
    "data-key": attrs.dataKey || "",
    class: "field-input",
    onchange: (e) => {
      const n = Number(e.target.value);
      if (!Number.isNaN(n) && n !== value) cb(n);
    },
    onkeydown: (e) => e.stopPropagation(),
  });
  return fieldRow(label, input);
}
function selectField(label, value, cb, options) {
  const sel = el("select", {
    class: "field-input field-select",
    onchange: (e) => cb(e.target.value),
    onkeydown: (e) => e.stopPropagation(),
  });
  for (const o of options) {
    const opt = el("option", { value: o, text: o });
    if (o === value) opt.selected = true;
    sel.appendChild(opt);
  }
  return fieldRow(label, sel);
}
function checkField(label, value, cb) {
  const cbox = el("input", {
    type: "checkbox",
    class: "field-check",
    onchange: (e) => cb(e.target.checked),
  });
  cbox.checked = !!value;
  return fieldRow(label, el("div", {
    style: { display: "inline-flex", alignItems: "center" },
  }, [cbox]));
}
function colorField(label, value, cb) {
  const wrap = el("div", {
    style: { display: "flex", gap: "6px", alignItems: "stretch" },
  });
  const swatchWrap = el("div", {
    style: {
      width: "26px", height: "26px",
      borderRadius: "6px",
      position: "relative", flex: "0 0 26px",
      background: value,
      border: "1px solid rgba(255,245,232,0.10)",
      cursor: "pointer",
    },
  });
  // The native <input type="color"> control is hard to style; we use it
  // strictly for its picker UX and lay our swatch on top via opacity: 0.
  const sw = el("input", {
    type: "color", value,
    style: {
      position: "absolute", inset: "0",
      width: "100%", height: "100%",
      padding: "0", border: "none", background: "transparent",
      cursor: "pointer", opacity: "0",
    },
    onchange: (e) => { swatchWrap.style.background = e.target.value; cb(e.target.value); },
    oninput:  (e) => { swatchWrap.style.background = e.target.value; },
  });
  swatchWrap.appendChild(sw);
  const tx = el("input", {
    type: "text", value,
    class: "field-input",
    style: { flex: "1", fontVariantNumeric: "tabular-nums" },
    onblur: (e) => { if (e.target.value !== value) cb(e.target.value); },
    onkeydown: (e) => {
      e.stopPropagation();
      if (e.key === "Enter") e.target.blur();
    },
  });
  wrap.appendChild(swatchWrap); wrap.appendChild(tx);
  return fieldRow(label, wrap);
}
/* ---- Image field ------------------------------------------------------
 *
 * Custom widget for the `image` component's `src` prop. Stacks:
 *
 *   [   thumbnail preview / placeholder   ]
 *   [ Upload ]  [ Clear ]
 *   [ url text input ......................]
 *
 * Uploaded files are read as data URLs and, if they're raster images
 * larger than `MAX_IMAGE_DIM`, automatically downscaled via canvas so we
 * don't bloat the deck JSON document. SVG files are passed through as-is.
 * External URLs are accepted via the text input — the browser will load
 * them through the normal <img> path (which is allowed in the sandbox).
 */
const MAX_IMAGE_DIM       = 1600;
const IMAGE_DOWNSCALE_MIN = 400_000;  // bytes — below this we keep the original

async function readFileAsDataURL(file) {
  return await new Promise((res, rej) => {
    const r = new FileReader();
    r.onload  = () => res(r.result);
    r.onerror = () => rej(r.error || new Error("read failed"));
    r.readAsDataURL(file);
  });
}

async function loadImage(src) {
  return await new Promise((res, rej) => {
    const img = new Image();
    img.onload  = () => res(img);
    img.onerror = () => rej(new Error("decode failed"));
    img.src = src;
  });
}

/* Convert a File to a data URL, downscaling raster images larger than
 * MAX_IMAGE_DIM on the longest side. SVG goes through verbatim. */
async function fileToImageDataURL(file) {
  if (file.type === "image/svg+xml") return await readFileAsDataURL(file);
  const original = await readFileAsDataURL(file);
  let img;
  try { img = await loadImage(original); }
  catch { return original; }
  const longest = Math.max(img.naturalWidth, img.naturalHeight);
  if (longest <= MAX_IMAGE_DIM && file.size < IMAGE_DOWNSCALE_MIN) return original;
  const scale = Math.min(1, MAX_IMAGE_DIM / longest);
  const canvas = document.createElement("canvas");
  canvas.width  = Math.max(1, Math.round(img.naturalWidth  * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  // PNGs preserve transparency; everything else goes to JPEG at 0.85.
  const isPng = file.type === "image/png";
  try {
    return canvas.toDataURL(isPng ? "image/png" : "image/jpeg",
      isPng ? undefined : 0.85);
  } catch { return original; }
}

function imageField(label, value, cb) {
  // Wrap cb so that any change also refreshes the inspector. The image
  // field has visible state in its own UI (preview + size label +
  // upload/clear visibility) so a slide-only re-render isn't enough.
  const apply = async (v) => {
    await cb(v);
    renderInspector();
  };
  const wrap = el("div", {
    style: { display: "flex", flexDirection: "column", gap: "6px" },
  });

  // --- Preview tile -----------------------------------------------------
  const preview = el("div", {
    style: {
      width: "100%", aspectRatio: "16 / 9",
      borderRadius: "7px",
      background: hexA(C.muted, 0.06),
      border: `1px solid rgba(255,245,232,0.08)`,
      backgroundImage:
        "linear-gradient(45deg, rgba(255,255,255,0.025) 25%, transparent 25%, transparent 75%, rgba(255,255,255,0.025) 75%)," +
        "linear-gradient(45deg, rgba(255,255,255,0.025) 25%, transparent 25%, transparent 75%, rgba(255,255,255,0.025) 75%)",
      backgroundSize: "16px 16px",
      backgroundPosition: "0 0, 8px 8px",
      display: "flex", alignItems: "center", justifyContent: "center",
      overflow: "hidden",
    },
  });
  if (value) {
    preview.appendChild(el("img", {
      src: value, alt: "", draggable: "false",
      style: { width: "100%", height: "100%",
               objectFit: "contain", display: "block" },
    }));
  } else {
    preview.appendChild(el("div", {
      text: "No image",
      style: { color: "#7b6254", fontSize: "10.5px", fontWeight: "700",
               letterSpacing: "0.08em", textTransform: "uppercase" },
    }));
  }

  // --- Buttons ---------------------------------------------------------
  const btnRow = el("div", { style: {
    display: "grid", gridTemplateColumns: value ? "1fr 1fr" : "1fr",
    gap: "4px",
  }});
  const fileInput = el("input", {
    type: "file",
    accept: "image/*",
    style: { display: "none" },
    onchange: async (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      try {
        const url = await fileToImageDataURL(f);
        await apply(url);
      } catch (err) {
        statusEl.textContent = "Couldn't read that file.";
        statusEl.style.color = "#ffb18d";
      }
      e.target.value = "";  // allow re-uploading the same file
    },
  });
  const upload = compactIconBtn(
    `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`,
    value ? "Replace image" : "Upload image",
    () => fileInput.click());
  // The compactIconBtn renders as icon-only; force a label inside it so the
  // image field reads better at the inspector's narrow width.
  upload.innerHTML = "";
  upload.appendChild(svgFromString(
    `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`));
  upload.appendChild(el("span", {
    text: value ? "Replace" : "Upload",
    style: { marginLeft: "8px", fontSize: "11.5px", fontWeight: "600",
             letterSpacing: "0.02em" },
  }));
  btnRow.appendChild(upload);
  btnRow.appendChild(fileInput);
  if (value) {
    const clear = compactIconBtn("", "Clear image", () => apply(""), { danger: true });
    clear.innerHTML = "";
    clear.appendChild(svgFromString(
      `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M6 18 18 6"/></svg>`));
    clear.appendChild(el("span", {
      text: "Clear",
      style: { marginLeft: "8px", fontSize: "11.5px", fontWeight: "600" },
    }));
    btnRow.appendChild(clear);
  }

  // --- URL input -------------------------------------------------------
  const urlInput = el("input", {
    type: "text",
    placeholder: "or paste image URL / data:URI",
    value: value && value.startsWith("data:") ? "" : value,
    class: "field-input",
    onblur: (e) => {
      const v = e.target.value.trim();
      if (v !== value) apply(v);
    },
    onkeydown: (e) => {
      e.stopPropagation();
      if (e.key === "Enter") e.target.blur();
    },
  });

  const statusEl = el("div", {
    style: { fontSize: "10.5px", color: "#7b6254",
             lineHeight: "1.4", minHeight: "0" },
  });
  if (value && value.startsWith("data:")) {
    // Approx byte count of base64 payload, sans header.
    const i = value.indexOf(",");
    const bytes = i >= 0 ? Math.round(((value.length - i - 1) * 3) / 4) : 0;
    if (bytes > 0) {
      statusEl.textContent = `Inlined • ${formatBytes(bytes)}`;
    }
  }

  wrap.appendChild(preview);
  wrap.appendChild(btnRow);
  wrap.appendChild(urlInput);
  if (statusEl.textContent) wrap.appendChild(statusEl);
  return fieldRow(label, wrap, { stacked: true });
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/* ---- SVG field --------------------------------------------------------
 *
 * Big monospace textarea for pasting raw SVG markup. We don't try to
 * validate here — `svg` component's render() does the parsing and shows
 * an "Invalid SVG" placeholder on the slide if it can't parse. */
function svgField(label, value, cb) {
  const ta = el("textarea", {
    class: "field-input field-textarea",
    placeholder: '<svg width="..." height="..." viewBox="...">...</svg>',
    spellcheck: "false",
    style: {
      minHeight: "120px",
      fontFamily: MONO,
      fontSize: "11px",
      lineHeight: "1.45",
      whiteSpace: "pre",
      overflowWrap: "normal",
      overflowX: "auto",
    },
    onblur: (e) => { if (e.target.value !== value) cb(e.target.value); },
    onkeydown: (e) => e.stopPropagation(),
  });
  ta.value = value;
  return fieldRow(label, ta, { stacked: true });
}

function compactIconBtn(iconHtml, title, onClick, opts = {}) {
  const danger = opts.danger;
  const b = el("button", {
    title, "aria-label": title, onclick: onClick,
    "data-press": "1",
    style: {
      width: "100%", height: "30px",
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      background: "rgba(255,245,232,0.04)",
      color: danger ? "#ffb8a0" : "#d8c4ad",
      border: "1px solid transparent",
      borderRadius: "7px",
      cursor: "pointer", padding: "0",
      transition:
        "background 140ms var(--ease), color 140ms var(--ease), border-color 140ms var(--ease)",
    },
  });
  b.innerHTML = iconHtml;
  b.addEventListener("mouseenter", () => {
    b.style.background = danger
      ? "rgba(255,95,46,0.16)"
      : "rgba(255,245,232,0.10)";
    b.style.borderColor = danger
      ? "rgba(255,95,46,0.32)"
      : "rgba(255,245,232,0.10)";
    b.style.color = danger ? "#ffd0bd" : "#fff5e8";
  });
  b.addEventListener("mouseleave", () => {
    b.style.background = "rgba(255,245,232,0.04)";
    b.style.borderColor = "transparent";
    b.style.color = danger ? "#ffb8a0" : "#d8c4ad";
  });
  return b;
}

/* ====================== Clipboard ========================================
 *
 * Copy/cut/paste of a single selected block. The clipboard is in-memory
 * (per-tab) — no cross-deck or cross-tab paste, which keeps the model
 * dead simple. Paste inserts onto the *current* slide (not the one the
 * block was copied from) and offsets the position so the new block is
 * visibly distinct from its source. The pasted block is selected.
 * ----------------------------------------------------------------------- */

function copySelectedBlock() {
  const slide = currentSlide();
  if (!slide || !selectedBlockId) return false;
  const block = slide.blocks.find(b => b.id === selectedBlockId);
  if (!block) return false;
  // Deep clone & strip id — paste mints a new one.
  const clone = JSON.parse(JSON.stringify(block));
  delete clone.id;
  clipboardBlock = clone;
  return true;
}

async function cutSelectedBlock() {
  const slide = currentSlide();
  if (!slide || !selectedBlockId) return;
  if (!copySelectedBlock()) return;
  const blockId = selectedBlockId;
  slide.blocks = slide.blocks.filter(b => b.id !== blockId);
  selectedBlockId = null;
  await gadget.removeBlock(slide.id, blockId);
  render(); renderInspector();
}

async function pasteClipboardBlock() {
  if (!clipboardBlock) return;
  const slide = currentSlide();
  if (!slide) return;
  const copy = JSON.parse(JSON.stringify(clipboardBlock));
  delete copy.id;
  // Nudge so the pasted block doesn't sit perfectly on top of its source.
  // Arrows have x/y=0 (full-bleed); for them, shift the endpoints instead.
  if (copy.type === "arrow" && copy.props) {
    copy.props = { ...copy.props,
      x1: (copy.props.x1 ?? 0) + 24, y1: (copy.props.y1 ?? 0) + 24,
      x2: (copy.props.x2 ?? 0) + 24, y2: (copy.props.y2 ?? 0) + 24,
    };
  } else {
    copy.x = (copy.x ?? 0) + 24;
    copy.y = (copy.y ?? 0) + 24;
  }
  const newId = await gadget.addBlock(slide.id, copy);
  slide.blocks.push({ ...copy, id: newId });
  selectedBlockId = newId;
  render(); renderInspector();
}

async function duplicateSelectedBlock() {
  // Equivalent to copy + paste-to-same-slide, but doesn't disturb the
  // clipboard. Mirrors the inspector's duplicate icon button.
  const slide = currentSlide();
  if (!slide || !selectedBlockId) return;
  const block = slide.blocks.find(b => b.id === selectedBlockId);
  if (!block) return;
  const copy = JSON.parse(JSON.stringify(block));
  delete copy.id;
  if (copy.type === "arrow" && copy.props) {
    copy.props = { ...copy.props,
      x1: (copy.props.x1 ?? 0) + 24, y1: (copy.props.y1 ?? 0) + 24,
      x2: (copy.props.x2 ?? 0) + 24, y2: (copy.props.y2 ?? 0) + 24,
    };
  } else {
    copy.x = (copy.x ?? 0) + 24;
    copy.y = (copy.y ?? 0) + 24;
  }
  const newId = await gadget.addBlock(slide.id, copy);
  slide.blocks.push({ ...copy, id: newId });
  selectedBlockId = newId;
  render(); renderInspector();
}

/* ====================== Undo / redo ======================================
 *
 * The undo stack lives on the server (see #save in server.js). It's a
 * global history for the deck shared across every connected client —
 * pressing undo here rolls back the most recent mutation made by ANY
 * client. This matches how a shared document feels: one timeline that
 * everyone agrees on. Buttons reflect server-reported availability and
 * are updated on every broadcast.
 * ----------------------------------------------------------------------- */

async function doUndo() {
  if (!canUndo) return;
  try { await gadget.undo(); } catch {}
  // The server will broadcast the new deck state (and updated meta) via
  // the Subscriber; no local state changes are needed here.
}

async function doRedo() {
  if (!canRedo) return;
  try { await gadget.redo(); } catch {}
}

function updateUndoButtons() {
  // Undo/redo are an editing concern, so the buttons (and their flanking
  // divider) are hidden entirely outside edit mode. The keyboard
  // shortcuts still work everywhere — they're cheap and harmless.
  const show = editMode;
  if (shellRef.undoDivider) {
    shellRef.undoDivider.style.display = show ? "block" : "none";
  }
  for (const [b, enabled] of [[shellRef.undoBtn, canUndo],
                              [shellRef.redoBtn, canRedo]]) {
    if (!b) continue;
    b.style.display = show ? "inline-flex" : "none";
    b.style.opacity = enabled ? "1" : "0.32";
    b.style.pointerEvents = enabled ? "auto" : "none";
    b.style.cursor = enabled ? "pointer" : "default";
  }
}

/* ====================== Add block ======================================== */

async function addBlockOfType(type) {
  const slide = currentSlide();
  if (!slide) return;
  const def = COMPONENTS[type];
  const base = def.defaultBlock ? def.defaultBlock() : { x: 100, y: 200, props: {} };
  // Offset successive added blocks so they don't stack.
  const sameType = slide.blocks.filter(b => b.type === type).length;
  base.x = (base.x ?? 100) + sameType * 16;
  base.y = (base.y ?? 200) + sameType * 16;
  const block = { type, ...base };
  const id = await gadget.addBlock(slide.id, block);
  block.id = id;
  slide.blocks.push(block);
  selectedBlockId = id;
  render(); renderInspector();
}

/* ====================== Slide ops UI ===================================== */

/* Add a slide after the current one. Pass a template object (e.g.
 * makeTitleSlide() / makeContentSlide()) to seed its layout; omit it for a
 * blank content slide (server's newBlankSlide, which is a cover). */
async function addSlide(template) {
  const seed = template ? JSON.parse(JSON.stringify(template)) : undefined;
  const id = await gadget.addSlide(currentIndex + 1, seed);
  const newDeck = await gadget.getDeck();
  deck = newDeck;
  const i = deck.slides.findIndex(s => s.id === id);
  if (i >= 0) currentIndex = i;
  selectedBlockId = null;
  render(); renderSlideList(); renderInspector(); updateCounter();
}
async function moveSlideTo(fromIndex, toIndex) {
  if (fromIndex === toIndex) return;
  const slide = deck.slides[fromIndex];
  if (!slide) return;
  // Optimistic local update so the list doesn't flicker.
  const [s] = deck.slides.splice(fromIndex, 1);
  deck.slides.splice(toIndex, 0, s);
  if (currentIndex === fromIndex) currentIndex = toIndex;
  else if (fromIndex < currentIndex && toIndex >= currentIndex) currentIndex--;
  else if (fromIndex > currentIndex && toIndex <= currentIndex) currentIndex++;
  await gadget.moveSlide(slide.id, toIndex);
  renderSlideList(); updateCounter();
}

async function duplicateSlideById(slideId) {
  const newId = await gadget.duplicateSlide(slideId);
  deck = await gadget.getDeck();
  const i = deck.slides.findIndex(s => s.id === newId);
  if (i >= 0) currentIndex = i;
  selectedBlockId = null;
  render(); renderSlideList(); renderInspector(); updateCounter();
}

async function removeSlideById(slideId) {
  const wasCurrent = currentSlide()?.id === slideId;
  await gadget.removeSlide(slideId);
  deck = await gadget.getDeck();
  if (wasCurrent) currentIndex = Math.min(currentIndex, deck.slides.length - 1);
  selectedBlockId = null;
  render(); renderSlideList(); renderInspector(); updateCounter();
}

/* ====================== Shell ============================================ */

const ICONS = {
  chevronLeft: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 6 9 12 15 18"/></svg>`,
  chevronRight: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>`,
  pencil: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>`,
  expand: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 9 4 4 9 4"/><polyline points="20 9 20 4 15 4"/><polyline points="4 15 4 20 9 20"/><polyline points="20 15 20 20 15 20"/></svg>`,
  collapse: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 4 9 9 4 9"/><polyline points="15 4 15 9 20 9"/><polyline points="9 20 9 15 4 15"/><polyline points="15 20 15 15 20 15"/></svg>`,
  plus: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
  // Hooked-arrow undo / redo (Lucide `undo-2` / `redo-2`): a horizontal
  // shaft that loops back under itself with the arrowhead pointing the
  // direction of travel. Much more universally legible as undo/redo
  // than the circular "rotate ccw / cw" arrows commonly bundled with
  // icon sets.
  undo: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5 5.5 5.5 0 0 1-5.5 5.5H11"/></svg>`,
  redo: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 14 5-5-5-5"/><path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5 5.5 5.5 0 0 0 9.5 20H13"/></svg>`,
  trash: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>`,
  copy: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
};

function mountShell() {
  document.body.style.margin = "0";
  document.body.style.padding = "0";
  document.body.style.background = "#faf9f7";
  document.body.style.height = "100vh";
  document.body.style.overflow = "hidden";
  document.body.style.fontFamily = FONT;
  document.body.style.color = "#fff5e8";

  // Global stylesheet: easing tokens, scrollbar polish, focus ring reset,
  // shared field control styles.
  const style = document.createElement("style");
  style.textContent = `
    :root {
      --ease: ${EASE};
      --ease-in-out: ${EASE_IN_OUT};
    }
    *, *::before, *::after { box-sizing: border-box; }
    button { font: inherit; -webkit-tap-highlight-color: transparent; }
    button:focus-visible, input:focus-visible, select:focus-visible,
    textarea:focus-visible {
      outline: 2px solid ${hexA(C.orange, 0.55)};
      outline-offset: 1px;
    }
    ::-webkit-scrollbar { width: 8px; height: 8px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb {
      background: rgba(255,245,232,0.08);
      border-radius: 4px;
    }
    ::-webkit-scrollbar-thumb:hover { background: rgba(255,245,232,0.18); }
    /* Slide list rows: subtle press feedback and hover lift. */
    [data-slide-row] {
      transition:
        background 180ms var(--ease),
        border-color 180ms var(--ease),
        transform 120ms var(--ease);
    }
    [data-slide-row]:active { transform: scale(0.985); }
    [data-icon-btn] {
      transition:
        background 160ms var(--ease),
        color 160ms var(--ease),
        transform 100ms var(--ease);
    }
    [data-icon-btn]:active { transform: scale(0.92); }
    [data-press] { transition: transform 120ms var(--ease); }
    [data-press]:active { transform: scale(0.97); }

    /* --- Inspector form controls ------------------------------------ */
    .field-input {
      width: 100%;
      min-width: 0;
      background: rgba(255,245,232,0.04);
      color: #fff5e8;
      border: 1px solid transparent;
      border-radius: 6px;
      padding: 5px 8px;
      font-size: 12px;
      font-family: ${FONT};
      line-height: 1.4;
      outline: none;
      transition:
        background 140ms var(--ease),
        border-color 140ms var(--ease),
        box-shadow 140ms var(--ease);
    }
    .field-input::placeholder { color: #6e5747; }
    .field-input:hover { background: rgba(255,245,232,0.07); }
    .field-input:focus, .field-input:focus-visible {
      background: rgba(20,12,8,0.6);
      border-color: ${hexA(C.orange, 0.45)};
      box-shadow: 0 0 0 3px ${hexA(C.orange, 0.10)};
      outline: none;
    }
    .field-textarea {
      min-height: 64px;
      resize: vertical;
      padding: 7px 8px;
    }
    .field-select {
      appearance: none;
      -webkit-appearance: none;
      padding-right: 24px;
      cursor: pointer;
      background-image: url("data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%239a8273' stroke-width='2.6' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 8px center;
    }
    .field-select option {
      background: #1a1108;
      color: #fff5e8;
    }
    .field-check {
      width: 16px; height: 16px;
      flex: 0 0 16px;
      appearance: none; -webkit-appearance: none;
      margin: 0;
      border: 1px solid rgba(255,245,232,0.22);
      border-radius: 4px;
      background: rgba(255,245,232,0.04);
      cursor: pointer;
      position: relative;
      transition:
        background 140ms var(--ease),
        border-color 140ms var(--ease);
    }
    .field-check:hover {
      background: rgba(255,245,232,0.10);
      border-color: rgba(255,245,232,0.34);
    }
    .field-check:checked {
      background: ${C.orange};
      border-color: ${C.orange};
    }
    .field-check:checked::after {
      content: "";
      position: absolute;
      left: 4.5px; top: 1.5px;
      width: 4px; height: 8px;
      border: solid #fff;
      border-width: 0 1.8px 1.8px 0;
      transform: rotate(45deg);
    }
    /* Hide number input spinners — they look noisy in dark UI. */
    .field-input[type="number"]::-webkit-outer-spin-button,
    .field-input[type="number"]::-webkit-inner-spin-button {
      -webkit-appearance: none; margin: 0;
    }
    .field-input[type="number"] { -moz-appearance: textfield; }

    /* Light editor chrome: the slides are the focus, so edit mode uses
       quiet neutral surfaces instead of heavy black sidebars. */
    #leftPanel, #rightPanel {
      background: rgba(255,255,255,0.97) !important;
      border-color: #e7e5e4 !important;
      color: #292524 !important;
      box-shadow: 0 0 28px rgba(28,25,23,0.05);
    }
    #leftPanel *, #rightPanel * { scrollbar-color: #d6d3d1 transparent; }
    #leftPanel ::-webkit-scrollbar-thumb,
    #rightPanel ::-webkit-scrollbar-thumb { background: #d6d3d1; }
    #leftPanel :is(div, span, label):not(.slide-frame *),
    #rightPanel :is(div, span, label) {
      color: #57534e !important;
    }
    #leftPanel input, #rightPanel input, #rightPanel textarea,
    #rightPanel select {
      color: #292524 !important;
    }
    #leftPanel input::placeholder, #rightPanel input::placeholder,
    #rightPanel textarea::placeholder { color: #a8a29e !important; }
    #leftPanel button, #rightPanel button {
      color: #57534e !important;
    }
    #leftPanel [data-slide-row] { border-color: transparent; }
    #leftPanel [data-slide-row]:hover { background: #f7f5f3 !important; }
    #leftPanel [data-slide-row][data-active="1"] {
      background: #fff7ed !important;
      border-color: #fdba74 !important;
    }
    #leftPanel [data-icon-btn] {
      background: rgba(255,255,255,0.94) !important;
      border-color: #e7e5e4 !important;
      box-shadow: 0 2px 8px rgba(28,25,23,0.10);
    }
    #rightPanel > div > div { border-color: #e7e5e4 !important; }
    #rightPanel button {
      background: #f7f7f6 !important;
      border-color: #efeeec !important;
    }
    #rightPanel button:hover { background: #efeeec !important; }
    #rightPanel .field-input {
      background: #f7f7f6 !important;
      border-color: #e7e5e4 !important;
    }
    #rightPanel .field-input:hover { background: #f1f0ef !important; }
    #rightPanel .field-input:focus {
      background: #fff !important;
      border-color: #fb923c !important;
      box-shadow: 0 0 0 3px rgba(251,146,60,0.14) !important;
    }
    #rightPanel .field-select option { background: #fff; color: #292524; }
    #rightPanel .field-check {
      background: #fff !important;
      border-color: #d6d3d1 !important;
    }
    #rightPanel .field-check:checked {
      background: ${C.orange} !important;
      border-color: ${C.orange} !important;
    }
    #leftPanel button:hover, #rightPanel button:hover {
      background: #f1f0ef !important;
    }
    #leftPanel [aria-label*="Delete"], #rightPanel [aria-label*="Delete"] {
      color: #dc2626 !important;
    }
    .add-slide-menu {
      animation: addMenuIn 150ms var(--ease);
      transform-origin: bottom right;
    }
    @keyframes addMenuIn {
      from { opacity: 0; transform: translateY(5px) scale(.98); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }
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
      #root { display: none !important; }
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
  `;
  document.head.appendChild(style);

  const root = el("div", {
    id: "root",
    style: { position: "fixed", inset: "0", display: "flex" },
  });

  // ---- Left panel (slides) -----------------------------------------
  // Same dark surface + 0.94 alpha as the right panel for cohesion.
  const leftPanel = el("div", {
    id: "leftPanel",
    style: {
      width: "208px", flex: "0 0 208px",
      background: "rgba(20,12,8,0.94)",
      borderRight: "1px solid rgba(255,245,232,0.06)",
      display: "none",
      flexDirection: "column",
    },
  });

  // Search header — same shape as the right-panel library search
  // (icon prefix, fading clear button), but freestanding rather than
  // wrapped in a card since the slides list is the whole left panel.
  leftPanel.appendChild(buildSlideSearchHeader());

  const slideList = el("div", {
    id: "slideList",
    style: { flex: "1", overflowY: "auto",
             padding: "4px 10px 8px", scrollBehavior: "smooth" },
  });
  leftPanel.appendChild(slideList);

  // Footer: one calm default action plus a caret menu for alternate layouts.
  // The primary action creates the standard narrative slide.
  const leftFooter = el("div", {
    style: {
      position: "relative",
      padding: "12px",
      borderTop: "1px solid #e7e5e4",
    },
  });
  const addMenu = el("div", {
    class: "add-slide-menu",
    style: {
      position: "absolute", left: "12px", right: "12px", bottom: "58px",
      display: "none", flexDirection: "column", gap: "2px",
      padding: "6px",
      background: "#ffffff", border: "1px solid #e7e5e4",
      borderRadius: "12px", boxShadow: "0 14px 34px rgba(28,25,23,0.14)",
      zIndex: "20",
    },
  });
  const closeAddMenu = () => { addMenu.style.display = "none"; };
  const addOption = (label, detail, factory) => {
    const option = el("button", {
      "data-press": "1",
      onclick: (e) => {
        e.stopPropagation(); closeAddMenu(); addSlide(factory());
      },
      style: {
        display: "flex", flexDirection: "column", alignItems: "flex-start",
        width: "100%", padding: "9px 10px", border: "none",
        borderRadius: "8px", background: "transparent", cursor: "pointer",
        textAlign: "left", fontFamily: FONT,
      },
    }, [
      el("span", { text: label, style: { fontSize: "12px", fontWeight: "650", color: "#292524" } }),
      el("span", { text: detail, style: { marginTop: "2px", fontSize: "10.5px", color: "#78716c" } }),
    ]);
    addMenu.appendChild(option);
  };
  addOption("Title slide", "Orange cover", makeTitleSlide);
  addOption("Narrative", "Standard content slide", makeContentSlide);
  addOption("Two columns", "Side-by-side comparison", makeTwoColumnSlide);
  addOption("Four columns", "Compact structured overview", makeFourColumnSlide);
  leftFooter.appendChild(addMenu);

  const addControl = el("div", {
    style: {
      display: "grid", gridTemplateColumns: "1fr 38px",
      border: "1px solid #d6d3d1", borderRadius: "10px",
      overflow: "hidden", background: "#ffffff",
      boxShadow: "0 1px 2px rgba(28,25,23,0.05)",
    },
  });
  const addDefault = el("button", {
    "data-press": "1", title: "Add standard slide",
    onclick: () => addSlide(makeContentSlide()),
    style: {
      height: "38px", border: "none", background: "transparent",
      color: "#292524", cursor: "pointer", fontFamily: FONT,
      fontSize: "12px", fontWeight: "650",
      display: "inline-flex", alignItems: "center", justifyContent: "center", gap: "7px",
    },
    html: `${ICONS.plus}<span>Add slide</span>`,
  });
  const caret = el("button", {
    title: "Choose slide layout", "aria-label": "Choose slide layout",
    onclick: (e) => {
      e.stopPropagation();
      addMenu.style.display = addMenu.style.display === "flex" ? "none" : "flex";
    },
    style: {
      height: "38px", border: "none", borderLeft: "1px solid #e7e5e4",
      background: "transparent", color: "#57534e", cursor: "pointer",
      display: "inline-flex", alignItems: "center", justifyContent: "center",
    },
    html: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`,
  });
  addControl.appendChild(addDefault);
  addControl.appendChild(caret);
  leftFooter.appendChild(addControl);
  leftPanel.appendChild(leftFooter);
  document.addEventListener("click", (e) => {
    if (!leftFooter.contains(e.target)) closeAddMenu();
  });
  root.appendChild(leftPanel);

  // ---- Center stage -------------------------------------------------
  const stageWrap = el("div", {
    style: {
      flex: "1", position: "relative", overflow: "hidden",
      background: "radial-gradient(circle at 50% 40%, #ffffff 0%, #f7f5f2 80%)",
    },
  });
  const stage = el("div", {
    id: "stage",
    style: {
      position: "absolute", top: "50%", left: "50%",
      width: "1200px", height: "675px",
      boxShadow: "0 10px 28px rgba(43, 28, 20, 0.14)",
      borderRadius: "18px", overflow: "hidden",
      transformOrigin: "center center",
    },
  });
  stageRef.el = stage; stageRef.wrap = stageWrap;
  stageWrap.appendChild(stage);
  root.appendChild(stageWrap);

  // ---- Right panel (component library + slide + inspector) ---------
  // The inspectorBody owns its own top padding (library card has 14px
  // margin-top), so we don't need a separate header strip.
  const rightPanel = el("div", {
    id: "rightPanel",
    style: {
      width: "284px", flex: "0 0 284px",
      background: "rgba(20,12,8,0.94)",
      borderLeft: "1px solid rgba(255,245,232,0.06)",
      display: "none",
      flexDirection: "column",
    },
  });
  const inspectorBody = el("div", {
    id: "inspectorBody",
    style: { flex: "1", overflowY: "auto", paddingBottom: "32px" },
  });
  rightPanel.appendChild(inspectorBody);
  root.appendChild(rightPanel);

  // ---- Bottom floating control bar ---------------------------------
  const bar = el("div", {
    id: "controls",
    style: {
      position: "absolute",
      left: "50%", bottom: "22px",
      transform: "translateX(-50%)",
      display: "flex", alignItems: "center", gap: "4px",
      padding: "6px",
      background: "rgba(20, 12, 8, 0.72)",
      border: "1px solid rgba(255, 245, 232, 0.08)",
      borderRadius: "999px",
      backdropFilter: "blur(14px) saturate(140%)",
      WebkitBackdropFilter: "blur(14px) saturate(140%)",
      boxShadow: "0 12px 36px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.04)",
      zIndex: "10", fontFamily: FONT,
    },
  });

  const iconBtn = ({ icon, title, onClick, variant = "ghost", size = 38 }) => {
    const b = el("button", {
      title, "aria-label": title, onclick: onClick,
      "data-icon-btn": "1",
      style: {
        width: size + "px", height: size + "px",
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        background: variant === "accent" ? C.orange : "transparent",
        color: variant === "accent" ? "#fff" : "#f5e7d6",
        border: "none", borderRadius: "999px", cursor: "pointer", padding: "0",
      },
    });
    b.innerHTML = icon;
    b.dataset.variant = variant;
    b.addEventListener("mouseenter", () => {
      b.style.background = b.dataset.variant === "accent"
        ? C.orangeDark : "rgba(255,245,232,0.08)";
    });
    b.addEventListener("mouseleave", () => {
      b.style.background = b.dataset.variant === "accent" ? C.orange : "transparent";
    });
    return b;
  };

  const prev = iconBtn({ icon: ICONS.chevronLeft, title: "Previous slide (←)",
    onClick: () => go(currentIndex - 1) });
  const next = iconBtn({ icon: ICONS.chevronRight, title: "Next slide (→)",
    onClick: () => go(currentIndex + 1) });

  const counter = el("button", {
    title: "Jump to slide",
    "data-press": "1",
    style: {
      minWidth: "78px", height: "38px", padding: "0 14px",
      background: "transparent", color: "#fff5e8",
      border: "none", borderRadius: "999px",
      fontSize: "13px", fontWeight: "700",
      fontVariantNumeric: "tabular-nums", letterSpacing: "0.02em",
      cursor: "pointer", fontFamily: FONT,
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      transition: "background 160ms var(--ease)",
    },
    onclick: (e) => { e.stopPropagation(); toggleJumpMenu(); },
  });
  counter.addEventListener("mouseenter", () =>
    counter.style.background = "rgba(255,245,232,0.08)");
  counter.addEventListener("mouseleave", () =>
    counter.style.background = "transparent");

  const divider = () => el("div", {
    style: { width: "1px", height: "22px", margin: "0 6px",
             background: "rgba(255,245,232,0.12)" },
  });

  const undoBtn = iconBtn({ icon: ICONS.undo, title: "Undo (⌘Z)",
    onClick: doUndo });
  const redoBtn = iconBtn({ icon: ICONS.redo, title: "Redo (⇧⌘Z)",
    onClick: doRedo });
  const editBtn = iconBtn({ icon: ICONS.pencil, title: "Edit (E)",
    onClick: toggleEdit });
  const fsBtn = iconBtn({ icon: ICONS.expand, title: "Present (F)",
    onClick: togglePresent });

  // The divider on the trailing side of the undo/redo pair is captured
  // so we can hide it alongside the buttons when not in edit mode.
  const undoDivider = divider();
  bar.appendChild(prev);
  bar.appendChild(counter);
  bar.appendChild(next);
  bar.appendChild(divider());
  bar.appendChild(undoBtn);
  bar.appendChild(redoBtn);
  bar.appendChild(undoDivider);
  bar.appendChild(editBtn);
  bar.appendChild(fsBtn);
  stageWrap.appendChild(bar);

  // Floating exit-present button.
  const exitBtn = el("button", {
    title: "Exit presentation (Esc / F)",
    "aria-label": "Exit presentation",
    "data-icon-btn": "1",
    onclick: togglePresent,
    style: {
      position: "absolute", top: "16px", right: "16px",
      width: "38px", height: "38px",
      display: "none",
      alignItems: "center", justifyContent: "center",
      background: "rgba(20,12,8,0.55)", color: "#f5e7d6",
      border: "1px solid rgba(255,245,232,0.10)",
      borderRadius: "999px", cursor: "pointer", padding: "0",
      backdropFilter: "blur(14px) saturate(140%)",
      WebkitBackdropFilter: "blur(14px) saturate(140%)",
      opacity: "0",
      transition: "opacity 180ms var(--ease), background 160ms var(--ease)",
      zIndex: "12",
    },
  });
  exitBtn.innerHTML = ICONS.collapse;
  exitBtn.addEventListener("mouseenter", () => exitBtn.style.opacity = "1");
  exitBtn.addEventListener("mouseleave", () => exitBtn.style.opacity = "0");
  stageWrap.appendChild(exitBtn);

  // Jump menu (number grid)
  const jumpMenu = el("div", {
    id: "jumpMenu",
    style: {
      position: "absolute", left: "50%", bottom: "78px",
      transform: "translateX(-50%)",
      display: "none",
      gridTemplateColumns: "repeat(6, 38px)",
      gap: "6px", padding: "10px",
      background: "rgba(20,12,8,0.92)",
      border: "1px solid rgba(255,245,232,0.10)",
      borderRadius: "14px",
      backdropFilter: "blur(14px) saturate(140%)",
      WebkitBackdropFilter: "blur(14px) saturate(140%)",
      boxShadow: "0 16px 40px rgba(0,0,0,0.5)",
      zIndex: "11",
    },
  });
  stageWrap.appendChild(jumpMenu);
  document.addEventListener("click", (e) => {
    if (jumpMenu.style.display !== "none" &&
        !jumpMenu.contains(e.target) && e.target !== counter) {
      jumpMenu.style.display = "none";
    }
  });

  shellRef.root = root;
  shellRef.leftPanel = leftPanel;
  shellRef.rightPanel = rightPanel;
  shellRef.inspectorBody = inspectorBody;
  shellRef.slideList = slideList;
  shellRef.counter = counter;
  shellRef.bar = bar;
  shellRef.exitBtn = exitBtn;
  shellRef.jumpMenu = jumpMenu;
  shellRef.editBtn = editBtn;
  shellRef.fsBtn = fsBtn;
  shellRef.undoBtn = undoBtn;
  shellRef.redoBtn = redoBtn;
  shellRef.undoDivider = undoDivider;
  updateUndoButtons();

  const printDeck = el("div", { id: "printDeck", "data-print-root": "slides" });
  shellRef.printDeck = printDeck;
  document.body.appendChild(root);
  document.body.appendChild(printDeck);

  const fit = () => {
    const w = stageWrap.clientWidth;
    const h = stageWrap.clientHeight;
    if (!w || !h) return;
    if (presenting) {
      stageScale = Math.min(w / 1200, h / 675);
      stage.style.transform = `translate(-50%, -50%) scale(${stageScale})`;
      stage.style.borderRadius = "0";
      stage.style.boxShadow = "none";
    } else {
      stageScale = Math.min((w - 48) / 1200, (h - 120) / 675);
      stage.style.transform = `translate(-50%, -50%) scale(${stageScale})`;
      stage.style.borderRadius = "18px";
      stage.style.boxShadow = "0 10px 28px rgba(43, 28, 20, 0.14)";
    }
  };
  shellRef.fit = fit;
  window.addEventListener("resize", fit);
  setTimeout(fit, 0);

  // Keyboard
  document.addEventListener("keydown", (e) => {
    if (e.target && (e.target.isContentEditable ||
        e.target.tagName === "INPUT" ||
        e.target.tagName === "TEXTAREA" ||
        e.target.tagName === "SELECT")) return;
    const mod = e.metaKey || e.ctrlKey;
    // Undo / redo work outside edit mode too (you might still want to
    // roll back a stray change), so check these before the edit-only
    // clipboard handlers below.
    if (mod && !e.altKey && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) doRedo(); else doUndo();
      return;
    }
    if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "y") {
      // Windows-style redo.
      e.preventDefault(); doRedo(); return;
    }
    // Clipboard shortcuts (edit mode only). Handled before the bare-key
    // branches so Ctrl+C / Cmd+C never get swallowed by the "f"/"e"
    // toggles below.
    if (editMode && mod && !e.shiftKey && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === "c") {
        if (selectedBlockId) { e.preventDefault(); copySelectedBlock(); }
        return;
      }
      if (k === "x") {
        if (selectedBlockId) { e.preventDefault(); cutSelectedBlock(); }
        return;
      }
      if (k === "v") {
        if (clipboardBlock) { e.preventDefault(); pasteClipboardBlock(); }
        return;
      }
      if (k === "d") {
        if (selectedBlockId) { e.preventDefault(); duplicateSelectedBlock(); }
        return;
      }
    }
    if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ")
      { e.preventDefault(); go(currentIndex + 1); }
    else if (e.key === "ArrowLeft" || e.key === "PageUp")
      { e.preventDefault(); go(currentIndex - 1); }
    else if (e.key === "Home") go(0);
    else if (e.key === "End")  go(deck.slides.length - 1);
    else if (e.key === "e" || e.key === "E") toggleEdit();
    else if (e.key === "f" || e.key === "F") togglePresent();
    else if ((e.key === "Delete" || e.key === "Backspace") &&
             editMode && selectedBlockId) {
      e.preventDefault();
      const slide = currentSlide();
      const block = slide && slide.blocks.find(b => b.id === selectedBlockId);
      if (block) {
        slide.blocks = slide.blocks.filter(b => b.id !== block.id);
        selectedBlockId = null;
        gadget.removeBlock(slide.id, block.id);
        render(); renderInspector();
      }
    } else if (e.key === "Escape") {
      if (jumpMenu.style.display === "grid") jumpMenu.style.display = "none";
      else if (selectedBlockId) selectBlock(null);
      else if (presenting) togglePresent();
    }
  });
}

/* Render a slide at a small fixed width by scaling its full-fidelity DOM.
 * We render with `editMode` forced off so the thumbnail never shows
 * selection outlines or contentEditable affordances. */
function renderSlideThumbnail(slide, width = 156) {
  const prevEdit = editMode, prevSel = selectedBlockId;
  editMode = false; selectedBlockId = null;
  let frame;
  try { frame = renderSlide(slide); }
  finally { editMode = prevEdit; selectedBlockId = prevSel; }
  const scale = width / 1200;
  const height = 675 * scale;
  const container = el("div", {
    style: {
      width: width + "px", height: height + "px",
      borderRadius: "6px", overflow: "hidden",
      background: (slide.background && slide.background.color) || C.page,
      position: "relative", pointerEvents: "none",
      boxShadow: "0 1px 0 rgba(0,0,0,0.4), inset 0 0 0 1px rgba(255,245,232,0.04)",
    },
  });
  frame.style.transform = `scale(${scale})`;
  frame.style.transformOrigin = "0 0";
  frame.style.flex = "none";
  container.appendChild(frame);
  return container;
}

/* Tiny per-row action button (duplicate / delete) revealed on row hover. */
function thumbActionBtn(iconHtml, title, onClick, danger = false) {
  const b = el("button", {
    title, "aria-label": title,
    "data-icon-btn": "1",
    onclick: onClick,
    style: {
      width: "22px", height: "22px", padding: "0",
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      background: "rgba(20,12,8,0.78)",
      color: danger ? "#ffb8a0" : "#f5e7d6",
      border: "1px solid rgba(255,245,232,0.10)",
      borderRadius: "6px",
      cursor: "pointer",
      backdropFilter: "blur(8px)",
      WebkitBackdropFilter: "blur(8px)",
    },
  });
  b.innerHTML = iconHtml;
  b.addEventListener("mouseenter", () => {
    b.style.background = danger
      ? "rgba(255,95,46,0.22)"
      : "rgba(255,245,232,0.16)";
  });
  b.addEventListener("mouseleave", () => {
    b.style.background = "rgba(20,12,8,0.78)";
  });
  return b;
}

function updateCounter() {
  if (shellRef.counter) {
    shellRef.counter.textContent =
      `${currentIndex + 1} / ${deck.slides.length}`;
  }
}

function toggleJumpMenu() {
  const menu = shellRef.jumpMenu;
  if (!menu) return;
  if (menu.style.display === "grid") { menu.style.display = "none"; return; }
  menu.innerHTML = "";
  for (let i = 0; i < deck.slides.length; i++) {
    const active = i === currentIndex;
    const b = el("button", {
      text: String(i + 1),
      onclick: () => { go(i); menu.style.display = "none"; },
      style: {
        width: "38px", height: "38px",
        borderRadius: "10px", border: "none",
        background: active ? C.orange : "rgba(255,245,232,0.06)",
        color: active ? "#fff" : "#f5e7d6",
        fontWeight: "800", fontSize: "13px",
        fontFamily: FONT, cursor: "pointer",
        fontVariantNumeric: "tabular-nums",
        transition: "background 0.12s ease",
      },
    });
    b.dataset.iconBtn = "1";
    b.style.transition =
      "background 160ms var(--ease), transform 120ms var(--ease)";
    if (!active) {
      b.addEventListener("mouseenter", () =>
        b.style.background = "rgba(255,245,232,0.14)");
      b.addEventListener("mouseleave", () =>
        b.style.background = "rgba(255,245,232,0.06)");
    }
    menu.appendChild(b);
  }
  menu.style.display = "grid";
}

function togglePresent() {
  presenting = !presenting;
  if (presenting && editMode) editMode = false;
  if (shellRef.bar) shellRef.bar.style.display = presenting ? "none" : "flex";
  if (shellRef.exitBtn)
    shellRef.exitBtn.style.display = presenting ? "inline-flex" : "none";
  if (shellRef.jumpMenu) shellRef.jumpMenu.style.display = "none";
  shellRef.leftPanel.style.display = (editMode && !presenting) ? "flex" : "none";
  shellRef.rightPanel.style.display = (editMode && !presenting) ? "flex" : "none";
  const b = shellRef.fsBtn;
  if (b) {
    b.innerHTML = presenting ? ICONS.collapse : ICONS.expand;
    b.title = presenting ? "Exit presentation (F)" : "Present (F)";
  }
  // Entering present mode implicitly leaves edit mode, so refresh the
  // undo button visibility too.
  updateUndoButtons();
  shellRef.fit?.();
  render();
}

function toggleEdit() {
  editMode = !editMode;
  if (editMode && presenting) presenting = false;
  selectedBlockId = null;
  const b = shellRef.editBtn;
  if (b) {
    b.style.background = editMode ? C.orange : "transparent";
    b.style.color = editMode ? "#fff" : "#f5e7d6";
    b.dataset.variant = editMode ? "accent" : "ghost";
    b.title = editMode ? "Done editing (E)" : "Edit (E)";
  }
  shellRef.leftPanel.style.display = editMode ? "flex" : "none";
  shellRef.rightPanel.style.display = editMode ? "flex" : "none";
  updateUndoButtons();
  shellRef.fit?.();
  render(); renderSlideList(); renderInspector();
}

function go(i) {
  const n = deck.slides.length;
  if (n === 0) return;
  currentIndex = ((i % n) + n) % n;
  selectedBlockId = null;
  updateCounter();
  render(); renderSlideList(); renderInspector();
}

function render() {
  if (!stageRef.el) return;
  stageRef.el.innerHTML = "";
  const slide = currentSlide();
  if (!slide) return;
  stageRef.el.appendChild(renderSlide(slide));
}

function renderPrintDeck() {
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

/* ====================== Slide list & search ============================= */

/* The search field that lives in the left panel header. Renders once at
 * shell mount time; typing into it filters the slide list in place
 * without ever stealing focus.
 *
 * The visual treatment mirrors the right panel's component-library
 * search exactly: a flat row (no pill background, no focus glow on the
 * wrapper) with the icon, input, and clear button laid out in a row,
 * with the surrounding `header` div providing the bottom-border
 * separator that the library card's border-bottom plays the role of. */
function buildSlideSearchHeader() {
  const header = el("div", {
    style: {
      padding: "9px 12px",
      borderBottom: "1px solid rgba(255,245,232,0.05)",
    },
  });

  const box = el("div", {
    style: {
      display: "flex", alignItems: "center", gap: "8px",
    },
  });
  box.dataset.slideSearchBox = "1";
  box.appendChild(svgFromString(
    `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#8a7164" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20.5 20.5-4.3-4.3"/></svg>`));

  const input = el("input", {
    type: "text",
    placeholder: "Search slides",
    value: slideSearch,
    style: {
      flex: "1",
      background: "transparent",
      border: "none", outline: "none",
      color: "#fff5e8",
      fontSize: "12px", fontFamily: FONT,
      padding: "0", letterSpacing: "0",
    },
    oninput: (e) => {
      slideSearch = e.target.value;
      renderSlideList();
      updateSlideSearchClear();
    },
    onkeydown: (e) => {
      e.stopPropagation();
      if (e.key === "Escape") {
        if (slideSearch) {
          slideSearch = "";
          e.target.value = "";
          renderSlideList();
          updateSlideSearchClear();
        } else {
          e.target.blur();
        }
      } else if (e.key === "Enter") {
        // Jump to the first match.
        const idxs = filteredSlideIndices();
        if (idxs.length > 0) go(idxs[0]);
      }
    },
  });
  box.appendChild(input);

  const clear = el("button", {
    title: "Clear",
    "aria-label": "Clear slide search",
    "data-press": "1",
    "data-slide-search-clear": "1",
    onclick: () => {
      slideSearch = "";
      input.value = "";
      input.focus();
      renderSlideList();
      updateSlideSearchClear();
    },
    style: {
      background: "transparent", border: "none",
      padding: "2px", margin: "0",
      color: "#8a7164", cursor: "pointer",
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      borderRadius: "4px",
      opacity: slideSearch ? "1" : "0",
      pointerEvents: slideSearch ? "auto" : "none",
      transition:
        "color 140ms var(--ease), background 140ms var(--ease), opacity 140ms var(--ease)",
    },
  });
  clear.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M6 18 18 6"/></svg>`;
  clear.addEventListener("mouseenter", () => {
    clear.style.color = "#fff5e8";
    clear.style.background = "rgba(255,245,232,0.08)";
  });
  clear.addEventListener("mouseleave", () => {
    clear.style.color = "#8a7164";
    clear.style.background = "transparent";
  });
  box.appendChild(clear);

  header.appendChild(box);
  return header;
}

function updateSlideSearchClear() {
  const c = document.querySelector('[data-slide-search-clear="1"]');
  if (c) {
    c.style.opacity = slideSearch ? "1" : "0";
    c.style.pointerEvents = slideSearch ? "auto" : "none";
  }
}

/* Index of the slide currently being dragged in the side list. */
let dragSrcIndex = null;

function clearDropIndicators(list) {
  list.querySelectorAll("[data-drop-line]").forEach(e => e.remove());
}

function renderSlideList() {
  const list = shellRef.slideList;
  if (!list) return;
  list.innerHTML = "";

  const indices = filteredSlideIndices();
  const filtering = !!slideSearch.trim();

  if (indices.length === 0) {
    list.appendChild(el("div", {
      style: {
        padding: "24px 12px", textAlign: "center",
        color: "#7b6254", fontSize: "11.5px", lineHeight: "1.4",
      },
    }, [
      el("div", { text: "No slides match", style: { fontWeight: "600" }}),
      el("div", {
        text: `"${slideSearch}"`,
        style: { marginTop: "4px", color: "#5b483b",
                 fontStyle: "italic", fontSize: "10.5px",
                 whiteSpace: "nowrap", overflow: "hidden",
                 textOverflow: "ellipsis" },
      }),
    ]));
    return;
  }

  // While filtering we can't drag-to-reorder (the visual positions don't
  // map cleanly onto absolute indices). Disable draggable + grab cursor.
  const canReorder = !filtering;

  for (const i of indices) {
    const s = deck.slides[i];
    const active = i === currentIndex;

    const row = el("div", {
      "data-slide-row": "1",
      "data-index": String(i),
      "data-active": active ? "1" : "0",
      draggable: canReorder ? "true" : "false",
      onclick: () => go(i),
      style: {
        position: "relative",
        padding: "8px",
        marginBottom: "5px",
        borderRadius: "10px",
        background: active
          ? hexA(C.orange, 0.12)
          : "transparent",
        border: `1px solid ${active
          ? hexA(C.orange, 0.40)
          : "transparent"}`,
        cursor: canReorder ? "grab" : "pointer",
        transition:
          "background 140ms var(--ease), border-color 140ms var(--ease)",
      },
    });

    // Header: slide number on the left, hover-revealed actions on the right.
    const header = el("div", {
      style: {
        display: "flex", alignItems: "center",
        marginBottom: "6px", padding: "0 2px",
        height: "16px",
      },
    });
    header.appendChild(el("div", {
      text: String(i + 1).padStart(2, "0"),
      style: {
        fontSize: "10px", fontWeight: "750",
        color: active ? "#ffb18d" : "#6e5747",
        fontVariantNumeric: "tabular-nums",
        letterSpacing: "0.08em",
      },
    }));
    const actions = el("div", {
      style: {
        marginLeft: "auto",
        display: "flex", gap: "4px",
        opacity: "0",
        transition: "opacity 140ms var(--ease)",
        pointerEvents: "none",
      },
    });
    const dupBtn = thumbActionBtn(ICONS.copy, "Duplicate slide", (e) => {
      e.stopPropagation(); duplicateSlideById(s.id);
    });
    const delBtn = thumbActionBtn(ICONS.trash, "Delete slide", (e) => {
      e.stopPropagation(); removeSlideById(s.id);
    }, true);
    actions.appendChild(dupBtn);
    actions.appendChild(delBtn);
    header.appendChild(actions);
    row.appendChild(header);

    // Thumbnail
    row.appendChild(renderSlideThumbnail(s, 156));

    // One-line title under the thumb, so the list is scannable without
    // having to read tiny thumbnail text.
    const label = slideLabel(s);
    row.appendChild(el("div", {
      style: {
        marginTop: "6px",
        padding: "0 2px",
        fontSize: "11px",
        fontWeight: active ? "600" : "500",
        color: active ? "#fff5e8" : "#a89082",
        lineHeight: "1.3",
        whiteSpace: "nowrap", overflow: "hidden",
        textOverflow: "ellipsis",
      },
      text: label,
    }));

    // Reveal hover actions only on hover (not on press / drag).
    row.addEventListener("mouseenter", () => {
      actions.style.opacity = "1";
      actions.style.pointerEvents = "auto";
      if (!active) row.style.background = "rgba(255,245,232,0.035)";
    });
    row.addEventListener("mouseleave", () => {
      actions.style.opacity = "0";
      actions.style.pointerEvents = "none";
      if (!active) row.style.background = "transparent";
    });

    if (canReorder) attachSlideDragHandlers(row, list, i);

    list.appendChild(row);
  }
}

function attachSlideDragHandlers(row, list, i) {
  // Native HTML5 drag-and-drop for reordering. Works inside the sandbox
  // and gets a free drag-image from the browser.
  row.addEventListener("dragstart", (e) => {
    dragSrcIndex = i;
    row.style.opacity = "0.4";
    row.style.cursor = "grabbing";
    try {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(i));
    } catch {}
  });
  row.addEventListener("dragend", () => {
    row.style.opacity = "1";
    row.style.cursor = "grab";
    clearDropIndicators(list);
    dragSrcIndex = null;
  });
  row.addEventListener("dragover", (e) => {
    if (dragSrcIndex == null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const rect = row.getBoundingClientRect();
    const before = (e.clientY - rect.top) < rect.height / 2;
    clearDropIndicators(list);
    // Don't show an indicator that would be a no-op.
    if ((before && (dragSrcIndex === i || dragSrcIndex === i - 1)) ||
        (!before && (dragSrcIndex === i || dragSrcIndex === i + 1))) return;
    const line = el("div", {
      "data-drop-line": "1",
      style: {
        height: "2px", margin: "0 2px",
        background: C.orange,
        borderRadius: "2px",
        boxShadow: `0 0 8px ${hexA(C.orange, 0.6)}`,
      },
    });
    if (before) list.insertBefore(line, row);
    else if (row.nextSibling) list.insertBefore(line, row.nextSibling);
    else list.appendChild(line);
  });
  row.addEventListener("drop", (e) => {
    e.preventDefault();
    const from = dragSrcIndex;
    clearDropIndicators(list);
    if (from == null || from === i) return;
    const rect = row.getBoundingClientRect();
    const before = (e.clientY - rect.top) < rect.height / 2;
    let to = before ? i : i + 1;
    if (from < to) to -= 1;
    if (from === to) return;
    moveSlideTo(from, to);
  });
}

/* ====================== Realtime ========================================= */

class Subscriber extends RpcTarget {
  deckChanged(newDeck, meta) {
    // The server passes `{canUndo, canRedo}` as a second arg; refresh
    // the button state alongside the rest of the UI. (Old/missing meta
    // is tolerated for forward-compat.)
    if (meta) {
      canUndo = !!meta.canUndo;
      canRedo = !!meta.canRedo;
      updateUndoButtons();
    }
    // Preserve selection & index when possible.
    const prevSlideId = currentSlide()?.id;
    deck = newDeck;
    if (prevSlideId) {
      const i = deck.slides.findIndex(s => s.id === prevSlideId);
      if (i >= 0) currentIndex = i;
      else currentIndex = Math.min(currentIndex, deck.slides.length - 1);
    } else {
      currentIndex = Math.min(currentIndex, deck.slides.length - 1);
    }
    // If selected block is gone, drop it.
    if (selectedBlockId) {
      const s = currentSlide();
      if (!s || !s.blocks.find(b => b.id === selectedBlockId))
        selectedBlockId = null;
    }
    render(); renderSlideList(); renderInspector(); updateCounter();
  }
}

/* ====================== Boot ============================================= */


  try {
    deck = (await gadget.getDeck()) || { slides: [] };
  } catch (e) { deck = { slides: [] }; }
  try { await gadget.subscribe(new Subscriber()); } catch (e) {}
  mountShell();
  updateCounter();
  render();
  renderSlideList();
  if (isSlidesExport) {
    renderPrintDeck();
    shellRef.root.remove();
  }
  // Initial undo-button state. Subsequent updates piggy-back on
  // deckChanged broadcasts.
  try {
    const s = await gadget.getUndoState();
    canUndo = !!s?.canUndo; canRedo = !!s?.canRedo;
    updateUndoButtons();
  } catch {}

