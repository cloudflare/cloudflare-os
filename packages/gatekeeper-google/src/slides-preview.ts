/**
 * The approver's preview of a presentation (see Gatekeeper.previewResource()): its slides as they
 * will be once the queued changes apply, drawn from the same replay agents read through, with each
 * slide and element a change touches tied to that change.
 *
 * A slide is drawn from Slides' own JSON, resolved as Google resolves it for display: a
 * placeholder takes its place, fill, outline and text styles from its layout's placeholder, and
 * that from its master's; a slide shows its master's and layout's other elements behind its own;
 * theme colours become the colours of the slide's master. What a surface needs to draw an element
 * as Slides does is given resolved: its outline's geometry, stroke and shadow, a picture's crop and
 * transparency, a table's grid, fills and borders, and each paragraph's and run's full style.
 * Nothing Google works out as it renders is simulated, as for any read (see
 * `slides-simulation.ts`): text is shrunk to fit only by the scale Google last reported, a bent
 * or curved line is drawn straight, and gradients and a picture's recolouring are not drawn.
 *
 * It is bounded: at most MAX_PREVIEW_SLIDES slides are fetched, those the changes touch first, then
 * their neighbours, then the rest in order. Any other slide is listed with its background alone.
 * Pictures are inlined only from Google's image host, within the caps of `inlineImages()`.
 */

import type {
  PresentationSlide, ResourcePreview, SlideArrow, SlideElement, SlideParagraph, SlideShadow,
  SlideStroke, SlideTable, SlideTableCell, SlideTextStyle,
} from "@gadgets/workshop-shared/gatekeeper";
import type {
  RestBorderRow, RestBullet, RestCropProperties, RestDimension, RestLineProperties, RestOpaqueColor, RestPageElement,
  RestParagraphStyle, RestPresentation, RestShadow, RestShapeProperties, RestSlide, RestSolidFill,
  RestText, RestTextStyle, RestThemePage,
} from "./slides-api";
import { pageOf, slideIdOf, type DesignChange } from "./slides-design";
import { ALIGNMENTS, BASELINES, colorOf, CONTENT_ALIGNMENTS } from "./slides-format";
import {
  emu, IDENTITY, localBox, matrixOf, multiply, placementOf, points, roundedPlacement, slidePoint,
  type Matrix,
} from "./slides-geometry";
import { mastersOf, slideIds, themePagesOf } from "./slides-model";
import {
  batchSlides, isDesignBatch, replayChanges, slidesToFetch, type Deck, type QueuedChange, type SlidesAction,
} from "./slides-simulation";

/** The most slides one preview fetches, each a request of its own. */
export const MAX_PREVIEW_SLIDES = 25;

/** The most distinct pictures one preview downloads. */
export const MAX_PREVIEW_IMAGES = 40;

/**
 * A slide's width in device pixels where the approver sees it largest: the main canvas on a
 * high-density screen. Each picture is fetched only as wide as it is drawn there.
 */
export const PREVIEW_SLIDE_PIXELS = 1600;
// The narrowest a picture is fetched: smaller still is not worth a picture.
const MIN_PICTURE_PIXELS = 200;

/** How wide, in pixels, to fetch a picture drawn `width` wide on a slide `slideWidth` wide. */
export function picturePixels(width: number, slideWidth: number): number {
  let pixels = Math.ceil((width / slideWidth) * PREVIEW_SLIDE_PIXELS / 100) * 100;
  return Number.isFinite(pixels) ? Math.min(2048, Math.max(MIN_PICTURE_PIXELS, pixels)) : PREVIEW_SLIDE_PIXELS;
}

/** The largest picture a preview inlines, in bytes. */
export const MAX_PREVIEW_IMAGE_BYTES = 1024 * 1024;

/**
 * The most picture bytes one preview carries, counting a picture once for each element showing
 * it, so a logo on every slide counts every time. Inlined as base64, they grow by a third.
 */
export const MAX_PREVIEW_TOTAL_IMAGE_BYTES = 4 * 1024 * 1024;

// Pictures downloaded at once.
const IMAGE_CONCURRENCY = 4;

// Google's default page, 10 by 5.625 inches, for a read that reports none.
const DEFAULT_PAGE_SIZE = { width: 720, height: 405 };

/**
 * A picture the preview shows, as an element or a slide's background, which `inlineImages()` may
 * download into it.
 */
export type PreviewImage = {
  /** Google's bearer URL for it, which never leaves the gatekeeper. */
  contentUrl: string;
  /** How wide to fetch it, in pixels (see picturePixels). */
  pixels: number;
  /** Puts the picture, as a `data:` URL, where it is shown. */
  place(url: string): void;
};

/**
 * Where the preview would show part of a slide as Google itself draws it: an element whose shape
 * no read describes, as a freehand line's path, on a slide no change touches. The caller fetches
 * the slide's render (see `GoogleSlidesApi.getThumbnailUrl()`) and places it, as a `data:` URL;
 * if it cannot, the element is drawn as best its read allows.
 */
export type PreviewRender = { slideId: string; place(url: string): void };

/** What a preview is drawn from: the preview outline, the slides fetched, and the changes. */
export type PreviewSource = {
  /** A read with `GoogleSlidesApi.getPreviewOutline()`. */
  outline: RestPresentation;
  /** Full pages of the slides fetched, which `previewSlideIds()` picks. */
  slides: ReadonlyMap<string, RestSlide>;
  /** The queued changes, oldest first. */
  changes: readonly QueuedChange[];
  /** Browser URL for opening the presentation, when it exists. */
  url?: string;
};

