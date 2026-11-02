# Space sync

A **space sync** brings a source that a connected account reaches, such as a tree of documents in another system, into a space (docs/spaces.md), one workspace per source item. A gatekeeper whose account declares the capability offers it; the user starts a sync, picking the space, a place in its tree and the source, and the account does the work. The kernel knows nothing about any source system: it owns the declaration it reads, the job record, the capability it hands the account for the job, and every write that capability makes. The kernel side is the "Space-sync jobs" part of `packages/workshop-backend/src/user.ts`, `SpaceDurableObject.placementFor` in `spaces.ts`, `OverseerDurableObject.writeForSpaceSync` in `overseer.ts` and `SpaceSyncLoopback` in `space-sync-loopback.ts`; the contract is in `packages/workshop-shared/src/gatekeeper.ts` (`AccountDescription.providesSpaceSync`, `GatekeeperUser.startSpaceSync` and `cancelSpaceSync`, `SpaceSyncRequest`, `SpaceSyncProgress`, `SpaceSyncTarget`, `SpaceSyncItem`, `SpaceSyncWrite`, `SPACE_SYNC_ERROR_CODES` and the `MAX_SPACE_SYNC_*` bounds) and `api.ts` (`AuthenticatedApi.startSpaceSync`, `listSpaceSyncJobs`, `cancelSpaceSync`, `resyncWorkspace`, `SpaceSyncJobInfo`, `GadgetMetadata.syncedFrom`), and a bundled blueprint's side of it is the `importMethods` key of its manifest (docs/blueprints.md). Tests are in `packages/workshop-backend/__tests__/space-sync-jobs.test.ts` (jobs) and `space-sync-writes.test.ts` (the writing methods and re-sync), and end to end, through a gatekeeper Worker, in `packages/integration-tests/__tests__/workshop-space-sync-jobs.test.ts` and `workshop-space-sync-writes.test.ts`.

## Why it is shaped this way

- **Snapshots owned by the syncing user.** A synced workspace is one of the user's own workspaces, made from a bundled blueprint, not a gatekeeper observation read through on every view. It belongs to its space and is listed, addressed and opened like any other (docs/spaces.md). A later sync takes the source as it then is, and discards whatever was written in the workspace since (see "Re-sync").
- **Always published.** Every workspace a sync creates is published to everyone signed in (docs/sharing.md, "Publishing to the deployment"), at the role the job records, which the kernel chooses (see "The job"); one placed under an unpublished entry is not visible until that entry is published (docs/spaces.md, "The cascade reaches access"). The dialog that starts a sync must say so before the user confirms.
- **Driven by the connector.** The account runs the job however it likes (a Cloudflare Workflow, say) and reports back. The kernel neither schedules nor retries the work.
- **The job record is the kernel's.** The record is kept in the syncing user's own Durable Object, beside their connected accounts, and is the only authority on what the account may still do for the job. The space, the place in its tree and the publication are in the record and never in what the account is told or may assert.
- **A job-scoped capability, no standing grant.** When the user starts a sync, the account is handed a loopback that acts for that one job and nothing else, checked against the record on every call. Nothing is granted to the account on a space, and nothing remains once the job ends.
- **Writes go in, nothing comes out.** No stub of a workspace, an Overseer or a gadget facet ever leaves the kernel. Such a stub would be storable, would outlive the job, and would let the account read what the space's members wrote in the workspace. The account names a method and its arguments, and the kernel makes the call and returns nothing of its result.

## The declaration

An account offers space sync by setting `AccountDescription.providesSpaceSync: { blueprintId, importMethods }` in what its `describe()` returns:

- `blueprintId` -- the bundled blueprint each synced workspace is created from. Only a blueprint compiled into the Worker (`BUNDLED_BLUEPRINTS`, see docs/blueprints.md, "Output Formats and Bundled Blueprints") has an id a gatekeeper can name in advance, and the kernel refuses to start a sync with any other.
- `importMethods` -- the methods of that blueprint's gadget a sync may call to fill a synced workspace in (`writeWorkspace`, below). The bundled blueprint must list a method too, under `importMethods` in its `blueprint.json`: only a method both lists name is reachable, so an account can narrow what its blueprint offers but never widen it, and a blueprint that lists none can be the target of a sync that creates workspaces but never writes them. The blueprint whose list is checked is the job's, fixed when the job starts and the one its workspaces are created from (see "The job"). An import method is expected to replace what it writes rather than add to it, since a write may be repeated (see "The loopback").

