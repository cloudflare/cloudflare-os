# Spaces

A space groups users and workspaces: it is a key, a display name, a list of members and a listing of the workspaces that belong to it. Every user has one **personal space**, and any signed-in user may create **team spaces**. Every workspace belongs to exactly one space: its owner's personal space, unless the owner placed it in a team space. The space's own member list is the only authority on who belongs to it and in what role; the owner's record of a workspace is the only authority on which space it belongs to. The kernel side is `packages/workshop-backend/src/spaces.ts` and the "Spaces" and "Workspaces in spaces" parts of `user.ts`; the API is listed under "API surface" below.

Belonging to a space decides where a workspace is listed and who sees it listed, and nothing else. A member's role grants nothing on a workspace: whether a user can open one is decided by that workspace's own sharing (see docs/sharing.md).

## The model

There are two kinds of space (`SpaceKind`), fixed when the space is created. Spaces form a flat list: a space has no parent and contains no other space.

| | Personal space | Team space |
|---|---|---|
| Created | For each user, the first time it is needed: by `listSpaces()`, or by a workspace of theirs that belongs in it | By any signed-in user, with `createSpace(key, name)` |
| Key | `~` followed by a part the server chooses, e.g. `~alice` or `~alice-2` | Chosen by the creator |
| Name | The owner's display name when the space was created | Given by the creator: trimmed, then 1 to 100 characters |
| Admins | The owner, and nobody else | One or more of its members |
| Other members | Allowed, as `build` or `use` | Allowed, in any role |
| Adds workspaces | The owner, and nobody else | Any member, whatever their role |

### Keys

A **team key** matches `TEAM_SPACE_KEY_PATTERN`, `[a-z0-9][a-z0-9-]{1,31}`: 2 to 32 lowercase ASCII letters, digits and dashes, the first not a dash. No key that matches is reserved. A **personal key** is `PERSONAL_SPACE_PREFIX` (`~`) followed by a string of the same grammar. A team key cannot start with `~`, so the two kinds never collide. `isValidTeamSpaceKey()` and `isValidSpaceKey()` are the checks `createSpace` and `openSpace` apply, and the first is also what `newGadget` and `moveToSpace` hold a `spaceKey` to; they are exported so a client refuses the same keys. A key is unique and immutable, and it is never released: nothing renames or deletes a space.

### Members and roles

Every member holds exactly one `SpaceMemberRole`, and being a member in any role is what lets a user open the space:

- **`admin`** -- may also change the member list (`Space.setMemberRole`, `Space.removeMember`).
- **`build`** and **`use`** -- ordinary members, named after the `CollaboratorRole` levels (see docs/sharing.md). In the space itself the two confer the same thing: reading its info, its member list and its listing of workspaces, adding workspaces of their own to a team space, and leaving it.

`setMemberRole(username, role)` sets a role *exactly*: it adds a non-member, and raises or lowers an existing member, who keeps their `added` date. `removeMember(profileId)` lets an admin remove anyone and any other member remove only themself, which is how one leaves a space; an admin removing someone who is not a member does nothing.

A refused open does not say whether the space exists: a key nobody has claimed and a space the caller does not belong to are refused with one error (`noSuchSpace()`).

### Invariants

`SpaceModel` holds the rules of a space, for its members and for its listing, as pure logic over typed storage, with no RPC, so they are unit-tested directly (`packages/workshop-backend/__tests__/spaces.test.ts`). `SpaceDurableObject` is a thin shell around it that adds the account lookup and the mirror pushes.

- **A space always has at least one admin.** Demoting or removing its last admin throws.
- **A personal space's owner is its only admin.** Nobody else can be made admin, and so, by the rule above, the owner can be neither demoted nor removed.

## Where the state lives

**One Durable Object per space.** Each space is a `SpaceDurableObject`, addressed by `getByName(spaceKey)`. Its storage (`storage-schema/space-storage.ts`) is a singleton `info` -- the key, name, kind and, for a personal space, the owner; absent until the key is claimed and never removed -- a collection `members` keyed by profile id, and a collection `workspaces` keyed by workspace id (the listing, see "Workspaces in a space"). A personal space's owner is stored in `members` too, as its only admin.

**No directory.** No object lists the spaces or the keys in use. A key is taken once the object under it has been claimed, and whether it has is asked of that object.

**The user's own Durable Object** holds, besides its records of the user's workspaces (see "Workspaces in a space"), two things (`storage-schema/user-storage.ts`), neither of which authorizes anything:

- `personalSpaceKey` -- the key of the user's personal space, once one has been claimed for them. It says which space to list first, and which space lists the user's workspaces that are in no team space.
- `spaces` -- a **mirror** of the user's memberships, one `SpaceInfo` per space with `role` set to that user's role. Once `personalSpaceKey` is set, `listSpaces()` is answered from the user's own object alone, waiting on no call to any space.

### The mirror

The mirror is presentation only, like the record a recipient's account keeps of a workspace shared with them (`UserDurableObject.recordSharedGadgetOpen()`, see docs/sharing.md). Every operation on a space is decided from what the space itself stores at the time of the call -- its `info`, its member list and, for an entry of its listing, the owner that entry is listed under (see "Workspaces in a space"); nothing is ever authorized from the mirror.

The space keeps it current by pushing to the affected user's object -- `recordSpaceMembership(info)` after `setMemberRole`, `forgetSpace(key)` after `removeMember`. The push is best-effort: the member list is already written, so a push that fails is logged (`space.membership.mirror.failed`) and the change stands. Opening is what heals a lost push: before `SpaceDurableObject.open` answers, the space makes the same push for the caller, recording their membership if they have one and dropping the key if they do not. So a listed space may still refuse to open, and a membership the mirror missed appears once that space has been opened by key.

## Claiming a key

`SpaceModel.claim(claim, creator)` creates the space: in one transaction it writes `info` and makes `creator` the first admin and, for a personal space, the owner, so a claim that fails leaves the key unclaimed. It returns whether `creator` now holds the key in the way they asked for.

- **The first claim wins.** The Durable Object serializes claims, so two users claiming one key at once get exactly one `true`.
- **One idempotent case.** The owner of a personal space claiming it again as their personal space gets `true`, and nothing changes. That is what lets a personal allocation resume (below).
- **A claim is never a takeover.** Every other claim of a claimed key returns `false` and changes nothing. Since the object under a key is the space, a claim that could rewrite it would hand the space and its member list to whoever asked.

`createSpace(key, name)` makes the claim for a team space and refuses a `false` as "already exists" -- also when the earlier claimant was the caller, and so disclosing that the key is taken. It then opens the space, and that open is what records it in the creator's mirror.

## Personal space allocation

`listSpaces()` first ensures the caller's personal space (`UserDurableObject.#ensurePersonalSpace()`), as does anything that needs the space a workspace with no `spaceKey` belongs to. If `personalSpaceKey` is set there is nothing to do. Otherwise the user's object claims the candidates of `personalSpaceClaim(owner, attempt)` in order -- `~base`, `~base-2`, `~base-3`, ... -- until a space grants one, then remembers that key and writes the mirror record.

The base is the local part of the profile id (what precedes any `@`), reduced to the key alphabet and cut so that the suffix still fits the grammar. Two users whose ids share a local part therefore get `~name` and `~name-2`, in the order their personal spaces are first needed. This is why the derivation is not part of the shared API: a client reads the key from the first entry of `listSpaces()` and never derives it from a user id.

- **Resumed, not restarted.** The key is remembered only once it has been granted. If the object stops between the claim and remembering it, the next allocation tries the same candidates in the same order, and the personal space grants its owner's claim again, so the user ends up on the key they had already claimed instead of stranding it and taking the next one.
- **Serialized.** Concurrent callers share one in-flight allocation, so they allocate one key between them.

## Workspaces in a space

Where a workspace belongs is recorded in two places, and only the first one counts.

- **The pointer** is `spaceKey` on the owner's record of the workspace in their User DO (`GadgetRecord`, which extends `GadgetMetadata`). It is only ever a team key; absent means the owner's personal space. The Overseer stores nothing about spaces, and a user's record of a workspace shared with them never carries a pointer.
- **The listing** is the space's `workspaces` collection: each workspace's id, title, a snapshot of its owner's profile and when it was created (`SpaceWorkspaceInfo`). `Space.listWorkspaces()` returns it to any member, newest first.

The pointer is the authority because the owner's record is already where the kernel keeps everything else a listing shows -- that the workspace exists, its title, when it was created, whether it has seen activity -- and is what a delete removes. So a space is told where a workspace belongs and is never asked. The listing follows the pointer and can lag it (below), so nothing about a workspace, or about who can open it, is decided from the listing. An entry decides one thing only, its own upkeep: it is updated or dropped only by the owner it is listed under.

