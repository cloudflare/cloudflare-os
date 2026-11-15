# Review Guidelines

Guidance for AI reviewers reading pull requests in this repository. For what changes are
accepted at all, see [CONTRIBUTING.md](./CONTRIBUTING.md).

Before reviewing, read the package guide (`AGENTS.md` › Package guides) for every directory the diff
touches. Cite a rule from the file you read it in.

Review priority, highest first: the kernel bar, capability-security invariants, secret leakage
through logs and errors, then everything else.

## High-scrutiny areas

`packages/workshop-backend/` and the public API in `packages/workshop-shared/src/api.ts` are the
**kernel**. Maintainers read every line, so hold them to a higher bar than UI or gatekeeper code:

- Every exported member of the `workshop-shared` public API needs a doc comment — types, consts and
  functions, not just interfaces.
- Reject a hand-written interface that mirrors an RPC interface plus an `as unknown as` cast. Derive
  from the real type instead, or rethink the design.
- Prefer reusing an existing mechanism over adding a parallel one; say which existing mechanism the
  change should have used.
- A large kernel change should be split by concern into separate PRs, and at minimum grouped into
  commits that let `workshop-backend`/`workshop-shared` be reviewed apart from UI. Flag PRs that
  bundle both.

## Capability-based security

- A resource becomes "ambient" (auto-injected) only through user or admin configuration. A
  gatekeeper must never assert its own ambience.
- `#assertResourceEnabled()` in `packages/workshop-backend/src/user.ts` is the single chokepoint
  where disabled gatekeepers and resources are enforced before a capability is minted, called by
  both of that file's mints: `getGatekeeperClassFor()` (not the same-named vendor method each
  gatekeeper implements) and `createResourceGatekeeper()`. Flag any new path that mints a
  gatekeeper capability without going through it.
- Authentication and authorization config (`AUTH_GATEKEEPERS`, `DISABLE_PASSWORD_AUTH`) is
  deliberately env-var driven in `auth/config.ts` and must **not** move into `AdminConfig`, so a
  compromised admin session cannot change it. Reject changes that relocate it.
- `AdminSettings` is the only writer of the authoritative `AdminConfig`. Other code reads through
  `readAdminConfig(env)`, except these, which deliberately read the authoritative config
  (`committedAdminConfig()`): in `AdminApiImpl`, where a view is minted, for `inspectWorkspace()`
  and `inspectUser()` alike, so that a KV mirror still holding a higher access level never mints a
  view at it, a content view included; the audit log's retention in `listAdminAudit()` and
  `getAdminAuditStats()`; and `requestWorkspaceWrite()` for `"grantContentAccess"`, so that a
  request for content is never made at a level the mirror alone still shows; and
  `IssueReportsDurableObject` (`#dueBefore()`), in `alarm()` and when an image upload is accepted,
  so that reports are never deleted, and no upload refused or let through, by a retention that may
  be stale. The admin-settings conventions are in `packages/workshop-backend/AGENTS.md`.
