// The paragraph, character and table styles the Word writer lays Markdown out with, as Word's own
// built-in styles: Heading 1–6, List Paragraph, Quote, Hyperlink, HTML Preformatted and HTML Code
// for code, and Grid Table 4 Accent 1 for tables. Using built-ins, matched by name rather than id,
// is what makes the navigation pane, a table of contents and an organization's theme work, and
// what lets a template's own definitions win: a template that styles Heading 1 its own way keeps
// its look. A style the document lacks is added with the definition below, whose colors and fonts
// refer to the theme, so even an added style takes on the template's palette.

import { attribute, childElements, firstChild } from "./xml";
import { escapeAttribute, parsePart, XML_DECLARATION } from "./ooxml";

/** A style the writer uses. */
export type StyleRole =
  | "normal" | "defaultParagraphFont" | "tableNormal" | "noList"
  | "heading1" | "heading2" | "heading3" | "heading4" | "heading5" | "heading6"
  | "listParagraph" | "quote" | "hyperlink" | "codeBlock" | "codeChar" | "table";

interface StyleDefinition {
  readonly type: "paragraph" | "character" | "table" | "numbering";
  /** Word's built-in name, which identifies the style whatever its id. */
  readonly name: string;
  readonly id: string;
  readonly isDefault?: boolean;
  /** Children after `w:name`, with `{normal}`-style placeholders for the ids of other roles. */
  readonly body: string;
}

const HEADING_COLOR = '<w:color w:val="0F4761" w:themeColor="accent1" w:themeShade="BF"/>';
const MAJOR_FONT = '<w:rFonts w:ascii="Aptos Display" w:hAnsi="Aptos Display" w:eastAsia="Aptos Display" w:cs="Aptos Display" ' +
  'w:asciiTheme="majorHAnsi" w:hAnsiTheme="majorHAnsi" w:eastAsiaTheme="majorEastAsia" w:cstheme="majorBidi"/>';
const MONO_FONT = '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/>';

function heading(level: number, size: number, extraRun = ""): StyleDefinition {
  const before = [360, 160, 160, 80, 80, 40][level - 1]!;
  const after = [80, 80, 80, 40, 40, 0][level - 1]!;
  return {
    type: "paragraph", name: `heading ${level}`, id: `Heading${level}`,
    body: `<w:basedOn w:val="{normal}"/><w:next w:val="{normal}"/><w:uiPriority w:val="9"/>${level > 1 ? '<w:unhideWhenUsed/>' : ""}<w:qFormat/>` +
      `<w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="${before}" w:after="${after}"/><w:outlineLvl w:val="${level - 1}"/></w:pPr>` +
      `<w:rPr>${level <= 3 ? MAJOR_FONT : ""}${extraRun}${HEADING_COLOR}<w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr>`,
  };
}

