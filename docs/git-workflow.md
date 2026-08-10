# Git workflow

How we work on FieldOS. This is a fork of Cloudflare OS, which shapes several of the rules below —
see [Upstream](#upstream).

## The short version

1. **One branch per concern.** Start it before the first edit, not after.
2. **Never commit to `main`.** Branch, PR, merge.
3. **A commit says *why*.** The diff already says what.
4. **Verify before committing**, and record what you ran in the commit message.
5. **Log substantive work** in `plans/fieldos-log.md`.

## Branches

Name them `<type>/<short-slug>`:

```
feat/gatekeeper-oidc          auth/session-expiry
fix/usage-quota-gating        chore/rebrand-fieldos
docs/git-workflow             refactor/gatekeeper-shared
```

**Branch before you start.** The common failure is starting work on the branch you happen to be on,
noticing three commits later that two of them are unrelated, and having to choose between messy
history and branch surgery. Deciding "this is a separate concern" costs nothing beforehand and is
annoying afterwards. This has already happened once on this repo — Phase 0's rebrand, the usage-quota
change and the plan docs all landed on `phase0-rebrand` because nobody switched branches.

One branch should answer one question in review. If you cannot describe it in a sentence without
"and", it is two branches.

## Commits

Subject line in the imperative, under ~72 characters, no trailing period:

```
Decouple usage quotas from Cloudflare billing
```

not `Fixed stuff` or `WIP` or `changes`.

The body carries the reasoning. Assume the reader has the diff and does not have your context. In
particular, write down:

- **Why this approach**, and what you rejected. This is the highest-value content in a commit
  message — it stops the next person re-litigating a settled question. A good example from this
  repo's history explains why the frontend keys on an existing `unlimited` flag rather than a new
  one.
- **What you verified.** Not "tested" — the actual commands and results.
- **What you deliberately did not do**, if a reviewer would otherwise wonder.

Commits should build and pass tests on their own. A reviewer bisecting a regression should never
land on a commit that does not run.

Every commit ends with:

```
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

## Verify before you commit

The gate CI enforces:

```bash
pnpm lint          # oxlint + recursive tsc --noEmit
pnpm test
```

Narrow it while iterating:

```bash
pnpm --filter @gadgets/workshop-frontend run types:check
pnpm --filter @gadgets/workshop-backend  run types:check
pnpm --filter @gadgets/workshop-frontend run test
```

`oxlint` currently emits ~64 warnings that predate this fork. Warnings do not block; **errors must
be zero**. Check the exit code rather than eyeballing output — a piped `tail` hides it:

```bash
pnpm lint:check > /tmp/lint.txt 2>&1; echo "exit=$?"
```

State the results in the commit message. "Verified: frontend + backend types:check clean, 118
frontend tests pass, oxlint 0 errors" is worth more than "tested".

## Deleting code

This repo has two traps that have already produced wrong answers.

**Resolve imports; do not grep names.** `ChatMessage.tsx` had zero importers but 35 apparent
references, because the name collides with the `AiChatMessage` API type. Grep tells you about
strings; you need to know about *modules*. Resolve each relative specifier against the filesystem
and check what actually points at the file.

**Delete clusters as a unit.** Dead files usually reference each other, so each looks "used" in
isolation. Verify the whole set has no importers from outside the set, then remove it in one commit.

## Traps in this repo

Things that have already cost time here. Each is cheap to avoid once known.

**Workerd-only APIs break under the Node test runner.** `crypto.subtle.timingSafeEqual` and
`Uint8Array.prototype.toHex` exist in workerd and not in the Node that most packages' vitest runs
under. If you need one in code that is unit-tested, write a portable implementation — a *real* one,
not a test stub — or move the package to the workers pool (`@cloudflare/vitest-pool-workers`, as
`workshop-backend` and `gatekeeper-scheduler` do). Note the copies of `constantTimeEqual` scattered
across the connectors are untested everywhere, for exactly this reason.

**A new deployable package needs three things beyond its own source**, or it ships broken:
1. `deploy-inputs.json` — without it the package inherits `DEFAULT_CRED_INPUTS`
   (`CLIENT_ID`/`CLIENT_SECRET`). Since the deploy wizard blocks Install on unfilled secret inputs,
   the wrong shape makes a connector **uninstallable**.
2. Only `kind: "secret"` produces a binding (`manifest-lib.mjs`). A `kind: "var"` input renders in
   the wizard and reaches the worker as *nothing*.
3. A fixture bundle under `scripts/testdata/fixture-bundles/<pkg>/`. The golden manifest test fails
   closed without one — deliberately, so a new worker cannot skip the deploy contract silently.
   Regenerate the golden with `UPDATE_GOLDEN=1 node --test scripts/release-manifest.test.js` and
   **read the diff**.

**A gatekeeper exposing a Session type needs `types.txt` as a *symlink*** to `src/types.d.ts`, not
a copy (`.agents/skills/write-gatekeeper/SKILL.md`). A copy silently goes stale.

**`AdminConfig` must not hold authentication or authorization settings.** They stay env-driven so a
compromised admin session cannot weaken them (`admin-config.ts`, `AGENTS.md`). Where an admin
genuinely needs a knob — session timeouts, say — give the env var a *ceiling* the admin may tighten
within, never exceed.

## Logging work

Substantive changes get an entry in `plans/fieldos-log.md`, appended at the bottom. Design decisions
update `plans/fieldos.md` as well.

The log is append-only: **corrections are new entries, not edits.** A record showing that an earlier
claim was wrong and how it was caught is more useful than one that has been quietly tidied. There is
already an entry walking back an overstated "confirmed from primary source" claim — that entry is
doing its job.

Record what was *verified* rather than what was assumed, and cite `file:line` for anything a reader
would otherwise have to hunt for.

## PRs

Push the branch and open a PR even when merging it yourself — the PR is where CI runs and where the
change is reviewable later.

```bash
git push -u origin feat/my-thing
gh pr create --fill
```

Merge with `--no-ff` so the branch remains visible as a unit:

```bash
git checkout main && git merge --no-ff feat/my-thing
```

Delete the branch after merging. `git branch -d` (lowercase) refuses to delete unmerged work;
prefer it to `-D`.

## Upstream

FieldOS is a **soft fork** of Cloudflare OS, and the merge model is deliberate: **cherry-pick
inward, never merge upstream wholesale.** Rebase-and-replay was considered and rejected — replaying
our patches onto a fast-moving 9,500-line kernel and 44,000-line frontend is an unbounded recurring
cost, and deleting ten connectors diverges history immediately. The reasoning is in
`plans/fieldos.md`.

**The runbook is [`upstream-sync.md`](./upstream-sync.md)** — cadence, the triage decision
procedure, the conflict surface with real numbers, and the security fast path. Ported and
deliberately-skipped commits are recorded in [`upstream-ports.md`](./upstream-ports.md).

Note an earlier version of this section said to "watch upstream for security fixes". That is not
implementable as written: upstream publishes **no tags, releases or advisories**, so there is
nothing to subscribe to. We watch a scoped set of *files* instead.

Which packages remain upstream-mergeable, and which we own outright, is tabled in the same document.
For mergeable packages — `workshop-backend`, `workshop-shared`, `router`, `mcp-shared` — **keep
diffs surgical.** Every line changed there is a line to reconcile on every future port. Prefer
adding a new file over editing an existing one where the choice exists.

Cherry-picked upstream commits keep their original author and message, with a note about why:

```
git cherry-pick -x <sha>     # -x appends the source commit hash
```

**Gate every upstream cherry-pick on our own workerd integration suite**, not upstream's CI.
Upstream tests against Cloudflare's platform; we run standalone `workerd`, and they are not the same
environment. This is the parity risk recorded in `plans/fieldos.md`.

## Things not to commit

- Secrets, tokens, `.dev.vars`, anything under `.wrangler/`
- Generated output — `src/generated/`, `worker-configuration.d.ts`, `dist/`
- Commented-out code. Git remembers it; delete it.
- Unrelated formatting churn. It buries the real change in review.

## Kernel changes

`workshop-backend` and API changes in `workshop-shared` are held to a higher bar — reviewers read
every line. Keep those diffs small, doc-comment every exported member of the `workshop-shared`
public API, and split large changes so kernel commits can be reviewed apart from UI. See the
repository `CLAUDE.md` for the full standard.
