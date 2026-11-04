// ── HTML → Markdown ──────────────────────────────────────────────────────────
// A Worker has no DOM parser, so block HTML is read as a flat run of tags and
// text. Emphasis follows the *formatting*, not the elements: `<b>`/`<i>`/`<s>`
// and the inline styles older documents (and pasted HTML) carry export alike,
// and the innermost element's say holds (`font-weight: normal` inside bold is
// plain). Markers open at the first text that has the formatting and close
// before the space after it -- the only placement Markdown reads
// (`**Hello **world` shows its asterisks; an empty `****` is a rule). Where
// emphasis changes inside a word and asterisks could pair differently than
// written, the block spells it as inline <strong>/<em>/<del> instead.
// Underline, colour, size, font and alignment have no Markdown and are dropped.
//
// Used by the server for the Markdown export, `getMarkdown` and the block
// API's descriptions; `readHtmlAttribute` and `decodeHtml` are the block API's
// too.

type EmphasisMarker = "**" | "*" | "~~";
/** What one element says about each kind of emphasis: on, off, or (absent) nothing. */
type Emphasis = Partial<Record<EmphasisMarker, boolean>>;
/** Where a block's emphasis opens or closes, as an offset into its inline text. */
interface EmphasisChange {
  at: number;
  marker: EmphasisMarker;
  open: boolean;
}
type Bullet = "-" | "*" | "." | ")";
interface OpenList {
  type: "ul" | "ol" | "check";
  count: number;
  bullet: Bullet;
  /** Spaces that put a line under the current item's text, after a hard break. */
  indent?: string;
  /** Spaces that put a list nested in the current item under its content. */
  nest?: string;
}
interface OpenTable {
  rows: OpenRow[];
  /** Whether the rows being read are in a <thead>. */
  inHead: boolean;
  /** Where the open cell's Markdown begins, or null between cells. */
  cellStart: number | null;
}
interface OpenRow {
  cells: string[];
  /** Each cell's alignment: "center", "right", or "" for the default. */
  aligns: string[];
  /** A header row: in a <thead>, or of <th>s only. */
  head: boolean;
}

const EMPHASIS_MARKERS: EmphasisMarker[] = ["**", "*", "~~"];
const EMPHASIS_TAGS: Record<EmphasisMarker, string> = { "**": "strong", "*": "em", "~~": "del" };
// The formatting elements, with the emphasis each implies before its inline style has a say.
const ELEMENT_EMPHASIS = new Map<string, Emphasis>([
  ["strong", { "**": true }], ["b", { "**": true }],
  ["em", { "*": true }], ["i", { "*": true }],
  ["s", { "~~": true }], ["strike", { "~~": true }], ["del", { "~~": true }],
  ["span", {}], ["font", {}], ["u", {}], ["mark", {}],
]);
// Tags that end a run of inline content, closing its emphasis.
const MD_BLOCK_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "p", "div", "blockquote", "pre", "ul", "ol", "li", "hr", "table", "tr", "td", "th"]);
// A second top-level list right after another switches to the other marker of its kind.
const OTHER_BULLET: Record<Bullet, Bullet> = { "-": "*", "*": "-", ".": ")", ")": "." };

