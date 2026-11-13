// PowerPoint (.pptx, .pptm, .potx, .ppsx, ...) to a drawable model: each visible slide's background
// and shapes with their geometry, fills and text fully resolved, so a renderer needs no knowledge of
// PresentationML's inheritance (slide, layout, master, theme). The model is plain data; see
// `pptx-slide-model.ts` for its units and shape. Charts, SmartArt and embedded objects are returned
// as labelled bounds rather than interpreted.
//
// The file is untrusted. Parts are read through the bounded ZIP and XML readers, only parts inside
// the package are ever opened (an external relationship is ignored, never fetched), and the number
// of slides returned is capped.

import {
  findMainPart, findRelationship, readPart, readRelationships, type Relationships,
} from "./ooxml";
import {
  DEFAULT_COLOR_MAP, WHITE, fillOf, mergeOutline, outlineLayer, readColorMap, readTheme, resolveColor,
  type ColorMap, type FillChoice, type OutlineLayer, type SlideTheme,
} from "./pptx-slide-color";
import type {
  Slide, SlideBounds, SlideDeck, SlideFill, SlideGeometry, SlideImage, SlideShape, SlideTextBody,
  SlideUnsupportedKind,
} from "./pptx-slide-model";
import { readTable } from "./pptx-slide-table";
import {
  readListStyle, readParagraphs, readTextFrame, uniformListStyle, type ListStyle, type TextContext,
} from "./pptx-slide-text";
import { attribute, childAt, childElements, firstChild, firstDescendant, type XmlElement } from "./xml";
import { ZipError, openZip, type ZipArchive } from "./zip";
import { lookupTable } from "./lookup-table";

export type * from "./pptx-slide-model";

/** The most slides `readPptxSlides` returns; a longer presentation is reported as truncated. */
export const MAX_SLIDES = 200;

/**
 * The most shapes, paragraphs and runs the slides before a slide may hold between them for that
 * slide to be read; the rest are reported as truncated. Every slide builds its master's and
 * layout's shapes again, so without this a small file could ask for millions of them.
 */
export const MAX_DECK_CONTENT = 200_000;

const EMU_PER_POINT = 12700;
/** 10 by 7.5 inches, the size of a presentation that states none. */
const DEFAULT_SIZE = { width: 720, height: 540 };
/** PowerPoint's own limit on a slide's side, 56 inches. */
const MAX_SIDE = 56 * 72;

/**
 * Reads a presentation's visible slides. Throws `DocumentConversionError`, `ZipError` or
 * `XmlError` for a file that cannot be read at all; content it does not interpret is listed in
 * the result's `unsupported`.
 */
export async function readPptxSlides(bytes: Uint8Array, options: { readonly maxSlides?: number } = {}): Promise<SlideDeck> {
  const maxSlides = Math.min(MAX_SLIDES, options.maxSlides ?? MAX_SLIDES);
  const zip = openZip(bytes);
  const mainPart = await findMainPart(zip, "ppt/presentation.xml");
  const presentation = await readPart(zip, mainPart);
  const relationships = await readRelationships(zip, mainPart);
  const tableStylesPart = findRelationship(relationships, "tableStyles")?.target;
  const reader = new DeckReader(
    zip, firstChild(presentation, "p:defaultTextStyle"), tableStylesPart ? await readPart(zip, tableStylesPart) : undefined);

  const slides: Slide[] = [];
  let truncated = false;
  let number = 0;
  // A slide list naming one part many times reads it once; each repeat would cost a full parse.
  const seen = new Set<string>();
  for (const slideId of childElements(firstChild(presentation, "p:sldIdLst"), "p:sldId")) {
    const relationship = relationships.get(attribute(slideId, "r:id") ?? "");
    if (!relationship || relationship.external || relationship.type !== "slide" || !zip.has(relationship.target)) continue;
    if (seen.has(relationship.target)) continue;
    if (slides.length >= maxSlides || reader.content >= MAX_DECK_CONTENT) {
      truncated = true;
      break;
    }
    seen.add(relationship.target);
    number++;
    const slide = await reader.readSlide(relationship.target, number);
    if (slide) slides.push(slide);
  }

  const size = firstChild(presentation, "p:sldSz");
  const side = (name: string, fallback: number) => {
    const points = emu(attribute(size, name));
    return points !== undefined && points > 0 && points <= MAX_SIDE ? points : fallback;
  };
  return {
    width: side("cx", DEFAULT_SIZE.width),
    height: side("cy", DEFAULT_SIZE.height),
    slides,
    truncated,
    unsupported: [...reader.unsupported],
  };
}