A synced workspace is created with no bindings (see "Known limitations"), so a blueprint whose gadget needs a binding to work is unusable for a sync.

An account that declares it implements the two optional `GatekeeperUser` methods, `startSpaceSync(request, target)` and `cancelSpaceSync(jobId)`. The kernel calls them only on an account whose description declares `providesSpaceSync`, as it calls `getSingletonGatekeeperClass` only on one that declares `singleton`. It reads the declaration from the description the user's Durable Object keeps on the account's `ConnectedAccountRecord`, and does not ask the account at the moment of a start.

## Starting a sync

`AuthenticatedApi.startSpaceSync(accountId, spaceKey, { resourceUrl, parentId? })` is answered by `UserDurableObject.startSpaceSync`, which refuses unless every one of these holds, checked in this order:

1. `spaceKey` is a well-formed key, personal or team (`checkSpaceKey`).
2. The caller has a connected account `accountId`, and its description declares `providesSpaceSync`.
3. The declared `blueprintId` is a bundled blueprint the deployment ships.
4. The space agrees to the placement (`SpaceDurableObject.placementFor(profileId, parentId)`, `SpaceModel.placementFor`): the caller may add workspaces to it -- the owner of a personal space, any member of a team space, the same rule (`canAddWorkspaces`) that governs adding any workspace to the space -- and, given a `parentId`, the space lists that entry; a start whose `parentId` it does not list is refused ("This space does not list that workspace."). A caller who may not add to the space, and a key nobody has claimed, get the single refusal of `noSuchSpace()`, so a start does not tell whether a space exists. A failed call to the space refuses the start.
5. The resource passes the admin chokepoint: `UserDurableObject.getGatekeeperClassFor(accountId, resourceUrl)`, the single place where the gatekeepers and resources a deployment's admin has disabled are enforced. The account resolves the URL to one of its resources there, so a URL it does not support is refused too. The class it returns is discarded.
6. After those calls, with nothing awaited between this and recording the job: the account is still connected, and the caller has no running job into this space. A second running job of the same user into the same space is refused, so of two concurrent starts exactly one is recorded. Jobs into other spaces, and other users' jobs into this one, are not limited.

The job is then recorded as "running", with a random `jobId` and the `publication` the kernel chooses (see "The job"). The user's object mints the loopback, `ctx.exports.SpaceSyncLoopback({ props: { userId, accountId, jobId } })`, and calls `account.startSpaceSync({ jobId, resourceUrl }, loopback)`. The account should resolve once it has accepted the job and do the work in the background. If it throws, the job ends as "failed", with the thrown message cut to `MAX_SPACE_SYNC_MESSAGE_LENGTH` as its `error`, the failure is logged (`space.sync.start.failed`), and the account is then asked to stop the job, best effort as when cancelling, in case it kept the job before it threw. Either way the start returns the job as recorded.

`SpaceSyncRequest` carries only the job's id, the resource the user picked with the account's existing resource configurator, and, for a re-sync, `scope: "item"` (see "Re-sync"); a start leaves `scope` out, which means `"tree"`: the item the resource names and the items beneath it, one workspace each. The space, the parent and the publication are the kernel's, kept in the job record.

## The job

`SpaceSyncJobInfo` is the record, in the user's `spaceSyncJobs` collection (`storage-schema/user-storage.ts`), keyed by `jobId`:

- `accountId` and `vendorId` -- the account running it; the vendor id is kept so the job still shows its source once the account is disconnected.
- `spaceKey` and `parentId` -- where its workspaces go: under that entry of the space's tree, or at its top when `parentId` is absent.
- `blueprintId` -- the bundled blueprint its workspaces are created from and written through: the one the account declared when the job started. Should the account declare another later, or none, the job's calls are refused (see "The loopback").
- `publication` -- the role every workspace it creates is published with: the default publication compiled into the bundled blueprint (`publication` in its `blueprint.json`), or `use` if it declares none. The account never asserts it.
- `status`, `progress`, `error`, `created` and `finished` -- its state, below.

**States.** A job is "running" from its start until it ends, once, in one of three states: "done" or "failed" when the account reports so (or "failed" when it threw at the start), or "cancelled" when the user cancels it or disconnects its account. Ending sets `finished`; only a running job changes. An ended job never runs again, which is what revokes the loopback.

**Progress.** `progress` is `{ done, total?, warnings }` as the account last reported it, `warnings` empty before the first report. A report replaces the previous one whole. Nothing is pushed to the browser: a client follows a job by polling `listSpaceSyncJobs`.

