import type { DocxTable } from "@gadgets/office-content/docx-document";
import { DocumentBlocks } from "./DocumentBlocks";
import { borderStyle, pt } from "./documentStyles";

/** A table with the column widths, borders, shading and cell padding the document gives it. */
export const DocumentTable = ({ table, defaultTabStop }: {
  table: DocxTable;
  defaultTabStop: number;
}) => {
  const width = table.columnWidths.reduce((sum, column) => sum + column, 0);
  return (
    <table
      style={{
        // Borders sit on the grid lines and the wider of two neighbours' wins, as in Word.
        borderCollapse: "collapse",
        tableLayout: width > 0 ? "fixed" : "auto",
        width: width > 0 ? pt(width) : "100%",
        marginLeft: table.alignment === "left" ? pt(table.indent) : "auto",
        marginRight: table.alignment === "center" ? "auto" : undefined,
      }}
    >
      {width > 0 && (
        <colgroup>
          {table.columnWidths.map((column, index) => <col key={index} style={{ width: pt(column) }} />)}
        </colgroup>
      )}
      <tbody>
        {table.rows.map((row, rowIndex) => (
          <tr key={rowIndex} style={{ height: row.height === undefined ? undefined : pt(row.height) }}>
            {row.cells.map((cell, cellIndex) => (
              <td
                key={cellIndex}
                colSpan={cell.columnSpan}
                rowSpan={cell.rowSpan}
                style={{
                  padding: `${pt(cell.margins.top)} ${pt(cell.margins.right)} ${pt(cell.margins.bottom)} ${pt(cell.margins.left)}`,
                  borderTop: borderStyle(cell.borders.top),
                  borderRight: borderStyle(cell.borders.right),
                  borderBottom: borderStyle(cell.borders.bottom),
                  borderLeft: borderStyle(cell.borders.left),
                  backgroundColor: cell.shading,
                  verticalAlign: cell.verticalAlign === "center" ? "middle" : cell.verticalAlign,
                  textAlign: "left",
                  fontWeight: "normal",
                }}
              >
                <DocumentBlocks blocks={cell.blocks} defaultTabStop={defaultTabStop} />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
};
