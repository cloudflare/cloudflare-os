import { CredentialsExpiredError, isCredentialsExpired, type RefreshCredentials } from "@gadgets/gatekeeper-kit/credentials";
import {
  GitRefUpdateRejectedError, MAX_RECEIVE_PACK_RESPONSE_BYTES, parseReceivePackResponse, validateBranchName,
} from "@gadgets/gatekeeper-kit/git-transport";
import {
  isInvalidGrant, mergeOAuthTokens, OAuthClient, oauthRefresh,
} from "@gadgets/gatekeeper-kit/oauth-client";
import { readBytesCapped, ResponseTooLargeError } from "@gadgets/gatekeeper-kit/response-body";
import type { AnsweredWith, CallAnswer } from "@gadgets/gatekeeper-kit/upstream";
import type { UserAccount } from "./github";
import {
  API_BASE_URL, githubUpstream, namesWait, type GitHubGraphqlOperation, type GitHubOperation,
} from "./github-upstream";

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
  id: number;
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
  /** The authenticated account's permissions on the repository. */
  permissions?: { admin: boolean };
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
  /** Why it can or cannot merge, e.g. `clean` or `blocked`; unset until GitHub has computed it. */
  mergeable_state?: string | null;
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

/** A repository webhook as this gatekeeper configures one: JSON payloads, signed with `secret`. */
export type GitHubRepoWebhookConfig = {
  url: string;
  secret: string;
  events: readonly string[];
};

/** A repository webhook, as GitHub reports one (never with its secret). */
export type GitHubRepoWebhookResponse = {
  id: number;
  active?: boolean;
  events?: string[];
  /** Where and how it delivers: `content_type` `"json"` or `"form"`; `insecure_ssl` `"0"` verifies TLS. */
  config: { url?: string; content_type?: string; insecure_ssl?: string | number };
};

/** One attempt at a webhook delivery, as the webhook's delivery log lists it. */
export type GitHubWebhookDeliveryResponse = {
  id: number;
  /** The delivery's `X-GitHub-Delivery` id, which every redelivery of it keeps. */
  guid: string;
  delivered_at: string;
  /** The HTTP status the attempt was answered with. */
  status_code: number;
};

/** The query of an issue search, which asks for GitHub's advanced search parsing. */
function issueSearch(query: string, page: number, perPage: number, sort?: string, order?: string) {
  return { q: query, advanced_search: true, page, per_page: perPage, sort, order };
}

function webhookBody({ url, secret, events }: GitHubRepoWebhookConfig) {
  return { active: true, events, config: { url, secret, content_type: "json", insecure_ssl: "0" } };
}

/** Bounds one read of a webhook's delivery log, at 100 attempts a page. */
const MAX_DELIVERY_PAGES = 10;
/**
 * Bounds one listing of a repository's webhooks, at 100 a page: far beyond the 20 per event that
 * GitHub allows a repository, for any likely number of events.
 */
const MAX_WEBHOOK_PAGES = 20;

/** The `cursor` of the page a `Link` header names as the next, if any. */
function nextCursor(headers: Headers): string | undefined {
  const next = headers.get("Link")?.split(",").find(link => /;\s*rel="next"/.test(link));
  const url = next?.match(/<([^>]+)>/)?.[1];
  return (url && URL.parse(url)?.searchParams.get("cursor")) || undefined;
}

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

/** A check run, as the checks API reports it. */
export type GitHubCheckRunResponse = {
  id: number;
  /** The GraphQL node id. */
  node_id: string;
  head_sha: string;
  name: string;
  html_url: string | null;
  details_url: string | null;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  output: {
    title: string | null;
    summary: string | null;
    text: string | null;
    annotations_count: number;
  };
  app: { name: string; slug?: string } | null;
};

export type GitHubCheckAnnotationResponse = {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: string | null;
  title: string | null;
  message: string;
};

/** A GitHub Actions job, as the workflow jobs API reports it. */
export type GitHubWorkflowJobResponse = {
  id: number;
  run_id: number;
  run_attempt?: number;
  head_sha: string;
  name: string;
  workflow_name?: string | null;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  html_url: string | null;
  /** The job's check run, `.../check-runs/<id>`. */
  check_run_url: string;
  steps?: Array<{ number: number; name: string; status: string; conclusion: string | null }>;
};

/** A GitHub Actions workflow run, as the workflow runs API reports it. */
export type GitHubWorkflowRunResponse = {
  id: number;
  name?: string | null;
  event: string;
  head_branch: string | null;
  head_sha: string;
  status: string | null;
  conclusion: string | null;
  run_attempt?: number;
  created_at: string;
  updated_at: string;
  run_started_at?: string;
  html_url: string;
  actor?: GitHubSimpleUser | null;
};

/** One entry of a repository's activity log. */
export type GitHubActivityResponse = {
  after: string;
  timestamp: string;
  activity_type: string;
};

/** One rule that applies to a branch, from any ruleset. */
export type GitHubBranchRuleResponse = {
  type: string;
  parameters?: { required_status_checks?: Array<{ context: string }> };
};

/** The required status checks of a branch's classic protection, where the reader may see them. */
export type GitHubBranchProtectionChecksResponse = {
  contexts?: string[];
  checks?: Array<{ context: string }>;
};

/** A GraphQL error: `path` names the field it nulled, when it concerns one. */
export type GitHubGraphqlError = { message: string; type?: string; path?: (string | number)[] };

/** A GraphQL response: `data` may be partial when `errors` is set. */
export type GitHubGraphqlResult<T> = {
  data: T;
  errors: GitHubGraphqlError[];
};

export class GitHubApiError extends Error {
  status: number;
  details?: unknown;
  isAuthError: boolean;
  /**
   * Whether GitHub refused the request for a rate limit, primary or secondary, rather than for want
   * of permission: with a 429, or a 403 that its rate-limit headers mark as one, or whose message
   * does, as GitHub's docs say a secondary limit's may be told by alone.
   */
  rateLimited: boolean;

  constructor(status: number, message: string, details?: unknown, headers?: Headers) {
    super(message);
    this.name = "GitHubApiError";
    this.status = status;
    this.details = details;
    this.isAuthError = status === 401;
    this.rateLimited = status === 429 || (status === 403 && (headers?.get("x-ratelimit-remaining") === "0" ||
      headers?.has("retry-after") === true || /\bsecondary rate limit\b/i.test(message)));
  }
}

