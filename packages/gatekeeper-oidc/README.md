# Gatekeeper OIDC

A generic OpenID Connect sign-in provider for any standards-compliant identity provider —
Keycloak, ADFS, Okta (on-prem), Authentik, Dex, and similar. Unlike the vendor-specific gatekeepers
(GitHub, Google), this connector speaks plain OIDC discovery/token/JWKS against an issuer URL the
deployment admin supplies, rather than a hardcoded vendor API.

## Status

Not yet implemented. This package currently contains only the scaffold (config, build, and package
boilerplate) required for `pnpm build` / `pnpm types:check` to pass; the OAuth/OIDC flow itself is
still to be written.

## Configuration

Set via `wrangler.jsonc` `vars` (see the commented block there) or deployment secrets:

- `OIDC_ISSUER` — the IdP's issuer URL, used for OIDC discovery.
- `OIDC_CLIENT_ID` — OAuth client ID registered with the IdP.
- `OIDC_CLIENT_SECRET` — OAuth client secret registered with the IdP.
- `OIDC_SCOPES` — space-separated scopes to request (e.g. `openid email profile`).

## Setup

TODO: once implemented, document how to register an OAuth client with the target IdP and configure
the deployment's `AUTH_GATEKEEPERS` allowlist, following the pattern in
`packages/gatekeeper-github/README.md`.
