# Review Guidelines

Guidance for AI reviewers reading pull requests in this repository. For what changes are
accepted at all, see [CONTRIBUTING.md](./CONTRIBUTING.md).

Before reviewing, read the package guide (`AGENTS.md` › Package guides) for every directory the diff
touches. Cite a rule from the file you read it in.

Review priority, highest first: the kernel bar, capability-security invariants, secret leakage
through logs and errors, then everything else.

## How to report

Start the title of each finding with exactly one tag: `[P0]`, `[P1]`, `[P2]` or `[P3]`. A finding
entry with no tag counts as P1. When rules give different severities for one finding, use the
highest.

End the review summary with a standalone line `MERGE-CONFIDENCE: <0-10>`: how sure you are that a
careful maintainer on this team would merge this PR as it is. Score the change, not the author. With
no such line, or a score outside 0 to 10, the PR goes to a person.

- **[P0]**: data loss, a security hole, or a broken build or deploy. Blocks an automatic merge.
- **[P1]**: a failure that can occur, which breaks a feature, loses or corrupts stored state, or
  blocks a user's work; or a wrong assumption about a data model. Blocks an automatic merge.
- **[P2]**: a defect with a smaller or recoverable impact, or a rule violation. The author should
  fix it. Does not block.
- **[P3]**: a nit. Never blocks.

For every finding:

- A P0 or P1 gives the file and line, a sequence that can occur, and its result. The sequence can be
  the steps of a user, the actions of an attacker, a Durable Object reset, or an interleaving of
  concurrent calls. If you cannot write such a sequence, use P2 or lower.
- Severity follows impact. A severity in parentheses next to a rule is the default for that rule.
  Use a higher severity when the impact is higher.
- Write one finding per root cause. List the other places where it occurs in the same finding.
- Do not repeat a finding that the author answered, fixed or declined, in any round. Reply again
  only with new evidence.
- Mark a problem that existed before this diff as "pre-existing". It is P3, unless the diff makes it
  reachable or worse. This is the only rule that lowers a severity below its impact.
- Rounds 1 and 2: review the full diff. Round 3: review only the commits since your last review.
  After round 3: post only the list of findings that are still open, then stop.

## Needs a person

When a change needs human judgment, add a standalone line to the review summary that starts with
`NEEDS-A-PERSON:` and says what to decide. Use it for:

- a design choice: a new mechanism, abstraction, pattern or public API shape;
- capability semantics: authority, ambience, approval, sharing;
- text that agents read: `types.d.ts`, tool descriptions, prompts;
- a fact or decision the diff cannot settle: whether a migration has shipped, whether stored records
  in an older shape still exist, or whether to drop handling for them (no release history in this
  repository tells you);
- a possible P0 or P1 in these areas that you are not sure about.

If a concern in this list has no concrete failure (a question of design or wording), also report it
as a [P2] finding. The flag can only send a PR to a person. It never lets a PR merge, and it does not
replace a severity tag.

## What this team blocks on

Report a failure in these areas at P1, or P0 for data loss or a security hole.

- **Approval bypass and ambient authority.** See "Capability-based security".
- **Agent-facing text.** `packages/gatekeeper-*/src/*types.d.ts`, tool descriptions and prompts
  contain only what the agent needs to use the API: no text about approvals, simulation, the UI or
  gatekeeper internals. A create, send or update action returns what it made. A change does not
  send very large text to the agent on each turn.
- **Persisted state and tokens.** The code misreads or loses data that the current or an earlier
  release wrote. A revoked or expired token shows as active or still works. A credential is used
  without a check. An `await` between a check and the write that depends on it lets another caller
  change the result.
- **Durable Object resets.** Resets occur in normal use. Flag an external write whose intent is not
  persisted before the call and reconciled later (for example by an alarm), a cached stub to another
  Durable Object that is not replaced after it breaks, and writes after `abort()` or not settled
  before it.
- **Hand-rolled auth.** OAuth, token, JWT or connect-flow code written by hand where
  `gatekeeper-kit` or a shared helper exists. Name the helper.
