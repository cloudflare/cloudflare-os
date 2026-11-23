import { memo, type ReactNode } from "react";
import type { SheetBorderEdge } from "@gadgets/office-content/xlsx-sheets";
import { SheetCell, type SheetCellFit } from "./SheetCell";
import {
  CELL_INDENT, CELL_PADDING, SHEET_GRIDLINE, borderCss, borderWidth, cellAlignment, textWidth,
} from "./sheetCellStyle";
import { SHEET_HEADER_HEIGHT, SHEET_ROW_HEADER_WIDTH, type SheetLayout } from "./sheetLayout";

/** The app's own chrome around the sheet: the lettered and numbered headers. */
export const SHEET_HEADER_CLASS =
  "overflow-hidden border-b border-r border-kumo-line bg-kumo-elevated p-0 text-center text-[11px] font-medium leading-none text-kumo-subtle";

/** A number may be drawn up to this much narrower before it is replaced by hashes. */
const MOST_CONDENSED = 0.75;

// Stacking of what stays in view, above the cells that scroll. A cell whose text spills over its
// neighbours sits one above its own layer, or the neighbour's background would cover the text.
const Z_PINNED_COLUMN = 2;
const Z_PINNED_ROW = 4;
const Z_PINNED_BOTH = 6;
const Z_ROW_HEADER = 2;
const Z_PINNED_ROW_HEADER = 8;

/** How each cell of a row fits its text, and which cell boundaries spilled text runs across. */
const fitRow = (layout: SheetLayout, rowPosition: number) => {
  const { columns, columnWidths, frozenColumns } = layout;
  const row = layout.rows[rowPosition];
  const fits = new Map<number, SheetCellFit>();
  /** Positions whose right-hand boundary has text running across it. */
  const crossed = new Set<number>();
  const taken = new Set<number>();
  const isFree = (position: number, side: number) =>
    position >= 0 && position < columns.length &&
    // Text never runs from the frozen columns into the scrolling ones, or back.
    (position < frozenColumns) === (side < frozenColumns) &&
    !taken.has(position) &&
    !layout.isCovered(rowPosition, position) && !layout.spanAt(rowPosition, position) &&
    !layout.cellAt(row, columns[position])?.text;

  for (let position = 0; position < columns.length; position++) {
    if (layout.isCovered(rowPosition, position)) continue;
    const span = layout.spanAt(rowPosition, position);
    const cell = span ? layout.cellAt(span.sourceRow, span.sourceColumn) : layout.cellAt(row, columns[position]);
    if (!cell?.text) continue;
    const style = layout.styles[cell.style] ?? layout.styles[0];
    if (style.wrap) continue;
    const alignment = cellAlignment(style, cell.kind);
    const width = layout.columnLefts[position + (span?.colSpan ?? 1)] - layout.columnLefts[position];
    const room = width - 1 - 2 * CELL_PADDING - style.indent * CELL_INDENT;
    const needed = textWidth(cell.text, style.font);
    if (needed <= room) continue;

    if (cell.kind === "number" || cell.kind === "date") {
      const scale = Math.max(0, room) / needed;
      fits.set(position, scale >= MOST_CONDENSED
        ? { kind: "condense", scale }
        : { kind: "hashes", count: Math.max(1, Math.floor(room / textWidth("#", style.font))) });
      continue;
    }
    if (span || cell.kind !== "text" || alignment === "justify") continue;

    // Text runs over empty neighbours on the side away from its alignment, as far as it needs.
    const over = needed - room;
    const extend = (direction: 1 | -1, want: number) => {
      let gained = 0;
      for (let next = position + direction; gained < want && isFree(next, position); next += direction) {
        gained += columnWidths[next];
        taken.add(next);
        crossed.add(direction === 1 ? next - 1 : next);
      }
      return gained;
    };
    const fit = {
      kind: "spill" as const,
      left: alignment === "right" ? extend(-1, over) : alignment === "center" ? extend(-1, over / 2) : 0,
      right: alignment === "left" ? extend(1, over) : alignment === "center" ? extend(1, over / 2) : 0,
    };
    if (fit.left > 0 || fit.right > 0) fits.set(position, fit);
  }
  return { fits, crossed };
};

