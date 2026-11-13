import type { DocxBlock } from "@gadgets/office-content/docx-document";
import { DocumentParagraph } from "./DocumentParagraph";
// A table's cells hold blocks of their own, so this and DocumentTable import each other.
import { DocumentTable } from "./DocumentTable";

/** A run of the document's blocks, in order: the body of a sheet, a header, a footer or a table cell. */
export const DocumentBlocks = ({ blocks, defaultTabStop }: {
  blocks: readonly DocxBlock[];
  defaultTabStop: number;
}) => blocks.map((block, index) => {
  switch (block.kind) {
    case "paragraph":
      return <DocumentParagraph key={index} paragraph={block} defaultTabStop={defaultTabStop} />;
    case "table":
      return <DocumentTable key={index} table={block} defaultTabStop={defaultTabStop} />;
    case "pageBreak":
      // Page breaks are where the preview starts a new sheet; within a cell they mean nothing.
      return null;
  }
});
