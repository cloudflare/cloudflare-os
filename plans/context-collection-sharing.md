# Context collection sharing

## Scope

Implement collection sharing in the Context gatekeeper as part of the current PR #744 branch,
stacked on #741; one PR carries the whole feature. Do not modify the upstream PR. This document is a
plan, not an implementation.

Sharing applies to an entire private collection: all documents, files, and skills inherit its
access. There are no per-file or per-skill grants.

Deployment-public (admin-managed) collections are not sharable and continue working unchanged.

## Access model

Keep authorization separate from discovery. A shared-list entry makes a collection discoverable;
it must not itself grant access.

Store authoritative access in `ContextCollectionDurableObject`:

- Grants keyed by Context account, with role `viewer`, `editor`, or `owner`.
- An independent `everyoneCanView` flag.

Ownership is a grant role, so owners can delegate it and a collection can have several. The
existing single `ownerAccountId` becomes the collection's first `owner` grant: migrate it when the
collection DO first reads access under the new schema. Afterwards `ownerAccountId` only names the
creator, whose owned index lists the collection; it confers nothing.

| Operation | Viewer | Editor | Owner |
| --- | --- | --- | --- |
| Read every document, file, and skill | Yes | Yes | Yes |
| Edit web-managed content, including deleting content | No | Yes | Yes |
| Configure git mirroring, branch, tokens, and refresh | No | Yes | Yes |
| Share as viewer or editor, and change or remove viewers and editors | No | Yes | Yes |
| Enable or disable everyone-viewable | No | Yes | Yes |
| Grant `owner`, and demote or remove owners | No | No | Yes |
| Delete the entire collection | No | No | Yes |

Git-backed content remains read-only in the web editor. Editors and owners use the existing
mirroring controls rather than bypassing the git-backed storage contract.

Ownership invariants, pending product confirmation:

- Owners are peers: any owner can demote or remove any other owner.
- No management operation may leave a collection without an owner. The last owner cannot demote
  or remove themselves; they transfer ownership by granting `owner` to someone else first, or
  delete the collection.
- Editors cannot change any owner's grant.

Owner account deletion: disconnecting an optional Context account calls `ContextAccount.revoke()`,
which today deletes every collection the account owns. Change it to remove the account's grant
from every collection it holds one on (owned and shared indexes alike), then:

- If another owner remains, nothing else changes.
- If no owner remains and no other grant exists and `everyoneCanView` is off, delete the
  collection, including its Artifacts repo as `deleteForRevokedOwner` does today.
- If no owner remains but the collection is still shared (any grant or `everyoneCanView`), keep
  it and record that it has no active owner. Disconnecting cannot be refused, so this is the one
  way the no-owner invariant breaks. Grantees keep their roles, and editors may then delete the
  collection or grant `owner` so that someone owns it again.
- When the last grant on an ownerless collection is removed and `everyoneCanView` is off, delete
  the collection, since no one can reach it any more.
- A disconnected account cannot reclaim anything: re-adding Context mints a new random account
  ID.
- Show a collection without an active owner as such in the Share dialog and labels.

`revoke()` still wipes the account's `UserLibraryDurableObject`; `#propagate` and `deleteSelf`
already skip a missing owned record.

### Existing authorization seams

- `packages/gatekeeper-context/src/context-collection.ts`: collection storage, owner identity,
  metadata, content, git token management, propagation, and deletion.
- `packages/gatekeeper-context/src/context-api.ts`: management read/write gates, metadata access,
  permission queries, collection listing, and git-management operations.
- `packages/gatekeeper-context/src/context-types.ts`: management API, metadata, and listing types.

Replace duplicated owner/public checks with one authoritative collection access policy, used by
management reads, mutations, agent reads, catalogs, and observer verification. Enforce role checks
server-side; hidden UI controls are not authorization. Public collections keep their current rule:
readable by everyone in the sharing domain, writable by admins.

## Individual sharing

Add a collection-owned Share dialog containing:

- Role selection for new recipients: viewer or editor, plus owner when the actor is an owner.
- Add people, opening the trusted Workshop user picker.
- Existing recipients, role changes, and removal.
- The independent everyone-viewable toggle.

Use the new user-selection capability rather than implementing user search inside the gatekeeper.

### Delivery flow

1. Construct a `GatekeeperUserSelectionReceiver` that captures the collection ID and selected role
   for that picker invocation. Do not read a mutable current-role state during delivery.
2. Call `host.selectUsers(receiver)`.
3. Each `receive(selection)` immediately calls the Context management API with the selection
   ticket and captured role. Do not defer delivery until the picker closes or a later Save action.
4. The backend verifies the actor's authority for the requested role (owner for `owner`, editor
   or owner otherwise) before redeeming the ticket through `AppUiContext.userSelectionExchange`.
5. Resolve recipient identity through the Context verifier returned by redemption. The verifier
   keeps its account ID in private props, so add a `ContextVerifierApi` method that returns it for
   a matching sharing domain and refuses any other. Browser-supplied names or account IDs must not
   establish identity.
