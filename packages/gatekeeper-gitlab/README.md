# Gatekeeper GitLab

This package provides GitLab OAuth integration for Gadgets, for gitlab.com and for self-hosted
GitLab instances. It serves two purposes:

- **Sign-in:** when `gitlab` is in the deployment's `AUTH_GATEKEEPERS` allowlist, "Continue with
  GitLab" appears on the login page. Sign-in requests only the `read_user` scope to read the
  account's **confirmed primary email**, which becomes the user's identity. The sign-in grant is
  transient (discarded right after the email is read).
- **Connections:** when a user connects GitLab (or signs in and later connects it), the `api` and
  `write_repository` scopes are requested so gadgets can read and manage projects, issues, and
  merge requests, read their CI pipelines, and pull from and push to repositories, on the user's
  behalf.

It is a mirror of the GitHub gatekeeper: the same three resource granularities (project, issue,
merge request), the same worktree integration (commit ids advertised, `gitPull()` over git
smart-HTTP, `push()` as a queued action), and the same review and merge flows expressed in GitLab's
own terms. See `plans/gitlab-gatekeeper.md` for the design record.

`gitPull(request, observer?)` returns a streaming Git smart-HTTP `Response`. It permits protocol-v2
ref discovery and upload-pack requests only; the provider selects the bound project URL and
credentials, never a guest-supplied upstream. For lazy DO reads and initial hydration, the kernel
selects immutable objects from recorded provenance and demultiplexes the response with
`startGitPull()`. Lazy reads ingest those objects through the bounded DO cache; container bootstrap
instead streams a complete shallow base pack without filling that cache.

During an authorized container command, native Git can also discover refs and fetch objects through
an already-connected whole-project binding. The kernel supplies `observer` for those new reads;
the provider checks project-level scope and authorizes the observation. An issue or merge-request
connection does not grant whole-project native fetch. The command's final writeback closes its Git
capability. This does not add push or arbitrary URL forwarding. OAuth and optional Cloudflare
Access credentials stay in the gatekeeper, including on self-hosted instances.

## Auto-approval

As in the GitHub gatekeeper, every queued action carries a stable kind (`gitlab.<action>`), and
most may be auto-approved once the user opts in to their kind, including closing and reopening,
resolving and reopening diff threads, `requestChanges` reviews, and pushes and force pushes to
other branches. A force push has its own kind (`gitlab.forcePush`), so enabling ordinary pushes
does not let history be rewritten. These always wait for a person, because they pass a gate:

- **merging a merge request**;
- **an approving review**, which shares the `gitlab.postReview` kind with the other reviews;
- **a push or force push to the default or a protected branch**, which shares the `gitlab.push` or
  `gitlab.forcePush` kind with pushes to other branches. For a branch the push creates, the gatekeeper reads the project's protected-branch rules,
  wildcards included. A push into an empty repository creates its default branch, so it waits too,
  and so does any push whose protection could not be read, except that if GitLab denies the account
  access to the rules (listing them takes Maintainer), no rule counts as covering the branch. An
  auto-approvable push is checked again when it applies; if its protection cannot be read then, the
  apply asks for a retry.

An issue or merge request created with a bot or service account among its assignees waits too,
under the same `gitlab.createIssue` or `gitlab.createMergeRequest` kind as other creates, because
the assignment can start an agent run (a GitLab Duo flow) that spends the namespace's credits.

Each binding advertises through `getAutoApprovableActions()` only the kinds its session can submit
that may be auto-approved, so `gitlab.mergeMergeRequest` never appears.

## CI status

Bindings read CI; they do not act on it. Retrying, cancelling or starting jobs, and merging when
the pipeline succeeds, stay in GitLab. `api` already covers every read, so no new scope is needed.

