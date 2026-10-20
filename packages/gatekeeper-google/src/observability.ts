import { createObservabilityContext } from "@gadgets/observability/observability-context";

/** Observability fields emitted by the Google gatekeeper. */
export type GoogleObservabilityFields = {
  actionId: number | string;
  conversionKind: string;
  copyFileId: string;
  fileId: string;
  /** Whether a converted PDF had a text layer. */
  hasText: boolean;
  httpStatus: number;
  messageId: string;
  method: string;
  operation: string;
  /** Size of a PDF sent for conversion, in bytes. */
  pdfBytes: number;
  provider: string;
  providerCode: number;
  providerReasons: string[];
  providerStatus: string;
  /** Length of converted text, in UTF-16 code units. */
  textChars: number;
  /** Whether converted text was cut at its size limit. */
  truncated: boolean;
  userObjectId: string;
  vendorId: string;
};

/** Ambient observability fields for one Google gatekeeper operation. */
export const obsContext = createObservabilityContext<GoogleObservabilityFields>();
