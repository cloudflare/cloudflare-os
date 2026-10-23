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
