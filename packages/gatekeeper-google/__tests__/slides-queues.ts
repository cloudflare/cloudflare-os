/**
 * Queues of Slides changes for tests of the replay: a deck that holds something for every design
 * operation to act on, queues drawn from a seed, queues written by hand for what a draw may miss,
 * and a count of what a set of queues reached.
 *
 * What the queues are for is a page that a later batch writes after an earlier batch of the same
 * queue wrote it. So a drawn batch mostly returns to a page, and to an element, that an earlier
 * batch of its queue edited or created, and each written queue runs one operation in three
 * batches on one page.
 */

import type { RestPageElement } from "../src/slides-api";
import { pageOf, type DesignChange } from "../src/slides-design";
import { themePagesOf } from "../src/slides-model";
import {
  isDesignBatch, type CreatedPlaceholder, type Deck, type QueuedChange, type SlidesAction,
} from "../src/slides-simulation";
import { seeded } from "./doc-fixture";
import {
  layout, master, shape as shapeElement, slide as slidePage, text as textOf,
} from "./slides-fixture";

const EMU = 12_700;

// `fields` as an element `width` by `height` points with its corner at (`x`, `y`).
function placedAt(
  id: string, x: number, y: number, width: number, height: number, fields: Partial<RestPageElement>,
): RestPageElement {
  return {
    objectId: id,
    size: { width: { magnitude: width * EMU, unit: "EMU" }, height: { magnitude: height * EMU, unit: "EMU" } },
    transform: { scaleX: 1, scaleY: 1, translateX: x * EMU, translateY: y * EMU, unit: "EMU" },
    ...fields,
  };
}

// A table of `cells`, one string a cell, each 100 points by 30, which a table's position is read
// from; `merged` makes one cell span the columns after it.
function table(
  cells: (string | { slideNumber: string })[][],
  merged?: { row: number; column: number; columnSpan: number },
): NonNullable<RestPageElement["table"]> {
  return {
    rows: cells.length,
    columns: cells[0].length,
    tableColumns: cells[0].map(() => ({ columnWidth: { magnitude: 100 * EMU, unit: "EMU" } })),
    tableRows: cells.map((line, rowIndex) => ({
      rowHeight: { magnitude: 30 * EMU, unit: "EMU" },
      tableCells: line.flatMap((cell, columnIndex) => {
        let inSpan = merged && rowIndex === merged.row && columnIndex >= merged.column &&
          columnIndex < merged.column + merged.columnSpan;
        if (inSpan && columnIndex > merged!.column) return [];
        return [{
          location: { rowIndex, columnIndex },
          text: textOf([cell]),
          ...(inSpan ? { columnSpan: merged!.columnSpan } : {}),
        }];
      }),
    })),
  };
}

/** The layout `queueDeck()` holds, whose two placeholders a new slide maps. */
export const QUEUE_LAYOUT = "layout-1";

/** The master `queueDeck()` holds. */
export const QUEUE_MASTER = "master-1";

/**
 * A deck of three slides, a layout and a master, with something for every design operation: slide
 * `s1` holds text, a filled shape, an image, a connected line, a table with a merged pair of
 * cells, and its slide number in a shape, in a table cell and in a group; `s2` a text box and a
 * table; `s3` nothing.
 */
