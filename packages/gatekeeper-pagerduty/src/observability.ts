import { createObservabilityContext } from "@gadgets/observability/observability-context";

/** Observability fields emitted by the PagerDuty gatekeeper. */
export type PagerDutyObservabilityFields = {
  vendorId: string;
};

/** Ambient observability fields for one PagerDuty gatekeeper operation. */
export const obsContext = createObservabilityContext<PagerDutyObservabilityFields>();
