import { createObservabilityContext } from "@gadgets/observability/observability-context";

/** Observability fields emitted by the GitHub gatekeeper. */
export type GitHubObservabilityFields = {
  vendorId: string;
  /** The HTTP statuses a webhook's recent deliveries were answered with, as GitHub logged them. */
  deliveryStatuses: number[];
  /** Which field of a GitHub CI response carried a value this gatekeeper does not recognise. */
  ciField: string;
  /** The unrecognised value itself: an enum value GitHub sent, never free text. */
  ciValue: string;
  /** How many errors GitHub returned alongside partial GraphQL data. */
  graphqlErrorCount: number;
};

/** Ambient observability fields for one GitHub gatekeeper operation. */
export const obsContext = createObservabilityContext<GitHubObservabilityFields>();
