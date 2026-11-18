# A gadget's asks, where the gadget is

## The problem

A gadget connected to a resource asks before it changes anything outside its workspace: ticking
a task off adds a line to a Google Doc only once someone allows it. In a chat that works, because
the chat shows what its agent asks. Using the gadget on its own, beside a chat, as its page or in
full screen, nothing showed. The action waited, the gadget seemed broken, and nobody knew why.

## What the backend does and doesn't do

- An action a gadget takes outside any chat has no `chatId`. It waits in the workspace's action
  log, and no chat feed shows it.
- `ActionLogEntry` names the gatekeeper, the resource and the chat, but not the gadget or the
  person whose use raised it. The only way to tie an ask to a gadget is through what the gadget
  reaches: its bindings' targets (`listBindings()`), and agent chats whose `spawnerId` is one of
  them.
- Someone who can only use a gadget (`role === 'use'`) gets an empty action log and can't decide
  anything. What their use raises waits for the workspace's members, and they aren't told.
- `setAutoApprovedActionKind` is per gatekeeper for the whole workspace, not per gadget, and its
  rules stop applying once the workspace holds restricted data.
- An action a rule allows is pending for a moment before the server lets it through.
- There are no notifications for asks, and no waiting count on `OutputSummary`. Seeing what waits
  in another workspace means opening it.

## The design

**A dock over the gadget's foot.** `aside/GadgetAskDock.tsx` (UI in `blocks/GadgetAsk.tsx`) sits
inside the gadget's surface in `AsidePane`. That one place covers it beside a chat, as its page and
in full screen. It appears only once something has been asked. It reads "Q3 platform review is
asking · 3", and it folds to that line. Asks are grouped by kind and resource ("Append to
document · Q3 notes · 2 changes · asked 3 hours ago"), always by the resource's title and never by
a binding's name. Each group has Don't allow, Only this time and Always allow. A kind the gatekeeper
won't auto-approve gets Allow alone and says it "asks every time". A creation gets Allow…, which
opens the same form the chat uses. Details shows each request in full, opened by default in a
restricted workspace, where Always allow is withheld and a note says why.

**Which asks are the gadget's.** An ask counts when it is pending and either comes from one of the
gadget's agents, or went through one of its targets with no chat. When the gadget sits beside a
chat that is in sight, asks from that chat are left to the chat's own feed. On a phone, or as a
page, the chat isn't in sight, so the dock shows those too (`gadgets/askGroups.ts`).

**Live, with a hold.** `gadgets/GadgetAsks.ts` subscribes to the workspace's actions before it
lists them, pages through what is pending, and holds new arrivals back for a second, so something
a rule lets through never flashes up. It reads the chats again when an ask comes from an unknown
chat (a new agent), and the bindings again when one comes through an unknown gatekeeper. It reopens
a lost workspace with backoff. Approvals go oldest first and denials newest first.

**Always allow, with Undo.** Always allow sets the rule, then approves whatever the server hadn't
already let through. A notice says plainly what it means: "Append to document in Q3 notes won't be
asked about again in this workspace." For eight seconds it offers Undo, which removes the rule.

**While you're elsewhere.** `gadgets/WaitingAsks.ts` keeps a count per gadget. Open gadgets report
theirs live. The others are found by a sweep over the workspaces you build in (not those you only
use), three at a time. It runs 3s after load, on returning to the tab after five minutes, and on
opening the Library if the last sweep is a minute old. A sweep never overwrites a live count. The
sidebar's Library row shows the total. The Library's rows and cards show "N waiting" for each
gadget, so the gadget is one click away and its dock does the rest.

## Gaps

- Who raised an ask isn't known, so the dock never says "Ana's use asked".
- Someone who only uses a gadget is told nothing about what their use is waiting on, and the owner
  hears of it only through the counts.
- Two gadgets connected to the same resource both show an ask that came through it outside any chat.
- The sweep opens each workspace, which wakes it. Asks raised while you're away show only after the
  next sweep.
- A chat-less ask through a gatekeeper that no gadget binds is shown nowhere.
- Always allow covers the whole workspace's use of that resource, not only this gadget's.

## Kernel changes that would close them

- `gadgetId` and an initiator on `ActionLogEntry`, for exact attribution and "who asked".
- A waiting count on `OutputSummary`, or a subscription across workspaces, in place of the sweep.
- A read-only view of their own pending asks for use-only sessions.
- Notifications for a gadget's asks.
- Per-gadget auto-approval rules.
