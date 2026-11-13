// The formatting a Word document inherits rather than states: theme fonts and colours, styles.xml
// and numbering.xml. Each `w:rPr`, `w:pPr`, `w:tblPr` and `w:tcPr` is parsed into a sparse
// "format" holding only what it sets, so that layers can be merged in Word's order by the reader
// in docx-document.ts. Lengths are in points and colours are `#RRGGBB` throughout.

import type { DocxBorder, DocxTabStop } from "./docx-document";
import { isOn } from "./ooxml";
import { attribute, childElements, firstChild, type XmlElement } from "./xml";

/** A decimal attribute value, or undefined when it is absent or not a plain number. */
export function numeric(value: string | undefined): number | undefined {
  if (value === undefined || !/^-?\d{1,9}(\.\d{1,6})?$/.test(value.trim())) return undefined;
  return Number.parseFloat(value);
}

/** An attribute in twentieths of a point, as points. */
export function twips(element: XmlElement | undefined, name: string): number | undefined {
  const value = numeric(attribute(element, name));
  return value === undefined ? undefined : value / 20;
}

/** `layers` merged left to right; a layer overrides only the properties it sets. */
export function layered<T extends object>(...layers: readonly (T | undefined)[]): T {
  const out: Record<string, unknown> = {};
  for (const layer of layers) {
    if (!layer) continue;
    for (const [key, value] of Object.entries(layer)) {
      if (value !== undefined) out[key] = value;
    }
  }
  return out as T;
}

// ---- Theme ----

/** The names WordprocessingML uses for a theme's twelve colour slots. */
const THEME_COLOR_SLOTS: Readonly<Record<string, string>> = {
  dark1: "dk1", text1: "dk1", light1: "lt1", background1: "lt1",
  dark2: "dk2", text2: "dk2", light2: "lt2", background2: "lt2",
  accent1: "accent1", accent2: "accent2", accent3: "accent3", accent4: "accent4", accent5: "accent5", accent6: "accent6",
  hyperlink: "hlink", followedHyperlink: "folHlink",
};

/** theme1.xml: the fonts behind `asciiTheme` and the colours behind `themeColor`. */
export class Theme {
  readonly #colors = new Map<string, string>();
  readonly #majorFont: string | undefined;
  readonly #minorFont: string | undefined;

  constructor(root: XmlElement | undefined) {
    const elements = firstChild(root, "a:themeElements");
    for (const slot of childElements(firstChild(elements, "a:clrScheme"))) {
      const color = childElements(slot)[0];
      const hex = hexColor(color?.name === "a:sysClr" ? attribute(color, "lastClr") : attribute(color, "val"));
      if (hex) this.#colors.set(slot.name.replace(/^a:/, ""), hex);
    }
    const fonts = firstChild(elements, "a:fontScheme");
    this.#majorFont = attribute(firstChild(firstChild(fonts, "a:majorFont"), "a:latin"), "typeface") || undefined;
    this.#minorFont = attribute(firstChild(firstChild(fonts, "a:minorFont"), "a:latin"), "typeface") || undefined;
  }

  /** The Latin font for a theme font name such as `majorHAnsi` or `minorAscii`. */
  font(name: string | undefined): string | undefined {
    if (name === undefined) return undefined;
    return name.startsWith("major") ? this.#majorFont : name.startsWith("minor") ? this.#minorFont : undefined;
  }

  /**
   * A theme colour lightened by `tint` or darkened by `shade`: each is a two-digit hex fraction
   * that scales the colour's lightness, towards white for a tint. This is how Word arrives at the
   * `w:val` it caches beside them.
   */
  color(name: string | undefined, tint: string | undefined, shade: string | undefined): string | undefined {
    const base = name === undefined ? undefined : this.#colors.get(THEME_COLOR_SLOTS[name] ?? "");
    if (!base) return undefined;
    const keepTint = hexFraction(tint);
    const keepShade = hexFraction(shade);
    if (keepTint === undefined && keepShade === undefined) return base;
    const [red, green, blue] = [1, 3, 5].map(at => Number.parseInt(base.slice(at, at + 2), 16) / 255) as [number, number, number];
    const max = Math.max(red, green, blue);
    const min = Math.min(red, green, blue);
    let lightness = (max + min) / 2;
    const saturation = max === min ? 0 : (max - min) / (1 - Math.abs(2 * lightness - 1));
    if (keepTint !== undefined) lightness = lightness * keepTint + (1 - keepTint);
    if (keepShade !== undefined) lightness *= keepShade;
    // Hue is unchanged, so each channel keeps its rank and its share of the new chroma.
    const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
    const floor = lightness - chroma / 2;
    const channels = [red, green, blue].map(channel => {
      const share = max === min ? 0 : (channel - min) / (max - min);
      return Math.round((floor + share * chroma) * 255).toString(16).padStart(2, "0");
    });
    return `#${channels.join("").toUpperCase()}`;
  }
}

