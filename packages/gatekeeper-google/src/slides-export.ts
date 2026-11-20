/**
 * The outlines of shapes that Google's Slides API does not report: a freeform's path, and how far
 * the handles of a preset shape were dragged. Google's PowerPoint export of the presentation holds
 * both, so a drawing takes them from there and everything else from the API.
 *
 * The export numbers its shapes anew, so each is matched to the API's by where it comes in its
 * page and checked against the API's own account of where the shape is. A shape that cannot be
 * told for certain gets no outline, and is drawn as one whose outline is unknown.
 */

import { findMainPart, findRelationship, readRelationships } from "@gadgets/office-content/ooxml";
import {
  attribute, childAt, childElements, firstChild, parseXml, streamElements, XmlError, type XmlElement, type XmlOptions,
} from "@gadgets/office-content/xml";
import { openZip, ZipError, type ZipLimits } from "@gadgets/office-content/zip";
import { obsContext } from "./observability";
import type { RestPageElement } from "./slides-api";
import {
  IDENTITY, localBox, matrixOf, multiply, placementOf, type Box, type Matrix, type Placement,
} from "./slides-geometry";
import type { DrawnPath } from "./slides-rendering-types";

/** The MIME type Drive exports a presentation to as a PowerPoint file. */
export const PPTX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
/** Drive exports no more than 10 MB. */
export const MAX_EXPORT_BYTES = 10.5 * 1024 * 1024;

const logger = obsContext.createLogger({ component: "gatekeeper.google.slides.export", vendorId: "google" });

// What is read of an export is bounded before it is allocated, by what a large real deck holds
// with room to spare: one of 27 slides full of freeforms has 53 pages of 1.9 MB of XML together,
// the largest 671 KB, with 938 shapes and 21,000 points in all, 11,600 of them on one page, and
// its largest group is 30,000 elements. A page past a bound gives no outlines; it is no error.
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const PAGE_LIMITS: ZipLimits = { maxEntries: 5_000, maxEntryBytes: MAX_PAGE_BYTES, maxTotalBytes: MAX_PAGE_BYTES };
// The presentation's list of its slides, and each page's of what it is laid over: a few KB each.
const SMALL_LIMITS: ZipLimits = { maxEntries: 5_000, maxEntryBytes: 128 * 1024, maxTotalBytes: 256 * 1024 };
/** The most elements of one shape or group, each parsed, read and let go before the next. */
const MAX_TREE_ELEMENTS = 60_000;
const MAX_PAGE_SHAPES = 2_000;
const MAX_SHAPE_PATHS = 64;
/** The most coordinates one freeform's paths may hold, one page's freeforms together, and a deck's. */
const MAX_SHAPE_NUMBERS = 20_000;
const MAX_PAGE_NUMBERS = 100_000;
const MAX_DECK_NUMBERS = 300_000;
const MAX_DECK_PAGES = 300;
const MAX_DECK_SHAPES = 10_000;
const MAX_DECK_BYTES = 12 * 1024 * 1024;
const MAX_ADJUSTS = 8;

// How far apart the API's and the export's account of one shape may be: each rounds differently.
const NEAR_POINTS = 0.5;
const NEAR_DEGREES = 0.5;

/**
 * The preset shapes whose handles a drawing follows, by `Shape.Type`, and what the export calls
 * each. The preview's `shapes.js` draws these from their adjust values.
 */
