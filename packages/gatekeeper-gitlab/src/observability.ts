import { createObservabilityContext } from "@gadgets/observability/observability-context";

/** Observability fields emitted by the GitLab gatekeeper. */
export type GitLabObservabilityFields = {
  vendorId: string;
  /** The statuses a webhook's recent deliveries were answered with, as GitLab logged them. */
  deliveryStatuses: string[];
};

/** Ambient observability fields for one GitLab gatekeeper operation. */
export const obsContext = createObservabilityContext<GitLabObservabilityFields>();
