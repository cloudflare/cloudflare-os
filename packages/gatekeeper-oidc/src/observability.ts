import { createObservabilityContext } from "@gadgets/backend-utils/observability-context";

/**
 * Observability fields emitted by the OIDC gatekeeper.
 *
 * `issuer` is a deployment-configured URL, not user data, so it is safe to index — and it is the
 * field that makes a discovery or verification failure diagnosable at all.
 */
export type OidcObservabilityFields = { vendorId: string; issuer?: string };

/** Ambient observability fields for one OIDC gatekeeper operation. */
export const obsContext = createObservabilityContext<OidcObservabilityFields>();