function hexFraction(value: string | undefined): number | undefined {
  return value !== undefined && /^[0-9a-fA-F]{2}$/.test(value) ? Number.parseInt(value, 16) / 255 : undefined;
}

function hexColor(value: string | undefined): string | undefined {
  return value !== undefined && /^[0-9a-fA-F]{6}$/.test(value) ? `#${value.toUpperCase()}` : undefined;
}

/** A colour as written: a theme colour when it resolves, else the literal value. `auto` is kept as such. */
function readColor(
  element: XmlElement | undefined, theme: Theme, value: string, themeColor: string, tint: string, shade: string,
): string | undefined {
  if (!element) return undefined;
  const themed = theme.color(attribute(element, themeColor), attribute(element, tint), attribute(element, shade));
  if (themed) return themed;
  const literal = attribute(element, value);
  return literal === "auto" ? "auto" : hexColor(literal);
}

/** A `w:shd` fill: a colour, or `none` for one that clears an inherited fill. */
function readShading(shading: XmlElement | undefined, theme: Theme): string | undefined {
  if (!shading) return undefined;
  if (attribute(shading, "w:val") === "nil") return "none";
  const solid = attribute(shading, "w:val") === "solid";
  const color = solid
    ? readColor(shading, theme, "w:color", "w:themeColor", "w:themeTint", "w:themeShade")
    : readColor(shading, theme, "w:fill", "w:themeFill", "w:themeFillTint", "w:themeFillShade");
  return color === undefined || color === "auto" ? "none" : color;
}

// ---- Run formatting ----

/** How a run is underlined. */
export type Underline = "single" | "double" | "dotted" | "dashed" | "wavy";

/** What one `w:rPr` sets. `auto` and `none` are explicit resets of an inherited value. */
export interface RunFormat {
  readonly font?: string;
  readonly size?: number;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly underline?: Underline | "none";
  readonly underlineColor?: string;
  readonly strike?: boolean;
  readonly color?: string;
  readonly highlight?: string;
  readonly shading?: string;
  readonly verticalAlign?: "baseline" | "superscript" | "subscript";
  readonly caps?: boolean;
  readonly smallCaps?: boolean;
  readonly letterSpacing?: number;
  readonly hidden?: boolean;
}

const HIGHLIGHT_COLORS: Readonly<Record<string, string>> = {
  yellow: "#FFFF00", green: "#00FF00", cyan: "#00FFFF", magenta: "#FF00FF", blue: "#0000FF", red: "#FF0000",
  darkBlue: "#000080", darkCyan: "#008080", darkGreen: "#008000", darkMagenta: "#800080", darkRed: "#800000",
  darkYellow: "#808000", darkGray: "#808080", lightGray: "#C0C0C0", black: "#000000", white: "#FFFFFF", none: "none",
};

function toggle(properties: XmlElement | undefined, name: string): boolean | undefined {
  const element = firstChild(properties, name);
  return element ? isOn(element, "w:val") : undefined;
}

function readUnderline(element: XmlElement | undefined): Underline | "none" | undefined {
  if (!element) return undefined;
  const value = attribute(element, "w:val") ?? "single";
  if (value === "none") return "none";
  if (value === "double") return "double";
  if (value.startsWith("dott")) return "dotted";
  if (value.startsWith("dash") || value.startsWith("dotD")) return "dashed";
  if (value.startsWith("wav")) return "wavy";
  return "single";
}

/** Parses a `w:rPr`. A theme font wins over a literal one on the same element, as in Word. */
export function readRunFormat(properties: XmlElement | undefined, theme: Theme): RunFormat {
  if (!properties) return {};
  const fonts = firstChild(properties, "w:rFonts");
  const size = numeric(attribute(firstChild(properties, "w:sz"), "w:val"));
  const vertical = attribute(firstChild(properties, "w:vertAlign"), "w:val");
  const highlight = attribute(firstChild(properties, "w:highlight"), "w:val");
  return layered<RunFormat>({
    font: theme.font(attribute(fonts, "w:asciiTheme") ?? attribute(fonts, "w:hAnsiTheme"))
      ?? attribute(fonts, "w:ascii") ?? attribute(fonts, "w:hAnsi"),
    size: size === undefined ? undefined : size / 2,
    bold: toggle(properties, "w:b"),
    italic: toggle(properties, "w:i"),
    underline: readUnderline(firstChild(properties, "w:u")),
    underlineColor: readColor(firstChild(properties, "w:u"), theme, "w:color", "w:themeColor", "w:themeTint", "w:themeShade"),
    strike: toggle(properties, "w:strike") ?? toggle(properties, "w:dstrike"),
    color: readColor(firstChild(properties, "w:color"), theme, "w:val", "w:themeColor", "w:themeTint", "w:themeShade"),
    highlight: highlight === undefined ? undefined : HIGHLIGHT_COLORS[highlight],
    shading: readShading(firstChild(properties, "w:shd"), theme),
    verticalAlign: vertical === "superscript" || vertical === "subscript" || vertical === "baseline" ? vertical : undefined,
    caps: toggle(properties, "w:caps"),
    smallCaps: toggle(properties, "w:smallCaps"),
    letterSpacing: twips(firstChild(properties, "w:spacing"), "w:val"),
    hidden: toggle(properties, "w:vanish") ?? toggle(properties, "w:webHidden"),
  });
}