type RequestOptions<T = unknown, B = T> = {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  auth?: "bearer" | "basic" | "none";
  headers?: Record<string, string | undefined>;
  okStatuses?: number[];
  /**
   * The caller throws on a 304, though it is among `okStatuses`: a 304 is then counted by its
   * status, an error.
   */
  refusesUnchanged?: boolean;
  /**
   * Answer a redirect to an https location off the API host with the redirect itself, unfollowed,
   * as for a download GitHub hands off to its blob storage.
   */
  externalRedirect?: true;
  basicAuth?: {
    username: string;
    password: string;
  };
  /** The name the request is counted under, where its path names none (see GitHubOperation). */
  operation?: GitHubOperation;
  /**
   * Reads what the request was sent for out of the parsed body of an answer with a 2xx status,
   * within the request, so that a body it throws on is counted an error with the reason `api`: a
   * body that was read and is not what the request was sent for. What it returns is the
   * result's `data`, and what it throws is what the request throws.
   */
  read?: (body: B) => T;
  /**
   * How an answer that is no error by its status is counted where its status does not say: from
   * its `data`, its status and its headers. It answers for an answer that is neither a redirect
   * nor a 304.
   */
  counted?: (data: unknown, answered: AnsweredWith) => CallAnswer | undefined;
};

/**
 * A repository with its GitHub id, which survives renames and owner transfers and is never reused.
 * A request beneath `/repos/<owner>/<repo>` is sent beneath `/repositories/<id>` instead (see
 * requestUrl): the same address GitHub redirects a renamed repository's old path to, and one no
 * other repository can take over, as a repository created under a deleted or renamed one's freed
 * name takes over that name.
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

/**
 * The options of a read that takes no 304 for an answer, known by identity: each unconditional
 * read asks through its conditional twin with these and throws on a 304, which is so counted by
 * its status and not as the success a 304 is to a conditional read.
 */
const UNCONDITIONAL: ConditionalRequestOptions = Object.freeze({});

const LOGIN_BASE_URL = "https://github.com";
const API_VERSION = "2022-11-28";
const DEFAULT_ACCEPT = "application/vnd.github+json";
const USER_AGENT = "Cloudflare-Gadgets";
const GIT_UPLOAD_PACK_TIMEOUT_MS = 120_000;
/** Also covers streaming the log body, which may run to tens of megabytes. */
const LOG_DOWNLOAD_TIMEOUT_MS = 120_000;

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
 * Where a request for `path` is sent: with `pin`, a path beneath the pinned repository's name goes
 * to the same path beneath its id (see PinnedRepo); every other path is sent as given.
 */
function requestUrl(path: string, pin: PinnedRepo | undefined): URL {
  const url = new URL(path, API_BASE_URL);
  if (!pin) return url;
  const prefix = `/repos/${encodeURIComponent(pin.owner)}/${encodeURIComponent(pin.repo)}`;
  const suffix = url.pathname.slice(prefix.length);
  if (url.pathname.startsWith(prefix) && (suffix === "" || suffix.startsWith("/"))) {
    url.pathname = `/repositories/${pin.id}${suffix}`;
  }
  return url;
}

/**
 * The URL to re-issue a redirected request to, built rather than taken from `location`. Only an
 * unpinned request for a repository's root is followed, to `/repositories/<id>`: GitHub redirects
 * a renamed or transferred repository there, and at the root the id can only be that same
 * repository's. A pinned request is addressed by id already, and beneath a repository GitHub
 * redirects only into another one, as for a transferred issue.
 */
function redirectTarget(url: URL, location: string | null, pin: PinnedRepo | undefined): URL | undefined {
  const moved = location === null ? null : URL.parse(location);
  if (pin || moved?.origin !== API_BASE_URL) return undefined;
  return REPO_ROOT_PATH.test(url.pathname) && REPO_ID_PATH.test(moved.pathname)
    ? new URL(`${moved.pathname}${url.search}`, API_BASE_URL) : undefined;
}

async function request<T, B = T>(
  method: string,
  path: string,
  options: RequestOptions<T, B> = {},
  getToken?: () => Promise<string>,
  pin?: PinnedRepo,
): Promise<RequestResult<T>> {
  const url = requestUrl(path, pin);

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
  // A redirect off the API host to another https origin, such as GitHub's blob storage.
  const handedOff = (r: Response) => {
    const location = URL.parse(r.headers.get("location") ?? "");
    return options.externalRedirect === true && isRedirect(r.status) &&
      location?.protocol === "https:" && location.origin !== API_BASE_URL;
  };
  // Sends to `to` and reads the answer. `reissued` is the request a redirect was re-issued as,
  // which follows no redirect of its own.
  const send = (to: URL, reissued: boolean) => githubUpstream.read<Answered<T>>(
    to, { ...init, operation: options.operation },
    async response => {
      if (isRedirect(response.status)) {
        if (handedOff(response)) return { response, handedOff: true };
        const target = reissued ? undefined : redirectTarget(url, response.headers.get("location"), pin);
        return { response, target };
      }
      if (!response.ok && !(options.okStatuses ?? []).includes(response.status)) {
        return { response, error: await apiError(response) };
      }
      let parsed: unknown;
      try {
        parsed = await parseBody(response);
      } catch (thrown) {
        // A body that could not be read is the client's to count and, where its attempt's
        // timeout cut it off, to ask for again. Not so one whose answer names a wait: a request
        // sent before that wait is over is refused, and its refusal would be thrown in place of
        // this failure. It is handed on, counted as the client would count it, and thrown.
        if (!namesWait(response.headers)) throw thrown;
        void response.body?.cancel().catch(() => undefined);
        return { response, lost: { thrown } };
      }
      if (!response.ok || !options.read) return { response, data: parsed as T };
      try {
        return { response, data: options.read(parsed as B) };
      } catch (thrown) {
        return { response, unread: { thrown } };
      }
    },
    (answered, answer) => {
      // A redirect that is acted on is what its request was sent for; one that is refused is
      // counted by its status, an error.
      if (answered.handedOff || answered.target) return { outcome: "success" };
      // A 403 that GitHub marks as a rate limit is a refusal, as a 429 is.
      if (answered.error) return answered.error.rateLimited ? { outcome: "refused", reason: "rate" } : undefined;
      if (isRedirect(answer.status)) return undefined;
      // A 304 says that nothing changed, which a conditional read takes for its answer. A read
      // whose caller throws on one is counted by its status.
      if (answer.status === 304) return options.refusesUnchanged ? undefined : { outcome: "success" };
      if (answered.lost) return { outcome: "error", reason: isTimeout(answered.lost.thrown) ? "timeout" : "parse" };
      // A body that was parsed and that the method's reading throws on is not what was asked for.
      if (answered.unread) return { outcome: "error", reason: "api" };
      return options.counted?.(answered.data, answer);
    },
  );
  let answered = await send(url, false);
  if (answered.target) answered = await send(answered.target, true);
  const { response } = answered;
  if (isRedirect(response.status) && !answered.handedOff) {
    // The destination is withheld: it may name a repository the binding's observers cannot read.
    throw new GitHubApiError(response.status,
      `GitHub moved ${url.pathname} out of the bound repository; it was not followed.`);
  }
  if (answered.handedOff) {
    await response.body?.cancel();
    return { data: undefined as T, headers: response.headers, status: response.status };
  }
  if (answered.error) throw answered.error;
  if (answered.lost) throw answered.lost.thrown;
  if (answered.unread) throw answered.unread.thrown;
  return {
    data: answered.data as T,
    headers: response.headers,
    status: response.status,
  };
}

