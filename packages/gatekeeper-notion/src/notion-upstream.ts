// Notion's API as this gatekeeper's upstream: the paths it calls, by which a request is named, and
// the client every request to Notion is sent through and counted by (`subservice/v1` points under
// the source `gatekeeper.notion.api`). `NotionApi` sends the API's requests through it, and the
// OAuth helpers beside it their token requests.

import { ID, type Routes } from "@gadgets/gatekeeper-kit/route-operation";
import { defineUpstream } from "@gadgets/gatekeeper-kit/upstream";

/** The origin of Notion's API, which every request of this gatekeeper goes to. */
export const NOTION_API_ORIGIN = "https://api.notion.com";

/**
 * The paths this gatekeeper calls under Notion's API root. A request is named by the last resource
 * of its path and what is done to it: `pages.get`, `children.list`, `data_sources.query`; a search
 * is `search`. A request to a path that is not here is counted under its HTTP method: add the path
 * to name it.
 */
export const NOTION_ROUTES: Routes = [[`${NOTION_API_ORIGIN}/v1/`, {
  users: { me: "GET", [ID]: {} },
  pages: { [ID]: {} },
  databases: { [ID]: {} },
  data_sources: { [ID]: { query: "POST" } },
  blocks: { [ID]: { children: {} } },
  comments: {},
  search: "POST",
}]];

/**
 * The name of each request that `NOTION_ROUTES` cannot name: the two requests to the token
 * endpoint, which share a URL.
 */
export const NOTION_OPERATIONS = ["token.exchange", "token.refresh"] as const;

/** A name of `NOTION_OPERATIONS`. */
export type NotionOperation = (typeof NOTION_OPERATIONS)[number];

/**
 * The client every request to Notion goes through, with the defaults of `Upstream`: 30 seconds an
 * attempt, a GET sent again after a 429, 502, 503 or 504, a network failure or a timeout, every
 * other request sent once, and no redirect followed. Each attempt is counted as a subservice call
 * to the service `notion` under the source `gatekeeper.notion.api`.
 */
export const notionUpstream = defineUpstream({ vendorId: "notion", routes: NOTION_ROUTES });