// ---- Borders ----

/** A border, or `none` for one that removes an inherited border. */
export type BorderFormat = DocxBorder | "none";

/** The borders an element may set: a box's four edges, and the lines between a table's cells. */
export interface BorderEdges {
  readonly top?: BorderFormat;
  readonly right?: BorderFormat;
  readonly bottom?: BorderFormat;
  readonly left?: BorderFormat;
  readonly insideH?: BorderFormat;
  readonly insideV?: BorderFormat;
}

function readBorder(element: XmlElement | undefined, theme: Theme): BorderFormat | undefined {
  if (!element) return undefined;
  const value = attribute(element, "w:val") ?? "single";
  if (value === "nil" || value === "none") return "none";
  const color = readColor(element, theme, "w:color", "w:themeColor", "w:themeTint", "w:themeShade");
  return {
    // Eighths of a point.
    width: Math.max(0.25, (numeric(attribute(element, "w:sz")) ?? 4) / 8),
    color: color === undefined || color === "auto" ? "#000000" : color,
    style: value === "double" || value === "triple" ? "double" : value === "dotted" ? "dotted" : /dash/i.test(value) ? "dashed" : "solid",
    space: numeric(attribute(element, "w:space")) ?? 0,
  };
}

/** Parses `w:pBdr`, `w:tblBorders` or `w:tcBorders`; `start` and `end` are the Strict names for left and right. */
function readBorders(element: XmlElement | undefined, theme: Theme): BorderEdges | undefined {
  if (!element) return undefined;
  const edge = (...names: string[]) => readBorder(names.map(name => firstChild(element, name)).find(Boolean), theme);
  return layered<BorderEdges>({
    top: edge("w:top"), right: edge("w:right", "w:end"), bottom: edge("w:bottom"), left: edge("w:left", "w:start"),
    insideH: edge("w:insideH"), insideV: edge("w:insideV"),
  });
}

// ---- Paragraph formatting ----

/** A tab stop as a `w:tabs` lists it; `clear` removes an inherited stop at its position. */
export interface TabFormat extends DocxTabStop {
  readonly clear: boolean;
}

/** What one `w:pPr` sets. */
export interface ParagraphFormat {
  readonly alignment?: "left" | "center" | "right" | "justify";
  readonly spacingBefore?: number;
  readonly spacingAfter?: number;
  /** `w:line` as written: 240ths of a line when the rule is `auto`, twentieths of a point otherwise. */
  readonly line?: number;
  readonly lineRule?: "auto" | "exact" | "atLeast";
  readonly indentLeft?: number;
  readonly indentRight?: number;
  /** Positive for a first-line indent, negative for a hanging one. */
  readonly indentFirstLine?: number;
  readonly borders?: BorderEdges;
  readonly shading?: string;
  readonly tabs?: readonly TabFormat[];
  readonly numId?: string;
  readonly level?: number;
  readonly contextualSpacing?: boolean;
  readonly pageBreakBefore?: boolean;
  readonly outlineLevel?: number;
}

const ALIGNMENTS: Readonly<Record<string, ParagraphFormat["alignment"]>> = {
  left: "left", start: "left", center: "center", right: "right", end: "right", both: "justify", distribute: "justify",
};

/** What Word uses for "auto" paragraph spacing, the kind HTML imports ask for. */
const AUTO_SPACING = 14;