**Listing.** `AuthenticatedApi.listSpaceSyncJobs(spaceKey?)` is answered from the user's own Durable Object alone, newest first, filtered to one space when `spaceKey` is given. It lists only the caller's own jobs; another user's sync into the same space is not among them.

**Retention.** Every running job is kept, and of the jobs that have ended, the 20 most recently ended (`MAX_ENDED_SPACE_SYNC_JOBS`). Each time a job ends, the ended jobs that ended before those 20 are deleted; the job just ended is always kept.

**Cancelling.** `AuthenticatedApi.cancelSpaceSync(jobId)` throws for a job the caller has no record of and does nothing for one that has already ended. For a running job it first ends the job as "cancelled", so that from then on every call the account makes for it is refused (a write already past its checks still completes), and only then asks the account, `account.cancelSpaceSync(jobId)`, to stop its work. That call may reach the account before its `startSpaceSync` for the job has returned. That call is best effort: a failure is logged (`space.sync.cancel.failed`) and not retried, and the job stays cancelled. Workspaces the sync has already created stay, as the user's own.

**Disconnecting.** `disconnectAccount(accountId)` cancels the account's running jobs the same way, ending each and then asking the account to stop, before it revokes the account and drops its record. A start that was already past its checks may record a job while the disconnect waits on the account, so the account's running jobs are ended once more in the same step that drops the record; the account is not asked to stop those, but their loopback is refused from then on. An account the admin settings provision for every user cannot be disconnected, so its jobs end only by cancelling, finishing or failing.

## The loopback

`SpaceSyncLoopback` (`space-sync-loopback.ts`, exported from `server.ts`) is a `WorkerEntrypoint` implementing `SpaceSyncTarget`, minted the way a hook's `GatekeeperHookLoopback` is. Its props, `{ userId, accountId, jobId }`, are set by the user's Durable Object when it mints the stub, so the account can neither forge nor widen them: `userId` is the id of that Durable Object, and the loopback reaches it through `idFromString`.

**Storable by design.** Unlike a hook's callback, the account may keep the stub for the job's lifetime and use it from anywhere, from a Workflow step for instance. That is safe because the loopback holds no authority of its own: every call goes to the user's Durable Object, which checks the props against the job record as it stands (`#runningSpaceSync`), so ending the job revokes every copy of the stub at once.

**Never renamed.** Accounts store stubs of the class, which name it, so `SpaceSyncLoopback` must keep its name and its export from `server.ts` once shipped.

**Checked on every call.** Each call is refused, with a code from `SPACE_SYNC_ERROR_CODES` (read with `getSpaceSyncErrorCode`), unless the job may still act:

| Code | When |
|---|---|
| `finished` (`SPACE_SYNC_FINISHED`) | The job has ended as "done" or "failed", or is no longer kept: since every running job is kept, a missing job has ended. |
| `notAllowed` (`SPACE_SYNC_NOT_ALLOWED`) | The job runs through another account than the one the loopback was minted for; the call is malformed (see each method); the user may no longer add workspaces to the job's space, or the account no longer declares `providesSpaceSync` naming the job's `blueprintId`, or the deployment no longer ships that blueprint (every method but `reportProgress`); or the call names a method the job may not call, or arguments it may not pass (see "Writing a workspace"). |
| `cancelled` (`SPACE_SYNC_CANCELLED`) | The user cancelled the job or disconnected its account. |
| `accountGone` (`SPACE_SYNC_ACCOUNT_GONE`) | The account is no longer connected: the user's object holds no record of it. |
| `workspaceGone` (`SPACE_SYNC_WORKSPACE_GONE`) | The call names a workspace the job may not touch (see "Writing a workspace"), or the space refused a workspace `ensureWorkspace` made (see "Creating a workspace"). |

Each of the first four is final for the job in the contract: an account that reads one should end the job's work rather than retry. `workspaceGone` is not: a workspace leaves the job's space through ordinary actions while the job runs, its owner deleting or moving it or a space admin evicting it, and only the call that names it is refused. The account may go on with its other items, and may ask `ensureWorkspace` for that item's workspace again, which then creates another. Any other failure, such as a Durable Object reset, may be transient.

