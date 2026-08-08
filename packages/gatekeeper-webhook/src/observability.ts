import { createObservabilityContext } from "@gadgets/backend-utils/observability-context";

/** Bounded observability fields emitted by the Webhooks gatekeeper. */
export type WebhookObservabilityFields = {
  accountId: string;
  workspaceId: string;
  endpointId: string;
  deliveryId: string;
  attempt: number;
  operation: string;
  durationMs: number;
  dueCount: number;
  batchSize: number;
  backlogCount: number;
  status: number;
  vendorId: string;
};

/** Ambient observability fields for one Webhooks operation. */
export const obsContext = createObservabilityContext<WebhookObservabilityFields>();