export const ADJUSTED_PRESETS: ReadonlyMap<string, string> = new Map(Object.entries({
  ROUND_RECTANGLE: "roundRect", ROUND_1_RECTANGLE: "round1Rect", ROUND_2_SAME_RECTANGLE: "round2SameRect",
  ROUND_2_DIAGONAL_RECTANGLE: "round2DiagRect", SNIP_1_RECTANGLE: "snip1Rect",
  SNIP_2_SAME_RECTANGLE: "snip2SameRect", SNIP_2_DIAGONAL_RECTANGLE: "snip2DiagRect",
  SNIP_ROUND_RECTANGLE: "snipRoundRect", PLAQUE: "plaque",
  ARC: "arc", PIE: "pie", CHORD: "chord", BLOCK_ARC: "blockArc", DONUT: "donut",
  HOME_PLATE: "homePlate", CHEVRON: "chevron", TRAPEZOID: "trapezoid", PARALLELOGRAM: "parallelogram",
  HEXAGON: "hexagon", OCTAGON: "octagon", TRIANGLE: "triangle", PLUS: "plus",
  CAN: "can", FRAME: "frame", CUBE: "cube", BEVEL: "bevel", FOLDED_CORNER: "foldedCorner",
  RIGHT_ARROW: "rightArrow", LEFT_ARROW: "leftArrow", UP_ARROW: "upArrow", DOWN_ARROW: "downArrow",
  LEFT_RIGHT_ARROW: "leftRightArrow", UP_DOWN_ARROW: "upDownArrow", NOTCHED_RIGHT_ARROW: "notchedRightArrow",
  WEDGE_RECTANGLE_CALLOUT: "wedgeRectCallout", WEDGE_ROUND_RECTANGLE_CALLOUT: "wedgeRoundRectCallout",
  WEDGE_ELLIPSE_CALLOUT: "wedgeEllipseCallout", CLOUD_CALLOUT: "cloudCallout", SMILEY_FACE: "smileyFace",
  STAR_4: "star4", STAR_5: "star5", STAR_6: "star6", STAR_7: "star7", STAR_8: "star8", STAR_10: "star10",
  STAR_12: "star12", STAR_16: "star16", STAR_24: "star24", STAR_32: "star32",
}));

/** What the export says of one shape's outline: a freeform's paths, or a preset's adjust values. */
export type ShapeGeometry = { paths: DrawnPath[] } | { preset: string; adjust: number[] };

/**
 * One shape, picture, line or table of an exported page, a group's each on its own. `kind` is what
 * outline a shape has, `"paths"` or a preset's name, whether or not it could be read.
 */
type Leaf = { placement?: Placement; kind?: string; geometry?: ShapeGeometry };

/** A page of the export: its elements in document order, and the layout or master it is laid over. */
export type ExportPage = { leaves: Leaf[]; over?: string };

const integer = (element: XmlElement | undefined, name: string): number | undefined => {
  let value = attribute(element, name);
  return value !== undefined && /^-?\d{1,12}$/.test(value) ? Number(value) : undefined;
};
const isSet = (element: XmlElement | undefined, name: string) => ["1", "true"].includes(attribute(element, name) ?? "");

/** The matrix an `a:xfrm` places its box with, and for a group the frame its children are in. */
function placed(xfrm: XmlElement | undefined): { matrix: Matrix; box: Box; frame: Matrix } | undefined {
  let [off, ext] = [firstChild(xfrm, "a:off"), firstChild(xfrm, "a:ext")];
  let [x, y, width, height] = [integer(off, "x"), integer(off, "y"), integer(ext, "cx"), integer(ext, "cy")];
  if (x === undefined || y === undefined || width === undefined || height === undefined) return undefined;
  // Turned clockwise about its centre, in 60,000ths of a degree, after it is mirrored.
  let angle = (integer(xfrm, "rot") ?? 0) / 60_000 * Math.PI / 180;
  let [fx, fy] = [isSet(xfrm, "flipH") ? -1 : 1, isSet(xfrm, "flipV") ? -1 : 1];
  let [cos, sin] = [Math.cos(angle), Math.sin(angle)];
  let turn = { a: cos * fx, b: sin * fx, c: -sin * fy, d: cos * fy };
  let matrix = {
    ...turn,
    tx: x + width / 2 - (turn.a * width / 2 + turn.c * height / 2),
    ty: y + height / 2 - (turn.b * width / 2 + turn.d * height / 2),
  };
  let [childOff, childExt] = [firstChild(xfrm, "a:chOff"), firstChild(xfrm, "a:chExt")];
  let [sx, sy] = [width / (integer(childExt, "cx") || width || 1), height / (integer(childExt, "cy") || height || 1)];
  let within = { a: sx, b: 0, c: 0, d: sy, tx: -(integer(childOff, "x") ?? 0) * sx, ty: -(integer(childOff, "y") ?? 0) * sy };
  return { matrix, box: { x: 0, y: 0, width, height }, frame: multiply(matrix, within) };
}