The kernel itself ends a job on no refusal: a job ends only when the account reports it ended, the user cancels it or disconnects its account (see "The job"). So `finished`, `cancelled` and `accountGone` are final because the job record says so, and every later call is refused the same way, while `notAllowed` is final because the account is told to treat it so. Some of what it refuses holds for the rest of the job (the user has left the space, the declaration has changed), and some only for the call (a malformed source URL, a method the lists do not name, arguments too large), after which a well-formed call would still be answered; an account that keeps going after one is in breach of the contract, not stopped by the kernel.

The job checks come first, from the user's object alone. Every method but `reportProgress` then asks the job's space whether the user may still add workspaces to it (`placementFor`, the rule a start checks), refusing as `notAllowed` once they may not, checks the job again after that call, since it may have ended meanwhile, and checks the account's declaration against the job's `blueprintId` (`#syncDeclaration`).

**`reportProgress(progress)`** records `SpaceSyncProgress` on the job, bounded on arrival: the first `MAX_SPACE_SYNC_WARNINGS` (50) warnings are kept, each warning and the error are cut to `MAX_SPACE_SYNC_MESSAGE_LENGTH` (500 UTF-16 code units), and a report whose `done` or `total` is not a non-negative integer is refused as `notAllowed`. `state: "running"` updates the progress; "done" or "failed" also ends the job, with the error for "failed", after which the next call, a repeated final report included, is refused as `finished`. The text is the account's and is shown to the user as it stands, so it must hold no secrets. A report does not re-check the user's membership of the space.

**`ensureWorkspace`**, **`writeWorkspace`** and **`setWorkspaceTitle`** create and fill in the job's workspaces, below. Each is answered by the user's object (`ensureSyncedWorkspace`, `writeSyncedWorkspace`, `setSyncedWorkspaceTitle`), which does the work itself, as the workspaces' owner. Every one is safe to call again after a failure that carries no code: `ensureWorkspace` and `setWorkspaceTitle` by what they do, and `writeWorkspace` because the contract assumes that import methods replace what they write rather than append to it, so that a write repeated after a lost reply leaves what one would.

## Creating a workspace

**`ensureWorkspace({ sourceUrl, title, parentId? })`** returns `{ workspaceId }`, the user's workspace for one source item in the job's space, creating it if there is none. `sourceUrl` identifies the item: it must be non-empty and at most `MAX_SPACE_SYNC_SOURCE_URL_LENGTH` (2000) UTF-16 code units, or the call is refused as `notAllowed`. It should be a resource URL the account's resource configurator could have produced, since a re-sync passes it through the admin chokepoint and back to the account (see "Re-sync").

**One workspace per item.** An item's identity is `{ space, account, blueprint, source URL }`. The user's `syncedWorkspaces` collection (`storage-schema/user-storage.ts`) maps each to the workspace kept for it, keyed by a SHA-256 digest of the four, since a URL may be longer than a storage key. With the blueprint in the key, a job whose blueprint differs from an earlier one's never finds that job's workspaces, so it never writes through one blueprint's import methods into a workspace made from another. A mapping counts only while the user's record of its workspace exists, is of their own workspace, and points at the job's space. So once the user has deleted the workspace or moved it to another space, the next call creates another and replaces the mapping, and the one moved away stays where it now is.

**A new workspace** goes through `newWorkspaceFromBlueprint` (`blueprint-instantiation.ts`), the path `AuthenticatedApi.newGadgetFromBlueprint` takes, with:

- the job's `blueprintId`, and no bindings;
- `title`, cut to `MAX_SPACE_SYNC_TITLE_LENGTH` (200);
- the job's space: its team key, or none for the user's own personal space;
- the place in the tree: under `parentId` if the job's space lists that entry when the call is made, otherwise under the job's `parentId`, otherwise at the top. The space applies it when it first lists the workspace, and puts the workspace at the top if by then it no longer lists that entry (docs/spaces.md, "Placement at creation");
- the job's `publication` as the workspace's publication, from its creation. It is the kernel's choice (see "The job"), never the account's. A workspace placed under an unpublished entry is not visible until that entry is published.

The new Overseer is opened as its owner by the user's object itself (`#openOwnWorkspace`, `OverseerDurableObject.openAsOwner` with the user's own ids), since no client session is behind the call. That is `open()` without counting an open (`gadget_opened`, the `workspace.opened` activity metric), since nobody opened the workspace; its creation is counted as any creation from a blueprint is. The record is then marked `syncedFrom: { accountId, blueprintId, sourceUrl }`, and the call waits for the workspace's registration with its space (`#syncSpace`), so that when it returns the workspace is listed, titled and published, and has a slug unless its title is a placeholder (docs/spaces.md, "Addresses"). If the space refuses it after all, the workspace falls back as any refused one does (docs/spaces.md, "A refused registration, a refused move"), keeping its publication, and the call is refused as `workspaceGone`.

