/**
 * Atlassian, as this gatekeeper's upstream: the client every request to it is sent through
 * (`@gadgets/gatekeeper-kit/upstream`), and the names its requests are counted under as subservice
 * metrics (`subservice/v1` points under the source `gatekeeper.confluence.api`): the route tree of
 * the REST paths it calls, and a literal for each request that no path names.
 */

import { ID, ONE, type Routes, type Tree } from "@gadgets/gatekeeper-kit/route-operation";
import { defineUpstream } from "@gadgets/gatekeeper-kit/upstream";

/** The origin of Atlassian's OAuth endpoints. */
export const ATLASSIAN_AUTH = "https://auth.atlassian.com";
/** The origin of Atlassian's API gateway, which serves each site's Confluence API by cloud ID. */
export const ATLASSIAN_API = "https://api.atlassian.com";

// What is listed beneath a page or a blog post.
const CONTENT: Tree = { "footer-comments": {}, labels: {}, attachments: {} };
// The content tree beneath a page, folder, whiteboard, database or embed.
const CONTENT_TREE: Tree = { "direct-children": {}, descendants: {} };

// The v2 API (`/wiki/api/v2/`).
const V2: Tree = {
  spaces: { [ID]: { pages: {} } },
  pages: { [ID]: { ...CONTENT, ...CONTENT_TREE, children: {} } },
  blogposts: { [ID]: CONTENT },
  folders: { [ID]: CONTENT_TREE },
  whiteboards: { [ID]: CONTENT_TREE },
  databases: { [ID]: CONTENT_TREE },
  embeds: { [ID]: CONTENT_TREE },
  "footer-comments": { [ID]: {} },
  attachments: { [ID]: {} },
};

// The v1 API (`/wiki/rest/api/`), for what v2 has no endpoint for.
const V1: Tree = {
  search: {},
  content: { [ID]: { label: {}, child: { attachment: {} } } },
};

/**
 * The REST paths this gatekeeper calls on Atlassian's API gateway, from which a request is named
 * (`routeOperation`): the last resource of its path and what is done to it, as `pages.get`,
 * `footer-comments.create` or `label.delete`. A site's cloud ID is an ID, so no site reaches a
 * name, and a page's and a blog post's comments are both `footer-comments.list`. A request to a
 * path that is not here is counted under its HTTP method: add the path to name it.
 */
export const CONFLUENCE_ROUTES: Routes = [[`${ATLASSIAN_API}/`, {
  oauth: { token: { "accessible-resources": {} } },
  me: ONE,
  ex: { confluence: { [ID]: { wiki: { api: { v2: V2 }, rest: { api: V1 } } } } },
}]];

/**
 * The name of each request that `CONFLUENCE_ROUTES` cannot name: the two token requests, which
 * share a URL, and the downloads, whose paths Confluence writes: an attachment's download link, a
 * space icon's link, and the signed URL on Atlassian's media service that link redirects to.
 */
export const CONFLUENCE_OPERATIONS = [
  "token.exchange", "token.refresh", "attachments.download", "icons.get", "icons.download",
] as const;

/** A name of `CONFLUENCE_OPERATIONS`. */
export type ConfluenceOperation = (typeof CONFLUENCE_OPERATIONS)[number];

/**
 * Atlassian, as this gatekeeper calls it. Every request is counted under the source
 * `gatekeeper.confluence.api` and the service `confluence`, with the defaults of `Upstream`: 30
 * seconds an attempt, a GET sent again after a 429, 502, 503 or 504, a network failure or a
 * timeout, and no redirect followed unless the request says so.
 */
export const confluenceUpstream = defineUpstream({ vendorId: "confluence", routes: CONFLUENCE_ROUTES });
