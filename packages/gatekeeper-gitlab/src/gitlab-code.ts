// Code search and file reads, shared by the instance binding (gitlab-instance.ts) and project
// bindings (gitlab-sessions.ts): which search engine runs where, what every page and file read
// reports to the Workshop, the narrowing of a search page a collaborator may not see, and the
// facet-storage caches behind them. No platform imports, so the package's Node vitest project runs
// all of it against fakes; the RPC cursors that serve these pagers live in gitlab-code-sessions.ts.
// See plans/gitlab-code-search.md, the design record.
//
// Engines (see gitlab-code-search-api.ts for what each matches): an instance or group search runs
// Zoekt only, since advanced search spreads a page over many more projects, each one more observer
// check. A project search on its default branch runs Zoekt, then advanced search where Zoekt is not
// available (unless the query needs Zoekt), then basic; on any other ref GitLab runs basic whatever
// is asked, so basic is asked. The engine of a search's first page serves all of it.
//
// Observations: an instance search page reports `instance/<host>` (it can reveal that a term is
// absent, or present in projects not on the page) and `repository/<id>` for each project on it; a
// project search page and every repository read report `repository/<id>`, but metadata of a project
// whose repository is disabled reports `project/<id>` (see readRepositoryMetadata); opening a
// repository reports `instance/<host>`, found or not. When the Workshop refuses a page because a
// collaborator was definitely denied, the page is offered once more with only the hits from
// projects every signed-in user of the instance can read (see #authorized); any other refusal, or
// one of that page, propagates.

