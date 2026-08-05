// Best-effort conversion between Confluence "storage format" (an XHTML dialect with `ac:`/`ri:`
// macro tags) and Markdown, so the Session API can exchange page/blog bodies as Markdown.
//
// Supported subset (round-trips): headings, paragraphs, bold/italic/strikethrough/inline code,
// links, bullet/numbered lists, task lists, fenced code blocks (with language), blockquotes,
// horizontal rules, tables, and info/note/warning/tip panels. Confluence macros we don't model,
// embedded media, and complex layouts degrade to a best-effort rendering on read and aren't
// reconstructable on write. Don't rely on byte-for-byte fidelity.

import { HTMLElement, TextNode, parse, type Node } from "node-html-parser";

// ---------------------------------------------------------------------------------------------
// storage (XHTML) -> Markdown

// A private-use-area sentinel that won't occur in real content, used to hold extracted CDATA
// (code) out of the HTML parser's reach and substitute it back into the final Markdown.
const CDATA_SENTINEL = "\uE000";

const PANEL_LABELS: Record<string, string> = {
  info: "Info",
  note: "Note",
  warning: "Warning",
  tip: "Tip",
};

// Inline elements that simply wrap their rendered children in fixed delimiters.
const INLINE_WRAPPERS: Record<string, string> = {
  strong: "**", b: "**",
  em: "*", i: "*",
  s: "~~", del: "~~", strike: "~~",
};

export function storageToMarkdown(xhtml: string): string {
  if (!xhtml?.trim()) return "";

  // Lift every CDATA run out before parsing: node-html-parser isn't CDATA-aware and would mangle
  // code containing `<`, `>` or `]]>`. Each run (one or more sections — see the write path's split
  // escaping) decodes to the concatenation of its sections' contents, behind an opaque placeholder
  // that we substitute back into the final Markdown.
  const cdata: string[] = [];
  const protectedXhtml = xhtml.replace(/(?:<!\[CDATA\[[\s\S]*?\]\]>)+/g, run => {
    const content = [...run.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)].map(m => m[1]).join("");
    return `${CDATA_SENTINEL}${cdata.push(content) - 1}${CDATA_SENTINEL}`;
  });

  const root = parse(protectedXhtml, { lowerCaseTagName: false, comment: false });
  return renderBlocks(root.childNodes)
    .trim()
    .replace(new RegExp(`${CDATA_SENTINEL}(\\d+)${CDATA_SENTINEL}`, "g"), (_, n) => cdata[Number(n)] ?? "");
}

const isElement = (node: Node): node is HTMLElement => node instanceof HTMLElement;
const tagOf = (el: HTMLElement): string => (el.rawTagName ?? "").toLowerCase();
const childByTag = (el: HTMLElement, tag: string): HTMLElement | undefined =>
  el.childNodes.find(n => isElement(n) && tagOf(n) === tag) as HTMLElement | undefined;

// Render nodes as block-level Markdown, joined by blank lines.
function renderBlocks(nodes: Node[]): string {
  return nodes
    .map(node => (isElement(node) ? renderBlock(node) : decodeText(node).trim() || null))
    .filter((b): b is string => !!b)
    .join("\n\n");
}

function renderBlock(el: HTMLElement): string | null {
  const tag = tagOf(el);
  const heading = tag.match(/^h([1-6])$/);
  if (heading) return `${"#".repeat(Number(heading[1]))} ${renderInline(el.childNodes)}`.trimEnd();

  switch (tag) {
    case "p": return renderInline(el.childNodes).trim() || null;
    case "ul": return renderList(el, false);
    case "ol": return renderList(el, true);
    case "blockquote": return prefixLines(renderBlocks(el.childNodes), "> ");
    case "hr": return "---";
    case "pre": return fence("", el.text);
    case "table": return renderTable(el);
    case "ac:task-list": return renderTaskList(el);
    case "ac:structured-macro": return renderMacro(el);
    case "br": return null;
    default:
      // Unknown container: descend into its children, or fall back to inline text.
      return el.childNodes.some(isElement)
        ? renderBlocks(el.childNodes) || null
        : renderInline(el.childNodes).trim() || null;
  }
}

function renderList(el: HTMLElement, ordered: boolean): string {
  return (el.childNodes.filter(n => isElement(n) && tagOf(n) === "li") as HTMLElement[])
    .map((li, i) => `${ordered ? `${i + 1}.` : "-"} ${renderInline(li.childNodes).trim()}`)
    .join("\n");
}

