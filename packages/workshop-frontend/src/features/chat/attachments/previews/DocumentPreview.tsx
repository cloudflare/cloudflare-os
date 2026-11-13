import { use, useEffect, useRef, useState } from "react";
import {
  readDocxDocument, type DocxBlock, type DocxDocument, type DocxUnsupportedKind,
} from "@gadgets/office-content/docx-document";
import type { AttachmentPreviewProps } from "../attachmentPreviewers";
import { derivedFrom } from "../derivedFrom";
import { assertOpenXml } from "./assertOpenXml";
import { DocumentSheet } from "./DocumentSheet";
import { PX_PER_PT } from "./documentStyles";

/** Sheets are drawn no wider than this, however wide the viewer. */
const MAX_SHEET_WIDTH = 900;

const OMITTED_LABELS: Readonly<Record<DocxUnsupportedKind | "notes", string>> = {
  textBox: "text boxes",
  chart: "charts",
  diagram: "diagrams",
  equation: "equations",
  object: "embedded objects",
  shape: "shapes",
  picture: "some pictures",
  notes: "footnote text",
};

/** A document's layout, refusing a password-protected file. */
export const readDocument = async (bytes: Uint8Array): Promise<DocxDocument> => {
  assertOpenXml(bytes);
  return readDocxDocument(bytes);
};

/** The body as the runs of blocks between its page breaks, one per sheet. */
const splitSheets = (body: readonly DocxBlock[]): DocxBlock[][] => {
  const sheets: DocxBlock[][] = [[]];
  for (const block of body) {
    if (block.kind === "pageBreak") sheets.push([]);
    else sheets[sheets.length - 1]!.push(block);
  }
  return sheets;
};

/**
 * A Word document drawn as it looks in Word: its page size and margins, fonts, colours, spacing,
 * lists, tables, pictures, header and footer.
 *
 * Pages are not broken where Word would break them, which would need Word's own line breaking and
 * fonts. The body is one continuous sheet, as tall as it needs to be, and a new sheet starts only
 * where the document asks for a new page. The first section's header is at the top of the first
 * sheet and its footer at the bottom of the last. Fonts are the reader's own: where neither an
 * Office font nor its metric-compatible stand-in is installed, lines break slightly differently.
 */
export const DocumentPreview = ({ bytes }: AttachmentPreviewProps) => {
  const document = use(derivedFrom(bytes, readDocument));
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.min(MAX_SHEET_WIDTH, Math.floor(entry.contentRect.width)));
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const sheets = splitSheets(document.body);
  const scale = width / (document.page.width * PX_PER_PT);
  const omitted = document.omitted.map(kind => OMITTED_LABELS[kind]);

  return (
    <div className="min-h-full">
      {(omitted.length > 0 || document.truncated) && (
        <div className="sticky top-0 z-10 border-b border-kumo-line bg-kumo-elevated px-4 py-2 text-center text-[12px] leading-4 text-kumo-subtle">
          {omitted.length > 0 && `Not shown: ${omitted.join(", ")}. `}
          {document.truncated && "This document is too long to show in full. "}
          Download the file to see everything.
        </div>
      )}
      <div className="px-4 py-4">
        <div ref={containerRef} className="flex flex-col items-center gap-3">
          {width > 0 && sheets.map((blocks, index) => (
            <DocumentSheet
              key={index}
              page={document.page}
              scale={scale}
              blocks={blocks}
              header={index === 0 ? document.header : undefined}
              footer={index === sheets.length - 1 ? document.footer : undefined}
              defaultTabStop={document.defaultTabStop}
            />
          ))}
        </div>
      </div>
    </div>
  );
};