/**
 * The slides a preview fetches, at most `limit`: every slide a change touches, and each slide the
 * replay needs to draw it, first; then the slides beside those; then the rest, in order. Only
 * slides of `order`, the slide IDs Google has, are named.
 */
export function previewSlideIds(
  order: readonly string[], changes: readonly QueuedChange[], limit = MAX_PREVIEW_SLIDES,
): string[] {
  let touched = changes.flatMap(({ action }) => slidesOf(action));
  let present = new Set(order);
  let picked = new Set<string>();
  let pick = (id: string | undefined) => {
    if (id !== undefined && present.has(id) && picked.size < limit) picked.add(id);
  };
  // In the order they are touched, so a cap keeps the earliest changes whole.
  for (let id of touched) for (let needed of slidesToFetch([id], changes)) pick(needed);
  for (let id of touched) {
    let at = order.indexOf(id);
    if (at >= 0) [order[at - 1], order[at + 1]].forEach(pick);
  }
  order.forEach(pick);
  return [...picked];
}

/** The slides `action` names, whether it changes them or places a slide beside them. */
function slidesOf(action: SlidesAction): string[] {
  switch (action.kind) {
    case "duplicateSlide":
      return [action.payload.slideId, action.payload.newSlideId];
    case "deleteSlide":
      return [action.payload.slideId];
    case "moveSlides":
      return [...action.payload.slideIds, ...(action.payload.after ? [action.payload.after] : [])];
    case "createSlide":
      return [action.payload.newSlideId, ...(action.payload.after ? [action.payload.after] : [])];
    case "skipSlides":
      return action.payload.slideIds;
    default:
      return batchSlides(action);
  }
}

/** Which slides, elements and theme pages each drawn change touches, by its index in `actions`. */
type Attribution = {
  slides: Map<string, Set<number>>;
  elements: Map<string, number>;
  themePages: Map<string, Set<number>>;
  /** Images whose picture a change replaces, whose old picture must not be shown. */
  repictured: Set<string>;
};

function attribute(changes: readonly QueuedChange[]): Attribution {
  let attribution: Attribution = {
    slides: new Map(), elements: new Map(), themePages: new Map(), repictured: new Set(),
  };
  let add = (map: Map<string, Set<number>>, id: string, change: number) => {
    let set = map.get(id) ?? new Set();
    map.set(id, set.add(change));
  };
  changes.forEach(({ action }, change) => {
    if (isDesignBatch(action)) {
      for (let design of action.payload.changes) {
        let slideId = slideIdOf(design);
        if (slideId === undefined) {
          add(attribution.themePages, pageOf(design).id, change);
          continue;
        }
        add(attribution.slides, slideId, change);
        let elementId = elementOf(design);
        if (elementId === undefined) continue;
        attribution.elements.set(elementId, change);
        if (design.op === "replaceImage") attribution.repictured.add(elementId);
      }
    } else {
      for (let id of changedSlidesOf(action)) add(attribution.slides, id, change);
    }
  });
  return attribution;
}

/**
 * The slides a change other than a design batch changes: a copy, not its source, and the slides
 * moved, not the one they follow.
 */
function changedSlidesOf(action: Exclude<SlidesAction, { payload: { changes: unknown } }>): string[] {
  switch (action.kind) {
    case "duplicateSlide":
    case "createSlide":
      return [action.payload.newSlideId];
    case "deleteSlide":
      return [action.payload.slideId];
    case "moveSlides":
    case "skipSlides":
      return action.payload.slideIds;
  }
}

/** The element a design change creates or changes, if it is about one. */
function elementOf(change: DesignChange): string | undefined {
  if ("elementId" in change && change.elementId !== undefined) return change.elementId;
  if ("id" in change && typeof change.id === "string") return change.id;
  return undefined;
}

/**
 * The presentation as it will be once `source.changes` apply, and the pictures it shows, which
 * `inlineImages()` may then download into it. A change replay cannot apply is omitted with its
 * reason, as is every change after it, which would apply over it.
 */
