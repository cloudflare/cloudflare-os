// A deck as structured data, for an agent to read before editing it: each slide's layout, its
// placeholders under stable names it can pass back to `setText`, its other text and tables, its
// pictures, and its speaker notes, all as Markdown.

import { PLAIN, escapeLineStarts, joinLines, renderInlines, renderTable, safeLinkTarget, type Inline, type TextStyle } from "./markdown";
import { parsePart } from "./ooxml";
import { Deck, relKind } from "./pptx-deck";
import { attribute, childAt, childElements, firstChild, firstDescendant, textContent, type XmlElement } from "./xml";

/** One slide, as `describePptx` reports it. */
export interface SlideInfo {
  /** 1-based, in presentation order. */
  readonly number: number;
  /** The layout's name, as PowerPoint shows it ("Title and Content"). */
  readonly layout: string;
  readonly hidden?: boolean;
  /** The slide's text placeholders; `name` is the handle `setText` takes. */
  readonly placeholders: readonly SlidePlaceholder[];
  /** Text boxes and tables that aren't placeholders, as Markdown. */
  readonly otherText: readonly string[];
  readonly images: readonly { readonly name: string; readonly description?: string }[];
  /** The speaker notes, as Markdown. */
  readonly notes?: string;
}

/** A text placeholder on a slide, with its content as Markdown. */
export interface SlidePlaceholder {
  /** "title", "subtitle", "body", "body 2", ... in placeholder order, or the shape's own name for any other kind. */
  readonly name: string;
  readonly type: "title" | "subtitle" | "body" | "other";
  /** The placeholder's index on its layout. */
  readonly index?: number;
  readonly markdown: string;
}

const FURNITURE = new Set(["dt", "ftr", "hdr", "sldNum", "sldImg"]);

/** A placeholder shape on a slide, before naming. */
export interface PlaceholderShape {
  readonly type: string;
  readonly idx: string | undefined;
  readonly name: string;
}

/** The kind a placeholder type reports as: centered titles are titles, content placeholders bodies. */
export function placeholderKind(type: string): SlidePlaceholder["type"] {
  return type === "title" || type === "ctrTitle" ? "title" : type === "subTitle" ? "subtitle" : type === "obj" || type === "body" ? "body" : "other";
}

/**
 * Names for a slide's placeholders, in the order given: "title", "subtitle", "body", "body 2", ...
 * numbered in placeholder index order; anything else by its shape name, made unique.
 */
export function placeholderHandles(shapes: readonly PlaceholderShape[]): string[] {
  const handles: string[] = Array.from({ length: shapes.length }, () => "");
  for (const kind of ["title", "subtitle", "body"] as const) {
    const members = shapes.map((shape, index) => ({ shape, index })).filter(entry => placeholderKind(entry.shape.type) === kind)
      .toSorted((a, b) => Number(a.shape.idx ?? 0) - Number(b.shape.idx ?? 0) || a.index - b.index);
    members.forEach((entry, order) => {
      handles[entry.index] = order === 0 ? kind : `${kind} ${order + 1}`;
    });
  }
  const used = new Set(handles.filter(Boolean));
  shapes.forEach((shape, index) => {
    if (handles[index]) return;
    const base = shape.name.trim() || `placeholder ${shape.idx ?? index}`;
    let name = base;
    for (let copy = 2; used.has(name.toLowerCase()) || used.has(name); copy++) name = `${base} (${copy})`;
    used.add(name.toLowerCase());
    handles[index] = name;
  });
  return handles;
}

