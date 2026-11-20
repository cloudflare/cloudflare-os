/**
 * The client every request to GitLab is sent through (`@gadgets/gatekeeper-kit/upstream`), and the
 * names its requests are counted under as subservice metrics: the route tree of the REST API's
 * paths, rooted at the API base of the configured instance, and a literal for each request that
 * no path of the tree names.
 */

import { ID, ONE, type Routes, type Tree } from "@gadgets/gatekeeper-kit/route-operation";
import { defineUpstream, type Upstream } from "@gadgets/gatekeeper-kit/upstream";

/** The path of the REST API beneath an instance's origin. */
export const API_PATH = "/api/v4";

// What is called beneath a project, addressed by its numeric id and by its path as one encoded
// segment alike. A branch, a tag and a commit's ref are one encoded segment too.
const PROJECT: Tree = {
  members: { all: "GET" },
  issues: { [ID]: { notes: { [ID]: {} }, discussions: {} } },
  merge_requests: {
    [ID]: {
      approvals: ONE,
      approve: "POST",
      unapprove: "POST",
      merge: "PUT",
      diffs: {},
      commits: {},
      pipelines: {},
      versions: {},
      notes: { [ID]: {} },
      discussions: { [ID]: { notes: {} } },
      draft_notes: { bulk_publish: "POST", [ID]: { publish: "PUT" } },
    },
  },
  repository: {
    branches: { [ID]: {} },
    tags: {},
    commits: { [ID]: { statuses: {} } },
    compare: "GET",
    merge_base: "GET",
    blobs: { [ID]: { raw: "GET" } },
  },
  protected_branches: {},
  events: {},
  pipelines: {
    [ID]: { jobs: {}, trigger_jobs: {}, bridges: {}, test_report_summary: ONE, test_report: ONE },
  },
  jobs: { [ID]: { trace: "GET" } },
};

// The paths this gatekeeper calls beneath the API's root, whatever the instance.
const API: Tree = {
  user: ONE,
  metadata: ONE,
  users: { [ID]: {} },
  projects: { [ID]: PROJECT },
};

// A file of a project's repository, beneath the API's root: its path is one encoded segment.
const REPOSITORY_FILE = /^projects\/[^/]+\/repository\/files\/[^/]+$/;

/**
 * The name of each request that the route tree cannot name: the HEAD that asks whether a file
 * exists, for which a tree has no verb, the three requests to the OAuth endpoints, and the two git
 * smart-HTTP endpoints.
 */
export const GITLAB_OPERATIONS = [
  "files.head", "token.exchange", "token.refresh", "token.revoke", "git.upload-pack", "git.receive-pack",
] as const;

/** A name of `GITLAB_OPERATIONS`. */
export type GitLabOperation = (typeof GITLAB_OPERATIONS)[number];

/**
 * GitLab, as this gatekeeper calls it. Every request is counted under the source
 * `gatekeeper.gitlab.api` and the service `gitlab`, with the defaults of `Upstream`: 30 seconds
 * an attempt, a GET or HEAD sent again after a 429, 502, 503 or 504, a network failure or a
 * timeout, and no redirect followed. A request is sent through `gitlabUpstreamAt`, which names it
 * by the paths of the configured instance; this one names none, and is where an operation that
 * makes many requests sums them (`summed`).
 */
export const gitlabUpstream = defineUpstream({ vendorId: "gitlab" });

// The routes and the upstream of each API base asked for. A deployment has one.
const instances = new Map<string, { routes: Routes; upstream: Upstream }>();

// The routes and the upstream of the API at `apiBase`, made once for each base.
function instanceAt(apiBase: string): { routes: Routes; upstream: Upstream } {
  const root = apiBase.endsWith("/") ? apiBase : `${apiBase}/`;
  let instance = instances.get(root);
  if (instance === undefined) {
    const routes: Routes = [[root, API]];
    const upstream = gitlabUpstream.with({
      routes,
      operation: (method, url) => {
        const address = url.origin + url.pathname;
        return method === "HEAD" && address.startsWith(root) && REPOSITORY_FILE.test(address.slice(root.length))
          ? "files.head" satisfies GitLabOperation : undefined;
      },
    });
    instances.set(root, instance = { routes, upstream });
  }
  return instance;
}

/**
 * The root of the REST API of the instance the Worker sends its requests to.
 * @param apiOrigin The instance's Worker-facing origin, as `https://gitlab.com`.
 * @returns The root, ending in `/`, as `https://gitlab.com/api/v4/`.
 */
export function gitlabApiBase(apiOrigin: string): string {
  return new URL(`${API_PATH}/`, apiOrigin).href;
}

/**
 * The REST paths this gatekeeper calls on one instance, from which a request is named
 * (`routeOperation`): the last resource of its path and what is done to it, as `issues.list`,
 * `notes.create` or `merge_requests.merge`. The tree is the same for every instance and only its
 * root differs, so no name holds a host or a base path. Made once for each base.
 * @param apiBase The root of the instance's REST API (`gitlabApiBase`).
 * @returns The routes under that root.
 */
export function gitlabRoutes(apiBase: string): Routes {
  return instanceAt(apiBase).routes;
}

/**
 * `gitlabUpstream` for one instance: its requests are named by `gitlabRoutes(apiBase)`, and the
 * HEAD of a repository file as `files.head`. Made once for each base.
 * @param apiBase The root of the instance's REST API (`gitlabApiBase`).
 * @returns The upstream every request to that instance is sent through.
 */
export function gitlabUpstreamAt(apiBase: string): Upstream {
  return instanceAt(apiBase).upstream;
}
