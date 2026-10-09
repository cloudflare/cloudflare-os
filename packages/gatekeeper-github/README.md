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

## Setting Up GitHub OAuth Credentials

If you're running this project locally and want to use GitHub integrations, you'll need to create
your own GitHub OAuth app. This guide walks you through the process.

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
which is deleted when the last of them is disabled, or when the account is disconnected. Each
webhook signs its deliveries with a secret only GitHub and this deployment hold; a delivery of a
payload already received, or of an event more than a day old, is ignored; and an event is
delivered only while the account can still read the repository, since a webhook outlives its
creator's access. The repository's other admins can see the webhook, though not its secret, and
editing or deleting it stops the deliveries until a hook on the repository is next enabled, which
restores it. GitHub does not retry a delivery that fails, but a delivery that reaches the worker is
retried until the gadget's hook accepts it, eight attempts in all.

For local development, GitHub cannot reach `localhost`: run a tunnel to the dev server (e.g.
`cloudflared tunnel --url http://localhost:8787`) and set `WEBHOOK_ORIGIN` to its origin in the
root `.dev.vars`.

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
