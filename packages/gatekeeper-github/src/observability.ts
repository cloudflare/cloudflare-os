import { createObservabilityContext } from "@gadgets/backend-utils/observability-context";

/** Observability fields emitted by the GitHub gatekeeper. */
export type GitHubObservabilityFields = { vendorId: string; actionId?: number };

/** Ambient observability fields for one GitHub gatekeeper operation. */
export const obsContext = createObservabilityContext<GitHubObservabilityFields>();
