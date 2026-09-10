# Totango → Heyodie sign-in migration

This is an authorized **same-local-part identity alias**, enabled only by deployment configuration:

```json
"AUTH_EMAIL_DOMAIN_ALIASES": { "heyodie.ai": "totango.com" }
```

The backend production Wrangler configuration includes this opt-in. Other deployments default to
disabled. A JSON string containing the same object is accepted for local environment files. Empty
objects disable it; other mappings, reversed mappings, chains, cycles, arrays, and malformed JSON
are rejected. This setting is deliberately absent from the admin panel and `AdminConfig`.

## Stable identities and collision recovery

After verified Google/gatekeeper sign-in or Cloudflare Access authentication, the backend probes
existing accounts in this order: `local@totango.com`, then `local@heyodie.ai`. It uses the first that
exists; otherwise it creates `local@totango.com` if signups are enabled. The local part is preserved
exactly, including case and plus tags; it is not lowercased or stripped. Domains match exactly
(case-insensitively), not by suffix or subdomain. Old-domain sign-in uses the same resolution.

The legacy profile ID is intentionally stable. Workspace ownership, collaborators, connected
accounts, chats, model preferences, avatars, and other records are neither renamed nor copied.
Existing tokens keep routing to the exact account which issued them, including an already-created
new-domain account. Tokens are **never** canonicalized during authentication.

If both accounts exist, sign in again through SSO, open the profile menu, and choose **Switch to
local@heyodie.ai** to access the data created under that account. Switch back to the legacy identity
to use its workspaces and connections. The API methods `listAccountIdentities()` and
`switchAccountIdentity(identity)` expose only existing authorized identities. Switching returns a
fresh account capability without mutating the source capability or merging storage.

New gatekeeper sessions record the email actually verified at sign-in. Access capabilities carry
the verified JWT email. Switching preserves this provenance. Pre-migration tokens and password
sessions still access their original accounts but cannot switch: a fresh SSO sign-in is required.
An email-shaped username or the absence of a password is not proof of switching authority.

The browser holds its identity choice in memory for the current login. It restores that choice
through a newly authenticated capability on WebSocket reconnect, disposes replaced stubs, and
remounts account-scoped UI state when switching. A new login or sign-out clears the choice; a full
page reload returns to the stored token's original identity (or the resolver's default for Access).
A failed reconnect switch reports an error rather than
quietly showing another account. Other already-open tabs keep their own identity.

## Sharing and admins

Keep existing emitted and persisted `totango.com` domain policies unchanged: changing their domain
would conflict with latched observation policies. The evaluator accepts configured `heyodie.ai`
identities for those policies and continues to exclude accounts with password login. Explicit
invitation and existing role checks still apply.

Inviting a new-domain email with no existing account resolves to its existing legacy account.
If that exact new-domain account already exists, the invite targets it explicitly. To invite the
legacy account in a collision, enter its `totango.com` identity. Neither invite path creates users.

Keep the existing `ADMINS` legacy principal list. Switching to an independently created new-domain
account does not grant it admin rights; admin checks use the actual selected account ID.

## Upstream operational work (outside this repository change)

1. **Google Workspace / identity provider:** provision and verify each `heyodie.ai` address with the
   same local part. Ensure the intended users can authenticate and that any OAuth consent-screen
   organization restrictions permit the new identities. Keeping old aliases/sign-in available is
   compatible with this resolver. Check Google actually returns a verified email for the new login.
2. **Cloudflare Access:** update application/IdP eligibility rules to admit `heyodie.ai` as well as
   `totango.com` while the transition runs. Keep JWT audience and issuer validation intact. Test the
   real browser-origin path and any separately configured native-origin path. Backend aliasing cannot
   admit a user that Access denies before the request reaches the application.
3. **Team PI relay and feedback service:** the local model catalog, signed transport validator, and
   feedback eligibility check accept the configured alias consistently. Requests still carry the
   selected account's real email; they do not impersonate the legacy identity. The external relay,
   feedback/coding-session service, and their organization checks must accept `heyodie.ai` too. Their
   deployed contracts are not verified or changed here. Until updated, collision-account requests
   may be rejected downstream even though Workshop authorizes them.
4. **Connected providers:** verify any upstream account/email restrictions and reconnect a provider
   from the selected account if required. Vendor endpoints, `TOTANGO_KG`, and the `totango` GitHub
   organization are unchanged; this migration does not rename those services or transfer grants.

## Rollout verification

Before rollout, test one legacy-only user, one new-domain-only user, one collision, and a new user.
Check both SSO paths, old token routing, switching in both directions, reconnect, independent
workspace/connection lists, admin status, an existing domain-restricted workspace, invites to both
collision identities, Team PI responses, and feedback submission. Check password/legacy sessions
cannot switch and unrelated local parts/domains remain inaccessible.

Disabling the opt-in stops cross-domain resolution and cross-domain switching on newly authenticated
capabilities. It does not revoke already-issued capabilities or tokens. There is no storage rollback
or data merge to undo. Retain both accounts' data while validating the upstream changes.

This repository change does not execute a production migration, deploy Workers, modify an IdP,
change Access policy, or update the external relay.
