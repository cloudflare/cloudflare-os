import { createObservabilityContext } from "@gadgets/observability/observability-context";

/** Observability fields emitted by the Acme Service gatekeeper. */
export type AcmeObservabilityFields = {
  vendorId: string;
};

/** Ambient observability fields for one Acme Service gatekeeper operation. */
export const obsContext = createObservabilityContext<AcmeObservabilityFields>();
