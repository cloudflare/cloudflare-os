// A freeform's path and a preset's dragged handles come from Google's PowerPoint export of the
// deck, which numbers its shapes anew: so these hold the export's shapes to being matched to the
// API's for certain or not at all, and what is read of an untrusted file to its bounds.

import { buildDeck, buildZip, drawnShape, transform } from "@gadgets/office-content/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RestPageElement } from "../src/slides-api";
import {
  exportedSlides, exportFor, EXPORT_WAIT_MS, logLoss, matchGeometry, MAX_HELD_EXPORTS, needsExport, readExport,
  releaseExport, resolveGeometry, type ExportLoss, type ShapeGeometry,
} from "../src/slides-export";

const EMU = 12_700;
const length = (points: number) => ({ magnitude: points * EMU, unit: "EMU" as const });

/** A shape as the API reports it, its box in points. */
function reported(objectId: string, shapeType: string, x: number, y: number, width: number, height: number): RestPageElement {
  return {
    objectId, size: { width: length(width), height: length(height) },
    transform: { scaleX: 1, scaleY: 1, translateX: x * EMU, translateY: y * EMU, unit: "EMU" },
    shape: { shapeType },
  };
}

const point = ([x, y]: number[]) => `<a:pt x="${x}" y="${y}"/>`;
const TRIANGLE = `<a:moveTo>${point([0, 50])}</a:moveTo><a:lnTo>${point([50, 0])}</a:lnTo>` +
  `<a:cubicBezTo>${[[60, 10], [90, 40], [100, 50]].map(point).join("")}</a:cubicBezTo><a:close/>`;
const TRIANGLE_PATH = { width: 100, height: 50, ops: "MLCZ", points: [0, 50, 50, 0, 60, 10, 90, 40, 100, 50] };
const freeform = (steps = TRIANGLE, attributes = 'w="100" h="50"') =>
  `<a:custGeom><a:pathLst><a:path ${attributes}>${steps}</a:path></a:pathLst></a:custGeom>`;
const preset = (name: string, adjust: Record<string, string> = {}) => `<a:prstGeom prst="${name}"><a:avLst>` +
  `${Object.entries(adjust).map(([guide, value]) => `<a:gd name="${guide}" fmla="${value}"/>`).join("")}</a:avLst></a:prstGeom>`;
/** A shape as the export holds it, its box in points. */
const exported = (geometry: string, x: number, y: number, width: number, height: number, attributes = "") =>
  drawnShape({ properties: transform(x * EMU, y * EMU, width * EMU, height * EMU, attributes) + geometry });

const slideOf = (deck: Awaited<ReturnType<typeof readExport>>, index: number) => deck.pages.get(deck.slides[index]);
async function pageOf(shapes: string) {
  return slideOf(await readExport(await buildDeck({ slides: [{ shapes }] })), 0)!;
}
async function matched(elements: RestPageElement[], shapes: string) {
  let geometry = new Map<string, ShapeGeometry>();
  matchGeometry(elements, await pageOf(shapes), geometry);
  return Object.fromEntries(geometry);
}
const line = (count: number) => `<a:moveTo>${point([0, 0])}</a:moveTo>${`<a:lnTo>${point([1, 1])}</a:lnTo>`.repeat(count)}`;

