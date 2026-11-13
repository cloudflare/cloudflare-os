import type { CSSProperties } from "react";
import type { SlideOutline, SlideTable as SlideTableData } from "@gadgets/office-content/pptx-slides";
import { SlideText } from "./SlideText";
import { boundsStyle, cssBorder, fillBackground } from "./slideStyles";

const VERTICAL_ALIGN = { top: "top", middle: "middle", bottom: "bottom" } as const;

type Side = "left" | "top" | "right" | "bottom";

/**
 * One edge of a cell, drawn over the grid line. PowerPoint's borders straddle the line and take
 * no room from the cell, where a CSS border would push the cell's text in by half its width.
 */
const CellBorder = ({ side, outline }: { side: Side; outline: SlideOutline }) => {
  const half = outline.width / 2;
  const horizontal = side === "top" || side === "bottom";
  const style: CSSProperties = horizontal
    ? { left: -half, right: -half, [side]: -half, borderTop: cssBorder(outline) }
    : { top: -half, bottom: -half, [side]: -half, borderLeft: cssBorder(outline) };
  return <div aria-hidden="true" style={{ position: "absolute", pointerEvents: "none", ...style }} />;
};

const SIDES: readonly Side[] = ["left", "top", "right", "bottom"];

/**
 * A table, as an HTML table so its rows grow with their text the way PowerPoint's do: a row's
 * stated height is its minimum.
 */
export const SlideTable = ({ table }: { table: SlideTableData }) => (
  <table
    style={{
      ...boundsStyle(table.bounds),
      width: table.columnWidths.reduce((total, width) => total + width, 0),
      height: undefined,
      tableLayout: "fixed",
      borderCollapse: "collapse",
    }}
  >
    <colgroup>
      {table.columnWidths.map((width, index) => <col key={index} style={{ width }} />)}
    </colgroup>
    <tbody>
      {table.rows.map((row, rowIndex) => (
        <tr key={rowIndex} style={{ height: row.height }}>
          {row.cells.map((cell) => (
            <td
              key={cell.column}
              colSpan={cell.columnSpan}
              rowSpan={cell.rowSpan}
              style={{
                position: "relative",
                background: fillBackground(cell.fill),
                padding: `${cell.text.insets.top}px ${cell.text.insets.right}px ${cell.text.insets.bottom}px ${cell.text.insets.left}px`,
                verticalAlign: VERTICAL_ALIGN[cell.text.anchor],
              }}
            >
              <SlideText body={cell.text} />
              {SIDES.map((side) => {
                const outline = cell.borders[side];
                return outline && <CellBorder key={side} side={side} outline={outline} />;
              })}
            </td>
          ))}
        </tr>
      ))}
    </tbody>
  </table>
);