const COMMANDS: Readonly<Record<string, [letter: string, points: number]>> = {
  "a:moveTo": ["M", 1], "a:lnTo": ["L", 1], "a:quadBezTo": ["Q", 2], "a:cubicBezTo": ["C", 3], "a:close": ["Z", 0],
};

/**
 * A freeform's paths, or undefined when they hold what is not read: an arc, a coordinate given as
 * a formula, or more than `budget` allows.
 */
function pathsOf(custom: XmlElement, box: Box | undefined, budget: { numbers: number }): DrawnPath[] | undefined {
  let paths: DrawnPath[] = [];
  let numbers = 0;
  for (let path of childElements(firstChild(custom, "a:pathLst"), "a:path")) {
    if (paths.length >= MAX_SHAPE_PATHS) return undefined;
    // A path that gives no size of its own is in its shape's.
    let width = integer(path, "w") ?? box?.width;
    let height = integer(path, "h") ?? box?.height;
    if (!width || !height || width < 0 || height < 0) return undefined;
    let ops = "";
    let points: number[] = [];
    for (let step of childElements(path)) {
      let command = COMMANDS[step.name];
      let at = childElements(step, "a:pt");
      if (!command || at.length !== command[1]) return undefined;
      for (let point of at) {
        let [x, y] = [integer(point, "x"), integer(point, "y")];
        if (x === undefined || y === undefined) return undefined;
        points.push(x, y);
      }
      ops += command[0];
      numbers += 1 + 2 * command[1];
      if (numbers > MAX_SHAPE_NUMBERS || numbers > budget.numbers) return undefined;
    }
    if (!ops.startsWith("M")) return undefined;
    paths.push({
      width, height, ops, points,
      ...(attribute(path, "fill") === "none" ? { filled: false as const } : {}),
      ...(["0", "false"].includes(attribute(path, "stroke") ?? "") ? { stroked: false as const } : {}),
    });
  }
  if (paths.length === 0) return undefined;
  budget.numbers -= numbers;
  return paths;
}

/** A preset's adjust values in order, `adj` or `adj1` first: none unless each is a plain number. */
function adjustOf(preset: XmlElement): number[] {
  let adjust: number[] = [];
  for (let guide of childElements(firstChild(preset, "a:avLst"), "a:gd")) {
    let name = /^adj(\d?)$/.exec(attribute(guide, "name") ?? "");
    let value = /^val (-?\d{1,12})$/.exec(attribute(guide, "fmla") ?? "");
    if (!name || !value) return [];
    adjust[Math.max(Number(name[1]) - 1, 0)] = Number(value[1]);
  }
  return adjust.length <= MAX_ADJUSTS && !adjust.includes(undefined!) && Object.keys(adjust).length === adjust.length ? adjust : [];
}

type Budget = { shapes: number; numbers: number };

function outlineOf(shape: XmlElement, box: Box | undefined, budget: Budget): Pick<Leaf, "kind" | "geometry"> {
  let properties = firstChild(shape, "p:spPr");
  let custom = firstChild(properties, "a:custGeom");
  if (custom) {
    let paths = pathsOf(custom, box, budget);
    return { kind: "paths", ...(paths ? { geometry: { paths } } : {}) };
  }
  let preset = firstChild(properties, "a:prstGeom");
  let name = attribute(preset, "prst");
  return preset && name ? { kind: name, geometry: { preset: name, adjust: adjustOf(preset) } } : {};
}

