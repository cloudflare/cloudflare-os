/**
 * Google Slides as far as the workerd tests need it: presentation and page reads, and an atomic,
 * revision-checked `batchUpdate` of the requests the gatekeeper sends.
 */

import { vi } from "vitest";
import type {
  RestPageBackgroundFill, RestPageElement, RestPresentation, RestSlide, RestText,
  RestThemeColorPair,
} from "../src/slides-api";
import { text } from "./slides-fixture";

/** A fake of one Google API: its answer to a request, or `undefined` for one it does not serve. */
export type ProviderFake = { handle(request: Request): Promise<Response | undefined> };

/** Stubs `fetch` with `fakes`: each request goes to the first that answers it. */
export function serveFakes(fakes: readonly ProviderFake[]): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    let request = new Request(input, init);
    for (let fake of fakes) {
      let response = await fake.handle(request.clone());
      if (response) return response;
    }
    throw new Error(`Unexpected provider request: ${request.method} ${request.url}`);
  }));
}

/** One provider index of a shape's text: a character, or an AutoText. */
type Unit = string | { auto: string };

type BatchRequest = Record<string, any>;

function unitsOf(body: RestText | undefined): Unit[] {
  let units = (body?.textElements ?? []).flatMap((element): Unit[] =>
    element.textRun ? [...(element.textRun.content ?? "")].flatMap(c => c.split(""))
      : element.autoText ? [{ auto: element.autoText.content ?? "" }] : []);
  return units.length > 0 ? units : ["\n"];
}

function textOfUnits(units: Unit[]): RestText {
  let elements: NonNullable<RestText["textElements"]> = [];
  let index = 0;
  for (let unit of units) {
    let last = elements.at(-1);
    if (typeof unit === "string" && last?.textRun) {
      last.textRun.content += unit;
      last.endIndex = ++index;
    } else {
      elements.push(typeof unit === "string"
        ? { startIndex: index, endIndex: ++index, textRun: { content: unit } }
        : { startIndex: index, endIndex: ++index, autoText: { type: "SLIDE_NUMBER", content: unit.auto } });
    }
  }
  return { textElements: elements };
}

export function table(objectId: string, rows: string[][]): RestPageElement {
  return {
    objectId,
    table: {
      rows: rows.length,
      columns: rows[0].length,
      tableRows: rows.map((row, rowIndex) => ({
        tableCells: row.map((cell, columnIndex) => ({
          location: { rowIndex, columnIndex }, text: text([cell]),
        })),
      })),
    },
  };
}

/** A parsed field mask: each field it names, and that field's own mask, or `true` for all of it. */
type Mask = Map<string, Mask | true>;

function parseMask(fields: string): Mask {
  let at = 0;
  let parse = (): Mask => {
    let mask: Mask = new Map();
    while (at < fields.length && fields[at] !== ")") {
      let name = /^[^,()]+/.exec(fields.slice(at))![0];
      at += name.length;
      if (fields[at] === "(") {
        at++;
        mask.set(name, parse());
        at++;
      } else {
        mask.set(name, true);
      }
      if (fields[at] === ",") at++;
    }
    return mask;
  };
  return parse();
}

