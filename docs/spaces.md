# Spaces

A space is a key, a display name and a list of members. Every user has one **personal space**, and any signed-in user may create **team spaces**. The space's own member list is the only authority on who belongs to it and in what role. The kernel side is `packages/workshop-backend/src/spaces.ts`; the API is `AuthenticatedApi`'s three space methods and the "Spaces" section of `packages/workshop-shared/src/api.ts`.

Spaces are the foundation for grouping workspaces. Placing workspaces in a space, addressing them under its key, and reaching them through membership all build on what is described here; today a member's role grants nothing on any workspace.

## The model

There are two kinds of space (`SpaceKind`), fixed when the space is created. Spaces form a flat list: a space has no parent and contains no other space.

| | Personal space | Team space |
|---|---|---|
| Created | For each user, the first time they call `listSpaces()` | By any signed-in user, with `createSpace(key, name)` |
| Key | `~` followed by a part the server chooses, e.g. `~alice` or `~alice-2` | Chosen by the creator |
| Name | The owner's display name when the space was created | Given by the creator: trimmed, then 1 to 100 characters |
| Admins | The owner, and nobody else | One or more of its members |
| Other members | Allowed, as `build` or `use` | Allowed, in any role |

### Keys

A **team key** matches `TEAM_SPACE_KEY_PATTERN`, `[a-z0-9][a-z0-9-]{1,31}`: 2 to 32 lowercase ASCII letters, digits and dashes, the first not a dash. No key that matches is reserved. A **personal key** is `PERSONAL_SPACE_PREFIX` (`~`) followed by a string of the same grammar. A team key cannot start with `~`, so the two kinds never collide. `isValidTeamSpaceKey()` and `isValidSpaceKey()` are the checks `createSpace` and `openSpace` apply, exported so a client refuses the same keys. A key is unique and immutable, and it is never released: nothing renames or deletes a space.

### Members and roles

Every member holds exactly one `SpaceMemberRole`, and being a member in any role is what lets a user open the space:

- **`admin`** -- may also change the member list (`Space.setMemberRole`, `Space.removeMember`).
- **`build`** and **`use`** -- ordinary members, named after the `CollaboratorRole` levels (see docs/sharing.md). In the space itself the two confer the same thing: reading its info and member list, and leaving it.

`setMemberRole(username, role)` sets a role *exactly*: it adds a non-member, and raises or lowers an existing member, who keeps their `added` date. `removeMember(profileId)` lets an admin remove anyone and any other member remove only themself, which is how one leaves a space; an admin removing someone who is not a member does nothing.

A refused open does not say whether the space exists: a key nobody has claimed and a space the caller does not belong to are refused with one error (`noSuchSpace()`).

### Invariants

`SpaceModel` holds the membership rules as pure logic over typed storage, with no RPC, so they are unit-tested directly (`packages/workshop-backend/__tests__/spaces.test.ts`). `SpaceDurableObject` is a thin shell around it that adds the account lookup and the mirror pushes.

- **A space always has at least one admin.** Demoting or removing its last admin throws.
- **A personal space's owner is its only admin.** Nobody else can be made admin, and so, by the rule above, the owner can be neither demoted nor removed.

## Where the state lives

**One Durable Object per space.** Each space is a `SpaceDurableObject`, addressed by `getByName(spaceKey)`. Its storage (`storage-schema/space-storage.ts`) is a singleton `info` -- the key, name, kind and, for a personal space, the owner; absent until the key is claimed and never removed -- and a collection `members` keyed by profile id. A personal space's owner is stored in `members` too, as its only admin.

**No directory.** No object lists the spaces or the keys in use. A key is taken once the object under it has been claimed, and whether it has is asked of that object.

**The user's own Durable Object** holds two things (`storage-schema/user-storage.ts`), neither of which authorizes anything:

- `personalSpaceKey` -- the key of the user's personal space, once one has been claimed for them. It says which space to list first.
- `spaces` -- a **mirror** of the user's memberships, one `SpaceInfo` per space with `role` set to that user's role. Once `personalSpaceKey` is set, `listSpaces()` is answered from the user's own object alone, with no call to any space.

### The mirror

The mirror is presentation only, like the record a recipient's account keeps of a workspace shared with them (`UserDurableObject.recordSharedGadgetOpen()`, see docs/sharing.md). Every operation on a space is decided from the space's member list at the time of the call; nothing is ever authorized from the mirror.

