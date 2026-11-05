# Context Library

The Context Library — a gatekeeper whose account provides a singleton read session + a management
UI, for authoring collections of context documents that agents read as observations.
`plans/context-collection-sharing.md` is the design record.

## State

- Collections have one of two visibilities: **private** (created by one account and shareable with
  others) and **public** (created/edited only by deployment admins, readable by everyone and
  auto-enabled for all users; not shareable).
- It owns its state in three Durable Objects (`ContextCollectionDurableObject` for content and a
  private collection's grants, `UserLibraryDurableObject` for each account's index of collections it
  created or was given, `LibraryRegistryDurableObject` for the domain's public set) plus a KV
  namespace.
- All data is namespaced by a `sharingDomain` (from the binding's props, see `domain.ts`) so multiple
  workshops sharing one gatekeeper instance stay isolated.

## Sharing

Sharing is whole-collection.

- A private collection's own grants (`viewer` / `editor` / `owner`, keyed by Context account) and its
  `everyoneCanView` flag are the sole authority, interpreted only by `collection-access.ts`; every
  listing, agent read, and observer verification re-checks them live, so a library index entry is
  discovery and never access.
- A collection always keeps an owner except when its last owner's account is disconnected while
  others still hold access; its editors then keep editor permissions only (nobody can delete it or
  grant ownership), and it is deleted once its last grant goes, even if everyone can view it.
- Everyone-viewable only grants read access (so sharing a workspace that used the collection is not
  blocked); it never adds the collection to anyone's library.
- Shares arrive through the Workshop user picker: the management API redeems the ticket and takes the
  recipient's account IDs from their Context verifiers (`getAccountId`), never from the browser, and
  grants all of that person's accounts together.
- Losing write access revokes the git mirror tokens that account minted, and tokens from before
  sharing count as the creator's; the collection serializes grant changes, token minting, and
  deletion so none can race another, and retries a failed revocation from an alarm.
- Disconnecting marks the account's library first, so a share racing it is refused rather than left
  behind.

## Account and app

Its `GatekeeperVendor` entrypoint (bound as `GATEKEEPER_CONTEXT`) declares `autoProvisionsAccount` and
mints a `ContextAccount` via `createAccount()` (no user identity is passed in; the account keys its
private data by its own generated `accountId`). The account exposes the agent read session
(`getSession()`), collection discovery metadata (`getAgentCatalog()`), and a management UI
(`startAppUi({ isAdmin })`). The UI is a single-file React SPA in `app/` (Vite + Tailwind + Kumo)
bundled by `build-app.ts` into `src/generated/app.txt`.