import type { ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";
import type { KvScannable } from "@gadgets/gatekeeper-kit/kv";
import { isObserverAccessDenied } from "@gadgets/gatekeeper-kit/observers";
import { SerialTaskQueue } from "@gadgets/gatekeeper-kit/serial-queue";
import { GitLabApiError, type GitLabProjectResponse } from "./gitlab-api";
import {
  GitLabCodeSearchError, projectFactsFailure, resolveGroupId, searchCodePage,
  type CodeSearchEngine, type CodeSearchFilters, type CodeSearchPage, type CodeSearchScope, type RawCodeHit,
} from "./gitlab-code-search-api";
import type { GitLabApiRunner } from "./gitlab-env";
import { fetchProjectFacts, fetchRepositoryOpenToAllUsers, type GitLabProjectFacts } from "./gitlab-graphql";
import { blobUrl, normalizeProjectMetadata } from "./gitlab-normalize";
import { instanceSubresourceId, metadataSubresourceId, repositorySubresourceId } from "./project-subresources";
import type {
  GitLabCodeHit, GitLabCodeSearchQuery, GitLabFileContent, GitLabProjectMetadata, GitLabReadFileOptions,
  GitLabTreeEntry,
} from "./types";

/** The most matches one search returns; the agent is told exactly this many may mean more. */
export const MAX_CODE_SEARCH_HITS = 500;
/**
 * Matches asked of GitLab per page, by engine. Advanced search's pages are small because its
 * matches spread across many projects (each one more to check per observer).
 */
export const CODE_SEARCH_PAGE_SIZES: Record<CodeSearchEngine, number> = { zoekt: 100, advanced: 20, basic: 100 };
/** The largest file `readFile` reads. */
export const MAX_FILE_BYTES = 1024 * 1024;
/** The most lines one `readFile` returns. */
export const MAX_FILE_LINES = 2000;

/**
 * How long the owner's view of a project is reused: its facts (path, default branch, visibility),
 * and whether its repository is open to everyone who can see it.
 */
const PROJECT_FACTS_TTL_MS = 10 * 60_000;
/** How long a scope Zoekt could not search is searched without asking Zoekt first. */
const NO_ZOEKT_TTL_MS = 10 * 60_000;
/**
 * The fewest entries of a timed family a write looks at for expired ones. A write of more looks
 * at twice as many as it wrote, so the sweep laps the family faster than writes grow it.
 */
const MIN_SWEEP = 32;
/** Bounds on the file contents a binding keeps: entries, and their bytes together. */
const MAX_CACHED_FILES = 128;
const MAX_CACHED_FILE_BYTES = 16 * 1024 * 1024;

const FACTS_PREFIX = "code:facts:";
const REPOSITORY_OPEN_PREFIX = "code:repositoryOpen:";
const NO_ZOEKT_PREFIX = "code:noZoekt:";
const FILE_PREFIX = "code:file:";
const FILE_INDEX_KEY = "code:files";

/** A full 40-hex commit id, which names one immutable version of a file. */
const COMMIT_OID = /^[0-9a-f]{40}$/;

/** A read's description, with what it depends on required (the new-gatekeeper observer contract). */
export type CodeObservation = ObservationDescription & { subresources: string[] };
/** Authorizes one observation through the reading session's own approval queue. */
export type CodeAuthorizer = (observation: CodeObservation) => Promise<void>;

/** The authorizer over a session's approval queue (or the reading cursor's own duplicate of it). */
export function queueAuthorizer(queue: { authorizeObservation(observation: ObservationDescription): unknown }): CodeAuthorizer {
  return async observation => {
    await queue.authorizeObservation(observation);
  };
}

type Timed<T> = { at: number; value: T };
type FileIndexEntry = { key: string; bytes: number };

/**
 * The caches a binding's code reads keep in its facet storage, beside (and apart from) the
 * project binding's generation-checked `cache:*` entries, since nothing here is changed by a queued
 * action: the owner's view of projects (their facts, and whether their repositories are open to
 * everyone who can see them) and which scopes Zoekt cannot search, each for ten minutes, and file
 * contents by commit, which never change, size-bounded with the oldest dropped first. A timed entry
 * a read finds expired is deleted, and every write sweeps its family for expired entries (see
 * #sweep), so those families hold little more than what is fresh. A cached file is still
 * authorized as it is read (see readRepositoryFile); search results are not cached.
 */
export class CodeCaches {
  readonly #kv: KvScannable;
  readonly #now: () => number;
  /** Per timed family, by prefix, the last key a sweep looked at; the next sweep starts after it. */
  readonly #sweptTo = new Map<string, string>();

  constructor(kv: KvScannable, now: () => number = Date.now) {
    this.#kv = kv;
    this.#now = now;
  }

  /** The value at `key` while it is fresh; an expired one is deleted. */
  #fresh<T>(key: string, ttlMs: number): T | undefined {
    const entry = this.#kv.get<Timed<T>>(key);
    if (entry === undefined) return undefined;
    if (this.#now() - entry.at < ttlMs) return entry.value;
    this.#kv.delete(key);
    return undefined;
  }

  /** Stores `entries` (key suffix, value) under `prefix`, timed from now, then sweeps the family. */
  #putTimed<T>(prefix: string, ttlMs: number, entries: ReadonlyArray<readonly [string, T]>): void {
    const at = this.#now();
    for (const [suffix, value] of entries) this.#kv.put<Timed<T>>(`${prefix}${suffix}`, { at, value });
    this.#sweep(prefix, ttlMs, Math.max(MIN_SWEEP, 2 * entries.length));
  }

  /**
   * Deletes the expired entries among the next `limit` of `prefix`'s family, in key order from
   * where the last sweep of it stopped, starting over from the first after reaching the end.
   */
  #sweep(prefix: string, ttlMs: number, limit: number): void {
    const after = this.#sweptTo.get(prefix);
    const batch = [...this.#kv.list<Timed<unknown>>({ prefix, limit, ...(after === undefined ? {} : { startAfter: after }) })];
    const now = this.#now();
    for (const [key, entry] of batch) {
      if (now - entry.at >= ttlMs) this.#kv.delete(key);
    }
    if (batch.length < limit) this.#sweptTo.delete(prefix);
    else this.#sweptTo.set(prefix, batch.at(-1)![0]);
  }

  /**
   * Each of `ids`' values in `prefix`'s family, from the cache where fresh and from `load` for the
   * rest. An id `load` leaves out is absent, and asked about again next time.
   */
  async #timedBatch<T>(prefix: string, ttlMs: number, ids: readonly number[],
                       load: (ids: number[]) => Promise<Map<number, T>>): Promise<Map<number, T>> {
    const found = new Map<number, T>();
    const missing: number[] = [];
    for (const id of new Set(ids)) {
      const cached = this.#fresh<T>(`${prefix}${id}`, ttlMs);
      if (cached === undefined) missing.push(id);
      else found.set(id, cached);
    }
    if (missing.length === 0) return found;
    const loaded = await load(missing);
    this.#putTimed(prefix, ttlMs, [...loaded].map(([id, value]) => [String(id), value] as const));
    for (const [id, value] of loaded) found.set(id, value);
    return found;
  }

  /**
   * The owner's view of each of `ids`, from the cache where fresh and from `load` for the rest. A
   * project `load` leaves out (the owner can't see it) is absent, and asked about again next time.
   */
  projectFacts(ids: readonly number[], load: (ids: number[]) => Promise<Map<number, GitLabProjectFacts>>):
      Promise<Map<number, GitLabProjectFacts>> {
    return this.#timedBatch(FACTS_PREFIX, PROJECT_FACTS_TTL_MS, ids, load);
  }

  /**
   * Whether each of `ids`' repositories is open to everyone who can see the project, as the owner
   * sees it, from the cache where fresh and from `load` for the rest. A project `load` leaves out
   * (not known) is absent, and asked about again next time.
   */
  repositoryOpenToAllUsers(ids: readonly number[], load: (ids: number[]) => Promise<Map<number, boolean>>):
      Promise<Map<number, boolean>> {
    return this.#timedBatch(REPOSITORY_OPEN_PREFIX, PROJECT_FACTS_TTL_MS, ids, load);
  }

  /** Whether Zoekt answered recently that it cannot search `scopeKey`. */
  hasNoZoekt(scopeKey: string): boolean {
    return this.#fresh<true>(`${NO_ZOEKT_PREFIX}${scopeKey}`, NO_ZOEKT_TTL_MS) === true;
  }

  markNoZoekt(scopeKey: string): void {
    this.#putTimed(NO_ZOEKT_PREFIX, NO_ZOEKT_TTL_MS, [[scopeKey, true]]);
  }

  /** A file's bytes at commit `commitId`, if kept. */
  file(projectId: number, commitId: string, path: string): Uint8Array | undefined {
    return this.#kv.get<Uint8Array>(fileKey(projectId, commitId, path));
  }

  /** Keeps a file's bytes at a commit, dropping the oldest kept files past the bounds. */
  storeFile(projectId: number, commitId: string, path: string, content: Uint8Array): void {
    const key = fileKey(projectId, commitId, path);
    const index = (this.#kv.get<FileIndexEntry[]>(FILE_INDEX_KEY) ?? []).filter(entry => entry.key !== key);
    index.push({ key, bytes: content.byteLength });
    let total = index.reduce((sum, entry) => sum + entry.bytes, 0);
    while (index.length > MAX_CACHED_FILES || total > MAX_CACHED_FILE_BYTES) {
      const dropped = index.shift()!;
      total -= dropped.bytes;
      this.#kv.delete(dropped.key);
    }
    if (index.some(entry => entry.key === key)) this.#kv.put(key, content);
    this.#kv.put(FILE_INDEX_KEY, index);
  }
}