- **Deploy and build breakage.** A Worker config that cannot deploy. A gatekeeper entry module that
  does not export each entrypoint its config names, or exports a value that is not an entrypoint. A
  removed export that another package or the internal repo still uses. An edit, reorder or removal
  of a storage or Durable Object migration that exists on the base branch; if the PR says it has not
  shipped, also write `NEEDS-A-PERSON`.
- **Cost in storage paths.** A full table scan on a common request path, a quadratic loop, a read of
  the same state in each loop iteration, or a whole result buffered when a stream or cursor works.
  Suggest an index or one `Promise.all()`.
- **Paid API spend.** In a gatekeeper that calls a pay-per-use API (for example X or Web Search), a
  call that skips the read budget or makes extra billed requests. Read that package's AGENTS.md.

## High-scrutiny areas

`packages/workshop-backend/` and the public API in `packages/workshop-shared/src/api.ts` are the
**kernel**. Maintainers read every line, so hold them to a higher bar than UI or gatekeeper code:

- Every exported member of the `workshop-shared` public API needs a doc comment: types, consts and
  functions, not just interfaces.
- Reject a hand-written interface that mirrors an RPC interface plus an `as unknown as` cast. Derive
  from the real type instead, or rethink the design.
- Prefer reusing an existing mechanism over adding a parallel one; say which existing mechanism the
  change should have used.
- A large kernel change should be split by concern into separate PRs, and at minimum grouped into
  commits that let `workshop-backend`/`workshop-shared` be reviewed apart from UI. Flag PRs that
  bundle both.

## Capability-based security

- Every side-effecting gatekeeper action goes through the approval queue. A gatekeeper never
  decides that an action needs no approval. Flag any path that performs a write without it.
- A resource becomes "ambient" (auto-injected) only through user or admin configuration. A
  gatekeeper must never assert its own ambience.
- Capability semantics are literal. Before you report a "leak", check whether the holder received
  that authority on purpose (for example, a build collaborator has the whole workspace). If you
  cannot tell, write `NEEDS-A-PERSON` and say in the finding that the grant may be intended.
- `packages/workshop-backend/AGENTS.md` (Admin settings): the `#assertResourceEnabled()` mint
  chokepoint, env-var-only auth config (`AUTH_GATEKEEPERS`, `DISABLE_PASSWORD_AUTH`), and
  `AdminSettings` as the only writer of `AdminConfig`. `packages/mcp-shared/AGENTS.md`: the
  `tools.ts` trust boundary and `sdkFetch(...)` for SDK OAuth. Flag a change that breaks them.
- Other code reads admin settings through `readAdminConfig(env)`. The one exception is
  `AdminApiImpl`, which reads the authoritative config for the audit log's retention in
  `listAdminAudit()` and `getAdminAuditStats()`.
- `ADMIN_AUDIT_RETENTION_MIN_DAYS` is env-driven, like auth config. Flag code that enforces or
  prunes with `adminAuditRetentionDays` without `adminAccessPolicy()`.
- A new `AdminSettings` mutator takes an `AdminSettingActor` and records through
  `#mutateAdminConfig()`, or records explicitly before any other write.
- `cf-os api` sends `User-Agent: cf-os-api/<version>`. Except on a local instance
  (`WORKSHOP_ENVIRONMENT` `development` or `test`, set only by `pnpm dev-server` and the integration
  harness), the Workshop lets such a session act only as a deployment admin. A client can send any
  User-Agent, so this is a speed bump, not authorization; the API's own checks are the boundary.
  Flag code that grants anything by User-Agent, and any deployment config that sets
  `WORKSHOP_ENVIRONMENT`.
- `packages/bundled-blueprints/blueprints/`: a `blueprintId` is never edited after deploy. Installs
  and promotion are keyed on it, so a rename orphans the old entry.

## Gatekeepers

Beyond correctness, pressure-test the agent-facing API
(`packages/gatekeeper-*/src/*types.d.ts`): does the shape make sense, does it cover the most common
user stories, what would you do differently? Check that the seams (resource granularities, bindings,
sessions) partition authority along the lines users grant. The checklist is "Reviewing a
gatekeeper" in `.agents/skills/write-gatekeeper/SKILL.md`.