/** `value` with only what `mask` names, as Google answers a request with a `fields` parameter. */
function masked(value: unknown, mask: Mask | true): unknown {
  if (mask === true || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(item => masked(item, mask));
  return Object.fromEntries(Object.entries(value).flatMap(([key, field]) => {
    let inner = mask.get(key);
    return inner === undefined ? [] : [[key, masked(field, inner)]];
  }));
}

/** Where Google serves the copy it keeps of a picture background: a bearer URL. */
export const PICTURE_COPY = "https://lh7-rt.googleusercontent.com/slidesz/picture-copy";

/**
 * A background as Google stores it from a request: `RENDERED`, the default, is omitted, and a
 * picture is downloaded once and served from Google's own host.
 */
function storedFill({ propertyState, ...fill }: RestPageBackgroundFill): RestPageBackgroundFill {
  if (fill.stretchedPictureFill) {
    if (!fill.stretchedPictureFill.contentUrl?.startsWith("https://")) throw new Invalid();
    let size = { width: { magnitude: 13600, unit: "EMU" as const }, height: { magnitude: 7650, unit: "EMU" as const } };
    return { stretchedPictureFill: { contentUrl: PICTURE_COPY, size } };
  }
  return propertyState === "RENDERED" ? fill : { propertyState, ...fill };
}

const FOLLOWING: Record<string, string> = {
  TEXT1: "DARK1", BACKGROUND1: "LIGHT1", TEXT2: "LIGHT2", BACKGROUND2: "DARK2",
};

class Invalid extends Error {}

/**
 * Google Slides as far as these tests need it: presentation and page reads, and an atomic,
 * revision-checked `batchUpdate` of the requests the gatekeeper sends.
 */
export class SlidesProvider {
  revision = 1;
  batches: { requests: BatchRequest[]; requiredRevisionId?: string }[] = [];
  /** Lands once, just before the next batch is checked, as a collaborator's edit would. */
  beforeNextBatch?: (deck: RestPresentation) => void;
  /** `lost` commits the next batch and answers 503; `dropped` answers 503 and commits nothing. */
  nextFailure?: "lost" | "dropped";
  /** Google reports a revision only to an account that can edit the presentation. */
  editable = true;
  /** Every page fetched, by ID. */
  pageReads: string[] = [];
  #copies = 0;

  constructor(public deck: RestPresentation, readonly presentationId = "deck-1") {}

  /**
   * Fakes that answer requests beside the presentation's own, such as Drive's when a test reaches
   * the presentation through a Drive binding; each provider installed serves them too.
   */
  static companions: ProviderFake[] = [];

  /** The provider installed last. */
  static installed?: SlidesProvider;

  /** Serves this presentation, and every one of `others`, as `fetch`. */
  install(...others: ProviderFake[]): this {
    SlidesProvider.installed = this;
    serveFakes([this, ...others, ...SlidesProvider.companions]);
    return this;
  }

  /** Google Slides' answer to `request`, or `undefined` for a request about another file. */
  async handle(request: Request): Promise<Response | undefined> {
    let url = new URL(request.url);
    if (url.hostname !== "slides.googleapis.com") return undefined;
    let base = `/v1/presentations/${this.presentationId}`;
    if (url.pathname === `${base}:batchUpdate`) return this.#batch(await request.json());
    let fields = url.searchParams.get("fields");
    let mask = fields === null ? true : parseMask(fields);
    if (url.pathname === base) {
      let read = { ...this.deck, ...(this.editable ? { revisionId: `r${this.revision}` } : {}) };
      return Response.json(masked(read, mask));
    }
    if (!url.pathname.startsWith(`${base}/`)) return undefined;
    let pageId = url.pathname.slice(`${base}/pages/`.length);
    this.pageReads.push(pageId);
    let page = [...this.deck.slides!, ...this.deck.layouts ?? []].find(s => s.objectId === pageId);
    return page ? Response.json(masked(page, mask)) : new Response(null, { status: 404 });
  }

  /** A collaborator's edit, which moves the revision. */
  edit(change: (deck: RestPresentation) => void): void {
    change(this.deck);
    this.revision++;
  }

  slide(id: string): RestSlide {
    return this.deck.slides!.find(s => s.objectId === id)!;
  }

  text(slideId: string, elementId: string): string {
    let element = this.slide(slideId).pageElements!.find(e => e.objectId === elementId)!;
    return unitsOf(element.shape?.text).map(u => typeof u === "string" ? u : u.auto).join("");
  }

  #batch(body: { requests: BatchRequest[]; writeControl?: { requiredRevisionId?: string } }): Response {
    this.batches.push({ requests: body.requests, requiredRevisionId: body.writeControl?.requiredRevisionId });
    if (this.beforeNextBatch) {
      this.edit(this.beforeNextBatch);
      this.beforeNextBatch = undefined;
    }
    if (body.writeControl?.requiredRevisionId !== `r${this.revision}`) {
      return Response.json({ error: { code: 400, status: "FAILED_PRECONDITION" } }, { status: 400 });
    }
    let failure = this.nextFailure;
    this.nextFailure = undefined;
    if (failure === "dropped") return new Response(null, { status: 503 });
    let next = structuredClone(this.deck);
    try {
      for (let request of body.requests) this.#apply(next, request);
    } catch (error) {
      if (!(error instanceof Invalid)) throw error;
      return Response.json({ error: { code: 400, status: "INVALID_ARGUMENT" } }, { status: 400 });
    }
    this.deck = next;
    this.revision++;
    return failure === "lost" ? new Response(null, { status: 503 }) : Response.json({ replies: [] });
  }

  #apply(deck: RestPresentation, request: BatchRequest): void {
    let slides = deck.slides!;
    if (request.insertText || request.deleteText) {
      let { objectId, cellLocation } = request.insertText ?? request.deleteText;
      let holder = this.#textHolder(deck, objectId, cellLocation);
      let units = unitsOf(holder.text);
      if (request.insertText) {
        let { insertionIndex, text: inserted } = request.insertText;
        if (insertionIndex < 0 || insertionIndex > units.length - 1) throw new Invalid();
        units.splice(insertionIndex, 0, ...inserted.split(""));
      } else {
        let { type, startIndex, endIndex } = request.deleteText.textRange;
        if (type !== "FIXED_RANGE" || startIndex < 0 || endIndex <= startIndex ||
          endIndex > units.length - 1) throw new Invalid();
        units.splice(startIndex, endIndex - startIndex);
      }
      holder.text = textOfUnits(units);
    } else if (request.updateTextStyle || request.updateParagraphStyle) {
      // Styles are not modelled here; the request must still address text that exists.
      let { objectId, cellLocation, textRange, fields } =
        request.updateTextStyle ?? request.updateParagraphStyle;
      let length = unitsOf(this.#textHolder(deck, objectId, cellLocation).text).length;
      let { type, startIndex, endIndex } = textRange;
      if (type !== "FIXED_RANGE" || !fields || startIndex < 0 || endIndex <= startIndex ||
        endIndex > length) throw new Invalid();
    } else if (request.duplicateObject) {
      let { objectId, objectIds } = request.duplicateObject;
      let at = slides.findIndex(s => s.objectId === objectId);
      if (at < 0) throw new Invalid();
      let existing = new Set(JSON.stringify(deck).match(/"objectId":"[^"]+"/g)!
        .map(match => match.slice(12, -1)));
      for (let [key, value] of Object.entries<string>(objectIds)) {
        if (!existing.has(key) || existing.has(value)) throw new Invalid();
      }
      let copy = structuredClone(slides[at]);
      let rename = (id: string) => objectIds[id] ?? `${id}_copy${++this.#copies}`;
      copy.objectId = rename(objectId);
      let walk = (elements: RestPageElement[] | undefined) => elements?.forEach(element => {
        element.objectId = rename(element.objectId!);
        walk(element.elementGroup?.children);
      });
      walk(copy.pageElements);
      let notes = copy.slideProperties!.notesPage!;
      let notesId = notes.notesProperties!.speakerNotesObjectId!;
      notes.notesProperties!.speakerNotesObjectId = `${copy.objectId}-notes`;
      for (let element of notes.pageElements ?? []) {
        element.objectId = element.objectId === notesId ? `${copy.objectId}-notes` : rename(element.objectId!);
      }
      slides.splice(at + 1, 0, copy);
    } else if (request.deleteObject) {
      let { objectId } = request.deleteObject;
      let at = slides.findIndex(s => s.objectId === objectId);
      if (at >= 0) {
        let [{ slideProperties }] = slides.splice(at, 1);
        // Google deletes a master, and its layouts, with its last slide, unless it is the first.
        let master = slideProperties!.masterObjectId;
        if (deck.masters?.slice(1).some(m => m.objectId === master) &&
          !slides.some(s => s.slideProperties!.masterObjectId === master)) {
          deck.masters = deck.masters.filter(m => m.objectId !== master);
          deck.layouts = deck.layouts!.filter(l => l.layoutProperties!.masterObjectId !== master);
        }
      } else {
        let page = slides.find(s => s.pageElements?.some(e => e.objectId === objectId));
        if (!page) throw new Invalid();
        page.pageElements = page.pageElements!.filter(e => e.objectId !== objectId);
      }
    } else if (request.createShape) {
      let { objectId, shapeType, elementProperties: { pageObjectId, size, transform } } = request.createShape;
      let page = slides.find(s => s.objectId === pageObjectId);
      if (!page || JSON.stringify(deck).includes(`"objectId":"${objectId}"`)) throw new Invalid();
      page.pageElements!.push({ objectId, size, transform, shape: { shapeType } });
    } else if (request.updateShapeProperties) {
      // Properties are not modelled here; the shape must still exist.
      let { objectId, fields } = request.updateShapeProperties;
      let found = slides.some(s => s.pageElements?.some(e => e.objectId === objectId && e.shape));
      if (!found || !fields) throw new Invalid();
    } else if (request.updateSlidesPosition) {
      let { slideObjectIds, insertionIndex } = request.updateSlidesPosition;
      let order = slides.map(s => s.objectId!);
      let positions = slideObjectIds.map((id: string) => order.indexOf(id));
      if (positions.some((p: number, i: number) => p < 0 || (i > 0 && p <= positions[i - 1]))) {
        throw new Invalid();
      }
      let moving = new Set<string>(slideObjectIds);
      let staying = slides.filter(s => !moving.has(s.objectId!));
      let at = order.slice(0, insertionIndex).filter(id => !moving.has(id)).length;
      staying.splice(at, 0, ...slideObjectIds.map((id: string) => slides[order.indexOf(id)]));
      deck.slides = staying;
    } else if (request.createSlide) {
      // Every layout placeholder is copied, as a live probe showed Google does.
      let { objectId, insertionIndex = slides.length, slideLayoutReference, placeholderIdMappings = [] } =
        request.createSlide;
      let layout = deck.layouts!.find(l => l.objectId === slideLayoutReference.layoutId);
      let placeholders = layout?.pageElements!.filter(e => e.shape?.placeholder) ?? [];
      let parentOf = (mapped: { type: string; index?: number }) => placeholders.find(e =>
        e.shape!.placeholder!.type === mapped.type && (e.shape!.placeholder!.index ?? 0) === (mapped.index ?? 0));
      // Google takes the layout from the master of the slide before, or of the first slide.
      let beside = slides[Math.max(insertionIndex - 1, 0)];
      if (!layout || JSON.stringify(deck).includes(`"objectId":"${objectId}"`) || insertionIndex > slides.length ||
        (beside && beside.slideProperties!.masterObjectId !== layout.layoutProperties!.masterObjectId) ||
        placeholderIdMappings.some((m: BatchRequest) => !parentOf(m.layoutPlaceholder))) throw new Invalid();
      slides.splice(insertionIndex, 0, {
        objectId,
        pageElements: placeholders.map(({ objectId: parentObjectId, size, transform, shape }) => ({
          objectId: placeholderIdMappings.find((m: BatchRequest) => parentOf(m.layoutPlaceholder)?.objectId ===
            parentObjectId)?.objectId ?? `${objectId}_${++this.#copies}`,
          size, transform,
          shape: { shapeType: shape!.shapeType, placeholder: { ...shape!.placeholder, parentObjectId } },
        })),
        slideProperties: {
          layoutObjectId: layout.objectId,
          masterObjectId: layout.layoutProperties!.masterObjectId,
          notesPage: { notesProperties: { speakerNotesObjectId: `${objectId}-notes` }, pageElements: [] },
        },
      });
    } else if (request.updateSlideProperties) {
      let { objectId, slideProperties, fields } = request.updateSlideProperties;
      let page = slides.find(s => s.objectId === objectId);
      if (!page || fields !== "isSkipped") throw new Invalid();
      if (slideProperties.isSkipped) page.slideProperties!.isSkipped = true;
      else delete page.slideProperties!.isSkipped;
    } else if (request.insertTableRows || request.deleteTableRow) {
      let { tableObjectId, cellLocation: { rowIndex } } = request.insertTableRows ?? request.deleteTableRow;
      let grid = slides.flatMap(s => s.pageElements ?? []).find(e => e.objectId === tableObjectId)?.table;
      if (!grid || rowIndex >= grid.rows!) throw new Invalid();
      if (request.insertTableRows) {
        let { insertBelow, number } = request.insertTableRows;
        let rows = Array.from({ length: number }, () => ({
          tableCells: Array.from({ length: grid.columns! }, () => ({ text: text([""]) })),
        }));
        grid.tableRows!.splice(rowIndex + (insertBelow ? 1 : 0), 0, ...rows);
        grid.rows! += number;
      } else {
        grid.tableRows!.splice(rowIndex, 1);
        grid.rows! -= 1;
      }
      // Google renumbers the cells it moved.
      grid.tableRows!.forEach((row, r) => row.tableCells!.forEach((cell, c) => {
        cell.location = { rowIndex: r, columnIndex: c };
      }));
    } else if (request.updatePageProperties) {
      let { objectId, pageProperties, fields } = request.updatePageProperties;
      let masters = deck.masters ?? [];
      let page = [...slides, ...deck.layouts ?? [], ...masters].find(p => p.objectId === objectId);
      if (!page) throw new Invalid();
      let master = masters.includes(page);
      let properties = page.pageProperties ??= {};
      if (fields === "pageBackgroundFill") {
        let fill: RestPageBackgroundFill | undefined = pageProperties.pageBackgroundFill;
        // A master has nothing to inherit, so resetting one leaves it with none.
        properties.pageBackgroundFill = fill ? storedFill(fill)
          : master ? { propertyState: "NOT_RENDERED", solidFill: { color: { rgbColor: { red: 1, green: 1, blue: 1 } } } }
          : { propertyState: "INHERIT" };
      } else if (fields === "colorScheme") {
        // Google takes all 12 theme colours, on a master alone, and works out the four that follow.
        let colors: RestThemeColorPair[] | undefined = pageProperties.colorScheme?.colors;
        if (!master || colors?.length !== 12) throw new Invalid();
        let following = Object.entries(FOLLOWING).map(([type, follows]) =>
          ({ type, color: colors.find(color => color.type === follows)?.color }));
        properties.colorScheme = { colors: [...colors, ...following] };
      } else {
        throw new Invalid();
      }
    } else {
      throw new Invalid();
    }
  }

  #textHolder(
    deck: RestPresentation, objectId: string,
    cell?: { rowIndex: number; columnIndex: number },
  ): { text?: RestText } {
    for (let page of deck.slides!) {
      let element = page.pageElements!.find(e => e.objectId === objectId);
      if (element && cell) {
        let found = element.table?.tableRows?.[cell.rowIndex]?.tableCells?.[cell.columnIndex];
        if (!found) throw new Invalid();
        return found;
      }
      if (element?.shape) return element.shape;
      let notes = page.slideProperties!.notesPage!;
      if (notes.notesProperties!.speakerNotesObjectId === objectId) {
        let existing = notes.pageElements!.find(e => e.objectId === objectId);
        if (existing) return existing.shape!;
        let created: RestPageElement = { objectId, shape: { shapeType: "TEXT_BOX" } };
        notes.pageElements!.push(created);
        return created.shape!;
      }
    }
    throw new Invalid();
  }
}

