# Sharing

Gadgets supports sharing gadgets with other users. There are two sharing mechanisms:

1. **Collaborators** -- granting other users direct access to a gadget, so they can work on it alongside the owner. (Covered in this file.)
2. **Blueprints** -- sharing a snapshot of a gadget's source code, so others can create independent gadgets from it. (Documented elsewhere.)

This document describes the collaborator system.

## Collaborators

A collaborator is a user who has direct access to a gadget they do not own. Each collaborator has a **role** that determines their level of access:

- **`build`** -- full access: edit code, use the AI chat, manage bindings, and interact with the gadget UI -- the same as the owner, modulo the owner-only exceptions below.
- **`use`** -- may only render and interact with the gadget's deployed UI. Concretely, a `use` collaborator may call `getUiBundle()` and `connectToGadget()` against the mainline code (`chatId` must be omitted), read basic metadata via `getMetadata()`/`subscribeToMetadata()` (restricted to `id`/`title`/`owner`/`role`), and call `subscribeToPresence()` to see active viewers' names, profile IDs, and roles. Every other `Overseer` method throws `Unauthorized`, with two exceptions: `subscribeToConsoleLogs()` and `subscribeToActions()` return inert subscriptions that never deliver data (no console logs; an empty, immediately-`ready()` action log). The editor opens both speculatively from top-level hooks before switching to the use-only view, so resolving them quietly avoids spurious client-side errors while still revealing nothing else.

Roles are totally ordered: `build` > `use`.

`build` collaborators differ from the owner in a few ways:

- **Cannot delete the gadget.** Only the owner can do this.
- **Use their own AI models.** When a collaborator engages AI chat, the model is resolved from their own account (BYOK billing goes to whoever prompted the AI, not the gadget owner).
- **Use their own connected accounts for bindings.** When a collaborator adds a gatekeeper binding, it connects through that collaborator's third-party accounts, not the owner's. This prevents collaborators from gaining access to the owner's accounts beyond what the gadget's existing bindings already expose.
- **Limited revocation authority.** A collaborator can only remove users that they themselves added (see "Permission graph" below).

A caller may never grant a role higher than their own effective role. Today only the owner and `build` collaborators can share at all (sharing methods are not in the `use` allowlist), so in practice `use` access is granted by the owner or a `build` collaborator. The permission graph nevertheless models roles generally, so allowing `use` collaborators to reshare `use` access in the future requires no algorithmic changes.

### Restricted capability

Authorization is capability-based: `open()` computes the caller's effective role from the permission graph and hands back a different object depending on the result. `build`/owner sessions get the full `OverseerClientInterface`; `use` sessions get a `UseOverseerInterface` that implements the entire `Overseer` interface but throws `Unauthorized` for everything outside the `use` allowlist (except the two inert telemetry subscriptions noted above). Presence is intentionally in the allowlist and exposes active viewers' names, profile IDs, and roles. Because that class `implements Overseer`, any newly-added interface method fails to compile until a developer consciously decides whether `use` callers may invoke it (default-deny).

### Adding collaborators

There are two ways to grant someone collaborator access:

**Direct add.** The owner or an existing collaborator enters a username (an email address on OAuth/CF Access deployments; a normalized alphanumeric handle on password deployments) in the Share modal. The system looks up the corresponding user account; if it exists, a collaborator record is created. The target user does not receive an in-product notification -- the sharer is expected to send them a link or tell them out of band.

**Share link.** Any collaborator (or the owner) can create a share link, which encodes a secret key in the URL as a `#share=<key>` fragment. Anyone who opens this link is automatically added as a collaborator. A link is a durable handle that owns one or more keys: creating it mints its first key, and "copying" the link later mints another key for the same link. The raw key is shown to the creator only once at mint time and is never stored server-side, so re-copying can't reproduce an old key -- it mints a new one. Any of a link's keys can be redeemed by multiple people, or the same person multiple times, until the link is revoked, which invalidates every key minted for it.