export function queueDeck(): Deck {
  let number = { slideNumber: "1" };
  let s1 = slidePage("s1", [
    placedAt("title", 20, 10, 300, 40, shapeElement("title", textOf(["Plan"]), { placeholder: "TITLE" })),
    placedAt("body", 20, 60, 300, 120,
      shapeElement("body", textOf(["First point"], ["Second point"], ["Third point"]), { placeholder: "BODY" })),
    placedAt("filled", 340, 10, 80, 60, {
      shape: {
        shapeType: "RECTANGLE",
        shapeProperties: {
          shapeBackgroundFill: { solidFill: { color: { rgbColor: { red: 1 } }, alpha: 1 } },
          outline: { weight: { magnitude: 9525, unit: "EMU" }, dashStyle: "SOLID" },
        },
      },
    }),
    placedAt("image", 340, 80, 80, 60, { image: { sourceUrl: "https://img.example/first.png" } }),
    placedAt("anchor", 440, 10, 40, 40, shapeElement("anchor", textOf(["Anchor"]), { shapeType: "ELLIPSE" })),
    placedAt("line", 440, 60, 40, 40, {
      line: {
        lineCategory: "STRAIGHT",
        lineProperties: {
          startConnection: { connectedObjectId: "anchor", connectionSiteIndex: 1 },
          endConnection: { connectedObjectId: "filled", connectionSiteIndex: 3 },
        },
      },
    }),
    placedAt("grid", 20, 200, 300, 90, {
      table: table(
        [["Name", "Score", number], ["Ada", "", "9"], ["Total", "", "9"]],
        { row: 2, column: 0, columnSpan: 2 }),
    }),
    placedAt("number", 440, 250, 40, 20, shapeElement("number", textOf(["Slide ", number]))),
    placedAt("group", 340, 160, 140, 60, {
      elementGroup: {
        children: [
          placedAt("group-number", 0, 0, 40, 20, shapeElement("group-number", textOf([number]))),
          placedAt("group-label", 50, 0, 40, 20, shapeElement("group-label", textOf(["Label"]))),
          placedAt("group-mark", 100, 0, 40, 20, { shape: { shapeType: "RECTANGLE" } }),
        ],
      },
    }),
  ], { layoutObjectId: QUEUE_LAYOUT, notes: textOf(["Speak slowly"]) });
  let s2 = slidePage("s2", [
    placedAt("box", 20, 20, 200, 60, shapeElement("box", textOf(["Second slide"]))),
    placedAt("grid-2", 20, 100, 200, 60, { table: table([["A", "B"], ["C", "D"]]) }),
  ], { layoutObjectId: QUEUE_LAYOUT });
  let s3 = slidePage("s3", [], { layoutObjectId: QUEUE_LAYOUT });
  let pages = [s1, s2, s3];
  return {
    order: pages.map(page => page.objectId!),
    slides: new Map(pages.map(page => [page.objectId!, page])),
    masters: new Map([...pages.map(page => page.objectId!), QUEUE_LAYOUT].map(id => [id, QUEUE_MASTER])),
    firstMaster: QUEUE_MASTER,
    themePages: themePagesOf({
      presentationId: "deck-1",
      masters: [master(QUEUE_MASTER)],
      layouts: [layout(QUEUE_LAYOUT, "Title and body", {
        pageElements: [
          placedAt("layout-title", 20, 10, 300, 40, { shape: { placeholder: { type: "TITLE" } } }),
          placedAt("layout-body", 20, 60, 300, 120, { shape: { placeholder: { type: "BODY" } } }),
        ],
      })],
    }),
  };
}

/** A design batch of `changes`, queued as the kind that takes any of them. */
export function batch(...changes: DesignChange[]): SlidesAction {
  return { kind: "editSlides", payload: { changes, slides: {} } };
}

/** `actions` as a queue, numbered from 1 in order. */
export function queued(actions: SlidesAction[]): QueuedChange[] {
  return actions.map((action, i) => ({ id: i + 1, action }));
}

/**
 * A queued new slide named `newSlideId` from the deck's layout, whose title is `${newSlideId}-title`
 * and body `${newSlideId}-body`, each carrying a size and a transform of the record's own.
 */
export function newSlide(newSlideId: string, after?: string | null): SlidesAction {
  let placeholder = (name: string, type: string, y: number, height: number): CreatedPlaceholder => ({
    objectId: `${newSlideId}-${name}`, type, index: 0, parentObjectId: `layout-${name}`,
    shapeType: "RECTANGLE",
    size: { width: { magnitude: 300 * EMU, unit: "EMU" }, height: { magnitude: height * EMU, unit: "EMU" } },
    transform: { scaleX: 1, scaleY: 1, translateX: 20 * EMU, translateY: y * EMU, unit: "EMU" },
  });
  return {
    kind: "createSlide",
    payload: {
      newSlideId, layoutId: QUEUE_LAYOUT, layout: "Title and body",
      ...(after === undefined ? {} : { after }),
      placeholders: [placeholder("title", "TITLE", 10, 40), placeholder("body", "BODY", 60, 120)],
    },
  };
}

/**
 * A queued copy of slide `s1` of `queueDeck()` as `newSlideId`, each element `id` copied as
 * `${newSlideId}-${id}`. The shape its line starts from is left out, as one added to the slide
 * after the copy was queued is, so the copied line holds a `connectedObjectId` of `undefined`.
 */
export function copyOfFirst(newSlideId: string): SlidesAction {
  let ids = [
    "title", "body", "filled", "image", "line", "grid", "number", "group", "group-number",
    "group-label", "group-mark",
  ];
  return {
    kind: "duplicateSlide",
    payload: {
      slideId: "s1", newSlideId, slide: { number: 1 },
      objectIds: Object.fromEntries(ids.map(id => [id, `${newSlideId}-${id}`])),
    },
  };
}

const BOUNDS = { x: 30, y: 40, width: 120, height: 50 };

/** What the names of the three queues that stop after an earlier batch made their element start with. */
export const FAILS_ON_MADE = "a batch that stops after an earlier batch made its element, at change";

/**
 * Queues written by hand: for each design operation, three batches on one page, the first making
 * what the operation needs and the next two running it; the same for a background on a layout and
 * a master and for theme colours; a batch that stops at each of its three changes after an earlier
 * batch made the element it writes; batches on a queued new slide, and on one that takes a deleted
 * slide's ID; and batches on a queued copy around a move that renumbers it.
 */
