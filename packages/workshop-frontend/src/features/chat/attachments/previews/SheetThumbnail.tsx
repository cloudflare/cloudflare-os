import type { ReactNode } from "react";
import { derivedFrom } from "../derivedFrom";
import { SheetGrid } from "./SheetGrid";
import { ThumbnailStage } from "./ThumbnailStage";
import { readSheets } from "./WorkbookPreview";

/** The corner of the grid a card shows, in the grid's own pixels: about five columns across. */
const CORNER_SIZE = 360;
/** The grid is laid out this much larger than the corner shown, which puts its scrollbars out of sight. */
const SCROLLBAR_ROOM = 24;

/** The top-left corner of a workbook's first sheet, drawn card-sized; null when it has no cells. */
export const sheetThumbnail = async (bytes: Uint8Array): Promise<ReactNode> => {
  const { sheets, styles } = await derivedFrom(bytes, readSheets);
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