Share key security: the server generates a random 128-bit key and stores only its HMAC-SHA-256 hash (using a fixed domain-separation constant, `SHARE_KEY_HMAC_KEY`). When a user redeems a share link, the client sends the raw key to the server, which computes the hash and looks it up. This means the server cannot reconstruct share links from its stored data, and a database leak does not expose valid share keys.

Storage shape: a link is its first key. The `shareKeys` table holds one row per key: the row for the first key carries the link's metadata and is keyed by that key's hash, which serves as the link id. Each later copy stores only an `alias` pointing back at that id.

Share key redemption and gadget opening happen atomically in a single RPC call (`openGadget(id, shareKey)`), which allows subsequent calls to be pipelined on the returned `Overseer` stub without waiting for a separate redemption step.

Redemption is **pending until verified**: redeeming a key writes the recipient's `shareKey` edge with a `pending` flag, which grants no authority to anyone -- the recipient is invisible to `listCollaborators`, to everyone's effective roles, and to the sensitive-observation coverage guard. Only the open() that performed the redemption counts the edge (to compute the role it must verify the recipient for); the edge is confirmed when that open's observer verification succeeds and severed when it fails, so a refused (or still-verifying) recipient never holds authority. A stale pending edge left by a crashed open is inert and settles on the next redemption of the same link.

### Home page behavior

A shared gadget does not appear on a collaborator's home page until they first open it. At that point, a record is created in the collaborator's user account (via `UserDurableObject.recordSharedGadgetOpen()`), storing a cached copy of the gadget's title and the owner's profile. The `lastActive` timestamp is updated each time they open the gadget.

Shared gadgets appear in the same list as owned gadgets on the home page, distinguished by showing the owner's name in the "Owner" column. Collaborators can dismiss a shared gadget from their home page (removing the record from their user account), but this does not revoke their access -- if they open the gadget again via its URL, it reappears.

When a collaborator's access is revoked, the stale record remains on their home page (we don't proactively reach into their account to remove it). The next time they try to open it, `open()` returns a workspace access-denied error and the client tells them they no longer have access without showing the workspace name or other metadata. They can dismiss the dead entry manually.

## Permission graph

The sharing system tracks *how* each collaborator gained access, forming a directed graph of permission edges. This graph is the foundation for transitive revocation.

### Edges

Each collaborator has one or more **permission edges** explaining how they got access. There are two edge types:

