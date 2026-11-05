// Word (.docx, .docm, .dotx, .dotm) to Markdown. The body is streamed one block at a time, so a
// large document costs one paragraph or table of tree at a time, and conversion stops early once
// the output budget is spent.
//
// WordprocessingML keeps meaning in several parts: the body holds paragraphs and runs, styles.xml
// says which paragraph styles are headings, numbering.xml says whether a list paragraph is
// bulleted or numbered, and document.xml.rels maps hyperlink and image ids to their targets.

import {
  MarkdownWriter, PLAIN, escapeLineStarts, imagePlaceholder, joinLines, renderInlines, renderTable, safeLinkTarget,
  type Block, type Inline, type TextStyle,
} from "./markdown";
import {
  findMainPart, findRelationship, isOn, readPart, readPartText, readRelationships, streamPart, type ConvertedMarkdown,
  type OfficeConversionOptions, type Relationships,
} from "./ooxml";
import { attribute, childElements, descendants, firstChild, firstDescendant, textContent, type XmlElement } from "./xml";
import { openZip, type ZipArchive } from "./zip";

/** Converts a Word document to Markdown. Throws `DocumentConversionError`, `ZipError` or `XmlError`. */
export async function docxToMarkdown(bytes: Uint8Array, options: OfficeConversionOptions = {}): Promise<ConvertedMarkdown> {
  const zip = openZip(bytes);
  const mainPart = await findMainPart(zip, "word/document.xml");
  const relationships = await readRelationships(zip, mainPart);
  const styles = new StyleSheet(await readRelatedPart(zip, relationships, "styles"));
  const writer = new MarkdownWriter(options.maxChars);
  const context: DocxContext = {
    writer,
    styles,
    numbering: new Numbering(await readRelatedPart(zip, relationships, "numbering"), styles),
    relationships,
    warnings: new Set(),
    noteReferences: new Map(),
    listCounters: new Map(),
    listDepth: -1,
  };

  // Depth 2 is w:document > w:body > each block.
  for (const element of streamPart(await readPartText(zip, mainPart), 2)) {
    if (!writer.hasRoom) break;
    for (const block of renderBodyElement(element, context)) writer.push(block);
  }
  if (writer.hasRoom) await renderNotes(zip, context, writer);
  return { markdown: writer.toString(), warnings: [...context.warnings], truncated: writer.truncated };
}

interface DocxContext {
  readonly writer: MarkdownWriter;
  readonly styles: StyleSheet;
  readonly numbering: Numbering;
  readonly relationships: Relationships;
  readonly warnings: Set<string>;
  /** Footnotes and endnotes referenced so far, by label, in order of first reference. */
  readonly noteReferences: Map<string, NoteReference>;
  /** Per numbering instance, the current count at each level. */
  readonly listCounters: Map<string, number[]>;
  /** The nesting depth of the last list item rendered, or -1 when the last block was not one. */
  listDepth: number;
}

interface NoteReference {
  readonly kind: "footnote" | "endnote";
  readonly id: string;
}

async function readRelatedPart(zip: ZipArchive, relationships: Relationships, type: string): Promise<XmlElement | undefined> {
  const relationship = findRelationship(relationships, type);
  return relationship ? readPart(zip, relationship.target) : undefined;
}

// ---- Blocks ----

function renderBodyElement(element: XmlElement, context: DocxContext): Block[] {
  switch (element.name) {
    case "w:p":
      return renderParagraph(element, context);
    case "w:tbl":
      context.listDepth = -1;
      return [{ kind: "other", markdown: renderDocxTable(element, context) }];
    case "w:sdt":
      return renderBodyElements(firstChild(element, "w:sdtContent"), context);
    case "w:customXml":
    case "w:sdtContent":
      return renderBodyElements(element, context);
    case "w:altChunk":
      context.warnings.add("The document embeds imported content (altChunk), which is not converted.");
      return [];
    default:
      return [];
  }
}

function renderBodyElements(parent: XmlElement | undefined, context: DocxContext): Block[] {
  return childElements(parent).flatMap(child => renderBodyElement(child, context));
}

