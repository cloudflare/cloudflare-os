# Editing a gadget's code

How a gadget's code is edited in the new app, evolving from today's read-only View code, with no
kernel changes. Written for the people who will build it and for Balint, whose app it lands in.

## Who it is for

Most people who open a gadget's code are not engineers. They want to change a word, a colour, a
number, and see it change; anything more they ask the agent for. Developers want an editor they
would choose: fast, keyboard-first, honest about what is saved, and never in their way. One design
serves both if the simple things are obvious and the deep things are there when reached for, never
the other way round. Neither should ever have to learn what a branch, a pin or a merge is.

## What the kernel gives us

Everything here is built on calls the backend already has. The facts that shape the design:

- **Edits belong to a chat.** A chat is the branch: its uncommitted code is one revisioned stream
  of changes (`ChatCodeBase`), which the agent and every person in the chat write into. A person
  writes with `submitCodeChange` (operational transform, at most one change in flight, retried by
  `clientId` and `seq`). Main's Workshop has no editing outside a chat either.
- **Keeping is ours to trigger.** `mergeChanges` makes the chat's changes the gadget's, as one
  commit. This app already keeps the agent's changes on its own when a turn ends and the viewer is
  the only one working on them (`chat/autoAccept.ts`). A person's edits can follow the same rules.
- **The running gadget follows the chat.** `getUiBundle(chatId)` and `connectToGadget(chatId)`
  build from the chat's latest code, server side included, and a build that fails throws, naming
  the file and line. So a preview that updates as you type costs nothing new.
- **A change is whole files or edits to them.** `set`, `edit` and `remove`, so creating, deleting
  and renaming are all one atomic change (a rename is a `remove` and a `set`). A folder is not a
  thing git keeps: it exists while a file is in it.
- **Gadgets hold text only.** `setBytes` is refused for a gadget (worktrees take it), so an image
  goes in as SVG or a data URL, and a binary file cannot be uploaded into a gadget.
- **A commit's message is the chat's title.** Keeping writes "Accept changes from chat: <title>",
  and `setChatTitle` sets the title, so we choose how a save reads in history.
- **There are no empty chats.** `newChat` needs a first message. This decides the open question
  at the end.
- **Editing is refused while the agent works.** The call throws a retryable error during a turn,
  so editing pauses for the turn rather than racing it.
- **Main has already solved the hard part.** `workshop-frontend/src/features/code/otClient.ts` (a
  chat's OT client: sparse content, first-keystroke pinning, riding a merge without losing typing,
  rebuilding after a revert) and `workpieceTree.ts` (tree, statuses, rename paths) are plain,
  tested and UI-free. They are ported, not rewritten.

## Principles

1. **One model, never named.** You are always editing in a chat, the same chat whose agent can see
   what you changed. The words are "Saved", "Kept" and "Changes", never branch, commit or merge.
2. **Saved without asking.** What you type is on the server within moments and survives a reload.
   It becomes the gadget's for everyone by the same rule the agent's work does. ⌘S is honoured,
   never required.
3. **The code and the gadget are one thing.** Code is another way of looking at the gadget in its
   pane, which keeps running and shows each change as it lands. Nobody switches apps to edit.
4. **The agent is your pair.** Anything you point at in the code can be handed to the chat, and
   whatever the agent writes, you watch it write.
5. **Quiet until needed.** No toolbar of icons, no modal for a name, no toast for what the screen
   already shows. Errors sit where they happened, in words for a person.
6. **Every state is designed.** Loading, empty, locked, failed, conflicting, offline, on a phone.

## How it reads

### Someone who isn't an engineer changes a colour

They open Counter beside its chat and choose Code from More, as today. Its files are listed with
the one the gadget starts from first. The colour in the stylesheet has a swatch beside it; they
click it, pick a blue, and the counter beside the chat turns blue as the picker moves. The status
line says "Saved", then a moment later "Kept". Nothing else happened, and nothing needed to.

### A developer works through a change

