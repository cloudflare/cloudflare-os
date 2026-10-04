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
- Storage: `GadgetRecord.upstream`, `BlueprintGadgetRecord.releases`. Both optional, so neither needs a migration. One was added afterwards all the same, as schema version 5, to name the blueprint of gadgets that predate `upstream` (see Backfilling `upstream` below).

### workshop-backend: chat and agent

- `applyBlueprint` body, modelled on `updateChatFromMainline`: same revalidation after awaits, same delivery as a change row plus a materialized message. It also creates the chat, which today only `newChat` does, and only from a user message, and for a merge it starts the agent turn.
- `mergeChanges`: `upstream` and extra parents from the log, the commit-if-new-to-history rule, the empty root for a pending gadget.
- agent.ts: the merge summary and task in replay, the prompt section, the release on `createGadget`'s recorded output.

### Frontend

Load the `frontend-conventions` skill before starting.

- **"Update from blueprint…"** in the gadget menu: a picker (followed blueprint preselected; the user's own, library and featured blueprints; a pasted link) and the unrelated-blueprint warning with its confirm step. It passes the user's selected model.
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

- "Update from blueprint…" in the gadget menu, with the picker and the unrelated-blueprint confirmation. It passes the selected model, and on `proposed` it opens the new chat. It says so when the outcome is `upToDate` or `baseUnavailable`, and offers a retry when the call fails because the gadget changed meanwhile.
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

Added after the commit series. A gadget made from a blueprint before this plan has no `upstream`, so the picker has no blueprint to start on, and nothing in the gadget's history names one.

- **What is recovered.** For a gadget an agent created, the `createGadget` tool call in the chat log names the blueprint (`input.blueprintId`) and the gadget (`output.gadgetId`). The storage migration `migrateToBlueprintUpstreams` (version 4 to 5) sets `upstream = {blueprintId}` on each such gadget that has no `upstream`.
- **What is not.** The release the gadget took. `GadgetUpstream.commitId` becomes optional, and its absence means the release is unknown. Such a gadget is treated as one with no upstream everywhere but in the picker: no "Update available", and decision 8's last row applies, with its warning, even when the blueprint applied is the one named. Accepting that proposal records the release. Recovering the release from the creation's `changes` message, or taking the gadget's first commit for it, was considered and set aside as not worth the code: the first is exact only when the agent wrote nothing else in the step, and the second announces an update on every such gadget.
- **Bounded.** The migration runs synchronously in the constructor. It reads no chat in a workspace with no gadget that lacks an `upstream`, which many are: one chat working on external resources, and no gadget at all. Otherwise it reads at most 1000 messages per workspace, divided between the chats and taken from the start of each, where creations mostly are.
- **Not covered.** Gadgets instantiated through the UI, which left no record of their blueprint outside product analytics, and gadgets whose creating chat was deleted. Both keep the manual path: pick the blueprint, and confirm the warning.

## Risks

- **Bundled formats merge poorly, and that is accepted.** They ship esbuild output only until the Gadgets environment can bundle for itself, after which they ship as source. For the same reason their releases are not chained (decision 14). Gadgets made from them are customized by editing the built files, so an update to one may conflict heavily. Merge quality for them is not a goal in the meantime. The release that switches a bundled blueprint from built output to source will replace `client.js` and `server.js` wholesale: gadgets customized against the built files get one noisy update, with their edits surfacing as delete-versus-modify conflicts for the agent to port over.
- **Wrong assumed base.** Covered under decision 8. The mitigation is review, not correctness. A merge over an assumed base gets the agent's review as well as the user's. A fast-forward over one replaces the gadget's files with the blueprint's and runs no agent, so there the only reviewer is the user, prompted by the notice's warning.
- **A conflict in a very large file.** A conflicted file holds both sides and the base, so its merged text can exceed `MAX_FILE_TEXT_LENGTH`, which the files that went into it obey. What the edit tools and a later publish make of such a file has not been tested. A mainline merge has the same exposure, but built bundles make it likelier here.
- **A large file that differs throughout. Open: found while testing commit 9, and not addressed.** `applyBlueprint` records its result as a minimal character-level change (`diffFiles`), as a mainline merge does, and that diff has no bound on the time it takes. Where the release's version of a file has little in common with the gadget's, it is nearly the whole cost of the call. Applying the bundled Sheets blueprint to a gadget just made from the bundled Docs one, with `allowUnrelated`, took 107 seconds in the local runtime, as a fast-forward. Their `client.js` files are 76 KB and 137 KB, and the diff of those two alone takes 88 seconds in Node. The workspace answers nothing meanwhile, and how a deployed Durable Object's CPU limit treats a call that long has not been tried. An ordinary update is not affected: scattered edits to the 137 KB file diff in 45 ms. What is affected is a blueprint applied to a gadget of another format, since every gadget has a `client.js`, and a release whose build output changed throughout. Recording a file that the merge took whole from the release as a `set`, as the agent's `writeFile` does, would cover the fast-forward. A merge that blends two versions with little in common would still be diffed.
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

