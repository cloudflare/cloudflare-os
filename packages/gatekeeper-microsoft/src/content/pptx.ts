// PowerPoint (.pptx, .pptm, .potx, .potm, .ppsx, .ppsm) to Markdown: one section per slide, in the
// order presentation.xml lists them (slide part names say nothing about order), with the title
// placeholder as the heading, body text as bullets by paragraph level, tables, image placeholders,
// and the speaker notes.

import {
  MarkdownWriter, PLAIN, escapeLineStarts, imagePlaceholder, joinLines, renderInlines, renderTable, safeLinkTarget,
  type Block, type Inline, type TextStyle,
} from "./markdown";
import {
  findMainPart, findRelationship, readPart, readRelationships, type ConvertedMarkdown, type OfficeConversionOptions,
  type Relationships,
} from "./ooxml";
import { attribute, childAt, childElements, descendants, firstChild, firstDescendant, textContent, type XmlElement } from "./xml";
import { openZip, type ZipArchive } from "./zip";

/** Converts a presentation to Markdown. Throws `DocumentConversionError`, `ZipError` or `XmlError`. */
export async function pptxToMarkdown(bytes: Uint8Array, options: OfficeConversionOptions = {}): Promise<ConvertedMarkdown> {
  const zip = openZip(bytes);
  const mainPart = await findMainPart(zip, "ppt/presentation.xml");
  const presentation = await readPart(zip, mainPart);
  const relationships = await readRelationships(zip, mainPart);
  const warnings = new Set<string>();
  const writer = new MarkdownWriter(options.maxChars);

  let number = 0;
  // A slide list naming one part many times reads it once; each repeat would cost a full parse.
  const rendered = new Set<string>();
  for (const slideId of childElements(childAt(presentation, "p:sldIdLst"), "p:sldId")) {
    if (!writer.hasRoom) break;
    const relationship = relationships.get(attribute(slideId, "r:id") ?? "");
    if (!relationship || relationship.external || relationship.type !== "slide" || !zip.has(relationship.target)) continue;
    if (rendered.has(relationship.target)) continue;
    rendered.add(relationship.target);
    number++;
    for (const block of await renderSlide(zip, relationship.target, number, { warnings, writer })) writer.push(block);
  }
  return { markdown: writer.toString(), warnings: [...warnings], truncated: writer.truncated };
}

/** What every slide shares. */
interface DeckContext {
  readonly warnings: Set<string>;
  readonly writer: MarkdownWriter;
}

interface SlideContext extends DeckContext {
  readonly relationships: Relationships;
}

async function renderSlide(zip: ZipArchive, partName: string, number: number, deck: DeckContext): Promise<Block[]> {
  const slide = await readPart(zip, partName);
  const relationships = await readRelationships(zip, partName);
  const context: SlideContext = { ...deck, relationships };
  const content = renderShapeTree(childAt(slide, "p:cSld", "p:spTree"), context);

  const hidden = attribute(slide, "show") === "0" ? " (hidden)" : "";
  const heading = `## Slide ${number}${content.title ? `: ${content.title}` : ""}${hidden}`;
  const blocks: Block[] = [{ kind: "other", markdown: heading }, ...content.blocks];

  const notesPart = findRelationship(relationships, "notesSlide")?.target;
  const notes = notesPart ? await renderNotes(zip, notesPart, deck) : [];
  if (notes.length > 0) blocks.push({ kind: "other", markdown: "### Notes" }, ...notes);
  return blocks;
}

/** The speaker notes: the notes page's body placeholder, skipping its slide image and slide number. */
async function renderNotes(zip: ZipArchive, partName: string, deck: DeckContext): Promise<Block[]> {
  const notes = await readPart(zip, partName);
  const context: SlideContext = { ...deck, relationships: await readRelationships(zip, partName) };
  const blocks: Block[] = [];
  for (const shape of descendants(childAt(notes, "p:cSld", "p:spTree"), "p:sp")) {
    if (placeholderType(shape) !== "body") continue;
    for (const paragraph of childElements(firstChild(shape, "p:txBody"), "a:p")) {
      const markdown = paragraphMarkdown(paragraph, context);
      if (markdown) blocks.push({ kind: "other", markdown: escapeLineStarts(markdown) });
    }
  }
  return blocks;
}