/** Whether a shape, picture, frame or group is one PowerPoint hides (`hidden` on its `p:cNvPr`). */
function isHidden(element: XmlElement): boolean {
  for (const child of childElements(element)) {
    if (!child.name.startsWith("p:nv")) continue;
    const hidden = attribute(firstChild(child, "p:cNvPr"), "hidden");
    return isTrue(hidden);
  }
  return false;
}

/** What a shape counts towards `MAX_DECK_CONTENT`: itself, its cells, and its paragraphs and their runs. */
function contentOf(shape: SlideShape): number {
  const text = (body: SlideTextBody | undefined) =>
    body ? body.paragraphs.reduce((sum, paragraph) => sum + 1 + paragraph.runs.length, 0) : 0;
  if (shape.kind === "shape") return 1 + text(shape.text);
  if (shape.kind !== "table") return 1;
  return shape.rows.reduce((sum, row) => sum + row.cells.reduce((cells, cell) => cells + 1 + text(cell.text), 0), 1);
}

function emu(value: string | undefined): number | undefined {
  const number = Number.parseInt(value ?? "", 10);
  return Number.isFinite(number) ? number / EMU_PER_POINT : undefined;
}

interface MasterPart {
  readonly partName: string;
  readonly root: XmlElement | undefined;
  readonly relationships: Relationships;
  readonly theme: SlideTheme;
  readonly colorMap: ColorMap;
}

interface LayoutPart {
  readonly partName: string;
  readonly root: XmlElement | undefined;
  readonly relationships: Relationships;
  readonly master: MasterPart | undefined;
  readonly colorMap: ColorMap;
}

/** Which of a master's three text styles underlies a shape's text. */
type TextCategory = "title" | "body" | "other";

/** What reading the shapes of one part (a slide, or the layout or master behind it) needs. */
interface Scope {
  readonly relationships: Relationships;
  readonly context: TextContext;
  /** The layout's and master's placeholder shapes a slide's placeholders inherit from; empty for the layout's and master's own shapes. */
  readonly layoutPlaceholders: PlaceholderIndex;
  readonly masterPlaceholders: PlaceholderIndex;
  /** Placeholders on a layout or master are templates for slides, not content. */
  readonly skipPlaceholders: boolean;
  /** The presentation's and master's styles for a category, lowest priority first. */
  readonly baseStyles: (category: TextCategory) => readonly ListStyle[];
}

/** A group's mapping from its children's coordinate space to its parent's. */
interface GroupFrame {
  readonly parent: GroupFrame | undefined;
  readonly scaleX: number;
  readonly scaleY: number;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly centerX: number;
  readonly centerY: number;
  readonly rotation: number;
  readonly flipH: boolean;
  readonly flipV: boolean;
}

/** Image types a browser draws. Office's own vector formats (EMF, WMF) and TIFF are not among them. */
const IMAGE_TYPES: Readonly<Record<string, string>> = lookupTable({
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", bmp: "image/bmp", webp: "image/webp",
  svg: "image/svg+xml",
});

/** The element Office 2016+ adds to a blip to carry the SVG its PNG is a fallback for. */
const SVG_BLIP = "{http://schemas.microsoft.com/office/drawing/2016/SVG/main}svgBlip";

const LINE_PRESETS = /^(line|straightConnector1|bentConnector\d|curvedConnector\d)$/;
/** `roundRect`'s default corner adjustment, in 100,000ths of the shorter side. */
const DEFAULT_CORNER = 16667;

class DeckReader {
  readonly unsupported = new Set<SlideUnsupportedKind>();
  /** How many shapes, paragraphs and runs the slides read so far hold. */
  content = 0;
  readonly #layouts = new Map<string, Promise<LayoutPart>>();
  readonly #masters = new Map<string, Promise<MasterPart>>();

  constructor(
    private readonly zip: ZipArchive,
    private readonly defaultTextStyle: XmlElement | undefined,
    private readonly tableStyles: XmlElement | undefined,
  ) {}

