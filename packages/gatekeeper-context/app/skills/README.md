# Skills

The app opens on the user's skills, in the Workshop's design (the shared components in
`@gadgets/ui`): a Skill library list and, under it, the Collections they are kept and shared in
(`SkillsHome`). A skill and a collection each have a page of their own (`SkillPane`,
`CollectionPane`). Everything in a collection, skills or not, is its Documents page, the general
document editor (`CollectionEditor` in `ContextLibraryPage.tsx`), reached from the collection's page
(its Documents button, or Settings → Documents). That is where its icon, Git source and branch, Git
tokens and deletion are, as before.

## Pages and the way back

The app runs in a sandboxed `srcdoc` frame whose location is the Workshop's, so it has no addresses:
each page is a view on a stack (`skillsNavigation.ts`, plain and tested), the way back pops it, and
the back button is named after the page under it. A skill that is renamed or filed under another
collection gets another id, and every view of it follows (`moved`). A collection that is deleted or
left goes back to the first page. Leaving the Documents page reads the skills again, as they may
have been changed there.

## The store

`SkillStore` (plain, tested over `MemorySkillsBackend`) reads and writes the skills through the
app's `ContextApi`. Every collection the user can read is listed in one call
(`listSkillCollections`), each with its documents, the user's permissions and the owner who shared
it; its skills are flat, the collection as the tag, but for the user's own first one (`My skills`),
which is no tag. A skill is a `SKILL.md` the Context Library names (`skillName`), with the files in
its folder, but for those of a skill in a folder within it. A `SKILL.md` whose frontmatter does not
parse is no skill, and is listed only among the collection's documents.

Changing a skill's collection moves it, files and all, to the user's collection of that name, made
for it where there is none: one call (`moveContextSkillToCollection`) copies its files, descriptions
included, into the other collection at once and then deletes it here; repeating a move that failed
between the two completes it, and the collection made for it stays if the move fails. A rename
moves it to a folder of the new name (`renameContextSkill`). A skill's files are read once it is
opened. Auto-use is not kept anywhere, so it lasts the visit, as does the title a skill was given
here while its name is still made from it. The app is not told the user's name, so their own skills
are drawn as "You".

Leaving a collection reads the list again even where the Context Library refuses part of it after
the user has left (their Git tokens not yet revoked), and says why.

## Sharing

The Share dialog adds people through the Workshop's person picker (`useSelectUsers()` in
`bridge.ts`), with the role chosen before it opened: each person picked is shared with as soon as
they are delivered, and a refusal is shown by the picker beside them. Cancelling it does not undo
what was delivered. Who has access is read again after each change. The last owner can neither leave
nor be made anything less. Everyone in the organization is one more row, which whoever may share it
turns on or off.

## Dialogs

The app fills only the Workshop's content pane, so a dialog over the whole window has the host grow
the frame first (`PresentedDialog`, over `usePresentWhileOpen`), and shrink it back once it has
gone. Menus stay inside the frame. The frame is sandboxed without `allow-forms`, so a `<form>`
never fires `submit`: a dialog's primary button acts on click, and Enter in a one-line field does
the same (`submitOnEnter`).

## Adding skills

A skill is written (`AddSkillDialog`) into one of the user's own collections, or a new one named
there, or added from files: each Markdown file chosen is a skill, and a folder with a `SKILL.md` is
one with everything in it (`prepareSkillUploads`). Supporting files are written after the manifest,
one at a time, as there is no call that makes a whole bundle at once. Folders are chosen with the
`webkitdirectory` file input; Chrome's directory APIs fail in the opaque-origin frame. A file can't
be downloaded from the frame (`sandbox="allow-scripts allow-modals"`).

A collection of the user's own is made with a name and what it is for (`AddCollectionDialog`). An
admin, or a deployment with Git collections, also has `CreateCollectionDialog`, with every choice
the Context Library has: an icon, a Git source, and visibility to everyone.

## Skill upload format contract

Uploads accept [Agent Skills](https://agentskills.io/specification) and legacy Markdown. Import
acceptance is deliberately broader than validation of the stored `SKILL.md`.

An import opts into skill metadata only when it begins with a complete `---` fenced block that
parses as a YAML mapping containing `name` or `description`. The delimiter must be unindented; a
BOM, CRLF, and trailing fence whitespace are accepted. Indented delimiters within YAML block scalars
do not close the block. Everything else is legacy Markdown, including ordinary text, horizontal
rules, unclosed fences, invalid YAML, sequences, and mappings without skill metadata keys. These
inputs are ambiguous, so the entire source is kept as instruction text rather than guessing which
part to discard. This also applies to imports named `SKILL.md`; that filename groups supporting
files but does not require a legacy import to already be a valid skill.

- Recognized metadata supplies the name and description; extra metadata is kept when the manifest
  is written. A name that is not valid is made from what the file was called.
- Legacy Markdown gets a name from its filename and a description made from it. Conversion adds new
  frontmatter and keeps the entire original instruction text, including leading whitespace and
  line endings.
- Recognized frontmatter is serialized after edits, but its Markdown body is kept verbatim.

`readSkillUploadSource` in `skillUpload.ts` is the single recognition decision used by both
inference and conversion, and by the store when it rewrites a manifest. New import behavior belongs
there, covered by the table-driven round-trip tests. The server's `parseSkillManifest` validates
the stored manifest.