// One answer of the API, read: a redirect that is handed to the caller or re-issued to `target`,
// the error an unsuccessful status is thrown as, what the reading of a body threw whose answer
// names a wait, what the method's reading of the parsed body threw, or what was read of that
// body.
type Answered<T> = {
  response: Response;
  handedOff?: true;
  target?: URL;
  error?: GitHubApiError;
  lost?: { thrown: unknown };
  unread?: { thrown: unknown };
  data?: T;
};

// The body of a GraphQL answer: `data` may be partial, or absent, where `errors` is set.
type GraphqlBody<T> = { data?: T | null; errors?: GitHubGraphqlError[] };

// Whether a GraphQL answer holds no data, which fails the query whatever else the answer holds.
function withoutData(data: unknown): data is null | undefined {
  return data === undefined || data === null;
}

// How a GraphQL answer is counted: GitHub reports a failed query, and a spent rate limit, inside a
// 200. An answer with no data is an error whether it names one or not, a body that is no object
// included. `partial` marks errors that came with data. Data that came with no error is an error
// where `refusal` gives one for it or throws on it: data that was read and is not what the query
// was sent for.
function graphqlAnswer<T>(
  body: unknown, refusal: ((data: T) => GitHubApiError | undefined) | undefined,
): CallAnswer | undefined {
  const { data, errors } = (typeof body === "object" && body !== null ? body : {}) as GraphqlBody<T>;
  // An entry that is no error names no rate limit.
  const failed: (GitHubGraphqlError | undefined)[] = Array.isArray(errors) ? errors : [];
  if (failed.some(error => error?.type === "RATE_LIMITED")) return { outcome: "refused", reason: "rate" };
  if (withoutData(data)) return { outcome: "error", reason: "api" };
  if (failed.length > 0) return { outcome: "error", reason: "api", detail: "partial" };
  try {
    return refusal?.(data) && { outcome: "error", reason: "api" };
  } catch {
    return { outcome: "error", reason: "api" };
  }
}

// Where an answer hands its request off to: the `location` of a redirect, and null for an answer
// that is none or names none.
function handOff(status: number, headers: Headers): string | null {
  return isRedirect(status) ? headers.get("location") : null;
}

// Whether an answer says that what was asked for is gone.
function gone(status: number): boolean {
  return status === 404 || status === 410;
}

// Whether `error` is what a timeout aborts with: the reason of an `AbortSignal.timeout`, which a
// body that the signal cut off fails its reading with.
function isTimeout(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "TimeoutError";
}

// The rows of a page of a listing that GitHub answers as an object: a count of all there is to
// list, and the rows of the page in a list beside it. A page with no rows holds an empty list. An
// answer that holds no list is no page of the listing, whatever it counts, and is thrown here, so
// that the request it answered is the one that fails.
function listedRows<R>(rows: R[] | undefined, what: string): R[] {
  if (!Array.isArray(rows)) throw new GitHubApiError(502, `GitHub answered a listing of ${what} with no list.`);
  return rows;
}

// A log's download, read: what its reader read of the log, or what the reader threw.
type Downloaded<T> = { log: T; unread?: undefined } | { unread: { thrown: unknown } };

// The media types of the results git's smart-HTTP endpoints answer with: the pack of a fetch, and
// the report of a push.
const UPLOAD_PACK_RESULT = "application/x-git-upload-pack-result";
const RECEIVE_PACK_RESULT = "application/x-git-receive-pack-result";

// Whether an answer says it is the git result `expected`. A success that does not is a page
// answered in place of the result, by GitHub or by a proxy before it.
function isGitResult(answered: Headers, expected: string): boolean {
  return (answered.get("content-type") ?? "").trim().toLowerCase().startsWith(expected);
}

// Whether a fetch's answer holds a pack for the transport to stream: it says it is one, and has a
// body. Neither its body nor its stream is read for this.
function holdsPack(answered: Response): boolean {
  return answered.body !== null && isGitResult(answered.headers, UPLOAD_PACK_RESULT);
}

// The error that a success which does not say it is the git result `expected` is thrown as. It
// says whether the answer named a content type and not which: nothing of an answer's headers is
// put into an error, which may be logged.
function notGitResult(verb: "fetch" | "push", expected: string, answered: Headers): GitHubApiError {
  const named = answered.has("content-type") ? "another content type" : "no content type";
  return new GitHubApiError(502,
    `git ${verb} failed: expected ${expected} but GitHub answered ${named}; ` +
    "this usually means an error page or a proxy answered instead of the git endpoint.");
}

// A push's answer, read: the answer to hand the transport and, where it is a git result of a
// successful status, the report-status body that answer holds.
type Pushed = { response: Response; report?: Uint8Array };

// Reads the report-status body of a push's answer as the transport reads one: up to the size it
// takes, and refused beyond that in the transport's words.
async function readPushReport(answer: Response): Promise<Uint8Array> {
  return await readBytesCapped(answer, MAX_RECEIVE_PACK_RESPONSE_BYTES).catch((error: unknown) => {
    if (error instanceof ResponseTooLargeError) {
      throw new Error(`git push response exceeded the ${MAX_RECEIVE_PACK_RESPONSE_BYTES}-byte limit`);
    }
    throw error;
  });
}

// How a push that GitHub answered with a success is counted: git reports a ref update it refused
// inside that answer, in the report the transport's parser reads. An update the parser reads as
// refused is an error of the API inside a success, and one it reads as applied is counted by its
// status. A body the parser throws on for any other reason (one that is no report, that does not
// mention `refName`, or that says the pack did not unpack) is counted as one that could not be
// parsed: the parser gives none of them a class of its own.
function pushAnswer(report: Uint8Array, refName: string): CallAnswer | undefined {
  try {
    parseReceivePackResponse(report, refName);
    return undefined;
  } catch (error) {
    return { outcome: "error", reason: error instanceof GitRefUpdateRejectedError ? "api" : "parse" };
  }
}

