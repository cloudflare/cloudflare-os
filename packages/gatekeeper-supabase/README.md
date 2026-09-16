# Gatekeeper Supabase

This package provides Supabase integration for Gadgets via the [Supabase Management
API](https://supabase.com/docs/reference/api/introduction), using OAuth2.

It exposes two resource granularities:

- **Project** (`https://supabase.com/dashboard/project/:ref`) — the recommended unit. A project is a
  hosted Postgres database plus its auth, storage, and edge functions. Gadgets can run read-only and
  (approval-gated) mutating SQL, introspect schema, and list edge functions and storage buckets.
- **Organization** (`https://supabase.com/dashboard/org/:slug`) — broader access to discover and act
  across every project in an organization.

A connected account corresponds to the organization the user authorizes during the OAuth consent
flow.

## Creating the OAuth app

1. In your Supabase **organization settings**, open the **OAuth Apps** tab
   (`https://supabase.com/dashboard/org/_/apps`) and **Add application**.
2. Set the **Redirect URI** to your deployment's callback (replace the host with `PUBLIC_BASE_URL`):

   ```
   ${PUBLIC_BASE_URL}/gatekeeper/supabase/oauth
   ```

   For local development that is `http://localhost:8787/gatekeeper/supabase/oauth`.
3. After creating it, copy the **Client ID** and **Client Secret** (the secret is shown once).

> Use the OAuth app's **Client ID + Client Secret** — not a personal access token or project API
> key. The `authorization_code` exchange requires the OAuth app credentials.

## Configuration

The gatekeeper Worker reads `CLIENT_ID` and `CLIENT_SECRET`. In local development these are seeded
from shell/`.dev.vars` variables by `run-dev-server.ts`:

```
SUPABASE_CLIENT_ID=<oauth app client id>
SUPABASE_CLIENT_SECRET=<oauth app client secret>
```

## Notes

- Reads are logged as observations; mutating SQL (`execute()`) is submitted to the approval queue
  and only runs once a human approves it.
- Mutating SQL is **not** simulated — arbitrary statements cannot be reliably previewed through the
  stateless query endpoint, so a `query()` will not observe an un-approved change. This is
  documented in the API types.
