import { describe, expect, it } from "vitest";
import type { StructuralElement } from "../src/docs-api";
import type { GoogleDocParagraph } from "../src/docs-rendering-types";
import { docTabToMarkdown } from "../src/markdown-converter";
import { buildTab } from "./doc-fixture";

const pt = (magnitude: number) => ({ magnitude, unit: "PT" });

/** The content of a header or a footer: `text` in one paragraph, tethered to `objects`. */
function part(text: string, objects: string[] = []): { content: StructuralElement[] } {
  let content = buildTab([{ runs: [`${text}\n`] }]).body.content.slice(1);
  if (objects.length) content[0]!.paragraph!.positionedObjectIds = objects;
  return { content };
}

const placed = (left: number, top: number, layout = "WRAP_TEXT") => ({
  positionedObjectProperties: {
    positioning: { layout, leftOffset: pt(left), topOffset: pt(top) },
    embeddedObject: { size: { width: pt(90), height: pt(60) }, imageProperties: { contentUri: `https://images.test/${left}` } },
  },
});

describe("a Google Doc tab's drawing", () => {
  it("names each body paragraph's line of the Markdown, and where each run starts in it", () => {
    let tab = buildTab([
      { runs: ["Report\n"], namedStyleType: "HEADING_1" },
      { runs: ["plain ", { text: "bold", style: { bold: true } }, " end\n"] },
    ]);
    let { markdown, drawing } = docTabToMarkdown(tab);
    let lines = markdown.split("\n");
    let [heading, body] = drawing.blocks as GoogleDocParagraph[];

    expect(lines[heading!.line!]).toBe("# Report");
    expect(heading!.style).toBe("HEADING_1");
    for (let run of body!.runs) {
      if (!("text" in run)) continue;
      expect(lines[body!.line!]!.slice(run.at, run.at! + run.text.length)).toBe(run.text);
    }
    // The bold run is set a step heavier than the text beside it, and each look is held once.
    let weights = body!.runs.map(run => drawing.textLooks[run.look]!.weight);
    expect(weights).toEqual([400, 700, 400]);
    expect(body!.runs[0]!.look).toBe(body!.runs[2]!.look);
  });

  it("sets a header and a footer where Google Docs does when the document says nowhere", () => {
    let unset = docTabToMarkdown({ ...buildTab([{ runs: ["Body\n"] }]), documentStyle: { marginHeader: pt(36), marginFooter: pt(36) } });
    // Google Docs ignores both margins until the document is told to use them.
    expect(unset.drawing.sections[0]).toMatchObject({ margins: { header: 5.25, footer: -3.6, top: 72 }, headerGap: 5.25 });

    let custom = docTabToMarkdown({
      ...buildTab([{ runs: ["Body\n"] }]),
      documentStyle: { useCustomHeaderFooterMargins: true, marginHeader: pt(20), marginFooter: pt(30) },
    });
    expect(custom.drawing.sections[0]!.margins).toMatchObject({ header: 20, footer: 30 });
    expect(custom.drawing.sections[0]).not.toHaveProperty("headerGap");
  });

  it("keeps a count of pages that starts at 0, and leaves out one that starts at 1", () => {
    let first = (pageNumberStart: number) =>
      docTabToMarkdown({ ...buildTab([{ runs: ["Body\n"] }]), documentStyle: { pageNumberStart } }).drawing.sections[0];

    expect(first(0)).toMatchObject({ pageNumberStart: 0 });
    expect(first(1)).not.toHaveProperty("pageNumberStart");
  });

  it("draws the header a section names, with the image tethered to it", () => {
    let { drawing, imageUris } = docTabToMarkdown({
      ...buildTab([{ runs: ["Body\n"] }]),
      documentStyle: { defaultHeaderId: "h", defaultFooterId: "f" },
      headers: { h: part("Head", ["logo"]) },
      footers: { f: part("Foot") },
      positionedObjects: { logo: placed(400, -20, "BEHIND_TEXT") },
    });
    let [section] = drawing.sections;
    let [head] = drawing.headers[section!.header!] as GoogleDocParagraph[];

    expect(section).toMatchObject({ header: "h", footer: "f" });
    expect(head).toMatchObject({ runs: [{ text: "Head" }], objects: ["logo"] });
    // Nothing of a header is in the Markdown, so none of it has a line.
    expect(head!.line).toBeUndefined();
    expect(drawing.objects.logo).toMatchObject({
      width: 90, height: 60, readable: true, placed: { left: 400, top: -20, layout: "behind" },
    });
    expect(imageUris.logo).toBe("https://images.test/400");
  });

  // Google Docs returns a first-page header, and of the header of every other page only the
  // image tethered in it.
  it("draws a header Google leaves out as the image it holds, set as the nearest returned one is", () => {
    let { drawing } = docTabToMarkdown({
      ...buildTab([{ runs: ["Body\n"] }]),
      documentStyle: { useFirstPageHeaderFooter: true, firstPageHeaderId: "first", firstPageFooterId: "last" },
      headers: { first: part("Head", ["corner"]) },
      footers: { last: part("Foot", ["band"]) },
      positionedObjects: {
        corner: placed(400, -20), band: placed(0, 30),
        // Tethered in no paragraph Google returned.
        "other-corner": placed(420, -20), "other-band": placed(10, 30),
      },
    });
    let [section] = drawing.sections;

    expect(section).toMatchObject({ firstPage: true, firstHeader: "first", header: "unreturned", footer: "unreturned" });
    expect(drawing.headers.unreturned).toMatchObject([{ type: "paragraph", runs: [], objects: ["other-corner"] }]);
    expect(drawing.footers.unreturned).toMatchObject([{ type: "paragraph", runs: [], objects: ["other-band"] }]);
    expect(drawing.objects["other-corner"]!.placed).toMatchObject({ left: 420, top: -20 });
  });

  it("leaves an image no header or footer is near undrawn", () => {
    let { drawing } = docTabToMarkdown({
      ...buildTab([{ runs: ["Body\n"] }]),
      positionedObjects: { stray: placed(100, 100) },
    });

    expect(drawing.headers).toEqual({});
    expect(drawing.objects).toEqual({});
    expect(drawing.sections[0]).not.toHaveProperty("header");
  });
});