// ---- Shapes ----

interface SlideContent {
  title: string | undefined;
  readonly blocks: Block[];
}

/** Placeholders that repeat master furniture rather than slide content. */
const FURNITURE_PLACEHOLDERS = new Set(["dt", "ftr", "hdr", "sldNum", "sldImg"]);
const TITLE_PLACEHOLDERS = new Set(["title", "ctrTitle"]);

/**
 * Walks a shape tree in document order, which is z-order. Slides rarely layer text, so z-order
 * is a fair approximation of reading order without reasoning about shape positions.
 */
function renderShapeTree(tree: XmlElement | undefined, context: SlideContext, content: SlideContent = { title: undefined, blocks: [] }): SlideContent {
  for (const shape of childElements(tree)) {
    switch (shape.name) {
      case "p:sp":
        renderTextShape(shape, context, content);
        break;
      case "p:grpSp":
        renderShapeTree(shape, context, content);
        break;
      case "p:graphicFrame":
        content.blocks.push(...renderGraphicFrame(shape, context));
        break;
      case "p:pic":
        content.blocks.push({ kind: "other", markdown: pictureMarkdown(shape, context) });
        break;
    }
  }
  return content;
}

/** The shape's placeholder type. A `p:ph` without one is an "obj" placeholder (ECMA-376 19.7.10). */
function placeholderType(shape: XmlElement): string | undefined {
  const placeholder = childAt(shape, "p:nvSpPr", "p:nvPr", "p:ph");
  return placeholder ? attribute(placeholder, "type") ?? "obj" : undefined;
}

function renderTextShape(shape: XmlElement, context: SlideContext, content: SlideContent): void {
  const type = placeholderType(shape);
  if (type !== undefined && FURNITURE_PLACEHOLDERS.has(type)) return;
  const paragraphs = childElements(firstChild(shape, "p:txBody"), "a:p");
  if (type !== undefined && TITLE_PLACEHOLDERS.has(type) && content.title === undefined) {
    const title = paragraphs.map(paragraph => joinLines(paragraphMarkdown(paragraph, context), " ")).filter(Boolean).join(" ");
    if (title) {
      content.title = title;
      return;
    }
  }
  content.blocks.push(...textBodyBlocks(paragraphs, type === "body" || type === "obj", context));
}

/**
 * Paragraphs as Markdown. Whether a paragraph is bulleted is decided by the slide layout and
 * master, which are not read: body and content placeholders are bulleted, as in the default
 * masters, and other shapes are not, unless a paragraph says otherwise with `a:buChar`,
 * `a:buAutoNum` or `a:buNone`.
 */
function textBodyBlocks(paragraphs: readonly XmlElement[], bulletedByDefault: boolean, context: SlideContext): Block[] {
  const blocks: Block[] = [];
  let previousLevel = -1;
  for (const paragraph of paragraphs) {
    const markdown = paragraphMarkdown(paragraph, context);
    if (!markdown) continue;
    const properties = firstChild(paragraph, "a:pPr");
    if (!isBulleted(properties, bulletedByDefault)) {
      previousLevel = -1;
      blocks.push({ kind: "other", markdown: escapeLineStarts(markdown) });
      continue;
    }
    // Markdown cannot skip a nesting level, and an item indented too far becomes a code block.
    const level = Math.min(paragraphLevel(properties), previousLevel + 1);
    previousLevel = level;
    const indent = "  ".repeat(level);
    blocks.push({ kind: "list-item", markdown: `${indent}- ${escapeLineStarts(markdown).split("\n").join(`\n${indent}  `)}` });
  }
  return blocks;
}

function isBulleted(properties: XmlElement | undefined, byDefault: boolean): boolean {
  if (firstChild(properties, "a:buNone")) return false;
  if (firstChild(properties, "a:buChar") || firstChild(properties, "a:buAutoNum")) return true;
  return byDefault;
}

