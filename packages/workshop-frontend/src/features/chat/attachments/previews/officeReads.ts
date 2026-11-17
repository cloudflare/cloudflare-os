import { readDocxDocument } from "@gadgets/office-content/docx-document";
import { readPptxSlides } from "@gadgets/office-content/pptx-slides";
import { readWorkbookSheets } from "@gadgets/office-content/xlsx-sheets";

/** The Office readers the previews run, by the name a request to the reading worker gives. */
export const OFFICE_READS = {
  document: readDocxDocument,
  slides: readPptxSlides,
  workbook: readWorkbookSheets,
};

/** One of the Office readers. */
export type OfficeRead = keyof typeof OFFICE_READS;

/** What a reader takes besides the file's bytes. */
export type OfficeReadOptions<R extends OfficeRead> = NonNullable<Parameters<(typeof OFFICE_READS)[R]>[1]>;

/** What a reader returns. */
export type OfficeReadResult<R extends OfficeRead> = Awaited<ReturnType<(typeof OFFICE_READS)[R]>>;

/** A request to the reading worker. */
export interface OfficeReadRequest {
  readonly id: number;
  readonly read: OfficeRead;
  readonly bytes: Uint8Array;
  readonly options: unknown;
}

/** The worker's answer: the model read, or why the file could not be read. */
export type OfficeReadResponse =
  | { readonly id: number; readonly result: unknown }
  | { readonly id: number; readonly error: string };
