import { createObservabilityContext } from "@gadgets/observability/observability-context";

/** Observability fields emitted by the GitLab gatekeeper. */
export type GitLabObservabilityFields = {
  vendorId: string;
  /** A pipeline or job status GitLab sent that this gatekeeper does not recognise: an enum value, never free text. */
  ciStatus: string;
  /** The HTTP status a GitLab request failed with. */
  status: number;
  /** A code search engine: the one asked for, or the one GitLab's `X-Search-Type` names (cut to 32 characters). */
  searchEngine: string;
};

/** Ambient observability fields for one GitLab gatekeeper operation. */
export const obsContext = createObservabilityContext<GitLabObservabilityFields>();
