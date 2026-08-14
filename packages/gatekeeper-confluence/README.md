# Confluence (Cloud) gatekeeper

Connects Gadgets to Atlassian Cloud [Confluence](https://www.atlassian.com/software/confluence)
(`*.atlassian.net`) using OAuth 2.0 (3LO). It exposes spaces, pages, blog posts, comments, labels,
and attachments through a capability-based Session API, with page/blog bodies converted to and from
Markdown. Runs as its own Cloudflare Worker and is auto-discovered by the backend from its
`GATEKEEPER_CONFLUENCE` binding.

Only Atlassian **Cloud** is supported; there is no Server / Data Center adapter.

## What it provides

Three connectable resource granularities:

| Granularity | URL pattern | Session type |
| --- | --- | --- |
| **Site** — search and open any space/page/blog post the account can access | `https://*.atlassian.net/wiki` | `ConfluenceSite` |
| **Space** — list/search/create pages and blog posts within one space | `https://*.atlassian.net/wiki/spaces/:spaceKey` | `ConfluenceSpace` |
| **Page or blog post** — read/edit the body, manage labels/comments/attachments, and (pages only) read/create child pages | `https://*.atlassian.net/wiki/spaces/:spaceKey/pages/:pageId/*` | `ConfluenceContent` |

Pages and blog posts share the `ConfluenceContent` session type (distinguished by
`ContentMetadata.type`); child-page methods are page-only.

A single account-level grant can span multiple sites. `getGatekeeperClassFor()` resolves a URL's
host to one of the connection's accessible sites (its cloud ID) — the one chokepoint enforcing site
access.

See `src/types.d.ts` for the full, agent-facing Session API.

## Setting up an Atlassian OAuth 2.0 app

1. Go to the [Atlassian Developer Console](https://developer.atlassian.com/console/myapps/) and
   create an **OAuth 2.0 integration**.
2. Add the **Confluence API** to the app and enable **both** scope families below (see
   `CONFLUENCE_SCOPES` in `confluence-api.ts`). The console has separate **Granular scopes** and
   **Classic scopes** tabs; this gatekeeper needs scopes from each because it uses the v2 API for
   most operations and falls back to v1 for a few (search, label writes, attachment upload,
   restore).

   **Granular scopes** (authorize the v2 API — v2 doesn't accept classic scopes):
   - `read:space:confluence`
   - `read:page:confluence`, `write:page:confluence`, `delete:page:confluence`
   - `read:blogpost:confluence`, `write:blogpost:confluence`, `delete:blogpost:confluence`
   - `read:comment:confluence`, `write:comment:confluence`, `delete:comment:confluence`
   - `read:label:confluence`, `write:label:confluence`
   - `read:attachment:confluence`, `write:attachment:confluence`, `delete:attachment:confluence`
   - `read:user:confluence`

   **Classic scopes** (authorize the v1 fallbacks — v1 doesn't accept granular scopes):
   - `search:confluence` (CQL search)
   - `read:confluence-content.all`, `read:confluence-content.summary` (search results / content reads)
   - `read:confluence-space.summary`
   - `write:confluence-content` (label add/remove, restore-from-trash)
   - `write:confluence-file` (attachment upload)
   - `readonly:content.attachment:confluence` (attachment download)
   - `read:confluence-user`

   **Account-level:**
   - `read:me` (authorizing user's identity)
   - `offline_access` (required for refresh tokens)
3. Under **Authorization**, set the callback URL to `<BASE_URL>/oauth`:
   - `http://localhost:8787/gatekeeper/confluence/oauth` for local dev
   - `<PUBLIC_BASE_URL>/gatekeeper/confluence/oauth` otherwise
4. Copy the app's **Client ID** and **Secret**.

> **API version:** this gatekeeper targets the Confluence **v2** REST API (`/wiki/api/v2/...`),
> which Atlassian now requires (the v1 content/space endpoints have been removed) — and which is
> why the **granular** scopes are needed. A few capabilities with no v2 equivalent (CQL search,
> label add/remove, attachment upload, restore-from-trash) fall back to v1 endpoints, which need
> the **classic** scopes, and degrade with a clear error if Atlassian has removed them too. The app
> therefore must enable scopes from both the Granular and Classic tabs.

## Configuring credentials

For local development, set these in the repo-root environment (e.g. `.dev.vars`) so the dev server
injects them into this Worker:

```
CONFLUENCE_CLIENT_ID=your-client-id
CONFLUENCE_CLIENT_SECRET=your-client-secret
```

`run-dev-server.js` maps `CONFLUENCE_CLIENT_ID` / `CONFLUENCE_CLIENT_SECRET` into the Worker's
`CLIENT_ID` / `CLIENT_SECRET` vars. For production, set `CLIENT_ID` and `CLIENT_SECRET` as secrets
on the deployed Worker and set `BASE_URL` to the public gatekeeper URL.

`providesAuth` is false: Confluence is a data connector, not a sign-in method. Wiring it up as a
"Sign in with Atlassian" provider (using the verified `/me` email) is a possible fast follow.

## How the connect flow works

1. The user starts a connection; `connectAccount()` creates a `UserAccount` Durable Object and
   returns a URL of the form `<BASE_URL>/<doId>/<nonce>`. The flow uses a two-phase nonce
   (initiation → OAuth).
2. Visiting that URL redirects to `auth.atlassian.com` to authorize the requested scopes.
3. Atlassian redirects back to `<BASE_URL>/oauth`; the gatekeeper exchanges the code for access +
   rotating refresh tokens, lists the account's accessible Confluence sites
   (`/oauth/token/accessible-resources`), reads the authorizing user's identity (`/me`), and stores
   them.
4. Each connected resource routes API calls through
   `https://api.atlassian.com/ex/confluence/<cloudId>/wiki/...`. Access tokens are short-lived and
   refreshed automatically (proactively before expiry and again on a 401); each refresh persists
   the **new** rotating refresh token.

A connection is created either by pasting a Confluence URL into the chat, or from the Connections
UI.

## API

Page/blog bodies are exchanged as **Markdown** (best-effort conversion to/from Confluence "storage
format" XHTML; see `confluence-markdown.ts`). Highlights:

- `ConfluenceSite`: `listSpaces`, `getSpace`, `getContent`, `search` (text or raw CQL),
  `getCurrentUser`
- `ConfluenceSpace`: `listPages`, `listBlogPosts`, `getContent`, `search`, `createPage`,
  `createBlogPost`
- `ConfluenceContent`: `getMetadata`/`getContent`, `setContent`/`appendContent`/`setTitle`,
  `listChildPages`/`createChildPage`, labels, comments, attachments
  (`downloadAttachment` is capped at 16 KB), `trash`/`restore`

Endpoint split: v2 for spaces, pages, blog posts, child pages, and reading comments/labels/
attachments; v1 (with graceful degradation) for CQL search, label add/remove, attachment upload,
and restore-from-trash.

## Approvals, caching & simulation

Every read calls `ApprovalQueue.authorizeObservation()`; every side-effecting operation
(create/edit page or blog post, comments, labels, attachment upload, trash/restore) is recorded as
a pending action and submitted via `submitAction()` — nothing reaches Confluence until the Overseer
calls `applyAction()`. Reads simulate pending (unapproved) writes so the agent can keep working
before approval (provisional IDs for created content, body/title/label/comment overlays, trashed
state). `rejectAction()` / `revertAction()` discard or undo. Content responses are cached in DO
storage with a short TTL and invalidated on write. This logic lives in `confluence-actions.ts`.

## Resource pickers

The Connections UI shows space / page-or-blog / site pickers supplied by
`startResourceConfigurator()`. Pasting a resource URL — or an agent's
`requestConnection(resourceUrl)` — also works and pre-fills the picker. For multi-site Atlassian
accounts the space/page pickers search across **all** accessible sites (each option's value carries
the correct site), so pasting a URL works for any connected site too.

## Notes and current limitations

- Body conversion between Confluence storage format and Markdown is best-effort; unsupported macros
  degrade to a labeled placeholder.
- `author` / `lastUpdatedBy` expose only an `accountId` (the v2 content API returns IDs, not user
  objects).
- CQL search, label add/remove, attachment upload, and restore-from-trash rely on v1 endpoints; if
  Atlassian removes them, those operations surface a clear "not available" error.

## Development

- `pnpm --filter @gadgets/confluence-gatekeeper build` — build the configurator UIs (`build:configurator`) and type-check (`tsc`).
- `pnpm --filter @gadgets/confluence-gatekeeper test:run` — run unit tests (URL/CQL parsing, Markdown conversion, v2 converters, action simulation).
- The Worker is run via the root `pnpm dev-server`, not directly.