describe("Google's export of a presentation", () => {
  it("reads its slides in the deck's order, each over its layout and that over its master", async () => {
    let deck = await readExport(await buildDeck({
      slides: [{ shapes: exported(freeform(), 0, 0, 10, 10) }, { shapes: "" }],
      layoutShapes: exported(preset("ellipse"), 0, 0, 10, 10), masterShapes: "",
    }));

    expect(deck.slides).toHaveLength(2);
    let [first, second] = [slideOf(deck, 0), slideOf(deck, 1)];
    expect(first!.leaves).toHaveLength(1);
    expect(second!.leaves).toEqual([]);
    expect(first!.over).toBe("ppt/slideLayouts/slideLayout1.xml");
    let layout = deck.pages.get(first!.over!);
    expect(layout!.leaves[0].geometry).toEqual({ preset: "ellipse", adjust: [] });
    expect(deck.pages.get(layout!.over!)!.leaves).toEqual([]);
    expect(deck.pages.size).toBe(4);
    expect(deck.numbers).toBe(TRIANGLE_PATH.ops.length + TRIANGLE_PATH.points.length);
  });

  it("reads a freeform's paths as numbers, and which of them are only filled or only outlined", async () => {
    let page = await pageOf(exported(
      `<a:custGeom><a:pathLst><a:path w="100" h="50" fill="none">${TRIANGLE}</a:path>` +
      `<a:path w="10" h="10" stroke="0"><a:moveTo>${point([0, 0])}</a:moveTo><a:quadBezTo>${point([5, 5])}${point([10, 0])}</a:quadBezTo></a:path>` +
      "</a:pathLst></a:custGeom>", 0, 0, 100, 50));

    expect(page.leaves[0].geometry).toEqual({ paths: [
      { ...TRIANGLE_PATH, filled: false }, { width: 10, height: 10, ops: "MQ", points: [0, 0, 5, 5, 10, 0], stroked: false },
    ] });
  });

  it("gives a path that names no size of its own its shape's", async () => {
    let page = await pageOf(exported(freeform(TRIANGLE, ""), 0, 0, 100, 50));

    expect(page.leaves[0].geometry).toEqual({ paths: [{ ...TRIANGLE_PATH, width: 100 * EMU, height: 50 * EMU }] });
  });

  it.each([
    ["an arc", `<a:moveTo>${point([0, 0])}</a:moveTo><a:arcTo wR="5" hR="5" stAng="0" swAng="5400000"/>`],
    ["a coordinate given as a formula", `<a:moveTo><a:pt x="hc" y="0"/></a:moveTo>`],
    ["a step with too few points", `<a:moveTo>${point([0, 0])}</a:moveTo><a:cubicBezTo>${point([1, 1])}</a:cubicBezTo>`],
    ["no start", `<a:lnTo>${point([0, 0])}</a:lnTo>`],
    ["more coordinates than a shape may hold", line(7000)],
  ])("reads no outline from a freeform with %s, though it knows it for a freeform", async (_, steps) => {
    let page = await pageOf(exported(freeform(steps), 0, 0, 100, 50));

    expect(page.leaves).toHaveLength(1);
    expect(page.leaves[0]).toMatchObject({ kind: "paths" });
    expect(page.leaves[0]).not.toHaveProperty("geometry");
  });

  it("reads a preset's adjust values in order, and none that are not plain numbers", async () => {
    let page = await pageOf(
      exported(preset("blockArc", { adj3: "val 8425", adj1: "val 10800000", adj2: "val -5154282" }), 0, 0, 10, 10) +
      exported(preset("roundRect", { adj: "val 50000" }), 0, 0, 10, 10) +
      exported(preset("roundRect", { adj: "*/ w 1 2" }), 0, 0, 10, 10) +
      exported(preset("blockArc", { adj1: "val 1", adj3: "val 3" }), 0, 0, 10, 10));

    expect(page.leaves.map(leaf => leaf.geometry)).toEqual([
      { preset: "blockArc", adjust: [10_800_000, -5_154_282, 8425] }, { preset: "roundRect", adjust: [50_000] },
      { preset: "roundRect", adjust: [] }, { preset: "blockArc", adjust: [] },
    ]);
  });

  it("refuses a file that is no PowerPoint file", async () => {
    await expect(readExport(new TextEncoder().encode("<!doctype html>"))).rejects.toThrow();
    await expect(readExport(await buildZip([{ name: "word/document.xml", data: "<w:document/>" }]))).rejects.toThrow();
  });
});