**Who may add.** `SpaceModel.canAddWorkspaces(profileId)`: only the owner of a personal space; any member of a team space, `use` included. `attachWorkspaces(owner, registrations)` is an upsert that returns `false`, having changed nothing, if it refuses any registration. A workspace not yet listed needs `canAddWorkspaces(owner.id)`. One listed under the same owner is updated whether or not they may still add, which is how a workspace keeps its place, and a current title, after its owner leaves the space. One listed under another owner is refused. `detachWorkspace(id, ownerId)` removes an entry only if that owner holds it.

### Registration and the reconcile

A workspace registers with its space at its first activity, never when its record is created. `AuthenticatedApi.newGadget` creates a workspace *provisional*, before the user has sent anything, and it may never be used, so a record with no `lastActive` is listed nowhere. For `newGadgetFromBlueprint` the first activity is part of the creation: instantiating the blueprint marks the workspace active, which starts its registration. Both check only that a `spaceKey` is a well-formed team key and store the pointer.

`registered` on the record is the marker: the `{ spaceKey, title }` a space last acknowledged, where `spaceKey` is that space's real key, personal or team. It is the User DO's own bookkeeping: `listGadgets()` and `getGadget()` strip it. `UserDurableObject.#reconcileSpace(id)` is what brings a listing in line with its record; the only other things that write to a listing are the backfill's pages and a delete (both below). It does nothing for a provisional workspace, for one shared with this user, or when the marker already matches. Otherwise it **attaches** the workspace to the space the record points at, then **detaches** it from the space the marker names if that is a different one, and only then **writes the marker**.

A failure leaves the marker as it was, so the next reconcile does whatever is left. A refused attach has changed nothing. An attach or a detach that fails without an answer may or may not have been applied by the space; the marker is unwritten either way, and the next reconcile starts again from the attach, which is safe because the attach is an upsert and the detach does nothing for an entry already gone. Until then the workspace may be listed in both spaces; because the attach comes first, no failed reconcile leaves a listed workspace in neither. Everything that touches a listing runs on one chain per User DO (`#inSpaceOrder()`), so reconciles never interleave, whichever workspaces they are for.

`#syncSpace(id)` is the reconcile plus the fallback below. `setGadgetLastActive` (the first activity and every later one; a later one finds nothing to do unless a sync, a move or a delete that failed left the workspace out of step, which makes the next activity the usual retry) and `updateTitle` run it detached, logging a failure as `space.workspace.sync.failed`, so that it neither slows nor fails the Overseer's call. The move and the delete await it, and the backfill runs it.

### A refused registration, a refused move

**A sync falls back.** When a space refuses the attach during `#syncSpace` -- the owner may not add to the team space the record names, and the workspace is not already listed there -- the record is pointed back at the space that still lists the workspace or, if no other space does, at the owner's personal space, and reconciled again; `space.workspace.fallback` is logged at `info`. So a workspace created in a team space its owner may not add to ends up in their personal space, with no error.

**A move refuses.** `Overseer.moveToSpace(spaceKey)` is for the workspace's owner only and calls their `UserDurableObject.setGadgetSpace(id, spaceKey)`; `null` means the personal space. That first syncs the workspace where it is, then points the record at the target and reconciles. If the target refuses, the record is pointed back where it was and the call throws `noSuchSpace()`, the refusal an open gives, so the move has changed nothing and the answer does not say whether the space exists; the sync before it may have changed something all the same, for example by finishing an earlier move or falling back from one. If a call that reconcile makes to a space fails without an answer it may still have reached the space, so the record stays pointed at the target, and the next sync either finishes the move or, on a refusal, falls back to where the workspace is listed. For a provisional workspace a move only changes the pointer.

### Delete

`UserDurableObject.deleteGadget(id)` first syncs one of the user's own workspaces that has seen activity, which leaves the space the marker names as the only one that lists it. It then clears the marker, detaches the workspace from that space, and only then drops the record. If the sync or the detach fails, the delete fails and the record is kept, because once it is gone nothing would ever remove the entry. `Overseer.deleteSelf()` makes this call before it destroys the workspace's storage, so that storage is intact and its owner can delete the workspace again; by then its running agents have been cancelled and its enabled hooks disabled, and the hooks stay disabled. The marker is cleared before the detach, so a record that outlives a failed delete is listed again by its next sync. The sync comes first so that a marker never names a space that has dropped the workspace: the fallback of a refused sync takes the marker's word that its space still lists it.

### Backfill

