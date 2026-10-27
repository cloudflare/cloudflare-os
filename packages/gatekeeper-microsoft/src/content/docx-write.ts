// Markdown to a Word document (.docx). A new document is laid out in Word's built-in styles with the
// Office theme (Aptos 11pt, theme-colored headings, Grid Table 4 tables), so it opens as if it had
// been written in Word and restyles with Word's own Design gallery. With a template (a .dotx, or any
// .docx used as one), the document instead takes the template's styles, theme, fonts, settings,
// numbering, headers, footers and page setup, with only its body replaced, and only the built-in
// styles the template lacks are added. What belonged to that body goes with it: its comments, its
// footnotes and endnotes, and the template its settings were attached to.

import { renderBlocks, emptyParagraph, type BodyContext } from "./docx-body";
import { NumberingAllocator } from "./docx-numbering";
import { CONTENT_TYPES, ContentTypesEditor, PackageEditor, RelationshipsEditor } from "./docx-package";
import { APP_XML, coreXml, FONT_TABLE_XML, SETTINGS_XML, THEME_XML } from "./docx-parts";
import { ALL_ROLES, StyleCatalog, type StyleRole } from "./docx-styles";
import { R_NS, W_NS } from "./docx-xml";
import { DocumentConversionError } from "./errors";
import { parseMarkdown, plainText, type MdBlock } from "./markdown-parse";
import { findMainPart, findRelationship, parsePart, readRelationships, relationshipsPartName, XML_DECLARATION, type Relationships } from "./ooxml";
import { applySplices, parseRaw, rawChildren, RawXmlError, type Splice } from "./raw-xml";
import { attribute, childElements, descendants, firstChild, type XmlElement } from "./xml";
import { writeZip } from "./zip-write";
import { openZip, type ZipArchive } from "./zip";

export { docxFeatures } from "./docx-features";

/** How `markdownToDocx` writes the document. */
export interface MarkdownToDocxOptions {
  /** The document title (core properties). Defaults to the text of a leading level-1 heading. */
  readonly title?: string;
  /** A Word template (.dotx) or document (.docx) whose styles, page setup, headers and footers to use. */
  readonly template?: Uint8Array;
  /** Recorded as the document's author and last editor. */
  readonly author?: string;
  /** The creation and modification time recorded; defaults to now. */
  readonly modifiedAt?: Date;
}

/** US Letter with one-inch margins: what Word's Normal template uses in the en-US locale. */
const DEFAULT_SECTION = '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>' +
  '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>' +
  '<w:cols w:space="720"/><w:docGrid w:linePitch="360"/></w:sectPr>';
const DEFAULT_TEXT_WIDTH = 12240 - 2 * 1440;

/** The styles every document's styles part defines, whether or not the body uses them. */
const BASE_ROLES: readonly StyleRole[] = ["normal", "defaultParagraphFont", "tableNormal", "noList"];

/** Relationship types of the parts that hold a body's comments, dropped with it. */
const COMMENT_PARTS = new Set(["comments", "commentsExtended", "commentsIds", "commentsExtensible", "people"]);
/** The notes settings.xml refers to by id, which stay when a notes part is emptied. */
const SEPARATOR_NOTES = new Set(["separator", "continuationSeparator"]);

/**
 * Converts Markdown to a .docx. Throws `DocumentConversionError` when the template can't be used:
 * it is corrupt, macro-enabled, or written in Strict Open XML.
 */
export async function markdownToDocx(markdown: string, options: MarkdownToDocxOptions = {}): Promise<Uint8Array> {
  const blocks = parseMarkdown(markdown);
  const modifiedAt = options.modifiedAt ?? new Date();
  const core = coreXml({ title: options.title ?? leadingTitle(blocks), author: options.author, created: modifiedAt, modified: modifiedAt });
  return options.template
    ? fromTemplate(blocks, options.template, core, modifiedAt)
    : fromScratch(blocks, core, modifiedAt);
}

function leadingTitle(blocks: readonly MdBlock[]): string | undefined {
  const first = blocks[0];
  return first?.kind === "heading" && first.level === 1 ? plainText(first.inlines).trim() || undefined : undefined;
}