6. Write the recipient's shared-list entry, then the collection grant. Both writes are idempotent.
7. Resolve `receive()` only after both writes are acknowledged. The Workshop picker then marks the
   person as added; errors remain visible beside the selected person.

Pass the existing exchange into `ContextApiImpl` from `ContextAccount.startAppUi()` in
`src/library-gatekeeper.ts`. Expose the existing host `selectUsers` operation to the management app
through `app/main.tsx` and `app/bridge.ts`. Dispose receiver capabilities according to Cap'n Web
ownership rules. Cancelling the picker cannot undo shares already delivered.

### Recipient and delivery edge cases

- Redemption may return zero eligible accounts. Show an actionable error rather than reporting
  success. Context is optionally provisioned by default; the exchange cannot automatically create
  an optional recipient account that does not exist.
- Redemption may return multiple accounts. They all belong to the one person selected, so share
  with each of them; that gives the person nothing beyond what was chosen.
- Same vendor does not imply same sharing domain. Reject incompatible recipients.
- Tickets are single-use, and redemption plus the two writes is not a distributed transaction.
  Because every read checks the collection's grants live, either partial state is safe: an index
  entry without a grant is filtered out, and a grant without an index entry is not yet listed. A
  failure rejects `receive()`; the user picks the person again, which mints a new ticket and
  repeats both idempotent writes.
- Display-name snapshots are presentation only. Grant management uses stable backend identities.

## Shared-list discovery and live authorization

