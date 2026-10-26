# Sharing

Gadgets supports sharing gadgets with other users. There are two sharing mechanisms:

1. **Collaborators** -- granting other users direct access to a gadget, so they can work on it alongside the owner. (Covered in this file.)
2. **Blueprints** -- sharing a snapshot of a gadget's source code, so others can create independent gadgets from it. (Documented elsewhere.)

This document describes the collaborator system.

## Collaborators

A collaborator is a user who has direct access to a workspace they do not own. Each collaborator holds **access** made of grants:

- **`build`** -- full access to the workspace: edit code, use the AI chat, manage bindings, and interact with every gadget's UI -- the same as the owner, modulo the owner-only exceptions below.
- **`use` of one gadget** -- may only render and interact with that gadget's deployed UI. A collaborator can hold any number of these, granted independently. Concretely, a `use` collaborator may call `getUiBundle()`, `connectToGadget()`, `getExportFormats()` and `export()` against the mainline code of a gadget they hold (`chatId` must be omitted), read basic workspace metadata via `getMetadata()`/`subscribeToMetadata()` (restricted to `id`/`title`/`owner`/`role`), list the gadgets they hold via `subscribeToWorkpieces()`, and call `subscribeToPresence()` to see active viewers' names, profile IDs, and roles. Every other `Overseer` method throws `Unauthorized`, with two exceptions: `subscribeToConsoleLogs()` and `subscribeToActions()` return inert subscriptions that never deliver data (no console logs; an empty, immediately-`ready()` action log). The editor opens both speculatively from top-level hooks before switching to the use-only view, so resolving them quietly avoids spurious client-side errors while still revealing nothing else.

New grants are `build` or `use` of a single gadget (`CollaboratorGrant`: `"build"` or `{gadgetId}`). Before gadgets were shared individually, `use` was granted on the whole workspace; collaborators who hold such a grant keep it unchanged -- `use` of every gadget, including gadgets added later -- but it can no longer be granted (see "Legacy workspace-wide `use`" below). A collaborator's effective access (`CollaboratorAccess`) is `{role: "build"}` or `{role: "use", gadgetIds}`, where `gadgetIds` is `"all"` for a legacy grant.

`build` collaborators differ from the owner in a few ways:

- **Cannot delete the gadget.** Only the owner can do this.
- **Use their own AI models.** When a collaborator engages AI chat, the model is resolved from their own account (BYOK billing goes to whoever prompted the AI, not the gadget owner).
- **Use their own connected accounts for bindings.** When a collaborator adds a gatekeeper binding, it connects through that collaborator's third-party accounts, not the owner's. This prevents collaborators from gaining access to the owner's accounts beyond what the gadget's existing bindings already expose.
- **Limited revocation authority.** A collaborator can only remove users that they themselves added (see "Permission graph" below).

A caller may never grant access they don't hold. Today only the owner and `build` collaborators can share at all (sharing methods are not in the `use` allowlist), so in practice gadget access is granted by the owner or a `build` collaborator. The permission graph nevertheless models access generally, so allowing `use` collaborators to reshare the gadgets they hold in the future requires no algorithmic changes.

### Restricted capability

Authorization is capability-based: `open()` computes the caller's effective access from the permission graph and hands back a different object depending on the result. `build`/owner sessions get the full `OverseerClientInterface`; `use` sessions get a `UseOverseerInterface` that implements the entire `Overseer` interface but throws `Unauthorized` for everything outside the `use` allowlist (except the two inert telemetry subscriptions noted above). Presence is intentionally in the allowlist and exposes active viewers' names, profile IDs, and roles. Because that class `implements Overseer`, any newly-added interface method fails to compile until a developer consciously decides whether `use` callers may invoke it (default-deny).

The `UseOverseerInterface` is a workspace shell: opening it verifies nothing (see "Authorization model"), and it lists only the gadgets the collaborator's access includes. Each gadget is obtained separately through `getGadget(id, configureObservers)`, which re-reads the collaborator's access, refuses a gadget it does not include exactly as it refuses one that doesn't exist, verifies the collaborator as an observer of that one gadget, and only then returns a restricted, mainline-only `UseGadgetClientInterface`.

