// Mail content for agents to read and write. Mail is written by its sender, not the user, so an agent
// reads what a person would see in Outlook and nothing they wouldn't: scripts, styles and comments
// go; hidden text (display:none, zero-size or background-coloured text, preheaders, invisible
// characters) and tracking images are removed and counted; every link shows its real target,
// unwrapped from Safe Links and URL Defense, and is flagged when its text names another site. Layout
// tables flatten to text. HTML is tokenized, built into a small tree, cleaned, and handed to
// `htmlToMarkdown`; nothing is evaluated.
//
// For composing, `markdownToMailHtml` writes Markdown as HTML with inline styles only (Outlook
// ignores <style>), and the parse and check functions validate what an agent passes.

import { escapeHtml } from "@gadgets/gatekeeper-kit/connect-pages";
import { parseMarkdown, safeHref as safeMarkdownHref, type MdBlock, type MdInline } from "./content/markdown-parse";
import { VOID, decodeEntities, htmlToMarkdown, tokenize, trimTrailingBlanks } from "./html-markdown";
import type { AttachmentInput, EmailAddress, MessageLink, SenderKind } from "./outlook-types";

// -- reading ------------------------------------------------------------------------------------

/** What `mailToMarkdown` makes of a body. */
export type MailMarkdown = {
  markdown: string; links: MessageLink[]; removed: string[]; truncated: boolean;
  /** Whether text was left out because it doesn't show when read: hidden regions or invisible characters. */
  hidesText: boolean;
};

/** The most links listed for one message. */
export const MAX_LINKS = 200;
/** How deep the tree is built; anything deeper is attached at this depth, flattened. */
const MAX_DEPTH = 200;

/**
 * Characters a person can't see: Unicode's default-ignorable set (zero-width spaces and joiners,
 * bidi controls, the BOM, soft hyphens, Hangul fillers, variation selectors, and the tag characters
 * U+E0000–E007F that can spell out text a model reads and a person doesn't), and controls.
 */