  /** Reads one slide, or returns undefined for a hidden one. */
  async readSlide(partName: string, number: number): Promise<Slide | undefined> {
    const root = await readPart(this.zip, partName);
    if (isFalse(attribute(root, "show"))) return undefined;
    const relationships = await readRelationships(this.zip, partName);
    const layoutPart = findRelationship(relationships, "slideLayout")?.target;
    const layout = layoutPart && this.zip.has(layoutPart) ? await this.#layout(layoutPart) : undefined;
    const master = layout?.master;
    const theme = master?.theme ?? readTheme(undefined);
    const colorMap = readColorMap(childAt(root, "p:clrMapOvr", "a:overrideClrMapping")) ?? layout?.colorMap ?? DEFAULT_COLOR_MAP;

    const scope = (relationships: Relationships, colorMap: ColorMap, inherits: boolean): Scope => {
      const context: TextContext = { theme, colorMap, slideNumber: number };
      const styles = new Map<TextCategory, readonly ListStyle[]>();
      return {
        relationships,
        context,
        layoutPlaceholders: inherits ? placeholderIndex(layout?.root) : NO_PLACEHOLDERS,
        masterPlaceholders: inherits ? placeholderIndex(master?.root) : NO_PLACEHOLDERS,
        skipPlaceholders: !inherits,
        baseStyles: category => {
          let found = styles.get(category);
          if (!found) {
            found = [
              readListStyle(this.defaultTextStyle, context),
              readListStyle(childAt(master?.root, "p:txStyles", `p:${category}Style`), context),
            ];
            styles.set(category, found);
          }
          return found;
        },
      };
    };
    const slideScope = scope(relationships, colorMap, true);
    const layoutScope = layout && scope(layout.relationships, layout.colorMap, false);
    const masterScope = master && scope(master.relationships, master.colorMap, false);

    const shapes: SlideShape[] = [];
    if (!isFalse(attribute(root, "showMasterSp"))) {
      if (masterScope && !isFalse(attribute(layout?.root, "showMasterSp"))) await this.#readTree(shapeTree(master.root), masterScope, undefined, shapes);
      if (layoutScope) await this.#readTree(shapeTree(layout.root), layoutScope, undefined, shapes);
    }
    await this.#readTree(shapeTree(root), slideScope, undefined, shapes);

    const background = await this.#background(root, slideScope)
      ?? (layoutScope && await this.#background(layout.root, layoutScope))
      ?? (masterScope && await this.#background(master.root, masterScope))
      ?? { kind: "solid", color: WHITE };
    return { number, background, shapes };
  }

  #layout(partName: string): Promise<LayoutPart> {
    let layout = this.#layouts.get(partName);
    if (!layout) this.#layouts.set(partName, layout = this.#readLayout(partName));
    return layout;
  }

  async #readLayout(partName: string): Promise<LayoutPart> {
    const root = await readPart(this.zip, partName);
    const relationships = await readRelationships(this.zip, partName);
    const masterPart = findRelationship(relationships, "slideMaster")?.target;
    const master = masterPart && this.zip.has(masterPart) ? await this.#master(masterPart) : undefined;
    const colorMap = readColorMap(childAt(root, "p:clrMapOvr", "a:overrideClrMapping")) ?? master?.colorMap ?? DEFAULT_COLOR_MAP;
    return { partName, root, relationships, master, colorMap };
  }