/** Parses a `w:pPr`. */
export function readParagraphFormat(properties: XmlElement | undefined, theme: Theme): ParagraphFormat {
  if (!properties) return {};
  const spacing = firstChild(properties, "w:spacing");
  const indent = firstChild(properties, "w:ind");
  const numbering = firstChild(properties, "w:numPr");
  const hanging = twips(indent, "w:hanging");
  const line = numeric(attribute(spacing, "w:line"));
  const lineRule = attribute(spacing, "w:lineRule");
  const tabs = childElements(firstChild(properties, "w:tabs"), "w:tab").flatMap((tab): TabFormat[] => {
    const position = twips(tab, "w:pos");
    const kind = attribute(tab, "w:val");
    if (position === undefined) return [];
    return [{
      position,
      alignment: kind === "center" ? "center" : kind === "right" || kind === "end" ? "right" : "left",
      clear: kind === "clear",
    }];
  });
  return layered<ParagraphFormat>({
    alignment: ALIGNMENTS[attribute(firstChild(properties, "w:jc"), "w:val") ?? ""],
    spacingBefore: isOn(spacing, "w:beforeAutospacing") && attribute(spacing, "w:beforeAutospacing") !== undefined
      ? AUTO_SPACING : twips(spacing, "w:before"),
    spacingAfter: isOn(spacing, "w:afterAutospacing") && attribute(spacing, "w:afterAutospacing") !== undefined
      ? AUTO_SPACING : twips(spacing, "w:after"),
    line,
    // A line height with no rule beside it is a multiple, whatever rule was inherited.
    lineRule: lineRule === "exact" || lineRule === "atLeast" || lineRule === "auto" ? lineRule : line === undefined ? undefined : "auto",
    indentLeft: twips(indent, "w:left") ?? twips(indent, "w:start"),
    indentRight: twips(indent, "w:right") ?? twips(indent, "w:end"),
    indentFirstLine: hanging === undefined ? twips(indent, "w:firstLine") : -hanging,
    borders: readBorders(firstChild(properties, "w:pBdr"), theme),
    shading: readShading(firstChild(properties, "w:shd"), theme),
    tabs: tabs.length > 0 ? tabs : undefined,
    numId: attribute(firstChild(numbering, "w:numId"), "w:val"),
    level: listLevel(attribute(firstChild(numbering, "w:ilvl"), "w:val")),
    contextualSpacing: toggle(properties, "w:contextualSpacing"),
    pageBreakBefore: toggle(properties, "w:pageBreakBefore"),
    outlineLevel: numeric(attribute(firstChild(properties, "w:outlineLvl"), "w:val")),
  });
}

/** Paragraph layers merged left to right. Borders merge edge by edge and tab stops by position. */
export function layeredParagraph(...layers: readonly (ParagraphFormat | undefined)[]): ParagraphFormat {
  const borders = layered<BorderEdges>(...layers.map(layer => layer?.borders));
  const tabs = new Map<number, TabFormat>();
  for (const layer of layers) {
    for (const tab of layer?.tabs ?? []) tabs.set(tab.position, tab);
  }
  return {
    ...layered<ParagraphFormat>(...layers),
    ...(Object.keys(borders).length > 0 ? { borders } : {}),
    ...(tabs.size > 0 ? { tabs: [...tabs.values()] } : {}),
  };
}

// ---- Table formatting ----

/** Space between a cell's edges and its content. */
export interface CellMargins {
  readonly top?: number;
  readonly right?: number;
  readonly bottom?: number;
  readonly left?: number;
}

/** Which of a table style's conditional formats the table asks for (`w:tblLook`). */
export interface TableLook {
  readonly firstRow: boolean;
  readonly lastRow: boolean;
  readonly firstColumn: boolean;
  readonly lastColumn: boolean;
  readonly bandedRows: boolean;
  readonly bandedColumns: boolean;
}

/** What one `w:tblPr` sets. */
export interface TableFormat {
  readonly borders?: BorderEdges;
  readonly cellMargins?: CellMargins;
  readonly indent?: number;
  readonly alignment?: "left" | "center" | "right";
  readonly rowBandSize?: number;
  readonly columnBandSize?: number;
  readonly look?: TableLook;
}

/** What one `w:tcPr` sets. */
export interface CellFormat {
  readonly borders?: BorderEdges;
  readonly shading?: string;
  readonly margins?: CellMargins;
  readonly verticalAlign?: "top" | "center" | "bottom";
}

function readMargins(element: XmlElement | undefined): CellMargins | undefined {
  if (!element) return undefined;
  const side = (...names: string[]) => twips(names.map(name => firstChild(element, name)).find(Boolean), "w:w");
  return layered<CellMargins>({ top: side("w:top"), right: side("w:right", "w:end"), bottom: side("w:bottom"), left: side("w:left", "w:start") });
}

/** `w:tblLook`: on/off attributes in current files, the same flags as a hex bitmask in older ones. */
function readLook(element: XmlElement | undefined): TableLook | undefined {
  if (!element) return undefined;
  const mask = Number.parseInt(attribute(element, "w:val") ?? "", 16);
  const flag = (name: string, bit: number): boolean => {
    const value = attribute(element, name);
    if (value !== undefined) return isOn(element, name);
    return Number.isNaN(mask) ? false : (mask & bit) !== 0;
  };
  return {
    firstRow: flag("w:firstRow", 0x0020), lastRow: flag("w:lastRow", 0x0040),
    firstColumn: flag("w:firstColumn", 0x0080), lastColumn: flag("w:lastColumn", 0x0100),
    bandedRows: !flag("w:noHBand", 0x0200), bandedColumns: !flag("w:noVBand", 0x0400),
  };
}

