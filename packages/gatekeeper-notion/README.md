# Notion gatekeeper

Mediates a Gadget's access to a user's [Notion](https://www.notion.so) workspace: pages and
databases. Runs as its own Cloudflare Worker and is auto-discovered by the backend from its
`GATEKEEPER_NOTION` binding.

## Auth

OAuth 2.0 public connection. Configure a Notion **public integration** and provide its client
credentials to the worker as `CLIENT_ID` / `CLIENT_SECRET`. For local dev, `run-dev-server.ts`
maps `NOTION_CLIENT_ID` / `NOTION_CLIENT_SECRET` (e.g. from a root `.dev.vars`) into those vars.

The integration's **redirect URI** must match `<BASE_URL>/oauth`, which in local dev defaults to
`http://localhost:8787/gatekeeper/notion/oauth`. Recommended capabilities: read/insert/update
content, read/insert comments, read user info (no email needed — `providesAuth` is false).

The connect flow uses a two-phase nonce (initiation → OAuth) and stores the access + refresh
tokens in a `UserAccount` Durable Object; access tokens are refreshed on a 401.

## Resources

| Granularity | URL pattern | Session type |
| --- | --- | --- |
| Whole workspace | `https://*` (catch-all) | `NotionWorkspace` |
| A page or database | `https://www.notion.so/:path+` | `NotionPage` or `NotionDatabase` (detected server-side) |

Only the pages/databases the user shares with the integration during the OAuth page-picker are
reachable.

## API

See `src/types.d.ts` for the full Session API (the agent-facing documentation). Page bodies are
exchanged as Markdown and property values use a simplified union. Highlights:

- `NotionWorkspace`: `search`, `getPage`, `getDatabase`, `createPage`, `listUsers`
- `NotionPage`: `getMetadata`/`getProperties`/`getContent`, `appendContent`, `setTitle`/
  `setProperties`/`setIcon`, `createSubPage`, `archive`/`restore`, comments, `listChildPages`
- `NotionDatabase`: `getSchema`, `query` (typed filters/sorts), `getPage`, `createPage`

## Approvals, caching & simulation

Every read calls `authorizeObservation()`; every write is staged via `submitAction()` and only
performed in `applyAction()`. Reads simulate pending (unapproved) writes so a Gadget sees its own
changes immediately — including provisional IDs for created pages. Page/database/data-source/user
responses are cached in DO storage with short TTLs.

Every write carries a kind (`append-content`, `edit-pages`, `create-pages`, `restore-pages`,
`post-comments`, `trash-pages`) that the user can choose to auto-approve, except moving a page to
trash, setting or creating a page with an external image icon, and writing a file into a files
property (Notion loads those URLs by itself, so they could carry page content out), which always
wait for a person. `describeAction` in `src/notion-actions.ts` assigns them;
tags are never renamed, because stored rules key on them.

## Observers

Every observation reports the subresources it depends on (`src/notion-subresources.ts`), which the
Workshop checks through each gatekeeper's `verifyObserverAccess()`:

| Binding | Reported on every read | Plus |
| --- | --- | --- |
| Page or database | `workspace/<workspaceId>/item/<itemId>` (the bound item) | nothing narrower: child pages and rows inherit its sharing |
| Whole workspace | `workspace/<workspaceId>` (membership) | `workspace/<workspaceId>/item/<itemId>` for each page/database the read reveals (search results, a listed child, a read page or queried database, a new page's parent) |

`workspaceId` is the binding owner's workspace id. A connection made before it was stored asks
Notion (`GET /v1/users/me`, whose bot user names `workspace_id`) with its own token and stores the
answer, unless a reconnect or revoke replaced its credentials meanwhile; if Notion names none, reads
fail closed until the owner reconnects. Item ids are normalized (no dashes, lowercase), and
provisional pages are never reported, though a pending row's properties report its database, whose
columns they show. `listChildPages` gathers the children once but reports each served chunk alone:
the parent plus that chunk's children. `verifyObserverAccess()` refuses any ID of another kind, and
on an item binding anything but the bound item; it accepts whichever workspace an ID was recorded
under, so a reconnect into another workspace doesn't invalidate recorded requirements. Each
observer's own `UserAccount` answers through `checkSubresourceAccess()`: membership compares its own
workspace id, asked of Notion the same way if it has none stored; an item is retrieved with its own
token, one at a time (Notion allows an integration about three requests a second), answers cached
under `cache:@access:` for 15 minutes when allowed and 15 seconds when denied, partitioned by
`credentialsId` (a UUID named on every credential install, including a committed reconnect, but not
on a token refresh). Errors other than a definite 404/403/`restricted_resource`/`validation_error`
throw and are not cached, and a check a reconnect lands in fails rather than combining two
connections' answers.

`addObserver()` keeps enforcing legacy history: an item binding checks the bound item; a workspace
binding checks membership and every item recorded under `observedItem:<id>` before subresources were
reported, and stores admitted verifiers under `observer:<id>`. Reads no longer add to either.
`getHistoricalSubresources()` exports what those checks require, named under the owner's stored
workspace id and without asking Notion: an item binding's bound item; a workspace binding's
membership plus each recorded item, pending or observed. While the owner has no stored
workspace id it exports nothing, since no existing ID can name the history without one. Such a
binding is not covered by the migration: once the Workshop imports history in place of legacy
admission, nothing it disclosed before reads reported subresources stays protected, a deliberate
loosening of its sharing controls.

## Data sources

Notion's newer model splits a database into one or more **data sources**. Database `query`,
`getSchema`, and row creation resolve the database's primary data source under Notion-Version
`2025-09-03`; pages/blocks/comments/search use `2022-06-28` so user-facing IDs/URLs stay
consistent. This split is hidden from the Session API.

## Build & test

```
pnpm exec vp run -F @gadgets/notion-gatekeeper build   # build:configurator + tsc
pnpm --filter @gadgets/notion-gatekeeper test:run    # vitest
```
