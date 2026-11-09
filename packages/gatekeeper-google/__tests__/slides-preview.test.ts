import { describe, expect, it } from "vitest";
import type { PresentationPreview, SlideElement } from "@gadgets/workshop-shared/gatekeeper";
import type {
  RestPageElement, RestParagraphStyle, RestPresentation, RestSlide, RestText, RestTextStyle,
} from "../src/slides-api";
import type { QueuedChange, SlidesAction } from "../src/slides-simulation";
import {
  inlineImages, MAX_PREVIEW_IMAGE_BYTES, MAX_PREVIEW_IMAGES, MAX_PREVIEW_TOTAL_IMAGE_BYTES, picturePixels, presentationPreview,
  previewSlideIds, type PreviewImage,
} from "../src/slides-preview";
import { layout, master, presentation, shape, slide, text } from "./slides-fixture";

const EMU = 12_700;

/** A transform placing an element `x` and `y` points from the slide's top left, unscaled. */
function at(x: number, y: number) {
  return { scaleX: 1, scaleY: 1, translateX: x * EMU, translateY: y * EMU, unit: "EMU" as const };
}

function size(width: number, height: number) {
  return { width: { magnitude: width * EMU, unit: "EMU" as const }, height: { magnitude: height * EMU, unit: "EMU" as const } };
}

/** A shape placed at (`x`, `y`), `width` by `height` points. */
function placed(element: RestPageElement, x: number, y: number, width: number, height: number): RestPageElement {
  return { ...element, size: size(width, height), transform: at(x, y) };
}

/** A placeholder's text: one empty paragraph, whose newline carries the style it passes on. */
function placeholderText(style: RestTextStyle, paragraph?: RestParagraphStyle): RestText {
  return { textElements: [
    { endIndex: 1, paragraphMarker: paragraph ? { style: paragraph } : {} },
    { endIndex: 1, textRun: { content: "\n", style } },
  ] };
}

// The layout's title placeholder sets where a slide's title is and how its text looks, and the
// master's title placeholder the colour, which the layout's leaves to it.
const MASTER_TITLE: RestPageElement = placed({
  objectId: "master-title",
  shape: {
    shapeType: "TEXT_BOX",
    placeholder: { type: "TITLE" },
    text: placeholderText({ foregroundColor: { opaqueColor: { themeColor: "DARK2" } } }),
  },
}, 20, 20, 600, 60);
const LAYOUT_TITLE: RestPageElement = placed({
  objectId: "layout-title-ph",
  shape: {
    shapeType: "TEXT_BOX",
    placeholder: { type: "TITLE", parentObjectId: "master-title" },
    text: placeholderText({ fontSize: { magnitude: 30, unit: "PT" }, fontFamily: "Lato" }, { alignment: "CENTER" }),
  },
}, 36, 40, 648, 80);
const LAYOUT_BODY: RestPageElement = placed({
  objectId: "layout-body-ph",
  shape: { shapeType: "TEXT_BOX", placeholder: { type: "BODY" } },
}, 36, 140, 648, 220);
// A logo on the layout, behind every slide made from it.
const LAYOUT_LOGO = placed(
  { objectId: "logo", image: { contentUrl: "https://lh3.googleusercontent.com/logo" } }, 650, 10, 60, 30);

/** A preview outline, its masters and layouts whole, of `slides`. */
function outline(slides: RestSlide[]): RestPresentation {
  return {
    ...presentation(slides),
    masters: [{ ...master("master-1"), pageElements: [MASTER_TITLE] }],
    layouts: [
      layout("layout-title-body", "Title and body", { pageElements: [LAYOUT_TITLE, LAYOUT_BODY, LAYOUT_LOGO] }),
    ],
  };
}

function titled(id: string, title: string, elements: RestPageElement[] = []): RestSlide {
  let titleShape = shape(`${id}-title`, text([title]), { placeholder: "TITLE" });
  titleShape.shape!.placeholder!.parentObjectId = "layout-title-ph";
  return slide(id, [titleShape, ...elements]);
}