/** Parses a `w:tblPr`. */
export function readTableFormat(properties: XmlElement | undefined, theme: Theme): TableFormat {
  if (!properties) return {};
  const alignment = attribute(firstChild(properties, "w:jc"), "w:val");
  const indent = firstChild(properties, "w:tblInd");
  return layered<TableFormat>({
    borders: readBorders(firstChild(properties, "w:tblBorders"), theme),
    cellMargins: readMargins(firstChild(properties, "w:tblCellMar")),
    indent: attribute(indent, "w:type") === "dxa" || attribute(indent, "w:type") === undefined ? twips(indent, "w:w") : undefined,
    alignment: alignment === "center" ? "center" : alignment === "right" || alignment === "end" ? "right" : alignment ? "left" : undefined,
    rowBandSize: numeric(attribute(firstChild(properties, "w:tblStyleRowBandSize"), "w:val")),
    columnBandSize: numeric(attribute(firstChild(properties, "w:tblStyleColBandSize"), "w:val")),
    look: readLook(firstChild(properties, "w:tblLook")),
  });
}

/** Parses a `w:tcPr`. */
export function readCellFormat(properties: XmlElement | undefined, theme: Theme): CellFormat {
  if (!properties) return {};
  const vertical = attribute(firstChild(properties, "w:vAlign"), "w:val");
  return layered<CellFormat>({
    borders: readBorders(firstChild(properties, "w:tcBorders"), theme),
    shading: readShading(firstChild(properties, "w:shd"), theme),
    margins: readMargins(firstChild(properties, "w:tcMar")),
    verticalAlign: vertical === "center" || vertical === "bottom" || vertical === "top" ? vertical : undefined,
  });
}

/** Table layers merged left to right, borders and cell margins edge by edge. */
export function layeredTable(...layers: readonly (TableFormat | undefined)[]): TableFormat {
  return {
    ...layered<TableFormat>(...layers),
    borders: layered<BorderEdges>(...layers.map(layer => layer?.borders)),
    cellMargins: layered<CellMargins>(...layers.map(layer => layer?.cellMargins)),
  };
}

/** The formatting one part of a table style carries: the whole table's, or one conditional region's. */
export interface TableStyleRegion {
  readonly paragraph: ParagraphFormat;
  readonly run: RunFormat;
  readonly cell: CellFormat;
}

/** A table style with its `basedOn` chain applied. */
export interface TableStyle extends TableStyleRegion {
  readonly table: TableFormat;
  /** By `w:tblStylePr` type: `firstRow`, `band1Horz`, `nwCell`, ... */
  readonly conditional: ReadonlyMap<string, TableStyleRegion>;
}

function layeredRegion(theme: Theme, base: TableStyleRegion | undefined, element: XmlElement): TableStyleRegion {
  const cell = readCellFormat(firstChild(element, "w:tcPr"), theme);
  return {
    paragraph: layeredParagraph(base?.paragraph, readParagraphFormat(firstChild(element, "w:pPr"), theme)),
    run: layered(base?.run, readRunFormat(firstChild(element, "w:rPr"), theme)),
    cell: {
      ...layered<CellFormat>(base?.cell, cell),
      borders: layered<BorderEdges>(base?.cell.borders, cell.borders),
      margins: layered<CellMargins>(base?.cell.margins, cell.margins),
    },
  };
}

// ---- Styles ----

/** A paragraph style with its `basedOn` chain applied. */
export interface ParagraphStyle {
  readonly paragraph: ParagraphFormat;
  readonly run: RunFormat;
  /** 1 for "Title" and "heading 1", by name: Word localizes style ids but not built-in names. */
  readonly headingLevel: number | undefined;
}

const MAX_STYLE_CHAIN = 16;

/**
 * What Word gives a document that has no stylesheet at all, as some generators write: the
 * formatting of its own blank document rather than the bare defaults of the file format.
 */
const APPLICATION_DEFAULTS: StyleSheet["defaults"] = {
  paragraph: { spacingAfter: 8, line: 278, lineRule: "auto" },
  run: { font: "Aptos", size: 12 },
};

/** styles.xml. Styles are resolved on first use: a real stylesheet defines hundreds a document never uses. */
export class StyleSheet {
  readonly #elements = new Map<string, XmlElement>();
  readonly #paragraphStyles = new Map<string, ParagraphStyle>();
  readonly #characterStyles = new Map<string, RunFormat>();
  readonly #tableStyles = new Map<string, TableStyle>();
  readonly #defaultParagraphStyle: string | undefined;
  readonly #defaultTableStyle: string | undefined;
  /** `w:docDefaults`, the base of every paragraph and run. */
  readonly defaults: { readonly paragraph: ParagraphFormat; readonly run: RunFormat };

