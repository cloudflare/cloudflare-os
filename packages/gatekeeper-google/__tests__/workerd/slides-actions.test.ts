import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  RestPageElement, RestPresentation, RestSlide, RestText,
} from "../../src/slides-api";
import type { Slide, PresentationInfo, ShapeElement, TableElement } from "../../src/slides-read-types";
import type { SlideTextEdit } from "../../src/slides-types";
import { TEXT_STYLE_FIELDS } from "../../src/slides-text";
import { presentation, shape, slide, text } from "../slides-fixture";

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

function table(objectId: string, rows: string[][]): RestPageElement {
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

/** A deck as the summary's field mask returns it: shapes' text, and other elements' IDs alone. */
function summaryOf(deck: RestPresentation): RestPresentation {
  return {
    ...deck,
    slides: deck.slides!.map(slide => ({
      ...slide,
      pageElements: slide.pageElements?.map(({ objectId, shape }) =>
        ({ objectId, ...(shape ? { shape: { placeholder: shape.placeholder, text: shape.text } } : {}) })),
    })),
  };
}

class Invalid extends Error {}

/**
 * Google Slides as far as these tests need it: presentation and page reads, and an atomic,
 * revision-checked `batchUpdate` of the requests the gatekeeper sends.
 */
class SlidesProvider {
  revision = 1;
  batches: { requests: BatchRequest[]; requiredRevisionId?: string }[] = [];
  /** Lands once, just before the next batch is checked, as a collaborator's edit would. */
  beforeNextBatch?: (deck: RestPresentation) => void;
  /** `lost` commits the next batch and answers 503; `dropped` answers 503 and commits nothing. */
  nextFailure?: "lost" | "dropped";
  /** Google reports a revision only to an account that can edit the presentation. */
  editable = true;
  #copies = 0;

  constructor(public deck: RestPresentation) {}

  install(): this {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      let request = new Request(input, init);
      let url = new URL(request.url);
      if (url.pathname === "/v1/presentations/deck-1:batchUpdate") {
        return this.#batch(await request.json());
      }
      if (url.pathname === "/v1/presentations/deck-1") {
        // Only the summary's mask stops at shapes, leaving tables and groups as their IDs.
        let deck = url.searchParams.get("fields")?.includes("pageElements(objectId,shape(")
          ? summaryOf(this.deck) : this.deck;
        return Response.json({ ...deck, ...(this.editable ? { revisionId: `r${this.revision}` } : {}) });
      }
      let pageId = url.pathname.match(/^\/v1\/presentations\/deck-1\/pages\/([^/]+)$/)?.[1];
      let page = this.deck.slides!.find(s => s.objectId === pageId);
      return page ? Response.json(page) : new Response(null, { status: 404 });
    }));
    return this;
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
        slides.splice(at, 1);
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

function hooks() {
  return env.TEST_HOOKS.getByName("hooks");
}

let facetCount = 0;

function textEdits(edits: SlideTextEdit[]) {
  return edits.map(edit => ({ op: "editText", ...edit }));
}

/** A Slides gatekeeper over its own storage, and calls through a fresh session each time. */
function gatekeeper() {
  let facet = `slides-${++facetCount}`;
  let call = async (method: string, ...args: unknown[]) =>
    hooks().callSlides(facet, method as never, args);
  let queued = async (method: string, ...args: unknown[]) => {
    let outcome = await call(method, ...args);
    if (outcome.error !== undefined) throw new Error(outcome.error);
    if (outcome.actionId === undefined) throw new Error(`${method} queued nothing`);
    return outcome;
  };
  return {
    call,
    queued,
    /** `updateSlides` with text edits alone. */
    edit: (edits: SlideTextEdit[]) => queued("updateSlides", textEdits(edits)),
    callEdit: (edits: SlideTextEdit[]) => call("updateSlides", textEdits(edits)),
    slides: async (...ids: string[]) => (await call("getSlides", ids)).value as Slide[],
    /** `getSlides`, calling `entered` once the gatekeeper has started it. */
    slidesEntered: async (entered: () => void, ...ids: string[]) =>
      (await hooks().callSlides(facet, "getSlides", [ids], entered)).value as Slide[],
    outline: async () => (await call("getPresentation")).value as PresentationInfo,
    apply: (actionId: number, entered?: () => void) => hooks().applySlides(facet, actionId, entered),
    reject: (actionId: number) => hooks().rejectSlides(facet, actionId),
    autoApprovable: () => hooks().slidesAutoApprovable(facet),
    orphan: (actionId: number) => hooks().orphanSlidesClaim(facet, actionId),
  };
}

