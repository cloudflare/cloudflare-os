# Space connectors

This is a proposal. Nothing in it is implemented: it describes how a space could be shared with a **connected account** (a gatekeeper account) so that the account may create workspaces in that space, and it ends with the decisions the owner of the project has to make. The model it builds on is docs/spaces.md and the "Space roles" and "Publishing to the deployment" sections of docs/sharing.md.

The motivating use is a wiki connector: a gatekeeper whose account reads a source wiki, syncing a subtree of it into a team space, one workspace per source page, each made from a "Wiki Page" blueprint. Today only a person can create a workspace (`AuthenticatedApi.newGadget`, `newGadgetFromBlueprint`), so a sync of a few hundred source pages would need a person to click through each one.

## The proposal in brief

- A space admin picks one of their **own** connected accounts in the space's members UI (`SpaceMembersDialog` in `workshop-frontend/src/features/spaces`) and grants it to the space.
- The kernel offers only an account whose description declares the capability statically. The gatekeeper cannot grant itself anything: the admin's choice and the declaration together are what grant it, as `AccountDescription.singleton` and `providesUi` are gated today.
- The space stores the grant. The kernel hands the account a loopback capability scoped to `{ spaceKey, grantId }`, minted the way a hook's `GatekeeperHookLoopback` is. It has one method: create a workspace in this space from a blueprint, with the grant's own account bound into it.
- Every call re-resolves the grant. Deleting the grant is the kill switch.
- A created workspace is owned by the **granting user**, registers with the space through the existing reconcile, and gets a slug from its title.

## The declaration and the grant

**The declaration.** A new optional member of `AccountDescription` (`packages/workshop-shared/src/gatekeeper.ts`), say `createsWorkspaces?: { blueprintIds: string[] }`, says that the account can use the capability and which blueprints it would instantiate. The user's Durable Object already keeps each account's description on its `ConnectedAccountRecord` (`storage-schema/user-storage.ts`) and refreshes it in `markCredentialsRestored`, so the kernel reads the declaration from there and never asks the gatekeeper at the moment of a grant. Because a refresh can drop the declaration, each call re-reads it too.

Blueprint ids are only stable for the bundled blueprints, whose `blueprint.json` fixes a `blueprintId` such as `format.document`. A blueprint a user creates from a workspace or imports gets a random id (for an import, `randomBlueprintId()` in blueprint-archive.ts), so a static declaration can only name bundled ones. The grant records the ids the admin was shown and the kernel accepts no others. A deployment that wants a blueprint of its own should have the admin pick it at grant time, which is one of the decisions below.

**The grant.** A new `grants` collection in the space's storage (`storage-schema/space-storage.ts`) holds one record per grant:

- `grantId`, from a counter that is never reused, like `nextRevocation`. A loopback minted for a deleted grant must never resolve to a later one.
- The account as the granting user's Durable Object knows it: the granting profile id, the `accountId` and the `vendorId`. Account ids come from the user's `nextAccountId` counter and are never reused either, so the pair stays bound to one account.
- `grantedBy`, the admin's profile snapshot, and `created`.
- The allowed `blueprintIds`, a snapshot of the account's display name and avatar for the members UI, and the counters behind the limits below.

**Making a grant.** `Space.grantAccount(accountId)` is admin-only and checked by `SpaceModel.requireAdmin` before anything else, as `SpaceDurableObject.setMemberRole` checks before it looks up a username. The space then asks the caller's own `UserDurableObject` to confirm the account. Since that object can only look up its own `connectedAccounts`, the account is the caller's by construction. It confirms the account exists, declares the capability, and that its vendor is not disabled (the same vendor check `UserDurableObject.getGatekeeperClassFor` makes). The space writes the grant, and the user's object hands the account its loopback through a new optional `GatekeeperUser.acceptSpaceGrant?(creator, { spaceKey, grantId })`. If the hand-off fails, the grant is deleted again. A matching `releaseSpaceGrant?(grantId)` tells the account when the grant ends, as `HookController.disable()` does. Both are best-effort courtesies: authority lives in the space.

## The loopback

A new `WorkerEntrypoint` beside `GatekeeperHookLoopback` in overseer.ts (or in spaces.ts), with props `{ spaceKey, grantId }`, minted from `ctx.exports` and exported from server.ts like the other loopbacks. The kernel sets the props, so the account cannot forge or widen them. Its type should come from the entrypoint class rather than the `as unknown as Fetcher<…>` cast that `OverseerClientInterface.enableHook` uses for the hook loopback.