function paragraphLevel(properties: XmlElement | undefined): number {
  const level = Number.parseInt(attribute(properties, "lvl") ?? "0", 10);
  return Number.isFinite(level) ? Math.max(0, Math.min(8, level)) : 0;
}

function paragraphMarkdown(paragraph: XmlElement, context: SlideContext): string {
  const inlines: Inline[] = [];
  for (const child of childElements(paragraph)) {
    if (child.name === "a:br") {
      inlines.push({ kind: "break" });
    } else if (child.name === "a:r" || child.name === "a:fld") {
      const properties = firstChild(child, "a:rPr");
      const textElement = firstChild(child, "a:t");
      const text = textElement ? textContent(textElement) : "";
      inlines.push({ kind: "text", text, style: runStyle(properties), href: runHyperlink(properties, context) });
    }
  }
  return renderInlines(inlines, "\n").trim();
}

function runStyle(properties: XmlElement | undefined): TextStyle {
  if (!properties) return PLAIN;
  return {
    bold: isTrue(attribute(properties, "b")),
    italic: isTrue(attribute(properties, "i")),
    strike: (attribute(properties, "strike") ?? "noStrike") !== "noStrike",
    code: false,
  };
}

function isTrue(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

function runHyperlink(properties: XmlElement | undefined, context: SlideContext): string | undefined {
  const id = attribute(firstChild(properties, "a:hlinkClick"), "r:id");
  const relationship = id ? context.relationships.get(id) : undefined;
  return relationship?.external ? safeLinkTarget(relationship.target) : undefined;
}

// ---- Graphic frames and pictures ----

function renderGraphicFrame(frame: XmlElement, context: SlideContext): Block[] {
  const data = childAt(frame, "a:graphic", "a:graphicData");
  const table = firstChild(data, "a:tbl");
  if (table) return [{ kind: "other", markdown: renderSlideTable(table, context) }];

  const kind = attribute(data, "uri") ?? "";
  const description = frameDescription(frame);
  if (kind.endsWith("/chart")) {
    context.warnings.add("Charts are shown as placeholders; their data is not converted.");
    return [{ kind: "other", markdown: imagePlaceholder(description ? `Chart: ${description}` : "Chart", undefined) }];
  }
  if (kind.endsWith("/diagram")) {
    context.warnings.add("SmartArt diagrams are shown as placeholders; their text is not converted.");
    return [{ kind: "other", markdown: imagePlaceholder(description ? `Diagram: ${description}` : "Diagram", undefined) }];
  }
  context.warnings.add("Embedded objects are shown as placeholders; their content is not converted.");
  return [{ kind: "other", markdown: imagePlaceholder(description ?? "Embedded object", undefined) }];
}

function frameDescription(frame: XmlElement): string | undefined {
  const properties = childAt(frame, "p:nvGraphicFramePr", "p:cNvPr");
  return attribute(properties, "descr") || attribute(properties, "title") || undefined;
}

function pictureMarkdown(picture: XmlElement, context: SlideContext): string {
  const properties = childAt(picture, "p:nvPicPr", "p:cNvPr");
  const description = attribute(properties, "descr") || attribute(properties, "title") || undefined;
  const embed = attribute(firstDescendant(picture, "a:blip"), "r:embed");
  const relationship = embed ? context.relationships.get(embed) : undefined;
  return imagePlaceholder(description, relationship && !relationship.external ? relationship.target : undefined);
}

/**
 * A DrawingML table. Unlike Word, a merged region keeps a cell element for every grid position,
 * with the covered ones marked `hMerge`/`vMerge`, so those render empty and spans need no padding.
 */
function renderSlideTable(table: XmlElement, context: SlideContext): string {
  const rows = childElements(table, "a:tr").map(row => childElements(row, "a:tc").map(cell => {
    if (isTrue(attribute(cell, "hMerge")) || isTrue(attribute(cell, "vMerge"))) return "";
    return childElements(firstChild(cell, "a:txBody"), "a:p")
      .map(paragraph => paragraphMarkdown(paragraph, context))
      .filter(Boolean)
      .join("\n");
  }));
  return renderTable(rows, context.writer.remaining);
}