function shapeText(slide: Slide, id: string): string {
  return (slide.elements.find(e => e.id === id) as ShapeElement).text;
}

function deck() {
  return presentation([
    slide("s1", [shape("t1", text(["Q3 review"]), { placeholder: "TITLE" })]),
    slide("s2", [
      shape("t2", text(["Revenue"]), { placeholder: "TITLE" }),
      shape("b2", text(["Revenue: $10M"], ["Margin: 20%"])),
      table("tb2", [["Region", "Sales"], ["EMEA", "4"]]),
    ], { notes: text(["Mention the outlook"]) }),
    slide("s3", [shape("t3", text(["Thanks"]), { placeholder: "TITLE" })], { notes: null }),
  ]);
}

/**
 * Runs `during` once the first write has committed but before Google answers it, and holds the
 * answer until the gatekeeper has started what `during` calls, which then either takes the write
 * into account or does not.
 */
function duringFirstWrite<T>(during: (entered: () => void) => Promise<T>): () => Promise<T> {
  let fetch = globalThis.fetch;
  let started: Promise<T> | undefined;
  vi.stubGlobal("fetch", async (input: RequestInfo, init?: RequestInit) => {
    let response = await fetch(input, init);
    if (String(input).endsWith(":batchUpdate") && !started) {
      let entered = Promise.withResolvers<void>();
      started = during(entered.resolve);
      started.catch(() => {});
      await entered.promise;
    }
    return response;
  });
  return () => started!;
}

