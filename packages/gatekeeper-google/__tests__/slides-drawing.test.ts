// How a slide is drawn from what Google reports of it: what each element takes from the layout and
// master above it is resolved here, so that whoever draws the slide need not know of either.

import { describe, expect, it } from "vitest";
import type { RestPageElement, RestPresentation } from "../src/slides-api";
import { drawSlide, fontsOf } from "../src/slides-drawing";
import type { ShapeGeometry } from "../src/slides-export";
import type { Deck } from "../src/slides-simulation";
import { colorScheme, SIMPLE_LIGHT, text } from "./slides-fixture";

const EMU_PER_POINT = 12_700;
const size = (width: number, height: number) => ({
  width: { magnitude: width * EMU_PER_POINT, unit: "EMU" as const },
  height: { magnitude: height * EMU_PER_POINT, unit: "EMU" as const },
});
const at = (x: number, y: number) => ({
  scaleX: 1, scaleY: 1, translateX: x * EMU_PER_POINT, translateY: y * EMU_PER_POINT, unit: "EMU" as const,
});
const themeFill = (themeColor: string) => ({ solidFill: { color: { themeColor }, alpha: 1 } });
const points = (magnitude: number) => ({ magnitude, unit: "PT" as const });

const MASTER_TITLE: RestPageElement = {
  objectId: "m-title", size: size(600, 60), transform: at(30, 20),
  shape: {
    shapeType: "TEXT_BOX", placeholder: { type: "TITLE" },
    text: text({
      runs: [{ content: "Master title", style: {
        fontFamily: "Oxygen", fontSize: points(28), bold: true,
        foregroundColor: { opaqueColor: { themeColor: "DARK2" } },
      } }],
      marker: { style: { alignment: "CENTER" } },
    }),
  },
};

function deckOf(slideElements: RestPageElement[]): Deck {
  return {
    order: ["s"],
    slides: new Map([["s", {
      objectId: "s", pageElements: slideElements,
      pageProperties: { pageBackgroundFill: { propertyState: "INHERIT" } },
      slideProperties: { layoutObjectId: "l", masterObjectId: "m" },
    }]]),
    masters: new Map([["s", "m"], ["l", "m"]]),
    firstMaster: "m",
    themePages: new Map([
      ["m", {
        objectId: "m", pageType: "MASTER",
        pageProperties: { pageBackgroundFill: themeFill("LIGHT2"), colorScheme: colorScheme() },
        pageElements: [
          { objectId: "m-mark", size: size(40, 20), transform: at(5, 5), shape: {
            shapeType: "RECTANGLE", shapeProperties: { shapeBackgroundFill: themeFill("ACCENT1") },
          } },
          MASTER_TITLE,
        ],
      }],
      ["l", {
        objectId: "l", pageType: "LAYOUT", layoutProperties: { displayName: "Title", masterObjectId: "m" },
        pageProperties: { pageBackgroundFill: { propertyState: "INHERIT" } },
        pageElements: [
          { objectId: "l-title", transform: at(50, 100), shape: {
            placeholder: { type: "TITLE", parentObjectId: "m-title" },
            shapeProperties: { shapeBackgroundFill: themeFill("ACCENT2") },
          } },
          { objectId: "l-bar", size: size(10, 405), transform: at(0, 0), shape: {
            shapeType: "RECTANGLE", shapeProperties: { shapeBackgroundFill: themeFill("ACCENT3") },
          } },
        ],
      }],
    ]),
  };
}

const SLIDE_TITLE: RestPageElement = {
  objectId: "t",
  shape: { shapeType: "TEXT_BOX", placeholder: { type: "TITLE", parentObjectId: "l-title" }, text: text(["Hello"]) },
};