function renderParagraph(paragraph: XmlElement, context: DocxContext): Block[] {
  const properties = firstChild(paragraph, "w:pPr");
  const styleId = attribute(firstChild(properties, "w:pStyle"), "w:val");
  const textBoxes: Block[] = [];
  const inlines = paragraphInlines(paragraph, context, textBoxes);
  if (context.styles.isCode(styleId) && paragraphHeadingLevel(properties, styleId, context.styles) === undefined) {
    const code = codeText(inlines);
    if (code.trim()) {
      context.listDepth = -1;
      return [{ kind: "other", markdown: fencedCode(code) }, ...textBoxes];
    }
  }
  const markdown = renderInlines(inlines, "\n").trim();
  if (!markdown && firstChild(firstChild(properties, "w:pBdr"), "w:bottom") && textBoxes.length === 0) {
    // An empty paragraph with a bottom border is how Word draws a horizontal rule (its own `---` autoformat).
    context.listDepth = -1;
    return [{ kind: "other", markdown: "---" }];
  }
  const blocks = markdown ? [paragraphBlock(markdown, properties, styleId, context)] : [];
  return [...blocks, ...textBoxes];
}

/** A code paragraph's text as written: line breaks kept, no Markdown escaping. */
function codeText(inlines: readonly Inline[]): string {
  return inlines.map(inline => inline.kind === "text" ? inline.text : inline.kind === "break" ? "\n" : inline.markdown).join("").trimEnd();
}

