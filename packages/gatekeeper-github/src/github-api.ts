import type { RefreshCredentials } from "@gadgets/gatekeeper-kit/credentials";
import {
  isInvalidGrant, mergeOAuthTokens, OAuthClient, oauthRefresh,
} from "@gadgets/gatekeeper-kit/oauth-client";

/**
 * A GitHub OAuth grant. An expiring grant -- the default for OAuth apps registered since August
 * 2026, opt-in before -- also carries `refreshToken` and `expiresAt`: its access token lasts eight
 * hours, and each refresh rotates both tokens. A grant without them does not expire.
 */
export type GitHubOAuthGrant = {
  accessToken: string;
  scopes: string[];
  refreshToken?: string;
  /** Absolute access-token expiry, epoch milliseconds. */
  expiresAt?: number;
};

export type GitHubSimpleUser = {
  login: string;
  name?: string | null;
  avatar_url: string;
  html_url: string;
};

export type GitHubLabelResponse = {
  name: string;
  color?: string;
  description?: string | null;
};

export type GitHubRepoResponse = {
  id: number;
  name: string;
  full_name: string;
  html_url: string;
  description?: string | null;
  visibility?: "public" | "private" | "internal";
  private?: boolean;
  default_branch: string;
  owner: GitHubSimpleUser;
};

export type GitHubIssueResponse = {
  number: number;
  html_url: string;
  title: string;
  state: "open" | "closed";
  state_reason?: "completed" | "not_planned" | "reopened" | null;
  body?: string | null;
  user: GitHubSimpleUser | null;
  labels: GitHubLabelResponse[];
  assignees?: GitHubSimpleUser[];
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
  comments: number;
  pull_request?: {
    html_url?: string | null;
    url?: string | null;
  };
};

export type GitHubPullRequestBranchResponse = {
  ref: string;
  sha: string;
  repo: GitHubRepoResponse | null;
};

export type GitHubPullRequestResponse = {
  number: number;
  html_url: string;
  title: string;
  state: "open" | "closed";
  body?: string | null;
  user: GitHubSimpleUser | null;
  labels: GitHubLabelResponse[];
  assignees?: GitHubSimpleUser[];
  requested_reviewers?: GitHubSimpleUser[];
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
  comments: number;
  draft: boolean;
  merged_at?: string | null;
  mergeable?: boolean | null;
  commits: number;
  additions: number;
  deletions: number;
  changed_files: number;
  head: GitHubPullRequestBranchResponse;
  base: GitHubPullRequestBranchResponse;
};

export type GitHubIssueCommentResponse = {
  id: number;
  html_url: string;
  body?: string | null;
  user: GitHubSimpleUser | null;
  created_at: string;
  updated_at: string;
};

export type GitHubPullRequestReviewResponse = {
  id: number;
  body?: string | null;
  state: string;
  html_url: string;
  user: GitHubSimpleUser | null;
  submitted_at?: string | null;
  commit_id?: string | null;
};

export type GitHubPullRequestReviewCommentResponse = {
  id: number;
  pull_request_review_id?: number | null;
  in_reply_to_id?: number;
  html_url: string;
  body?: string | null;
  user: GitHubSimpleUser | null;
  created_at: string;
  updated_at: string;
  path: string;
  line?: number;
  original_line?: number;
  side?: "LEFT" | "RIGHT";
  start_line?: number | null;
  original_start_line?: number | null;
  start_side?: "LEFT" | "RIGHT" | null;
  subject_type?: "line" | "file";
  position?: number | null;
  original_position?: number | null;
};

export type GitHubPullFileResponse = {
  sha?: string;
  filename: string;
  status: "added" | "modified" | "removed" | "renamed" | "copied" | "changed" | "unchanged";
  previous_filename?: string;
  additions: number;
  deletions: number;
  patch?: string;
};

export type GitHubBranchResponse = {
  name: string;
  commit: {
    sha: string;
  };
  protected?: boolean;
};

export type GitHubTagResponse = {
  name: string;
  commit: {
    sha: string;
  };
};

/** A commit author/committer identity as recorded in the git commit object itself. */
export type GitHubGitIdentityResponse = {
  name?: string | null;
  email?: string | null;
  date?: string | null;
};

export type GitHubCommitResponse = {
  sha: string;
  html_url: string;
  commit: {
    message: string;
    author?: GitHubGitIdentityResponse | null;
    committer?: GitHubGitIdentityResponse | null;
    tree?: {
      sha: string;
    };
  };
  author?: GitHubSimpleUser | null;
  parents: Array<{
    sha: string;
  }>;
  /** Present on single-commit lookups; omitted from list responses. */
  stats?: {
    additions: number;
    deletions: number;
    total: number;
  };
};

export type GitHubCompareResponse = {
  base_commit: {
    sha: string;
  };
  /**
   * The merge base of the two compared commits (what a three-dot compare diffs from). GitHub
   * documents it as always present; it is optional here so a malformed response is handled
   * explicitly (see `mergeBaseOfCompare` in github.ts) rather than crashing on a blind read.
   */
  merge_base_commit?: {
    sha: string;
  };
  commits?: GitHubCommitResponse[];
  total_commits: number;
  files?: GitHubPullFileResponse[];
};

