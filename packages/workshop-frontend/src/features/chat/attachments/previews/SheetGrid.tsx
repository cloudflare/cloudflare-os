import { useEffect, useMemo, useRef, useState } from "react";
import type { SheetCellStyle, SheetModel } from "@gadgets/office-content/xlsx-sheets";
import { MAX_GRID_COLUMNS, MAX_GRID_ROWS } from "./DataGrid";
import { SHEET_HEADER_CLASS, SheetRow } from "./SheetRow";
import { SHEET_INK, SHEET_PAPER } from "./sheetCellStyle";
import {
  SHEET_HEADER_HEIGHT, SHEET_ROW_HEADER_WIDTH, columnLetter, layoutSheet, rowWindow,
} from "./sheetLayout";

const range = (start: number, end: number) =>
  Array.from({ length: Math.max(0, end - start) }, (_, offset) => start + offset);

/**
 * A worksheet drawn as Excel shows it on screen: lettered and numbered headers that stay in view,
 * the file's own column widths, row heights, merges, frozen panes and cell formatting. Only the
 * rows near the viewport are in the page, so a large sheet opens quickly.
 */
export const SheetGrid = ({ sheet, styles }: { sheet: SheetModel; styles: readonly SheetCellStyle[] }) => {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setRoom({ width: Math.floor(entry.contentRect.width), height: Math.floor(entry.contentRect.height) });
    });
    observer.observe(scroller);
    return () => observer.disconnect();
  }, []);

  // Laying out a thousand rows on every scroll event would make scrolling stutter.
  const content = useMemo(() => layoutSheet(sheet, styles, MAX_GRID_ROWS, MAX_GRID_COLUMNS), [sheet, styles]);
  // A sheet smaller than the viewer is padded with exactly the empty cells that fit beside and
  // below it: the grid fills the viewer, and nothing scrolls that has nothing to scroll to.
  const spareRows = Math.max(0, Math.floor(
    (room.height - SHEET_HEADER_HEIGHT - content.rowTops[content.rows.length]) / sheet.defaultRowHeight));
  const spareColumns = Math.max(0, Math.floor(
    (room.width - SHEET_ROW_HEADER_WIDTH - content.columnLefts[content.columns.length]) / sheet.defaultColumnWidth));
  const layout = useMemo(
    () => (spareRows === 0 && spareColumns === 0
      ? content
      : layoutSheet(sheet, styles, MAX_GRID_ROWS, MAX_GRID_COLUMNS, { rows: spareRows, columns: spareColumns })),
    [content, sheet, styles, spareRows, spareColumns],
  );
  // The viewport's height is not known until the grid is in the page; the window's is at least it.
  const [drawn, setDrawn] = useState(() => ({ layout, rows: rowWindow(layout, 0, window.innerHeight) }));
  // A new layout has other rows; the window over the old one is recomputed where the grid is scrolled to.
  const rows = drawn.layout === layout
    ? drawn.rows
    : rowWindow(layout, scrollerRef.current?.scrollTop ?? 0, window.innerHeight);

  const { columns, columnWidths, rowTops, frozenRows } = layout;
  const columnCount = columns.length + 1;
  // Stands in for the rows not drawn, so the scrollbar spans the whole sheet.
  const spacer = (key: string, height: number) => height > 0 && (
    <tr key={key} aria-hidden style={{ height }}>
      <td colSpan={columnCount} className="p-0" />
    </tr>
  );

  return (
    <div
      ref={scrollerRef}
      className="h-full overflow-auto bg-kumo-elevated"
      onScroll={(event) => {
        const next = rowWindow(layout, event.currentTarget.scrollTop, window.innerHeight);
        setDrawn((current) => (
          current.layout === layout && current.rows.start === next.start && current.rows.end === next.end
            ? current
            : { layout, rows: next }
        ));
      }}
    >
      <table
        className="table-fixed border-separate border-spacing-0"
        style={{
          width: SHEET_ROW_HEADER_WIDTH + layout.columnLefts[columns.length],
          background: SHEET_PAPER,
          color: SHEET_INK,
        }}
      >
        <colgroup>
          <col style={{ width: SHEET_ROW_HEADER_WIDTH }} />
          {columns.map((column, position) => <col key={column} style={{ width: columnWidths[position] }} />)}
        </colgroup>
        <thead>
          <tr style={{ height: SHEET_HEADER_HEIGHT }}>
            <th className={`sticky left-0 top-0 z-10 ${SHEET_HEADER_CLASS}`} />
            {columns.map((column) => (
              <th key={column} scope="col" className={`sticky top-0 z-[9] ${SHEET_HEADER_CLASS}`}>
                {columnLetter(column)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {range(0, frozenRows).map((position) => <SheetRow key={position} layout={layout} rowPosition={position} />)}
          {spacer("above", rowTops[rows.start] - rowTops[frozenRows])}
          {range(rows.start, rows.end).map((position) => <SheetRow key={position} layout={layout} rowPosition={position} />)}
          {spacer("below", rowTops[layout.rows.length] - rowTops[rows.end])}
        </tbody>
      </table>
    </div>
  );
};
