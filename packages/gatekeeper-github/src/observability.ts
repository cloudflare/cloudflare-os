import { createObservabilityContext } from "@gadgets/observability/observability-context";

/** Observability fields emitted by the GitHub gatekeeper. */
export type GitHubObservabilityFields = { vendorId: string };

/** Ambient observability fields for one GitHub gatekeeper operation. */
export const obsContext = createObservabilityContext<GitHubObservabilityFields>();