  #master(partName: string): Promise<MasterPart> {
    let master = this.#masters.get(partName);
    if (!master) this.#masters.set(partName, master = this.#readMaster(partName));
    return master;
  }

  async #readMaster(partName: string): Promise<MasterPart> {
    const root = await readPart(this.zip, partName);
    const relationships = await readRelationships(this.zip, partName);
    const themePart = findRelationship(relationships, "theme")?.target;
    const theme = readTheme(themePart ? await readPart(this.zip, themePart) : undefined);
    return { partName, root, relationships, theme, colorMap: readColorMap(firstChild(root, "p:clrMap")) ?? DEFAULT_COLOR_MAP };
  }

  /** The background a part states, or undefined when it leaves it to the part it inherits from. */
  async #background(root: XmlElement | undefined, scope: Scope): Promise<SlideFill | undefined> {
    const background = childAt(root, "p:cSld", "p:bg");
    const fill = await this.#fill(firstChild(background, "p:bgPr"), scope);
    if (fill && fill !== "none") return fill;
    const reference = firstChild(background, "p:bgRef");
    if (!reference) return undefined;
    const color = resolveColor(reference, scope.context);
    const styled = this.#themeFill(reference, scope, color);
    return styled && styled !== "none" ? styled : color && { kind: "solid", color };
  }

  /** The theme format-scheme fill a `fillRef` or `bgRef` indexes, painted in the reference's color. */
  #themeFill(reference: XmlElement | undefined, scope: Scope, color = resolveColor(reference, scope.context)): FillChoice {
    const index = Number.parseInt(attribute(reference, "idx") ?? "", 10);
    if (!Number.isFinite(index)) return undefined;
    const { theme } = scope.context;
    const style = index >= 1001 ? theme.backgroundFillStyles[index - 1001] : theme.fillStyles[index - 1];
    return style && fillOf(style, scope.context, color);
  }

  /** The first fill among `container`'s children, including a picture fill. */
  async #fill(container: XmlElement | undefined, scope: Scope): Promise<FillChoice> {
    for (const child of childElements(container)) {
      if (child.name === "a:blipFill") {
        const image = await this.#image(firstChild(child, "a:blip"), scope);
        if (image) return { kind: "image", image };
        continue;
      }
      const fill = fillOf(child, scope.context);
      if (fill) return fill;
    }
    return undefined;
  }

  /**
   * The picture a blip embeds: its SVG when it carries one, else its raster. A linked picture
   * (`r:link`, or an embed whose relationship is external) is never fetched.
   */
  async #image(blip: XmlElement | undefined, scope: Scope): Promise<SlideImage | undefined> {
    const ids = [attribute(firstDescendant(blip, SVG_BLIP), "r:embed"), attribute(blip, "r:embed")];
    for (const id of ids) {
      const relationship = id === undefined ? undefined : scope.relationships.get(id);
      if (!relationship || relationship.external || relationship.type !== "image" || !this.zip.has(relationship.target)) continue;
      const contentType = IMAGE_TYPES[relationship.target.slice(relationship.target.lastIndexOf(".") + 1).toLowerCase()];
      if (!contentType) continue;
      try {
        return { bytes: await this.zip.readBytes(relationship.target), contentType };
      } catch (error) {
        // One oversized or damaged picture should cost that picture, not the presentation.
        if (!(error instanceof ZipError)) throw error;
      }
    }
    return undefined;
  }

  /** Appends the tree's shapes back to front, flattening groups. */
  async #readTree(tree: XmlElement | undefined, scope: Scope, frame: GroupFrame | undefined, out: SlideShape[]): Promise<void> {
    for (const element of childElements(tree)) {
      if (scope.skipPlaceholders && placeholderOf(element)) continue;
      if (isHidden(element)) continue;
      let shape: SlideShape | undefined;
      switch (element.name) {
        case "p:sp":
        case "p:cxnSp":
          shape = await this.#shape(element, scope, frame);
          break;
        case "p:pic":
          shape = await this.#picture(element, scope, this.#bounds(element, scope, frame));
          break;
        case "p:graphicFrame":
          shape = await this.#graphicFrame(element, scope, frame);
          break;
        case "p:grpSp":
          await this.#readTree(element, scope, groupFrame(element, frame), out);
          break;
      }
      if (shape) {
        if (shape.kind === "unsupported") this.unsupported.add(shape.what);
        this.content += contentOf(shape);
        out.push(shape);
      }
    }
  }

  /** The shape and the layout and master placeholders it inherits from, nearest first. */
  #inheritance(shape: XmlElement, scope: Scope): { layers: XmlElement[]; category: TextCategory } {
    const placeholder = placeholderOf(shape);
    if (!placeholder) return { layers: [shape], category: "other" };
    const type = attribute(placeholder, "type");
    const index = attribute(placeholder, "idx");
    const layout = scope.layoutPlaceholders;
    const inLayout = (index !== undefined ? layout.byIndex.get(index) : undefined)
      ?? (type !== undefined ? layout.byType.get(type) ?? layout.byKind.get(masterKind(type)) : undefined);
    const kind = masterKind(type ?? (inLayout ? placeholderType(inLayout) : "obj"));
    const inMaster = scope.masterPlaceholders.byKind.get(kind);
    return {
      layers: [shape, inLayout, inMaster].filter((layer): layer is XmlElement => layer !== undefined),
      category: kind === "title" ? "title" : kind === "body" ? "body" : "other",
    };
  }

  /** The shape's own position, or the one its placeholder inherits, placed through its groups. */
  #bounds(shape: XmlElement, scope: Scope, frame: GroupFrame | undefined): SlideBounds | undefined {
    for (const layer of this.#inheritance(shape, scope).layers) {
      const bounds = readBounds(childAt(layer, "p:spPr", "a:xfrm"));
      if (bounds) return placeInGroups(bounds, frame);
    }
    return undefined;
  }

  async #shape(shape: XmlElement, scope: Scope, frame: GroupFrame | undefined): Promise<SlideShape | undefined> {
    const { context } = scope;
    const { layers, category } = this.#inheritance(shape, scope);
    const bounds = this.#bounds(shape, scope, frame);
    if (!bounds) return undefined;
    const properties = layers.map(layer => firstChild(layer, "p:spPr"));
    const style = firstChild(shape, "p:style");

    let fill: FillChoice;
    for (const layer of properties) {
      fill = await this.#fill(layer, scope);
      if (fill) break;
    }
    fill ??= this.#themeFill(firstChild(style, "a:fillRef"), scope);

    const outlines: OutlineLayer[] = properties.map(layer => outlineLayer(firstChild(layer, "a:ln"), context));
    const lineReference = firstChild(style, "a:lnRef");
    const lineStyle = context.theme.lineStyles[Number.parseInt(attribute(lineReference, "idx") ?? "", 10) - 1];
    if (lineStyle) outlines.push(outlineLayer(lineStyle, context, resolveColor(lineReference, context)));
    const outline = mergeOutline(outlines);

    const body = firstChild(shape, "p:txBody");
    let text: SlideTextBody | undefined;
    if (body) {
      const fontReference = firstChild(style, "a:fontRef");
      const fontColor = resolveColor(fontReference, context);
      const fromStyle = fontReference && uniformListStyle({
        font: attribute(fontReference, "idx") === "major" ? "+mj-lt" : "+mn-lt",
        ...(fontColor ? { color: fontColor } : {}),
      });
      const inherited = layers.slice(1).toReversed();
      const paragraphs = readParagraphs(body, [
        ...scope.baseStyles(category),
        ...(fromStyle ? [fromStyle] : []),
        ...[...inherited, shape].map(layer => readListStyle(childAt(layer, "p:txBody", "a:lstStyle"), context)),
      ], context);
      if (paragraphs.some(paragraph => paragraph.runs.some(run => run.text.trim() !== ""))) {
        text = { ...readTextFrame([...inherited, shape].map(layer => childAt(layer, "p:txBody", "a:bodyPr"))), paragraphs };
      }
    }

    const visibleFill = fill && fill !== "none" ? fill : undefined;
    if (!visibleFill && !outline && !text) return undefined;
    return {
      kind: "shape",
      bounds,
      ...readGeometry(shape.name === "p:cxnSp", properties, bounds),
      ...(visibleFill ? { fill: visibleFill } : {}),
      ...(outline ? { outline } : {}),
      ...(text ? { text } : {}),
    };
  }

  async #picture(picture: XmlElement | undefined, scope: Scope, bounds: SlideBounds | undefined): Promise<SlideShape | undefined> {
    const blip = childAt(picture, "p:blipFill", "a:blip");
    if (!bounds || !blip) return undefined;
    const image = await this.#image(blip, scope);
    if (!image) return { kind: "unsupported", bounds, what: "picture" };
    const properties = firstChild(picture, "p:spPr");
    const source = childAt(picture, "p:blipFill", "a:srcRect");
    const cropped = (side: string) => {
      const value = Number.parseInt(attribute(source, side) ?? "0", 10) / 100000;
      return Number.isFinite(value) && value < 1 ? value : 0;
    };
    const outline = mergeOutline([outlineLayer(firstChild(properties, "a:ln"), scope.context)]);
    const description = attribute(childAt(picture, "p:nvPicPr", "p:cNvPr"), "descr");
    return {
      kind: "picture",
      bounds,
      ...readGeometry(false, [properties], bounds),
      image,
      crop: { left: cropped("l"), top: cropped("t"), right: cropped("r"), bottom: cropped("b") },
      ...(outline ? { outline } : {}),
      ...(description ? { description } : {}),
    };
  }

  async #graphicFrame(frame: XmlElement, scope: Scope, group: GroupFrame | undefined): Promise<SlideShape | undefined> {
    const own = readBounds(firstChild(frame, "p:xfrm"));
    if (!own) return undefined;
    const bounds = placeInGroups(own, group);
    const data = childAt(frame, "a:graphic", "a:graphicData");
    const table = firstChild(data, "a:tbl");
    if (table) {
      return readTable(table, bounds, { context: scope.context, styles: scope.baseStyles("other"), tableStyles: this.tableStyles });
    }
    const kind = attribute(data, "uri") ?? "";
    if (kind.endsWith("/chart")) return { kind: "unsupported", bounds, what: "chart" };
    if (kind.endsWith("/diagram")) return { kind: "unsupported", bounds, what: "diagram" };
    // An embedded object carries a picture of itself, which is what PowerPoint shows until it is opened.
    const preview = await this.#picture(firstDescendant(data, "p:pic"), scope, bounds);
    return preview?.kind === "picture" ? preview : { kind: "unsupported", bounds, what: "object" };
  }
}