export function presentationPreview(
  source: PreviewSource,
): { preview: ResourcePreview; images: PreviewImage[]; renders: PreviewRender[] } {
  let { outline, changes } = source;
  let base: Deck = {
    order: slideIds(outline),
    slides: source.slides,
    ...mastersOf(outline),
    themePages: themePagesOf(outline),
  };
  let replay = replayChanges(base, changes);
  let deck = replay.kind === "complete" ? replay.value : replay.partial;
  let stopped = replay.kind === "complete" ? changes.length : changes.indexOf(replay.unsupported);
  let drawn = changes.slice(0, stopped);
  let omitted = replay.kind === "complete" ? [] : changes.slice(stopped).map(({ id }, i) => ({
    action: id,
    reason: i === 0
      ? `This change no longer applies to the presentation: ${replay.reason}.`
      : `An earlier queued change no longer applies, so this one, queued after it, is not drawn.`,
  }));

  let attribution = attribute(drawn);
  let size = pageSize(outline);
  // Pictures on changed slides are downloaded first.
  let changedImages: PreviewImage[] = [];
  let otherImages: PreviewImage[] = [];
  let renders: PreviewRender[] = [];
  let baseOrder = new Set(base.order);
  let finalOrder = new Set(deck.order);
  let draw = (id: string, from: Deck, status?: "added" | "removed"): PresentationSlide => {
    let images: PreviewImage[] = [];
    let page = new PageContext(from, id, attribution, images, size);
    let changed = [...attribution.slides.get(id) ?? []];
    for (let themeId of page.themePageIds) changed.push(...attribution.themePages.get(themeId) ?? []);
    let background = page.background();
    let slide: PresentationSlide = {
      id,
      changes: [...new Set(changed)].toSorted((a, b) => a - b),
      ...(status ? { status } : {}),
      ...(background.color ? { background: background.color } : {}),
      // A removed slide's content is shown as it was, with no change marked on what it holds.
      elements: page.elements(status === "removed", changed.length === 0 && status !== "added"
        ? place => renders.push({ slideId: id, place })
        : undefined),
    };
    // The background first, as it is behind everything else.
    if (background.picture) {
      images.unshift({ contentUrl: background.picture, pixels: PREVIEW_SLIDE_PIXELS, place: url => { slide.backgroundImage = url; } });
    }
    (changed.length > 0 ? changedImages : otherImages).push(...images);
    return slide;
  };
  let slides = deck.order.map(id => draw(id, deck, baseOrder.has(id) ? undefined : "added"));
  // A removed slide is shown where it was: after the slide that came before it.
  let placed = deck.order.slice();
  base.order.forEach((id, at) => {
    if (finalOrder.has(id)) return;
    let before = base.order.slice(0, at).findLast(earlier => placed.includes(earlier));
    let index = before === undefined ? 0 : placed.indexOf(before) + 1;
    placed.splice(index, 0, id);
    slides.splice(index, 0, draw(id, base, "removed"));
  });

  return {
    preview: {
      title: outline.title ?? "Untitled presentation",
      ...(source.url ? { url: source.url } : {}),
      actions: drawn.map(({ id }) => id),
      ...(omitted.length > 0 ? { omitted } : {}),
      content: {
        type: "presentation",
        ...size,
        slides,
      },
    },
    images: [...changedImages, ...otherImages],
    renders,
  };
}

function pageSize({ pageSize: size }: RestPresentation): { width: number; height: number } {
  let width = points(emu(size?.width));
  let height = points(emu(size?.height));
  return width > 0 && height > 0 ? { width, height } : DEFAULT_PAGE_SIZE;
}

/** A colour as CSS takes it, a theme colour resolved through `theme`; undefined for none. */
export function cssColor(
  color: RestOpaqueColor | undefined, theme: ReadonlyMap<string, string>, alpha = 1,
): string | undefined {
  let read = colorOf(color);
  let hex = read?.startsWith("#") ? read : read && theme.get(read);
  if (!hex) return undefined;
  if (alpha >= 1) return hex;
  return `${hex}${Math.round(Math.max(alpha, 0) * 255).toString(16).padStart(2, "0")}`;
}

/** A master's theme colours, the four that repeat others included, each `#rrggbb`. */
function themeOf(master: RestThemePage | undefined): Map<string, string> {
  let theme = new Map<string, string>();
  for (let { type, color } of master?.pageProperties?.colorScheme?.colors ?? []) {
    // Google omits a zero component, so black is `{}`.
    let hex = colorOf({ rgbColor: color ?? {} });
    if (type && hex) theme.set(type, hex);
  }
  return theme;
}

type Fill = { propertyState?: string; solidFill?: RestSolidFill };

type Outline = NonNullable<RestShapeProperties["outline"]>;

/** The scale Google last shrank a shape's text by to fit it, and how far it closed its lines up. */
type Fit = { scale: number; reduction: number };

const UNFITTED: Fit = { scale: 1, reduction: 0 };

/** A list's style for each nesting level, as `TextContent.lists` holds it. */
type RestList = { nestingLevel?: Record<string, { bulletStyle?: RestTextStyle } | undefined> };

const DASHES: Record<string, NonNullable<SlideStroke["dash"]>> = {
  DOT: "dot", DASH: "dash", DASH_DOT: "dashDot", LONG_DASH: "longDash", LONG_DASH_DOT: "longDashDot",
};

const ARROWS: Record<string, SlideArrow> = {
  STEALTH_ARROW: "stealthArrow", FILL_ARROW: "fillArrow", FILL_CIRCLE: "fillCircle",
  FILL_SQUARE: "fillSquare", FILL_DIAMOND: "fillDiamond", OPEN_ARROW: "openArrow",
  OPEN_CIRCLE: "openCircle", OPEN_SQUARE: "openSquare", OPEN_DIAMOND: "openDiamond",
};

// Shapes the preview draws as their box, which it names no geometry for.
const BOXES = new Set(["TEXT_BOX", "RECTANGLE", "TYPE_UNSPECIFIED"]);

// Slides' default line, 1px, which Google stores as 9525 EMU.
const DEFAULT_LINE_WEIGHT = 0.75;

// The edges of a table whose borders a queued change leaves unknown (see `unsetBorders()`) are
// drawn as Slides draws a new table's: 1pt, in the theme's first dark colour.
const DEFAULT_BORDER_WEIGHT = 1;

// Slides' default text size, in points, which a shape's autofit scales too.
const DEFAULT_FONT_SIZE = 14;

// What Google stores for text at the regular weight.
const REGULAR_WEIGHT = 400;

/** One paragraph's runs, with the marker that starts it. */
type RestParagraph = {
  marker?: { style?: RestParagraphStyle; bullet?: RestBullet };
  runs: { text: string; style?: RestTextStyle }[];
  /** The style of the newline ending it, which a placeholder's paragraphs pass on. */
  end?: RestTextStyle;
};