// A page is held to its bounds before it is parsed, not after: what is read of one is its text,
// then one shape or group of it at a time.
describe("the bounds on what is read of an export", () => {
  let small = exported(preset("rect"), 0, 0, 1, 1);
  let read = async (...slides: string[]) => {
    let lost: ExportLoss[] = [];
    let deck = await readExport(await buildDeck({ slides: slides.map(shapes => ({ shapes })) }), why => lost.push(why));
    return { deck, lost, read: slides.map((_, index) => slideOf(deck, index)?.leaves.length) };
  };

  it("leaves out a page that holds more shapes than a page may, and reads the others", async () => {
    let { read: counts, lost } = await read(small.repeat(2001), small.repeat(2000));

    expect(counts).toEqual([undefined, 2000]);
    expect(lost).toEqual(["page-limit"]);
  });

  it("leaves out a page whose text is larger than a page's may be, without parsing it", async () => {
    // 2.3 MB of shapes, which is none too many shapes or points: it is refused as it is inflated.
    let large = `<p:sp><p:spPr>${"<a:ln/>".repeat(1100)}</p:spPr></p:sp>`.repeat(300);
    let parse = vi.spyOn(String.prototype, "charCodeAt");
    let before = parse.mock.calls.length;

    let { read: counts, lost } = await read(large);

    expect(large.length).toBeGreaterThan(2 * 1024 * 1024);
    expect(counts).toEqual([undefined]);
    expect(lost).toEqual(["page-limit"]);
    // None of its two million characters was looked at.
    expect(parse.mock.calls.length - before).toBeLessThan(100_000);
    parse.mockRestore();
  });

  it("leaves out a page with a shape or group of more elements than one may hold", async () => {
    let group = `<p:grpSp>${"<p:sp/>".repeat(60_001)}</p:grpSp>`;

    let { read: counts, lost } = await read(group, small);

    expect(counts).toEqual([undefined, 1]);
    expect(lost).toEqual(["page-limit"]);
  });

  it("stops reading paths past a page's share of coordinates, and past a deck's", async () => {
    let large = exported(freeform(line(6000)), 0, 0, 1, 1);
    let outlined = (deck: Awaited<ReturnType<typeof readExport>>, index: number) =>
      slideOf(deck, index)!.leaves.filter(leaf => leaf.geometry).length;

    let { deck } = await read(...Array.from({ length: 4 }, () => large.repeat(7)));

    // Each holds 18,003 numbers: five to a page of 100,000, and sixteen to a deck of 300,000.
    expect([0, 1, 2, 3].map(index => outlined(deck, index))).toEqual([5, 5, 5, 1]);
    expect(deck.numbers).toBe(16 * 18_003);
  });

  it("reads no more pages than a deck may hold", async () => {
    let { deck, read: counts } = await read(...Array.from({ length: 301 }, () => small));

    // The layout and the master are two of the 300.
    expect(deck.pages.size).toBe(300);
    expect(counts.filter(count => count === 1)).toHaveLength(298);
  });

  it("leaves out a page that is not well formed", async () => {
    let { read: counts, lost } = await read("<p:sp>", small);

    expect(counts).toEqual([undefined, 1]);
    expect(lost).toEqual(["page-unreadable"]);
  });
});