- Check every action's `autoApprovable` verdict against that skill's "Action kinds and
  auto-approval" policy.
- A new gatekeeper meets that checklist's "Observer protocol" items, including a read-only
  `getHistoricalSubresources()` that returns `[]`. The `Gatekeeper` interface enforces none of them,
  so code that type-checks can still break them.
- An existing gatekeeper's migration keeps the old enforcement until every affected read reports
  complete requirements and a shipped kernel importer has written the complete historical
  requirements from `getHistoricalSubresources()` to the observer ledger. The kernel does not read
  that export yet, so do not apply the new-gatekeeper empty-history rule to existing data.
- A fan-out where one failed item must not fail the rest (a catalog, a menu, a list built from many
  sources) uses `Promise.allSettled`, not `Promise.all` (P2; P1 when one failing source empties the
  list for all users).

## Logging, errors and secrets

- Server logging and issue reporting follow `packages/observability/AGENTS.md`; frontend error
  reporting follows `packages/error-reporting/AGENTS.md`.
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

## Cap'n Web RPC

- Promise pipelining is intentional: an RPC promise may be passed as an argument or used in place of
  a stub without being awaited. **Do not report unawaited RPC promises as floating promises.** Do
  flag an RPC promise put inside an object that a method returns: Workers RPC cannot serialize an
  `RpcPromise`.
- A `useState` value that holds an `RpcStub` must be wrapped in an object. The setter would
  otherwise call the stub, since every stub is callable at runtime.
- Dispose a Cap'n Web stub that the code gets from an RPC call and owns: `stub[Symbol.dispose]()`,
  a `using` declaration, or a `useEffect` cleanup that disposes the stub a component got. A stub
  that is never disposed is a server-side leak (P2).
- Do not ask to dispose a Durable Object stub: it has no disposer, and `using` on it throws "object
  not disposable". A `Fetcher` needs no disposal.
- A stub received as an RPC parameter is disposed when the call returns. Code that keeps it after
  the call (in a field, a map or a closure) must keep a `.dup()` of it.

## Build system (Vite+ tasks)

These break silently, so they are worth flagging even when the diff looks fine:

- A cached `vp` task sees only a built-in environment. A build that reads an env var must *be* a
  task declaring `env`, since `env`/`untrackedEnv` do not exist on a package.json script, and a
  sibling script duplicating a task's command gains nothing from that task's declaration.
