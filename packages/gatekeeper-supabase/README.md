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
  and only runs once a human approves it. It is never auto-approved: one statement can be a
  harmless `INSERT` or a `DROP`, and the gatekeeper has no SQL parser to tell them apart.
- Mutating SQL is **not** simulated — arbitrary statements cannot be reliably previewed through the
  stateless query endpoint, so a `query()` will not observe an un-approved change. This is
  documented in the API types.

## Observers

Every observation reports the subresources it depends on (`src/subresources.ts`), and the Workshop
checks collaborators against them through `verifyObserverAccess()`:

| Binding | Reported IDs |
|---|---|
| Organization | `organization/<slug>` on every read; reads of a project's data (opening it, its metadata, health, edge functions, buckets, SQL, schema) add `organization/<slug>/project/<ref>` |
| Project | `organization/<orgSlug>/project/<ref>` on every read, `<orgSlug>` from the project's cached metadata; a read fails if Supabase names no organization |

`verifyObserverAccess()` refuses the whole call for an ID the binding never reports: an
organization binding accepts only IDs under its own slug; a project binding accepts only its own
project ref, under any organization (projects can be transferred), and no organization ID. Each
observer's own `UserAccount` answers `checkSubresourceAccess()`: a project ID is allowed when the
ref is in the observer's `/v1/projects` (organization membership is not consulted), an organization
ID when the slug is in their `/v1/organizations`, one list request per kind for every ID without a
recent answer. Allowed answers are reused for 15 minutes, denials for 15 seconds; failures
(missing or expired credentials, rate limits, outages) throw and are never cached.

`addObserver()` still enforces the legacy checks for history recorded before reads reported
subresources: project access for a project binding; organization membership plus access to every
recorded project for an organization binding, whose verified observers' verifiers are still stored.
Reads no longer record projects or set `excludeObservers`.

## Storage

`UserAccount` (besides the connect flow's `callback`, `nonce`, staged-reconnect and credential-expiry
keys):

- `accessToken`, `refreshToken`, `accessTokenExpiresAt` — the live OAuth grant.
- `credentialsId` — a random name for the installed credentials, replaced on every install
  (initial connect and confirmed reconnect, not token refresh) and created on first use for
  accounts connected before it existed. It partitions the access cache.
- `cache:@access:entry:<subresource ID>`, `cache:@access:generation` — `checkSubresourceAccess()`
  answers (`KvTtlCache` named `access`), stored with the `credentialsId` that learned them.

`SupabaseGatekeeperImpl`:

- `cache:entry:<key>`, `cache:generation` — cached metadata and schema reads.
- `pending:action:<id>`, `pending:nextActionId` — SQL statements awaiting approval.
- `observedProject:<ref>` (`"pending"`, `"observed"` or `true`), `observer:<id>` (a stored
  verifier) — the legacy organization-binding tracker. No longer written by reads; kept because
  `addObserver()` checks it.
