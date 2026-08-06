export type GitHubOAuthGrant = {
  accessToken: string;
  scopes: string[];
  tokenType: string;
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
  name: string;
  full_name: string;
  html_url: string;
  description?: string | null;
  visibility?: "public" | "private" | "internal";
  private?: boolean;
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
  status: "added" | "modified" | "removed" | "renamed" | "copied";
  previous_filename?: string;
  additions: number;
  deletions: number;
  patch?: string;
};

export type GitHubCompareResponse = {
  base_commit: {
    sha: string;
  };
  commits?: Array<{
    sha: string;
  }>;
  total_commits: number;
  files?: GitHubPullFileResponse[];
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
  baseUrl?: string;
  auth?: "bearer" | "basic" | "none";
  headers?: Record<string, string | undefined>;
  okStatuses?: number[];
  basicAuth?: {
    username: string;
    password: string;
  };
};

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

async function request<T>(
  method: string,
  path: string,
  options: RequestOptions = {},
  getToken?: () => Promise<string>,
): Promise<RequestResult<T>> {
  const url = new URL(path, options.baseUrl ?? API_BASE_URL);

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

  const response = await fetch(url.toString(), {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

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

export async function exchangeAuthCode(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
): Promise<GitHubOAuthGrant> {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
  });

  const response = await fetch(`${LOGIN_BASE_URL}/login/oauth/access_token`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
    },
    body: body.toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const parsed = await parseBody(response);
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    if (typeof parsed === "string" && parsed.length > 0) {
      message = parsed;
    } else if (parsed && typeof parsed === "object") {
      const details = parsed as { error?: string; error_description?: string };
      message = [details.error, details.error_description].filter(Boolean).join(": ") || message;
    }
    throw new GitHubApiError(response.status, message, parsed);
  }

  const result = parsed as {
    access_token?: string;
    scope?: string;
    token_type?: string;
    error?: string;
    error_description?: string;
  };
  if (!result.access_token || !result.token_type || result.error) {
    const message = [result.error, result.error_description].filter(Boolean).join(": ")
      || "GitHub OAuth token exchange failed";
    throw new GitHubApiError(400, message, parsed);
  }

  return {
    accessToken: result.access_token,
    scopes: result.scope?.split(",").map((scope: string) => scope.trim()).filter(Boolean) ?? [],
    tokenType: result.token_type,
  };
}

export async function revokeOAuthGrant(
  accessToken: string,
  clientId: string,
  clientSecret: string,
): Promise<void> {
  await request<void>(
    "DELETE",
    `/applications/${encodeURIComponent(clientId)}/grant`,
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

export class GitHubApi {
  #getToken: () => Promise<string>;

  constructor(getToken: () => Promise<string>) {
    this.#getToken = getToken;
  }

  async #request<T>(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<RequestResult<T>> {
    return await request<T>(method, path, options, this.#getToken);
  }

  async #conditionalGet<T>(
    path: string,
    query: Record<string, string | number | boolean | undefined> | undefined,
    options: ConditionalRequestOptions = {},
  ): Promise<ConditionalRequestResult<T>> {
    const result = await this.#request<T>("GET", path, {
      query,
      headers: options.ifNoneMatch ? { "If-None-Match": options.ifNoneMatch } : undefined,
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

  // Returns the account's primary, verified email (for use as a sign-in identity), or null if the
  // account has no verified email. Requires the `user:email` scope.
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

  // GitHub's `/search/repositories` endpoint. Use this when the user has typed a query so we
  // only fetch the matching repos rather than enumerating their entire affiliation list. The
  // query string follows GitHub's search-syntax (e.g. "react user:jonesphillip in:name").
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

  async listReviewCommentsForReview(
    owner: string,
    repo: string,
    pullNumber: number,
    reviewId: number,
    page: number,
    perPage: number,
  ): Promise<GitHubPullRequestReviewCommentResponse[]> {
    const result = await this.listReviewCommentsForReviewConditional(
      owner,
      repo,
      pullNumber,
      reviewId,
      page,
      perPage,
    );
    if (result.status === 304) {
      throw new Error("GitHub unexpectedly returned 304 for an unconditional review comment list request.");
    }
    return result.data;
  }

  async listReviewCommentsForReviewConditional(
    owner: string,
    repo: string,
    pullNumber: number,
    reviewId: number,
    page: number,
    perPage: number,
    options: ConditionalRequestOptions = {},
  ): Promise<ConditionalRequestResult<GitHubPullRequestReviewCommentResponse[]>> {
    return await this.#conditionalGet<GitHubPullRequestReviewCommentResponse[]>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}/reviews/${reviewId}/comments`,
      {
        per_page: perPage,
        page,
      },
      options,
    );
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

  async compareBranches(
    owner: string,
    repo: string,
    base: string,
    head: string,
  ): Promise<GitHubCompareResponse> {
    const result = await this.compareBranchesConditional(owner, repo, base, head);
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
  ): Promise<ConditionalRequestResult<GitHubCompareResponse>> {
    return await this.#conditionalGet<GitHubCompareResponse>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/compare/${encodeURIComponent(`${base}...${head}`)}`,
      undefined,
      options,
    );
  }
}