- `env` fingerprints the variable's value, not what it points at. A var naming a path outside the
  workspace needs `cache: false` instead (see `workshop-backend`'s `build`).
- A task that reads a path it also writes never caches. New tasks must exclude their own outputs and
  vitest/wrangler scratch paths from `input`; exclusions for the gatekeeper SPA builds have to be
  workspace-wide or the gatekeepers invalidate each other.
- A test entry point (the `test` task or a `test:run` script) that imports a gitignored generated
  file must generate it first or depend on the task that generates it (P2).
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

CONTRIBUTING.md accepts only small, trivially verified PRs that fix a problem. If an outside PR is
more than about a dozen lines, or has low value (for example, a typo fix), say that CONTRIBUTING.md
asks for it to be closed, and stop. Otherwise judge it against that bar. Do not ask an outside
contributor to broaden scope, add refactors, or take on adjacent cleanup.

## Quality rules people enforce

Report these at P2 in kernel files and at P3 in other files.

- A comment gives intent, a contract, or a rejected alternative. Flag a comment that restates the
  code, hedges, or describes the change ("now", "updated to", "this PR").
- Flag diff lines that change only comment style (`//` to `/**` or back), formatting, or the words
  of a correct comment, and files unrelated to the PR's purpose. Ask to revert them. Use `//` for
  inline comments and `/** */` only for exported API docs.
- Flag a test that pins implementation (many mocks to check wiring, assertions on private calls)
  and does not check behavior that a user sees. Prefer one test through the public surface.
- Flag a new file for one small helper or one declaration. Put a complex part behind one exported
  function in one file.
- Flag a vague name and suggest a precise one.
- Flag code that the diff adds and nothing uses, and logic that duplicates an existing helper.
- A new migration for a feature whose earlier migration may not have shipped: write
  `NEEDS-A-PERSON` so a maintainer can decide whether to merge the two.

## Do not flag

Each item below covers only what it names. Its "still flag" part always wins.

- Unawaited RPC promises used as arguments or stubs (see "Cap'n Web RPC").
- Preview deployments skipped on fork PRs. GitHub withholds secrets from those runs by design.
- `test:run` as a script name; a Vite+ task may not share a name with a package.json script, which
  is also why `pnpm --filter <pkg> build`/`test` do not work here.
- oxlint warnings such as `no-shadow`, which are kept for incremental cleanup and do not block CI,
  and the absence of type-aware lint rules.
- `"singleThreaded": true` in tsconfig, measured as both the fastest and smallest configuration.
- The lack of `baseUrl` in any tsconfig; TypeScript 7 removed the option.
- Memory or CPU exhaustion in one call, on input that the caller of that call (the user's agent)
  chose: the call fails and the isolate restarts. Still flag memory that grows across calls (a cache
  or map on a long-lived object), input that is stored or comes from another user, a third party or
  the web, a call that skips a limit the code already has, and a normal workload that fails.
- Missing expiry or garbage collection in kernel Durable Object storage for copies of data that can
  be dropped and pulled again from a gatekeeper or a git remote, when nothing reads a stale copy and
  no size limit is hit. Still flag growth of authoritative records, records over a size limit, and
  stale entries that users or code read.
- A race whose only result is one notification for an event that happened before the user changed a
  notification setting (for example, a mute set within seconds of a task ending).
- A short error during a rollout that one refresh or retry fixes and that changes no stored data:
  an old browser client against a new server, or two of our Workers on different versions. Still
  flag reconnect loops, failures that a refresh does not fix, native app clients, and stored effects.
- Type checks that `@validateRpc()` already makes on a class that has it (still flag a missing
  annotation), and range checks on a value from the agent or user that the code passes unchanged to
  a third-party API, when a bad value only makes that one call fail and nothing is stored.
- Defensive code for a value that only our own code produces, after you check each producer in
  the repository. Values from gatekeepers (including the internal repo), other Workers, storage
  written by an earlier release, third parties or users are not covered.
- A test that fails only on a local clean checkout when the CI job that runs that same test passed
  on the head commit. Still flag failures from task caching or a missing generated file.
- A bug that needs an admin to switch the deployment between modes and back (for example, AI
  Gateway mode), or a user to set advanced model settings that contradict each other, when nobody
  has reproduced it. A test, a script or a report that shows the failure is a reproduction.
- A claim that a crash or reset can split two successful writes to the same Durable Object's storage
  with no `await` between them. Still flag a throw after an earlier write (the earlier write stays;
  use a transaction), and writes to different objects, KV, R2 or external services.
- A Cap'n Web stub disposed twice. Disposal is idempotent.
- An HTTPS-only or no-credentials check that does not re-check a redirect, on a fetch of an
  agent-supplied URL that carries no credentials. The check restricts the agent, not the site.

## Ignore during review

- Generated files, which are gitignored and rebuilt: `packages/*/src/generated/**` (`app.txt`,
  `*-configurator-ui.*`, `bundled-blueprints.ts`, `browser-export-runtime.txt`) and any `dist/`.
- The contents of `pnpm-lock.yaml`. Still check that each package.json dependency change has a
  matching lockfile change, and check dependency changes against the `minimumReleaseAge`
  supply-chain policy in `pnpm-workspace.yaml`.
- Committed `*.gadget` archives in a blueprint directory, which are opaque data.
- `packages/*/wrangler.jsonc` when a `cloudflare.config.ts` sits beside it: it is generated from that
  file and checked by `pnpm configs:check`; review the config instead.
- `packages/*/worker-configuration.d.ts`, which is `wrangler types` output.
