# Plan: GitLab code search

Design record for code search in `gatekeeper-gitlab`: an instance-wide code-reading connection,
code search and file reads on project connections, and the observer model that keeps shared
workspaces usable. Decisions below are locked; measurements were taken read-only against
gitlab.cfdata.org (GitLab 18.11.13-ee, Zoekt and Elasticsearch both enabled) on 2026-11-06.

## Resource types

| Type | URL pattern | Grants | Actions |
|---|---|---|---|
| **Instance** (new) | the `GITLAB_URL` root | Read code in every project the account can read | none |
| Project | unchanged | unchanged, plus `searchCode`, `readFile`, `listFiles` | unchanged |
| Issue, Merge Request | unchanged | unchanged | unchanged |

- The Instance type is listed only when `GITLAB_INSTANCE_CODE_SEARCH` is set (off by default;
  gitlab.com has no instance-wide search). It is its own connect card, not grouped with Project,
  and its configurator only confirms the instance. Suggested binding name `GITLAB_INSTANCE`.
- Writes stay behind a Project connection. The instance connection is read-only by its API, not
  by a narrower OAuth token (accepted).

## Agent-facing API

- `GitLabInstance.searchCode(query: GitLabInstanceCodeSearch): Promise<Cursor<GitLabCodeHit>>`
- `GitLabInstance.getRepository(idOrPath): Promise<GitLabRepository>` — read-only, pinned to the
  numeric project id when created.
- `GitLabRepository`: `readFile`, `listFiles`, `getMetadata`. `GitLabProject extends
  GitLabRepository` and adds `searchCode(query: GitLabProjectCodeSearch)`.
- `GitLabCodeSearchQuery` holds options both methods take (`text`, `regex`, `path`, `filename`,
  `extension`, `language`); `GitLabInstanceCodeSearch` adds `groupPath` and `includeArchived`;
  `GitLabProjectCodeSearch` adds `ref`.
- `language` is a `GitLabCodeLanguage`, a fixed union of lowercase names, each checked live against
  gitlab.cfdata.org's Zoekt to return results as spelled (`typescript`, `tsx`, `javascript`,
  `python`, `go`, `c++`, `c#`, `shell`, `yaml`, `hcl`, `dockerfile`, `markdown`, `text`, …; the type
  is the list). Zoekt answers an unknown `lang:` with zero hits, which an agent would read as
  absence, so `@validateRpc()` refuses an unlisted value before anything is sent. It is sent
  verbatim (`c++`, `c#` URL-encoded with the rest of `search`). `typescript` leaves out `.tsx`
  (use `tsx`); anything unlisted goes through `extension` or `filename`.
- Hits carry plain `projectId`/`projectPath` (no stub per hit) and `matchedAs: "exact" | "regex" |
  "words"`, taken from GitLab's `X-Search-Type` header, never from what was requested.
- `GitLabFileContent.commitId` is returned for consistent multi-file reads (pass it as `ref`). A
  project connection's `readFile` advertises it to the git cache once the read is authorized, so
  it can be mounted as a worktree (its search, listings and metadata return no commit ids). The
  instance connection does not advertise it, so it cannot be mounted; worktrees from the instance
  connection are deferred (`gitPull` receives object ids only and cannot route lazy faults to a
  project).
- At most 500 hits per search, documented; exactly 500 means there may be more. A page can be
  short or `[]` when matches were left out (see narrowing); `null` ends the search.
- File reads are text only (binary refused), at most 2,000 lines per call with `totalLines`, files
  over 1 MiB refused.

## Search engine routing

- **Instance and group scope: Zoekt only (v1).** Send `search_type=zoekt&regex=<bool>`; a response
  whose `X-Search-Type` is not `zoekt` is an error. Advanced search there would cost about 25×
  more observer checks (measured: 53 projects per 100 `var` hits with advanced, 2 with Zoekt).
- **Project scope, default branch** (`ref` unset or equal to the default branch): Zoekt with
  `regex=false` (or `true` when asked); on 400 `Zoekt is not available`, advanced with escaped
  text; then basic.
- **Project scope, any other ref:** GitLab forces basic (`EE::Search::ProjectService#search_type`)
  even when Zoekt is requested, and rejects `regex`. Send `search_type=basic`, no `regex`; refuse
  `regex` / `language` before sending.
- Encodings: Zoekt `regex=false` takes text verbatim; advanced needs simple_query_string escaping
  and does word matching; basic takes text verbatim and matches case-insensitively. Shared filters
  `extension:`, `filename:`, `path:` work on all three.
- Always read `X-Search-Type`. If an option needed an engine that did not run, return an error, not
  results that ignored the option.

## Observer model

| Read | Requirement |
|---|---|
| Instance search page, empty pages included | `instance/<host>` + `repository/<projectId>` per distinct project on the page |
| `GitLabRepository` reads, missing paths included | `repository/<projectId>` (metadata: as on a project connection) |
| `getRepository(path)`, found or not | `instance/<host>` |
| Project connection code-only reads: `searchCode`, `readFile`, `listFiles`, `listBranches`, `listTags`, `resolveRef`, `listCommits`, `getMetadata` | `repository/<projectId>` |
| `getMetadata` (either connection) of a project with `repository_access_level: disabled` | `project/<projectId>` |
| Project connection issues, MRs, discussions, pipelines, jobs, `getCommit` (includes CI) | unchanged: `project/<id>` or `project/<id>/role/<role>` |