/** Lists `child` of a shape tree, a group's elements in the group's place, each placed on its page. */
function listLeaves(child: XmlElement, frame: Matrix | undefined, leaves: Leaf[], budget: Budget): void {
  if (child.name === "p:grpSp") {
    let group = frame && placed(childAt(child, "p:grpSpPr", "a:xfrm"));
    for (let within of childElements(child)) listLeaves(within, group && multiply(frame!, group.frame), leaves, budget);
    return;
  }
  if (!["p:sp", "p:pic", "p:cxnSp", "p:graphicFrame"].includes(child.name)) return;
  if (--budget.shapes < 0) throw new XmlError("limit", "The export holds too many shapes");
  let own = placed(child.name === "p:graphicFrame" ? firstChild(child, "p:xfrm") : childAt(child, "p:spPr", "a:xfrm"));
  let placement = frame && own && placementOf(multiply(frame, own.matrix), own.box);
  leaves.push({ ...(placement ? { placement } : {}), ...(child.name === "p:sp" ? outlineOf(child, own?.box, budget) : {}) });
}

// As `@gadgets/office-content/ooxml` names them, in the namespaces Office and Google write.
const XML: XmlOptions = {
  namespaces: {
    "http://schemas.openxmlformats.org/drawingml/2006/main": "a",
    "http://purl.oclc.org/ooxml/drawingml/main": "a",
    "http://schemas.openxmlformats.org/presentationml/2006/main": "p",
    "http://purl.oclc.org/ooxml/presentationml/main": "p",
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships": "r",
    "http://purl.oclc.org/ooxml/officeDocument/relationships": "r",
  },
  maxElements: MAX_TREE_ELEMENTS,
};

/** Why an export, or a page of one, gave no outlines: what is logged, once a session. */
export type ExportLoss =
  | "http-4xx" | "http-5xx" | "too-large" | "slow" | "failed" | "unreadable" | "page-limit" | "page-unreadable" | "slide-count";

/**
 * Google's PowerPoint export of a presentation as far as a drawing needs it: the part each slide is
 * in, in the deck's order, and each of those pages and the layouts and masters under them.
 */
export type DeckExport = { slides: readonly string[]; pages: ReadonlyMap<string, ExportPage>; numbers: number };

/**
 * Reads an export, throwing if it is not a PowerPoint file. A page that cannot be read, or that
 * would take the deck past what is read of one, is left out and `lost` told why. Nothing of
 * `bytes` is kept.
 */
export async function readExport(bytes: Uint8Array, lost: (why: ExportLoss) => void = () => {}): Promise<DeckExport> {
  let small = () => openZip(bytes, SMALL_LIMITS);
  let main = await findMainPart(small(), "ppt/presentation.xml");
  let relationships = await readRelationships(small(), main);
  let list = firstChild(parseXml(await small().readText(main), XML), "p:sldIdLst");
  // Every slide in order, however few are read: what pairs the export's slides with the deck's.
  let slides = childElements(list, "p:sldId").map(slide => {
    let relationship = relationships.get(attribute(slide, "r:id") ?? "");
    return relationship && !relationship.external && relationship.type === "slide" ? relationship.target : "";
  });
  let pages = new Map<string, ExportPage>();
  let left = { pages: MAX_DECK_PAGES, bytes: MAX_DECK_BYTES, shapes: MAX_DECK_SHAPES, numbers: MAX_DECK_NUMBERS };
  let seen = new Set<string>();
  for (let slide of slides) {
    // Nothing more is kept once a deck's worth is read, so nothing more is inflated.
    if (left.pages < 0 || left.bytes < 0) break;
    // The slide, the layout it is over, and the master that is over.
    for (let name: string | undefined = slide, depth = 0; name && depth < 3 && !seen.has(name); depth++) {
      seen.add(name);
      if (--left.pages < 0) break;
      try {
        let over: string | undefined = depth < 2
          ? findRelationship(await readRelationships(small(), name), depth ? "slideMaster" : "slideLayout")?.target : undefined;
        // Each shape and group of the page's shape tree is read and let go before the next, and
        // the archive opened for the one page, so no more than a page's text is held inflated.
        let text = await openZip(bytes, PAGE_LIMITS).readText(name);
        if ((left.bytes -= text.length) < 0) throw new XmlError("limit", "The export holds too much");
        let budget = { shapes: Math.min(MAX_PAGE_SHAPES, left.shapes), numbers: Math.min(MAX_PAGE_NUMBERS, left.numbers) };
        let spent = { ...budget };
        let leaves: Leaf[] = [];
        // A slide's root holds `p:cSld`, and that the `p:spTree` whose children these are.
        for (let child of streamElements(text, 3, XML)) listLeaves(child, IDENTITY, leaves, budget);
        left.shapes -= spent.shapes - budget.shapes;
        left.numbers -= spent.numbers - budget.numbers;
        pages.set(name, { leaves, ...(over ? { over } : {}) });
        name = over;
      } catch (error) {
        let limit = error instanceof XmlError ? error.code === "limit" : error instanceof ZipError && error.code.endsWith("too-large");
        lost(limit ? "page-limit" : "page-unreadable");
        break;
      }
    }
  }
  return { slides, pages, numbers: MAX_DECK_NUMBERS - left.numbers };
}

