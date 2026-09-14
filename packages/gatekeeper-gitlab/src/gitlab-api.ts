// HTTP client for the GitLab REST API v4, its OAuth endpoints, and its git smart-HTTP endpoints,
// parameterized by instance: every request goes to a caller-supplied `apiOrigin` (the browser-
// facing instance URL, or a separate Worker-facing hostname when the two differ) and carries the
// caller's extra headers (a Cloudflare Access service-token pair, for instances behind Access).
//
// Response shapes below are the fields this gatekeeper reads, taken from the GitLab REST API
// documentation. Everything in this module is provider plumbing; gitlab.ts owns the agent-facing
// behaviour (caching, actions, simulation).

/** A grant returned by the token endpoint. GitLab's documented response carries no `scope`. */
export type GitLabOAuthGrant = {
  accessToken: string;
  refreshToken: string;
  /** Absolute expiry, from the response's `expires_in` (never a hard-coded 7200: admins can change it). */
  expiresAt: Date;
};

/** The current user, `GET /user`. `email` is the primary address; `confirmed_at` proves it. */
export type GitLabUserResponse = {
  id: number;
  username: string;
  name: string;
  avatar_url?: string | null;
  web_url: string;
  email?: string | null;
  confirmed_at?: string | null;
};

/** A user as it appears nested in issuables and elsewhere. */
export type GitLabSimpleUser = {
  id: number;
  username: string;
  name?: string | null;
  avatar_url?: string | null;
  web_url: string;
};

/** Per-user access levels on a project, `GET /projects/:id`. Both are null for a non-member. */
export type GitLabProjectPermissions = {
  project_access: { access_level: number } | null;
  group_access: { access_level: number } | null;
};

export type GitLabProjectResponse = {
  id: number;
  name: string;
  path: string;
  path_with_namespace: string;
  web_url: string;
  description?: string | null;
  visibility: "public" | "private" | "internal";
  default_branch?: string | null;
  namespace: { full_path: string; name: string; path: string };
  permissions?: GitLabProjectPermissions;
  archived?: boolean;
  empty_repo?: boolean;
};

/** A label object, as returned with `with_labels_details=true`. */
export type GitLabLabelResponse = {
  id?: number;
  name: string;
  color?: string;
  text_color?: string;
  description?: string | null;
};

export type GitLabIssueResponse = {
  id: number;
  iid: number;
  project_id: number;
  title: string;
  description?: string | null;
  state: "opened" | "closed";
  author: GitLabSimpleUser | null;
  assignees?: GitLabSimpleUser[];
  /** Plain names by default; objects when the request set `with_labels_details=true`. */
  labels: Array<string | GitLabLabelResponse>;
  user_notes_count: number;
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
  web_url: string;
  references?: { short: string; relative: string; full: string };
};

/** `diff_refs` as GitLab spells them. Note the inversion: `base_sha` IS the merge base. */
export type GitLabDiffRefsResponse = {
  /** The merge base of source and target. */
  base_sha: string;
  /** The head of the *target* branch when the diff was computed. */
  start_sha: string;
  /** The head of the source branch. */
  head_sha: string;
};

export type GitLabMergeRequestResponse = {
  id: number;
  iid: number;
  project_id: number;
  title: string;
  description?: string | null;
  state: "opened" | "closed" | "merged" | "locked";
  draft: boolean;
  author: GitLabSimpleUser | null;
  assignees?: GitLabSimpleUser[];
  reviewers?: GitLabSimpleUser[];
  labels: Array<string | GitLabLabelResponse>;
  user_notes_count: number;
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
  merged_at?: string | null;
  web_url: string;
  source_branch: string;
  target_branch: string;
  source_project_id: number;
  target_project_id: number;
  /** Head commit of the source branch. */
  sha: string;
  merge_commit_sha?: string | null;
  squash_commit_sha?: string | null;
  /** Single-GET only; empty right after creation until GitLab computes the diff. */
  diff_refs?: GitLabDiffRefsResponse | null;
  /** Single-GET only. A string: `"12"`, or `"1000+"` when capped. Empty until computed. */
  changes_count?: string | null;
  detailed_merge_status?: string;
  has_conflicts?: boolean;
  should_remove_source_branch?: boolean | null;
  squash?: boolean;
  /** Single-GET only. */
  user?: { can_merge: boolean };
};

export type GitLabApprovalsResponse = {
  approved_by: Array<{ user: GitLabSimpleUser }>;
};

export type GitLabNoteResponse = {
  id: number;
  type?: "DiscussionNote" | "DiffNote" | null;
  body: string;
  author: GitLabSimpleUser | null;
  created_at: string;
  updated_at: string;
  /** GitLab-generated activity ("added label ~bug"), never a person's words. */
  system: boolean;
  noteable_iid?: number | null;
  resolvable?: boolean;
  resolved?: boolean;
  resolved_by?: GitLabSimpleUser | null;
  /** Present on `DiffNote`s. */
  position?: GitLabPositionResponse | null;
};