### Adding collaborators

There are two ways to grant someone collaborator access:

**Direct add.** The owner or an existing collaborator enters a username (an email address on OAuth/CF Access deployments; a normalized alphanumeric handle on password deployments) in one of the two sharing dialogs, which fixes what it grants: **Invite to workspace** grants the workspace (`build`), and **Share gadget**, in the gadget pane, grants that one gadget. The system looks up the corresponding user account; if it exists, a collaborator record is created, or the grant is added to their existing one. The target user does not receive an in-product notification -- the sharer is expected to send them a link or tell them out of band. Each dialog lists who holds what it grants: the workspace's members, or the people given the gadget beneath a reminder that every workspace member can edit it. Removing someone from a gadget's dialog removes only their grants of that gadget. People holding legacy workspace-wide `use` are listed separately in both, and only the workspace dialog can remove them, since that takes all of their access.

**Share link.** Any collaborator (or the owner) can create a share link from either dialog, granting what that dialog does, which encodes a secret key in the URL as a `#share=<key>` fragment (a link to one gadget also names it with `?w=<gadgetId>`, so it opens on that gadget). Anyone who opens this link is automatically added as a collaborator with that grant. A link is a durable handle that owns one or more keys: creating it mints its first key, and "copying" the link later mints another key for the same link. A link's grant is fixed when it is created. The raw key is shown to the creator only once at mint time and is never stored server-side, so re-copying can't reproduce an old key -- it mints a new one. Any of a link's keys can be redeemed by multiple people, or the same person multiple times, until the link is revoked, which invalidates every key minted for it.

Share key security: the server generates a random 128-bit key and stores only its HMAC-SHA-256 hash (using a fixed domain-separation constant, `SHARE_KEY_HMAC_KEY`). When a user redeems a share link, the client sends the raw key to the server, which computes the hash and looks it up. This means the server cannot reconstruct share links from its stored data, and a database leak does not expose valid share keys.

Storage shape: a link is its first key. The `shareKeys` table holds one row per key: the row for the first key carries the link's metadata and is keyed by that key's hash, which serves as the link id. Each later copy stores only an `alias` pointing back at that id.

Share key redemption and workspace opening happen atomically in a single RPC call (`openWorkspace(id, shareKey)`), which allows subsequent calls to be pipelined on the returned `Overseer` stub without waiting for a separate redemption step.

Redemption is **one-step**: redeeming a key writes the recipient's `shareKey` edge immediately, making them a collaborator like any other before the redeeming open()'s observer verification runs. A recipient whose verification then fails keeps the edge -- see Known limitations.

### Home page behavior

A shared workspace does not appear on a collaborator's home page until they first open it. At that point, a record is created in the collaborator's user account (via `UserDurableObject.recordSharedWorkspaceOpen()`), storing a cached copy of the workspace's title and the owner's profile. The `lastActive` timestamp is updated each time they open the workspace.

Shared workspaces appear in the same list as owned workspaces on the home page, distinguished by showing the owner's name in the "Owner" column. Collaborators can dismiss a shared workspace from their home page (removing the record from their user account), but this does not revoke their access -- if they open the workspace again via its URL, it reappears.

When a collaborator's access is revoked, the stale record remains on their home page (we don't proactively reach into their account to remove it). The next time they try to open it, `open()` returns a workspace access-denied error and the client tells them they no longer have access without showing the workspace name or other metadata. They can dismiss the dead entry manually.

## Permission graph

The sharing system tracks *how* each collaborator gained access, forming a directed graph of permission edges. This graph is the foundation for transitive revocation.

### Edges

Each collaborator has one or more **permission edges** explaining how they got access. There are two edge types:

