import { createObservabilityContext } from "@gadgets/observability/observability-context";

/** Observability fields emitted by the Google gatekeeper. */
export type GoogleObservabilityFields = {
  actionId: number | string;
  /** Which kind of queued action a log is about. */
  actionKind: string;
  /** A Drive comment or reply ID. */
  commentId: string;
  conversionKind: string;
  copyFileId: string;
  fileId: string;
  folderId: string;
  /** Whether a converted PDF had a text layer. */
  hasText: boolean;
  httpStatus: number;
  /** Size of a PDF page image sent for transcription, in bytes as stored in the PDF. */
  imageBytes: number;
  /** How a PDF page image is encoded, in the gatekeeper's own names. */
  imageEncoding: string;
  messageId: string;
  method: string;
  /** How many page images a scanned PDF has to transcribe. */
  ocrPages: number;
  operation: string;
  /** How an operation ended, as a class rather than a message. */
  outcome: string;
  /** Which page image of a PDF, from 1, in the order the file stores them. */
  page: number;
  /** Size of a PDF sent for conversion, in bytes. */
  pdfBytes: number;
  provider: string;
  providerCode: number;
  providerReasons: string[];
  providerStatus: string;
  userObjectId: string;
  vendorId: string;
};

/** Ambient observability fields for one Google gatekeeper operation. */
export const obsContext = createObservabilityContext<GoogleObservabilityFields>();