/** The body's blocks, ending with the paragraph Word requires before the section properties. */
function body(blocks: readonly MdBlock[], context: BodyContext): string {
  for (const role of BASE_ROLES) context.styles.id(role);
  const rendered = renderBlocks(blocks, context);
  return rendered.xml === "" || rendered.endsWithTable ? rendered.xml + emptyParagraph(context) : rendered.xml;
}

async function fromScratch(blocks: readonly MdBlock[], core: string, modifiedAt: Date): Promise<Uint8Array> {
  const styles = new StyleCatalog(undefined);
  const numbering = new NumberingAllocator(undefined);
  const relationships = new RelationshipsEditor(undefined);
  relationships.add("styles", "styles.xml");
  relationships.add("settings", "settings.xml");
  relationships.add("fontTable", "fontTable.xml");
  relationships.add("theme", "theme/theme1.xml");
  const content = body(blocks, { styles, numbering, hyperlink: url => relationships.hyperlink(url), textWidth: DEFAULT_TEXT_WIDTH });
  // Styles appear in the gallery order of a fresh Normal template rather than the order first used.
  const ordered = new StyleCatalog(undefined);
  for (const role of ALL_ROLES) if (styles.has(role)) ordered.id(role);
  if (numbering.used) relationships.add("numbering", "numbering.xml");

  const overrides: Array<readonly [string, string]> = [
    ["word/document.xml", CONTENT_TYPES.document], ["word/styles.xml", CONTENT_TYPES.styles],
    ["word/settings.xml", CONTENT_TYPES.settings], ["word/fontTable.xml", CONTENT_TYPES.fontTable],
    ["word/theme/theme1.xml", CONTENT_TYPES.theme], ["docProps/core.xml", CONTENT_TYPES.core], ["docProps/app.xml", CONTENT_TYPES.app],
  ];
  if (numbering.used) overrides.push(["word/numbering.xml", CONTENT_TYPES.numbering]);
  const contentTypes = `${XML_DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="${CONTENT_TYPES.relationships}"/><Default Extension="xml" ContentType="application/xml"/>` +
    overrides.map(([name, type]) => `<Override PartName="/${name}" ContentType="${type}"/>`).join("") + "</Types>";
  const packageRelationships = new RelationshipsEditor(undefined);
  packageRelationships.add("officeDocument", "word/document.xml");
  packageRelationships.add(CORE_TYPE, "docProps/core.xml");
  packageRelationships.add("extended-properties", "docProps/app.xml");

  const document = `${XML_DECLARATION}<w:document xmlns:w="${W_NS}" xmlns:r="${R_NS}"><w:body>${content}${DEFAULT_SECTION}</w:body></w:document>`;
  return writeZip([
    { name: "[Content_Types].xml", data: contentTypes },
    { name: "_rels/.rels", data: packageRelationships.toString() },
    { name: "word/document.xml", data: document },
    { name: "word/_rels/document.xml.rels", data: relationships.toString() },
    { name: "word/styles.xml", data: ordered.serialize() },
    ...(numbering.used ? [{ name: "word/numbering.xml", data: numbering.serialize() }] : []),
    { name: "word/settings.xml", data: SETTINGS_XML },
    { name: "word/fontTable.xml", data: FONT_TABLE_XML },
    { name: "word/theme/theme1.xml", data: THEME_XML },
    { name: "docProps/core.xml", data: core },
    { name: "docProps/app.xml", data: APP_XML },
  ], modifiedAt);
}

/** The core-properties relationship is the one package relationship outside the officeDocument namespace. */
const CORE_TYPE = "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties";