**An existing workspace** is returned as it is: its title, place and publication are not changed (`setWorkspaceTitle` changes the title). The call marks it `syncedFrom` again and waits for its registration, so a call that finds a workspace an earlier call made but did not finish completes it. A workspace that has come to hold restricted data or is owner-invites-only is one no space lists (docs/spaces.md, "Workspaces a space never lists"); it still belongs to the job's space, so the call returns it, unlisted.

**Retries and concurrency.** Repeating a call, after a lost reply say, returns the same workspace. Concurrent calls for the same item share one creation: the user's object keeps the creations under way by key, and a second call awaits the first one's. A creation allocates the new workspace's Overseer id and writes the mapping to it before anything else, so a creation cut short by a crash or reset always leaves a mapping that leads to it, and the next call for the item finds one of three things:

- no record of that id: nothing was made, and a workspace is created;
- a record of a workspace that has not finished initializing from the blueprint (it has never reported activity, so no space has been asked to list it): it is deleted, as its owner deletes a workspace, and another is created;
- a record of a workspace that has: it is completed as above.

So one source never has two listed workspaces in one space through a retry; at worst a half-made one waits until the next call for its item completes or replaces it.

## Writing a workspace

**`writeWorkspace(workspaceId, { method, args })`** calls `method(args)` on the workspace's default gadget, as it runs on main, typically to replace its content with the source item's. It is refused as `workspaceGone` unless the first check holds, and as `notAllowed` unless the others do:

1. the user's record of `workspaceId` is of their own workspace, which has finished initializing, which this account synced (`syncedFrom.accountId`, by this job or an earlier one) from the job's blueprint (`syncedFrom.blueprintId`), and which belongs to the job's space;
2. `method` is listed both in the account's `providesSpaceSync.importMethods`, which must be an array, and in the `importMethods` of the job's bundled blueprint, as compiled into the Worker, which is the blueprint the workspace was created from; and it is neither `then` nor a name `Object.prototype` has (`constructor`, `toString`, `__proto__`, ...), which name no method of the gadget's own whatever the lists say;
3. `JSON.stringify(args)` neither throws (a BigInt, a cycle) nor returns `undefined` (for `undefined`, a function or a symbol), and what it returns is at most `MAX_SPACE_SYNC_WRITE_BYTES` (8 MiB) of UTF-8.

The gadget receives `JSON.parse` of that, so the arguments travel JSON round-tripped and a value JSON does not carry does not arrive as sent. The call reaches the workspace through `OverseerDurableObject.writeForSpaceSync(ownerId, method, argsJson)`, a method of the Durable Object only, on no client capability, which refuses anyone but the workspace's owner's object. Its result is disposed and nothing of it is returned. A throw from the gadget is logged (`space.sync.write.failed`, naming the method) and replaced by an error that carries no code and does not quote it, since what a gadget throws could disclose the workspace's content to the account.

## Retitling a workspace

**`setWorkspaceTitle(workspaceId, title)`** is refused as `workspaceGone` as `writeWorkspace`'s first check refuses. Otherwise it sets the title, cut to `MAX_SPACE_SYNC_TITLE_LENGTH`, through `Overseer.setTitle` on the workspace opened as its owner (`openAsOwner`, so not counted as an open), the path the owner's own rename takes, and waits for the workspace's space to follow, so its entry is retitled and, if it had no slug and the new title is not a placeholder, given one.

## Re-sync