function fileKey(projectId: number, commitId: string, path: string): string {
  return `${FILE_PREFIX}${projectId}:${commitId}:${encodeURIComponent(path)}`;
}

/** What code reads through one binding need: GitLab as its account, its caches, and the instance. */
export type CodeReadContext = {
  /** Runs replay-safe reads as the binding's account. */
  read: GitLabApiRunner;
  caches: CodeCaches;
  /** The browser-facing instance origin, for links. */
  instanceUrl: string;
  /** The instance's host, as `instanceSubresourceId` takes it. */
  host: string;
};

/** The first `max` characters of `text`, for an audit title. */
function clip(text: string, max = 80): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** The filters a query asks for, with what it left unset left out. */
function filtersOf(query: GitLabCodeSearchQuery): CodeSearchFilters {
  if (typeof query?.text !== "string") throw new Error("searchCode() needs `text`, the text to search for.");
  return {
    text: query.text,
    ...(query.regex === undefined ? {} : { regex: query.regex }),
    ...(query.path === undefined ? {} : { path: query.path }),
    ...(query.filename === undefined ? {} : { filename: query.filename }),
    ...(query.extension === undefined ? {} : { extension: query.extension }),
    ...(query.language === undefined ? {} : { language: query.language }),
  };
}

/** How a page's matches were matched, from the engine that ran (never from what was asked). */
export function matchedAs(engine: CodeSearchEngine, regex: boolean | undefined): GitLabCodeHit["matchedAs"] {
  if (engine === "advanced") return "words";
  return engine === "zoekt" && regex === true ? "regex" : "exact";
}