const DEFINITIONS: Readonly<Record<StyleRole, StyleDefinition>> = {
  normal: {
    type: "paragraph", name: "Normal", id: "Normal", isDefault: true,
    body: '<w:qFormat/>',
  },
  defaultParagraphFont: {
    type: "character", name: "Default Paragraph Font", id: "DefaultParagraphFont", isDefault: true,
    body: '<w:uiPriority w:val="1"/><w:semiHidden/><w:unhideWhenUsed/>',
  },
  tableNormal: {
    type: "table", name: "Normal Table", id: "TableNormal", isDefault: true,
    body: '<w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/>' +
      '<w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/>' +
      '<w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr>',
  },
  noList: {
    type: "numbering", name: "No List", id: "NoList", isDefault: true,
    body: '<w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/>',
  },
  heading1: heading(1, 40),
  heading2: heading(2, 32),
  heading3: heading(3, 28),
  heading4: heading(4, 22, "<w:i/><w:iCs/>"),
  heading5: heading(5, 22),
  heading6: heading(6, 22, "<w:i/><w:iCs/>"),
  listParagraph: {
    type: "paragraph", name: "List Paragraph", id: "ListParagraph",
    body: '<w:basedOn w:val="{normal}"/><w:uiPriority w:val="34"/><w:qFormat/><w:pPr><w:ind w:left="720"/><w:contextualSpacing/></w:pPr>',
  },
  quote: {
    type: "paragraph", name: "Quote", id: "Quote",
    body: '<w:basedOn w:val="{normal}"/><w:next w:val="{normal}"/><w:uiPriority w:val="29"/><w:qFormat/>' +
      '<w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="12" w:color="156082" w:themeColor="accent1"/></w:pBdr>' +
      '<w:spacing w:before="120" w:after="120"/><w:ind w:left="720" w:right="720"/></w:pPr>' +
      '<w:rPr><w:i/><w:iCs/><w:color w:val="404040" w:themeColor="text1" w:themeTint="BF"/></w:rPr>',
  },
  hyperlink: {
    type: "character", name: "Hyperlink", id: "Hyperlink",
    body: '<w:basedOn w:val="{defaultParagraphFont}"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/>' +
      '<w:rPr><w:color w:val="467886" w:themeColor="hyperlink"/><w:u w:val="single"/></w:rPr>',
  },
  codeBlock: {
    type: "paragraph", name: "HTML Preformatted", id: "HTMLPreformatted",
    body: '<w:basedOn w:val="{normal}"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/>' +
      '<w:pPr><w:pBdr><w:top w:val="single" w:sz="4" w:space="6" w:color="D9D9D9"/><w:left w:val="single" w:sz="4" w:space="6" w:color="D9D9D9"/>' +
      '<w:bottom w:val="single" w:sz="4" w:space="6" w:color="D9D9D9"/><w:right w:val="single" w:sz="4" w:space="6" w:color="D9D9D9"/></w:pBdr>' +
      '<w:shd w:val="clear" w:color="auto" w:fill="F5F5F5"/><w:spacing w:before="120" w:after="240" w:line="240" w:lineRule="auto"/>' +
      '<w:ind w:left="144" w:right="144"/></w:pPr>' +
      `<w:rPr>${MONO_FONT}<w:sz w:val="19"/><w:szCs w:val="19"/></w:rPr>`,
  },
  codeChar: {
    type: "character", name: "HTML Code", id: "HTMLCode",
    body: `<w:basedOn w:val="{defaultParagraphFont}"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/>` +
      `<w:rPr>${MONO_FONT}<w:color w:val="C0392B"/><w:sz w:val="20"/><w:szCs w:val="20"/>` +
      '<w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/></w:rPr>',
  },
  table: {
    type: "table", name: "Grid Table 4 Accent 1", id: "GridTable4-Accent1",
    body: '<w:basedOn w:val="{tableNormal}"/><w:uiPriority w:val="49"/>' +
      '<w:pPr><w:spacing w:before="40" w:after="40" w:line="240" w:lineRule="auto"/></w:pPr>' +
      '<w:tblPr><w:tblStyleRowBandSize w:val="1"/><w:tblStyleColBandSize w:val="1"/><w:tblBorders>' +
      ["top", "left", "bottom", "right", "insideH", "insideV"].map(side =>
        `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="45B0E1" w:themeColor="accent1" w:themeTint="99"/>`).join("") +
      '</w:tblBorders><w:tblCellMar><w:top w:w="58" w:type="dxa"/><w:left w:w="115" w:type="dxa"/>' +
      '<w:bottom w:w="58" w:type="dxa"/><w:right w:w="115" w:type="dxa"/></w:tblCellMar></w:tblPr>' +
      '<w:tblStylePr w:type="firstRow"><w:rPr><w:b/><w:bCs/><w:color w:val="FFFFFF" w:themeColor="background1"/></w:rPr>' +
      '<w:tblPr/><w:tcPr><w:tcBorders>' +
      ["top", "left", "bottom", "right"].map(side =>
        `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="156082" w:themeColor="accent1"/>`).join("") +
      '<w:insideH w:val="nil"/><w:insideV w:val="nil"/></w:tcBorders>' +
      '<w:shd w:val="clear" w:color="auto" w:fill="156082" w:themeFill="accent1"/></w:tcPr></w:tblStylePr>' +
      '<w:tblStylePr w:type="band1Horz"><w:tblPr/><w:tcPr>' +
      '<w:shd w:val="clear" w:color="auto" w:fill="C1E4F5" w:themeFill="accent1" w:themeFillTint="33"/></w:tcPr></w:tblStylePr>',
  },
};

/** Every role, in the order a new document's styles part lists them. */
export const ALL_ROLES = Object.keys(DEFINITIONS) as StyleRole[];

/** The document defaults a new document's styles part opens with: Aptos 11pt, Office's spacing. */
const DOC_DEFAULTS = '<w:docDefaults><w:rPrDefault><w:rPr>' +
  '<w:rFonts w:ascii="Aptos" w:hAnsi="Aptos" w:eastAsia="Aptos" w:cs="Aptos" w:asciiTheme="minorHAnsi" w:eastAsiaTheme="minorEastAsia" ' +
  'w:hAnsiTheme="minorHAnsi" w:cstheme="minorBidi"/><w:kern w:val="2"/><w:sz w:val="22"/><w:szCs w:val="22"/>' +
  '<w:lang w:val="en-US" w:eastAsia="en-US" w:bidi="ar-SA"/></w:rPr></w:rPrDefault>' +
  '<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="278" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>';

interface ExistingStyle {
  readonly id: string;
  readonly type: string;
  readonly name: string;
  readonly isDefault: boolean;
  /** For a list style such as List Bullet, the numbering its paragraphs take. */
  readonly numbering?: { readonly numId: string; readonly level: number };
  /** Whether the document had the style, rather than this catalog adding it. */
  readonly own: boolean;
}

/** A document's own list paragraph style, and the numbering it carries. */
export interface ListStyle {
  readonly id: string;
  readonly numId: string;
  readonly level: number;
}

