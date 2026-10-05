# Git-Based Blueprints and Blueprint Updates

## Goals

1. **Replace the Yjs blueprint format with git.** A blueprint version becomes a git commit, shipped as a packfile. Yjs survives only as a reader for content already stored.
2. **Let a gadget take updates from a blueprint.** Applying an update is a three-way merge delivered into a new chat, where the user previews it and the agent resolves conflicts.
3. **Let a gadget switch blueprints.** Alice publishes a blueprint; Bob builds on it and publishes his own; Carol, who started from Alice's, can move to Bob's. The same mechanism upgrades gadgets that predate this plan and gadgets whose blueprint was re-uploaded under a new id.

Out of scope: forking a gadget's database for a chat with pending changes (a separate workstream, which is what makes a previewed data migration reversible), automatic updates, any change to what a blueprint's bindings metadata contains, and clean merges for the bundled formats while they ship build output (see Risks).

## Current state

Line numbers are as of `e6ad8c24`.

- **Blueprint content is a gzip-compressed Yjs V2 snapshot** of the final file map, built from a commit at publish (`snapshotCode`, overseer.ts:7184) and stored in R2 at `<blueprintId>/<version>`. Metadata is a `BlueprintKvRecord` in KV. A `.gadget` download is a 24-byte header, the metadata JSON, and those same bytes (blueprint-archive.ts).
- **Instantiation discards everything but the files.** The UI path (`initializeFromBlueprint`, overseer.ts:9100) writes a fresh parentless commit authored by the new owner. The agent path (`createGadget({blueprintId})`, agent.ts:3237) copies the files into the chat as `set` changes, so the first commit is whatever the user later accepts.
- **A gadget does not record where it came from.** `GadgetRecord` carries only the blueprint's `output` format.
- **Gadget code is real git, with no refs.** Loose objects live in the workspace's Overseer; record fields act as refs (git-store.ts header).
- **History is linear.** Every writer passes zero or one parent; accept hardcodes `parents: [baseHead]` (overseer.ts:3393).
- **A pack codec exists** (`buildPackBytes`, `decodePackBytes` in git-codec.ts), but its only entry points are gatekeeper-scoped: `consumePackFromGatekeeper` attributes every object to a remote, and `buildPackForAction` packs one queued push.
- **A three-way merge exists** (`threeWayMerge`, git-store.ts:551): file maps in, diff3 markers out, base supplied by the caller. Its one caller is `updateChatFromMainline`. There is no merge-base computation.
- **Nothing treats conflict markers specially.** The agent sees a mainline merge as a user-authored diff, and accept does not look for leftover markers.
- **Bundled blueprints build Yjs archives at build time** (`packages/bundled-blueprints/src/files.ts`) and install them to `<blueprintId>/<version>`, overwriting that object in place when the files change without a version bump.

## The model in one picture

Two rules shape every commit this plan writes:

- **First parent means "my own previous state". Every other parent means "merged from elsewhere".** A gadget's own history is its first-parent chain, and so is a blueprint's sequence of releases. This plan calls such a chain a *lineage*.
- **A commit with merged-in parents always has an own-lineage first parent.** Where none exists yet (a gadget being instantiated, the first release of a derived blueprint), an empty-tree root commit is minted to be it.

Each row below is one lineage, oldest commit first. Brackets list a merge commit's parents.

```
Alice's blueprint    A1 ── A2 ── A3
Bob's gadget         e ── i ── b1 ── b2          i  = [e, A2]
Bob's blueprint      B0 ── B1                    B1 = [B0, A2], with b2's tree
Carol's gadget       e' ── i' ── c1 ── m         i' = [e', A3],  m = [c1, B1]
```

Bob instantiated Alice's A2, made changes, and published B1. Carol instantiated Alice's A3, made a change (c1), then switched to Bob's blueprint. The merge base of c1 and B1 is A2, found by walking commit objects. `m` records the merge, so her next update from Bob computes its base the same way.

## Core decisions

**1. A blueprint version is a synthetic release commit.** Publishing mints a commit whose tree is the source gadget's tree at that moment. The gadget's real history is not shipped: its commit messages contain chat titles and its authors include collaborators. The release's author is the workspace owner (the same identity `BlueprintMetadata.author` already publishes), and its message is `Release <version>: <title>`.

**2. Releases form a public graph that mirrors what was merged.** A release's parents are:

- first, the blueprint's previous release, or a new empty-tree root if this is the first release and it has upstream parents (B0 above); and
- then each upstream release merged into the source gadget since, found structurally as the non-first parents along the gadget's first-parent chain, dropping any that is an ancestor of the previous release or of another one kept. They are listed in the order the gadget merged them, oldest first.

The empty root is itself written as a release commit: version 0, of the empty tree, with no parents, so its message is `Release 0: <title>`.

An original blueprint's first release is simply parentless. If the tree and parents match the previous release, nothing is minted and the version does not change. A release that merged something new is minted even if its tree is unchanged.

**3. The origin workspace records how releases map to its own commits.** `BlueprintGadgetRecord` gains `releases: {version, releaseCommit, sourceCommit}[]`, appended on each publish. It gives retry something exact to re-send, tells the UI whether the gadget has unpublished changes, and names the next release's first parent. The release commits and their trees live in the workspace's object store like any other objects.

**4. Blueprint content is a packfile carrying three things.**