They expand Counter to its own page, where the code and the running gadget sit side by side. ⌘P
finds a file, ⌘⇧F searches them all, and each keystroke reaches the preview about half a second
after the last one. A typo that breaks the build keeps the last good preview up and underlines the
line the server named, with its message, so they fix it where they are. They rename a file with
Enter in the tree, drag two into a new folder, and the Changes group at the top of the tree shows
what is different from what is kept. ⌘S keeps it now. History lists it as their save, by name.

### Working with the agent

They select a function and choose "Ask about this" (⌘L). The lines go into the composer as a
quote, file and lines named, and they ask for a change. While the agent works the editor is read
only, and its edits stream into the file being written, which is opened for them unless they have
moved to another file since the turn began. When the turn ends the editor is theirs again, and the
agent's changes are kept as they are today.

### Two people in one chat

Someone else's edits arrive as they are made, transformed against yours, so neither loses a
keystroke. What they changed glows briefly in their colour with their name, then settles. Nothing
is kept on its own while someone else is working on it: the status line says "Not kept yet" with
Keep beside it, and the chat's Keep changes card is the one place that decides.

## Where editing happens

**Beside a chat.** The pane shows the gadget or its code, as today: More → View code, and the
title's trail "Counter › Code" goes back. Code is editable here whenever the viewer can build in
the workspace. A second press of the trail's last crumb, or ⌘⇧E, flips between the two, keeping
each where it was. The gadget keeps running under the code, so flipping back is instant.

**As the gadget's own page.** Wide enough (container width, not the window's, as `CodeBrowser`
already measures), the code and the running gadget are split side by side, the divider dragged
like the app's other splits and remembered per device (`prefs/codePrefs`). Narrower, it is the same
flip as beside a chat. See the open question at the end for where these edits go.

**On a phone.** Editing works, as CodeMirror does on touch, but the layout is the narrow one:
files in the drawer the file's header opens, the flip between code and gadget, and a toolbar over
the keyboard with Tab, the brackets, Undo and Done. The swatch and number controls work by touch.

**Who can.** Owners and whoever builds in the workspace. Someone given the gadget to use sees
neither View code nor editing (`role === 'use'`), as today.

## Saving

Edits go to the chat as they are made: the OT client composes what was typed since the last
acknowledgement into one submission, so a burst of typing is one round trip, not one per key.
Then they are kept by the chat's own rules.

| What the status line says | When |
|---|---|
| Saving… | Something typed hasn't been acknowledged yet. Shown only after 400 ms, so quick saves never flicker. |
| Saved | The server has it. A reload, another tab or another device sees it in this chat. |
| Kept | It is the gadget's, for everyone. Fades back to the line's usual content after 1.5 s (`SHOWN_FOR`). |
| Not kept yet · Keep | Someone else is in the workspace, or another chat holds changes to it. Keep is the chat's keep. |
| Offline · Saved on this device | The connection is down. Edits wait in the client and are sent in order when it is back. |
| Couldn't save · Try again | A submission was refused for good (see below). |

**When it is kept.** By `acceptsAlone` and `proposesOnlyCode`, the rules already in
`autoAccept.ts`, at the first of these: 3 seconds after the last edit, leaving the code, closing
the pane or page, or ⌘S. A binding or a template update the chat proposes still waits for the Keep
changes card, as it does for the agent, and holds back the whole keep.

**History stays readable.** Each keep is a commit, so a session of edits makes several. History
groups consecutive keeps from one chat by one person within ten minutes into one entry, "Edited by
Ada · 6 saves", which opens to show them all. The chat's title names the entry: a chat made only
for editing is titled "Edits to Counter" (`setChatTitle`).

**Undo.** ⌘Z undoes your own edits only, never someone else's or the agent's. Remote changes enter
the editor outside its history, so undo never takes away what you didn't do. Undo still works
after a keep, because a keep doesn't move what's on screen.

**When a submission is refused for good.** A revert, a discarded draft or a stopped turn ends the
chat's stream, and unacknowledged edits can't be applied to what replaced it. The OT client then
rebuilds, and the editor says so in place: "Your last few edits couldn't be saved, because the
chat's changes were undone. Copy them". Copy puts the lost text on the clipboard as a diff. Nothing
is dropped without a trace.

## The preview