/** A fenced code block, its fence longer than any run of backticks in the code. */
function fencedCode(code: string): string {
  const longest = Math.max(2, ...Array.from(code.matchAll(/`+/g), match => match[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}\n${code}\n${fence}`;
}

function paragraphBlock(markdown: string, properties: XmlElement | undefined, styleId: string | undefined, context: DocxContext): Block {
  const level = paragraphHeadingLevel(properties, styleId, context.styles);
  if (level !== undefined) {
    context.listDepth = -1;
    return { kind: "other", markdown: `${"#".repeat(level)} ${joinLines(markdown, " ")}` };
  }
  const marker = listMarker(properties, styleId, context);
  if (marker) {
    const indent = "    ".repeat(marker.depth);
    const continuation = `\n${indent}${" ".repeat(marker.text.length + 1)}`;
    // A task item is written in Word as a list paragraph opening with a ballot box.
    const item = escapeLineStarts(markdown).replace(/^([☐☒☑])[ \t\u00A0]+/, (_match, box: string) => box === "☐" ? "[ ] " : "[x] ");
    return { kind: "list-item", markdown: `${indent}${marker.text} ${item.split("\n").join(continuation)}` };
  }
  context.listDepth = -1;
  if (context.styles.isQuote(styleId)) return { kind: "other", markdown: escapeLineStarts(markdown).split("\n").map(line => `> ${line}`).join("\n") };
  return { kind: "other", markdown: escapeLineStarts(markdown) };
}

/** A heading level from the paragraph's own outline level, or else its style's. */
function paragraphHeadingLevel(properties: XmlElement | undefined, styleId: string | undefined, styles: StyleSheet): number | undefined {
  return outlineHeadingLevel(properties) ?? styles.headingLevel(styleId);
}

/** `w:outlineLvl` 0–8 marks a heading (level + 1); 9 is body text. Markdown stops at six levels. */
function outlineHeadingLevel(properties: XmlElement | undefined): number | undefined {
  const value = parseInteger(attribute(firstChild(properties, "w:outlineLvl"), "w:val"));
  return value !== undefined && value >= 0 && value <= 8 ? Math.min(value + 1, 6) : undefined;
}

// ---- Lists ----

interface ListMarker {
  readonly depth: number;
  readonly text: string;
}

/**
 * The list marker for a numbered paragraph, advancing its counter. Markdown lists can only count
 * in decimal, so letter and roman formats are rendered as their decimal position. Nesting follows
 * `w:ilvl`, clamped to one deeper than the previous item: Markdown has no way to skip a level,
 * and an over-indented item would become a code block.
 */
function listMarker(properties: XmlElement | undefined, styleId: string | undefined, context: DocxContext): ListMarker | undefined {
  const reference = numberingReference(properties, styleId, context.styles);
  if (!reference) return undefined;
  const level = context.numbering.level(reference.numId, reference.level);
  if (level?.format === "none") return undefined;

  // Word's List Bullet 2 (and List Number 3, ...) nest by style, each with numbering of its own at level 0.
  const depth = Math.min(Math.max(reference.level, context.styles.listLevel(styleId)), context.listDepth + 1);
  context.listDepth = depth;
  const counters = context.listCounters.get(reference.numId) ?? [];
  context.listCounters.set(reference.numId, counters);
  counters.length = Math.min(counters.length, reference.level + 1);
  if (!level || level.format === "bullet") return { depth, text: "-" };
  const count = (counters[reference.level] ?? level.start - 1) + 1;
  counters[reference.level] = count;
  return { depth, text: `${count}.` };
}

interface NumberingReference {
  readonly numId: string;
  readonly level: number;
}

/**
 * The paragraph's numbering: its own `w:numPr`, completed from its style's (list styles such as
 * "List Bullet" carry the numbering). `numId` 0 explicitly removes numbering.
 */
function numberingReference(properties: XmlElement | undefined, styleId: string | undefined, styles: StyleSheet): NumberingReference | undefined {
  const direct = parseNumberingProperties(firstChild(properties, "w:numPr"));
  const inherited = styles.numbering(styleId);
  const numId = direct.numId ?? inherited?.numId;
  if (numId === undefined || numId === "0") return undefined;
  return { numId, level: clampLevel(direct.level ?? inherited?.level ?? 0) };
}

function parseNumberingProperties(numPr: XmlElement | undefined): { numId?: string; level?: number } {
  return {
    numId: attribute(firstChild(numPr, "w:numId"), "w:val"),
    level: parseInteger(attribute(firstChild(numPr, "w:ilvl"), "w:val")),
  };
}

function clampLevel(level: number): number {
  return Math.max(0, Math.min(8, level));
}

interface ListLevel {
  /** `w:numFmt`: `bullet`, `decimal`, `lowerLetter`, `none`, ... */
  readonly format: string;
  readonly start: number;
}

/** numbering.xml: numbering instances (`w:num`) pointing at abstract definitions (`w:abstractNum`). */
class Numbering {
  readonly #abstractLevels = new Map<string, Map<number, ListLevel>>();
  /** An abstract definition that only names a list style (`w:numStyleLink`) and takes its levels from it. */
  readonly #abstractStyleLinks = new Map<string, string>();
  readonly #instances = new Map<string, { abstractId: string; overrides: Map<number, Partial<ListLevel>> }>();

  constructor(root: XmlElement | undefined, private readonly styles: StyleSheet) {
    for (const abstract of childElements(root, "w:abstractNum")) {
      const id = attribute(abstract, "w:abstractNumId");
      if (id === undefined) continue;
      const levels = new Map<number, ListLevel>();
      for (const level of childElements(abstract, "w:lvl")) {
        const index = parseInteger(attribute(level, "w:ilvl"));
        if (index !== undefined) levels.set(index, { format: levelFormat(level) ?? "decimal", start: levelStart(level) ?? 0 });
      }
      this.#abstractLevels.set(id, levels);
      const styleLink = attribute(firstChild(abstract, "w:numStyleLink"), "w:val");
      if (styleLink) this.#abstractStyleLinks.set(id, styleLink);
    }
    for (const instance of childElements(root, "w:num")) {
      const numId = attribute(instance, "w:numId");
      const abstractId = attribute(firstChild(instance, "w:abstractNumId"), "w:val");
      if (numId !== undefined && abstractId !== undefined) this.#instances.set(numId, { abstractId, overrides: parseOverrides(instance) });
    }
  }

  level(numId: string, level: number): ListLevel | undefined {
    const instance = this.#instances.get(numId);
    if (!instance) return undefined;
    const base = this.#levelsOf(instance.abstractId, 0)?.get(level);
    const override = instance.overrides.get(level);
    const format = override?.format ?? base?.format;
    if (format === undefined) return undefined;
    return { format, start: override?.start ?? base?.start ?? 0 };
  }

  #levelsOf(abstractId: string, hops: number): Map<number, ListLevel> | undefined {
    const levels = this.#abstractLevels.get(abstractId);
    const styleLink = this.#abstractStyleLinks.get(abstractId);
    if ((levels && levels.size > 0) || !styleLink || hops > 4) return levels;
    const linkedNumId = this.styles.numbering(styleLink)?.numId;
    const linked = linkedNumId === undefined ? undefined : this.#instances.get(linkedNumId);
    return linked ? this.#levelsOf(linked.abstractId, hops + 1) : levels;
  }
}

function parseOverrides(instance: XmlElement): Map<number, Partial<ListLevel>> {
  const overrides = new Map<number, Partial<ListLevel>>();
  for (const override of childElements(instance, "w:lvlOverride")) {
    const index = parseInteger(attribute(override, "w:ilvl"));
    if (index === undefined) continue;
    const redefined = firstChild(override, "w:lvl");
    const start = parseInteger(attribute(firstChild(override, "w:startOverride"), "w:val")) ?? levelStart(redefined);
    overrides.set(index, { format: levelFormat(redefined), start });
  }
  return overrides;
}

function levelFormat(level: XmlElement | undefined): string | undefined {
  return attribute(firstChild(level, "w:numFmt"), "w:val");
}

function levelStart(level: XmlElement | undefined): number | undefined {
  return parseInteger(attribute(firstChild(level, "w:start"), "w:val"));
}

// ---- Styles ----

interface StyleDefinition {
  readonly name: string;
  readonly basedOn: string | undefined;
  readonly outlineLevel: number | undefined;
  readonly numbering: { numId?: string; level?: number };
  readonly run: Partial<TextStyle>;
}

const MAX_STYLE_CHAIN = 16;

/**
 * styles.xml. Headings are recognised by style *name* ("heading 1", "Title"), not id: Word keeps
 * built-in names in English but localizes ids (a German document's Heading 1 has id
 * "berschrift1"). Properties are inherited through `w:basedOn`, so a custom style based on
 * Heading 2 is a level-2 heading too.
 */
class StyleSheet {
  readonly #styles = new Map<string, StyleDefinition>();

  constructor(root: XmlElement | undefined) {
    for (const style of childElements(root, "w:style")) {
      const id = attribute(style, "w:styleId");
      if (id === undefined) continue;
      const paragraphProperties = firstChild(style, "w:pPr");
      this.#styles.set(id, {
        name: (attribute(firstChild(style, "w:name"), "w:val") ?? id).toLowerCase(),
        basedOn: attribute(firstChild(style, "w:basedOn"), "w:val"),
        outlineLevel: outlineHeadingLevel(paragraphProperties),
        numbering: parseNumberingProperties(firstChild(paragraphProperties, "w:numPr")),
        run: directRunStyle(firstChild(style, "w:rPr")),
      });
    }
  }

  headingLevel(styleId: string | undefined): number | undefined {
    if (styleId === undefined) return undefined;
    if (!this.#styles.has(styleId)) return headingLevelFromName(styleId.toLowerCase().replace(/^heading(\d)$/, "heading $1"));
    for (const style of this.#chain(styleId)) {
      const level = headingLevelFromName(style.name) ?? style.outlineLevel;
      if (level !== undefined) return level;
    }
    return undefined;
  }

  numbering(styleId: string | undefined): NumberingReference | undefined {
    const chain = this.#chain(styleId);
    const numId = chain.find(style => style.numbering.numId !== undefined)?.numbering.numId;
    if (numId === undefined) return undefined;
    return { numId, level: chain.find(style => style.numbering.level !== undefined)?.numbering.level ?? 0 };
  }

  /** The nesting a list style's name gives: 1 for "List Bullet 2", 0 for anything else. */
  listLevel(styleId: string | undefined): number {
    for (const style of this.#chain(styleId)) {
      const match = /^list (?:bullet|number|continue) ([2-9])$/.exec(style.name);
      if (match) return Number(match[1]) - 1;
    }
    return 0;
  }

  /** Whether a paragraph style is a quotation: Quote, Intense Quote, or one based on them. */
  isQuote(styleId: string | undefined): boolean {
    return this.#chain(styleId).some(style => style.name === "quote" || style.name === "intense quote");
  }

  /** Whether a paragraph style sets a monospace font, as HTML Preformatted and most code styles do. */
  isCode(styleId: string | undefined): boolean {
    return styleId !== undefined && this.runStyle(styleId).code === true;
  }

  /** A character style's formatting, nearest definition winning. */
  runStyle(styleId: string | undefined): Partial<TextStyle> {
    return this.#chain(styleId).reduceRight<Partial<TextStyle>>((merged, style) => ({ ...merged, ...style.run }), {});
  }

  #chain(styleId: string | undefined): StyleDefinition[] {
    const chain: StyleDefinition[] = [];
    const seen = new Set<string>();
    for (let id = styleId; id !== undefined && !seen.has(id) && chain.length < MAX_STYLE_CHAIN; ) {
      seen.add(id);
      const style = this.#styles.get(id);
      if (!style) break;
      chain.push(style);
      id = style.basedOn;
    }
    return chain;
  }
}