/** One entry of a git tree object, as the git-data trees API reports it. */
export type GitHubGitTreeEntryResponse = {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  size?: number;
};

export type GitHubGitTreeResponse = {
  sha: string;
  tree: GitHubGitTreeEntryResponse[];
  truncated?: boolean;
};

type GitHubGitBlobResponse = {
  sha: string;
  size: number;
  content: string;
  encoding: string;
};

export class GitHubApiError extends Error {
  status: number;
  details?: unknown;
  isAuthError: boolean;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.name = "GitHubApiError";
    this.status = status;
    this.details = details;
    this.isAuthError = status === 401;
  }
}

type RequestOptions = {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  auth?: "bearer" | "basic" | "none";
  headers?: Record<string, string | undefined>;
  okStatuses?: number[];
  basicAuth?: {
    username: string;
    password: string;
  };
};

/**
 * A repository with its GitHub id, which survives renames and owner transfers. GitHub redirects
 * a renamed repo's `/repos/<owner>/<name>/...` to `/repositories/<id>/...`, while a transferred
 * issue redirects into another repository, so the id tells the two apart.
 */
export type PinnedRepo = { owner: string; repo: string; id: number };

export type RequestResult<T> = {
  data: T;
  headers: Headers;
  status: number;
};

export type ConditionalRequestResult<T> =
  | { status: 304; headers: Headers }
  | { status: 200; headers: Headers; data: T };

export type ConditionalRequestOptions = {
  ifNoneMatch?: string;
};

const API_BASE_URL = "https://api.github.com";
const LOGIN_BASE_URL = "https://github.com";
const API_VERSION = "2022-11-28";
const DEFAULT_ACCEPT = "application/vnd.github+json";
const USER_AGENT = "Cloudflare-Gadgets";
const REQUEST_TIMEOUT_MS = 30_000;
const GIT_UPLOAD_PACK_TIMEOUT_MS = 120_000;

function encodeBasicAuth(username: string, password: string): string {
  return btoa(`${username}:${password}`);
}

async function parseBody(response: Response): Promise<unknown> {
  if (response.status === 204 || response.status === 304) {
    return undefined;
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return await response.json();
  }

  return await response.text();
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400 && status !== 304;
}

const REPO_ROOT_PATH = /^\/repos\/[^/]+\/[^/]+$/;
const REPO_ID_PATH = /^\/repositories\/\d+$/;

/**
 * The URL to re-issue a redirected request to, built rather than taken from `location`. Without
 * `pin`, only a repository's root is followed, to `/repositories/<id>`: GitHub redirects a renamed
 * or transferred repository there, and at the root the id can only be that same repository's.
 * With it, a redirect is followed only to the same path under the pinned id, since beneath the
 * root a transferred issue redirects into another repository.
 */
function redirectTarget(url: URL, location: string | null, pin: PinnedRepo | undefined): URL | undefined {
  const moved = location === null ? null : URL.parse(location);
  if (moved?.origin !== API_BASE_URL) return undefined;
  if (!pin) {
    return REPO_ROOT_PATH.test(url.pathname) && REPO_ID_PATH.test(moved.pathname)
      ? new URL(`${moved.pathname}${url.search}`, API_BASE_URL) : undefined;
  }
  const prefix = `/repos/${encodeURIComponent(pin.owner)}/${encodeURIComponent(pin.repo)}`;
  const suffix = url.pathname.slice(prefix.length);
  if (!url.pathname.startsWith(prefix) || !(suffix === "" || suffix.startsWith("/"))) return undefined;
  const target = new URL(`/repositories/${pin.id}${suffix}${url.search}`, API_BASE_URL);
  return moved.pathname === target.pathname ? target : undefined;
}

async function request<T>(
  method: string,
  path: string,
  options: RequestOptions = {},
  getToken?: () => Promise<string>,
  pin?: PinnedRepo,
): Promise<RequestResult<T>> {
  const url = new URL(path, API_BASE_URL);

  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }

  const headers = new Headers({
    Accept: DEFAULT_ACCEPT,
    "User-Agent": USER_AGENT,
    "X-GitHub-Api-Version": API_VERSION,
  });

  for (const [key, value] of Object.entries(options.headers ?? {})) {
    if (value !== undefined) {
      headers.set(key, value);
    }
  }

  const authMode = options.auth ?? "bearer";
  if (authMode === "bearer") {
    if (!getToken) {
      throw new Error("Bearer auth requested without a token callback");
    }
    headers.set("Authorization", `Bearer ${await getToken()}`);
  } else if (authMode === "basic") {
    if (!options.basicAuth) {
      throw new Error("Basic auth requested without credentials");
    }
    headers.set(
      "Authorization",
      `Basic ${encodeBasicAuth(options.basicAuth.username, options.basicAuth.password)}`,
    );
  }

  let body: BodyInit | undefined;
  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(options.body);
  }

  const init: RequestInit = { method, headers, body, redirect: "manual" };
  let response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (isRedirect(response.status)) {
    const target = redirectTarget(url, response.headers.get("location"), pin);
    if (target) {
      response = await fetch(target, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    }
    if (!target || isRedirect(response.status)) {
      // The destination is withheld: it may name a repository the binding's observers cannot read.
      throw new GitHubApiError(response.status,
        `GitHub moved ${url.pathname} out of the bound repository; it was not followed.`);
    }
  }

  if (!response.ok && !(options.okStatuses ?? []).includes(response.status)) {
    const parsed = await parseBody(response);
    let message = `${response.status} ${response.statusText}`;
    if (typeof parsed === "string" && parsed.length > 0) {
      message = parsed;
    } else if (parsed && typeof parsed === "object") {
      const errorMessage = (parsed as { message?: string; error?: string }).message
        ?? (parsed as { message?: string; error?: string }).error;
      if (errorMessage) {
        message = errorMessage;
      }
    }
    throw new GitHubApiError(response.status, message, parsed);
  }

  const parsed = await parseBody(response);
  return {
    data: parsed as T,
    headers: response.headers,
    status: response.status,
  };
}

