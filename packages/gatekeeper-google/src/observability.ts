import { createObservabilityContext } from "@gadgets/observability/observability-context";

/** Observability fields emitted by the Google gatekeeper. */
export type GoogleObservabilityFields = {
  actionId: number | string;
  fileId: string;
  httpStatus: number;
  messageId: string;
  operation: string;
  provider: string;
  providerCode: number;
  providerReasons: string[];
  providerStatus: string;
  userObjectId: string;
  vendorId: string;
};

/** Ambient observability fields for one Google gatekeeper operation. */
export const obsContext = createObservabilityContext<GoogleObservabilityFields>();
