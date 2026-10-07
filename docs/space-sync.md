# Space sync

A **space sync** brings a source that a connected account reaches, such as a tree of documents in another system, into a space (docs/spaces.md), one workspace per source item. A gatekeeper whose account declares the capability offers it; the user starts a sync, picking the space, a place in its tree and the source, and the account does the work. The kernel knows nothing about any source system: it owns the declaration it reads, the job record, and the capability it hands the account for the job. The kernel side is the "Space-sync jobs" part of `packages/workshop-backend/src/user.ts`, `SpaceDurableObject.checkPlacement` in `spaces.ts` and `SpaceSyncLoopback` in `space-sync-loopback.ts`; the contract is in `packages/workshop-shared/src/gatekeeper.ts` (`AccountDescription.providesSpaceSync`, `GatekeeperUser.startSpaceSync` and `cancelSpaceSync`, `SpaceSyncRequest`, `SpaceSyncProgress`, `SpaceSyncTarget`, `SPACE_SYNC_ERROR_CODES`) and `api.ts` (`AuthenticatedApi.startSpaceSync`, `listSpaceSyncJobs`, `cancelSpaceSync`, `SpaceSyncJobInfo`). Tests are in `packages/workshop-backend/__tests__/space-sync-jobs.test.ts`, and end to end, through a gatekeeper Worker, in `packages/integration-tests/__tests__/workshop-space-sync-jobs.test.ts`.

## Why it is shaped this way

- **Snapshots owned by the syncing user.** A synced workspace is one of the user's own workspaces, made from a bundled blueprint, not a gatekeeper observation read through on every view. It belongs to its space and is listed, addressed and opened like any other (docs/spaces.md). A later sync takes the source as it then is.
- **Always published.** Every workspace a sync creates is published to everyone signed in (docs/sharing.md, "Publishing to the deployment"), at the role the job records, which the kernel chooses (see "The job"); one placed under an unpublished entry is not visible until that entry is published (docs/spaces.md, "The cascade reaches access"). The dialog that starts a sync must say so before the user confirms.
- **Driven by the connector.** The account runs the job however it likes (a Cloudflare Workflow, say) and reports back. The kernel neither schedules nor retries the work.
- **The job record is the kernel's.** The record is kept in the syncing user's own Durable Object, beside their connected accounts, and is the only authority on what the account may still do for the job. The space, the place in its tree and the publication are in the record and never in what the account is told or may assert.
- **A job-scoped capability, no standing grant.** When the user starts a sync, the account is handed a loopback that acts for that one job and nothing else, checked against the record on every call. Nothing is granted to the account on a space, and nothing remains once the job ends.

## The declaration

An account offers space sync by setting `AccountDescription.providesSpaceSync: { blueprintId, importMethods }` in what its `describe()` returns:

- `blueprintId` -- the bundled blueprint each synced workspace is created from. Only a blueprint compiled into the Worker (`BUNDLED_BLUEPRINTS`, see docs/blueprints.md, "Output Formats and Bundled Blueprints") has an id a gatekeeper can name in advance, and the kernel refuses to start a sync with any other.
- `importMethods` -- the methods of that blueprint's gadget a sync may call to fill a synced workspace in; no other method of it is meant to be reachable through a sync.

An account that declares it implements the two optional `GatekeeperUser` methods, `startSpaceSync(request, target)` and `cancelSpaceSync(jobId)`. The kernel calls them only on an account whose description declares `providesSpaceSync`, as it calls `getSingletonGatekeeperClass` only on one that declares `singleton`. It reads the declaration from the description the user's Durable Object keeps on the account's `ConnectedAccountRecord`, and does not ask the account at the moment of a start.

## Starting a sync

`AuthenticatedApi.startSpaceSync(accountId, spaceKey, { resourceUrl, parentId? })` is answered by `UserDurableObject.startSpaceSync`, which refuses unless every one of these holds, checked in this order:

