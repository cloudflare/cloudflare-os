// DrawingML tables (`a:tbl`) for the slide reader. Most of a table's look comes from its table
// style, which paints regions (the whole table, banded rows, the header row, ...) that overlap; a
// cell's own properties then override whatever the regions gave it.

import { parsePart } from "./ooxml";
import {
  findFill, mergeOutline, outlineLayer, resolveColor, type FillChoice, type OutlineLayer,
} from "./pptx-slide-color";
import type { SlideBounds, SlideColor, SlideTable, SlideTableCell, SlideTextBody } from "./pptx-slide-model";
import { readParagraphs, uniformListStyle, type ListStyle, type RunProps, type TextContext } from "./pptx-slide-text";
import { attribute, childElements, firstChild, textContent, type XmlElement } from "./xml";
import { lookupTable } from "./lookup-table";

/** What reading a table needs from the presentation around it. */
export interface TableEnvironment {
  readonly context: TextContext;
  /** The list styles under a cell's text, lowest priority first. */
  readonly styles: readonly ListStyle[];
  /** The root of `ppt/tableStyles.xml`, when the file has one. */
  readonly tableStyles: XmlElement | undefined;
}

const EMU_PER_POINT = 12700;

/**
 * "Medium Style 2 - Accent 1", the style PowerPoint gives a new table. Applications know it by
 * id and writers such as python-pptx reference it without including its definition, so a table
 * naming it would otherwise be drawn bare.
 */
const DEFAULT_STYLE_ID = "{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}";

function defaultStyleXml(): string {
  const white = (width: number) => `<a:ln w="${width}" cmpd="sng"><a:solidFill><a:schemeClr val="lt1"/></a:solidFill></a:ln>`;
  const tinted = (tint: number) => `<a:fill><a:solidFill><a:schemeClr val="accent1"><a:tint val="${tint}"/></a:schemeClr></a:solidFill></a:fill>`;
  const accent = `<a:fill><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></a:fill>`;
  const heading = (border: string) =>
    `<a:tcTxStyle b="on"><a:schemeClr val="lt1"/></a:tcTxStyle><a:tcStyle><a:tcBdr>${border}</a:tcBdr>${accent}</a:tcStyle>`;
  return `<a:tblStyle xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" styleId="${DEFAULT_STYLE_ID}">` +
    `<a:wholeTbl><a:tcTxStyle><a:schemeClr val="dk1"/></a:tcTxStyle><a:tcStyle><a:tcBdr>` +
    ["left", "right", "top", "bottom", "insideH", "insideV"].map(side => `<a:${side}>${white(12700)}</a:${side}>`).join("") +
    `</a:tcBdr>${tinted(20000)}</a:tcStyle></a:wholeTbl>` +
    `<a:band1H><a:tcStyle>${tinted(40000)}</a:tcStyle></a:band1H><a:band1V><a:tcStyle>${tinted(40000)}</a:tcStyle></a:band1V>` +
    `<a:lastCol>${heading("")}</a:lastCol><a:firstCol>${heading("")}</a:firstCol>` +
    `<a:lastRow>${heading(`<a:top>${white(38100)}</a:top>`)}</a:lastRow>` +
    `<a:firstRow>${heading(`<a:bottom>${white(38100)}</a:bottom>`)}</a:firstRow></a:tblStyle>`;
}

let defaultStyle: XmlElement | undefined;

function findTableStyle(properties: XmlElement | undefined, tableStyles: XmlElement | undefined): XmlElement | undefined {
  const idElement = firstChild(properties, "a:tableStyleId");
  const id = idElement ? textContent(idElement).trim() : "";
  if (id === "") return undefined;
  const found = childElements(tableStyles, "a:tblStyle").find(style => attribute(style, "styleId") === id);
  if (found || id !== DEFAULT_STYLE_ID) return found;
  return defaultStyle ??= parsePart(defaultStyleXml());
}

