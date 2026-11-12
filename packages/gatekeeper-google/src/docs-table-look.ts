// The look of a Google Docs table, as `getContent()` writes it into the table's HTML: each cell's
// shading, alignment, padding and borders, each column's width and each row's minimum height.
// One look reads as one byte-exact set of opening tags, so a replay can write the tags a fresh
// read would show, and reading the tags back gives the look again.

import type { Dimension, OptionalColor, Table, TableCellBorder, TableCellStyle } from "./docs-api";

/** The CSS longhands a cell's look is written with, in the order they are written. */
export const LONGHANDS = [
  "background-color", "vertical-align",
  "padding-top", "padding-right", "padding-bottom", "padding-left",
  "border-top", "border-right", "border-bottom", "border-left",
] as const;

/** One of `LONGHANDS`. */
export type Longhand = typeof LONGHANDS[number];

/** The four sides of a cell, in the order CSS names them. */
export const SIDES = ["top", "right", "bottom", "left"] as const;

/** One of `SIDES`. */
export type Side = typeof SIDES[number];

/**
 * A cell's look, every longhand set to its canonical value: `background-color` a `#rrggbb` or
 * `transparent`; `vertical-align` `top`, `middle` or `bottom`; a padding `<n>pt`; a border
 * `<n>pt solid|dotted|dashed #rrggbb`, or `none` for one Google draws 0pt wide.
 */
export type CellLook = Readonly<Record<Longhand, string>>;

/**
 * A table's look. `cells` has one entry for each cell of each row, `null` for a cell a merged
 * cell covers; a merged cell's look is that of the block it shows, its right and bottom borders
 * those Google keeps on the block's last column and row. `columns`, when given, has each
 * column's fixed width in points, or `null` for one sharing the width the fixed ones leave;
 * left out, every column shares it. `rows` has each row's minimum height in points, 0 for one
 * as tall as its text.
 */
export type TableLook = {
  cells: (CellLook | null)[][];
  columns?: (number | null)[];
  rows: number[];
};

/** The border Google Docs draws where a table sets none. */
export const DEFAULT_BORDER = "1pt solid #000000";

/** What a cell looks like where Google Docs stores nothing: a table `insertTable` adds. */
export const DEFAULT_CELL: CellLook = {
  "background-color": "transparent",
  "vertical-align": "top",
  "padding-top": "5pt", "padding-right": "5pt", "padding-bottom": "5pt", "padding-left": "5pt",
  "border-top": DEFAULT_BORDER, "border-right": DEFAULT_BORDER,
  "border-bottom": DEFAULT_BORDER, "border-left": DEFAULT_BORDER,
};

/** A length in points as the look writes it: at most three decimals, and no `-0`. */
export function points(magnitude: number): string {
  let rounded = Number(magnitude.toFixed(3));
  return `${rounded === 0 ? 0 : rounded}pt`;
}

function hexByte(component: number | undefined): string {
  return Math.round(Math.min(Math.max(component ?? 0, 0), 1) * 255).toString(16).padStart(2, "0");
}

/** A colour as `#rrggbb`, each component clamped to [0, 1]. Google omits a zero component. */
export function hexColor(rgb: { red?: number; green?: number; blue?: number }): string {
  return `#${hexByte(rgb.red)}${hexByte(rgb.green)}${hexByte(rgb.blue)}`;
}

const DASHES: Record<string, string> = { SOLID: "solid", DOT: "dotted", DASH: "dashed" };

const ALIGNMENTS: Record<string, string> = { TOP: "top", MIDDLE: "middle", BOTTOM: "bottom" };

function colorOf(color: OptionalColor | undefined): string | undefined {
  return color?.color?.rgbColor ? hexColor(color.color.rgbColor) : undefined;
}

// A length Google stores: absent, the default; present without a magnitude, 0, as Google omits
// every zero.
function lengthOf(dimension: Dimension | undefined, fallback: string): string {
  return dimension ? points(dimension.magnitude ?? 0) : fallback;
}

function borderOf(border: TableCellBorder | undefined): string {
  if (!border) return DEFAULT_BORDER;
  let width = border.width?.magnitude ?? 0;
  let color = colorOf(border.color);
  // Google refuses a border without a colour, and draws none 0pt wide.
  if (width === 0 || color === undefined) return "none";
  return `${points(width)} ${DASHES[border.dashStyle ?? "SOLID"] ?? "solid"} ${color}`;
}

