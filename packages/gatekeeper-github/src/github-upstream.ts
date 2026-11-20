/**
 * The client every request to GitHub is sent through (`@gadgets/gatekeeper-kit/upstream`), and the
 * names its requests are counted under as subservice metrics: the route tree of the REST API's
 * paths, and a literal for each request that no path names.
 */

import { ID, ONE, REST, type Routes, type Tree } from "@gadgets/gatekeeper-kit/route-operation";
import { defineUpstream, type RetryPolicy } from "@gadgets/gatekeeper-kit/upstream";

/** The origin of GitHub's REST and GraphQL APIs. */
export const API_BASE_URL = "https://api.github.com";

// What is called beneath a repository, addressed by its name (`/repos/{owner}/{repo}`) and by its
// id (`/repositories/{id}`) alike. A branch's name is the rest of its path, slashes included.
const REPOSITORY: Tree = {
  issues: {
    comments: { [ID]: {} },
    [ID]: { comments: {}, labels: { [ID]: {} } },
  },
  pulls: {
    comments: { [ID]: {} },
    [ID]: {
      reviews: { [ID]: {} },
      comments: { [ID]: { replies: {} } },
      files: {},
      commits: {},
      merge: "PUT",
    },
  },
  commits: { [ID]: {} },
  compare: { [ID]: {} },
  branches: { [REST]: {} },
  tags: {},
  git: { ref: { [REST]: {} }, trees: { [ID]: {} }, blobs: { [ID]: {} } },
  rules: { [REST]: {} },
  activity: {},
  "check-runs": { [ID]: { annotations: {} } },
  actions: {
    jobs: { [ID]: { logs: ONE } },
    runs: { [ID]: { jobs: {}, attempts: { [ID]: { jobs: {} } } } },
  },
};

/**
 * The REST paths this gatekeeper calls, from which a request is named (`routeOperation`): the last
 * resource of its path and what is done to it, as `issues.list`, `comments.create` or
 * `pulls.merge`. An owner and a repository are two IDs. Webhooks are addressed by the
 * repository's id alone.
 */
export const GITHUB_ROUTES: Routes = [[`${API_BASE_URL}/`, {
  user: { emails: {}, repos: {} },
  search: { repositories: "GET", issues: "GET" },
  repos: { [ID]: { [ID]: REPOSITORY } },
  repositories: {
    [ID]: { ...REPOSITORY, hooks: { [ID]: { deliveries: { [ID]: { attempts: {} } } } } },
  },
}]];

/** The GraphQL queries this gatekeeper sends, each by the name it is counted under. */
export const GITHUB_GRAPHQL_OPERATIONS = ["graphql.checks.list", "graphql.deployment.get"] as const;

/** The name of one GraphQL query: a member of `GITHUB_GRAPHQL_OPERATIONS`. */
export type GitHubGraphqlOperation = (typeof GITHUB_GRAPHQL_OPERATIONS)[number];

/**
 * The name of each request that `GITHUB_ROUTES` cannot name: a GraphQL query, the revocation of a
 * token, the download of a job's log from the storage GitHub hands it off to, and the two git
 * smart-HTTP endpoints.
 */
export const GITHUB_OPERATIONS = [
  ...GITHUB_GRAPHQL_OPERATIONS, "token.revoke", "logs.download", "git.upload-pack", "git.receive-pack",
] as const;

/** A name of `GITHUB_OPERATIONS`. */
export type GitHubOperation = (typeof GITHUB_OPERATIONS)[number];

/**
 * The longest a request waits before it is sent again, which is the longest wait of the client's
 * own retry policy: a rate limit that lifts later than this is the caller's to wait out.
 */
const MAX_WAIT_MS = 10_000;

/** The statuses of a failure that may pass, after which the client's own rule sends a read again. */
const TRANSIENT: ReadonlySet<number> = new Set([502, 503, 504]);