- **User edge**: records that a specific sharer (identified by `profile.id`) directly added this collaborator. Includes a timestamp, the granted role, and an optional note.
- **Share-link edge**: records that this collaborator redeemed a key for a specific share link (identified by `keyId`, the id of the link's first key). Includes a timestamp; the granted role is taken from the link.

A collaborator can accumulate multiple edges -- for example, if they were added directly by Alice and also redeemed a share link created by Bob. The collaborator retains access as long as they have at least one valid edge.

(Edges and share links created before roles were introduced have no `role` field; they are treated as `build` for backwards compatibility.)

### Effective role

A collaborator's **effective role** is the maximum role reachable from the owner through their valid edges. Each edge grants `min(edge role, sharer's effective role)`: the owner is the implicit root at `build`, a user edge's sharer is the owner or another collaborator, and a share-link edge's "sharer" is the link's creator. A collaborator's effective role is the maximum granted role across all their valid edges. Effective role is computed live (it is never denormalized into storage), so it is always consistent with the current graph -- which also means a session's access is recomputed from scratch at each `open()`.

### Share links in the graph

Share links are first-class nodes in the permission graph, connected to their creator. A share link is "supported" by its creator: if the creator loses access, the link is transitively revoked, which in turn removes anyone who gained access solely through it.

Concretely, revoking a share link or removing its creator triggers the same transitive revocation algorithm described below, treating all edges referencing that link as invalid. A link may have several keys, but they all resolve to the same link node, so redeeming any of them yields one edge.

### The owner as root

The owner is the implicit root of the permission graph. The owner is never stored in the collaborators table and cannot be removed. All permission chains must ultimately trace back to the owner (or to someone the owner added, or someone *they* added, etc.) for access to be valid.

## Lazy revocation

Access is determined by **reachability from the owner**, recomputed live at every `open()` (see "Authorization model" below). Revocation exploits this: rather than eagerly cascading and deleting records, the system only **severs the edges that grant the removed party access** and lets reachability do the rest.

- **Removing a collaborator** deletes the edges that grant *them* access. The owner severs *all* incoming edges to the target; a non-owner severs only their own `user` edge. The target's record is retained even if it becomes empty, and crucially the edges where the target is the *sharer* of access to others are left untouched.
- **Revoking a share link** sets the link's `revoked` flag instead of deleting it. A revoked link contributes nothing to the permission graph and none of its keys can be redeemed, but the link record and all edges referencing it stay intact (no dangling references). The link's copies are deleted outright, since no edge ever references an alias.

Nothing cascades. A dependent who loses their only path to the owner (e.g. Carol, reachable only via the removed Bob) simply becomes unreachable -- they are denied at `open()` time, not pruned from storage. This is the example from the introduction: removing Bob makes Carol unreachable automatically, with no separate cleanup step.

### Restoring access (undo)

Because the graph is never destructively pruned, revocation is reversible. If you accidentally remove someone who had in turn shared with five other people, you can **undo** simply by re-adding them: their record and their five outgoing grants were never deleted, so re-adding an edge from the owner restores their reachability and, transitively, all five downstream collaborators. (Share-link revocation is likewise non-destructive via the `revoked` flag, though there is no UI to un-revoke a link yet -- see Future work.)

This does mean removed collaborators and revoked links accumulate in storage. Listing RPCs (`listCollaborators`, `listShareLinks`) return only currently-active entries, so removed users disappear from the UI; a future GC could reclaim long-dead records.

### Effective-role algorithm

The core is a **fixed-point role-propagation computation** implemented in `SharingManager.computeEffectiveRoles()`. It computes the effective role of every collaborator (given an optional hypothetical change), returning a map from profile ID to effective role (absence from the map means no access). It is the single source of truth: `open()`, the listing RPCs, and the preview methods all derive from it.

Inputs (all optional; used to model a hypothetical change):
- `removedUser` -- a profile ID to treat as removed (excluded from the graph). Used by preview.
- `removedEdge` -- a single user edge (`{target, sharer}`) to treat as removed. Used to preview a non-owner removing only their own edge.
- `revokedLinkId` -- a share link ID to treat as revoked. Used by preview.
- `assumePendingLink` -- a `{profileId, linkId}` pair whose pending edge is counted as though it were confirmed. Unlike the removal-shaped preview inputs, this models a hypothetical *grant*: the open() that just redeemed the link counting its own edge to compute the role it must verify for. Every other pending edge contributes nothing.

The algorithm:

1. **Build the candidate set.** Load all collaborators except the (hypothetically) removed user.
2. **Collect share-link metadata.** Build a map from link ID to `{creator, role}`, skipping links that are `revoked` (or the hypothetical `revokedLinkId`).
3. **Iterate to fixed point.** Repeatedly scan all collaborators. For each edge, compute the role it grants -- `min(edge role, sharer's effective role)`, where the sharer (or share link creator) is the owner (always `build`) or another collaborator's current effective role -- and raise the collaborator's role to the maximum across their valid edges. Pending `shareKey` edges are skipped (except the one named by `assumePendingLink`). Raising one collaborator's role may unlock or raise others on the next pass.
4. **Converge.** Roles only ever increase, so the loop terminates when a full pass changes nothing.
5. **Return the role map.** Collaborators absent from the map have no access; collaborators present with a lower role than before have been downgraded.

This handles arbitrary graph shapes: diamonds (a user reachable via two independent paths), cycles (mutual adds), and deep chains.

### Removals and downgrades

Because edges carry roles, severing an upstream edge or revoking a link may either remove a user (they lose all access) or merely **downgrade** them (they keep access via another path, but at a lower role). `removeCollaborator`/`revokeShareLink` return the affected set by diffing the effective-role map captured before the change against the map recomputed after: each entry is an `AffectedCollaborator` carrying `oldRole` and `newRole` (with `newRole === null` meaning full removal).

### Preview and confirm

Revocation is a two-phase process in the UI:

1. **Preview.** Before changing anything, the frontend calls `previewRemoveCollaborator()` or `previewRevokeShareLink()`, which runs the effective-role computation with the corresponding hypothetical input and returns the `AffectedCollaborator`s whose access would change. If non-empty, the UI can warn the user (e.g. "removing Bob will also cut off Carol").
2. **Confirm.** The frontend calls `removeCollaborator(profileId, keepUsers)` or `revokeShareLink(linkId, keepUsers)`. Both perform the lazy edge-severance described above and return the actually-affected set.

### keepUsers (optional re-rooting)

`keepUsers` lets the caller spare specific dependents from a removal/revocation. After the edge is severed, `#reRootKeptUsers` recomputes effective roles and, for each listed user who would otherwise lose access or be downgraded, appends a fresh `user` edge from the caller at their prior role (bounded by what the caller can grant). This is pure convenience layered on top of the lazy model -- the same effect is achievable by re-adding the intermediary, or by granting the dependent access directly.

### Non-owner removal

A non-owner can only sever their own `user` edge to the target (and only if such an edge exists -- otherwise the call is rejected). If the target still has edges from other sources, they retain access, though possibly at a lower role; if the caller's edge was their only support, the target becomes unreachable like any other lazily-removed user.

## Resource isolation between collaborators

Collaborators share the gadget's code, storage, and AI chat history, but certain resources are scoped to individual users:

- **AI model bindings** resolve from the account of whoever created the binding. This is baked in at binding creation time for AI model gatekeepers (the full `AiModelConfig` including API key is stored in the binding props). For agent spawners, the creating user's DO ID is stored in `AgentSpawnerBindingProps.creatorUserId` so the model can be resolved at trigger time from the correct account.
- **Gatekeeper bindings** connect through the third-party accounts of whoever created them (`OverseerClientInterface.newGatekeeper()` calls `clientUser.getGatekeeperClassFor()` rather than `owner.getGatekeeperClassFor()`).

This means no collaborator implicitly gains access to another user's connected third-party accounts.

## Authorization model

Authorization is enforced at `open()`: the method computes the caller's effective role from the permission graph (`getEffectiveRole()`), treating the owner as the implicit `build` root. A caller with no effective role receives `WORKSPACE_ACCESS_DENIED`, while an uninitialized or deleted gadget receives `WORKSPACE_NOT_FOUND`. This distinction acknowledges that an initialized workspace exists, but the denial exposes no workspace name, owner, or content. Otherwise the role selects which capability is returned (full `OverseerClientInterface` for `build`/owner, restricted `UseOverseerInterface` for `use`). (Note: `UseOverseerInterface` still throws `Unauthorized` when a *valid* `use` collaborator calls a `build`-only method -- that's a different case, where existence is already known and only the operation is denied.)

