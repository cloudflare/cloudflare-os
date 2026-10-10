import { createObservabilityContext } from "@gadgets/observability/observability-context";

/** Observability fields emitted by the GitHub gatekeeper. */
export type GitHubObservabilityFields = {
  vendorId: string;
  /** The HTTP statuses a webhook's recent deliveries were answered with, as GitHub logged them. */
  deliveryStatuses: number[];
};

/** Ambient observability fields for one GitHub gatekeeper operation. */
export const obsContext = createObservabilityContext<GitHubObservabilityFields>();
