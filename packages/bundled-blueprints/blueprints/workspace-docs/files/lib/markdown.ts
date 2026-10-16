// The Markdown export: the document's block HTML, as the editor and agents write it, rendered as
// Markdown. A Worker has no DOM parser, so the HTML is read as a flat run of tags and text.
//
// The editor formats with `execCommand` under `styleWithCSS`, so the bold, italic and
// strikethrough it applies arrive as `<span style>` rather than `<b>`, `<i>` and `<s>`; both
// spellings export alike, and as in the page the innermost element's say holds, so
// `font-weight: normal` inside bold is plain. Formatting Markdown has no syntax for (underline,
// colour, size, font, alignment) is dropped and its text kept, as is emphasis inside code, which
// shows text verbatim.

type Marker = "**" | "*" | "~~";
/** What one element says about each emphasis: on, off, or (absent) nothing. */
type Emphasis = Partial<Record<Marker, boolean>>;
/** Emphasis turning on or off at an offset into a block's inline Markdown. */
type EmphasisChange = { at: number; marker: Marker; open: boolean };

const MARKERS: Marker[] = ["**", "*", "~~"];
const HTML_TAGS: Record<Marker, string> = { "**": "strong", "*": "em", "~~": "del" };

/** The formatting elements, with the emphasis each implies before its inline style has a say. */
const ELEMENT_EMPHASIS = new Map<string, Emphasis>([
  ["strong", { "**": true }], ["b", { "**": true }],
  ["em", { "*": true }], ["i", { "*": true }],
  ["s", { "~~": true }], ["strike", { "~~": true }], ["del", { "~~": true }],
  ["span", {}], ["font", {}],
]);

/** Tags that end a run of inline content, closing its emphasis and dropping any space or break. */
const BLOCK_TAGS: Record<string, true> = Object.fromEntries([
  "h1", "h2", "h3", "h4", "h5", "h6", "p", "div", "blockquote", "pre", "ul", "ol", "li", "hr",
  "table", "tr", "td", "th",
].map((tag) => [tag, true]));

/** Render block HTML as Markdown, ending with one newline, or as "" when it holds no content. */
export function htmlToMarkdown(html: string): string {
  const tokens = String(html).match(/<!--[\s\S]*?-->|<![^>]*>|<[^>]+>|[^<]+/g) || [];
  const lists: { type: "ul" | "ol"; count: number }[] = [];
  const links: string[] = [];
  const blockquotes: number[] = [];
  // What each open formatting element says about emphasis, and the markers open in the output,
  // outermost first. Markers follow the formatting rather than the elements: they open at the
  // first content that has it and close at the next content or block that does not, before the
  // space between, the only placement Markdown reads (`**Hello **world` keeps its asterisks; an
  // empty `****` is a horizontal rule).
  const frames: Emphasis[] = [];
  const written: Marker[] = [];
  let markdown = "";
  // The current block's inline content and where its emphasis changes, spelled when it ends.
  let inline = "";
  let changes: EmphasisChange[] = [];
  let inPre = false;
  let inCode = false;
  let inHeading = false;
  // Space and `<br>`s since the last content, written only once more content follows: the editor
  // leaves a `<br>` as the sole content of an empty paragraph.
  let space = false;
  let breaks = 0;

  const closeTo = (depth: number) => {
    for (const marker of written.splice(depth).reverse()) {
      changes.push({ at: inline.length, marker, open: false });
    }
  };
  // Inline content is about to be written: close the emphasis it lacks, write the space or breaks
  // before it, then open the emphasis it gains.
  const beginInline = (wanted = emphasisIn(frames)) => {
    let kept = 0;
    while (kept < written.length && wanted.includes(written[kept])) kept++;
    closeTo(kept);
    inline += breaks ? "\\\n".repeat(breaks) : space ? " " : "";
    space = false;
    breaks = 0;
    for (const marker of wanted) {
      if (written.includes(marker)) continue;
      written.push(marker);
      changes.push({ at: inline.length, marker, open: true });
    }
  };
  const endBlock = () => {
    closeTo(0);
    markdown += spellEmphasis(inline, changes);
    inline = "";
    changes = [];
    space = false;
    breaks = 0;
  };

  for (const token of tokens) {
    if (!token.startsWith("<")) {
      const text = decodeHtml(token);
      if (inPre) inline += text;
      else if (inCode) inline += text.replace(/\s+/g, " ");
      else {
        const words = text.replace(/\s+/g, " ").replace(/([\\*_[\]])/g, "\\$1");
        space ||= words.startsWith(" ");
        if (words.trim()) {
          beginInline();
          inline += words.trim();
          space = words.endsWith(" ");
        }
      }
      continue;
    }
    if (token.startsWith("<!--") || token.startsWith("<!")) continue;

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
    if (BLOCK_TAGS[tag]) endBlock();

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
          const start = blockquotes.pop();
          const content = markdown.slice(start).trim().replace(/\n{3,}/g, "\n\n");
          const quoted = content
            ? content.split("\n").map((line) => line ? "> " + line : ">").join("\n")
            : ">";
          markdown = markdown.slice(0, start) + quoted + "\n\n";
          break;
        }
        case "code": if (!inPre) { inline += "\x60"; inCode = false; } break;
        case "pre": markdown += "\n\x60\x60\x60\n\n"; inPre = false; break;
        case "a":
          closeTo(0);
          inline += "](" + (links.pop() ?? "") + ")";
          frames.pop();
          break;
        case "li": if (!markdown.endsWith("\n")) markdown += "\n"; break;
        case "ul": case "ol": lists.pop(); break;
        case "td": case "th": markdown += "\t"; break;
        case "tr": markdown += "\n"; break;
      }
      continue;
    }

    switch (tag) {
      case "h1": case "h2": case "h3": case "h4": case "h5": case "h6":
        inHeading = true;
        markdown += "\n\n" + "#".repeat(Number(tag[1])) + " ";
        break;
      case "p": case "div": markdown += "\n\n"; break;
      // A heading is one line in Markdown, and code one span, so a break in either is a space.
      case "br":
        if (inPre) inline += "\n";
        else if (inCode) inline += " ";
        else if (inHeading) space = true;
        else breaks++;
        break;
      case "code": if (!inPre) { beginInline(); inline += "\x60"; inCode = true; } break;
      case "pre": markdown += "\n\n\x60\x60\x60\n"; inPre = true; break;
      case "blockquote": markdown += "\n\n"; blockquotes.push(markdown.length); break;
      case "hr": markdown += "\n\n---\n\n"; break;
      case "ul": lists.push({ type: "ul", count: 0 }); break;
      case "ol": lists.push({ type: "ol", count: 0 }); break;
      case "li": {
        const list = lists.at(-1) || { type: "ul", count: 0 };
        list.count += 1;
        markdown += (markdown.endsWith("\n") ? "" : "\n") +
          "  ".repeat(Math.max(0, lists.length - 1)) +
          (list.type === "ol" ? list.count + ". " : "- ");
        break;
      }
      // Emphasis cannot pair across a link label's brackets, so the label opens and closes its
      // own; the toolbar's Bold or Italic on a whole link styles the link itself.
      case "a":
        beginInline([]);
        frames.push(styleEmphasis(attributes));
        links.push(readHtmlAttribute(attributes, "href"));
        inline += "[";
        break;
      case "img": {
        beginInline();
        const alt = readHtmlAttribute(attributes, "alt").replace(/[\\[\]]/g, "\\$&");
        inline += "![" + alt + "](" + readHtmlAttribute(attributes, "src") + ")";
        break;
      }
    }
  }
  endBlock();

  const clean = markdown
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return clean ? clean + "\n" : "";
}

