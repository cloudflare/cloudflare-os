// GitLab code search (`scope=blobs`) as one request per page against one engine, with GitLab's
// failures turned into fixed, agent-safe errors. Routing between engines, caching and observer
// reporting belong to the callers; see plans/gitlab-code-search.md.
//
// GitLab has three engines, chosen with `search_type` (left out, it picks Zoekt, then advanced,
// then basic) and named back in the `X-Search-Type` response header, which is the only word on
// which one actually ran: a project search on a ref other than the default branch always runs
// basic, whatever was asked. Measured on GitLab 18.11:
//
// - `zoekt` (exact code search): regex mode unless `regex=false`, which matches the text verbatim;
//   in regex mode a malformed pattern fails with a message naming internal hosts. `lang:` filters.
// - `advanced` (Elasticsearch simple_query_string): word matching, needing its special characters
//   backslash-escaped; it silently matches nothing for `file:` / `lang:`.
// - `basic`: verbatim, case-insensitive.
//
// `path:`, `filename:` and `extension:` filter on all three. Error bodies are never passed on or
// logged: Zoekt's can name internal hosts, and known 400s are matched exactly against the 18.11
// source (`ee/app/services/ee/search_service.rb`, `lib/api/search.rb`).

import { GitLabApiError, type GitLabApi, type GitLabBlobSearchRow } from "./gitlab-api";
import { VENDOR_ID } from "./gitlab-env";
import { obsContext } from "./observability";
import type { GitLabCodeLanguage } from "./types";

const logger = obsContext.createLogger({ component: "gatekeeper.gitlab", vendorId: VENDOR_ID });

/** A GitLab code search engine, as `search_type` and `X-Search-Type` spell it. */
export type CodeSearchEngine = "zoekt" | "advanced" | "basic";

/** Where a search looks: the whole instance, one group (by id) and its subgroups, or one project. */
export type CodeSearchScope =
  | { kind: "instance" }
  | { kind: "group"; groupId: number }
  | { kind: "project"; projectId: number };

/**
 * What a search looks for: `text`, as a regular expression with `regex` (Zoekt only), narrowed to
 * files beneath `path`, named like `filename` (`*` wildcards), with `extension` (a leading dot is
 * dropped), or in `language` (Zoekt only, sent verbatim as `lang:`; Zoekt matches nothing for a
 * name it does not know, so only the names `GitLabCodeLanguage` lists reach here). An empty filter
 * is no filter.
 */
export type CodeSearchFilters = {
  text: string;
  regex?: boolean;
  path?: string;
  filename?: string;
  extension?: string;
  language?: GitLabCodeLanguage;
};

/** One match: the file, the ref it was found at, and the snippet starting at `startLine`. */
export type RawCodeHit = { projectId: number; path: string; ref: string; startLine: number; data: string };

/** One page of matches, the engine that ran (from `X-Search-Type`), and the next page (null at the end). */
export type CodeSearchPage = { hits: RawCodeHit[]; engine: CodeSearchEngine; nextPage: number | null };

/**
 * Why a search failed:
 * - `zoektUnavailable`: Zoekt can't search this scope (a caller may fall back at project scope).
 * - `noEngine`: neither Zoekt nor advanced search can search it.
 * - `disabled`: the instance turned code search off for this scope.
 * - `tooBroad`: the group has too many projects for Zoekt right now.
 * - `rejected`: GitLab, or this module, refused the query itself.
 * - `rateLimited`: GitLab is throttling the account; see `retryAfterSeconds`.
 * - `unavailable`: GitLab failed or could not be reached; retryable.
 * - `refused`: GitLab refused the account (401, 403 or 404); see `status`.
 * - `needsExactSearch`: the query needs Zoekt (a regex or `language`) and another engine would run.
 * - `internal`: a request GitLab should never have been sent, or an answer this can't read.
 */
export type CodeSearchErrorCategory =
  | "zoektUnavailable" | "noEngine" | "disabled" | "tooBroad" | "rejected" | "rateLimited"
  | "unavailable" | "refused" | "needsExactSearch" | "internal";

/** Each category's fixed text, safe to show an agent: no provider text, no resource names. */
export const CODE_SEARCH_ERROR_MESSAGES: Record<CodeSearchErrorCategory, string> = {
  zoektUnavailable: "Exact code search is not available for this scope on this GitLab instance.",
  noEngine: "Code search is not available for this scope on this GitLab instance.",
  disabled: "Code search is turned off for this scope on this GitLab instance.",
  tooBroad: "This group has too many projects to search on this GitLab instance right now. " +
    "Search a subgroup with `groupPath`, or search the whole instance without it.",
  rejected: "GitLab rejected the search query. Check the search text and filters.",
  rateLimited: "GitLab is rate-limiting code searches. Try again later.",
  unavailable: "GitLab code search is unavailable right now. Try again shortly.",
  refused: "GitLab refused the code search.",
  needsExactSearch: "Regular expressions and `language` need GitLab's exact code search, which cannot " +
    "run for this search (for example on a branch other than the default one).",
  internal: "Code search failed because of a problem in the GitLab gatekeeper.",
};