function headingLevelFromName(name: string): number | undefined {
  if (name === "title") return 1;
  const match = /^heading\s*([1-9])$/.exec(name);
  return match ? Math.min(Number(match[1]), 6) : undefined;
}

// ---- Runs ----

const MONOSPACE_FONTS = new Set([
  "andale mono", "cascadia code", "cascadia mono", "consolas", "courier", "courier new", "dejavu sans mono",
  "fira code", "fira mono", "ibm plex mono", "inconsolata", "jetbrains mono", "liberation mono", "lucida console",
  "lucida sans typewriter", "menlo", "monaco", "noto mono", "roboto mono", "sf mono", "source code pro", "ubuntu mono",
]);

/** Formatting set directly in a `w:rPr`, leaving unset properties absent so styles can supply them. */
function directRunStyle(properties: XmlElement | undefined): Partial<TextStyle> {
  const style: { -readonly [K in keyof TextStyle]?: boolean } = {};
  const bold = toggle(properties, "w:b");
  const italic = toggle(properties, "w:i");
  const strike = toggle(properties, "w:strike") ?? toggle(properties, "w:dstrike");
  const fonts = firstChild(properties, "w:rFonts");
  const font = attribute(fonts, "w:ascii") ?? attribute(fonts, "w:hAnsi");
  if (bold !== undefined) style.bold = bold;
  if (italic !== undefined) style.italic = italic;
  if (strike !== undefined) style.strike = strike;
  if (font !== undefined) style.code = MONOSPACE_FONTS.has(font.toLowerCase());
  return style;
}

