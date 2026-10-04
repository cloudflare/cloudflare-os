# Blueprints

Blueprints let a user share a gadget's source code so that others can create their own gadget instances from it. A blueprint captures the code but not the chat history, SQLite storage, or credentials. Each gadget created from a blueprint gets its own bindings, storage, and chat history.

This is analogous to a template: the blueprint author publishes a reusable gadget design, and anyone with the link can stamp out their own copy, pointing it at their own resources.

Unlike a copy made from a template, a gadget stays connected to the blueprint it was made from. When the blueprint is published again, the gadget can take the new version as an update, merged with whatever was changed in the gadget meanwhile, and it can switch to another blueprint altogether. See [Updating a Gadget from a Blueprint](#updating-a-gadget-from-a-blueprint).

## Key Properties

- A single gadget can have **multiple blueprints**, potentially at different code versions (e.g. a "stable" and a "latest" blueprint of the same gadget).
- Each blueprint has a **128-bit random hex ID**, generated server-side. Blueprints bundled with a deployment are the exception: they carry stable, readable IDs (see [Output Formats and Bundled Blueprints](#output-formats-and-bundled-blueprints)).
- Blueprints are shared via link: `https://<host>/blueprint/<blueprint-id>` (for example, a random hex ID or a bundled ID such as `format.document`).
- Anyone with the link can **view** the blueprint's metadata (title, description, author, required bindings) without authenticating. **Creating a gadget** from a blueprint requires authentication.
- A blueprint is always owned by the gadget's owner, regardless of which collaborator creates it. Bundled blueprints have no owning user at all.
- The blueprint author can **update** a blueprint to reflect newer code, incrementing its version number. Each version is a git commit, called a **release**, and is stored under its own key. Earlier releases are retained, so an instantiation that read the blueprint's metadata just before an update still finds the code that metadata describes.
- A gadget made from a blueprint **follows** it. The gadget can take a later release as an update, or switch to following a different blueprint. Nothing is applied automatically: an update is a proposal that the user previews and accepts.
- Blueprints can be exported to a `.gadget` file and imported into a different Workshop instance.

## What a Blueprint Captures

A blueprint captures:

- **Source code** -- the files of the gadget's committed code at the moment of publishing, as a git commit made for the purpose (see [Releases](#releases)). The gadget's own commit history is not included.
- **Binding requirements** -- a description of each named binding the gadget uses, including what type of connection is needed (gatekeeper, AI model, or agent spawner) and how to configure it. The blueprint does not include any credentials or live connections.
- **Metadata** -- title, description, optional screenshot metadata, author info, version number, and timestamps.

A blueprint does **not** capture:

- The gadget's SQLite storage contents.
- AI chat history, or the gadget's commit history. Its commit messages hold chat titles and its authors include collaborators, neither of which the publisher chose to share.
- Live connections or credentials. Only the *shape* of each binding (its type, gatekeeper name, URL pattern, etc.) is recorded.

## Binding Annotations

Before creating a blueprint, the author can optionally add **blueprint annotations** for the gadget's named bindings. This user-provided metadata controls how each required connection appears to someone creating a gadget from the blueprint:

- **Name** -- a friendly connection name shown to blueprint consumers. It defaults to the current resource title, while the binding name remains the stable key used by code.
- **Description** -- optional helper text that tells the blueprint consumer what kind of resource to connect.
- **Suggest value** -- optionally includes the specific resource URL or model name as a suggestion. This is useful when the blueprint author intends all instances to use the same resource, but it remains a suggestion rather than a requirement.

All named bindings are included in the blueprint. Annotations are configured in the **Blueprint** modal, opened with **Publish as blueprint…** in the gadget editor header's Blueprints menu. The annotation is stored on the `GatekeeperRecord` as the `blueprintAnnotation` field.

## Binding Types

Blueprints support three types of bindings, matching the three types of gatekeepers:

1. **Gatekeeper** (`type: "gatekeeper"`) -- an external resource connection (e.g. Google Drive, a REST API). The blueprint records the gatekeeper adapter name and a URL pattern describing what kind of resource is expected. When instantiating, the user picks a connected account and configures a matching resource.

2. **AI Model** (`type: "aiModel"`) -- a language model binding. The blueprint may suggest a specific provider/model. When instantiating, the user picks from their own configured models.

3. **Agent Spawner** (`type: "agentSpawner"`) -- an agent spawner binding. The blueprint carries over the spawner configuration (prompt types, env restrictions) from the source gadget. The user only needs to choose which model the spawner should use (or no model).

## Releases

Gadget code is stored as git commits in the workspace's Overseer (see the header of `git-store.ts`), and a blueprint's code is a git commit too. `blueprint-release.ts` defines the format: the commit a blueprint version is, the packfile it ships in, and the check that decides what such a pack may bring into a workspace. It is pure computation over byte arrays and an object lookup, so the same code serves the Overseer and the bundled-blueprint installer.

### Lineage

Two rules shape every commit that publishing, instantiating and updating write:

- **A commit's first parent is its own previous state. Every other parent is something merged from elsewhere.** A gadget's own history is therefore its first-parent chain, and so is a blueprint's sequence of releases. Such a chain is called a *lineage*.
- **A commit with merged-in parents always has a first parent of its own lineage.** Where none exists yet (a gadget being instantiated, or the first release of a blueprint built on another), an empty-tree root commit is written to be it.

Each row below is one lineage, oldest commit first. Brackets list a merge commit's parents.

```
Alice's blueprint    A1 ── A2 ── A3
Bob's gadget         e ── i ── b1 ── b2          i  = [e, A2]
Bob's blueprint      B0 ── B1                    B1 = [B0, A2], with b2's tree
Carol's gadget       e' ── i' ── c1 ── m         i' = [e', A3],  m = [c1, B1]
```

Bob instantiated Alice's A2, made changes, and published B1. Carol instantiated Alice's A3, made a change (c1), then switched to Bob's blueprint. What c1 and B1 have in common is A2, found by walking commit objects. `m` records the merge, so Carol's next update from Bob finds its base the same way.

### Release commits

Publishing writes a release commit (`mintBlueprintRelease` in `overseer.ts`):

- **Tree** -- the tree of the source gadget's head.
- **Author and committer** -- the workspace owner, which is the identity `BlueprintMetadata.author` already publishes, at the time of publishing.
- **Message** -- `Release <version>: <title>`.
- **Parents** -- first the blueprint's previous release, then each release of another blueprint that was merged into the source gadget since the last publish (or ever, for a first release), in the order the gadget merged them. Those are found structurally, as the non-first parents along the gadget's first-parent chain. One that is already in the history of the previous release, or of another one listed, is left out.

An original blueprint's first release has no parents. A blueprint built on another has upstream parents from its first release on, so that release needs a first parent of its own: an empty root, which is written as a release too (`Release 0: <title>`, of the empty tree). B0 above is one.

Publishing a tree that the previous release already holds, with nothing newly merged, writes nothing, and the version stays as it is. A release that merged something new is written even if its tree is unchanged, since its parents are what record the merge.

A release commit does not name its blueprint. A blueprint ID is a bearer share link, and release commits travel on into the packs of blueprints derived from them. The link between the two is `BlueprintMetadata.commitId`, which names a blueprint's current release. `BlueprintMetadata.version` remains the counter that people see.

### Packs

A release is stored as a git packfile (`buildReleasePack`) that carries three things:

1. **The release's whole tree.**
2. **Every ancestor commit, without its tree.** These are a few hundred bytes each, and make the release graph walkable by whoever holds the pack.
3. **Fork-point trees.** For each *other* lineage in the release's ancestry, the whole tree of that lineage's newest release there (A2 in B1's pack).

Commits alone are enough to *find* the release two histories have in common, but a three-way merge needs that release's files. In the picture, Carol holds A3's tree but only A2's commit, so without A2's tree in Bob's pack she could not switch. One tree per foreign lineage suffices because a lineage is a linear chain: the common release is the older of the two sides' newest releases in that lineage, and each side holds its own. The publisher holds a fork-point tree if it merged that release itself or a pack it merged carried the tree. One it does not wholly hold is left out, which costs only the ability to merge against it.

Fork-point trees travel in the pack, rather than being fetched when needed, because a commit ID does not locate content (R2 is keyed by blueprint ID), because deleting a blueprint would then break switches to the blueprints built on it, and because a `.gadget` file uploaded to another deployment would arrive without its fork point. Objects are content-addressed, so the tree costs only the blobs the derived blueprint changed.

The same release always packs to the same bytes.

### Validation

A pack arrives from an upload, or from storage that any uploader can write, so it is checked at the one place its objects enter a workspace: `readBlueprintRelease` in `blueprint-archive.ts`, which `OverseerImpl.loadBlueprint` calls before importing anything. `validateReleaseObjects` admits only what `blueprint-release.ts` could itself have written:

- The pack is at most 32 MiB, no object is larger than a file of the longest allowed text could encode to, and no delta refers to an object outside the pack. Object IDs are computed from content, never taken from the pack.
- The commit that `metadata.commitId` names is present, and so is every ancestor of it, up to 10,000 commits. Each is in the canonical form the encoder writes.
- The release's tree is complete. Any other commit's tree is either complete or absent.
- Trees hold only subtrees and mode `100644` blobs, under names `GitStore` can read back. Every blob is UTF-8 text within `MAX_FILE_TEXT_LENGTH`, at a path within `MAX_FILE_PATH_LENGTH`. This keeps every imported file readable and editable as a code change.
- Nothing else is in the pack.

Publishing runs the same check on what it is about to pack, so a blueprint that publishes always instantiates. Imported objects are stored with no record of any gatekeeper remote possessing them (`WorkspaceGitCache.importObjects`), so they grant no gatekeeper a read.

### Snapshot releases

Some content is nothing but its files: a blueprint stored before releases were commits, and one a deployment bundles. Its release is a *snapshot release* (`buildSnapshotRelease`): a parentless commit of those files with a fixed author, date and message. The commit depends on the files alone, so every workspace and every deployment derives the same commit ID from the same content, and finds that release in common with anyone else who did.

A blueprint stored before releases were commits has no `commitId` in its metadata. Its content is a gzip-compressed Yjs V2 state update of a document whose root map is filename -> `Y.Text`. Nothing rewrites it: it is converted to its snapshot release each time it is read. When such a blueprint is next published, its first release takes that snapshot release as first parent, so gadgets instantiated from the old content share lineage with the new. That release is written even if the files have not changed, since it is what moves the stored content to a pack.

## Storage Architecture

Blueprint data is stored in three places, with one-way propagation: Gadget DO -> User DO -> Workers KV.

1. **Gadget DO** (`blueprints` collection) -- the authoritative source. Stores `BlueprintGadgetRecord` including full metadata, the gadget commit that was last exported, the list of `releases` (each one's version, release commit and the gadget commit it was taken from), and a `dirty` flag for tracking propagation failures. The release commits and their trees live in the workspace's git object store.

2. **User DO** (`blueprints` collection) -- a denormalized copy for efficient listing. Stores `BlueprintUserRecord` with metadata and a reference to the source gadget. This allows a user to audit and manage their blueprints even if the source gadget has been deleted.

3. **Workers KV** (`BLUEPRINTS` namespace) -- the public-facing lookup store. Stores `BlueprintKvRecord` keyed by blueprint hex ID. This is what `PublicApi.getBlueprint()` reads from.

Blueprint **code content** is stored separately in an **R2 bucket** (`BLUEPRINT_CONTENT`), in one of two forms (`blueprintContentKey`):

- A release pack at `<blueprintId>/<commitId>`, for metadata that names its release commit. A release never changes, so neither does the object stored for it.
- A Yjs snapshot at `<blueprintId>/<version>`, for metadata that names none (see [Snapshot releases](#snapshot-releases)). Publishing no longer writes this form. Importing a version 1 `.gadget` archive still does, since an import stores the archive's content as it is.

When a blueprint is updated, earlier releases are retained. When a blueprint is deleted, everything under the `<blueprintId>/` prefix is deleted, which covers both forms.

The `dirty` flag handles propagation failures gracefully: it is set to `true` before propagation begins and cleared only after all writes succeed. If a failure leaves it set, the UI shows a warning with a "Retry" button. A retry rebuilds the pack of the release that was being published, not of the gadget's current code. (A record that was left dirty before releases were commits has no release to re-send, and has to be republished instead.)

## Explore

The Explore page (`/explore`) is a place where users can discover featured blueprints. Goal is to show users what is possible and to give them place to start.

Admins have the ability to "feature" blueprints. This is what determines what is on this page.

## Blueprints on home page

The home page has a blueprints tab which shows a list of blueprints that they have published plus what is in their library.

Users can pin blueprints to keep them at the top of the home Blueprints tab. Pinning a public blueprint that is not already in the user's library adds it to the library first, then pins it.

Library entries come in two forms:

- **Saved by reference** -- created by `addBlueprintToLibrary()`. The entry stores a cached copy of the blueprint's public metadata for list rendering, but the actual blueprint remains owned by the original publisher. Removing it only deletes your personal library entry.
- **Uploaded** -- created by `importBlueprint()` from a `.gadget` archive. This creates a new local blueprint ID on the current deployment, stores the archive's content in this deployment's R2/KV, and records it in your library with `uploaded: true`. Removing one of these entries deletes the imported blueprint content as well.

## Export / Import Format

Blueprints can be downloaded from `/blueprint/<id>` as `.gadget` files and uploaded from the home blueprints tab into another Workshop instance.

The `.gadget` format is a simple internal binary container:

- 8-byte magic number: `0xec2e2d3a2300e317`
- 4-byte format version (`1` or `2`)
- 4-byte JSON metadata length
- 8-byte raw content length
- JSON-encoded `BlueprintMetadata`
- Raw blueprint content bytes, exactly as stored in `BLUEPRINT_CONTENT`

The format version says which form the content takes:

- **Version 2** -- a release pack. The pack is not wrapped in gzip, since a packfile already compresses each object. The metadata must name the release commit (`commitId`).
- **Version 1** -- a gzip-compressed Yjs snapshot, the form content took before releases were commits. Any `commitId` in the metadata is dropped on import, since everything that reads the content back goes by whether the metadata names one.

A download serves whatever is stored, so a blueprint last published before releases were commits keeps downloading as version 1 until it is published again.

The archive's header is validated on import. Metadata is capped at 64 KiB and the content is capped at 32 MiB so a malformed archive cannot force unbounded allocation in the worker. The content itself is not decoded at upload: it is checked when it is loaded into a workspace (see [Validation](#validation)), so an archive whose content is invalid imports, but then refuses to instantiate or to be applied to a gadget.

Only `BlueprintMetadata` is included in the file, not the full KV record. In particular, the archive does not include `ownerId`, `gadgetId`, or screenshot bytes. Imported archives clear any screenshot marker because screenshots are stored separately from the archive content.

Import/export streams the content bytes directly to and from R2 using `pipeTo()` rather than buffering the whole archive in memory on the server.

Importing a version 2 archive stores the same release commit under a new blueprint ID. A gadget made from the original can therefore follow the copy without any change to its code (see [Kinds of proposal](#kinds-of-proposal)).

## Admin Features and Featured Blueprints

Deployments can optionally configure a set of admin usernames through the backend worker's `ADMINS` binding as an array of usernames.

Admins get access to two extra RPCs:

- `AuthenticatedApi.adminIsBlueprintFeatured()` returns whether a published blueprint is currently featured.
- `AuthenticatedApi.adminSetBlueprintFeatured()` marks or unmarks a blueprint as featured.

Only gadget-backed published blueprints are featureable. Uploaded/imported library blueprints are intentionally excluded.

Featured blueprint state is split across two stores:

- The authoritative `featured` bit lives in the owning user's `blueprints` record inside their User DO.
- The `AdminSettings` durable object is a singleton (`getByName("")`) that mirrors the current public metadata for featured blueprints and writes a KV snapshot consumed by `AuthenticatedApi.listFeaturedBlueprints()`.

## Output Formats and Bundled Blueprints

A **format** is an ordinary blueprint the deployment has promoted, so that "New Doc" or "New Slides" appears in the composer's `+` menu and in the list the agent is told to prefer. Promotion is admin curation (`AdminConfig.formats`, managed in the admin **Formats** panel); nothing about the blueprint itself changes.

What a blueprint may declare is `BlueprintMetadata.output`: a grouping `id`, a `noun` and `plural` ("Doc"/"Docs"), and an `icon` from the closed `OUTPUT_ICONS` set. A gadget instantiated from the blueprint inherits it, and that is what the workspace tab, chat cards and the Outputs page draw. Declaring it is presentation only and grants nothing -- any user can publish a blueprint calling itself a Document. Being *offered* as one of the deployment's standard formats is the separate, admin-curated decision. An admin can override any of these fields (`FormatCuration.overrides`), and the override is applied on every instantiation path, so a rename reaches gadgets the agent builds as well as ones made from the menu.

A deployment can also ship blueprints as data. `packages/bundled-blueprints/blueprints/` holds a directory for each blueprint with a `blueprint.json` manifest and reviewable files under `files/`. The Workshop backend's `scripts/build-bundled-blueprints.ts` builds each one's files and embeds them, with the manifest, in a generated module (overridable with `BUNDLED_BLUEPRINTS_DIR`, so a fork can ship its own set). Installing one writes an ordinary blueprint: metadata into KV and a release pack into R2. These differ from published blueprints in four ways:

- Their IDs are **stable and readable** (`format.document`, not a random hex ID), because both installation and promotion are keyed on them. Renaming one after deploy orphans the old entry rather than moving it.
- They have **no owning User DO**. `AdminSettings` writes them straight into the featured mirror, because there is no publishing user whose `featured` bit could be authoritative.
- Their `output` lives in `blueprint.json`, so the deployment's presentation has a single source of truth.
- Their **releases are not chained**. Each is the [snapshot release](#snapshot-releases) of its files, a parentless commit that depends on nothing else. So the installer never reads what was installed before, reinstalling the same files rewrites the same bytes under the same key, and every deployment that installs the same files installs the same commit. `metadata.version` still comes from `blueprint.json`.

The first `/api` request a deployment serves reinstalls the bundled blueprints if the manifest fingerprint of any has changed. A blueprint's fingerprint covers its title, description, author, revision, output presentation, and a hash of its files and the rest of the metadata the manifest supplies. Each bundled blueprint is promoted only once ever -- an upgrade never undoes an admin's later removal or overrides.

A gadget made from a bundled blueprint follows it like any other. When the deployment installs new files, an update becomes available to the gadget, and it is merged against the release the gadget last took, which is the right base (see [The merge base](#the-merge-base)). What unchained releases give up is the link between a blueprint *derived* from one bundled release and a later bundled release: switching a gadget between those two has no history to go by, so it is merged against an assumed base, with the warning that brings.

The bundled formats currently ship build output (bundled `client.js` and `server.js`), which does not merge well. A gadget customized by editing those files may see heavy conflicts when it takes an update. That is accepted until the formats ship as source.

## Creating and Managing Blueprints

Blueprints are managed through the Blueprints menu in the gadget editor header, whose **Publish as blueprint…** item opens the Blueprint modal. (The menu's other item, **Update from blueprint…**, is the reverse direction: see [Updating a Gadget from a Blueprint](#updating-a-gadget-from-a-blueprint).) The UI allows:

- **Creating** a new blueprint from the gadget's current committed code, with a title, optional description, and optional screenshot.
- **Describing** the required connections with optional per-binding helper text and suggested values.
- **Listing** existing blueprints with their title, description, version, and code version date. A blueprint is marked **Unpublished changes** when the gadget's committed files differ from the ones it last published (`BlueprintGadgetSummary.unpublishedChanges`).
- **Editing** a blueprint's title, description, screenshot, and connection guidance through the same form used to create a blueprint.
- **Updating** a blueprint to the gadget's current code. This publishes a new release and increments the version, unless there is nothing new to release.
- **Copying** the blueprint's share link to the clipboard.
- **Deleting** a blueprint (with confirmation).
- **Retrying** a failed publish when the dirty flag is set.

On the backend, the Overseer handles blueprint lifecycle through `createBlueprint`, `updateBlueprint`, `deleteBlueprint`, and `retryBlueprintPublish`. Blueprint creation generates a random ID, collects binding metadata from all annotated gatekeepers (via `collectBindingMetadata`), writes the first release of the gadget's committed code (via `mintBlueprintRelease`, which also returns its pack), and propagates to all three storage locations and R2 (via `propagateBlueprint`). `updateBlueprint` with `updateCode` writes the next release the same way. A gadget with no committed files cannot be published, and neither can one still pending in a chat.

## Instantiating a Blueprint

When someone opens a blueprint link (`/blueprint/<id>`), they see the **Blueprint Landing Page**:

1. The page fetches metadata via `PublicApi.getBlueprint()` (unauthenticated -- knowing the ID is sufficient since a blueprint is just data).
2. It displays the title, description, optional screenshot, author, version, and a summary of required bindings.
3. If the user is not logged in, they see a "Log in to create a gadget" button.
4. Once authenticated, the user enters **configure mode**, where they assign each required binding:
   - For gatekeeper bindings: pick a connected account and configure the matching resource.
   - For AI model bindings: pick from their configured models.
   - For agent spawner bindings: pick a model (or none).
5. Clicking "Create Gadget" calls `AuthenticatedApi.newGadgetFromBlueprint()`, which:
   - Reads the blueprint's metadata from KV.
   - Creates a new Overseer DO and has it initialize itself via `initializeFromBlueprint`. The Overseer reads the release from R2 for itself, as the version that metadata describes, so the code is the code the bindings set up below belong to even if the blueprint is republished meanwhile. The pack never crosses an RPC.
   - Creates gatekeepers from the user's binding assignments (pipelined for performance).
   - Returns the new Overseer stub, and the UI redirects to the new gadget.

Instantiating from release R writes two commits. The first is an empty root `e`, `Create gadget: <title>`. The second is `i = [e, R]` with R's tree, `Instantiate blueprint: <title>`, which becomes the gadget's head. So every commit on the gadget's first-parent chain was written locally and has its tree, while R's ancestors, most of which arrive without trees, are reached only through other parents. Pointing the head at R itself would run the gadget's own history into the release history, where trees are missing.

The gadget also records the blueprint it follows: `GadgetRecord.upstream = {blueprintId, commitId}`, the blueprint to check for updates and the release of it most recently merged. (An `upstream` can hold less than that, or be absent, see [What `upstream` can say](#what-upstream-can-say).) The record has to name the blueprint because the release commit does not. `upstream` reaches clients as `GadgetSummary.upstream`, for subscribers with the "build" role only: a blueprint ID is a share link to the blueprint's code, which a "use" collaborator cannot otherwise read.

A release that fails validation, or has no files, refuses to instantiate and leaves no gadget behind.

The new gadget is independent from the blueprint source: it has its own storage, chat history, and bindings. Later releases of the blueprint reach it only when someone who can build in the workspace applies them.

### Instantiation by the agent

The AI agent can also instantiate a blueprint as an *additional* gadget within an existing workspace:

- The `listBlueprints` tool lists the blueprints available to the workspace owner (the deployment's standard formats, listed first and marked as preferred, then their own published blueprints, their library, and the deployment's featured set) as formatted text; there is no search index, so the model scans the list itself.
- Passing a `blueprintId` to the `createGadget` tool creates the new gadget from the blueprint's code instead of empty. The gadget is provisional to the chat like any agent-created gadget, and the blueprint's files are copied into the chat's proposed changes (recorded in the same `changes` message as the creation), so accepting or reverting the chat's changes covers the files and the creation together.
- Bindings are not auto-assigned on this path: the tool result describes the bindings the blueprint expects, and the agent wires them up itself under the same names (via `setGadgetBinding`, requesting connections as needed), or asks the user to add AI-model / agent-spawner bindings from the Connections panel.
- The creation's `changes` message also records which release the files came from (a `blueprintMerges` entry of kind `fastForward`, see [The proposal record](#the-proposal-record)). Accepting the chat's changes reads it: the gadget's first commit is written as `[e, R]`, over an empty root of its own, and the gadget follows the blueprint from then on. A gadget made this way has the same lineage as one made from the landing page, though its first commit may already include the agent's edits.

When a `.gadget` file is uploaded, the target instance creates a new local blueprint ID, stores the uploaded content in its own R2 bucket, writes the imported metadata to its own KV namespace, and records the blueprint under the importing user's account. The original blueprint author metadata is preserved, but ownership of the imported copy belongs to the importing user on the new instance.

## Updating a Gadget from a Blueprint

A gadget can take a later release of the blueprint it follows, or switch to following another blueprint. Both are one operation: `GadgetClient.applyBlueprint(blueprintId, {modelId, allowUnrelated?})`, which proposes merging the blueprint's *current* release into the gadget. It also serves a gadget that follows nothing yet, and a gadget whose blueprint was uploaded again under a new ID. It is available to the "build" role only, like `createBlueprint`.

Applying a blueprint never changes the gadget. It creates a new chat, titled `Update from blueprint: <title>`, that holds a proposal. The user previews the result there like any other proposed change, then accepts or discards it. Nothing about the gadget changes until accept, including which blueprint it follows. Accepting a proposal always makes the gadget follow the blueprint applied: there is no one-off merge that leaves the followed blueprint as it was.

There are no automatic updates.

### In the UI

- **Update from blueprint…** in the gadget editor's Blueprints menu opens a dialog with two options: update from the blueprint the gadget follows (the default), or, under **Advanced: Switch blueprints**, from another blueprint the user names by pasting its ID or share link. The second explains that the new blueprint must be derived from the same base as the gadget. When the followed blueprint is not known or no longer exists, naming one is the only option. The menu item is not shown for a gadget recorded as built from scratch (see [What `upstream` can say](#what-upstream-can-say)).
- **Update available** appears on that menu item, and as a dot on the menu's button, when the followed blueprint's current release is not the one the gadget last took. The frontend works this out by comparing `GadgetSummary.upstream.commitId` with `PublicApi.getBlueprint()`, so there is no RPC for it. The blueprint is read when the gadget's upstream changes, not continuously, so a release published while the workspace stays open is noticed later. A followed blueprint with no `commitId` never shows an update. Neither does a gadget whose `upstream` names no release, nor a "use" collaborator's view, which is not told `upstream`.
- On a proposal, the UI opens the new chat. For the other outcomes it says so in the dialog, and when the call fails because the gadget changed meanwhile it offers to try again.

### What `applyBlueprint` does

1. Reads the blueprint's metadata and loads its release into the workspace's git store, which validates it.
2. Refuses a gadget that is still pending in a chat. Such a gadget has no committed code to merge into.
3. Works out what there is to do (see [The merge base](#the-merge-base)), and returns one of four outcomes (`ApplyBlueprintResult`):
   - `upToDate` -- the gadget already follows this blueprint at this release. Nothing is proposed.
   - `unrelated` -- the gadget and the release share no history, and `allowUnrelated` was not set. Nothing is proposed. The UI warns the user and calls again with `allowUnrelated`.
   - `baseUnavailable` -- the two share a version, but its files are not held, so there is nothing to merge against. Nothing is proposed.
   - `proposed`, with the new chat's ID.
4. For a proposal, creates the chat and records a `changes` message carrying the proposal (see [The proposal record](#the-proposal-record)). Unless the release is already in the gadget's history, it pins the gadget at its head, runs a three-way merge of the head and the release against the base, and records the result as the message's change.
5. Starts an agent turn if the proposal is a merge that changes a file (see [The agent's review](#the-agents-review)).

If the gadget's head moves while this is being computed, the call throws an error asking for a retry rather than record a merge into a head the gadget no longer has. The chat and its proposal are written in one transaction, so a chat never exists without its proposal.

### Kinds of proposal

Every proposal is one of three kinds, recorded on it:

| Kind | When | Files | Agent |
|---|---|---|---|
| `follow` | The release is already in the gadget's history, or its files equal the base's. | Unchanged. | No |
| `fastForward` | The gadget's files equal the base's: it has no changes of its own since the release it last took. | Become the release's exactly. | No |
| `merge` | The gadget and the blueprint have both changed files since the base. | Three-way merged. | Yes, if any file changes |

The kind comes from comparing each side's files with the base's, not from what the merge produced. A gadget and a blueprint that made the same changes therefore yield a `merge` whose change is empty.

A `follow` proposal is what keeps "already merged" from blocking a switch. An export uploaded again is the same release commit under a new blueprint ID, and a gadget made from the original should be able to follow the copy. A gadget that took Alice's latest release by way of Bob's derived blueprint should be able to go back to following Alice. In both cases there is nothing to merge, but `upstream` names a different blueprint. The proposal keeps the preview-and-accept contract while changing no code: accepting it retargets `upstream`.

A `fastForward` is named for its effect on files. Accepting one still writes a two-parent commit.

### The merge base

The base of the three-way merge comes from the commit graph (`WorkspaceGitCache.mergeBases`, which walks commit objects the workspace holds), with fallbacks where the graph has nothing to offer:

| Situation | Behaviour |
|---|---|
| The release is already an ancestor of the head | No merge. If `upstream` already names this blueprint at this release, the gadget is up to date. Otherwise the proposal is a `follow`. |
| One best common ancestor, tree held | Use it. |
| Several best common ancestors | Of those whose trees are held, prefer one on the release's own lineage, else the one with the latest commit date. A recursive merge is future work. |
| A common ancestor exists, but no candidate's tree is held | Refuse (`baseUnavailable`). |
| No common ancestor, and the blueprint is the one the gadget follows, at a release on record | Use `upstream.commitId`, the release the gadget last took from it. No warning. |
| No common ancestor otherwise | Assume a base, and require `allowUnrelated`: `upstream.commitId` if the gadget has one, else the oldest commit on its first-parent chain to have any files. |

The fifth row serves blueprints whose releases are not chained, which today means the bundled ones. It needs no warning because only a blueprint's own publisher can put a release under its ID, so the release the gadget last took from that ID is the right base.

The last row is a guess. A gadget that follows a blueprint and switches to one sharing no history with it is merged against the release it last took. A gadget with no release on record (it was built from scratch, or was made from a blueprint before gadgets recorded what they follow) is merged against its first non-empty commit. It is "first non-empty" rather than "root" because a gadget created empty, or converted from the storage that preceded git, is rooted at an empty-tree commit. That guess is exact only if the commit is the blueprint's tree unchanged. Where it already includes edits of the owner's or the agent's, those edits look to a three-way merge like something the blueprint removed, and can be reverted with no conflict reported. So the proposal is recorded with `unverifiedBase`, and the dialog, the notice in the chat and the agent's view of the merge all say so.

A base is not treated as a guess if it has no files (there is nothing a wrong guess could undo), or if the release or one of its ancestors has the very same tree, which the commit objects reveal.

Once such an update is accepted, the gadget has an upstream and, for a blueprint with chained releases, real lineage. Later updates from the same blueprint need no warning.

### What `upstream` can say

`upstream` records where a gadget's code came from, in one of four states:

| `upstream` | Meaning | "Update from blueprint…" |
|---|---|---|
| `{blueprintId, commitId}` | The gadget follows that blueprint, and last took that release. | Shown, offering that blueprint |
| `{blueprintId}` | The gadget was made from that blueprint, but which release it took is not on record. | Shown, offering that blueprint |
| `{}` | The gadget was built from scratch in this workspace. It follows no blueprint. | Hidden |
| absent | Where the gadget came from is not known. | Shown, asking for a blueprint ID or link |

A gadget instantiated from a blueprint gets the first state, and accepting any blueprint proposal sets it. A gadget created from no blueprint (by the user from the workspace UI, in a chat or outside one, or by the agent's `createGadget` with no `blueprintId`) is born in the third. So every gadget made since this was recorded is in the first or the third once it is permanent. A gadget the agent is creating from a blueprint has no `upstream` while its creation is still proposed.

Hiding the menu item is the only thing the third state does, and only the UI does it. `applyBlueprint` treats `{}` and absent alike: neither has a release on record, so both take the last row of the table above, with its warning, and accepting the proposal gives the gadget a blueprint to follow. The item is hidden because merging a blueprint into a gadget that never came from one has no sensible base. One case that deserves a flow of its own is not served meanwhile: the author of a blueprint taking back the changes of someone who built on it. Their gadget was built from scratch, and the right base for that merge is the commit they published from (`BlueprintGadgetRecord.releases`), not the gadget's first commit.

A "use" collaborator is never told `upstream`, so their view cannot tell the states apart. They cannot apply a blueprint in any case.

The second state and the last exist only for gadgets made before `upstream` was recorded. A storage migration (`migrateToBlueprintUpstreams` in `storage-schema/overseer-migrations.ts`) sorts those gadgets by what the chat log still says:

- The agent's `createGadget` tool call with a `blueprintId`: `{blueprintId}`. The call does not say which release the gadget took.
- That call with no `blueprintId`, or a `changes` message in a user's name that lists the gadget as created (the user's own creation, from the workspace UI with a chat open): `{}`.
- Anything else: left absent. That covers a gadget instantiated from the landing page or the New menu, which left no record of its blueprint anywhere; one a user created outside any chat; and one whose record in the log is gone or was not reached.

An `upstream` with no release does one thing: the update dialog offers that blueprint. No update is announced for the gadget, and applying the blueprint takes the last row of the table above, with its warning. Accepting that proposal records the release, and the gadget is like any other from then on.

The migration is best-effort. A workspace with no gadget that lacks an `upstream` is not scanned at all, which covers the many workspaces that hold no gadget. Otherwise it reads at most 1000 chat messages per workspace, shared between the chats and taken from the start of each, so a creation late in a long chat can be missed. A gadget it misses stays of unknown origin, and keeps the menu item.

### The proposal record

The proposal is recorded in the chat log, as `blueprintMerges` on a `changes` message (`BlueprintMerge` in `api.ts`):

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

It holds everything the UI and the agent need to describe the proposal, so neither reads a blueprint again that may have moved since. A few of its fields need explaining:

- `conflictPaths` are paths within the gadget. (A `mainlineMerge` record's paths are `GADGET_NAME/path` instead.) A conflicted file holds inline diff3 markers, labelled `this gadget`, `base` and `blueprint`. A file that one side deleted and the other changed is listed too but has no markers: it holds the changed version.
- `missingBindings` are the bindings the release declares that the gadget had none named for when the proposal was made. Bindings the release no longer declares are left alone, and a `spawnerOnly` binding is never listed. The gadget's `output` format is not changed by a switch.
- `messageCount` is present when the change was too large for one `changes` message and was split by file across consecutive messages. The entry is on the first, and the count is what tells the rest from edits made afterwards.

`Overseer.mergeChanges()` reads the record from the log when the chat's changes are accepted. For each gadget with an entry on a message that is neither merged nor reverted, it sets `upstream`, and it writes a commit with the release as a further parent unless the release is already an ancestor of the head. That has several consequences:

- There is no separate proposal state. Reverting the message withdraws the proposal, as it removes the pin that message declared, and discarding the chat leaves `upstream` alone. (Unlike a `mainlineMerge` message, a `blueprintMerges` message can be reverted, since it advances no pin.)
- A gadget whose release is new to its history is committed even if its content equals its head. Otherwise the merge would go unrecorded and the next update would be merged against the wrong base.
- A proposal whose release is already in history declares no pin and writes no commit, so it cannot go stale. For the same reason it does not appear in `AiChatMetadata.proposedChangeWorkpieces`: the record on a still-proposed message is the only sign that the chat has something to accept, and the UI offers accept and discard by it.

Because a gadget's head can now have two parents, a chat's first edit of a gadget may declare its pin at the head or at the head's *first* parent only (the tolerance for a race with one concurrent accept). Any parent would admit the merged release, which is not a state the gadget was ever in.

### The agent's review

The server starts the agent, once, and only for a merge.

- **A merge that changes files gets an agent turn, even with no conflicts.** Lines that merge cleanly can still disagree: the blueprint renames a function that the gadget's own code calls, or both sides add the same feature in different places. Only something that reads the result can catch that.
- **A `follow`, a `fastForward` or an empty merge gets none.** The result is one side's files exactly, so there is nothing to check that the user's own preview does not show. These are the common cases and cost no tokens. A user who wants help anyway, say with a missing binding, asks in the chat.
- **`applyBlueprint` starts the turn itself**, in the call that creates the chat, with the model the caller named (`modelId`, as for `newChat`; null starts none). One application therefore starts at most one turn, however many collaborators, tabs or reconnects are watching, and no client decides whether to start one.
- **The turn is prompted by the record, not by a message.** Replay renders the entry as the model's input (`formatBlueprintProposal` in `agent.ts`). No prose is stored. Other kinds are rendered as a one-line note, so a later turn in the chat knows what happened.
- **The agent sees a summary, not a diff.** It names the blueprint and version; the base, head and release commits, which the agent can mount with `createWorktree` to look closer; whether the base is a guess; the missing bindings; and the changed files in three groups: files with conflicts, files both sides changed that merged cleanly, and files only the blueprint changed. Each group names at most 50 paths, so the summary's size does not depend on what is in the files.
- **The task is narrow.** Resolve the conflicts, check that the two sets of changes still work together, wire up the missing bindings, change nothing else, and say what was done. Over a guessed base it is also asked to look for work of the user's that the merge undid. The system prompt has a "Merge conflicts" section covering the markers, for mainline merges too.

### In the chat

- **A notice** stands in the transcript for each proposal, in place of the generic changes card (`BlueprintProposalNotice`). It is generated from the record alone, apart from whether an agent is taking part in the chat (which for a merge is the one reviewing it): which blueprint and version, what kind of proposal it is, who is making sure the gadget's own changes fit the update, that nothing changes until the user accepts, the guessed-base warning, and the missing bindings. It is written for readers who are not developers, so version-control terms (merge kind, commits, conflicted files, binding names) appear only under its collapsed "Advanced details". A split merge's later messages are folded into it. Once the proposal is decided, the notice stays as a record of the update, marked accepted or discarded and without what was still to do, so the agent's review still has something to follow.
- **Accept and discard** are offered for any chat with a still-proposed `blueprintMerges` message, which covers the `follow` that pins nothing.
- **Conflict markers are checked before accept, by the UI.** It looks through the files that the chat's still-proposed `blueprintMerges` and `mainlineMerge` records list as conflicted, in the chat content it already holds, for a line beginning `<<<<<<< ` or `>>>>>>> `. Finding one opens a dialog that lists the files and offers "Accept anyway". `mergeChanges` itself accepts whatever it is given: merging markers is the caller's prerogative.

### Trust

Lineage is information, not authority. A crafted pack can claim any ancestry, which at most suppresses the "unrelated" warning for a blueprint the user chose to apply. The controls are the same as for any proposed change: the user picks the blueprint, previews the proposal, and accepts. "Update available", and the unwarned use of the last-taken release as base, are driven only by the followed blueprint's ID, which only its publisher can publish to: its workspace's builders, or for a bundled blueprint the deployment.

### Limitations

- **A guessed base can undo local edits silently.** See [The merge base](#the-merge-base). The mitigation is review. A merge over a guessed base gets the agent's review as well as the user's, but a `fastForward` over one runs no agent, so there the only reviewer is the user, prompted by the notice.
- **A large file that differs throughout is slow to apply.** The result is recorded as a minimal character-level diff, which has no bound on the time it takes. Applying a blueprint whose large files have little in common with the gadget's (a blueprint of another format, say) can take minutes, during which the workspace answers nothing. How a deployed Durable Object's CPU limit treats a call that long has not been tried. An ordinary update, with scattered edits to a large file, is not affected.
- **A conflicted file can exceed the file size limit.** It holds both sides and the base, so its text can be longer than `MAX_FILE_TEXT_LENGTH` even though the files that went into it are not. What the edit tools and a later publish make of such a file has not been tested.
- **A preview shares the gadget's storage.** If the new release migrates stored data when it runs, discarding the proposal does not undo the migration.
- **The UI's checks see only loaded history.** A chat reopened after a compaction loads what follows the checkpoint. A conflicted merge, or a `follow` that pins nothing, recorded before the checkpoint is not noticed until the user scrolls back that far.
- **Published identity is permanent.** A release commit carries its author's name and commit email into the pack of every blueprint derived from it, and deleting the original blueprint does not recall it.

## Orphaned Blueprints

A blueprint can outlive its source gadget. If a gadget is deleted, its blueprints remain accessible via KV and R2. The user can manage orphaned blueprints through `AuthenticatedApi.listOwnBlueprints()` (which reads from the User DO) and delete them via `deleteOrphanedBlueprint()` (which cleans up KV, R2, and the User DO record directly, bypassing the now-deleted Gadget DO).

## Creation Specs

To support blueprint metadata derivation, each gatekeeper stores a `GatekeeperCreationSpec` that records how it was originally created. This includes the vendor ID (for gatekeeper bindings), provider and model name (for AI model bindings), or the full spawner config (for agent spawner bindings). The creation spec, combined with the blueprint annotation, is used by `collectBindingMetadata` to produce the `BlueprintBinding` records stored in the blueprint.