/** One row of a sheet: its numbered header and its cells. */
export const SheetRow = memo(({ layout, rowPosition }: { layout: SheetLayout; rowPosition: number }) => {
  const { sheet, rows, columns, frozenRows, frozenColumns } = layout;
  const row = rows[rowPosition];
  const rowPinned = rowPosition < frozenRows;
  const top = SHEET_HEADER_HEIGHT + layout.rowTops[rowPosition];
  const { fits, crossed } = fitRow(layout, rowPosition);

  // An edge with no border of its own is a gridline, unless a fill on either side covers it or
  // spilled text crosses it.
  const edge = (border: SheetBorderEdge | undefined, fill: string | undefined, hidden: boolean) =>
    border ? borderCss(border) : `1px solid ${fill ?? (sheet.showGridlines && !hidden ? SHEET_GRIDLINE : "transparent")}`;

  const cells: ReactNode[] = [];
  for (let position = 0; position < columns.length; position++) {
    if (layout.isCovered(rowPosition, position)) continue;
    const span = layout.spanAt(rowPosition, position);
    const rowSpan = span?.rowSpan ?? 1;
    const colSpan = span?.colSpan ?? 1;
    const column = columns[position];
    const lastRow = rows[rowPosition + rowSpan - 1];
    const lastColumn = columns[position + colSpan - 1];
    const style = layout.styleAt(span?.sourceRow ?? row, span?.sourceColumn ?? column);
    const nextColumn = columns[position + colSpan];
    const nextRow = rows[rowPosition + rowSpan];
    const beside = nextColumn === undefined ? undefined : layout.styleAt(row, nextColumn);
    const below = nextRow === undefined ? undefined : layout.styleAt(nextRow, column);
    // Neighbours share an edge: a cell's right border may be the next cell's left one.
    const right = layout.styleAt(row, lastColumn).borders.right ?? beside?.borders.left;
    const bottom = layout.styleAt(lastRow, column).borders.bottom ?? below?.borders.top;
    // A merge that reaches past the frozen columns scrolls with the rest rather than stay over it.
    const columnPinned = position + colSpan <= frozenColumns;
    const fit = fits.get(position);
    const layer = rowPinned && columnPinned ? Z_PINNED_BOTH : rowPinned ? Z_PINNED_ROW : Z_PINNED_COLUMN;

    cells.push(
      <SheetCell
        key={position}
        cell={span ? layout.cellAt(span.sourceRow, span.sourceColumn) : layout.cellAt(row, column)}
        style={style}
        width={layout.columnLefts[position + colSpan] - layout.columnLefts[position]}
        height={layout.rowTops[rowPosition + rowSpan] - layout.rowTops[rowPosition]}
        colSpan={colSpan}
        rowSpan={rowSpan}
        rightEdge={edge(right, style.fill ?? beside?.fill, crossed.has(position + colSpan - 1))}
        bottomEdge={edge(bottom, style.fill ?? below?.fill, false)}
        leftEdge={position === 0 && style.borders.left ? borderCss(style.borders.left) : undefined}
        topEdge={rowPosition === 0 && style.borders.top ? borderCss(style.borders.top) : undefined}
        bottomWidth={borderWidth(bottom)}
        fit={fit}
        pinned={rowPinned || columnPinned ? {
          top: rowPinned ? top : undefined,
          left: columnPinned ? SHEET_ROW_HEADER_WIDTH + layout.columnLefts[position] : undefined,
          zIndex: layer + (fit?.kind === "spill" ? 1 : 0),
        } : undefined}
      />,
    );
  }

  return (
    <tr style={{ height: layout.rowHeights[rowPosition] }}>
      <th
        scope="row"
        className={`sticky left-0 tabular-nums ${SHEET_HEADER_CLASS}`}
        style={{ top: rowPinned ? top : undefined, zIndex: rowPinned ? Z_PINNED_ROW_HEADER : Z_ROW_HEADER }}
      >
        {row + 1}
      </th>
      {cells}
    </tr>
  );
});
SheetRow.displayName = "SheetRow";