/** Where a search looks and how it is routed and reported. */
export type CodeSearchRequest =
  | {
    kind: "instance";
    query: GitLabCodeSearchQuery & { groupPath?: string; includeArchived?: boolean };
  }
  | {
    kind: "project";
    query: GitLabCodeSearchQuery & { ref?: string };
    projectId: number;
    projectPath: string;
    /** The project's default branch; null for an empty repository. */
    defaultBranch: string | null;
  };

/**
 * One code search, page by page: `next()` answers like a cursor's. Every answer but a `null` after
 * an answered page is authorized first, an empty one included; a refused answer ends the search,
 * every later call failing as it did. A failed GitLab read does not: the same page is asked for
 * again by the next call. Calls are serialized.
 */
export class CodeSearchPager {
  readonly #context: CodeReadContext;
  readonly #authorize: CodeAuthorizer;
  readonly #request: CodeSearchRequest;
  readonly #filters: CodeSearchFilters;
  readonly #queue = new SerialTaskQueue();
  #scope: CodeSearchScope | undefined;
  /** The engine the first page ran on, which serves the rest. */
  #engine: CodeSearchEngine | undefined;
  #page = 1;
  #answered = 0;
  #served = 0;
  #done = false;
  #refusal: unknown;

  constructor(context: CodeReadContext, authorize: CodeAuthorizer, request: CodeSearchRequest) {
    this.#context = context;
    this.#authorize = authorize;
    this.#request = request;
    this.#filters = filtersOf(request.query);
    if (request.kind === "project") this.#scope = { kind: "project", projectId: request.projectId };
  }

  next(): Promise<GitLabCodeHit[] | null> {
    return this.#queue.run(async () => {
      if (this.#refusal !== undefined) throw this.#refusal;
      if (this.#done) return null;
      try {
        return await this.#nextPage();
      } catch (error) {
        if (error instanceof RefusedPage) {
          this.#refusal = error.refusal;
          throw error.refusal;
        }
        throw error;
      }
    });
  }

