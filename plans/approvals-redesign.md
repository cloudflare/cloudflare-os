# Approvals redesign: drafts you can see, and a mode you choose

Status: proposal, nothing built. Draws on `pjones/prototype-gatekeeper-ui-google` (file previews,
review bar) and on how the current queue, simulation and auto-approve work.

## What goes wrong today

- **Edits look done when they aren't.** The agent writes to a Google Doc and carries on reading
  its own simulated text. The user sees "Done" in the chat and finds the real doc unchanged.
- **Approving is a chore.** One card per API call: 20 edits means 20 Approve clicks, in order,
  since the Docs connection refuses an edit whose predecessor is still waiting. The header
  popover shows 3 at a time. Old/New are two blobs with no diff, so people approve blind.
- **The escape hatch is hidden and too wide.** "Always approve" is found after the fact and
  creates a permanent rule for that connection's whole kind ("Document edits"), across every
  chat and app in the workspace, while the dialog names only the one action.
- **Automations stall silently.** A scheduled run's edits wait for someone who isn't coming.
  Nothing notifies, and the next run builds on the unapproved draft.
- **Two activity surfaces, neither in context.** The chat header's pulse dropdown and the
  chat's Activity tab both show the whole workspace's queue, not this chat's.

The idea behind simulation is right: **the agent never has to stop for you, and nothing reaches
the outside world until you say so.** What's missing is that the user is never shown the draft as
a draft, or given one obvious place, and one obvious moment, to decide.

## How other tools handle this

| Product | Pattern | What we take |
|---|---|---|
| Claude Code | Permission modes in the input (ask / accept edits / plan / auto, with a classifier in auto) | A **mode chosen per conversation, in the composer**, that the user can see and change at any time |
| Codex, Cursor, Copilot agent | "Suggest / auto-edit / full auto"; per-session "Allow for this session" | **Session-scoped** allowances, not permanent workspace rules |
| Google Docs | Suggesting mode, accept/reject on the page, "Accept all" | **Review on the thing itself**, with all changes accepted at once |
| GitHub PR | One review of many commits | **One decision per turn**, not per call |
| Gmail | Undo send, scheduled send | Outward actions (send, share, delete) get a **hold or undo**, never silent |
| ChatGPT agent / Operator | Confirms before consequential actions and pauses for takeover | Only **consequential** actions interrupt; reversible ones flow |

## The model, in the user's words

> "Every chat has a mode, shown next to Send. **Review** means it drafts and I approve at the
> end. **Auto** means it just does things, and only asks before anything it can't take back."

### 1. The approval mode lives in the composer

```
┌──────────────────────────────────────────────────────────────┐
│ Ask anything…                                                │
│                                                              │
│ ＋   ⓘ Review changes ▾                                  (↑) │
└──────────────────────────────────────────────────────────────┘
        ┌────────────────────────────────────────────────┐
        │ ✓ Review changes                               │
        │   Drafts edits and messages. You approve them  │
        │   when it's done.                              │
        │   Auto                                         │
        │   Makes changes as it goes. Still asks before  │
        │   sending, sharing or deleting.                │
        │   Auto, judged by AI              (later)      │
        │   An AI reviewer approves what's clearly in    │
        │   line with your request and asks about the    │
        │   rest.                                        │
        └────────────────────────────────────────────────┘
```

- It is per chat and remembered with the chat. The default comes from a user setting, Review to
  start, and the admin can cap it per connection.
- **Auto** applies actions whose gatekeeper says `autoApprovable: true` (edits, appends, labels).
  `autoApprovable: false` actions (send an email, share a file, delete, pay) still stop and ask,
  as `awaitDecision` does today. It reuses the existing verdict; no gatekeeper changes.
- Restricted workspaces (`containsRestrictedData`) show the control locked to Review and say why.
- This replaces "Always approve" on individual cards. Rules become "this chat is on Auto", which
  is visible, scoped and easy to undo. The workspace-wide per-kind rules remain in settings for
  admins and power users.

### 2. A draft looks like a draft

The agent's writes in Review mode are **drafts**. The word "simulated" never reaches the user.

- In the chat, at the end of a turn, one card for everything the turn drafted:

```
┌ Drafted, not applied yet ───────────────────────────────────┐
│ 📄 Q4 Plan                         7 edits      Review ›    │
│ ✉  Email to Alex Kim               "Launch moved…" Review › │
│                                                             │
│                          [ Discard ]  [ Apply all ]         │
└─────────────────────────────────────────────────────────────┘
```

- The agent says so too. The branch's `waitingForApprovalNote()` makes its replies read
  "I've drafted 7 edits to Q4 Plan for you to apply", never "Done".
- The composer gets a quiet chip while drafts wait: `● 2 drafts waiting · Review`.
- Under the hood, **Apply all** is one RPC that approves the turn's actions in order (see
  Kernel). It doesn't take 20 clicks, and it can't fail on ordering.

### 3. Review on the file, not on a list

Clicking **Review ›** opens the file in the side pane, drawn as it will be: the branch's renderers
for Docs (suggestion marks), Sheets (changed cells with previous values) and Slides (filmstrip
plus canvas), restyled to our pane chrome.