function shapeTree(root: XmlElement | undefined): XmlElement | undefined {
  return childAt(root, "p:cSld", "p:spTree");
}

/** The `p:ph` of a shape, picture or frame, whose non-visual properties element is named for its kind. */
function placeholderOf(shape: XmlElement | undefined): XmlElement | undefined {
  for (const child of childElements(shape)) {
    if (child.name.startsWith("p:nv")) return childAt(child, "p:nvPr", "p:ph");
  }
  return undefined;
}

/** A `p:ph` without a type is an "obj" placeholder (ECMA-376 19.7.10). */
function placeholderType(shape: XmlElement): string {
  return attribute(placeholderOf(shape), "type") ?? "obj";
}

/** A layout's or master's placeholders, each lookup finding the first in the part that matches. */
interface PlaceholderIndex {
  readonly byIndex: ReadonlyMap<string, XmlElement>;
  readonly byType: ReadonlyMap<string, XmlElement>;
  readonly byKind: ReadonlyMap<string, XmlElement>;
}

const NO_PLACEHOLDERS: PlaceholderIndex = { byIndex: new Map(), byType: new Map(), byKind: new Map() };
const placeholderIndexes = new WeakMap<XmlElement, PlaceholderIndex>();

/**
 * The placeholders of a layout or master, indexed once per part: every slide's shapes look their
 * placeholders up here, and searching the part's list for each would cost shapes times placeholders.
 */