  /** The group an instance search is narrowed to, if any. */
  get #groupPath(): string | undefined {
    const request = this.#request;
    return request.kind === "instance" && request.query.groupPath ? request.query.groupPath : undefined;
  }

  get #title(): string {
    const request = this.#request;
    const group = this.#groupPath;
    const scope = request.kind === "project" ? ` in ${request.projectPath}` : group ? ` in ${group}` : "";
    const title = `Search GitLab code: ${clip(request.query.text)}${scope}`;
    return this.#answered === 0 ? title : `${title} (page ${this.#answered + 1})`;
  }

  get #description(): string {
    const request = this.#request;
    const group = this.#groupPath;
    const where = request.kind === "project" ? `the GitLab project ${request.projectPath}`
      : group ? `the GitLab group ${group} on ${this.#context.host}` : `every readable project on ${this.#context.host}`;
    return `Search code in ${where} for "${clip(request.query.text, 200)}".`;
  }

  /** What a page discloses beyond its hits' repositories: the instance, for an instance search. */
  #baseSubresources(): string[] {
    return this.#request.kind === "instance" ? [instanceSubresourceId(this.#context.host)]
      : [repositorySubresourceId(this.#request.projectId)];
  }

  #subresourcesFor(hits: readonly GitLabCodeHit[]): string[] {
    const base = this.#baseSubresources();
    if (this.#request.kind === "project") return base;
    return [...base, ...new Set(hits.map(hit => repositorySubresourceId(hit.projectId)))];
  }

  async #authorizePage(hits: readonly GitLabCodeHit[]): Promise<void> {
    try {
      await this.#authorize({ title: this.#title, description: this.#description, subresources: this.#subresourcesFor(hits) });
    } catch (error) {
      throw new RefusedPage(error);
    }
  }

  async #nextPage(): Promise<GitLabCodeHit[] | null> {
    const scope = await this.#resolveScope();
    const page = await this.#fetch(scope);
    const remaining = MAX_CODE_SEARCH_HITS - this.#served;
    if (page.hits.length === 0 && page.nextPage === null && this.#answered > 0) {
      this.#done = true;
      return null;
    }
    const facts = await this.#context.caches.projectFacts(page.hits.map(hit => hit.projectId),
      missing => this.#context.read(api => fetchProjectFacts(api, missing))).catch((error: unknown) => {
      throw projectFactsFailure(error);
    });
    const hits = page.hits.flatMap(raw => {
      const project = facts.get(raw.projectId);
      return project === undefined ? [] : [this.#hit(raw, project, page.engine)];
    }).slice(0, remaining);

    const served = await this.#authorized(hits, facts);
    this.#answered++;
    this.#served += served.length;
    this.#page = page.nextPage ?? this.#page;
    if (page.nextPage === null || this.#served >= MAX_CODE_SEARCH_HITS) this.#done = true;
    return page.hits.length === 0 && page.nextPage === null ? null : served;
  }

  /**
   * `hits`, once authorized; if a collaborator was definitely denied them, only those from
   * projects every signed-in user can read, once that narrower page is authorized instead. Only an
   * instance search narrows: a project search's page depends on one repository however it is cut.
   */
  async #authorized(hits: GitLabCodeHit[], facts: Map<number, GitLabProjectFacts>): Promise<GitLabCodeHit[]> {
    try {
      await this.#authorizePage(hits);
      return hits;
    } catch (error) {
      const denied = error instanceof RefusedPage && isObserverAccessDenied(error.refusal);
      if (!denied || this.#request.kind !== "instance") throw error;
      const open = await this.#openToEveryone(hits, facts);
      const narrowed = hits.filter(hit => open.has(hit.projectId));
      if (narrowed.length === hits.length) throw error;
      await this.#authorizePage(narrowed);
      return narrowed;
    }
  }

  /**
   * The projects on `hits` whose code every signed-in user of the instance can read, as the owner
   * sees it: internal or public, with a repository open to everyone who can see the project. Only
   * narrowing asks GitLab for the repository's level, for the page's internal and public projects
   * alone; a level GitLab did not show, or that could not be read, counts as not open.
   */
  async #openToEveryone(hits: readonly GitLabCodeHit[], facts: Map<number, GitLabProjectFacts>): Promise<Set<number>> {
    const visible = [...new Set(hits.map(hit => hit.projectId))].filter(id => facts.get(id)!.visibility !== "private");
    if (visible.length === 0) return new Set();
    const open = await this.#context.caches.repositoryOpenToAllUsers(visible,
      missing => this.#context.read(api => fetchRepositoryOpenToAllUsers(api, missing)));
    return new Set(visible.filter(id => open.get(id) === true));
  }

  #hit(raw: RawCodeHit, project: GitLabProjectFacts, engine: CodeSearchEngine): GitLabCodeHit {
    return {
      projectId: raw.projectId,
      projectPath: project.path,
      path: raw.path,
      ref: raw.ref,
      startLine: raw.startLine,
      snippet: raw.data,
      webUrl: blobUrl(this.#context.instanceUrl, project.path, raw.ref, raw.path, raw.startLine),
      matchedAs: matchedAs(engine, this.#filters.regex),
    };
  }

  /**
   * Where the search looks, resolving `groupPath` on the first call. A group the account can't see
   * there is an answer about the instance, authorized as one, and ends the search.
   */
  async #resolveScope(): Promise<CodeSearchScope> {
    if (this.#scope !== undefined) return this.#scope;
    const groupPath = this.#groupPath;
    if (groupPath === undefined) return this.#scope = { kind: "instance" };
    const groupId = await this.#context.read(api => resolveGroupId(api, groupPath));
    if (groupId !== null) return this.#scope = { kind: "group", groupId };
    await this.#authorizePage([]);
    this.#answered++;
    this.#done = true;
    throw new Error(`No GitLab group at "${groupPath}" that this account can read on ${this.#context.host}.`);
  }

  /** The scope's key for the "no Zoekt here" cache. */
  #scopeKey(scope: CodeSearchScope): string {
    switch (scope.kind) {
      case "instance": return "instance";
      case "group": return `group/${scope.groupId}`;
      case "project": return `project/${scope.projectId}`;
    }
  }

  #search(scope: CodeSearchScope, engine: CodeSearchEngine): Promise<CodeSearchPage> {
    const ref = this.#request.kind === "project" ? this.#request.query.ref : undefined;
    const includeArchived = this.#request.kind === "instance" ? this.#request.query.includeArchived : undefined;
    return this.#context.read(api => searchCodePage(api, scope, engine, this.#filters, {
      ...(ref === undefined ? {} : { ref }),
      ...(includeArchived === undefined ? {} : { includeArchived }),
      page: this.#page,
      perPage: CODE_SEARCH_PAGE_SIZES[engine],
    }));
  }

  /** One page, on the engine the search runs on, choosing it on the first page. */
  async #fetch(scope: CodeSearchScope): Promise<CodeSearchPage> {
    if (this.#engine !== undefined) return await this.#search(scope, this.#engine);
    for (const engine of this.#candidates(scope)) {
      try {
        const page = await this.#search(scope, engine);
        this.#engine = page.engine;
        return page;
      } catch (error) {
        if (!(error instanceof GitLabCodeSearchError)) throw error;
        if (engine === "zoekt" && error.category === "zoektUnavailable") {
          this.#context.caches.markNoZoekt(this.#scopeKey(scope));
          if (scope.kind === "project") continue;
        }
        if (engine === "advanced" && error.category === "noEngine") continue;
        throw error;
      }
    }
    throw new GitLabCodeSearchError("noEngine");
  }

  /** The engines to try, in order. */
  #candidates(scope: CodeSearchScope): CodeSearchEngine[] {
    const noZoekt = this.#context.caches.hasNoZoekt(this.#scopeKey(scope));
    if (this.#request.kind === "instance") {
      if (noZoekt) throw new GitLabCodeSearchError("zoektUnavailable");
      return ["zoekt"];
    }
    const { ref } = this.#request.query;
    if (ref !== undefined && ref !== "" && ref !== this.#request.defaultBranch) return ["basic"];
    return noZoekt ? ["advanced", "basic"] : ["zoekt", "advanced", "basic"];
  }
}