- **A commit's or merge request's CI.** `getCommit(ref).ci` on a project and `getDetails().ci` on
  a merge request report the commit's latest pipeline and a `phase`: poll while it is
  `notStarted` or `active`, stop at `blocked` (waiting for a person, such as a manual job) or
  `done`. A merge request's `ci` is for its current head only, never a pipeline an earlier head
  left behind. With no pipeline yet, `notStarted` means one is expected: a queued push will make
  the commit a head, or it became one less than ten minutes ago and has CI configuration (the
  project's `ci_config_path`, else `.gitlab-ci.yml`) or its first parent ran a pipeline.
  Otherwise it is `done` with `pipeline: null`. When it became a head is, in order: when this
  gatekeeper pushed it, else the merge request diff version GitLab made for it, else its
  committer date or, when that is older than the window and CI is expected, a push GitLab
  recorded among the project's latest 100 push events (`GET /projects/:id/events?action=pushed`),
  so an old commit someone else just pushed reads `notStarted` rather than a terminal `done`.
  These lookups are best-effort: one that GitLab fails is skipped. `ci` is left
  out for an account that cannot read the project's pipelines, and when GitLab fails any other
  CI read (logged; read again), so the commit or merge request is still returned. A refused or
  expired token still fails the read.
- **Pipelines and jobs.** A project binding has `listPipelines(filter)`, `getPipeline(id)` and
  `getJob(id)` for the bound project. A merge request binding has `listPipelines()`,
  `getPipeline(id?)` (the head's pipeline by default) and `getJob(id)`, limited to the merge
  request's pipelines and their child pipelines in the same project. A pipeline lists its jobs
  (runner jobs, trigger jobs and external statuses, at most 1000, favouring the most recent, so a
  larger pipeline has some left out, even under a status filter, and one with more than 1000 jobs
  or trigger jobs lists no external statuses), opens a same-project child
  pipeline, and reads its unit test report: totals, and the failed and errored cases with about
  4 KiB of output each. Pipelines of a fork's source project and downstream pipelines in other
  projects are data only.
- **Job logs.** `readLog()` returns numbered lines, the last 200 by default (up to 2000 per
  page), from a line onwards or filtered by `search`, with terminal colours removed and section
  headers as `▶` lines. A log over 128 MiB is refused; a very long one keeps only its tail
  (`firstAvailableLine`). Finished logs are cached for an hour, but every read re-reads the job
  first, so an erased log is never served, and a cached log is served only while the connected
  account still holds Developer on the project; otherwise the log is read from GitLab, which
  decides.
- **Sharing.** A collaborator needs the **Developer** role on the project, not Reporter, to
  observe a job log or a test report the workspace read. A job run with `CI_DEBUG_TRACE` writes
  every CI/CD variable, masked or not, into its log, and GitLab shows such logs only to Developers
  and above ([docs](https://docs.gitlab.com/ci/variables/variables_troubleshooting/)); a failed
  test's recorded output comes from the job that ran it, so test reports count too. A test report
  needs **Maintainer** instead unless the connected account was a project member below Maintainer
  and not an instance administrator when it was read: a job can restrict its reports to
  Maintainers ([`artifacts:access`](https://docs.gitlab.com/ci/yaml/#artifactsaccess)), and GitLab
  includes those for a Maintainer and for an administrator, whatever its membership. See
  [Sharing with collaborators](#sharing-with-collaborators).

Status values GitLab adds after this gatekeeper was written read as `unknown` with phase
`blocked`, and are logged as `ci.unknown_status`. GitLab 19.2 renamed the trigger-jobs listing
(`…/bridges` → `…/trigger_jobs`); the gatekeeper picks the route from the instance's version.
This gatekeeper registers no GitLab webhooks, so agents poll.

## Sharing with collaborators

A binding is one project (or one of its issues or merge requests, which share its permissions),
and the policy for a collaborator is that their own connected GitLab account holds an effective
membership of that project at Reporter or above, whatever its visibility, since a public project
can still hold confidential issues and internal notes; job logs and test reports need more (see
[CI status](#ci-status)).

- **Identity.** A binding pins its project's numeric GitLab id on its first read (read once by
  path; GitLab answers a moved project's old path with a redirect to its id, which that read
  follows, as GitHub's does) and reads nothing until it has. From then on every REST request beneath the project
  goes to `/projects/<id>/...`. Git fetches and pushes, which GitLab addresses only by path, are
  sent to the path that id has: a push's read afresh, a fetch's from the project read cached for
  up to 30 seconds. A fetch fails if the path read afresh once GitLab has answered differs from
  the one it was sent to, and a failed fetch drops the cached project, so a retry goes to the new
  path. So a rename or transfer keeps the binding on its project, and a project later created at
  an old path is never served in its place (a fetch may reach it, and its answer is refused) unless
  the path moves away and back between the path sent and that check. A push is not checked
  again once GitLab has answered, since what GitLab accepted can't be called back: only a move
  and the path's reuse both landing between the lookup and the push could deliver it elsewhere.
  A binding that read before ids were pinned is pinned to the project its path names at its first
  read since, which may not be the one it read then.
  Returned issue and merge request references use the current project path from GitLab's web URL,
  including same-project source and target branches, and comment, diff-thread, queued-item and
  queued-commit links use the path the pinned project has now; the original binding path remains only the REST
  rewrite key and the legacy admission requirement.
- **Every read reports it.** Each read, each page of a listing as it is returned, an empty result,
  and one served from a cache or from queued actions, reports `project/<projectId>` as its
  subresource, so the Workshop checks everyone who can see it before it is returned (see
  [docs/observers.md](../../docs/observers.md) §10). A job log reports
  `project/<projectId>/role/developer`. A test report reports `project/<projectId>/role/developer`
  when it was read through a member below Maintainer who is not an administrator, and
  `project/<projectId>/role/maintainer` otherwise: chosen as the report is fetched, beside the
  connected account's role and fenced to one connection, and kept for every page of it, however
  the account's role changes later.
- **Checks.** A collaborator's account is asked `GET /projects/<id>/members/all?user_ids[]=` for
  its own GitLab user, with its own token: a membership at the role the ID names (Reporter for a
  project alone) allows; none, a lower one, an invitation not yet accepted, an expired one, or a
  project GitLab hides from them denies; anything else fails the check rather than deny. Their
  account reuses a grant for up to 15 minutes and a denial for up to 15 seconds, so a removed
  membership can still admit them for 15 minutes; it asks afresh after a reconnect, which may sign
  in as another GitLab user, and reuses nothing once disconnected or once GitLab has confirmed its
  grant dead: the check fails. Bindings created since subresource reporting (marked
  `reportsSubresources: true` in their immutable props) have no reads that predate it, so they
  admit every collaborator without asking GitLab, record none, and have no collaborator cap: the
  Workshop checks each read's report instead. Older bindings also ask each open, uncached and never
  with the binding owner's token, for the stored project id when there is one, and for the project
  their original path names now (read at the project's root first, following a moved project's
  redirect from that path, as GitHub's name check does), since earlier path-addressed reads may
  have disclosed a project that later took it. For those older bindings, no stored id means the path is all they are checked
  by; recorded CI data still needs its role the same way. Caches filled before conversion are
  discarded on upgrade. Their legacy history is not exported, so these checks remain.

## Setting up GitLab OAuth credentials

If you're running this project locally and want to use GitLab integrations, you'll need to create
your own GitLab OAuth application.

### Step 1: Create a GitLab application

1. On GitLab, go to **User settings → Applications** (or, to share the application with a team,
   a group's **Settings → Applications**).
2. Fill in the application details:
   - **Name**: anything (e.g. "Gadgets Local Dev")
   - **Redirect URI**: `http://localhost:8787/gatekeeper/gitlab/oauth`
     (replace the host with your `PUBLIC_BASE_URL` when not running locally)
   - **Confidential**: checked
   - **Scopes**: `api`, `write_repository`, `read_user`
3. Save the application, and copy the **Application ID** and **Secret**.

> **Why `write_repository` when `api` is "everything"?** GitLab's documentation grants Git over
> HTTPS to OAuth tokens only through the `read_repository`/`write_repository` scopes; `api` covers
> the REST API. Pushing commits from a worktree needs `write_repository`, so both are requested.

### Step 2: Configure your local environment

Create a `.env` file in this package's directory (`packages/gatekeeper-gitlab/.env`):

```bash
CLIENT_ID=your-application-id-here
CLIENT_SECRET=your-application-secret-here
```

Alternatively, export `GITLAB_CLIENT_ID` and `GITLAB_CLIENT_SECRET` in your shell; `pnpm dev-server`
maps them into the worker's `CLIENT_ID`/`CLIENT_SECRET`.

To develop against a self-hosted instance, set `GITLAB_URL` (and `GITLAB_API_URL`,
`CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` as the instance needs -- see
[Self-hosted instances](#self-hosted-instances)) in the root `.dev.vars` or your shell;
`pnpm dev-server` passes them through to the worker, so nothing tracked has to change.

> **Note**: The `.env` file is gitignored and should never be committed.

### Step 3: (Optional) Enable GitLab sign-in

To offer "Continue with GitLab" on the login page, add `gitlab` to the deployment's
`AUTH_GATEKEEPERS` allowlist (e.g. in the root `.dev.vars`):

```
AUTH_GATEKEEPERS=cloudflare,google,gitlab
```

Users are keyed by their GitLab primary email, which GitLab only makes primary once confirmed. An
account whose primary email is unconfirmed cannot sign in.

### Step 4: Verify setup

1. Start the application in dev mode (see instructions in the root README.md).
2. Create or open a gadget.
3. Navigate to the **Connections** tab.
4. Click **+ New Connection**.
5. Choose a GitLab resource type: project, issue, or merge request.
6. If prompted, connect a GitLab account.
7. You should be redirected to GitLab's authorization page in a new tab.
8. After granting access, the tab closes, and you're back to Gadgets.
9. Use the picker to choose the project, issue, or merge request to connect.
10. Create the connection. The Gadget now has access only to the selected GitLab resource.

## Self-hosted instances

By default the gatekeeper talks to `https://gitlab.com`. Point it at another instance with these
variables on the worker:

| Variable | Purpose | Default |
|---|---|---|
| `GITLAB_URL` | The instance users visit: the OAuth authorization page, links in results, and the URLs of connectable resources. | `https://gitlab.com` |
| `GITLAB_API_URL` | The origin the Worker sends requests to (REST, token endpoints, git over HTTPS), when it differs from `GITLAB_URL`. | `GITLAB_URL` |
| `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` (secrets) | A Cloudflare Access **service token**, attached to every Worker→GitLab request as `CF-Access-Client-Id`/`CF-Access-Client-Secret`. Set both or neither. | unset |

Both URLs must be `https` origins (scheme and host, no path): every request to the API origin
carries a user's token, and the OAuth exchanges carry the client secret. Plain `http` is accepted
only on `localhost`, `127.0.0.1` or `[::1]`, for a GitLab run on your own machine. A GitLab
served under a relative URL root (`https://example.com/gitlab`) is not supported; the worker
refuses the URL at its first request rather than sending tokens to the wrong path.

The typical Access-protected layout is `GITLAB_URL=https://gitlab.example.com` (behind Access for
browsers) and `GITLAB_API_URL=https://gitlab-access.example.com` (a hostname whose Access
application admits the service token). The Access application must admit the token on the
`/api/v4/*`, `/oauth/*`, **and** `/<group>/<project>.git/*` paths — the last is where git fetch and
push go, and a policy scoped to the API alone makes worktree pulls fail with a login page.

Register the OAuth application on the instance itself, with the same redirect URI and scopes as
above.

A review that requests changes needs GitLab 19.2 or later: earlier versions' review-publishing
endpoint ignores the reviewer state without an error, so on them the gatekeeper refuses a
`requestChanges` review rather than post it as a plain comment. Comment and approve reviews work
on every version.

## Worker Preview OAuth callbacks

A Worker Preview's hostname cannot be registered with the GitLab application, so a deployment
that tests on previews registers one **stable** callback and relays the result to the preview
that started the flow (`@gadgets/gatekeeper-kit/preview-oauth`, as `gatekeeper-google` does).
Give the stable Worker and its previews the same `OAUTH_STATE_SIGNING_SECRET` and
`OAUTH_ALLOW_PREVIEW_REDIRECTS=true`, and set the fixed redirect on previews only:

```text
OAUTH_REDIRECT_URI=https://gatekeeper-gitlab.example.workers.dev/oauth
```

Register `OAUTH_REDIRECT_URI` as the application's redirect URI. A preview sends that URI to
GitLab and carries its own callback in signed, short-lived state; the stable Worker accepts
return URLs only on its `<preview>-<worker>.<workers.dev>` hosts and forwards only GitLab's
result and the state. The preview then exchanges the code with the same redirect URI it
authorized under. Normal deployments omit all three settings and use `${BASE_URL}/oauth` directly.

Deploy the relay-capable stable Worker before enabling the fixed redirect on previews. Previews
do not inherit the stable Worker's secrets: set `CLIENT_ID`, `CLIENT_SECRET`,
`OAUTH_STATE_SIGNING_SECRET` and, for an Access-protected instance, `CF_ACCESS_CLIENT_ID` /
`CF_ACCESS_CLIENT_SECRET` on the stable Worker (`wrangler secret put`) **and** in its Previews
Base configuration (`wrangler preview base-config secret put`); a preview created afterwards
receives them.

## Troubleshooting

### "The GitLab project has been renamed or transferred"

A request beneath a project was answered with a redirect, which is followed only for a read of the
project itself. The bound project is read by its id once pinned, and the pin and collaborator
checks follow a moved project's redirect from its old path, so a rename or transfer does not cause
this on its own; if you see it, report it.

### "GitLab credentials have expired or been revoked"

GitLab access tokens last two hours and are refreshed automatically; the refresh token behind them
is single-use and rotates on every refresh. When GitLab refuses an access token the gatekeeper
first refreshes past it. This error means the refresh token itself was rejected (`invalid_grant`)
— typically because the application was revoked in GitLab, or the account sat idle past the
instance's refresh-token lifetime. Reconnect the account. A token endpoint that is unreachable,
answers 5xx, or is turned away by Cloudflare Access fails the request with "Could not refresh
GitLab credentials" instead and leaves the connection intact.

### "GitLab credentials were renewed during this request"

GitLab invalidates an access token when it issues its replacement, so a request in flight while
the gatekeeper refreshed can be refused. Reads are rerun once with the new token; anything else
fails with this message and is safe to retry.

### The redirect URI does not match

The **Redirect URI** on the GitLab application must be exactly
`<PUBLIC_BASE_URL>/gatekeeper/gitlab/oauth` (no trailing slash, `http` for local dev) -- or, on a
Worker Preview, the stable Worker's `OAUTH_REDIRECT_URI` (see above).

### "Not configured" page during authorization

`CLIENT_ID` or `CLIENT_SECRET` is missing. Make sure the `.env` file exists at
`packages/gatekeeper-gitlab/.env` and contains both values, then restart the dev server.

### "GitLab did not answer the request: the API redirected to …"

Every REST call is answered with a redirect to a login page: the instance is behind Cloudflare
Access and the Access application in front of `GITLAB_API_URL` does not admit the gatekeeper's
service token, or `CF_ACCESS_CLIENT_ID`/`CF_ACCESS_CLIENT_SECRET` are not set on the worker (see
[Self-hosted instances](#self-hosted-instances)). Distinct from the rename message above: the
gatekeeper tells them apart by where the redirect points.

### git fetch or push fails with a redirect or an HTML page

The same cause on the `.git/` paths: the Access application admits the service token for
`/api/v4` but not for the repository, or the token is not configured.

### "This collaborator does not have read access to the GitLab project …"

Someone sharing a workspace is not a member of the project it is bound to at **Reporter** or
above — or is a member only at Guest. Being able to open the project in GitLab is not enough,
even on an `internal` or `public` one: a project can hold confidential issues and internal notes
that only members at those roles see, and the workspace may have read them. The remedy is for a
project maintainer to add the collaborator as a Reporter (inherited group membership counts).

### "This workspace has read CI job logs or test reports from this GitLab project …"

The collaborator is a member below **Developer**, and a release that recorded CI reads itself
read a job log or a test report through this connection, which raises the bar from Reporter to
Developer (see [CI status](#ci-status)). A project maintainer can grant the collaborator
Developer; otherwise share a workspace that has not read CI job logs or test reports. Reads made
since are checked by the Workshop, which refuses the read, or the collaborator, in its own words.

### "This workspace has read CI test reports from this GitLab project through a connection that may have Maintainer access …"

As above, for a test report such a release read through a connected account that was a
Maintainer, an instance administrator, or not a project member, so it may include ones a job
keeps from anyone below Maintainer, and the collaborator is below Maintainer (see
[CI status](#ci-status)). A project owner can grant the collaborator Maintainer; otherwise share a
workspace that has not read them.

### "This binding already answers for 50 collaborators …"

A binding created before subresource reporting can be shared with at most 50 collaborators at
once: it records each one it admits, as the releases that checked every one of them on each
job-log or test-report read did. Remove a collaborator from the workspace before adding another,
or bind the project again: a binding created since has no cap.
