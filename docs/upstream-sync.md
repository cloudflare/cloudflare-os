# Upstream sync

How FieldOS takes changes from [`cloudflare/cloudflare-os`](https://github.com/cloudflare/cloudflare-os).

The model is **cherry-pick inward, never merge wholesale** — the reasoning is in
[`plans/fieldos.md`](../plans/fieldos.md), and rebase-and-replay was considered and rejected there.
This file is the runbook.

## Two facts that shape everything

**Upstream publishes no security signal.** Zero tags, zero releases, zero advisories, no
`SECURITY.md`. There is nothing to subscribe to, so "watch upstream for security fixes" is not
implementable as a subscription. We watch *files* instead.

**Upstream is fast and accelerating.** 345 commits in 90 days, 162 in the last 30. Roughly **35%
touch a file we have modified.** Reading every commit is not sustainable — the process has to be a
cheap filter with a default of SKIP, not a review.

## Setup, once

```sh
git remote add upstream https://github.com/cloudflare/cloudflare-os
git fetch upstream
```

## The conflict surface

Our diff is large but mostly harmless. It decomposes as:

| | conflict risk |
|---|---|
| 45 **added** files (`gatekeeper-oidc`, `fieldos-runtime`, `plans/`, `run-workerd.mjs`) | none |
| 10 **deleted** files | near-zero — upstream touched them 3× in 90 days |
| **30 modified** files that exist upstream | **this is the entire recurring cost** |

Ranked by collision risk (upstream touches in 90d × our lines changed):

| upstream 90d | our Δ | file |
|---|---|---|
| 70 | +48/−0 | `workshop-backend/src/overseer.ts` |
| 55 | +42/−5 | `workshop-shared/src/api.ts` |
| 31 | +109/−7 | `workshop-backend/src/user.ts` |
| 24 | +77/−3 | `workshop-backend/src/server.ts` |
| 18 / 15 | ±4 / ±5 | `gatekeeper-github/src/github.ts`, `-homeassistant/src/homeassistant.ts` — **pure rebrand** |
| 11 / 6 / 3 / … | ±1..4 | `styles.css`, `ContextLibraryPage.tsx`, `AddModelModal.tsx`, … — **pure rebrand** |

**The kernel edits are already shaped correctly.** `overseer.ts` is `+48/−0` — one private method
and two call sites. A new file cannot hold a private method that touches `this.impl.storage`, so
leave it alone. Same for `user.ts` and `server.ts`: overwhelmingly additive, which is exactly what
the workflow doc prescribes.

**The avoidable friction is the rebrand strings.** Nine of the modified files are one- to five-line
brand swaps sitting in files upstream edits constantly — `github.ts` takes 18 upstream touches for
4 changed lines. They carry most of the collision probability for none of the fork's value. The
cheap win: revert the *doc-comment* rebrands in `api.ts` (a file upstream touched 55 times in 90
days). They are comments; they change nothing a user sees.

## Triage

Apply in order, **stop at the first match**. Designed so almost every commit exits at rule 1 or 2
without a judgement call.

| # | Test | Action |
|---|---|---|
| 1 | Touches only files absent from our tree (deleted connectors, `.gitlab-ci.yml`) | **SKIP** — not applicable |
| 2 | Touches no watched file and nothing we modified | **SKIP** — divergence accepted, batch-record |
| 3 | Auth, session, token, crypto, SSRF, sandbox escape, `globalOutbound`, approval gating, capability minting | **PORT** — security fast path |
| 4 | Touches `workshop-backend`/`workshop-shared` **and** a file we modified | **PORT** — kernel correctness is why we soft-fork |
| 5 | Touches a file we modified only via rebrand strings | **ADAPT** — take the hunk, re-apply the brand |
| 6 | Frontend-only, nothing we modified | **SKIP until batched** |
| 7 | Dependency bump / lockfile | **SKIP** — we are airgapped and pin independently |

Rule 3 is the only genuine judgement call, and it is deliberately biased toward over-porting.

## The runbook

**Check** — weekly, or when the CI watcher files an issue:

```sh
git fetch upstream
git log --oneline --reverse <high-water-mark>..upstream/main -- $(tr '\n' ' ' < docs/upstream-watch.txt)
```

**Dry-run in a throwaway worktree**, never in the working tree:

```sh
git worktree add --detach /tmp/port HEAD
git -C /tmp/port cherry-pick -x <sha>
git -C /tmp/port status --porcelain | grep '^UU'   # the conflict list
git worktree remove --force /tmp/port
```

**Port for real:**

```sh
git checkout -b port/<sha7>-<slug>
git cherry-pick -x <sha>      # -x records the upstream sha and keeps the original author
# resolve, then run the gate
pnpm gate
git cherry-pick --continue
```

Then record it, PR, and merge `--no-ff` as usual.

## The gate

See [`testing.md`](./testing.md). In short: `pnpm lint`, `pnpm test`, the standalone-workerd tiers,
and the capnp translatability check. Upstream's own CI proves nothing here — it runs against
Cloudflare's platform, so it says nothing about `localDisk`, Worker Loaders, or our KV/R2 services.

**For a rule-3 security port, the control needs a test that fails without the patch.** A security
fix ported without a failing-first test is unverified.

## Recording

An append-only `docs/upstream-ports.md` with a **high-water mark** at the top.

The mark is the load-bearing part: it makes the next pass `git log <mark>..upstream/main` instead of
re-triaging 345 commits. It cannot be derived — **cherry-picking does not create ancestry**, so
`merge-base` stays pinned at the original fork point forever and would keep re-including everything
already ported.

Record skips as **ranges**, not per-commit. At 40–70 commits/week, per-commit skip rows make the
file unreadable within a month. A skipped commit still matters — otherwise it gets re-triaged
forever.

## Security fast path

There is no advisory feed, so detection is structural:

- **Detect** via the weekly CI watcher plus triage rule 3. The watch list deliberately includes
  every security chokepoint we have modified: `user.ts` (the capability chokepoint), `server.ts`
  (`authenticate`/`abortSession`), `auth/login-flow.ts`, `mcp-shared/src/endpoint.ts` (SSRF).
- **SLA:** triage within 1 business day of the watcher issue; port or explicitly risk-accept within
  5. A skip needs a written reason — an airgapped customer cannot patch themselves.
- **Owner:** the repo maintainer. With no advisory feed, an unowned process degrades to nobody
  looking.
- **Escalation:** because customers are airgapped and offline, a ported security fix needs a
  **release and a customer notification**, not just a merge to `main`. This is the step most likely
  to be forgotten.

## CI watcher

A scheduled weekly workflow that fetches upstream and opens an issue **only if** the file-scoped log
is non-empty. Scoping is what makes it signal rather than noise: unscoped it would fire on 40–70
commits a week; scoped, it is roughly 3 issues a month, each genuinely needing a decision.

Generate the watch list in the job from
`git diff --name-only --diff-filter=M $(git merge-base HEAD upstream/main) HEAD` rather than
maintaining it by hand — otherwise someone edits a new upstream-mergeable file, forgets the list,
and the watcher goes quiet on exactly the file that needed watching.

## Do this now, not later

Divergence today is **one unported commit**. At 35% collision and 40–70 commits a week, a six-month
deferral makes `overseer.ts` and `user.ts` ports materially harder. This is the cheapest this will
ever be.