```
┌ 📄 Q4 Plan  · Draft         Open in Google Docs ↗    ✕ ┐
│                                                        │
│   Q4 Plan                                              │
│   Revenue grew ~~8%~~ 12% over Q3…                     │
│   ▌New: Hiring plan                                    │
│                                                        │
│        ┌─────────────────────────────────────────┐     │
│        │ ‹ 3 of 7 ›   Keep   Undo     Apply all   │     │
│        └─────────────────────────────────────────┘     │
└────────────────────────────────────────────────────────┘
```

- Emails render as an email (to, subject, body) with Send and Discard. Things that can't be drawn
  fall back to the branch's word-diff rows.
- Undoing one edit redraws the file. Edits that depended on it are marked "no longer applies", as
  the Docs connection already decides.

### 4. Google files are things in the Library

People think of a Google Doc the way they think of an app or an uploaded file. Any external file a
chat reads, creates or edits (from the action log's `subject`) is a Library item with its app
icon:

- in the chat's Library tab, the workspace's Library and the global Library;
- opening it shows the same pane: the live file, plus any drafts on it;
- "Open in Google Docs" is always one click away.

This is the branch's `workspaceFiles` and `FilePane`, moved into the new Library and pane rather
than the old Outputs shelf.

### 5. Automations say what happens without you

When an automation is set up (in chat, or in its card), it states its mode:

```
Monday ocean fun fact                                   [on]
Runs Mondays at 9:00 · Makes changes on its own        ▾
                         ├ Makes changes on its own
                         └ Drafts changes for me to review
```

- "Makes changes on its own" is Auto for that run's chat.
- "Drafts for review" holds changes **and notifies** ("Ocean digest drafted 1 email · Review").
  Today unattended drafts notify nobody.
- Later runs of a held automation see the draft as a draft (the agent is told it's pending) or
  wait. They never treat it as done.

### 6. Activity becomes history

- **Remove the chat header's pulse dropdown.** Decisions happen in the chat card and the pane;
  the header keeps presence only.
- Chat details → Activity shows **this chat's** history: what was applied, by whom, and whether
  it was automatic.
- Workspace → Activity shows everything, including a "Waiting" filter for admins and anything
  orphaned (a deleted chat's drafts, a gadget's own actions).
- App panes get a small tray when the app has waiting drafts (the branch's `PendingChangesTray`).

## "Auto, judged by AI" (later)

The third mode adds a reviewer model between the agent and the queue. It is planned for now, not
built now.

- On each `autoApprovable: false` action in this mode, the overseer asks a small model on Workers
  AI: given the user's request in this turn and the action's description, is this clearly what
  they asked for? Answers are `apply`, `ask` or `ask-with-reason`.
- It can only approve **less** than the user could themselves. Restricted data, `awaitDecision`
  with a manual gate, and admin caps always ask. Anything uncertain asks.
- Each AI decision is logged with its reason ("Sent: you asked to email Alex the summary").
  History shows them, and the user can turn the mode off.
- Kernel shape: a `decideAction(action, context) → "apply" | "ask"` hook in the drainer. Auto mode
  is the version that answers "apply" iff `autoApprovable`; the AI mode adds a model call. It
  needs a threat review first: the action description is gatekeeper-written, but its contents
  are attacker-influenced.

## Kernel changes (small, separable PRs)

1. **Chat approval mode.** `AiChatMetadata.approvalMode?: "review" | "auto"`, set by
   `Overseer.setChatApprovalMode(chatId, mode)`. `autoApprovalRule` also accepts when the
   caller's chat is in Auto and the action is `autoApprovable`. Workspace rules keep working.
2. **Approve a turn.** `Overseer.approveActions(ids)` / `rejectActions(ids)`, applied in id order
   and stopping at the first failure. Also `ActionLogEntry.turn?` (the turn's starting sequence),
   so the chat can group a turn's drafts.
3. **Agent knows drafts are drafts.** Port `waitingForApprovalNote()` from the branch.
4. **Unattended drafts notify.** A `draftsWaiting` notification kind when a callback, spawned or
   hook turn ends with pending actions in Review mode.
5. **Previews.** Port `Gatekeeper.previewResource?(subject)` and `ResourcePreview`, plus the
   Docs/Sheets/Slides preview builders, from the branch. Make previews available to build-role
   members, not owner only, and replace its `TypeError` string-matching with a declared
   capability.
6. Later: the `decideAction` hook and the AI reviewer.

## Frontend work

- Composer mode control, the turn draft card, the drafts chip, the email draft view.
- Port the `resource-preview` renderers and `ReviewBar` into `PaneSheet`, restyled with Kumo
  tokens. The branch's Google theme stays scoped to the drawn page only.
- Library: external files as items, from action-log subjects.
- Remove `ActivityNotifications` from the chat header, scope the chat's Activity tab to the chat,
  and drop the per-card "Always approve".
- Automation card: the "without you" mode line.

## Order

1. Turn card + Apply all + agent wording (kernel 2, 3). This is the biggest relief for the least
   change.
2. Composer mode, Auto (kernel 1) + remove the header dropdown.
3. File previews in the pane + Library items (kernel 5).
4. Automations' mode + notifications (kernel 4).
5. AI reviewer (kernel 6), after a threat review.

## Open questions

- Should Auto be the default for chats with no connections that write? Probably Review stays the
  default, and the composer control only appears once a chat has a writing connection.
- Should Review mode's drafts expire? Gmail drafts don't; a stale Doc edit fails its revision
  check anyway.
- Should a member's Auto chat be able to act through the owner's connections? Today the auto
  rule's `enabledBy` carries authority; a chat mode should carry the authority of whoever set it.