/** The look of a cell Google stores `style` for; `right` and `bottom` give those edges' styles. */
function cellLookOf(
  style: TableCellStyle | undefined, right: TableCellStyle | undefined,
  bottom: TableCellStyle | undefined,
): CellLook {
  return {
    "background-color": colorOf(style?.backgroundColor) ?? "transparent",
    "vertical-align": ALIGNMENTS[style?.contentAlignment ?? ""] ?? "top",
    "padding-top": lengthOf(style?.paddingTop, "5pt"),
    "padding-right": lengthOf(style?.paddingRight, "5pt"),
    "padding-bottom": lengthOf(style?.paddingBottom, "5pt"),
    "padding-left": lengthOf(style?.paddingLeft, "5pt"),
    "border-top": borderOf(style?.borderTop),
    "border-right": borderOf(right?.borderRight),
    "border-bottom": borderOf(bottom?.borderBottom),
    "border-left": borderOf(style?.borderLeft),
  };
}

/** A cell's spans, as a table's cells carry them. */
export type Spans = { rowSpan: number; columnSpan: number };

/**
 * Which cells of a table a merged cell covers: a cell that spans rows or columns covers every
 * other cell its spans reach, below it and to its right.
 */
export function coveredCells(rows: readonly (readonly Spans[])[]): boolean[][] {
  let covered = rows.map(row => row.map(() => false));
  rows.forEach((row, r) => row.forEach(({ rowSpan, columnSpan }, c) => {
    if (covered[r][c]) return;
    for (let down = r; down < Math.min(r + rowSpan, rows.length); down++) {
      for (let across = c; across < Math.min(c + columnSpan, rows[down].length); across++) {
        if (down !== r || across !== c) covered[down][across] = true;
      }
    }
  }));
  return covered;
}

// The last row or column a cell at `at` spans, of `limit`.
function lastSpanned(span: number | undefined, limit: number, at: number): number {
  return Math.min(at + Math.max(span ?? 1, 1), limit) - 1;
}

/** The look of a table as Google Docs stores it. */
export function lookOfTable(table: Table): TableLook {
  let rows = table.tableRows ?? [];
  let styles = rows.map(row => (row.tableCells ?? []).map(cell => cell.tableCellStyle));
  let covered = coveredCells(styles.map(row => row.map(style => ({
    rowSpan: Math.max(style?.rowSpan ?? 1, 1), columnSpan: Math.max(style?.columnSpan ?? 1, 1),
  }))));
  let cells = styles.map((row, r) => row.map((style, c) => {
    if (covered[r][c]) return null;
    let right = row[lastSpanned(style?.columnSpan, row.length, c)];
    let bottom = styles[lastSpanned(style?.rowSpan, styles.length, r)]?.[c];
    return cellLookOf(style, right, bottom);
  }));
  let properties = table.tableStyle?.tableColumnProperties ?? [];
  let columns = properties.map(column => column.widthType === "FIXED_WIDTH" &&
    column.width?.magnitude !== undefined ? Number(column.width.magnitude.toFixed(3)) : null);
  return {
    cells,
    ...(columns.some(width => width !== null) ? { columns } : {}),
    rows: rows.map(row => Number((row.tableRowStyle?.minRowHeight?.magnitude ?? 0).toFixed(3))),
  };
}

// ---------------------------------------------------------------------------
// Writing a look
// ---------------------------------------------------------------------------

/**
 * The attributes a look writes, each with its leading space or empty: on `<table>`, on each
 * `<tr>` and on each `<td>` after its spans, a covered cell's always empty; and the
 * `<colgroup>` element the table's second line holds, when a column has a fixed width.
 */
export type RenderedLook = {
  table: string;
  colgroup?: string;
  rows: string[];
  cells: string[][];
};

/**
 * The value each longhand takes on the table: the one most of its uncovered cells have, a tie
 * going to the default, else to the value reached first, row by row.
 */
