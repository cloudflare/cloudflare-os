import type { CSSProperties } from "react";
import type { SheetCell as SheetCellModel, SheetCellStyle } from "@gadgets/office-content/xlsx-sheets";
import {
  CELL_INDENT, CELL_PADDING, SHEET_INK, SHEET_LINK, SHEET_PAPER, cellAlignment, fontCss, safeHref, textDecoration,
} from "./sheetCellStyle";

const JUSTIFY = { left: "flex-start", center: "center", right: "flex-end", justify: "flex-start" } as const;
const ALIGN = { top: "flex-start", center: "center", bottom: "flex-end", justify: "center", distributed: "center" } as const;

/** How a cell's text is fitted when it is wider than the cell. */
export type SheetCellFit =
  /** Text runs over empty neighbours by this many pixels on each side. */
  | { kind: "spill"; left: number; right: number }
  /** A number is drawn narrower by this factor, to absorb a substitute font's wider digits. */
  | { kind: "condense"; scale: number }
  /** A number too wide to show, replaced by this many `#`, as Excel does. */
  | { kind: "hashes"; count: number };

/** One cell of a sheet: a table cell sized by its row and columns, drawn in the file's own style. */
export const SheetCell = ({ cell, style, width, height, colSpan, rowSpan, rightEdge, bottomEdge, leftEdge, topEdge, bottomWidth, fit, pinned }: {
  cell: SheetCellModel | undefined;
  style: SheetCellStyle;
  /** The cell's outer size in pixels, over all the columns and rows it spans. */
  width: number;
  height: number;
  colSpan: number;
  rowSpan: number;
  /** CSS borders. Right and bottom are always drawn; left and top only at the grid's first column and row. */
  rightEdge: string;
  bottomEdge: string;
  leftEdge?: string;
  topEdge?: string;
  bottomWidth: number;
  fit?: SheetCellFit;
  /** Set for a cell in a frozen row or column: where it sticks, and above what. */
  pinned?: { top?: number; left?: number; zIndex: number };
}) => {
  const text = cell?.text ?? "";
  const tdStyle: CSSProperties = {
    padding: 0,
    borderRight: rightEdge,
    borderBottom: bottomEdge,
    borderLeft: leftEdge,
    borderTop: topEdge,
    background: style.fill,
    overflow: fit?.kind === "spill" ? "visible" : "hidden",
  };
  if (pinned) {
    // A pinned cell covers what scrolls beneath it, so it cannot be see-through.
    Object.assign(tdStyle, { position: "sticky", top: pinned.top, left: pinned.left, zIndex: pinned.zIndex, background: style.fill ?? SHEET_PAPER });
  }
  if (text === "") return <td colSpan={colSpan} rowSpan={rowSpan} style={tdStyle} />;

  const alignment = cellAlignment(style, cell?.kind ?? "text");
  const href = safeHref(cell?.hyperlink);
  const isLink = cell?.hyperlink !== undefined;
  const indent = style.indent * CELL_INDENT;
  const spill = fit?.kind === "spill" ? fit : undefined;
  const boxStyle: CSSProperties = {
    ...fontCss(style.font),
    display: "flex",
    boxSizing: "border-box",
    // The row's height is fixed by the file, so content taller than it is cut, not grown into.
    height: height - bottomWidth,
    width: spill ? width + spill.left + spill.right : undefined,
    marginLeft: spill ? -spill.left : undefined,
    paddingLeft: CELL_PADDING + (alignment === "right" ? 0 : indent),
    paddingRight: CELL_PADDING + (alignment === "right" ? indent : 0),
    alignItems: ALIGN[style.vertical],
    justifyContent: JUSTIFY[alignment],
    textAlign: alignment,
    overflow: "hidden",
    whiteSpace: style.wrap ? "pre-wrap" : "pre",
    overflowWrap: style.wrap ? "anywhere" : undefined,
    // A link is blue unless the file gave its text a colour of its own; black is no such choice.
    color: cell?.color ?? (isLink && (style.font.color ?? SHEET_INK) === SHEET_INK ? SHEET_LINK : style.font.color),
    textDecoration: textDecoration(style.font, isLink),
  };
  const shown = fit?.kind === "hashes" ? "#".repeat(fit.count) : style.wrap ? text : text.replace(/\r?\n/g, " ");
  const content = fit?.kind === "condense"
    ? <span style={{ display: "inline-block", transform: `scaleX(${fit.scale})`, transformOrigin: alignment === "right" ? "right" : "left" }}>{shown}</span>
    : shown;

  return (
    <td
      colSpan={colSpan}
      rowSpan={rowSpan}
      style={tdStyle}
      // Hashes stand in for a value that does not fit; the value itself stays the cell's name.
      aria-label={fit?.kind === "hashes" ? text : undefined}
      title={fit?.kind === "hashes" ? text : undefined}
    >
      <div style={boxStyle}>
        {href
          ? <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: "inherit", textDecoration: "inherit" }}>{content}</a>
          : content}
      </div>
    </td>
  );
};
