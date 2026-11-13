import { describe, expect, it } from "vitest";
import { MAX_SLIDES, readPptxSlides, type SlideDeck, type SlideDrawnShape, type SlideShape } from "../src/pptx-slides";
import { buildDeck, drawnShape, slideParagraph, transform, type DeckFixture } from "./test-fixtures";

async function deckOf(fixture: DeckFixture): Promise<SlideDeck> {
  return readPptxSlides(await buildDeck(fixture));
}

/** The shapes of the deck's first slide. */
async function shapesOf(fixture: DeckFixture): Promise<readonly SlideShape[]> {
  return (await deckOf(fixture)).slides[0]!.shapes;
}

function drawn(shape: SlideShape | undefined): SlideDrawnShape {
  if (shape?.kind !== "shape") throw new Error(`Expected a drawn shape, got ${shape?.kind}`);
  return shape;
}

const solid = (hex: string, transforms = "") => `<a:solidFill><a:srgbClr val="${hex}">${transforms}</a:srgbClr></a:solidFill>`;
const scheme = (name: string, transforms = "") => `<a:solidFill><a:schemeClr val="${name}">${transforms}</a:schemeClr></a:solidFill>`;
const INCH = 914400;

describe("readPptxSlides", () => {
  it("reports the slide size in points and skips hidden slides without renumbering the rest", async () => {
    const text = (value: string) => drawnShape({ properties: transform(0, 0, INCH, INCH), body: slideParagraph(value) });
    const deck = await deckOf({
      size: { cx: 12192000, cy: 6858000 },
      slides: [{ shapes: text("One") }, { shapes: text("Two"), hidden: true }, { shapes: text("Three") }],
    });
    expect([deck.width, deck.height]).toEqual([960, 540]);
    expect(deck.slides.map(slide => slide.number)).toEqual([1, 3]);
    expect(deck.truncated).toBe(false);
    expect(deck.unsupported).toEqual([]);
  });

  it("caps the slides it returns and says so", async () => {
    const deck = await deckOf({ slides: Array.from({ length: MAX_SLIDES + 1 }, () => ({ shapes: "" })) });
    expect(deck.slides).toHaveLength(MAX_SLIDES);
    expect(deck.truncated).toBe(true);
  });

  describe("inheritance", () => {
    const masterTitle = drawnShape({
      placeholder: '<p:ph type="title"/>',
      properties: transform(INCH, INCH, 8 * INCH, INCH),
      body: slideParagraph("Master title"),
    });
    const textStyles =
      `<p:titleStyle><a:lvl1pPr algn="ctr"><a:defRPr sz="4400"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mj-lt"/></a:defRPr></a:lvl1pPr></p:titleStyle>` +
      `<p:bodyStyle>` +
      `<a:lvl1pPr marL="342900" indent="-342900"><a:spcBef><a:spcPct val="20000"/></a:spcBef><a:buChar char="•"/><a:defRPr sz="3200"/></a:lvl1pPr>` +
      `<a:lvl2pPr marL="742950" indent="-285750"><a:buChar char="–"/><a:defRPr sz="2800"/></a:lvl2pPr>` +
      `</p:bodyStyle>`;

    it("takes a placeholder's geometry from the layout, then the master", async () => {
      const fromLayout = await shapesOf({
        masterShapes: masterTitle,
        layoutShapes: drawnShape({ placeholder: '<p:ph type="ctrTitle"/>', properties: transform(2 * INCH, 3 * INCH, 6 * INCH, 2 * INCH), body: "" }),
        slides: [{ shapes: drawnShape({ placeholder: '<p:ph type="ctrTitle"/>', body: slideParagraph("Title") }) }],
      });
      expect(fromLayout).toHaveLength(1);
      expect(fromLayout[0]!.bounds).toMatchObject({ x: 144, y: 216, width: 432, height: 144 });

      const fromMaster = await shapesOf({
        masterShapes: masterTitle,
        layoutShapes: drawnShape({ placeholder: '<p:ph type="title"/>', body: "" }),
        slides: [{ shapes: drawnShape({ placeholder: '<p:ph type="title"/>', body: slideParagraph("Title") }) }],
      });
      expect(fromMaster[0]!.bounds).toMatchObject({ x: 72, y: 72, width: 576, height: 72 });
    });

    it("resolves run properties through the master's text styles, the layout's list style, the paragraph and the run", async () => {
      const [title] = await shapesOf({
        masterShapes: masterTitle,
        textStyles,
        defaultTextStyle: `<a:lvl1pPr><a:defRPr sz="1800" i="1"/></a:lvl1pPr>`,
        layoutShapes: drawnShape({
          placeholder: '<p:ph type="title"/>',
          listStyle: `<a:lvl1pPr><a:defRPr b="1">${solid("FF0000")}</a:defRPr></a:lvl1pPr>`,
          body: "",
        }),
        slides: [{
          shapes: drawnShape({
            placeholder: '<p:ph type="title"/>',
            body: `<a:p><a:pPr algn="r"/><a:r><a:t>Plain</a:t></a:r><a:r><a:rPr sz="2000" b="0"><a:latin typeface="Arial"/></a:rPr><a:t>Own</a:t></a:r></a:p>`,
          }),
        }],
      });
      const paragraph = drawn(title).text!.paragraphs[0]!;
      expect(paragraph.align).toBe("right");
      expect(paragraph.bullet).toBeUndefined();
      // Size and theme font from the master, weight and color from the layout, slant from the presentation.
      expect(paragraph.runs[0]).toMatchObject({ text: "Plain", size: 44, font: "Cambria", bold: true, italic: true, color: { hex: "FF0000", alpha: 1 } });
      expect(paragraph.runs[1]).toMatchObject({ text: "Own", size: 20, font: "Arial", bold: false, italic: true });
    });

    it("gives body paragraphs their level's bullet, indent and spacing", async () => {
      const [body] = await shapesOf({
        masterShapes: drawnShape({ placeholder: '<p:ph type="body" idx="1"/>', properties: transform(INCH, 2 * INCH, 8 * INCH, 4 * INCH), body: "" }),
        textStyles,
        slides: [{
          shapes: drawnShape({
            placeholder: '<p:ph idx="1"/>',
            body: slideParagraph("Top") + slideParagraph("Nested", 'lvl="1"') + "<a:p><a:pPr><a:buNone/></a:pPr><a:r><a:t>Bare</a:t></a:r></a:p><a:p/>",
          }),
        }],
      });
      const [top, nested, bare, empty] = drawn(body).text!.paragraphs;
      expect(top).toMatchObject({ level: 0, marginLeft: 27, indent: -27, fontSize: 32, bullet: { text: "•", size: 32, font: "Calibri" } });
      expect(top!.spaceBefore).toBeCloseTo(0.2 * 32 * 1.2);
      expect(nested).toMatchObject({ level: 1, marginLeft: 58.5, indent: -22.5, fontSize: 28, bullet: { text: "–" } });
      expect(bare!.bullet).toBeUndefined();
      // An empty paragraph keeps its line but shows no bullet.
      expect(empty).toMatchObject({ runs: [], fontSize: 32 });
      expect(empty!.bullet).toBeUndefined();
    });

    it("numbers automatic lists and fills in the slide number field", async () => {
      const numbered = (text: string, level = 0) =>
        `<a:p><a:pPr lvl="${level}"><a:buAutoNum type="${level === 0 ? "arabicPeriod" : "alphaLcParenR"}"/></a:pPr><a:r><a:t>${text}</a:t></a:r></a:p>`;
      const deck = await deckOf({
        slides: [{ shapes: "", hidden: true }, {
          shapes: drawnShape({ properties: transform(0, 0, INCH, INCH), body: numbered("a") + numbered("b") + numbered("c", 1) + numbered("d", 1) + numbered("e") }) +
            drawnShape({ properties: transform(0, 0, INCH, INCH), body: `<a:p><a:fld type="slidenum"><a:t>‹#›</a:t></a:fld></a:p>` }),
        }],
      });
      const [list, field] = deck.slides[0]!.shapes;
      expect(drawn(list).text!.paragraphs.map(paragraph => paragraph.bullet?.text)).toEqual(["1.", "2.", "a)", "b)", "3."]);
      expect(drawn(field).text!.paragraphs[0]!.runs[0]!.text).toBe("2");
    });

    it("reads insets, anchor and shrink-on-overflow from the nearest body properties", async () => {
      const master = `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr>${transform(0, 0, INCH, INCH)}</p:spPr>` +
        `<p:txBody><a:bodyPr lIns="0" anchor="ctr"><a:normAutofit fontScale="62500" lnSpcReduction="20000"/></a:bodyPr><a:p/></p:txBody></p:sp>`;
      const [title] = await shapesOf({
        masterShapes: master,
        slides: [{ shapes: drawnShape({ placeholder: '<p:ph type="title"/>', body: slideParagraph("Title") }) }],
      });
      expect(drawn(title).text).toMatchObject({
        insets: { left: 0, top: 3.6, right: 7.2, bottom: 3.6 }, anchor: "middle", wrap: true, fontScale: 0.625, lineSpacingReduction: 0.2,
      });
    });

    it("draws the layout's and master's own shapes behind the slide's, but not their placeholders", async () => {
      const box = (hex: string) => drawnShape({ properties: transform(0, 0, INCH, INCH) + solid(hex) });
      const fixture: DeckFixture = {
        masterShapes: box("111111") + drawnShape({ placeholder: '<p:ph type="title"/>', properties: transform(0, 0, INCH, INCH) + solid("AAAAAA"), body: slideParagraph("Prompt") }),
        layoutShapes: box("222222"),
        slides: [{ shapes: box("333333") }, { shapes: box("333333"), attributes: 'showMasterSp="0"' }],
      };
      const deck = await deckOf(fixture);
      const fills = (index: number) => deck.slides[index]!.shapes.map(shape => { const fill = drawn(shape).fill; return fill?.kind === "solid" ? fill.color.hex : undefined; });
      expect(fills(0)).toEqual(["111111", "222222", "333333"]);
      expect(fills(1)).toEqual(["333333"]);
    });

    it("inherits the background from the master until a slide states its own", async () => {
      const deck = await deckOf({
        masterBackground: `<p:bg><p:bgRef idx="1001"><a:schemeClr val="bg2"/></p:bgRef></p:bg>`,
        slides: [
          { shapes: "" },
          { shapes: "", background: `<p:bg><p:bgPr><a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="FF0000"/></a:gs><a:gs pos="100000"><a:srgbClr val="0000FF"/></a:gs></a:gsLst><a:lin ang="5400000"/></a:gradFill></p:bgPr></p:bg>` },
        ],
      });
      expect(deck.slides[0]!.background).toEqual({ kind: "solid", color: { hex: "EEECE1", alpha: 1 } });
      expect(deck.slides[1]!.background).toEqual({
        kind: "gradient", angle: 90,
        stops: [{ position: 0, color: { hex: "FF0000", alpha: 1 } }, { position: 1, color: { hex: "0000FF", alpha: 1 } }],
      });
    });

    it("paints a slide nothing paints white", async () => {
      const deck = await deckOf({ slides: [{ shapes: "" }] });
      expect(deck.slides[0]!.background).toEqual({ kind: "solid", color: { hex: "FFFFFF", alpha: 1 } });
    });
  });

  describe("colors", () => {
    const fillOf = async (fill: string, slide: Partial<DeckFixture["slides"][number]> = {}) => {
      const [shape] = await shapesOf({ slides: [{ shapes: drawnShape({ properties: transform(0, 0, INCH, INCH) + fill }), ...slide }] });
      const found = drawn(shape).fill;
      if (found?.kind !== "solid") throw new Error("Expected a solid fill");
      return found.color;
    };

    it("maps scheme colors through the master's color map", async () => {
      expect(await fillOf(scheme("tx1"))).toEqual({ hex: "000000", alpha: 1 });
      expect(await fillOf(scheme("bg2"))).toEqual({ hex: "EEECE1", alpha: 1 });
      expect(await fillOf(scheme("accent1"))).toEqual({ hex: "4F81BD", alpha: 1 });
    });

    it("lets a slide override the color map", async () => {
      const override = `<a:overrideClrMapping bg1="dk1" tx1="lt1" bg2="dk2" tx2="lt2" accent1="accent2"/>`;
      expect(await fillOf(scheme("tx1"), { colorMapOverride: override })).toEqual({ hex: "FFFFFF", alpha: 1 });
      expect(await fillOf(scheme("accent1"), { colorMapOverride: override })).toEqual({ hex: "C0504D", alpha: 1 });
    });

    it("applies tint and shade in linear light, as PowerPoint does", async () => {
      // PowerPoint's "Text 1, 75% tint" subtitle gray.
      expect((await fillOf(scheme("tx1", '<a:tint val="75000"/>'))).hex).toBe("898989");
      // The default table style's banding: accent 1 at 40% and 20%.
      expect((await fillOf(scheme("accent1", '<a:tint val="40000"/>'))).hex).toBe("D0D8E8");
      expect((await fillOf(scheme("accent1", '<a:tint val="20000"/>'))).hex).toBe("E9EDF4");
      expect((await fillOf(solid("FFFFFF", '<a:shade val="50000"/>'))).hex).toBe("BCBCBC");
    });

    it("applies luminance and alpha transforms", async () => {
      // "Blue, Accent 1, Darker 25%" and "Lighter 40%" in PowerPoint's color picker.
      expect((await fillOf(scheme("accent1", '<a:lumMod val="75000"/>'))).hex).toBe("376092");
      expect((await fillOf(scheme("accent1", '<a:lumMod val="60000"/><a:lumOff val="40000"/>'))).hex).toBe("95B3D7");
      expect(await fillOf(solid("FF0000", '<a:alpha val="50000"/>'))).toEqual({ hex: "FF0000", alpha: 0.5 });
    });

    it("resolves a shape style's theme fill, line and font references", async () => {
      const [shape] = await shapesOf({
        slides: [{
          shapes: drawnShape({
            properties: transform(0, 0, INCH, INCH) + `<a:prstGeom prst="roundRect"><a:avLst/></a:prstGeom>`,
            style: `<a:lnRef idx="1"><a:schemeClr val="accent1"><a:shade val="50000"/></a:schemeClr></a:lnRef>` +
              `<a:fillRef idx="1"><a:schemeClr val="accent1"/></a:fillRef><a:effectRef idx="0"/>` +
              `<a:fontRef idx="major"><a:schemeClr val="lt1"/></a:fontRef>`,
            body: slideParagraph("Styled"),
          }),
        }],
      });
      const styled = drawn(shape);
      expect(styled.geometry).toBe("roundRect");
      expect(styled.cornerRadius).toBeCloseTo(72 * 0.16667);
      expect(styled.fill).toEqual({ kind: "solid", color: { hex: "4F81BD", alpha: 1 } });
      expect(styled.outline).toMatchObject({ width: 0.75, dash: "solid" });
      expect(styled.text!.paragraphs[0]!.runs[0]).toMatchObject({ font: "Cambria", color: { hex: "FFFFFF" } });
    });

    it("leaves out a shape with no fill, outline or text", async () => {
      const shapes = await shapesOf({
        slides: [{ shapes: drawnShape({ properties: transform(0, 0, INCH, INCH) + "<a:noFill/><a:ln><a:noFill/></a:ln>", body: "<a:p/>" }) }],
      });
      expect(shapes).toEqual([]);
    });
  });

  describe("groups", () => {
    const group = (transformXml: string, children: string) =>
      `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="9" name="Group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr>${transformXml}</p:grpSpPr>${children}</p:grpSp>`;
    const groupTransform = (x: number, y: number, cx: number, cy: number, childX: number, childY: number, childCx: number, childCy: number, attributes = "") =>
      `<a:xfrm ${attributes}><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/><a:chOff x="${childX}" y="${childY}"/><a:chExt cx="${childCx}" cy="${childCy}"/></a:xfrm>`;
    const child = (x: number, y: number, cx: number, cy: number) => drawnShape({ properties: transform(x, y, cx, cy) + solid("000000") });

    it("maps children from the group's child space into its box", async () => {
      const [shape] = await shapesOf({
        slides: [{ shapes: group(groupTransform(INCH, INCH, 2 * INCH, INCH, 0, 0, 4 * INCH, 2 * INCH), child(INCH, INCH, 2 * INCH, INCH)) }],
      });
      expect(shape!.bounds).toMatchObject({ x: 72 + 36, y: 72 + 36, width: 72, height: 36, rotation: 0 });
    });

    it("composes nested groups", async () => {
      const inner = group(groupTransform(2 * INCH, 0, 2 * INCH, 2 * INCH, 0, 0, INCH, INCH), child(0, 0, INCH / 2, INCH / 2));
      const [shape] = await shapesOf({
        slides: [{ shapes: group(groupTransform(0, INCH, 2 * INCH, INCH, 0, 0, 4 * INCH, 2 * INCH), inner) }],
      });
      // The inner group doubles the child and moves it 2in right; the outer halves that and moves it 1in down.
      expect(shape!.bounds).toMatchObject({ x: 72, y: 72, width: 36, height: 36 });
    });

    it("turns and mirrors children with their group", async () => {
      const [turned] = await shapesOf({
        slides: [{ shapes: group(groupTransform(0, 0, 2 * INCH, 2 * INCH, 0, 0, 2 * INCH, 2 * INCH, 'rot="5400000"'), child(0, 0, INCH, INCH)) }],
      });
      // A quarter turn about the group's center carries the top-left quadrant to the top right.
      expect(turned!.bounds.x).toBeCloseTo(72);
      expect(turned!.bounds.y).toBeCloseTo(0);
      expect(turned!.bounds.rotation).toBe(90);

      const [mirrored] = await shapesOf({
        slides: [{ shapes: group(groupTransform(0, 0, 2 * INCH, 2 * INCH, 0, 0, 2 * INCH, 2 * INCH, 'flipH="1"'), child(0, 0, INCH, INCH)) }],
      });
      expect(mirrored!.bounds).toMatchObject({ x: 72, y: 0, flipH: true, flipV: false });
    });
  });

  describe("tables", () => {
    const cell = (text: string, properties = "", attributes = "") =>
      `<a:tc ${attributes}><a:txBody><a:bodyPr/><a:lstStyle/>${slideParagraph(text)}</a:txBody>${properties ? properties : "<a:tcPr/>"}</a:tc>`;
    const frame = (table: string) =>
      `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="Table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>` +
      `<p:xfrm><a:off x="${INCH}" y="${2 * INCH}"/><a:ext cx="${4 * INCH}" cy="${INCH}"/></p:xfrm>` +
      `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">${table}</a:graphicData></a:graphic></p:graphicFrame>`;
    const grid = `<a:tblGrid><a:gridCol w="${2 * INCH}"/><a:gridCol w="${2 * INCH}"/></a:tblGrid>`;
    const row = (cells: string) => `<a:tr h="${INCH / 2}">${cells}</a:tr>`;

    it("paints a table that names PowerPoint's default style, whose definition files leave out", async () => {
      const [table] = await shapesOf({
        slides: [{
          shapes: frame(`<a:tbl><a:tblPr firstRow="1" bandRow="1"><a:tableStyleId>{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}</a:tableStyleId></a:tblPr>${grid}` +
            row(cell("Region") + cell("Revenue")) + row(cell("EMEA") + cell("$1.2M")) + row(cell("Americas") + cell("$2.4M")) + `</a:tbl>`),
        }],
      });
      if (table?.kind !== "table") throw new Error("Expected a table");
      expect(table.bounds).toMatchObject({ x: 72, y: 144 });
      expect(table.columnWidths).toEqual([144, 144]);
      expect(table.rows.map(tableRow => tableRow.height)).toEqual([36, 36, 36]);
      const hex = (rowIndex: number) => { const fill = table.rows[rowIndex]!.cells[0]!.fill; return fill?.kind === "solid" ? fill.color.hex : undefined; };
      expect([hex(0), hex(1), hex(2)]).toEqual(["4F81BD", "D0D8E8", "E9EDF4"]);
      const header = table.rows[0]!.cells[0]!;
      expect(header.text.paragraphs[0]!.runs[0]).toMatchObject({ text: "Region", bold: true, color: { hex: "FFFFFF" }, size: 18 });
      expect(header.borders.bottom).toMatchObject({ width: 3, color: { hex: "FFFFFF" } });
      expect(header.borders.top).toMatchObject({ width: 1 });
      expect(table.rows[1]!.cells[1]!.text.paragraphs[0]!.runs[0]).toMatchObject({ text: "$1.2M", bold: false, color: { hex: "000000" } });
    });

    it("reads a cell's own fill, borders, margins and anchor, and leaves out merged-away cells", async () => {
      const own = `<a:tcPr marL="0" anchor="ctr"><a:lnB w="25400"><a:solidFill><a:srgbClr val="00FF00"/></a:solidFill><a:prstDash val="dash"/></a:lnB>${solid("FFFF00")}</a:tcPr>`;
      const [table] = await shapesOf({
        slides: [{
          shapes: frame(`<a:tbl><a:tblPr/>${grid}` + row(cell("Wide", own, 'gridSpan="2"') + cell("", "", 'hMerge="1"')) + row(cell("Left") + cell("Right")) + `</a:tbl>`),
        }],
      });
      if (table?.kind !== "table") throw new Error("Expected a table");
      expect(table.rows[0]!.cells).toHaveLength(1);
      const wide = table.rows[0]!.cells[0]!;
      expect(wide).toMatchObject({ column: 0, columnSpan: 2, rowSpan: 1, fill: { kind: "solid", color: { hex: "FFFF00" } } });
      expect(wide.borders).toEqual({ bottom: { width: 2, color: { hex: "00FF00", alpha: 1 }, dash: "dash" } });
      expect(wide.text).toMatchObject({ anchor: "middle", insets: { left: 0, right: 7.2 } });
      expect(table.rows[1]!.cells.map(tableCell => tableCell.column)).toEqual([0, 1]);
      expect(table.rows[1]!.cells[0]!.fill).toBeUndefined();
    });
  });

  describe("pictures and other content", () => {
    const picture = (blip: string) =>
      `<p:pic><p:nvPicPr><p:cNvPr id="5" name="Picture" descr="A chart of sales"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>` +
      `<p:blipFill>${blip}<a:srcRect l="10000" b="25000"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
      `<p:spPr>${transform(INCH, INCH, 2 * INCH, INCH)}</p:spPr></p:pic>`;
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

    it("returns an embedded picture's bytes, type, crop and description", async () => {
      const [shape] = await shapesOf({
        parts: [{ name: "ppt/media/image1.png", data: png }],
        slides: [{ shapes: picture('<a:blip r:embed="rId2"/>'), relationships: [{ id: "rId2", type: "image", target: "../media/image1.png" }] }],
      });
      expect(shape).toMatchObject({
        kind: "picture", bounds: { x: 72, y: 72, width: 144, height: 72 }, description: "A chart of sales",
        image: { contentType: "image/png" }, crop: { left: 0.1, top: 0, right: 0, bottom: 0.25 },
      });
      if (shape?.kind !== "picture") throw new Error("Expected a picture");
      expect([...shape.image.bytes]).toEqual([...png]);
    });

    it("prefers the SVG a blip carries over its raster fallback", async () => {
      const blip = `<a:blip r:embed="rId2"><a:extLst><a:ext uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}">` +
        `<asvg:svgBlip xmlns:asvg="http://schemas.microsoft.com/office/drawing/2016/SVG/main" r:embed="rId3"/></a:ext></a:extLst></a:blip>`;
      const [shape] = await shapesOf({
        parts: [{ name: "ppt/media/image1.png", data: png }, { name: "ppt/media/image2.svg", data: "<svg xmlns='http://www.w3.org/2000/svg'/>" }],
        slides: [{
          shapes: picture(blip),
          relationships: [{ id: "rId2", type: "image", target: "../media/image1.png" }, { id: "rId3", type: "image", target: "../media/image2.svg" }],
        }],
      });
      expect(shape).toMatchObject({ kind: "picture", image: { contentType: "image/svg+xml" } });
    });

    it("never follows an external picture relationship", async () => {
      const deck = await deckOf({
        slides: [{
          shapes: picture('<a:blip r:embed="rId2"/>') + picture('<a:blip r:link="rId2"/>'),
          relationships: [{ id: "rId2", type: "image", target: "https://example.com/tracker.png", external: true }],
        }],
      });
      expect(deck.slides[0]!.shapes).toEqual([
        { kind: "unsupported", what: "picture", bounds: expect.objectContaining({ x: 72, y: 72 }) },
        { kind: "unsupported", what: "picture", bounds: expect.objectContaining({ x: 72, y: 72 }) },
      ]);
      expect(deck.unsupported).toEqual(["picture"]);
    });

    it("does not take a picture from outside the media a slide relates to", async () => {
      const shapes = await shapesOf({
        parts: [{ name: "ppt/media/image1.emf", data: png }],
        slides: [{
          shapes: picture('<a:blip r:embed="rId2"/>') + picture('<a:blip r:embed="rId3"/>'),
          relationships: [{ id: "rId2", type: "image", target: "../media/image1.emf" }, { id: "rId3", type: "image", target: "../media/missing.png" }],
        }],
      });
      expect(shapes.map(shape => shape.kind)).toEqual(["unsupported", "unsupported"]);
    });

    it("returns charts and SmartArt as labelled bounds", async () => {
      const frame = (uri: string) =>
        `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="Frame"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>` +
        `<p:xfrm><a:off x="${INCH}" y="${INCH}"/><a:ext cx="${INCH}" cy="${INCH}"/></p:xfrm>` +
        `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/${uri}"/></a:graphic></p:graphicFrame>`;
      const deck = await deckOf({ slides: [{ shapes: frame("chart") + frame("diagram") + frame("ole") }] });
      expect(deck.slides[0]!.shapes.map(shape => shape.kind === "unsupported" && shape.what)).toEqual(["chart", "diagram", "object"]);
      expect(deck.slides[0]!.shapes[0]!.bounds).toMatchObject({ x: 72, y: 72, width: 72, height: 72 });
      expect(deck.unsupported).toEqual(["chart", "diagram", "object"]);
    });

    it("reads lines, ellipses and outlines", async () => {
      const [line, ellipse] = await shapesOf({
        slides: [{
          shapes: `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="7" name="Line"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr>` +
            `<p:spPr>${transform(0, 0, INCH, 0, 'flipV="1"')}<a:prstGeom prst="line"><a:avLst/></a:prstGeom><a:ln w="38100">${solid("FF0000")}<a:prstDash val="sysDot"/></a:ln></p:spPr></p:cxnSp>` +
            drawnShape({ properties: transform(0, 0, INCH, INCH) + `<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom>` + solid("00FF00") + "<a:ln><a:noFill/></a:ln>" }),
        }],
      });
      expect(line).toMatchObject({ kind: "shape", geometry: "line", bounds: { width: 72, height: 0, flipV: true }, outline: { width: 3, dash: "dot", color: { hex: "FF0000" } } });
      expect(drawn(ellipse)).toMatchObject({ geometry: "ellipse", fill: { kind: "solid" } });
      expect(drawn(ellipse).outline).toBeUndefined();
    });
  });

  it("refuses a file that is not a presentation", async () => {
    await expect(readPptxSlides(new Uint8Array([1, 2, 3]))).rejects.toThrow();
  });
});