1. `spaceKey` is a well-formed key, personal or team (`checkSpaceKey`).
2. The caller has a connected account `accountId`, and its description declares `providesSpaceSync`.
3. The declared `blueprintId` is a bundled blueprint the deployment ships.
4. The space agrees to the placement (`SpaceDurableObject.checkPlacement(profileId, parentId)`, `SpaceModel.checkPlacement`): the caller may add workspaces to it -- the owner of a personal space, any member of a team space, the same rule (`canAddWorkspaces`) that governs adding any workspace to the space -- and, given a `parentId`, the space lists that entry. A caller who may not add to the space, and a key nobody has claimed, get the single refusal of `noSuchSpace()`, so a start does not tell whether a space exists. A failed call to the space refuses the start.
5. The resource passes the admin chokepoint: `UserDurableObject.getGatekeeperClassFor(accountId, resourceUrl)`, the single place where the gatekeepers and resources a deployment's admin has disabled are enforced. The account resolves the URL to one of its resources there, so a URL it does not support is refused too. The class it returns is discarded.
6. After those calls, with nothing awaited between this and recording the job: the account is still connected, and the caller has no running job into this space. A second running job of the same user into the same space is refused, so of two concurrent starts exactly one is recorded. Jobs into other spaces, and other users' jobs into this one, are not limited.

The job is then recorded as "running", with a random `jobId` and the `publication` the kernel chooses (see "The job"). The user's object mints the loopback, `ctx.exports.SpaceSyncLoopback({ props: { userId, accountId, jobId } })`, and calls `account.startSpaceSync({ jobId, resourceUrl }, loopback)`. The account should resolve once it has accepted the job and do the work in the background. If it throws, the job ends as "failed", with the thrown message cut to `MAX_SPACE_SYNC_MESSAGE_LENGTH` as its `error`, the failure is logged (`space.sync.start.failed`), and the account is then asked to stop the job, best effort as when cancelling, in case it kept the job before it threw. Either way the start returns the job as recorded.

`SpaceSyncRequest` carries only the job's id and the resource the user picked with the account's existing resource configurator. The space, the parent and the publication are the kernel's, kept in the job record.

## The job

`SpaceSyncJobInfo` is the record, in the user's `spaceSyncJobs` collection (`storage-schema/user-storage.ts`), keyed by `jobId`:

- `accountId` and `vendorId` -- the account running it; the vendor id is kept so the job still shows its source once the account is disconnected.
- `spaceKey` and `parentId` -- where its workspaces go: under that entry of the space's tree, or at its top when `parentId` is absent.
- `publication` -- the role every workspace it creates is published with: the default publication compiled into the bundled blueprint (`publication` in its `blueprint.json`), or `use` if it declares none. The account never asserts it.
- `status`, `progress`, `error`, `created` and `finished` -- its state, below.

**States.** A job is "running" from its start until it ends, once, in one of three states: "done" or "failed" when the account reports so (or "failed" when it threw at the start), or "cancelled" when the user cancels it or disconnects its account. Ending sets `finished`; only a running job changes. An ended job never runs again, which is what revokes the loopback.

**Progress.** `progress` is `{ done, total?, warnings }` as the account last reported it, `warnings` empty before the first report. A report replaces the previous one whole. Nothing is pushed to the browser: a client follows a job by polling `listSpaceSyncJobs`.

**Listing.** `AuthenticatedApi.listSpaceSyncJobs(spaceKey?)` is answered from the user's own Durable Object alone, newest first, filtered to one space when `spaceKey` is given. It lists only the caller's own jobs; another user's sync into the same space is not among them.

**Retention.** Every running job is kept, and of the jobs that have ended, the 20 most recently ended (`MAX_ENDED_SPACE_SYNC_JOBS`). Each time a job ends, the ended jobs that ended before those 20 are deleted; the job just ended is always kept.

**Cancelling.** `AuthenticatedApi.cancelSpaceSync(jobId)` throws for a job the caller has no record of and does nothing for one that has already ended. For a running job it first ends the job as "cancelled", so that from then on every call the account makes for it is refused, and only then asks the account, `account.cancelSpaceSync(jobId)`, to stop its work. That call may reach the account before its `startSpaceSync` for the job has returned. That call is best effort: a failure is logged (`space.sync.cancel.failed`) and not retried, and the job stays cancelled. Workspaces the sync has already created stay, as the user's own.

