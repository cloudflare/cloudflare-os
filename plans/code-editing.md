# Editing a gadget's code

How a gadget's code is edited in the new app, evolving from today's read-only View code, with no
kernel changes. Few people will edit code by hand; most ask the agent. This is for parity with the
old Workshop, and for the few who do, so it is kept simple and made to fit the journey that is
already there rather than to add one.

## Decisions

- **Saving is explicit.** Edits are a draft on this device until Save. Discard throws the draft
  away. Nothing is ever saved on its own, so a half-typed change never reaches a gadget someone is
  using. ⌘S saves.
- **A save is a chat's keep.** The backend only changes a gadget's code through a chat
  (`submitCodeChange`, then `mergeChanges`, as main's Workshop does). Beside a chat, Save goes
  into that chat, which records it ("dev saved edits") and whose agent then sees it. On a gadget's
  own page there is no chat, so the first Save makes one, with the agent off
  (`newChat(message, null)`): its one line is what was done, "Edited client.ts and styles.css",
  and it is titled "Edits to Counter" (`setChatTitle`), which is also how the save reads in
  history ("Accept changes from chat: Edits to Counter"). Later saves of that gadget on this
  device reuse the chat while it is the last one made for it, so one session of edits is one chat.
- **A save is whole files.** The draft is sent as one change of `set` and `remove`, never
  keystroke by keystroke, so there is no live co-editing and no port of main's OT client. What
  others change meanwhile is checked for before saving (Conflicts, below).
- **The gadget shows a save once it is kept.** The running gadget reloads when its head moves,
  as it already does. A draft is not previewed: Save to see it run.

## When code can be edited

View code is editable for whoever can build in the workspace (`role !== 'use'`), when all of
these hold:

- The agent of the chat it is beside is not working. Otherwise the editor is read only, and the
  status line says "You can edit when the agent is done."
- That chat proposes nothing not yet kept. Saving keeps everything a chat proposes, so it must hold
  only the draft. Otherwise: "This chat has changes that aren't kept yet. Keep or discard them in
  the chat to edit here."
- It is the code as it is now, not a past version from history. Comparing is read only.

The line under the editor says which. When none of these hold, the editor and the file actions
are simply there, with no mode to enter.

## The draft

- Held per gadget for as long as the app is open (`gadgets/codeDrafts.ts`, plain and tested), so
  flipping back to the gadget, going to another page or opening it elsewhere keeps it. Closing the
  tab or reloading with a draft asks first (`beforeunload`).
- It records the commit it was started from (its base) and, for each file it touches, the text
  then and the text now, or that the file was deleted.
- A file edited back to how it was stops being a change. The draft with no changes is no draft.
- The tree marks each changed file with a dot: changed, added or deleted (struck through, still
  listed until saved, and opened read only).
- The status line has the draft's state at its end, in place of "Kept 5 min ago": "3 unsaved
  changes", then Discard and Save (primary). Discard asks in place, "Discard your changes to 3
  files?", and puts every file back as it was.
- Undo (⌘Z) and Redo work per file, and keep their history while the draft lasts.

## Saving

1. Read the gadget's head. If it is still the draft's base, go on.
2. If it moved (someone kept changes meanwhile), compare each file the draft touches at the base
   and at the new head:
   - None differ: the draft moves onto the new head, and the save goes on.
   - Some differ: nothing is saved. In place: "Counter was changed while you were editing:
     styles.css." It offers **Save mine anyway**, which saves those files as the draft has them,
     over the other change, and **Discard mine**.
3. Find the chat: the one it is beside, or the own page's (made now if need be).
4. Submit the draft as one change, declaring a pin at the base for the gadget unless the chat has
   one already, then keep the chat's changes. If the keep is refused as stale (someone kept in
   between), go back to step 2 once.
5. Saved: the draft goes, the status line says "Saved" for a moment, history gains the save, and
   the gadget reloads.
6. A failure says why under the status line, and the draft stays, with Save again.

## Files

Every action is in each row's ⋯ menu in the tree (`CodeFileTree`). New file is a + in the tree's
header. Names are typed in place in the tree, never in a dialog. Each action changes the draft
only, so all of them are undone by Discard and saved by Save.

- **New file:** a row for its name, in the folder of the file shown. A name with `/` makes the
  folders it names ("components/Button.tsx"). Enter makes it, empty, and opens it. Escape, or
  leaving it empty, takes the row away. There is no New folder: git keeps no empty folders, and a
  folder comes with its first file this way.
- **Rename:** the name is edited in place, selected without its extension. A `/` or `..` moves it
  (main's `resolveRenamePath`). Its edits come with it.
- **Duplicate:** "styles copy.css", made and put into renaming.
- **Delete:** at once, as a deleted file in the draft that can be brought back from its ⋯
  (Restore) or by Discard.
- **Restore** (a changed file's ⋯): puts that one file back as it was.

Guards, each said in the row's field or the status line:

| Case | What happens |
|---|---|
| The name is taken | "There's already a styles.css here." Enter does nothing. |
| An empty or invalid name (`/` at the ends, `..` above the top, control characters, over 1024 characters) | What is wrong, in the field: "A name can't end with /". |
| A different case only | Allowed. |
| Deleting the last file | Not offered: "A gadget needs at least one file." |
| Deleting or renaming what it starts from (`client.*`, `server.*` at the top) | Allowed, with a caution in the menu item's detail: "Counter starts from it". |
| Renaming an executable, a symlink or a submodule | Not offered: a change can't carry a file's mode, so it would be lost. |
| A file whose text isn't readable | Can be deleted, not edited or renamed. |
| Editing isn't possible now (above) | The actions are out of use, with the same line. |

## Details

- The caret, selection and scroll per file survive flipping to the gadget and back (the
  editor's `memoryKey`).
- Find, go to line, quick open, folding, indentation guides and the theme's colours are as today.
  Editing adds undo history, closing brackets, auto-indent on Enter, Tab to indent (Escape then Tab
  leaves the editor), and ⌘/ to comment.
- Unsaved files are marked in quick open (⌘P) too.
- A screen reader hears each action named: "Renamed styles.css to theme.css".
- On a phone the same, in the narrow layout `CodeBrowser` already has.

## What this gives up without kernel changes

| Gap | Why | Kernel change that would close it |
|---|---|---|
| A save on a gadget's own page makes a chat with a line written for the user | there are no empty chats | an edit session without a message, or `newChat` without one |
| No binary files in a gadget | `setBytes` is for worktrees | byte state for gadgets |
| A draft is not previewed running | the gadget builds from a chat or its head | a preview from a client's draft |
| A worktree's code is read only still | its edits are its agent's | none needed, only the same work over its accepted commit |

## Later, if people use it

Live co-editing (port main's OT client), drag to move, search across files, a preview of the
draft, and asking the agent about selected lines.