- **User edge**: records that a specific sharer (identified by `profile.id`) directly added this collaborator. Includes a timestamp, the grant (`role`, plus `gadgetId` for a `use` grant of one gadget), and an optional note. A sharer's edges to one person never repeat each other: `build` covers every gadget, and so does a legacy workspace-wide `use` grant, so the only way one sharer holds several edges to one person is several individual gadgets. Granting something one of the sharer's edges already covers only updates that edge's note (granting less never narrows anyone); granting more replaces the sharer's narrower edges with one.
- **Share-link edge**: records that this collaborator redeemed a key for a specific share link (identified by `keyId`, the id of the link's first key). Includes a timestamp; the grant is taken from the link (the edge carries a copy for display).

A collaborator can accumulate multiple edges -- for example, if they were added directly by Alice and also redeemed a share link created by Bob. The collaborator retains access as long as they have at least one valid edge.

(Edges and share links created before roles were introduced have no `role` field; they are treated as `build` for backwards compatibility. A `use` edge or link without a `gadgetId` is a legacy workspace-wide grant; see below.)

### Effective access

A collaborator's **effective access** is everything reachable from the owner through their valid edges. Each edge grants what it confers (its grant) intersected with its sharer's effective access: the owner is the implicit root with `build`, a user edge's sharer is the owner or another collaborator, and a share-link edge's "sharer" is the link's creator. A collaborator's effective access is the union of what all their valid edges grant. Intersection and union treat `build` as covering every gadget and each gadget as independent: someone holding only gadget A supports grants of A, and nothing they ever granted of gadget B. A grant of a gadget that no longer exists (or is still provisional to a chat) confers nothing. Effective access is computed live (it is never denormalized into storage), so it is always consistent with the current graph -- which also means a session's access is recomputed from scratch at each `open()`, and a gadget's at each `getGadget()`.

### Legacy workspace-wide `use`

Edges and links granting `use` without a `gadgetId` predate gadget-level sharing. They stay in the graph unchanged and keep meaning what they meant: `use` of every gadget in the workspace, including gadgets created afterwards, and never `build`. They are subject to the same propagation, revocation and `ownerInvitesOnly` rules as any other edge. What changed is that nothing new is granted that way: the sharing RPCs take only `"build"` or `{gadgetId}`, a legacy link can't be copied (`newShareLinkKey` refuses it), and redeeming one adds no edge -- people who redeemed it before keep the edge they hold, while anyone else gets no access from it. The one exception is `keepUsers` re-rooting, which can write such an edge to keep access someone already had.

### Share links in the graph

Share links are first-class nodes in the permission graph, connected to their creator. A share link is "supported" by its creator: if the creator loses access, the link is transitively revoked, which in turn removes anyone who gained access solely through it.

Concretely, revoking a share link or removing its creator triggers the same transitive revocation algorithm described below, treating all edges referencing that link as invalid. A link may have several keys, but they all resolve to the same link node, so redeeming any of them yields one edge. Because a link's grant is fixed and stored on the link, every key of it grants the same thing.

### The owner as root

The owner is the implicit root of the permission graph. The owner is never stored in the collaborators table and cannot be removed. All permission chains must ultimately trace back to the owner (or to someone the owner added, or someone *they* added, etc.) for access to be valid.

## Lazy revocation

Access is determined by **reachability from the owner**, recomputed live at every `open()` (see "Authorization model" below). Revocation exploits this: rather than eagerly cascading and deleting records, the system only **severs the edges that grant the removed party access** and lets reachability do the rest.

- **Removing a collaborator** deletes the edges that grant *them* access -- or, given a `gadgetId`, only the edges granting that gadget (access the target holds through `build` or a legacy workspace-wide grant is unaffected). The owner severs *all* such incoming edges to the target; a non-owner severs only their own `user` edges. The target's record is retained even if it becomes empty, and crucially the edges where the target is the *sharer* of access to others are left untouched.
- **Revoking a share link** sets the link's `revoked` flag instead of deleting it. A revoked link contributes nothing to the permission graph and none of its keys can be redeemed, but the link record and all edges referencing it stay intact (no dangling references). The link's copies are deleted outright, since no edge ever references an alias.

Nothing cascades. A dependent who loses their only path to the owner (e.g. Carol, reachable only via the removed Bob) simply becomes unreachable -- they are denied at `open()` time, not pruned from storage. This is the example from the introduction: removing Bob makes Carol unreachable automatically, with no separate cleanup step.

### Restoring access (undo)

Because the graph is never destructively pruned, revocation is reversible. If you accidentally remove someone who had in turn shared with five other people, you can **undo** simply by re-adding them: their record and their five outgoing grants were never deleted, so re-adding an edge from the owner restores their reachability and, transitively, all five downstream collaborators. (Share-link revocation is likewise non-destructive via the `revoked` flag, though there is no UI to un-revoke a link yet -- see Future work.) The undo applies only while `ownerInvitesOnly` is unset: once it is set, only direct grants from the owner count, so re-adding someone restores nobody else (see "`ownerInvitesOnly`").

This does mean removed collaborators and revoked links accumulate in storage. Listing RPCs (`listCollaborators`, `listShareLinks`) return only currently-active entries, so removed users disappear from the UI; a future GC could reclaim long-dead records.

### Effective-access algorithm

The core is a **fixed-point access-propagation computation** implemented in `SharingManager.computeEffectiveAccess()`. It computes the effective access of every collaborator (given an optional hypothetical change), returning a map from profile ID to `CollaboratorAccess` (absence from the map means no access). It is the single source of truth: `open()`, `getGadget()`, the listing RPCs, and the preview methods all derive from it.

Inputs (all optional; used to model a hypothetical change):
- `severed` -- a predicate over `(target, edge)` naming edges to treat as removed. Previews of a removal pass the same predicate the removal itself uses.
- `revokedLinkId` -- a share link ID to treat as revoked.

Once `ownerInvitesOnly` is set, the computation follows only `user` edges whose sharer is the owner (see "`ownerInvitesOnly`").

The algorithm:

1. **Collect share-link metadata.** Build a map from link ID to `{creator, grant}`, skipping links that are `revoked` (or the hypothetical `revokedLinkId`), and links granting a gadget that can't be shared.
2. **Iterate to fixed point.** Repeatedly scan all collaborators. For each edge, compute what it grants -- its grant intersected with its sharer's access, where the sharer (or share link creator) is the owner (always `build`) or another collaborator's current effective access -- and add it to the collaborator's access. Widening one collaborator's access may unlock or widen others on the next pass.
3. **Converge.** Access only ever widens, so the loop terminates when a full pass changes nothing.
4. **Return the access map.** Collaborators absent from the map have no access; collaborators present with less than before have been narrowed.

This is a least fixed point, so it handles arbitrary graph shapes: diamonds (a user reachable via two independent paths), cycles (mutual adds; a cycle nobody outside it supports grants nothing), and deep chains.

### Removals and narrowing

Because edges carry grants, severing an upstream edge or revoking a link may either remove a user (they lose all access) or merely **narrow** their access (they keep some via another path: `build` reduced to some gadgets, or one gadget of several lost). `removeCollaborator`/`revokeShareLink` return the affected set by diffing the effective-access map captured before the change against the map recomputed after: each entry is an `AffectedCollaborator` carrying `oldAccess` and `newAccess` (with `newAccess === null` meaning full removal). Losing gadget A while keeping gadget B is a narrowing like any other.

### Preview and confirm

Revocation is a two-phase process in the UI:

1. **Preview.** Before changing anything, the frontend calls `previewRemoveCollaborator()` or `previewRevokeShareLink()`, which runs the effective-access computation with the corresponding hypothetical input and returns the `AffectedCollaborator`s whose access would narrow. If non-empty, the UI can warn the user (e.g. "removing Bob will also cut off Carol").
2. **Confirm.** The frontend calls `removeCollaborator(profileId, keepUsers, gadgetId?)` or `revokeShareLink(linkId, keepUsers)`. Both perform the lazy edge-severance described above and return the actually-affected set.

### keepUsers (optional re-rooting)

`keepUsers` lets the caller spare specific dependents from a removal/revocation. After the edge is severed, `#reRootKeptUsers` recomputes effective access and, for each listed user whose access would otherwise narrow, gives them fresh `user` edges from the caller restoring exactly what they lost (bounded by what the caller holds): `build`, the gadgets lost, or a legacy workspace-wide `use` grant, which is kept rather than newly assigned. This is pure convenience layered on top of the lazy model -- the same effect is achievable by re-adding the intermediary, or by granting the dependent access directly.

### Non-owner removal

A non-owner can only sever their own `user` edges to the target (and only if such an edge exists -- otherwise the call is rejected). If the target still has edges from other sources, they retain the access those grant; if the caller's edges were their only support, the target becomes unreachable like any other lazily-removed user.

## Resource isolation between collaborators

Collaborators share the gadget's code, storage, and AI chat history, but certain resources are scoped to individual users:

- **AI model bindings** resolve from the account of whoever created the binding. This is baked in at binding creation time for AI model gatekeepers (the full `AiModelConfig` including API key is stored in the binding props). For agent spawners, the creating user's DO ID is stored in `AgentSpawnerBindingProps.creatorUserId` so the model can be resolved at trigger time from the correct account.
- **Gatekeeper bindings** connect through the third-party accounts of whoever created them (`OverseerClientInterface.newGatekeeper()` calls `clientUser.getGatekeeperClassFor()` rather than `owner.getGatekeeperClassFor()`, and a resource the agent creates with `createExternalResource` is created in the account its approver chooses).

This means no collaborator implicitly gains access to another user's connected third-party accounts.

## Authorization model

Authorization is enforced at `open()`: the method computes the caller's effective access from the permission graph (`getEffectiveAccess()`), treating the owner as the implicit `build` root. A caller with no effective access receives `WORKSPACE_ACCESS_DENIED`, while an uninitialized or deleted gadget receives `WORKSPACE_NOT_FOUND`. This distinction acknowledges that an initialized workspace exists, but the denial exposes no workspace name, owner, or content. Otherwise the access selects which capability is returned (full `OverseerClientInterface` for `build`/owner, restricted `UseOverseerInterface` for `use`). (Note: `UseOverseerInterface` still throws `Unauthorized` when a *valid* `use` collaborator calls a `build`-only method -- that's a different case, where existence is already known and only the operation is denied.)

