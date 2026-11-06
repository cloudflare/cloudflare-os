# Gatekeeper GitHub

This package provides GitHub OAuth integration for Gadgets. It serves two purposes:

- **Sign-in:** when `github` is in the deployment's `AUTH_GATEKEEPERS` allowlist, "Continue with
  GitHub" appears on the login page. Sign-in requests only minimal scopes (`read:user user:email`)
  to read the account's **primary verified email**, which becomes the user's identity. The sign-in
  grant is transient (discarded right after the email is read).
- **Connections:** when a user connects GitHub (or signs in and later connects it), the full scopes
  (`repo read:user user:email`) are requested so gadgets can access repositories, issues, and pull
  requests on the user's behalf.

> **Use a GitHub _OAuth App_, not a GitHub _App_.** Only OAuth Apps honor the OAuth `scope`
> parameter, which is what makes the minimal-on-login / full-on-connect behavior work, and the
> `user:email` scope is what grants access to the user's verified email. A **GitHub App** (client id
> starting with `Iv…`) ignores `scope` entirely and will return `Resource not accessible by
> integration` for the email lookup unless you separately grant it the **Email addresses** account
> permission — and even then login won't be minimal-scope. See [Using a GitHub App
> instead](#using-a-github-app-instead) if you must.

## Auto-approval

Every queued action carries a stable kind (`github.<action>`, e.g. `github.push`), and the user may
opt in to approving a kind automatically on a connection. Every action is eligible, including
closing and reopening, `requestChanges` reviews and force pushes, except those that pass a review
gate or can start a billed run, which always wait for a person: **merging a pull request**, **an
approving review**, **a push or force push to the repository's default branch or a protected
branch**, and **creating an issue assigned to an app**. An approval shares
the `github.postReview` kind with comment and request-changes reviews, and a gated push shares
`github.push` or `github.forcePush` with pushes to other branches, but neither is ever
auto-approvable, so enabling those kinds does not cover them. Whether a branch is gated is read
live when the push is queued, and again when an auto-approvable push applies: the repository's
default branch, a branch GitHub reports as protected, or one a ruleset covers, including a branch
the push creates, and the first push into an empty repository, which makes its default branch. A
classic protection pattern is shown only to admins, so a push that creates a
branch one will match is not gated. If GitHub denies the account access to the branch protection
or ruleset details, the branch counts as unprotected; any other failed read gates the push. An issue assigned to an app (a login
ending in `[bot]`, or `Copilot`) shares `github.createIssue` with other issues but always waits,
because an app such as Copilot's coding agent starts a run that spends billed credits. A force push has its own kind (`github.forcePush`), so enabling ordinary pushes does
not let history be rewritten. Excluded actions are still approved by hand as before. Each binding
advertises through `getAutoApprovableActions()` only the eligible kinds its session can submit (an
issue binding, for example, never lists pushes).

## CI status (read-only)

Gadgets can read CI with the `repo` scope connections already have; nothing CI-related is queued
for approval, and every read is logged as an observation.

- **Checks on a commit.** `repo.getChecks(ref?)` and `pullRequest.getChecks(commitId?)` report
  the check runs (GitHub Actions jobs and other apps' checks) and commit statuses on a commit,
  from GraphQL's `statusCheckRollup`: the first 1000 entries, with an overall `state`, `counts` by
  state over every entry (over the listed ones when GitHub cannot count them), and a `phase`:
  `active` (queued, running, or on a deployment wait timer: poll again), `blocked` (waits for a
  person, such as a deployment reviewer or a first-time contributor's approval), `done`, or for a
  commit nothing has reported on, `notStarted`. A commit reads `notStarted` while a push of it is
  queued, or for 10 minutes after it became a head when CI is expected (the commit has
  `.github/workflows/*.yml` or `*.yaml`, or its first parent had CI); otherwise it is `done` with
  `state: "none"`. The head time is when this gatekeeper applied the push, else GitHub's activity
  log for the branch (best-effort: if GitHub refuses or fails it, the committer date), else the
  committer date; for a pull request's head, no earlier than when the pull request was opened,
  since opening it starts `on: pull_request` CI without a push. A pull request read also marks which entries the base branch requires
  (`required`) and names required checks that have not reported (`missingRequired`, best-effort
  from the branch's rulesets and classic protection); while any is missing, the state reads
  `expected` (unless something failed). An `expected` state, GitHub's own or from
  `missingRequired`, with nothing else unfinished reads `active` for those same 10 minutes, then
  `blocked`, since a required check that has not reported by then needs someone to act (a
  path-filtered workflow, or an app that is not installed). A phase that would end polling
  (`done`, or that `blocked`) reads `active` instead while a GitHub Actions run of the commit
  waits on its concurrency group, created under an hour ago: such a run has no check runs, so
  the rollup cannot show it (one best-effort `status=pending` runs lookup, made only then).
- **Pull request scope.** A pull request binding reads CI only on the pull request's head (counting
  queued pushes) and the first 250 commits its listing shows; check runs and workflow runs on any
  other commit are refused. `GitHubPullRequestDetails.mergeState` carries GitHub's
  `mergeable_state`.
- **Check runs.** `getCheckRun(id)` accepts a check run id or an Actions job id (`/runs/<id>` and
  `/actions/runs/<run>/job/<id>` URLs). `getDetails()` adds output, steps and any deployment
  hold; `listAnnotations()` pages the file annotations; `readLog()` reads a finished Actions job's
  log (numbered lines, tail by default, `fromLine`/`maxLines`/`search`), refusing other apps'
  check runs. GitHub answers the logs endpoint with a redirect to its blob storage, which is
  fetched without the token. Finished logs are cached (see `storage-schema.md`) and revalidated
  against the logs endpoint before each use, so a deleted log stops being served.
- **Workflow runs.** `repo.listWorkflowRuns()` filters by branch, commit, event and state (GitHub's
  `queued` filter leaves out runs still `pending` on a concurrency group or `requested`);
  `pullRequest.listWorkflowRuns()` lists the head commit's. `getWorkflowRun(id)` opens one for
  `getDetails()` and `listJobs({ attempt? })`.

Re-running, cancelling or approving runs, and merging when green, are not supported yet.

## Sharing with collaborators

A binding is one repository (or one of its issues or pull requests, which share its permissions),
and the policy for a collaborator is that their own connected GitHub account can read that
repository. Nothing narrower is checked: not the permissions CI logs, Actions or checks need, and
passing doesn't mean GitHub shows that account everything the binding's account read.

- **Identity.** A binding pins its repository's numeric GitHub id on its first read (read once by
  name; a renamed or transferred repository's redirect to its id is followed) and reads nothing
  until it has. From then on every REST request beneath the repository goes to
  `/repositories/<id>/...` and follows no redirect, and GraphQL reads are checked against it.
  Issue search and git fetches and pushes, which github.com addresses only by name, are sent to
  the name that id has now, and a search or fetch fails if it changed before GitHub answered. So a
  rename or transfer keeps the binding on its repository and a repository later created under an
  old name is never read in its place: the binding's requests fail instead. A push is not checked
  again once GitHub has answered, since what GitHub accepted can't be called back: only a rename
  and the name's reuse both landing between the lookup and the push could deliver it elsewhere. A
  binding that read before ids were pinned is pinned to the repository its name names at its first
  read since, which may not be the one it read then.
  Returned repository references and issue/pull-request URLs use GitHub's canonical response, not
  the binding's original name; queued creations and comments use the repository metadata, and hook
  comment/review subjects use the current name from the delivery's access check. Existing cache
  freshness rules still apply.
- **Every read reports it.** Each read, each page of a listing as it is returned, an empty result,
  one served from a cache or from queued actions, and each hook delivery, reports
  the repository as its subresource (`repo/<repoId>` on GitHub.com, instance-qualified on
  Enterprise), so the Workshop checks everyone who can see it before it
  is returned (see [docs/observers.md](../../docs/observers.md) §10). A hook bound by an earlier
  release reports the id its binding stored.
- **Checks.** A collaborator's account is asked `GET /repositories/<id>` with its own token: 200
  allows; 404, or a 403 GitHub doesn't mark as a rate limit (an organization's OAuth app or SAML
  restrictions), denies; anything else fails the check rather than deny. Their account reuses a
  grant for up to 15 minutes and a denial for up to 15 seconds, so a revoked grant can still admit
  them for 15 minutes; it asks afresh after a reconnect, which may sign in as another GitHub user,
  and reuses nothing once disconnected or once GitHub has confirmed its grant dead: the check fails.
  Each open also asks, uncached and never with the binding owner's token, for what the workspace
  read before reads reported the repository: whether their account can read the repository the
  binding's name names now, as releases that read by name asked, and, once the binding has pinned
  an id, the same question of that id, since what those releases read may have come from a
  repository that took the name. A binding with no id yet has read nothing by id, so the name is
  all it is checked by. Caches those releases filled are discarded on upgrade.
- **Offline collaborators.** After a collaborator has opened the workspace and chosen an account,
  the Workshop keeps checking that account for reads within their sharing scope, even after their
  session closes. A failed check can therefore block the owner's reads and hook callbacks while
  that collaborator is offline; being offline alone does not block anything. Account removal or
  confirmed credential expiry fails immediately; repository access revocation may remain hidden
  by the 15-minute grant cache. A collaborator with no stored account choice is checked on admission
  instead.

## Setting Up GitHub OAuth Credentials

If you're running this project locally and want to use GitHub integrations, you'll need to create
your own GitHub OAuth app. This guide walks you through the process.

For GitHub Enterprise Server, create the OAuth App on your own instance and configure its URL as
described in [Self-hosted instances](#self-hosted-instances).

### Step 1: Create a GitHub OAuth App

1. Go to [GitHub Settings > Developer settings > OAuth Apps](https://github.com/settings/developers)
   (**OAuth Apps**, not "GitHub Apps").
2. Click **New OAuth App**
3. Fill in the application details:
   - **Application name**: Enter anything (e.g., "Gadgets Local Dev")
   - **Homepage URL**: `http://localhost:3000`
   - **Authorization callback URL**: `http://localhost:8787/gatekeeper/github/oauth`
     (replace the host with your `PUBLIC_BASE_URL` when not running locally)
4. Click **Register application**

GitHub enables expiring user tokens by default for OAuth apps registered since August 2026
(**Optional features** in the app's settings). The gatekeeper supports both kinds: it refreshes an
expiring token shortly before its eight hours run out, and asks the user to reconnect only once
GitHub rejects the refresh token itself (unused for six months, or revoked).

### Step 2: Generate a Client Secret

On the app's settings page after registration:

1. Click **Generate a new client secret**
2. Copy the **Client ID** and the generated **Client secret** — you'll need both in the next step.

### Step 3: Configure Your Local Environment

Create a `.env` file in this package's directory (`packages/gatekeeper-github/.env`):

```bash
CLIENT_ID=your-client-id-here
CLIENT_SECRET=your-client-secret-here
```

> **Note**: The `.env` file is gitignored and should never be committed.

### Step 4: (Optional) Enable GitHub sign-in

To offer "Continue with GitHub" on the login page, add `github` to the deployment's
`AUTH_GATEKEEPERS` allowlist (e.g. in the root `.dev.vars`):

```
AUTH_GATEKEEPERS=cloudflare,google,github
```

Users are keyed by their GitHub primary verified email, so the OAuth App must be able to read it
(the `user:email` scope, requested automatically). No extra setup is needed for an OAuth App.

### Step 5: Verify Setup

1. Start the application in dev mode (see instructions in the root README.md).
2. Create or open a gadget.
3. Navigate to the **Connections** tab.
4. Click **+ New Connection**.
5. Choose a GitHub resource type: repository, issue, or pull request.
6. If prompted, connect a GitHub account.
7. You should be redirected to GitHub's authorization page in a new tab.
8. After granting access, the tab closes, and you're back to Gadgets.
9. Use the picker to choose the repository, issue, or pull request to connect.
10. Create the connection. The Gadget now has access only to the selected GitHub resource scope.

You can also see your connected accounts and add and remove them in the settings (accessed through the account menu in the upper-right).

## Self-hosted instances

By default the gatekeeper connects to `https://github.com`. Configure these variables on the worker
to use one GitHub Enterprise Server instance instead:

| Variable | Purpose | Default |
|---|---|---|
| `GITHUB_URL` | Browser-facing origin: OAuth authorization, resource URLs and links. | `https://github.com` |
| `GITHUB_API_URL` | Worker-facing origin for OAuth token exchange, REST, GraphQL and Git over HTTPS. | `GITHUB_URL` |

URLs must be HTTPS origins without credentials, paths, queries or fragments. HTTP is accepted only
on `localhost`, `127.0.0.1` or `[::1]` for local development. Enterprise Server uses `/api/v3` for
REST and `/api/graphql` for GraphQL; the default GitHub.com configuration uses `api.github.com`.
For local development, set the variables in the root `.dev.vars` or your shell.

Register an **OAuth App on the Enterprise instance**, with the callback
`{PUBLIC_BASE_URL}/gatekeeper/github/oauth`, and configure its client ID and secret as above. The
browser must reach `GITHUB_URL`, and the Worker must reach `GITHUB_API_URL`. For event hooks, the
Enterprise instance must also reach `WEBHOOK_ORIGIN`.

One deployment uses one instance. Accounts and bindings are tied to their original instance;
changing `GITHUB_URL` does not migrate them and they refuse access until the original URL is
restored. Disconnect old accounts and remove old bindings before changing instances. Repository
observation IDs for Enterprise include the instance origin, so the same numeric repository ID on
another server cannot grant access. Enterprise Server version and feature availability can affect
CI, rulesets, GraphQL and webhook functionality; verify those against your instance.

## Event hooks (optional)

Gadgets can subscribe to a repository's issue, pull request, comment, review, push and tag events,
or to one issue's or pull request's (`subscribe()` in `src/types.d.ts`). GitHub delivers them through
a repository webhook, so this needs a public URL:

1. Set `WEBHOOK_ORIGIN` on this worker to the public origin GitHub should deliver to, e.g.
   `https://gadgets.example.com`. Without it, hooks are refused and everything else works as
   before.
2. If the deployment sits behind Cloudflare Access, add a bypass for
   `/gatekeeper/github/webhook/*`; the worker accepts only deliveries signed with a webhook's
   secret instead.

Enabling a hook adds a webhook to the repository, delivering to
`${WEBHOOK_ORIGIN}/gatekeeper/github/webhook/<id>`, so GitHub allows it only if the connected
account is an admin of the repository. An account's hooks on one repository share its webhook,
which is deleted when the last of them is disabled, or when the account is disconnected. Should
GitHub fail to delete it, the hourly check tries again, and a disconnect that leaves it fails,
keeping the account connected, with the token that can delete it, until disconnecting again finds
it gone. Each webhook signs its deliveries with a secret only GitHub and this deployment hold; a
delivery of a payload already received, or of an event more than a day old, is ignored; and an
event is delivered only while the account can still read the repository, since a webhook outlives
its creator's access.

The repository's other admins can see the webhook, though not its secret. Every hour the worker
checks each webhook on GitHub, and restores one that someone has deleted, deactivated, pointed
elsewhere, switched to form-encoded payloads or unverified TLS, or given other events, another
secret or none: to stop the deliveries, disable the hooks. The same check moves them to a new
`WEBHOOK_ORIGIN` within the hour. GitHub never retries a failed delivery itself, so the same check
asks it to redeliver what it failed to deliver in the past two hours: up to 20 an hour for each
account, shared among its repositories so that a busy one can't crowd out the rest. That includes
what was refused while the webhook was misconfigured, by this worker or by another receiver, as
GitHub redelivers to the webhook as it is configured now. Failures beyond that, or older than two
hours, are lost, as is anything another receiver accepted while the webhook pointed there. A
delivery that reaches the worker is retried until the gadget's hook accepts it, eight attempts in
all. When every recent delivery failed, as when Cloudflare Access turns GitHub away, the check logs
`hooks.webhook.deliveries.failing` with the statuses GitHub got.

For local development, GitHub cannot reach `localhost`: run a tunnel to the dev server (e.g.
`cloudflared tunnel --url http://localhost:8787`) and set `WEBHOOK_ORIGIN` to its origin in the
root `.dev.vars`.

What this relies on GitHub for is checked against GitHub itself by `pnpm test:contract`
(`__tests__/contract`), which the `github-contract` workflow runs weekly and on demand once the
`CONTRACT_GITHUB_TOKEN` secret and `CONTRACT_GITHUB_REPO` variable name a disposable private
repository (the token fine-grained, with access to that repository alone; see the workflow):
- a reader without access gets a 404, whatever ETag it sends;
- a redelivery uses the webhook's current URL, encoding and secret;
- the delivery log is newest first;
- the account is the sender of what it does;
- each event's payload parses.

## Using a GitHub App instead

If you must use a **GitHub App** (client id `Iv…`) rather than an OAuth App, be aware:

- GitHub Apps **ignore the OAuth `scope` parameter**. Permissions are fixed in the App's
  configuration and apply to every user authorization, so sign-in cannot be limited to minimal
  scopes — it grants whatever the App is configured for.
- To read the user's email for sign-in, you must grant the App the **Email addresses** account
  permission: App settings → **Permissions & events** → **Account permissions** → **Email
  addresses → Read-only** → save. Existing users must then re-authorize (re-run the sign-in flow) to
  approve the added permission. Without it, the email lookup fails with `Resource not accessible by
  integration` and sign-in is rejected.

For these reasons an **OAuth App is recommended** for sign-in.

## Troubleshooting

### "Resource not accessible by integration" error

You're using a **GitHub App** that lacks the **Email addresses** account permission, so the email
lookup required for sign-in is forbidden. Either switch to an OAuth App (recommended) or grant the
App the Email-addresses permission and re-authorize — see [Using a GitHub App
instead](#using-a-github-app-instead).

### "redirect_uri_mismatch" error

The callback URL in your OAuth app settings doesn't match what the app is sending. Double-check that you set it to exactly `http://localhost:8787/gatekeeper/github/oauth` (no trailing slash, `http` not `https`).

### "bad_verification_code" error

The authorization code has expired or already been used. Return to Gadgets and try connecting again.

### "Not configured" page during authorization

Your `CLIENT_ID` or `CLIENT_SECRET` is missing. Make sure the `.env` file exists at `packages/gatekeeper-github/.env` and contains both values, then restart the dev server.