async function fromTemplate(blocks: readonly MdBlock[], template: Uint8Array, core: string, modifiedAt: Date): Promise<Uint8Array> {
  const zip = openZip(template);
  const pkg = new PackageEditor(zip);
  const mainPart = await findMainPart(zip, "word/document.xml");
  const contentTypes = new ContentTypesEditor(await requiredText(pkg, "[Content_Types].xml"));
  const mainType = contentTypes.override(mainPart);
  if (mainType === CONTENT_TYPES.macroDocument || mainType === CONTENT_TYPES.macroTemplate) {
    throw new DocumentConversionError("unsupported", "The template is macro-enabled (.dotm or .docm); save it as a .dotx or .docx to use it.");
  }
  if (mainType !== CONTENT_TYPES.document) contentTypes.setOverride(mainPart, CONTENT_TYPES.document);

  const relationshipsPart = relationshipsPartName(mainPart);
  const relationships = new RelationshipsEditor(await pkg.text(relationshipsPart));
  const existing = await readRelationships(zip, mainPart);
  const stylesPart = findRelationship(existing, "styles")?.target;
  const numberingPart = findRelationship(existing, "numbering")?.target;
  const stylesXml = stylesPart === undefined ? undefined : await pkg.text(stylesPart);
  const numberingXml = numberingPart === undefined ? undefined : await pkg.text(numberingPart);
  for (const [name, text] of [[mainPart, undefined], [stylesPart, stylesXml], [numberingPart, numberingXml]] as const) {
    if (name !== undefined) requireTransitional(text ?? await requiredText(pkg, name), name);
  }

  const documentXml = await requiredText(pkg, mainPart);
  const section = finalSection(documentXml);
  const styles = new StyleCatalog(stylesXml);
  const numbering = new NumberingAllocator(numberingXml);
  const content = body(blocks, { styles, numbering, hyperlink: url => relationships.hyperlink(url), textWidth: section.textWidth });

  pkg.set(mainPart, documentXml.slice(0, section.bodyStart) + content + section.xml + documentXml.slice(section.bodyEnd));
  for (const relationship of existing.values()) {
    if (relationship.external) continue;
    if (COMMENT_PARTS.has(relationship.type)) {
      relationships.remove(relationship.id);
      contentTypes.removeOverride(relationship.target);
      pkg.delete(relationship.target);
    } else if (relationship.type === "footnotes" || relationship.type === "endnotes") {
      // Only the separators stay: settings.xml names them by id, and nothing cites the rest now.
      const notes = await pkg.text(relationship.target);
      if (notes !== undefined) pkg.set(relationship.target, withoutElements(notes, relationship.target, note => !SEPARATOR_NOTES.has(note.attributes.get("w:type") ?? "")));
    }
  }
  await detachTemplate(zip, pkg, existing);
  const directory = mainPart.slice(0, mainPart.lastIndexOf("/") + 1);
  if (stylesPart === undefined) {
    relationships.add("styles", "styles.xml");
    contentTypes.setOverride(`${directory}styles.xml`, CONTENT_TYPES.styles);
  }
  pkg.set(stylesPart ?? `${directory}styles.xml`, styles.serialize());
  if (numbering.used) {
    if (numberingPart === undefined) {
      relationships.add("numbering", "numbering.xml");
      contentTypes.setOverride(`${directory}numbering.xml`, CONTENT_TYPES.numbering);
    }
    pkg.set(numberingPart ?? `${directory}numbering.xml`, numbering.serialize());
  }
  if (relationships.changed) pkg.set(relationshipsPart, relationships.toString());

  const packageRelationships = new RelationshipsEditor(await pkg.text("_rels/.rels"));
  const corePart = findRelationship(await readRelationships(zip, ""), "core-properties")?.target;
  if (corePart === undefined) {
    packageRelationships.add(CORE_TYPE, "docProps/core.xml");
    pkg.set("_rels/.rels", packageRelationships.toString());
    contentTypes.setOverride("docProps/core.xml", CONTENT_TYPES.core);
  }
  pkg.set(corePart ?? "docProps/core.xml", core);
  if (contentTypes.changed) pkg.set("[Content_Types].xml", contentTypes.toString());
  return pkg.write(modifiedAt);
}

/** Removes the template's link to its own template, which Word would fetch when the document opens. */
async function detachTemplate(zip: ZipArchive, pkg: PackageEditor, existing: Relationships): Promise<void> {
  const settingsPart = findRelationship(existing, "settings")?.target;
  const settings = settingsPart === undefined ? undefined : await pkg.text(settingsPart);
  if (settingsPart === undefined || settings === undefined) return;
  const attached = [...(await readRelationships(zip, settingsPart)).values()].filter(relationship => relationship.type === "attachedTemplate");
  if (attached.length === 0) return;
  const relationshipsPart = relationshipsPartName(settingsPart);
  const relationships = new RelationshipsEditor(await pkg.text(relationshipsPart));
  for (const relationship of attached) relationships.remove(relationship.id);
  pkg.set(relationshipsPart, relationships.toString());
  pkg.set(settingsPart, withoutElements(settings, settingsPart, element => element.name === "w:attachedTemplate"));
}