function renderTaskList(el: HTMLElement): string {
  return (el.childNodes.filter(n => isElement(n) && tagOf(n) === "ac:task") as HTMLElement[])
    .map(task => {
      const done = childByTag(task, "ac:task-status")?.text.trim() === "complete";
      const body = childByTag(task, "ac:task-body");
      return `- [${done ? "x" : " "}] ${body ? renderInline(body.childNodes).trim() : ""}`;
    })
    .join("\n");
}

function renderMacro(el: HTMLElement): string | null {
  const name = (el.getAttribute("ac:name") ?? "").toLowerCase();

  if (name === "code") {
    return fence(paramValue(el, "language") ?? "", childByTag(el, "ac:plain-text-body")?.text ?? "");
  }
  if (name in PANEL_LABELS) {
    const body = childByTag(el, "ac:rich-text-body");
    const inner = body ? renderBlocks(body.childNodes).trim() : "";
    return prefixLines(`**${PANEL_LABELS[name]}:** ${inner}`.trim(), "> ");
  }

  // Other macros: surface readable inner content, else a labelled placeholder.
  const body = childByTag(el, "ac:rich-text-body") ?? childByTag(el, "ac:plain-text-body");
  const inner = body ? (renderBlocks(body.childNodes).trim() || body.text.trim()) : "";
  return inner || `_[${name || "macro"} macro]_`;
}

const tableRow = (vals: string[]): string => `| ${vals.join(" | ")} |`;
// Escape backslashes as well as pipes so an existing backslash cannot neutralize the pipe escape.
const escapeTableCell = (value: string): string =>
  value.replace(/[\\|]/g, character => `\\${character}`);

function renderTable(el: HTMLElement): string {
  const rows = el.querySelectorAll("tr");
  if (rows.length === 0) return "";
  const cells = (row: HTMLElement) =>
    (row.childNodes.filter(n => isElement(n) && ["td", "th"].includes(tagOf(n))) as HTMLElement[])
      .map(c => escapeTableCell(renderInline(c.childNodes).trim()));

  const header = cells(rows[0]);
  const lines = [tableRow(header), tableRow(header.map(() => "---"))];
  for (const row of rows.slice(1)) lines.push(tableRow(cells(row)));
  return lines.join("\n");
}

function renderInline(nodes: Node[]): string {
  return nodes
    .map(node => {
      if (!isElement(node)) return decodeText(node);
      const tag = tagOf(node);
      if (tag in INLINE_WRAPPERS) {
        const d = INLINE_WRAPPERS[tag];
        return `${d}${renderInline(node.childNodes)}${d}`;
      }
      if (tag === "code") return `\`${node.text}\``;
      if (tag === "a") return `[${renderInline(node.childNodes)}](${node.getAttribute("href") ?? ""})`;
      if (tag === "br") return "\n";
      return renderInline(node.childNodes);
    })
    .join("");
}

const fence = (lang: string, body: string): string => `\`\`\`${lang}\n${body.replace(/\n$/, "")}\n\`\`\``;

function paramValue(macro: HTMLElement, name: string): string | undefined {
  const param = macro.childNodes.find(
    n => isElement(n) && tagOf(n) === "ac:parameter" && n.getAttribute("ac:name") === name,
  ) as HTMLElement | undefined;
  return param?.text.trim();
}

