import { useMemo } from "react";
import type { AttachmentPreviewProps } from "../attachmentPreviewers";
import { DataGrid, MAX_GRID_ROWS } from "./DataGrid";
import { decodeText } from "./decodeText";
import { parseDelimited, sniffDelimiter } from "./parseDelimited";

/** A CSV or TSV file as a grid. */
export const DelimitedPreview = ({ bytes, name, mimeType }: AttachmentPreviewProps) => {
  const tabs = mimeType === "text/tab-separated-values" || name.toLowerCase().endsWith(".tsv");
  const { rows, truncated } = useMemo(
    () => {
      const text = decodeText(bytes);
      return parseDelimited(text, tabs ? "\t" : sniffDelimiter(text), MAX_GRID_ROWS);
    },
    [bytes, tabs],
  );
  return <DataGrid rows={rows} moreRows={truncated} />;
};