// "1. x", "- x", "# x", "+ x" and any ">" would otherwise start a list, heading or quote.
function escapeLineStart(text: string): string {
  return text.replace(/^(\d{1,9})([.)])(?=\s|$)/, "$1\\$2").replace(/^(>|[#+-](?=[\s#>+-]|$))/, "\\$1");
}

/**
 * `html` as Markdown. `abbreviateImages` writes a long `data:` image source as its short
 * reference (`abbreviateDataUri`): the block API's reads do, the Markdown export does not.
 */
export function htmlToMarkdown(html: string, { abbreviateImages = false } = {}): string {
  const tokens = String(html).match(/<!--[\s\S]*?-->|<![^>]*>|<[^>]+>|[^<]+/g) || [];
  const lists: OpenList[] = [];
  // Each open link's Markdown destination, or null for one written as plain text.
  const links: (string | null)[] = [];
  const blockquotes: number[] = [];
  const tables: OpenTable[] = [];
  // The last top-level list: its marker, and where the Markdown after it begins.
  const lastList: { bullet: Bullet | null; end: number } = { bullet: null, end: -1 };
  // What each open formatting element says about emphasis, and the markers
  // open in the output, outermost first.
  const frames: Emphasis[] = [];
  const written: EmphasisMarker[] = [];
  let markdown = "";
  // The current block's inline content and where its emphasis changes,
  // spelled out when the block ends.
  let inline = "";
  let changes: EmphasisChange[] = [];
  let inPre = false, inCode = false, inHeading = false, preStart = 0, codeStart = 0;
  // The code span last closed: where it ends, and its code, so one that opens
  // right there continues it (`a``b` would read as one span holding a backtick).
  let lastCode = { start: 0, end: -1, code: "", changes: 0 };
  // Space and <br>s since the last content, written only once more content
  // follows: an empty line is a lone <br>, and a break that ends a block
  // breaks nothing.
  let space = false, breaks = 0;
  const inCell = () => tables.at(-1)?.cellStart != null;
  const closeTo = (depth: number) => {
    for (const marker of written.splice(depth).reverse()) changes.push({ at: inline.length, marker, open: false });
  };
  // Inline content is about to be written: close the emphasis it lacks, write
  // the space or breaks before it, then open the emphasis it gains.
  const beginInline = (wanted = emphasisIn(frames)) => {
    let kept = 0;
    while (kept < written.length && wanted.includes(written[kept])) kept++;
    closeTo(kept);
    // A hard break is a backslash ending the line (after two spaces, a second
    // break in a row would leave a blank line, ending the paragraph), indented
    // under a list item's text so the item continues. Table cells take a plain
    // "\n" (written as <br>).
    inline += breaks ? (inCell() ? "\n" : "\\\n" + (lists.at(-1)?.indent ?? "")).repeat(breaks) : space ? " " : "";
    space = false;
    breaks = 0;
    for (const marker of wanted) {
      if (written.includes(marker)) continue;
      written.push(marker);
      changes.push({ at: inline.length, marker, open: true });
    }
  };
  // A code span that starts or ends with a backtick (or a space at both ends)
  // is padded with spaces, which reading it back drops.
  const closeCode = () => {
    const code = inline.slice(codeStart), fence = codeFence(code, 1);
    const pad = /^`|`$|^ .*[^ ].* $/.test(code) ? " " : "";
    inline = inline.slice(0, codeStart) + fence + pad + code + pad + fence;
    inCode = false;
    lastCode = { start: codeStart, end: inline.length, code, changes: changes.length };
  };
  const endBlock = () => {
    if (inCode) closeCode();
    lastCode.end = -1;
    closeTo(0);
    // A closing run of #s would be read as the heading's closing sequence, not its text.
    const spelled = spellEmphasis(inline, changes);
    markdown += inHeading ? spelled.replace(/ (#+)$/, " \\$1") : spelled;
    inline = "";
    changes = [];
    space = false;
    breaks = 0;
  };
  for (const token of tokens) {
    if (!token.startsWith("<")) {
      // Zero-width spaces only let the caret escape code and links.
      const text = decodeHtml(token).replace(/​/g, "");
      if (inPre) inline += text;
      // Backslash escapes are literal inside a code span, so none there.
      else if (inCode) inline += text.replace(/\s+/g, " ");
      else {
        const flat = text.replace(/\s+/g, " ");
        space ||= flat.startsWith(" ");
        if (flat.trim()) {
          // At the start of a line, text that reads as a heading, quote, list or rule marker is escaped.
          const lineStart = !inline || breaks > 0;
          beginInline();
          // A bare URL keeps its _ and * as written, which GFM links whole
          // (`a\_b` would link to `a%5C_b`) -- where the reader links it too:
          // after a space, "(" or the line's start in the Markdown written, not
          // after emphasis or an image, and not in a link's label.
          const bareAtStart = /(?:^|[\s(])$/.test(inline) && changes.at(-1)?.at !== inline.length;
          // (Doubled tildes would read as strikethrough; a lone one is left as it is.)
          const words = flat.trim()
            .replace(/(?<![^\s(])(https?:\/\/[^\s<]+)|[\\*_[\]<`]/g, (m, url: string | undefined, at: number) =>
              m.replace(url && links.at(-1) == null && (at > 0 || bareAtStart) ? /[\\[\]`]/g : /[\\*_[\]<`]/g, "\\$&"))
            .replace(/~(?=~)|(?<=~)~/g, "\\~");
          inline += lineStart ? escapeLineStart(words) : words;
          space = flat.endsWith(" ");
        }
      }
      continue;
    }
    if (token.startsWith("<!")) continue;
    const match = /^<\s*(\/?)\s*([a-z0-9]+)([^>]*)>/i.exec(token);
    if (!match) continue;
    const closing = match[1] === "/";
    const tag = match[2].toLowerCase();
    const attributes = match[3];
    const emphasis = emphasisOf(tag, attributes);
    if (emphasis) {
      if (closing) frames.pop();
      else frames.push(emphasis);
      continue;
    }
    if (MD_BLOCK_TAGS.has(tag)) endBlock();
    if (closing) {
      switch (tag) {
        case "h1": case "h2": case "h3": case "h4": case "h5": case "h6":
          inHeading = false;
          markdown += "\n\n";
          break;
        case "p": case "div":
          markdown += "\n\n";
          break;
        case "blockquote": {
          const start = blockquotes.pop() ?? markdown.length;
          // An indent (the editor's <blockquote style="margin…">) is not a quote.
          if (start < 0) { markdown += "\n\n"; break; }
          const content = markdown.slice(start).trim().replace(/\n{3,}/g, "\n\n");
          const quoted = content ? content.split("\n").map((line) => line ? "> " + line : ">").join("\n") : ">";
          markdown = markdown.slice(0, start) + quoted + "\n\n";
          break;
        }
        case "code":
          if (!inPre && inCode) closeCode();
          break;
        case "pre": {
          // Each code line ends in \u0001, so the cleanup below keeps its trailing space and blank lines.
          const code = markdown.slice(preStart), fence = codeFence(code);
          markdown = markdown.slice(0, preStart) + fence + "\n" + (code + "\n").replace(/\n/g, "\u0001\n") + fence + "\n\n";
          inPre = false;
          break;
        }
        case "a": {
          const destination = links.pop();
          // Emphasis can't pair across a link label's brackets: the label
          // opens and closes its own.
          if (destination != null) {
            closeTo(0);
            inline += "](" + destination + ")";
          }
          frames.pop();
          break;
        }
        case "li":
          if (!markdown.endsWith("\n")) markdown += "\n";
          break;
        case "ul": case "ol":
          lists.pop();
          if (!lists.length) { markdown += "\n\n"; lastList.end = markdown.length; }
          break;
        case "thead": {
          const table = tables.at(-1);
          if (table) table.inHead = false;
          break;
        }
        case "td": case "th": {
          // A cell's Markdown is cut out of the stream and kept for its row.
          const table = tables.at(-1);
          if (!table || table.cellStart === null) break;
          const text = markdown.slice(table.cellStart).trim().replace(/\s*\n+\s*/g, "<br>").replace(/(?<!\\)(<br>)+$/, "").replace(/\|/g, "\\|");
          markdown = markdown.slice(0, table.cellStart);
          table.cellStart = null;
          table.rows.at(-1)!.cells.push(text);
          break;
        }
        case "table": {
          const rows = tables.pop()?.rows.filter((r) => r.cells.length) ?? [];
          if (!rows.length) break;
          // GFM has no table without a header row: one without gets an empty
          // header row, which is how it reads back, so an empty header row of
          // its own keeps a <br>.
          const cells = rows.map((r) => r.cells);
          if (!rows[0].head) cells.unshift([]);
          else if (cells[0].every((c) => !c)) cells[0][0] = "<br>";
          const cols = Math.max(...cells.map((r) => r.length));
          // Columns are padded to line up, but only up to a point: a long
          // cell (an image's data URI, say) runs on rather than padding the rest.
          const widths = Array.from({ length: cols }, (_, i) => Math.max(3, Math.min(40, Math.max(...cells.map((r) => (r[i] || "").length)))));
          const line = (r: string[]) => "| " + widths.map((w, i) => (r[i] || "").padEnd(w)).join(" | ") + " |";
          // Markdown aligns whole columns: a column takes an alignment its cells all share.
          const delimiter = (w: number, i: number) => {
            const column = new Set(rows.map((r) => r.aligns[i] ?? ""));
            const align = column.size === 1 ? [...column][0] : "";
            return align === "center" ? ":" + "-".repeat(w - 2) + ":" : align === "right" ? "-".repeat(w - 1) + ":" : "-".repeat(w);
          };
          markdown += "\n\n" + [line(cells[0]), "| " + widths.map(delimiter).join(" | ") + " |", ...cells.slice(1).map(line)].join("\n") + "\n\n";
          break;
        }
      }
      continue;
    }
    switch (tag) {
      case "h1": case "h2": case "h3": case "h4": case "h5": case "h6":
        inHeading = true;
        markdown += "\n\n" + "#".repeat(Number(tag[1])) + " ";
        break;
      case "p": case "div":
        markdown += "\n\n";
        break;
      // A heading is one line in Markdown, and inline code one span, so a
      // break in either is a space.
      case "br":
        if (inPre) inline += "\n";
        else if (inCode) inline += " ";
        else if (inHeading) space = true;
        else breaks++;
        break;
      case "code":
        if (!inPre && !inCode) {
          beginInline();
          if (inline.length === lastCode.end && changes.length === lastCode.changes) {
            codeStart = lastCode.start;
            inline = inline.slice(0, codeStart) + lastCode.code;
          } else codeStart = inline.length;
          inCode = true;
        }
        break;
      case "pre":
        markdown += "\n\n";
        preStart = markdown.length;
        inPre = true;
        break;
      case "blockquote":
        markdown += "\n\n";
        blockquotes.push(/margin/.test(readHtmlAttribute(attributes, "style")) ? -1 : markdown.length);
        break;
      case "hr":
        markdown += "\n\n---\n\n";
        break;
      case "table":
        tables.push({ rows: [], inHead: false, cellStart: null });
        break;
      case "thead": {
        const table = tables.at(-1);
        if (table) table.inHead = true;
        break;
      }
      case "tr":
        tables.at(-1)?.rows.push({ cells: [], aligns: [], head: true });
        break;
      case "td": case "th": {
        const table = tables.at(-1);
        if (table) {
          table.cellStart = markdown.length;
          const align = (/text-align:\s*(center|right)/i.exec(readHtmlAttribute(attributes, "style"))?.[1] ?? readHtmlAttribute(attributes, "align")).toLowerCase();
          if (!table.rows.length) table.rows.push({ cells: [], aligns: [], head: true });
          const row = table.rows.at(-1)!;
          row.aligns.push(align === "center" || align === "right" ? align : "");
          if (tag === "td" && !table.inHead) row.head = false;
        }
        break;
      }
      case "ul": case "ol": {
        const isChecklist = tag === "ul" && (/(^|\s)checklist(\s|$)/.test(readHtmlAttribute(attributes, "class")) || lists.at(-1)?.type === "check");
        // Two top-level lists side by side are one list to Markdown, blank
        // line or not, unless the second changes its marker ("-" -> "*",
        // "1." -> "1)").
        let bullet: Bullet = tag === "ol" ? "." : "-";
        if (!lists.length) {
          if (lastList.bullet !== null && lastList.end === markdown.length && (tag === "ol") === (lastList.bullet === "." || lastList.bullet === ")")) bullet = OTHER_BULLET[lastList.bullet];
          lastList.bullet = bullet;
        }
        // A numbered list may start past 1 (`<ol start="3">`).
        const start = /^\s*(\d{1,9})\s*$/.exec(readHtmlAttribute(attributes, "start"))?.[1];
        lists.push({ type: isChecklist ? "check" : tag, count: start ? Number(start) - 1 : 0, bullet });
        break;
      }
      case "li": {
        const list = lists.at(-1) || { type: "ul", count: 0, bullet: "-" };
        list.count += 1;
        const b = list.bullet;
        const marker = list.type === "ol" ? list.count + b + " " : list.type === "check" ? (readHtmlAttribute(attributes, "data-checked") === "true" ? b + " [x] " : b + " [ ] ") : b + " ";
        const lead = lists.at(-2)?.nest ?? "";
        list.indent = lead + " ".repeat(marker.length);
        // A to-do's "[ ] " is its content, and four spaces past that would be code.
        list.nest = lead + " ".repeat(list.type === "check" ? b.length + 1 : marker.length);
        markdown += (markdown.endsWith("\n") ? "" : "\n") + lead + marker;
        break;
      }
      case "a": {
        // A link with no URL, or a script URL (which stripUnsafe removes), keeps only its label.
        const href = readHtmlAttribute(attributes, "href");
        const destination = !href.trim() || isScriptUrl(href) ? null : markdownDestination(href);
        if (destination !== null) {
          beginInline([]);
          // A "!" right before the label would make the link an image.
          if (!inCode && inline.endsWith("!") && changes.at(-1)?.at !== inline.length) inline = inline.slice(0, -1) + "\\!";
          inline += "[";
        }
        frames.push(styleEmphasis(attributes));
        links.push(destination);
        break;
      }
      case "img": {
        const src = readHtmlAttribute(attributes, "src");
        if (isScriptUrl(src)) break;
        beginInline();
        const alt = readHtmlAttribute(attributes, "alt").replace(/[\\[\]]/g, "\\$&");
        // The abbreviated reference is written as is: it is matched literally when sent back.
        const abbreviated = abbreviateImages ? abbreviateDataUri(src) : src;
        inline += "![" + alt + "](" + (abbreviated === src ? markdownDestination(src) : abbreviated) + ")";
        break;
      }
    }
  }
  endBlock();
  const clean = markdown.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/\u0001/g, "").trim();
  return clean ? clean + "\n" : "";
}

/**
 * Whether `url` runs script or a document when followed: `javascript:`, `vbscript:`, or a `data:`
 * URI other than an image. Entities, backslash escapes and whitespace a Markdown renderer or a
 * browser would remove (`java&Tab;script:`, `javascript\:`) are removed before the scheme is read.
 */
function isScriptUrl(url: string): boolean {
  const compact = decodeHtml(url).replace(/&[a-z][a-z0-9]*;?/gi, "").replace(/\\(?=[!-/:-@[-`{-~])/g, "").replace(/[\s\u0000-\u001f]+/g, "").toLowerCase();
  return /^(javascript|vbscript):/.test(compact) || compact.startsWith("data:") && !compact.startsWith("data:image/");
}

// `url` as a Markdown link destination: the characters that would end or break it (space, parens,
// angle brackets, a backslash escaping the closing paren, control characters) percent-encoded,
// which the block API's own Markdown reader also accepts.
function markdownDestination(url: string): string {
  return url.replace(/[\s()<>\\\u0000-\u001f\u007f]/g, (c) => c.charCodeAt(0) < 0x80 ? "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0") : encodeURIComponent(c));
}

// What a formatting element says about emphasis, or undefined for any other element.
function emphasisOf(tag: string, attributes: string): Emphasis | undefined {
  const implied = ELEMENT_EMPHASIS.get(tag);
  return implied && { ...implied, ...styleEmphasis(attributes) };
}

// What an element's inline style says, which overrides what its tag implies.
function styleEmphasis(attributes: string): Emphasis {
  const style = readHtmlAttribute(attributes, "style").toLowerCase();
  const emphasis: Emphasis = {};
  // `lighter` is relative (900 becomes a still-bold 700), so it says nothing.
  const weight = /font-weight\s*:\s*(?:(bold|bolder|[6-9]00)|normal|[1-5]00)\b/.exec(style);
  if (weight) emphasis["**"] = weight[1] !== undefined;
  const slant = /font-style\s*:\s*(?:(italic|oblique)|normal)\b/.exec(style);
  if (slant) emphasis["*"] = slant[1] !== undefined;
  // A descendant can't lift its ancestor's line-through, so it only turns on.
  if (/text-decoration(-line)?\s*:[^;]*line-through/.test(style)) emphasis["~~"] = true;
  return emphasis;
}

// The emphasis in force inside `frames`, in the order it was turned on.
function emphasisIn(frames: Emphasis[]): EmphasisMarker[] {
  const on = new Set<EmphasisMarker>();
  for (const frame of frames) {
    for (const marker of EMPHASIS_MARKERS) {
      if (frame[marker]) on.add(marker);
      else if (frame[marker] === false) on.delete(marker);
    }
  }
  return [...on];
}

// A block's inline Markdown with its emphasis changes written in: as asterisks
// and tildes when CommonMark reads each run as written, otherwise (emphasis
// changing inside a word, `**A***B**C***`) as inline HTML tags.
function spellEmphasis(text: string, changes: EmphasisChange[]): string {
  const spell = (delimiter: (change: EmphasisChange) => string) => {
    let spelled = "", from = 0;
    for (const change of changes) {
      spelled += text.slice(from, change.at) + delimiter(change);
      from = change.at;
    }
    return spelled + text.slice(from);
  };
  const markdown = spell(({ marker }) => marker);
  if (delimitersReadAsWritten(markdown, changes)) return markdown;
  return spell(({ marker, open }) => `<${open ? "" : "/"}${EMPHASIS_TAGS[marker]}>`);
}

// Whether CommonMark reads each delimiter run as written. An opening run must
// be left- and not right-flanking (or it may close an earlier opener); a
// closing run need only be right-flanking. A run that both closes and opens
// can't be read as written.
function delimitersReadAsWritten(markdown: string, changes: EmphasisChange[]): boolean {
  const runs: { start: number; end: number; opens: boolean; closes: boolean }[] = [];
  let shift = 0;
  for (const { at, marker, open } of changes) {
    const start = at + shift;
    shift += marker.length;
    const run = runs.at(-1);
    if (run?.end === start && markdown[run.start] === marker[0]) {
      run.end += marker.length;
      run.opens ||= open;
      run.closes ||= !open;
    } else runs.push({ start, end: start + marker.length, opens: open, closes: !open });
  }
  return runs.every(({ start, end, opens, closes }) => {
    // Whole code points, since an emoji is a symbol and so punctuation.
    const before = charClass(markdown.slice(Math.max(start - 2, 0), start).match(/.$/su)?.[0]);
    const after = charClass(markdown.slice(end, end + 2).match(/^./su)?.[0]);
    const leftFlanking = after !== "space" && (after !== "punctuation" || before !== "word");
    const rightFlanking = before !== "space" && (before !== "punctuation" || after !== "word");
    return opens ? !closes && leftFlanking && !rightFlanking : rightFlanking;
  });
}

// A character as CommonMark's flanking rules class it; a block's edge is space.
function charClass(char: string | undefined): "space" | "punctuation" | "word" {
  if (char === undefined || /\s/.test(char)) return "space";
  return /[\p{P}\p{S}]/u.test(char) ? "punctuation" : "word";
}

/** The decoded value of attribute `name` in a tag's attribute source, or "" when it has none. */
// A code fence (or, with `min` 1, a code span's delimiter) longer than any
// run of backticks in `code`, so none of them can close it early.
export function codeFence(code: string, min = 3): string {
  return "`".repeat((code.match(/`+/g) ?? []).reduce((longest, run) => Math.max(longest, run.length), min - 1) + 1);
}
// Whether `line` closes the fence `open` began: the same character, at least
// as many, and nothing else.
export function closesFence(line: string, open: string): boolean {
  const t = line.trim();
  return t.length >= open.length && t === open[0].repeat(t.length);
}

export function readHtmlAttribute(source: string, name: string): string {
  // Attributes are read one by one, so neither another attribute ending in the name (`data-src`
  // for `src`) nor text inside another's value (`alt="x src=y"`) is mistaken for it.
  const wanted = name.toLowerCase();
  const pattern = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (let match: RegExpExecArray | null; (match = pattern.exec(source)); ) {
    if (match[1].toLowerCase() === wanted) return decodeHtml(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return "";
}

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/**
 * `value` with the entities the editor's serializer writes (numeric, and the few named ones)
 * decoded. `&nbsp;` becomes a plain space: the text is headed for Markdown and attribute values.
 */
export function decodeHtml(value: string): string {
  return String(value).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith("#")) {
      const code = lower.startsWith("#x") ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
      // Out of Unicode's range (or a surrogate): the replacement character, as browsers decode it.
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "\ufffd";
    }
    return NAMED_ENTITIES[lower];
  });
}

// ── Abbreviated images ───────────────────────────────────────────────────────
// A pasted screenshot is a `data:` URI of tens of thousands of characters, which
// the block API's Markdown would hand an agent whole. Its reads write a long one
// as `data:image/jpeg;… 57 KB #1a2b3c4d` instead: the type, the decoded size, and
// a hash of the full URI. Markdown or specs sent back with that reference get the
// document's image it names (`expandImageRefs`), so a round trip keeps the image,
// and a reference to an image the document no longer holds is refused.

const ABBREVIATE_OVER = 256;
const IMAGE_REF = /data:(image\/[a-z0-9.+-]+);… [\d.]+ (?:B|KB|MB) #([0-9a-f]{8})/gi;

/** `src` itself, or for a long `data:` URI the short reference that stands for it. */
export function abbreviateDataUri(src: string): string {
  const match = /^data:([^;,]+)[^,]*,/i.exec(src);
  if (!match || src.length <= ABBREVIATE_OVER) return src;
  const payload = src.length - match[0].length;
  const bytes = /;base64,$/i.test(match[0]) ? Math.floor(payload * 3 / 4) : payload;
  const size = bytes < 1024 ? bytes + " B" : bytes < 1024 * 1024 ? Math.round(bytes / 1024) + " KB" : (bytes / 1024 / 1024).toFixed(1) + " MB";
  return `data:${match[1].toLowerCase()};… ${size} #${hashString(src)}`;
}

/**
 * `value` (any JSON-like argument) with every abbreviated image reference in its strings
 * replaced by the full `data:` URI of the image in `blocks` it names. Throws for a reference
 * to an image none of them holds, rather than storing the reference as the image.
 */
export function expandImageRefs<T>(value: T, blocks: { html: string }[]): T {
  let images: Map<string, string> | null = null;
  const lookup = () => {
    if (images) return images;
    images = new Map();
    for (const block of blocks) {
      for (const tag of block.html.match(/<img\b[^>]*>/gi) || []) {
        const src = readHtmlAttribute(tag.slice(4), "src");
        if (src.startsWith("data:")) images.set(hashString(src), src);
      }
    }
    return images;
  };
  const expand = (item: unknown): unknown => {
    if (typeof item === "string") {
      if (!item.includes(";… ")) return item;
      return item.replace(IMAGE_REF, (ref, type: string, hash: string) => {
        const src = lookup().get(hash.toLowerCase());
        if (!src || !src.toLowerCase().startsWith("data:" + type.toLowerCase())) {
          throw new Error(`"${ref}" is an abbreviated image that is no longer in the document. Keep an image by passing its reference unchanged while the image is in the document, or pass a full data: URI (from getBlocks' html).`);
        }
        return src;
      });
    }
    if (Array.isArray(item)) return item.map(expand);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, field]) => [key, expand(field)]));
    return item;
  };
  return expand(value) as T;
}

// FNV-1a: a short, stable name for an image, not a security boundary (a reference only
// ever resolves to an image already in the same document).
function hashString(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 0x01000193);
  return (hash >>> 0).toString(16).padStart(8, "0");
}