- `getRepository()` authorizes `instance/<host>` on the found path too, so a refused collaborator
  cannot tell a private project exists from one that does not.
- A disabled repository makes GitLab's `downloadCode` false for everyone, so `repository/<id>`
  would refuse every collaborator for metadata the project's members can see; it reports the
  membership requirement instead. An absent level keeps `repository/<id>`. The instance
  connection's verifier therefore accepts `project/<id>` (no role) as well.

- `repository/<id>`: the observer's own token can `downloadCode` (GraphQL `projects(ids:)`,
  chunks of ≤100 ids, independent, bounded parallelism; `hasNextPage: true` is an error; an
  omitted project is a denial).
- `instance/<host>`: the observer's `GET /user` is `state: active`, `external: false`.
- Search misses and narrowed pages are accepted existence signals: a search reveals that a term is
  absent from, or present in, projects some collaborators cannot read, never their content. The
  narrowed page is visible to everyone who can see the reading chat or gadget.
- Recorded requirements are never rewritten: reads before this change keep their `project/<id>`.
  Legacy (pre-`reportsSubresources`) connections keep their admission checks.

### Narrowing

A search page is authorized with all its hits. If `authorizeObservation` fails with the kernel's
definite-denial code (`OBSERVER_ACCESS_DENIED_CODE`, set only when every verifier answered and at
least one denied), retry once with hits from projects every signed-in user can read (owner-side
facts: internal/public visibility, repository not members-only) and authorize that. Any other
failure propagates unchanged; a failed narrowed retry propagates. A solo workspace runs no observer
checks and always gets everything.

The repository access level (REST `GET /projects/:id`, one request per project; GraphQL has no
field for it) is fetched lazily: page processing reads only the GraphQL facts, and only a page
refused with the definite denial asks for the level of its internal and public projects, cached
like the facts. An unknown level, or a failed lookup, counts as not open.

## Caching

| Cache | Where | Key | Lifetime |
|---|---|---|---|
| Observer verdicts | observer's `UserAccount` (`KvTtlCache`), per connection generation | `repository/*`, `instance/*` | grants `GITLAB_CODE_ACCESS_CACHE_TTL_SECONDS` (default 86400), denials 15 s, failures uncached |
| Project facts (owner's view) | connection facet storage | project id → path, default branch, visibility | ~10 min |
| Repository open to all (owner's view) | connection facet storage | project id → repository access level `enabled` or not; asked only when narrowing | ~10 min; unknown or failed not cached |
| "No Zoekt here" | connection facet storage | scope key | ~10 min |
| File contents | connection facet storage | `(projectId, commitId, path)` | immutable; size-bounded; hits still authorize |
| Search results | not cached | | |

The timed entries are bounded: a read that finds one expired deletes it, and each write sweeps
its family for expired entries (at least twice as many keys as it wrote, from where the last sweep
stopped), so a family holds about what was written in the last 10 minutes.

A revoked code-read grant can go unnoticed for up to the configured TTL (24 h by default).
Project membership verdicts (`project/*`) keep their 15-minute lifetime.

## Errors

Classify by status first; replace provider body text on every search error and never log bodies.

| Status | Category | Text |
|---|---|---|
| 401 on `/user` | reconnect (existing) | existing |
| 403 `Global Search is disabled for this scope` | turned off | fixed |
| other 401/403 | refused | fixed, with status |
| 429 | rate limited | fixed + `retryAfterSeconds` (new `GitLabApiError` field) |
| 5xx, transport, a search answer that is not a list | unavailable, retryable | fixed |
| 400 Zoekt unavailable | internal fallback (project scope) / unavailable (instance) | fixed |
| 400 Elasticsearch unavailable/disabled, `Scope supported only with…` | no engine | fixed |
| 400 `regex supported only with exact code search` | our bug | fixed; logged |
| 400 Zoekt group project limit | too broad | "This group has too many projects to search on this GitLab instance right now. Search a subgroup with `groupPath`, or search the whole instance without it." |
| other 400 | query rejected | fixed |

Known 400 strings are matched exactly (18.11.13 source); anything else is "query rejected".

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `GITLAB_INSTANCE_CODE_SEARCH` | unset (off) | List the Instance resource type |
| `GITLAB_CODE_ACCESS_CACHE_TTL_SECONDS` | `86400` | Grant lifetime for `repository/*` and `instance/*` verdicts |

## Kernel change

`workshop-shared/src/gatekeeper.ts` exports `OBSERVER_ACCESS_DENIED_CODE`, documented on
`authorizeObservation()`. The observer ledger sets it as an enumerable `code` only where every
verifier answered and at least one observer was denied; verification failures stay unmarked. The
kit's `isObserverAccessDenied()` matches it. If kernel review declines, narrowing is removed and an
instance search with a restricted hit fails while a restricted collaborator is present.

## Deferred

- A cross-account cache of project facts (strategy shortcut for widely readable repositories).
- Worktrees from the instance connection.
- Group grants (a narrower connection than the instance).
- Advanced search at instance and group scope.

## Not yet verified

- Behaviour without Zoekt, and whether instance Zoekt search skips unindexed namespaces.
- 5xx and 429 search error bodies.
- Advanced-search escaping edge cases (Unicode, leading `-`, only special characters).
- GraphQL cost with several observers at once, latency from a Worker, platform limits on a slow
  verifier call.
- GitLab versions other than 18.11.13.
