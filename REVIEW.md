# Review Guidelines

Guidance for AI reviewers reading pull requests in this repository. For how to build, test and
work in the repo, see [AGENTS.md](./AGENTS.md); for what changes are accepted at all, see
[CONTRIBUTING.md](./CONTRIBUTING.md).

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
- `getGatekeeperClassFor()` in `packages/workshop-backend/src/user.ts` (not the same-named vendor
  method each gatekeeper implements) is the single chokepoint where disabled gatekeepers and
  resources are enforced before a capability is minted. Flag any new path that mints a gatekeeper
  capability without going through it.
- Authentication and authorization config (`AUTH_GATEKEEPERS`, `DISABLE_PASSWORD_AUTH`) is
  deliberately env-var driven in `auth/config.ts` and must **not** move into `AdminConfig`, so a
  compromised admin session cannot change it. Reject changes that relocate it.
- `AdminSettings` is the only writer of the authoritative `AdminConfig`. Other code reads through
  `readAdminConfig(env)`.
- In `packages/mcp-shared/`, `tools.ts` is the trust boundary: nothing outside it may read a tool's
  annotations, a tool is an observation only when the server declares `readOnlyHint: true`, and
  auto-applying a write additionally requires a `vetted` endpoint. Every SDK OAuth operation must be
  given `sdkFetch(...)` so endpoint and SSRF checks survive redirects.
- `format-blueprints/`: a `blueprintId` is never edited after deploy — installs and promotion are
  keyed on it, so a rename orphans the old entry.

## Logging, errors and secrets

- Server code logs through `@gadgets/backend-utils/logger` with a module-scoped logger and a stable
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
- `pnpm test`'s `--filter '!cloudflare-os'` hardcodes the root package name; renaming the root
  silently doubles the scripts suite.
- After an intentional release-manifest change, the golden file must be regenerated
  (`UPDATE_GOLDEN=1 node --test scripts/release/manifest-lib.test.ts`) and its diff reviewed.
- A new installable gatekeeper that takes no third-party OAuth credentials belongs in
  `NO_DEFAULT_CRED_INPUTS`; a spurious default secret input makes it uninstallable in the deploy
  wizard.

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
  `*-configurator-ui.*`, `format-blueprints.ts`, `browser-export-runtime.txt`) and any `dist/`.
- `pnpm-lock.yaml`, unless the change is itself a dependency change — then check it against the
  `minimumReleaseAge` supply-chain policy in `pnpm-workspace.yaml`.
- Committed `format-blueprints/*.gadget` archives, which are opaque data.