  constructor(root: XmlElement | undefined, private readonly theme: Theme) {
    const defaults = firstChild(root, "w:docDefaults");
    this.defaults = root ? {
      paragraph: readParagraphFormat(firstChild(firstChild(defaults, "w:pPrDefault"), "w:pPr"), theme),
      run: readRunFormat(firstChild(firstChild(defaults, "w:rPrDefault"), "w:rPr"), theme),
    } : APPLICATION_DEFAULTS;
    for (const style of childElements(root, "w:style")) {
      const id = attribute(style, "w:styleId");
      if (id === undefined) continue;
      this.#elements.set(id, style);
      if (!isOn(style, "w:default") || attribute(style, "w:default") === undefined) continue;
      if (attribute(style, "w:type") === "paragraph") this.#defaultParagraphStyle ??= id;
      if (attribute(style, "w:type") === "table") this.#defaultTableStyle ??= id;
    }
  }

  /** The style a paragraph names, or the document's default paragraph style when it names none. */
  paragraphStyle(styleId: string | undefined): ParagraphStyle {
    const id = styleId ?? this.#defaultParagraphStyle;
    if (id === undefined) return { paragraph: {}, run: {}, headingLevel: undefined };
    let resolved = this.#paragraphStyles.get(id);
    if (!resolved) {
      const chain = this.#chain(id);
      resolved = {
        paragraph: layeredParagraph(...chain.map(style => readParagraphFormat(firstChild(style, "w:pPr"), this.theme))),
        run: layered(...chain.map(style => readRunFormat(firstChild(style, "w:rPr"), this.theme))),
        headingLevel: chain.length === 0
          // A document with no stylesheet still names its headings by Word's conventional ids.
          ? headingLevelFromName(id.toLowerCase())
          : chain.map(style => headingLevelFromName(styleName(style))).findLast(level => level !== undefined),
      };
      this.#paragraphStyles.set(id, resolved);
    }
    return resolved;
  }

  /** A character style's formatting. */
  characterStyle(styleId: string | undefined): RunFormat {
    if (styleId === undefined) return {};
    let resolved = this.#characterStyles.get(styleId);
    if (!resolved) {
      resolved = layered(...this.#chain(styleId).map(style => readRunFormat(firstChild(style, "w:rPr"), this.theme)));
      this.#characterStyles.set(styleId, resolved);
    }
    return resolved;
  }

  /** The style a table names, or the document's default table style when it names none. */
  tableStyle(styleId: string | undefined): TableStyle {
    const id = styleId ?? this.#defaultTableStyle;
    if (id === undefined) return { paragraph: {}, run: {}, cell: {}, table: {}, conditional: new Map() };
    let resolved = this.#tableStyles.get(id);
    if (!resolved) {
      let whole: TableStyleRegion | undefined;
      let table: TableFormat = {};
      const conditional = new Map<string, TableStyleRegion>();
      for (const style of this.#chain(id)) {
        whole = layeredRegion(this.theme, whole, style);
        table = layeredTable(table, readTableFormat(firstChild(style, "w:tblPr"), this.theme));
        for (const region of childElements(style, "w:tblStylePr")) {
          const type = attribute(region, "w:type");
          if (type !== undefined) conditional.set(type, layeredRegion(this.theme, conditional.get(type), region));
        }
      }
      resolved = { ...(whole ?? { paragraph: {}, run: {}, cell: {} }), table, conditional };
      this.#tableStyles.set(id, resolved);
    }
    return resolved;
  }

  /** The style and what it is based on, base first. */
  #chain(styleId: string): XmlElement[] {
    const chain: XmlElement[] = [];
    const seen = new Set<string>();
    for (let id: string | undefined = styleId; id !== undefined && !seen.has(id) && chain.length < MAX_STYLE_CHAIN; ) {
      seen.add(id);
      const style = this.#elements.get(id);
      if (!style) break;
      chain.unshift(style);
      id = attribute(firstChild(style, "w:basedOn"), "w:val");
    }
    return chain;
  }
}

function styleName(style: XmlElement): string {
  return (attribute(firstChild(style, "w:name"), "w:val") ?? "").toLowerCase();
}

function headingLevelFromName(name: string): number | undefined {
  if (name === "title") return 1;
  const match = /^heading\s*([1-9])$/.exec(name);
  return match ? Number(match[1]) : undefined;
}

// ---- Numbering ----