/** Drops the next write, then edits as a collaborator would, so its resend is refused as stale. */
function dropNextWrite(provider: SlidesProvider, collaborate = (d: RestPresentation) => {
  d.slides![1].pageElements![1].shape!.text = text(["Revenue: $10M"], ["Margin: 21%"]);
}): void {
  provider.nextFailure = "dropped";
  let fetch = globalThis.fetch;
  let sent = false;
  vi.stubGlobal("fetch", async (input: RequestInfo, init?: RequestInit) => {
    let response = await fetch(input, init);
    if (String(input).endsWith(":batchUpdate") && !sent) {
      sent = true;
      provider.edit(collaborate);
    }
    return response;
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Google Slides changes", () => {
  it("shows a queued edit in reads, then writes only the changed text at the read's revision", async () => {
    let provider = new SlidesProvider(deck()).install();
    let slides = gatekeeper();

    let { actionId, action, observations } = await slides.edit([
      { slideId: "s2", elementId: "b2", find: "Revenue: $10M", replace: "Revenue: $12M" },
    ]);

    expect(observations).toHaveLength(1);
    expect(action).toMatchObject({
      title: "Change slide 2 (\"Revenue\")",
      autoApprovable: true,
      actionKind: { tag: "editSlidesText" },
      descriptionIsComplete: true,
      fields: [
        { label: "Find", kind: "text", value: "Revenue: $10M" },
        { label: "Replace with", kind: "text", value: "Revenue: $12M" },
      ],
    });
    expect(shapeText((await slides.slides("s2"))[0], "b2")).toBe("Revenue: $12M\nMargin: 20%");
    expect(provider.text("s2", "b2")).toBe("Revenue: $10M\nMargin: 20%\n");

    expect(await slides.apply(actionId!)).toBeNull();

    expect(provider.text("s2", "b2")).toBe("Revenue: $12M\nMargin: 20%\n");
    // Only "0" became "2": the label and unit are not rewritten, so they keep their own style, and
    // the "2" is given the style of the "0" it replaces, here none.
    expect(provider.batches).toEqual([{
      requiredRevisionId: "r1",
      requests: [
        { insertText: { objectId: "b2", text: "2", insertionIndex: 11 } },
        { updateTextStyle: {
          objectId: "b2", style: {}, fields: TEXT_STYLE_FIELDS,
          textRange: { type: "FIXED_RANGE", startIndex: 11, endIndex: 12 },
        } },
        { deleteText: { objectId: "b2", textRange: { type: "FIXED_RANGE", startIndex: 12, endIndex: 13 } } },
      ],
    }]);
    expect(shapeText((await slides.slides("s2"))[0], "b2")).toBe("Revenue: $12M\nMargin: 20%");
  });

  it("edits table cells and creates absent speaker notes, all in one approval", async () => {
    let provider = new SlidesProvider(deck()).install();
    let slides = gatekeeper();

    let { actionId } = await slides.edit([
      { slideId: "s2", elementId: "tb2", cell: { row: 1, column: 1 }, replace: "5" },
      { slideId: "s3", replace: "Close with questions" },
    ]);
    let [s2, s3] = await slides.slides("s2", "s3");
    expect((s2.elements.find(e => e.id === "tb2") as TableElement).cells[1][1]).toEqual({ text: "5" });
    expect(s3.speakerNotes).toBe("Close with questions");

    expect(await slides.apply(actionId!)).toBeNull();

    expect(provider.batches).toHaveLength(1);
    let [after2, after3] = await slides.slides("s2", "s3");
    expect((after2.elements.find(e => e.id === "tb2") as TableElement).cells[1][1]).toEqual({ text: "5" });
    expect(after3.speakerNotes).toBe("Close with questions");
  });

  it("refuses an edit whose text is not there, or is there twice, without queuing it", async () => {
    new SlidesProvider(deck()).install();
    let slides = gatekeeper();
    let refusal = async (find: string) => {
      let outcome = await slides.callEdit([{ slideId: "s2", elementId: "b2", find, replace: "x" }]);
      expect(outcome.actionId).toBeUndefined();
      return outcome.error;
    };

    expect(await refusal("Profit")).toContain("does not contain the text to find");
    // "0" is in both "$10M" and "20%".
    expect(await refusal("0")).toContain("more than once");
    expect((await slides.callEdit([
      { slideId: "s2", elementId: "b2", find: "$10M", replace: "x" },
    ])).actionId).toEqual(expect.any(Number));
  });

  it("lets later changes build on a queued copy, and applies them in order", async () => {
    let provider = new SlidesProvider(deck()).install();
    let slides = gatekeeper();

    let copy = await slides.queued("duplicateSlide", "s2");
    let copyId = copy.value as string;
    let [copied] = await slides.slides(copyId);
    let body = copied.elements.find(e => (e as ShapeElement).text?.startsWith("Revenue:"))!;
    expect(body.id).not.toBe("b2");
    let edit = await slides.edit([{ slideId: copyId, elementId: body.id, find: "$10M", replace: "$9M" }]);

    expect((await slides.outline()).slides.map(s => s.id)).toEqual(["s1", "s2", copyId, "s3"]);
    expect(await slides.apply(edit.actionId!)).toContain("apply in the order they were queued");
    expect(provider.batches).toEqual([]);

    expect(await slides.apply(copy.actionId!)).toBeNull();
    expect(await slides.apply(edit.actionId!)).toBeNull();

    expect(provider.deck.slides!.map(s => s.objectId)).toEqual(["s1", "s2", copyId, "s3"]);
    expect(provider.text(copyId, body.id)).toBe("Revenue: $9M\nMargin: 20%\n");
    expect(provider.text("s2", "b2")).toBe("Revenue: $10M\nMargin: 20%\n");
  });

  it("moves and deletes slides as previewed", async () => {
    let provider = new SlidesProvider(deck()).install();
    let slides = gatekeeper();

    let move = await slides.queued("moveSlides", ["s3", "s1"], "s2");
    expect((await slides.outline()).slides.map(s => s.id)).toEqual(["s2", "s1", "s3"]);
    let remove = await slides.queued("deleteSlide", "s1");
    expect(remove.action).toMatchObject({ title: "Delete slide 2 (\"Q3 review\")" });
    expect((await slides.outline()).slides.map(s => s.id)).toEqual(["s2", "s3"]);

    expect(await slides.apply(move.actionId!)).toBeNull();
    expect(provider.deck.slides!.map(s => s.objectId)).toEqual(["s2", "s1", "s3"]);
    expect(await slides.apply(remove.actionId!)).toBeNull();
    expect(provider.deck.slides!.map(s => s.objectId)).toEqual(["s2", "s3"]);
  });

  it("reports a queued edit a collaborator's change broke, and fails it without writing", async () => {
    let provider = new SlidesProvider(deck()).install();
    let slides = gatekeeper();
    let { actionId } = await slides.edit([
      { slideId: "s2", elementId: "b2", find: "$10M", replace: "$12M" },
    ]);

    provider.edit(d => {
      d.slides![1].pageElements![1].shape!.text = text(["Revenue: $11M"]);
    });

    let [s2] = await slides.slides("s2");
    expect(shapeText(s2, "b2")).toBe("Revenue: $11M");
    expect(s2.queuedChangeConflict).toContain("does not contain the text to find");
    // Further changes to that slide would build on it; changes elsewhere still queue.
    let blocked = await slides.call("duplicateSlide", "s2");
    expect(blocked.error).toContain("until it is rejected");
    expect(blocked.actionId).toBeUndefined();
    expect((await slides.call("deleteSlide", "s3")).actionId).toEqual(expect.any(Number));
    expect(await slides.apply(actionId!)).toContain("This change no longer applies");
    expect(provider.batches).toEqual([]);
  });

  it("guards a whole-text replacement on the text it replaced", async () => {
    let provider = new SlidesProvider(deck()).install();
    let slides = gatekeeper();
    let { actionId, action } = await slides.edit([
      { slideId: "s1", elementId: "t1", replace: "Q4 review" },
    ]);
    expect(action?.fields).toEqual([
      { label: "Current text", kind: "text", value: "Q3 review" },
      { label: "New text", kind: "text", value: "Q4 review" },
    ]);

    provider.edit(d => {
      d.slides![0].pageElements![0].shape!.text = text(["Q3 review (draft)"]);
    });

    expect(await slides.apply(actionId!)).toContain("the text has changed since this edit was made");
    expect(provider.text("s1", "t1")).toBe("Q3 review (draft)\n");
  });

  it("plans again when the presentation changes between its read and its write", async () => {
    let provider = new SlidesProvider(deck()).install();
    let slides = gatekeeper();
    let { actionId } = await slides.edit([
      { slideId: "s2", elementId: "b2", find: "Margin: 20%", replace: "Margin: 25%" },
    ]);
    provider.beforeNextBatch = d => {
      d.slides![1].pageElements![1].shape!.text = text(["Revenue: $10M (est.)"], ["Margin: 20%"]);
    };

    expect(await slides.apply(actionId!)).toBeNull();

    expect(provider.batches.map(b => b.requiredRevisionId)).toEqual(["r1", "r2"]);
    expect(provider.text("s2", "b2")).toBe("Revenue: $10M (est.)\nMargin: 25%\n");
  });

  it("resends a write whose response was lost only as first sent, and finds it landed", async () => {
    let provider = new SlidesProvider(deck()).install();
    let slides = gatekeeper();
    let { actionId } = await slides.edit([
      { slideId: "s2", elementId: "b2", find: "$10M", replace: "$10M ($8M net)" },
    ]);
    provider.nextFailure = "lost";

    expect(await slides.apply(actionId!)).toBeNull();

    expect(provider.batches).toHaveLength(2);
    expect(provider.batches[1]).toEqual(provider.batches[0]);
    expect(provider.text("s2", "b2")).toBe("Revenue: $10M ($8M net)\nMargin: 20%\n");
    expect(await slides.apply(actionId!)).toBeNull();
    expect(provider.batches).toHaveLength(2);
  });

  it("records an unknown outcome when a lost write cannot be shown to have landed", async () => {
    let provider = new SlidesProvider(deck()).install();
    let slides = gatekeeper();
    let { actionId } = await slides.edit([
      { slideId: "s2", elementId: "b2", find: "$10M", replace: "$12M" },
    ]);
    dropNextWrite(provider);

    let error = await slides.apply(actionId!);

    expect(error).toContain("may or may not have taken effect");
    expect(provider.batches).toHaveLength(2);
    expect(await slides.apply(actionId!)).toBe(error);
    expect(provider.batches).toHaveLength(2);
    expect(await slides.reject(actionId!)).toBeNull();
  });

  // Text that ends as it began reads the same whether the batch landed or not.
  it("records an unknown outcome for a dropped batch whose edits undo each other", async () => {
    let provider = new SlidesProvider(deck()).install();
    let slides = gatekeeper();
    let { actionId } = await slides.edit([
      { slideId: "s1", elementId: "t1", find: "Q3", replace: "Q4" },
      { slideId: "s1", elementId: "t1", find: "Q4", replace: "Q3" },
    ]);
    dropNextWrite(provider);

    expect(await slides.apply(actionId!)).toContain("may or may not have taken effect");
  });

  it("follows an edited cell through the rows a lost batch then adds and deletes", async () => {
    let outcome = async (...lines: { op: string; at: number }[]) => {
      let provider = new SlidesProvider(deck()).install();
      let slides = gatekeeper();
      let { actionId } = await slides.queued("updateSlides", [
        { op: "editText", slideId: "s2", elementId: "tb2", cell: { row: 1, column: 0 }, replace: "APAC" },
        ...lines.map(line => ({ ...line, slideId: "s2", elementId: "tb2" })),
      ]);
      provider.nextFailure = "lost";
      return slides.apply(actionId!);
    };

    expect(await outcome({ op: "insertTableRows", at: 1 }, { op: "insertTableRows", at: 3 })).toBeNull();
    expect(await outcome({ op: "deleteTableRows", at: 0 })).toBeNull();
    // Deleting its row deletes the text's evidence, but not the table's size.
    expect(await outcome({ op: "deleteTableRows", at: 1 })).toBeNull();
  });

  // The edited cell moves down a row, so the text its old place shows proves nothing.
  it("records an unknown outcome for a dropped batch that edits a cell, then adds a row above it", async () => {
    let provider = new SlidesProvider(deck()).install();
    let slides = gatekeeper();
    let { actionId } = await slides.queued("updateSlides", [
      { op: "editText", slideId: "s2", elementId: "tb2", cell: { row: 1, column: 0 }, replace: "APAC" },
      { op: "insertTableRows", slideId: "s2", elementId: "tb2", at: 1 },
    ]);
    // The new row would leave "" where "EMEA" was, as the collaborator does.
    dropNextWrite(provider, d => {
      d.slides![1].pageElements![2] = table("tb2", [["Region", "Sales"], ["", "4"]]);
    });

    expect(await slides.apply(actionId!)).toContain("may or may not have taken effect");
  });

  // The cell moves down onto one that already reads as the edit leaves it.
  it("records an unknown outcome for a dropped batch whose moved cell lands on text it matches", async () => {
    let provider = new SlidesProvider(deck()).install();
    let slides = gatekeeper();
    let { actionId } = await slides.queued("updateSlides", [
      { op: "editText", slideId: "s2", elementId: "tb2", cell: { row: 0, column: 0 }, replace: "EMEA" },
      { op: "insertTableRows", slideId: "s2", elementId: "tb2", at: 0 },
    ]);
    dropNextWrite(provider);

    expect(await slides.apply(actionId!)).toContain("may or may not have taken effect");
  });

  it("finds a lost batch landed by the cells of a table it only adds rows to", async () => {
    let provider = new SlidesProvider(deck()).install();
    let slides = gatekeeper();
    let { actionId } = await slides.queued("updateSlides", [
      { op: "insertTableRows", slideId: "s2", elementId: "tb2", at: 2 },
    ]);
    provider.nextFailure = "lost";

    expect(await slides.apply(actionId!)).toBeNull();
  });

  // A collaborator's change matches part of the batch, but not the table it would leave.
  it.each([
    {
      name: "types the edit's text where the new row would move it",
      changes: [
        { op: "editText", slideId: "s2", elementId: "tb2", cell: { row: 0, column: 0 }, replace: "Area" },
        { op: "insertTableRows", slideId: "s2", elementId: "tb2", at: 0 },
      ],
      collaborated: [["Region", "Sales"], ["Area", "4"]],
    },
    {
      name: "deletes a different row",
      changes: [{ op: "deleteTableRows", slideId: "s2", elementId: "tb2", at: 0 }],
      collaborated: [["Region", "Sales"]],
    },
  ])("records an unknown outcome for a dropped batch when a collaborator $name", async ({ changes, collaborated }) => {
    let provider = new SlidesProvider(deck()).install();
    let slides = gatekeeper();
    let { actionId } = await slides.queued("updateSlides", changes);
    dropNextWrite(provider, d => {
      d.slides![1].pageElements![2] = table("tb2", collaborated);
    });

    expect(await slides.apply(actionId!)).toContain("may or may not have taken effect");
  });

  // The collaborator's 3 × 3 table, each row's first cell spanning two columns, holds the same
  // text row by row as the 3 × 2 table the batch plans; only their sizes and spans tell them apart.
  it("records an unknown outcome for a dropped row insertion when a collaborator merges cells instead", async () => {
    let provider = new SlidesProvider(deck()).install();
    let slides = gatekeeper();
    let { actionId } = await slides.queued("updateSlides", [
      { op: "insertTableRows", slideId: "s2", elementId: "tb2", at: 2 },
    ]);
    dropNextWrite(provider, d => {
      let merged = table("tb2", [["Region", "Sales"], ["EMEA", "4"], ["", ""]]);
      merged.table!.columns = 3;
      for (let row of merged.table!.tableRows!) {
        row.tableCells![0].columnSpan = 2;
        row.tableCells![1].location!.columnIndex = 2;
      }
      d.slides![1].pageElements![2] = merged;
    });

    expect(await slides.apply(actionId!)).toContain("may or may not have taken effect");
  });

  it("asks for a restart only when rejecting a change that later ones were built on", async () => {
    new SlidesProvider(deck()).install();
    let slides = gatekeeper();
    let first = await slides.edit([{ slideId: "s1", elementId: "t1", find: "Q3", replace: "Q4" }]);
    let second = await slides.queued("deleteSlide", "s3");

    expect(await slides.reject(first.actionId!)).toEqual({ restart: true });
    expect(await slides.reject(second.actionId!)).toBeNull();
    expect(await slides.autoApprovable()).toEqual([
      { tag: "editSlidesText", label: "Slide text edits" },
      { tag: "formatSlides", label: "Slide formatting and layout" },
    ]);
  });

  it("does not show a change twice to a read made while it is being written", async () => {
    new SlidesProvider(deck()).install();
    let slides = gatekeeper();
    let { actionId } = await slides.edit([
      { slideId: "s2", elementId: "b2", find: "Revenue", replace: "Revenue (USD)" },
    ]);
    let read = duringFirstWrite(entered => slides.slidesEntered(entered, "s2"));

    expect(await slides.apply(actionId!)).toBeNull();

    expect(shapeText((await read())[0], "b2")).toBe("Revenue (USD): $10M\nMargin: 20%");
  });

  it("lets reads overlap one another", async () => {
    new SlidesProvider(deck()).install();
    let slides = gatekeeper();
    let fetch = globalThis.fetch;
    let outlines = 0;
    let both = Promise.withResolvers<void>();
    vi.stubGlobal("fetch", async (input: RequestInfo, init?: RequestInit) => {
      // Each read's outline is answered only once both reads have asked for theirs.
      if (new URL(String(input)).pathname === "/v1/presentations/deck-1" && ++outlines <= 2) {
        if (outlines === 2) both.resolve();
        await both.promise;
      }
      return fetch(input, init);
    });

    let read = await Promise.all([slides.slides("s1"), slides.slides("s3")]);

    expect(read.map(([slide]) => slide.id)).toEqual(["s1", "s3"]);
  });

  it("applies a change approved while the one before it is being written, after it", async () => {
    let provider = new SlidesProvider(deck()).install();
    let slides = gatekeeper();
    let first = await slides.edit([{ slideId: "s1", elementId: "t1", find: "Q3", replace: "Q4" }]);
    let second = await slides.queued("deleteSlide", "s3");
    let applySecond = duringFirstWrite(entered => slides.apply(second.actionId!, entered));

    expect(await slides.apply(first.actionId!)).toBeNull();
    expect(await applySecond()).toBeNull();

    expect(provider.text("s1", "t1")).toBe("Q4 review\n");
    expect(provider.deck.slides!.map(s => s.objectId)).toEqual(["s1", "s2"]);
  });

  it("shows a batch in the outline only if all of it applies, tables included", async () => {
    let provider = new SlidesProvider(deck()).install();
    let slides = gatekeeper();
    await slides.edit([
      { slideId: "s2", elementId: "t2", find: "Revenue", replace: "Sales" },
      { slideId: "s2", elementId: "tb2", cell: { row: 1, column: 0 }, find: "EMEA", replace: "APAC" },
    ]);
    expect((await slides.outline()).slides[1].title).toBe("Sales");

    provider.edit(d => {
      d.slides![1].pageElements![2] = table("tb2", [["Region", "Sales"], ["LATAM", "4"]]);
    });

    let outline = await slides.outline();
    expect(outline.slides[1].title).toBe("Revenue");
    expect(outline.queuedChangeConflict).toContain("does not contain the text to find");
  });

  it("does not replay a change whose activation died applying it", async () => {
    let provider = new SlidesProvider(deck()).install();
    let slides = gatekeeper();
    let { actionId } = await slides.edit([
      { slideId: "s2", elementId: "b2", find: "Revenue", replace: "Revenue (USD)" },
    ]);
    // Google committed it, but the activation died before the journal heard back.
    provider.edit(d => {
      d.slides![1].pageElements![1].shape!.text = text(["Revenue (USD): $10M"], ["Margin: 20%"]);
    });
    await slides.orphan(actionId!);

    expect(shapeText((await slides.slides("s2"))[0], "b2")).toBe("Revenue (USD): $10M\nMargin: 20%");
  });

  it("refuses to queue a change the account cannot make, but still reads", async () => {
    let provider = new SlidesProvider(deck()).install();
    provider.editable = false;
    let slides = gatekeeper();

    let refused = await slides.call("deleteSlide", "s3");

    expect(refused.error).toContain("can view \"Quarterly review\" but not edit it");
    expect(refused.actionId).toBeUndefined();
    expect((await slides.outline()).slides.map(s => s.id)).toEqual(["s1", "s2", "s3"]);
  });
});

describe("Google Slides design changes", () => {
  const BADGE = {
    op: "createShape", slideId: "s2", ref: "badge", shapeType: "ROUND_RECTANGLE",
    bounds: { x: 10, y: 20, width: 100, height: 40 }, text: "New", fill: "ACCENT1",
  };

  it("queues a batch as one approval, shows it in reads, and writes it as one revision-pinned batch", async () => {
    let provider = new SlidesProvider(deck()).install();
    let slides = gatekeeper();

    let { actionId, action, value } = await slides.queued("updateSlides", [
      BADGE,
      { op: "formatText", slideId: "s2", elementId: "badge", format: { bold: true } },
      { op: "deleteElement", slideId: "s2", elementId: "b2" },
    ]);
    let { badge } = value as Record<string, string>;

    expect(action).toMatchObject({
      title: "Change slide 2 (\"Revenue\")",
      autoApprovable: false,
      descriptionIsComplete: true,
      fields: [{ label: "Change 1: Text", kind: "text", value: "New" }],
    });
    expect(action!.description).toContain(
      "2. On slide 2 (\"Revenue\"), format all of the text of the shape change 1 adds: bold");
    let [s2] = await slides.slides("s2");
    expect(s2.elements.map(e => e.id)).toEqual(["t2", "tb2", badge]);
    expect(s2.elements[2]).toMatchObject({ text: "New", formats: [{ start: 0, end: 3, bold: true }], fill: "ACCENT1" });
    expect(provider.batches).toEqual([]);

    expect(await slides.apply(actionId!)).toBeNull();

    expect(provider.batches).toHaveLength(1);
    expect(provider.batches[0].requiredRevisionId).toBe("r1");
    expect(provider.slide("s2").pageElements!.map(e => e.objectId)).toEqual(["t2", "tb2", badge]);
    expect(provider.text("s2", badge)).toBe("New\n");
  });

  it("shows a font name in full, since any string is sent and kept", async () => {
    new SlidesProvider(deck()).install();
    let font = `${"Workspace data ".repeat(5)}*not* [shown] in prose`;
    let { action } = await gatekeeper().queued("updateSlides", [
      { op: "formatText", slideId: "s2", elementId: "t2", format: { fontFamily: font } },
    ]);

    expect(action).toMatchObject({ descriptionIsComplete: true, fields: [{ label: "Font", value: font }] });
    expect(action!.description).toContain("the font below");
  });

  it("finds a batch whose response was lost landed by the element it created", async () => {
    let provider = new SlidesProvider(deck()).install();
    let slides = gatekeeper();
    let { actionId, value } = await slides.queued("updateSlides", [BADGE]);
    provider.nextFailure = "lost";

    expect(await slides.apply(actionId!)).toBeNull();

    // The resend at the first revision was refused, and a read found the shape.
    expect(provider.batches).toHaveLength(2);
    expect(provider.text("s2", (value as Record<string, string>).badge)).toBe("New\n");
  });

  it("finds a lost batch landed when it deleted an element it created, and its edits", async () => {
    let provider = new SlidesProvider(deck()).install();
    let slides = gatekeeper();
    let { actionId } = await slides.queued("updateSlides", [
      BADGE,
      { op: "editText", slideId: "s2", elementId: "badge", replace: "Old" },
      { op: "deleteElement", slideId: "s2", elementId: "badge" },
      { op: "editText", slideId: "s2", elementId: "t2", replace: "Sales" },
    ]);
    provider.nextFailure = "lost";

    expect(await slides.apply(actionId!)).toBeNull();

    expect(provider.batches).toHaveLength(2);
    expect(provider.text("s2", "t2")).toBe("Sales\n");
  });

  it("lets a batch apply without asking only when it only edits text, or only formats", async () => {
    new SlidesProvider(deck()).install();
    let slides = gatekeeper();
    let kindOf = async (...changes: object[]) => {
      let { action } = await slides.queued("updateSlides", changes);
      return action!.autoApprovable ? action!.actionKind!.tag : "manual";
    };
    let format = (fields: object) => ({ op: "formatText", slideId: "s1", elementId: "t1", format: fields });

    expect(await kindOf(format({ bold: true }), { op: "arrange", slideId: "s1", elementId: "t1", to: "front" }))
      .toBe("formatSlides");
    // Google keeps a font's or link's whole string, so either needs approval.
    expect(await kindOf(format({ fontFamily: "Georgia" }))).toBe("manual");
    expect(await kindOf(format({ link: "https://example.com/" }))).toBe("manual");
    expect(await kindOf(format({ italic: true }), { op: "editText", slideId: "s1", elementId: "t1", find: "Q3", replace: "Q4" }))
      .toBe("manual");
    expect(await kindOf({ op: "setAltText", slideId: "s1", elementId: "t1", title: "Title" })).toBe("manual");
  });

  // Neither the created-then-deleted element nor the formatting differs between a batch that
  // landed and one that did not, so neither may count as having landed.
  it("records an unknown outcome for a dropped batch that leaves no trace", async () => {
    let provider = new SlidesProvider(deck()).install();
    let slides = gatekeeper();
    let { actionId } = await slides.queued("updateSlides", [
      BADGE,
      { op: "deleteElement", slideId: "s2", elementId: "badge" },
      { op: "formatText", slideId: "s2", elementId: "t2", format: { bold: true } },
    ]);
    dropNextWrite(provider);

    expect(await slides.apply(actionId!)).toContain("may or may not have taken effect");
    expect(provider.batches).toHaveLength(2);
  });

  it("refuses a ref that is also an element's ID, queuing nothing", async () => {
    new SlidesProvider(deck()).install();
    let slides = gatekeeper();
    let outcome = await slides.call("updateSlides", [{ ...BADGE, ref: "b2" }]);
    expect(outcome.error).toContain('The ref "b2" is also an element\'s ID');
    expect(outcome.actionId).toBeUndefined();
  });
});