/**
 * The styles of one document: which existing style plays each role, and which definitions must be
 * added. A role is looked up by its built-in name (case-insensitively, since Word lower-cases some),
 * so a localized id such as a German "berschrift1" is still found as heading 1.
 */
export class StyleCatalog {
  readonly #existing: ExistingStyle[];
  readonly #resolved = new Map<StyleRole, string>();
  readonly #added: string[] = [];
  readonly #source: string | undefined;

  /** @param stylesXml The document's styles part, or undefined to write a new one. */
  constructor(stylesXml: string | undefined) {
    this.#source = stylesXml;
    this.#existing = stylesXml === undefined ? [] : childElements(parsePart(stylesXml), "w:style").flatMap(style => {
      const id = attribute(style, "w:styleId");
      const type = attribute(style, "w:type") ?? "paragraph";
      if (id === undefined) return [];
      const name = (attribute(firstChild(style, "w:name"), "w:val") ?? id).toLowerCase();
      const isDefault = ["1", "true", "on"].includes(attribute(style, "w:default") ?? "");
      const numPr = firstChild(firstChild(style, "w:pPr"), "w:numPr");
      const numId = attribute(firstChild(numPr, "w:numId"), "w:val");
      const level = Number(attribute(firstChild(numPr, "w:ilvl"), "w:val") ?? 0);
      const numbering = numId !== undefined && numId !== "0" && Number.isInteger(level) ? { numId, level } : undefined;
      return [{ id, type, name, isDefault, numbering, own: true }];
    });
  }

  /** The style id that plays `role`, adding its definition if the document has none. */
  id(role: StyleRole): string {
    const known = this.#resolved.get(role);
    if (known !== undefined) return known;
    const definition = DEFINITIONS[role];
    const existing = this.#existing.find(style => style.type === definition.type && style.name === definition.name.toLowerCase())
      // The document's own default plays the default roles even when it has another name.
      ?? (definition.isDefault ? this.#existing.find(style => style.type === definition.type && style.isDefault) : undefined);
    if (existing) {
      this.#resolved.set(role, existing.id);
      return existing.id;
    }
    const id = this.#freeId(definition.id);
    this.#resolved.set(role, id);
    // A default is only claimed when the document has none of that type, or Word would see two.
    const isDefault = definition.isDefault && !this.#existing.some(style => style.type === definition.type && style.isDefault);
    const body = definition.body.replace(/\{(\w+)\}/g, (_match, other: string) => this.id(other as StyleRole));
    this.#added.push(`<w:style w:type="${definition.type}"${isDefault ? ' w:default="1"' : ""} w:styleId="${escapeAttribute(id)}">` +
      `<w:name w:val="${escapeAttribute(definition.name)}"/>${body}</w:style>`);
    this.#existing.push({ id, type: definition.type, name: definition.name.toLowerCase(), isDefault: isDefault ?? false, own: false });
    return id;
  }

  /**
   * The document's own List Bullet or List Number style for a nesting level ("List Bullet 2" for
   * the second), when it has one that carries numbering: lists inserted into a document that uses
   * them then look exactly like the lists already there.
   */
  listStyle(ordered: boolean, level: number): ListStyle | undefined {
    const name = `${ordered ? "list number" : "list bullet"}${level === 0 ? "" : ` ${level + 1}`}`;
    const style = this.#existing.find(candidate => candidate.own && candidate.type === "paragraph" && candidate.name === name);
    return style?.numbering ? { id: style.id, ...style.numbering } : undefined;
  }

  /** Has `role` played by the document's own style `id`, if it has one of the right type. */
  prefer(role: StyleRole, id: string): void {
    if (this.#existing.some(style => style.own && style.id === id && style.type === DEFINITIONS[role].type)) this.#resolved.set(role, id);
  }

  /** Whether `role` has been resolved. */
  has(role: StyleRole): boolean {
    return this.#resolved.has(role);
  }

  /** Whether resolving roles added any definitions. */
  get changed(): boolean {
    return this.#added.length > 0;
  }

  /**
   * The styles part with the added definitions. The document's own part is otherwise kept as
   * written; a new document's opens with Office's defaults.
   */
  serialize(): string {
    if (this.#source === undefined) {
      return `${XML_DECLARATION}<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
        `${DOC_DEFAULTS}${this.#added.join("")}</w:styles>`;
    }
    if (!this.changed) return this.#source;
    const close = this.#source.lastIndexOf("</w:styles>");
    if (close === -1) throw new Error("The document's styles part has no closing w:styles tag.");
    return this.#source.slice(0, close) + this.#added.join("") + this.#source.slice(close);
  }

  #freeId(preferred: string): string {
    const taken = new Set(this.#existing.map(style => style.id.toLowerCase()));
    if (!taken.has(preferred.toLowerCase())) return preferred;
    for (let suffix = 2; ; suffix++) {
      if (!taken.has(`${preferred}${suffix}`.toLowerCase())) return `${preferred}${suffix}`;
    }
  }
}
