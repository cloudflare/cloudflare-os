import { createObservabilityContext } from "@gadgets/backend-utils/observability-context";

/** Observability fields emitted by the GitLab gatekeeper. */
export type GitLabObservabilityFields = { vendorId: string };

/** Ambient observability fields for one GitLab gatekeeper operation. */
export const obsContext = createObservabilityContext<GitLabObservabilityFields>();