function toggle(properties: XmlElement | undefined, name: string): boolean | undefined {
  const element = firstChild(properties, name);
  return element ? isOn(element, "w:val") : undefined;
}

/**
 * A run's effective formatting: its own properties over its character style's. Paragraph-style
 * formatting is deliberately not applied, or every heading (bold by style) would render bold.
 */
function runStyle(properties: XmlElement | undefined, styles: StyleSheet): TextStyle {
  const styled = styles.runStyle(attribute(firstChild(properties, "w:rStyle"), "w:val"));
  return { ...PLAIN, ...styled, ...directRunStyle(properties) };
}

/** One complex field (`w:fldChar` begin … separate … end) the walker is inside. */
interface FieldFrame {
  instruction: string;
  /** False while in the field's code, whose runs are instructions rather than text. */
  inResult: boolean;
  /** For a HYPERLINK field, its vetted target, applied to the result runs. */
  href: string | undefined;
}

interface InlineWalk {
  readonly context: DocxContext;
  readonly inlines: Inline[];
  /** Blocks found inside the paragraph, such as text boxes, rendered after it. */
  readonly textBoxes: Block[];
  readonly fields: FieldFrame[];
}

function paragraphInlines(paragraph: XmlElement, context: DocxContext, textBoxes: Block[]): Inline[] {
  const walk: InlineWalk = { context, inlines: [], textBoxes, fields: [] };
  collectInlines(paragraph, walk, undefined);
  return walk.inlines;
}