function oauthClient(clientId: string, clientSecret: string): OAuthClient {
  return new OAuthClient({
    label: "GitHub",
    client: { method: "post", id: clientId, secret: clientSecret },
    tokenEndpoint: `${LOGIN_BASE_URL}/login/oauth/access_token`,
    headers: { "User-Agent": USER_AGENT },
    scopeSeparator: ",",
    timeoutMs: REQUEST_TIMEOUT_MS,
  });
}

export async function exchangeAuthCode(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
): Promise<GitHubOAuthGrant> {
  const tokens = await oauthClient(clientId, clientSecret).exchangeCode({ code, redirectUri });
  const grant: GitHubOAuthGrant = {
    accessToken: tokens.accessToken,
    scopes: tokens.scopes?.map(scope => scope.trim()).filter(Boolean) ?? [],
  };
  if (tokens.refreshToken !== undefined) grant.refreshToken = tokens.refreshToken;
  if (tokens.expiresAt !== undefined) grant.expiresAt = tokens.expiresAt;
  return grant;
}

/**
 * Refreshes an expiring grant. The scopes are kept as stored, since GitHub never changes them on
 * refresh. GitHub answers a refresh token that is expired, revoked, or already used with
 * `bad_refresh_token` (in an HTTP 200), which proves the grant dead.
 */
export function refreshGitHubGrant(
  clientId: string,
  clientSecret: string,
  expiredMessage: string,
): RefreshCredentials<GitHubOAuthGrant> {
  return oauthRefresh<GitHubOAuthGrant>(oauthClient(clientId, clientSecret), {
    refreshToken: grant => grant.refreshToken,
    merge: (grant, tokens) => ({ ...mergeOAuthTokens(grant, tokens), scopes: grant.scopes }),
    isGrantDeath: error => isInvalidGrant(error)
      || (error.oauthError === "bad_refresh_token" && error.httpStatus < 500),
    expiredMessage,
  });
}

/**
 * Revokes one OAuth token, and only that token. The neighbouring `/applications/{id}/grant`
 * endpoint revokes every token the user holds for this OAuth app at once, which took a working
 * connection down whenever a duplicate or an abandoned pending connect for the same user was
 * revoked; a user may legitimately hold several tokens (one per connected account, plus the
 * transient sign-in grant).
 */
export async function revokeOAuthToken(
  accessToken: string,
  clientId: string,
  clientSecret: string,
): Promise<void> {
  await request<void>(
    "DELETE",
    `/applications/${encodeURIComponent(clientId)}/token`,
    {
      auth: "basic",
      basicAuth: {
        username: clientId,
        password: clientSecret,
      },
      body: {
        access_token: accessToken,
      },
    },
  );
}

/**
 * GitHub's REST API as one account. Redirects are followed only within `repo`, by its id (see
 * PinnedRepo); without it, only a repository root's redirect to its id is (see redirectTarget),
 * and every other redirect fails with a GitHubApiError.
 */
export class GitHubApi {
  #getToken: () => Promise<string>;
  #repo?: PinnedRepo;

  constructor(getToken: () => Promise<string>, options: { repo?: PinnedRepo } = {}) {
    this.#getToken = getToken;
    this.#repo = options.repo;
  }

  async #request<T>(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<RequestResult<T>> {
    return await request<T>(method, path, options, this.#getToken, this.#repo);
  }

