// Cloudflare's API as this gatekeeper's upstream: the paths it calls, by which a request is named,
// and the client every request to Cloudflare is sent through and counted by (`subservice/v1` points
// under the source `gatekeeper.cloudflare.api`). The REST helper (`cloudflare-api.ts`) and the
// Workers Observability client (`observability-api.ts`) send the API's requests through it, and the
// OAuth client (`oauth.ts`) its token requests.

import { ID, ONE, type Routes } from "@gadgets/gatekeeper-kit/route-operation";
import { defineUpstream } from "@gadgets/gatekeeper-kit/upstream";
import { VENDOR_ID } from "./vendor.js";

/** The root of Cloudflare's REST API, which every path this gatekeeper calls is under. */
export const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";

/**
 * The paths this gatekeeper calls under Cloudflare's API root. A request is named by the last
 * resource of its path and what is done to it: `user.get`, `accounts.list`, `telemetry.query`,
 * `telemetry.keys`, `telemetry.values`. An account's id is an ID and reaches no name. A request to
 * a path that is not here is counted under its HTTP method: add the path to name it.
 */
export const CLOUDFLARE_ROUTES: Routes = [[`${CLOUDFLARE_API_BASE}/`, {
  user: ONE,
  accounts: {
    [ID]: {
      workers: { observability: { telemetry: { query: "POST", keys: "POST", values: "POST" } } },
    },
  },
}]];

/**
 * The client every request to Cloudflare goes through: the REST API and the dashboard's OAuth
 * token endpoint. Each attempt has 30 seconds and is one subservice metric point under the source
 * `gatekeeper.cloudflare.api` and the service `cloudflare`. No redirect is followed. A GET that
 * was answered 429, 502, 503 or 504, or got no answer, is sent up to three times; a telemetry
 * request states a retry rule of its own (`telemetryRetry` in `observability-api.ts`), and a
 * token request is sent once.
 */
export const cloudflareUpstream = defineUpstream({ vendorId: VENDOR_ID, routes: CLOUDFLARE_ROUTES });