describe("a slide as drawn", () => {
  it("gives a placeholder the place, fill and text styles of the layout and master above it", () => {
    let { slide } = drawSlide(deckOf([SLIDE_TITLE]), "s")!;
    let title = slide.elements.find(element => element.id === "t");

    expect(title).toMatchObject({
      kind: "shape",
      // Placed where the layout puts it, at the size only the master gives.
      bounds: { x: 50, y: 100, width: 600, height: 60 },
      fill: { color: SIMPLE_LIGHT.ACCENT2 },
      text: [{
        alignment: "center",
        runs: [{ text: "Hello", fontFamily: "Oxygen", fontSize: 28, fontWeight: 700, color: SIMPLE_LIGHT.DARK2 }],
      }],
    });
  });

  it("draws what the master and layout hold that is no placeholder behind the slide's own, and their background", () => {
    let { slide, behind } = drawSlide(deckOf([SLIDE_TITLE]), "s")!;

    // The master's and the layout's are apart from the slide's own, so each can be sent once.
    expect(behind.map(elements => elements.map(({ id, from }) => [id, from])))
      .toEqual([[["m-mark", "master"]], [["l-bar", "layout"]]]);
    expect(slide.elements.map(({ id, from }) => [id, from])).toEqual([["t", undefined]]);
    expect(behind[0][0]).toMatchObject({ fill: { color: SIMPLE_LIGHT.ACCENT1 } });
    expect(slide.background).toEqual({ color: SIMPLE_LIGHT.LIGHT2 });
  });

  it("keeps what the slide's own element sets over what it would inherit", () => {
    let own: RestPageElement = {
      objectId: "t", size: size(300, 40), transform: at(10, 10),
      shape: {
        shapeType: "TEXT_BOX", placeholder: { type: "TITLE", parentObjectId: "l-title" },
        shapeProperties: { shapeBackgroundFill: { propertyState: "NOT_RENDERED" } },
        text: text([{ content: "Own", style: { fontSize: points(12), bold: false, italic: true } }]),
      },
    };
    let title = drawSlide(deckOf([own]), "s")!.slide.elements.at(-1)!;

    expect(title).toMatchObject({
      bounds: { x: 10, y: 10, width: 300, height: 40 },
      text: [{ runs: [{ text: "Own", fontFamily: "Oxygen", fontSize: 12, fontWeight: 400, italic: true }] }],
    });
    expect(title).not.toHaveProperty("fill");
  });

  it("lists what a group holds on its own, placed as the group places it, and marked as the group is", () => {
    let group: RestPageElement = {
      objectId: "g", transform: { ...at(100, 50), scaleX: 2, scaleY: 2 },
      elementGroup: { children: [
        { objectId: "c", size: size(10, 20), transform: at(5, 5), shape: { shapeType: "ELLIPSE" } },
      ] },
    };
    let { slide } = drawSlide(deckOf([group]), "s", ids => ids.includes("g") ? [{ id: 7, op: "setBounds" }] : [])!;

    expect(slide.elements.at(-1)).toMatchObject({
      id: "c", shapeType: "ELLIPSE", bounds: { x: 110, y: 60, width: 20, height: 40 },
      changes: [{ id: 7, op: "setBounds" }],
    });
  });

  it("names a picture by its element, and keeps where Google serves it out of the drawing", () => {
    let picture: RestPageElement = {
      objectId: "pic", size: size(100, 50), transform: at(0, 0),
      image: { contentUrl: "https://lh3.googleusercontent.com/secret=s1600" },
    };
    let { slide, pictures } = drawSlide(deckOf([picture]), "s")!;

    expect(slide.elements.at(-1)).toMatchObject({ kind: "picture", of: "image", pictureId: "pic" });
    expect(JSON.stringify(slide)).not.toContain("googleusercontent");
    expect(pictures.get("pic")).toEqual({ contentUrl: "https://lh3.googleusercontent.com/secret=s1600", side: 100 });
  });

  // The image host sizes a picture by its longer side, and serves the whole of it.
  it.each([
    ["taller than wide", size(50, 200), undefined, 200],
    ["cut to its middle half across", size(100, 50), { leftOffset: .25, rightOffset: .25 }, 200],
    ["cut to its top fifth", size(100, 50), { bottomOffset: .8 }, 250],
  ])("says how long the longer side of a picture %s is drawn, cut or not", (_, box, cropProperties, side) => {
    let picture: RestPageElement = {
      objectId: "pic", size: box, transform: at(0, 0),
      image: { contentUrl: "https://lh3.googleusercontent.com/a=s1", imageProperties: { cropProperties } },
    };

    expect(drawSlide(deckOf([picture]), "s")!.pictures.get("pic")!.side).toBeCloseTo(side);
  });

  it("draws a picture's cut, its turn in degrees, and how it is faded and toned", () => {
    let picture: RestPageElement = {
      objectId: "pic", size: size(100, 50), transform: at(0, 0),
      image: { contentUrl: "https://lh3.googleusercontent.com/a=s1", imageProperties: {
        cropProperties: { leftOffset: .1, topOffset: .2, angle: Math.PI / 2 },
        transparency: .25, brightness: .5, contrast: -.5,
        outline: { outlineFill: { solidFill: { color: { rgbColor: { red: 1 } } } }, weight: points(2), dashStyle: "DASH" },
      } },
    };

    expect(drawSlide(deckOf([picture]), "s")!.slide.elements[0]).toMatchObject({
      crop: { left: .1, top: .2, right: 0, bottom: 0, angle: 90 }, opacity: .75, brightness: .5, contrast: -.5,
      outline: { color: "#ff0000", weight: 2, dash: "DASH" },
    });
  });

  it("names no picture for an image a pending change replaces, which Google does not serve yet", () => {
    let picture: RestPageElement = {
      objectId: "pic", size: size(100, 50), transform: at(0, 0),
      image: { contentUrl: "https://lh3.googleusercontent.com/old=s1" },
    };
    let { slide, pictures } = drawSlide(deckOf([picture]), "s", () => [{ id: 3, op: "replaceImage" }])!;

    expect(slide.elements[0]).not.toHaveProperty("pictureId");
    expect(pictures.size).toBe(0);
  });

  it("draws a picture behind a slide from whichever of the slide, its layout and its master sets one", () => {
    let deck = deckOf([]);
    deck.themePages.get("l")!.pageProperties = { pageBackgroundFill: {
      stretchedPictureFill: { contentUrl: "https://lh3.googleusercontent.com/back=s1" },
    } };
    let { slide, pictures } = drawSlide(deck, "s")!;

    // Named by the page that holds it, so every slide of the layout names the same picture.
    expect(slide.background).toEqual({ pictureId: "l" });
    expect(pictures.get("l")).toEqual({ contentUrl: "https://lh3.googleusercontent.com/back=s1", side: Infinity });
    expect(JSON.stringify(slide)).not.toContain("googleusercontent");
  });

  it("draws no background where the slide switches it off, whatever its master's is", () => {
    let deck = deckOf([]);
    deck.slides.get("s")!.pageProperties = { pageBackgroundFill: { propertyState: "NOT_RENDERED" } };

    expect(drawSlide(deck, "s")!.slide).not.toHaveProperty("background");
  });
});

