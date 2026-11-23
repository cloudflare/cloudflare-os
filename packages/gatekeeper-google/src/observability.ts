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
  /**
   * Bytes of a PDF page sent for transcription: of a page image as the PDF stores it, or of a
   * band of a rendered page as PNG, summed over every time the band was asked for.
   */
  imageBytes: number;
  /** How a PDF page image is encoded, in the gatekeeper's own names. */
  imageEncoding: string;
  messageId: string;
  method: string;
  /**
   * How many pages a PDF has to transcribe: the page images it stores, or, when its pages are
   * rendered, the pages the renderer counted in it.
   */
  ocrPages: number;
  operation: string;
  /** How an operation ended, as a class rather than a message. */
  outcome: string;
  /**
   * Which page of a PDF, from 1: of its page images in the order the file stores them, or, when
   * its pages are rendered, of the document's pages.
   */
  page: number;
  /** Size of a PDF sent for conversion, in bytes. */
  pdfBytes: number;
  provider: string;
  providerCode: number;
  /** The `error` code of a refused OAuth token request, such as `invalid_grant`. */
  providerError: string;
  /** Whether a failed Google request's error body was read to the end and parsed. */
  providerErrorRead: boolean;
  providerReasons: string[];
  providerStatus: string;
  /** The `error_subtype` code of a refused OAuth token request, such as `invalid_rapt`. */
  providerSubtype: string;
  userObjectId: string;
  vendorId: string;
};

/** Ambient observability fields for one Google gatekeeper operation. */
export const obsContext = createObservabilityContext<GoogleObservabilityFields>();
