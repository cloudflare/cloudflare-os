import { columnLetter } from "./sheetLayout";

/** Rows and columns shown at most; a notice says when a sheet has more. */
export const MAX_GRID_ROWS = 1000;
export const MAX_GRID_COLUMNS = 100;

const HEADER_CELL_CLASS =
  "border-b border-r border-kumo-line bg-kumo-elevated px-2 py-1 text-center text-[11px] font-medium text-kumo-subtle";

/**
 * A sheet of cells with lettered columns and numbered rows, which stay in view while scrolling.
 * `moreRows` tells the reader the rows given are not the whole sheet.
 */
export const DataGrid = ({ rows, moreRows }: {
  rows: readonly (readonly string[])[];
  moreRows: boolean;
}) => {
  const shown = rows.slice(0, MAX_GRID_ROWS);
  const width = shown.reduce((max, row) => Math.max(max, row.length), 0);
  const columns = Math.min(width, MAX_GRID_COLUMNS);
  const cut = [
    moreRows || rows.length > shown.length ? `the first ${shown.length.toLocaleString()} rows` : "",
    width > columns ? `the first ${columns} columns` : "",
  ].filter(Boolean);

  if (shown.length === 0) {
    return <div className="grid h-full place-items-center text-[13px] text-kumo-subtle">This sheet is empty.</div>;
  }

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-auto bg-kumo-base">
        <table className="border-separate border-spacing-0 text-[12px] leading-[18px] text-kumo-default">
          <thead>
            <tr>
              <th className={`sticky left-0 top-0 z-20 ${HEADER_CELL_CLASS}`} />
              {Array.from({ length: columns }, (_, column) => (
                <th key={column} scope="col" className={`sticky top-0 z-10 min-w-16 ${HEADER_CELL_CLASS}`}>
                  {columnLetter(column)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, rowIndex) => (
              <tr key={rowIndex}>
                <th scope="row" className={`sticky left-0 z-10 tabular-nums ${HEADER_CELL_CLASS}`}>
                  {rowIndex + 1}
                </th>
                {Array.from({ length: columns }, (_, column) => (
                  <td
                    key={column}
                    className="max-w-[320px] truncate whitespace-pre border-b border-r border-kumo-line px-2 py-1"
                    title={row[column] && row[column].length > 40 ? row[column] : undefined}
                  >
                    {row[column] ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {cut.length > 0 && (
        <div className="shrink-0 border-t border-kumo-line bg-kumo-base px-4 py-2 text-[12px] text-kumo-subtle">
          Showing {cut.join(" and ")}. Download the file to see all of it.
        </div>
      )}
    </div>
  );
};