function queued(...actions: SlidesAction[]): QueuedChange[] {
  return actions.map((action, i) => ({ id: 10 + i, action }));
}

function preview(slides: RestSlide[], changes: QueuedChange[] = []) {
  let source = outline(slides);
  let { preview, images, renders } = presentationPreview({
    outline: source,
    slides: new Map(slides.map(page => [page.objectId!, page])),
    changes,
    url: "https://docs.google.com/presentation/d/deck-1/edit",
  });
  return { preview, content: preview.content as PresentationPreview, images, renders };
}

function element(content: PresentationPreview, slideId: string, elementId: string): SlideElement {
  let found = content.slides.find(({ id }) => id === slideId)?.elements.find(({ id }) => id === elementId);
  if (!found) throw new Error(`no element ${elementId} on ${slideId}`);
  return found;
}

const DECK = [titled("s1", "Intro"), titled("s2", "Plan"), titled("s3", "Close")];

describe("Slides preview", () => {
  it("lists every slide in simulated order, an added one where it lands and a removed one where it was", () => {
    let { preview: drawn, content } = preview(DECK, queued(
      {
        kind: "createSlide",
        payload: {
          newSlideId: "new", layoutId: "layout-title-body", layout: "Title and body", after: "s1",
          placeholders: [],
        },
      },
      { kind: "deleteSlide", payload: { slideId: "s2", slide: { number: 3 } } },
      { kind: "moveSlides", payload: { slideIds: ["s3"], after: null, slides: [] } },
    ));

    expect(content.slides.map(({ id, status, changes }) => ({ id, status, changes }))).toEqual([
      { id: "s3", status: undefined, changes: [2] },
      { id: "s1", status: undefined, changes: [] },
      { id: "s2", status: "removed", changes: [1] },
      { id: "new", status: "added", changes: [0] },
    ]);
    expect(drawn).toMatchObject({
      title: "Quarterly review", url: "https://docs.google.com/presentation/d/deck-1/edit",
      actions: [10, 11, 12],
    });
    expect(drawn.omitted).toBeUndefined();
    expect(content).toMatchObject({ width: 720, height: 405 });
  });

  it("places elements in points, a placeholder where its layout puts it, a line between its ends", () => {
    let turned: RestPageElement = {
      objectId: "box",
      size: size(100, 50),
      // A quarter turn clockwise about the box's top left corner, then moved.
      transform: { scaleX: 0, scaleY: 0, shearX: -1, shearY: 1, translateX: 300 * EMU, translateY: 100 * EMU, unit: "EMU" },
      shape: { shapeType: "RECTANGLE" },
    };
    let line: RestPageElement = {
      objectId: "rule",
      size: size(100, 0),
      transform: at(50, 200),
      line: { lineProperties: { lineFill: { solidFill: { color: { rgbColor: { red: 1 } } } } } },
    };
    let { content } = preview([titled("s1", "Intro", [turned, line])]);

    expect(element(content, "s1", "s1-title")).toMatchObject({ kind: "shape", x: 36, y: 40, width: 648, height: 80 });
    expect(element(content, "s1", "box")).toMatchObject({ x: 225, y: 125, width: 100, height: 50, rotation: 90 });
    expect(element(content, "s1", "rule")).toEqual({
      id: "rule", kind: "line", x: 50, y: 200, width: 100, height: 0,
      outline: { color: "#ff0000", weight: 0.75 },
    });
    // The layout's logo is drawn behind the slide's own elements; its placeholders are not.
    expect(content.slides[0].elements.map(({ id }) => id)).toEqual(["logo", "s1-title", "box", "rule"]);
  });

  it("styles text runs as their placeholders resolve them, with bullets and alignment", () => {
    let body = shape("body", text(
      ["Revenue ", { content: "up", style: { bold: true, italic: true, fontSize: { magnitude: 14, unit: "PT" } } }],
      { runs: [{ content: "Costs", style: { strikethrough: true, underline: true } }],
        marker: { bullet: { listId: "l", nestingLevel: 1, glyph: "◦" }, style: { alignment: "END" } } },
    ));
    let { content } = preview([titled("s1", "Intro", [placed(body, 0, 0, 200, 100)])]);

    expect(element(content, "s1", "s1-title").text).toEqual([{
      align: "center",
      runs: [{ text: "Intro", fontSize: 30, fontFamily: "Lato", color: "#595959" }],
    }]);
    expect(element(content, "s1", "body").text).toEqual([
      { runs: [{ text: "Revenue " }, { text: "up", bold: true, italic: true, fontSize: 14 }] },
      {
        align: "end", bullet: { glyph: "◦" },
        runs: [{ text: "Costs", underline: true, strikethrough: true }],
      },
    ]);
  });

  it("ties each slide and element to the changes that touch them", () => {
    let box = placed(shape("box", text(["Old"])), 0, 0, 100, 40);
    let changes = queued(
      {
        kind: "editText",
        payload: { changes: [{ op: "editText", slideId: "s2", elementId: "box", replace: "New" }], slides: {} },
      },
      {
        kind: "updateSlides",
        payload: {
          changes: [
            { op: "createShape", slideId: "s2", id: "added", shapeType: "RECTANGLE", bounds: { x: 0, y: 50, width: 10, height: 10 } },
            { op: "setBackground", layoutId: "layout-title-body", background: "#112233" },
          ],
          slides: {},
        },
      },
      { kind: "duplicateSlide", payload: { slideId: "s2", newSlideId: "copy", objectIds: { "s2-title": "ct", box: "cb" }, slide: { number: 2 } } },
      { kind: "skipSlides", payload: { slideIds: ["s3"], skipped: true, slides: [] } },
    );
    let { content } = preview([titled("s1", "Intro"), titled("s2", "Plan", [box]), titled("s3", "Close")], changes);

    // The layout's background reaches every slide made from it.
    expect(content.slides.map(({ id, changes, background }) => ({ id, changes, background }))).toEqual([
      { id: "s1", changes: [1], background: "#112233" },
      { id: "s2", changes: [0, 1], background: "#112233" },
      { id: "copy", changes: [1, 2], background: "#112233" },
      { id: "s3", changes: [1, 3], background: "#112233" },
    ]);
    expect(element(content, "s2", "box")).toMatchObject({ change: 0, text: [{ runs: [{ text: "New" }] }] });
    expect(element(content, "s2", "added")).toMatchObject({ kind: "shape", change: 1 });
    expect(element(content, "s2", "s2-title").change).toBeUndefined();
    expect(element(content, "copy", "cb")).toMatchObject({ text: [{ runs: [{ text: "New" }] }] });
  });

  it("omits a change that no longer applies, and every change after it", () => {
    let { preview: drawn, content } = preview(DECK, queued(
      { kind: "skipSlides", payload: { slideIds: ["s1"], skipped: true, slides: [] } },
      { kind: "deleteSlide", payload: { slideId: "gone", slide: { number: 4 } } },
      { kind: "deleteSlide", payload: { slideId: "s3", slide: { number: 3 } } },
    ));

    expect(drawn.actions).toEqual([10]);
    expect(drawn.omitted).toEqual([
      { action: 11, reason: 'This change no longer applies to the presentation: slide "gone" no longer exists.' },
      { action: 12, reason: expect.stringContaining("earlier queued change no longer applies") },
    ]);
    expect(content.slides.map(({ id, status }) => [id, status])).toEqual([
      ["s1", undefined], ["s2", undefined], ["s3", undefined],
    ]);
  });

  it("resolves theme colours through the slide's master, a queued theme change included", () => {
    let filled = placed({
      objectId: "filled",
      shape: {
        shapeType: "RECTANGLE",
        shapeProperties: {
          shapeBackgroundFill: { solidFill: { color: { themeColor: "ACCENT1" }, alpha: 0.5 } },
          outline: { outlineFill: { solidFill: { color: { themeColor: "ACCENT4" } } } },
        },
        text: text([{ content: "Link", style: { foregroundColor: { opaqueColor: { themeColor: "HYPERLINK" } } } }]),
      },
    }, 0, 0, 50, 50);
    let plain = preview([titled("s1", "Intro", [filled])]);
    expect(plain.content.slides[0].background).toBe("#ffffff");
    expect(element(plain.content, "s1", "filled")).toMatchObject({
      fill: "#4285f480", outline: { color: "#ffab40", weight: 0.75 }, text: [{ runs: [{ text: "Link", color: "#0097a7" }] }],
    });

    let recoloured = preview([titled("s1", "Intro", [filled])], queued({
      kind: "updateSlides",
      payload: { changes: [{ op: "setThemeColors", masterId: "master-1", colors: { ACCENT1: "#ff0000" } }], slides: {} },
    }));
    expect(recoloured.content.slides[0].changes).toEqual([0]);
    expect(element(recoloured.content, "s1", "filled").fill).toBe("#ff000080");
  });

  it("draws a shape's geometry, outline, shadow, alignment and autofit as Google reports them", () => {
    let callout = placed({
      objectId: "callout",
      shape: {
        shapeType: "ROUND_RECTANGLE",
        shapeProperties: {
          shapeBackgroundFill: { solidFill: { color: { rgbColor: { red: 1, green: 1, blue: 1 } }, alpha: 0.8 } },
          outline: {
            outlineFill: { solidFill: { color: { themeColor: "ACCENT1" }, alpha: 1 } },
            weight: { magnitude: 25400, unit: "EMU" }, dashStyle: "DASH", propertyState: "RENDERED",
          },
          shadow: {
            type: "OUTER", alignment: "BOTTOM_LEFT", alpha: 0.4, color: { rgbColor: {} }, rotateWithShape: false,
            transform: { scaleX: 1, scaleY: 1, translateX: 25400, translateY: 38100, unit: "EMU" },
            blurRadius: { magnitude: 50800, unit: "EMU" }, propertyState: "RENDERED",
          },
          contentAlignment: "MIDDLE",
          autofit: { autofitType: "TEXT_AUTOFIT", fontScale: 0.5, lineSpacingReduction: 20 },
        },
        text: text(
          [{ content: "Go", style: { fontSize: { magnitude: 20, unit: "PT" } } }, " live"],
          { runs: ["Docs"], marker: { style: { lineSpacing: 150, spaceAbove: { magnitude: 6, unit: "PT" } } } },
        ),
      },
    }, 400, 100, 200, 100);
    // As Google reads a text box that draws no outline or shadow.
    let plain = placed({
      objectId: "plain",
      shape: {
        shapeType: "TEXT_BOX",
        shapeProperties: {
          outline: { outlineFill: { solidFill: { color: {} } }, propertyState: "NOT_RENDERED" },
          shadow: { type: "OUTER", color: { rgbColor: {} }, alpha: 1, propertyState: "NOT_RENDERED" },
        },
        text: text(["Note"]),
      },
    }, 0, 300, 200, 50);
    let { content } = preview([titled("s1", "Intro", [callout, plain])]);

    expect(element(content, "s1", "callout")).toEqual({
      id: "callout", kind: "shape", x: 400, y: 100, width: 200, height: 100,
      geometry: "ROUND_RECTANGLE",
      fill: "#ffffffcc",
      outline: { color: "#4285f4", weight: 2, dash: "dash" },
      shadow: { color: "#00000066", x: 2, y: 3, blur: 4 },
      verticalAlign: "middle",
      text: [
        { lineSpacing: 80, runs: [{ text: "Go", fontSize: 10 }, { text: " live", fontSize: 7 }] },
        { lineSpacing: 130, spaceAbove: 6, runs: [{ text: "Docs", fontSize: 7 }] },
      ],
    });
    expect(element(content, "s1", "plain")).toEqual({
      id: "plain", kind: "shape", x: 0, y: 300, width: 200, height: 50, text: [{ runs: [{ text: "Note" }] }],
    });
  });

  it("styles runs, bullets and indents in full, a link in the theme's link colour", () => {
    let body = placed(shape("body", {
      ...text(
        { runs: [{ content: "Plan", style: { weightedFontFamily: { fontFamily: "Montserrat", weight: 300 } } }],
          marker: {
            bullet: { listId: "list-1", glyph: "1." },
            style: { indentStart: { magnitude: 36, unit: "PT" }, indentFirstLine: { magnitude: 18, unit: "PT" } },
          } },
        { runs: [
          { content: "docs", style: { link: { url: "https://example.com" } } },
          { content: "2", style: { baselineOffset: "SUPERSCRIPT", smallCaps: true,
            backgroundColor: { opaqueColor: { rgbColor: { red: 1, green: 1 } } } } },
        ], marker: {
          bullet: { listId: "list-1", nestingLevel: 1, glyph: "a." },
          // An indent Google reports as zero has no magnitude.
          style: { indentStart: { magnitude: 54, unit: "PT" }, indentFirstLine: { unit: "PT" } },
        } },
      ),
      lists: { "list-1": { listId: "list-1", nestingLevel: {
        0: { bulletStyle: { foregroundColor: { opaqueColor: { themeColor: "ACCENT1" } } } },
      } } },
    }), 0, 0, 300, 200);
    let { content } = preview([titled("s1", "Intro", [body])]);

    expect(element(content, "s1", "body").text).toEqual([
      {
        bullet: { glyph: "1.", weight: 300, fontFamily: "Montserrat", color: "#4285f4" },
        indentStart: 36, indentFirstLine: 18,
        runs: [{ text: "Plan", weight: 300, fontFamily: "Montserrat" }],
      },
      {
        // A bullet takes its paragraph's first character's style, but not as a link.
        bullet: { glyph: "a." },
        indentStart: 54, indentFirstLine: 0,
        runs: [
          { text: "docs", color: "#0097a7", underline: true },
          { text: "2", baseline: "superscript", smallCaps: true, background: "#ffff00" },
        ],
      },
    ]);
  });

  it("draws a picture's crop, transparency and outline, a line's weight, dash and arrowheads", async () => {
    let photo = placed({
      objectId: "photo",
      image: {
        contentUrl: "https://lh7-rt.googleusercontent.com/photo",
        imageProperties: {
          cropProperties: { leftOffset: 0.1, rightOffset: 0.2, topOffset: 0.05 },
          transparency: 0.25,
          outline: {
            outlineFill: { solidFill: { color: { rgbColor: {} } } }, weight: { magnitude: 12700, unit: "EMU" },
            propertyState: "RENDERED",
          },
          shadow: { type: "OUTER", propertyState: "NOT_RENDERED" },
        },
      },
    }, 10, 20, 300, 200);
    let arrow: RestPageElement = {
      objectId: "arrow",
      size: size(100, 0),
      transform: at(50, 250),
      line: {
        lineCategory: "STRAIGHT",
        lineProperties: {
          lineFill: { solidFill: { color: { themeColor: "DARK2" }, alpha: 1 } },
          weight: { magnitude: 38100, unit: "EMU" }, dashStyle: "LONG_DASH_DOT",
          startArrow: "NONE", endArrow: "FILL_ARROW",
        },
      },
    };
    let { content, images } = preview([titled("s1", "Intro", [photo, arrow])]);
    await inlineImages(images, async () => ({ mediaType: "image/jpeg", content: new Uint8Array([1]) }));

    expect(element(content, "s1", "photo")).toEqual({
      id: "photo", kind: "image", x: 10, y: 20, width: 300, height: 200, image: expect.any(String),
      crop: { left: 0.1, top: 0.05, right: 0.2, bottom: 0 }, opacity: 0.75,
      outline: { color: "#000000", weight: 1 },
    });
    expect(element(content, "s1", "photo").image).toBe("data:image/jpeg;base64,AQ==");
    expect(element(content, "s1", "logo").image).toBe("data:image/jpeg;base64,AQ==");
    expect(element(content, "s1", "arrow")).toEqual({
      id: "arrow", kind: "line", x: 50, y: 250, width: 100, height: 0,
      outline: { color: "#595959", weight: 3, dash: "longDashDot" }, endArrow: "fillArrow",
    });
  });

  it("turns a picture's crop by its angle, in degrees", () => {
    let photo = placed({
      objectId: "photo",
      image: { contentUrl: "https://lh7-rt.googleusercontent.com/photo", imageProperties: { cropProperties: { angle: -Math.PI / 4 } } },
    }, 10, 20, 300, 200);
    let { content } = preview([titled("s1", "Intro", [photo])]);
    expect(element(content, "s1", "photo").crop).toEqual({ left: 0, top: 0, right: 0, bottom: 0, angle: -45 });
  });

  it("fills a placeholder switched on with no colour of its own in its layout's hidden colour", () => {
    let caption = shape("caption", text(["Malibu sunset"]), { placeholder: "BODY" });
    caption.shape!.placeholder!.parentObjectId = "layout-body-ph";
    caption.shape!.shapeProperties = { shapeBackgroundFill: {} };
    let slides = [slide("s1", [caption])];
    let source = outline(slides);
    let hiddenWhite = { propertyState: "NOT_RENDERED" as const, solidFill: { color: { rgbColor: { red: 1, green: 1, blue: 1 } }, alpha: 1 } };
    source.layouts![0].pageElements = [LAYOUT_TITLE, { ...LAYOUT_BODY, shape: { ...LAYOUT_BODY.shape!, shapeProperties: { shapeBackgroundFill: hiddenWhite } } }];
    let { preview: drawn } = presentationPreview({ outline: source, slides: new Map([["s1", slides[0]]]), changes: [] });
    expect(element(drawn.content as PresentationPreview, "s1", "caption").fill).toBe("#ffffff");
  });

  it("asks for Google's render of an untouched slide to show a freehand line, and draws it straight until then", () => {
    let curve: RestPageElement = {
      objectId: "curve", size: size(100, 50), transform: at(50, 100),
      line: { lineProperties: { weight: { magnitude: 12700, unit: "EMU" } } },
    };
    let { content, renders } = preview([titled("s1", "Intro", [curve]), titled("s2", "Plan", [{ ...curve, objectId: "curve-2" }])],
      queued({ kind: "editText", payload: { changes: [{ op: "editText", slideId: "s2", elementId: "s2-title", replace: "Roadmap" }], slides: {} } }));

    expect(element(content, "s1", "curve").kind).toBe("line");
    // Only the untouched slide is as Google draws it.
    expect(renders.map(({ slideId }) => slideId)).toEqual(["s1"]);
    renders[0].place("data:image/png;base64,AQ==");
    // Out to its stroke, as a share of the slide's 720 by 405.
    expect(element(content, "s1", "curve")).toEqual({
      id: "curve", kind: "image", x: 44, y: 94, width: 112, height: 62, image: "data:image/png;base64,AQ==",
      crop: { left: 0.0611, top: 0.2321, right: 0.7833, bottom: 0.6148 },
    });
    expect(element(content, "s2", "curve-2").kind).toBe("line");
  });

  it("draws a table's grid, fills, borders and merged cells", () => {
    let border = (red: number) => ({
      tableBorderProperties: {
        tableBorderFill: { solidFill: { color: { rgbColor: { red } }, alpha: 1 } },
        weight: { magnitude: 12700, unit: "EMU" as const }, dashStyle: "SOLID",
      },
    });
    let none = { tableBorderProperties: { tableBorderFill: { solidFill: { color: {}, alpha: 0 } } } };
    let grid: RestPageElement = {
      objectId: "grid",
      transform: at(40, 100),
      table: {
        rows: 2, columns: 2,
        tableColumns: [{ columnWidth: { magnitude: 120 * EMU, unit: "EMU" } }, { columnWidth: { magnitude: 80 * EMU, unit: "EMU" } }],
        tableRows: [
          { rowHeight: { magnitude: 30 * EMU, unit: "EMU" }, tableCells: [{
            location: {}, rowSpan: 1, columnSpan: 2, text: text(["Owners"]),
            tableCellProperties: {
              tableCellBackgroundFill: { solidFill: { color: { themeColor: "ACCENT1" }, alpha: 1 }, propertyState: "RENDERED" },
              contentAlignment: "MIDDLE",
            },
          }] },
          { rowHeight: { magnitude: 20 * EMU, unit: "EMU" }, tableCells: [
            { location: { rowIndex: 1 }, rowSpan: 1, columnSpan: 1, text: text(["Maya"]) },
            { location: { rowIndex: 1, columnIndex: 1 }, rowSpan: 1, columnSpan: 1, text: text([]),
              tableCellProperties: { contentAlignment: "TOP" } },
          ] },
        ],
        horizontalBorderRows: [0, 1, 2].map(rowIndex => ({
          tableBorderCells: [0, 1].map(columnIndex => ({
            location: { rowIndex, columnIndex }, ...(rowIndex === 1 ? none : border(1)),
          })),
        })),
        verticalBorderRows: [0, 1].map(rowIndex => ({
          tableBorderCells: [0, 1, 2].map(columnIndex => ({ location: { rowIndex, columnIndex }, ...border(0.5) })),
        })),
      },
    };
    let { content } = preview([titled("s1", "Intro", [grid])]);

    let red = { color: "#ff0000", weight: 1 };
    let dim = { color: "#800000", weight: 1 };
    expect(element(content, "s1", "grid")).toEqual({
      id: "grid", kind: "table", x: 40, y: 100, width: 200, height: 50,
      table: {
        columns: [120, 80],
        rows: [30, 20],
        cells: [
          [{ text: [{ runs: [{ text: "Owners" }] }], fill: "#4285f4", columnSpan: 2, verticalAlign: "middle" }, null],
          [{ text: [{ runs: [{ text: "Maya" }] }] }, {}],
        ],
        horizontalBorders: [[red, red], [null, null], [red, red]],
        verticalBorders: [[dim, dim, dim], [dim, dim, dim]],
      },
    });
  });

  it("draws a picture background through Google's copy of it, and a theme's text colour", async () => {
    let source = outline([titled("s1", "Intro", [placed(shape("note", text(["Hi"])), 0, 0, 100, 40)])]);
    source.masters![0].pageProperties!.pageBackgroundFill = {
      stretchedPictureFill: { contentUrl: "https://lh7-rt.googleusercontent.com/backdrop" },
    };
    source.masters![0].pageProperties!.colorScheme!.colors!.find(({ type }) => type === "DARK1")!.color =
      { red: 0.2, green: 0.2, blue: 0.2 };
    let { preview: drawn, images } = presentationPreview({
      outline: source, slides: new Map(source.slides!.map(page => [page.objectId!, page])), changes: [],
    });
    let content = drawn.content as PresentationPreview;
    expect(content.slides[0].background).toBeUndefined();
    expect(element(content, "s1", "note").text).toEqual([{ runs: [{ text: "Hi", color: "#333333" }] }]);

    // The background is downloaded before the slide's pictures.
    expect(images[0].contentUrl).toBe("https://lh7-rt.googleusercontent.com/backdrop");
    await inlineImages(images, async () => ({ mediaType: "image/png", content: new Uint8Array([1]) }));
    expect(content.slides[0].backgroundImage).toBe("data:image/png;base64,AQ==");
    expect(JSON.stringify(drawn)).not.toContain("googleusercontent");
  });

  it("fetches the slides changes touch first, then their neighbours, within the cap", () => {
    let order = ["a", "b", "c", "d", "e", "f"];
    let changes = queued({ kind: "deleteSlide", payload: { slideId: "e", slide: { number: 5 } } });

    expect(previewSlideIds(order, changes, 4)).toEqual(["e", "d", "f", "a"]);
    expect(previewSlideIds(order, [], 3)).toEqual(["a", "b", "c"]);
  });

  it("lists a slide not fetched with no elements", () => {
    let source = outline(DECK);
    let { content } = presentationPreview({ outline: source, slides: new Map([["s1", DECK[0]]]), changes: [] })
      .preview as { content: PresentationPreview };

    expect(content.slides.map(({ id, elements }) => [id, elements.length])).toEqual([["s1", 2], ["s2", 0], ["s3", 0]]);
  });
});

