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