The space keeps it current by pushing to the affected user's object -- `recordSpaceMembership(info)` after `setMemberRole`, `forgetSpace(key)` after `removeMember`. The push is best-effort: the member list is already written, so a push that fails is logged (`space.membership.mirror.failed`) and the change stands. Opening is what heals a lost push: before `SpaceDurableObject.open` answers, the space makes the same push for the caller, recording their membership if they have one and dropping the key if they do not. So a listed space may still refuse to open, and a membership the mirror missed appears once that space has been opened by key.

## Claiming a key

`SpaceModel.claim(claim, creator)` creates the space: in one transaction it writes `info` and makes `creator` the first admin and, for a personal space, the owner, so a claim that fails leaves the key unclaimed. It returns whether `creator` now holds the key in the way they asked for.

- **The first claim wins.** The Durable Object serializes claims, so two users claiming one key at once get exactly one `true`.
- **One idempotent case.** The owner of a personal space claiming it again as their personal space gets `true`, and nothing changes. That is what lets a personal allocation resume (below).
- **A claim is never a takeover.** Every other claim of a claimed key returns `false` and changes nothing. Since the object under a key is the space, a claim that could rewrite it would hand the space and its member list to whoever asked.

`createSpace(key, name)` makes the claim for a team space and refuses a `false` as "already exists" -- also when the earlier claimant was the caller, and so disclosing that the key is taken. It then opens the space, and that open is what records it in the creator's mirror.

## Personal space allocation

`listSpaces()` first ensures the caller's personal space (`UserDurableObject.#ensurePersonalSpace()`). If `personalSpaceKey` is set there is nothing to do. Otherwise the user's object claims the candidates of `personalSpaceClaim(owner, attempt)` in order -- `~base`, `~base-2`, `~base-3`, ... -- until a space grants one, then remembers that key and writes the mirror record.

The base is the local part of the profile id (what precedes any `@`), reduced to the key alphabet and cut so that the suffix still fits the grammar. Two users whose ids share a local part therefore get `~name` and `~name-2`, in the order they first list their spaces. This is why the derivation is not part of the shared API: a client reads the key from the first entry of `listSpaces()` and never derives it from a user id.

- **Resumed, not restarted.** The key is remembered only once it has been granted. If the object stops between the claim and remembering it, the next allocation tries the same candidates in the same order, and the personal space grants its owner's claim again, so the user ends up on the key they had already claimed instead of stranding it and taking the next one.
- **Serialized.** Concurrent callers share one in-flight allocation, so they allocate one key between them.

## Trust boundary

Every method `SpaceDurableObject` exposes takes the acting user as a plain parameter -- their profile id, or for `claim` their profile -- like `OverseerDurableObject.open()`. Its only callers are `AuthenticatedApiImpl` (server.ts), which passes the identity of the authenticated session, and `UserDurableObject` (user.ts), which passes its own -- never a client, gadget, gatekeeper or agent -- so the parameter is authoritative.

A client only ever holds a `Space`: the `SpaceClientInterface` minted by `SpaceDurableObject.open()`, which closes over the caller fixed at open time. It carries no standing permission. Every method has the space look that user's membership up again, so a stub held by someone who has since been removed or demoted loses those powers at once, with no session to terminate.

`setMemberRole` checks that the caller is an admin *before* it resolves the username, so a non-admin cannot use it to find out which accounts exist. The lookup is the one `Overseer.addCollaborator` uses (`UserDurableObject.whoamiIfExists()`), and likewise returns null for a username with no account.

## API surface

- `AuthenticatedApi.listSpaces()` -- the caller's spaces from their mirror: their personal space first, then the others by name.
- `AuthenticatedApi.openSpace(key)` -- a `Space` acting as the caller. A malformed key throws; a well-formed one the caller cannot open gets the single refusal above.
- `AuthenticatedApi.createSpace(key, name)` -- claims a team key and opens the new space, with the caller as its first admin.
- `Space` -- `getInfo()` and `listMembers()` for any member; `setMemberRole(username, role)` for admins; `removeMember(profileId)` for an admin, or a member removing themself.

## Known limitations

- **Display names are snapshots.** The display name in a member record, in `SpaceInfo.owner` and in a personal space's `name` may trail a rename.
- **A lost mirror write hides a space until it is opened.** In particular, a team space whose creator's mirror write was lost is absent from their list until they open it by key.
- **Personal keys are probed in order.** Allocation claims `~base`, `~base-2`, ... one call at a time with no bound, so a user's first `listSpaces()` makes a call for every candidate already taken before the one it is granted.