describe("matching the export's shapes to the API's", () => {
  it("says which elements are drawn from the export, a group's among them", () => {
    expect(needsExport([reported("a", "RECTANGLE", 0, 0, 1, 1), reported("b", "ELLIPSE", 0, 0, 1, 1)])).toBe(false);
    expect(needsExport([reported("a", "CUSTOM", 0, 0, 1, 1)])).toBe(true);
    expect(needsExport([{ objectId: "g", elementGroup: { children: [reported("a", "BLOCK_ARC", 0, 0, 1, 1)] } }])).toBe(true);
    expect(needsExport(undefined)).toBe(false);
  });

  it("matches each shape to the one at its place in the page's order, shapes stacked on one spot too", async () => {
    let arc = (start: number) => exported(preset("blockArc", { adj1: `val ${start}`, adj2: "val 0", adj3: "val 25000" }), 50, 50, 100, 100);

    let geometry = await matched(
      [reported("t", "TEXT_BOX", 0, 0, 300, 40), reported("a", "BLOCK_ARC", 50, 50, 100, 100),
        reported("b", "BLOCK_ARC", 50, 50, 100, 100), reported("f", "CUSTOM", 200, 100, 100, 50)],
      exported(preset("rect"), 0, 0, 300, 40) + arc(1) + arc(2) + exported(freeform(), 200, 100, 100, 50));

    expect(geometry).toEqual({
      a: { preset: "blockArc", adjust: [1, 0, 25_000] }, b: { preset: "blockArc", adjust: [2, 0, 25_000] },
      f: { paths: [TRIANGLE_PATH] },
    });
  });

  it("matches a shape in a group where the group, and the groups around it, put it", async () => {
    let inner: RestPageElement = {
      objectId: "inner", transform: { scaleX: 1, scaleY: 1, translateX: 10 * EMU, translateY: 10 * EMU, unit: "EMU" },
      elementGroup: { children: [reported("f", "CUSTOM", 5, 5, 20, 10)] },
    };
    let outer: RestPageElement = {
      objectId: "outer", transform: { scaleX: 2, scaleY: 2, translateX: 100 * EMU, translateY: 50 * EMU, unit: "EMU" },
      elementGroup: { children: [inner, reported("r", "RECTANGLE", 0, 0, 5, 5)] },
    };
    let group = (x: number, y: number, cx: number, cy: number, childCx: number, childCy: number, children: string) =>
      `<p:grpSp><p:nvGrpSpPr/><p:grpSpPr><a:xfrm><a:off x="${x * EMU}" y="${y * EMU}"/><a:ext cx="${cx * EMU}" cy="${cy * EMU}"/>` +
      `<a:chOff x="0" y="0"/><a:chExt cx="${childCx * EMU}" cy="${childCy * EMU}"/></a:xfrm></p:grpSpPr>${children}</p:grpSp>`;

    // The freeform is at (15, 15) in the outer group, which doubles it: (130, 80), 40 by 20.
    let geometry = await matched([outer], group(100, 50, 200, 100, 100, 50,
      group(10, 10, 50, 30, 50, 30, exported(freeform(), 5, 5, 20, 10)) + exported(preset("rect"), 0, 0, 5, 5)));

    expect(geometry).toEqual({ f: { paths: [TRIANGLE_PATH] } });
  });

  it("matches a turned and mirrored shape, which the export and the API each say their own way", async () => {
    // Mirrored left to right, then a quarter turn clockwise about the middle of a 100 by 40 box at (20, 30).
    let turned: RestPageElement = {
      ...reported("f", "CUSTOM", 0, 0, 100, 40),
      transform: { scaleX: 0, shearY: -1, shearX: -1, scaleY: 0, translateX: 90 * EMU, translateY: 100 * EMU, unit: "EMU" },
    };

    expect(await matched([turned], exported(freeform(), 20, 30, 100, 40, 'flipH="1" rot="5400000"'))).toHaveProperty("f");
    expect(await matched([turned], exported(freeform(), 20, 30, 100, 40, 'rot="5400000"'))).toEqual({});
    expect(await matched([turned], exported(freeform(), 20, 30, 100, 40, 'flipH="1"'))).toEqual({});
  });

  it.each([
    ["is somewhere else", exported(freeform(), 60, 50, 100, 50)],
    ["is another size", exported(freeform(), 50, 50, 100, 60)],
    ["is another kind of shape", exported(preset("blockArc", { adj1: "val 1" }), 50, 50, 100, 50)],
    ["says nothing of where it is", drawnShape({ properties: freeform() })],
    ["is a picture", `<p:pic><p:spPr>${transform(50 * EMU, 50 * EMU, 100 * EMU, 50 * EMU)}</p:spPr></p:pic>`],
  ])("gives a shape no outline when the export's shape at its place %s", async (_, shapes) => {
    expect(await matched([reported("f", "CUSTOM", 50, 50, 100, 50)], shapes)).toEqual({});
  });

  it("does not take a preset's handles from a preset of another name", async () => {
    let shapes = exported(preset("homePlate", { adj: "val 30000" }), 50, 50, 100, 50);

    expect(await matched([reported("s", "ROUND_RECTANGLE", 50, 50, 100, 50)], shapes)).toEqual({});
    expect(await matched([reported("s", "HOME_PLATE", 50, 50, 100, 50)], shapes)).toEqual({ s: { preset: "homePlate", adjust: [30_000] } });
  });

  // The export holds one shape more than the API reports, so no place in its order can be trusted.
  it("takes the only shape that fits when the pages differ in length, and none when two do", async () => {
    let elements = [reported("f", "CUSTOM", 50, 50, 100, 50), reported("g", "CUSTOM", 300, 50, 100, 50)];
    let two = freeform(`<a:moveTo>${point([0, 0])}</a:moveTo><a:lnTo>${point([1, 1])}</a:lnTo>`);

    let geometry = await matched(elements, exported(preset("rect"), 0, 0, 10, 10) + exported(freeform(), 50, 50, 100, 50) +
      exported(freeform(), 300, 50, 100, 50) + exported(two, 300, 50, 100, 50));

    expect(geometry).toEqual({ f: { paths: [TRIANGLE_PATH] } });
  });

  it("matches none of a page's shapes when one of them is nowhere in the export's page", async () => {
    let geometry = new Map<string, ShapeGeometry>();
    let page = await pageOf(exported(freeform(), 50, 50, 100, 50) + exported(freeform(), 300, 50, 100, 50));
    let elements = [reported("f", "CUSTOM", 50, 50, 100, 50), reported("g", "CUSTOM", 300, 80, 100, 50)];

    expect(matchGeometry(elements, page, geometry)).toBe(false);
    expect(geometry.size).toBe(0);
    // A freeform whose outline could not be read is still where it should be: the others match.
    let unread = await pageOf(exported(freeform(), 50, 50, 100, 50) + exported(freeform(line(7000)), 300, 80, 100, 50));
    expect(matchGeometry(elements, unread, geometry)).toBe(true);
    expect([...geometry.keys()]).toEqual(["f"]);
  });
});


