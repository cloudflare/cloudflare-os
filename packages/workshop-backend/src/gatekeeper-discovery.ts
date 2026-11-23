// The Workshop's discovery calls to gatekeeper workers: describe() and getSupportedResources(),
// which list what a gatekeeper offers. Some gatekeepers answer them from a service of their own
// (a directory, say), so one that is slow or throttled must cost its own entry and not the list
// it is part of.

import { recordSubserviceCall } from "@gadgets/observability/metrics";
import { TimeoutError, withTimeout } from "./do-retry";

/** How long the Workshop waits on one gatekeeper's discovery before going on without it. */
export const DISCOVERY_TIMEOUT_MS = 10_000;

/** The `source` of every discovery point. */
const DISCOVERY_SOURCE = "workshop.gatekeeper.discovery";

/** Where a discovery call was made, recorded as its point's `detail`. */
export type DiscoverySite = "list" | "filter" | "ambient" | "connections" | "admin";

/**
 * Asks one gatekeeper a discovery question, bounded at DISCOVERY_TIMEOUT_MS, and records how it
 * went as a `subservice/v1` point: service `gatekeeper.<vendorId>`, operation `discovery`, with
 * its duration, and on failure the reason `timeout` or `threw`. Settles as `ask` does, or rejects
 * with a `TimeoutError` once the bound has passed; the call is not cancelled.
 */
export async function askVendor<T>(
    site: DiscoverySite, vendorId: string, ask: () => Promise<T>): Promise<T> {
  let started = Date.now();
  let point = {
    source: DISCOVERY_SOURCE, service: `gatekeeper.${vendorId}`, operation: "discovery",
    detail: site,
  };
  try {
    let answer = await withTimeout((async () => ask())(), DISCOVERY_TIMEOUT_MS,
        `Gatekeeper ${vendorId} did not answer discovery in time.`);
    recordSubserviceCall({ ...point, outcome: "success", durationMs: Date.now() - started });
    return answer;
  } catch (err) {
    recordSubserviceCall({
      ...point, outcome: "error", reason: err instanceof TimeoutError ? "timeout" : "threw",
      durationMs: Date.now() - started,
    });
    throw err;
  }
}
