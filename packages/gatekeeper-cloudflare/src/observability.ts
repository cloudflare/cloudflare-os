import { createObservabilityContext } from "@gadgets/backend-utils/observability-context";

/** Observability fields emitted by the Cloudflare gatekeeper. */
export type CloudflareObservabilityFields = {
  accountsListed: number;
  /** Events a Worker-scoped read had to drop, proving the provider ignored the scope filter. */
  droppedEvents: number;
  path: string;
  /** Cloudflare error codes from a failed provider response. Codes only -- never the messages. */
  providerCodes: string;
  status: number;
  statusText: string;
  attempt: number;
  totalCount: number;
  vendorId: string;
};

/** Ambient observability fields for one Cloudflare gatekeeper operation. */
export const obsContext = createObservabilityContext<CloudflareObservabilityFields>();