/** What the export would have to say of an element: a freeform's paths, or a preset by name. */
function wanted(element: RestPageElement): "paths" | string | undefined {
  let type = element.shape?.shapeType;
  return type === "CUSTOM" ? "paths" : ADJUSTED_PRESETS.get(type ?? "");
}

/** Whether any of `elements`, or of the groups among them, is drawn from the export. */
export function needsExport(elements: readonly RestPageElement[] | undefined): boolean {
  return (elements ?? []).some(element => wanted(element) !== undefined || needsExport(element.elementGroup?.children));
}

function near(a: Placement, b: Placement): boolean {
  let turn = Math.abs(a.rotation - b.rotation) % 360;
  return a.flipped === b.flipped && Math.min(turn, 360 - turn) <= NEAR_DEGREES &&
    (["x", "y", "width", "height"] as const).every(side => Math.abs(a.bounds[side] - b.bounds[side]) <= NEAR_POINTS);
}

/**
 * Adds to `into` the geometry of each of `elements`, a page's as the API reports them, that
 * `page`, the same page of the export, is certain to hold: one that comes at the same place in the
 * page's order, or failing that the only one there could be, and that is the same kind of shape in
 * the same place, at the same size and turn. Adds none, and returns false, when some shape has no
 * such shape in `page` at all: it is then some other page, or the page at some other time.
 */
export function matchGeometry(
  elements: readonly RestPageElement[] | undefined, page: ExportPage, into: Map<string, ShapeGeometry>,
): boolean {
  let own: { element: RestPageElement; placement?: Placement }[] = [];
  let list = (within: readonly RestPageElement[] | undefined, frame: Matrix | undefined) => {
    for (let element of within ?? []) {
      let matrix = frame && element.transform && multiply(frame, matrixOf(element.transform));
      if (element.elementGroup) {
        list(element.elementGroup.children, matrix);
        continue;
      }
      let box = localBox(element);
      let placement = matrix && box && placementOf(matrix, box);
      own.push({ element, ...(placement ? { placement } : {}) });
    }
  };
  list(elements, IDENTITY);
  let inOrder = own.length === page.leaves.length;
  let found = new Map<string, ShapeGeometry>();
  for (let [at, { element, placement }] of own.entries()) {
    let kind = wanted(element);
    if (!kind || !placement || !element.objectId) continue;
    let fits = (leaf: Leaf) => leaf.kind === kind && !!leaf.placement && near(placement, leaf.placement);
    let candidates = inOrder && fits(page.leaves[at]) ? [page.leaves[at]] : page.leaves.filter(fits);
    if (candidates.length === 0) return false;
    if (candidates.length === 1 && candidates[0].geometry) found.set(element.objectId, candidates[0].geometry);
  }
  for (let [id, geometry] of found) into.set(id, geometry);
  return true;
}

