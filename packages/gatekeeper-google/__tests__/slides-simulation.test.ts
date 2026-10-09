import { describe, expect, it } from "vitest";
import type { RestText } from "../src/slides-api";
import { slideOf } from "../src/slides-model";
import {
  applyChange, slidesToFetch, type Deck, type SlidesAction,
} from "../src/slides-simulation";
import { editSlide } from "../src/slides-target";
import { ChangeConflict } from "../src/slides-text";
import { shape, slide, text } from "./slides-fixture";

function edit(body: RestText, find: string | undefined, replace: string) {
  let page = slide("s1", [shape("box", body)]);
  return editSlide(page, { slideId: "s1", elementId: "box", find, replace });
}

describe("Slides text edits", () => {
  // "Page 11 of 12" projects the slide number as "11", which Slides indexes as one code unit.
  const PAGE = text(["Page ", { slideNumber: "11" }, " of 12"]);

  it("maps an edit after a slide number onto Slides' indices", () => {
    expect(edit(PAGE, "of 12", "of 13")).toMatchObject({
      range: { startIndex: 11, endIndex: 12 }, inserted: "3", text: "Page 11 of 13",
    });
  });

  it("replaces a slide number whole, never part of it", () => {
    // The shared leading "1" is inside the AutoText, so the edit keeps all of it.
    expect(edit(PAGE, "11 of", "12 of")).toMatchObject({
      range: { startIndex: 5, endIndex: 6 }, inserted: "12",
    });
    expect(() => edit(PAGE, "1 of", "2 of")).toThrow(ChangeConflict);
  });

  it("refuses a match that splits a character, and never narrows into one", () => {
    expect(() => edit(text(["Nice 👍🏽!"]), "👍", "👎")).toThrow("inside a character");
    // "é" and "è" decomposed share the base letter, but not as a character of their own.
    expect(edit(text(["Caf\u0065\u0301"]), "e\u0301", "e\u0300")).toMatchObject({
      range: { startIndex: 3, endIndex: 5 }, inserted: "e\u0300",
    });
  });

  it("keeps styles as Google does: new text joins the run it replaces, a new paragraph copies its own", () => {
    let red = { foregroundColor: { opaqueColor: { themeColor: "ACCENT2" } } };
    let body = text(
      { runs: ["Revenue ", { content: "up 4%", style: { bold: true } }, " in Q3"],
        marker: { style: { alignment: "CENTER" } } },
      { runs: [{ content: "Costs", style: red }, " flat"], marker: { style: { alignment: "END" } } },
      { runs: ["Next"], marker: { bullet: { listId: "l", nestingLevel: 1 } } },
    );
    let change = (find: string, replace: string) => {
      let page = slide("s1", [shape("box", body)]);
      let { requests } = editSlide(page, { slideId: "s1", elementId: "box", find, replace });
      return { read: slideOf(page, 0, new Map()).elements[0], requests };
    };

    expect(change("up 4%", "up 9%").read).toMatchObject({
      text: "Revenue up 9% in Q3\nCosts flat\nNext",
      formats: [{ start: 8, end: 13, bold: true }, { start: 20, end: 25, color: "ACCENT2" }],
    });
    // Splitting the bulleted paragraph makes two bulleted paragraphs.
    expect(change("Next", "Ne\nxt").read).toMatchObject({
      paragraphs: [
        { alignment: "center" }, { alignment: "end" },
        { start: 31, end: 33, bullet: { level: 1 } }, { start: 34, end: 36, bullet: { level: 1 } },
      ],
    });
    // Joining paragraphs keeps the second's, whose newline survives, and says so to Google. "osts"
    // is left as it was, so it stays red; "; c" replacing " in Q3\nC" joins the run it starts in.
    let joined = change(" in Q3\nCosts", "; costs");
    expect(joined.read).toMatchObject({
      text: "Revenue up 4%; costs flat\nNext",
      formats: [{ start: 8, end: 13, bold: true }, { start: 16, end: 20, color: "ACCENT2" }],
      paragraphs: [{ start: 0, end: 25, alignment: "end" }, { start: 26, end: 30 }],
    });
    expect(joined.requests.at(-1)).toMatchObject({
      updateParagraphStyle: { style: { alignment: "END" }, textRange: { startIndex: 0, endIndex: 26 } },
    });
    // Which bullet a merged paragraph keeps cannot be said to Google, so it is refused.
    expect(() => change("flat\nNext", "flat, next")).toThrow("not items of the same list");
  });

  // Reads run a link on across a newline, but text typed before one takes the newline's style.
  it("never links a newline the new text adds, as Google never does", () => {
    const url = "https://x.example/";
    let page = slide("s1", [shape("box", text([{ content: "AB", style: { link: { url } } }]))]);
    editSlide(page, { slideId: "s1", elementId: "box", find: "AB", replace: "A\nB" });
    editSlide(page, { slideId: "s1", elementId: "box", find: "A\n", replace: "AX\n" });

    expect(slideOf(page, 0, new Map()).elements[0]).toMatchObject({
      text: "AX\nB", formats: [{ start: 0, end: 1, link: url }, { start: 3, end: 4, link: url }],
    });
  });
});

