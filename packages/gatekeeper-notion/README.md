# Notion gatekeeper

Mediates a Gadget's access to a user's [Notion](https://www.notion.so) workspace: pages and
databases. Runs as its own Cloudflare Worker and is auto-discovered by the backend from its
`GATEKEEPER_NOTION` binding.

## Auth

OAuth 2.0 public connection. Configure a Notion **public integration** and provide its client
credentials to the worker as `CLIENT_ID` / `CLIENT_SECRET`. For local dev, `run-dev-server.js`
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

## Data sources

Notion's newer model splits a database into one or more **data sources**. Database `query`,
`getSchema`, and row creation resolve the database's primary data source under Notion-Version
`2025-09-03`; pages/blocks/comments/search use `2022-06-28` so user-facing IDs/URLs stay
consistent. This split is hidden from the Session API.

## Build & test

```
pnpm --filter @gadgets/notion-gatekeeper build   # build:configurator + tsc
pnpm --filter @gadgets/notion-gatekeeper test:run    # vitest
```
