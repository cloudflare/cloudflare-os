import { createObservabilityContext } from "@gadgets/observability/observability-context";

/** Observability fields emitted by the Linear gatekeeper. */
export type LinearObservabilityFields = { vendorId: string };

/** Ambient observability fields for one Linear gatekeeper operation. */
export const obsContext = createObservabilityContext<LinearObservabilityFields>();
