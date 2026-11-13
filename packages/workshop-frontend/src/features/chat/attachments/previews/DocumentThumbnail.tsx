import type { ReactNode } from "react";
import { readDocxDocument } from "@gadgets/office-content/docx-document";
import { derivedFrom } from "../derivedFrom";
import { assertOpenXml } from "./assertOpenXml";
import { DocumentSheet } from "./DocumentSheet";
import { PX_PER_PT } from "./documentStyles";
import { ThumbnailStage } from "./ThumbnailStage";

/** More blocks than the top of a page holds, so a long document is not laid out to draw a card. */
const THUMBNAIL_BLOCKS = 40;

/** Only the start of the document: the viewer reads all of it once it is opened. */
const readStart = (bytes: Uint8Array) => {
  assertOpenXml(bytes);
  return readDocxDocument(bytes, { maxBlocks: THUMBNAIL_BLOCKS });
};

/** The margin kept around the text, in points: a card has no room for a page's full margins. */
const THUMBNAIL_MARGIN = 28;

/** The top of a document's first page, drawn card-sized and closed in on its text; null for a blank page. */
export const documentThumbnail = async (bytes: Uint8Array): Promise<ReactNode> => {
  const document = await derivedFrom(bytes, readStart);
  const firstBreak = document.body.findIndex((block) => block.kind === "pageBreak");
  const blocks = document.body.slice(0, Math.min(THUMBNAIL_BLOCKS, firstBreak < 0 ? Infinity : firstBreak));
  if (blocks.length === 0 && document.header.length === 0) return null;
  return (
    <ThumbnailStage>
      {(width) => {
        const { page } = document;
        const trimX = Math.max(0, Math.min(page.marginLeft, page.marginRight) - THUMBNAIL_MARGIN);
        const trimY = Math.max(0, page.marginTop - THUMBNAIL_MARGIN);
        const scale = width / ((page.width - 2 * trimX) * PX_PER_PT);
        return (
        <div
          className="self-start justify-self-start"
          style={{ marginLeft: -trimX * PX_PER_PT * scale, marginTop: -trimY * PX_PER_PT * scale }}
        >
          <DocumentSheet
            page={page}
            scale={scale}
            blocks={blocks}
            header={document.header}
            defaultTabStop={document.defaultTabStop}
          />
        </div>
        );
      }}
    </ThumbnailStage>
  );
};