/**
 * Walks paragraph content. Tracked insertions (`w:ins`, `w:moveTo`) are read as text; tracked
 * deletions (`w:del`, `w:moveFrom`) are skipped, so the output is the document as if all changes
 * were accepted.
 */
function collectInlines(parent: XmlElement | undefined, walk: InlineWalk, href: string | undefined): void {
  for (const child of childElements(parent)) {
    switch (child.name) {
      case "w:r":
        collectRun(child, walk, href);
        break;
      case "w:hyperlink":
        collectInlines(child, walk, hyperlinkTarget(child, walk.context.relationships) ?? href);
        break;
      case "w:fldSimple":
        collectInlines(child, walk, fieldHyperlink(attribute(child, "w:instr") ?? "") ?? href);
        break;
      case "w:sdt":
        collectInlines(firstChild(child, "w:sdtContent"), walk, href);
        break;
      case "w:ins":
      case "w:moveTo":
      case "w:smartTag":
      case "w:customXml":
      case "w:dir":
      case "w:bdo":
        collectInlines(child, walk, href);
        break;
      case "m:oMath":
      case "m:oMathPara":
        walk.inlines.push({ kind: "text", text: mathText(child), style: PLAIN, href });
        break;
    }
  }
}

function collectRun(run: XmlElement, walk: InlineWalk, href: string | undefined): void {
  const properties = firstChild(run, "w:rPr");
  if (toggle(properties, "w:vanish") || toggle(properties, "w:webHidden")) return;
  const style = runStyle(properties, walk.context.styles);

  for (const child of childElements(run)) {
    if (child.name === "w:fldChar") {
      advanceField(walk.fields, attribute(child, "w:fldCharType"));
      continue;
    }
    const field = walk.fields[walk.fields.length - 1];
    if (child.name === "w:instrText" && field && !field.inResult) field.instruction += textContent(child);
    if (walk.fields.some(frame => !frame.inResult)) continue;
    collectRunContent(child, walk, style, fieldHref(walk.fields) ?? href);
  }
}

function collectRunContent(child: XmlElement, walk: InlineWalk, style: TextStyle, href: string | undefined): void {
  const text = (value: string): void => {
    walk.inlines.push({ kind: "text", text: value, style, href });
  };
  switch (child.name) {
    case "w:t":
      return text(textContent(child));
    case "w:tab":
    case "w:ptab":
      return text("\t");
    case "w:noBreakHyphen":
      return text("-");
    case "w:br":
    case "w:cr":
      walk.inlines.push({ kind: "break" });
      return;
    case "w:drawing":
      return collectDrawing(child, walk, href);
    case "w:pict":
    case "w:object":
      return collectVml(child, walk, href);
    case "w:footnoteReference":
    case "w:endnoteReference":
      return collectNoteReference(child, walk);
  }
}

function advanceField(fields: FieldFrame[], type: string | undefined): void {
  if (type === "begin") {
    fields.push({ instruction: "", inResult: false, href: undefined });
  } else if (type === "separate") {
    const field = fields[fields.length - 1];
    if (field) {
      field.inResult = true;
      field.href = fieldHyperlink(field.instruction);
    }
  } else if (type === "end") {
    fields.pop();
  }
}

function fieldHref(fields: readonly FieldFrame[]): string | undefined {
  for (let index = fields.length - 1; index >= 0; index--) {
    if (fields[index]!.href) return fields[index]!.href;
  }
  return undefined;
}

/** A `HYPERLINK "url"` field's target. A field with only `\l "bookmark"` is an internal jump. */
function fieldHyperlink(instruction: string): string | undefined {
  const match = /^\s*HYPERLINK\s+"([^"]+)"/i.exec(instruction);
  return match ? safeLinkTarget(match[1]!) : undefined;
}

