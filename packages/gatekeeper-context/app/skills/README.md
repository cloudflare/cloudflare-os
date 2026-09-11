# Skills Navigator Direction and Compatibility

The target information model is deliberately flat: a collection contains atomic skills. Each skill
encompasses its `SKILL.md` manifest and all related agentic standards files. Those files may be
stored together in a skill directory, but the navigator presents the complete bundle as one skill,
not as a file hierarchy.

Skill titles are presented as human-readable title case. Creation and rename accept that display
form, then derive the lowercase, hyphen-separated `name` required by the Agent Skills specification
for the manifest metadata and directory name.

Organizational directories are being abandoned. The navigator does not let users create, rename, or
move them, and new product behavior must not depend on adding more directory hierarchy. Directory
nodes remain only to preserve collections that already use older nested layouts.

Selecting a skill still opens the existing collection editor, which remains the general-purpose
document editing surface.

## Legacy directories

Existing organizational directories remain fully usable for backwards compatibility. Skills can be
created in them and moved into, out of, or between them. Restricting movement to only one direction
would make existing layouts confusing to manage and could prevent users from reorganizing their
skills before eventually flattening a collection.

Legacy directories can also be deleted. Deleting one removes its complete document subtree,
including files the skills-only projection does not display. None of these compatibility behaviors
make directories part of the forward-looking data model: no operation can create another
organizational directory.

## Mutation boundaries

- Users can create, rename, move, and delete complete skill bundles, but cannot create, rename, or
  move organizational directories.
- Skill mutations use the skill-specific RPC methods rather than composing generic document calls in
  the client. Each operation validates the manifest and applies all storage changes atomically.
- Renaming or moving a non-root skill operates on its complete directory, preserving supporting
  files. Destination conflicts fail rather than overwrite existing documents.
- A root-level `SKILL.md` is supported, but it has no exclusive directory subtree: moving, renaming,
  or deleting it affects only that manifest. Treating every other root document as its support file
  would risk moving or deleting unrelated skills and documents.
- A destination must be the collection root or an existing legacy directory outside every skill
  bundle. Skills cannot be nested inside other skills, even if an RPC caller supplies a path the UI
  would not offer.

## Permissions and sources

Navigator actions are offered only when the account can write the collection and the collection is
web-backed. Git-backed and otherwise read-only collections remain browsable but expose no mutation
actions and are not offered as Add Skill targets. If loading a collection's documents fails, that
collection also fails closed as non-writable for the current view.

The server remains the authority for every mutation. The client-side checks control affordances and
provide earlier feedback; they are not the security boundary.

## Move limitations

Drag-and-drop is intentionally limited to one collection. Within that collection, existing legacy
directories remain valid destinations for the compatibility reasons above. A same-collection move
can update the skill directory and all supporting documents in one Durable Object storage
transaction.

Cross-collection moves are disabled. Implementing one as separate client-side copy and delete calls
could overwrite concurrent edits or leave duplicated or partially moved data after a failure. A
future backend operation must authorize both collections, reject read-only sources and destinations,
preserve the complete skill subtree, fail on destination conflicts, and define recoverable or atomic
semantics across the two collection Durable Objects before the UI enables these drops.

## Upload limitations

The Skills Navigator accepts standalone Markdown files and folders. Each loose `.md` or `.markdown`
file becomes one skill. A `SKILL.md` file defines a bundle and imports the other files below its source
directory as related skill files; nested bundles are imported as separate top-level skills. Browser
folder selection is based on the non-standard but widely supported `webkitdirectory` input. Chrome's
directory APIs fail or terminate the management app's opaque-origin iframe, so complete folders should
be selected with the folder picker. Supporting folder drops requires reading them in the Workshop host
and passing the files into the sandboxed app.

Skill manifests are created through the skill-specific RPC, but there is currently no backend RPC for
atomically creating a complete bundle. Supporting files are written only after the manifest succeeds.
If one of those writes fails, the user is told which skill was only partially uploaded, but the created
manifest and any successful related files remain. A future bundle-oriented RPC is required for true
all-or-nothing uploads.