/** A diff-note position. `line_range` is present for multi-line comments. */
export type GitLabPositionResponse = {
  base_sha: string;
  start_sha: string;
  head_sha: string;
  old_path: string;
  new_path: string;
  position_type: "text" | "image" | "file";
  old_line?: number | null;
  new_line?: number | null;
  line_range?: {
    start: GitLabLineRangeEndpoint;
    end: GitLabLineRangeEndpoint;
  } | null;
};

export type GitLabLineRangeEndpoint = {
  line_code: string;
  type: "new" | "old" | null;
  old_line?: number | null;
  new_line?: number | null;
};

export type GitLabDiscussionResponse = {
  id: string;
  individual_note: boolean;
  notes: GitLabNoteResponse[];
};

export type GitLabDraftNoteResponse = {
  id: number;
  author_id: number;
  merge_request_id: number;
  discussion_id?: string | null;
  note: string;
  position?: GitLabPositionResponse | null;
};

/** One file of `GET …/merge_requests/:iid/diffs` or a compare's `diffs`. */
export type GitLabDiffResponse = {
  old_path: string;
  new_path: string;
  a_mode?: string | null;
  b_mode?: string | null;
  diff: string;
  new_file: boolean;
  renamed_file: boolean;
  deleted_file: boolean;
  generated_file?: boolean;
  /** 18.4+: patch excluded but fetchable. */
  collapsed?: boolean;
  /** 18.4+: patch excluded and not fetchable. */
  too_large?: boolean;
};

export type GitLabCommitResponse = {
  id: string;
  short_id: string;
  title: string;
  message: string;
  author_name?: string | null;
  author_email?: string | null;
  authored_date?: string | null;
  committer_name?: string | null;
  committer_email?: string | null;
  committed_date?: string | null;
  parent_ids?: string[];
  web_url: string;
  /** Single-GET only (or `with_stats` on the list). */
  stats?: { additions: number; deletions: number; total: number };
};

export type GitLabBranchResponse = {
  name: string;
  protected: boolean;
  default: boolean;
  can_push?: boolean;
  commit: { id: string };
};

export type GitLabTagResponse = {
  name: string;
  /** The tag object's sha for annotated tags, the commit's for lightweight ones -- use `commit.id`. */
  target: string;
  commit: { id: string };
};

export type GitLabCompareResponse = {
  commit: GitLabCommitResponse | null;
  /** Always complete, even when `compare_timeout` is set. */
  commits: GitLabCommitResponse[];
  /** May be incomplete when `compare_timeout` is set. */
  diffs: GitLabDiffResponse[];
  compare_timeout: boolean;
  compare_same_ref: boolean;
};

/**
 * A failed GitLab request. `status` is the HTTP status; `isAuthError` marks a 401, which callers
 * treat as "revoked, reconnect" -- not "refresh": expiry is handled ahead of time from
 * `expires_in`, so a 401 on a token still fresh by our clock means it was revoked, and a refresh
 * would only come back `invalid_grant`. `movedTo` is set when the API answered a 3xx: a renamed
 * or transferred project answers its old path with a `301` to its numeric-id URL, which must
 * never be followed (a followed 301 turns a POST into a GET).
 */
export class GitLabApiError extends Error {
  status: number;
  details?: unknown;
  isAuthError: boolean;
  movedTo?: string;

  constructor(status: number, message: string, details?: unknown, movedTo?: string) {
    super(message);
    this.name = "GitLabApiError";
    this.status = status;
    this.details = details;
    this.isAuthError = status === 401;
    this.movedTo = movedTo;
  }
}

/** Where a `GitLabApi` sends requests and what it attaches to each. */
export type GitLabInstance = {
  /** Worker-facing origin, e.g. `https://gitlab.com` or a Cloudflare Access service-token hostname. */
  apiOrigin: string;
  /** Extra headers for every upstream request (the `CF-Access-Client-*` pair, or none). */
  headers: Record<string, string>;
};

type QueryValue = string | number | boolean | undefined | null;
type Query = Record<string, QueryValue | QueryValue[]>;

type RequestOptions = {
  query?: Query;
  body?: unknown;
  headers?: Record<string, string | undefined>;
  okStatuses?: number[];
};

export type RequestResult<T> = {
  data: T;
  headers: Headers;
  status: number;
};

export const DEFAULT_INSTANCE_URL = "https://gitlab.com";
const USER_AGENT = "Cloudflare-Gadgets";
const REQUEST_TIMEOUT_MS = 30_000;
const GIT_TIMEOUT_MS = 120_000;

function encodeBasicAuth(username: string, password: string): string {
  return btoa(`${username}:${password}`);
}

/**
 * Encode a project path for use as GitLab's `:id` path parameter: the whole path with its
 * namespaces as one URL-encoded segment (`group%2Fsub%2Fproject`).
 */
export function encodeProjectPath(pathWithNamespace: string): string {
  return encodeURIComponent(pathWithNamespace);
}

/**
 * Encode a branch or tag name for a path parameter. GitLab wants the whole name as one segment
 * (`feature%2Fx`), the opposite of GitHub's per-segment join.
 */
export function encodeRefName(name: string): string {
  return encodeURIComponent(name);
}

async function parseBody(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return await response.json();
  }
  return await response.text();
}

/**
 * Extract a message from GitLab's three documented error shapes: `{"message": "404 …"}`, the
 * validation hash `{"message": {"field": ["…"]}}`, and OAuth-style `{"error", "error_description"}`.
 */