/** One level of a list definition. */
export interface ListLevel {
  /** `w:numFmt`: `bullet`, `decimal`, `lowerRoman`, `none`, ... */
  readonly format: string;
  /** `w:lvlText`: the marker, with `%1` standing for the first level's number. */
  readonly text: string;
  readonly start: number;
  /** `w:lvlRestart`: 0 never restarts; otherwise the one-based level whose use restarts this one. */
  readonly restart: number | undefined;
  readonly suffix: "tab" | "space" | "nothing";
  readonly paragraph: ParagraphFormat;
  readonly run: RunFormat;
}

interface ListInstance {
  readonly abstractId: string;
  readonly overrides: ReadonlyMap<number, { readonly start: number | undefined; readonly level: ListLevel | undefined }>;
}

/** A paragraph's place in a list, and the marker to draw for it. */
export interface ListItem {
  readonly level: ListLevel;
  readonly text: string;
}

/**
 * A list level, 0 to 8 as Word has nine, or undefined for anything else. Levels index the
 * counters of a list, so one a file made up would size that array.
 */
function listLevel(value: string | undefined): number | undefined {
  const level = numeric(value);
  return level !== undefined && Number.isInteger(level) && level >= 0 && level <= 8 ? level : undefined;
}

/**
 * numbering.xml, and the running count of every list. Numbering instances (`w:num`) that share an
 * abstract definition share its counters, as in Word, until one overrides a level's start.
 */
export class Numbering {
  readonly #abstractLevels = new Map<string, Map<number, ListLevel>>();
  /** Per abstract definition, the level a paragraph style is tied to (`w:lvl/w:pStyle`). */
  readonly #styleLevels = new Map<string, Map<string, number>>();
  readonly #styleLinks = new Map<string, string>();
  readonly #instances = new Map<string, ListInstance>();
  readonly #counters = new Map<string, (number | undefined)[]>();
  readonly #restarted = new Set<string>();

  constructor(root: XmlElement | undefined, private readonly styles: StyleSheet, theme: Theme) {
    for (const abstract of childElements(root, "w:abstractNum")) {
      const id = attribute(abstract, "w:abstractNumId");
      if (id === undefined) continue;
      const levels = new Map<number, ListLevel>();
      const styleLevels = new Map<string, number>();
      for (const element of childElements(abstract, "w:lvl")) {
        const index = listLevel(attribute(element, "w:ilvl"));
        if (index === undefined) continue;
        levels.set(index, readLevel(element, theme));
        const style = attribute(firstChild(element, "w:pStyle"), "w:val");
        if (style !== undefined) styleLevels.set(style, index);
      }
      this.#abstractLevels.set(id, levels);
      this.#styleLevels.set(id, styleLevels);
      const styleLink = attribute(firstChild(abstract, "w:numStyleLink"), "w:val");
      if (styleLink) this.#styleLinks.set(id, styleLink);
    }
    for (const instance of childElements(root, "w:num")) {
      const numId = attribute(instance, "w:numId");
      const abstractId = attribute(firstChild(instance, "w:abstractNumId"), "w:val");
      if (numId === undefined || abstractId === undefined) continue;
      const overrides = new Map<number, { start: number | undefined; level: ListLevel | undefined }>();
      for (const override of childElements(instance, "w:lvlOverride")) {
        const index = listLevel(attribute(override, "w:ilvl"));
        const redefined = firstChild(override, "w:lvl");
        if (index === undefined) continue;
        overrides.set(index, {
          start: numeric(attribute(firstChild(override, "w:startOverride"), "w:val")),
          level: redefined ? readLevel(redefined, theme) : undefined,
        });
      }
      this.#instances.set(numId, { abstractId, overrides });
    }
  }

  /** The level a paragraph of `styleId` sits at when neither it nor its style says: the one tied to that style. */
  styleLevel(numId: string, styleId: string | undefined): number {
    const instance = this.#instances.get(numId);
    if (!instance || styleId === undefined) return 0;
    return this.#styleLevels.get(this.#definition(instance.abstractId))?.get(styleId) ?? 0;
  }

  /** The definition of one level, without counting a paragraph against it. */
  level(numId: string, level: number): ListLevel | undefined {
    const instance = this.#instances.get(numId);
    if (!instance) return undefined;
    return instance.overrides.get(level)?.level ?? this.#abstractLevels.get(this.#definition(instance.abstractId))?.get(level);
  }