function hoisted(cells: readonly (CellLook | null)[][]): CellLook {
  let table = { ...DEFAULT_CELL };
  for (let longhand of LONGHANDS) {
    let counts = new Map<string, number>();
    for (let row of cells) {
      for (let cell of row) {
        if (cell) counts.set(cell[longhand], (counts.get(cell[longhand]) ?? 0) + 1);
      }
    }
    // A map iterates in the order values were first reached, so of tied values the first wins.
    let best = DEFAULT_CELL[longhand];
    let most = counts.get(best) ?? 0;
    for (let [value, count] of counts) {
      if (count > most) {
        best = value;
        most = count;
      }
    }
    table[longhand] = best;
  }
  return table;
}

/** The declarations of the longhands of `look` that differ from `base`, as a `style` value. */
function declarations(look: CellLook, base: CellLook): string {
  let written: string[] = [];
  let groups = [
    { name: "padding", longhands: LONGHANDS.slice(2, 6) },
    { name: "border", longhands: LONGHANDS.slice(6, 10) },
  ];
  for (let longhand of LONGHANDS.slice(0, 2)) {
    if (look[longhand] !== base[longhand]) written.push(`${longhand}:${look[longhand]}`);
  }
  for (let { name, longhands } of groups) {
    let differ = longhands.filter(longhand => look[longhand] !== base[longhand]);
    if (differ.length === 4 && differ.every(longhand => look[longhand] === look[longhands[0]])) {
      written.push(`${name}:${look[longhands[0]]}`);
    } else {
      for (let longhand of differ) written.push(`${longhand}:${look[longhand]}`);
    }
  }
  return written.join(";");
}

const styleAttribute = (value: string): string => value === "" ? "" : ` style="${value}"`;

/** The attributes that write `look`. */
export function renderLook(look: TableLook): RenderedLook {
  let table = hoisted(look.cells);
  return {
    table: styleAttribute(declarations(table, DEFAULT_CELL)),
    ...(look.columns?.some(width => width !== null)
      ? {
        colgroup: `<colgroup>${look.columns.map(width =>
          width === null ? "<col>" : `<col style="width:${points(width)}">`).join("")}</colgroup>`,
      }
      : {}),
    rows: look.rows.map(height => height > 0 ? ` style="height:${points(height)}"` : ""),
    cells: look.cells.map(row =>
      row.map(cell => cell ? styleAttribute(declarations(cell, table)) : "")),
  };
}

// ---------------------------------------------------------------------------
// Reading a look back
// ---------------------------------------------------------------------------

/** The style values of a table's opening tags, as `tableLines` finds them: "" for none. */
export type LookAttributes = {
  table: string;
  colgroup?: string;
  rows: string[];
  cells: string[][];
};