export function errorMessageFromBody(parsed: unknown, fallback: string): string {
  if (typeof parsed === "string" && parsed.length > 0) return parsed;
  if (parsed && typeof parsed === "object") {
    const body = parsed as { message?: unknown; error?: unknown; error_description?: unknown };
    if (typeof body.message === "string") return body.message;
    if (body.message && typeof body.message === "object") {
      const parts = Object.entries(body.message as Record<string, unknown>).map(([field, errors]) =>
        `${field}: ${Array.isArray(errors) ? errors.join(", ") : String(errors)}`);
      if (parts.length > 0) return parts.join("; ");
    }
    const oauth = [body.error, body.error_description].filter(v => typeof v === "string");
    if (oauth.length > 0) return oauth.join(": ");
  }
  return fallback;
}

/**
 * Explain a 3xx from the REST API. Two unrelated things answer with one: a renamed or
 * transferred project, whose old path 301s to its numeric-id URL under `/api/v4/`, and an
 * access proxy in front of the instance (Cloudflare Access without a valid service token) that
 * 302s every request to a login page. They need opposite remedies, so the message is chosen by
 * the redirect's *path*, not its host: GitLab builds the rename's Location from its configured
 * external URL -- the browser-facing host -- which differs from the host the Worker requested
 * whenever the instance is reached through a separate Access hostname.
 */
function redirectMessage(requested: URL, location: string | undefined): string {
  let target: URL | undefined;
  try {
    target = location === undefined ? undefined : new URL(location, requested);
  } catch {}
  if (target?.pathname.startsWith("/api/v4/")) {
    return "The GitLab project has been renamed or transferred; re-bind the connection to its new path.";
  }
  return `GitLab did not answer the request: the API redirected to ${target?.origin ?? "an unknown location"}. ` +
    "If the instance is behind Cloudflare Access, the gatekeeper's service token must be accepted by the Access application in front of the API.";
}

function appendQuery(url: URL, query: Query | undefined): void {
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      // GitLab's array params are spelled `key[]=a&key[]=b`.
      for (const item of value) {
        if (item !== undefined && item !== null) url.searchParams.append(`${key}[]`, String(item));
      }
    } else {
      url.searchParams.set(key, String(value));
    }
  }
}

/**
 * Send one request to the API: the instance's headers and the bearer token attached, the
 * documented redirect behaviour applied (see `redirectMessage`), and any status the caller did not
 * list as acceptable turned into a `GitLabApiError` carrying GitLab's message. The response is
 * returned unread so the caller decides how to consume the body -- as JSON (`request`), or as a
 * capped byte stream (`GitLabApi.getBlob`). `okStatuses` names non-2xx statuses that are answers
 * rather than failures (a 404 that means "none", say).
 */
async function send(
  instance: GitLabInstance,
  method: string,
  path: string,
  options: RequestOptions & { accept?: string },
  getToken?: () => Promise<string>,
): Promise<Response> {
  const url = new URL(`/api/v4${path}`, instance.apiOrigin);
  appendQuery(url, options.query);

  const headers = new Headers({ "User-Agent": USER_AGENT, ...instance.headers });
  if (options.accept !== undefined) headers.set("Accept", options.accept);
  for (const [key, value] of Object.entries(options.headers ?? {})) {
    if (value !== undefined) headers.set(key, value);
  }
  if (getToken) {
    headers.set("Authorization", `Bearer ${await getToken()}`);
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
    // Never follow: a renamed project's 301 points at its numeric-id URL, and following it would
    // silently turn a POST into a GET. Surfaced as a "project moved" error instead.
    redirect: "manual",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => {});
    const location = response.headers.get("location") ?? undefined;
    throw new GitLabApiError(response.status, redirectMessage(url, location), undefined, location);
  }

  if (!response.ok && !(options.okStatuses ?? []).includes(response.status)) {
    const parsed = await parseBody(response);
    let message = errorMessageFromBody(parsed, `${response.status} ${response.statusText}`);
    if (response.status === 429) {
      const retryAfter = response.headers.get("retry-after");
      if (retryAfter) message += ` (retry after ${retryAfter}s)`;
    }
    throw new GitLabApiError(response.status, message, parsed);
  }

  return response;
}

/** `send`, with the JSON (or text) body read. */
async function request<T>(
  instance: GitLabInstance,
  method: string,
  path: string,
  options: RequestOptions = {},
  getToken?: () => Promise<string>,
): Promise<RequestResult<T>> {
  const response = await send(instance, method, path, { ...options, accept: "application/json" }, getToken);
  const parsed = await parseBody(response);
  return { data: parsed as T, headers: response.headers, status: response.status };
}

// ---------------------------------------------------------------------------
// OAuth

function base64UrlEncode(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of arr) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Generate a PKCE code verifier (43 chars of base64url) and its S256 challenge. */
export async function generatePkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64UrlEncode(digest) };
}

/**
 * The `GET /oauth/authorize` URL on the *browser-facing* instance origin (the user's own session
 * must reach it). PKCE S256, `response_type=code`.
 */