The running gadget reloads from the chat's code as edits are acknowledged, coalescing a burst into
one reload (`GadgetConnection` already does both). Craft on top:

- **Waits for a pause.** About 500 ms after the last edit that changed what the UI or server
  builds from. Editing README.md doesn't reload anything.
- **The last good page stays.** A failed build leaves the gadget as it was, with a thin bar along
  the preview's top: "Couldn't build. client.ts, line 42". The bar opens that line.
- **Errors sit on the line.** The server's message is parsed for file and line and drawn as a
  squiggle there, with the message on hover and in the gutter. It clears on the next good build.
- **What the page logs is next to the code.** Console errors and uncaught exceptions the frame
  reports (`GadgetFrameRoot`, already reported by the frame's root) are counted in the status line.
  Each opens at its line, with "Ask the agent to fix this", which quotes the error and the lines
  into the composer.
- **State survives where it can.** A reload starts the page over. The server side keeps its data,
  so only what the page held in memory goes, as it does on every reload today.

## While the agent works

- The editor is read only from the turn's first step to its end (the server refuses edits then).
  The status line says "Agent is editing…", and the cursor stays where you left it.
- The agent's `writeFile` and `editFile` stream into the file as they are written, from the
  edit-preview events `ChatSession` already receives, drawn as main draws them: typed in, with
  the changed range lit, and the final row replacing the preview without a flash.
- **Follow.** The file being written opens, unless you went to another file during this turn,
  which means you're reading something and are left there. A small "Agent is in styles.css" in
  the status line goes to it.
- Stop in the composer stops the turn, as it does today, and the editor is yours again.
- Typing at a read-only editor shows, once per turn, a hint in place: "You can edit when the agent
  is done, or Stop it."

## Files

The tree beside the code (`CodeFileTree`) gains everything below. Every action is in a row's ⋯
menu and its right-click menu, and has a key. Names are always edited in place in the tree, never
in a dialog.

**New file** (+ in the tree's header, ⌘⌥N). A row appears for a name, in the folder of the
selected file, or the folder that is selected. A name with `/` makes the folders it names
("components/Button.tsx"). Enter creates it and opens it empty with the cursor in it. Escape or
clicking away with nothing typed takes the row back. The language is the extension's, and a few
get a starting line: `.md` gets a heading with the file's name, and `.css` and `.ts` get nothing.

**New folder** (⌘⌥⇧N). Git doesn't keep empty folders, so a new folder is a name row that becomes
a folder holding a new file row, focused, for the first file in it. A folder abandoned with no
file goes, and nothing is said, since nothing was made.

**Rename** (Enter on macOS, F2 elsewhere, or double-click a name). The name is selected without
its extension, so typing replaces only the stem. A `/` or `..` moves it (main's
`resolveRenamePath`). Renaming a folder renames every file in it as one change. Open editors
follow the rename, and their scroll, selection and undo history come too.

**Move** (drag in the tree). A drop on a folder moves into it, and holding over a closed folder
for 600 ms opens it. A drop between rows moves to that row's folder. A line shows where it will
land, and Escape cancels a drag. Several files can be selected (⌘-click, ⇧-click) and moved or
deleted together, as one change.

**Duplicate** (⌘D in the tree). "styles copy.css", named in place straight away.

**Delete** (⌘⌫). Done at once, with "Deleted styles.css · Undo" in the status line until the
next action. Undo puts the file back as it was, as one more change. A folder with files asks first,
in place, "Delete components and its 4 files?", because Undo for many is easy to miss.

**Discard changes** (on a changed file). Puts it back as it is kept: the kept text as a `set`, or
a `remove` for a file that isn't kept. Asked first only if it would throw away more than a few
lines.

**Download** a file, and **Download all** as a zip from the tree's ⋯, which the browser builds.

**Upload or drop in** text files from the desktop: onto the tree, into the folder under the
pointer. Binary files are refused for a gadget, saying why and what to do instead: "Gadgets keep
text only. Add images as SVG, or ask the agent to draw it." A worktree takes them (`uploadBlob`
and `setBytes`).

**Guards, each said where it happens, never in a toast:**

| Case | What happens |
|---|---|
| The name is taken | The row's field turns red: "There's already a styles.css here." Enter does nothing. |
| An empty or invalid name (`/` at the ends, `..` above the root, control characters, past 1024 characters) | The field says what is wrong: "A name can't end with /". |
| A different case only, `App.tsx` to `app.tsx` | Allowed, as one change. |
| Deleting the gadget's last file | Not offered: "A gadget needs at least one file." |
| Deleting or renaming what the gadget starts from (`client.ts`/`client.js`, `server.ts`/`server.js`) | Allowed, with a caution first: "Counter starts from client.ts. Without it, it won't open." |
| Renaming an executable (a worktree's script) | Not offered, with a tooltip saying why: a change can't carry a file's mode, so the new file would lose it (main's rule). |
| A symlink or submodule (worktrees) | Listed with its kind, and opens a note instead of an editor. |
| The file is changed by someone else while it's being renamed | The rename takes what the chat holds now (as main does), and is refused if the new name has since been taken. |
| The agent is working | Every action is out of use, with the same hint as typing. |

## Changes and history

- **Changes** leads the tree while there are any: each file that differs from what is kept, with
  a dot for changed, added or deleted, and who changed it (you, the agent, or someone by their
  avatar). Choosing one shows it as a diff against what is kept, in the layout chosen today
  (unified or side by side), and editable on its new side.
- **History** stays as it is, gaining the grouping above and authorship by name and avatar.
- **Restore this version** on a history entry sets every file to how it was then, as one change
  in the chat, so the result is reviewed and kept like any other edit and is itself undoable. It's
  computed with `diffFiles` from the commit's tree to what the chat holds now. No kernel change is
  needed.
- **Compare** any entry with now, or with another entry, from its ⋯.

## For people who aren't engineers

- **Ask about this** (⌘L, and in the right-click menu of a selection or a line): quotes the lines
  into the composer, using the reply quote the app already has, with the file and lines named.
- **Ask the agent to fix this** on every build error and logged error.
- **Swatches** beside CSS colours and colour literals in code: click to pick, drag to try.
  **Numbers** in CSS can be scrubbed with ⌥-drag. Both are single edits, so they undo in one step.
- **README.md opens as a document**, rendered, with Edit to see its Markdown, since that's the
  file a person is most likely to read.
- **What a file is for**, where the README says (a "Files" section listing them), shows under its
  name in the tree on hover.
- **Plain words for errors.** The server's own message is kept, and led by a sentence for a person:
  "Something in client.ts, line 42, isn't finished: a bracket may be missing."

## For developers

- ⌘P quick open (have), ⌘⇧F search in all files, with replace, over the gadget's files (which are
  small, so read whole once and kept by commit like today's reads), ⌘⇧O go to a symbol in the file
  (from the parser's tree), ⌘G go to line (have), find (have).
- Multiple cursors, ⌥↑/⌥↓ to move lines, ⌘/ to comment, indent from the file
  (`detectIndent`, have), brackets closed and matched, and auto-indent on Enter.
- Completion from the file's words and the language's keywords, and for `env.` the gadget's own
  bindings by name (`listBindings`, as the settings page reads them).
- Later, and only if it can be quick: TypeScript diagnostics and completion in a worker, with the
  gadget runtime's types. This is optional, and comes in its own phase, since it is the one heavy
  thing here.
- Format document (⇧⌥F) with Prettier in a worker, loaded the first time it's asked for. It is
  never run on save, since that would rewrite what someone else is typing in.
- The key list is in the status line's ⋯ and on `?`, so nobody has to remember a key to find it.

## Details that make it feel made

- The caret, the selection and the scroll per file survive a flip to the gadget and back, a
  reload, and a rename (today's `memoryKey`, extended to the selection).
- A remote edit above the caret never moves what you're looking at: the scroll anchors to the line
  under the caret.
- Line numbers in the gutter link, as today. With a selection, Copy link names its lines.
- The tree's rows for changed files use the same marks as the Changes group, so there's no second
  legend.
- New, renamed and moved rows slide to where they now sort rather than jumping, with reduced motion
  respected.
- The cursor is a block in the editor's colour while it is read only, and a line while it isn't,
  so locked is legible at a glance without a banner.
- A paste of a whole file into an empty new file takes its language from the content when the
  name has no extension.
- Tabs show where a file is indented with them, and spaces otherwise: never mixed on Enter.
- Every action names itself to a screen reader ("Renamed styles.css to theme.css"), and the tree is
  a tree to assistive technology, as `CodeFileTree` already is.
- Dark mode is the theme's code tokens, as today. The swatches show a checkerboard under
  transparency.

## Built how

- **Port, don't rewrite:** `otClient.ts` and its tests into `src/code/`, `workpieceTree.ts`'s
  rename and status helpers into `blocks/codeTree.ts`, and the `EditSession` contract from main's
  `CodeEditor.tsx` (local edits out, remote edits patched in, outside history) into ours.
- **`chat/ChatCode.ts`** (plain and tested, like `ChatSession`): one OT client per chat,
  fed by `ChatSession`'s metadata, change rows and edit previews, which it already receives.
  It exposes a chat's files, statuses, lock state and save state as a snapshot, so the editor, the
  tree, the status line and the gadget pane read one source.
- **`gadgets/useCodeEdits.ts`:** the file actions above as one place that builds `CodeChange`s,
  so each guard is written once and tested once.
- **`CodeEditor`** gains `editable`, an `EditSession`, error marks, the swatch and number widgets,
  and remote-authorship marks, all as CodeMirror extensions loaded only when editing.
- **Mock and gallery:** the `output` scenario gets an editable chat over `MockOverseer` with a
  scripted collaborator and agent, and the gallery gets each state in the tables above.

## In phases

1. **Edit beside a chat:** the OT client, an editable CodeEditor, saving states, keep by the
   rules, the lock and follow during turns, and errors on the line. This removes the plan's "Code
   is read only" sacrifice.
2. **Files:** new, rename, move, duplicate, delete with undo, discard, download, and every guard.
3. **The page split and the bridges:** side by side on the gadget's page, Ask about this,
   fix-this, swatches and numbers, and README as a document.
4. **Developer depth:** search across files, symbols, completion for bindings, Format, and
   restore and compare in history.
5. **If it earns its place:** TypeScript in a worker.

Each phase ships whole, with its states, tests and gallery entries, and leaves nothing
half-visible.

## What this gives up without kernel changes

| Gap | Why | Kernel change that would close it |
|---|---|---|
| No binary files in a gadget | `setBytes` is for worktrees | byte state for gadgets, with the runtime able to serve it |
| No one else's cursor or selection, only what they changed | the change stream has no presence | a presence channel on the chat |
| Each keep is a commit, grouped only in our history | `mergeChanges` always commits | squashing a chat's keeps, or a commit message per keep |
| A file's mode can't survive a rename | a `CodeChange` has no mode | a mode on `set` |
| Edits from a gadget's own page need a chat to go into (below) | there are no empty chats | an editing session without a message, or `newChat` with none |

## Open question: edits from a gadget's own page

Beside a chat, edits go into that chat. On a gadget's own page there is no chat, and `newChat`
needs a first message. The options:

- **A. Recommended: the chat is made when there is something to keep.** The code is editable at
  once. Edits are held in the OT client, and also on the device so a reload loses nothing, until
  the first of these:
  - Chat (from the gadget-to-chat header) and a message: the edits go with the first message, as
    connections added before it already do.
  - A keep (the 3 s pause, leaving, or ⌘S): the chat is made with the model off
    (`newChat(…, null)`), its one line saying what you did, "Edited client.ts and styles.css",
    and titled "Edits to Counter". Then it is kept.

  The chat lists as one more of the workspace's chats: a true record of who changed what, which
  history names. Later edits on the page go into the same chat while it is the last one to have
  them, so a session is one chat, not many.
- **B. Read only on its own page,** with Edit leading to Chat. It's simpler, but it is a detour
  for the typo case, and that case matters most.
- **C. Ask for the kernel change** (an editing session without a message) and do A's experience
  without the made-up line. This is the right end state, as a later request.

A is kernel-free, honest about what happened, and closest to C, so moving to C later changes only
where the first line comes from.