describe("matching a presentation's pages to the export's", () => {
  let shape = (x: number) => exported(freeform(), x, 50, 100, 50);
  let found = (deck: Awaited<ReturnType<typeof readExport>>, slides: Parameters<typeof resolveGeometry>[1],
    pages: RestPageElement[][], under: { objectId: string; pageElements: RestPageElement[] }[] = []) =>
    resolveGeometry(deck, slides, pages.map((pageElements, index) => ({ objectId: `s${index + 1}`, pageElements })), under);
  let listed = (...skipped: boolean[]) => skipped.map((skip, index) => ({ id: `s${index + 1}`, layout: "l", master: "m", skipped: skip }));
  let own = (x: number, id = "f") => [reported(id, "CUSTOM", x, 50, 100, 50)];

  it("takes each saved slide for the export's at its place", async () => {
    let deck = await readExport(await buildDeck({ slides: [{ shapes: shape(0) }, { shapes: shape(200) }] }));

    expect([...exportedSlides(deck, listed(false, true))!.keys()]).toEqual(["s1", "s2"]);
    expect([...found(deck, listed(false, true), [own(0, "a"), own(200, "b")])!.keys()]).toEqual(["a", "b"]);
  });

  // Whether Google's export keeps a skipped slide is not known: either way a slide is matched.
  it("takes the slides that are not skipped for the export's, when it holds only as many as those", async () => {
    let deck = await readExport(await buildDeck({ slides: [{ shapes: shape(0) }, { shapes: shape(200) }] }));
    let slides = listed(false, true, false);

    expect([...exportedSlides(deck, slides)!.entries()].map(([id, part]) => [id, deck.slides.indexOf(part)]))
      .toEqual([["s1", 0], ["s3", 1]]);
    expect([...found(deck, slides, [own(0, "a"), own(100, "skipped"), own(200, "c")])!.keys()]).toEqual(["a", "c"]);
  });

  it("matches nothing to an export of some other number of slides", async () => {
    let deck = await readExport(await buildDeck({ slides: [{ shapes: shape(0) }] }));

    expect(found(deck, listed(false, false, false), [own(0)])).toBeUndefined();
    expect(found(deck, listed(false, true, true, false), [own(0)])).toBeUndefined();
  });

  // The export may be of the deck as it was: a slide that has moved is then some other slide.
  it("gives a slide whose shapes are not all where the export's are none of them, and the other slides theirs", async () => {
    let deck = await readExport(await buildDeck({ slides: [{ shapes: shape(0) + shape(200) }, { shapes: shape(0) }] }));

    let geometry = found(deck, listed(false, false), [[...own(0, "a"), ...own(300, "moved")], own(0, "b")]);

    expect([...geometry!.keys()]).toEqual(["b"]);
  });

  it("finds a layout and its master under any saved slide laid over them, for a slide that is not saved yet", async () => {
    let deck = await readExport(await buildDeck({
      slides: [{ shapes: "" }], layoutShapes: shape(0), masterShapes: exported(preset("blockArc", { adj1: "val 1" }), 0, 0, 10, 10),
    }));
    let under = [
      { objectId: "l", pageElements: own(0, "on-layout") },
      { objectId: "m", pageElements: [reported("on-master", "BLOCK_ARC", 0, 0, 10, 10)] },
      { objectId: "other", pageElements: own(0, "elsewhere") },
    ];

    // No saved slide is drawn: the new slide's layout is still found.
    expect(Object.fromEntries(found(deck, listed(false), [], under)!)).toEqual({
      "on-layout": { paths: [TRIANGLE_PATH] }, "on-master": { preset: "blockArc", adjust: [1] },
    });
  });
});