describe("a shape as drawn", () => {
  let only = (element: RestPageElement) => drawSlide(deckOf([element]), "s")!.slide.elements[0];
  let box = { objectId: "b", size: size(100, 40), transform: at(20, 30) };

  it("turns and mirrors a shape as its transform does", () => {
    let turned = only({ ...box, shape: { shapeType: "RIGHT_ARROW" },
      transform: { scaleX: 0, scaleY: 0, shearX: -1, shearY: 1, translateX: 200 * EMU_PER_POINT, translateY: 0, unit: "EMU" } });
    let mirrored = only({ ...box, shape: { shapeType: "RIGHT_ARROW" }, transform: { ...at(20, 30), scaleY: -1 } });

    expect(turned).toMatchObject({ rotation: 90, bounds: { width: 100, height: 40 } });
    expect(turned).not.toHaveProperty("flipped");
    expect(mirrored).toMatchObject({ flipped: true, bounds: { x: 20, y: -10, width: 100, height: 40 } });
    expect(mirrored).not.toHaveProperty("rotation");
  });

  // Neither is in what the API reports: both come from the export, by the element's id.
  it("draws a freeform with the outline found for it, and a preset with the handles found for its own kind", () => {
    let path = { width: 100, height: 50, ops: "MLZ", points: [0, 0, 100, 50] };
    let drawn = (shapeType: string, geometry: ShapeGeometry) => drawSlide(
      deckOf([{ ...box, shape: { shapeType } }]), "s", undefined, new Map([["b", geometry]]),
    )!.slide.elements[0];

    expect(drawn("CUSTOM", { paths: [path] })).toMatchObject({ shapeType: "CUSTOM", paths: [path] });
    expect(drawn("BLOCK_ARC", { preset: "blockArc", adjust: [1, 2, 3] })).toMatchObject({ adjust: [1, 2, 3] });
    for (let unmatched of [
      only({ ...box, shape: { shapeType: "CUSTOM" } }), drawn("CUSTOM", { preset: "rect", adjust: [1] }),
      drawn("BLOCK_ARC", { paths: [path] }), drawn("BLOCK_ARC", { preset: "chord", adjust: [1, 2] }),
      drawn("BLOCK_ARC", { preset: "blockArc", adjust: [] }), drawn("RECTANGLE", { preset: "rect", adjust: [1] }),
    ]) {
      expect(unmatched).not.toHaveProperty("paths");
      expect(unmatched).not.toHaveProperty("adjust");
    }
  });

  it("draws a shadow by its offset, blur and colour, and none that is switched off", () => {
    let shadow = {
      transform: { scaleX: 1, scaleY: 1, translateX: 2 * EMU_PER_POINT, translateY: 3 * EMU_PER_POINT, unit: "EMU" as const },
      blurRadius: points(4), color: { rgbColor: {} }, alpha: .5,
    };
    let lit = only({ ...box, shape: { shapeType: "RECTANGLE", shapeProperties: { shadow } } });
    let unlit = only({ ...box, shape: { shapeType: "RECTANGLE", shapeProperties: {
      shadow: { ...shadow, propertyState: "NOT_RENDERED" },
    } } });

    expect(lit).toMatchObject({ shadow: { color: "#000000", opacity: .5, x: 2, y: 3, blur: 4 } });
    expect(unlit).not.toHaveProperty("shadow");
  });

  it("draws an outline at its weight and dash, and none that is switched off or has no colour", () => {
    let outline = { outlineFill: { solidFill: { color: { themeColor: "ACCENT1" } } }, weight: points(3), dashStyle: "DOT" };
    let outlined = (set: object) => only({ ...box, shape: { shapeType: "RECTANGLE", shapeProperties: { outline: set } } });

    expect(outlined(outline)).toMatchObject({ outline: { color: SIMPLE_LIGHT.ACCENT1, weight: 3, dash: "DOT" } });
    expect(outlined({ ...outline, propertyState: "NOT_RENDERED" })).not.toHaveProperty("outline");
    expect(outlined({ weight: points(3) })).not.toHaveProperty("outline");
  });

  it("takes a fill it inherits from the layout, and the colour of a layout's hidden fill once switched on", () => {
    let deck = deckOf([
      { objectId: "a", shape: { placeholder: { type: "TITLE", parentObjectId: "l-title" },
        shapeProperties: { shapeBackgroundFill: { propertyState: "INHERIT" } } } },
      { objectId: "b", shape: { placeholder: { type: "BODY", parentObjectId: "l-body" },
        shapeProperties: { shapeBackgroundFill: { propertyState: "RENDERED" } } } },
    ]);
    deck.themePages.get("l")!.pageElements!.push({ objectId: "l-body", size: size(10, 10), transform: at(0, 0), shape: {
      placeholder: { type: "BODY" },
      shapeProperties: { shapeBackgroundFill: { propertyState: "NOT_RENDERED", ...themeFill("ACCENT4") } },
    } });
    let [inherits, switchedOn] = drawSlide(deck, "s")!.slide.elements;

    expect(inherits.kind === "shape" && inherits.fill).toEqual({ color: SIMPLE_LIGHT.ACCENT2 });
    expect(switchedOn.kind === "shape" && switchedOn.fill).toEqual({ color: SIMPLE_LIGHT.ACCENT4 });
  });

  it("draws text as Google last shrank it to fit, with its lines as much closer", () => {
    let fitted = only({ ...box, shape: {
      shapeType: "TEXT_BOX",
      shapeProperties: { autofit: { autofitType: "TEXT_AUTOFIT", fontScale: .5, lineSpacingReduction: 20 } },
      text: text({ runs: [{ content: "Long", style: { fontSize: points(24) } }], marker: { style: { lineSpacing: 115 } } }),
    } });

    expect(fitted).toMatchObject({ contentAlignment: "top", text: [{ lineSpacing: 95, runs: [{ fontSize: 12 }] }] });
  });

  it("starts a text box's text at its top and any other shape's at its middle, unless it says", () => {
    let aligned = (shapeType: string, contentAlignment?: string) => only({ ...box, shape: {
      shapeType, text: text(["x"]), shapeProperties: { contentAlignment },
    } });

    expect(aligned("TEXT_BOX")).toMatchObject({ contentAlignment: "top" });
    expect(aligned("ELLIPSE")).toMatchObject({ contentAlignment: "middle" });
    expect(aligned("ELLIPSE", "BOTTOM")).toMatchObject({ contentAlignment: "bottom" });
  });

  it("draws each list item's marker as its level of the list styles it, over the text's own style", () => {
    let item = (content: string, nestingLevel?: number) => ({
      runs: [{ content, style: { fontSize: points(18), foregroundColor: { opaqueColor: { rgbColor: { blue: 1 } } }, underline: true } }],
      marker: { bullet: { listId: "list", glyph: nestingLevel ? "○" : "●", ...(nestingLevel ? { nestingLevel } : {}) },
        style: { indentStart: points(36 * ((nestingLevel ?? 0) + 1)), indentFirstLine: points(18) } },
    });
    let body = text(item("One"), item("Two", 1));
    body.lists = { list: { nestingLevel: {
      0: { bulletStyle: { foregroundColor: { opaqueColor: { rgbColor: { red: 1 } } } } },
      1: { bulletStyle: { fontSize: points(10), bold: true } },
    } } };
    let listed = only({ ...box, shape: { shapeType: "TEXT_BOX", text: body } });

    expect(listed.kind === "shape" && listed.text).toMatchObject([
      { indentStart: 36, indentFirstLine: 18, bullet: { glyph: "●", fontSize: 18, color: "#ff0000", fontWeight: 400 } },
      { indentStart: 72, bullet: { glyph: "○", fontSize: 10, color: "#0000ff", fontWeight: 700 } },
    ]);
    // A marker is never underlined, though its paragraph's first character is.
    expect(listed.kind === "shape" && listed.text![0].bullet).not.toHaveProperty("underline");
  });
});