/** The placeholder shapes (`p:sp` with a non-furniture `p:ph`) of a slide, in document order. */
export function slidePlaceholders(slide: XmlElement): { shape: XmlElement; info: PlaceholderShape }[] {
  const out: { shape: XmlElement; info: PlaceholderShape }[] = [];
  const walk = (tree: XmlElement | undefined) => {
    for (const child of childElements(tree)) {
      if (child.name === "p:grpSp") walk(child);
      if (child.name !== "p:sp") continue;
      const ph = childAt(child, "p:nvSpPr", "p:nvPr", "p:ph");
      const type = ph ? attribute(ph, "type") ?? "obj" : undefined;
      if (!type || FURNITURE.has(type)) continue;
      out.push({ shape: child, info: { type, idx: attribute(ph, "idx"), name: attribute(childAt(child, "p:nvSpPr", "p:cNvPr"), "name") ?? "" } });
    }
  };
  walk(childAt(slide, "p:cSld", "p:spTree"));
  return out;
}

/** Describes every slide of a deck. Throws `PackageError` or `ZipError` for a file that isn't one. */
export async function describePptx(bytes: Uint8Array): Promise<SlideInfo[]> {
  const deck = await Deck.open(bytes);
  const layoutNames = new Map(deck.layouts().map(layout => [layout.part, layout.name || layout.type]));
  return deck.slides().map((slide, index): SlideInfo => {
    const root = parsePart(deck.pkg.text(slide.part)!);
    const relationships = new Map(deck.pkg.relationships(slide.part).map(relationship => [relationship.id, relationship]));
    const link = (id: string | undefined) => {
      const relationship = id ? relationships.get(id) : undefined;
      return relationship?.external ? safeLinkTarget(relationship.target) : undefined;
    };
    const layoutRelationship = [...relationships.values()].find(relationship => relKind(relationship.type) === "slideLayout");
    const layoutPart = layoutRelationship && deck.pkg.target(slide.part, layoutRelationship);
    const layout = (layoutPart && layoutNames.get(layoutPart)) ?? (layoutPart ? /<p:cSld\b[^>]*\bname="([^"]*)"/.exec(deck.pkg.text(layoutPart) ?? "")?.[1] : undefined) ?? "";

    const found = slidePlaceholders(root);
    const handles = placeholderHandles(found.map(entry => entry.info));
    const placeholders = found.map(({ shape, info }, at): SlidePlaceholder => {
      const kind = placeholderKind(info.type);
      const paragraphs = childElements(firstChild(shape, "p:txBody"), "a:p");
      const markdown = kind === "title"
        ? paragraphs.map(paragraph => joinLines(paragraphMarkdown(paragraph, link), " ")).filter(Boolean).join(" ")
        : textMarkdown(paragraphs, kind === "body", link);
      const index = info.idx !== undefined && /^\d+$/.test(info.idx) ? Number(info.idx) : undefined;
      return { name: handles[at]!, type: kind, ...(index !== undefined ? { index } : {}), markdown };
    });

    const otherText: string[] = [];
    const images: { name: string; description?: string }[] = [];
    const walk = (tree: XmlElement | undefined) => {
      for (const child of childElements(tree)) {
        if (child.name === "p:grpSp") {
          walk(child);
        } else if (child.name === "p:sp" && !childAt(child, "p:nvSpPr", "p:nvPr", "p:ph")) {
          const markdown = textMarkdown(childElements(firstChild(child, "p:txBody"), "a:p"), false, link);
          if (markdown) otherText.push(markdown);
        } else if (child.name === "p:graphicFrame") {
          const table = firstDescendant(child, "a:tbl");
          if (table) otherText.push(tableMarkdown(table, link));
        } else if (child.name === "p:pic") {
          const properties = childAt(child, "p:nvPicPr", "p:cNvPr");
          const description = attribute(properties, "descr") || attribute(properties, "title");
          images.push({ name: attribute(properties, "name") ?? "Picture", ...(description ? { description } : {}) });
        }
      }
    };
    walk(childAt(root, "p:cSld", "p:spTree"));

    const notesPart = deck.notesPart(slide.part);
    let notes: string | undefined;
    if (notesPart) {
      const notesRoot = parsePart(deck.pkg.text(notesPart)!);
      const notesRelationships = new Map(deck.pkg.relationships(notesPart).map(relationship => [relationship.id, relationship]));
      const notesLink = (id: string | undefined) => {
        const relationship = id ? notesRelationships.get(id) : undefined;
        return relationship?.external ? safeLinkTarget(relationship.target) : undefined;
      };
      const body = slidePlaceholders(notesRoot).find(entry => entry.info.type === "body");
      const markdown = body ? textMarkdown(childElements(firstChild(body.shape, "p:txBody"), "a:p"), false, notesLink) : "";
      if (markdown) notes = markdown;
    }
    return {
      number: index + 1, layout,
      ...(attribute(root, "show") === "0" ? { hidden: true } : {}),
      placeholders, otherText, images,
      ...(notes ? { notes } : {}),
    };
  });
}