Its one method takes a blueprint id, the resource URL to bind, a connector-chosen idempotency key (the source page's id) and the title, described below. Each call does the following:

1. The space re-resolves the grant: it still exists, `grantedBy` is still an admin, the blueprint is one the grant allows, and the grant's limits allow another workspace. A key the grant has already used returns the workspace made for it and creates nothing.
2. The granting user's Durable Object confirms that the account is still connected and still declares the capability. The account, vendor and resource checks of `getGatekeeperClassFor` apply again when the binding is created.
3. The kernel creates the workspace as that user, running the steps `AuthenticatedApiImpl.newGadgetFromBlueprint` runs today: `UserDurableObject.newGadget(id, title, spaceKey)`, the first open, `initializeFromBlueprint`, `newGatekeeper(accountId, resourceUrl)` and `gadget.bind`. Those steps live in a per-session RPC class today, so they would move into a kernel function that both call. A blueprint whose bindings cannot all be filled from the grant's one account is refused.
4. It returns the workspace id. It never returns an `Overseer`: the account gets no session in what it created.

This is the same two-sided check as `workspaceRoleInSpace`: the space vouches for the grant and the user's object vouches for the account, and neither trusts an earlier answer. It also mirrors `requireLiveHook`: the capability lives outside the kernel, possibly stored for good, so each call checks the record as it is now.

**The title is content.** A space shows every member each listed workspace's title (docs/spaces.md, "Known limitations"), and a slug is minted from the first title that is not a placeholder. A source page's title is read from the source, so it must not reach a listing without passing the restricted-data rule. The proposed refinement: the call carries the title as an `ObservationDescription`, with whatever `containsRestrictedData` or `ownerInvitesOnly` flags the gatekeeper would put on a read of it. The kernel creates the workspace under `DEFAULT_WORKSPACE_TITLE`, which mints no slug. It authorizes the observation on the new binding through `OverseerImpl.authorizeObservation`, the path every `ApprovalQueue` takes, and only then sets the title. The title update states the flags with it, so the workspace of a restricted source page is never listed under its title, and every other workspace gets its slug from its own title rather than from the blueprint's.

## How content gets into the workspace

This is the open question. Both options keep the account out of the workspace's sessions. They differ in which direction the source's content travels.

**(a) The gadget pulls.** The created workspace's gadget reads its source page through its binding. Every read is an ordinary observation, so the restricted-data rule, observer verification and per-viewer checks apply with no new channel. This is the author's lean.

- *Cost.* The blueprint's gadget does the fetching and caching. Reads reach the source when someone views the workspace or the gadget refreshes, so source load scales with views, and the source must be reachable at view time unless the gadget serves its cache.
- *Exposure.* None beyond the create capability. The account holds nothing that reaches into a created workspace.
- *Restricted data and observers.* A read the gatekeeper flags sets one of the workspace's one-way flags, which takes the workspace off the listing and ends its space roles and any publication. A member who opens the workspace is verified for their combined role by `ensureObserver`, against an account of their own on the source. So a member with no access to a source page cannot open its workspace, and a member with no account on the source cannot open any of them.
- *Updates.* Need nothing from the connector: the gadget reads afresh. Change notifications through the existing hooks would need a person to enable a hook in each workspace, which does not scale to a synced tree, so freshness here means reading on open.
- *A deleted source page.* The read fails and the gadget says so. The workspace stays until its owner deletes it.
- *Kernel.* Nothing beyond creation.

**(b) The connector pushes.** A hook-style write channel by which the connector delivers content into a created workspace.

- *Cost.* One source read per change rather than per view, and incremental updates come naturally, which suits a connector that already tracks sync state.
- *Exposure.* A standing write capability into every workspace the grant created, held outside the kernel and exercised with no viewer present. It must be revocable per workspace and per grant, and rate-limited separately from creation.
- *Restricted data and observers.* Safe only if every push is authorized as an observation on the workspace's binding, as a hook firing is (`startHook` returns an `ApprovalQueue` for exactly this). Any path that writes into gadget storage without passing that check would bypass the flags and the exclusion gate, so it must not exist. Verification at open is unchanged.
- *Updates.* A new push. *A deleted source page:* a tombstone push. Deleting the workspace would need a second capability.
- *Kernel.* Either auto-enable a hook at creation, which means the kernel enables on the strength of the grant what `enableHook` reserves today for a person with `build`, or add a push method that re-resolves the grant and the workspace, opens a gatekeeper session on the binding, authorizes the push and calls the gadget. Either way it is a second revalidated path into the Overseer, about 150 kernel lines more than (a).

**Recommendation.** (a). It adds no channel into a workspace, and it puts every byte from the source through the one check the restricted-data and observer rules already rest on. Its costs (source load per view, no push freshness) fall on the gadget and the source, not on the kernel's trust boundary. (b) can be added later as a second loopback method if read-on-open proves too stale.

## Revocation

- **Deleting the grant.** Any admin of the space deletes it (`Space.revokeAccountGrant(grantId)`). The next loopback call fails at step 1, and the account is told best-effort through `releaseSpaceGrant`.
- **The admin stops being an admin.** `SpaceModel.removeMember`, and `setMemberRole` lowering them from `admin`, delete their grants in the same write, as those methods revoke leases today. The per-call admin check stays as a second line.
- **The account disconnects.** `UserDurableObject.disconnectAccount` calls `revoke()` and deletes the record, so step 2 fails from then on. To also clear the grant from the members UI, the user's object would keep a presentation-only mirror of its accounts' grants (like its `spaces` mirror) and push the deletion best-effort. A lost push leaves only a dead entry.
- **A gatekeeper disabled by the deployment admin** is refused at creation by the `getGatekeeperClassFor` checks.
- **Workspaces already created stay.** They are the granting user's workspaces, listed under that user, with ordinary bindings. Nothing deletes them, for the reason a space admin cannot evict a workspace today: ownership, not the grant, decides a workspace's fate. Once the account is revoked their reads fail. Their owner can delete them, and the idempotency keys the grant kept list which ones they are until the grant is deleted.

## Limits

Each grant counts in the space, which serializes every call through one object:

- a number of creations per window (rate);
- a total number of workspaces per grant (count);
- a bound on the title, the key and the resource URL (size).

The blueprint bounds the rest. The kernel has no per-user workspace quota today, so the granting user's own quotas bound nothing here. The count matters most because `Space.listWorkspaces()` is not paginated: every synced workspace arrives in one answer to every member. Recommended: fixed kernel constants first, as the scheduler's limits are, with a count in the hundreds until the listing is paginated. A per-deployment setting in `AdminConfig` can come later.

## Space roles, publication and restricted data

- A created workspace is an ordinary listed workspace. Members hold their space role on it, and its owner may publish it or share it like any other.
- The account is not a member. It holds no role, cannot open or list the space, sets no slug, publishes nothing, and receives no lease or revocation.
- The existing fallback applies: if the granting user could not add to the space by the time the workspace registers, it lands in their personal space with `space.workspace.fallback` logged.
- A workspace whose title observation or first read carries a flag leaves the listing for good and gives no space role. It is visible only in its owner's own list, which is the rule doing its job: the connector should skip such source pages, or accept that they sync to the admin alone.
- The granting user's own list (`listGadgets()`) fills with every synced workspace. Hiding those from the home list would be presentation only.

## What the kernel adds

Rough sizes, excluding tests and UI:

- `workshop-shared`: the declaration, the loopback interface and the two optional account methods in gatekeeper.ts (~60 lines); `Space.listAccountGrants`, `grantAccount`, `revokeAccountGrant` and a grant info type in api.ts (~50).
- The `grants` collection and its counter (~30), and the grant rules in `SpaceModel` and the Durable Object shell (~120).
- In user.ts: confirming and handing over the grant, creation as the user, and the grant mirror (~80).
- The loopback entrypoint, the title observation step, and moving `newGadgetFromBlueprint`'s body into a shared kernel function (~120, much of it moved).

About 450 lines in all. Two PRs keep each reviewable: the grant (storage, API, members UI), then the loopback and creation.

## Out of scope

- The account updating, moving, retitling, publishing or deleting a workspace, or changing members or slugs.
- Granting someone else's account, or granting to a visitor.
- Any hierarchy among the created workspaces (spaces are flat).
- Converting the source's markup, which is the gatekeeper's and the blueprint's business.
- Personal spaces: their owner is their only admin and can create workspaces themselves, so grants are offered in team spaces only.

## Decisions for the owner

1. *Pull or push?* Pull (a). Add push only if read-on-open proves too stale.
2. *Does the declaration name blueprints, or does the admin pick at grant time?* The declaration names bundled blueprint ids, and the admin confirms them. Admin choice can extend this later.
3. *May the account choose the title freely?* No: it arrives as an observation, authorized before the workspace is listed under it.
4. *What happens to created workspaces when the grant ends?* They stay, owned by the granting user.
5. *Does losing admin delete the admin's grants?* Yes, in the same write as the role change.
6. *Should creation be idempotent per source key?* Yes, keyed per grant. Retries then never duplicate, and the grant knows what it created.
7. *Who sets the limits?* Fixed kernel constants, with the count kept in the hundreds until `listWorkspaces()` is paginated.
8. *Should one grant cover several spaces?* No: one grant, one space, so deleting it is a single unambiguous kill switch.