  /** Counts one more paragraph at `level` of the list and returns its marker. */
  next(numId: string, level: number): ListItem | undefined {
    const instance = this.#instances.get(numId);
    const definition = this.level(numId, level);
    if (!instance || !definition) return undefined;
    const abstractId = this.#definition(instance.abstractId);
    let counters = this.#counters.get(abstractId);
    if (!counters) this.#counters.set(abstractId, counters = []);

    for (const [index, override] of instance.overrides) {
      const key = `${numId}/${index}`;
      if (override.start === undefined || this.#restarted.has(key)) continue;
      this.#restarted.add(key);
      counters[index] = override.start - 1;
    }
    for (let deeper = level + 1; deeper < counters.length; deeper++) {
      const restart = this.level(numId, deeper)?.restart;
      if (restart === undefined || (restart !== 0 && level < restart)) counters[deeper] = undefined;
    }
    counters[level] = (counters[level] ?? definition.start - 1) + 1;

    if (definition.format === "bullet") return { level: definition, text: definition.text };
    const text = definition.text.replace(/%([1-9])/g, (_match, digit: string) => {
      const index = Number(digit) - 1;
      const referenced = this.level(numId, index);
      return formatCount(counters[index] ?? referenced?.start ?? 1, referenced?.format ?? "decimal");
    });
    return { level: definition, text };
  }

  /** The abstract definition whose levels apply: itself, or the one behind the list style it links to. */
  #definition(abstractId: string): string {
    const styleLink = this.#styleLinks.get(abstractId);
    if (!styleLink || (this.#abstractLevels.get(abstractId)?.size ?? 0) > 0) return abstractId;
    const linkedNumId = this.styles.paragraphStyle(styleLink).paragraph.numId;
    return (linkedNumId === undefined ? undefined : this.#instances.get(linkedNumId)?.abstractId) ?? abstractId;
  }
}

function readLevel(element: XmlElement, theme: Theme): ListLevel {
  const suffix = attribute(firstChild(element, "w:suff"), "w:val");
  return {
    format: attribute(firstChild(element, "w:numFmt"), "w:val") ?? "decimal",
    text: attribute(firstChild(element, "w:lvlText"), "w:val") ?? "",
    start: numeric(attribute(firstChild(element, "w:start"), "w:val")) ?? 1,
    restart: numeric(attribute(firstChild(element, "w:lvlRestart"), "w:val")),
    suffix: suffix === "space" || suffix === "nothing" ? suffix : "tab",
    paragraph: readParagraphFormat(firstChild(element, "w:pPr"), theme),
    run: readRunFormat(firstChild(element, "w:rPr"), theme),
  };
}

const ROMAN: readonly (readonly [number, string])[] = [
  [1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"],
];

/** A count in one of Word's number formats. Formats this does not know count in decimal. */
export function formatCount(count: number, format: string): string {
  switch (format) {
    case "none":
      return "";
    case "decimalZero":
      return String(count).padStart(2, "0");
    case "lowerLetter":
    case "upperLetter": {
      if (count < 1) return String(count);
      // Word counts past z by repeating the letter: aa, bb, ...
      const letters = String.fromCharCode(97 + (count - 1) % 26).repeat(Math.min(Math.ceil(count / 26), 8));
      return format === "upperLetter" ? letters.toUpperCase() : letters;
    }
    case "lowerRoman":
    case "upperRoman": {
      if (count < 1 || count > 3999) return String(count);
      let rest = count;
      let roman = "";
      for (const [value, numeral] of ROMAN) {
        while (rest >= value) {
          roman += numeral;
          rest -= value;
        }
      }
      return format === "upperRoman" ? roman.toUpperCase() : roman;
    }
    default:
      return String(count);
  }
}

/** Glyphs of the Symbol and Wingdings fonts that bullets use, by their code in the font. */
const SYMBOL_GLYPHS: Readonly<Record<string, Readonly<Record<number, string>>>> = {
  symbol: { 0xb7: "•", 0xa8: "♦", 0xde: "⇒", 0xae: "→" },
  wingdings: { 0xa7: "▪", 0xa8: "◻", 0x6e: "■", 0x6f: "□", 0x71: "❑", 0x76: "❖", 0x9f: "•", 0xd8: "➢", 0xfc: "✔", 0xe0: "→" },
};

/**
 * Text set in a symbol font, as the Unicode characters that look the same. Such fonts put their
 * glyphs at private-use code points (U+F0xx) that no fallback font can draw, so a bullet would
 * otherwise show as an empty box. Returns undefined for text that needs no translation.
 */
export function symbolText(text: string, font: string | undefined): string | undefined {
  const glyphs = SYMBOL_GLYPHS[font?.toLowerCase() ?? ""];
  const privateUse = /[\uf000-\uf0ff]/.test(text);
  if (!glyphs && !privateUse) return undefined;
  return Array.from(text, char => {
    const code = char.charCodeAt(0);
    if (code >= 0xf000 && code <= 0xf0ff) return (glyphs ?? SYMBOL_GLYPHS.symbol!)[code & 0xff] ?? "•";
    return glyphs?.[code] ?? char;
  }).join("");
}