const prefixLines = (text: string, prefix: string): string =>
  text.split("\n").map(line => (prefix + line).trimEnd()).join("\n");

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", nbsp: " ",
};
const decodeEntities = (s: string): string => s.replace(/&(#?\w+);/g, (m, e) => ENTITIES[e] ?? m);
const decodeText = (node: Node): string =>
  decodeEntities(node instanceof TextNode ? node.rawText : node.text);

// ---------------------------------------------------------------------------------------------
// Markdown -> storage (XHTML)

const STRUCTURAL = /^(?:```|#{1,6}\s+|[-*]\s+|\d+\.\s+|>\s?|(?:-{3,}|\*{3,}|_{3,})\s*$)/;
const TASK_ITEM = /^[-*]\s+\[([ xX])\]\s+(.*)$/;

export function markdownToStorage(markdown: string): string {
  const lines = (markdown ?? "").replace(/\r\n/g, "\n").split("\n");
  const blocks: string[] = [];
  let i = 0;

  const collect = (pred: (line: string) => boolean): string[] => {
    const out: string[] = [];
    while (i < lines.length && pred(lines[i])) out.push(lines[i++]);
    return out;
  };

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") { i++; continue; }

    const fenceOpen = line.match(/^```(.*)$/);
    if (fenceOpen) {
      i++;
      const body = collect(l => !/^```\s*$/.test(l));
      i++; // closing fence
      blocks.push(codeMacro(fenceOpen[1].trim(), body.join("\n")));
      continue;
    }

    if (/^(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { blocks.push("<hr/>"); i++; continue; }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      blocks.push(`<h${level}>${inlineToStorage(heading[2].trim())}</h${level}>`);
      i++;
      continue;
    }

    if (TASK_ITEM.test(line)) {
      const tasks = collect(l => TASK_ITEM.test(l)).map(l => {
        const [, mark, text] = l.match(TASK_ITEM)!;
        const status = mark.toLowerCase() === "x" ? "complete" : "incomplete";
        return `<ac:task><ac:task-status>${status}</ac:task-status>` +
          `<ac:task-body>${inlineToStorage(text.trim())}</ac:task-body></ac:task>`;
      });
      blocks.push(`<ac:task-list>${tasks.join("")}</ac:task-list>`);
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      const items = collect(l => /^[-*]\s+/.test(l) && !TASK_ITEM.test(l))
        .map(l => `<li>${inlineToStorage(l.replace(/^[-*]\s+/, "").trim())}</li>`);
      blocks.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      const items = collect(l => /^\d+\.\s+/.test(l))
        .map(l => `<li>${inlineToStorage(l.replace(/^\d+\.\s+/, "").trim())}</li>`);
      blocks.push(`<ol>${items.join("")}</ol>`);
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quoted = collect(l => /^>\s?/.test(l)).map(l => l.replace(/^>\s?/, ""));
      blocks.push(`<blockquote><p>${inlineToStorage(quoted.join(" ").trim())}</p></blockquote>`);
      continue;
    }

    if (line.includes("|") && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(lines[i + 1] ?? "")) {
      const header = splitTableRow(line);
      i += 2; // header + separator
      const body = collect(l => l.includes("|") && l.trim() !== "").map(splitTableRow);
      const cells = (vals: string[], tag: string) =>
        vals.map(v => `<${tag}>${inlineToStorage(v)}</${tag}>`).join("");
      const rows = [`<tr>${cells(header, "th")}</tr>`, ...body.map(r => `<tr>${cells(r, "td")}</tr>`)];
      blocks.push(`<table><tbody>${rows.join("")}</tbody></table>`);
      continue;
    }

    const para = collect(l => l.trim() !== "" && !STRUCTURAL.test(l)).map(l => l.trim());
    blocks.push(`<p>${inlineToStorage(para.join(" "))}</p>`);
  }

  return blocks.join("");
}

// Embed code in a CDATA section, neutralizing any `]]>` so it can't terminate the section early
// and inject storage markup. The standard split (`]]>` -> `]]]]><![CDATA[>`) round-trips when the
// reader concatenates adjacent CDATA sections (see storageToMarkdown).
function codeMacro(language: string, body: string): string {
  const safe = body.replaceAll("]]>", "]]]]><![CDATA[>");
  const param = language ? `<ac:parameter ac:name="language">${escapeHtml(language)}</ac:parameter>` : "";
  return `<ac:structured-macro ac:name="code">${param}` +
    `<ac:plain-text-body><![CDATA[${safe}]]></ac:plain-text-body></ac:structured-macro>`;
}

const splitTableRow = (line: string): string[] =>
  line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(c => c.trim());

// Convert inline Markdown to storage XHTML: code spans, links, bold, strike, italic, with literal
// text HTML-escaped. Recurses for nested emphasis.
function inlineToStorage(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);

    if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i) { out += `<code>${escapeHtml(text.slice(i + 1, end))}</code>`; i = end + 1; continue; }
    }

    const link = rest.match(/^\[([^\]]*)\]\(([^)\s]+)\)/);
    if (link) { out += `<a href="${escapeHtml(link[2])}">${inlineToStorage(link[1])}</a>`; i += link[0].length; continue; }

    const wrapped =
      delimited(rest, "**", "strong") ?? delimited(rest, "~~", "s") ?? delimited(rest, "*", "em");
    if (wrapped) { out += wrapped.html; i += wrapped.length; continue; }

    out += escapeHtml(text[i]);
    i++;
  }
  return out;
}

// Match a `delim...delim` span at the start of `s` and render it as `<tag>...</tag>`.
function delimited(s: string, delim: string, tag: string): { html: string; length: number } | null {
  if (!s.startsWith(delim)) return null;
  const end = s.indexOf(delim, delim.length);
  if (end < delim.length) return null;
  const inner = s.slice(delim.length, end);
  return { html: `<${tag}>${inlineToStorage(inner)}</${tag}>`, length: end + delim.length };
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
