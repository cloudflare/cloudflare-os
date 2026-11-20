/**
 * The client every request to Supabase is sent through (`@gadgets/gatekeeper-kit/upstream`), and
 * the names its requests are counted under as subservice metrics: the route tree of the
 * Management API's paths, and a literal for each request to the OAuth endpoints.
 */

import { ID, ONE, type Routes } from "@gadgets/gatekeeper-kit/route-operation";
import { defineUpstream } from "@gadgets/gatekeeper-kit/upstream";

/** The origin of the Supabase Management API and of its OAuth endpoints. */
export const SUPABASE_API_ORIGIN = "https://api.supabase.com";

/**
 * The Management API paths this gatekeeper calls, from which a request is named
 * (`routeOperation`): the last resource of its path and what is done to it, as `projects.list`,
 * `projects.get`, `buckets.list` or `body.get`. A project's ref and a function's slug are IDs. SQL
 * is a POST of a project's `query` resource: `query.read-only` for a statement run as the
 * read-only role, `query.create` for one that may write. A request to a path that is not here is
 * counted under its HTTP method: add the path to name it.
 */
export const SUPABASE_ROUTES: Routes = [[`${SUPABASE_API_ORIGIN}/v1/`, {
  organizations: {},
  projects: {
    [ID]: {
      database: { query: { "read-only": "POST" } },
      functions: { [ID]: { body: ONE } },
      storage: { buckets: {} },
      health: ONE,
    },
  },
}]];

/**
 * The names of the requests to the OAuth endpoints, which no path tells apart: an exchange and a
 * refresh share a URL. Each is a literal at its call site.
 */
export const SUPABASE_TOKEN_OPERATIONS = ["token.exchange", "token.refresh", "token.revoke"] as const;

/** The name of one request to the OAuth endpoints: a member of `SUPABASE_TOKEN_OPERATIONS`. */
export type SupabaseTokenOperation = (typeof SUPABASE_TOKEN_OPERATIONS)[number];

/**
 * The client every request to Supabase goes through. Each attempt has 30 seconds, the reading of
 * its answer included, and no redirect is followed. A GET that is answered 429, 502, 503 or 504,
 * that fails on the network or that times out is sent again, three sends at most. Every other
 * request is a POST, which that rule sends once: a SQL statement, and a token request, whose
 * second send would spend a code or a refresh token that the first may have used. A statement
 * that may write says so itself as well (`retry: null` in `SupabaseApi.runQuery`), since a second
 * send could apply it twice. Each attempt is counted as a subservice call to the service
 * `supabase` under the source `gatekeeper.supabase.api`.
 */
export const supabaseUpstream = defineUpstream({ vendorId: "supabase", routes: SUPABASE_ROUTES });
