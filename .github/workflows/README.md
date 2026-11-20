# Workflows

Notes on the workflows that need more than their own file to operate. Each file's header comment
is the design record; this covers what lives outside the repository.

## Preview deployments

[`preview.yml`](preview.yml) deploys a preview of each pull request from a branch in this
repository, on the Cloudflare account the `CLOUDFLARE_ACCOUNT_ID` variable names. It needs a
Cloudflare API token that can create Workers and storage, so it never runs for a pull request from a
fork: GitHub withholds secrets from those runs, and a maintainer deploys one when the change needs
manual review. The file's header explains why its triggers must stay as they are.

## Risk review

[`risk-review.yml`](risk-review.yml) posts the `risk-review` check run on each pull request into
`main` and on each merge group, as the risk-review GitHub App. It rates each change by band (low,
medium, high) and area, and decides whether it could merge without a person; the rules are in
[`scripts/risk-review-policy.ts`](../../scripts/risk-review-policy.ts) and
[`scripts/risk-review.ts`](../../scripts/risk-review.ts). It reads three policy files from the base
commit: [`maintainers`](../maintainers), [`automerge-bands.json`](../automerge-bands.json) and
[`automerge-escape-files.json`](../automerge-escape-files.json).

It runs only from `main`'s definition, through `workflow_run` (when a producer workflow, CI or
the review relay finishes) and `issue_comment`, and never checks out or runs pull request code.
[`risk-review-trigger.yml`](risk-review-trigger.yml) only relays pull request, review and merge
group events to it; the gate decides a merge group only when the merge queue lists its commit.
Producer workflows (reviewer verdicts, rung 1 proofs, band evidence) upload one JSON artifact each
and post nothing. The two verdicts are Bonk's (`bonk-pr.yml`, run "Bonk PR Review", artifact
`automerge-verdict-bonk`) and our Opus runner's (`review-verdict.yml`, `automerge-verdict-opus`).
Bonk's verdict artifact and `review-verdict.yml` land in #972, `automerge-proofs.yml` in #987, and
`automerge-evidence.yml` in #988. Until then the gate finds no run of them and counts every input they
would give as absent, so every pull request goes to a person. The gate accepts an artifact only from a successful `pull_request` run of the
expected workflow file on the pull request's head commit and branch, in this repository, created
after the pull request's base last changed (and none counts until a push follows that change,
since GitHub rebuilds the merge ref in the background); and no run counts once another pull request from the same
branch, open or closed, has had another base at any point (read from its base-change history), since
its runs use that base's copy of the workflows.
The run whose latest
attempt started last wins even when it failed. Dependabot pull requests get no deployed preview:
their smoke runs in workerd, without secrets, in Automerge evidence. A rung 1 proof also counts only
for the commit the pull request would land on (its base, or the queue's commit under it in a merge
group): `proof-actions` and `proof-deps` only while the files they read at their base (the touched
workflows; `pnpm-workspace.yaml` and `pnpm-lock.yaml`) are the same readable blobs there, and
`proof-equivalence` and `proof-tests` only when made against that commit with a head that contains
it. No proof admits a change to text that people or agents read (any Markdown file, `docs/`,
`plans/`, `.agents/`): it leaves the build byte-identical, so it can only be AI-scored. Edits under
`.agents/skills/` are scored like code; a symlink there, and every other instruction file
(`REVIEW.md`, any `AGENTS.md`, the rest of `.agents/`), always needs a person. The escape raise
ignores lockfiles and Markdown, `docs/` and `plans/` outside `.agents/`.

A change that may drop Durable Object data always needs a person. The gate reads it from the
parsed `wrangler.jsonc`, the file Wrangler and the release manifest deploy from, and treats its
migrations as append-only: Wrangler applies those after the deployed tag, by position, so a list
that is reordered, retagged, edited or cut can run an old deletion again. A person is needed when:

- the head's migrations do not start with the base's;
- an appended migration does anything but add classes (`deleted_classes`, `renamed_classes`,
  `transferred_classes`, an operation the gate does not know);
- the Worker's `name` changes;
- a `wrangler.jsonc` is removed or renamed, even to another directory;
- the file is not in the form the generator writes (`//` lines, then strict JSON);
- the change touches any other Wrangler config (`wrangler.json`, `wrangler.toml`, `.wrangler/`),
  which Wrangler would prefer or follow.

The gate does not read `cloudflare.config.ts`: it takes effect only through the generated file
(`pnpm configs:check`, part of `Lint`, fails while the two differ). A change to either file still
needs `proof-migrations`.