/** A `w:hyperlink`'s external target. Links to bookmarks (`w:anchor` alone) stay plain text. */
function hyperlinkTarget(link: XmlElement, relationships: Relationships): string | undefined {
  const id = attribute(link, "r:id");
  const relationship = id === undefined ? undefined : relationships.get(id);
  if (!relationship?.external) return undefined;
  const anchor = attribute(link, "w:anchor");
  return safeLinkTarget(anchor ? `${relationship.target}#${anchor}` : relationship.target);
}

function mathText(math: XmlElement): string {
  return Array.from(descendants(math, "m:t"), textContent).join("");
}

/**
 * A DrawingML object: a picture becomes an image placeholder with its `wp:docPr` description as
 * alt text; a text box (`w:txbxContent`) contributes its paragraphs after this one.
 */
function collectDrawing(drawing: XmlElement, walk: InlineWalk, href: string | undefined): void {
  const docPr = firstDescendant(drawing, "wp:docPr");
  const description = attribute(docPr, "descr") || attribute(docPr, "title") || undefined;
  const kind = attribute(firstDescendant(drawing, "a:graphicData"), "uri") ?? "";
  const hasTextBox = collectTextBoxes(drawing, walk);

  if (kind.endsWith("/chart")) {
    walk.context.warnings.add("Charts are shown as placeholders; their data is not converted.");
    walk.inlines.push({ kind: "markdown", markdown: imagePlaceholder(description ? `Chart: ${description}` : "Chart", undefined), href });
  } else if (kind.endsWith("/diagram")) {
    walk.context.warnings.add("SmartArt diagrams are shown as placeholders; their text is not converted.");
    walk.inlines.push({ kind: "markdown", markdown: imagePlaceholder(description ? `Diagram: ${description}` : "Diagram", undefined), href });
  } else {
    const embed = attribute(firstDescendant(drawing, "a:blip"), "r:embed");
    if (embed === undefined && hasTextBox) return;
    walk.inlines.push({ kind: "markdown", markdown: imagePlaceholder(description, internalTarget(walk.context, embed)), href });
  }
}

/** Legacy VML pictures and embedded (OLE) objects, which show a preview image when they have one. */
function collectVml(element: XmlElement, walk: InlineWalk, href: string | undefined): void {
  const hasTextBox = collectTextBoxes(element, walk);
  if (element.name === "w:object") walk.context.warnings.add("Embedded objects are shown as placeholders; their content is not converted.");
  const image = firstDescendant(element, "v:imagedata");
  if (!image && hasTextBox) return;
  if (!image && element.name !== "w:object") return;
  const description = attribute(image, "o:title") || attribute(firstDescendant(element, "v:shape"), "alt") || undefined;
  walk.inlines.push({ kind: "markdown", markdown: imagePlaceholder(description, internalTarget(walk.context, attribute(image, "r:id"))), href });
}

function collectTextBoxes(element: XmlElement, walk: InlineWalk): boolean {
  let found = false;
  for (const content of descendants(element, "w:txbxContent")) {
    found = true;
    walk.textBoxes.push(...renderBodyElements(content, walk.context));
  }
  return found;
}

function internalTarget(context: DocxContext, id: string | undefined): string | undefined {
  const relationship = id === undefined ? undefined : context.relationships.get(id);
  return relationship && !relationship.external ? relationship.target : undefined;
}

// ---- Notes ----

function collectNoteReference(reference: XmlElement, walk: InlineWalk): void {
  const kind = reference.name === "w:footnoteReference" ? "footnote" : "endnote";
  const id = attribute(reference, "w:id");
  if (id === undefined) return;
  const label = noteLabel(kind, id);
  if (!walk.context.noteReferences.has(label)) walk.context.noteReferences.set(label, { kind, id });
  walk.inlines.push({ kind: "markdown", markdown: `[^${label}]` });
}

function noteLabel(kind: NoteReference["kind"], id: string): string {
  return kind === "footnote" ? id : `endnote-${id}`;
}

