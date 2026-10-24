// SVG markup from the deck is untrusted (pasted, or written by an agent or a
// collaborator). It is parsed inert -- a <template> loads and runs nothing --
// and stripped of whatever could run script, embed a document or navigate
// before it is shown inline: script and embedding elements, event handler
// attributes, links to anything but a fragment or image data, and animations
// that would write such a link. (CSS references are left: the gadget frame's
// content security policy already blocks every outside load.)

const SVG_UNSAFE_ELEMENTS = "script, iframe, frame, frameset, object, embed, applet, portal, base, link, meta, form, input, button, textarea, select, audio, video";
const SVG_URL_ATTRS = new Set(["href", "src", "action", "formaction", "data", "srcdoc"]);
const isSafeSvgUrl = (v: string) => /^\s*(#|data:image\/)/i.test(v);

/** The first `<svg>` in `markup`, made safe to show inline, or null when there is none. */
export function parseSvgMarkup(markup: string): SVGSVGElement | null {
  const t = document.createElement("template");
  t.innerHTML = markup.trim();
  const node = t.content.querySelector("svg");
  if (!node) return null;
  node.querySelectorAll(SVG_UNSAFE_ELEMENTS).forEach((n) => n.remove());
  for (const n of [node, ...node.querySelectorAll("*")]) {
    if (/^(animate|set)$/i.test(n.localName) && /href$/i.test(n.getAttribute("attributeName") ?? "")) {
      n.remove();
      continue;
    }
    for (const a of Array.from(n.attributes)) {
      const name = a.name.toLowerCase();
      if (name.startsWith("on") || (SVG_URL_ATTRS.has(name.split(":").pop() ?? "") && !isSafeSvgUrl(a.value))) n.removeAttribute(a.name);
    }
  }
  return node;
}

/**
 * The size of `svg`'s artwork in its own units. One with a width and height but no viewBox is
 * given the viewBox they imply, so that resizing it scales the artwork rather than showing it at
 * its original size in a corner.
 */
export function svgArtworkSize(svg: SVGSVGElement): { w: number; h: number } {
  const vb = (svg.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
  if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) return { w: vb[2], h: vb[3] };
  const length = (name: string) => /^\s*[\d.]+(px)?\s*$/i.test(svg.getAttribute(name) ?? "") ? parseFloat(svg.getAttribute(name)!) : 0;
  const w = length("width"), h = length("height");
  if (w > 0 && h > 0) svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  return { w: w || 300, h: h || 150 };
}

let svgScopes = 0;

/**
 * Prefixes `svg`'s ids with one unique to this copy and rewrites its references to them. A block
 * is drawn several times on a page (slide, thumbnails, print deck) and ids are page-wide, so a
 * `url(#id)` could otherwise resolve to a hidden copy and paint nothing.
 */
export function scopeSvgIds(svg: SVGSVGElement): void {
  const ids = new Map<string, string>();
  const prefix = `svg${++svgScopes}-`;
  for (const n of svg.querySelectorAll("[id]")) {
    ids.set(n.id, prefix + n.id);
    n.id = prefix + n.id;
  }
  if (!ids.size) return;
  const scoped = (m: string, id: string) => (ids.has(id) ? m.replace(`#${id}`, `#${ids.get(id)}`) : m);
  for (const n of [svg, ...svg.querySelectorAll("*")]) {
    for (const a of Array.from(n.attributes)) {
      if (/(^|:)href$/i.test(a.name)) a.value = a.value.replace(/^#(.+)$/, scoped);
      else a.value = a.value.replace(/url\(\s*['"]?#([^'")\s]+)/g, scoped);
    }
    // In a stylesheet, `#id` is both a selector and the target of `url(#id)`.
    if (n.localName === "style") n.textContent = (n.textContent ?? "").replace(/#([\w-]+)/g, scoped);
  }
}