`listSpaces()` starts `#backfillSpaces()` without waiting for it, once per Durable Object instance and again after one that failed (`space.workspace.backfill.failed`). It registers every workspace of the user's own that has seen activity and that its space has yet to acknowledge as it is now, reading the user's records only, so no Overseer is woken. Those with neither a marker nor a pointer, which includes every one older than the listing, go to the personal space in pages of up to 128 per `attachWorkspaces` call, and each page is marked once acknowledged, so a backfill that stops resumes with what is left. Every other record out of step goes through `#syncSpace`, which makes the backfill the retry for a sync that failed earlier on a workspace that has seen no activity since.

## Trust boundary

Every method `SpaceDurableObject` exposes takes the acting user as a plain parameter -- their profile id, or for `claim` and `attachWorkspaces` their profile -- like `OverseerDurableObject.open()`. Its only callers are `AuthenticatedApiImpl` (server.ts), which passes the identity of the authenticated session, and `UserDurableObject` (user.ts), which passes its own -- never a client, gadget, gatekeeper or agent -- so the parameter is authoritative.

`attachWorkspaces` and `detachWorkspace` are called by `UserDurableObject` alone, which states its own user as the owner, so a user's workspaces are only ever registered or dropped by that user's object. Neither is on `Space`.

A client only ever holds a `Space`: the `SpaceClientInterface` minted by `SpaceDurableObject.open()`, which closes over the caller fixed at open time. It carries no standing permission. Every method has the space look that user's membership up again, so a stub held by someone who has since been removed or demoted loses those powers at once, with no session to terminate.

`setMemberRole` checks that the caller is an admin *before* it resolves the username, so a non-admin cannot use it to find out which accounts exist. The lookup is the one `Overseer.addCollaborator` uses (`UserDurableObject.whoamiIfExists()`), and likewise returns null for a username with no account.

## API surface

- `AuthenticatedApi.listSpaces()` -- the caller's spaces from their mirror: their personal space first, then the others by name.
- `AuthenticatedApi.openSpace(key)` -- a `Space` acting as the caller. A malformed key throws; a well-formed one the caller cannot open gets the single refusal above.
- `AuthenticatedApi.createSpace(key, name)` -- claims a team key and opens the new space, with the caller as its first admin.
- `Space` -- `getInfo()`, `listMembers()` and `listWorkspaces()` for any member; `setMemberRole(username, role)` for admins; `removeMember(profileId)` for an admin, or a member removing themself.
- `AuthenticatedApi.newGadget(spaceKey?)` and `newGadgetFromBlueprint(blueprintId, bindings, spaceKey?)` -- create the workspace in a team space; omitted, in the caller's personal space. A malformed key throws.
- `Overseer.moveToSpace(spaceKey | null)` -- owner only: moves the workspace to a team space, or with `null` back to its owner's personal space.
- `GadgetMetadata.spaceKey` -- the team space a workspace belongs to, on its owner's own record only (so in `listGadgets()` for a workspace the caller owns); absent means the owner's personal space.

## Known limitations

- **Display names are snapshots.** The display name in a member record, in `SpaceInfo.owner`, in a personal space's `name` and in a listed workspace's `owner` may trail a rename. A listed workspace's title trails a change until its next sync.
- **A listing does not follow a workspace's own sharing.** Every member of a space sees the title, owner and creation date of each workspace it lists, whether or not they can open it. That holds for a workspace whose sharing is restricted too -- one under `ownerInvitesOnly` (docs/sharing.md) or holding restricted data (docs/observers.md) -- and the title shown may be one a model generated from the workspace's chat.
- **A workspace cannot be evicted.** It stays in a team space after its owner leaves or is removed, and only its owner can move or delete it: a space admin cannot take it off the listing.
- **Membership is checked at registration, not at creation.** `newGadget(spaceKey)` and `newGadgetFromBlueprint(…, spaceKey)` accept any well-formed team key, and a workspace whose owner may not add to that space falls back to their personal space at its first activity (for one made from a blueprint, as it is created), with nothing reported to the caller.
- **A workspace can be listed by two spaces.** During a move both list it between the attach and the detach, and when either call fails, possibly until the next sync.
- **The listing is not paginated.** `listWorkspaces()` returns every workspace of the space in one answer.
- **A lost mirror write hides a space until it is opened.** In particular, a team space whose creator's mirror write was lost is absent from their list until they open it by key.
- **Personal keys are probed in order.** Allocation claims `~base`, `~base-2`, ... one call at a time with no bound, so a user's allocation makes a call for every candidate already taken before the one it is granted.