describe("Slides preview pictures", () => {
  /** Pictures at `urls`, each with where it was placed. */
  function images(urls: string[]): (PreviewImage & { placed?: string })[] {
    return urls.map(contentUrl => {
      let image: PreviewImage & { placed?: string } = { contentUrl, pixels: 800, place: url => { image.placed = url; } };
      return image;
    });
  }

  it("inlines each picture once as a data URL, and never shows its URL", async () => {
    let wanted = images([0, 1, 0].map(i => `https://lh3.googleusercontent.com/${i}`));
    let fetched: string[] = [];
    await inlineImages(wanted, async url => {
      fetched.push(url);
      return { mediaType: "image/png", content: new Uint8Array([1, 2, 3]) };
    });

    expect(fetched.toSorted()).toEqual(["https://lh3.googleusercontent.com/0", "https://lh3.googleusercontent.com/1"]);
    expect(wanted.map(({ placed }) => placed)).toEqual(Array(3).fill("data:image/png;base64,AQID"));
  });

  it("fetches a picture shown twice as wide as its widest showing", async () => {
    let wanted = images(["https://lh3.googleusercontent.com/a", "https://lh3.googleusercontent.com/a"]);
    wanted[1].pixels = 1600;
    let sizes: number[] = [];
    await inlineImages(wanted, async (_url, _maxBytes, pixels) => {
      sizes.push(pixels);
      return { mediaType: "image/png", content: new Uint8Array([1]) };
    });
    expect(sizes).toEqual([1600]);
  });

  it("asks again, narrower, for a picture too large to fit", async () => {
    let [photo] = images(["https://lh3.googleusercontent.com/photo"]);
    photo.pixels = 1600;
    let sizes: number[] = [];
    await inlineImages([photo], async (_url, maxBytes, pixels) => {
      sizes.push(pixels);
      // A photo's bytes grow with its area.
      let bytes = MAX_PREVIEW_IMAGE_BYTES * (pixels / 1200) ** 2;
      if (bytes > maxBytes) throw new Error("too large");
      return { mediaType: "image/jpeg", content: new Uint8Array(bytes) };
    });
    expect(sizes).toEqual([1600, 800]);
    expect(photo.placed).toMatch(/^data:image\/jpeg/);
  });

  it("sizes a picture by its share of the slide's width, within the image host's sizes", () => {
    expect([picturePixels(360, 720), picturePixels(720, 720), picturePixels(5, 720), picturePixels(2000, 720)])
      .toEqual([800, 1600, 200, 2048]);
  });

  it("leaves out a picture that fails, and those past the caps", async () => {
    let many = images(Array.from({ length: MAX_PREVIEW_IMAGES + 2 }, (_, i) => `https://lh3.googleusercontent.com/${i}`));
    let fetched: string[] = [];
    let failures: string[] = [];
    // Each picture is just under the per-picture cap, so four fit the total.
    let bytes = MAX_PREVIEW_TOTAL_IMAGE_BYTES / 4 - 1;
    await inlineImages(many, async (url, maxBytes) => {
      fetched.push(url);
      if (url.endsWith("/0")) throw new Error("not a picture");
      // As a capped download refuses a body longer than it was allowed.
      if (bytes > maxBytes) throw new Error("too large");
      return { mediaType: "image/jpeg", content: new Uint8Array(bytes) };
    }, error => failures.push((error as Error).message));

    expect(failures).toContain("not a picture");
    expect(many[0].placed).toBeUndefined();
    expect(many.filter(({ placed }) => placed !== undefined)).toHaveLength(4);
    // Those past the cap of distinct pictures are never fetched.
    expect(new Set(fetched).size).toBeLessThanOrEqual(MAX_PREVIEW_IMAGES);
    expect(fetched).not.toContain(`https://lh3.googleusercontent.com/${MAX_PREVIEW_IMAGES}`);
  });
});