export function buildAuthorizeUrl(instanceUrl: string, params: {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL("/oauth/authorize", instanceUrl);
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", params.scopes.join(" "));
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

type RawTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  error?: string;
  error_description?: string;
};

async function postForm(
  instance: GitLabInstance,
  path: string,
  form: Record<string, string>,
): Promise<Response> {
  return await fetch(new URL(path, instance.apiOrigin).toString(), {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
      ...instance.headers,
    },
    body: new URLSearchParams(form).toString(),
    redirect: "manual",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

function grantFromResponse(parsed: unknown, now: number): GitLabOAuthGrant {
  const result = parsed as RawTokenResponse;
  if (!result.access_token || !result.refresh_token || typeof result.expires_in !== "number") {
    throw new GitLabApiError(400, errorMessageFromBody(parsed, "GitLab OAuth token response was incomplete"), parsed);
  }
  return {
    accessToken: result.access_token,
    refreshToken: result.refresh_token,
    expiresAt: new Date(now + result.expires_in * 1000),
  };
}

/**
 * `grant_type=authorization_code` with PKCE. Both `client_secret` and `code_verifier` are sent:
 * the application is registered as confidential, and PKCE is additional.
 */
export async function exchangeAuthCode(
  instance: GitLabInstance,
  params: { code: string; clientId: string; clientSecret: string; redirectUri: string; codeVerifier: string },
  now = Date.now(),
): Promise<GitLabOAuthGrant> {
  const response = await postForm(instance, "/oauth/token", {
    grant_type: "authorization_code",
    code: params.code,
    client_id: params.clientId,
    client_secret: params.clientSecret,
    redirect_uri: params.redirectUri,
    code_verifier: params.codeVerifier,
  });
  const parsed = await parseBody(response);
  if (!response.ok) {
    throw new GitLabApiError(response.status,
      errorMessageFromBody(parsed, "GitLab OAuth token exchange failed"), parsed);
  }
  return grantFromResponse(parsed, now);
}

/** Outcome of a refresh: a new grant, or `revoked` when GitLab reports the refresh token is dead. */
export type RefreshResult =
  | { ok: true; grant: GitLabOAuthGrant }
  | { ok: false; revoked: true; message: string };

/**
 * `grant_type=refresh_token`. GitLab rotates: the response carries a new refresh token and the
 * old one is invalidated, so the caller must persist the new pair before using either. An
 * `invalid_grant` error means the refresh token was already used, expired, or revoked.
 */
export async function refreshAccessToken(
  instance: GitLabInstance,
  params: { refreshToken: string; clientId: string; clientSecret: string; redirectUri: string },
  now = Date.now(),
): Promise<RefreshResult> {
  const response = await postForm(instance, "/oauth/token", {
    grant_type: "refresh_token",
    refresh_token: params.refreshToken,
    client_id: params.clientId,
    client_secret: params.clientSecret,
    redirect_uri: params.redirectUri,
  });
  const parsed = await parseBody(response);
  if (!response.ok) {
    const body = parsed as RawTokenResponse | string;
    if (typeof body === "object" && body?.error === "invalid_grant") {
      return { ok: false, revoked: true, message: errorMessageFromBody(parsed, "invalid_grant") };
    }
    throw new GitLabApiError(response.status,
      errorMessageFromBody(parsed, "GitLab OAuth token refresh failed"), parsed);
  }
  return { ok: true, grant: grantFromResponse(parsed, now) };
}

/** `POST /oauth/revoke`. Returns 200 with `{}` on success; a failure throws. */
export async function revokeToken(
  instance: GitLabInstance,
  params: { token: string; clientId: string; clientSecret: string },
): Promise<void> {
  const response = await postForm(instance, "/oauth/revoke", {
    token: params.token,
    client_id: params.clientId,
    client_secret: params.clientSecret,
  });
  if (!response.ok) {
    const parsed = await parseBody(response);
    throw new GitLabApiError(response.status,
      errorMessageFromBody(parsed, "GitLab OAuth token revocation failed"), parsed);
  }
  await response.body?.cancel().catch(() => {});
}

// ---------------------------------------------------------------------------
// REST client

export class GitLabApi {
  #instance: GitLabInstance;
  #getToken: () => Promise<string>;

  constructor(instance: GitLabInstance, getToken: () => Promise<string>) {
    this.#instance = instance;
    this.#getToken = getToken;
  }

  get instance(): GitLabInstance {
    return this.#instance;
  }

  async #request<T>(method: string, path: string, options: RequestOptions = {}): Promise<RequestResult<T>> {
    return await request<T>(this.#instance, method, path, options, this.#getToken);
  }

  async #get<T>(path: string, query?: Query): Promise<T> {
    return (await this.#request<T>("GET", path, { query })).data;
  }

  // -- users

  /** The token's own user. `email` + non-null `confirmed_at` is the provider-verified identity. */
  async getCurrentUser(): Promise<GitLabUserResponse> {
    return await this.#get<GitLabUserResponse>("/user");
  }

  /** Users matching a username exactly (case-insensitive). Empty when none. */
  async findUsersByUsername(username: string): Promise<GitLabSimpleUser[]> {
    return await this.#get<GitLabSimpleUser[]>("/users", { username });
  }

  // -- projects

  async getProject(projectPath: string): Promise<GitLabProjectResponse> {
    return await this.#get<GitLabProjectResponse>(`/projects/${encodeProjectPath(projectPath)}`);
  }

  /**
   * Projects the user is a member of, optionally filtered by `search` (matched against path,
   * name, and description; with `search_namespaces`, ancestor namespaces too).
   */
  async listMemberProjects(options: { search?: string; perPage: number; page: number }): Promise<GitLabProjectResponse[]> {
    return await this.#get<GitLabProjectResponse[]>("/projects", {
      membership: true,
      search: options.search || undefined,
      search_namespaces: options.search ? true : undefined,
      order_by: "last_activity_at",
      sort: "desc",
      per_page: options.perPage,
      page: options.page,
    });
  }

  // -- issues

  async getIssue(projectPath: string, iid: number): Promise<GitLabIssueResponse> {
    return await this.#get<GitLabIssueResponse>(
      `/projects/${encodeProjectPath(projectPath)}/issues/${iid}`,
      { with_labels_details: true },
    );
  }

  async listIssues(projectPath: string, options: {
    state?: "opened" | "closed" | "all";
    labels?: string[];
    authorUsername?: string;
    assigneeUsername?: string;
    search?: string;
    orderBy?: "created_at" | "updated_at" | "popularity";
    sort?: "asc" | "desc";
    perPage: number;
    page: number;
  }): Promise<GitLabIssueResponse[]> {
    return await this.#get<GitLabIssueResponse[]>(`/projects/${encodeProjectPath(projectPath)}/issues`, {
      state: options.state === "all" ? undefined : options.state,
      labels: options.labels?.length ? options.labels.join(",") : undefined,
      author_username: options.authorUsername,
      assignee_username: options.assigneeUsername ? [options.assigneeUsername] : undefined,
      search: options.search,
      order_by: options.orderBy,
      sort: options.sort,
      with_labels_details: true,
      per_page: options.perPage,
      page: options.page,
    });
  }

  async createIssue(projectPath: string, body: {
    title: string;
    description?: string;
    labels?: string[];
    assignee_ids?: number[];
  }): Promise<GitLabIssueResponse> {
    return (await this.#request<GitLabIssueResponse>("POST", `/projects/${encodeProjectPath(projectPath)}/issues`, {
      body: {
        title: body.title,
        description: body.description,
        labels: body.labels?.length ? body.labels.join(",") : undefined,
        assignee_ids: body.assignee_ids,
      },
    })).data;
  }

  /** `PUT` an issue: any of title, description, `state_event`, `add_labels`, `remove_labels`. */
  async updateIssue(projectPath: string, iid: number, patch: GitLabIssuablePatch): Promise<GitLabIssueResponse> {
    return (await this.#request<GitLabIssueResponse>("PUT",
      `/projects/${encodeProjectPath(projectPath)}/issues/${iid}`, { body: issuablePatchBody(patch) })).data;
  }

  // -- merge requests

  async getMergeRequest(projectPath: string, iid: number): Promise<GitLabMergeRequestResponse> {
    return await this.#get<GitLabMergeRequestResponse>(
      `/projects/${encodeProjectPath(projectPath)}/merge_requests/${iid}`,
      { with_labels_details: true },
    );
  }

  async listMergeRequests(projectPath: string, options: {
    state?: "opened" | "closed" | "merged" | "locked" | "all";
    sourceBranch?: string;
    targetBranch?: string;
    labels?: string[];
    authorUsername?: string;
    assigneeUsername?: string;
    /** Draft filter; spelled with the `wip` param, which every supported version accepts. */
    draft?: boolean;
    search?: string;
    orderBy?: "created_at" | "updated_at";
    sort?: "asc" | "desc";
    perPage: number;
    page: number;
  }): Promise<GitLabMergeRequestResponse[]> {
    return await this.#get<GitLabMergeRequestResponse[]>(
      `/projects/${encodeProjectPath(projectPath)}/merge_requests`, {
        state: options.state ?? "all",
        source_branch: options.sourceBranch,
        target_branch: options.targetBranch,
        labels: options.labels?.length ? options.labels.join(",") : undefined,
        author_username: options.authorUsername,
        assignee_username: options.assigneeUsername ? [options.assigneeUsername] : undefined,
        wip: options.draft === undefined ? undefined : options.draft ? "yes" : "no",
        search: options.search,
        order_by: options.orderBy,
        sort: options.sort,
        with_labels_details: true,
        per_page: options.perPage,
        page: options.page,
      });
  }

  async createMergeRequest(projectPath: string, body: {
    source_branch: string;
    target_branch: string;
    title: string;
    description?: string;
    remove_source_branch?: boolean;
    squash?: boolean;
  }): Promise<GitLabMergeRequestResponse> {
    return (await this.#request<GitLabMergeRequestResponse>("POST",
      `/projects/${encodeProjectPath(projectPath)}/merge_requests`, { body })).data;
  }

  async updateMergeRequest(projectPath: string, iid: number, patch: GitLabIssuablePatch): Promise<GitLabMergeRequestResponse> {
    return (await this.#request<GitLabMergeRequestResponse>("PUT",
      `/projects/${encodeProjectPath(projectPath)}/merge_requests/${iid}`, { body: issuablePatchBody(patch) })).data;
  }

  async getMergeRequestApprovals(projectPath: string, iid: number): Promise<GitLabApprovalsResponse> {
    return await this.#get<GitLabApprovalsResponse>(
      `/projects/${encodeProjectPath(projectPath)}/merge_requests/${iid}/approvals`);
  }

  /** `POST …/approve`. With `sha`, GitLab answers 409 if the head has moved. */
  async approveMergeRequest(projectPath: string, iid: number, sha?: string): Promise<void> {
    await this.#request<unknown>("POST",
      `/projects/${encodeProjectPath(projectPath)}/merge_requests/${iid}/approve`, { body: { sha } });
  }

  async unapproveMergeRequest(projectPath: string, iid: number): Promise<void> {
    await this.#request<unknown>("POST",
      `/projects/${encodeProjectPath(projectPath)}/merge_requests/${iid}/unapprove`);
  }

  async mergeMergeRequest(projectPath: string, iid: number, options: {
    squash?: boolean;
    should_remove_source_branch?: boolean;
    merge_commit_message?: string;
    squash_commit_message?: string;
    sha?: string;
  }): Promise<GitLabMergeRequestResponse> {
    return (await this.#request<GitLabMergeRequestResponse>("PUT",
      `/projects/${encodeProjectPath(projectPath)}/merge_requests/${iid}/merge`, { body: options })).data;
  }

  /** One page of the MR's changed files. Patches are in `diff`; large ones are `too_large`/`collapsed`. */
  async listMergeRequestDiffs(projectPath: string, iid: number, page: number, perPage: number): Promise<GitLabDiffResponse[]> {
    return await this.#get<GitLabDiffResponse[]>(
      `/projects/${encodeProjectPath(projectPath)}/merge_requests/${iid}/diffs`, { page, per_page: perPage });
  }

  async listMergeRequestCommits(projectPath: string, iid: number, page: number, perPage: number): Promise<GitLabCommitResponse[]> {
    return await this.#get<GitLabCommitResponse[]>(
      `/projects/${encodeProjectPath(projectPath)}/merge_requests/${iid}/commits`, { page, per_page: perPage });
  }

  // -- notes and discussions

  /**
   * One page of notes on an issue or merge request. Ordered by `updated_at` descending so an
   * incremental sync can stop at the first note older than its watermark (there is no `since`).
   */
  async listNotes(projectPath: string, kind: "issues" | "merge_requests", iid: number, options: {
    orderBy?: "created_at" | "updated_at";
    sort?: "asc" | "desc";
    page: number;
    perPage: number;
  }): Promise<GitLabNoteResponse[]> {
    return await this.#get<GitLabNoteResponse[]>(
      `/projects/${encodeProjectPath(projectPath)}/${kind}/${iid}/notes`, {
        order_by: options.orderBy,
        sort: options.sort,
        page: options.page,
        per_page: options.perPage,
      });
  }

  async createNote(projectPath: string, kind: "issues" | "merge_requests", iid: number, body: string): Promise<GitLabNoteResponse> {
    return (await this.#request<GitLabNoteResponse>("POST",
      `/projects/${encodeProjectPath(projectPath)}/${kind}/${iid}/notes`, { body: { body } })).data;
  }

  async deleteNote(projectPath: string, kind: "issues" | "merge_requests", iid: number, noteId: number): Promise<void> {
    await this.#request<void>("DELETE",
      `/projects/${encodeProjectPath(projectPath)}/${kind}/${iid}/notes/${noteId}`);
  }

  async listMergeRequestDiscussions(projectPath: string, iid: number, page: number, perPage: number): Promise<GitLabDiscussionResponse[]> {
    return await this.#get<GitLabDiscussionResponse[]>(
      `/projects/${encodeProjectPath(projectPath)}/merge_requests/${iid}/discussions`, { page, per_page: perPage });
  }

  /** Reply within an existing discussion. */
  async addDiscussionNote(projectPath: string, iid: number, discussionId: string, body: string): Promise<GitLabNoteResponse> {
    return (await this.#request<GitLabNoteResponse>("POST",
      `/projects/${encodeProjectPath(projectPath)}/merge_requests/${iid}/discussions/${encodeURIComponent(discussionId)}/notes`,
      { body: { body } })).data;
  }

  async setDiscussionResolved(projectPath: string, iid: number, discussionId: string, resolved: boolean): Promise<void> {
    await this.#request<unknown>("PUT",
      `/projects/${encodeProjectPath(projectPath)}/merge_requests/${iid}/discussions/${encodeURIComponent(discussionId)}`,
      { body: { resolved } });
  }

  // -- draft notes (reviews)

  async listDraftNotes(projectPath: string, iid: number): Promise<GitLabDraftNoteResponse[]> {
    return await this.#get<GitLabDraftNoteResponse[]>(
      `/projects/${encodeProjectPath(projectPath)}/merge_requests/${iid}/draft_notes`);
  }

  /** Create one draft note; `position` makes it a diff comment, omitting it a plain one. */
  async createDraftNote(projectPath: string, iid: number, body: {
    note: string;
    position?: GitLabPositionRequest;
  }): Promise<GitLabDraftNoteResponse> {
    return (await this.#request<GitLabDraftNoteResponse>("POST",
      `/projects/${encodeProjectPath(projectPath)}/merge_requests/${iid}/draft_notes`, { body })).data;
  }

  async publishDraftNote(projectPath: string, iid: number, draftNoteId: number): Promise<void> {
    await this.#request<unknown>("PUT",
      `/projects/${encodeProjectPath(projectPath)}/merge_requests/${iid}/draft_notes/${draftNoteId}/publish`);
  }

  /**
   * Publish every pending draft of the token's user on this MR, optionally with a summary
   * `note` and a `reviewer_state`. `reviewer_state` does not record a formal approval.
   */
  async bulkPublishDraftNotes(projectPath: string, iid: number, body: {
    note?: string;
    reviewer_state?: "reviewed" | "requested_changes";
  }): Promise<void> {
    await this.#request<unknown>("POST",
      `/projects/${encodeProjectPath(projectPath)}/merge_requests/${iid}/draft_notes/bulk_publish`, { body });
  }

  // -- repository

  /** A branch, or null when it does not exist. Always live: callers bind push expectations to it. */
  async getBranch(projectPath: string, branch: string): Promise<GitLabBranchResponse | null> {
    try {
      return await this.#get<GitLabBranchResponse>(
        `/projects/${encodeProjectPath(projectPath)}/repository/branches/${encodeRefName(branch)}`);
    } catch (error) {
      if (error instanceof GitLabApiError && error.status === 404) return null;
      throw error;
    }
  }

  async listBranches(projectPath: string, options: { search?: string; page: number; perPage: number }): Promise<GitLabBranchResponse[]> {
    return await this.#get<GitLabBranchResponse[]>(
      `/projects/${encodeProjectPath(projectPath)}/repository/branches`,
      { search: options.search, page: options.page, per_page: options.perPage });
  }

  async listTags(projectPath: string, page: number, perPage: number): Promise<GitLabTagResponse[]> {
    return await this.#get<GitLabTagResponse[]>(
      `/projects/${encodeProjectPath(projectPath)}/repository/tags`, { page, per_page: perPage });
  }

  /**
   * A single commit by sha (full or abbreviated), branch name, or tag name. GitLab has no
   * sha-only media type, so this is also how a ref is resolved. Null on 404.
   */
  async getCommit(projectPath: string, ref: string): Promise<GitLabCommitResponse | null> {
    try {
      return await this.#get<GitLabCommitResponse>(
        `/projects/${encodeProjectPath(projectPath)}/repository/commits/${encodeRefName(ref)}`, { stats: true });
    } catch (error) {
      if (error instanceof GitLabApiError && error.status === 404) return null;
      throw error;
    }
  }

  async listCommits(projectPath: string, options: {
    refName?: string;
    path?: string;
    author?: string;
    since?: string;
    until?: string;
    page: number;
    perPage: number;
  }): Promise<GitLabCommitResponse[]> {
    return await this.#get<GitLabCommitResponse[]>(
      `/projects/${encodeProjectPath(projectPath)}/repository/commits`, {
        ref_name: options.refName,
        path: options.path,
        author: options.author,
        since: options.since,
        until: options.until,
        page: options.page,
        per_page: options.perPage,
      });
  }

  /** Three-dot compare (`from...to`, via the merge base). The response has no merge base of its own. */
  async compare(projectPath: string, from: string, to: string): Promise<GitLabCompareResponse> {
    return await this.#get<GitLabCompareResponse>(
      `/projects/${encodeProjectPath(projectPath)}/repository/compare`, { from, to });
  }

  /** The merge base of two refs, or null when they are unrelated (GitLab answers 400 or 404). */
  async mergeBase(projectPath: string, a: string, b: string): Promise<GitLabCommitResponse | null> {
    try {
      return await this.#get<GitLabCommitResponse>(
        `/projects/${encodeProjectPath(projectPath)}/repository/merge_base`, { refs: [a, b] });
    } catch (error) {
      if (error instanceof GitLabApiError && (error.status === 404 || error.status === 400)) return null;
      throw error;
    }
  }

  /**
   * A blob's raw bytes by oid, or null if unknown, or `"oversized"` once more than `maxBytes` have
   * arrived. Read from the documented raw endpoint (`…/blobs/:sha/raw`) as a stream that is
   * abandoned the moment it exceeds the cap: the JSON endpoint carries the whole blob as base64
   * in one body that would have to be buffered before its `size` could be read, and a blob a
   * simulated diff touches can be far larger than any Worker should hold. GitLab rate-limits
   * blobs over 10 MB to 5 requests a minute.
   */
  async getBlob(projectPath: string, sha: string, maxBytes: number): Promise<Uint8Array | "oversized" | null> {
    const response = await send(this.#instance, "GET",
      `/projects/${encodeProjectPath(projectPath)}/repository/blobs/${encodeURIComponent(sha)}/raw`,
      { okStatuses: [404] }, this.#getToken);
    if (response.status === 404) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    if (response.body === null) return new Uint8Array();
    return await collectBytesCapped(response.body, maxBytes);
  }

  // -- git smart-HTTP

  /**
   * POST a git smart-HTTP protocol v2 `upload-pack` request and return the raw `Response`, whose
   * body the caller streams -- see `@gadgets/gatekeeper-kit/git-transport`. Auth is Basic with the
   * `oauth2` username GitLab documents for OAuth access tokens; the token is fetched immediately
   * before the request (it may be close to expiry). Throws `GitLabApiError` on a non-OK status, and
   * on a 3xx or non-git content type, which means Access or a login page answered rather than
   * GitLab.
   */
  async fetchGitUploadPack(projectPath: string, requestBody: Uint8Array): Promise<Response> {
    return await this.#gitPost(projectPath, "git-upload-pack", requestBody, {
      "Content-Type": "application/x-git-upload-pack-request",
      Accept: "application/x-git-upload-pack-result",
      "Git-Protocol": "version=2",
    }, "fetch");
  }

  /**
   * POST a git smart-HTTP `receive-pack` request (classic protocol -- there is no v2 for
   * receive-pack) and return the raw `Response`, whose report-status body the caller parses.
   * The request body streams (the pack may be large). Requires the `write_repository` scope.
   */
  async fetchGitReceivePack(projectPath: string, requestBody: ReadableStream<Uint8Array>): Promise<Response> {
    return await this.#gitPost(projectPath, "git-receive-pack", requestBody, {
      "Content-Type": "application/x-git-receive-pack-request",
      Accept: "application/x-git-receive-pack-result",
    }, "push");
  }

  async #gitPost(
    projectPath: string,
    service: "git-upload-pack" | "git-receive-pack",
    body: Uint8Array | ReadableStream<Uint8Array>,
    headers: Record<string, string>,
    verb: "fetch" | "push",
  ): Promise<Response> {
    const url = `${this.#instance.apiOrigin}/${gitRepoPath(projectPath)}.git/${service}`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        ...headers,
        "User-Agent": USER_AGENT,
        Authorization: `Basic ${encodeBasicAuth("oauth2", await this.#getToken())}`,
        ...this.#instance.headers,
      },
      body,
      redirect: "manual",
      // Longer than REQUEST_TIMEOUT_MS: the signal also covers streaming the pack.
      signal: AbortSignal.timeout(GIT_TIMEOUT_MS),
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {});
      throw new GitLabApiError(response.status,
        `git ${verb} failed: the git endpoint redirected (${response.headers.get("location") ?? "no location"}); ` +
        "if the instance is behind Cloudflare Access, the Access application must admit the service token on the .git/ paths.",
        undefined, response.headers.get("location") ?? undefined);
    }
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).trim().slice(0, 200);
      throw new GitLabApiError(response.status,
        `git ${verb} failed: ${response.status} ${response.statusText}${detail ? `: ${detail}` : ""}`);
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.startsWith(headers.Accept)) {
      await response.body?.cancel().catch(() => {});
      throw new GitLabApiError(502,
        `git ${verb} failed: expected ${headers.Accept} but the endpoint answered ${contentType || "no content type"}; ` +
        "this usually means a login page or proxy answered instead of GitLab.");
    }
    return response;
  }
}