export function directedQueues(): { name: string; queue: QueuedChange[] }[] {
  let slideId = "s1";
  let on = { slideId, elementId: "made" };
  let shapeMade: DesignChange = {
    op: "createShape", slideId, id: "made", shapeType: "RECTANGLE", bounds: BOUNDS,
    text: "Alpha beta\nGamma delta\nEpsilon", format: { bold: true, color: "#336699" },
    fill: "#ffeecc", outline: { color: "ACCENT1", weight: 2 },
  };
  let tableMade: DesignChange = {
    op: "createTable", slideId, id: "made", rows: 4, columns: 3, bounds: { ...BOUNDS, height: 80 },
    cells: [["a", "b", "c"], ["d", "", "f"]],
  };
  let imageMade: DesignChange = {
    op: "insertImage", slideId, id: "made", url: "https://img.example/made.png", bounds: BOUNDS,
  };
  let threeBatches: [string, DesignChange, DesignChange, DesignChange][] = [
    ["editText", shapeMade,
      { op: "editText", ...on, find: "Alpha", replace: "Omega" },
      { op: "editText", ...on, replace: "One\n\tTwo" }],
    ["formatText", shapeMade,
      { op: "formatText", ...on, find: "beta", format: { italic: true, link: "https://example.com/a" } },
      { op: "formatText", ...on, range: { start: 0, end: 8 }, format: { bold: null, fontSize: 18 } }],
    ["formatParagraphs", shapeMade,
      { op: "formatParagraphs", ...on, alignment: "center", lineSpacing: 150 },
      { op: "formatParagraphs", ...on, find: "Alpha", bullets: "numbered", spaceAbove: 6 }],
    ["createShape", shapeMade,
      { op: "createShape", slideId, id: "made-2", shapeType: "TEXT_BOX", bounds: BOUNDS, text: "Two" },
      { op: "createShape", slideId, id: "made-3", shapeType: "ELLIPSE", bounds: { ...BOUNDS, x: 200 }, fill: "none" }],
    ["updateShape", shapeMade,
      { op: "updateShape", ...on, fill: "ACCENT2", contentAlignment: "middle" },
      { op: "updateShape", ...on, fill: "none", outline: "none" }],
    ["setBounds", shapeMade,
      { op: "setBounds", ...on, bounds: { x: 5, y: 6 } },
      { op: "setBounds", ...on, bounds: { width: 60, height: 20 }, rotation: 30 }],
    ["deleteElement", shapeMade,
      { op: "deleteElement", ...on },
      { op: "deleteElement", slideId, elementId: "image" }],
    ["setAltText", shapeMade,
      { op: "setAltText", ...on, title: "A box" },
      { op: "setAltText", ...on, title: "The box", description: "It holds three lines" }],
    ["arrange", shapeMade,
      { op: "arrange", ...on, to: "back" },
      { op: "arrange", ...on, to: "front" }],
    ["insertImage", imageMade,
      { op: "insertImage", slideId, id: "made-2", url: "https://img.example/two.png" },
      { op: "insertImage", slideId, id: "made-3", url: "https://img.example/three.png", bounds: BOUNDS }],
    ["replaceImage", imageMade,
      { op: "replaceImage", ...on, url: "https://img.example/other.png" },
      { op: "replaceImage", ...on, url: "https://img.example/last.png" }],
    ["createTable", tableMade,
      { op: "createTable", slideId, id: "made-2", rows: 2, columns: 2, cells: [["x"]] },
      { op: "createTable", slideId, id: "made-3", rows: 1, columns: 4, bounds: BOUNDS }],
    ["insertTableRows", tableMade,
      { op: "insertTableRows", ...on, at: 1 },
      { op: "insertTableRows", ...on, at: 5, count: 2 }],
    ["insertTableColumns", tableMade,
      { op: "insertTableColumns", ...on, at: 3 },
      { op: "insertTableColumns", ...on, at: 0, count: 2 }],
    ["deleteTableRows", tableMade,
      { op: "deleteTableRows", ...on, at: 1, count: 2 },
      { op: "deleteTableRows", ...on, at: 0 }],
    ["deleteTableColumns", tableMade,
      { op: "deleteTableColumns", ...on, at: 0 },
      { op: "deleteTableColumns", ...on, at: 1 }],
    ["formatTableCells", tableMade,
      { op: "formatTableCells", ...on, fill: "ACCENT3" },
      { op: "formatTableCells", ...on, range: { row: 1, column: 1, rowSpan: 2 }, fill: "none", contentAlignment: "bottom" }],
    ["setBackground on a slide",
      { op: "setBackground", slideId, background: "#112233" },
      { op: "setBackground", slideId, background: { imageUrl: "https://img.example/back.png" } },
      { op: "setBackground", slideId, background: null }],
    ["setBackground on a layout",
      { op: "setBackground", layoutId: QUEUE_LAYOUT, background: "ACCENT4" },
      { op: "setBackground", layoutId: QUEUE_LAYOUT, background: "none" },
      { op: "setBackground", layoutId: QUEUE_LAYOUT, background: "#445566" }],
    ["setBackground on a master",
      { op: "setBackground", masterId: QUEUE_MASTER, background: "#778899" },
      { op: "setBackground", masterId: QUEUE_MASTER, background: { imageUrl: "https://img.example/m.png" } },
      { op: "setBackground", masterId: QUEUE_MASTER, background: "LIGHT2" }],
    ["setThemeColors",
      { op: "setThemeColors", masterId: QUEUE_MASTER, colors: { ACCENT1: "#010203" } },
      { op: "setThemeColors", masterId: QUEUE_MASTER, colors: { ACCENT1: "#040506", DARK1: "#111111" } },
      { op: "setThemeColors", masterId: QUEUE_MASTER, colors: { HYPERLINK: "#0000ee" } }],
  ];
  let queues = threeBatches.map(([name, first, second, third]) => ({
    name: `${name}, in three batches on one page`,
    queue: queued([
      batch(first), batch(second),
      // The table lines left after two deletions, and the master whose colours were set, take
      // another operation.
      name.startsWith("deleteTable") ? batch(third, { op: "formatTableCells", ...on, fill: "#abcdef" })
        : name === "setThemeColors"
          ? batch(third, { op: "setBackground", masterId: QUEUE_MASTER, background: "ACCENT1" })
          : batch(third),
    ]),
  }));
  let writes: DesignChange[] = [
    { op: "updateShape", ...on, fill: "#00ff00" },
    { op: "setBounds", ...on, bounds: { x: 90 } },
    { op: "formatText", ...on, find: "Gamma", format: { underline: true } },
  ];
  for (let index of [0, 1, 2]) {
    queues.push({
      name: `${FAILS_ON_MADE} ${index + 1} of 3`,
      queue: queued([
        batch(shapeMade),
        batch(...writes.map((change, i) => i === index ? { ...change, elementId: "missing" } : change)),
      ]),
    });
  }
  queues.push({
    name: "a batch that stops on a layout the deck has not, after two backgrounds of its layout",
    queue: queued([
      batch({ op: "setBackground", layoutId: QUEUE_LAYOUT, background: "#123123" }),
      batch(
        { op: "setBackground", layoutId: QUEUE_LAYOUT, background: "#321321" },
        { op: "setBackground", layoutId: "layout-gone", background: "none" }),
    ]),
  }, {
    name: "a new slide, then two batches on a placeholder that holds its record's size and transform",
    queue: queued([
      newSlide("fresh", "s1"),
      batch({ op: "setBounds", slideId: "fresh", elementId: "fresh-title", bounds: { x: 44, width: 200 } }),
      batch(
        { op: "editText", slideId: "fresh", elementId: "fresh-title", replace: "A fresh title" },
        { op: "setBounds", slideId: "fresh", elementId: "fresh-body", bounds: { y: 90 } }),
    ]),
  }, {
    name: "a new slide under the ID of a deleted slide that a batch had edited, then a batch on it",
    queue: queued([
      batch({ op: "setBackground", slideId: "s3", background: "#010101" }),
      { kind: "deleteSlide", payload: { slideId: "s3", slide: { number: 3 } } },
      newSlide("s3"),
      batch({ op: "setBounds", slideId: "s3", elementId: "s3-title", bounds: { x: 44 } }),
    ]),
  }, {
    name: "a copy, a batch on it, a move that renumbers it, and a second batch on it",
    queue: queued([
      copyOfFirst("copy"),
      batch(
        { op: "editText", slideId: "copy", elementId: "copy-title", replace: "The copy" },
        { op: "updateShape", slideId: "copy", elementId: "copy-filled", fill: "ACCENT5" }),
      { kind: "moveSlides", payload: { slideIds: ["copy"], after: "s3", slides: [] } },
      batch(
        { op: "formatText", slideId: "copy", elementId: "copy-title", find: "copy", format: { bold: true } },
        { op: "setBounds", slideId: "copy", elementId: "copy-line", bounds: { x: 12 } }),
    ]),
  });
  return queues;
}

