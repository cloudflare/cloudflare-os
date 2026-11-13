import type { ReactNode } from "react";
import { readWorkbookSheets } from "@gadgets/office-content/xlsx-sheets";
import { derivedFrom } from "../derivedFrom";
import { assertOpenXml } from "./assertOpenXml";
import { SheetGrid } from "./SheetGrid";
import { ThumbnailStage } from "./ThumbnailStage";

/** The corner of the grid a card shows, in the grid's own pixels: about five columns across. */
const CORNER_SIZE = 360;
/** The grid is laid out this much larger than the corner shown, which puts its scrollbars out of sight. */
const SCROLLBAR_ROOM = 24;

/**
 * Only as many rows and columns as the corner can show, however narrow they are: the viewer reads
 * the whole sheet once it is opened, and a card mounts only these cells.
 */
const readCorner = (bytes: Uint8Array) => {
  assertOpenXml(bytes);
  return readWorkbookSheets(bytes, { maxRows: 40, maxColumns: 20 });
};

/** The top-left corner of a workbook's first sheet, drawn card-sized; null when it has no cells. */
export const sheetThumbnail = async (bytes: Uint8Array): Promise<ReactNode> => {
  const { sheets, styles } = await derivedFrom(bytes, readCorner);
  const [sheet] = sheets;
  if (!sheet || sheet.rowCount === 0) return null;
  return (
    <ThumbnailStage>
      {(width) => (
        <div className="self-start justify-self-start overflow-hidden" style={{ width, height: width }}>
          <div
            className="origin-top-left"
            style={{ width: CORNER_SIZE + SCROLLBAR_ROOM, height: CORNER_SIZE + SCROLLBAR_ROOM, transform: `scale(${width / CORNER_SIZE})` }}
          >
            <SheetGrid sheet={sheet} styles={styles} />
          </div>
        </div>
      )}
    </ThumbnailStage>
  );
};