// The error an unsuccessful answer is thrown as, with the message its body gives where it has one.
// Whether an answer's status and headers alone say it is a rate limit: a 429, or a 403 with none of
// the primary limit left or a wait named.
function throttledByHeaders(response: Response): boolean {
  return response.status === 429 || (response.status === 403 &&
    (response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after")));
}

async function apiError(response: Response): Promise<GitHubApiError> {
  // A body that cannot be read leaves the error to its status and headers where those say on their
  // own that it is a rate limit. Otherwise its reading's failure is thrown: a 403 may be a limit
  // told by its body alone, and is no denial while that body is unread.
  const parsed = await parseBody(response).catch((error: unknown) => {
    if (throttledByHeaders(response)) return undefined;
    throw error;
  });
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
  return new GitHubApiError(response.status, message, parsed, response.headers);
}

function oauthClient(clientId: string, clientSecret: string): OAuthClient {
  return new OAuthClient({
    label: "GitHub",
    client: { method: "post", id: clientId, secret: clientSecret },
    tokenEndpoint: `${LOGIN_BASE_URL}/login/oauth/access_token`,
    headers: { "User-Agent": USER_AGENT },
    scopeSeparator: ",",
    upstream: githubUpstream,
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
      operation: "token.revoke",
    },
  );
}

/**
 * GitHub's REST API as one account. With `repo`, a request beneath its name is sent by its id (see
 * PinnedRepo) and no redirect is followed; without it, only a repository root's redirect to its id
 * is (see redirectTarget). Every other redirect fails with a GitHubApiError.
 */
export class GitHubApi {
  #getToken: () => Promise<string>;
  #repo?: PinnedRepo;

  constructor(getToken: () => Promise<string>, options: { repo?: PinnedRepo } = {}) {
    this.#getToken = getToken;
    this.#repo = options.repo;
  }

  async #request<T, B = T>(
    method: string,
    path: string,
    options: RequestOptions<T, B> = {},
  ): Promise<RequestResult<T>> {
    return await request<T, B>(method, path, options, this.#getToken, this.#repo);
  }

  async #conditionalGet<T, B = T>(
    path: string,
    query: Record<string, string | number | boolean | undefined> | undefined,
    options: ConditionalRequestOptions = {},
    accept?: string,
    read?: (body: B) => T,
  ): Promise<ConditionalRequestResult<T>> {
    const result = await this.#request<T, B>("GET", path, {
      query,
      headers: {
        ...(options.ifNoneMatch ? { "If-None-Match": options.ifNoneMatch } : undefined),
        ...(accept ? { Accept: accept } : undefined),
      },
      okStatuses: [304],
      refusesUnchanged: options === UNCONDITIONAL,
      read,
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
    const result = await this.getViewerConditional(UNCONDITIONAL);
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
    return (await this.#request<string | null, Array<{
      email: string; primary: boolean; verified: boolean;
    }> | undefined>("GET", "/user/emails", {
      read: body => {
        const emails = body ?? [];
        const primary = emails.find(e => e.primary && e.verified);
        const verified = primary ?? emails.find(e => e.verified);
        return verified?.email ?? null;
      },
    })).data;
  }

  async getRepo(owner: string, repo: string): Promise<GitHubRepoResponse> {
    const result = await this.getRepoConditional(owner, repo, UNCONDITIONAL);
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

  /**
   * The repository with GitHub id `id`, whatever it is named now. `/repositories/<id>` is where
   * GitHub redirects a renamed repository's old path.
   */
  async getRepoByIdConditional(
    id: number,
    options: ConditionalRequestOptions = {},
  ): Promise<ConditionalRequestResult<GitHubRepoResponse>> {
    return await this.#conditionalGet<GitHubRepoResponse>(`/repositories/${id}`, undefined, options);
  }

  async listRepos(options: {
    affiliation?: string;
    sort?: string;
    direction?: string;
    per_page: number;
    page: number;
  }): Promise<GitHubRepoResponse[]> {
    const result = await this.#request<GitHubRepoResponse[]>("GET", "/user/repos", {
      query: options, read: rows => listedRows(rows, "repositories"),
    });
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
    return (await this.#request<GitHubRepoResponse[], { items: GitHubRepoResponse[] }>(
      "GET", "/search/repositories", { query: options, read: body => listedRows(body.items, "repositories") })).data;
  }

  // A repository's webhooks are addressed by its id, as `/repositories/<id>` is where GitHub
  // redirects a renamed repository's old path: a name a rename freed can name another repository.

  /** The repository's webhooks, every page of them. GitHub answers only a repository admin. */
  async listRepoWebhooks(repoId: number): Promise<GitHubRepoWebhookResponse[]> {
    return await githubUpstream.summed(async () => {
      const webhooks: GitHubRepoWebhookResponse[] = [];
      // A short page is the last.
      for (let page = 1; page <= MAX_WEBHOOK_PAGES; page++) {
        // The page is added to the list as its answer is read, and its length is what is read of it.
        const { data: listed } = await this.#request<number, GitHubRepoWebhookResponse[]>(
          "GET", `/repositories/${repoId}/hooks`, {
            query: { per_page: 100, page },
            read: data => {
              webhooks.push(...data);
              return data.length;
            },
          });
        if (listed < 100) return webhooks;
      }
      throw new Error(`Repository ${repoId} has more webhooks than can be listed.`);
    });
  }

  /** Adds an active webhook to the repository. GitHub allows only a repository admin to. */
  async createRepoWebhook(repoId: number, webhook: GitHubRepoWebhookConfig): Promise<GitHubRepoWebhookResponse> {
    return (await this.#request<GitHubRepoWebhookResponse>(
      "POST", `/repositories/${repoId}/hooks`, { body: { name: "web", ...webhookBody(webhook) } },
    )).data;
  }

  /** Makes an existing webhook active, with exactly `webhook`'s URL, secret and events. */
  async updateRepoWebhook(
    repoId: number, hookId: number, webhook: GitHubRepoWebhookConfig,
  ): Promise<GitHubRepoWebhookResponse> {
    return (await this.#request<GitHubRepoWebhookResponse>(
      "PATCH", `/repositories/${repoId}/hooks/${hookId}`, { body: webhookBody(webhook) },
    )).data;
  }

  /** A repository webhook, which GitHub shows only to a repository admin. */
  async getRepoWebhook(repoId: number, hookId: number): Promise<GitHubRepoWebhookResponse> {
    return (await this.#request<GitHubRepoWebhookResponse>("GET", `/repositories/${repoId}/hooks/${hookId}`)).data;
  }

  /**
   * A webhook's delivery attempts since `since` (in ms since the epoch), newest first, as GitHub
   * lists them. GitHub keeps three days of them.
   */
  async listRepoWebhookDeliveries(repoId: number, hookId: number, since: number): Promise<GitHubWebhookDeliveryResponse[]> {
    const path = `/repositories/${repoId}/hooks/${hookId}/deliveries`;
    return await githubUpstream.summed(async () => {
      const deliveries: GitHubWebhookDeliveryResponse[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_DELIVERY_PAGES; page++) {
        // What is read of a page: its recent deliveries, and how many it lists.
        const { data: { recent, listed }, headers } = await this.#request<
          { recent: GitHubWebhookDeliveryResponse[]; listed: number }, GitHubWebhookDeliveryResponse[]
        >("GET", path, {
          query: { per_page: 100, cursor },
          read: data => ({
            recent: data.filter(delivery => Date.parse(delivery.delivered_at) >= since),
            listed: data.length,
          }),
        });
        deliveries.push(...recent);
        cursor = nextCursor(headers);
        if (cursor === undefined || recent.length < listed) break;
      }
      return deliveries;
    });
  }

  /** Asks GitHub to make a webhook delivery again, which it does in its own time. */
  async redeliverRepoWebhookDelivery(repoId: number, hookId: number, deliveryId: number): Promise<void> {
    await this.#request<void>("POST", `/repositories/${repoId}/hooks/${hookId}/deliveries/${deliveryId}/attempts`);
  }

  /**
   * Deletes a webhook. A 404 is not an error, though it means either that the webhook is gone or
   * that the account may no longer manage it: GitHub answers a non-admin the same.
   */
  async deleteRepoWebhook(repoId: number, hookId: number): Promise<void> {
    await this.#request<void>("DELETE", `/repositories/${repoId}/hooks/${hookId}`, { okStatuses: [404] });
  }

  async getIssue(owner: string, repo: string, issueNumber: number): Promise<GitHubIssueResponse> {
    const result = await this.getIssueConditional(owner, repo, issueNumber, UNCONDITIONAL);
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
    const result = await this.getPullRequestConditional(owner, repo, pullNumber, UNCONDITIONAL);
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
    const result = await this.listIssuesConditional(owner, repo, options, UNCONDITIONAL);
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
    return await this.#conditionalGet<GitHubIssueResponse[], GitHubIssueResponse[]>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`,
      query,
      options,
      undefined,
      rows => listedRows(rows, "issues"),
    );
  }

  async searchIssues(
    query: string,
    page: number,
    perPage: number,
    sort?: string,
    order?: string,
  ): Promise<GitHubIssueResponse[]> {
    const result = await this.#conditionalGet<GitHubIssueResponse[], { items: GitHubIssueResponse[] }>(
      "/search/issues", issueSearch(query, page, perPage, sort, order), UNCONDITIONAL, undefined,
      body => listedRows(body.items, "issues"));
    if (result.status === 304) {
      throw new Error("GitHub unexpectedly returned 304 for an unconditional issue search request.");
    }
    return result.data;
  }

  async searchIssuesConditional(
    query: string,
    page: number,
    perPage: number,
    sort?: string,
    order?: string,
    options: ConditionalRequestOptions = {},
  ): Promise<ConditionalRequestResult<{ items: GitHubIssueResponse[] }>> {
    // A 304 holds no page, and is not read.
    return await this.#conditionalGet<{ items: GitHubIssueResponse[] }>(
      "/search/issues", issueSearch(query, page, perPage, sort, order), options, undefined,
      body => ({ ...body, items: listedRows(body.items, "issues") }));
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
    const result = await this.listPullRequestsConditional(owner, repo, options, UNCONDITIONAL);
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
    return await this.#conditionalGet<GitHubPullRequestResponse[], GitHubPullRequestResponse[]>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`,
      query,
      options,
      undefined,
      rows => listedRows(rows, "pull requests"),
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
        read: rows => listedRows(rows, "comments"),
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
    const result = await this.listPullRequestReviewsConditional(owner, repo, pullNumber, page, perPage, UNCONDITIONAL);
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
    return await this.#conditionalGet<GitHubPullRequestReviewResponse[], GitHubPullRequestReviewResponse[]>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}/reviews`,
      {
        page,
        per_page: perPage,
      },
      options,
      undefined,
      rows => listedRows(rows, "reviews"),
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
        read: rows => listedRows(rows, "review comments"),
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
    const result = await this.getPullRequestReviewCommentConditional(owner, repo, commentId, UNCONDITIONAL);
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
    const result = await this.listPullRequestFilesConditional(owner, repo, pullNumber, page, perPage, UNCONDITIONAL);
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
    return await this.#conditionalGet<GitHubPullFileResponse[], GitHubPullFileResponse[]>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}/files`,
      {
        page,
        per_page: perPage,
      },
      options,
      undefined,
      rows => listedRows(rows, "files"),
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
    const result = await this.compareBranchesConditional(owner, repo, base, head, UNCONDITIONAL, paging);
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
    return await this.#conditionalGet<GitHubBranchResponse[], GitHubBranchResponse[]>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches`,
      query,
      options,
      undefined,
      rows => listedRows(rows, "branches"),
    );
  }

  /**
   * Look up a single branch's current head commit sha, or null if the branch does not exist.
   * Always an unconditional, uncached read: callers use this to bind a push's expected old head,
   * which must reflect the remote's live state. Read as the exact git ref, because
   * `/branches/<name>` redirects a renamed branch's old name to the new one (as `master` does in
   * many repositories), and git has no such alias. The name is validated first: it is encoded
   * segment by segment, so a `..` segment would otherwise climb out of the repository.
   */
  async getBranchHead(owner: string, repo: string, branch: string): Promise<string | null> {
    try {
      const result = await this.#request<string, { object: { sha: string } }>(
        "GET",
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/heads/${
          validateBranchName(branch).split("/").map(encodeURIComponent).join("/")}`,
        { read: body => body.object.sha },
      );
      return result.data;
    } catch (error) {
      // 409 is GitHub's answer for an empty repository, which has no branches at all.
      if (error instanceof GitHubApiError && (error.status === 404 || error.status === 409)) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Whether GitHub reports a branch as protected; false for a branch that does not exist. An
   * unconditional, uncached read, since it decides whether a push may apply without a person. A
   * renamed branch's old name redirects to the new branch, which is not followed, so it counts
   * as protected: the branch it names may be.
   */
  async isBranchProtected(owner: string, repo: string, branch: string): Promise<boolean> {
    try {
      const result = await this.#request<boolean, GitHubBranchResponse>(
        "GET",
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches/${
          validateBranchName(branch).split("/").map(encodeURIComponent).join("/")}`,
        { read: body => body.protected === true },
      );
      return result.data;
    } catch (error) {
      if (!(error instanceof GitHubApiError)) throw error;
      if (isRedirect(error.status)) return true;
      // 409 is GitHub's answer for an empty repository, which has no branches at all.
      if (error.status === 404 || error.status === 409) return false;
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
    return await this.#conditionalGet<GitHubTagResponse[], GitHubTagResponse[]>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tags`,
      query,
      options,
      undefined,
      rows => listedRows(rows, "tags"),
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
    try {
      return (await this.#request<Uint8Array | "oversized", GitHubGitBlobResponse>(
        "GET",
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs/${encodeURIComponent(sha)}`,
        {
          read: response => {
            if (response.size > maxBytes || response.encoding !== "base64") {
              return "oversized";
            }
            return Uint8Array.from(atob(response.content.replace(/\s+/g, "")), char => char.charCodeAt(0));
          },
        },
      )).data;
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) {
        return null;
      }
      throw error;
    }
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
    return await this.#conditionalGet<GitHubCommitResponse[], GitHubCommitResponse[]>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits`,
      query,
      options,
      undefined,
      rows => listedRows(rows, "commits"),
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
    return await this.#conditionalGet<GitHubCommitResponse[], GitHubCommitResponse[]>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}/commits`,
      {
        page,
        per_page: perPage,
      },
      options,
      undefined,
      rows => listedRows(rows, "commits"),
    );
  }

  /**
   * A GraphQL query, counted under `operation`. Throws when GitHub answers with errors and no data;
   * with partial data, the fields that failed are null and `errors` says why.
   */
  async graphql<T>(
    operation: GitHubGraphqlOperation, query: string, variables: Record<string, unknown>,
  ): Promise<GitHubGraphqlResult<T>> {
    return await this.#graphql<T>(operation, query, variables);
  }

  // Sends a GraphQL query. `refusal` gives the error that an answer's data is thrown as, where
  // the data is not what the query was sent for. Every answer that is thrown here is counted an
  // error, by the checks it is thrown on (see `graphqlAnswer`).
  async #graphql<T>(
    operation: GitHubGraphqlOperation, query: string, variables: Record<string, unknown>,
    refusal?: (data: T) => GitHubApiError | undefined,
  ): Promise<GitHubGraphqlResult<T>> {
    const { data } = await this.#request<GraphqlBody<T>>("POST", "/graphql", {
      body: { query, variables }, operation, counted: body => graphqlAnswer(body, refusal),
    });
    const errors = data.errors ?? [];
    if (withoutData(data.data)) {
      const type = errors[0]?.type;
      throw new GitHubApiError(type === "NOT_FOUND" ? 404 : type === "FORBIDDEN" ? 403 : 502,
        `GitHub GraphQL query failed: ${errors.map(error => error.message).join("; ") || "no data"}`, errors);
    }
    const refused = refusal?.(data.data);
    if (refused) throw refused;
    return { data: data.data, errors };
  }

  /**
   * A GraphQL query that reads `repository(owner: $owner, name: $name, followRenames:
   * $followRenames) { databaseId ... }`, with those variables supplied here, counted under
   * `operation`. A renamed or transferred repository is followed only while it is still the pinned
   * one, by id, as REST redirects are; without a pin, renames are not followed.
   */
  async queryRepository<T extends { repository: { databaseId: number | null } | null }>(
    operation: GitHubGraphqlOperation, owner: string, repo: string, query: string,
    variables: Record<string, unknown>,
  ): Promise<GitHubGraphqlResult<T>> {
    const pin = this.#repo;
    // Whether the repository GitHub answered about is another than the pinned one. The answer
    // is read for it within the request, which so counts one that names no repository an error.
    let moved = false;
    const result = await this.#graphql<T>(operation, query, {
      ...variables, owner, name: repo, followRenames: pin !== undefined,
    }, data => {
      const found = data.repository;
      if (found === null) return new GitHubApiError(404, `Repository ${owner}/${repo} was not found.`);
      moved = pin !== undefined && found.databaseId !== pin.id;
      return undefined;
    });
    // The pin is the binding's rule about an answer that holds the repository at that name: the
    // request is counted by its status.
    if (moved) {
      throw new GitHubApiError(404, `GitHub moved ${owner}/${repo} out of the bound repository; it was not followed.`);
    }
    return result;
  }

  async getCheckRun(owner: string, repo: string, checkRunId: number): Promise<GitHubCheckRunResponse> {
    return (await this.#request<GitHubCheckRunResponse>(
      "GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/check-runs/${checkRunId}`)).data;
  }

  async listCheckRunAnnotations(
    owner: string, repo: string, checkRunId: number, page: number, perPage: number,
  ): Promise<GitHubCheckAnnotationResponse[]> {
    return (await this.#request<GitHubCheckAnnotationResponse[]>(
      "GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/check-runs/${checkRunId}/annotations`,
      { query: { page, per_page: perPage }, read: rows => listedRows(rows, "annotations") })).data;
  }

  async getWorkflowJob(owner: string, repo: string, jobId: number): Promise<GitHubWorkflowJobResponse> {
    return (await this.#request<GitHubWorkflowJobResponse>(
      "GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/jobs/${jobId}`)).data;
  }

  /**
   * Where a job's log can be downloaded from for the next minute: GitHub answers with a redirect
   * to its blob storage, which is not followed here. Null once the log is gone (404 or 410).
   */
  async getWorkflowJobLogLocation(owner: string, repo: string, jobId: number): Promise<string | null> {
    const result = await this.#request<unknown>(
      "GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/jobs/${jobId}/logs`,
      {
        externalRedirect: true,
        okStatuses: [404, 410],
        // An answer that neither hands the log off nor says that it is gone is no answer to this
        // request, whatever its status. A redirect is counted before this is asked.
        counted: (_data, { status }) => gone(status) ? undefined : { outcome: "error", reason: "api" },
      });
    if (gone(result.status)) return null;
    const location = handOff(result.status, result.headers);
    if (location === null) {
      throw new GitHubApiError(result.status, `GitHub did not hand off the log of job ${jobId} for download.`);
    }
    return location;
  }

  /**
   * Downloads a log from the location `getWorkflowJobLogLocation()` returned, and returns what
   * `read` reads of it. The location is signed and off GitHub's API host, so the request carries
   * no `Authorization`: the token must never reach blob storage. A redirect from there is not
   * followed, and fails the download.
   *
   * The log is read within the request, as it arrives, so that the request is counted by whether
   * its log arrived and not by the status that came ahead of it: what `read` throws is thrown
   * here, with the request counted an error, a timeout where that is what `read` threw. The
   * download is sent once, whatever it is answered and whether it is answered at all: GitHub
   * signs the location for a minute, so a later send may be for a location whose signature has
   * run out, and its refusal would be thrown in place of the failure that was met.
   * @param location The signed location of the log.
   * @param read Reads the log from the stream of an answer, which it releases or cancels itself.
   * It is asked once at most, and reads the log from its start.
   * @returns What `read` returned of the log.
   */
  async downloadJobLog<T>(location: string, read: (log: ReadableStream<Uint8Array>) => Promise<T>): Promise<T> {
    const downloaded = await githubUpstream.read<Downloaded<T>>(location, {
      operation: "logs.download" satisfies GitHubOperation,
      headers: { "User-Agent": USER_AGENT },
      timeoutMs: LOG_DOWNLOAD_TIMEOUT_MS,
      // The location's signature runs out within a minute: it is asked once.
      retry: null,
    }, async response => {
      // The answer is checked within the request, so that one with no log to read is no success.
      const { body } = response;
      if (!response.ok || body === null) {
        await body?.cancel();
        throw new GitHubApiError(response.status, `Downloading the log failed: ${response.status} ${response.statusText}`);
      }
      try {
        return { log: await read(body) };
      } catch (thrown) {
        // Handed on and not thrown, so that the count says how the reading failed. What is left
        // of a body that no reader holds is let go, as the client lets go of one whose reading
        // threw.
        void body.cancel().catch(() => undefined);
        return { unread: { thrown } };
      }
    },
    // A log that did not arrive is no success: cut off by the timeout where its reading failed
    // as a timeout fails one, and not read otherwise, which is how the client counts each.
    ({ unread }) => unread && { outcome: "error", reason: isTimeout(unread.thrown) ? "timeout" : "parse" });
    if (downloaded.unread) throw downloaded.unread.thrown;
    return downloaded.log;
  }

  async listWorkflowRuns(owner: string, repo: string, query: {
    branch?: string; head_sha?: string; event?: string; status?: string; page: number; per_page: number;
  }): Promise<GitHubWorkflowRunResponse[]> {
    return (await this.#request<GitHubWorkflowRunResponse[], { workflow_runs?: GitHubWorkflowRunResponse[] }>(
      "GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs`, {
        query: { ...query, exclude_pull_requests: true },
        read: body => listedRows(body.workflow_runs, "workflow runs"),
      })).data;
  }

  async getWorkflowRun(owner: string, repo: string, runId: number): Promise<GitHubWorkflowRunResponse> {
    return (await this.#request<GitHubWorkflowRunResponse>(
      "GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${runId}`,
      { query: { exclude_pull_requests: true } })).data;
  }

  /** A run's jobs: those of `attempt`, or of its latest attempt. */
  async listWorkflowRunJobs(
    owner: string, repo: string, runId: number, attempt: number | undefined, page: number, perPage: number,
  ): Promise<GitHubWorkflowJobResponse[]> {
    const run = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${runId}`;
    return (await this.#request<GitHubWorkflowJobResponse[], { jobs?: GitHubWorkflowJobResponse[] }>(
      "GET", attempt === undefined ? `${run}/jobs` : `${run}/attempts/${attempt}/jobs`, {
        query: { page, per_page: perPage, filter: attempt === undefined ? "latest" : undefined },
        read: body => listedRows(body.jobs, "a workflow run's jobs"),
      })).data;
  }

  /**
   * The latest updates to `branch`, newest first: pushes, force pushes, its creation, merges into
   * it. Unfiltered by kind, since any of them can make a commit its head.
   */
  async listBranchActivity(owner: string, repo: string, branch: string): Promise<GitHubActivityResponse[]> {
    return (await this.#request<GitHubActivityResponse[]>(
      "GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/activity`,
      {
        query: { ref: `refs/heads/${branch}`, direction: "desc", per_page: 30 },
        read: rows => listedRows(rows, "branch activity"),
      })).data;
  }

  /** The rules every ruleset applies to `branch`. */
  async getBranchRules(owner: string, repo: string, branch: string): Promise<GitHubBranchRuleResponse[]> {
    return (await this.#request<GitHubBranchRuleResponse[]>(
      "GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/rules/branches/${
        validateBranchName(branch).split("/").map(encodeURIComponent).join("/")}`,
      { query: { per_page: 100 }, read: rows => listedRows(rows, "branch rules") })).data;
  }

  /**
   * The required status checks of `branch`'s classic protection, or undefined when it has none or
   * GitHub does not show them to this account.
   */
  async getBranchProtectionChecks(
    owner: string, repo: string, branch: string,
  ): Promise<GitHubBranchProtectionChecksResponse | undefined> {
    return (await this.#request<
      GitHubBranchProtectionChecksResponse | undefined,
      { protection?: { required_status_checks?: GitHubBranchProtectionChecksResponse } }
    >(
      "GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches/${
        validateBranchName(branch).split("/").map(encodeURIComponent).join("/")}`,
      { read: body => body.protection?.required_status_checks },
    )).data;
  }

  /**
   * POST a git smart-HTTP protocol v2 `upload-pack` request (the git fetch endpoint, on
   * github.com rather than api.github.com) and return the raw `Response`, whose body the caller
   * streams -- see `@gadgets/gatekeeper-kit/git-transport`. Auth is Basic with the `x-access-token` username GitHub
   * specifies for token-authenticated git operations. Throws `GitHubApiError` on a non-OK
   * status (401 marks it an auth error, like every other method here), so callers get the same
   * credential-expiry handling as REST calls.
   *
   * A success that holds no pack (one of another content type, which is a page answered in place
   * of the result, or one with no body) is thrown as a `GitHubApiError` of status 502, its body
   * cancelled unread, and the request is counted as that error. What holds a pack is told by the
   * answer's headers and by whether it has a body, so the pack is handed on as it came: unread.
   */
  async fetchGitUploadPack(owner: string, repo: string, requestBody: Uint8Array): Promise<Response> {
    const url = `${LOGIN_BASE_URL}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}.git/git-upload-pack`;
    const response = await githubUpstream.read(url, {
      operation: "git.upload-pack" satisfies GitHubOperation,
      method: "POST",
      headers: {
        "Content-Type": "application/x-git-upload-pack-request",
        Accept: UPLOAD_PACK_RESULT,
        "Git-Protocol": "version=2",
        "User-Agent": USER_AGENT,
        Authorization: `Basic ${encodeBasicAuth("x-access-token", await this.#getToken())}`,
      },
      body: requestBody,
      // GitHub serves a renamed repo over smart-HTTP without redirecting, so any redirect is
      // refused (as a non-OK status) rather than followed somewhere unbound.
      redirect: "manual",
      // Longer than a request's 30 seconds: the timeout also covers streaming the response body,
      // which may be a pack of tens of megabytes.
      timeoutMs: GIT_UPLOAD_PACK_TIMEOUT_MS,
    },
    // The pack is the transport's to stream: the answer is handed on with its body unread.
    answered => answered,
    // A success that holds no pack is thrown below, and is counted as the error it is thrown as.
    answered => answered.ok && !holdsPack(answered) ? { outcome: "error", reason: "parse" } : undefined);
    if (!response.ok) {
      // The error body is short prose (e.g. "Repository not found"); a truncated copy makes the
      // failure actionable without trusting its size.
      const detail = (await response.text().catch(() => "")).trim().slice(0, 200);
      throw new GitHubApiError(
        response.status,
        `git fetch failed: ${response.status} ${response.statusText}${detail ? `: ${detail}` : ""}`,
      );
    }
    if (!holdsPack(response)) {
      await response.body?.cancel().catch(() => {});
      throw isGitResult(response.headers, UPLOAD_PACK_RESULT)
        ? new GitHubApiError(502, "git fetch failed: response had no body")
        : notGitResult("fetch", UPLOAD_PACK_RESULT, response.headers);
    }
    return response;
  }

  /**
   * POST a git smart-HTTP `receive-pack` request (the git push endpoint; classic protocol -- there
   * is no v2 for receive-pack) that updates `branch`, and return its answer, whose report-status
   * body the caller parses -- see `@gadgets/gatekeeper-kit/git-transport`. The request body streams (the pack may be
   * large), so it is sent chunked. Auth and error handling mirror `fetchGitUploadPack`.
   *
   * Git answers a ref update it refused with a 200 and says so in that report, so the request is
   * counted by what the report says of `branch` (see `pushAnswer`). The report is read for that
   * within the request, so that one whose transfer is cut off is no success either, and what is
   * returned is an answer of the status GitHub gave over the report that was read.
   *
   * A success of another content type holds no report: it is a page answered in place of the
   * result. It is thrown as a `GitHubApiError` of status 502, its body cancelled unread, and the
   * request is counted as that error.
   */
  async fetchGitReceivePack(
    owner: string, repo: string, branch: string, requestBody: ReadableStream<Uint8Array>,
  ): Promise<Response> {
    const url = `${LOGIN_BASE_URL}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}.git/git-receive-pack`;
    const { response, report: reported } = await githubUpstream.read<Pushed>(url, {
      operation: "git.receive-pack" satisfies GitHubOperation,
      method: "POST",
      headers: {
        "Content-Type": "application/x-git-receive-pack-request",
        Accept: RECEIVE_PACK_RESULT,
        "User-Agent": USER_AGENT,
        Authorization: `Basic ${encodeBasicAuth("x-access-token", await this.#getToken())}`,
      },
      body: requestBody,
      redirect: "manual",
      // Same generous budget as fetch: the timeout also covers streaming the pack up.
      timeoutMs: GIT_UPLOAD_PACK_TIMEOUT_MS,
      // A push is never sent twice.
      retry: null,
    }, async answered => {
      // Only a git result holds a report: any other answer is thrown below, its body unread.
      if (!answered.ok || !isGitResult(answered.headers, RECEIVE_PACK_RESULT)) return { response: answered };
      const report = await readPushReport(answered);
      // The transport is handed the report to parse, and no body where GitHub sent none, which
      // it refuses in its own words.
      const body = answered.body === null ? null : report;
      return { response: new Response(body, { status: answered.status }), report };
    }, ({ response: answered, report }) => {
      if (report) return pushAnswer(report, `refs/heads/${branch}`);
      // A success with no report read of it is no git result, and is counted as the error it is
      // thrown as below.
      return answered.ok ? { outcome: "error", reason: "parse" } : undefined;
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).trim().slice(0, 200);
      throw new GitHubApiError(
        response.status,
        `git push failed: ${response.status} ${response.statusText}${detail ? `: ${detail}` : ""}`,
      );
    }
    if (reported === undefined) {
      await response.body?.cancel().catch(() => {});
      throw notGitResult("push", RECEIVE_PACK_RESULT, response.headers);
    }
    return response;
  }
}

