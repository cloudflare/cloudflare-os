// The GitLab gatekeeper's environment and the instance-configuration helpers derived from it.
// Shared by the account/entrypoint half (gitlab.ts) and the gatekeeper-DO half
// (gitlab-gatekeeper.ts) so neither imports the other for these.

import { stripTrailingSlashes, type SupportedResource } from "@gadgets/workshop-shared/gatekeeper";
import { DEFAULT_INSTANCE_URL, type GitLabInstance } from "./gitlab-api";

export type Env = Cloudflare.Env & {
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

/** The instance users visit: OAuth authorization, links in results, resource URLs. */
export function instanceUrl(env: Env): string {
  return stripTrailingSlashes(env.GITLAB_URL || DEFAULT_INSTANCE_URL);
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
    apiOrigin: stripTrailingSlashes(env.GITLAB_API_URL || instanceUrl(env)),
    headers,
  };
}

export function ensureConfigured(env: Env): void {
  if (!env.CLIENT_ID || !env.CLIENT_SECRET) {
    throw new Error("The GitLab gatekeeper is not configured.");
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