describe("Slides change replay", () => {
  const copyOf = (slideId: string, newSlideId: string, objectIds: Record<string, string>): SlidesAction =>
    ({ kind: "duplicateSlide", payload: { slideId, newSlideId, objectIds, slide: { number: 1 } } });

  it("fetches the slide a queued copy of a queued copy starts from", () => {
    let changes = [copyOf("s1", "c1", {}), copyOf("s2", "c2", {}), copyOf("c1", "c3", {})]
      .map((action, i) => ({ id: i + 1, action }));

    expect(slidesToFetch(["c3"], changes)).toEqual(new Set(["c3", "c1", "s1"]));
  });

  it("fetches every slide of a batch touching a requested slide, since it applies whole", () => {
    let batch = (...slideIds: string[]): SlidesAction => ({
      kind: "editText",
      payload: { changes: slideIds.map(slideId => ({ op: "editText", slideId, replace: "x" })), slides: {} },
    });
    let changes = [copyOf("s1", "c1", {}), batch("c1", "s2"), batch("s4", "s5")]
      .map((action, i) => ({ id: i + 1, action }));

    expect(slidesToFetch(["s2"], changes)).toEqual(new Set(["s2", "c1", "s1"]));
  });

  it("leaves out of a queued copy an element added to its source since, which it cannot name", () => {
    let source = slide("s1", [shape("title", text(["Q3"])), shape("added", text(["New"]))]);
    let unchanged = structuredClone(source);
    let deck: Deck = { order: ["s1"], slides: new Map([["s1", source]]) };

    let copied = applyChange(deck, copyOf("s1", "c1", { title: "c1title" }));

    expect(copied.order).toEqual(["s1", "c1"]);
    expect(copied.slides.get("c1")!.pageElements!.map(e => e.objectId)).toEqual(["c1title"]);
    expect(source).toEqual(unchanged);
  });

  it("reports a queued copy whose slide already exists, rather than showing it twice", () => {
    let deck: Deck = { order: ["s1", "c1"], slides: new Map() };

    expect(() => applyChange(deck, copyOf("s1", "c1", {}))).toThrow('the copy\'s ID "c1" already exists');
  });

  it("renumbers the slides a queued copy, move or delete shifts", () => {
    let numbered = (n: number) => slide(`s${n}`, [shape(`n${n}`, text(["Page ", { slideNumber: `${n}` }]))]);
    let deck: Deck = { order: ["s1", "s2", "s3"], slides: new Map([1, 2, 3].map(n => [`s${n}`, numbered(n)])) };
    let pages = ({ order, slides }: Deck) => order.map(id => [id, slides.get(id)!.pageElements![0].shape!
      .text!.textElements!.find(e => e.autoText)!.autoText!.content]);

    let copied = applyChange(deck, copyOf("s1", "c1", { n1: "cn1" }));
    expect(pages(copied)).toEqual([["s1", "1"], ["c1", "2"], ["s2", "3"], ["s3", "4"]]);
    let moved = applyChange(copied, { kind: "moveSlides", payload: { slideIds: ["s3"], after: null, slides: [] } });
    expect(pages(moved)).toEqual([["s3", "1"], ["s1", "2"], ["c1", "3"], ["s2", "4"]]);
    let deleted = applyChange(moved, { kind: "deleteSlide", payload: { slideId: "s1", slide: { number: 2 } } });
    expect(pages(deleted)).toEqual([["s3", "1"], ["c1", "2"], ["s2", "3"]]);
  });
});