`AuthenticatedApi.resyncWorkspace(workspaceId)` (`UserDurableObject.resyncWorkspace`) takes one synced workspace back to its source. It starts a job through the account that synced it, refused unless the caller owns the workspace, its record has `syncedFrom`, and everything a start requires holds (see "Starting a sync") for the account, the record's `sourceUrl` as the resource, and the space the workspace belongs to now, with no `parentId`: the account is still connected and declares `providesSpaceSync` with a blueprint the deployment ships, the caller may add workspaces to the space, the source passes the admin chokepoint, and no job of the caller's runs into that space. In the step that records the job, the workspace must still belong to that space, the blueprint the account declares must be the one it was created from (`syncedFrom.blueprintId`; a workspace made from another blueprint cannot be re-synced through this one's import methods), and no creation of a workspace for the same source in that space may still be under way: a job that has ended may have left one running, and the re-sync's `ensureWorkspace` would share it and be handed the workspace it creates. Then the `syncedWorkspaces` mapping of the source in that space is pointed at the workspace, so that a workspace moved since its sync is the one the job fills in. The job is recorded and handed to the account as any other, with `SpaceSyncRequest.scope: "item"` and the source URL as its `resourceUrl`, and the user follows and cancels it as any other.

A job of the scope `"item"` syncs only that one item into its existing workspace: `ensureWorkspace` with the source URL returns the workspace while it still counts as the item's (see "One workspace per item"; once its owner deletes or moves it while the job runs, a call naming it is refused as `workspaceGone` and `ensureWorkspace` creates a new one, as for any item), and the account replaces its content and its comments through the blueprint's import methods. The kernel clears nothing itself; what is discarded is what those methods replace, which for a re-sync is meant to be everything, so whatever anyone wrote in the workspace since is lost. The workspace keeps its place in the tree and its publication. A client must say so, and have the user confirm, before it calls `resyncWorkspace`.

**`GadgetMetadata.syncedFrom`** is `{ accountId }` on the owner's own record of a workspace a sync created, as `listGadgets` and `getGadget` return it, so a client can offer the re-sync while that account is connected. The blueprint and the source URL stay in the user's object. It is kept after the account is disconnected, and never set on a record of a workspace shared with the user or on the metadata an `Overseer` reports.

## Trust boundary

- The account learns the job's id, the resource the user picked, the ids of the workspaces it created and nothing about the space, the place in its tree or the publication. The `parentId` it may pass is honoured only as an entry the job's space lists.
- `SpaceDurableObject.placementFor` takes the acting profile id as a plain parameter and is called only by that user's own `UserDurableObject`, which states its own profile, like the space's other methods (docs/spaces.md, "Trust boundary"). It is not on `Space`. Likewise `OverseerDurableObject.writeForSpaceSync` and `openAsOwner` are called only by the owner's User DO and are on no client capability.
- The declaration is the account's, but it can only narrow: the blueprint must be one the deployment ships, the methods it calls must be ones that blueprint lists, the resource must pass the admin chokepoint, and the space must admit the user. The blueprint is fixed for a job when it starts and recorded on each workspace it creates, so changing the declaration later neither moves a running job onto another blueprint nor opens a workspace to another blueprint's import methods. The publication and the placement come from the kernel.
- The loopback is the only thing the account holds for the job, and it can do only what the job record still allows, only to workspaces this account synced into the job's space. Nothing it calls returns content or a capability: `ensureWorkspace` returns an id, and the others nothing.

## Known limitations

- **No bindings.** A synced workspace is created with no bindings, so its gadget can reach no gatekeeper; a blueprint that needs one is unusable for a sync.
- **A re-sync discards local edits.** The user and the space's members may edit a synced workspace like any other, and a re-sync replaces that work with the source as it then is.
- **Writes are not rate-limited.** Beyond the payload cap and the per-call checks, nothing bounds how often a job writes, and synced workspaces count against no special quota.
- **A call in flight outlives a cancel.** `ensureWorkspace`, `writeWorkspace` and `setWorkspaceTitle` check the job before they act, so one past its checks when the job ends still completes: a workspace is still created, written or retitled.
- **A change of blueprint duplicates the workspaces.** An item is identified by its space, account, blueprint and source URL, so once an account comes to declare another blueprint, its next tree sync finds none of the workspaces made from the old one and creates a second listed workspace per item beside each. That keeps one blueprint's import methods out of another's workspaces, and blueprint changes are rare; the old workspaces stay the user's, and cannot be re-synced while the account declares the new one.
- **A refused first registration leaves a published workspace in the personal space.** A new workspace is published from its creation. If the user is removed from the team space between `ensureWorkspace`'s check and the space's first listing of the workspace, the space refuses it, it falls back to the user's personal space and stays published there, and the call is refused as `workspaceGone`.
- **A job can run with nothing behind it.** A job stays "running" with no connector working on it if the user's object resets between recording the job and calling the account, or if the account accepts the job and never reports. It then blocks new syncs into its space until the user cancels it, which always works.
- **Expired credentials do not end a job.** `accountGone` means the account's record is gone. An account whose credentials have expired is still connected, and its loopback keeps working.
- **Progress is polled.** A client sees a report only when it next lists the jobs.
- **Ended jobs are forgotten.** Beyond the 20 most recently ended jobs, a job's record, its warnings and its error are dropped, and a stub of it is then refused as `finished`.