- **The release's full tree.**
- **Every ancestor commit object, with no trees.** These are a few hundred bytes each and make the release graph walkable by whoever holds the pack.
- **Fork-point trees.** For each *other* lineage in the release's ancestry, the full tree of that lineage's newest release there (A2 in B1's pack). The publisher holds each one: it merged that release itself, or a pack it merged carried the tree.

The third item is the non-obvious one. Commit-only history is enough to *find* a common ancestor but not to merge against it, because the merge needs the ancestor's files. In the picture, Carol holds A3's tree but only A2's commit, so without A2's tree in Bob's pack the switch could not proceed.

One tree per foreign lineage is sufficient because a lineage is a linear chain: the merge base is the older of the two sides' newest releases in its lineage, and each side holds its own. Two caveats. A lineage can fork if two blueprints share a legacy root (decision 13 derives it from content alone), in which case each newest release is carried. And a pack that omits these trees, whether hand-made or published before this rule shipped, leads to the "refuse" row of decision 8.

Fetching the fork point on demand instead was considered and set aside:

- **A commit id does not locate content.** R2 is keyed `<blueprintId>/<commitId>`, and a release commit deliberately does not name its blueprint (decision 7). Fetching by commit alone needs a second, commit-keyed index or store.
- **A commit-keyed store complicates deletion.** Either deleting Alice's blueprint breaks switches to Bob's, or her content outlives her delete, or objects are reference-counted.
- **It does not survive export.** A `.gadget` of Bob's blueprint uploaded to another deployment would arrive without its fork point.
- **Carrying the tree is cheap.** Objects are content-addressed, so the fork-point tree adds only the blobs Bob changed, in their original form, plus a few tree objects.

No consent from the upstream author is needed to carry it: the derived tree already contains most of that content. A rights system for derivative blueprints, if one comes, would govern creating a derived blueprint at all.

Which trees a pack carries is a transport detail that can change later, so this is not a one-way door. The commit shapes in decisions 1, 2 and 6 are, since commit ids are permanent.

**5. Storage and metadata.**

- `BlueprintMetadata` gains `commitId`, the release commit. Its absence marks legacy content.
- New content is stored in R2 at `<blueprintId>/<commitId>`, which makes each object immutable and removes the overwrite-in-place hazard. Deletion lists the `<blueprintId>/` prefix instead of counting versions.
- `metadata.version` stays as the display counter.
- The `.gadget` container moves to format version 2: same header, content is the raw pack (already zlib-compressed per object, so no gzip wrapper). Downloads serve whatever is stored, so a legacy blueprint keeps downloading as version 1 until it is republished.

**6. A gadget's history records what it merged.** Instantiating from release R writes an empty root `e` and a commit `i = [e, R]` with R's tree; the gadget's head is `i`. Their messages are `Create gadget: <title>` and `Instantiate blueprint: <title>`. Accepting a blueprint update writes `[head, R]`. Consequences:

- Every commit on a gadget's first-parent chain was written locally and has its tree. Release ancestors, most of which arrive without trees, are only ever reached through other parents.
- The merge base for any future update is derivable from the graph, including after switching blueprints.
- The alternative of pointing the head at R itself was rejected: the first-parent chain would then run into the release history, where trees are missing.

**7. A gadget also names the blueprint it follows.** `GadgetRecord.upstream = {blueprintId, commitId}` is the blueprint to check for updates and the release of it most recently merged. It is needed because release commits deliberately do not name their blueprint: a blueprint id is a bearer share link, and commits propagate into derived blueprints' packs. It is not normally the merge base: the graph supplies that, and decision 8 falls back on `upstream` only where the graph has nothing to offer. Accepting a blueprint proposal always retargets `upstream` to the blueprint applied; there is no one-off merge that leaves the followed blueprint unchanged.

`upstream` is delivered only to subscribers with the "build" role. The blueprint id is a share link to the blueprint's code, which a "use" collaborator cannot otherwise read.

**8. The merge base comes from the commit graph, with fallbacks.**

| Situation | Behaviour |
|---|---|
| Target is already an ancestor of the head | No merge. If `upstream` already names this blueprint at this release, the gadget is up to date. Otherwise the result is a follow proposal (decision 9). |
| One best common ancestor, tree held | Use it. |
| Several best common ancestors | Prefer one on the target's own lineage, else the one with the latest commit date; record which. A recursive merge is future work. |
| A common ancestor exists but no candidate's tree is held | Refuse, explaining that the shared version's files are unavailable. |
| No common ancestor, and the target is the blueprint the gadget follows | Use `upstream.commitId`, the release the gadget last took from it. No warning. |
| No common ancestor otherwise | Assume a base and warn the user: `upstream.commitId` if the gadget has an upstream, else its **first non-empty commit** on its first-parent chain. |

The fifth row serves blueprints whose releases are not chained, which today means the bundled ones (decision 14). It needs no warning because only a blueprint's own publisher can put a release under its id, so the release the gadget last took from that id is the right base. That release's tree is always held: it was the head of a pack the gadget imported.

The last row has two cases. A gadget with an upstream is switching to a blueprint that shares no history with it; the release it last took is the best available guess at what its local changes are relative to. A gadget with no upstream predates this plan, and gets the first-non-empty-commit rule. "First non-empty" rather than "root" because migrated gadgets and gadgets created empty are rooted at an empty-tree commit (overseer-git-migration.ts:311, overseer.ts:9845). The warning is suppressed when the assumed base's tree id equals the tree of the target or of one of its ancestors, which the commit objects reveal for free. It is also suppressed when the assumed base has no files. That happens only for a gadget with no upstream and no commit that has any files, whose base is then its root: it has nothing a wrong guess could undo.

For a gadget with no upstream, the assumed base is exact only if it was instantiated through the UI after the git migration, so that its root commit is the blueprint's tree unchanged. An agent-created gadget's first commit already includes the agent's edits, and a pre-git gadget's may include the user's. Edits that are inside the assumed base look, to a three-way merge, like something the blueprint removed, so they can be reverted with no conflict reported. That is why the warning says so, why the update lands in a chat for review, and why the merge is recorded as having an unverified base, which both the chat's notice and the agent's view of the merge repeat.

Once such an update is accepted, the gadget has an upstream and, for a chained blueprint, real lineage. Later updates from the same blueprint need no warning.

**9. Applying a blueprint always produces a proposal in a new chat.** `GadgetClient.applyBlueprint(blueprintId, {modelId, allowUnrelated?})`:

1. Reads the blueprint and imports its pack into the workspace store.
2. Classifies the situation per decision 8. An up-to-date gadget returns `{outcome: "upToDate"}`. An assumed base, without `allowUnrelated`, returns `{outcome: "unrelated"}` so the UI can warn and re-call. A base whose files are not held returns `{outcome: "baseUnavailable"}`.
3. Creates a chat, titled `Update from blueprint: <title>`, and records a `changes` message carrying `blueprintMerges`. Unless the target is already in the gadget's history, it first pins the gadget at its head, runs `threeWayMerge(base, head, target)`, and records the result as a change row. The pin is declared even when the merge changes no file.
4. Starts an agent turn if the proposal is a merge that changes a file (decision 11).
5. Returns the chat id.

The user previews the result like any other proposed change, and accepts or discards it. Nothing about the gadget changes until accept, including which blueprint it follows. A gadget still pending in a chat has no head to merge into and is refused, as `createBlueprint` refuses it. If the gadget's head moves while the proposal is being computed, the call throws an error asking for a retry rather than record a merge into a head the gadget no longer has.

Every proposal is one of three kinds, recorded on it:

| Kind | When | Files | Agent |
|---|---|---|---|
| `follow` | The target is already in the gadget's history, or its files equal the base's. | Unchanged. | No |
| `fastForward` | The gadget's files equal the base's: it has no changes of its own since the release it last took. | Become the target's exactly. | No |
| `merge` | The gadget and the blueprint have both changed files since the base. | Three-way merged. | Yes, if any file changes |

The kind is decided by comparing each side's files with the base's, as the table says, not by what the merge produced. So a gadget and a blueprint that made the same changes yield a `merge` whose change is empty. That one starts no agent turn (decision 11).

**A `follow` proposal is what keeps "already merged" from blocking a switch.** Two cases need it. Re-uploading an export gives the same release commit a new blueprint id, and a gadget made from the original should be able to follow the copy. And a gadget that took Alice's latest release by way of Bob's derived blueprint should be able to go back to following Alice. In both, the target is already an ancestor of the head, so there is nothing to merge, but `upstream` names a different blueprint. The proposal keeps the preview-and-accept contract while changing no code: accepting it retargets `upstream`. `upToDate` is reserved for a gadget whose `upstream` already names this blueprint at this release.

A `fastForward` is named for its effect on files. It still writes a two-parent commit at accept, for the reason given in decision 6.

**10. The proposal is recorded in the chat log, and accept reads it from there.** A `changes` message gains `blueprintMerges`, a list of:

```ts
{
  gadgetId, blueprintId, title, version, commitId,
  kind: "follow" | "fastForward" | "merge",
  baseCommit?: string,
  conflictPaths: string[],
  unverifiedBase?: true,
  missingBindings?: Record<string, BlueprintBinding>,
  messageCount?: number,
}
```

The type is `BlueprintMerge` in api.ts. `title` is the blueprint's title at that release, so that describing the proposal needs no second read of the blueprint. `baseCommit` is the base the merge used; it is absent when the target was already in the gadget's history, and on the agent's `createGadget` entry. `conflictPaths` holds paths within the gadget, with no binding-name prefix: the entry names its gadget. A `mainlineMerge` record's paths are `GADGET_NAME/path` instead. `messageCount` is present when the change was split (commit 7): it counts the `changes` messages the change spans, which are the entry's own and the ones at the sequences directly after it. Those later messages hold the rest of the change and nothing else, and the count is the only thing that tells them from edits made afterwards. `mergeChanges` already loads the epoch's messages and their statuses. For each gadget with a surviving entry it sets `upstream`, and it writes a commit with the release as a further parent unless the release is already an ancestor of the head. Consequences:

- No new pin state. Reverting the message removes the proposal, exactly as it removes the pin that message declared.
- A gadget whose release is new to its history is committed even if its content equals its head. Otherwise the lineage would go unrecorded and the next update would compute the wrong base.
- A proposal whose release is already in history declares no pin and writes no commit, so it cannot go stale: the release stays an ancestor however the head moves before accept.
- That same proposal does not appear in `AiChatMetadata.proposedChangeWorkpieces`, which is derived from pins and pending records. `mergeChanges` and `revertChanges` handle it all the same, but the `blueprintMerges` record on a still-proposed message is then the only sign that the chat has something to accept, and the UI has to go by it (commit 11). Listing it would take either new state or a scan of the chat log on every metadata delivery.
- `mergeChanges` looks for surviving entries in the log itself before deciding there is nothing to merge. A compaction checkpoint keeps no trace of a proposal that changes no file.
- The agent's `createGadget({blueprintId})` records an entry on its creation message, with kind `fastForward`, so its first accept writes `[e, R]` with no state on the pending record.
- The record is everything the UI and the agent need to describe the proposal, so neither re-reads a blueprint that may have moved since.

**11. The server starts the agent, once, and only for a merge.**

- **A merge gets an agent turn, even with no conflicts.** Lines that merge cleanly can still disagree: the blueprint renames a function the gadget's own code calls, or both sides add the same feature in different places. Only something that reads the result can catch that. The one exception is a merge whose change is empty (decision 9). Its result is the gadget's own files, unchanged, so there is nothing new to read, and it is treated as a `follow` is.
- **A `follow` or a `fastForward` gets none.** The gadget had no changes of its own to reconcile, so there is nothing to check that the user's own preview does not show. These are the common cases and cost no tokens. Over an unverified base, "no changes of its own" rests on the assumed base being right, which is what the notice's warning is for. A user who wants help anyway, say with a binding the new release needs, asks in the chat.
- **`applyBlueprint` starts the turn itself**, in the same call that creates the chat, with the model the caller named. A null `modelId` starts none, as with `newChat`. One application therefore starts at most one turn by construction, however many collaborators, tabs or reconnects are watching the chat, and no client decides whether to start one. Two people applying the same blueprint at once get two independent chats, like any two chats.
- **The turn is prompted by the record, not by a message.** Replay renders the `blueprintMerges` entry as the model's input: a summary of what was merged and the task. No prose is stored, and a turn with no user message has a precedent in hook callbacks. Like a callback, the entry reaches the model as a `user` message. A `follow`, a `fastForward` or an empty merge is rendered the same way, as a one-line note of what happened, for a later turn in the chat. A proposal that has since been reverted is still rendered: the turn that reviewed it was answering it, and the revert is reported where it happened, as any revert is.
- **The agent sees a summary, not a diff.** It gives the blueprint and version; the base, head and release commit ids, which the agent can mount with `createWorktree` and read with its usual file tools if it wants detail; whether the base is unverified; the missing bindings; and the changed files grouped by outcome. The groups are files with conflicts, files both sides changed that merged cleanly (where hidden conflicts live), and files only the blueprint changed. They are worked out at replay from the three commits, the head being the pin that the proposal's message declares, so the record needs no more fields. Paths are quoted, since a blueprint's author chose them, and each group names at most 50 before counting the rest. User-authored changes are replayed today as an uncapped unified diff (agent.ts:1416), which for a large file would swamp the context.
- **The task is narrow.** Resolve the conflicts, check that the gadget's own changes and the blueprint's still work together (starting with the files both changed, but a rename on one side can break a file only the other touched), wire the missing bindings, change nothing else, and say what was done. Over an unverified base it is also asked to look for work of the user's that the merge undid. The system prompt gains a short section on conflict markers; the agent works with its existing `grep`, `readFile` and `editFile` tools. A blueprint merge labels the three sides `this gadget`, `base` and `blueprint` (`<<<<<<< this gadget`, `||||||| base`, `>>>>>>> blueprint`). A mainline merge labels them `mainline`, `merged base` and `this chat`.
- **The UI renders a notice for every proposal**, generated deterministically from the record: which blueprint and version, what kind of proposal it is, that nothing changes until the user accepts, and that this is their chance to try the new version in the preview first. It lists missing bindings, and an unverified base adds the warning that local edits may have been reverted without a conflict. For a `follow` whose release was already in the gadget's history, the notice is also where accept and discard have to be offered, since such a chat has no `proposedChangeWorkpieces` (decision 10).
- **The conflict-marker check at accept is the UI's.** Before calling `mergeChanges`, the UI looks through the files the epoch's `blueprintMerges` and `mainlineMerge` records list as conflicted, in the chat content it already holds, for a line beginning `<<<<<<< ` or `>>>>>>> `. The two records name files differently (decision 10). What it does on finding one (jump the editor there, pre-fill a prompt, offer "Accept anyway") is a design choice. `mergeChanges` accepts whatever it is given: merging markers is the caller's prerogative. Delete-versus-modify conflicts carry no markers, so only the notice and the summary report them.

**12. Missing bindings are recorded, and the agent wires them when it runs.** `missingBindings` records the bindings the target declares that the gadget lacks, as of the proposal. On a merge, the agent's summary describes them the way `fetchBlueprint`'s notes do today, and the agent wires them with `setGadgetBinding` and `requestConnection`. On a `follow` or `fastForward` the notice lists them for the user. The one-line note the agent is given of such a proposal does not, so an agent later asked to wire one has only the code to go by. Bindings the target no longer declares are left alone. The gadget's `output` format is not changed by a switch. "Lacks" means the gadget has no binding under that name. A binding that exists only to feed an agent spawner (`spawnerOnly`) has no name in the gadget to look for, so it is never listed.

**13. Legacy content converts deterministically.** A stored Yjs snapshot becomes a parentless commit of its files with a fixed author, timestamp and message, so every workspace derives the same commit id from the same content. When a legacy blueprint is next published, its first new release takes that commit as first parent, computed locally from the recorded source commit's files. Gadgets instantiated in between therefore have lineage. No stored value is rewritten.

**14. Bundled blueprints get no release lineage for now.** Their releases are not chained to one another. Chaining them is not worth its cost while they ship build output that is not expected to merge well (see Risks), and it would need machinery this plan otherwise avoids (see Future work).

- The generator emits each blueprint's built file map instead of an archive. It keeps its Yjs reader for the legacy `<name>.gadget` pair layout and for importing version 1 exports.
- The installer turns the file map into the deterministic parentless commit of decision 13, packs it with its tree, and writes R2 then KV. It reads nothing about what was installed before, so no step depends on a KV read being current. Reinstalling the same files rewrites the same bytes under the same key.
- Because it is the same construction as the legacy conversion, a legacy install and a new install of the same files yield the same commit, on every deployment.

What still works: a gadget made from a bundled blueprint records it as `upstream`, sees "update available" when the deployment installs new files, and merges the update against the release it last took (decision 8, fifth row). That is the correct base, every time, with no warning.

What is given up: a blueprint *derived* from one bundled release has no graph link to a later bundled release. Switching a gadget between the two takes the assumed-base path, with its warning, and can undo the difference between the two bundled releases.

**15. Lineage is information, not authority.** A crafted pack can claim any ancestry, which at most suppresses the "unrelated" warning for a blueprint the user chose to apply. The controls are unchanged: the user picks the blueprint, previews the proposal, and accepts. "Update available" and the unwarned fifth row of decision 8 are driven only by the followed blueprint's id, which only its publisher can publish to: its workspace's builders, or for a bundled blueprint the deployment.

## Pack validation

Uploaded archives are untrusted and R2 content is only as trustworthy as its uploader, so the check runs at the one place objects enter a workspace: the Overseer's import. Upload keeps today's header checks only.

- Decode with `decodePackBytes` under the archive's existing 32 MiB cap, a per-object cap, and no external delta bases. Object ids are computed from content, never taken from the pack.
- The commit named by `metadata.commitId` is present.
- Commit history is closed: every parent of every commit is in the pack, up to a bound on commit count.
- Any commit's tree is either absent or complete. The head's is complete.
- Trees contain only subtrees and mode `100644` blobs; blobs are valid UTF-8 no longer than `MAX_FILE_TEXT_LENGTH`; paths obey `MAX_FILE_PATH_LENGTH`. This keeps every imported file readable by `readCommitFiles` and editable by a code change.
- Nothing else is in the pack: no tags, no unreachable objects.
- Publish enforces the same limits, so a blueprint that publishes always instantiates.

Imported objects get no `gitObjectMetadata` rows, so they grant no gatekeeper any read.

## Change inventory by area

### workshop-shared/api.ts

Every addition is doc-commented.

- `BlueprintMetadata.commitId?: string`.
- `GadgetSummary.upstream?: GadgetUpstream`, which is `{blueprintId, commitId}`, delivered to the "build" role only (decision 7). The frontend detects an available update by comparing it with `PublicApi.getBlueprint()`, so detection needs no new RPC.
- `blueprintMerges: BlueprintMerge[]` on the `changes` message body.
- `GadgetClient.applyBlueprint(blueprintId, {modelId, allowUnrelated?})` returning `ApplyBlueprintResult`: `{outcome: "proposed", chatId} | {outcome: "upToDate"} | {outcome: "unrelated"} | {outcome: "baseUnavailable"}`. Build role only, like `createBlueprint`. `modelId` follows `newChat`: an id from `listModels()`, or null for no agent. The options object is a required argument.
- `mergeChanges` and `MergeChangesResult` are unchanged.

Every one of these is additive, so the frontend should keep compiling throughout. That is a convenience, not a constraint (see Commit series).

### workshop-backend: git layer

- **Tree and commit encoders in git-codec.ts**, beside the parsers. Every object this plan writes goes through them, for two reasons. The bundled installer has no object store to hand isomorphic-git. And the legacy conversion (decision 13) must produce the same commit id wherever it runs, which one encoder guarantees and two would have to be tested into. plans/worktrees.md already wants these encoders.
- **Release builder and reader** in a new `blueprint-release.ts`: build a release commit, collect its closure, build its pack, validate and decode an incoming pack, convert legacy content, list a release's files. Pure functions over byte arrays and an object lookup, so the same code runs in the Overseer and in `AdminSettings`.
- **`importObjects(objects)`** on `WorkspaceGitCache`: stores hash-verified objects with no `gitObjectMetadata` rows.
- **`mergeBases(a, b)`** beside `isAncestor` in git-cache.ts, walking local commit objects.
- **`GitStore.firstParentChain(oid)`** and **`GitStore.readCommitFilesIfHeld(oid)`**: a walk of one lineage, and a file read that reports a tree the store does not hold instead of throwing.
- **Pin validation tolerates only the head's first parent** (overseer.ts:2839 and 3052 today accept any parent, which a two-parent head would widen to the upstream release).
- The GC-roots note in git-store.ts gains release commits and `GadgetRecord.upstream`.

### workshop-backend: blueprints

- `createBlueprint`, `updateBlueprint`, `retryBlueprintPublish`: mint or re-send a release instead of calling `snapshotCode`, which is deleted. `propagateBlueprint` writes the pack at the new key.
- `deleteBlueprintPropagation` and `user.ts:deleteOwnedBlueprint`: delete by prefix.
- `readBlueprintContent` is replaced by one loader, used by every path that instantiates or applies: read KV and R2, turn pack or legacy bytes into validated objects, import them, and return the release commit with its metadata.
- `initializeFromBlueprint` and `fetchBlueprint` call that loader. The first takes a blueprint id instead of content bytes, so the pack no longer crosses an RPC from server.ts; it writes `e` and `i` and sets `upstream`. The second returns the release for the creation message.
- `importBlueprint`, `downloadBlueprint`, blueprint-archive.ts: accept and emit container versions 1 and 2.
- bundled-blueprints.ts and the generator: decision 14. `import:bundled-blueprint` learns to read version 2 archives, with `git` (see commit 5).
- Storage: `GadgetRecord.upstream`, `BlueprintGadgetRecord.releases`. Both optional, so neither needs a migration. One was added afterwards all the same, as schema version 5, to record where gadgets that predate `upstream` came from (see Backfilling `upstream` below).

### workshop-backend: chat and agent

- `applyBlueprint` body, modelled on `updateChatFromMainline`: same revalidation after awaits, same delivery as a change row plus a materialized message. It also creates the chat, which today only `newChat` does, and only from a user message, and for a merge it starts the agent turn.
- `mergeChanges`: `upstream` and extra parents from the log, the commit-if-new-to-history rule, the empty root for a pending gadget.
- agent.ts: the merge summary and task in replay, the prompt section, the release on `createGadget`'s recorded output.

### Frontend

Load the `frontend-conventions` skill before starting.

- **"Update from blueprint…"** in the gadget menu: two options, updating from the followed blueprint (the default) or, under "Advanced: Switch blueprints", from another blueprint the user names by pasting its ID or link, with a note that it must be derived from the same base. With no followed blueprint known or available, only the second is offered. Then the unrelated-blueprint warning with its confirm step. A "Reviewing agent" selector, starting on the user's selected model and offering "No agent", picks the model it passes.
- **"Update available"** indicator on a gadget whose followed blueprint has moved.
- **Proposal notice** for a `blueprintMerges` batch, in place of the generic changes card (decision 11).
- **Conflict-marker check** before accept, covering mainline merges too.
- **Blueprint modal** can show whether the gadget has unpublished changes.

### Docs

`docs/blueprints.md` (format, storage keys, updates, and its stale statements about Yjs), `packages/bundled-blueprints/README.md`, and the bundled-blueprints paragraph of `AGENTS.md`. Header comments in git-store.ts and blueprint-archive.ts change with the code they describe.

## Commit series

This lands as one PR made of the commits below, in order. Kernel commits (`workshop-backend`, `workshop-shared`) come first and stay separate from UI commits, so each can be reviewed on its own.

**Each commit must pass the tests of the packages it modifies, and only those.** A package that depends on a changed one may be broken until the later commit that is slated to update it. Do not add stubs, shims or placeholder implementations to keep the build green in between. In particular, an API change that breaks the frontend is fixed in the frontend commits, not papered over when the API changes. Use `pnpm --filter <package> test:run` per commit; `pnpm build`, `pnpm test` and `pnpm lint` must pass at the end of the series.

Commits 4, 6 and 7 fix commit shapes permanently, so they deserve the closest review.

**Status: commits 1 to 9 are implemented.** Where what was built differs from what this plan first said, the decisions above have been brought into line, and the notes on commits 10 and 11 below say what that means for each.

### 1. `workshop-backend`: tree and commit encoders in git-codec

- `encodeGitTree(entries)` and `encodeGitCommit({tree, parents, author, committer, message})`, beside the existing parsers. Tree entries are sorted in git's canonical order, where a directory compares as if its name ended in `/`.
- Tests in `git-codec.test.ts`: for the same inputs, the ids match what `GitStore` (isomorphic-git) writes, including nested directories and names that sort differently as files and as directories.
- No callers yet.

### 2. `workshop-backend`: `blueprint-release.ts`

Pure functions, no storage and no `cloudflare:*` imports:

- **Build a release commit** from a tree id, parents, author, title, version and timestamp.
- **Convert legacy content**: a file map becomes tree objects and a parentless commit with a fixed author, timestamp and message (decision 13).
- **Collect a pack's objects** given an object lookup and a release commit: its full tree, every ancestor commit, and the fork-point trees (decision 4). Enforces the publish-side limits.
- **Read a pack**: decode, then apply every rule under Pack validation. Returns the objects keyed by computed id.
- **List a release's files** from a set of objects, for callers with no object store.

Tests in a new `blueprint-release.test.ts`: pack round trip, cross-checked against real `git index-pack --strict` and `git fsck` as `buildPackBytes` was; one rejection test per validation rule; fork-point selection over the Alice, Bob and Carol graph and a three-level derivation; legacy conversion yields a fixed, known commit id.

### 3. `workshop-backend`: `importObjects` and `mergeBases` on the git cache

- `WorkspaceGitCache.importObjects(objects)`: one storage transaction, no metadata rows.
- `WorkspaceGitCache.mergeBases(a, b)`: best common ancestors over local commit objects. Like `isAncestor`, it never pulls.
- Tests in `git-cache.test.ts`: linear, forked, criss-cross and disjoint graphs; imported objects are invisible to every gatekeeper's scoped view.

### 4. `workshop-shared`, `workshop-backend`: publish and read releases

The format switch, with no change to what instantiation produces.

- **API:** `BlueprintMetadata.commitId`.
- **Storage:** `BlueprintGadgetRecord.releases`.
- **Publish:** `createBlueprint` and `updateBlueprint({updateCode})` mint a release whose only parent is the previous release, or for a legacy record the conversion of its recorded source commit's files. A republish with an unchanged tree mints nothing. `retryBlueprintPublish` rebuilds the pack from the recorded release. `propagateBlueprint` writes `<blueprintId>/<commitId>`. `snapshotCode` is deleted.
- **Read:** the loader described under Change inventory replaces `readBlueprintContent`. `initializeFromBlueprint` and `fetchBlueprint` use it, then build the gadget from the release's files exactly as today: a fresh parentless commit on the UI path, `set` changes on the agent path.
- **Archive:** blueprint-archive.ts parses container versions 1 and 2 and emits the version matching the stored content. `importBlueprint` stores version 2 content under the commit id its metadata names.
- **Delete:** `deleteBlueprintPropagation` and `user.ts:deleteOwnedBlueprint` list and delete the `<blueprintId>/` prefix, which covers legacy and new keys alike.
- **Tests:** a release chain across publishes, including the first release after a legacy record and a no-op republish; retry re-sends an identical pack; a legacy blueprint and a version 1 archive still instantiate; a pack that fails validation refuses to instantiate and leaves no gadget behind; delete removes every object.

The bundled installer still writes legacy content after this commit, which the loader reads.

### 5. `bundled-blueprints`, `workshop-backend`: bundled blueprints install as packs

Decision 14, both halves: what the generator emits, and what the installer makes of it. One commit, because the generated module is the interface between the two packages and neither side builds against the other's old half.

- **Generator:** `BUNDLED_BLUEPRINTS` entries carry `files`, as `[path, text]` pairs sorted by path, plus the metadata the archive used to hold (`created`, `version`, `lastUpdated`, `bindings`), instead of a base64 `archive`. `contentHash` covers all of it.
- **Legacy layout:** the `<name>.gadget` pair layout is still read, as version 1 only, through the existing Yjs reader. The build refuses a version 2 archive there and says to import it: a version 2 export enters the repo through `import:bundled-blueprint`, which rewrites the entry in the extracted layout.
- `buildContent` and `serializeArchive` go; `parseArchive` (which now reports the container version) and `extractFiles` stay for the pair layout and the importer.
- **Installer:** `installOne` turns the entry's files into the deterministic parentless commit of decision 13, builds a pack of that commit and its tree, and writes R2 at `<blueprintId>/<commitId>` then KV with `metadata.commitId`. It never reads the previous install. `metadata.version` still comes from `blueprint.json`.
- **Importer:** `scripts/import-bundled-blueprint.ts` reads a version 2 archive by having `git` unpack its pack and list the release's tree. It does not go through `blueprint-release.ts`, which a Node script cannot import: the backend's scripts are type-checked as Node programs (`scripts/tsconfig.json`), and that module brings `workshop-shared`'s API types with it, which need the Workers types. The importer already required `git`, it only takes files out, and the build validates the staged tree before anything is replaced, as it does for a version 1 export.
- The package README changes here.
- **Tests:**
    - `bundled-blueprints.test.ts`: a fresh install instantiates; the commit id equals the legacy conversion of the same files; reinstalling unchanged files is idempotent; changed files yield a new parentless commit; a metadata-only change leaves the commit id alone.
    - `scripts/build-bundled-blueprints.test.ts`: the generated module's shape and fingerprint; a version 2 export imports, and one that names no release, or holds something a release cannot, is refused before anything is replaced; the pair layout refuses a version 2 archive and importing it migrates the entry.

### 6. `workshop-shared`, `workshop-backend`: lineage

- **API and storage:** `GadgetRecord.upstream`, surfaced as `GadgetSummary.upstream` to the "build" role.
- **Instantiate:** `initializeFromBlueprint` writes the empty root `e` and `i = [e, R]`, and sets `upstream` (decision 6).
- **Publish:** a release gains upstream parents, found by walking the source gadget's first-parent chain back to the previous release's `sourceCommit` and collecting other parents (decision 2). A derived blueprint's first release gets its own empty root, `Release 0: <title>`. Packs now carry fork-point trees.
- **Pins:** tolerance narrows to the head's first parent.
- **Audit:** every reader of commit parents in the backend, for an assumption of at most one. Today that is the pin prefetch (overseer.ts:2840) and the walks in git-cache.ts, which already handle several.
- **Tests:** instantiation produces `[e, R]`; a gadget instantiated from a legacy blueprint gets the converted commit as `R`; Bob's release is `[B0, A2]` and its pack carries A2's tree; a second release from Bob names no parent twice; a pin at the release parent of the head is rejected.

### 7. `workshop-shared`, `workshop-backend`: apply

- **API:** `blueprintMerges` on the `changes` message; `GadgetClient.applyBlueprint`, denied to the "use" role. Its options object is required, so that commit 8 only adds a field to it.
- **`applyBlueprint`:** decision 9 without its agent step, classified and based per decision 8, taking `{allowUnrelated?}` only. The chat is created with a deterministic title and no user message. A merge too large for one `changes` message (they are bounded by `CHAT_CHANGE_MESSAGE_BUDGET`, agent.ts:57) is split by file across consecutive messages, the first carrying `blueprintMerges`, whose entry counts them in `messageCount`.
- **`mergeChanges`:** a surviving `blueprintMerges` entry sets its gadget's `upstream`. If its release is not already an ancestor of the head, the gadget is committed with the release as a further parent, even when its content equals its head. A pending gadget with an entry gets an empty root first, so its first commit is `[e, R]`. A message carrying only an entry, with no `change`, still counts as something to accept, as a creation-only batch does.
- **Agent path:** `createGadget({blueprintId})` puts a `blueprintMerges` entry on its creation message.
- **Revert:** a `blueprintMerges` message is revertible like any other, unlike a `mainlineMerge`, because it advances no pin.
- **Tests:**
    - each kind is classified correctly, including a target whose files equal the base's;
    - conflicting, unrelated and base-unavailable applies;
    - the same release under a new blueprint id yields a `follow` proposal, and accepting it retargets `upstream` and writes no commit;
    - a gadget that took Alice's release through Bob's blueprint can go back to following Alice;
    - `upToDate` is returned only when `upstream` already names the blueprint at that release;
    - a blueprint with unchained releases updates twice, the second time using the first update's release as base, with no warning either time;
    - a gadget with no upstream falls back to its first non-empty commit and sets `unverifiedBase`, except when that tree matches a release;
    - accept writes two parents and sets `upstream`; a release new to history is committed even with no file changes;
    - reverting the proposal leaves no trace at accept, and discarding the chat leaves `upstream` alone;
    - an oversized merge splits; agent-created gadgets accept as `[e, R]`; Carol's switch finds A2;
    - of several best common ancestors, the one in the target's lineage is chosen, else the latest;
    - a proposal that changes no file is still accepted after a compaction checkpoint covers it.

The agent path is tested by running the real `createGadget` tool, with pi's faux provider scripting the model as `describe-binding.test.ts` does. A second test has the tool's copy of the files fail for want of room in the step, and checks that no entry is recorded for the gadget it leaves behind.

### 8. `workshop-shared`, `workshop-backend`: the agent reviews a merge

- **API:** `applyBlueprint` gains `modelId`.
- **Kick-off:** `applyBlueprint` starts a turn after recording a `merge` proposal, and for no other kind (decision 11). A `merge` whose change is empty (decision 9) has nothing to review, and starts none.
- **Replay:** a `blueprintMerges` entry of kind `merge` renders as the summary and task of decision 11 instead of a diff. Until this commit a proposal replays as any user-authored `changes` message does, as an `observeUserChanges` diff (the `"changes"` case of replay in agent.ts). A split merge's later messages carry the rest of the change and no entry. They are the `messageCount - 1` messages directly after the entry's (decision 10), and replay applies their changes without rendering them as user diffs. A `follow` or `fastForward` proposal renders as a one-line note, so a later turn in the same chat knows what happened, and so does an empty merge. The entry on the agent's own `createGadget` message needs none. A reverted proposal is rendered like any other, ahead of the revert.
- **Prompt:** the system prompt gains the conflict-marker section, which covers mainline merges too.
- **Shared text:** the description of missing bindings moves out of `fetchBlueprint` into `formatMissingBlueprintBindings` in agent.ts, which the summary also uses.
- **Tests:** a merge starts exactly one turn, with or without conflicts; `follow`, `fastForward`, an empty merge and a null model start none, and leave a note; replay of a clean merge, a conflicted one that the agent resolves, one with an unverified base and one with missing bindings; a reverted proposal stays in the agent's history; the summary's size does not grow with the size of the files merged, split or not.

Most of the tests record the turn `applyBlueprint` starts rather than let it run, then run it by hand with pi's faux provider. One lets the workspace run it, with a model that cannot be reached, and checks that the failure leaves the chat idle and the proposal still to accept. A turn that the workspace starts and that reaches a model is left to commit 9.

### 9. `integration-tests`, `workshop-backend`: end to end

In `workshop-blueprints.test.ts`:

- publish, instantiate, edit both sides, republish, apply, resolve, accept. The conflict is resolved by hand, with `submitCodeChange`, and the merge is read back through the chat's preview;
- the Alice, Bob and Carol switch end to end, between three accounts, down to the commits that Carol's history then lists and the base her next update from Bob finds;
- applying to a gadget with no lineage, with and without `allowUnrelated`;
- a merge runs the mock model for one turn and a fast-forward never calls it. Nothing before this runs the turn `applyBlueprint` starts as far as a model (see commit 8);
- a bundled blueprint reinstalled with new files updates a gadget made from the old ones;
- a version 1 `.gadget` still imports and instantiates, and a version 2 download re-imports: as the same release under another id, which a gadget made from the original is then proposed only to follow;
- a "use" collaborator is not told which blueprint a gadget follows (decision 7).

Every `applyBlueprint` call names a `modelId`, which is null where no turn is wanted.

No existing assertion needed updating: nothing in this package looked at the root commit of an instantiated gadget or at an archive's version. "republishing a blueprint changes future installs, not existing ones" passes as it was.

In `workshop-use-role.test.ts`, `applyBlueprint` joins the table of `GadgetClient` methods denied to the "use" role. The table is exhaustive at compile time, so this package's type check fails from commit 7 until this is done.

**The reinstall test deploys twice.** The bundled blueprints are compiled into the Workshop, which the suite builds once, so a test cannot change them by writing a file. Two additions to the toolkit make them a matter of configuration instead (docs/integration-testing.md). `Harness.redeployWorkshop()` deploys another build over the running one, keeping its storage, so that the `AdminSettings` that installed the old files is the one that notices the new. `bundleBlueprints()` is a patch that has a build ship the blueprints a test names. The test starts a harness of its own, since a redeploy breaks every session open at the time.

**Fixed here: `GitStore.readCommitLog()` listed some commits twice.** It delegated to isomorphic-git's `log()`, which lists a commit again when it reaches one it has already listed. That happens to a commit which two parents of a merge both lead to, unless it is older than everything between: a tie is enough, and commit dates are whole seconds. Carol's history has such commits in the releases that Bob's blueprint was built on, and her log listed them twice. The audit of commit 6 missed this reader of parents: it follows every one, but trusts commit dates to bring it to a shared ancestor only once. The walk is now the store's own, and lists each commit once.

### 10. `workshop-frontend`: applying a blueprint

- "Update from blueprint…" in the gadget menu, with the followed-or-switch choice and the unrelated-blueprint confirmation. It passes the model picked in its "Reviewing agent" selector (the user's selected model by default, or "No agent"), and on `proposed` it opens the new chat. It says so when the outcome is `upToDate` or `baseUnavailable`, and offers a retry when the call fails because the gadget changed meanwhile.
- The "Update available" indicator, from `GadgetSummary.upstream` and `getBlueprint()`. A followed blueprint whose metadata has no `commitId` is legacy and never shows one. Neither does a "use" collaborator's view, which is not told `upstream`.
- The blueprint modal shows whether the gadget has unpublished changes.

### 11. `workshop-frontend`: the proposal in the chat

- The proposal notice, rendered from the `blueprintMerges` record. The UI never starts the agent for a proposal; the server already has. The chat of a merge therefore arrives with `activeAgent` set and no message from anyone: the agent's reply follows the notice directly. (A chat subscriber hears of the new chat while it is being set up. The first deliveries of its metadata carry no `activeAgent`, and the one that does follows within the same call, a few milliseconds later.) A split merge's later `changes` messages have no record of their own; the entry's `messageCount` says which they are, so they can be folded into the notice rather than shown as generic cards.
- Accept and discard for a chat whose only proposal is a `follow` of a release already in the gadget's history. `proposedChangeWorkpieces` is empty for such a chat, so they are offered wherever a `changes` message that is neither merged nor reverted carries `blueprintMerges` (decision 10).
- The conflict-marker check before accept, for blueprint and mainline merges. A `blueprintMerges` entry gives paths within its gadget, and a `mainlineMerge` record gives `GADGET_NAME/path`.
- Tests: notice text for each kind and for unverified-base, conflicted and missing-binding records; accept is intercepted while a listed file still has markers and proceeds once they are gone.

### 12. Docs

`docs/blueprints.md` and the bundled-blueprints paragraph of `AGENTS.md`.

Fork-point trees (in commit 6) could be dropped from this series without a format change, at the cost that releases published before they land cannot serve as a switch target for gadgets that never held the fork point.

## Backfilling `upstream`

Added after the commit series. A gadget made from a blueprint before this plan has no `upstream`, so the dialog has no blueprint to offer, and nothing in the gadget's history names one. And with `upstream` simply absent on everything else, a gadget that was never made from a blueprint cannot be told from one whose blueprint was not recorded, so "Update from blueprint…" is offered where it makes no sense.

`upstream` therefore gains two partial forms, and its absence a narrower meaning:

| `upstream` | Meaning | "Update from blueprint…" |
|---|---|---|
| `{blueprintId, commitId}` | As decision 7. | Shown, blueprint offered |
| `{blueprintId}` | Made from that blueprint; the release it took is unknown. | Shown, blueprint offered |
| `{}` | Built from scratch in this workspace. | Hidden |
| absent | Origin unknown. | Shown, blueprint named by ID or link |

- **Going forward.** `OverseerImpl.createGadget`, which every creation from no blueprint goes through, writes `{}`. Instantiation and accept already write the full form. So absent and `{blueprintId}` are legacy states, apart from a gadget the agent is creating from a blueprint, which has none until its creation is accepted.
- **The migration.** `migrateToBlueprintUpstreams` (version 4 to 5) scans the chat log. The agent's `createGadget` tool call names the gadget (`output.gadgetId`) and the blueprint if any (`input.blueprintId`): with one the gadget gets `{blueprintId}`, without one `{}`. A `changes` message in a user's name that lists a gadget in `createdGadgets` is the user's own creation, and gets `{}`. The message that converted a chat from the storage before git is excluded: it is in the owner's name and lists again whatever gadgets were pending in the chat, whoever made them. Gadgets with no such evidence stay absent.
- **The release is not recovered.** A gadget with `{blueprintId}` is treated as one with no upstream everywhere but in the update dialog: no "Update available", and decision 8's last row applies, with its warning, even when the blueprint applied is the one named. Accepting that proposal records the release. Recovering the release from the creation's `changes` message, or taking the gadget's first commit for it, was considered and set aside as not worth the code: the first is exact only when the agent wrote nothing else in the step, and the second announces an update on every such gadget.
- **Hiding is the UI's alone.** `applyBlueprint` treats `{}` as it does absent, and accepting its proposal overwrites it. So nothing in the kernel has to be undone by the flow below.
- **Bounded.** The migration runs synchronously in the constructor. It reads no chat in a workspace with no gadget that lacks an `upstream`, which many are: one chat working on external resources, and no gadget at all. Otherwise it reads at most 1000 messages per workspace, divided between the chats and taken from the start of each, where creations mostly are.
- **Left of unknown origin.** Gadgets instantiated through the UI, which left no record of their blueprint outside product analytics; gadgets a user created outside any chat; and gadgets whose creating chat was deleted or whose creation the scan did not reach. All keep the manual path: name the blueprint, and confirm the warning.
- **Not served: merging back into a blueprint's source.** Alice builds a gadget from scratch and publishes it; Bob builds on her blueprint and publishes his; Alice wants Bob's changes. Her gadget is `{}`, so the UI offers her no update. What it would have offered was poor anyway: her history holds no release, so the base would be her first commit, far behind what Bob started from. The right base is the commit she published from, which `BlueprintGadgetRecord.releases` records as `sourceCommit`. That is a flow of its own, left to a later change.

## Risks

- **Bundled formats merge poorly, and that is accepted.** They ship esbuild output only until the Gadgets environment can bundle for itself, after which they ship as source. For the same reason their releases are not chained (decision 14). Gadgets made from them are customized by editing the built files, so an update to one may conflict heavily. Merge quality for them is not a goal in the meantime. The release that switches a bundled blueprint from built output to source will replace `client.js` and `server.js` wholesale: gadgets customized against the built files get one noisy update, with their edits surfacing as delete-versus-modify conflicts for the agent to port over.
- **Wrong assumed base.** Covered under decision 8. The mitigation is review, not correctness. A merge over an assumed base gets the agent's review as well as the user's. A fast-forward over one replaces the gadget's files with the blueprint's and runs no agent, so there the only reviewer is the user, prompted by the notice's warning.
- **A conflict in a very large file.** A conflicted file holds both sides and the base, so its merged text can exceed `MAX_FILE_TEXT_LENGTH`, which the files that went into it obey. What the edit tools and a later publish make of such a file has not been tested. A mainline merge has the same exposure, but built bundles make it likelier here.

  > **Update: Part 2 refuses such a merge** (its decision 14).
- **A large file that differs throughout. Open: found while testing commit 9, and not addressed.** `applyBlueprint` records its result as a minimal character-level change (`diffFiles`), as a mainline merge does, and that diff has no bound on the time it takes. Where the release's version of a file has little in common with the gadget's, it is nearly the whole cost of the call. Applying the bundled Sheets blueprint to a gadget just made from the bundled Docs one, with `allowUnrelated`, took 107 seconds in the local runtime, as a fast-forward. Their `client.js` files are 76 KB and 137 KB, and the diff of those two alone takes 88 seconds in Node. The workspace answers nothing meanwhile, and how a deployed Durable Object's CPU limit treats a call that long has not been tried. An ordinary update is not affected: scattered edits to the 137 KB file diff in 45 ms. What is affected is a blueprint applied to a gadget of another format, since every gadget has a `client.js`, and a release whose build output changed throughout. Recording a file that the merge took whole from the release as a `set`, as the agent's `writeFile` does, would cover the fast-forward. A merge that blends two versions with little in common would still be diffed.

  > **Update: addressed by Part 2**, which writes the merge as a commit and diffs nothing.
- **Every merge costs an agent turn**, including the ones that would have been fine. That is the price of catching conflicts a line merge cannot see.
- **Previewing an update that migrates stored data.** A chat preview shares the gadget's storage, so discarding the code does not undo the migration. Accepted until the database-fork workstream lands.
- **Memory.** Import decodes a whole pack in the Overseer, up to the existing 32 MiB archive cap plus inflated objects. A streaming pack decoder has been discussed and would remove this, but it is a separate change.
- **Published identity is permanent.** A release commit carries its author's name and commit email into every derived blueprint's pack, and deleting the original blueprint does not recall it. The same identity is already public in blueprint metadata, but that copy can be deleted.

## Future work

- **Recursive merge** for several best common ancestors.
- **Fetching a missing base tree by commit id**, as a fallback for the "refuse" row of decision 8. Not a replacement for fork-point trees, for the reasons under decision 4.
- **A streaming pack decoder** (see Risks).
- **Chained releases for bundled blueprints**, once they ship as source. The installer would have to choose each release's parent from an authoritative per-blueprint record of the installed head in `AdminSettings` storage, with KV as its public mirror and a defined retry when propagation fails. Choosing the parent from a KV read could pick a stale one and fork the lineage for good.
- **Assignment UI for new bindings**, in place of agent notes.
- **Release notes** as the release commit message, and a "what changed" view between releases.
- **History UI.** `getCommitLog` with first-parent traversal now yields exactly the gadget's own history.
- **Dropping Yjs from the backend.** Blocked on legacy KV records, which nothing rewrites, and on the pre-git migration. A one-off sweep that republishes legacy content would unblock the first.
- **Pushing a blueprint lineage to a real git remote.** Releases are ordinary commits, so this is now mostly a transport question.

# Part 2: Merges as commits

Part 1 (above) is implemented on this branch and deployed nowhere, so Part 2 may change anything it introduced: wire types, storage shapes, and the commits an accept writes. Update-from-mainline is older than this branch and is deployed, so a chat whose log holds one of its messages has to keep working (decision 11).

Line numbers are as of `0a739a11`.

## Problem

Both merges compute a merged file map and then deliver it into the chat as an operational-transform change. `updateChatFromMainline` (overseer.ts:3275) and `applyBlueprint` (overseer.ts:3370) each call `diffFiles` on the chat's content and the merged files, and record the result as a change row and a `changes` message.

- **The diff has no bound on its time.** `diffFiles` is a minimal character-level diff. Part 1's open risk measured it: 88 of the 107 seconds of applying one bundled blueprint to a gadget made from another. The merge itself is cheap, since `threeWayMerge` takes a file whole wherever only one side changed it and runs a line merge only where both did.
- **Machinery exists only to carry the change.** A merge too large for one message is split by file across several (`splitCodeChangeByFile`, `BlueprintMerge.messageCount`), which replay, the notice and the UI's fold each put back together.
- **A change is a poor record of a merge.** The agent sees a mainline merge as an uncapped unified diff, presented as the user's own edits. It sees a blueprint merge as a summary that cannot name the result, because the result is not a commit. And a still-proposed mainline merge cannot be reverted, because nothing records what the pin was before it.

## The model in one picture

**A merge is written as a commit, and the chat's pin for the gadget moves onto it.** The chat log records that the pin moved. It carries no change.

```
update from mainline                         apply blueprint

B ── H              mainline                 H             the gadget
│    │                                       │
S ── M = [H, S]     the chat                 M = [H, R]    the new chat

the pin afterwards:        {baseCommit: M, mergedCommit: H}

accept, no further edits:  head = M
accept after edits:        C = [M], head = C
```

- `H` is the gadget's head when the merge is made, and `R` is the blueprint release.
- `B` is the mainline commit the chat had last merged: the pin's `mergedCommit` before the update.
- `S` is a snapshot of the chat's files for the gadget as they were before the update (decision 3). Its parent is the commit the pin was at, which is `B` in the picture.
- `M` is the merge result. It is not the gadget's head until the chat is accepted, and a chat that is discarded leaves it dangling.

Both merges have two parents, and only one of them merged a blueprint. The commit on the right says so, in a header (decision 12). Nothing infers it from the shape.

A pin already has the two fields this needs. `baseCommit` is the commit the chat's changes compose on, and `mergedCommit` is the head that an accept must fast-forward from. Until now the second was the first, or a descendant of it. After a merge it is the first's first parent.

## Core decisions

**1. A pin declaration re-roots its gadget.** A `changes` message whose `pins` names a gadget sets that gadget's content to the named commit's tree. If the gadget was already pinned in the epoch, the changes that earlier messages recorded for it no longer count. This is the one rule every fold of the log follows.

- Three folds already behave this way: `buildChatContent` (overseer.ts:1936), the agent's `applyReplayedPin` (agent.ts:1803), and the checkpoint's pin map (agent-compaction.ts:413).
- Two compose an epoch's changes into one, and have to learn it: `buildCompactionState` (agent-compaction.ts:423) and the frontend's `computeChatEpochChanges` (ChatInterface.tsx:2418). Both move to one helper in `workshop-shared/src/code-change.ts`, which composes a sequence of batches and drops a gadget's accumulated change when a batch declares a pin for it. A `CodeChange` is keyed by workpiece, so the drop is one key. A checkpoint's `proposedChange` seeds the helper, so a re-root in the messages after a compaction boundary drops the gadget's part of the seed too. Where nothing is left the helper returns no change at all, never an empty one. Nothing may read that as "nothing is proposed" (decision 13).
- The log's declaration gains an optional `mergedCommit`, absent when it equals `baseCommit`. It is a new type, `ChatGadgetPinRecord`, used by a message's `pins` and a checkpoint's `pins`. `CodeChangeSubmission.pins` keeps the strict `ChatGadgetPin`, so no client can declare one. It records what the pin was when it was declared, for whoever describes the merge (decision 9). The pin's live `mergedCommit` is never set from it (decision 6).
- A reverted message declares nothing, as now. So reverting a re-root brings back the earlier declaration and the changes recorded since it, in every fold alike.

**2. The merge commit's parents.** An update from mainline writes `M = [H, S]`: mainline first, then what the chat had (decision 3). A blueprint merge writes `M = [H, R]`, which is the commit Part 1 had accept write.

- **`H` is first in both.** A first parent is the gadget's own previous state, and the gadget's own history stays its first-parent chain. In an update from mainline the chat is the side being merged in, as a branch is in the merge commit of a pull request.
- **The two are told apart by a mark, not by their shape.** A commit that merges a blueprint release names the release in a header, and nothing else is read as having merged one (decision 12). Part 1 took every parent but the first for a release. That was true of every commit it wrote, and `M = [H, S]` ends it.
- If `S` is already in `H`'s history, the chat had nothing of its own to merge. No commit is written and the pin moves to `H` itself.
- Messages: `Merge latest changes into chat: <chat title>` and `Merge blueprint: <blueprint title> v<version>`. The author is the user who ran the update or applied the blueprint.
- An accept with no further edits makes `M` the head, so its message is what the gadget's history shows for the chat's whole change.

**3. An update from mainline also commits what the chat had before it.** `S` holds the chat's files for the gadget as of the update. Its message is `Chat before update: <chat title>`. It is the second parent of `M`, and the merge record names it as well (decision 8).

- **Its parent is the commit the pin was at.** That is the commit the chat's changes were made on, whichever it is: the mainline commit the chat was first pinned at, or the merge commit of an earlier update, or of a blueprint proposal. In the last case the release stays in the chat's history, through `S`, when the chat is brought up to date. If the chat's files equal that commit's, `S` is that commit and nothing is written.
- The mainline commit the chat had last merged, `B`, was considered for the parent, since it would keep `S` one step from the gadget's own chain. It was set aside because it would say that the chat's changes were made on a commit they were not, and would drop that earlier merge from history.
- It gives the agent all three sides of the merge as commits it can mount and diff, and a way to restore its own version of a file that a clean merge got wrong.
- It makes the summary of a mainline merge the same computation as a blueprint merge's (decision 9).
- A blueprint merge needs none: the chat is new, so what the gadget had before is `H`.

**4. A re-root reaches clients as a destructive generation bump.** The frontend's OT client rebuilds on one: for each pin it reads the base texts it needs from `pin.baseCommit` and applies the epoch's composed change (`#rebuild`, otClient.ts:811). With the fold of decision 1 that is the right content. No other path in the client resets one gadget.

- `updateChatFromMainline` writes its message first and the metadata second, in one synchronous step, as `revertChanges` does. A client rebuilds when it sees the new generation, and the message has to be in its fold by then. Written the other way round, it would apply the epoch's earlier changes to the new base.
- Every live row was materialized before the merge was computed, and the revision token rules out any since. So deleting the rows loses nothing the server had accepted.
- **Accepted cost:** keystrokes that a collaborator had not yet had acknowledged, at the instant of an update, are dropped, with the toast a revert already shows. A content-preserving bump would save them. It was set aside because the client's handoff keeps only the paths its own buffers touch, which is right after an accept, where every pin evaporates, and wrong here, where the other pins and their changes survive.
- `applyBlueprint` creates its chat already pinned at `M`. No client holds state for a chat that did not exist, so it needs no bump.

**5. Accept fast-forwards from the merge commit.** Whether the chat has anything to accept at all is decision 13. Where it has, `mergeChanges` decides, per gadget, in this order:

1. **Nothing to do**, as now: the chat's files equal `mergedCommit`'s, and the chat proposes no release that the head's history lacks.
2. **The stale gate**, unchanged: `mergedCommit` must be the gadget's head.
3. **The parent.** If the pin's `baseCommit` is a merge not yet accepted, which is to say its first parent is `mergedCommit`, the parent is `baseCommit`. Otherwise it is `mergedCommit`, as now. That second case is a pin that never moved, or one that a merge from before this part advanced (decision 11).
4. **The head.** If the chat's files equal the parent's, and every release the chat proposes is in the parent's history, the head becomes the parent and no commit is written. Otherwise a commit is written on the parent. If the parent's history lacks the release, the commit has it as a further parent and is marked as merging it (decision 12).

The release test in step 4 is Part 1's, made against the parent instead of the head.

- It does nothing after `applyBlueprint`, whose `M` already has `R`.
- It does nothing either when an update from mainline has since re-rooted the proposal. The chat's snapshot has the proposal's `M` as its parent (decision 3), so the new merge commit has `R` in its history.
- It still gives the agent's `createGadget({blueprintId})` its `[e, R]`, which is now the one case in which accept adds a release.

**6. A revert restores pins from the log.** After writing the revert message, `revertChanges` settles each pin from two records, one for each of its fields:

- **`baseCommit`** is that of the pin's last surviving declaration. A pin with none is dropped, as now.
- **`mergedCommit`** is the merge base of the earliest update from mainline that the revert covered for the gadget: the `baseCommit` of its `mainlineMerge.gadgets` entry (decision 8). An update merges against the pin's `mergedCommit`, so that entry records exactly what the pin's was before it. If the revert covered no update of the gadget, `mergedCommit` stays as it is, since nothing else moves it.

This is how a revert already rolls back a worktree's head: to what the earliest covered `worktreeCommits` entry says it was before.

- **Why not the declaration's `mergedCommit`.** A merge from before this part advanced `mergedCommit` and declared nothing (decision 11), so the last surviving declaration can be behind the pin it describes. Restoring from it would leave the chat holding that old merge's content with a pin that says the content was never merged. The next update would merge against too old a base, and where mainline had since undone a change the old merge brought in, it would take the chat's stale copy for an edit of the chat's own and keep it, with no conflict reported. The update's own record is right whichever form the merges before it took.
- A mainline merge of the new form can therefore be reverted like any other change. The refusal at overseer.ts:4029 narrows to merges recorded before this part.

**7. A blueprint proposal's kind is decided by the merge's result.** `follow` if the result equals the gadget's files and nothing conflicted, else `fastForward` if the gadget's files equal the base's, else `merge`.

- A gadget and a blueprint that made the same changes are now a `follow`. Part 1 called that a `merge` whose change is empty, and special-cased it in `applyBlueprint`, in replay and in the notice. All three cases go.
- **A conflict makes a `merge`, whether or not a file changes.** Where the gadget changed a file that the blueprint deleted, the gadget's version is kept and the file is listed as conflicted. If that is all the release did, the result is the gadget's own files, yet the two sides were not reconciled: whether the file should stay is still to be decided. Part 1 started no turn for this either, as an empty merge.
- So a `follow` means that every change the release made is already in the gadget, and a `merge` always has something to review: a changed file or a conflict. It always starts the agent's turn.
- Unless the release is already in the gadget's history, every kind writes `M = [H, R]`, marked as merging `R` (decision 12), and pins the chat at it. That includes a `follow`: the commit is what records the release.
- The agent's `createGadget({blueprintId})` is unchanged. A pending gadget has no head to commit on, and its files arrive as `set` changes, which cost no diff.

**8. The records.** A `changes` message that records a merge has no `change` and no `watermark`. Its `pins` holds the re-root, one declaration per gadget merged: `{gadgetId, baseCommit: M, mergedCommit: H}`.

- **`mainlineMerge` gains `gadgets`**, a list of `{gadgetId, baseCommit, chatCommit, conflictPaths}`. `baseCommit` is `B`, the base of the merge, as in a `BlueprintMerge`: not the pin's `baseCommit`, which is `M`. It is also what the pin's `mergedCommit` was before the update, which is what a revert of the update restores (decision 6). `chatCommit` is `S`. Where an `M` was written, `S` is also its second parent. It is recorded all the same, so that describing the merge reads no commit object, and because no `M` is written for a chat with no changes of its own. `conflictPaths` are paths within the gadget.
- `mainlineMerge.conflictPaths` stays as it is, `GADGET_NAME/path`, since `updateChatFromMainline` returns the same list. A record with no `gadgets` was written before this part.
- **`BlueprintMerge` loses `messageCount`.** A proposal is one message. `splitCodeChangeByFile` goes, with the agent's `blueprintMergeThrough` and the frontend's continuation folding.
- A `BlueprintMerge` needs nothing new. The gadget's head before the merge is the declaration's `mergedCommit`, and the result is its `baseCommit`.

**9. The agent is given commits, not a diff.** Both summaries name the commits of the merge, say how to diff any two, and list the files by what the merge did with them. Their size does not depend on what is in the files.

- **The lists are one computation.** Call the three sides base, incoming and own. A blueprint merge has `baseCommit`, the release and `H`. A mainline merge has `B`, `H` and `S`. A file is listed if it differs from base to incoming, differs from own to incoming, and is not conflicted. It is "both changed" if it also differs from base to own, and "only the incoming side changed" otherwise. The differences come from comparing tree objects by id, through a new `AgentHooks` member, so no blob is read. Today's blueprint summary reads three whole file maps for the same answer.
- **The diff recipe.** `(await env.GIT.newWorktree("<to>")).diff("<from>")` in `executeCode` needs no worktree created in the chat (worktree-binding.d.ts:37 and :170). `createWorktree` remains the way to read a commit's files with `readFile` and `grep`.
- **A mainline merge** is delivered through the `observeUserChanges` channel, as now, with no task and no turn of its own: it is the user's chat. For each gadget:

    ```
    The user updated this chat with the changes accepted from other chats since it was last brought up to date. The files of `env.NOTES` in this chat are now the result of a three-way merge.

    The commits that were merged, and the result:
    * merged base, the version this chat was last based on: <B>
    * mainline, with the other chats' changes: <H>
    * this chat, before the update: <S>
    * the result, which this chat's files now start from: <M>

    To see what changed from one commit to another, run in `executeCode`:
      (await env.GIT.newWorktree("<to>")).diff("<from>")
    From merged base to mainline is what the other chats changed. From this chat before the update to the result is what the update did to this chat's files.

    Files with conflicts: ...
    Files that this chat and mainline both changed, merged with no conflict found: ...
    Files that only mainline changed: ...
    Files you read earlier that the update changed: ...
    ```

- **The last list keeps `readFile`'s promise** that the agent is told when a file it has read changes, which the diff used to keep. It holds the files the model has session knowledge of whose text differs across the re-root. It is bounded by the model's own reads, so it is not capped as the others are. `applyReplayedPin` drops that knowledge as it re-roots, so `editFile` requires a re-read as well.
- **A blueprint merge** keeps Part 1's summary and task, with the result added to its list of commits, the recipe beside the `createWorktree` advice, and the gadget's head taken from the declaration's `mergedCommit`. Diffing the result against the gadget before the merge gives exactly the diff that is no longer sent.

**10. Worktrees share the rule, not the mechanism.** A worktree also has commits that are not accepted yet, and the two were considered together.

- A worktree's unaccepted commits live on its record: `headCommit`, rolled back through `worktreeCommits.previousHead`. `commit()` deliberately leaves the pin alone.
- Routing a gadget's merge through that would give a gadget a second head and a second rollback path. Routing `commit()` through a re-root would mean a generation bump in the middle of an agent's step, and `pinBase` would still be needed for the squash at accept.
- What they now share is decision 1. plans/worktrees.md keeps `commit()` from moving the pin because replaying the epoch's rows on the new base would apply every edit twice. Under decision 1 it would not. That makes a simpler worktree possible later, and is not part of this change.

**11. What was recorded before this part still reads as it was written.**

- A `mainlineMerge` message with no `gadgets` carries the merge as its `change`. Every fold applies it as an ordinary change, the agent replays it as a diff, and it cannot be reverted.
- A pin that such a merge advanced has a `mergedCommit` that is a descendant of its `baseCommit`. No declaration records the advance. Accept takes `mergedCommit` as the parent (decision 5, step 3). A revert never touches it, unless it covers a later update of the new form, and then it puts back what that update's record says the pin had (decision 6).
- Nothing reads `messageCount`. A blueprint proposal exists only on this branch, so there is no log to honour.
- A commit that this branch wrote before decision 12, with a release as its second parent and no mark, is read as having merged no release. A blueprint published from such a gadget would not name the release it was built on. Applying a blueprint to it is unaffected, since the merge base comes from ancestry and not from the mark. No deployment holds such a commit.

**12. A commit that merges a blueprint release says so.** It carries a header naming the release, after `committer`:

```
tree <tree>
parent <H>
parent <R>
author …
committer …
blueprint-release <R>

Merge blueprint: Notes v3
```

A commit merged a release if, and only if, it has that header and the commit named is one of its parents other than the first. Every other parent is something else: today a chat's snapshot (decision 3), and later whatever else comes to be merged. Nothing is assumed about a parent that is not marked.

- **Three places write the mark**, and they are the three that give a commit a release for a parent: `initializeFromBlueprint` on `i = [e, R]`, `applyBlueprint` on `M = [H, R]`, and `mergeChanges` where it adds a release (decision 5). `blueprint-release.ts` owns the header's name: one function there builds the header for a release, and one reads the releases a commit merged.
- **`releasesMergedSince` reads the marks** (overseer.ts:7586). It is the one reader of parents in the backend that took a parent for a release. From the gadget's head it walks every parent that is not a marked release, stops at any commit in the history of `since`, and collects the marked releases. The walk leaves the first-parent chain because a mark can: when a blueprint proposal is brought up to date before it is accepted, the commit that merged the release is reached through the chat's snapshot. A release's own history is never entered.
- **The order of a release's parents** is the order of that walk, taking a commit's first parent's history before its other parents' and those before the commit itself: oldest first, as Part 1 has it. The two filters that follow are Part 1's.
- **Every commit is written by `encodeGitCommit`.** `GitCommit` gains optional extra headers, written after `committer` in the order given, and a reader beside `parseGitCommitRefs` returns a named header's values. `GitStore`'s commit writer encodes with it and stores the object itself, where it called isomorphic-git's `writeCommit`, which cannot write a header. The two already yield the same id for the same commit (Part 1, commit 1), so no id changes. This is one more step in replacing isomorphic-git.
- **Nothing a user types can write the mark.** A message cannot reach the headers. A name or an email could: isomorphic-git writes them into the `author` and `committer` lines as given, so a display name holding a line break adds header lines today. `encodeGitCommit` refuses such a name. So that an accept does not start failing for one, `commitIdentityForAuthor` drops the characters a signature cannot hold, as `encodeReleaseCommit` does. A forged mark on the commit of an update from mainline would claim the chat's snapshot as a release. The next publish would then give a public release a private commit for a parent, and ship that commit's message and author in its pack, which is what Part 1's decision 1 is there to prevent.
- **No pack can bring a marked commit in.** Pack validation takes a commit only in the exact form of a release (`COMMIT_SHAPE`, blueprint-release.ts:199), which has no room for another header. A release never carries the mark: the commits that merged its upstreams are the publisher's own, and its parents say what they found.
- **What git makes of the header**, tried with git 2.43:
    - It is accepted by `fsck --strict`, by a push to a repository with `receive.fsckObjects`, by a clone with `fetch.fsckObjects`, by `index-pack --strict` and by a bundle, and it arrives intact through each. It has to follow `committer`: ahead of `author`, `hash-object` refuses the commit.
    - `commit --amend` keeps it. `rebase`, `cherry-pick` and `fast-export` drop it, and so would anything that rewrites history through them. The reading rule already makes a copy that lost its release parent mean nothing.
    - `git log` does not show it. `cat-file -p` and `log --format=raw` do.
    - Other implementations were not tried. A commit travels as its bytes, so one that drops an unknown header on the way would also change the commit's id.
- **Why a header.** It is where git keeps the facts about a commit that tools read, as `encoding`, `mergetag` and `gpgsig` are, and no text that anyone types is written near it. Three alternatives were set aside:
    - **A trailer in the message.** It would survive a rebase and show in `git log`. But titles are written into messages, so every writer of a message would have to keep a title from adding one.
    - **Telling a release from a gadget's own commit by ancestry**, such as whether the gadget's root is among its ancestors. That filters out what is known not to be a release, so everything it does not think of is taken for one.
    - **A list on the gadget's record.** History would no longer say what it merged, and the list would need its own handling wherever a head moves or a gadget is copied.

**13. What a chat proposes is read from its state, not from its changes.** A chat has something to accept exactly when it holds a pin, a gadget or binding edge pending in it, or a `blueprintMerges` entry on a message that is neither merged nor reverted.

- **A merge commit can be the whole proposal.** After a merge, and until someone edits, the chat's pin at `M` is all there is: the re-root dropped every earlier change (decision 1), and the message that records it has none.
- **`mergeChanges` asked the changes.** Its test for "nothing to merge" (overseer.ts:3580) goes through `getProposedChanges`, which folds the log's batches, and for a compacted prefix reports one only if the checkpoint holds a `proposedChange` or a pending record exists (overseer.ts:5740). A chat whose merge lies under a compaction boundary has neither. Accept would return `merged` and leave the gadget's head where it was. Part 1's scan of the log for `blueprintMerges` entries covers a blueprint proposal. Nothing covers an update from mainline.
- **It now asks what `proposedChangeWorkpieceIds` asks**, which is how the UI already decides that a chat has changes to accept: pins and pending records, to which accept adds the surviving `blueprintMerges` entries it already collects. `getProposedChanges` and `#hasPendingStructure` have no other caller and are deleted.
- **A pin is enough because a pin is always declared.** Once accept has swept the chat's live rows into a message, a pin exists only while a surviving message of the epoch declares it, and that message was a proposed batch. So before a compaction the two tests agree. They differ on a chat whose surviving messages propose nothing: one that only created a worktree, or whose pending gadget was since removed. Accept wrote an empty merge message for such a chat and now writes none.
- **A checkpoint's `proposedChange` is content and nothing else.** It is what replay applies over the checkpoint's pins. It is absent when the composition leaves nothing (decision 1), and no reader takes its absence to mean that nothing is proposed.

**14. A merge that needs a file too large to hold is refused.** Where both sides changed a file, the merge reads three versions of it and writes a fourth. If any of the four is too large, the whole merge fails. Nothing is written: no commit, no message, no pin moved, and for a blueprint no chat.

- **Too large** is a text over `MAX_FILE_TEXT_LENGTH` or a blob over `MAX_GIT_OBJECT_SIZE`. The first is the most that a chat's file may hold. An edit that leaves a file longer is refused, so the conflicts in such a file could not be resolved one at a time. The second is the most that the git cache reads back (git-cache.ts:83).
- **The result can be too large where neither side is.** A conflicted file holds both sides and the base. That is the likely case. A side too large for the git cache is possible but rare: a file near the text limit, mostly of characters that take three bytes.
- **A file that only one side changed is not checked.** It is taken whole, and is no larger in the result than where it came from. Neither is one that one side changed and the other deleted, which keeps the changed version.
- **Keeping one side was considered**, as the form a delete-versus-modify conflict takes, and set aside. It would drop the other side's changes to the file while recording the merge as made, so no later update would bring them back. And where that was the only file, the result would be the gadget's own files, which reads as nothing left to do.
- `threeWayMerge` reports such files in place of merging them, and both callers throw an error that names them and says what to do: make the file smaller, or undo this side's changes to it, after which only one side has changed it.
- **Accepted cost:** until the user does that, a stale chat cannot be brought up to date, and so cannot be accepted, and a gadget cannot take the release. Better support for large files is separate work.
- A file listed as conflicted that holds no markers is therefore still one thing only, deleted by one side and changed by the other, as both summaries tell the agent (decision 9).

## What Part 1 says that no longer holds

- **"The model in one picture":** every parent but the first is still "merged from elsewhere", but elsewhere is no longer always a blueprint. A gadget's own history is still its first-parent chain.
- **Decision 2, and Publish in commit 6:** the releases merged into the source gadget are not "found structurally as the non-first parents along the gadget's first-parent chain". They are found by their marks, on a walk that leaves that chain (decision 12).
- **Decision 6:** the commit `Instantiate blueprint: <title>` gains the header. Accepting a blueprint update no longer writes `[head, R]`. `applyBlueprint` wrote it, as `M`, and accept moves the head to it or commits on top of it.
- **Decision 9:** step 3 records no change row. The kinds are decided by the result, not by comparing each side with the base, and the empty merge is gone. A proposal with a conflict is a `merge` and gets its turn, even if no file changes (decision 7).
- **Decision 10:** `messageCount` is gone, and so is the split in commit 7 and its replay in commit 8. "A gadget whose release is new to its history is committed even if its content equals its head" still holds, but the commit is `M`.
- **Decision 11:** the summary names the result. The conflict-marker check can no longer rely on the chat's change holding every conflicted file. A mainline merge is rendered as a summary too.
- **Change inventory, pin validation:** tolerance is two first-parent steps, not one (see below).
- **`blueprintMerges` in api.ts:** "unlike a `mainlineMerge` batch it can be reverted, since it advances no pin". Both advance a pin now, and both can be reverted.
- **Decision 10, on compaction:** "`mergeChanges` looks for surviving entries in the log itself before deciding there is nothing to merge", because a checkpoint keeps no trace of a proposal that changes no file. That is now true of every merge, and the test no longer goes by changes at all (decision 13).
- **Risks, "a large file that differs throughout":** resolved. Nothing diffs a merge.
- **Risks, "a conflict in a very large file":** such a merge is now refused (decision 14).

## Change inventory by area

### workshop-shared

Every addition is doc-commented.

- `ChatGadgetPinRecord` (decision 1), on a `changes` message's `pins`.
- `mainlineMerge.gadgets` and its entry type. `BlueprintMerge.messageCount` removed (decision 8).
- `Overseer.listChangedPaths(fromCommit, toCommit)`: the paths whose entry differs between two commits' trees, added and removed ones included, in sorted order. It reads tree objects only. Denied to the "use" role, as `listTree` is.
- The epoch-change helper in code-change.ts (decision 1).
- Docs rewritten: `ChatGadgetPin.baseCommit` ("immutable for the life of the pin" becomes "until a later declaration re-roots the gadget"), `ChatGadgetPinState.mergedCommit`, `ChatCodeBase.generation` (an update from mainline now bumps it, destructively), `updateChatFromMainline`, `revertChanges`, `mergeChanges`, `mainlineMerge`, `blueprintMerges`.

### workshop-backend: overseer and git

- **`declaredPinGadgets`** returns each gadget's last surviving declaration, not just the set of gadgets. `undeclaredMetaPins` writes `mergedCommit` where it differs from `baseCommit`.
- **`materializeChatChanges`** takes declarations from its caller, for the message that `updateChatFromMainline` writes ahead of the metadata.
- **`updateChatFromMainline`:** up to the revalidation it is as now, less the `diffFiles`. Then it writes `S` and `M` for each stale gadget. Its synchronous tail writes the message, moves the pins, deletes the chat's rows and bumps the generation with no `prior`.
- **`applyBlueprint`:** writes `M`, creates the chat pinned at `{baseCommit: M, mergedCommit: H}`, and materializes one message, which stamps the pin. The kind is decided per decision 7.
- **`mergeChanges`:** decisions 5 and 13. `getProposedChanges` and `#hasPendingStructure` are deleted, and `CompactionCheckpoint.proposedChange`'s comment, which sends its reader to them, is rewritten.
- **`revertChanges`:** decision 6.
- **`threeWayMerge`** (git-store.ts:594) reports the files it could not merge for their size, and both callers refuse (decision 14).
- **Pin validation** in `submitCodeChange` (overseer.ts:2890) tolerates the head, its first parent, and that commit's first parent. A client that raced one accept declares the head from before it, which is two steps back when the accept wrote `C = [M]`. A stale pin is harmless: the accept gate catches it.
- **The mark** (decision 12):
    - git-codec.ts: extra headers on `GitCommit`, and the reader of a named header. The encoder refuses a header named as one of git's own, and a name or value that would not parse back.
    - git-store.ts: `WriteCommitOptions` gains the headers, and the commit writer goes through `encodeGitCommit`. `commitIdentityForAuthor` drops what a signature cannot hold.
    - blueprint-release.ts: the header for a release, and the releases a commit merged.
    - overseer.ts: `initializeFromBlueprint` and `mergeChanges` mark what they write, and `releasesMergedSince` reads marks. The comments that call every other parent a release change with it (overseer.ts:7584, and `initializeFromBlueprint`'s).
- **git-cache.ts:** the tree comparison behind `listChangedPaths` and the agent's hook, beside `listTree`. It skips a subtree whose id is the same on both sides.
- **git-store.ts:** the header says that a chat's edits never leave dangling objects. A chat's merges now do, when the chat is discarded. Their roots are already on its list: the pin declarations in chat logs.

### workshop-backend: agent and compaction

- `buildCompactionState` composes through the helper. A checkpoint's `pins` carry `mergedCommit`.
- `applyReplayedPin`: on a re-root, drops session knowledge of the files whose text changed, and reports them for the summary.
- `formatBlueprintProposal`: decision 9. Its `msg.change === undefined` branch and the split handling go.
- A new renderer for a `mainlineMerge` with `gadgets`, sharing the path lists with the above.
- `AgentHooks` gains the changed-paths read.

### Frontend

Load the `frontend-conventions` skill before starting.

- `computeChatEpochChanges` composes through the helper.
- **The Changes list.** The code view assumes that only paths the OT client has touched can differ from the review base (WorkpieceCodeInterface.tsx:977). Where a pin's `baseCommit` is not its `mergedCommit`, the list adds `listChangedPaths(mergedCommit, baseCommit)`, cached by the pair of commits. A tree as the client holds it carries no ids, which is why this is an RPC.
- **The conflict-marker check.** A conflicted file that nobody has edited since the merge is not in the OT client's content. The check reads it from the pin's `baseCommit`, which makes the check asynchronous. It takes gadget ids and paths from `mainlineMerge.gadgets` and from `blueprintMerges`, and keeps today's path for a record with no `gadgets`.
- **The proposal notice** tells whether files change by `kind`, not by whether the message has a `change`. The continuation folding goes.
- **The mainline row** enables its discard button for a record with `gadgets`.
- **A refused update** (decision 14). `handleUpdateFromMainline` shows a generic toast for any failure (ChatInterface.tsx:4267). It shows what the server says, as the discard and rewind handlers beside it do, since the message names the file. The blueprint dialog already does.

## Commit series

The same rules as Part 1: kernel commits first and apart from the UI, each commit passing the tests of the packages it modifies and only those, and no shims in between. The frontend stops compiling at commit 4, where `messageCount` goes, and is fixed in commit 6.

**Status: commits 1 to 8 are implemented.**

Commit 1 comes first because commit 3 writes the first two-parent commit that merged no release. From then on a reader that took every other parent for one would publish a chat's snapshot.

### 1. `workshop-backend`: a commit that merges a blueprint release says so

Decision 12, with no change to which commits are written.

- Extra headers in `encodeGitCommit` and their reader. `GitStore`'s commit writer goes through the encoder, and `commitIdentityForAuthor` drops what a signature cannot hold.
- The header for a release and its reader, in `blueprint-release.ts`.
- `initializeFromBlueprint` and `mergeChanges` mark the commits that they give a release for a parent.
- `releasesMergedSince` reads marks, on the walk decision 12 describes.
- Tests, in `git-codec.test.ts`, `git-store.test.ts`, `blueprint-release.test.ts` and `blueprints.test.ts`:
    - a commit with a header round-trips, real `git fsck --strict` accepts it, and the encoder refuses a header named `parent` or a value holding a line break;
    - `GitStore` writes the same commit ids as before for the same inputs, and reads a marked commit back through every reader it has (`readCommitObject`, `readCommitLog`, `readCommitFiles`);
    - a header that names the first parent, or a commit that is no parent, marks nothing;
    - a display name holding a line break and the header's text yields a commit without the header, and so does a chat title holding one;
    - pack validation refuses a commit that carries the header;
    - an instantiated gadget's head and an agent-created gadget's first commit carry the mark, and Bob's release is still `[B0, A2]`;
    - a commit with a second parent and no mark contributes nothing to a release's parents;
    - a release merged off the first-parent chain is found: over a hand-built `M2 = [H2, S]` whose `S` has `[H, R]` for its parent, the next release names `R`;
    - a release marked in the history of `since` is not named again.

### 2. `workshop-shared`, `workshop-backend`: a pin declaration re-roots its gadget

- `ChatGadgetPinRecord`, the helper, and its use in `buildCompactionState`. The type of `mainlineMerge.gadgets`, which a revert reads.
- `declaredPinGadgets` as a map, `undeclaredMetaPins` with `mergedCommit`.
- `mergeChanges` per decisions 5 and 13, `revertChanges` per decision 6, and the wider pin tolerance.
- `applyReplayedPin` drops stale session knowledge.
- Nothing writes a re-root yet. Tests build the logs by hand:
    - every fold agrees on the content after a re-root, and after a revert of one;
    - a checkpoint taken after a re-root replays to the same content, and one taken before it does too;
    - accept makes the merge commit the head when nothing was edited, and commits on top of it when something was;
    - the same accept after a compaction checkpoint covers the re-root, which leaves the checkpoint no `proposedChange`: the head still moves to the merge commit;
    - a chat that only created a worktree accepts as a no-op, and writes no merge message;
    - accept still adds a release that the parent's history lacks, and marks the commit;
    - a pin advanced by a merge from before this part accepts as it did;
    - reverting a re-root over such a pin leaves `mergedCommit` where the old merge put it, not at the declaration's commit, and reverting two re-roots at once restores what the earlier one's record says;
    - a pin declared two first-parent steps behind the head is taken, and three is refused.

### 3. `workshop-shared`, `workshop-backend`: an update from mainline commits its merge

- The tree comparison in git-cache.ts, and the `AgentHooks` member. `threeWayMerge` reports files too large to merge.
- `updateChatFromMainline` as above. The agent's summary of it.
- Tests, in the `updateChatFromMainline` suite of `chat-changes.test.ts` and beside the blueprint replay tests:
    - the message has no `change`, declares `{M, H}` and names `B` and `S`; `M`'s parents are `[H, S]`, `S`'s tree is the chat's files before, and its parent is the commit the pin was at;
    - the generation is bumped with no `prior`, and the message is delivered ahead of the metadata that carries the bump;
    - a chat with no changes of its own pins at `H` and writes no commit;
    - a second update's snapshot has the first update's merge commit for its parent;
    - reverting the update restores the pin, and the chat is stale again;
    - a chat that a merge from before this part brought up to date, then updated again and that update reverted, takes at its next update a change that mainline made in between. Merged against the commit the chat was first pinned at, it would keep its stale copy and report no conflict;
    - an update of a chat that holds a blueprint proposal keeps the proposal: the release is in the new merge's history, accepting adds no parent, and the gadget follows the blueprint;
    - a blueprint published from a gadget after that accept names the release, and one published after an ordinary update names nothing new: its parents are releases only, and its pack holds no commit of the gadget's own;
    - the summary's text for a clean and a conflicted merge, that its size does not grow with the files', and that a file the agent had read is named and must be read again before `editFile` takes it;
    - a `mainlineMerge` with no `gadgets` replays as a diff and still refuses a revert;
    - an update is refused, in an error naming the file, where both sides changed a file and the merged text is over the limit, or one side's blob is. The chat is as it was: same pins, same generation, no new message. The same file changed on one side only merges.

### 4. `workshop-shared`, `workshop-backend`: a blueprint is applied as a merge commit

- `applyBlueprint` as above, kinds per decision 7, refusing per decision 14. `messageCount`, `splitCodeChangeByFile` and `blueprintMergeThrough` are deleted.
- `formatBlueprintProposal` per decision 9.
- Tests, in `blueprints.test.ts`:
    - each kind writes `M = [H, R]`, marked, and one message with no `change`; identical changes on both sides are a `follow`;
    - a release that only deletes a file the gadget changed is a `merge` that changes no file: it lists the conflict and starts the turn;
    - an apply that would need a file too large is refused and creates no chat;
    - accepting with no edits makes `M` the head, and accepting after the agent resolves a conflict yields `[M]`, whose first parent's parents are `[H, R]`;
    - Bob's next release still finds the release that his gadget merged, through `M`;
    - reverting the proposal unpins the gadget and leaves no trace at accept;
    - the summary names the result, and is the same for a one-line file and a very large one. The test of a split merge is deleted;
    - applying one bundled blueprint to a gadget made from another, which took 107 seconds, completes in the time of the line merge.

### 5. `workshop-shared`, `workshop-backend`: `listChangedPaths`

The RPC over commit 3's tree comparison, with its "use"-role denial. Tests: added, removed and changed paths, nested directories, a mode change, and identical subtrees not being read.

### 6. `workshop-frontend`

The changes under Frontend. Tests:

- an OT client rebuilds to the right content when a pin moves, with the message arriving first;
- the Changes list shows a file that only the merge changed;
- the accept check finds a marker in a conflicted file that was never edited, and none once it is resolved;
- the notice for each kind with no `change` on the message, a `merge` that changes no file included;
- the mainline row can be discarded;
- a refused update shows the server's message.

### 7. `integration-tests`

- `workshop-changes.test.ts`: the stale-chat test reads the merge back through the preview, resolves it and accepts, and then reverts an update instead of being refused.
- `workshop-blueprints.test.ts`: the end-to-end apply reads the merge from the pin's commit, and Carol's history lists `M`. Bob's gadget takes an update from mainline before he publishes, and his release's parents are still `[B0, A2]`.
- `workshop-use-role.test.ts`: `listChangedPaths` joins the denied methods.

### 8. Docs

`docs/blueprints.md`: what an update writes and when, the mark, and its statement that a release's upstream parents are "found structurally, as the non-first parents along the gadget's first-parent chain". Header comments change with the code they describe.

## Risks

- **Broken and unfinished files enter history.** An accepted `M` is on the gadget's first-parent chain, and where conflicts were resolved afterwards it is a commit whose files are broken. Its second parent `S` is whatever the chat held when the update was run, finished or not. Neither is ever a merge base for a blueprint: a release has no gadget commit among its parents. A history view that follows first parents shows `M` and not `S`.
- **A release must never name a gadget's own commit.** A release's parents are published, with the message and author of every commit in their history (Part 1, decision 1). Before this part every other parent in a gadget's history was a release. Now some are chat snapshots, and what keeps them out of a release is the mark and nothing else (decision 12). The mark can be written only by the three places that merge a release, as long as every commit is written by the one encoder, which lets no name or email add a header line. Commit 3's publish test is the check on the whole of it.
- **A rewrite drops the mark.** Nothing rewrites a gadget's commits today. But `git rebase` and `git cherry-pick` drop a header they do not know, so a lineage that was one day pushed to a real remote, rewritten there and pulled back would have lost its marks. The next release published from the gadget would then name no upstream. Updating the gadget itself would be unaffected, since a merge base comes from ancestry.
- **The mark is not visible in `git log`**, nor in `env.GIT.readCommit`, whose result has no field for it. A history view that wants to say "merged blueprint X" reads the header through the codec.
- **A merge refused for a file's size** (decision 14). It takes a file of more than about a third of `MAX_FILE_TEXT_LENGTH`, some 170K characters, in conflict throughout, or a larger one with less in conflict. Hand-written source is rarely that long. A built bundle can be, and the bundled blueprints ship those (Part 1, Risks). A gadget that customized one cannot take a release that rebuilt it until the gadget's own edits to the file are undone. The same merge today yields a file that takes no edit unless the edit brings it back under the limit.
- **Unacknowledged keystrokes at an update.** Decision 4.
- **Delivery order.** Decision 4 depends on a client seeing the message before the metadata. Both leave the server in the order they were written, as a revert's do. Commit 6's first test is what holds the client to it.
- **More commits.** Every update of a chat with changes of its own writes `S` and `M`. Accepted, both stay in the gadget's history, where the ancestry walks (`isAncestor`, `mergeBases`) pass through them. Discarded, they dangle. There is no GC, and they are small: they share every blob that did not change.

## Future work

- **A content-preserving re-root**, which would keep a collaborator's keystrokes through an update. It needs the OT client to reset one gadget while keeping the rest.
- **Moving a worktree's pin at `commit()`** (decision 10).
- **A "what the update changed" view** in the UI, from `S` and `M`.

