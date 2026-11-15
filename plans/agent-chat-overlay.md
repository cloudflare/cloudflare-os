# Plan: Showing a spawned agent's chat over the working chat

## Problem

The Workshop has one selected chat (`?chat=` in the URL, `effectiveSelectedChatId` in
`GadgetEditor`), and the whole gadget pane follows it:

- the drafts it lists;
- the preview's `chatId`;
- Connections' provisional bindings;
- the export;
- console-log routing;
- the code view, whose `ChatOtClient` sends the user's edits with `submitCodeChange(chatId, …)`.

Opening a spawned agent's chat makes it the selected chat, which causes two problems:

1. **The draft disappears.** Say you're testing a draft gadget in chat N and it calls
   `host.openAgentChat()`. `navigateToChat()` leaves N, so the draft you were testing disappears
   from the pane. The same happens when you open a run from the chat list's Agents tab.
2. **Your gadget edits are filed under the agent.** With a spawned chat selected, edits you make
   in the code view are submitted to that chat. A spawned agent can't edit a gadget's code
   (`assertMayModifyWorkpiece` in `agent.ts` lets it modify only worktrees), so this attributes to
   it work it could never have done. The kernel accepts the edit because `submitCodeChange` checks
   only that the chat exists.

## Idea

Split the selected chat into two:

- **The working chat** is the regular chat you're working in, or none (mainline). It is never a
  spawned chat. The gadget pane follows it, as it follows the selected chat today.
- **The agent chat** is a spawned chat shown in the chat pane over the working chat. Opening one
  leaves the working chat alone. Closing it brings the working chat back.

The chat pane shows the agent chat if there is one, otherwise the working chat. The pane never
treats the agent chat as the chat a gadget belongs to.

**One exception: worktrees.** A spawned agent can create worktrees and edit them. A worktree
belongs to its chat for its whole life, so an agent chat's worktrees appear in the pane while that
chat is open. When one of them is selected, the code view works in the agent chat. That's
correct: those edits really are on that chat's branch. A gadget is never owned by a spawned chat,
so this can never put a gadget frame in the agent chat.

As a rule, **the pane's chat is the selected workpiece's own chat if it has one (a draft or a
worktree), and otherwise the working chat.**

## Design

### Route state

- Add `agent?: number` to `GadgetSearch` (`routes/workspace.$id.tsx`) beside `chat`.
  - `chat` keeps its meaning for everything already reading it, and a spawned chat never goes
    there.
  - Keeping this in the URL means a reload keeps the agent chat open, and the browser's Back
    closes it.
- **Normalization.** Once the chat list is known, `GadgetEditor` corrects the URL, replacing
  rather than pushing:
  - A spawned chat in `chat` moves to `agent`, with no working chat. This covers notification
    links (`NotificationBridge`, `UnreadThreads`), which name a chat with `chat=`, and old URLs.
  - A regular chat in `agent` moves to `chat`.
  - An `agent` naming a deleted chat is dropped.
  - "Spawned" means `spawnerName` is set. `agentList.ts` already uses that test.
  - `ChatInterface` reports the chat list itself (`onChatListChange`, which replaces the token
    report). `GadgetEditor` derives the tokens and which chats are spawned in one synchronous
    callback, into a ref. A gadget's `openAgentChat()` can find its token in the very report
    that first lists the chat, and must already know then that the chat is spawned.

### `GadgetEditor`

- **Navigation.** `navigateToChat(chatId)` checks what kind of chat `chatId` is:
  - **Spawned chat:** set `agent=chatId` and leave `chat` and `w` alone. No pending app is left,
    so the pane stays as it is.
  - **Regular chat, or `null`:** set `chat` and clear `agent`, exactly as today (including leaving
    a pending app).
  - **Back with an agent chat open:** clears only `agent`. That returns you to the working chat,
    or to the list if there is none.
  - Every caller goes through this one function:
    - the chat list;
    - the Agents tab's `onOpenRun`;
    - `AgentRunsPane`;
    - `host.openAgentChat()`'s `showChat`.

    So all of them open a spawned chat over the working chat. `ChatInterface` calls
    `onNavigateToChat(null)` after its own chat is deleted; that clears `agent` if the deleted chat
    was the agent chat.
