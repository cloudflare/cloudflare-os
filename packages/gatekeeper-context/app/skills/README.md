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

Existing organizational directories remain usable for backwards compatibility: skills can be
created in them and moved into, out of, or between them, and the directories themselves can be
deleted. They cannot be created, renamed, or moved through the navigator, because the forward model
treats only skill bundles as movable units.

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

Skill and directory actions are offered only when the account can write the collection and the
collection is web-backed. Git-backed collections remain read-only at the skill level but owners and
admins can still edit their collection settings, manage Git tokens, refresh them, or delete them.
Otherwise read-only collections expose no mutation actions and are not offered as Add Skill targets.
If loading a collection's documents fails, that collection also fails closed as non-writable for
skill mutations in the current view.

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

## Skill upload format contract

The upload dialog accepts [Agent Skills](https://agentskills.io/specification) and
legacy Markdown. Import acceptance is deliberately broader than validation of the
stored `SKILL.md`.

### Recognizing metadata

An import opts into skill metadata only when it begins with a complete `---`
fenced block that parses as a YAML mapping containing `name` or `description`.
The delimiter must be unindented; a BOM, CRLF, and trailing fence whitespace are
accepted. Indented delimiters within YAML block scalars do not close the block.

Everything else is legacy Markdown, including ordinary text, horizontal rules,
unclosed fences, invalid YAML, sequences, and mappings without skill metadata keys.
These inputs are ambiguous, so preserve the entire source as instruction text
rather than guessing which part to discard. This also applies to imports named
`SKILL.md`; that filename groups supporting files but does not require a legacy
import to already be a valid skill.

### Review and conversion

- Recognized metadata supplies the editable name and description. Missing or
  non-string fields are left blank for correction; invalid strings are not replaced
  with inferred defaults. Extra metadata is retained when writing the manifest.
- Legacy Markdown gets a filename-derived name and a suggested description for
  user review. Conversion adds new frontmatter and preserves the entire original
  instruction text, including leading whitespace and line endings.
- Recognized frontmatter is serialized after edits, but its Markdown body is
  preserved verbatim. The metadata syntax itself need not round-trip byte-for-byte.
- The existing review form checks the final name and description before upload;
  the server's `parseSkillManifest` validates the resulting stored manifest.

`readSkillUploadSource` in `skillUpload.ts` is the single recognition decision used
by both inference and conversion. New import behavior should be expressed here
and covered by the table-driven round-trip tests, rather than added as an independent
delimiter heuristic in a caller.

This is not a claim of full specification validation: the existing server validates
required fields, permits names differing from the parent directory, and does not
validate every optional specification field.