type LinkResolver = (id: string | undefined) => string | undefined;

/** Paragraphs as Markdown: bulleted where the paragraph or (for body placeholders) the layout bullets them. */
function textMarkdown(paragraphs: readonly XmlElement[], bulletedByDefault: boolean, link: LinkResolver): string {
  const lines: string[] = [];
  let previous = -1;
  for (const paragraph of paragraphs) {
    const markdown = paragraphMarkdown(paragraph, link);
    if (!markdown) continue;
    const properties = firstChild(paragraph, "a:pPr");
    const bulleted = firstChild(properties, "a:buNone") ? false
      : firstChild(properties, "a:buChar") || firstChild(properties, "a:buAutoNum") ? true : bulletedByDefault;
    if (!bulleted) {
      previous = -1;
      lines.push(escapeLineStarts(markdown));
      continue;
    }
    const level = Math.min(Math.max(0, Number.parseInt(attribute(properties, "lvl") ?? "0", 10) || 0), previous + 1);
    previous = level;
    const indent = "  ".repeat(level);
    const marker = firstChild(properties, "a:buAutoNum") ? "1." : "-";
    lines.push(`${indent}${marker} ${escapeLineStarts(markdown).split("\n").join(`\n${indent}  `)}`);
  }
  // List items stay together; anything else is its own paragraph.
  return lines.reduce((text, line, at) => at === 0 ? line : `${text}${/^\s*(-|1\.) /.test(line) && /^\s*(-|1\.) /.test(lines[at - 1]!) ? "\n" : "\n\n"}${line}`, "");
}

/** One DrawingML paragraph's runs, fields and breaks as Markdown inline text. */
export function paragraphMarkdown(paragraph: XmlElement, link: LinkResolver): string {
  const inlines: Inline[] = [];
  for (const child of childElements(paragraph)) {
    if (child.name === "a:br") {
      inlines.push({ kind: "break" });
    } else if (child.name === "a:r" || child.name === "a:fld") {
      const properties = firstChild(child, "a:rPr");
      const textElement = firstChild(child, "a:t");
      inlines.push({ kind: "text", text: textElement ? textContent(textElement) : "", style: runStyle(properties), href: link(attribute(firstChild(properties, "a:hlinkClick"), "r:id")) });
    }
  }
  return renderInlines(inlines, "\n").trim();
}

function runStyle(properties: XmlElement | undefined): TextStyle {
  if (!properties) return PLAIN;
  const on = (name: string) => ["1", "true"].includes(attribute(properties, name) ?? "");
  const typeface = attribute(firstChild(properties, "a:latin"), "typeface") ?? "";
  return { bold: on("b"), italic: on("i"), strike: (attribute(properties, "strike") ?? "noStrike") !== "noStrike", code: /consolas|courier|mono/i.test(typeface) };
}

function tableMarkdown(table: XmlElement, link: LinkResolver): string {
  const rows = childElements(table, "a:tr").map(row => childElements(row, "a:tc").map(cell => {
    if (["1", "true"].includes(attribute(cell, "hMerge") ?? "") || ["1", "true"].includes(attribute(cell, "vMerge") ?? "")) return "";
    return childElements(firstChild(cell, "a:txBody"), "a:p").map(paragraph => paragraphMarkdown(paragraph, link)).filter(Boolean).join(" ");
  }));
  return renderTable(rows);
}