describe("a line as drawn", () => {
  let lineOf = (lineCategory: string, lineType: string, more: Partial<RestPageElement> = {}, properties = {}): RestPageElement => ({
    objectId: "line", size: size(100, 60), transform: at(200, 100),
    line: { lineCategory, lineType, lineProperties: {
      lineFill: { solidFill: { color: { rgbColor: { green: 1 } } } }, weight: points(2), ...properties,
    } },
    ...more,
  });
  let shapeAt = (objectId: string, x: number, y: number): RestPageElement =>
    ({ objectId, size: size(40, 40), transform: at(x, y), shape: { shapeType: "RECTANGLE" } });
  let drawnLine = (...elements: RestPageElement[]) =>
    drawSlide(deckOf(elements), "s")!.slide.elements.find(element => element.kind === "line")!;

  it("runs a straight line from its box's first corner to its last, with its ends' arrows and its dash", () => {
    let line = drawnLine(lineOf("STRAIGHT", "STRAIGHT_CONNECTOR_1", {}, {
      startArrow: "NONE", endArrow: "FILL_ARROW", dashStyle: "DASH",
    }));

    expect(line).toMatchObject({
      category: "straight", start: { x: 200, y: 100 }, end: { x: 300, y: 160 },
      stroke: { color: "#00ff00", weight: 2, dash: "DASH" }, endArrow: "FILL_ARROW",
    });
    expect(line).not.toHaveProperty("startArrow");
    expect(line).not.toHaveProperty("via");
  });

  it("runs a mirrored line from the corner its transform puts first", () => {
    let line = drawnLine(lineOf("STRAIGHT", "STRAIGHT_CONNECTOR_1", { transform: { ...at(200, 160), scaleY: -1 } }));

    expect(line).toMatchObject({ start: { x: 200, y: 160 }, end: { x: 300, y: 100 } });
  });

  it("draws a line with no colour as no stroke", () => {
    expect(drawnLine(lineOf("STRAIGHT", "STRAIGHT_CONNECTOR_1", {}, { lineFill: {} }))).not.toHaveProperty("stroke");
  });

  it("turns a connector of two legs at its box's corner", () => {
    expect(drawnLine(lineOf("BENT", "BENT_CONNECTOR_2"))).toMatchObject({ category: "bent", via: [{ x: 300, y: 100 }] });
  });

  it("puts the middle leg of a connector of three legs halfway along, bent or curved", () => {
    let via = [{ x: 250, y: 100 }, { x: 250, y: 160 }];

    expect(drawnLine(lineOf("BENT", "BENT_CONNECTOR_3"))).toMatchObject({ category: "bent", via });
    expect(drawnLine(lineOf("CURVED", "CURVED_CONNECTOR_3"))).toMatchObject({ category: "curved", via });
  });

  // Google routes such a line around the shape, and does not say where.
  it("draws a connector of three legs straight where its first leg would cross the shape it leaves", () => {
    // The line starts on the left side of a shape that lies to its right.
    let joined = lineOf("BENT", "BENT_CONNECTOR_3", {}, { startConnection: { connectedObjectId: "from", connectionSiteIndex: 1 } });

    expect(drawnLine(shapeAt("from", 200, 80), joined)).not.toHaveProperty("via");
    // Starting on the right side of a shape to its left, the first leg leaves the shape.
    expect(drawnLine(shapeAt("from", 160, 80), joined)).toHaveProperty("via");
  });

  it.each(["BENT_CONNECTOR_4", "BENT_CONNECTOR_5"])("draws a %s straight, as where it turns is not reported", lineType => {
    let line = drawnLine(lineOf("BENT", lineType));

    expect(line).toMatchObject({ category: "bent", start: { x: 200, y: 100 }, end: { x: 300, y: 160 } });
    expect(line).not.toHaveProperty("via");
  });
});