function placeholderIndex(root: XmlElement | undefined): PlaceholderIndex {
  if (!root) return NO_PLACEHOLDERS;
  let index = placeholderIndexes.get(root);
  if (index) return index;
  const byIndex = new Map<string, XmlElement>();
  const byType = new Map<string, XmlElement>();
  const byKind = new Map<string, XmlElement>();
  const first = (map: Map<string, XmlElement>, key: string | undefined, shape: XmlElement) => {
    if (key !== undefined && !map.has(key)) map.set(key, shape);
  };
  for (const shape of childElements(shapeTree(root))) {
    const placeholder = placeholderOf(shape);
    if (!placeholder) continue;
    first(byIndex, attribute(placeholder, "idx"), shape);
    first(byType, placeholderType(shape), shape);
    first(byKind, masterKind(placeholderType(shape)), shape);
  }
  placeholderIndexes.set(root, index = { byIndex, byType, byKind });
  return index;
}

/**
 * The master placeholder a type inherits from: a master has one title, one body and the three
 * footer placeholders, and every content type (subtitle, object, picture, chart, ...) follows the body.
 */
function masterKind(type: string): string {
  if (type === "title" || type === "ctrTitle") return "title";
  return type === "dt" || type === "ftr" || type === "sldNum" ? type : "body";
}

function readBounds(transform: XmlElement | undefined): SlideBounds | undefined {
  const offset = firstChild(transform, "a:off");
  const extent = firstChild(transform, "a:ext");
  const x = emu(attribute(offset, "x"));
  const y = emu(attribute(offset, "y"));
  const width = emu(attribute(extent, "cx"));
  const height = emu(attribute(extent, "cy"));
  if (x === undefined || y === undefined || width === undefined || height === undefined) return undefined;
  const rotation = Number.parseInt(attribute(transform, "rot") ?? "0", 10) / 60000;
  return {
    x, y, width: Math.max(0, width), height: Math.max(0, height),
    rotation: Number.isFinite(rotation) ? rotation : 0,
    flipH: isTrue(attribute(transform, "flipH")),
    flipV: isTrue(attribute(transform, "flipV")),
  };
}