Extend `UserLibraryDurableObject` with a shared-collection index holding collection IDs only.
Metadata is read live from the collection, so collection edits need no propagation to recipients
(`#propagate` updates only the creator's library or the public registry). A grantee's entry stays
in the shared index whatever its role, including `owner`. The owned index keeps only collections
the account created, and removing the creator's grant drops it; a demoted creator keeps the entry.
Whether a collection is shown as owned comes from the live role (`EnabledCollectionInfo.membership`),
not from which index lists it. Merge both indexes into management listings, agent catalogs, and skill
discovery, alongside the existing deployment-public category.

For each indexed collection:

- Resolve current read access and effective role from the collection's authoritative state.
- Filter revoked or deleted entries before exposing metadata.
- Deduplicate by collection ID.
- Keep list membership distinct from ownership, role, and everyone-viewability.

Direct sharing must update the recipient UserLibrary DO synchronously, not through KV propagation.
A recipient UI that is already open picks up the new share on its next load or explicit refresh;
there is no push from the library to open UIs.

`LibraryReadSession` currently caches enabled collection membership for the session. Do not use
that cached membership as authorization after introducing sharing: existing sessions must honor
revocation and must not indefinitely miss new shares. Apply live access checks before revealing
content or catalog metadata.

Drop collection title uniqueness. It was added in #504 as a navigator convenience, not an
invariant: collections are keyed by ID everywhere, and a share cannot be refused because the
recipient already has a collection with that title. Remove `#assertUniqueCollectionTitle` from
create and update in `context-api.ts`, `DUPLICATE_COLLECTION_TITLE_ERROR` from `context-types.ts`,
and `app/skills/collectionTitle.ts` with its uses in `CreateCollectionDialog.tsx` and
`EditCollectionDialog.tsx`. Collections with the same title are told apart by their owned/shared
labels.

The Skills navigator currently opens skills rather than arbitrary collections. Add an Open
collection action for every reader, reusing the existing collection file surface, so collections
containing only ordinary documents remain usable.

## Everyone-viewable

`everyoneCanView` exists so that sharing a workspace is not blocked: a collaborator can join a
workspace that read the collection without the owner first sharing the collection with them
individually. People are not expected to discover these collections, so the flag changes read
permission only:

- Do not enumerate the collection into any account's library or shared index.
- Do not register it through the existing public-registry broadcast path.
- Never grant editor rights through this flag.

"Everyone" means every Context account in the collection's sharing domain. Disabling the flag
removes read permission unless ownership or an explicit grant still allows it. An explicit grant
must survive flag changes, and removing an explicit grant must not erase another valid access path.

## Observer verification

Retain the existing collection-tracking observer strategy: the Context singleton spans collections
with different ACLs, and the tracker already records collection IDs.

Update `ContextVerifier.hasCollectionsAccess()` to accept:

- Ownership.
- Explicit viewer or editor grants.
- Everyone-viewable permission.
- Existing deployment-public access.

Keep it free of side effects: the tracker calls it on every read and on admission attempts that
fail, so it is not a successful-join notification. Use the same authoritative policy as management
and agent reads. A stale shared-list reference must not satisfy observer verification. Revocation
must affect subsequent checks even when a read session or discovery entry already exists.

Update `CONTEXT_OBSERVER_DENIED`, which names "another user's private collection" as the example,
so it still makes sense when the collection is shared with others, and keep it free of collection
names.

Relevant files:

- `src/context-observers.ts`: vendor-specific batched access oracle and tracked strategy.
- `src/library-gatekeeper.ts`: Context account, verifier, observer admission, and catalog integration.
- `src/library-read.ts`: collection-scoped observations and enabled-set caching.
- `src/user-library.ts`: owned/shared discovery indexes.

## Git mirroring and credential lifetime

Reuse existing git functionality: generated push-mirror destination credentials, branch selection,
token creation/list/revocation, and manual refresh. Do not introduce repository OAuth, source repo
browsing, webhooks, or automated upstream configuration.

Grant editors access to those existing management operations. Keep viewers out of branch, token,
and refresh controls in both the Skills navigator dialogs and the older collection-detail surface.

Existing git tokens permit direct writes independently of the management UI, and are minted with
Artifacts' maximum lifetime of one year. Track the issuing account for newly created mirror tokens
and, when an account is demoted to viewer or loses its grant, revoke every token it minted, so
access revocation does not merely hide token controls. Tokens minted before sharing existed have no
recorded issuer and are left alone, so no owner's existing mirror is unexpectedly revoked.

## UI integration

Add a feature-owned collection Share dialog, using Kumo controls and existing dialog/presentation
patterns. Reuse the host-owned picker rather than importing Workshop components into the sandbox.
Offer it on private collections only.

Update both collection entry surfaces:

- `app/skills/SkillsNavigatorPage.tsx` and `SkillsNavigatorTree.tsx`.
- `app/ContextLibraryPage.tsx` and its collection options/editor.

Feed effective permissions into existing manageable/writable gates in
`app/skills/useSkillsNavigatorData.ts`. Viewers keep navigation, previews, downloads, and collection
opening; editors receive content/share/mirror controls as appropriate to collection source; owners
additionally receive owner management and whole-collection deletion.

Replace labels that infer ownership from private/public visibility. Show owned/shared membership,
effective role, and everyone-viewability separately; public collections keep their current label.
No file or skill sharing controls.

## Implementation sequence

1. Define collection roles, grant/access results, the listing's `membership` field, and narrow
   management APIs in `context-types.ts`. Implement authoritative collection ACL storage and the
   shared index with safe defaults for existing collections.
2. Integrate ticket redemption, the verifier account-ID method, immediate durable delivery, grant
   role changes/removal, and partial-failure semantics.
3. Extend observer access verification. Update live authorization for management/agent reads and
   catalogs; avoid cached membership as authority. Remove title uniqueness.
4. Implement Share dialog, role-sensitive controls, collection opening, and shared-list
   presentation. Apply permissions consistently to existing git-management surfaces.
5. Cover credential-lifetime behavior, update Context documentation and UI copy, and run
   end-to-end verification.

## Acceptance and verification

Protect consumer-visible behavior with focused tests and real-browser smoke checks:

- Viewers can read all collection content but cannot mutate, reshare, or manage git.
- Editors can edit web content, reshare as viewer or editor, and manage existing git mirroring
  controls, but cannot grant `owner`, change an owner's grant, or delete the collection.
- Owners can grant `owner`, demote or remove other owners, and delete the collection; the last
  owner cannot demote or remove themselves, and ownership transfers by granting then leaving.
- Existing collections load with their `ownerAccountId` as the sole owner.
- No per-file or per-skill grant exists; moving or adding content preserves collection-level access.
- Direct sharing updates recipient discovery before reporting success.
- Receiver delivery captures the selected role and propagates backend errors through the host picker.
- Enabling everyone-viewable adds the collection to no one's library.
- A collaborator can join a workspace that read an everyone-viewable or explicitly shared collection,
  and is refused for one that is neither.
- Everyone-viewable changes and explicit grants remain independent.
- Revocation works despite stale indexes and existing sessions; deleted collections reveal no metadata.
- Cross-domain recipients, missing/multiple accounts, expired/reused tickets, and partial writes fail
  safely rather than reporting false success.
- Collections with the same title can coexist, whether owned or shared.
- Disconnecting an account removes its grants. A collection left with another owner is unchanged;
  one left with no owner is deleted if unshared, and otherwise keeps working for grantees, shows
  that it has no active owner, and lets editors delete it or grant `owner`.
- Mirror-token revocation follows the agreed policy.
- Existing owned and deployment-public collections behave as before.

Use the existing Context Node/workerd test projects for authorization and persistence, existing app
suites for permission-sensitive interactions, and actual Chromium surfaces for sharing, keyboard
behavior, and viewer/editor controls. Run package types/build and relevant lint checks after
integration. Do not treat mocked forwarding tests alone as proof of delivery.

## Decisions

Settled while implementing; revisit if product direction differs.

1. Owners are peers (any owner can demote or remove another), and the last owner cannot demote or
   remove themselves.
2. A ticket naming several eligible accounts shares with all of them; one naming none fails with
   "This person hasn't turned on Skills yet, so you can't share with them."
3. Losing write access revokes the git tokens that account minted; legacy untagged tokens stay.
4. Editors of a collection left without an owner may delete it or grant `owner`, and removing its
   last grant deletes it.