/** The project path as it appears in a git URL: segments individually encoded, slashes kept. */
export function gitRepoPath(projectPath: string): string {
  return projectPath.split("/").map(encodeURIComponent).join("/");
}

/**
 * Collect a byte stream, or answer `"oversized"` and cancel it as soon as more than `maxBytes`
 * have arrived -- so the bound holds on what the Worker holds, not on what the server sent.
 */
async function collectBytesCapped(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array | "oversized"> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) return "oversized";
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Fields a `PUT` on an issue or merge request may change. */
export type GitLabIssuablePatch = {
  title?: string;
  description?: string;
  state_event?: "close" | "reopen";
  add_labels?: string[];
  remove_labels?: string[];
};

function issuablePatchBody(patch: GitLabIssuablePatch): Record<string, unknown> {
  return {
    title: patch.title,
    description: patch.description,
    state_event: patch.state_event,
    add_labels: patch.add_labels?.length ? patch.add_labels.join(",") : undefined,
    remove_labels: patch.remove_labels?.length ? patch.remove_labels.join(",") : undefined,
  };
}

/** A diff-note position for `POST …/discussions` and `POST …/draft_notes`. */
export type GitLabPositionRequest = {
  base_sha: string;
  start_sha: string;
  head_sha: string;
  position_type: "text" | "file";
  old_path: string;
  new_path: string;
  old_line?: number;
  new_line?: number;
  line_range?: {
    start: { line_code: string; type: "new" | "old" };
    end: { line_code: string; type: "new" | "old" };
  };
};

/**
 * GitLab's `line_code` for a diff line, as its documentation spells it: `<SHA1 of the file
 * path>_<old_line>_<new_line>`. GitLab derives both numbers from its own walk of the patch --
 * for an added line, `old_line` is the old-side position the walk had reached (not 0) -- so the
 * caller supplies both from the same hunk walk that numbered the diff it read.
 */
export async function lineCode(path: string, oldLine: number, newLine: number): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(path));
  const hex = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
  return `${hex}_${oldLine}_${newLine}`;
}