/** Appends referenced footnotes and endnotes as GFM footnote definitions. */
async function renderNotes(zip: ZipArchive, context: DocxContext, writer: MarkdownWriter): Promise<void> {
  const references = [...context.noteReferences.values()];
  for (const kind of ["footnote", "endnote"] as const) {
    const wanted = references.filter(reference => reference.kind === kind);
    if (wanted.length === 0) continue;
    const part = await readRelatedPart(zip, context.relationships, kind === "footnote" ? "footnotes" : "endnotes");
    const notes = new Map(childElements(part, `w:${kind}`).map(note => [attribute(note, "w:id"), note]));
    for (const { id } of wanted) {
      const note = notes.get(id);
      if (!note) continue;
      const text = childElements(note, "w:p")
        .map(paragraph => renderInlines(paragraphInlines(paragraph, context, []), " ").trim())
        .filter(Boolean)
        .join(" ");
      writer.push({ kind: "other", markdown: `[^${noteLabel(kind, id)}]: ${text}` });
    }
  }
}

// ---- Tables ----

/**
 * A table as GFM. Horizontally merged cells (`w:gridSpan`) are followed by empty cells so columns
 * line up; vertically merged continuation cells (`w:vMerge` without "restart") are left empty.
 * Rows deleted under tracked changes are dropped.
 */
function renderDocxTable(table: XmlElement, context: DocxContext): string {
  const rows: string[][] = [];
  for (const row of unwrapped(table, "w:tr")) {
    const header = rows.length === 0;
    const rowProperties = firstChild(row, "w:trPr");
    if (firstChild(rowProperties, "w:del")) continue;
    const cells: string[] = Array.from({ length: gridValue(rowProperties, "w:gridBefore", 0) }, () => "");
    for (const cell of unwrapped(row, "w:tc")) {
      const cellProperties = firstChild(cell, "w:tcPr");
      const merge = firstChild(cellProperties, "w:vMerge");
      const continued = merge !== undefined && attribute(merge, "w:val") !== "restart";
      const markdown = continued ? "" : cellMarkdown(cell, context);
      // A header row is bold already in Markdown; bold that only says so would double it.
      cells.push(header ? markdown.replace(/^\*\*((?:(?!\*\*)[\s\S])+)\*\*$/, "$1") : markdown);
      for (let span = gridValue(cellProperties, "w:gridSpan", 1); span > 1; span--) cells.push("");
    }
    rows.push(cells);
  }
  return renderTable(rows, context.writer.remaining);
}

const MAX_GRID_SPAN = 64;

function gridValue(properties: XmlElement | undefined, name: string, fallback: number): number {
  const value = parseInteger(attribute(firstChild(properties, name), "w:val")) ?? fallback;
  return Math.max(0, Math.min(MAX_GRID_SPAN, value));
}

/** A cell's paragraphs, one per line; a nested table is flattened to its cells' text. */
function cellMarkdown(cell: XmlElement, context: DocxContext): string {
  const lines: string[] = [];
  for (const child of unwrapped(cell, "w:p", "w:tbl")) {
    if (child.name === "w:p") {
      const textBoxes: Block[] = [];
      lines.push(renderInlines(paragraphInlines(child, context, textBoxes), "\n").trim());
      lines.push(...textBoxes.map(block => block.markdown));
    } else {
      for (const row of unwrapped(child, "w:tr")) {
        lines.push(unwrapped(row, "w:tc").map(nested => cellMarkdown(nested, context).replace(/\n/g, " ")).filter(Boolean).join("; "));
      }
    }
  }
  return lines.filter(Boolean).join("\n");
}

/** Child elements with one of `names`, looking through content controls and custom XML wrappers. */
function unwrapped(parent: XmlElement, ...names: readonly string[]): XmlElement[] {
  const found: XmlElement[] = [];
  for (const child of childElements(parent)) {
    if (names.includes(child.name)) found.push(child);
    else if (child.name === "w:sdt") found.push(...unwrapped(firstChild(child, "w:sdtContent") ?? child, ...names));
    else if (child.name === "w:customXml" || child.name === "w:sdtContent") found.push(...unwrapped(child, ...names));
  }
  return found;
}

function parseInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^-?\d{1,9}$/.test(value.trim())) return undefined;
  return Number.parseInt(value, 10);
}