/** Whether `error` is `withAccountApi`'s report of a confirmed expiry: the owner has to reconnect. */
export function isConnectionExpired(error: unknown): boolean {
  return isCredentialsExpired((error as { cause?: unknown } | undefined)?.cause);
}

export const CREDENTIALS_EXPIRED_MESSAGE =
  "GitHub credentials have expired or been revoked. Please reconnect the account.";

/**
 * Runs `fn` against GitHub as `account`, a stub to it or the account itself, addressing `repo` by
 * its id (see GitHubApi). GitHub's rejection of the token a request presented is the account's to
 * adjudicate, so a token replaced while the request was in flight fails as retryable rather than
 * marking the account expired. With `replayable`, which only calls safe to run twice may pass, such
 * a failure instead reruns `fn` once with the replacement token.
 */
export async function withAccountApi<T>(
  account: Pick<UserAccount, "getAccessToken" | "reportTokenRejected">,
  fn: (api: GitHubApi) => Promise<T>,
  options: { replayable?: true; repo?: PinnedRepo } = {},
): Promise<T> {
  for (let replays = options.replayable ? 1 : 0; ; replays--) {
    let presented: string | undefined;
    const api = new GitHubApi(async () => (presented = await account.getAccessToken()),
      { repo: options.repo });
    try {
      return await fn(api);
    } catch (error) {
      if (isCredentialsExpired(error)) {
        throw new Error(CREDENTIALS_EXPIRED_MESSAGE, { cause: error });
      }
      if (!(error instanceof GitHubApiError && error.isAuthError) || presented === undefined) {
        throw error;
      }
      const verdict = await account.reportTokenRejected(presented);
      if (verdict === "expired") {
        // Shaped like the known expiry above: the marked error as its cause is how callers tell an
        // expiry from a token renewed mid-request.
        // oxlint-disable-next-line eslint/preserve-caught-error -- kept as the marked error's cause.
        throw new Error(CREDENTIALS_EXPIRED_MESSAGE,
          { cause: new CredentialsExpiredError(CREDENTIALS_EXPIRED_MESSAGE, { cause: error }) });
      }
      if (verdict !== "superseded") throw error;
      if (replays > 0) continue;
      throw new Error("GitHub credentials were renewed during this request. Please retry it.",
        { cause: error });
    }
  }
}