/** What a formatting element says about emphasis, or undefined for any other element. */
function emphasisOf(tag: string, attributes: string): Emphasis | undefined {
  const implied = ELEMENT_EMPHASIS.get(tag);
  return implied && { ...implied, ...styleEmphasis(attributes) };
}

/** What an element's inline style says about emphasis, which overrides what its tag implies. */
function styleEmphasis(attributes: string): Emphasis {
  const style = readHtmlAttribute(attributes, "style").toLowerCase();
  const emphasis: Emphasis = {};
  // `lighter` is relative (900 becomes a still-bold 700), so it says nothing.
  const weight = /font-weight\s*:\s*(?:(bold|bolder|[6-9]00)|normal|[1-5]00)\b/.exec(style);
  if (weight) emphasis["**"] = weight[1] !== undefined;
  const slant = /font-style\s*:\s*(?:(italic|oblique)|normal)\b/.exec(style);
  if (slant) emphasis["*"] = slant[1] !== undefined;
  // A descendant cannot lift its ancestor's line-through, so strikethrough only turns on.
  if (/text-decoration(-line)?\s*:[^;]*line-through/.test(style)) emphasis["~~"] = true;
  return emphasis;
}

/** The emphasis in force inside `frames`, in the order it was turned on. */
function emphasisIn(frames: Emphasis[]): Marker[] {
  const on = new Set<Marker>();
  for (const frame of frames) {
    for (const marker of MARKERS) {
      if (frame[marker]) on.add(marker);
      else if (frame[marker] === false) on.delete(marker);
    }
  }
  return [...on];
}

/**
 * A block's inline Markdown with its emphasis changes written in: as asterisks and tildes when
 * CommonMark reads each of their runs as written, and otherwise, as where emphasis changes inside
 * a word (`**A***B**C***`), as inline HTML tags, which Markdown passes through.
 */
function spellEmphasis(text: string, changes: EmphasisChange[]): string {
  const spell = (delimiter: (change: EmphasisChange) => string) => {
    let spelled = "";
    let from = 0;
    for (const change of changes) {
      spelled += text.slice(from, change.at) + delimiter(change);
      from = change.at;
    }
    return spelled + text.slice(from);
  };
  const markdown = spell(({ marker }) => marker);
  if (delimitersReadAsWritten(markdown, changes)) return markdown;
  return spell(({ marker, open }) => `<${open ? "" : "/"}${HTML_TAGS[marker]}>`);
}

/**
 * Whether CommonMark reads each delimiter run that `changes` spelled into `markdown` as written. An
 * opening run must be left- and not right-flanking, or it may close an earlier opener. A closing
 * run need only be right-flanking: the opener it closes is the nearest one waiting. A run that
 * both closes and opens cannot be read as written.
 */
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
    } else {
      runs.push({ start, end: start + marker.length, opens: open, closes: !open });
    }
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

/** A character as CommonMark's flanking rules class it, where a block's edge is space. */
function charClass(char: string | undefined): "space" | "punctuation" | "word" {
  if (char === undefined || /\s/.test(char)) return "space";
  return /[\p{P}\p{S}]/u.test(char) ? "punctuation" : "word";
}

function readHtmlAttribute(source: string, name: string): string {
  const pattern = new RegExp(name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))", "i");
  const match = pattern.exec(source);
  return decodeHtml(match ? match[1] ?? match[2] ?? match[3] ?? "" : "");
}

function decodeHtml(value: string): string {
  return String(value).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_: string, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith("#x")) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
    if (lower.startsWith("#")) return String.fromCodePoint(Number.parseInt(lower.slice(1), 10));
    const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };
    return named[lower];
  });
}
