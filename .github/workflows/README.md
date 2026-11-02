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

It runs from `main`'s definition through `workflow_run` (when a producer workflow or the review
relay finishes), `issue_comment` and `merge_group`, and never checks out or runs pull request code.
[`risk-review-trigger.yml`](risk-review-trigger.yml) only relays pull request and review events to
it. Producer workflows (reviewer verdicts, rung 1 proofs, band evidence) upload one JSON artifact
each and post nothing; the gate accepts an artifact only from a successful `pull_request` run of
the expected workflow file on the pull request's head, in this repository, and the newest such run
wins even when it failed.

`automerge-bands.json` sets the mode. It ships in `shadow` with every band closed: the check
mirrors today's rule (`reviewDecision` is `APPROVED`), is not required, and records the decision it
would have made as JSON at the top of its output.
[`scripts/risk-review-report.ts`](../../scripts/risk-review-report.ts) rebuilds the calibration
table from those records. In `enforce` mode the check reports the gate's own rule, and for an open
band the App approves (when `app_approvals_count` is true) and enqueues the pull request. A change to
any of these files always needs a person.

### Setup

An organization owner, or a GitHub App manager, does this once.

1. **The app.** Create a GitHub App owned by the organization, with its webhook inactive, the
   repository permissions *Checks: Read and write*, *Pull requests: Read and write*, *Contents:
   Read*, *Actions: Read* (to read producer runs and artifacts) and *Merge queues: Read*, and
   installation limited to this account. Install it on this repository only. Set the repository
   variable `RISK_REVIEW_APP_ID` to its App ID.
2. **The key.** Generate a private key and store it as the secret `RISK_REVIEW_APP_PRIVATE_KEY` in
   the `risk-review` environment, with no reviewers and deployment branches limited to `main` and
   `gh-readonly-queue/main/*` (merge group runs are on that ref). Until the key exists the workflow
   fails at the token step and posts nothing; there is no fallback to the job token.

   **Never store the key as a repository secret.** A workflow a pull request adds can read those,
   and could then post a passing check run or an approval as the app.
3. **The `main` ruleset.** Leave it as it is in shadow mode, and do not require `risk-review`.
   Enforcing is a later team decision: require the `risk-review` check with the risk-review app as
   its source (GitHub needs a recent check run from the app to offer it), and add a merge queue.
   Before relying on App approvals, approve a real draft pull request as the App and confirm the
   ruleset counts it, then set `app_approvals_count`. Stale-approval dismissal is not needed: the
   gate counts only approvals of the head commit.
4. **Actions settings.** Leave *Allow GitHub Actions to create and approve pull requests* off;
   otherwise a pull request's own workflow could approve it.

To rotate the key, generate a new one, replace the secret in the environment, then delete the old
key from the app.