describe("the export a session keeps", () => {
  let bytes = buildDeck({ slides: [{ shapes: "" }] });
  let info: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { info = vi.spyOn(console, "info").mockImplementation(() => {}); });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  let losses = () => info.mock.calls.map((call: unknown[]) => call[0] as { event?: string; outcome?: string } | undefined)
    .flatMap((entry: { event?: string; outcome?: string } | undefined) => entry?.event === "google.slides.export.unused" ? [entry.outcome] : []);

  it("is fetched once while the presentation's revision stands", async () => {
    let fetches = vi.fn(async () => bytes);
    let holder = {};

    let first = await exportFor(holder, "rev-1", fetches);
    expect(await exportFor(holder, "rev-1", fetches)).toBe(first);
    expect(first).toMatchObject({ slides: [expect.any(String)] });
    expect(fetches).toHaveBeenCalledTimes(1);
    // Another session's is its own.
    expect(await exportFor({}, "rev-1", fetches)).not.toBe(first);
    expect(fetches).toHaveBeenCalledTimes(2);
  });

  // Each shape is still held to where the API puts it now, so an older export is no guess.
  it.each([["an editor whose presentation keeps changing", ["rev-1", "rev-2", "rev-3"]], ["a viewer, who is told no revision", []]])(
    "is fetched no more than once a minute for %s", async (_, revisions) => {
      vi.useFakeTimers();
      let fetches = vi.fn(async () => bytes);
      let holder = {};

      let first = await exportFor(holder, revisions[0], fetches);
      vi.advanceTimersByTime(59_000);
      expect(await exportFor(holder, revisions[1], fetches)).toBe(first);
      expect(fetches).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(2000);
      expect(await exportFor(holder, revisions[2], fetches)).not.toBe(first);
      expect(fetches).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    ["Drive refuses it", async () => "http-4xx" as const, "http-4xx"],
    ["it is larger than is read", async () => "too-large" as const, "too-large"],
    ["the request fails", async () => { throw new Error("network"); }, "failed"],
    ["it is no PowerPoint file", async () => new TextEncoder().encode("<!doctype html>"), "unreadable"],
  ])("is none, and no error, when %s: asked for again only after a minute, and logged once", async (_, answer, outcome) => {
    vi.useFakeTimers();
    let fetches = vi.fn(answer);
    let holder = {};

    expect(await exportFor(holder, "rev-1", fetches)).toBeUndefined();
    expect(await exportFor(holder, "rev-1", fetches)).toBeUndefined();
    expect(fetches).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(61_000);
    await exportFor(holder, "rev-1", fetches);
    expect(fetches).toHaveBeenCalledTimes(2);
    expect(losses()).toEqual([outcome]);
  });

  it("keeps the export it has when Drive makes no newer one", async () => {
    vi.useFakeTimers();
    let answers: (() => Promise<Uint8Array | ExportLoss>)[] = [() => bytes, async () => "http-5xx"];
    let holder = {};

    let first = await exportFor(holder, "rev-1", () => answers.shift()!());
    vi.advanceTimersByTime(61_000);

    expect(await exportFor(holder, "rev-2", () => answers.shift()!())).toBe(first);
  });

  it("makes a read wait no longer than a few seconds for it, and has it for a later read", async () => {
    vi.useFakeTimers();
    let arrive!: (bytes: Uint8Array) => void;
    let fetches = vi.fn(() => new Promise<Uint8Array>(resolve => { arrive = resolve; }));
    let holder = {};

    let [first, second] = [exportFor(holder, "rev-1", fetches), exportFor(holder, "rev-1", fetches)];
    await vi.advanceTimersByTimeAsync(EXPORT_WAIT_MS);
    // Each is told it is on its way, which is not that there is none.
    expect(await Promise.all([first, second])).toEqual(["pending", "pending"]);
    // The reads at once shared the one request, and a session elsewhere starts no second.
    expect(fetches).toHaveBeenCalledTimes(1);
    expect(await exportFor({}, "rev-1", fetches)).toBe("pending");
    expect(fetches).toHaveBeenCalledTimes(1);
    expect(losses()).toEqual(["slow"]);

    arrive(await bytes);
    await vi.advanceTimersByTimeAsync(100);
    expect(await exportFor(holder, "rev-1", fetches)).toMatchObject({ slides: [expect.any(String)] });
    expect(fetches).toHaveBeenCalledTimes(1);
  });

  it("draws from the export it has, and says nothing is on its way, while a newer one is slow", async () => {
    vi.useFakeTimers();
    let end!: (loss: ExportLoss) => void;
    let answers: (() => Promise<Uint8Array | ExportLoss>)[] = [() => bytes, () => new Promise(resolve => { end = resolve; })];
    let holder = {};
    let first = await exportFor(holder, "rev-1", () => answers.shift()!());
    vi.advanceTimersByTime(61_000);

    let read = exportFor(holder, "rev-2", () => answers.shift()!());
    await vi.advanceTimersByTimeAsync(EXPORT_WAIT_MS);

    expect(await read).toBe(first);
    end("http-5xx");
    await vi.advanceTimersByTimeAsync(1);
  });

  it("asks again past a request that never ended", async () => {
    vi.useFakeTimers();
    let end!: (loss: ExportLoss) => void;
    let fetches = vi.fn(() => new Promise<ExportLoss>(resolve => { end = resolve; }));
    let holder = {};

    let read = exportFor(holder, "rev-1", fetches);
    await vi.advanceTimersByTimeAsync(EXPORT_WAIT_MS);
    await read;
    // The next read within the time the request is given waits on it again; one after takes it up anew.
    let waited = exportFor(holder, "rev-1", fetches);
    await vi.advanceTimersByTimeAsync(EXPORT_WAIT_MS);
    expect(await waited).toBe("pending");
    expect(fetches).toHaveBeenCalledTimes(1);
    // A request still alive may be on its third try, so it is not taken up while it could be.
    vi.advanceTimersByTime(20_000);
    let early = exportFor(holder, "rev-1", fetches);
    await vi.advanceTimersByTimeAsync(EXPORT_WAIT_MS);
    await early;
    expect(fetches).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10_000);
    let again = exportFor(holder, "rev-1", fetches);

    expect(fetches).toHaveBeenCalledTimes(2);
    end("http-5xx");
    await again;
  });

  it("keeps nothing of a request it gave up on", async () => {
    vi.useFakeTimers();
    let arrive!: (bytes: Uint8Array) => void;
    let end!: (loss: ExportLoss) => void;
    let answers: (() => Promise<Uint8Array | ExportLoss>)[] = [
      () => new Promise(resolve => { arrive = resolve; }), () => new Promise(resolve => { end = resolve; }),
    ];
    let holder = {};
    let read = (revisionId: string) => exportFor(holder, revisionId, () => answers.shift()!());

    let first = read("rev-1");
    await vi.advanceTimersByTimeAsync(EXPORT_WAIT_MS);
    await first;
    vi.advanceTimersByTime(40_000);
    let second = read("rev-2");
    end("http-5xx");
    await vi.advanceTimersByTimeAsync(1);
    expect(await second).toBeUndefined();

    // The first answers at last, and reading it takes real time.
    arrive(await bytes);
    vi.useRealTimers();
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(await read("rev-1")).toBeUndefined();
  });

  it("is let go when its session ends", async () => {
    let fetches = vi.fn(async () => bytes);
    let holder = {};
    await exportFor(holder, "rev-1", fetches);

    releaseExport(holder);
    await exportFor(holder, "rev-1", fetches);

    expect(fetches).toHaveBeenCalledTimes(2);
  });

  it("keeps no more sessions' exports than its bound, had or not, letting the oldest go first", async () => {
    let fetches = vi.fn(async (): Promise<ExportLoss> => "http-4xx");
    let holders = Array.from({ length: MAX_HELD_EXPORTS + 1 }, () => ({}));
    for (let holder of holders) await exportFor(holder, "rev-1", fetches);
    expect(fetches).toHaveBeenCalledTimes(MAX_HELD_EXPORTS + 1);

    await exportFor(holders.at(-1)!, "rev-1", fetches);
    expect(fetches).toHaveBeenCalledTimes(MAX_HELD_EXPORTS + 1);
    await exportFor(holders[0], "rev-1", fetches);
    expect(fetches).toHaveBeenCalledTimes(MAX_HELD_EXPORTS + 2);
  });

  it("logs why a session's drawings went without, once for each reason and with nothing of the file", () => {
    let holder = {};

    logLoss(holder, "slide-count");
    logLoss(holder, "slide-count");
    logLoss(holder, "page-limit");
    logLoss({}, "slide-count");

    expect(losses()).toEqual(["slide-count", "page-limit", "slide-count"]);
    expect(info.mock.calls[0][0]).toMatchObject({ component: "gatekeeper.google.slides.export", vendorId: "google" });
  });
});