function isTrue(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

/** Whether an attribute that is on unless it says otherwise says otherwise, in either XML spelling. */
function isFalse(value: string | undefined): boolean {
  return value === "0" || value === "false";
}

/** A group scales its children from the space `chOff`/`chExt` describe into its own box, then turns and flips them with it. */
function groupFrame(group: XmlElement, parent: GroupFrame | undefined): GroupFrame | undefined {
  const transform = childAt(group, "p:grpSpPr", "a:xfrm");
  const bounds = readBounds(transform);
  if (!bounds) return parent;
  const childOffset = firstChild(transform, "a:chOff");
  const childExtent = firstChild(transform, "a:chExt");
  const childWidth = emu(attribute(childExtent, "cx")) ?? 0;
  const childHeight = emu(attribute(childExtent, "cy")) ?? 0;
  const scaleX = childWidth > 0 ? bounds.width / childWidth : 1;
  const scaleY = childHeight > 0 ? bounds.height / childHeight : 1;
  return {
    parent,
    scaleX,
    scaleY,
    offsetX: bounds.x - (emu(attribute(childOffset, "x")) ?? 0) * scaleX,
    offsetY: bounds.y - (emu(attribute(childOffset, "y")) ?? 0) * scaleY,
    centerX: bounds.x + bounds.width / 2,
    centerY: bounds.y + bounds.height / 2,
    rotation: bounds.rotation,
    flipH: bounds.flipH,
    flipV: bounds.flipV,
  };
}

/** Carries bounds out through the groups around them, innermost first, to slide coordinates. */
function placeInGroups(bounds: SlideBounds, frame: GroupFrame | undefined): SlideBounds {
  let { x, y, width, height, rotation, flipH, flipV } = bounds;
  for (let group = frame; group; group = group.parent) {
    width *= group.scaleX;
    height *= group.scaleY;
    let centerX = x * group.scaleX + group.offsetX + width / 2;
    let centerY = y * group.scaleY + group.offsetY + height / 2;
    // Mirroring a turned shape turns it the other way.
    if (group.flipH) {
      centerX = 2 * group.centerX - centerX;
      flipH = !flipH;
      rotation = -rotation;
    }
    if (group.flipV) {
      centerY = 2 * group.centerY - centerY;
      flipV = !flipV;
      rotation = -rotation;
    }
    if (group.rotation !== 0) {
      const angle = group.rotation * Math.PI / 180;
      const dx = centerX - group.centerX;
      const dy = centerY - group.centerY;
      centerX = group.centerX + dx * Math.cos(angle) - dy * Math.sin(angle);
      centerY = group.centerY + dx * Math.sin(angle) + dy * Math.cos(angle);
      rotation += group.rotation;
    }
    x = centerX - width / 2;
    y = centerY - height / 2;
  }
  return { x, y, width, height, rotation, flipH, flipV };
}

/** The preset geometry the nearest layer states. Presets other than these are drawn as their bounding rectangle. */
function readGeometry(
  connector: boolean, properties: readonly (XmlElement | undefined)[], bounds: SlideBounds,
): { geometry: SlideGeometry; cornerRadius: number } {
  const preset = properties.map(layer => firstChild(layer, "a:prstGeom")).find(found => found !== undefined);
  const name = attribute(preset, "prst") ?? "rect";
  if (connector || LINE_PRESETS.test(name)) return { geometry: "line", cornerRadius: 0 };
  if (name === "ellipse") return { geometry: "ellipse", cornerRadius: 0 };
  if (name !== "roundRect") return { geometry: "rect", cornerRadius: 0 };
  const guide = childElements(firstChild(preset, "a:avLst"), "a:gd").find(candidate => attribute(candidate, "name") === "adj");
  const stated = Number.parseInt(/^val\s+(-?\d+)$/.exec(attribute(guide, "fmla") ?? "")?.[1] ?? "", 10);
  const adjust = Math.min(50000, Math.max(0, Number.isFinite(stated) ? stated : DEFAULT_CORNER));
  return { geometry: "roundRect", cornerRadius: Math.min(bounds.width, bounds.height) * adjust / 100000 };
}
