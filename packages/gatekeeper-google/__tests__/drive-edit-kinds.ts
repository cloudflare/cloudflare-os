import type { ActionKind } from "@gadgets/workshop-shared/gatekeeper";

/** What a Drive binding's label adds to an editor's own: the kind covers every such file it reaches. */
function onDrive(kind: ActionKind, noun: string): ActionKind {
  return { tag: kind.tag, label: `${kind.label}, in any ${noun} this connection reaches` };
}

/** The Slides kinds a user may let apply without asking, as a read and write Drive binding lists them. */
export const DRIVE_SLIDES_KINDS: ActionKind[] = [
  { tag: "editSlidesText", label: "Slide text edits" },
  { tag: "formatSlides", label: "Slide formatting and arrangement" },
  {
    tag: "edit-slides",
    label: "Slide edits that keep every element, table row and column and download no images",
  },
  { tag: "delete-slide-content", label: "Slide changes that delete elements, table rows or columns" },
  { tag: "arrange-slides", label: "Adding, copying and reordering slides" },
  { tag: "delete-slides", label: "Deleting slides" },
  { tag: "skipSlides", label: "Skipping slides" },
].map(kind => onDrive(kind, "presentation"));

/** The Sheets kinds a user may let apply without asking, as a read and write Drive binding lists them. */
export const DRIVE_SHEETS_KINDS: ActionKind[] = [
  { tag: "editSheetValues", label: "Sheet value edits" },
  { tag: "formatSheets", label: "Sheet formatting" },
  { tag: "edit-spreadsheet", label: "Spreadsheet edits that keep every sheet, row and column" },
  {
    tag: "layout-spreadsheet",
    label: "Spreadsheet edits that resize rows or columns, freeze lines or unmerge cells",
  },
  {
    tag: "delete-spreadsheet-content",
    label: "Spreadsheet changes that delete sheets, rows, columns or merged cells' values",
  },
].map(kind => onDrive(kind, "spreadsheet"));

/** The Doc kinds a user may let apply without asking, as a read and write Drive binding lists them. */
export const DRIVE_DOCS_KINDS: ActionKind[] = [
  { tag: "editDocument", label: "Document edits" },
  { tag: "document-tables", label: "Table changes" },
].map(kind => onDrive(kind, "Doc"));