/** `body` a paragraph at a time, each with its marker, runs, and the newline ending it. */
function paragraphsOf(body: RestText | undefined): RestParagraph[] {
  let paragraphs: RestParagraph[] = [];
  let current: RestParagraph | undefined;
  for (let element of body?.textElements ?? []) {
    if (element.paragraphMarker) {
      paragraphs.push(current = { marker: element.paragraphMarker, runs: [] });
      continue;
    }
    let run = element.textRun ?? element.autoText;
    if (!run) continue;
    let pieces = (run.content ?? "").split("\n");
    pieces.forEach((piece, i) => {
      if (i > 0) {
        if (current) current.end = run.style;
        current = undefined;
      }
      if (!piece) return;
      if (!current) paragraphs.push(current = { runs: [] });
      current.runs.push({ text: piece, ...(run.style ? { style: run.style } : {}) });
    });
  }
  return paragraphs;
}

function levelOf(paragraph: RestParagraph): number {
  return paragraph.marker?.bullet ? paragraph.marker.bullet.nestingLevel ?? 0 : 0;
}

/**
 * The text and paragraph style a paragraph at `level` takes from a placeholder above it: Google
 * gives a paragraph not in a list the style of the parent's first paragraph at level 0, and a list
 * item that of the parent's first at its own level, each the style of that paragraph's newline.
 */
function inheritedAt(
  parents: readonly RestParagraph[][], level: number,
): { text: RestTextStyle; paragraph: RestParagraphStyle } {
  let text: RestTextStyle = {};
  let paragraph: RestParagraphStyle = {};
  // The farthest ancestor first, so the nearest wins.
  for (let paragraphs of parents.toReversed()) {
    let match = paragraphs.find(p => levelOf(p) === level) ?? paragraphs[0];
    if (!match) continue;
    Object.assign(text, match.end ?? match.runs.at(-1)?.style);
    Object.assign(paragraph, match.marker?.style);
  }
  return { text, paragraph };
}

/** A length Google reported, in points; a dimension with no magnitude is a zero it omitted. */
function lengthOf(dimension: RestDimension | undefined): number | undefined {
  return dimension && points(emu(dimension));
}

const round = (value: number, places = 2) => Math.round(value * 10 ** places) / 10 ** places + 0;

/** One slide, or a removed one, resolved against its layout and master in `deck`. */
class PageContext {
  /** The slide's layout and master. */
  readonly themePageIds: string[];
  #slide?: RestSlide;
  #attribution: Attribution;
  #images: PreviewImage[];
  #slideSize: { width: number; height: number };
  #render?: (place: PreviewRender["place"]) => void;
  #layout?: RestThemePage;
  #master?: RestThemePage;
  #theme: Map<string, string>;
  /** Every layout and master element by ID, which a placeholder names as its parent. */
  #parents = new Map<string, RestPageElement>();