const LENGTH = /^-?\d+(?:\.\d{1,3})?pt$/;
const BORDER = /^(?:none|\d+(?:\.\d{1,3})?pt (?:solid|dotted|dashed) #[0-9a-f]{6})$/;
const VALUES: Record<string, RegExp> = {
  "background-color": /^(?:transparent|#[0-9a-f]{6})$/,
  "vertical-align": /^(?:top|middle|bottom)$/,
  padding: LENGTH,
  border: BORDER,
};

/** `base` with the declarations of `style` over it, or undefined when one does not parse. */
function overlay(base: CellLook, style: string): CellLook | undefined {
  if (style === "") return base;
  let look: Record<Longhand, string> = { ...base };
  for (let declaration of style.split(";")) {
    let colon = declaration.indexOf(":");
    let name = declaration.slice(0, colon);
    let value = declaration.slice(colon + 1);
    let group = name.replace(/-(?:top|right|bottom|left)$/, "");
    if (colon < 0 || !VALUES[group]?.test(value)) return undefined;
    if (name === group && group !== "background-color" && group !== "vertical-align") {
      for (let side of SIDES) look[`${group}-${side}` as Longhand] = value;
    } else {
      look[name as Longhand] = value;
    }
  }
  return look;
}

const COLUMN = /^<col(?: style="width:(\d+(?:\.\d{1,3})?)pt")?>/;
const HEIGHT = /^height:(\d+(?:\.\d{1,3})?)pt$/;

/**
 * The look that `attributes` write, for a table whose cells `covered` says a merged cell
 * covers; undefined unless the attributes are exactly those `renderLook` writes for it.
 */
export function readLook(
  attributes: LookAttributes, covered: readonly (readonly boolean[])[],
): TableLook | undefined {
  let table = overlay(DEFAULT_CELL, attributes.table);
  if (!table) return undefined;
  let cells: (CellLook | null)[][] = [];
  for (let [r, row] of attributes.cells.entries()) {
    let read: (CellLook | null)[] = [];
    for (let [c, style] of row.entries()) {
      if (covered[r]?.[c]) {
        if (style !== "") return undefined;
        read.push(null);
        continue;
      }
      let cell = overlay(table, style);
      if (!cell) return undefined;
      read.push(cell);
    }
    cells.push(read);
  }
  let rows: number[] = [];
  for (let style of attributes.rows) {
    if (style === "") {
      rows.push(0);
      continue;
    }
    let height = HEIGHT.exec(style);
    if (!height) return undefined;
    rows.push(Number(height[1]));
  }
  let look: TableLook = { cells, rows };
  if (attributes.colgroup !== undefined) {
    let rest = attributes.colgroup.replace(/^<colgroup>/, "").replace(/<\/colgroup>$/, "");
    let columns: (number | null)[] = [];
    for (let column = COLUMN.exec(rest); column; column = COLUMN.exec(rest)) {
      columns.push(column[1] === undefined ? null : Number(column[1]));
      rest = rest.slice(column[0].length);
    }
    if (rest !== "") return undefined;
    look.columns = columns;
  }
  let rendered = renderLook(look);
  let same = rendered.table === styleAttribute(attributes.table) &&
    rendered.colgroup === attributes.colgroup &&
    rendered.rows.every((style, r) => style === styleAttribute(attributes.rows[r])) &&
    rendered.cells.every((row, r) =>
      row.every((style, c) => style === styleAttribute(attributes.cells[r][c])));
  return same ? look : undefined;
}

// ---------------------------------------------------------------------------
// How rows and columns change a look
// ---------------------------------------------------------------------------

// Each changes a table without merged cells, as the row and column changes are kept to.

/**
 * `look` with `count` rows added before row `at`: each takes the cells' looks and the least
 * height of the row it goes before, or of the last row at the end, as Google copies them.
 */
export function lookWithRows(look: TableLook, at: number, count: number): TableLook {
  let reference = Math.min(at, look.cells.length - 1);
  return {
    ...look,
    cells: look.cells.toSpliced(
      at, 0, ...Array.from({ length: count }, () => look.cells[reference])),
    rows: look.rows.toSpliced(at, 0, ...Array.from({ length: count }, () => look.rows[reference])),
  };
}

/**
 * `look` with `count` columns added before column `at`: each takes the cells' looks and the
 * width of the column it goes before, or of the last column at the end.
 */
export function lookWithColumns(look: TableLook, at: number, count: number): TableLook {
  let copies = <T>(line: readonly T[]) => {
    let reference = Math.min(at, line.length - 1);
    return line.toSpliced(at, 0, ...Array.from({ length: count }, () => line[reference]));
  };
  return {
    ...look,
    cells: look.cells.map(copies),
    ...(look.columns ? { columns: copies(look.columns) } : {}),
  };
}

/** `look` without rows `at` to `at + count - 1`. */
export function lookWithoutRows(look: TableLook, at: number, count: number): TableLook {
  return { ...look, cells: look.cells.toSpliced(at, count), rows: look.rows.toSpliced(at, count) };
}

/** `look` without columns `at` to `at + count - 1`. */
export function lookWithoutColumns(look: TableLook, at: number, count: number): TableLook {
  let columns = look.columns?.toSpliced(at, count);
  return {
    cells: look.cells.map(row => row.toSpliced(at, count)),
    ...(columns?.some(width => width !== null) ? { columns } : {}),
    rows: look.rows,
  };
}

// ---------------------------------------------------------------------------
// Setting cells' looks
// ---------------------------------------------------------------------------

/** The edges a style change can set on a block of cells. */
export const EDGES =
  ["top", "bottom", "left", "right", "innerHorizontal", "innerVertical"] as const;

/** One of `EDGES`. */
export type Edge = typeof EDGES[number];

/**
 * What a style change sets on a block of cells, each value as `CellLook` writes it; a field left
 * out is left as it is. `border` sets every edge of every cell, and `borders` then sets edges of
 * the block: its outer ones, or those between its rows or its columns.
 */
export type CellStyleChange = {
  background?: string;
  verticalAlign?: string;
  padding?: Partial<Record<Side, string>>;
  border?: string;
  borders?: Partial<Record<Edge, string>>;
};

/** A block of a table's cells, counted from 0. */
export type CellBlock = { row: number; column: number; rows: number; columns: number };

/** One part of a style change as Google applies it: one request, over a block of cells. */
export type CellStyleStep = {
  block: CellBlock;
  /** The longhands the request sets on each cell the block reaches, with their values. */
  set: Partial<Record<Longhand, string>>;
};

/**
 * The requests a style change makes, in the order they are sent: the shading, alignment and
 * padding over the block, then `border` over it, then each of `borders` over the cells along
 * that edge. Google has no request for the edges between cells, so those are the bottoms of every
 * row but the last, or the right sides of every column but the last.
 */
export function cellStyleSteps(block: CellBlock, style: CellStyleChange): CellStyleStep[] {
  let steps: CellStyleStep[] = [];
  let plain: Partial<Record<Longhand, string>> = {};
  if (style.background !== undefined) plain["background-color"] = style.background;
  if (style.verticalAlign !== undefined) plain["vertical-align"] = style.verticalAlign;
  for (let side of SIDES) {
    let padding = style.padding?.[side];
    if (padding !== undefined) plain[`padding-${side}`] = padding;
  }
  if (Object.keys(plain).length > 0) steps.push({ block, set: plain });
  if (style.border !== undefined) {
    let border = style.border;
    steps.push({ block, set: Object.fromEntries(SIDES.map(side => [`border-${side}`, border])) });
  }
  let { row, column, rows, columns } = block;
  let edges: [Edge, CellBlock, Longhand][] = [
    ["innerHorizontal", { row, column, rows: rows - 1, columns }, "border-bottom"],
    ["innerVertical", { row, column, rows, columns: columns - 1 }, "border-right"],
    ["top", { row, column, rows: 1, columns }, "border-top"],
    ["bottom", { row: row + rows - 1, column, rows: 1, columns }, "border-bottom"],
    ["left", { row, column, rows, columns: 1 }, "border-left"],
    ["right", { row, column: column + columns - 1, rows, columns: 1 }, "border-right"],
  ];
  for (let [edge, reached, longhand] of edges) {
    let value = style.borders?.[edge];
    if (value !== undefined) steps.push({ block: reached, set: { [longhand]: value } });
  }
  return steps;
}

const OPPOSITE: Record<Side, Side> = { top: "bottom", bottom: "top", left: "right", right: "left" };

/** The merged cell, or the cell, that covers each cell of a table: its row and column. */
function headsOf(spans: readonly (readonly Spans[])[]): [number, number][][] {
  let heads = spans.map(row => row.map((): [number, number] => [-1, -1]));
  spans.forEach((row, r) => row.forEach(({ rowSpan, columnSpan }, c) => {
    if (heads[r][c][0] >= 0) return;
    for (let down = r; down < Math.min(r + rowSpan, spans.length); down++) {
      for (let across = c; across < Math.min(c + columnSpan, spans[down].length); across++) {
        heads[down][across] = [r, c];
      }
    }
  }));
  return heads;
}

/**
 * `look` once Google has applied `steps` to the table whose cells have `spans`. A request
 * reaches the whole of every merged cell it reaches any cell of. It sets the shading, alignment
 * and padding of each, and a border along each one's side: on the cells Google keeps that side
 * on, and on the facing side of the cells beside them, last write winning. A merged cell reads
 * its top and left edges from its first cell, its right from its last column and its bottom from
 * its last row, as `lookOfTable` reads them.
 */
export function lookWithCellStyle(
  look: TableLook, spans: readonly (readonly Spans[])[], steps: readonly CellStyleStep[],
): TableLook {
  let cells = look.cells.map(row => row.map(cell => cell && { ...cell }));
  let heads = headsOf(spans);
  let height = spans.length;
  // Set side `side` of the cell at `r`, `c`, where the merged cell covering it reads it from.
  let setSide = (r: number, c: number, side: Side, value: string) => {
    let [hr, hc] = heads[r][c];
    let { rowSpan, columnSpan } = spans[hr][hc];
    let reads = side === "right" ? r === hr && c === hc + columnSpan - 1
      : side === "bottom" ? r === hr + rowSpan - 1 && c === hc
      : r === hr && c === hc;
    let cell = cells[hr][hc];
    if (reads && cell) (cell as Record<Longhand, string>)[`border-${side}`] = value;
  };
  for (let { block, set } of steps) {
    let reached = new Set<string>();
    for (let r = block.row; r < block.row + block.rows; r++) {
      for (let c = block.column; c < block.column + block.columns; c++) {
        reached.add(heads[r][c].join());
      }
    }
    for (let key of reached) {
      let [hr, hc] = key.split(",").map(Number);
      let { rowSpan, columnSpan } = spans[hr][hc];
      let last = {
        row: Math.min(hr + rowSpan, height) - 1,
        column: Math.min(hc + columnSpan, spans[hr].length) - 1,
      };
      for (let [longhand, value] of Object.entries(set) as [Longhand, string][]) {
        let side = SIDES.find(name => longhand === `border-${name}`);
        if (!side) {
          (cells[hr][hc] as Record<Longhand, string>)[longhand] = value;
          continue;
        }
        // The cells along that side, and the cell beside each.
        let along: [number, number][] = [];
        if (side === "top" || side === "bottom") {
          let r = side === "top" ? hr : last.row;
          for (let c = hc; c <= last.column; c++) along.push([r, c]);
        } else {
          let c = side === "left" ? hc : last.column;
          for (let r = hr; r <= last.row; r++) along.push([r, c]);
        }
        let step = { top: [-1, 0], bottom: [1, 0], left: [0, -1], right: [0, 1] }[side];
        for (let [r, c] of along) {
          setSide(r, c, side, value);
          let [nr, nc] = [r + step[0], c + step[1]];
          if (nr >= 0 && nr < height && nc >= 0 && nc < spans[nr].length) {
            setSide(nr, nc, OPPOSITE[side], value);
          }
        }
      }
    }
  }
  return { ...look, cells };
}

/** A look's colour as Google's colour: `#rrggbb`, each component a fraction of 255. */
export function googleColor(hex: string): OptionalColor {
  let component = (at: number) => parseInt(hex.slice(at, at + 2), 16) / 255;
  return { color: { rgbColor: { red: component(1), green: component(3), blue: component(5) } } };
}

const DASH_STYLES: Record<string, string> = { solid: "SOLID", dotted: "DOT", dashed: "DASH" };

/** A look's border as Google stores one: `none` is drawn 0pt wide, in black. */
export function googleBorder(value: string): TableCellBorder {
  if (value === "none") {
    return {
      width: { magnitude: 0, unit: "PT" }, dashStyle: "SOLID", color: googleColor("#000000"),
    };
  }
  let [width, dash, color] = value.split(" ");
  return {
    width: { magnitude: Number(width.slice(0, -2)), unit: "PT" },
    dashStyle: DASH_STYLES[dash], color: googleColor(color),
  };
}

const CONTENT_ALIGNMENTS: Record<string, string> =
  { top: "TOP", middle: "MIDDLE", bottom: "BOTTOM" };

const STYLE_FIELDS: Record<Longhand, keyof TableCellStyle> = {
  "background-color": "backgroundColor", "vertical-align": "contentAlignment",
  "padding-top": "paddingTop", "padding-right": "paddingRight",
  "padding-bottom": "paddingBottom", "padding-left": "paddingLeft",
  "border-top": "borderTop", "border-right": "borderRight",
  "border-bottom": "borderBottom", "border-left": "borderLeft",
};

/** What one step sends Google: the cell style it sets and the field mask that names it. */
export function googleCellStyle(
  set: CellStyleStep["set"],
): { tableCellStyle: TableCellStyle; fields: string } {
  let style: Record<string, unknown> = {};
  let fields: string[] = [];
  for (let longhand of LONGHANDS) {
    let value = set[longhand];
    if (value === undefined) continue;
    let field = STYLE_FIELDS[longhand];
    fields.push(field);
    // A shading cleared is a field named in the mask and left out, as probe R1 saw.
    if (longhand === "background-color") {
      if (value !== "transparent") style[field] = googleColor(value);
    } else if (longhand === "vertical-align") {
      style[field] = CONTENT_ALIGNMENTS[value];
    } else if (longhand.startsWith("padding")) {
      style[field] = { magnitude: Number(value.slice(0, -2)), unit: "PT" };
    } else {
      style[field] = googleBorder(value);
    }
  }
  return { tableCellStyle: style as TableCellStyle, fields: fields.join(",") };
}