// A count of seconds, which is the form GitHub sends a `retry-after` in, and an
// `x-ratelimit-reset` as the seconds of the UTC epoch. A header in any other form, a date
// included, cannot be read.
const SECONDS = /^\d+$/;

// The milliseconds an answer asks to wait before its request is sent again: the longer of its
// `retry-after` and, where its `x-ratelimit-remaining` is `0`, the time left until its
// `x-ratelimit-reset`, which is none once that is past. Undefined where it names neither. A wait
// that cannot be read may be any wait, and is one with no end.
function namedWaitMs(headers: Headers): number | undefined {
  const waits: number[] = [];
  const retryAfter = headers.get("retry-after");
  if (retryAfter !== null) waits.push(SECONDS.test(retryAfter) ? Number(retryAfter) * 1000 : Infinity);
  if (headers.get("x-ratelimit-remaining") === "0") {
    const reset = headers.get("x-ratelimit-reset") ?? "";
    waits.push(SECONDS.test(reset) ? Math.max(Number(reset) * 1000 - Date.now(), 0) : Infinity);
  }
  return waits.length === 0 ? undefined : Math.max(...waits);
}

/**
 * Whether an answer names a wait before its request may be sent again: a `retry-after`, or a
 * rate limit with nothing left of it. GitHub says so on an answer of any status, a success
 * included, and a request sent before that wait is over is refused.
 */
export function namesWait(headers: Headers): boolean {
  return namedWaitMs(headers) !== undefined;
}

/**
 * When a request to GitHub is sent again. GitHub's rule for a rate limit: a request answered with
 * a `retry-after` is not sent before that many seconds, one answered with `x-ratelimit-remaining:
 * 0` is not sent before the time in `x-ratelimit-reset`, any other waits at least a minute, and an
 * integration that keeps sending while limited can be banned. The wait an answer names is the
 * longer of the two. A read answered 429 is sent again only where the answer names a wait of
 * `MAX_WAIT_MS` at most, after exactly that wait: where it names none, one that cannot be read or
 * a longer one, the 429 is handed back to its caller after the one send. A read answered 502, 503
 * or 504 is sent again by the client's own rule and backoff, unless its answer names a wait, which
 * it then follows as a 429 does: it too is handed back where the wait is longer or cannot be read.
 * A 403 is never sent again, though GitHub answers some rate limits with one, and neither is a
 * write.
 */
const RETRY = {
  maxDelayMs: MAX_WAIT_MS,
  retryable: (status, request, headers) => {
    if (!request.idempotent || (status !== 429 && !TRANSIENT.has(status))) return false;
    const wait = namedWaitMs(headers);
    return wait === undefined ? status !== 429 : wait <= MAX_WAIT_MS;
  },
  delayMs: response => namedWaitMs(response.headers),
} satisfies RetryPolicy;

/**
 * GitHub, as this gatekeeper calls it. Every request is counted under the source
 * `gatekeeper.github.api` and the service `github`, with the defaults of `Upstream`: 30 seconds
 * an attempt and no redirect followed. A GET is sent again, three times at most, after a 502, 503
 * or 504, a network failure or a timeout, and after a 429 only once the wait GitHub names in it
 * has passed (`RETRY`): one that names no wait, or a longer one than `MAX_WAIT_MS`, is handed
 * back after the one send. An answer is counted by its status, of which a 304 is no success:
 * the REST helper (`request` in `github-api.ts`) counts one as the success of a conditional
 * read, which takes it for an answer, as it counts every other answer that it reads otherwise
 * than its status says.
 */
export const githubUpstream = defineUpstream({
  vendorId: "github",
  routes: GITHUB_ROUTES,
  // `/user` is one resource that has resources beneath it, which a tree reads as a listing.
  operation: (method, url) =>
    method === "GET" && url.origin === API_BASE_URL && url.pathname === "/user" ? "user.get" : undefined,
  retry: RETRY,
});