/**
 * What a count of `coverageOf` is kept under: an operation's name, and for a background also the
 * kind of page it was set on.
 */
export const COVERED: readonly string[] = [
  "editText", "formatText", "formatParagraphs", "createShape", "updateShape", "setBounds",
  "deleteElement", "setAltText", "arrange", "insertImage", "replaceImage", "createTable",
  "insertTableRows", "insertTableColumns", "deleteTableRows", "deleteTableColumns",
  "formatTableCells", "setBackground", "setThemeColors",
  "setBackground SLIDE", "setBackground LAYOUT", "setBackground MASTER",
];

/**
 * Adds to `counts`, for the first `applied` changes of `queue`, how many times each operation ran
 * in a batch on a page that an earlier batch of the queue edited: under each name of `COVERED`.
 */
export function coverageOf(
  queue: readonly QueuedChange[], applied: number, counts = new Map<string, number>(),
): Map<string, number> {
  let edited = new Set<string>();
  for (let { action } of queue.slice(0, applied)) {
    if (!isDesignBatch(action)) continue;
    let pages = action.payload.changes.map(change => ({ op: change.op, ...pageOf(change) }));
    for (let { op, id, pageType } of pages) {
      if (!edited.has(id)) continue;
      let names = op === "setBackground" ? [op, `${op} ${pageType}`] : [op];
      for (let name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    for (let { id } of pages) edited.add(id);
  }
  return counts;
}

// Every object reachable from `value`, itself included.
function objectsUnder(value: unknown, into = new Set<object>()): Set<object> {
  if (typeof value !== "object" || value === null || into.has(value)) return into;
  into.add(value);
  for (let part of Object.values(value)) objectsUnder(part, into);
  return into;
}

/**
 * The pages of `deck` that a design batch among the first `applied` changes of `queue` edited and
 * that hold an object of a queued record, which a later batch of a fold would write.
 */
export function pagesHoldingRecords(queue: readonly QueuedChange[], applied: number, deck: Deck): string[] {
  let records = objectsUnder(queue);
  let edited = new Set(queue.slice(0, applied).flatMap(({ action }) =>
    isDesignBatch(action) ? action.payload.changes.map(change => pageOf(change).id) : []));
  return [...edited].filter(id =>
    [...objectsUnder(deck.slides.get(id) ?? deck.themePages.get(id))].some(object => records.has(object)));
}

/** The names of `COVERED` that `counts` holds no run of. */
export function uncovered(counts: ReadonlyMap<string, number>): string[] {
  return COVERED.filter(name => !counts.get(name));
}

// What the generator remembers of an element: enough to draw a change that is likely to apply.
type Shadow = {
  id: string;
  kind: "shape" | "image" | "table" | "line" | "group";
  /** A shape's text, where the generator knows it. */
  text?: string;
  rows?: number;
  columns?: number;
  /** Whether a table holds a merged cell, beside which Google's rules for its lines are not replayed. */
  merged?: boolean;
  /** The group it is a child of. */
  group?: string;
  /** Whether it has a size and a transform, which moving it needs. */
  placed: boolean;
  /** The batch of the queue that created it. */
  madeIn?: number;
};

type ShadowSlide = { id: string; notes: boolean; elements: Shadow[] };

function isShape(element: Shadow): boolean {
  return element.kind === "shape";
}

function isTable(element: Shadow): boolean {
  return element.kind === "table";
}

function topLevel(element: Shadow): boolean {
  return !element.group;
}

// A shape of `queueDeck()` as the generator remembers it, with its text where that is known.
function shape(id: string, known?: string, group?: string): Shadow {
  return { id, kind: "shape", placed: true, ...(known === undefined ? {} : { text: known }), ...(group ? { group } : {}) };
}

// What the generator remembers of `queueDeck()`.
function shadowDeck(): ShadowSlide[] {
  return [
    {
      id: "s1", notes: true, elements: [
        shape("title", "Plan"), shape("body", "First point\nSecond point\nThird point"), shape("filled", ""),
        { id: "image", kind: "image", placed: true }, shape("anchor", "Anchor"),
        { id: "line", kind: "line", placed: true },
        { id: "grid", kind: "table", rows: 3, columns: 3, merged: true, placed: true }, shape("number"),
        { id: "group", kind: "group", placed: true }, shape("group-number", undefined, "group"),
        shape("group-label", "Label", "group"), shape("group-mark", "", "group"),
      ],
    },
    {
      id: "s2", notes: true, elements: [
        shape("box", "Second slide"), { id: "grid-2", kind: "table", rows: 2, columns: 2, placed: true },
      ],
    },
    { id: "s3", notes: true, elements: [] },
  ];
}

const OPS = COVERED.slice(0, 19) as DesignChange["op"][];
const COLORS = ["#102030", "#a0b0c0", "ACCENT1", "ACCENT5", "DARK2", "#ffffff"];
const BATCH_KINDS = ["editText", "formatSlides", "editSlides", "deleteSlideContent", "updateSlides"] as const;

/**
 * A queue of 4 to 10 changes drawn from `seed`, for `queueDeck()`: six in ten a design batch of 1
 * to 4 changes, each of an operation drawn evenly, the rest a copy, a deletion, a move, a new
 * slide or a skip. A batch returns, three times in four, to a page an earlier batch of the queue
 * edited, and half the time to an element one created. One queued change in eight is made to
 * conflict. The generator follows what its changes make only roughly, so a queue may stop sooner.
 */
export function generatedQueue(seed: number): QueuedChange[] {
  let next = seeded(seed);
  let below = (count: number) => Math.floor(next() * count);
  let chance = (odds: number) => next() < odds;
  let oneOf = <T>(items: readonly T[]): T => items[below(items.length)];
  let minted = 0;
  let mint = (name: string) => `${name}-${seed}-${++minted}`;
  let word = () => `word${++minted}`;
  let phrase = () => Array.from({ length: 1 + below(3) }, word).join(chance(0.3) ? "\n" : " ");
  let bounds = () => ({ x: below(400), y: below(200), width: 20 + below(200), height: 10 + below(100) });

  let slides = shadowDeck();
  let editedSlides = new Set<string>();
  let editedThemes = new Set<string>();
  let actions: SlidesAction[] = [];
  let batchIndex = 0;

  // A slide for a change: three times in four one an earlier batch edited, where there is one.
  let slideFor = (wanted: (element: Shadow) => boolean): ShadowSlide | undefined => {
    let able = slides.filter(slide => slide.elements.some(wanted));
    let edited = able.filter(slide => editedSlides.has(slide.id));
    return edited.length > 0 && chance(0.75) ? oneOf(edited) : able.length > 0 ? oneOf(able) : slides[0];
  };
  // An element for a change: half the time one an earlier batch created, where there is one.
  let target = (wanted: (element: Shadow) => boolean): { slideId: string; element: Shadow } => {
    let slide = slideFor(wanted);
    let able = slide?.elements.filter(wanted) ?? [];
    let made = able.filter(element => element.madeIn !== undefined && element.madeIn < batchIndex);
    let element = made.length > 0 && chance(0.5) ? oneOf(made)
      : able.length > 0 ? oneOf(able) : { id: "nothing", kind: "shape" as const, placed: false };
    return { slideId: slide?.id ?? "nowhere", element };
  };
  let anySlide = () => slideFor(() => true)?.id ?? "nowhere";
  let add = (slideId: string, element: Shadow) => {
    slides.find(slide => slide.id === slideId)?.elements.push({ ...element, madeIn: batchIndex });
  };
  // A table to add or delete lines in: one in ten times a table with a merged cell will do.
  let lines = () => {
    let any = chance(0.1);
    return (element: Shadow) => isTable(element) && (any || !element.merged);
  };
  let format = () => oneOf<Extract<DesignChange, { op: "formatText" }>["format"]>([
    { bold: true }, { italic: true, fontSize: 18 }, { color: oneOf(COLORS) }, { bold: null },
    { link: "https://example.com/page" }, { highlight: oneOf(COLORS), fontFamily: "Arial" },
    { baseline: "superscript", underline: true },
  ]);

  let designChange = (): DesignChange => {
    let op = oneOf(OPS);
    switch (op) {
      case "editText": {
        if (chance(0.3)) {
          let { slideId, element } = target(isTable);
          let cell = { row: below(element.rows ?? 1), column: below(element.columns ?? 1) };
          return { op, slideId, elementId: element.id, cell, replace: phrase() };
        }
        let { slideId, element } = target(isShape);
        if (chance(0.15) && slides.find(slide => slide.id === slideId)?.notes) {
          return { op, slideId, replace: phrase() };
        }
        let replace = phrase();
        let found = element.text && chance(0.4) ? oneOf(element.text.split(/\s/)) : undefined;
        if (found) {
          element.text = element.text!.replace(found, replace);
          return { op, slideId, elementId: element.id, find: found, replace };
        }
        let before = element.text !== undefined && chance(0.5) ? { before: element.text } : {};
        element.text = replace;
        return { op, slideId, elementId: element.id, replace, ...before };
      }
      case "formatText": {
        let { slideId, element } = target(candidate => isShape(candidate) && !!candidate.text);
        let known = element.text ?? "";
        let where = chance(0.5) ? { find: oneOf(known.split(/\s/)) }
          : { range: { start: 0, end: 1 + below(known.length) }, before: known };
        return { op, slideId, elementId: element.id, ...where, format: format() };
      }
      case "formatParagraphs": {
        let { slideId, element } = target(candidate => isShape(candidate) && candidate.text !== undefined);
        let find = element.text && chance(0.4) ? { find: oneOf(element.text.split(/\s/)) } : {};
        return {
          op, slideId, elementId: element.id, ...find,
          ...oneOf<Partial<Extract<DesignChange, { op: "formatParagraphs" }>>>([
            { alignment: "center" }, { lineSpacing: 150, spaceAbove: 6 }, { bullets: "bullet" },
            { bullets: "numbered", alignment: "end" }, { bullets: "none" }, { alignment: null, spaceBelow: 4 },
          ]),
        };
      }
      case "createShape": {
        let slideId = anySlide();
        let id = mint("shape");
        let words = chance(0.7) ? phrase() : undefined;
        add(slideId, { id, kind: "shape", text: words ?? "", placed: true });
        return {
          op, slideId, id, shapeType: oneOf(["RECTANGLE", "TEXT_BOX", "ELLIPSE"]), bounds: bounds(),
          ...(words ? { text: words } : {}),
          ...(words && chance(0.5) ? { format: format() } : {}),
          ...(chance(0.5) ? { fill: oneOf([...COLORS, "none"]) } : {}),
          ...(chance(0.5) ? { outline: oneOf([{ color: oneOf(COLORS), weight: 1 + below(4) }, "none"] as const) } : {}),
        };
      }
      case "updateShape": {
        let { slideId, element } = target(isShape);
        return {
          op, slideId, elementId: element.id,
          ...oneOf<Partial<Extract<DesignChange, { op: "updateShape" }>>>([
            { fill: oneOf(COLORS) }, { fill: "none", outline: "none" }, { contentAlignment: "middle" },
            { outline: { color: oneOf(COLORS), weight: 3 } }, { outline: { weight: 2 }, contentAlignment: "top" },
          ]),
        };
      }
      case "setBounds": {
        let { slideId, element } = target(candidate =>
          topLevel(candidate) && candidate.placed && candidate.madeIn !== batchIndex);
        let sized = (element.kind === "shape" || element.kind === "image") && chance(0.5);
        return {
          op, slideId, elementId: element.id,
          ...(sized
            ? { bounds: { width: 20 + below(100), height: 20 + below(100) }, ...(chance(0.5) ? { rotation: below(360) } : {}) }
            : { bounds: { x: below(400), y: below(200) } }),
        };
      }
      case "deleteElement": {
        let { slideId, element } = target(topLevel);
        let held = slides.find(slide => slide.id === slideId);
        if (held) {
          held.elements = held.elements.filter(other => other !== element && other.group !== element.id);
        }
        return { op, slideId, elementId: element.id };
      }
      case "setAltText": {
        let { slideId, element } = target(candidate => candidate.kind !== "group");
        return {
          op, slideId, elementId: element.id,
          ...oneOf([{ title: word() }, { description: phrase() }, { title: word(), description: word() }]),
        };
      }
      case "arrange": {
        let { slideId, element } = target(topLevel);
        return { op, slideId, elementId: element.id, to: oneOf(["front", "back"] as const) };
      }
      case "insertImage": {
        let slideId = anySlide();
        let id = mint("image");
        let placed = chance(0.75);
        add(slideId, { id, kind: "image", placed });
        return { op, slideId, id, url: `https://img.example/${word()}.png`, ...(placed ? { bounds: bounds() } : {}) };
      }
      case "replaceImage": {
        let { slideId, element } = target(candidate => candidate.kind === "image");
        return { op, slideId, elementId: element.id, url: `https://img.example/${word()}.png` };
      }
      case "createTable": {
        let slideId = anySlide();
        let id = mint("table");
        let rows = 1 + below(4);
        let columns = 1 + below(4);
        let placed = chance(0.75);
        add(slideId, { id, kind: "table", rows, columns, placed });
        return {
          op, slideId, id, rows, columns, ...(placed ? { bounds: bounds() } : {}),
          ...(chance(0.5) ? { cells: [Array.from({ length: columns }, () => chance(0.7) ? word() : "")] } : {}),
        };
      }
      case "insertTableRows":
      case "insertTableColumns": {
        let { slideId, element } = target(lines());
        let axis: "rows" | "columns" = op === "insertTableRows" ? "rows" : "columns";
        let count = 1 + below(2);
        let at = below((element[axis] ?? 0) + 1);
        element[axis] = (element[axis] ?? 0) + count;
        return { op, slideId, elementId: element.id, at, ...(count > 1 || chance(0.5) ? { count } : {}) };
      }
      case "deleteTableRows":
      case "deleteTableColumns": {
        let axis: "rows" | "columns" = op === "deleteTableRows" ? "rows" : "columns";
        let wanted = lines();
        let { slideId, element } = target(candidate => wanted(candidate) && (candidate[axis] ?? 0) > 1);
        let size = element[axis] ?? 1;
        let count = size > 2 && chance(0.3) ? 2 : 1;
        let at = below(Math.max(size - count, 0) + 1);
        element[axis] = size - count;
        return { op, slideId, elementId: element.id, at, ...(count > 1 || chance(0.5) ? { count } : {}) };
      }
      case "formatTableCells": {
        let { slideId, element } = target(isTable);
        let row = below(element.rows ?? 1);
        let column = below(element.columns ?? 1);
        return {
          op, slideId, elementId: element.id,
          ...(chance(0.5) ? { range: { row, column, ...(chance(0.5) ? { rowSpan: 1, columnSpan: 1 } : {}) } } : {}),
          ...oneOf([{ fill: oneOf([...COLORS, "none"]) }, { contentAlignment: "middle" as const },
            { fill: oneOf(COLORS), contentAlignment: "bottom" as const }]),
        };
      }
      case "setBackground": {
        let background = oneOf([...COLORS, "none", null, { imageUrl: `https://img.example/${word()}.png` }]);
        // No other operation edits a layout, so a background returns to one an earlier batch set
        // three times in four; otherwise the kind of page is drawn evenly.
        let pageType = editedThemes.has(QUEUE_LAYOUT) && chance(0.75) ? "LAYOUT"
          : oneOf(["SLIDE", "LAYOUT", "MASTER"] as const);
        if (pageType === "LAYOUT") return { op, layoutId: QUEUE_LAYOUT, background };
        if (pageType === "MASTER") return { op, masterId: QUEUE_MASTER, background };
        return { op, slideId: anySlide(), background };
      }
      case "setThemeColors": {
        let names = ["DARK1", "LIGHT1", "ACCENT1", "ACCENT2", "ACCENT6", "HYPERLINK"] as const;
        let hex = () => `#${below(0x1000000).toString(16).padStart(6, "0")}`;
        return {
          op, masterId: QUEUE_MASTER,
          colors: { [oneOf(names)]: hex(), ...(chance(0.5) ? { [oneOf(names)]: hex() } : {}) },
        };
      }
    }
  };

  // `change` made to name what is not there, or what has changed.
  let conflicting = (change: DesignChange): DesignChange => {
    if (change.op === "createShape") {
      let taken = slides.find(slide => slide.id === change.slideId)?.elements.find(other => other.id !== change.id);
      return taken ? { ...change, id: taken.id } : { ...change, slideId: "gone" };
    }
    if (change.op === "insertTableRows" || change.op === "deleteTableColumns") return { ...change, at: 99 };
    if (change.op === "editText" && change.find === undefined && chance(0.5)) return { ...change, before: "stale" };
    if (change.op === "formatText" && change.range) return { ...change, before: "stale" };
    if ("elementId" in change && change.elementId !== undefined) return { ...change, elementId: "missing" };
    if (change.op === "setThemeColors") return { ...change, masterId: "master-gone" };
    if (change.op === "setBackground" && change.layoutId) return { ...change, layoutId: "layout-gone" };
    if (change.op === "setBackground" && change.masterId) return { ...change, masterId: "master-gone" };
    return { ...change, slideId: "gone" };
  };

  let structural = (conflict: boolean): SlidesAction => {
    let ids = slides.map(slide => slide.id);
    let some = () => conflict ? "gone" : ids.length > 0 ? oneOf(ids) : "s1";
    switch (oneOf(["copy", "deletion", "move", "new", "skip"] as const)) {
      case "copy": {
        let slideId = some();
        let newSlideId = mint("copy");
        let source = slides.find(slide => slide.id === slideId);
        let left = source && source.elements.length > 0 && chance(0.33) ? oneOf(source.elements).id : undefined;
        let kept = (source?.elements ?? []).filter(element => element.id !== left && element.group !== left);
        let objectIds = Object.fromEntries(kept.map(element => [element.id, mint("copied")]));
        if (source) {
          slides.splice(slides.indexOf(source) + 1, 0, {
            id: newSlideId, notes: source.notes,
            elements: kept.map(({ madeIn: _, ...element }) => ({
              ...element, id: objectIds[element.id], ...(element.group ? { group: objectIds[element.group] } : {}),
            })),
          });
        }
        return { kind: "duplicateSlide", payload: { slideId, newSlideId, objectIds, slide: { number: 1 } } };
      }
      case "deletion": {
        let slideId = some();
        slides = slides.filter(slide => slide.id !== slideId);
        editedSlides.delete(slideId);
        return { kind: "deleteSlide", payload: { slideId, slide: { number: 1 } } };
      }
      case "move": {
        let slideIds = [...new Set([some(), ...(chance(0.4) ? [some()] : [])])];
        let others = ids.filter(id => !slideIds.includes(id));
        let after = others.length > 0 && chance(0.7) ? oneOf(others) : null;
        return { kind: "moveSlides", payload: { slideIds, after, slides: [] } };
      }
      case "new": {
        let newSlideId = mint("new");
        let after = conflict ? "gone" : oneOf([undefined, null, ...ids]);
        let elements = ["title", "body"].map(name => shape(`${newSlideId}-${name}`, ""));
        slides.splice(after === undefined ? slides.length : after === null ? 0 : ids.indexOf(after) + 1, 0,
          { id: newSlideId, notes: false, elements });
        return newSlide(newSlideId, after);
      }
      case "skip":
        return {
          kind: "skipSlides",
          payload: { slideIds: [some(), ...(chance(0.4) ? [some()] : [])], skipped: chance(0.7), slides: [] },
        };
    }
  };

  let length = 4 + below(7);
  while (actions.length < length) {
    let conflict = chance(1 / 8);
    if (!chance(0.6)) {
      actions.push(structural(conflict));
      continue;
    }
    let changes = Array.from({ length: 1 + below(4) }, designChange);
    if (conflict) {
      let index = below(changes.length);
      changes[index] = conflicting(changes[index]);
    }
    actions.push({ kind: oneOf(BATCH_KINDS), payload: { changes, slides: {} } });
    for (let { pageType, id } of changes.map(pageOf)) (pageType === "SLIDE" ? editedSlides : editedThemes).add(id);
    batchIndex++;
  }
  return queued(actions);
}