/** A refused authorization, kept apart from GitLab's failures so it can end the search. */
class RefusedPage extends Error {
  constructor(readonly refusal: unknown) {
    super("refused");
  }
}

// ---------------------------------------------------------------------------
// Repositories

/** A repository opened for reading: the project, pinned by id, and its path then for titles. */
export type RepositoryTarget = { projectId: number; projectPath: string };

/**
 * Authorizes a read of `target`'s repository, then returns `value` -- or, when the read found
 * nothing (`missing`), throws its error: "no such file" is an answer from the repository too.
 */
async function observeRepository<T>(authorize: CodeAuthorizer, target: RepositoryTarget,
                                    observation: Omit<ObservationDescription, "subresources">, value: () => T): Promise<T> {
  await authorize({ ...observation, subresources: [repositorySubresourceId(target.projectId)] });
  return value();
}

/** Whether `error` is GitLab saying nothing is there (404). */
function isNotFound(error: unknown): boolean {
  return error instanceof GitLabApiError && error.status === 404 && !error.isAuthError;
}

/** A positive whole line number option, or undefined when unset. */
function lineOption(name: string, value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${name} must be a positive whole number.`);
  return value as number;
}

/** A file's lines, without the empty one after a final newline. */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/**
 * The text of a file's bytes, or why it is refused: it holds a NUL byte, as binary files do and
 * text never does. Decoded as UTF-8, invalid sequences as U+FFFD, a leading BOM dropped.
 */
export function decodeTextFile(content: Uint8Array): { text: string } | { binary: true } {
  return content.includes(0) ? { binary: true } : { text: new TextDecoder("utf-8").decode(content) };
}

/**
 * Lines `startLine`..`endLine` of `text` (1-based, inclusive), at most MAX_FILE_LINES of them,
 * the end clamped to the file's.
 * @throws Error when `startLine` is past the end, or `endLine` before `startLine`.
 */
export function sliceLines(path: string, text: string, startLine = 1, endLine?: number):
    Pick<GitLabFileContent, "startLine" | "endLine" | "totalLines" | "text"> {
  const lines = splitLines(text);
  const totalLines = lines.length;
  if (endLine !== undefined && endLine < startLine) throw new Error("endLine must not be before startLine.");
  if (startLine > Math.max(totalLines, 1)) {
    throw new Error(`Line ${startLine} is past the end of ${path}, which has ${totalLines} lines.`);
  }
  const last = Math.min(endLine ?? totalLines, totalLines, startLine + MAX_FILE_LINES - 1);
  return { startLine, endLine: last, totalLines, text: lines.slice(startLine - 1, last).join("\n") };
}

/**
 * Reads a text file from `target`'s repository at `options.ref` (the default branch), as
 * `GitLabRepository.readFile` documents. A file at a commit id already kept is served from the
 * cache; either way the read is authorized, a missing, binary or oversized file included, before
 * anything about it is returned.
 */
export async function readRepositoryFile(context: CodeReadContext, authorize: CodeAuthorizer, target: RepositoryTarget,
                                         path: string, options: GitLabReadFileOptions = {}): Promise<GitLabFileContent> {
  if (typeof path !== "string" || path.replace(/^\/+/, "") === "") throw new Error("readFile() needs the file's path.");
  const filePath = path.replace(/^\/+/, "");
  const startLine = lineOption("startLine", options.startLine);
  const endLine = lineOption("endLine", options.endLine);
  const ref = options.ref === undefined || options.ref === "" ? "HEAD" : options.ref;
  const observation = {
    title: `Read ${filePath} in ${target.projectPath}`,
    description: `Read ${filePath}${options.ref ? ` at ${options.ref}` : ""} in the GitLab project ${target.projectPath}.`,
  };

  const cached = COMMIT_OID.test(ref) ? context.caches.file(target.projectId, ref, filePath) : undefined;
  const file = cached !== undefined ? { commitId: ref, size: cached.byteLength, content: cached }
    : await context.read(api => api.getRepositoryFile(target.projectId, filePath, ref, MAX_FILE_BYTES));
  return await observeRepository(authorize, target, observation, () => {
    if (file === null) {
      throw new Error(`There is no file ${filePath} at ${options.ref || "the default branch"} in ${target.projectPath}.`);
    }
    if (file.content === null) {
      throw new Error(`${filePath} is ${file.size} bytes, larger than the 1 MiB readFile() reads.`);
    }
    const decoded = decodeTextFile(file.content);
    if ("binary" in decoded) throw new Error(`${filePath} is a binary file; readFile() reads text files only.`);
    if (cached === undefined) context.caches.storeFile(target.projectId, file.commitId, filePath, file.content);
    return { path: filePath, commitId: file.commitId, ...sliceLines(filePath, decoded.text, startLine, endLine) };
  });
}

/**
 * Reads `target`'s project metadata as the binding's account; a project gone is still an answer.
 * Reported as metadataSubresourceId says: the repository, or the project when its repository is
 * disabled; a project gone, the repository.
 */
export async function readRepositoryMetadata(context: CodeReadContext, authorize: CodeAuthorizer,
                                             target: RepositoryTarget): Promise<GitLabProjectMetadata> {
  let project: GitLabProjectResponse | undefined;
  let failure: unknown;
  try {
    project = await context.read(api => api.getProjectById(target.projectId));
  } catch (error) {
    if (!isNotFound(error)) throw error;
    failure = error;
  }
  await authorize({
    title: `Read project metadata for ${target.projectPath}`,
    description: `Read basic metadata for the GitLab project ${target.projectPath}.`,
    subresources: [project === undefined ? repositorySubresourceId(target.projectId)
      : metadataSubresourceId(target.projectId, project.repository_access_level)],
  });
  if (project === undefined) throw failure;
  return normalizeProjectMetadata(context.instanceUrl, project);
}

/** What `listFiles` lists: where, at which ref, and how many per page. */
export type TreeRequest = { ref?: string; path?: string; recursive?: boolean; pageSize: number };

/**
 * `listFiles()`, page by page: each answer is authorized before it is returned, an empty page and
 * a missing path or ref (the first page's error) included; a `null` after an answered page is not.
 * A refused answer ends the listing. Calls are serialized.
 */
export class RepositoryTreePager {
  readonly #context: CodeReadContext;
  readonly #authorize: CodeAuthorizer;
  readonly #target: RepositoryTarget;
  readonly #request: TreeRequest;
  readonly #queue = new SerialTaskQueue();
  #page: number | null = 1;
  #answered = 0;
  #refusal: unknown;

  constructor(context: CodeReadContext, authorize: CodeAuthorizer, target: RepositoryTarget, request: TreeRequest) {
    this.#context = context;
    this.#authorize = authorize;
    this.#target = target;
    this.#request = request;
  }

  next(): Promise<GitLabTreeEntry[] | null> {
    return this.#queue.run(async () => {
      if (this.#refusal !== undefined) throw this.#refusal;
      if (this.#page === null) return null;
      const page = this.#page;
      const { ref, path, recursive, pageSize } = this.#request;
      const result = await this.#context.read(api => api.listRepositoryTree(this.#target.projectId, {
        ...(ref ? { ref } : {}), ...(path ? { path } : {}), ...(recursive ? { recursive } : {}), page, perPage: pageSize,
      }));
      if (result === null && this.#answered > 0) {
        this.#page = null;
        return null;
      }
      const where = path ? `${path} in ${this.#target.projectPath}` : this.#target.projectPath;
      const title = `List files in ${where}`;
      try {
        await this.#authorize({
          title: this.#answered === 0 ? title : `${title} (page ${this.#answered + 1})`,
          description: `List files${recursive ? " recursively" : ""} in ${path ? `${path} of ` : ""}the GitLab project `
            + `${this.#target.projectPath}${ref ? ` at ${ref}` : ""}.`,
          subresources: [repositorySubresourceId(this.#target.projectId)],
        });
      } catch (error) {
        this.#refusal = error;
        throw error;
      }
      this.#answered++;
      if (result === null) {
        this.#page = null;
        throw new Error(`There is nothing at ${path || "the repository root"} at ${ref || "the default branch"} in `
          + `${this.#target.projectPath}: the path or ref does not exist, or the repository is empty.`);
      }
      this.#page = result.nextPage;
      return result.items.map(item => ({ path: item.path, type: item.type }));
    });
  }
}

