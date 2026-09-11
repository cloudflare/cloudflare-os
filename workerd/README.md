# Standalone workerd

[`config.capnp`](config.capnp) describes a complete single-process Cloudflare OS deployment: the
public router, Workshop backend, every gatekeeper Worker, their Durable Object namespaces, the
Gadget Worker Loader, and the frontend asset service.

From the repository root:

```sh
pnpm install
pnpm workerd:build
pnpm workerd:serve
```

Then open <http://localhost:8787>. `workerd:build` creates the frontend and Wrangler dry-run
bundles, then generates the module declarations imported by `config.capnp`. Run it again after a
source change. `workerd:serve` deliberately passes `--experimental`, which standalone workerd
currently requires for the Worker Loader used by Gadgets and agent code.

## Local platform services

Standalone workerd has no Cloudflare account behind it, so the config binds `BLUEPRINTS`,
`AVATARS`, `CONTEXT_COLLECTIONS`, `BLUEPRINT_CONTENT`, and `WORKERS_AI` as ordinary JSRPC services
implemented by [`platform-services.js`](platform-services.js):

- KV and R2 payloads are files under `workerd/state/objects`; a Durable Object keeps the small,
  authoritative metadata index.
- The Workers AI facade supplies the document-conversion shape the backend expects. It preserves
  HTML/XML/CSV as lossless Markdown inline content, but deliberately does not pretend to run model
  inference. Configure a user-supplied model in the UI for inference.
- Static assets are served from the frontend build with MIME types and SPA fallback.

Deletes remove the authoritative KV/R2 metadata immediately. The disk service has no delete
primitive, so immutable payload files are retained and should be accounted for when sizing or
backing up `workerd/state/objects`.

Durable Object state lives under `workerd/state/durable-objects`. Both state directories are
gitignored. Back them up for a persistent installation, and do not change existing `uniqueKey`
values in `config.capnp`: those keys are part of Durable Object identity and storage layout.

Browser Rendering is not available in standalone workerd, so browser-based PDF/image exports are
left unbound and report the backend's normal “not configured” error. Server-side export formats
continue to work.

## Configuration

The checked config listens on all interfaces at port 8787 but advertises
`http://localhost:8787` in callback URLs. Before exposing it through another origin, update
`PUBLIC_BASE_URL` and each gatekeeper `BASE_URL` in `config.capnp`, and put TLS/authentication in a
trusted reverse proxy. The implicit outbound network permits public addresses only, preserving the
backend and MCP workers' SSRF boundary.

OAuth gatekeepers read credentials from these host environment variables:

| Gatekeeper | Variables |
| --- | --- |
| Cloudflare | `CLOUDFLARE_OAUTH_CLIENT_ID`, `CLOUDFLARE_OAUTH_CLIENT_SECRET` |
| Confluence | `CONFLUENCE_CLIENT_ID`, `CONFLUENCE_CLIENT_SECRET` |
| GitHub | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` |
| Google | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |
| Linear | `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET` |
| Notion | `NOTION_CLIENT_ID`, `NOTION_CLIENT_SECRET` |
| Slack | `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` |
| Spotify | `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` |
| Supabase | `SUPABASE_CLIENT_ID`, `SUPABASE_CLIENT_SECRET` |
| ZoomInfo | `ZOOMINFO_CLIENT_ID`, `ZOOMINFO_CLIENT_SECRET` |

The MCP portal also accepts its existing `MCP_PORTAL_*` environment variables. Unconfigured
optional connectors remain present but cannot complete their connection flow until their
credentials are supplied.

To relocate state or change the listen address without editing the file, invoke workerd directly:

```sh
pnpm exec workerd serve --experimental workerd/config.capnp config \
  --socket-addr http=127.0.0.1:9000 \
  --directory-path durable-object-storage=/srv/cloudflare-os/durable-objects \
  --directory-path object-storage=/srv/cloudflare-os/objects
```

The paths passed to `--directory-path` must already exist.