function isTrue(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

function emu(value: string | undefined): number | undefined {
  const number = Number.parseInt(value ?? "", 10);
  return Number.isFinite(number) ? number / EMU_PER_POINT : undefined;
}

function span(value: string | undefined): number {
  const number = Number.parseInt(value ?? "1", 10);
  return Number.isFinite(number) && number >= 1 ? number : 1;
}

/** A style region that covers a cell, and which way its edges face. */
interface Region {
  readonly part: XmlElement;
  /** `row` regions are one row deep, so their top and bottom are always the cell's own. */
  readonly kind: "table" | "row" | "column";
}

type Side = "left" | "right" | "top" | "bottom";
const SIDES: readonly Side[] = ["left", "right", "top", "bottom"];
const CELL_BORDERS: Readonly<Record<Side, string>> = { left: "a:lnL", right: "a:lnR", top: "a:lnT", bottom: "a:lnB" };
const ANCHORS: Readonly<Record<string, SlideTextBody["anchor"]>> = lookupTable({ t: "top", ctr: "middle", b: "bottom" });

/** Reads an `a:tbl` placed at `bounds`. */
export function readTable(table: XmlElement, bounds: SlideBounds, environment: TableEnvironment): SlideTable {
  const { context } = environment;
  const properties = firstChild(table, "a:tblPr");
  const style = findTableStyle(properties, environment.tableStyles);
  const on = (name: string) => isTrue(attribute(properties, name));
  const columnWidths = childElements(firstChild(table, "a:tblGrid"), "a:gridCol").map(column => emu(attribute(column, "w")) ?? 0);
  const rowElements = childElements(table, "a:tr");
  const rowCount = rowElements.length;
  const columnCount = columnWidths.length;

  const regionsFor = (row: number, column: number, columnSpan: number): Region[] => {
    if (!style) return [];
    const regions: Region[] = [];
    const add = (name: string, kind: Region["kind"]) => {
      const part = firstChild(style, name);
      if (part) regions.push({ part, kind });
    };
    const firstRow = on("firstRow") && row === 0;
    const lastRow = on("lastRow") && row === rowCount - 1;
    const firstColumn = on("firstCol") && column === 0;
    const lastColumn = on("lastCol") && column + columnSpan === columnCount;
    add("a:wholeTbl", "table");
    if (on("bandRow") && !firstRow && !lastRow) add((row - (on("firstRow") ? 1 : 0)) % 2 === 0 ? "a:band1H" : "a:band2H", "row");
    if (on("bandCol") && !firstColumn && !lastColumn) add((column - (on("firstCol") ? 1 : 0)) % 2 === 0 ? "a:band1V" : "a:band2V", "column");
    if (lastColumn) add("a:lastCol", "column");
    if (firstColumn) add("a:firstCol", "column");
    if (lastRow) add("a:lastRow", "row");
    if (firstRow) add("a:firstRow", "row");
    return regions;
  };

  const rows = rowElements.map((rowElement, row) => {
    const cells: SlideTableCell[] = [];
    childElements(rowElement, "a:tc").forEach((cell, column) => {
      if (isTrue(attribute(cell, "hMerge")) || isTrue(attribute(cell, "vMerge"))) return;
      const columnSpan = span(attribute(cell, "gridSpan"));
      const rowSpan = span(attribute(cell, "rowSpan"));
      const cellProperties = firstChild(cell, "a:tcPr");
      const regions = regionsFor(row, column, columnSpan);
      const outer: Readonly<Record<Side, boolean>> = {
        left: column === 0, right: column + columnSpan >= columnCount, top: row === 0, bottom: row + rowSpan >= rowCount,
      };

      let fill: FillChoice;
      let run: RunProps = {};
      const borders: Record<Side, OutlineLayer[]> = { left: [], right: [], top: [], bottom: [] };
      for (const region of regions) {
        const cellStyle = firstChild(region.part, "a:tcStyle");
        fill = findFill(firstChild(cellStyle, "a:fill"), context) ?? fill;
        run = { ...run, ...regionRunProps(firstChild(region.part, "a:tcTxStyle"), context) };
        const regionBorders = firstChild(cellStyle, "a:tcBdr");
        for (const side of SIDES) {
          const horizontal = side === "top" || side === "bottom";
          const faces = region.kind === "table" ? outer[side] : region.kind === "row" ? horizontal || outer[side] : !horizontal || outer[side];
          const edge = firstChild(regionBorders, faces ? `a:${side}` : horizontal ? "a:insideH" : "a:insideV");
          borders[side].unshift(outlineLayer(firstChild(edge, "a:ln"), context));
        }
      }
      fill = findFill(cellProperties, context) ?? fill;
      for (const side of SIDES) borders[side].unshift(outlineLayer(firstChild(cellProperties, CELL_BORDERS[side]), context));

      const body = firstChild(cell, "a:txBody");
      const outline = (side: Side) => {
        const merged = mergeOutline(borders[side]);
        return merged ? { [side]: merged } : {};
      };
      cells.push({
        column, columnSpan, rowSpan,
        ...(fill && fill !== "none" ? { fill } : {}),
        borders: { ...outline("left"), ...outline("top"), ...outline("right"), ...outline("bottom") },
        text: {
          insets: {
            left: emu(attribute(cellProperties, "marL")) ?? 7.2, top: emu(attribute(cellProperties, "marT")) ?? 3.6,
            right: emu(attribute(cellProperties, "marR")) ?? 7.2, bottom: emu(attribute(cellProperties, "marB")) ?? 3.6,
          },
          anchor: ANCHORS[attribute(cellProperties, "anchor") ?? ""] ?? "top",
          wrap: true,
          direction: attribute(cellProperties, "vert") === "vert270" ? "rotate270"
            : (attribute(cellProperties, "vert") ?? "horz") === "horz" ? "horizontal" : "rotate90",
          fontScale: 1,
          lineSpacingReduction: 0,
          paragraphs: body ? readParagraphs(body, [...environment.styles, uniformListStyle(run)], context) : [],
        },
      });
    });
    return { height: emu(attribute(rowElement, "h")) ?? 0, cells };
  });
  return { kind: "table", bounds, columnWidths, rows };
}

/** A region's `a:tcTxStyle`: weight, slant, color and theme font for the text of the cells it covers. */
function regionRunProps(style: XmlElement | undefined, context: TextContext): RunProps {
  if (!style) return {};
  const color: SlideColor | undefined = resolveColor(style, context);
  const font = attribute(firstChild(style, "a:fontRef"), "idx");
  const state = (name: string) => {
    const value = attribute(style, name);
    return value === "on" ? true : value === "off" ? false : undefined;
  };
  const bold = state("b");
  const italic = state("i");
  return {
    ...(bold === undefined ? {} : { bold }),
    ...(italic === undefined ? {} : { italic }),
    ...(color ? { color } : {}),
    ...(font === "major" ? { font: "+mj-lt" } : font === "minor" ? { font: "+mn-lt" } : {}),
  };
}
