import { createObservabilityContext } from "@gadgets/backend-utils/observability-context";

/** Observability fields emitted by the Cloudflare gatekeeper. */
export type CloudflareObservabilityFields = {
  path: string;
  status: number;
  statusText: string;
  attempt: number;
  vendorId: string;
};

/** Ambient observability fields for one Cloudflare gatekeeper operation. */
export const obsContext = createObservabilityContext<CloudflareObservabilityFields>();