describe("a table as drawn", () => {
  let cell = (rowIndex: number, columnIndex: number, more: object = {}) => ({
    location: { ...(rowIndex ? { rowIndex } : {}), ...(columnIndex ? { columnIndex } : {}) }, ...more,
  });
  let border = (columnIndex: number, red: number) => ({
    location: columnIndex ? { columnIndex } : {},
    tableBorderProperties: { tableBorderFill: { solidFill: { color: { rgbColor: { red } } } }, weight: points(2) },
  });
  let table = (more: object = {}): RestPageElement => ({
    objectId: "table", size: size(200, 60), transform: { ...at(10, 20), scaleX: 2 },
    table: {
      rows: 2, columns: 2,
      tableColumns: [{ columnWidth: size(60, 0).width }, { columnWidth: size(40, 0).width }],
      tableRows: [
        { rowHeight: size(0, 30).height, tableCells: [
          cell(0, 0, { columnSpan: 2, text: text(["Head"]), tableCellProperties: {
            tableCellBackgroundFill: themeFill("ACCENT1"), contentAlignment: "MIDDLE",
          } }),
          cell(0, 1),
        ] },
        { rowHeight: size(0, 30).height, tableCells: [cell(1, 0, { text: text(["A"]) }), cell(1, 1)] },
      ],
      ...more,
    },
  });
  let drawnTable = (element: RestPageElement) => {
    let drawn = drawSlide(deckOf([element]), "s")!.slide.elements[0];
    if (drawn.kind !== "table") throw new Error("not a table");
    return drawn;
  };

  it("sizes its columns as its transform stretches them, and draws a merged cell once", () => {
    let drawn = drawnTable(table());

    expect(drawn.columnWidths).toEqual([120, 80]);
    expect(drawn.rowHeights).toEqual([30, 30]);
    expect(drawn.cells[0]).toMatchObject([
      { columnSpan: 2, fill: { color: SIMPLE_LIGHT.ACCENT1 }, contentAlignment: "middle", text: [{ runs: [{ text: "Head" }] }] },
      null,
    ]);
    expect(drawn.cells[1]).toMatchObject([{ text: [{ runs: [{ text: "A" }] }] }, {}]);
    expect(drawn.cells[1][1]).toEqual({});
  });

  it("draws each edge Google reports at its own colour and weight, and none where it reports none", () => {
    let drawn = drawnTable(table({
      horizontalBorderRows: [{ tableBorderCells: [border(0, 1), border(1, .5)] }, {}, { tableBorderCells: [border(1, 1)] }],
      verticalBorderRows: [{ tableBorderCells: [border(2, 1)] }, {}],
    }));

    expect(drawn.horizontalBorders).toEqual([
      [{ color: "#ff0000", weight: 2 }, { color: "#800000", weight: 2 }], [null, null], [null, { color: "#ff0000", weight: 2 }],
    ]);
    expect(drawn.verticalBorders).toEqual([[null, null, { color: "#ff0000", weight: 2 }], [null, null, null]]);
  });

  it("draws the edges of a table whose borders a pending change left unknown as a new table's", () => {
    let drawn = drawnTable(table());
    let edge = { color: SIMPLE_LIGHT.DARK1, weight: 1 };

    expect(drawn.horizontalBorders).toEqual([[edge, edge], [edge, edge], [edge, edge]]);
    expect(drawn.verticalBorders).toEqual([[edge, edge, edge], [edge, edge, edge]]);
  });
});

describe("the fonts a presentation names", () => {
  it("lists each family once with the weights its text is set in", () => {
    let deck: RestPresentation = { presentationId: "p", masters: [{ objectId: "m", pageElements: [MASTER_TITLE] }], slides: [{
      objectId: "s", pageElements: [{ objectId: "b", shape: { text: text([
        { content: "Body", style: { weightedFontFamily: { fontFamily: "Poppins", weight: 800 } } },
      ]) } }],
    }] };

    let fonts = fontsOf(deck);

    expect(fonts.map(font => font.family)).toEqual(["Oxygen", "Poppins"]);
    expect(fonts.find(font => font.family === "Poppins")!.weights).toContain(800);
    expect(fonts.find(font => font.family === "Oxygen")!.weights).toContain(700);
  });
});
