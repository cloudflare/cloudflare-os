// The GitLab gatekeeper's environment and the instance-configuration helpers derived from it.
// Shared by the account/entrypoint half (gitlab.ts) and the gatekeeper-DO half
// (gitlab-gatekeeper.ts) so neither imports the other for these.

import { stripTrailingSlashes, type SupportedResource } from "@gadgets/workshop-shared/gatekeeper";
import type { PreviewOAuthEnv } from "@gadgets/gatekeeper-kit/preview-oauth";
import { DEFAULT_INSTANCE_URL, GitLabApi, GitLabApiError, type GitLabCredential, type GitLabInstance } from "./gitlab-api";

/**
 * The Worker's environment. `PreviewOAuthEnv` adds the kit's three optional preview-relay
 * variables (`OAUTH_ALLOW_PREVIEW_REDIRECTS`, `OAUTH_REDIRECT_URI`, `OAUTH_STATE_SIGNING_SECRET`):
 * unset, OAuth callbacks are direct, as in production; set, a Worker Preview -- whose hostname
 * cannot be registered with the OAuth application -- sends GitLab to the stable Worker's
 * callback, which relays to the preview (see `gatekeeper-kit/preview-oauth`).
 */
export type Env = Cloudflare.Env & PreviewOAuthEnv & {
  /** Where this worker is reachable; the OAuth redirect URI is `${BASE_URL}/oauth`. */
  BASE_URL?: string;
  /** OAuth application credentials (secrets). */
  CLIENT_ID?: string;
  CLIENT_SECRET?: string;
  /** Browser-facing instance origin. Defaults to gitlab.com. */
  GITLAB_URL?: string;
  /** Worker-facing origin when it differs (e.g. a Cloudflare Access service-token hostname). */
  GITLAB_API_URL?: string;
  /** Optional Cloudflare Access service token, attached to every Worker→GitLab request (secrets). */
  CF_ACCESS_CLIENT_ID?: string;
  CF_ACCESS_CLIENT_SECRET?: string;
};

export const VENDOR_ID = "gitlab";

/** Scopes a full connection requests: REST through `api`, git fetch/push through `write_repository`. */
export const OAUTH_SCOPES = ["api", "write_repository"];

/** Scopes a transient sign-in grant requests: enough to read the account's confirmed email. */
export const AUTH_SCOPES = ["read_user"];

export function getBaseUrl(env: Env): string {
  return stripTrailingSlashes(env.BASE_URL ?? "http://localhost:8787/gatekeeper/gitlab");
}

export function getBasePath(env: Env): string {
  const path = new URL(getBaseUrl(env)).pathname;
  return path === "/" ? "" : path;
}

export function getRedirectUri(env: Env): string {
  return `${getBaseUrl(env)}/oauth`;
}

/** Hosts a plain-http instance URL is accepted for: a GitLab run on the developer's own machine. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Validate an operator-configured instance URL before anything is sent to it. Every request to
 * the instance carries the user's token, the OAuth exchanges carry the client secret and a
 * refresh token, and users are sent to its authorization page -- so it must be `https`, except
 * on loopback for local development, and must not embed credentials. It must also be an
 * *origin*: every path this package builds (`/api/v4/…`, `/oauth/…`, `/<project>.git/…`, and
 * the web URLs it parses and emits) starts at the root, so a GitLab served under a relative URL
 * root is not supported, and a path here is refused rather than silently dropped -- dropped, it
 * would send tokens to whatever answers at the root of that host. The message names the
 * variable, not its value.
 */