- `OverseerDurableObject.openForAdmin()` stays reachable only over the Durable Object binding, never
  through a capability a user holds, and refuses an uninitialised workspace without writing.
  `UserDurableObject.openForAdmin()` is held to the same, for an account never created. Both views
  run every method through `adminViewCall()` (`admin-view.ts`), and neither appends a record
  itself. `adminViewCall()` checks the view again once it has read the deployment's setting and
  once the call has read its answer, with nothing awaited before its record is sent, and records
  the call in the deployment-wide log before anything it read leaves the server, so that a call
  whose record cannot be written returns nothing. An `AdminWorkspaceView` never reaches a
  connection (an admin's reads of trees and history never pull). An `AdminUserView` reads only
  the account's own store, writes nothing to it, and returns no token, hash, API key, API URL or
  header value. An `AdminWorkspaceView` method returns what the `"metadata"` level withholds (see
  docs/admin-access.md) only when its `#call()` found, on that call, a view opened for content,
  the level in force `"content"` and a live grant (`contentGrant()`), and it records the grant's
  id; an `AdminUserView` method never does. The one condition a `withhold*` helper may hang on is
  the `content` flag `#call()` hands the read, and every workspace method has its entry in
  `ADMIN_METHOD_ANSWERS`. Flag a path that returns a workspace's or an account's data to an admin
  without `adminViewCall()`; a content read whose condition is anything but that flag; a method
  missing from the table or classified by a second list; a liveness test for a grant that is not
  `isAdminGrantLive()`; and a content read that holds a file or an attachment whole.
- That an `AdminUserView` never calls a gatekeeper is a type, so check the diff, not a call graph:
  `AdminUserViewImpl` reaches the account only through `AdminUserViewHost`, whose `UserStoreReads`
  leaves out the collections that hold gatekeeper stubs and whose `connectedAccounts()` yields
  records without `account`. Flag a change that widens either type, casts around them, gives the
  view the Durable Object itself, builds an answer by spreading a stored record, or exports the
  view's class or constructs it anywhere but in its `open()`: `openAdminUserView()` is the one way
  to a view, and it records the open first. The rule excepts three stored values, which the view
  returns whole because each is an API value that holds no credential: `describe()`'s profile, a
  shared workspace's owner and a workspace's notification mute. It builds everything else field by
  field, and names neither a connected account's description nor a blueprint's id.
- `OverseerDurableObject.applyAdminWrite()` stays reachable only over the Durable Object binding
  and is called only by `AdminApiImpl.approveWorkspaceWrite()`, after `AdminSettings` has verified
  a passkey assertion over that request's challenge and claimed the request. It appends its
  `"approved"` record to the deployment-wide log before any effect, so that a write whose record
  cannot be written does not happen, and enters the write in the workspace's action log, except
  `"grantContentAccess"`, which enters nothing there and raises nothing a member can see. Flag a
  path that changes a workspace for an admin without these, any code that reads
  `ADMIN_WORKSPACE_WRITES` other than through `adminWorkspaceWritesEnabled()`, any move of passkeys
  into `AdminConfig`, any passkey check that trusts a request header for the origin, any way to
  remove or use a passkey without an assertion, and any way to remove or use another admin's
  passkey. Flag also an approver compared with the requester other than through
  `sameDeploymentAdmin()`; a member-facing path that writes, deletes or returns a grant with source
  `"admins"`, or that asks the owner's account for the account-wide grant; and an owner's grant
  call that appends to the admin audit log.
- Three more entry points stay reachable only over the Durable Object binding, never through a
  capability a user or a member's session holds. `OverseerDurableObject.endAdminGrant()` is called
  only by `AdminApiImpl.endWorkspaceGrant()`; it ends only a live grant with source `"admins"`, and
  appends its `"revoked"` record to the deployment-wide log before the grant is ended, so that an
  ending whose record cannot be written does not happen. `OverseerDurableObject.issueReportContext()`
  is called only by `AuthenticatedApiImpl.submitIssueReport()`, for the caller's own user id; it
  answers from the sharing records, opens no session, joins no presence and writes nothing.
  `UserDurableObject.liveAccountAdminGrant()` is reached over the binding only by
  `OverseerImpl.contentGrant()`, that is, only when an admin's call needs content and the
  workspace's own storage holds no live grant (the account's own `grantAccountAdminAccess()` reads
  it too); it reads one value and writes nothing. Flag any of the three exposed through a
  capability; a second caller of any of them; an `endAdminGrant()` that ends an owner's grant or
  ends before its record is appended; an `issueReportContext()` handed a user id that is not the
  caller's own; and a path other than `contentGrant()` (a listing, a metadata call, any
  member-facing method) that asks an account for its account-wide grant.
- Issue reports (see docs/issue-reports.md) keep an admins-only entry from the reporter and an
  image behind its row. Flag a path that returns an admins-only entry, or anything derived from
  one (a count, a timestamp), to a reporter; a path that returns an admin's id to a reporter; an
  image served or rendered with a type that is not the recognised one; a use of the image bucket
  (`ISSUE_IMAGES`) outside `issue-reports.ts`, an image reachable over an HTTP route or a bucket
  URL, an image object read before its row is checked, or an image row deleted before its object;
  a copy of a profile or other member-controlled text into the report store, or into a grant,
  other than through `namedUser()`; a reporter's or an owner's call that can add a row the store
  keeps without a bound (a `grants` row no report names); and a listing that returns every report
  or every grant.