// oxlint-disable-next-line no-control-regex -- matching invisible and control characters is the point
const INVISIBLE = /[\p{Default_Ignorable_Code_Point}\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;
/** Of those, the variation selectors that pick text or emoji presentation, which hide nothing worth a note. */
const PRESENTATION_SELECTORS = /^[\ufe0e\ufe0f]$/u;

/** Text with the characters a person can't see removed: for subjects, names and previews. */
export function visibleText(text: string): string {
  return text.replace(INVISIBLE, "");
}

/** Elements removed with everything in them. */
const DROPPED = new Set([
  "script", "style", "head", "title", "template", "noscript", "iframe", "object", "embed", "applet", "frame", "frameset",
  "form", "input", "button", "select", "option", "textarea", "svg", "math", "audio", "video", "canvas", "map", "link", "meta",
]);

/** Elements that end a paragraph when opened inside one, as browsers close them. */
const CLOSES_P = new Set(["p", "div", "table", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "hr", "section", "article", "header", "footer"]);

type Element = { tag: string; attrs: Record<string, string>; children: Node[]; parent: Element | null };
type Node = Element | { text: string };

const isElement = (node: Node): node is Element => "tag" in node;

/** Builds a tree from tokens, closing elements as a browser would, with depth bounded. */
function buildTree(html: string): { root: Element; base?: string } {
  const root: Element = { tag: "#root", attrs: {}, children: [], parent: null };
  let current = root;
  let depth = 0;
  let base: string | undefined;
  const closeTo = (tag: string): boolean => {
    let node: Element | null = current;
    let steps = 0;
    while (node && node !== root && node.tag !== tag) {
      node = node.parent;
      steps++;
    }
    if (!node || node === root) return false;
    current = node.parent!;
    depth -= steps + 1;
    return true;
  };
  const closeIfOpen = (tags: readonly string[], stopAt: readonly string[]) => {
    for (let node: Element | null = current; node && node !== root; node = node.parent) {
      if (stopAt.includes(node.tag)) return;
      if (tags.includes(node.tag)) {
        closeTo(node.tag);
        return;
      }
    }
  };
  for (const token of tokenize(html)) {
    if (token.type === "text") {
      current.children.push({ text: token.text });
      continue;
    }
    // Outlook's namespaced tags (`o:p`, `v:shape`) tokenize as their prefix; they carry nothing.
    const tag = token.tag;
    if (token.type === "close") {
      closeTo(tag);
      continue;
    }
    if (tag === "base") {
      base ??= token.attrs.href;
      continue;
    }
    if (tag === "p" || CLOSES_P.has(tag)) closeIfOpen(["p"], ["table", "td", "th", "li", "blockquote"]);
    if (tag === "li") closeIfOpen(["li"], ["ul", "ol"]);
    if (tag === "td" || tag === "th") closeIfOpen(["td", "th"], ["table"]);
    if (tag === "tr") closeIfOpen(["td", "th", "tr"], ["table"]);
    const element: Element = { tag, attrs: token.attrs, children: [], parent: current };
    current.children.push(element);
    if (!token.selfClosing && !VOID.has(tag) && depth < MAX_DEPTH) {
      current = element;
      depth++;
    }
  }
  return { root, ...(base !== undefined ? { base } : {}) };
}

/** CSS declarations (`a: b; c: d`) by property, lower-cased, `!important` dropped. */
/**
 * Each `selectors { declarations }` of a stylesheet, in one pass. A selector list runs from the
 * nearest `{`, `}` or `@` before its brace, so an at-rule's prelude is never one, and a block that
 * holds other blocks (`@media`) yields no rule itself, only the rules inside it. The regex
 * `/([^{}@]+)\{([^{}]*)\}/g` found the same rules but backtracked quadratically over a long
 * stylesheet with no braces.
 */
function cssRules(css: string): { selectors: string; declarations: string }[] {
  const rules: { selectors: string; declarations: string }[] = [];
  let from = 0;
  let close = -1;
  for (let open = css.indexOf("{"); open !== -1;) {
    if (close < open) close = css.indexOf("}", open + 1);
    if (close === -1) break;
    const next = css.indexOf("{", open + 1);
    const before = css.slice(from, open);
    const selectors = before.slice(Math.max(before.lastIndexOf("}"), before.lastIndexOf("@")) + 1);
    if (selectors && (next === -1 || next > close)) {
      rules.push({ selectors, declarations: css.slice(open + 1, close) });
      from = close + 1;
    } else {
      from = open + 1;
    }
    open = next;
  }
  return rules;
}

function parseDeclarations(css: string): Map<string, string> {
  const declarations = new Map<string, string>();
  for (const declaration of css.split(";")) {
    const colon = declaration.indexOf(":");
    if (colon > 0) declarations.set(declaration.slice(0, colon).trim().toLowerCase(), declaration.slice(colon + 1).replace(/!important/i, "").trim().toLowerCase());
  }
  return declarations;
}

/**
 * What a message's own <style> blocks say about its elements, which inline styles alone would miss:
 * hiding (`.preheader { display: none }`), and the colours and sizes that decide whether text shows.
 * A hiding selector's last compound decides, ignoring what comes before it, so `table td.x` hides
 * every `.x`: reading more hides more than the rule does, never less. Colours and sizes come only
 * from single-compound selectors (`.x`, `td.x`), since `.header a { color: #fff }` says nothing
 * about the links elsewhere.
 */
export type StyleRules = {
  classes: Map<string, Map<string, string>>;
  ids: Map<string, Map<string, string>>;
  tags: Map<string, Map<string, string>>;
  /** Attributes whose presence a hiding rule selects on (`[data-preheader]`). */
  hiddenAttributes: Set<string>;
};

/** The declarations text inherits, the only ones taken from `html` and `body` rules: hiding those would hide the message. */
const INHERITED_PROPERTIES = new Set(["color", "background", "background-color", "font-size"]);

function stylesheetRules(html: string): StyleRules {
  const rules: StyleRules = { classes: new Map(), ids: new Map(), tags: new Map(), hiddenAttributes: new Set() };
  const merge = (into: Map<string, Map<string, string>>, key: string, declarations: ReadonlyMap<string, string>) => {
    const merged = into.get(key) ?? new Map<string, string>();
    for (const [property, value] of declarations) merged.set(property, value);
    into.set(key, merged);
  };
  for (const block of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) {
    for (const rule of cssRules(block[1]!.replace(/\/\*[\s\S]*?\*\//g, ""))) {
      const declarations = parseDeclarations(rule.declarations);
      const hides = hidesElement(declarations);
      for (const selector of rule.selectors.split(",")) {
        const compounds = selector.trim().split(/[\s>+~]+/);
        if (!hides && compounds.length > 1) continue;
        // The last compound, without pseudo-classes: `div > p.x:first-child` → `p.x`.
        const last = compounds.at(-1)?.replace(/::?[a-z-]+(\([^)]*\))?/gi, "") ?? "";
        let matched = false;
        for (const part of last.matchAll(/([.#])([a-z0-9_-]+)/gi)) {
          merge(part[1] === "." ? rules.classes : rules.ids, part[2]!.toLowerCase(), declarations);
          matched = true;
        }
        for (const part of last.matchAll(/\[\s*([a-z0-9_:-]+)\s*(?:[~|^$*]?=\s*["']?[^"'\]]*["']?\s*)?\]/gi)) {
          // A value test (`=`, `^=`, `*=`…) is read as "has the attribute", hiding at least as much.
          if (hides) rules.hiddenAttributes.add(part[1]!.toLowerCase());
          matched = true;
        }
        const tag = /^([a-z][a-z0-9]*)/i.exec(last)?.[1]?.toLowerCase();
        if (matched || tag === undefined) continue;
        merge(rules.tags, tag, tag === "html" || tag === "body"
          ? new Map([...declarations].filter(([property]) => INHERITED_PROPERTIES.has(property))) : declarations);
      }
    }
  }
  return rules;
}

/** An element's style: the stylesheet's rules for its tag, classes and ID, then its own `style`. */
function styleOf(element: Element, rules: StyleRules): Map<string, string> {
  const style = new Map(rules.tags.get(element.tag));
  for (const name of (element.attrs.class ?? "").toLowerCase().split(/\s+/)) {
    for (const [property, value] of rules.classes.get(name) ?? []) style.set(property, value);
  }
  for (const [property, value] of rules.ids.get(element.attrs.id?.toLowerCase() ?? "") ?? []) style.set(property, value);
  for (const [property, value] of parseDeclarations(element.attrs.style ?? "")) style.set(property, value);
  return style;
}

/** Text no larger than this, in pixels, can't be read: it counts as hidden. */
const MAX_HIDDEN_FONT_PX = 3;
/** Positioned this far off the page, an element is out of sight. */
const OFF_SCREEN_PX = -500;
/** A clipped box this small (a preheader's usual shape) shows nothing readable. */
const MAX_CLIPPED_PX = 2;
/** Letters drawn this far back over one another can't be read: an em at the default size. */
const COLLAPSED_SPACING_PX = -16;

/** Whether declarations hide an element and all it holds. */
function hidesElement(style: ReadonlyMap<string, string>, options: { sized?: boolean } = {}): boolean {
  if (style.get("display") === "none" || style.get("visibility") === "hidden" || style.get("visibility") === "collapse"
    || style.get("mso-hide") === "all" || style.get("content-visibility") === "hidden") return true;
  const opacity = style.get("opacity");
  if (opacity !== undefined && (opacity.endsWith("%") ? Number.parseFloat(opacity) / 100 : Number.parseFloat(opacity)) <= 0.05) return true;
  // A zero box hides what overflows it in mail clients, which clip regardless of `overflow`; a box
  // of a pixel or two does so when it clips. (An image's own size is read as a tracking pixel instead.)
  const clips = ["overflow", "overflow-x", "overflow-y"].some(property => /^(hidden|clip)$/.test(style.get(property) ?? ""));
  for (const property of options.sized === false ? [] : ["max-height", "height", "max-width", "width"]) {
    const size = cssLength(style.get(property) ?? "");
    if (size !== undefined && (size === 0 || (clips && size <= MAX_CLIPPED_PX))) return true;
  }
  const position = style.get("position");
  for (const side of position === "absolute" || position === "fixed" ? ["left", "top", "right", "bottom", "margin-left", "margin-top"] : ["margin-left", "margin-top"]) {
    const offset = cssLength(style.get(side) ?? "");
    if (offset !== undefined && offset <= OFF_SCREEN_PX) return true;
  }
  const indent = cssLength(style.get("text-indent") ?? "");
  if (indent !== undefined && indent <= OFF_SCREEN_PX) return true;
  const spacing = cssLength(style.get("letter-spacing") ?? "");
  if (spacing !== undefined && spacing <= COLLAPSED_SPACING_PX) return true;
  const clip = style.get("clip")?.replace(/\s+/g, "");
  if (clip !== undefined && /^rect\((0(px)?,?){3}0(px)?\)$/.test(clip)) return true;
  const clipPath = style.get("clip-path");
  if (clipPath !== undefined && /inset\(\s*50%|circle\(\s*0|polygon\(\s*0(px)?\s+0(px)?\s*\)/.test(clipPath)) return true;
  const transform = style.get("transform");
  if (transform !== undefined) {
    if (/scale[xy]?\(\s*0(\.0+)?\s*[,)]/.test(transform)) return true;
    const moved = /translate(?:3d|x|y)?\(([^)]*)\)/i.exec(transform)?.[1]?.split(",") ?? [];
    if (moved.some(part => (cssLength(part) ?? 0) <= OFF_SCREEN_PX)) return true;
  }
  return false;
}

/** A CSS length in pixels, roughly (pt and em are converted); undefined when it isn't one. */
function cssLength(value: string): number | undefined {
  const match = /^(-?[0-9]*\.?[0-9]+)(px|pt|em|rem|%|vw|vh|vmin|vmax|ch|ex|cm|mm|in|pc)?$/.exec(value.replace(/!important/i, "").trim());
  if (!match) return undefined;
  const number = Number(match[1]);
  switch (match[2]) {
    case "pt": return number * 4 / 3;
    case "pc": return number * 16;
    case "in": return number * 96;
    case "cm": return number * 96 / 2.54;
    case "mm": return number * 96 / 25.4;
    case "em": case "rem": return number * 16;
    case "ch": case "ex": return number * 8;
    // Relative to something unknown: only zero is certain.
    case "%": case "vw": case "vh": case "vmin": case "vmax": return number === 0 ? 0 : undefined;
    default: return number;
  }
}

/** CSS's named colours, so text named as the colour of its background is seen for what it is. */
const NAMED_COLORS: ReadonlyMap<string, string> = new Map(("aliceblue:f0f8ff antiquewhite:faebd7 aqua:00ffff aquamarine:7fffd4 azure:f0ffff " +
  "beige:f5f5dc bisque:ffe4c4 black:000000 blanchedalmond:ffebcd blue:0000ff blueviolet:8a2be2 brown:a52a2a burlywood:deb887 " +
  "cadetblue:5f9ea0 chartreuse:7fff00 chocolate:d2691e coral:ff7f50 cornflowerblue:6495ed cornsilk:fff8dc crimson:dc143c cyan:00ffff " +
  "darkblue:00008b darkcyan:008b8b darkgoldenrod:b8860b darkgray:a9a9a9 darkgreen:006400 darkgrey:a9a9a9 darkkhaki:bdb76b " +
  "darkmagenta:8b008b darkolivegreen:556b2f darkorange:ff8c00 darkorchid:9932cc darkred:8b0000 darksalmon:e9967a darkseagreen:8fbc8f " +
  "darkslateblue:483d8b darkslategray:2f4f4f darkslategrey:2f4f4f darkturquoise:00ced1 darkviolet:9400d3 deeppink:ff1493 " +
  "deepskyblue:00bfff dimgray:696969 dimgrey:696969 dodgerblue:1e90ff firebrick:b22222 floralwhite:fffaf0 forestgreen:228b22 " +
  "fuchsia:ff00ff gainsboro:dcdcdc ghostwhite:f8f8ff gold:ffd700 goldenrod:daa520 gray:808080 green:008000 greenyellow:adff2f " +
  "grey:808080 honeydew:f0fff0 hotpink:ff69b4 indianred:cd5c5c indigo:4b0082 ivory:fffff0 khaki:f0e68c lavender:e6e6fa " +
  "lavenderblush:fff0f5 lawngreen:7cfc00 lemonchiffon:fffacd lightblue:add8e6 lightcoral:f08080 lightcyan:e0ffff " +
  "lightgoldenrodyellow:fafad2 lightgray:d3d3d3 lightgreen:90ee90 lightgrey:d3d3d3 lightpink:ffb6c1 lightsalmon:ffa07a " +
  "lightseagreen:20b2aa lightskyblue:87cefa lightslategray:778899 lightslategrey:778899 lightsteelblue:b0c4de lightyellow:ffffe0 " +
  "lime:00ff00 limegreen:32cd32 linen:faf0e6 magenta:ff00ff maroon:800000 mediumaquamarine:66cdaa mediumblue:0000cd " +
  "mediumorchid:ba55d3 mediumpurple:9370db mediumseagreen:3cb371 mediumslateblue:7b68ee mediumspringgreen:00fa9a " +
  "mediumturquoise:48d1cc mediumvioletred:c71585 midnightblue:191970 mintcream:f5fffa mistyrose:ffe4e1 moccasin:ffe4b5 " +
  "navajowhite:ffdead navy:000080 oldlace:fdf5e6 olive:808000 olivedrab:6b8e23 orange:ffa500 orangered:ff4500 orchid:da70d6 " +
  "palegoldenrod:eee8aa palegreen:98fb98 paleturquoise:afeeee palevioletred:db7093 papayawhip:ffefd5 peachpuff:ffdab9 peru:cd853f " +
  "pink:ffc0cb plum:dda0dd powderblue:b0e0e6 purple:800080 rebeccapurple:663399 red:ff0000 rosybrown:bc8f8f royalblue:4169e1 " +
  "saddlebrown:8b4513 salmon:fa8072 sandybrown:f4a460 seagreen:2e8b57 seashell:fff5ee sienna:a0522d silver:c0c0c0 skyblue:87ceeb " +
  "slateblue:6a5acd slategray:708090 slategrey:708090 snow:fffafa springgreen:00ff7f steelblue:4682b4 tan:d2b48c teal:008080 " +
  "thistle:d8bfd8 tomato:ff6347 turquoise:40e0d0 violet:ee82ee wheat:f5deb3 white:ffffff whitesmoke:f5f5f5 yellow:ffff00 " +
  "yellowgreen:9acd32").split(" ").map(entry => entry.split(":") as [string, string]));

type Rgba = [number, number, number, number];

/** A CSS or HTML colour as RGB and alpha (`transparent` is alpha 0); undefined for anything else. */
function parseColor(value: string | undefined): Rgba | undefined {
  if (!value) return undefined;
  let text = value.replace(/!important/i, "").trim().toLowerCase();
  if (text === "transparent") return [0, 0, 0, 0];
  text = NAMED_COLORS.get(text) ?? text;
  const hex = /^#?([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(text);
  if (hex) {
    const short = hex[1]!.length <= 4;
    const digits = short ? [...hex[1]!].map(digit => digit + digit).join("") : hex[1]!;
    const [red, green, blue, alpha] = [0, 2, 4, 6].map(at => Number.parseInt(digits.slice(at, at + 2) || "ff", 16));
    return [red!, green!, blue!, alpha! / 255];
  }
  const fn = /^(rgba?|hsla?)\(([^)]*)\)$/.exec(text);
  if (!fn) return undefined;
  const parts = fn[2]!.trim().split(/\s*[,/]\s*|\s+/).filter(Boolean);
  if (parts.length < 3) return undefined;
  const alphaPart = parts[3];
  const alpha = alphaPart === undefined ? 1 : alphaPart.endsWith("%") ? Number.parseFloat(alphaPart) / 100 : Number.parseFloat(alphaPart);
  if (!Number.isFinite(alpha)) return undefined;
  if (fn[1]!.startsWith("rgb")) {
    const channels = parts.slice(0, 3).map(part => part.endsWith("%") ? Number.parseFloat(part) * 2.55 : Number.parseFloat(part));
    if (channels.some(channel => !Number.isFinite(channel))) return undefined;
    return [channels[0]!, channels[1]!, channels[2]!, Math.max(0, Math.min(1, alpha))];
  }
  const hue = Number.parseFloat(parts[0]!), saturation = Number.parseFloat(parts[1]!) / 100, lightness = Number.parseFloat(parts[2]!) / 100;
  if (![hue, saturation, lightness].every(Number.isFinite)) return undefined;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const channel = (n: number) => {
    const k = (n + hue / 30) % 12;
    return 255 * (lightness - chroma / 2 * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
  };
  return [channel(0), channel(8), channel(4), Math.max(0, Math.min(1, alpha))];
}

/** The background colour a `background` or `background-color` declaration sets, if any. */
function backgroundColor(element: Element, style: ReadonlyMap<string, string>, behind: Rgba): Rgba | undefined {
  const color = parseColor(style.get("background-color")) ?? parseColor(style.get("background")?.split(/\s+/).find(part => parseColor(part) !== undefined))
    ?? parseColor(element.attrs.bgcolor);
  return color && blend(color, behind);
}

/** A colour as it shows over an opaque one. */
function blend(color: Rgba, behind: Rgba): Rgba {
  const alpha = color[3];
  return [0, 1, 2].map(at => color[at]! * alpha + behind[at]! * (1 - alpha)).concat(1) as Rgba;
}

/** What text inherits from the elements around it. */
type Inherited = { color: Rgba; background: Rgba; fontSize: number };

/** Text this close in RGB distance to its background can't be read: it counts as hidden. */
const INVISIBLE_DISTANCE = 24;

function colorDistance(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
}

/** Known open-tracking image hosts and paths. */
const TRACKER = /(?:\/wf\/open|\/track\/open|\/trk\/|\/open\.gif|\/pixel\.(?:gif|png)|\/beacon|list-manage\.com\/track|mandrillapp\.com\/track|sendgrid\.net\/wf|mailchimp\.com\/track|hubspotemail\.net|t\.hubspotemail|\/e2t\/o\/|google-analytics\.com\/collect|mailtrack|mixmax\.com\/api\/track|yesware|bananatag|\/o\.gif|email\.mg\.[^/]+\/o\/|links\.[^/]+\/o\/|cmail\d+\.com\/t\/|exct\.net\/open)/i;

type Counters = {
  hiddenRegions: number;
  invisibleChars: number;
  trackingImages: number;
  dataImages: number;
  unsafeLinks: number;
  unwrapped: number;
};

/** A message body as safe Markdown, with its links and what was taken out. */
export function mailToMarkdown(
  body: { contentType: "html" | "text"; content: string },
  options: { maxChars: number; inlineImages?: ReadonlyMap<string, string> },
): MailMarkdown {
  const counters: Counters = { hiddenRegions: 0, invisibleChars: 0, trackingImages: 0, dataImages: 0, unsafeLinks: 0, unwrapped: 0 };
  const links = new LinkCollector();
  let markdown: string;
  if (body.contentType === "text") {
    markdown = textToMarkdown(body.content, counters, links);
  } else {
    const rules = stylesheetRules(body.content);
    const { root, base } = buildTree(body.content);
    const baseUrl = base !== undefined ? httpUrl(base) : undefined;
    const html = serialize(root, {
      rules, counters, links, baseUrl, inlineImages: options.inlineImages ?? new Map(),
    }, { color: [0, 0, 0, 1], background: [255, 255, 255, 1], fontSize: 16 });
    markdown = htmlToMarkdown(html);
  }
  const { text, truncated } = truncate(markdown, options.maxChars);
  return { markdown: text, links: links.list(), removed: removedNotes(counters), truncated, hidesText: counters.hiddenRegions > 0 || counters.invisibleChars > 0 };
}

const plural = (count: number, one: string) => `${count} ${count === 1 ? one : `${one}s`}`;

function removedNotes(counters: Counters): string[] {
  const notes: string[] = [];
  if (counters.hiddenRegions > 0) notes.push(counters.hiddenRegions === 1 ? "hidden text" : `hidden text (${counters.hiddenRegions} places)`);
  if (counters.invisibleChars > 0) notes.push(plural(counters.invisibleChars, "invisible character"));
  if (counters.trackingImages > 0) notes.push(plural(counters.trackingImages, "tracking image"));
  if (counters.dataImages > 0) notes.push(plural(counters.dataImages, "embedded image"));
  if (counters.unsafeLinks > 0) {
    notes.push(counters.unsafeLinks === 1 ? "1 link that wasn't a web or email link" : `${counters.unsafeLinks} links that weren't web or email links`);
  }
  if (counters.unwrapped > 0) notes.push(`unwrapped ${plural(counters.unwrapped, "Safe Link")}`);
  return notes;
}

type SerializeContext = {
  rules: StyleRules;
  counters: Counters;
  links: LinkCollector;
  baseUrl?: string;
  inlineImages: ReadonlyMap<string, string>;
};

/** Writes the cleaned tree back as the plain HTML `htmlToMarkdown` reads. Iterative, so depth costs no stack. */
function serialize(root: Element, context: SerializeContext, inherited: Inherited): string {
  const out: string[] = [];
  type Frame = { node: Node; inherited: Inherited } | { close: string };
  const stack: Frame[] = root.children.map(node => ({ node, inherited })).toReversed();
  while (stack.length > 0) {
    const frame = stack.pop()!;
    if ("close" in frame) {
      out.push(frame.close);
      continue;
    }
    const { node } = frame;
    if (!isElement(node)) {
      out.push(textOut(node.text, frame.inherited, context.counters));
      continue;
    }
    const written = elementOut(node, frame.inherited, context);
    if (written === null) continue;
    out.push(written.open);
    stack.push({ close: written.close });
    if (written.leaf) continue;
    for (let index = node.children.length - 1; index >= 0; index--) stack.push({ node: node.children[index]!, inherited: written.inherited });
  }
  return out.join("");
}

/** A text node as escaped HTML, or nothing when it is zero-size or background-coloured. */
function textOut(raw: string, inherited: Inherited, counters: Counters): string {
  const decoded = decodeEntities(raw);
  let invisible = 0;
  const visible = decoded.replace(INVISIBLE, char => {
    if (!PRESENTATION_SELECTORS.test(char)) invisible++;
    return "";
  });
  if (visible.trim() === "") {
    counters.invisibleChars += invisible;
    return escapeHtml(visible);
  }
  if (inherited.fontSize <= MAX_HIDDEN_FONT_PX || colorDistance(blend(inherited.color, inherited.background), inherited.background) < INVISIBLE_DISTANCE) {
    counters.hiddenRegions++;
    return " ";
  }
  counters.invisibleChars += invisible;
  return escapeHtml(visible);
}

/** Whether an element (with what it holds) has any text a person could read, ignoring whitespace. */
function hasText(element: Element): boolean {
  const stack: Node[] = [...element.children];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (!isElement(node)) {
      if (decodeEntities(node.text).replace(INVISIBLE, "").trim() !== "") return true;
    } else if (!DROPPED.has(node.tag)) {
      stack.push(...node.children);
    }
  }
  return false;
}

/** Bullets Word writes as text before a list paragraph's content, which read better as a bullet. */
const WORD_BULLETS = /^[·•o§▪■–-]$/;

/** How an element is written: its replacement tags, what its contents inherit, and whether they are written at all. */
type Written = { open: string; close: string; inherited: Inherited; leaf?: true };

function elementOut(element: Element, inherited: Inherited, context: SerializeContext): Written | null {
  const { tag } = element;
  if (DROPPED.has(tag)) return null;
  const style = styleOf(element, context.rules);
  if (hidesElement(style, { sized: tag !== "img" }) || "hidden" in element.attrs || [...context.rules.hiddenAttributes].some(name => Object.hasOwn(element.attrs, name))) {
    if (hasText(element)) context.counters.hiddenRegions++;
    return null;
  }
  const next: Inherited = { ...inherited };
  const color = parseColor(style.get("color")) ?? (tag === "font" ? parseColor(element.attrs.color) : undefined);
  if (color) next.color = color;
  const background = backgroundColor(element, style, inherited.background);
  if (background) next.background = background;
  const fontSize = style.get("font-size");
  if (fontSize !== undefined) {
    const percent = /^([0-9.]+)%$/.exec(fontSize.trim());
    const pixels = percent ? inherited.fontSize * Number(percent[1]) / 100 : cssLength(fontSize);
    if (pixels !== undefined) next.fontSize = pixels;
  } else if (tag === "font" && element.attrs.size === "0") {
    next.fontSize = 0;
  }
  // Word's list bullets, written as text in a span Outlook marks `mso-list:Ignore`.
  if (style.get("mso-list") === "ignore") {
    const text = plainTextOf(element).replace(/\s+/g, " ").trim();
    return { open: WORD_BULLETS.test(text) ? "• " : `${escapeHtml(text)} `, close: "", inherited: next, leaf: true };
  }
  switch (tag) {
    case "img": return { open: imageOut(element, style, context), close: "", inherited: next, leaf: true };
    case "a": return linkOut(element, next, context);
    case "table": {
      if (tableKind(element).data) return { open: "<table>", close: "</table>", inherited: next };
      return { open: "<div>", close: "</div>", inherited: next };
    }
    case "tr": case "td": case "th": case "thead": case "tbody": case "tfoot": {
      const table = enclosingTable(element);
      const kind = table ? tableKind(table) : undefined;
      if (kind?.data) {
        if (["thead", "tbody", "tfoot"].includes(tag)) return { open: "", close: "", inherited: next };
        // A data table with no header cells reads its first row as the header.
        const cell = tag === "td" && element.parent === kind.headerRow ? "th" : tag;
        return { open: `<${cell}>`, close: `</${cell}>`, inherited: next };
      }
      return { open: "<div>", close: "</div>", inherited: next };
    }
    case "br": case "hr": return { open: `<${tag}>`, close: "", inherited: next };
    case "p": case "div": case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": case "blockquote": case "pre":
    case "ul": case "ol": case "li": case "strong": case "b": case "em": case "i": case "s": case "strike": case "del": case "code":
    case "section": case "article": case "header": case "footer": case "figure":
      return { open: `<${tag}>`, close: `</${tag}>`, inherited: next };
    case "center": case "address": case "main": case "aside": case "nav": case "dl": case "dt": case "dd": case "caption":
      return { open: "<div>", close: "</div>", inherited: next };
    default:
      return { open: "", close: "", inherited: next };
  }
}

function enclosingTable(element: Element): Element | null {
  for (let node = element.parent; node; node = node.parent) if (node.tag === "table") return node;
  return null;
}

/** Whether a table holds data, and the row to read as its header when it has no header cells. */
type TableKind = { data: false } | { data: true; headerRow?: Element };

const tableKinds = new WeakMap<Element, TableKind>();

function tableKind(table: Element): TableKind {
  let kind = tableKinds.get(table);
  if (kind === undefined) {
    kind = classifyTable(table);
    tableKinds.set(table, kind);
  }
  return kind;
}

/**
 * Whether a table holds data (shown as a table) or lays out a page (flattened to text). A data
 * table has header cells, or two or more rows of the same two or more short cells, and no table
 * inside it or role="presentation".
 */
function classifyTable(table: Element): TableKind {
  if (table.attrs.role === "presentation" || table.attrs.role === "none") return { data: false };
  const rows: { row: Element; cells: Element[] }[] = [];
  let nested = false;
  const walk = (element: Element) => {
    for (const child of element.children) {
      if (!isElement(child)) continue;
      if (child.tag === "table") nested = true;
      else if (child.tag === "tr") rows.push({ row: child, cells: child.children.filter((cell): cell is Element => isElement(cell) && (cell.tag === "td" || cell.tag === "th")) });
      else if (["thead", "tbody", "tfoot"].includes(child.tag)) walk(child);
    }
  };
  walk(table);
  if (nested || rows.length === 0 || rows.some(({ cells }) => cells.some(cell => containsTag(cell, "table")))) return { data: false };
  if (rows.some(({ cells }) => cells.some(cell => cell.tag === "th"))) return { data: true };
  const width = rows[0]!.cells.length;
  if (rows.length < 2 || width < 2 || rows.some(({ cells }) => cells.length !== width)) return { data: false };
  const texts = rows.flatMap(({ cells }) => cells.map(cell => plainTextOf(cell).trim()));
  if (texts.some(text => text.length > 200)) return { data: false };
  const filled = texts.filter(text => text !== "");
  const short = filled.length >= texts.length / 2 && filled.reduce((sum, text) => sum + text.length, 0) / Math.max(1, filled.length) <= 60;
  return short ? { data: true, headerRow: rows[0]!.row } : { data: false };
}

function containsTag(element: Element, tag: string): boolean {
  const stack: Node[] = [...element.children];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (isElement(node)) {
      if (node.tag === tag) return true;
      stack.push(...node.children);
    }
  }
  return false;
}

function plainTextOf(element: Element): string {
  const parts: string[] = [];
  const stack: Node[] = [element];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (isElement(node)) {
      if (!DROPPED.has(node.tag)) for (let index = node.children.length - 1; index >= 0; index--) stack.push(node.children[index]!);
    } else {
      parts.push(decodeEntities(node.text));
    }
  }
  return parts.join("");
}

/** The most of an image's alt text shown: the sender's to write, at any length. */
const MAX_ALT_CHARS = 200;

/** An image as the placeholder text `htmlToMarkdown` writes, or nothing for a tracking or data image. */
function imageOut(element: Element, style: ReadonlyMap<string, string>, context: SerializeContext): string {
  const src = (element.attrs.src ?? "").trim();
  const width = cssLength(element.attrs.width ?? style.get("width") ?? "");
  const height = cssLength(element.attrs.height ?? style.get("height") ?? "");
  if (/^data:/i.test(src)) {
    context.counters.dataImages++;
    return "";
  }
  if ((width !== undefined && width <= 2) || (height !== undefined && height <= 2) || (/^https?:/i.test(src) && TRACKER.test(src))) {
    context.counters.trackingImages++;
    return "";
  }
  if (/^cid:/i.test(src)) {
    const name = context.inlineImages.get(src.slice(4).replace(/^<|>$/g, "")) ?? element.attrs.alt?.trim().slice(0, MAX_ALT_CHARS);
    return `<img alt="${escapeHtml(name || "inline image")}">`;
  }
  const alt = element.attrs.alt?.replace(INVISIBLE, "").trim().slice(0, MAX_ALT_CHARS);
  return alt ? `<img alt="${escapeHtml(alt)}">` : "<img>";
}

/** A link with its real target, or just its text when the target isn't a web or email link. */
function linkOut(element: Element, inherited: Inherited, context: SerializeContext): Written {
  const raw = element.attrs.href?.trim();
  if (raw === undefined || raw === "" || raw.startsWith("#")) return { open: "", close: "", inherited };
  const resolved = resolveHref(raw, context.baseUrl);
  if (resolved === undefined) {
    context.counters.unsafeLinks++;
    return { open: "", close: "", inherited };
  }
  const { url, unwrapped } = unwrapLink(resolved);
  if (unwrapped) context.counters.unwrapped++;
  const text = plainTextOf(element).replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
  context.links.add(text || url, url);
  return { open: `<a href="${escapeHtml(url)}">`, close: "</a>", inherited };
}

/** An absolute http(s) or mailto URL for an href, resolved against the message's <base>; else undefined. */
function resolveHref(href: string, baseUrl: string | undefined): string | undefined {
  // oxlint-disable-next-line no-control-regex -- browsers ignore control characters and whitespace in schemes
  const cleaned = href.replace(/[\u0000- ]/g, char => char === " " ? "%20" : "");
  if (/^mailto:/i.test(cleaned)) return /^mailto:[^\s<>"]+$/i.test(cleaned) ? cleaned : undefined;
  if (/^https?:/i.test(cleaned)) return httpUrl(cleaned);
  if (/^[a-z][a-z0-9+.-]*:/i.test(cleaned)) return undefined;
  return baseUrl ? httpUrl(cleaned, baseUrl) : undefined;
}

function httpUrl(value: string, base?: string): string | undefined {
  try {
    const url = new URL(value, base);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The real target of a link wrapped by Microsoft Defender Safe Links or Proofpoint URL Defense, which
 * rewrite every link in a message to go through them; anything else as it is.
 */
export function unwrapLink(url: string): { url: string; unwrapped: boolean } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { url, unwrapped: false };
  }
  const host = parsed.hostname.toLowerCase();
  if (host.endsWith(".safelinks.protection.outlook.com") || host === "safelinks.protection.outlook.com") {
    const target = parsed.searchParams.get("url");
    const inner = target ? resolveHref(target, undefined) : undefined;
    if (inner && /^https?:|^mailto:/i.test(inner)) return { url: unwrapLink(inner).url, unwrapped: true };
  }
  if (host === "urldefense.com" || host === "urldefense.proofpoint.com") {
    const v3 = /^\/v3\/__(.+?)__;/.exec(parsed.pathname + parsed.search);
    if (v3) {
      const inner = httpUrl(v3[1]!);
      if (inner) return { url: inner, unwrapped: true };
    }
    const u = parsed.searchParams.get("u");
    if (parsed.pathname.startsWith("/v2/url") && u) {
      const decoded = httpUrl(u.replace(/_/g, "/").replace(/-([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))));
      if (decoded) return { url: decoded, unwrapped: true };
    }
  }
  return { url, unwrapped: false };
}

/** Collects links in order, once per target, flagging a target whose text names another site. */
class LinkCollector {
  readonly #links = new Map<string, MessageLink>();

  add(text: string, url: string): void {
    const mismatch = linkMismatch(text, url);
    const existing = this.#links.get(url);
    if (existing) {
      if (mismatch) existing.mismatch = true;
      return;
    }
    if (this.#links.size >= MAX_LINKS) return;
    this.#links.set(url, { text: text.slice(0, 500), url, ...(mismatch ? { mismatch: true as const } : {}) });
  }

  list(): MessageLink[] {
    return [...this.#links.values()];
  }
}

/** Suffixes under which a registrable domain has three labels, not two. */
const MULTI_PART_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "ltd.uk", "plc.uk", "me.uk", "net.uk", "com.au", "net.au", "org.au", "edu.au", "gov.au",
  "co.nz", "org.nz", "co.jp", "ne.jp", "or.jp", "ac.jp", "co.in", "net.in", "org.in", "com.br", "com.cn", "net.cn", "org.cn",
  "com.mx", "co.za", "com.sg", "com.hk", "co.kr", "com.tr", "com.tw", "co.il", "com.ar", "co.id", "com.my", "com.ph",
]);

/** The registrable part of a host name ("mail.contoso.co.uk" → "contoso.co.uk"), in punycode. */
export function registrableDomain(host: string): string {
  let ascii: string;
  try {
    ascii = new URL(`http://${host}`).hostname;
  } catch {
    return host.toLowerCase();
  }
  if (/^[0-9.]+$/.test(ascii) || ascii.startsWith("[")) return ascii;
  const labels = ascii.replace(/\.$/, "").split(".");
  const take = labels.length >= 3 && MULTI_PART_SUFFIXES.has(labels.slice(-2).join(".")) ? 3 : 2;
  return labels.slice(-take).join(".");
}

const URLISH = /^(?:https?:\/\/)?((?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+[\p{L}]{2,})(?::\d+)?(?:[/?#]\S*)?$/u;
const EMAILISH = /^[^\s@]+@((?:[\p{L}\p{N}-]+\.)+[\p{L}]{2,})$/u;

/** Whether a link's visible text names a different site (or email domain) than it goes to. */
export function linkMismatch(text: string, url: string): boolean {
  const shown = text.trim().replace(/^<|>$/g, "");
  const textHost = URLISH.exec(shown)?.[1] ?? (url.startsWith("mailto:") ? EMAILISH.exec(shown)?.[1] : undefined);
  if (textHost === undefined) return false;
  let targetHost: string;
  if (url.toLowerCase().startsWith("mailto:")) {
    let address: string;
    try {
      address = decodeURIComponent(url.slice(7).split("?")[0] ?? "");
    } catch {
      return true;
    }
    targetHost = address.slice(address.lastIndexOf("@") + 1);
  } else {
    try {
      targetHost = new URL(url).hostname;
    } catch {
      return true;
    }
  }
  return registrableDomain(textHost) !== registrableDomain(targetHost);
}

/** A text body as Markdown-ish text: line endings normalized, invisible characters and Safe Links undone. */
function textToMarkdown(content: string, counters: Counters, links: LinkCollector): string {
  let text = content.replace(/\r\n?/g, "\n").replace(INVISIBLE, char => {
    if (char === "\n" || char === "\t") return char;
    counters.invisibleChars++;
    return "";
  });
  text = text.replace(/https?:\/\/[^\s<>"']+/gi, match => {
    const trailing = /[.,;:!?)\]]+$/.exec(match)?.[0] ?? "";
    const bare = trailing ? match.slice(0, -trailing.length) : match;
    const valid = httpUrl(bare);
    if (!valid) return match;
    const { url, unwrapped } = unwrapLink(valid);
    if (unwrapped) counters.unwrapped++;
    links.add(url, url);
    return (unwrapped ? url : bare) + trailing;
  });
  return text.split("\n").map(trimTrailingBlanks).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Cuts Markdown to `maxChars` at a paragraph, line or word boundary near the limit. */
function truncate(markdown: string, maxChars: number): { text: string; truncated: boolean } {
  if (markdown.length <= maxChars) return { text: markdown, truncated: false };
  const window = markdown.slice(0, maxChars);
  const floor = Math.floor(maxChars * 0.6);
  let cut = window.lastIndexOf("\n\n");
  if (cut < floor) cut = window.lastIndexOf("\n");
  if (cut < floor) cut = window.lastIndexOf(" ");
  if (cut < floor) cut = maxChars;
  // Never split a surrogate pair.
  if (cut > 0 && /[\ud800-\udbff]/.test(markdown[cut - 1]!)) cut--;
  return { text: markdown.slice(0, cut).trimEnd(), truncated: true };
}

// -- writing ------------------------------------------------------------------------------------

const FONT = "font-family:Aptos,Calibri,Arial,Helvetica,sans-serif;font-size:11pt";
const MONO = "font-family:Consolas,'Courier New',monospace;font-size:10pt";

/** Markdown as the HTML body of a new message: inline-styled, every character escaped, links checked. */
export function markdownToMailHtml(markdown: string): string {
  const blocks = parseMarkdown(markdown);
  return `<div style="${FONT}">${blocksHtml(blocks)}</div>`;
}

function blocksHtml(blocks: readonly MdBlock[]): string {
  return blocks.map(blockHtml).join("");
}

function blockHtml(block: MdBlock): string {
  switch (block.kind) {
    case "heading": {
      const size = [0, 18, 15, 13, 12, 11, 11][block.level];
      return `<h${block.level} style="margin:12pt 0 6pt;font-size:${size}pt;font-weight:600">${inlinesHtml(block.inlines)}</h${block.level}>`;
    }
    case "paragraph": return `<p style="margin:0 0 8pt">${inlinesHtml(block.inlines)}</p>`;
    case "list": {
      const tag = block.ordered ? "ol" : "ul";
      const start = block.ordered && block.start !== 1 ? ` start="${block.start}"` : "";
      const items = block.items.map(item => {
        const box = item.checked === undefined ? "" : item.checked ? "☒ " : "☐ ";
        const [first, ...rest] = item.blocks;
        const lead = first?.kind === "paragraph" ? box + inlinesHtml(first.inlines) : box + (first ? blockHtml(first) : "");
        return `<li style="margin:0 0 2pt">${lead}${blocksHtml(rest)}</li>`;
      }).join("");
      return `<${tag}${start} style="margin:0 0 8pt;padding-left:24pt">${items}</${tag}>`;
    }
    case "quote":
      return `<blockquote style="margin:0 0 8pt;padding-left:10pt;border-left:3px solid #c8c8c8;color:#555555">${blocksHtml(block.blocks)}</blockquote>`;
    case "code":
      return `<pre style="margin:0 0 8pt;padding:6pt;background:#f4f4f4;${MONO};white-space:pre-wrap">${escapeHtml(block.text)}</pre>`;
    case "table": {
      const cell = (tag: "th" | "td", inlines: readonly MdInline[], index: number) => {
        const align = block.align[index];
        return `<${tag} style="border:1px solid #c8c8c8;padding:4pt 6pt;text-align:${align ?? "left"}${tag === "th" ? ";background:#f2f2f2;font-weight:600" : ""}">${inlinesHtml(inlines)}</${tag}>`;
      };
      const head = `<tr>${block.header.map((inlines, index) => cell("th", inlines, index)).join("")}</tr>`;
      const body = block.rows.map(row => `<tr>${row.map((inlines, index) => cell("td", inlines, index)).join("")}</tr>`).join("");
      return `<table style="border-collapse:collapse;margin:0 0 8pt;${FONT}"><thead>${head}</thead><tbody>${body}</tbody></table>`;
    }
    case "rule": return `<hr style="border:none;border-top:1px solid #c8c8c8;margin:8pt 0">`;
  }
}

function inlinesHtml(inlines: readonly MdInline[]): string {
  return inlines.map(inline => {
    if (inline.kind === "break") return "<br>";
    if (inline.kind === "link") {
      const href = safeMarkdownHref(inline.href);
      const inner = inlinesHtml(inline.children);
      return href ? `<a href="${escapeHtml(href)}">${inner}</a>` : inner;
    }
    let html = escapeHtml(inline.text);
    if (inline.style.code) html = `<code style="${MONO};background:#f4f4f4">${html}</code>`;
    if (inline.style.strike) html = `<s>${html}</s>`;
    if (inline.style.italic) html = `<em>${html}</em>`;
    if (inline.style.bold) html = `<strong>${html}</strong>`;
    return html;
  }).join("");
}

// -- validating what an agent passes --------------------------------------------------------------

/** The longest address Exchange accepts. */
const MAX_ADDRESS_CHARS = 320;
/** The longest subject accepted. */
export const MAX_SUBJECT_CHARS = 255;
/** The longest Markdown body accepted. */
export const MAX_BODY_CHARS = 1_000_000;
/** Graph's limit for an attachment added in one request; larger ones need an upload session. */
export const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;
/** The longest attachment name accepted. */
const MAX_ATTACHMENT_NAME_CHARS = 255;

const ADDRESS = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;

/** A recipient: a bare address, or `Name <address>`. Throws, saying what is wrong, for anything else. */
export function parseRecipient(text: string): EmailAddress {
  if (typeof text !== "string") throw new Error("A recipient must be text, like \"ada@contoso.com\" or \"Ada Lovelace <ada@contoso.com>\".");
  // oxlint-disable-next-line no-control-regex -- refusing control characters, line breaks included, is the point
  if (/[\u0000-\u001f\u007f]/.test(text)) throw new Error(`The recipient "${printable(text)}" contains a line break or control character.`);
  const trimmed = text.trim();
  if (trimmed === "") throw new Error("A recipient can't be empty.");
  // A group ("Team: a@x.com, b@x.com;") names its members before the colon.
  if (/^[^<>"@]*:.*;$/.test(trimmed)) throw new Error(`"${printable(text)}" is a group, which can't be a recipient. Pass each member separately.`);
  let name: string | undefined;
  let address: string;
  const named = /^(.*?)\s*<([^<>]*)>$/.exec(trimmed);
  if (named) {
    const quoted = /^"((?:[^"\\]|\\.)*)"$/.exec(named[1]!.trim());
    name = quoted ? quoted[1]!.replace(/\\(.)/g, "$1").trim() : named[1]!.trim();
    address = named[2]!.trim();
    if (/[<>]/.test(name) || (!quoted && /[",;]/.test(name))) throw new Error(`"${printable(text)}" isn't one recipient. Pass each recipient separately.`);
    if (!quoted && /[()]/.test(name)) throw new Error(`"${printable(text)}" has a comment in it. Quote the name ("Ada (CEO)" <ada@contoso.com>) or leave it out.`);
  } else {
    address = trimmed;
  }
  if (/[,;]/.test(address) || /\s/.test(address) || /@.*@/.test(address)) {
    throw new Error(`"${printable(text)}" looks like more than one recipient. Pass each recipient separately.`);
  }
  if (/[()]/.test(address)) throw new Error(`"${printable(text)}" has a comment in it. Pass just the address.`);
  if (address.length > MAX_ADDRESS_CHARS) throw new Error(`An address can be at most ${MAX_ADDRESS_CHARS} characters.`);
  if (!ADDRESS.test(address)) throw new Error(`"${printable(address)}" isn't an email address.`);
  const at = address.lastIndexOf("@");
  const result: EmailAddress = { address: address.slice(0, at) + address.slice(at).toLowerCase() };
  if (name) {
    if (name.length > 256) throw new Error("A recipient's name can be at most 256 characters.");
    result.name = name;
  }
  return result;
}

/** A recipient list, deduplicated by address (ignoring case). */
export function parseRecipients(list: unknown, field: string, max = 100): EmailAddress[] {
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new Error(`${field} must be a list of recipients.`);
  if (list.length > max) throw new Error(`${field} can have at most ${max} recipients.`);
  const seen = new Set<string>();
  const out: EmailAddress[] = [];
  list.forEach((entry, index) => {
    let parsed: EmailAddress;
    try {
      parsed = parseRecipient(entry as string);
    } catch (error) {
      throw new Error(`${field}[${index}]: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    const key = parsed.address.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(parsed);
  });
  return out;
}

/** Who wrote a message, relative to the mailbox: its owner, someone in one of the organization's domains, or someone else. */
export function senderKind(address: string | undefined, me: string, orgDomains: readonly string[]): SenderKind {
  if (!address) return "external";
  const lower = address.toLowerCase();
  if (lower === me.toLowerCase()) return "you";
  const domain = lower.slice(lower.lastIndexOf("@") + 1);
  return orgDomains.some(org => org.toLowerCase() === domain) ? "internal" : "external";
}

/** Checks a subject: one line, at most 255 characters. */
export function checkSubject(subject: string): string {
  if (typeof subject !== "string") throw new Error("A subject must be text.");
  // oxlint-disable-next-line no-control-regex -- a subject is one line of text
  if (/[\u0000-\u001f\u007f]/.test(subject)) throw new Error("A subject can't contain line breaks or control characters.");
  if (subject.length > MAX_SUBJECT_CHARS) throw new Error(`A subject can be at most ${MAX_SUBJECT_CHARS} characters.`);
  return subject;
}

/** Checks a body's size. */
export function checkBody(markdown: string): string {
  if (typeof markdown !== "string") throw new Error("A body must be text (Markdown).");
  if (markdown.length > MAX_BODY_CHARS) throw new Error(`A body can be at most ${MAX_BODY_CHARS.toLocaleString("en-US")} characters.`);
  return markdown;
}

const CONTENT_TYPES: Record<string, string> = {
  txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json", xml: "application/xml",
  html: "text/html", htm: "text/html", ics: "text/calendar", pdf: "application/pdf", png: "image/png", jpg: "image/jpeg",
  jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", zip: "application/zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  doc: "application/msword", xls: "application/vnd.ms-excel", ppt: "application/vnd.ms-powerpoint",
  eml: "message/rfc822",
};

/** An attachment as name, media type and bytes, checked against Graph's per-request limit. */
export function attachmentBytes(input: AttachmentInput): { name: string; contentType: string; bytes: Uint8Array } {
  if (input === null || typeof input !== "object") throw new Error("An attachment is { name, content }.");
  const { name } = input;
  if (typeof name !== "string" || name.trim() === "") throw new Error("An attachment needs a name.");
  // oxlint-disable-next-line no-control-regex -- a file name has no control characters or path separators
  if (/[\u0000-\u001f\u007f/\\]/.test(name)) throw new Error(`The attachment name "${printable(name)}" can't contain slashes or control characters.`);
  if (name.length > MAX_ATTACHMENT_NAME_CHARS) throw new Error(`An attachment name can be at most ${MAX_ATTACHMENT_NAME_CHARS} characters.`);
  if (name === "." || name === "..") throw new Error(`"${name}" isn't a file name.`);
  const bytes = typeof input.content === "string" ? new TextEncoder().encode(input.content) : input.content;
  if (!(bytes instanceof Uint8Array)) throw new Error(`The content of "${name}" must be text or a Uint8Array.`);
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new Error(`"${name}" is ${(bytes.byteLength / (1024 * 1024)).toFixed(1)} MB; an attachment can be at most ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB. Share a link to a SharePoint or OneDrive file instead.`);
  }
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  const given = typeof input.contentType === "string" ? input.contentType.trim().toLowerCase() : "";
  if (given !== "" && !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(given)) {
    throw new Error(`"${printable(input.contentType ?? "")}" isn't a media type, like "application/pdf".`);
  }
  const contentType = given || CONTENT_TYPES[extension] || (typeof input.content === "string" ? "text/plain" : "application/octet-stream");
  return { name, contentType, bytes };
}

/** Text with control characters shown as escapes, for an error message. */
function printable(text: string): string {
  // oxlint-disable-next-line no-control-regex -- showing control characters visibly
  return text.slice(0, 120).replace(/[\u0000-\u001f\u007f]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