**Disconnecting.** `disconnectAccount(accountId)` cancels the account's running jobs the same way, ending each and then asking the account to stop, before it revokes the account and drops its record. A start that was already past its checks may record a job while the disconnect waits on the account, so the account's running jobs are ended once more in the same step that drops the record; the account is not asked to stop those, but their loopback is refused from then on. An account the admin settings provision for every user cannot be disconnected, so its jobs end only by cancelling, finishing or failing.

## The loopback

`SpaceSyncLoopback` (`space-sync-loopback.ts`, exported from `server.ts`) is a `WorkerEntrypoint` implementing `SpaceSyncTarget`, minted the way a hook's `GatekeeperHookLoopback` is. Its props, `{ userId, accountId, jobId }`, are set by the user's Durable Object when it mints the stub, so the account can neither forge nor widen them: `userId` is the id of that Durable Object, and the loopback reaches it through `idFromString`.

**Storable by design.** Unlike a hook's callback, the account may keep the stub for the job's lifetime and use it from anywhere, from a Workflow step for instance. That is safe because the loopback holds no authority of its own: every call goes to the user's Durable Object, which checks the props against the job record as it stands (`#runningSpaceSync`), so ending the job revokes every copy of the stub at once.

**Never renamed.** Accounts store stubs of the class, which name it, so `SpaceSyncLoopback` must keep its name and its export from `server.ts` once shipped.

**Checked on every call.** Each call is refused, with a code from `SPACE_SYNC_ERROR_CODES` (read with `getSpaceSyncErrorCode`), unless the job may still act:

| Code | When |
|---|---|
| `finished` (`SPACE_SYNC_FINISHED`) | The job has ended as "done" or "failed", or is no longer kept: since every running job is kept, a missing job has ended. |
| `notAllowed` (`SPACE_SYNC_NOT_ALLOWED`) | The job runs through another account than the one the loopback was minted for, or the report is malformed (see `reportProgress`). |
| `cancelled` (`SPACE_SYNC_CANCELLED`) | The user cancelled the job or disconnected its account. |
| `accountGone` (`SPACE_SYNC_ACCOUNT_GONE`) | The account is no longer connected: the user's object holds no record of it. |

Each of the four is final for the job: an account that reads one should end the job's work rather than retry. Any other failure, such as a Durable Object reset, may be transient.

**`reportProgress(progress)`** is its only method. It records `SpaceSyncProgress` on the job, bounded on arrival: the first `MAX_SPACE_SYNC_WARNINGS` (50) warnings are kept, each warning and the error are cut to `MAX_SPACE_SYNC_MESSAGE_LENGTH` (500 UTF-16 code units), and a report whose `done` or `total` is not a non-negative integer is refused as `notAllowed`. `state: "running"` updates the progress; "done" or "failed" also ends the job, with the error for "failed", after which the next call, a repeated final report included, is refused as `finished`. The text is the account's and is shown to the user as it stands, so it must hold no secrets. A report does not re-check the user's membership of the space.

## Trust boundary

- The account learns the job's id, the resource the user picked and nothing about the space, the place in its tree or the publication.
- `SpaceDurableObject.checkPlacement` takes the acting profile id as a plain parameter and is called only by that user's own `UserDurableObject`, which states its own profile, like the space's other methods (docs/spaces.md, "Trust boundary"). It is not on `Space`.
- The declaration is the account's, but it can only narrow: the blueprint must be one the deployment ships, the resource must pass the admin chokepoint, and the space must admit the user. The publication and the placement come from the kernel.
- The loopback is the only thing the account holds for the job, and it can do only what the job record still allows.

## Known limitations

- **No workspace is created yet.** The loopback has only `reportProgress`, so `parentId`, `publication`, `blueprintId` and `importMethods` are checked and recorded, but nothing in the contract acts on them yet: a job only reports progress and ends.
- **A job can run with nothing behind it.** A job stays "running" with no connector working on it if the user's object resets between recording the job and calling the account, or if the account accepts the job and never reports. It then blocks new syncs into its space until the user cancels it, which always works.
- **Expired credentials do not end a job.** `accountGone` means the account's record is gone. An account whose credentials have expired is still connected, and its loopback keeps working.
- **Progress is polled.** A client sees a report only when it next lists the jobs.
- **Ended jobs are forgotten.** Beyond the 20 most recently ended jobs, a job's record, its warnings and its error are dropped, and a stub of it is then refused as `finished`.