- **Chat ids.** Rename `effectiveSelectedChatId` to `workingChatId` (the URL's `chat`, plus
  today's chat-0 pinning) and add:
  - `agentChatId`, the URL's `agent`;
  - `shownChatId = agentChatId ?? workingChatId`, which goes to `ChatInterface` as
    `selectedChatId` and to `reportVisibleChat`;
  - `paneChatId = selectedWorkpieceSummary?.chatId ?? workingChatId`.
- **Workpieces.** `visibleWorkpieces` becomes the visible gadgets, plus the working chat's
  worktrees, plus the agent chat's worktrees. Picking another chat's worktree in the rail already
  navigates to that chat (`handleSelectWorkpiece`, which sets the URL itself). For a spawned
  chat's worktree, that now opens the chat over the working chat. Picking a permanent gadget
  leaves the agent chat open.
- **What follows the working chat:**
  - `visibleGadgets` and `pendingGadgetIds`;
  - auto-opening a newly created app;
  - `previewChatId` (and with it the `GadgetUI` frame and the export);
  - console logs, both the buffer reset and server-log routing.

  Only a regular chat can create a gadget, so none of this can change once an agent chat is open.
- **What follows the pane chat:**
  - the code view's `selectedChatId`;
  - Connections' `chatId`;
  - streaming-file tracking;
  - agent activity, which drives the pane's progress bar and the turn's tab auto-switch.

  When a gadget is selected, the pane chat is the working chat. It is the agent chat only while
  one of that chat's worktrees is selected.
- **Console logs.** The log chip sits in the composer. It is passed to `ChatInterface` only while
  the working chat is shown, so gadget logs never offer themselves to a spawned agent. The buffer
  stays intact and shows again when you return to the working chat.

### `ChatInterface`

- New prop: `codeChatId?: number | null`, the chat the code view follows (`paneChatId`). It
  defaults to `selectedChatId`, so other hosts (`GadgetUseView`) don't change.
- The derivations that feed the gadget pane, rather than the transcript, switch from
  `selectedChatId` to `codeChatId`:
  - `onChatChangesChange`;
  - `currentLiveRows` and `currentLiveEditPreviews`;
  - `onStreamingActiveFileChange`;
  - `onSelectedChatProposedChangesChange`;
  - `onAgentActiveChange`. It reads the code chat's `activeAgent` from the chat cache; with no
    code chat it keeps today's "any chat active".

  This works because the subscription already covers every chat, and the cache keeps each loaded
  chat's messages and change rows by id.
- **Loading history.** The history-loading effect also loads `codeChatId`'s tail page if it isn't
  cached. Otherwise, after a reload at `?chat=N&agent=M`, N's changes never load and the code view
  stays empty.
- **What stays on `selectedChatId`:**
  - the transcript and the composer;
  - `viewChat`;
  - read receipts;
  - the chat's own accept/discard banner, so a spawned agent's worktree changes are still accepted
    from its chat;
  - `chatContent` matching, which falls back to no reader when the shown chat isn't the code chat,
    as it does today for any chat whose code isn't open.
- **The agent chat's header.** Its Back button is titled for where it goes: "Back to
  ‹working chat title›", or "Back to conversations" when there is no working chat. Nothing else in
  the header changes. `ChatInterface` can't infer the destination, because the code chat is the
  agent chat itself while one of its worktrees is selected. So `GadgetEditor` passes it in as
  `returnChatId`.

### Kernel

The frontend fix makes the bug impossible from the Workshop. The kernel also refuses, for a
spawned chat:

- a `submitCodeChange` that touches a non-worktree workpiece;
- `createGadget(…, chatId)`;
- `bind` with a `chatId` (and so `bindWithSuggestedName`, which binds through it).

This mirrors `assertMayModifyWorkpiece`, so a spawned chat can't hold gadget changes no matter
which client sent them. It is a few lines in `overseer.ts`, plus the API doc notes on those methods.

## Existing data

Spawned chats that already hold user gadget edits (from the bug) keep them. They still appear in
that chat's accept/discard banner, so the user can accept or discard them from the chat. After
this change the pane no longer previews them, which is correct: that preview was the bug.

## Commits

1. **Kernel:** refuse gadget changes and provisional bindings on spawned chats.
2. **Workshop:**
   - the `agent` route parameter and normalization;
   - the chat index's spawned set;
   - `GadgetEditor`'s ids and navigation;
   - `ChatInterface`'s `codeChatId` and history loading;
   - the Back label.

This is independent of `openAgentChat()`; the same bug happens when you open a run from the
Agents tab. It lands with `openAgentChat()`, which is what makes it pressing.

## Tests

- **`GadgetEditor`:**
  - Opening a spawned chat (from the list, `onOpenRun`, or `host.openAgentChat`) keeps `chat` and
    `w`. The draft stays in the pane, and `GadgetUI` keeps its `chatId`.
  - With an agent chat open, the code view and Connections still get the working chat.
  - Selecting the agent chat's worktree gives the code view the agent chat.
  - Back clears only `agent`.
  - Normalization moves a spawned `chat` to `agent` and a regular `agent` to `chat`.
  - The console-log chip isn't passed while an agent chat is shown, and comes back afterwards.
- **`ChatInterface`:**
  - With `codeChatId` ≠ `selectedChatId`, the code feeds report the code chat while the
    transcript shows the selected one.
  - The code chat's history loads when it isn't cached.
- **Kernel (if done):** `submitCodeChange` to a spawned chat succeeds for its worktree and is
  refused for a gadget. `createGadget` and `bind` with a spawned `chatId` are refused.
- **Manual:**
  - Test a draft whose button calls `openAgentChat()`: the draft stays in the pane and Back
    returns to its chat.
  - Edit the gadget's code with an agent chat open: the edit lands in the working chat.

## Open questions

- **Should notification links preserve the working chat?** A notification for a spawned chat's
  approval replaces the URL with `chat=M`, which normalizes to `agent=M` with no working chat, so
  a draft you were testing still drops out. Today that happens for every chat. Keeping it would
  mean the notification navigating with the current `chat` kept, which is a change to
  `NotificationBridge` that could follow separately.