  async #conditionalGet<T>(
    path: string,
    query: Record<string, string | number | boolean | undefined> | undefined,
    options: ConditionalRequestOptions = {},
    accept?: string,
  ): Promise<ConditionalRequestResult<T>> {
    const result = await this.#request<T>("GET", path, {
      query,
      headers: {
        ...(options.ifNoneMatch ? { "If-None-Match": options.ifNoneMatch } : undefined),
        ...(accept ? { Accept: accept } : undefined),
      },
      okStatuses: [304],
    });
    if (result.status === 304) {
      return {
        status: 304,
        headers: result.headers,
      };
    }

    return {
      status: 200,
      headers: result.headers,
      data: result.data,
    };
  }

  async getViewer(): Promise<{ user: GitHubSimpleUser; scopes: string[] }> {
    const result = await this.getViewerConditional();
    if (result.status === 304) {
      throw new Error("GitHub unexpectedly returned 304 for an unconditional viewer request.");
    }
    const user = result.data;
    const scopes = result.headers
      .get("x-oauth-scopes")
      ?.split(",")
      .map((scope: string) => scope.trim())
      .filter(Boolean) ?? [];

    return {
      user,
      scopes,
    };
  }

  async getViewerConditional(
    options: ConditionalRequestOptions = {},
  ): Promise<ConditionalRequestResult<GitHubSimpleUser>> {
    return await this.#conditionalGet<GitHubSimpleUser>("/user", undefined, options);
  }

  /**
   * Returns the account's primary, verified email (for use as a sign-in identity), or null if the
   * account has no verified email. Requires the `user:email` scope.
   */
  async getPrimaryVerifiedEmail(): Promise<string | null> {
    const result = await this.#request<Array<{
      email: string; primary: boolean; verified: boolean;
    }>>("GET", "/user/emails", {});
    const emails = result.data ?? [];
    const primary = emails.find(e => e.primary && e.verified);
    const verified = primary ?? emails.find(e => e.verified);
    return verified?.email ?? null;
  }

  async getRepo(owner: string, repo: string): Promise<GitHubRepoResponse> {
    const result = await this.getRepoConditional(owner, repo);
    if (result.status === 304) {
      throw new Error("GitHub unexpectedly returned 304 for an unconditional repo request.");
    }
    return result.data;
  }

  async getRepoConditional(
    owner: string,
    repo: string,
    options: ConditionalRequestOptions = {},
  ): Promise<ConditionalRequestResult<GitHubRepoResponse>> {
    return await this.#conditionalGet<GitHubRepoResponse>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      undefined,
      options,
    );
  }

  async listRepos(options: {
    affiliation?: string;
    sort?: string;
    direction?: string;
    per_page: number;
    page: number;
  }): Promise<GitHubRepoResponse[]> {
    const result = await this.#request<GitHubRepoResponse[]>("GET", "/user/repos", { query: options });
    return result.data;
  }

  /**
   * GitHub's `/search/repositories` endpoint. Use this when the user has typed a query so we
   * only fetch the matching repos rather than enumerating their entire affiliation list. The
   * query string follows GitHub's search-syntax (e.g. "react user:jonesphillip in:name").
   */
  async searchRepos(options: {
    q: string;
    per_page: number;
    page: number;
    sort?: "stars" | "forks" | "help-wanted-issues" | "updated";
    order?: "asc" | "desc";
  }): Promise<GitHubRepoResponse[]> {
    const result = await this.#request<{ items: GitHubRepoResponse[] }>("GET", "/search/repositories", { query: options });
    return result.data.items;
  }

  async getIssue(owner: string, repo: string, issueNumber: number): Promise<GitHubIssueResponse> {
    const result = await this.getIssueConditional(owner, repo, issueNumber);
    if (result.status === 304) {
      throw new Error("GitHub unexpectedly returned 304 for an unconditional issue request.");
    }
    return result.data;
  }

  async getIssueConditional(
    owner: string,
    repo: string,
    issueNumber: number,
    options: ConditionalRequestOptions = {},
  ): Promise<ConditionalRequestResult<GitHubIssueResponse>> {
    return await this.#conditionalGet<GitHubIssueResponse>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}`,
      undefined,
      options,
    );
  }

  async getPullRequest(
    owner: string,
    repo: string,
    pullNumber: number,
  ): Promise<GitHubPullRequestResponse> {
    const result = await this.getPullRequestConditional(owner, repo, pullNumber);
    if (result.status === 304) {
      throw new Error("GitHub unexpectedly returned 304 for an unconditional pull request request.");
    }
    return result.data;
  }

  async getPullRequestConditional(
    owner: string,
    repo: string,
    pullNumber: number,
    options: ConditionalRequestOptions = {},
  ): Promise<ConditionalRequestResult<GitHubPullRequestResponse>> {
    return await this.#conditionalGet<GitHubPullRequestResponse>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}`,
      undefined,
      options,
    );
  }

  async listIssues(
    owner: string,
    repo: string,
    options: {
      state?: string;
      labels?: string;
      creator?: string;
      assignee?: string;
      sort?: string;
      direction?: string;
      per_page: number;
      page: number;
    },
  ): Promise<GitHubIssueResponse[]> {
    const result = await this.listIssuesConditional(owner, repo, options);
    if (result.status === 304) {
      throw new Error("GitHub unexpectedly returned 304 for an unconditional issue list request.");
    }
    return result.data;
  }

  async listIssuesConditional(
    owner: string,
    repo: string,
    query: {
      state?: string;
      labels?: string;
      creator?: string;
      assignee?: string;
      sort?: string;
      direction?: string;
      per_page: number;
      page: number;
    },
    options: ConditionalRequestOptions = {},
  ): Promise<ConditionalRequestResult<GitHubIssueResponse[]>> {
    return await this.#conditionalGet<GitHubIssueResponse[]>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`,
      query,
      options,
    );
  }

  async searchIssues(
    query: string,
    page: number,
    perPage: number,
    sort?: string,
    order?: string,
  ): Promise<GitHubIssueResponse[]> {
    const result = await this.searchIssuesConditional(query, page, perPage, sort, order);
    if (result.status === 304) {
      throw new Error("GitHub unexpectedly returned 304 for an unconditional issue search request.");
    }
    return result.data.items;
  }

  async searchIssuesConditional(
    query: string,
    page: number,
    perPage: number,
    sort?: string,
    order?: string,
    options: ConditionalRequestOptions = {},
  ): Promise<ConditionalRequestResult<{ items: GitHubIssueResponse[] }>> {
    return await this.#conditionalGet<{ items: GitHubIssueResponse[] }>(
      "/search/issues",
      {
        q: query,
        advanced_search: true,
        page,
        per_page: perPage,
        sort,
        order,
      },
      options,
    );
  }

  async listPullRequests(
    owner: string,
    repo: string,
    options: {
      state?: string;
      head?: string;
      base?: string;
      sort?: string;
      direction?: string;
      per_page: number;
      page: number;
    },
  ): Promise<GitHubPullRequestResponse[]> {
    const result = await this.listPullRequestsConditional(owner, repo, options);
    if (result.status === 304) {
      throw new Error("GitHub unexpectedly returned 304 for an unconditional pull request list request.");
    }
    return result.data;
  }

  async listPullRequestsConditional(
    owner: string,
    repo: string,
    query: {
      state?: string;
      head?: string;
      base?: string;
      sort?: string;
      direction?: string;
      per_page: number;
      page: number;
    },
    options: ConditionalRequestOptions = {},
  ): Promise<ConditionalRequestResult<GitHubPullRequestResponse[]>> {
    return await this.#conditionalGet<GitHubPullRequestResponse[]>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`,
      query,
      options,
    );
  }

  async listIssueComments(
    owner: string,
    repo: string,
    issueNumber: number,
    page: number,
    perPage: number,
    since?: string,
  ): Promise<GitHubIssueCommentResponse[]> {
    return (await this.#request<GitHubIssueCommentResponse[]>(
      "GET",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/comments`,
      {
        query: {
          page,
          per_page: perPage,
          since,
        },
      },
    )).data;
  }

  async createIssue(
    owner: string,
    repo: string,
    options: {
      title: string;
      body?: string;
      labels?: string[];
      assignees?: string[];
    },
  ): Promise<GitHubIssueResponse> {
    return (await this.#request<GitHubIssueResponse>(
      "POST",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`,
      { body: options },
    )).data;
  }

  async createPullRequest(
    owner: string,
    repo: string,
    options: {
      title: string;
      body?: string;
      head: string;
      base: string;
      draft?: boolean;
    },
  ): Promise<GitHubPullRequestResponse> {
    return (await this.#request<GitHubPullRequestResponse>(
      "POST",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`,
      { body: options },
    )).data;
  }

  async updateIssue(
    owner: string,
    repo: string,
    issueNumber: number,
    patch: {
      title?: string;
      body?: string;
      state?: "open" | "closed";
      state_reason?: "completed" | "not_planned" | null;
    },
  ): Promise<GitHubIssueResponse> {
    return (await this.#request<GitHubIssueResponse>(
      "PATCH",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}`,
      { body: patch },
    )).data;
  }

  async addLabels(
    owner: string,
    repo: string,
    issueNumber: number,
    labels: string[],
  ): Promise<GitHubLabelResponse[]> {
    return (await this.#request<GitHubLabelResponse[]>(
      "POST",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/labels`,
      {
        body: { labels },
      },
    )).data;
  }

  async removeLabel(
    owner: string,
    repo: string,
    issueNumber: number,
    label: string,
  ): Promise<void> {
    await this.#request<void>(
      "DELETE",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`,
    );
  }

  async setLabels(
    owner: string,
    repo: string,
    issueNumber: number,
    labels: string[],
  ): Promise<GitHubLabelResponse[]> {
    return (await this.#request<GitHubLabelResponse[]>(
      "PUT",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/labels`,
      {
        body: { labels },
      },
    )).data;
  }

  async createIssueComment(
    owner: string,
    repo: string,
    issueNumber: number,
    body: string,
  ): Promise<GitHubIssueCommentResponse> {
    return (await this.#request<GitHubIssueCommentResponse>(
      "POST",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/comments`,
      {
        body: { body },
      },
    )).data;
  }

  async updateIssueComment(
    owner: string,
    repo: string,
    commentId: number,
    body: string,
  ): Promise<GitHubIssueCommentResponse> {
    return (await this.#request<GitHubIssueCommentResponse>(
      "PATCH",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/comments/${commentId}`,
      {
        body: { body },
      },
    )).data;
  }

  async deleteIssueComment(owner: string, repo: string, commentId: number): Promise<void> {
    await this.#request<void>(
      "DELETE",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/comments/${commentId}`,
    );
  }

  async listPullRequestReviews(
    owner: string,
    repo: string,
    pullNumber: number,
    page: number,
    perPage: number,
  ): Promise<GitHubPullRequestReviewResponse[]> {
    const result = await this.listPullRequestReviewsConditional(owner, repo, pullNumber, page, perPage);
    if (result.status === 304) {
      throw new Error("GitHub unexpectedly returned 304 for an unconditional pull request review list request.");
    }
    return result.data;
  }

  async listPullRequestReviewsConditional(
    owner: string,
    repo: string,
    pullNumber: number,
    page: number,
    perPage: number,
    options: ConditionalRequestOptions = {},
  ): Promise<ConditionalRequestResult<GitHubPullRequestReviewResponse[]>> {
    return await this.#conditionalGet<GitHubPullRequestReviewResponse[]>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}/reviews`,
      {
        page,
        per_page: perPage,
      },
      options,
    );
  }

  async listPullRequestReviewComments(
    owner: string,
    repo: string,
    pullNumber: number,
    page: number,
    perPage: number,
    since?: string,
  ): Promise<GitHubPullRequestReviewCommentResponse[]> {
    return (await this.#request<GitHubPullRequestReviewCommentResponse[]>(
      "GET",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}/comments`,
      {
        query: {
          page,
          per_page: perPage,
          since,
        },
      },
    )).data;
  }

  async getPullRequestReviewComment(
    owner: string,
    repo: string,
    commentId: number,
  ): Promise<GitHubPullRequestReviewCommentResponse> {
    const result = await this.getPullRequestReviewCommentConditional(owner, repo, commentId);
    if (result.status === 304) {
      throw new Error("GitHub unexpectedly returned 304 for an unconditional review comment request.");
    }
    return result.data;
  }

  async getPullRequestReviewCommentConditional(
    owner: string,
    repo: string,
    commentId: number,
    options: ConditionalRequestOptions = {},
  ): Promise<ConditionalRequestResult<GitHubPullRequestReviewCommentResponse>> {
    return await this.#conditionalGet<GitHubPullRequestReviewCommentResponse>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/comments/${commentId}`,
      undefined,
      options,
    );
  }

  async createPullRequestReview(
    owner: string,
    repo: string,
    pullNumber: number,
    body: {
      commit_id: string;
      body?: string;
      event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
      comments?: Array<{
        path: string;
        body: string;
        side?: "LEFT" | "RIGHT";
        line?: number;
        start_line?: number;
        start_side?: "LEFT" | "RIGHT";
        subject_type?: "line" | "file";
      }>;
    },
  ): Promise<GitHubPullRequestReviewResponse> {
    return (await this.#request<GitHubPullRequestReviewResponse>(
      "POST",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}/reviews`,
      {
        body,
      },
    )).data;
  }

  async updatePullRequestReview(
    owner: string,
    repo: string,
    pullNumber: number,
    reviewId: number,
    body: string,
  ): Promise<GitHubPullRequestReviewResponse> {
    return (await this.#request<GitHubPullRequestReviewResponse>(
      "PUT",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}/reviews/${reviewId}`,
      {
        body: { body },
      },
    )).data;
  }

  async replyToPullRequestReviewComment(
    owner: string,
    repo: string,
    pullNumber: number,
    commentId: number,
    body: string,
  ): Promise<GitHubPullRequestReviewCommentResponse> {
    return (await this.#request<GitHubPullRequestReviewCommentResponse>(
      "POST",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}/comments/${commentId}/replies`,
      {
        body: { body },
      },
    )).data;
  }

  async updatePullRequestReviewComment(
    owner: string,
    repo: string,
    commentId: number,
    body: string,
  ): Promise<GitHubPullRequestReviewCommentResponse> {
    return (await this.#request<GitHubPullRequestReviewCommentResponse>(
      "PATCH",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/comments/${commentId}`,
      {
        body: { body },
      },
    )).data;
  }

  async deletePullRequestReviewComment(
    owner: string,
    repo: string,
    commentId: number,
  ): Promise<void> {
    await this.#request<void>(
      "DELETE",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/comments/${commentId}`,
    );
  }

  async listPullRequestFiles(
    owner: string,
    repo: string,
    pullNumber: number,
    page: number,
    perPage: number,
  ): Promise<GitHubPullFileResponse[]> {
    const result = await this.listPullRequestFilesConditional(owner, repo, pullNumber, page, perPage);
    if (result.status === 304) {
      throw new Error("GitHub unexpectedly returned 304 for an unconditional pull request files request.");
    }
    return result.data;
  }

  async listPullRequestFilesConditional(
    owner: string,
    repo: string,
    pullNumber: number,
    page: number,
    perPage: number,
    options: ConditionalRequestOptions = {},
  ): Promise<ConditionalRequestResult<GitHubPullFileResponse[]>> {
    return await this.#conditionalGet<GitHubPullFileResponse[]>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}/files`,
      {
        page,
        per_page: perPage,
      },
      options,
    );
  }

  async mergePullRequest(
    owner: string,
    repo: string,
    pullNumber: number,
    options: {
      merge_method?: "merge" | "squash" | "rebase";
      commit_title?: string;
      commit_message?: string;
      sha?: string;
    },
  ): Promise<{ sha: string; merged: boolean; message: string }> {
    return (await this.#request<{ sha: string; merged: boolean; message: string }>(
      "PUT",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}/merge`,
      {
        body: options,
      },
    )).data;
  }

  /**
   * `paging` pages the compare's commit listing. Callers that only want the comparison's
   * metadata (e.g. its `merge_base_commit`) should pass `{ perPage: 1, page: 2 }`: GitHub puts
   * the full changed-files array -- up to 300 entries, patches included -- on the *first* page
   * of a compare regardless of `per_page`, while every page carries the static metadata.
   */
  async compareBranches(
    owner: string,
    repo: string,
    base: string,
    head: string,
    paging?: { perPage: number; page: number },
  ): Promise<GitHubCompareResponse> {
    const result = await this.compareBranchesConditional(owner, repo, base, head, {}, paging);
    if (result.status === 304) {
      throw new Error("GitHub unexpectedly returned 304 for an unconditional branch compare request.");
    }
    return result.data;
  }

  async compareBranchesConditional(
    owner: string,
    repo: string,
    base: string,
    head: string,
    options: ConditionalRequestOptions = {},
    paging?: { perPage: number; page: number },
  ): Promise<ConditionalRequestResult<GitHubCompareResponse>> {
    return await this.#conditionalGet<GitHubCompareResponse>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/compare/${encodeURIComponent(`${base}...${head}`)}`,
      paging === undefined ? undefined : { per_page: paging.perPage, page: paging.page },
      options,
    );
  }

  async listBranchesConditional(
    owner: string,
    repo: string,
    query: {
      protected?: boolean;
      per_page: number;
      page: number;
    },
    options: ConditionalRequestOptions = {},
  ): Promise<ConditionalRequestResult<GitHubBranchResponse[]>> {
    return await this.#conditionalGet<GitHubBranchResponse[]>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches`,
      query,
      options,
    );
  }

  /**
   * Look up a single branch's current head commit sha, or null if the branch does not exist.
   * Always an unconditional, uncached read: callers use this to bind a push's expected old head,
   * which must reflect the remote's live state. Read as the exact git ref, because
   * `/branches/<name>` redirects a renamed branch's old name to the new one (as `master` does in
   * many repositories), and git has no such alias.
   */
  async getBranchHead(owner: string, repo: string, branch: string): Promise<string | null> {
    try {
      const result = await this.#request<{ object: { sha: string } }>(
        "GET",
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/heads/${
          branch.split("/").map(encodeURIComponent).join("/")}`,
      );
      return result.data.object.sha;
    } catch (error) {
      // 409 is GitHub's answer for an empty repository, which has no branches at all.
      if (error instanceof GitHubApiError && (error.status === 404 || error.status === 409)) {
        return null;
      }
      throw error;
    }
  }

  async listTagsConditional(
    owner: string,
    repo: string,
    query: {
      per_page: number;
      page: number;
    },
    options: ConditionalRequestOptions = {},
  ): Promise<ConditionalRequestResult<GitHubTagResponse[]>> {
    return await this.#conditionalGet<GitHubTagResponse[]>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tags`,
      query,
      options,
    );
  }

  /**
   * Look up a single commit. `ref` may be a full or truncated commit SHA, a branch name, or a tag
   * name; GitHub resolves truncated SHAs natively (404 if unknown or ambiguous).
   */
  async getCommitConditional(
    owner: string,
    repo: string,
    ref: string,
    options: ConditionalRequestOptions = {},
  ): Promise<ConditionalRequestResult<GitHubCommitResponse>> {
    return await this.#conditionalGet<GitHubCommitResponse>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(ref)}`,
      undefined,
      options,
    );
  }

  /**
   * Resolve a ref to its commit sha only, via the same endpoint as `getCommitConditional` but
   * with GitHub's `sha` media type, so the response is the bare sha instead of the full commit
   * with its whole diff. Same ref grammar: full or truncated commit SHA, branch name, or tag
   * name (404 if unknown or ambiguous).
   */
  async getCommitShaConditional(
    owner: string,
    repo: string,
    ref: string,
    options: ConditionalRequestOptions = {},
  ): Promise<ConditionalRequestResult<string>> {
    return await this.#conditionalGet<string>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(ref)}`,
      undefined,
      options,
      "application/vnd.github.sha",
    );
  }

  /**
   * One level of a git tree object via the git-data API, or null if the tree is unknown to
   * GitHub. Used to enumerate the on-remote side of a simulated pull request diff when the tree
   * object is not in the workspace git cache.
   */
  async getGitTree(owner: string, repo: string, sha: string): Promise<GitHubGitTreeResponse | null> {
    try {
      return (await this.#request<GitHubGitTreeResponse>(
        "GET",
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(sha)}`,
      )).data;
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * A blob's raw bytes via the git-data API. Returns null if the blob is unknown to GitHub, and
   * `"oversized"` when its size exceeds `maxBytes` (the content is then never downloaded) or the
   * response is not base64 (GitHub's signal that the blob is too large to inline).
   */
  async getGitBlob(
    owner: string,
    repo: string,
    sha: string,
    maxBytes: number,
  ): Promise<Uint8Array | "oversized" | null> {
    let response: GitHubGitBlobResponse;
    try {
      response = (await this.#request<GitHubGitBlobResponse>(
        "GET",
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs/${encodeURIComponent(sha)}`,
      )).data;
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) {
        return null;
      }
      throw error;
    }
    if (response.size > maxBytes || response.encoding !== "base64") {
      return "oversized";
    }
    return Uint8Array.from(atob(response.content.replace(/\s+/g, "")), char => char.charCodeAt(0));
  }

  async listCommitsConditional(
    owner: string,
    repo: string,
    query: {
      /** Branch name, tag name, or commit SHA to start listing from. */
      sha?: string;
      path?: string;
      author?: string;
      since?: string;
      until?: string;
      per_page: number;
      page: number;
    },
    options: ConditionalRequestOptions = {},
  ): Promise<ConditionalRequestResult<GitHubCommitResponse[]>> {
    return await this.#conditionalGet<GitHubCommitResponse[]>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits`,
      query,
      options,
    );
  }

  async listPullRequestCommitsConditional(
    owner: string,
    repo: string,
    pullNumber: number,
    page: number,
    perPage: number,
    options: ConditionalRequestOptions = {},
  ): Promise<ConditionalRequestResult<GitHubCommitResponse[]>> {
    return await this.#conditionalGet<GitHubCommitResponse[]>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}/commits`,
      {
        page,
        per_page: perPage,
      },
      options,
    );
  }

  /**
   * POST a git smart-HTTP protocol v2 `upload-pack` request (the git fetch endpoint, on
   * github.com rather than api.github.com) and return the raw `Response`, whose body the caller
   * streams -- see `@gadgets/gatekeeper-kit/git-transport`. Auth is Basic with the `x-access-token` username GitHub
   * specifies for token-authenticated git operations. Throws `GitHubApiError` on a non-OK
   * status (401 marks it an auth error, like every other method here), so callers get the same
   * credential-expiry handling as REST calls.
   */
  async fetchGitUploadPack(owner: string, repo: string, requestBody: Uint8Array): Promise<Response> {
    const url = `${LOGIN_BASE_URL}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}.git/git-upload-pack`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-git-upload-pack-request",
        Accept: "application/x-git-upload-pack-result",
        "Git-Protocol": "version=2",
        "User-Agent": USER_AGENT,
        Authorization: `Basic ${encodeBasicAuth("x-access-token", await this.#getToken())}`,
      },
      body: requestBody,
      // GitHub serves a renamed repo over smart-HTTP without redirecting, so any redirect is
      // refused (as a non-OK status) rather than followed somewhere unbound.
      redirect: "manual",
      // Longer than REQUEST_TIMEOUT_MS: the signal also covers streaming the response body,
      // which may be a pack of tens of megabytes.
      signal: AbortSignal.timeout(GIT_UPLOAD_PACK_TIMEOUT_MS),
    });
    if (!response.ok) {
      // The error body is short prose (e.g. "Repository not found"); a truncated copy makes the
      // failure actionable without trusting its size.
      const detail = (await response.text().catch(() => "")).trim().slice(0, 200);
      throw new GitHubApiError(
        response.status,
        `git fetch failed: ${response.status} ${response.statusText}${detail ? `: ${detail}` : ""}`,
      );
    }
    return response;
  }

  /**
   * POST a git smart-HTTP `receive-pack` request (the git push endpoint; classic protocol -- there
   * is no v2 for receive-pack) and return the raw `Response`, whose report-status body the caller
   * parses -- see `@gadgets/gatekeeper-kit/git-transport`. The request body streams (the pack may be large), so it is
   * sent chunked. Auth and error handling mirror `fetchGitUploadPack`.
   */
  async fetchGitReceivePack(
    owner: string, repo: string, requestBody: ReadableStream<Uint8Array>,
  ): Promise<Response> {
    const url = `${LOGIN_BASE_URL}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}.git/git-receive-pack`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-git-receive-pack-request",
        Accept: "application/x-git-receive-pack-result",
        "User-Agent": USER_AGENT,
        Authorization: `Basic ${encodeBasicAuth("x-access-token", await this.#getToken())}`,
      },
      body: requestBody,
      redirect: "manual",
      // Same generous budget as fetch: the signal also covers streaming the pack up.
      signal: AbortSignal.timeout(GIT_UPLOAD_PACK_TIMEOUT_MS),
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).trim().slice(0, 200);
      throw new GitHubApiError(
        response.status,
        `git push failed: ${response.status} ${response.statusText}${detail ? `: ${detail}` : ""}`,
      );
    }
    return response;
  }
}