/** The part with the root's children `drop` selects removed, the rest byte for byte. */
function withoutElements(text: string, partName: string, drop: (element: { name: string; attributes: ReadonlyMap<string, string> }) => boolean): string {
  requireTransitional(text, partName);
  try {
    const splices: Splice[] = rawChildren(parseRaw(text)).filter(drop).map(element => ({ start: element.start, end: element.end, text: "" }));
    return applySplices(text, splices);
  } catch (error) {
    if (error instanceof RawXmlError) throw new DocumentConversionError("corrupt", `The template's ${partName} can't be read: ${error.message}`, { cause: error });
    throw error;
  }
}

async function requiredText(pkg: PackageEditor, name: string): Promise<string> {
  const text = await pkg.text(name);
  if (text === undefined) throw new DocumentConversionError("corrupt", `The template has no ${name} part.`);
  return text;
}

/**
 * Parts are edited as text, which relies on the conventional `w:` prefix for WordprocessingML in
 * its Transitional namespace; Word always writes that, so anything else is refused, not guessed at.
 */
export function requireTransitional(text: string, partName: string): void {
  const root = /<(?!\?|!)[^>]*>/.exec(text)?.[0] ?? "";
  if (!root.includes(`xmlns:w="${W_NS}"`)) {
    throw new DocumentConversionError("unsupported",
      `${partName} is not in Word's usual (Transitional) format, so it can't be edited safely; save it from Word as a .docx first.`);
  }
}

/** Where the body's content sits, and the final section properties that close it. */
interface FinalSection {
  readonly bodyStart: number;
  readonly bodyEnd: number;
  /** The body's closing `w:sectPr`, as written, or a default one. */
  readonly xml: string;
  /** The width between the margins, in twips. */
  readonly textWidth: number;
}

function finalSection(documentXml: string): FinalSection {
  const open = /<w:body(?:\s[^>]*)?>/.exec(documentXml);
  const bodyEnd = documentXml.lastIndexOf("</w:body>");
  if (!open || bodyEnd === -1) {
    if (/<w:body\s*\/>/.test(documentXml)) {
      throw new DocumentConversionError("unsupported", "The template's body is empty and self-closed; open and save it in Word first.");
    }
    throw new DocumentConversionError("corrupt", "The template's document part has no body.");
  }
  const bodyStart = open.index + open[0].length;
  const root = parsePart(documentXml);
  const bodyElement = firstChild(root, "w:body");
  const last = childElements(bodyElement).at(-1);
  if (last?.name !== "w:sectPr") return { bodyStart, bodyEnd, xml: DEFAULT_SECTION, textWidth: DEFAULT_TEXT_WIDTH };
  // The body's own section properties open before any `w:sectPr` nested in them (a tracked layout
  // change holds the earlier ones), so theirs is the last opening tag but those.
  const nested = [...descendants(last, "w:sectPr")].length;
  const sectionStart = [...documentXml.slice(0, bodyEnd).matchAll(/<w:sectPr[\s>/]/g)].at(-1 - nested)!.index;
  return { bodyStart, bodyEnd, xml: documentXml.slice(sectionStart, bodyEnd), textWidth: textWidth(last) };
}

/** The page width less its margins and gutter, as tables are sized to fill it. */
export function textWidth(section: XmlElement | undefined): number {
  const twips = (element: XmlElement | undefined, name: string): number | undefined => {
    const value = Number(attribute(element, name));
    return Number.isFinite(value) ? value : undefined;
  };
  const size = firstChild(section, "w:pgSz");
  const margins = firstChild(section, "w:pgMar");
  const width = twips(size, "w:w");
  if (width === undefined) return DEFAULT_TEXT_WIDTH;
  const result = width - (twips(margins, "w:left") ?? 1440) - (twips(margins, "w:right") ?? 1440) - (twips(margins, "w:gutter") ?? 0);
  return result >= 1440 ? Math.round(result) : DEFAULT_TEXT_WIDTH;
}