/** A slide as the presentation's outline lists it. */
export type ListedSlide = { id: string; layout?: string; master?: string; skipped?: boolean };

/**
 * The part of `deck` each of `slides`, the saved presentation's in order, is in: by its place, or
 * by its place among the slides that are not skipped when the export holds only as many as those.
 * Undefined when the export is of some other number of slides, so of the presentation at another
 * time. A slide's part is still only where to look: `matchGeometry()` holds each to its shapes.
 */
export function exportedSlides(deck: DeckExport, slides: readonly ListedSlide[]): Map<string, string> | undefined {
  let shown = slides.filter(slide => !slide.skipped);
  let listed = deck.slides.length === slides.length ? slides : deck.slides.length === shown.length ? shown : undefined;
  return listed && new Map(listed.map((slide, index) => [slide.id, deck.slides[index]]));
}

/**
 * The geometry `deck` holds for the shapes of `pages`, saved slides with their elements, and of
 * `under`, layouts and masters. A layout or master is looked for under each slide of `slides` that
 * is laid over it, so one a slide not saved yet names is found through the saved slides that share it.
 */
export function resolveGeometry(
  deck: DeckExport, slides: readonly ListedSlide[],
  pages: Iterable<{ objectId?: string; pageElements?: RestPageElement[] }>,
  under: Iterable<{ objectId?: string; pageElements?: RestPageElement[] }>,
): Map<string, ShapeGeometry> | undefined {
  let parts = exportedSlides(deck, slides);
  if (!parts) return undefined;
  let geometry = new Map<string, ShapeGeometry>();
  for (let page of pages) {
    let exported = deck.pages.get(parts.get(page.objectId ?? "") ?? "");
    if (exported) matchGeometry(page.pageElements, exported, geometry);
  }
  let candidates = new Map<string, Set<string>>();
  for (let { id, layout, master } of slides) {
    let over = deck.pages.get(parts.get(id) ?? "")?.over;
    let base = deck.pages.get(over ?? "")?.over;
    for (let [page, part] of [[layout, over], [master, base]]) {
      if (page && part) candidates.set(page, (candidates.get(page) ?? new Set()).add(part));
    }
  }
  for (let page of under) {
    if (!needsExport(page.pageElements)) continue;
    for (let part of candidates.get(page.objectId ?? "") ?? []) {
      let exported = deck.pages.get(part);
      if (exported && matchGeometry(page.pageElements, exported, geometry)) break;
    }
  }
  return geometry;
}

// An export is kept while its presentation's revision stands, but no longer than this.
const HELD_MS = 10 * 60_000;
// How long one is kept whatever the revision: for a viewer, who is told none; while an editor's
// keeps moving, since each shape is held to where the API puts it now; and before Drive is asked
// again for one it did not make.
const REFETCH_MS = 60_000;
/** How long a read waits for the export: past it the read goes on without, and a later read has it. */
export const EXPORT_WAIT_MS = 5_000;
/** How long Drive is given to make and send the export. */
export const EXPORT_TIMEOUT_MS = 10_000;
/** As many coordinates as an isolate keeps of exports, and as many sessions' exports, for all its sessions. */
const MAX_HELD_NUMBERS = 4 * MAX_DECK_NUMBERS;
export const MAX_HELD_EXPORTS = 32;

type Loading = { since: number; done?: Promise<void> };
type Held = { revisionId?: string; at: number; deck?: DeckExport; loading?: Loading };
// By the session that fetched it: an export is as private as the presentation.
const held = new Map<object, Held>();
const logged = new WeakMap<object, Set<ExportLoss>>();
// One export is fetched and read at a time, which is the most memory any takes.
let inFlight: Loading | undefined;
// A fetch that never settled, as one cut off with its request is, stands in no other's way. One
// still alive may make three requests: its own, and one each for a refreshed and a reloaded token.
const stuck = (loading: Loading | undefined, now: number) => !loading || now - loading.since > 3.5 * EXPORT_TIMEOUT_MS;

