# Gadgets Workshop Frontend

Single-page app for the Gadgets Workshop UI. Built with React, Kumo, and Vite.

## Development

```sh
pnpm dev                # start dev server on http://localhost:3000
pnpm exec vp run build  # type-check and build for production
pnpm preview            # preview production build locally
```

`build` is a Vite+ task, not a package.json script, so that it can declare the `VITE_*` flags below
as fingerprinted env: a cached `vp` run executes each task in a clean environment, which drops any
ambient value, and a flag the fingerprint ignores means a changed flag replays the old bundle.

It always produces a production bundle, whatever `NODE_ENV` the shell holds, and it deletes `dist/`
before building — a cache hit restores archived files without deleting any, so the previous build's
sourcemaps would otherwise linger. `vite.config.ts` documents both.

## Gatekeeper user selection

Gatekeeper management apps can open the Workshop-owned **Select users** picker through
`selectUsers(receiver)`. Selections are delivered through the receiver's `receive(selection)` method.
With directory search enabled, users select only directory results; empty or failed searches do not
offer an exact-username/email fallback. With search disabled, users enter an exact identifier
directly. Arrow keys navigate options while focus stays in the input; Tab moves to the next control
without selecting a user. Picking someone does not re-run the current search: people already added
or being added are excluded when each search is issued and hidden from results returned earlier.
If minting or delivery fails, the current query is refreshed so the person can be selected again,
including when the server excluded them from a search made while their selection was pending.
Refreshed results stay dismissed after blur or Escape until the user focuses, types, or uses an
arrow key to reopen them.
Each person the app accepts is announced to assistive technology by their snapshotted name.

**Done** and the close button both wait for ticket minting and selection deliveries before closing.
If a pending mint or delivery fails, closing is cancelled so the error remains visible and the user
can retry or choose **Done** again. Every picker session starts with fresh search and selection state,
including when closing one and opening another are batched in the same render.
**Stop waiting and close** cancels the picker and disposes its outstanding mint and delivery RPC
promises as well as its receiver; frame teardown does the same. Closing and cancelling both resolve
`selectUsers()`; after a cancellation, a delivery already sent to the app may still settle, and
cancellation cannot undo a selection the app already accepted. `selectUsers()` rejects only when the
picker cannot be opened or, on teardown, when the app's connection to the host closes. A superseded
or abandoned directory search is disposed as soon as it is no longer needed.

## Gatekeeper downloads

Gatekeeper management apps can call the trusted host's `downloadFile(url)` capability to download
a setup file authorized by their gatekeeper. Use an absolute URL on the Workshop origin under the
calling vendor's
`/gatekeeper/<mount>/` route, without a query string or fragment. The router's mount name replaces
underscores in the vendor ID with hyphens: `mcp_portal` downloads use `/gatekeeper/mcp-portal/`. The host asks the user to confirm
in a Workshop dialog before fetching. The response must be a successful `Content-Disposition:
attachment` response; redirects are rejected. Only one download may be pending per management app,
including its confirmation and body read. Closing the app cancels the download. After confirmation,
a 60-second timeout covers the request and full body read so a stalled transfer can be retried in
the same frame. Download confirmation and person selection share one prompt slot; an attempt to
open either while the other is visible is rejected. The file contents stay in the host and are saved to the user's device, rather than returned
to the sandboxed app.
The gatekeeper endpoint must authorize the download itself, for example with a short-lived,
single-use grant minted over its authenticated RPC capability. Same-origin fetch forwards cookies
when present; it does not add the Workshop RPC login token. In password mode that token lives in
local storage and authenticates RPC, not this HTTP route. URL-path grants require full-URL
invocation logging to stay disabled on every HTTP hop. Production and preview router, backend and
gatekeeper configs keep invocation logs off while retaining application diagnostics; do not turn
request-URL logging on for these endpoints.

During `pnpm dev-client`, an absolute URL on the configured `VITE_BACKEND_HOST` origin is also
accepted and rewritten through the frontend's same-origin `/gatekeeper/` proxy. That proxy's
error logs omit attachment URLs and upstream error details. `pnpm dev-server` also redacts gatekeeper
paths in Wrangler’s Miniflare request logger, including debug output, while retaining other
diagnostics and the interactive terminal. The dev launcher disables Local Explorer trace capture
(`X_LOCAL_OBSERVABILITY=false`), which otherwise persists full request URLs independently of terminal
logging. Vite refuses startup with Node's raw HTTP/stream trace modes enabled
(`NODE_DEBUG=http`, `NODE_DEBUG=stream`, or a matching wildcard): these traces dump credentials
before middleware can sanitize them. Restart without those modes; `DEBUG=*` and `NODE_DEBUG=net`
remain supported in Vite. The backend launcher clears raw `NODE_DEBUG` traces in its Wrangler
child, including when only that backend process was configured for tracing. Normal `DEBUG` and
Worker console diagnostics remain available. One-use tickets stay private in both processes.

## Authentication modes

The frontend supports two authentication modes, selected at build time.

### Password mode (default)

Users log in with a username and password. Account creation is available via `/signup`.
This is the default — no extra configuration needed.

### Cloudflare Access mode

When the backend is deployed behind [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/applications/), Access handles identity before the user ever reaches the app. In this mode:

- The password-based login page and signup page are disabled.
- On load, the app authenticates automatically using the CF Access session that Access has already established (via `authenticateFromCfAccess()` on the server).

To build in CF Access mode, set `VITE_CF_ACCESS_MODE=true`:

```sh
VITE_CF_ACCESS_MODE=true pnpm exec vp run build
```

Or add it to a `.env` file for persistent local configuration:

```sh
# .env.local
VITE_CF_ACCESS_MODE=true
```

The backend also needs to be configured with the `CF_ACCESS_ISS` and `CF_ACCESS_AUD` environment variables (see the workshop-backend package) for the JWT verification to work.