A `build` collaborator is verified as an observer of everything the workspace has read inside `open()`. A `use` collaborator is not: the shell `open()` hands them shows nothing any gadget has read. Instead, `UseOverseerInterface.getGadget(id, configureObservers)` (`OverseerImpl.authorizeGadget`) checks their live access includes that gadget and that it can be opened, and verifies them as an observer of what *that gadget* reaches (see docs/observers.md, "Grant-based breadth of verification"). Each gadget is verified on its own: someone given gadgets A and B who can't verify B still opens A, and failing B leaves an A they already hold alone. Requirements reported as `ObservationDescription.subresources` record which gadget read what and are checked only for the contexts that gadget reaches. This is additive: every in-scope connection still runs `addObserver()`, and its `excludeObservers` still applies connection-wide, so two gadgets sharing a connection may still constrain each other's collaborators through the gatekeeper's own checks, including reads that omit `subresources` and history from before it began reporting them.

Because access is recomputed from the graph on every `open()` and `getGadget()`, the live computation is the *sole* source of truth for access -- there is no eager cleanup whose bugs could grant access to an unreachable user. This is what makes lazy revocation safe: severing an edge is enough to deny access, even though the unreachable records linger in storage.

A share-key redemption goes through the same gate. The redeeming open() then verifies a `build` recipient as an observer like any other collaborator, and a gadget recipient when they get the gadget; a recipient whose verification fails persists as an unverified collaborator until removed (see Known limitations).

