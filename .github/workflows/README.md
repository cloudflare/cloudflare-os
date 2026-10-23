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

[`risk-review.yml`](risk-review.yml) rates each pull request into `main` as low, medium or high
risk (rules in [`scripts/risk-review.ts`](../../scripts/risk-review.ts)). A low-risk change is
approved by the risk-review GitHub App; medium and high each need a maintainer's approval of the
head commit. [`risk-review-trigger.yml`](risk-review-trigger.yml) only relays review events to it.

Unlike `preview.yml`, it runs through `pull_request_target` and `workflow_run`. That is safe because
it never checks out or runs the pull request's code: it reads the diff through the API and sends it
only to Clef. Those triggers are also what keep a pull request from editing its own classifier.

### Setup

An organization owner, or a GitHub App manager, does this once.

1. **The app.** Create a GitHub App owned by the organization, with its webhook inactive, the
   repository permissions *Commit statuses: Read and write* and *Pull requests: Read and write*,
   and installation limited to this account. Install it on this repository only. Set the
   repository variable `RISK_REVIEW_APP_ID` to its App ID.
2. **The key.** Generate a private key and store it as the secret `RISK_REVIEW_APP_PRIVATE_KEY` in
   two environments, both with deployment branches limited to `main`:
   - `risk-review`, with no reviewers;
   - `risk-review-external`, with maintainers as required reviewers and self-review prevented. A
     pull request from anyone without write access waits here until a maintainer approves the run.

   **Never store the key as a repository secret.** A workflow a pull request adds can read those,
   and could then post a passing status or an approval as the app.
3. **Workers AI.** `CF_AI_GATEWAY_TOKEN` needs *Workers AI Read* on the account in
   `CF_AI_GATEWAY_ACCOUNT_ID`. Without it every pull request is at least medium.
4. **The `main` ruleset.**
   - Keep one required approving review. It is the backstop when a run is broken, skipped or never
     relayed, so do not lower it.
   - Dismiss stale approvals when new commits are pushed.
   - Require the `risk-review` status check, with the risk-review app as its source. Statuses from
     any other source, including GitHub Actions, must not satisfy it.
5. **Actions settings.** Leave *Allow GitHub Actions to create and approve pull requests* off;
   otherwise a pull request's own workflow could approve it.

To rotate the key, generate a new one, replace the secret in both environments, then delete the old
key from the app.