/** Logs why `holder`'s drawings go without the export, once for each reason. */
export function logLoss(holder: object, why: ExportLoss, error?: unknown): void {
  let reasons = logged.get(holder) ?? new Set();
  if (reasons.has(why)) return;
  logged.set(holder, reasons.add(why));
  logger.info("drew a presentation without its PowerPoint export", {
    event: "google.slides.export.unused", outcome: why, ...(error === undefined ? {} : { error }),
  });
}

/** Lets go of what `holder` keeps, when its session ends. */
export function releaseExport(holder: object): void {
  held.delete(holder);
}

/**
 * The export `holder` keeps of its presentation at `revisionId`, fetched with `fetch` when it
 * keeps none that is current. Concurrent reads share one fetch, and none waits long for it:
 * `"pending"` when it is still being fetched and there is no older one to draw from meanwhile, so
 * that a read a little later has it, or takes the fetch up. Undefined, never an error, when there
 * is none to be had: what is drawn from the export is then drawn without it.
 */
export async function exportFor(
  holder: object, revisionId: string | undefined, fetch: () => Promise<Uint8Array | ExportLoss>,
): Promise<DeckExport | "pending" | undefined> {
  let now = Date.now();
  for (let [key, entry] of held) if (now - entry.at > HELD_MS && !entry.loading) held.delete(key);
  let kept = held.get(holder);
  let certain = kept?.deck !== undefined && revisionId !== undefined && kept.revisionId === revisionId;
  if (kept && (certain || now - kept.at < REFETCH_MS)) return kept.deck;
  let entry = kept ?? { at: 0 };
  if (stuck(entry.loading, now)) {
    if (!stuck(inFlight, now)) return entry.deck ?? "pending";
    held.set(holder, entry);
    inFlight = entry.loading = { since: now };
    entry.loading.done = load(holder, entry, entry.loading, revisionId, fetch);
  }
  let timer!: ReturnType<typeof setTimeout>;
  await Promise.race([entry.loading!.done, new Promise(resolve => { timer = setTimeout(resolve, EXPORT_WAIT_MS); })]);
  clearTimeout(timer);
  if (entry.loading) logLoss(holder, "slow");
  return entry.deck ?? (entry.loading ? "pending" : undefined);
}

async function load(
  holder: object, entry: Held, loading: Loading, revisionId: string | undefined, fetch: () => Promise<Uint8Array | ExportLoss>,
): Promise<void> {
  // What an export that could not be had leaves is the one before it, if any.
  let found: Pick<Held, "deck" | "revisionId"> | undefined;
  try {
    let bytes = await fetch();
    if (typeof bytes === "string") logLoss(holder, bytes);
    else found = { deck: await readExport(bytes, why => logLoss(holder, why)), revisionId };
  } catch (error) {
    logLoss(holder, error instanceof ZipError || error instanceof XmlError ? "unreadable" : "failed", error);
  }
  if (inFlight === loading) inFlight = undefined;
  // One given up on for a later fetch leaves what that fetch finds.
  if (entry.loading !== loading) return;
  Object.assign(entry, found, { at: Date.now(), loading: undefined });
  if (held.get(holder) !== entry) return;
  // The oldest go first.
  held.delete(holder);
  held.set(holder, entry);
  let numbers = [...held.values()].reduce((sum, { deck }) => sum + (deck?.numbers ?? 0), 0);
  for (let [key, { deck }] of held) {
    if (numbers <= MAX_HELD_NUMBERS && held.size <= MAX_HELD_EXPORTS) break;
    held.delete(key);
    numbers -= deck?.numbers ?? 0;
  }
}