### `ownerInvitesOnly`

A gatekeeper whose data source requires each recipient to be granted access individually can mark an observation `ownerInvitesOnly` (`ObservationDescription` in `packages/workshop-shared/src/gatekeeper.ts`, typically alongside `containsRestrictedData`). Once any such observation is authorized, the Overseer permanently sets the `ownerInvitesOnly` storage flag (in `authorizeObservation`, after the exclusion gate, so a refused observation sets nothing). From then on, **only direct grants from the owner count**: `computeEffectiveAccess` skips every share-link edge (even for a link the owner created) and every `user` edge from anyone but the owner. Because every access decision derives from that computation, `open()`, `getGadget()`, `listCollaborators`, and the removal previews agree without further checks. The flag covers the whole workspace: an owner grant of gadget A still grants only A.

- **Link joiners and transitively added people lose access.** Anyone who reached the workspace through a link or through another collaborator is denied at their next `open()` and disappears from `listCollaborators`. A collaborator whose owner edges grant less than they had reached transitively is narrowed to what those grant. People the owner kept during a removal (`keepUsers`) hold owner edges, so they count as direct.
- **The workspace restarts if anyone lost access.** `authorizeObservation` snapshots effective access before setting the flag, diffs it afterwards, and if anyone's access narrowed schedules the same restart as a revocation (see below), then tears down their observer records and cached listings best-effort without making the observation wait.
- **The owner can re-add them directly.** Adding someone by username creates an owner edge, and they open after passing verification like anyone else.
- **Re-adding an intermediary restores nobody else.** If Alice added Bob, Bob added Carol, and Alice removed Bob, re-adding Bob after the flag is set brings back only Bob; Carol needs her own grant from Alice. The lazy undo (see Restoring access) applies only while the flag is unset.
- **No new links.** `createShareLink` and `newShareLinkKey` throw "Share links are disabled…".
- **No redemption for people without owner grants.** Redeeming a still-active link throws the same message, coded `OPEN_WORKSPACE_ERROR_CODES.shareLinksDisabled`, for anyone the owner has not added directly, including people who joined through a link before the flag was set. The error page lets them retry once the owner adds them. A direct collaborator reopening an old link is let through, but no edge is added.
- **Owner-only direct adds.** `addCollaborator` throws for non-owners, whose grants would count for nothing.