/** A failed code search, with a fixed message (see CODE_SEARCH_ERROR_MESSAGES) and its category. */
export class GitLabCodeSearchError extends Error {
  readonly category: CodeSearchErrorCategory;
  /** GitLab's HTTP status, when GitLab answered. */
  readonly status?: number;
  /** For `rateLimited`: how long GitLab asked the caller to wait, when it said. */
  readonly retryAfterSeconds?: number;

  constructor(category: CodeSearchErrorCategory,
              options: { status?: number; retryAfterSeconds?: number; message?: string; cause?: unknown } = {}) {
    let message = options.message ?? CODE_SEARCH_ERROR_MESSAGES[category];
    if (options.message === undefined && category === "refused" && options.status !== undefined) {
      message = `GitLab refused the code search (HTTP ${options.status}).`;
    }
    if (options.message === undefined && category === "rateLimited" && options.retryAfterSeconds !== undefined) {
      message = `GitLab is rate-limiting code searches. Try again in ${options.retryAfterSeconds} seconds.`;
    }
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "GitLabCodeSearchError";
    this.category = category;
    this.status = options.status;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

/** The characters simple_query_string gives meaning to, each escaped with a backslash. */
const ADVANCED_SPECIAL_CHARACTERS = /[\\"~|+\-*()[\]{}.^$?/=,<>&:!#]/g;

/**
 * The `search` parameter for `filters` on `engine`: the text (backslash-escaped for advanced
 * search, verbatim otherwise), then `path:`, `filename:`, `extension:` and, on Zoekt, `lang:`.
 * @throws GitLabCodeSearchError (`rejected`) for empty text, or a filter value with whitespace,
 * which would split it into search terms.
 */
export function encodeSearchText(filters: CodeSearchFilters, engine: CodeSearchEngine): string {
  if (filters.text.trim() === "") {
    throw new GitLabCodeSearchError("rejected", { message: "The search text must not be empty." });
  }
  const parts = [engine === "advanced" ? filters.text.replace(ADVANCED_SPECIAL_CHARACTERS, "\\$&") : filters.text];
  const filter = (name: string, value: string | undefined) => {
    if (value === undefined || value === "") return;
    if (/\s/.test(value)) {
      throw new GitLabCodeSearchError("rejected",
        { message: "Search filters (path, filename, extension, language) must not contain spaces." });
    }
    parts.push(`${name}:${value}`);
  };
  filter("path", filters.path);
  filter("filename", filters.filename);
  filter("extension", filters.extension?.replace(/^\./, ""));
  if (engine === "zoekt") filter("lang", filters.language);
  return parts.join(" ");
}

/** Where `scope`'s searches are sent. */
function scopePath(scope: CodeSearchScope): string {
  switch (scope.kind) {
    case "instance": return "/search";
    case "group": return `/groups/${scope.groupId}/search`;
    case "project": return `/projects/${scope.projectId}/search`;
  }
}

/**
 * One page of matches for `filters` in `scope`, run by `engine` (`search_type`): on Zoekt, `regex`
 * is always sent, true or false; on the others never. `ref` applies at project scope (the default
 * branch when unset) and `includeArchived` at instance and group scope. Rows are deduplicated on
 * project, path and line.
 * @throws GitLabCodeSearchError: `needsExactSearch`, before anything is sent, for a regex or
 * `language` on another engine, and when another engine than Zoekt ran such a query;
 * `zoektUnavailable` when another engine than Zoekt ran an instance or group search; `internal`
 * for any other mismatch, or a missing `X-Search-Type`; GitLab's failures as their category (see
 * CodeSearchErrorCategory). A credential refusal (`GitLabApiError.isAuthError`) and anything that
 * is not a `GitLabApiError` are rethrown unchanged.
 */
export async function searchCodePage(
  api: GitLabApi, scope: CodeSearchScope, engine: CodeSearchEngine, filters: CodeSearchFilters,
  options: { ref?: string; includeArchived?: boolean; page: number; perPage: number },
): Promise<CodeSearchPage> {
  const needsExact = filters.regex === true || filters.language !== undefined;
  if (needsExact && engine !== "zoekt") throw new GitLabCodeSearchError("needsExactSearch");
  const query = {
    search: encodeSearchText(filters, engine),
    search_type: engine,
    regex: engine === "zoekt" ? filters.regex === true : undefined,
    ref: scope.kind === "project" ? options.ref || undefined : undefined,
    include_archived: scope.kind !== "project" && options.includeArchived ? true : undefined,
  };
  const page = await api.searchBlobs(scopePath(scope), query, options.page, options.perPage).catch((error: unknown) => {
    throw codeSearchFailure(error, engine);
  });

  const ran = page.searchType?.trim().toLowerCase();
  if (ran !== engine) {
    logger.warn("GitLab ran a code search on another engine than the one asked for", {
      event: "code.search.engine.mismatch", searchEngine: (ran ?? "none").slice(0, 32),
    });
    if (needsExact) throw new GitLabCodeSearchError("needsExactSearch");
    if (engine === "zoekt" && scope.kind !== "project") throw new GitLabCodeSearchError("zoektUnavailable");
    throw new GitLabCodeSearchError("internal");
  }

  const seen = new Set<string>();
  const hits: RawCodeHit[] = [];
  for (const row of page.items) {
    const hit = codeHit(row);
    if (hit === undefined) throw new GitLabCodeSearchError("internal");
    const key = JSON.stringify([hit.projectId, hit.path, hit.startLine]);
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push(hit);
  }
  return { hits, engine, nextPage: page.nextPage };
}

/** A search row as a hit, or undefined for one missing what a hit needs. */
function codeHit(row: GitLabBlobSearchRow): RawCodeHit | undefined {
  if (!Number.isSafeInteger(row?.project_id) || typeof row.path !== "string" || row.path === ""
      || typeof row.data !== "string" || typeof row.ref !== "string") {
    return undefined;
  }
  return {
    projectId: row.project_id,
    path: row.path,
    ref: row.ref,
    startLine: Number.isSafeInteger(row.startline) ? row.startline : 1,
    data: row.data,
  };
}

/**
 * The numeric id of the group at `groupPath`, or null when the account can't see one there.
 * @throws GitLabCodeSearchError for GitLab's failures, as searchCodePage classifies them.
 */
export async function resolveGroupId(api: GitLabApi, groupPath: string): Promise<number | null> {
  try {
    return await api.getGroupId(groupPath);
  } catch (error) {
    throw codeSearchFailure(error);
  }
}

/** GitLab's prefixes on `bad_request!` / `forbidden!` messages, dropped before matching. */
const STATUS_PREFIX = /^(?:400 Bad request|403 Forbidden) - /;

/** The 403 an instance answers when code search is turned off for the scope. */
const GLOBAL_SEARCH_DISABLED = "Global Search is disabled for this scope";

/** The start of Zoekt's group project-limit message; its rest varies with the limit. */
const GROUP_LIMIT_PREFIX = "Your search includes too many projects while traversal ID indexing is still in progress.";

/**
 * The known 400 messages and what each means. Several search-type errors arrive joined with ", ".
 * The two `internal` ones are requests this module never sends.
 */
const KNOWN_400S: Record<string, "zoektUnavailable" | "noEngine" | "internal"> = {
  "Zoekt is not available": "zoektUnavailable",
  "Elasticsearch is not available": "noEngine",
  "Elasticsearch is disabled for blobs": "noEngine",
  "Scope supported only with advanced search or exact code search": "noEngine",
  "Zoekt can only be used for blobs": "internal",
  "regex supported only with exact code search": "internal",
};

/** When several known 400s arrive together, the one reported: a request bug before an engine gap. */
const KNOWN_400_PRIORITY = ["internal", "zoektUnavailable", "noEngine"] as const;

/**
 * `error`, a failed search request, as a GitLabCodeSearchError of its category (see
 * CodeSearchErrorCategory), by status first and, for a 400 or 403, GitLab's exact message.
 * Credential refusals, redirects (whose messages are this client's own) and anything not a
 * GitLabApiError are returned unchanged. Logs the status, never the body.
 */
function codeSearchFailure(error: unknown, engine?: CodeSearchEngine): unknown {
  if (!(error instanceof GitLabApiError) || error.isAuthError || (error.status >= 300 && error.status < 400)) {
    return error;
  }
  const { status } = error;
  const category = categoryOf(error);
  const searchEngine = engine ? { searchEngine: engine } : {};
  if (category === "internal") {
    logger.error("GitLab refused a code search request the gatekeeper should never have sent", {
      event: "code.search.request.invalid", status, ...searchEngine,
    });
  } else {
    logger.warn("GitLab failed a code search request", { event: "code.search.failed", status, ...searchEngine });
  }
  return new GitLabCodeSearchError(category, {
    status, retryAfterSeconds: category === "rateLimited" ? error.retryAfterSeconds : undefined,
  });
}

/** The category of a failed search request; see codeSearchFailure. */
function categoryOf(error: GitLabApiError): CodeSearchErrorCategory {
  const { status } = error;
  if (status === 429) return "rateLimited";
  if (status >= 500) return "unavailable";
  const message = error.message.replace(STATUS_PREFIX, "");
  if (status === 403 && message === GLOBAL_SEARCH_DISABLED) return "disabled";
  if (status === 401 || status === 403 || status === 404) return "refused";
  if (status !== 400) return "rejected";
  if (message.startsWith(GROUP_LIMIT_PREFIX) || message.includes(`, ${GROUP_LIMIT_PREFIX}`)) return "tooBroad";
  const parts = message.split(", ").map(part => Object.hasOwn(KNOWN_400S, part) ? KNOWN_400S[part] : undefined);
  if (parts.some(part => part === undefined)) return "rejected";
  return KNOWN_400_PRIORITY.find(category => parts.includes(category)) ?? "rejected";
}
