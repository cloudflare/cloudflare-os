# Gatekeeper GitLab

This package provides GitLab OAuth integration for Gadgets, for gitlab.com and for self-hosted
GitLab instances. It serves two purposes:

- **Sign-in:** when `gitlab` is in the deployment's `AUTH_GATEKEEPERS` allowlist, "Continue with
  GitLab" appears on the login page. Sign-in requests only the `read_user` scope to read the
  account's **confirmed primary email**, which becomes the user's identity. The sign-in grant is
  transient (discarded right after the email is read).
- **Connections:** when a user connects GitLab (or signs in and later connects it), the `api` and
  `write_repository` scopes are requested so gadgets can read and manage projects, issues, and
  merge requests, and pull from and push to repositories, on the user's behalf.

It is a mirror of the GitHub gatekeeper: the same three resource granularities (project, issue,
merge request), the same worktree integration (commit ids advertised, `gitPull()` over git
smart-HTTP, `push()` as a queued action), and the same review and merge flows expressed in GitLab's
own terms. See `plans/gitlab-gatekeeper.md` for the design record.

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

## Troubleshooting

### "The GitLab project has been renamed or transferred"

The project a connection was bound to has moved. GitLab answers the old path with a redirect that
the gatekeeper deliberately does not follow (following it would turn writes into reads). Re-bind
the connection to the project's new path.

### "GitLab credentials have expired or been revoked"

GitLab access tokens last two hours and are refreshed automatically; the refresh token behind them
is single-use and rotates on every refresh. This error means the refresh token itself was rejected
(`invalid_grant`) — typically because the application was revoked in GitLab, or the account sat
idle past the instance's refresh-token lifetime. Reconnect the account.

### The redirect URI does not match

The **Redirect URI** on the GitLab application must be exactly
`<PUBLIC_BASE_URL>/gatekeeper/gitlab/oauth` (no trailing slash, `http` for local dev).

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
