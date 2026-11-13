import { use, useState } from "react";
import { Tabs } from "@cloudflare/kumo";
import { readWorkbookSheets, type UndrawnFeature } from "@gadgets/office-content/xlsx-sheets";
import type { AttachmentPreviewProps } from "../attachmentPreviewers";
import { derivedFrom } from "../derivedFrom";
import { assertOpenXml } from "./assertOpenXml";
import { MAX_GRID_COLUMNS, MAX_GRID_ROWS } from "./DataGrid";
import { SheetGrid } from "./SheetGrid";

/** A workbook's sheets, refusing a password-protected file. */
export const readSheets = async (bytes: Uint8Array) => {
  assertOpenXml(bytes);
  return readWorkbookSheets(bytes, { maxRows: MAX_GRID_ROWS, maxColumns: MAX_GRID_COLUMNS });
};

const UNDRAWN_NAMES: Record<UndrawnFeature, string> = {
  charts: "charts",
  images: "pictures",
  shapes: "shapes",
  comments: "comments",
  conditionalFormatting: "conditional formatting",
  dataValidation: "data validation",
  sparklines: "sparklines",
  pivotTables: "pivot tables",
};

const listed = new Intl.ListFormat("en", { type: "conjunction" });

// "Charts and conditional formatting aren't shown.", so the preview is not taken for the whole sheet.
const undrawnNotice = (undrawn: readonly UndrawnFeature[]): string => {
  const names = listed.format(undrawn.map((feature) => UNDRAWN_NAMES[feature]));
  return `${names[0].toUpperCase()}${names.slice(1)} aren’t shown.`;
};

/** An Excel workbook as it looks in Excel, one sheet at a time, with its sheet tabs along the bottom. */
export const WorkbookPreview = ({ bytes }: AttachmentPreviewProps) => {
  const { sheets, styles } = use(derivedFrom(bytes, readSheets));
  const [active, setActive] = useState(0);
  const sheet = sheets[active];

  if (!sheet) {
    return (
      <div className="grid h-full place-items-center text-[13px] text-kumo-subtle">
        This workbook has no sheets to show.
      </div>
    );
  }

  const notices = [
    sheet.undrawn.length > 0 ? undrawnNotice(sheet.undrawn) : "",
    // Without this an empty total reads as a real, empty value.
    sheet.uncalculatedFormulas ? "Formulas this file holds no results for show as empty." : "",
    sheet.truncated
      ? `Showing at most the first ${MAX_GRID_ROWS.toLocaleString()} rows and ${MAX_GRID_COLUMNS} columns. Download the file to see all of it.`
      : "",
  ].filter(Boolean);

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1">
        {sheet.rowCount === 0
          ? <div className="grid h-full place-items-center text-[13px] text-kumo-subtle">This sheet is empty.</div>
          : <SheetGrid key={active} sheet={sheet} styles={styles} />}
      </div>
      {notices.length > 0 && (
        <div className="shrink-0 border-t border-kumo-line bg-kumo-base px-4 py-2 text-[12px] text-kumo-subtle">
          {notices.join(" ")}
        </div>
      )}
      {sheets.length > 1 && (
        <div className="shrink-0 overflow-x-auto border-t border-kumo-line bg-kumo-base px-3 py-2">
          <Tabs
            size="sm"
            value={String(active)}
            onValueChange={(value) => setActive(Number(value))}
            tabs={sheets.map((item, index) => ({ value: String(index), label: item.name }))}
          />
        </div>
      )}
    </div>
  );
};