- `ADMIN_WORKSPACE_ACCESS_MAX`, `ADMIN_AUDIT_RETENTION_MIN_DAYS`, `ISSUE_REPORT_RETENTION_MIN_DAYS`
  and `ADMIN_WORKSPACE_WRITES` are env-driven, like auth config, and the cap and the writes switch
  fail closed. Flag code that enforces `adminWorkspaceAccess`, or enforces or prunes with
  `adminAuditRetentionDays` or `issueReportRetentionDays`, without `adminAccessPolicy()`.
- A new `AdminSettings` mutator takes an `AdminSettingActor` and records through
  `#mutateAdminConfig()`, or records explicitly before any other write.
- Text a user or workspace member controls (display names, titles) enters the directory or the
  audit log only bounded: clamped to `MAX_DIRECTORY_TEXT_LENGTH`, or cut by `cutAdminAuditText()`.
  Flag a new copy of such text into either store without a bound.
- `cf-os api` sends `User-Agent: cf-os-api/<version>`, and except on a local instance
  (`WORKSHOP_ENVIRONMENT` `development` or `test`, set only by `pnpm dev-server` and the integration
  harness) the Workshop lets such a session act only as a deployment admin. That is a speed bump
  against casual use: a client can send any User-Agent, so never rely on it for authorization; the
  API's own checks are the boundary. Flag code that grants anything by User-Agent, and any
  deployment config that sets `WORKSHOP_ENVIRONMENT`.
- In `packages/mcp-shared/`, `tools.ts` is the trust boundary: nothing outside it may read a tool's
  annotations, a tool is an observation only when the server declares `readOnlyHint: true`, and
  auto-applying a write additionally requires a `vetted` endpoint. Every SDK OAuth operation must be
  given `sdkFetch(...)` so endpoint and SSRF checks survive redirects. Full rule:
  `packages/mcp-shared/AGENTS.md`.
- `packages/bundled-blueprints/blueprints/`: a `blueprintId` is never edited after deploy — installs and promotion are
  keyed on it, so a rename orphans the old entry.

## Gatekeepers

Correctness is not enough. Pressure-test the agent-facing API
(`packages/gatekeeper-*/src/*types.d.ts`): does the shape make sense, does it cover the most common
user stories, what would you do differently? Check that the seams (resource granularities, bindings,
sessions) partition authority along the lines users actually grant. The checklist is "Reviewing a
gatekeeper" in `.agents/skills/write-gatekeeper/SKILL.md`. Check every action's `autoApprovable`
verdict against that skill's "Action kinds and auto-approval" policy.

For **new gatekeepers**, enforce that checklist's "Observer protocol" items, including a read-only
`getHistoricalSubresources()` returning `[]`. The current `Gatekeeper` interface enforces none of
them, so code that type-checks can still violate them. For **existing migrations**,
preserve old enforcement until every affected read reports complete requirements and a shipped
kernel importer has committed the complete historical requirements exported through
`getHistoricalSubresources()` to the observer ledger. The current kernel does not consume this
export yet; do not apply the new-gatekeeper empty-history/no-op rule to existing data.

## Logging, errors and secrets

- Server code logs through `@gadgets/observability/logger` with a module-scoped logger and a stable
  dot-separated `component` (plus `vendorId` for gatekeepers). Caught values are passed as `error`.
- Never log or report secrets, prompts, headers, tokens, or request/response bodies. Exception
  messages and stacks reach the external Reporter, so the same rule applies to anything thrown or
  attached as report metadata.
- Gatekeeper UIs must not report errors directly from their own Worker origin; they `postMessage`
  to the Workshop host, which validates the known frame window with origin `null`. Frontend reports
  never convey authority.
- A report's `reportedUserId` is client-supplied and unverified; reject any change that reads it as
  identity or authority. `pageLocation` is origin and pathname only, rebuilt at the boundary rather
  than trimmed: a share link's fragment is a bearer capability and an `href` retains credentials.