  /** Collects into `images` the pictures the slide's elements show, on a slide `slideSize` big. */
  constructor(
    deck: Deck, id: string, attribution: Attribution, images: PreviewImage[], slideSize: { width: number; height: number },
  ) {
    let slide = this.#slide = deck.slides.get(id);
    this.#attribution = attribution;
    this.#images = images;
    this.#slideSize = slideSize;
    let layoutId = slide?.slideProperties?.layoutObjectId;
    let masterId = deck.masters.get(id) ?? slide?.slideProperties?.masterObjectId;
    this.#layout = layoutId === undefined ? undefined : deck.themePages.get(layoutId);
    masterId ??= this.#layout?.layoutProperties?.masterObjectId;
    this.#master = masterId === undefined ? undefined : deck.themePages.get(masterId);
    this.themePageIds = [layoutId, masterId].filter(page => page !== undefined);
    this.#theme = themeOf(this.#master);
    let index = (elements: RestPageElement[] | undefined) => {
      for (let element of elements ?? []) {
        if (element.objectId) this.#parents.set(element.objectId, element);
        index(element.elementGroup?.children);
      }
    };
    index(this.#master?.pageElements);
    index(this.#layout?.pageElements);
  }

  /**
   * The slide's background, or its layout's, or its master's: a colour, or the picture Google
   * serves of it, if a read gave its URL.
   */
  background(): { color?: string; picture?: string } {
    for (let fill of [this.#slide, this.#layout, this.#master].map(page => page?.pageProperties?.pageBackgroundFill)) {
      if (!fill || fill.propertyState === "INHERIT") continue;
      if (fill.propertyState === "NOT_RENDERED") return {};
      let picture = fill.stretchedPictureFill?.contentUrl;
      if (fill.stretchedPictureFill) return picture ? { picture } : {};
      let color = cssColor(fill.solidFill?.color, this.#theme, fill.solidFill?.alpha);
      return color ? { color } : {};
    }
    return {};
  }

  /**
   * The master's and layout's elements other than placeholders, then the slide's own, back to
   * front. `unmarked` leaves out which change touched each, as for a slide being removed. `render`,
   * where the slide as Google draws it is still the slide shown, asks for it to fill in what no
   * read describes.
   */
  elements(unmarked: boolean, render?: (place: PreviewRender["place"]) => void): SlideElement[] {
    this.#render = render;
    let drawn: SlideElement[] = [];
    let behind = (page: RestThemePage | undefined) =>
      (page?.pageElements ?? []).filter(element => !element.shape?.placeholder);
    for (let element of [...behind(this.#master), ...behind(this.#layout)]) {
      this.#draw(element, IDENTITY, drawn, true);
    }
    for (let element of this.#slide?.pageElements ?? []) this.#draw(element, IDENTITY, drawn, unmarked);
    return drawn;
  }

  /** The element and the placeholders above it, nearest first. */
  #chain(element: RestPageElement): RestPageElement[] {
    let chain = [element];
    for (let parentId = element.shape?.placeholder?.parentObjectId; parentId !== undefined;) {
      let parent = this.#parents.get(parentId);
      if (!parent || chain.includes(parent)) break;
      chain.push(parent);
      parentId = parent.shape?.placeholder?.parentObjectId;
    }
    return chain;
  }

  #draw(element: RestPageElement, parent: Matrix, into: SlideElement[], unmarked: boolean): void {
    let chain = this.#chain(element);
    // A placeholder that sets no place of its own is where its layout's is.
    let transform = chain.find(link => link.transform)?.transform;
    let matrix = transform && multiply(parent, matrixOf(transform));
    if (element.elementGroup) {
      for (let child of element.elementGroup.children ?? []) this.#draw(child, matrix ?? parent, into, unmarked);
      return;
    }
    let size = chain.find(link => link.size)?.size;
    let box = localBox(element.table || !size ? element : { ...element, size });
    if (!matrix || !box || !element.objectId) return;
    let base = { id: element.objectId, ...this.#geometry(element, matrix, box) };
    if (!base.width && !base.height && !element.line) return;
    let change = unmarked ? undefined : this.#attribution.elements.get(element.objectId);
    let drawn = this.#content(element, chain, base);
    if (!drawn) return;
    if (element.line && !element.line.lineType) this.#renderInstead(drawn, matrix, box, element.line.lineProperties);
    // In place, since the element's picture is downloaded into this very object.
    if (change !== undefined) drawn.change = change;
    into.push(drawn);
  }

  /**
   * Has a freehand line, which a read gives only the box and stroke of, replaced by its part of the
   * slide's render once that arrives: the box it sweeps, out to its stroke and arrowheads.
   */
  #renderInstead(
    drawn: SlideElement, matrix: Matrix, box: NonNullable<ReturnType<typeof localBox>>,
    properties: RestLineProperties | undefined,
  ): void {
    if (!this.#render) return;
    let { width: slideWidth, height: slideHeight } = this.#slideSize;
    let corners = [[box.x, box.y], [box.x + box.width, box.y], [box.x, box.y + box.height], [box.x + box.width, box.y + box.height]]
      .map(([x, y]) => slidePoint(matrix, x, y));
    let pad = (lengthOf(properties?.weight) || DEFAULT_LINE_WEIGHT) * 4 + 2;
    let left = Math.max(0, Math.min(...corners.map(({ x }) => x)) - pad);
    let top = Math.max(0, Math.min(...corners.map(({ y }) => y)) - pad);
    let right = Math.min(slideWidth, Math.max(...corners.map(({ x }) => x)) + pad);
    let bottom = Math.min(slideHeight, Math.max(...corners.map(({ y }) => y)) + pad);
    if (right <= left || bottom <= top) return;
    let picture: SlideElement = {
      id: drawn.id, kind: "image",
      x: round(left), y: round(top), width: round(right - left), height: round(bottom - top),
      crop: {
        left: round(left / slideWidth, 4), top: round(top / slideHeight, 4),
        right: round(1 - right / slideWidth, 4), bottom: round(1 - bottom / slideHeight, 4),
      },
    };
    this.#render(url => {
      let target: Partial<SlideElement> = drawn;
      for (let key of Object.keys(target) as (keyof SlideElement)[]) delete target[key];
      Object.assign(target, picture, { image: url });
    });
  }

  /**
   * Where the element is. A line runs from its box's top-left corner to its bottom-right, before its
   * transform turns or flips it, so it is drawn as the box of no height whose top edge, turned
   * about its centre, runs between the line's ends.
   */
  #geometry(
    element: RestPageElement, matrix: Matrix, box: NonNullable<ReturnType<typeof localBox>>,
  ): Pick<SlideElement, "x" | "y" | "width" | "height" | "rotation" | "flipped"> {
    if (element.line) {
      let start = slidePoint(matrix, box.x, box.y);
      let end = slidePoint(matrix, box.x + box.width, box.y + box.height);
      let length = Math.hypot(end.x - start.x, end.y - start.y);
      let rotation = (Math.atan2(end.y - start.y, end.x - start.x) * 180 / Math.PI + 360) % 360;
      return {
        x: round((start.x + end.x - length) / 2), y: round((start.y + end.y) / 2),
        width: round(length), height: 0,
        ...(round(rotation) % 360 ? { rotation: round(rotation) % 360 } : {}),
      };
    }
    let exact = placementOf(matrix, box);
    if (!exact) return { x: 0, y: 0, width: 0, height: 0 };
    let { bounds, rotation, flipped } = roundedPlacement(exact);
    return { ...bounds, ...(rotation ? { rotation } : {}), ...(flipped ? { flipped: true } : {}) };
  }

  #content(
    element: RestPageElement, chain: RestPageElement[],
    base: Pick<SlideElement, "id" | "x" | "y" | "width" | "height" | "rotation" | "flipped">,
  ): SlideElement | undefined {
    if (element.shape) {
      let properties = chain.map(link => link.shape?.shapeProperties);
      let fill = this.#fill(properties.map(set => set?.shapeBackgroundFill));
      let outline = this.#outline(properties.map(set => set?.outline));
      let shadow = this.#shadow(properties.map(set => set?.shadow));
      let { shapeType = "TEXT_BOX" } = element.shape;
      // A text box's text starts at its top, any other shape's at its middle, unless it says.
      let alignment = properties.map(set => CONTENT_ALIGNMENTS[set?.contentAlignment ?? ""]).find(Boolean)
        ?? (shapeType === "TEXT_BOX" ? "top" : "middle");
      let autofit = element.shape.shapeProperties?.autofit;
      let fit = { scale: autofit?.fontScale ?? 1, reduction: autofit?.lineSpacingReduction ?? 0 };
      let parents = chain.slice(1).map(link => paragraphsOf(link.shape?.text));
      let text = this.#text(element.shape.text, parents, fit);
      return {
        ...base, kind: "shape",
        ...(BOXES.has(shapeType) ? {} : { geometry: shapeType }),
        ...(fill ? { fill } : {}), ...(outline ? { outline } : {}), ...(shadow ? { shadow } : {}),
        ...(text && alignment !== "top" ? { verticalAlign: alignment } : {}),
        ...(text ? { text } : {}),
      };
    }
    if (element.table) return { ...base, kind: "table", table: this.#table(element.table) };
    if (element.line) {
      let properties = element.line.lineProperties;
      let outline = this.#stroke(properties?.lineFill?.solidFill, properties?.weight, properties?.dashStyle);
      let startArrow = ARROWS[properties?.startArrow ?? ""];
      let endArrow = ARROWS[properties?.endArrow ?? ""];
      return {
        ...base, kind: "line",
        ...(outline ? { outline } : {}),
        ...(startArrow ? { startArrow } : {}), ...(endArrow ? { endArrow } : {}),
      };
    }
    if (element.wordArt) {
      let text = element.wordArt.renderedText;
      return { ...base, kind: "shape", ...(text ? { text: [{ runs: [{ text }] }] } : {}) };
    }
    if (element.image) {
      let properties = element.image.imageProperties;
      let outline = this.#outline([properties?.outline]);
      let shadow = this.#shadow([properties?.shadow]);
      let crop = cropOf(properties?.cropProperties);
      let transparency = properties?.transparency ?? 0;
      let drawn: SlideElement = {
        ...base, kind: "image",
        ...(crop ? { crop } : {}),
        ...(transparency > 0 ? { opacity: round(Math.max(0, 1 - transparency), 3) } : {}),
        ...(outline ? { outline } : {}), ...(shadow ? { shadow } : {}),
      };
      let { contentUrl } = element.image;
      if (contentUrl && !this.#attribution.repictured.has(base.id)) {
        this.#images.push({
          contentUrl, pixels: picturePixels(base.width, this.#slideSize.width), place: url => { drawn.image = url; },
        });
      }
      return drawn;
    }
    // A video, chart or other picture-like element is drawn as a picture not fetched.
    if (element.video || element.sheetsChart || element.speakerSpotlight) return { ...base, kind: "image" };
    return undefined;
  }

  /**
   * A fill, taken from the nearest of `fills` that does not inherit. One that is drawn but names no
   * colour takes it from the nearest further one that does, drawn or not: a placeholder switched
   * on over a layout's hidden white box is drawn white.
   */
  #fill(fills: (Fill | undefined)[]): string | undefined {
    let at = fills.findIndex(fill => fill && fill.propertyState !== "INHERIT");
    let fill = fills[at];
    if (!fill || fill.propertyState === "NOT_RENDERED") return undefined;
    let solid = fills.slice(at).find(link => link?.solidFill)?.solidFill;
    return cssColor(solid?.color, this.#theme, solid?.alpha);
  }

  /** An outline, taken from the nearest of `outlines` that does not inherit. */
  #outline(outlines: (Outline | undefined)[]): SlideStroke | undefined {
    let outline = outlines.find(link => link && link.propertyState !== "INHERIT");
    if (!outline || outline.propertyState === "NOT_RENDERED") return undefined;
    return this.#stroke(outline.outlineFill?.solidFill, outline.weight, outline.dashStyle);
  }

  #stroke(
    fill: RestSolidFill | undefined, weight: RestDimension | undefined, dashStyle: string | undefined,
    fallbackWeight = DEFAULT_LINE_WEIGHT,
  ): SlideStroke | undefined {
    // Google stores a transparent line as a fill with no colour, or none at all.
    if (fill?.alpha === 0) return undefined;
    let color = cssColor(fill?.color, this.#theme, fill?.alpha);
    if (!color) return undefined;
    let dash = DASHES[dashStyle ?? ""];
    return { color, weight: lengthOf(weight) || fallbackWeight, ...(dash ? { dash } : {}) };
  }

  /** A shadow, taken from the nearest of `shadows` that does not inherit. */
  #shadow(shadows: (RestShadow | undefined)[]): SlideShadow | undefined {
    let shadow = shadows.find(link => link && link.propertyState !== "INHERIT");
    if (!shadow || shadow.propertyState === "NOT_RENDERED") return undefined;
    let color = cssColor(shadow.color ?? { rgbColor: {} }, this.#theme, shadow.alpha ?? 1);
    if (!color) return undefined;
    let { translateX: x = 0, translateY: y = 0, unit } = shadow.transform ?? {};
    return {
      color,
      x: points(emu({ magnitude: x, unit })), y: points(emu({ magnitude: y, unit })),
      blur: lengthOf(shadow.blurRadius) ?? 0,
    };
  }

  #table(table: NonNullable<RestPageElement["table"]>): SlideTable {
    let rows = table.rows ?? 0;
    let columns = table.columns ?? 0;
    let cells: (SlideTableCell | null)[][] =
      Array.from({ length: rows }, () => Array.from({ length: columns }, (): SlideTableCell => ({})));
    for (let row of table.tableRows ?? []) {
      for (let cell of row.tableCells ?? []) {
        // Google omits a zero index. A merged cell appears once, at its top left.
        let r = cell.location?.rowIndex ?? 0;
        let c = cell.location?.columnIndex ?? 0;
        if (r >= rows || c >= columns || cells[r][c] === null) continue;
        let rowSpan = Math.min(cell.rowSpan ?? 1, rows - r);
        let columnSpan = Math.min(cell.columnSpan ?? 1, columns - c);
        let properties = cell.tableCellProperties;
        let text = this.#text(cell.text, [], UNFITTED);
        let fill = this.#fill([properties?.tableCellBackgroundFill]);
        let alignment = CONTENT_ALIGNMENTS[properties?.contentAlignment ?? ""];
        for (let dr = 0; dr < rowSpan; dr++) for (let dc = 0; dc < columnSpan; dc++) cells[r + dr][c + dc] = null;
        cells[r][c] = {
          ...(text ? { text } : {}), ...(fill ? { fill } : {}),
          ...(rowSpan > 1 ? { rowSpan } : {}), ...(columnSpan > 1 ? { columnSpan } : {}),
          ...(alignment && alignment !== "top" ? { verticalAlign: alignment } : {}),
        };
      }
    }
    let unknown: SlideStroke = { color: this.#theme.get("DARK1") ?? "#000000", weight: DEFAULT_BORDER_WEIGHT };
    let borders = (lines: RestBorderRow[] | undefined, count: number, length: number) =>
      Array.from({ length: count }, (_, i) => {
        let edges = new Map(lines?.[i]?.tableBorderCells?.map(edge =>
          [edge.location?.columnIndex ?? 0, edge.tableBorderProperties] as const));
        return Array.from({ length }, (_edge, j): SlideStroke | null => {
          if (!lines) return unknown;
          let edge = edges.get(j);
          return (edge && this.#stroke(edge.tableBorderFill?.solidFill, edge.weight, edge.dashStyle)) ?? null;
        });
      });
    return {
      columns: Array.from({ length: columns }, (_, c) => lengthOf(table.tableColumns?.[c]?.columnWidth) ?? 0),
      rows: Array.from({ length: rows }, (_, r) => lengthOf(table.tableRows?.[r]?.rowHeight) ?? 0),
      cells,
      horizontalBorders: borders(table.horizontalBorderRows, rows + 1, columns),
      verticalBorders: borders(table.verticalBorderRows, rows, columns + 1),
    };
  }

  /** Text a paragraph at a time, each styled as its placeholders resolve it; none if empty. */
  #text(body: RestText | undefined, parents: RestParagraph[][], fit: Fit): SlideParagraph[] | undefined {
    let lists = (body?.lists ?? {}) as Record<string, RestList | undefined>;
    let paragraphs = paragraphsOf(body).map((paragraph): SlideParagraph => {
      let level = levelOf(paragraph);
      let inherited = inheritedAt(parents, level);
      let style: RestParagraphStyle = { ...inherited.paragraph, ...paragraph.marker?.style };
      let drawn: SlideParagraph = { runs: [] };
      for (let run of paragraph.runs) {
        let look = this.#textStyle({ ...inherited.text, ...run.style }, fit.scale);
        // A line break within a paragraph is a vertical tab to Google.
        let text = run.text.replaceAll("\u000b", "\n");
        // Runs an edit split apart that draw alike are drawn as one.
        let last = drawn.runs.at(-1);
        if (last && JSON.stringify({ ...last, text: "" }) === JSON.stringify({ ...look, text: "" })) {
          last.text += text;
        } else {
          drawn.runs.push({ ...look, text });
        }
      }
      let align = ALIGNMENTS[style.alignment ?? ""];
      if (align) drawn.align = align;
      let bullet = paragraph.marker?.bullet;
      if (bullet) {
        let listed = lists[bullet.listId ?? ""]?.nestingLevel?.[level]?.bulletStyle;
        // A bullet is drawn in its paragraph's first character's style, but never as a link.
        let { link: _link, underline: _underline, strikethrough: _strikethrough, ...first } = {
          ...inherited.text, ...paragraph.runs[0]?.style ?? paragraph.end, ...listed, ...bullet.bulletStyle,
        };
        drawn.bullet = { glyph: bullet.glyph || "●", ...this.#textStyle(first, fit.scale) };
      }
      let indentStart = lengthOf(style.indentStart) ?? 0;
      let indentFirstLine = lengthOf(style.indentFirstLine) ?? indentStart;
      if (indentStart) drawn.indentStart = indentStart;
      if (indentFirstLine !== indentStart) drawn.indentFirstLine = indentFirstLine;
      // Google closes lines up by points of the percentage, as `slides-target.ts` undoes it.
      let lineSpacing = round((style.lineSpacing ?? 100) - fit.reduction);
      if (lineSpacing !== 100 && lineSpacing > 0) drawn.lineSpacing = lineSpacing;
      let spaceAbove = lengthOf(style.spaceAbove);
      let spaceBelow = lengthOf(style.spaceBelow);
      if (spaceAbove) drawn.spaceAbove = spaceAbove;
      if (spaceBelow) drawn.spaceBelow = spaceBelow;
      return drawn;
    });
    return paragraphs.some(paragraph => paragraph.runs.length > 0 || paragraph.bullet)
      ? paragraphs : undefined;
  }

  /**
   * A run's or bullet's style as Slides draws it, its size scaled by its shape's autofit. Text
   * that sets no colour is the theme's first dark colour, and a link that sets none the theme's
   * link colour, underlined.
   */
  #textStyle(style: RestTextStyle, scale: number): SlideTextStyle {
    let read: SlideTextStyle = {};
    let weight = style.weightedFontFamily?.weight;
    let bold = style.bold ?? (weight === undefined ? undefined : weight >= 700);
    if (bold) read.bold = true;
    else if (weight && weight !== REGULAR_WEIGHT && weight !== 700) read.weight = weight;
    for (let key of ["italic", "underline", "strikethrough", "smallCaps"] as const) if (style[key]) read[key] = true;
    let size = lengthOf(style.fontSize) || (scale === 1 ? undefined : DEFAULT_FONT_SIZE);
    if (size) read.fontSize = round(size * scale);
    let link = style.link !== undefined;
    let color = cssColor(style.foregroundColor?.opaqueColor, this.#theme)
      ?? (link ? this.#theme.get("HYPERLINK") : undefined) ?? this.#theme.get("DARK1");
    if (color && color !== "#000000") read.color = color;
    if (link && style.underline === undefined) read.underline = true;
    let highlight = cssColor(style.backgroundColor?.opaqueColor, this.#theme);
    if (highlight) read.background = highlight;
    let fontFamily = style.weightedFontFamily?.fontFamily ?? style.fontFamily;
    if (fontFamily) read.fontFamily = fontFamily;
    let baseline = BASELINES[style.baselineOffset ?? ""];
    if (baseline) read.baseline = baseline;
    return read;
  }
}

/** A picture's crop, as fractions of its width and height; none if it is not cropped. */
function cropOf(crop: RestCropProperties | undefined): SlideElement["crop"] {
  let edges = {
    left: crop?.leftOffset ?? 0, top: crop?.topOffset ?? 0,
    right: crop?.rightOffset ?? 0, bottom: crop?.bottomOffset ?? 0,
  };
  // What is left of the picture must have some size to stretch.
  if (edges.left + edges.right >= 1 || edges.top + edges.bottom >= 1) return undefined;
  // Google gives the crop's turn in radians.
  let angle = round(((crop?.angle ?? 0) * 180) / Math.PI, 2);
  if (Object.values(edges).every(edge => edge === 0) && !angle) return undefined;
  return {
    left: round(edges.left, 4), top: round(edges.top, 4), right: round(edges.right, 4), bottom: round(edges.bottom, 4),
    ...(angle ? { angle } : {}),
  };
}

/**
 * Downloads the pictures `images` names into where they are shown, as `data:` URLs, in the order
 * given, within MAX_PREVIEW_IMAGES distinct pictures of at most MAX_PREVIEW_IMAGE_BYTES each, and
 * MAX_PREVIEW_TOTAL_IMAGE_BYTES in all. A picture that fails to download or would pass a cap is
 * asked for again at half the width, down to MIN_PICTURE_PIXELS, and then left out: an element is
 * drawn as a placeholder, and a background as its colour alone. `download` throws for anything it
 * will not fetch or that is not a picture.
 */
export async function inlineImages(
  images: readonly PreviewImage[],
  download: (contentUrl: string, maxBytes: number, pixels: number) => Promise<{ mediaType: string; content: Uint8Array }>,
  onFailure: (error: unknown) => void = () => {},
): Promise<void> {
  // One download per picture, as wide as its widest showing.
  let byUrl = new Map<string, { pixels: number; places: PreviewImage["place"][] }>();
  for (let { contentUrl, pixels, place } of images) {
    let wanted = byUrl.get(contentUrl);
    if (wanted) {
      wanted.places.push(place);
      wanted.pixels = Math.max(wanted.pixels, pixels);
    } else if (byUrl.size < MAX_PREVIEW_IMAGES) {
      byUrl.set(contentUrl, { pixels, places: [place] });
    }
  }
  let queue = [...byUrl];
  // Spent only by what is placed. Concurrent downloads may each fill what is left, so a picture
  // that no longer fits once it arrives is asked for again, smaller.
  let budget = MAX_PREVIEW_TOTAL_IMAGE_BYTES;
  let fetchFitting = async (contentUrl: string, pixels: number) => {
    for (let width = pixels; ; width = Math.round(width / 2)) {
      let image = await download(contentUrl, Math.min(MAX_PREVIEW_IMAGE_BYTES, budget), width)
        .catch((error: unknown) => {
          if (width / 2 < MIN_PICTURE_PIXELS) onFailure(error);
          return undefined;
        });
      if (image && image.content.byteLength <= budget) return image;
      if (width / 2 < MIN_PICTURE_PIXELS || budget <= 0) return undefined;
    }
  };
  let worker = async () => {
    for (let next = queue.shift(); next && budget > 0; next = queue.shift()) {
      let [contentUrl, { pixels, places }] = next;
      let image = await fetchFitting(contentUrl, pixels);
      if (!image) continue;
      let url = `data:${image.mediaType};base64,${base64(image.content)}`;
      for (let place of places) {
        if (image.content.byteLength > budget) break;
        budget -= image.content.byteLength;
        place(url);
      }
    }
  };
  await Promise.all(Array.from({ length: IMAGE_CONCURRENCY }, worker));
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  // In chunks, since spreading a whole picture into one call would overflow the stack.
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return btoa(binary);
}