/**
 * The project `idOrPath` names, read as the binding's account: a numeric id, a full path, or a
 * project URL on the instance. Found or not, the answer is about the instance, authorized as one
 * (`instance/<host>`) before it is returned, so a collaborator refused it learns neither; when
 * there is no project the account can read, the call then fails.
 */
export async function openRepository(context: CodeReadContext, authorize: CodeAuthorizer, idOrPath: string,
                                     projectPathOfUrl: (url: string) => string | null): Promise<GitLabProjectResponse> {
  if (typeof idOrPath !== "string" || idOrPath.trim() === "") throw new Error("getRepository() needs a project id or path.");
  const trimmed = idOrPath.trim();
  const fromUrl = /^https?:\/\//i.test(trimmed) ? projectPathOfUrl(trimmed) : null;
  const path = fromUrl ?? trimmed.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  let project: GitLabProjectResponse | undefined;
  let failure: unknown;
  try {
    project = await context.read(api => /^[1-9][0-9]*$/.test(path) && Number.isSafeInteger(Number(path))
      ? api.getProjectById(Number(path)) : api.getProject(path));
  } catch (error) {
    if (!isNotFound(error)) throw error;
    failure = error;
  }
  await authorize({
    title: `Open GitLab repository ${clip(trimmed)}`,
    description: `Look for the GitLab project ${clip(trimmed, 200)} on ${context.host}.`,
    subresources: [instanceSubresourceId(context.host)],
  });
  if (project !== undefined) return project;
  throw new Error(`There is no GitLab project "${clip(trimmed, 200)}" that this account can read on ${context.host}.`,
    { cause: failure });
}