Because the role is recomputed from the graph on every `open()`, the live computation is the *sole* source of truth for access -- there is no eager cleanup whose bugs could grant access to an unreachable user. This is what makes lazy revocation safe: severing an edge is enough to deny access, even though the unreachable records linger in storage.

A share-key redemption goes through the same gate without ever granting interim authority: the redeemed edge is written pending (see "Adding collaborators"), the redeeming open() verifies the recipient against the role the edge *would* grant, and only a successful verification confirms the edge. After confirming, the role is re-derived from the live graph and re-checked -- which is what denies a redeemer whose link was revoked while their verification was in flight -- and capped at the role verification covered: a role raised mid-verification (say, an owner grant landing while the recipient sat on the configuration modal) takes effect at their next open, which verifies at the wider role's scope. Confirming additionally requires the workspace's connection/binding topology to be unchanged since verification began: any change (a connection or gadget binding added or removed while the recipient sat on the modal) denies the open and reverts the redemption, and a retry re-verifies against the new topology.

### Terminating live sessions on revocation

Authorization is only checked at `open()`, so a session that is *already* open is not re-checked per message. Without intervention, a collaborator who was just removed or downgraded could keep using their live session until something else disconnected them. To close this gap, `removeCollaborator`/`revokeShareLink` proactively restart the gadget's Overseer DO via `ctx.abort()` whenever the change actually removed or downgraded someone (i.e. the returned `AffectedCollaborator[]` is non-empty; pure no-op removals don't restart). Aborting forcibly disconnects every client; each reconnects and re-runs `open()`, which re-evaluates the now-changed permission graph -- sending removed users to the terminal access-denied page and handing downgraded users their reduced capability (the editor swaps to the `use` view automatically based on `metadata.role`). Since removals are rare (and DOs restart unpredictably anyway, so reconnects are already cheap), the disruption is acceptable.

