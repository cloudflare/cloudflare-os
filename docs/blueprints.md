# Blueprints

Blueprints let a user share a gadget's source code so that others can create their own gadget instances from it. A blueprint captures the code but not the chat history, SQLite storage, or credentials. Each gadget created from a blueprint gets its own bindings, storage, and chat history.

This is analogous to a template: the blueprint author publishes a reusable gadget design, and anyone with the link can stamp out their own copy, pointing it at their own resources.

## Key Properties

- A single gadget can have **multiple blueprints**, potentially at different code versions (e.g. a "stable" and a "latest" blueprint of the same gadget).
- Each blueprint has a **128-bit random hex ID**, generated server-side. Blueprints bundled with a deployment are the exception: they carry stable, readable IDs (see [Output Formats and Bundled Blueprints](#output-formats-and-bundled-blueprints)).
- Blueprints are shared via link: `https://<host>/blueprint/<blueprint-id>` (for example, a random hex ID or a bundled ID such as `format.document`).
- Anyone with the link can **view** the blueprint's metadata (title, description, author, required bindings) without authenticating. **Creating a gadget** from a blueprint requires authentication.
- A blueprint is always owned by the gadget's owner, regardless of which collaborator creates it. Bundled blueprints have no owning user at all.
- The blueprint author can **update** a blueprint to reflect newer code, incrementing its version number. Old code versions are retained in storage to avoid race conditions during concurrent instantiation.
- Blueprints can be exported to a `.gadget` file and imported into a different Workshop instance.

## What a Blueprint Captures

A blueprint captures:

- **Source code** -- a snapshot of the gadget's committed Yjs document, stripped of edit history. The snapshot contains only the final file contents (one insert operation per file), producing a minimal encoding.
- **Binding requirements** -- a description of each named binding the gadget uses, including what type of connection is needed (gatekeeper, AI model, or agent spawner) and how to configure it. The blueprint does not include any credentials or live connections.
- **Metadata** -- title, description, optional screenshot metadata, author info, version number, and timestamps.

A blueprint does **not** capture:

- The gadget's SQLite storage contents.
- AI chat history or edit history.
- Live connections or credentials. Only the *shape* of each binding (its type, gatekeeper name, URL pattern, etc.) is recorded.

## Binding Annotations

Before creating a blueprint, the author can optionally add **blueprint annotations** for the gadget's named bindings. This user-provided metadata controls how each required connection appears to someone creating a gadget from the blueprint:

- **Name** -- a friendly connection name shown to blueprint consumers. It defaults to the current resource title, while the binding name remains the stable key used by code.
- **Description** -- optional helper text that tells the blueprint consumer what kind of resource to connect.
- **Suggest value** -- optionally includes the specific resource URL or model name as a suggestion. This is useful when the blueprint author intends all instances to use the same resource, but it remains a suggestion rather than a requirement.

All named bindings are included in the blueprint. Annotations are configured in the **Blueprint** modal opened from the gadget editor header. The annotation is stored on the `GatekeeperRecord` as the `blueprintAnnotation` field.

## Binding Types

Blueprints support three types of bindings, matching the three types of gatekeepers:

1. **Gatekeeper** (`type: "gatekeeper"`) -- an external resource connection (e.g. Google Drive, a REST API). The blueprint records the gatekeeper adapter name and a URL pattern describing what kind of resource is expected. When instantiating, the user picks a connected account and configures a matching resource.

2. **AI Model** (`type: "aiModel"`) -- a language model binding. The blueprint may suggest a specific provider/model. When instantiating, the user picks from their own configured models.

3. **Agent Spawner** (`type: "agentSpawner"`) -- an agent spawner binding. The blueprint carries over the spawner configuration (prompt types, env restrictions) from the source gadget. The user only needs to choose which model the spawner should use (or no model).

## Storage Architecture

Blueprint data is stored in three places, with one-way propagation: Gadget DO -> User DO -> Workers KV.

1. **Gadget DO** (`blueprints` collection) -- the authoritative source. Stores `BlueprintGadgetRecord` including full metadata, the code version that was exported, and a `dirty` flag for tracking propagation failures.

2. **User DO** (`blueprints` collection) -- a denormalized copy for efficient listing. Stores `BlueprintUserRecord` with metadata and a reference to the source gadget. This allows a user to audit and manage their blueprints even if the source gadget has been deleted.

3. **Workers KV** (`BLUEPRINTS` namespace) -- the public-facing lookup store. Stores `BlueprintKvRecord` keyed by blueprint hex ID. This is what `PublicApi.getBlueprint()` reads from.

Blueprint **code content** is stored separately in an **R2 bucket** (`BLUEPRINT_CONTENT`). The R2 key is `<blueprintId>/<version>`. Content is stored as a Yjs V2-encoded document (the full state, not incremental updates). When a blueprint is updated, old versions are retained to avoid race conditions. When a blueprint is deleted, all its R2 versions are cleaned up.

The `dirty` flag handles propagation failures gracefully: it is set to `true` before propagation begins and cleared only after all writes succeed. If a failure leaves it set, the UI shows a warning with a "Retry" button.

## Explore

The Explore page (`/explore`) is a place where users can discover featured blueprints. Goal is to show users what is possible and to give them place to start.

Admins have the ability to "feature" blueprints. This is what determines what is on this page.

## Blueprints on home page

The home page has a blueprints tab which shows a list of blueprints that they have published plus what is in their library.

Users can pin blueprints to keep them at the top of the home Blueprints tab. Pinning a public blueprint that is not already in the user's library adds it to the library first, then pins it.

Library entries come in two forms:

- **Saved by reference** -- created by `addBlueprintToLibrary()`. The entry stores a cached copy of the blueprint's public metadata for list rendering, but the actual blueprint remains owned by the original publisher. Removing it only deletes your personal library entry.
- **Uploaded** -- created by `importBlueprint()` from a `.gadget` archive. This creates a new local blueprint ID on the current deployment, stores the snapshot in this deployment's R2/KV, and records it in your library with `uploaded: true`. Removing one of these entries deletes the imported blueprint content as well.

## Export / Import Format

Blueprints can be downloaded from `/blueprint/<id>` as `.gadget` files and uploaded from the home blueprints tab into another Workshop instance.

The `.gadget` format is a simple internal binary container:

- 8-byte magic number: `0xec2e2d3a2300e317`
- 4-byte format version (`1`)
- 4-byte JSON metadata length
- 8-byte raw content length
- JSON-encoded `BlueprintMetadata`
- Raw blueprint content bytes copied from `BLUEPRINT_CONTENT/<blueprintId>/<version>`

Imports are validated before publication. Metadata is capped at 64 KiB and the stored snapshot payload is capped at 32 MiB so a malformed archive cannot force unbounded allocation in the worker.

Only `BlueprintMetadata` is included in the file, not the full KV record. In particular, the archive does not include `ownerId`, `gadgetId`, or screenshot bytes. Imported archives clear any screenshot marker because screenshots are stored separately from the archive content.

The trailing content bytes are the same gzip-compressed Yjs snapshot that is already stored in R2 for the blueprint's current version. Import/export streams these bytes directly to and from R2 using `pipeTo()` rather than buffering the whole archive in memory on the server.

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

A deployment can also ship blueprints as data. `packages/workshop-backend/format-blueprints/` holds a directory for each blueprint with a `blueprint.json` manifest and reviewable files under `files/`. `scripts/build-format-blueprints.ts` reconstructs their ordinary archive representation and bundles it into a generated module (overridable with `FORMAT_BLUEPRINTS_DIR`, so a fork can ship its own set). These differ from published blueprints in three ways:

- Their IDs are **stable and readable** (`format.document`, not a random hex ID), because both installation and promotion are keyed on them. Renaming one after deploy orphans the old entry rather than moving it.
- They have **no owning User DO**. `AdminSettings` writes them straight into the featured mirror, because there is no publishing user whose `featured` bit could be authoritative.
- Their `output` lives in `blueprint.json`, so the deployment's presentation has a single source of truth.

The first `/api` request a deployment serves installs any whose manifest fingerprint has changed. The fingerprint covers its title, description, author, revision, output presentation, and generated archive content hash. Each bundled blueprint is promoted only once ever -- an upgrade never undoes an admin's later removal or overrides.

## Creating and Managing Blueprints

Blueprints are managed through the **Blueprint** button in the gadget editor header. The UI allows:

- **Creating** a new blueprint from the gadget's current committed code, with a title, optional description, and optional screenshot.
- **Describing** the required connections with optional per-binding helper text and suggested values.
- **Listing** existing blueprints with their title, description, version, and code version date.
- **Editing** a blueprint's title, description, screenshot, and connection guidance through the same form used to create a blueprint.
- **Updating** a blueprint to the gadget's current code (increments the version).
- **Copying** the blueprint's share link to the clipboard.
- **Deleting** a blueprint (with confirmation).
- **Retrying** a failed publish when the dirty flag is set.

On the backend, the Overseer handles blueprint lifecycle through `createBlueprint`, `updateBlueprint`, `deleteBlueprint`, and `retryBlueprintPublish`. Blueprint creation generates a random ID, collects binding metadata from all annotated gatekeepers (via `collectBindingMetadata`), snapshots the code (via `snapshotCode`), and propagates to all three storage locations (via `propagateBlueprint`).

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
   - Reads the blueprint from KV and its code from R2.
   - Creates a new Overseer DO and initializes it with the blueprint's code via `initializeFromBlueprint`.
   - Creates gatekeepers from the user's binding assignments (pipelined for performance).
   - Returns the new Overseer stub, and the UI redirects to the new gadget.

The new gadget is independent from the blueprint source: it has its own storage, chat history, and bindings. There is currently no mechanism for automatic updates from the blueprint to existing instances (though the Yjs-based storage format could support this in the future).

### Instantiation by the agent

The AI agent can also instantiate a blueprint as an *additional* gadget within an existing workspace:

- The `listBlueprints` tool lists the blueprints available to the workspace owner (the deployment's standard formats, listed first and marked as preferred, then their own published blueprints, their library, and the deployment's featured set) as formatted text; there is no search index, so the model scans the list itself.
- Passing a `blueprintId` to the `createGadget` tool creates the new gadget from the blueprint's code instead of empty. The gadget is provisional to the chat like any agent-created gadget, and the blueprint's files are copied into the chat's proposed changes (recorded in the same `changes` message as the creation), so accepting or reverting the chat's changes covers the files and the creation together.
- Bindings are not auto-assigned on this path: the tool result describes the bindings the blueprint expects, and the agent wires them up itself under the same names (via `setGadgetBinding`, requesting connections as needed), or asks the user to add AI-model / agent-spawner bindings from the Connections panel.

When a `.gadget` file is uploaded, the target instance creates a new local blueprint ID, stores the uploaded code snapshot in its own R2 bucket, writes the imported metadata to its own KV namespace, and records the blueprint under the importing user's account. The original blueprint author metadata is preserved, but ownership of the imported copy belongs to the importing user on the new instance.

## Orphaned Blueprints

A blueprint can outlive its source gadget. If a gadget is deleted, its blueprints remain accessible via KV and R2. The user can manage orphaned blueprints through `AuthenticatedApi.listOwnBlueprints()` (which reads from the User DO) and delete them via `deleteOrphanedBlueprint()` (which cleans up KV, R2, and the User DO record directly, bypassing the now-deleted Gadget DO).

## Creation Specs

To support blueprint metadata derivation, each gatekeeper stores a `GatekeeperCreationSpec` that records how it was originally created. This includes the vendor ID (for gatekeeper bindings), provider and model name (for AI model bindings), or the full spawner config (for agent spawner bindings). The creation spec, combined with the blueprint annotation, is used by `collectBindingMetadata` to produce the `BlueprintBinding` records stored in the blueprint.