`automerge-bands.json` sets the mode. It ships in `shadow` with every band closed: the check
mirrors today's rule (`reviewDecision` is `APPROVED`), is not required, and records the decision it
would have made as JSON at the top of its output, including both reviewers' scores whenever their
verdicts' own conditions hold (`eligible_scores`).
[`scripts/risk-review-report.ts`](../../scripts/risk-review-report.ts) rebuilds the calibration
table from those records. With `--calibrate` it reads every record on every head of each merged pull
request and prints, for each area, band, reviewer configuration and threshold from 10 to 1, the
pull requests the gate would have merged, the misses among them (a maintainer comment or
non-approving review followed by a commit, a change request, or a revert or a pull request naming it
within 14 days), and the run of clean ones since the last miss. A band opens at threshold 10, and
only once that run reaches 60; the threshold is then lowered a step at a time as the record
supports it, and a change to either reviewer's configuration starts the run again. In `enforce` mode
the check reports the gate's own rule, and the App approves (when `app_approvals_count` is true) and
enqueues a pull request only when its band is open, the gate decided it can merge without a person,
and it is not a draft. A change to
any of these files, or to anything else under `.github/`, always needs a person, with one exception:
a Dependabot Actions bump that only modifies workflows the gate does not read (none of the producer
workflows, `risk-review.yml` or `risk-review-trigger.yml`; `GATE_WORKFLOWS` in the script), and whose
`proof-actions` from `automerge-proofs.yml` holds. That proof requires full-SHA pin swaps, an
allowlisted publisher, and touched workflows that hold no credential. For both Dependabot routes
(this one and `proof-deps`), the gate itself also requires every commit on the pull request to be
authored by `dependabot[bot]`, committed by `web-flow` and verified by GitHub.

### Setup

An organization owner, or a GitHub App manager, does this once.

1. **The app.** Create a GitHub App owned by the organization, with its webhook inactive, the
   repository permissions *Checks: Read and write*, *Pull requests: Read and write*, *Contents:
   Read*, *Actions: Read* (to read producer runs and artifacts) and *Merge queues: Read and write*
   (to enqueue), and installation limited to this account. Install it on this repository only. Set the repository
   variable `RISK_REVIEW_APP_ID` to its App ID.
2. **The key.** Generate a private key and store it as the secret `RISK_REVIEW_APP_PRIVATE_KEY` in
   the `risk-review` environment, with no reviewers and deployment branches limited to `main`. Do not
   add `gh-readonly-queue/main/*`: anyone who can push can create a branch with that name. Until the
   key exists the workflow fails at the token step and posts nothing; there is no fallback to the job
   token.

   **Never store the key as a repository secret.** A workflow a pull request adds can read those,
   and could then post a passing check run or an approval as the app.
3. **The `main` ruleset.** Leave it as it is in shadow mode, and do not require `risk-review`.
   Enforcing is a later team decision: require the `risk-review` check with the risk-review app as
   its source (GitHub needs a recent check run from the app to offer it), and add a merge queue.
   Before relying on App approvals, approve a real draft pull request as the App and confirm the
   ruleset counts it, then set `app_approvals_count`. Stale-approval dismissal is not needed: the
   gate counts only approvals of the head commit. Bonk need not become a required check: the gate
   reads both reviewers' verdicts itself, and an AI-scored band merges nothing unless both are
   present, `ok`, from the band's reviewer configuration (model, opencode, `REVIEW.md`, prompt and
   action), free of P0 and P1 findings and `NEEDS-A-PERSON`, and at or above its threshold. Rung 1
   merges only on proofs.
4. **Actions settings.** Leave *Allow GitHub Actions to create and approve pull requests* off;
   otherwise a pull request's own workflow could approve it.

To rotate the key, generate a new one, replace the secret in the environment, then delete the old
key from the app.

### Known limits

- Bonk's verdict comes from a job that runs the pull request's code next to secrets, so it rests on
  a maintainer author and uncompromised dependencies. The Opus verdict, which no pull request code
  reaches, is required as well.
- Medium and high bands require `evidence-consumer-build`, held until the GitLab tokens exist and
  the gadgets-internal patch merges. Until then those bands cannot open; the report still lists
  their records.
- `.agents/skills/write-gatekeeper/SKILL.md` is a culprit file of escapes fixed on 2026-10-08,
  2026-11-02 and 2026-11-06, so the escape raise puts edits to it in the high band until those
  fall out of the 90-day window (2027-02-04). High needs `evidence-consumer-build` too, so scoring
  those edits admits none of them before then.
- The producer binding rests on what GitHub records about a run (its head commit and branch, and
  when it was created) and on the pull requests' base histories. It is not a signed record of which
  workflow file ran. Artifact attestations (`actions/attest-build-provenance`, binding each result
  to `refs/pull/N/merge` and its merge commit) would be one; building them is a later decision.
- A newer Bonk run whose job was skipped (a label removed, a bot event) leaves Bonk's verdict absent
  until the next push, which sends the pull request to a person.
- The report counts a fix as a miss only when it names the pull request or reverts it within 14
  days; fixes on GitLab, or ones that name nothing, go uncounted. Maintainers are those on the
  default branch's list today, and deleted comments are not seen.