Two precautions surround the abort (`OverseerImpl.scheduleRevocationRestart`): the severed edge is flushed with `ctx.storage.sync()` first (because `ctx.abort()` does not respect the output gate, a restart could otherwise come back with the change lost), and the abort is delayed ~100ms so the triggering RPC's response reaches the caller -- typically the owner, who is also connected -- before their own connection drops. The disconnect reaches the browser through the existing `notifyClosed` plumbing: when the Overseer DO aborts, the per-session `notifyClosed` stub is disposed without being called, which `AuthenticatedApiImpl` treats as a lost connection and reacts to by killing the browser WebSocket, forcing a reconnect. The client discards its retained share key on the first successful open, so this forced reconnect after a removal is keyless and lands the removed collaborator on the access-denied page rather than silently re-redeeming the still-active link (which would undo the removal and break the assumption stated above). The residual is unchanged: the *link* itself survives a collaborator removal under the lazy model, so a recipient who kept the URL can still re-redeem it manually until the owner revokes it -- the discard removes only the client's automatic re-grant.

Note this is only needed for removals/downgrades. Granting or raising access never strands anyone, and `containsRestrictedData` cannot strand a session either: an observation carrying that flag is *blocked* (rather than applied) unless every current collaborator *in whose verification scope the producing gatekeeper falls* is already a verified observer of it (coverage is held to each collaborator's role scope; see docs/observers.md edge case 4), so no live session ever belongs to someone the flag would newly exclude. Verification, though, is a *live* check re-run at each open: a collaborator whose provider-side access is later revoked may still hold an older session opened while they passed. That is why a failed re-verification scrubs the failed gatekeeper from their persisted observer record (docs/observers.md edge case 3) — from that point the coverage guard blocks that producer's restricted observations, including to the stale session, until a successful re-open.

One party the restart deliberately does not cover is a redeemer whose share link is revoked *while their first open is still verifying them*: their edge is pending, so it is invisible to the revocation's affected-set computation and no restart targets them. They are denied anyway -- after verification confirms the edge, `authorizeCollaborator` re-derives the role from the live graph, where the revoked link contributes nothing.

## Future work

- **More permission levels.** Beyond `build` and `use`, planned levels include: chat-only (can create chats but not merge to mainline) and read-only.
- **Resharing of `use` access.** Allow `use` collaborators to grant `use` access to others. The permission graph already supports this; it only requires adding the relevant sharing methods to the `use` allowlist.
- **Binding-aware access control.** Prohibit adding collaborators when the gadget holds binding permissions that the collaborator lacks, and conversely prohibit adding sensitive bindings when existing collaborators lack the required permissions.
- **Share link expiration and usage limits.** Including single-use links.
- **Un-revoking share links.** Revocation is non-destructive (the `revoked` flag), but there is no UI or RPC to list revoked links or clear the flag, so link revocation is currently one-way in practice.
- **Garbage-collecting dead records.** Removed collaborators and revoked links accumulate in storage under the lazy model; a background sweep could reclaim entries that have been unreachable for a long time.
- **Notifications.** Currently there are no in-product notifications for access grants or revocations.
