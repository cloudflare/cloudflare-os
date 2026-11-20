// ZoomInfo's API as this gatekeeper's upstream: the paths it calls, by which a request is named,
// and the client every request to ZoomInfo is sent through and counted by (`subservice/v1` points
// under the source `gatekeeper.zoominfo.api`). `ZoomInfoApi` sends the API's requests through it,
// and the token requests are sent through it under their literal names.

import { ID, routeOperation, type Routes, type Tree } from "@gadgets/gatekeeper-kit/route-operation";
import { defineUpstream, type Upstream, type UpstreamOptions } from "@gadgets/gatekeeper-kit/upstream";
import { stripTrailingSlashes } from "@gadgets/workshop-shared/gatekeeper";

/** The API root of a deployment that configures none. */
export const DEFAULT_API_BASE_URL = "https://api.zoominfo.com/gtm";

/**
 * The paths this gatekeeper calls under the API root. A request is named by the last resource of
 * its path and what is done to it: `companies.search`, `hashtags.enrich`, `users.usage`. The field
 * a lookup names and the company an account summary is of are IDs, which are never read. A request
 * to a path that is not here is counted under its HTTP method: add the path to name it.
 */
export const ZOOMINFO_TREE: Tree = {
  data: {
    v1: {
      lookup: { enrich: "GET", [ID]: {} },
      companies: {
        search: "POST",
        enrich: "POST",
        "corporate-hierarchy": { enrich: "POST" },
        hashtags: { enrich: "POST" },
      },
      contacts: { search: "POST", enrich: "POST" },
      intent: { search: "POST", enrich: "POST" },
      scoops: { search: "POST", enrich: "POST" },
      news: { search: "POST", enrich: "POST" },
      users: { usage: "GET" },
    },
  },
  copilot: {
    v1: {
      companies: {
        lookalikes: "GET",
        insights: "POST",
        [ID]: { "account-summary": { actions: { ask: "POST" } } },
      },
      contacts: { lookalikes: "GET", recommendations: "GET" },
    },
  },
};

/**
 * The names given to the requests whose paths `ZOOMINFO_TREE` cannot spell. A company's account
 * summary is one thing with a path under it, which a tree reads as a resource that is listed.
 */
export const SHAPE_OPERATIONS = ["account-summary.get"] as const;

/**
 * The names of the token requests, each a literal where it is sent: an exchange and a refresh
 * share the token URL, which a deployment may configure.
 */
export const TOKEN_OPERATIONS = ["token.exchange", "token.refresh"] as const;

/** A name of `TOKEN_OPERATIONS`. */
export type TokenOperation = typeof TOKEN_OPERATIONS[number];

/**
 * The paths this gatekeeper calls, as `ZOOMINFO_TREE` under the API root of a deployment. The root
 * is where a request is read from and no part of a name, so no host or path of a deployment's own
 * reaches a point.
 * @param apiBaseUrl The API root, as `resolveOAuthConfig` gives it.
 * @returns The routes, which are empty for a root that is no URL: no request is sent under one.
 */
export function zoominfoRoutes(apiBaseUrl: string): Routes {
  const base = URL.parse(apiBaseUrl);
  if (!base) return [];
  return [[`${stripTrailingSlashes(base.origin + base.pathname)}/`, ZOOMINFO_TREE]];
}

// How the requests under one API root are named: by the tree under that root, after a namer for
// the path the tree cannot spell.
function namedUnder(apiBaseUrl: string): Pick<UpstreamOptions, "routes" | "operation"> {
  const routes = zoominfoRoutes(apiBaseUrl);
  const [accountSummary] = SHAPE_OPERATIONS;
  return {
    routes,
    operation: (method, url) =>
      routeOperation(routes, method, url) === "account-summary.list" ? accountSummary : undefined,
  };
}

/**
 * The client every request to ZoomInfo goes through, naming the requests under the default API
 * root: 30 seconds per attempt, no redirect followed, and the client's default retry. A GET, which
 * spends no credits, is sent again after a 429, 502, 503 or 504, a network failure or a timeout.
 * Every other request is a POST and is sent once: an enrichment spends credits, a refresh token is
 * redeemed once, and a search is not marked as safe to send twice.
 */
export const zoominfoUpstream = defineUpstream({ vendorId: "zoominfo", ...namedUnder(DEFAULT_API_BASE_URL) });

/**
 * The upstream of a deployment whose API root is `apiBaseUrl`: `zoominfoUpstream`, naming the
 * requests under that root in place of the default one.
 * @param apiBaseUrl The API root, as `resolveOAuthConfig` gives it.
 * @returns The upstream. Never throws: under a root that is no URL a request has no name.
 */
export function zoominfoUpstreamAt(apiBaseUrl: string): Upstream {
  return apiBaseUrl === DEFAULT_API_BASE_URL ? zoominfoUpstream : zoominfoUpstream.with(namedUnder(apiBaseUrl));
}
