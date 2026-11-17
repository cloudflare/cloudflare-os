import { lazy, memo, type ComponentType, type MemoExoticComponent } from "react";
import type { PreviewFormat } from "./previewFormat";

/** What a previewer is given: the whole file, already loaded. */
export type AttachmentPreviewProps = {
  bytes: Uint8Array;
  name: string;
  mimeType: string;
};

/**
 * A failure whose message is written for the person looking at the file, such as a PDF that needs
 * a password. Anything else a previewer throws is shown as a generic failure.
 */
export class AttachmentPreviewError extends Error {}

type Previewer = MemoExoticComponent<ComponentType<AttachmentPreviewProps>>;

// Memoised: the viewer sits in a message, which renders again on every streamed token, and an
// open document or grid is too large to reconcile each time. A previewer's props do not change.
const previewer = (load: () => Promise<ComponentType<AttachmentPreviewProps>>): Previewer =>
  memo(lazy(() => load().then((component) => ({ default: component }))));

/**
 * The previewer for each format. Adding a format is an entry here, a case in `previewFormat`, and
 * the component. Each loads on first use, so a parser costs nothing until a file needs it.
 */
export const ATTACHMENT_PREVIEWERS: Record<PreviewFormat, Previewer> = {
  image: previewer(() => import("./previews/ImagePreview").then(m => m.ImagePreview)),
  pdf: previewer(() => import("./previews/PdfPreview").then(m => m.PdfPreview)),
  text: previewer(() => import("./previews/TextPreview").then(m => m.TextPreview)),
  markdown: previewer(() => import("./previews/MarkdownPreview").then(m => m.MarkdownPreview)),
  delimited: previewer(() => import("./previews/DelimitedPreview").then(m => m.DelimitedPreview)),
  workbook: previewer(() => import("./previews/WorkbookPreview").then(m => m.WorkbookPreview)),
  document: previewer(() => import("./previews/DocumentPreview").then(m => m.DocumentPreview)),
  slides: previewer(() => import("./previews/SlidesPreview").then(m => m.SlidesPreview)),
};