- Automatic error capture belongs only in trusted first-party surfaces, never in gadget or
  user-authored code.

The full rules are in `packages/observability/AGENTS.md` (server) and
`packages/error-reporting/AGENTS.md` (frontend).

## Cap'n Web RPC

- Promise pipelining is intentional: an RPC promise may be passed as an argument or used in place of
  a stub without being awaited. **Do not report unawaited RPC promises as floating promises.**
- A `useState` value that holds an `RpcStub` must be wrapped in an object — the setter would
  otherwise call the stub, since every stub is callable at runtime.
- Stubs must be disposed: `stub[Symbol.dispose]()`, a `using` declaration, or a `useEffect` cleanup
  that disposes the stub a component obtained. A stub acquired and never disposed is a server-side
  leak worth flagging.

## Build system (Vite+ tasks)

These break silently rather than loudly, so they are worth flagging even when the diff looks fine:

- A cached `vp` task sees only a built-in environment. A build that reads an env var must *be* a
  task declaring `env`, since `env`/`untrackedEnv` do not exist on a package.json script — and a
  sibling script duplicating a task's command gains nothing from that task's declaration.
- `env` fingerprints the variable's value, not what it points at. A var naming a path outside the
  workspace needs `cache: false` instead (see `workshop-backend`'s `build`).
- A task that reads a path it also writes never caches. New tasks must exclude their own outputs and
  vitest/wrangler scratch paths from `input`; exclusions for the gatekeeper SPA builds have to be
  workspace-wide or the gatekeepers invalidate each other.
- Do not add `incremental` to a tsconfig, do not reintroduce a root script calling
  `pnpm run --recursive`, and do not remove `scripts/assert-workerd.ts` from a package's
  `setupFiles` to make a suite green.
- `pnpm test`'s `--filter=!cloudflare-os` hardcodes the root package name; renaming the root
  silently doubles the scripts suite. Keep it spelled with `=` and unquoted: `cmd.exe` keeps single
  quotes literal, so a quoted filter matches nothing on Windows and the script exits 0 having run
  nothing.
- After an intentional release-manifest change, the golden file must be regenerated
  (`UPDATE_GOLDEN=1 node --test scripts/release/manifest-lib.test.ts`) and its diff reviewed.
- A new installable gatekeeper that takes no third-party OAuth credentials belongs in
  `NO_DEFAULT_CRED_INPUTS`; a spurious default secret input makes it uninstallable in the deploy
  wizard. See `scripts/release/AGENTS.md`.

## Outside contributions

Contributions from outside the team are limited to small changes that are obviously correct and
trivially verifiable by reading the patch. Judge such a PR against that bar — do not ask an outside
contributor to broaden scope, add refactors, or take on adjacent cleanup.

## Do not flag

- Unawaited RPC promises (see above).
- Preview deployments skipped on fork PRs — GitHub withholds secrets from those runs by design.
- `test:run` as a script name; a Vite+ task may not share a name with a package.json script, which
  is also why `pnpm --filter <pkg> build`/`test` do not work here.
- oxlint warnings such as `no-shadow`, which are kept for incremental cleanup and do not block CI,
  and the absence of type-aware lint rules.
- `"singleThreaded": true` in tsconfig — measured as both the fastest and smallest configuration.
- The lack of `baseUrl` in any tsconfig; TypeScript 7 removed the option.

## Ignore during review

- Generated files, which are gitignored and rebuilt: `packages/*/src/generated/**` (`app.txt`,
  `*-configurator-ui.*`, `bundled-blueprints.ts`, `browser-export-runtime.txt`) and any `dist/`.
- `pnpm-lock.yaml`, unless the change is itself a dependency change — then check it against the
  `minimumReleaseAge` supply-chain policy in `pnpm-workspace.yaml`.
- Committed `*.gadget` archives in a blueprint directory, which are opaque data.
- `packages/*/wrangler.jsonc`, generated from the `cloudflare.config.ts` beside it and checked by
  `pnpm configs:check`; review the config instead.
- `packages/*/worker-configuration.d.ts`, which is `wrangler types` output.