The owner can still list, rename, and revoke links (which no longer grant anything) and remove collaborators. `WorkspaceMetadata.ownerInvitesOnly` reports the flag, and the Share modal hides link controls (and, for non-owners, the invite box).

The policy lives in the Overseer, which passes it into `SharingManager` as a hook. Each grant checks it after its last await, right before the storage write, so an observation that sets the flag mid-call cannot slip a grant through.

**Residual:** the observation that sets the flag is delivered to the gatekeeper's caller before the restart lands (~100ms later), so a session held by someone who is about to lose access stays live for that window.

### Terminating live sessions on revocation or scope growth

Authorization is only checked at `open()` and `getGadget()`, so a session that is *already* open is not re-checked per message. Without intervention, a collaborator who was just removed or narrowed could keep using their live session until something else disconnected them. To close this gap, `removeCollaborator`/`revokeShareLink` (and `authorizeObservation`, when setting `ownerInvitesOnly` revokes access) proactively restart the gadget's Overseer DO via `ctx.abort()` whenever the change actually narrowed someone's access (i.e. the returned `AffectedCollaborator[]` is non-empty; pure no-op removals don't restart). Aborting forcibly disconnects every client; each reconnects and re-runs `open()`, which re-evaluates the now-changed permission graph -- sending removed users to the terminal access-denied page and handing narrowed users their reduced capability (the editor swaps to the `use` view automatically based on `metadata.role`, and a `use` shell lists only the gadgets still held). Since removals are rare (and DOs restart unpredictably anyway, so reconnects are already cheap), the disruption is acceptable. A narrowed collaborator's cached Outputs index is re-synced to the gadgets they still hold, best-effort.

Two precautions surround the abort (`OverseerImpl.scheduleAccessRestart`): the severed edge is flushed with `ctx.storage.sync()` first (because `ctx.abort()` does not respect the output gate, a restart could otherwise come back with the change lost), and the abort is delayed ~100ms so the triggering RPC's response reaches the caller -- typically the owner, who is also connected -- before their own connection drops. The disconnect reaches the browser through the existing `notifyClosed` plumbing: when the Overseer DO aborts, the per-session `notifyClosed` stub is disposed without being called, which `AuthenticatedApiImpl` treats as a lost connection and reacts to by killing the browser WebSocket, forcing a reconnect. The client discards its retained share key on the first successful open, so this forced reconnect after a removal is keyless and lands the removed collaborator on the access-denied page rather than silently re-redeeming the still-active link (which would undo the removal and break the assumption stated above). The residual is unchanged: the *link* itself survives a collaborator removal under the lazy model, so a recipient who kept the URL can still re-redeem it manually until the owner revokes it -- the discard removes only the client's automatic re-grant.

The abort also lands later than the ~100ms delay alone suggests: the revocation handlers first await the observer teardown (`tearDownLostObservers`, a per-collaborator `removeObserver` fan-out) and the listing refresh (`refreshAffectedCollaboratorListings`, chunked cross-DO round trips), so the removed users' sessions stay live and watching for a window that scales with collaborator and gatekeeper count.

Granting or widening access never strands anyone: a live session's capability is fixed at open, so a `use` collaborator promoted to `build` in the graph still holds `UseOverseerInterface` until they re-open, and one given another gadget sees it listed after they re-open (`getGadget` re-reads access, so they can get it sooner by id). Nobody is newly excluded from anything.

The same abort serves a second purpose, though, and there the trigger is a *grant*: per-connection observer verification (see docs/observers.md) also runs only at `open()` and `getGadget()` (only reads that report `subresources` are also checked as they happen), so widening what a collaborator must be verified against leaves their live session holding access they were never verified for. `OverseerImpl.#restartIfSessionsAffected` restarts the workspace whenever that happens -- a connection is added, one is bound into a gadget, an agent spawner bound into a gadget exposes another gadget (whose recorded history the first gadget's holders were never verified against), or a merge promotes such a binding -- so every client re-opens and re-runs `ensureObserver` at the new scope. It is a no-op unless a collaborator session holding what widened is live -- a `build` session for a new connection, a session holding the gadget for a gadget's widening -- since severing sessions is all a restart does, so a solo workspace, or one whose collaborators are all disconnected or hold only other gadgets, is never disturbed. See docs/observers.md, "Restarting when verification scope widens", for the full trigger list and the reasoning about what deliberately does *not* trigger it.

The abort has a third use, unrelated to access. A workspace can get stuck with every call it makes to a User DO failing on "Subrequest depth limit exceeded. This request looped back into the Workers runtime too many times." until its Overseer DO is replaced. When one of the workspace's own User DO calls is rejected with that error, `OverseerImpl.restartIfLoopLimited` schedules the same restart, at most once per instance and never in an instance's first 60 seconds. The rejected call still fails. Errors thrown by gadgets, agents or gatekeeper facets are not checked, so they cannot restart a shared workspace.

## Future work

- **More permission levels.** Beyond `build` and `use` of a gadget, planned levels include: chat-only (can create chats but not merge to mainline) and read-only.
- **Resharing of gadget access.** Allow `use` collaborators to grant the gadgets they hold to others. The permission graph already supports this; it only requires adding the relevant sharing methods to the `use` allowlist.
- **Binding-aware access control.** Prohibit adding collaborators when the gadget holds binding permissions that the collaborator lacks, and conversely prohibit adding sensitive bindings when existing collaborators lack the required permissions.
- **Share link expiration and usage limits.** Including single-use links.
- **Un-revoking share links.** Revocation is non-destructive (the `revoked` flag), but there is no UI or RPC to list revoked links or clear the flag, so link revocation is currently one-way in practice.
- **Garbage-collecting dead records.** Removed collaborators and revoked links accumulate in storage under the lazy model; a background sweep could reclaim entries that have been unreachable for a long time.
- **Notifications.** Currently there are no in-product notifications for access grants or revocations.

## Known limitations

Revocations and role changes take effect within seconds -- the revocation restart lands in
~100ms -- and read-side races inside that envelope are accepted by design; only guards against
*persistent* wrong state remain. Each item below is marked at its site in the code by a matching
`TODO` comment.

- **An unverified redeemer persists as a collaborator.** Redemption writes a real edge before the
  redeeming open's observer verification runs, so from the moment a recipient clicks the link they
  appear in `listCollaborators` whether or not they ever complete the open. They cannot reach the
  workspace -- verification denies them at open. Remedies: they verify (complete the open), the
  owner removes them, or the link is revoked. Two-phase redemption (a pending edge granting
  nothing until verification confirms it) is the planned fix.
- **A refused recipient persists.** A recipient whose verification is refused keeps their edge:
  they appear in `listCollaborators` until the owner removes them (or revokes the link), with the
  same consequences as the previous item, and covered by the same planned fix.
