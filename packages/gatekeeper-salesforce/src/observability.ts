import { createObservabilityContext } from "@gadgets/backend-utils/observability-context";

/** Bounded observability fields emitted by the Salesforce gatekeeper. */
export type SalesforceObservabilityFields = {
  accountId: string;
  objectType: string;
  operation: string;
  durationMs: number;
  batchSize: number;
  recordCount: number;
  queryTopK: number;
  syncMode: string;
  vendorId: string;
};

/** Ambient observability fields for one Salesforce operation. */
export const obsContext = createObservabilityContext<SalesforceObservabilityFields>();