function instanceOrigin(name: "GITLAB_URL" | "GITLAB_API_URL", raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} is not a valid URL.`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))) {
    throw new Error(`${name} must use https (http is accepted on localhost only).`);
  }
  if (url.username || url.password) {
    throw new Error(`${name} must not include credentials.`);
  }
  if (stripTrailingSlashes(url.pathname) !== "" || url.search || url.hash) {
    throw new Error(`${name} must be an origin (scheme and host only): a GitLab under a relative URL root is not supported.`);
  }
  return url.origin;
}

/** The instance users visit: OAuth authorization, links in results, resource URLs. */
export function instanceUrl(env: Env): string {
  return instanceOrigin("GITLAB_URL", env.GITLAB_URL || DEFAULT_INSTANCE_URL);
}

/**
 * The origin the Worker sends requests to, with the headers every request carries. The Access
 * service token is a pair; one half without the other is a deployment mistake that would
 * otherwise fail as an unexplained login redirect on every request, so it fails here by name.
 */
export function gitlabInstance(env: Env): GitLabInstance {
  const headers: Record<string, string> = {};
  if (!!env.CF_ACCESS_CLIENT_ID !== !!env.CF_ACCESS_CLIENT_SECRET) {
    throw new Error("CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET must be set together (or neither).");
  }
  if (env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET) {
    headers["CF-Access-Client-Id"] = env.CF_ACCESS_CLIENT_ID;
    headers["CF-Access-Client-Secret"] = env.CF_ACCESS_CLIENT_SECRET;
  }
  return {
    apiOrigin: env.GITLAB_API_URL ? instanceOrigin("GITLAB_API_URL", env.GITLAB_API_URL) : instanceUrl(env),
    headers,
  };
}

export function ensureConfigured(env: Env): void {
  if (!env.CLIENT_ID || !env.CLIENT_SECRET) {
    throw new Error("The GitLab gatekeeper is not configured.");
  }
}

export const RECONNECT_MESSAGE = "GitLab credentials have expired or been revoked. Please reconnect the account.";

/**
 * What the account half of `UserAccount` looks like to the code that calls GitLab on its behalf:
 * a credential to send, and one place to report that GitLab refused it. Structural, so the
 * entrypoints and the gatekeeper DO reach the account through its stub without importing the
 * class.
 */
export type AccountCredentials = {
  getCredential(): Promise<GitLabCredential>;
  credentialsRejected(grantId: string | undefined): Promise<void>;
};

/**
 * Run `fn` against GitLab with the account's credential. A refused credential (a 401 from the
 * probe or the git endpoints -- see `GitLabApiError.isAuthError`) is reported to the account
 * *for the grant that was refused*: the error names the grant its token came from, so a stale
 * answer to a token that a reconnect has since replaced cannot retire the new grant. The caller
 * sees the reconnect message either way.
 */
export async function withAccountApi<T>(
  env: Env, account: AccountCredentials, fn: (api: GitLabApi) => Promise<T>,
): Promise<T> {
  const api = new GitLabApi(gitlabInstance(env), async () => await account.getCredential());
  try {
    return await fn(api);
  } catch (error) {
    if (error instanceof GitLabApiError && error.isAuthError) {
      await account.credentialsRejected(error.grantId);
      throw new Error(RECONNECT_MESSAGE, { cause: error });
    }
    throw error;
  }
}

/**
 * The connectable resource types, with URL patterns on the configured instance. Ordered most
 * specific first: `:project+` also matches an issue or merge request URL, and resource
 * resolution is first-match. The issue and merge request patterns accept anything after the
 * number (`{/*}?`): GitLab's tabs put it there -- `/merge_requests/7/diffs`, `/commits`,
 * `/pipelines`, `/issues/3/designs` -- and without it such a URL would match only `:project+`
 * and pre-select a capability over the whole project for an agent that asked about one merge
 * request. `parseResourceUrl` accepts the same suffixes.
 */
export function supportedResources(env: Env): {
  mergeRequest: SupportedResource;
  issue: SupportedResource;
  project: SupportedResource;
  all: SupportedResource[];
} {
  const origin = instanceUrl(env);
  const mergeRequest: SupportedResource = {
    urlPattern: `${origin}/:project+/-/merge_requests/:iid{/*}?`,
    title: "GitLab Merge Request",
    description: "Read and manage a specific GitLab merge request and its review threads.",
  };
  const issue: SupportedResource = {
    urlPattern: `${origin}/:project+/-/issues/:iid{/*}?`,
    title: "GitLab Issue",
    description: "Read and manage a specific GitLab issue.",
  };
  const project: SupportedResource = {
    urlPattern: `${origin}/:project+`,
    title: "GitLab Project",
    description: "Read and manage issues, merge requests, reviews, and code in a GitLab project.",
  };
  return { mergeRequest, issue, project, all: [mergeRequest, issue, project] };
}

export type ResourceKind = "project" | "issue" | "mergeRequest";

/** What a bound gatekeeper DO is told about itself (`ctx.props`). */
export type GitLabGatekeeperImplProps = {
  userObjectId: string;
  resourceKind: ResourceKind;
  /** Full path with namespaces, e.g. `group/sub/project`. */
  projectPath: string;
  /** The issue or merge request number, for those resource kinds. */
  iid?: number;
};
