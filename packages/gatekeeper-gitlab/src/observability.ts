import { createObservabilityContext } from "@gadgets/observability/observability-context";

/** Observability fields emitted by the GitLab gatekeeper. */
export type GitLabObservabilityFields = {
  vendorId: string;
  /** A pipeline or job status GitLab sent that this gatekeeper does not recognise: an enum value, never free text. */
  ciStatus: string;
};

/** Ambient observability fields for one GitLab gatekeeper operation. */
export const obsContext = createObservabilityContext<GitLabObservabilityFields>();
