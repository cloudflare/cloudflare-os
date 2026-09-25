import { createObservabilityContext } from "@gadgets/observability/observability-context";

/** Observability fields emitted by the Supabase gatekeeper. */
export type SupabaseObservabilityFields = { vendorId: string };

/** Ambient observability fields for one Supabase gatekeeper operation. */
export const obsContext = createObservabilityContext<SupabaseObservabilityFields>();
