# Plan: Forking reality — branches of pending gatekeeper actions

Status: implemented. Part 2, at the end, replaces part 1's rules and holding, so where the two
differ, part 2 describes what the code does.

## Summary

Today every connection (gatekeeper facet) has one stream of pending actions. Every chat and gadget
on the connection sees every pending action simulated, and the user approves actions one at a time.

This plan gives each chat its own **branch**: a private stream of pending changes on top of the
real world.

- A session sees only its own branch's actions simulated. Two chats on one connection interfere no
  more than two chats in separate workspaces: each sees the other's work only once it is applied,
  as a change to the real resource.
- A branch is accepted as a unit. "Accept changes" merges the chat's code *and* applies its pending
  actions. The user can still deny individual actions first.
- Gatekeepers apply a branch in one call, `applyActions(branch, actions)`, strictly in order.
  It replaces `applyAction()`. An action is only ever skipped by being rejected first.
- Auto-approval moves to the end of the agent's turn: if everything pending on the branch is
  auto-approvable, the branch is accepted then.
- A gadget runs on the chat's branch when the chat has diverged or the agent invoked it. Otherwise
  its actions go to **staging**, the pending actions that belong to no chat, which normally apply
  immediately.
- Every chat is built on staging: it sees whatever staging holds, and accepting it applies that
  first.
- To hold a gadget's actions for review, a user runs it in a chat, which need not have an agent.
  Where the system must hold them itself, staging holds them.
- gatekeeper-kit carries the new obligations. A gatekeeper author does not handle branches.

The gatekeeper interface carries fork lineage from the start, so forking a chat later needs no
second gatekeeper migration.

## Scope

Gatekeepers exist outside this repository, so this plan changes none of them.

- **This plan:** the kernel (`workshop-backend`, `workshop-shared`), the Workshop UI and
  gatekeeper-kit. Every existing gatekeeper keeps working, unchanged, against the new kernel, and
  a gatekeeper written against today's kit keeps working against the new kit.
- **Afterwards, separately:** each gatekeeper adopts the new interface.
- **Last:** the compatibility shims are removed. "Compatibility with existing gatekeepers" lists
  them.

What users get at each stage:

- **After this plan:** the new approval model, for every gatekeeper. Accepting a chat applies that
  chat's actions; deny is per action; auto-approval runs at the end of the turn; staged actions
  apply at once. Chats are not yet isolated: an unchanged gatekeeper still simulates one shared
  stream.
- **As each gatekeeper adopts:** isolation between branches and batch apply, for that gatekeeper.

## Decisions

Settled:

- **`applyActions()` takes the view and the list of actions to apply.** The list is complete up
  to the last action it names, so a gatekeeper may work from the view and the list's bounds
  instead of from each action.
- **No gatekeeper changes in this plan.** The kernel and the kit stay compatible with existing
  gatekeepers until they are updated separately.
- **The kit carries the complexity**, so gatekeeper authors do not.
- **Holding by choice belongs to a chat thread**, not the workspace.
- **Pending actions that belong to no chat are "staging"**, a special thing and not a chat, and
  every chat's simulation reflects them.
- **A gatekeeper adopts branches as a whole**, not one code path at a time. Implementing
  `applyActions()` is the declaration, and a gatekeeper that has it needs no `applyAction()`.

To confirm. Each is argued in the section named.

1. **Apply stops at the first failure, with no exceptions.** A gatekeeper never applies past a
   failed action, even one it believes is unrelated. See "Applying a branch".
2. **The kernel, not the gatekeeper, reconciles mismatches**, from the IDs a call reports applied
   and a durable mark it sets before each call. See "Applying a branch".
3. **`rejectAction()` reports the other actions it had to reject with it**, so that denying a
   failed action and retrying takes one step. See "Applying a branch".
4. **Actions that cannot be simulated (`awaitDecision`) keep an individual decision.** Approving
   one applies that connection's branch up to and including it, and "always approve" rules fire for
   it mid-turn as they do today. See "Actions that cannot be simulated".
5. **Staging applies everything at once**, including actions whose author set
   `autoApprovable: false`, actions a hook firing caused, and actions a `use` collaborator caused.
   Restricted-data mode imposes holding. See "Staging". *Confirmed:* `autoApprovable: false` means
   an agent must never do it without a person's sign-off, but a gadget a person operates involves
   no agent, and approving what you just clicked ("send email") again is needless friction. So such
   a gadget's actions are never reviewed unless the person opted in by holding.
6. **Accept applies actions first, then merges code, and is not atomic.** See "Accepting a branch".
7. **A staged action that fails stays pending and holds what is behind it**, as on a branch,
   except that one that can never apply is rejected automatically, unless the provider may have
   applied it anyway. See "Staging".
8. **An agent invoking a gadget restarts it onto the chat's branch**, because a gadget has one
   facet. This adds restarts until gadget facets fork. See "Gadgets".
9. **Accepting a chat applies what staging holds on the chat's connections first**, instead of
   merging the chat into staging and leaving it pending. See "Staging".
10. **Later, gatekeepers with their own action store are ported onto the kit's journal** instead
   of each implementing the new contract. See "Afterwards: updating gatekeepers".

## Background: what exists today

### Kernel

- **One facet per connection.** `gatekeeper${id}` holds the connection's journal and simulation
  state, shared by every chat, gadget, hook and user.
- **One session per binding call.** `GatekeeperLoopback` calls `startGatekeeperSession()`, which
  builds a fresh `ApprovalQueueImpl` and calls `facet.startSession(queue)`.
- **The kernel already knows the submitting chat; the gatekeeper does not.** Each queue carries a
  `GatekeeperCaller` (`{from: "agent", chatId}`, `{from: "gadget", chatId?, gadgetId?}`,
  `{from: "user", chatId?}`, `{from: "hook", gadgetId?}`), recorded on `ActionRecord.caller`. The
  `ApprovalQueue` interface exposes only `getExecutionId()`.
- **Two ID spaces.** The kernel's `ActionRecord.id` is workspace-wide. The gatekeeper's own integer
  is stored as `ActionRecord.action` and passed back to `applyAction()` and `rejectAction()`.
- **Actions have three states:** `pending`, `approved`, `rejected`. A failed apply throws to the
  caller and leaves the record `pending`; nothing records the error.
- **Approval is per action.** `approveAction()` calls `applyPendingAction()`, which calls
  `gatekeeper.applyAction(id, cache)` with a `GitCache` stub scoped to that one action. Manual
  approval enforces no order. "Apply all" and "Discard all" are client-side loops
  (`useBulkResolve`).
- **Auto-approval runs at submit.** `autoApprovalRule()` needs the action's `autoApprovable`, a
  user rule for its `actionKind.tag` on that connection, and no restricted-data latch. The drainer
  applies eligible actions per connection in ID order and stops at the first manual gate.
- **`awaitDecision` suspends the agent's turn** until the action is approved or denied, unless a
  rule applies it first.
- **Accept is code only.** `mergeChanges(chatId)` is all-or-nothing, fast-forward only (`"stale"`
  otherwise), refused while the agent runs, and never touches actions. Discard is
  `revertChanges(chatId, 0)`.
- **Two things the gatekeeper contract promises that the kernel does not do.** It discards
  `rejectAction()`'s `{restart}` result, and it never calls `revertAction()`.
- **Stranded records.** Deleting a chat leaves its pending actions. Removing a connection leaves
  its pending actions `pending`, though nothing can decide them.

### Gadgets

- **A gadget has one facet and one storage.** A "chat-specific instance" is that same facet,
  restarted with the chat's code and an env whose caller carries the `chatId`.
  `#getGadgetFacetRaw()` aborts the facet whenever the requested variant differs from the running
  one, so a mainline viewer and a chat preview restart each other.
- **A chat's variant is used only when the chat proposes changes to that gadget**
  (`#resolveGadgetChatId()`; the frontend's `previewChatId` applies the same rule).
- **Consequence:** when an agent invokes a gadget its chat has not edited, the gadget runs as
  mainline and the actions it submits carry no `chatId`.

### Gatekeepers

- **One linear stream per facet.** IDs come from one counter; simulation replays every pending
  action; nothing is keyed by session, chat or execution.
- **Kit-based:** Sheets, Slides, Drive, the three Microsoft gatekeepers, X, PagerDuty.
- **Hand-rolled journals:** GitHub, GitLab, Gmail, Docs edits, Google Calendar, Google Chat,
  Notion, Linear, Confluence, Spotify, Home Assistant.
- **No simulation (`awaitDecision`):** Supabase, ZoomInfo, the MCP gatekeepers.
- **Order is enforced unevenly.** Docs requires facet-wide order; Sheets, Slides and Drive require
  per-file order; Chat per conversation; GitHub and GitLab chain pushes by compare-and-swap; the
  rest check provisional-ID dependencies only.
- **Every gatekeeper stores an action before calling `submitAction()`, and most make it visible
  at once.** The kernel can throw from `submitAction()` as a refusal, and then never calls
  `rejectAction()`. Every gatekeeper deletes the record when that happens, but they differ in what
  the record did meanwhile (audited; see "Submitting an action"):
  - The kit and Spotify store it `staged`, which no read projects, and promote it once
    `submitAction()` returns.
  - Gmail, Docs edits, Google Calendar, Google Chat, Notion, Confluence, Linear and Home Assistant
    store it live. A concurrent read simulates it, and another action can be built on it, while
    `submitAction()` is awaited. A crash in that window leaves it simulated forever: the kernel
    holds nothing, so nobody can deny it.
  - GitHub and GitLab have a `staged` state but mishandle the race with an early apply.
- **Each apply makes one provider write.** Batch endpoints (Docs/Sheets/Slides `batchUpdate`,
  Gmail `batchModify`, Graph `$batch`, multi-ref receive-pack) are used within one action at most.
- **`docs/observers.md` accepts a leak this plan closes:** content one chat queues in an action
  reaches other chats through simulation before it is approved.
- **`plans/gatekeeper-kit.md` reserved a follow-up**, the batch `applyActionsThrough` contract.
  This plan supersedes it.

## Concepts

- **Branch.** A chat's stream of changes that have been made but not applied to the real world:
  pending gatekeeper actions and proposed code changes. Identified by an opaque `BranchId` the
  kernel mints.
- **Chat branch.** Every chat has one, for its whole life. Accepting it empties it; later work
  refills the same branch.
- **Staging.** One per workspace: the pending actions that are on no branch, submitted by
  mainline gadgets, hook firings and other sessions with no chat. They normally apply as soon as
  they are submitted, so staging is normally empty. Every chat branch is built on it.
- **View.** What a session sees: staging, then, once chats can fork, a prefix of each ancestor
  chat, then its own branch. Reads are the real resource with the view's pending actions replayed
  over it in that order.
- **Accept / discard.** Accepting applies the branch to the real world. Discarding rejects its
  pending actions and reverts its code.

Chat branches do not see each other. Each sees the real world and staging.
Once a branch is applied, every other branch sees its effects as real changes. A pending action
that no longer fits (the paragraph it edits is gone, the push is no longer a fast-forward) fails
when its own branch is accepted, exactly as it would across two workspaces.

### Where a session's actions go

| Session | Caller today | Its actions join |
|---|---|---|
| Agent `executeCode` binding | `{from: "agent", chatId}` | the chat's |
| Gadget loaded as a chat's variant | `{from: "gadget", chatId, gadgetId}` | the chat's |
| Gadget loaded as mainline | `{from: "gadget", gadgetId}` | staging (no branch) |
| Hook firing | `{from: "hook"}` | staging (no branch) |
| Slash command in a chat (reads only) | `{from: "user", chatId}` | the chat's |
| Workshop UI session | `{from: "user"}` | staging (no branch) |

A gadget held in a chat by choice is loaded as that chat's variant, so the second row covers it
(see "Holding").

The branch is a function of the caller the kernel already records, so `ActionRecord` needs no new
field until forks exist. A new sparse index, `pendingByBranch`, replaces the scans that
`pendingByGatekeeper` serves today.

## Gatekeeper interface

All additions are in `packages/workshop-shared/src/gatekeeper.ts`. The kernel is always upgraded
before any gatekeeper, as with observer tracking, so no gatekeeper needs to handle an older kernel.

### Telling the gatekeeper its branch

```ts
/** Names a chat's stream of submitted, not-yet-applied actions. Opaque: compare by equality. */
export type BranchId = string;

/** Which pending actions a session sees simulated, and where its own actions go. */
export type BranchView = {
  /**
   * The branch actions submitted through this session join, or null when they join no branch:
   * they are staged.
   */
  branch: BranchId | null;

  /**
   * Branches this one was forked from, nearest first. The session also sees each one's actions
   * whose ID is at most `through`. Absent for a branch that was never forked.
   */
  ancestors?: {branch: BranchId, through: number}[];
};

export interface Gatekeeper<Session> extends DurableObject {
  /** … `branch` is the view the session reads through, fixed for its life. */
  startSession(approvalQueue: RpcStub<ApprovalQueue>, branch: BranchView): Promise<Session>;
}

export interface HookInitiator<Hook extends RpcTarget> extends WorkerEntrypoint {
  startHook(): Promise<{
    callback: RpcStub<Hook>, approvalQueue: RpcStub<ApprovalQueue>,
    /** The view the firing reads through. */
    branch: BranchView,
  }>;
}

export interface ObservationAuthorizer extends RpcTarget {
  /** The view this authorizer's holder reads through; the same one it was handed. */
  getBranch(): Promise<BranchView>;
}
```

**Staged actions are special, and the interface says so.** A staged action is one submitted
with `branch: null`. Three rules apply to it and to nothing else:

1. **Every view sees it.** Staging is not listed in a view; it is always there.
2. **It comes first.** A view's **order** is the staged actions, then the branch's and its
   ancestors' actions, each group in ID order. Simulation replays in that order, and the kernel
   lists actions for `applyActions()` in it. A staged action therefore precedes a chat's action
   even when it was submitted later.
3. **It builds on nothing but other staged actions.** A staged action never sees a branch's
   actions, so it cannot depend on one.

A pending action submitted on branch `b` with ID `n` is then **visible** in a view when `b` is
null, or `b` is the view's `branch`, or some ancestor has `branch === b` and `through >= n`.

Null, and not a reserved name, because staged actions are on no branch. A gatekeeper has nothing
to compare against and no string to get wrong.

What a gatekeeper has to do differently for staged actions follows from the three rules:

- **Simulate them in every session**, ahead of the session's own branch.
- **Refresh simulated state when staging changes.** A chat's simulated state depends on staging
  as well as on its own branch, so anything cached from it is stale when a staged action is
  submitted, applied or rejected.
- **Let a denial reach across branches.** Denying a staged action can strand actions on any
  branch, and they are reported in `rejected`.

The kit does the first and third, and its session handle returns pending actions already in
order, so an author sees none of this (see "gatekeeper-kit: where the complexity lives").

A fork needs no such rule: an ancestor's inherited actions all have lower IDs than the fork's
own, so ID order is already right.

**The view is handed over with the queue**, so a session never spends a call to learn it. A
session starts on every binding call, which makes an extra round trip per session an extra round
trip per call.

- `startSession()` takes it as a second argument.
- `startHook()` returns it beside the queue.
- `getBranch()`, beside `getExecutionId()`, remains for code that holds only the authorizer: a
  slash command's `invoke()`, or a helper deep in a gatekeeper that was passed a queue alone.

An existing gatekeeper is unaffected by the new argument. Its `startSession()` declares one
parameter, and the RPC validator drops extra arguments before the method runs (capnweb-validate
documents "Extra argument: Allowed"). Several gatekeepers already rely on this: they declare
`applyAction(actionId)` while the kernel passes a second argument.

A gatekeeper that simulates must then do three things. The kit does the first two for its users,
who never see a `BranchView` (see "gatekeeper-kit: where the complexity lives"):

1. Record the view's `branch` with each action it stores.
2. Replay over a read only the pending actions visible in the reading session's view.
3. Key any cache of *simulated* state by branch. Caches of provider state are unaffected.

A view's `through` values are in the gatekeeper's own ID space, which is why the kernel hands
out the view per connection. Order within a view, and a fork's boundary, rely on a contract that
holds today but is not written down: **a facet's action IDs are unique and increase in the
order `submitAction()` is called.** The kit's submission lane keeps it within a journal.

The kernel logs a submission that breaks it, at no cost in storage reads: it compares against
the last ID each connection submitted, kept in a map in memory. The map starts empty when the
workspace's object restarts, so the check is best effort, which is enough for a log.

### Submitting an action

Simulation is only sound if the gatekeeper and the kernel agree on which actions exist. An action
the gatekeeper simulates but the kernel does not hold is a **phantom**: the agent sees its
results, later actions are built on it, and no user is ever shown it. Which method later applies
the branch cannot repair that. The agreement has to be established at submission.

Today's contract does not say how. The gatekeeper cannot store the action only after
`submitAction()` returns, for two reasons:

- **The ID must exist first.** It is the argument.
- **An apply can outrun the reply.** The kernel may call back for the action before the
  gatekeeper sees `submitAction()` return. Today that is the auto-approval drain; under this plan
  it is every staged action.

So the record must be durable before the call, but inert. The contract, to be written into
`ApprovalQueue.submitAction()`'s documentation:

1. **Store before submitting, in a state nothing reads.** Until rule 2 holds, the action is not
   simulated, no other action may depend on it, and nothing derived from it is returned to a
   caller.
2. **It becomes visible when `submitAction()` returns, or when the kernel shows it holds it:** a
   `rejectAction()` naming it, an `applyActions()` whose list names it, or `holdsAction()`
   answering yes.
3. **If `submitAction()` throws, the kernel may still have recorded the action** and lost only
   the reply. Unless rule 2 already made the record visible, the gatekeeper asks `holdsAction()`.
   If the kernel does not hold the action, it was not accepted: delete the record, and whatever
   was created for it. The kernel will not call `rejectAction()`. With no answer, the record
   stays unread for rule 4.
4. **An unconfirmed record found when the facet starts, or left by rule 3, stays unread until it
   is settled.** Its caller saw the submission fail, but the kernel may have recorded it. The
   gatekeeper asks as soon as it has a queue to ask through, which is the next session to start
   (`ApprovalQueue.holdsAction()`), and that session neither reads nor submits until the answer
   is in. The record becomes visible if the kernel holds the action, and is deleted if it does
   not. If the kernel names it first, rule 2 settles it.

```ts
export interface ApprovalQueue extends ObservationAuthorizer {
  /**
   * Whether the kernel recorded the action this connection submitted as `action`. For settling
   * a record whose `submitAction()` call was cut off by a restart, so that the gatekeeper never
   * learned whether it was accepted.
   */
  holdsAction(action: number): Promise<boolean>;
}
```

With these rules, everything a gatekeeper simulates is something the kernel holds.

**Nothing is inferred from IDs.** An unconfirmed record becomes visible only when the kernel
names that action. So the contract does not depend on a gatekeeper submitting one action at a
time, and two stores on one facet need not coordinate. The kit serializes submissions per
journal today and goes on doing so.

**Why rule 4 keeps the record and asks**, instead of deleting it. One crash can leave the kernel
holding an action the gatekeeper is unsure of: the kernel records the submission and replies, and
the facet dies before it sees the reply. Then:

- **The kernel may already be applying it.** A staged action is applied at once. If the restart
  deleted the record, the repeated apply would name an action the gatekeeper no longer has, and
  the kernel, having marked it as attempted, would record it as applied (see "Applying a
  branch"). Kept, the record is named by that apply, confirmed and applied.
- **The kernel shows it as pending.** Until the gatekeeper learns that, it leaves the action out
  of simulation. The agent's call failed, so it may try again, not see the first action, and
  submit a second. Accepting the chat would then apply both. Asking settles it at the next
  session, where waiting for the apply could take days.

The kit's `stage()` already implements rules 1 to 3.

The kernel's half:

- **A throw means nothing was recorded.** `OverseerImpl.submitAction()` refuses before it writes
  (connection removed, a push in restricted mode, failed push ancestry, a disabled hook, invalid
  arguments). The bookkeeping after its write must not throw. That leaves a broken stub as the
  only ambiguous throw, and then the session is over anyway.
- **The reverse mismatch is settled at apply.** After a lost reply or a crash, the kernel can hold
  an action the gatekeeper deleted. The kernel finds out when an apply names that action and the
  gatekeeper does not report it, and marks it rejected (see "Applying a branch"). Today such an
  action fails every apply until the user denies it, and in Google Chat cannot be denied either.
- **`holdsAction()` answers from what is recorded.** The kernel handles a submission
  synchronously, so it is never part-way through one. A submission still in transit from the
  dead activation can arrive after a "no", though. That is the reverse mismatch again, and is
  settled the same way.

What the audit found against these rules, in gatekeepers as they are today:

| Gatekeepers | Finding |
|---|---|
| Kit-based (Sheets, Slides, Drive, Docs comments, Microsoft, X, PagerDuty), Spotify | Correct. |
| Supabase, ZoomInfo, MCP, the test fixture | Correct: they simulate nothing. |
| Gmail, Docs edits, Google Calendar, Google Chat, Notion, Confluence, Linear, Home Assistant | Break rule 1. Visible during the await; dependents built then are not cleaned up when the parent is refused; a crash leaves a permanent phantom. In Docs it also blocks every later edit, which must apply in order behind it. Home Assistant's window includes a provider round trip. |
| GitHub, GitLab | Break rule 2. An apply or rejection that lands during the await retires the record, and the returning `submitAction()` then rewrites it as pending, so an applied action is simulated again for good and its provisional-to-real binding is erased. This is a bug today, independent of this plan, and is being fixed separately. |

No gatekeeper keeps a record after a clean refusal. The phantoms come from the visibility window
and from crashes. This plan fixes none of these, since it changes no gatekeeper: they are fixed as
each gatekeeper adopts the contract.

Phantoms that past crashes already left in hand-rolled stores are not removed by any of this. If
that matters, the kernel can hand each connection the set of actions it holds, once, at upgrade.

### Knowing which gatekeepers have adopted branches

A gatekeeper adopts branches by implementing `applyActions()`. Nothing else declares it.

- **The kernel looks for the method.** It reads `applyActions` from the facet's stub as a
  property. A missing member should read as `undefined`, as in JavaScript, but Workers RPC
  refuses the read today with `TypeError: The RPC receiver does not implement the method`.
  The kernel accepts both as "not implemented". In the second case it matches the error's
  text, so that no other failure is taken for a missing method. The check goes away with the
  last unconverted gatekeeper.
- **A gatekeeper that has it is fully converted.** Every action it submits is recorded on its
  queue's branch. There is no half-converted gatekeeper, and no flag on an action.
- **The method decides how the whole connection is applied.** With it, every pending action on
  the connection goes through `applyActions()`. Without it, each goes through `applyAction()`.
  A converted gatekeeper needs no `applyAction()`.

**Leftovers.** Actions already pending when a gatekeeper converts were recorded with no branch.

- **The gatekeeper goes on simulating them to every session**, in ID order, ahead of everything
  newer. That is how they were simulated before, and other chats may have built on them.
- **The kernel leaves them where they are:** on the chat that submitted them, or in staging.
  Accepting that chat names them in its list, so the gatekeeper applies them without needing a
  branch for them.
- **They go first in a list, in ID order**, matching how they were simulated. To know which
  actions they are, the kernel records one number per connection: the highest action ID it holds
  there when it first sees `applyActions()`.
- **When the kernel looks.** Once per session, when the session first submits, before recording
  that submission, so that no later action is taken for a leftover. A session that only reads
  pays nothing. It looks again whenever it applies.
- **Until they drain, chats still see each other's leftovers.** That is the behavior every
  unconverted gatekeeper has, kept for those actions only.
- **A leftover is applied only when a list names it.** It belongs to neither of a view's groups
  (see below), so a gatekeeper that works by range still goes by name for leftovers. A chat's
  list does not name another chat's leftovers, though its sessions see them, and a gatekeeper
  that enforces order refuses then, as it does before it converts (shim 3).

### Applying a branch

```ts
export interface Gatekeeper<Session> extends DurableObject {
  /**
   * `actions` were approved: apply them, in the order given.
   *
   * The list is complete. A view's actions fall in two groups: the staged actions, and those
   * on the branch and its ancestors. From each group, the list names every action the kernel
   * holds pending with an ID up to the highest it names there. A gatekeeper may therefore work
   * from the view and those two bounds instead of from each action: an action it knows the
   * kernel accepted (`submitAction()` returned) that falls within them is on the list.
   *
   * Every action named is one the kernel holds, so naming it confirms it (see
   * `ApprovalQueue.submitAction()`). A record still waiting for its `submitAction()` reply is
   * applied if the list names it and left alone if not. An action named here that the
   * gatekeeper does not hold is left out of the result.
   *
   * Implementing this method is how a gatekeeper declares that it has adopted branches: every
   * action it submits is recorded on its queue's branch, and the kernel applies every pending
   * action on the connection through this method.
   *
   * Stop at the first action that cannot be applied, and report it. Nothing after it may be
   * applied: later actions are often built on earlier ones, and an action is only ever skipped
   * by being rejected (`rejectAction()`), never by being passed over.
   *
   * May return before the end of the list, with no failure, to bound the call's duration. The
   * kernel calls again with what is left, as long as a call applied something. A call that
   * applies nothing and reports no failure says nothing in the list is left to apply.
   *
   * Throwing tells the kernel nothing about what was applied, and it will call again. A repeated
   * call applies whatever is still pending and must not repeat an effect.
   *
   * `cache.buildPack(actions)` builds one pack for the pushes of the actions it names, which
   * must be among this call's.
   */
  applyActions?(branch: BranchView, actions: number[], cache: RpcStub<GitCache>)
      : Promise<ApplyActionsResult>;

  /**
   * @deprecated Applies one action. Called only for a gatekeeper that does not implement
   * `applyActions()`.
   */
  applyAction?(action: number, cache: RpcStub<GitCache>): Promise<void>;

  /**
   * … `rejected` lists other pending actions that can no longer be applied without this one
   * and were rejected along with it.
   */
  rejectAction(action: number): Promise<void | {restart?: boolean, rejected?: number[]}>;
}

/** What a call to `Gatekeeper.applyActions()` did. */
export type ApplyActionsResult = {
  /** The actions this call applied, in the order applied. */
  applied: number[];

  /**
   * Present when the call stopped at an action it could not apply. Every later action in the
   * list was left unapplied because of it.
   */
  failed?: {
    action: number,
    /** Shown to the user. */
    message: string,
    /** False when applying again cannot succeed, so the action can only be denied. */
    retryable: boolean,
    /**
     * The provider may have applied it anyway (a timeout, say). Comes with `retryable: false`, and
     * a later call naming it reports the same failure without attempting it again.
     */
    outcomeUnknown?: true,
  };
};
```

**Both apply methods are optional.** A gatekeeper implements one of them: `applyActions()` once
it has converted, `applyAction()` until then. The types do not require one or the other: the
state is temporary, and ends when `applyAction()` is removed.

**Why a list.**

- **Naming is confirming.** The list says exactly which actions the kernel holds. Nothing is
  inferred from an ID, so the method does not depend on how a gatekeeper orders or serializes
  its submissions.
- **Nothing is passed over.** Actions apply in order, and an action is skipped only by being
  rejected first. The kernel promises a complete list, so a gatekeeper has nothing to validate.
- **One call covers staging and the chat.** Staging goes first, whatever its IDs. Take a chat
  with actions 10 and 12 pending while staging holds 13: approving 10 is the list `[13, 10]`.
- **It covers actions the gatekeeper has no branch for.** Leftovers are named like any other.
- **The kernel already has it.** Accepting a branch snapshots and claims the actions it will
  apply. The list is that snapshot.

**Why the view comes with it.** Some gatekeepers will find a range easier to reason about than
individual actions. The view and the list's bounds give them one:

- **The bounds.** For `[13, 10]` they are "staged actions up to 13" and "the branch's actions up
  to 10".
- **What a gatekeeper may assume.** An action it knows the kernel accepted, inside the bounds, is
  on the list. If it is not, that is a bug in the kernel. No gatekeeper is expected to check for
  it.
- **What still needs the list.** Whether a record that is waiting for its `submitAction()` reply
  was accepted. A range cannot say, and a staged action is routinely applied before its reply
  arrives.

**What the kernel owes for that assumption to hold.**

- **Bounds are by ID, not by time.** An action submitted after the kernel took the list has a
  higher ID than anything in its group, so it is outside the bounds and applies later. That
  includes a staged action submitted while a chat's accept is under way: it does not go ahead
  of the chat's remaining actions. Staging comes first when a list is taken, and an apply
  already under way is not reordered.
- **An accepted action leaves the pending set only through the gatekeeper.** The kernel marks it
  approved from an apply's result, and rejected once `rejectAction()` has returned for it or has
  named it in `rejected`. It does this today: `rejectAction()` records the rejection after the
  gatekeeper's call returns.

**Failure.** A failed action stops the branch on that connection. `failed` is how the gatekeeper
reports that everything after it was left unapplied on its account. The kernel records the error
on that action, and the UI shows the later ones as waiting on it. The user has two ways forward:

- **Fix the cause and retry.** The same call is made again and resumes at the failed action.
- **Deny the failed action**, then retry. `rejectAction()` reports, in `rejected`, any other
  pending actions that could not be applied without it. The kernel marks those rejected too, so
  the retry does not stop again at each dependent in turn. Today a gatekeeper retires such
  dependents silently and the Workshop goes on showing them as pending.

A gatekeeper may not apply an action past a failure even when it believes the two are unrelated
(decision 1). Allowing it would mean a branch can end up applied in an order nobody reviewed, and
every gatekeeper would need its own notion of "unrelated".

**Reconciliation is the kernel's job.** The gatekeeper reports only what a call did. From that the
kernel settles each action it named:

- **Reported in `applied`:** approved.
- **Reported in `failed`:** stays pending, with the error.
- **After the point the call reached**, in the list: stays pending.
- **Before that point, and not reported:** the gatekeeper does not hold it as pending. There are
  two possible reasons, and the kernel tells them apart with a durable mark it sets on every
  action it names before each call and clears when the call's result is recorded:
  - **The mark was already there when this call began**, left by an earlier call whose result
    was lost to a crash or a throw. The action was applied by that call. Approved.
  - **Otherwise** the gatekeeper never kept it (see "Submitting an action"). Rejected.

"The point the call reached" is the failed action, or else the last action in `applied`, or else
the end of the list when the call applied nothing.

The mark shows only that a call was made, so the first inference holds only if a gatekeeper never
drops an action the kernel may be applying. Rule 4 of the submission contract is what ensures
that: a restart keeps an unconfirmed record, so a repeated call finds the action still pending,
applies it and reports it.

One case is settled wrongly: an action the gatekeeper dropped although the kernel recorded it,
whose first apply call then loses its result, is recorded as applied. The gatekeeper drops such
an action only when `holdsAction()` was answered just before the kernel's write. It takes two
independent faults on one action.

**What batching buys.** A gatekeeper may coalesce: several Docs edits into one `batchUpdate`,
label changes into one `batchModify`, several refs into one receive-pack. The early-return rule
bounds each RPC's duration and gives the UI progress ("Applying 120 of 500").

**`GitCache` changes.**

- `buildPack(actions?: number[])`. On the stub passed to `applyActions()` the argument is required
  and names actions from the call's list; several pushes can then share one pack.
- The read view of a session's `getGitCache()` is "on the remote, or queued for push by a pending
  action". The second half becomes "by a pending action visible in this session's view".
  `pendingPush` marks already name the kernel action, which names its branch. A leftover's push
  stays visible to every session, as the leftover is.

**Unchanged.** `rejectAction(action)` stays per action: it is the line-item veto, and discarding a
branch calls it newest first. `revertAction()` is untouched. Batch rejection is a possible later
optimization.

**Honoring `restart`.** `rejectAction()`'s `{restart: true}` means later simulated work was built
on the denied action. The kernel discards it today. With branches it has a precise target, so the
kernel should act on it: restart the gadget variants running on that branch, and tell the agent in
its next turn that the action was denied.

## Kernel

### Accepting a branch

`mergeChanges(chatId)` keeps its name, so `pnpm cf-os api … merge-changes` keeps working. It
becomes "accept the chat's branch":

1. **Check, as today.** Refuse while the agent is active, materialize draft changes, and return
   `"stale"` if mainline has moved. Nothing has been applied yet.
2. **Snapshot the pending actions to apply** and claim them (`claimDecision`): the chat's own,
   and what staging holds on each connection the chat has an action on. For each connection they
   form one list, in the order they apply: leftovers by ID, then staged actions, then the chat's.
   Refuse if a pending creation has no approval (see "Creations").
3. **Apply them, one connection at a time**, ordered by each connection's earliest pending action.
   Within a connection: the creation; then `applyActions(view, list)`, repeated with what is
   left while it makes progress. A gatekeeper that has not converted gets one `applyAction()`
   per action instead, in ID order. Each applied action is recorded as approved, with its push
   marks converted, in the same transaction as today.
4. **Stop at the first failure.** Later actions and other connections are not attempted, the code
   is not merged, and the result is `"failed"`.
5. **Merge the code**, in the existing synchronous section, after revalidating heads. If mainline
   moved during step 3, return `"stale"`: the actions are applied, and the retry merges only code.

```ts
export type MergeChangesResult = {
  /** … "failed": an action could not be applied; see ActionLogEntry.applyError. */
  outcome: "merged" | "stale" | "failed";
};
```

**Not atomic.** External effects cannot be rolled back, so a failed accept leaves the branch
partly applied. Actions go first because they are the part that can fail for outside reasons,
while the code merge is local and was checked in step 1. The user then fixes the cause and
retries, or denies the failed action and retries.

**Order across connections.** Each connection's own order is exact. Across connections only the
order of first actions is kept, so that a connection's actions can go in one call. No gatekeeper
depends on another's pending actions today.

**Failures are recorded.** `ActionRecord` gains
`applyError?: {message, retryable, outcomeUnknown?}`, cleared on success and delivered on
`ActionLogEntry`. An accept that nobody is watching, such as auto-approval at the end of a turn,
then still shows what went wrong. A staged action rejected
for failing keeps its error too. The UI shows later pending actions on the same
connection and branch as waiting on the failed one.

**Discard.** `revertChanges(chatId, revertFrom)` also rejects the branch's pending actions whose
chat `action` message is at or after `revertFrom`, newest first. `revertFrom: 0` rejects all of
them, including any with no message yet.

**Two cleanups this makes necessary**, since a stuck action would now block a banner:

- Deleting a chat discards its branch.
- Removing a connection marks its pending actions rejected.

### Auto-approval

Rules, their storage and `autoApprovalRule()` are unchanged. What changes is when they act.

- **At the end of a turn.** If the turn finished normally, the branch proposes no code or binding
  changes, and every pending action on it satisfies `autoApprovalRule()`, the kernel accepts the
  branch as if the user had clicked "Accept changes". Otherwise nothing is applied. Code changes
  count as changes that are never auto-approvable, for now.
- **As the turn's last phase.** The accept runs before the chat goes idle, so no message or turn
  can start during it and `waitForAgent()` returns only once it is done. A stopped, failed or
  waiting turn does not trigger it.
- **When a rule is enabled.** `setAutoApprovedActionKind()` re-runs the check for idle chats, which
  keeps today's "matching pending actions are applied immediately".
- **Not after a denial.** Denying one action never auto-accepts the rest: the user may be midway
  through denying several.
- **Attribution.** Each action records the user who enabled its rule, as today.
- **Restricted-data mode** still disables rules entirely.
- **Holding.** A chat with holding on is never accepted automatically (see "Holding"). Nor is a
  chat whose accept would release something staging is holding (see "Staging").

The per-connection drainer (`AutoApprovalDrainer`) goes away in this plan. Everything it did is
now "apply this connection's branch up to an action", which works for an unconverted
gatekeeper too.

### Actions that cannot be simulated

An `awaitDecision` action is one the gatekeeper cannot simulate: an MCP tool call, arbitrary SQL,
a paid lookup. The agent needs its real result, so it cannot wait inside a fork until the branch is
accepted. Treating it like any other pending action would force the user to accept everything,
half-written code included, each time the agent calls such a tool, and would make "always approve"
useless for MCP connections whenever the chat has code changes.

Recommendation: such an action is the one exception to "no one-by-one approval".

- **Deciding it.** Its card keeps Approve and Deny. Approving applies what staging holds on
  *that connection*, and then that connection's branch up to and including the action. The agent
  issued it against a world where staging and its own earlier actions on that connection had
  happened. For a gatekeeper that simulates nothing, that is just the action itself.
- **Rules.** At submit, if the action and every earlier pending action on that connection's branch
  satisfy `autoApprovalRule()`, they are applied at once and the turn continues. This is today's
  in-order drain, scoped to one branch. A rule never releases what staging is holding (see
  "Staging"), so the action then waits for a user.
- **Everything else** on the branch stays pending for the banner.

`approveAction(id)` remains in the API, and now means "apply staging on this action's connection,
and then its branch on that connection up to and including it", for any pending action. Existing
scripts that call it keep working, and it can no longer apply anything out of order. The UI
offers it only on an awaited action.

### Creations

A `createExternalResource` creation is never auto-approvable: approving it means choosing the
account, and sometimes configuring where the resource goes. It is a pending action on the chat's
branch that needs input before the branch can be accepted.

- The creation's card collects the account and configuration, as `CreationAccountModal` does now.
- `mergeChanges(chatId, {creations})` takes those choices, keyed by action ID. Accept is refused
  while a pending creation has none.
- The creation applies first on its connection (`applyCreation()`), then the actions queued behind
  it, as today.

### Staging

**Staging** is the workspace's pending actions that belong to no chat: what mainline gadgets,
hook firings and other sessions with no chat have submitted and that has not been applied yet.
They are on no branch (`branch: null` in the gatekeeper interface). What makes staging special
is that **every chat is built on it.**

- **Normally it is empty.** A staged action is recorded, and applied as soon as `submitAction()`
  has replied, through the same path as an accept. The gatekeeper still submits and waits for the
  apply call. It is attributed to the workspace owner, with `autoApproved: true`.
- **It holds actions in three situations**, all decided by the kernel, never chosen by a user:
  - **Holding is imposed.** Restricted-data mode, today: otherwise the latch that makes every
    action require review would stop covering gadget actions. Staged actions then wait until a
    `build` user accepts them.
  - **A `use` collaborator may have caused the action.** A gadget's action is held when a `use`
    collaborator has that gadget open, or closed it within the last minute, since a call made
    just before leaving may still be running. The kernel cannot tell whose request a gadget is
    serving, so presence stands in for it, and whoever else is using the gadget then has their
    actions held too. `build` collaborators do not count: they may apply any action themselves.
    The mark is made when the action is submitted and stays until a `build` user decides it. See
    "A known gap" below for what this does not catch.
  - **An earlier staged action on that connection is still pending.** Order is kept in staging
    as on a branch, so later actions wait behind one that failed or is held.
- **A failure.** A staged action whose apply failed stays pending, and is retried the next time
  anything applies on that connection. One the gatekeeper reports as not retryable is rejected
  automatically, along with whatever it reports could not apply without it: nobody is watching
  that apply, and nothing could be done with the action but deny it. The error is kept and a
  notification raised (decision 7). Not one whose outcome is unknown (`outcomeUnknown`): it may
  have been applied, so it stays pending, holding what follows, until a user who has checked the
  provider denies it. The gatekeeper never attempts it again.
- **At upgrade.** Actions already pending with no chat were waiting for a user's review, so they
  are not applied unreviewed: a migration marks them, and staging holds each one, and what follows
  it on its connection, until a user decides it. Accepting staging applies them, and discarding it
  or denying one rejects them; no rule releases them. A chat's accept applies them along with the
  chat's actions, as it does whatever else staging holds on its connections, since its action list
  shows them.
- **No restart.** A gadget does not restart when holding begins or ends: its sessions were
  submitting to staging throughout.
- **Reviewing it.** The gadget view and the Activity page show `build` users what staging holds,
  with accept, per-action deny and discard, as a chat's banner does. `acceptStagedActions()`
  applies it. `use` collaborators see their actions simulated and wait.

**Chats are built on staging.**

- **Every view includes staging.** A session with no chat sees the staged actions. A chat's
  session sees them too, and then the chat's own.
- **Why.** A user talking to an agent that has changed nothing sees the gadget as mainline shows
  it, staged actions included. When the agent submits its first action, the gadget moves to the
  chat's branch. If that branch did not include staging, things the user was looking at would
  vanish.
- **All of staging, as it changes.** A chat sees actions staged after it began, the same way it
  sees the real resource change. This is the rebase, built in: nothing is moved, because staging
  was never copied into the chat.
- **One direction only.** Staged actions never see a chat's actions.
- **Staged first.** In a chat's view, staged actions come before the chat's own, whatever their
  IDs. A chat's action is always treated as made on top of staging as it now stands.

**What that means for accepting a chat.** The chat's actions were simulated on top of staging, so
they do not apply ahead of what staging holds when the accept takes its list. A staged action
submitted after that applies later (see "Applying a branch").

- **Accepting a chat first applies what staging holds on the connections the chat acted on**,
  then the chat's own actions. Staging on other connections is left alone.
- **The reviewer sees it.** The chat's action list shows those staged actions, marked as coming
  from gadgets, and each can be denied like any other.
- **A stuck staged action blocks the chats behind it.** If one fails, the chat's accept stops
  there until it is retried or denied.
- **Auto-approval does not release held staging.** A chat is not accepted automatically, and an
  awaited action is not applied by a rule, while staging is holding anything on a connection
  that would have to apply first.

The alternative to applying staging with the chat is to merge the chat's actions *into* staging
and leave them pending. It is the right answer when the person accepting the chat is not allowed
to release what staging holds. Nothing in this plan creates that situation: in restricted-data
mode, a `build` user reviewing the chat may release staging too. It also needs a way to tell a
gatekeeper that an action has changed branch, which this plan does not add. It belongs with the
permission work below.

What "apply at once" newly allows (decision 5, confirmed):

- **`autoApprovable: false` actions.** The author's verdict gates rules for agents: an agent must
  never take such an action without a person's sign-off. For a staged action it is not consulted:
  no agent is involved, the code was accepted, and the user chose to run it. Asking them to
  approve what they just clicked would be needless friction. A user who wants review holds.
- **Hook-driven actions.** The kernel cannot tell a gadget call caused by a user's click from one
  caused by a hook or an alarm; all are `{from: "gadget"}`.

`use` collaborators are not among them. Their use of a gadget today queues actions for a `build`
user, and applying those at once would let anyone a gadget is shared with act as its owner. So
staging holds a gadget's actions while one is using it (above).

**A known gap.** The user driving a gadget may not have permission to perform its actions, in
which case a user who does is supposed to approve them. The kernel does not track which user
caused a gadget's action, so holding by presence is a stand-in until it does (by carrying the
user through the gadget's async context). It misses an action the gadget takes for a
collaborator after they have been gone a minute, such as a job their click left in the gadget's
storage for a later request or hook firing to carry out. A gadget has no alarms, and a `use`
collaborator cannot enable a hook, so that takes a gadget built to defer work. It also holds more
than it must: the owner's own use of the gadget, and a hook's firing into it, while a
collaborator has it open. And no rule releases a held action, so a shared gadget whose purpose is
to write needs a `build` user to accept each time. When the kernel does track the user, only
that user's actions will be held. Two questions then need answers, and the design leaves both
open without closing off either:

- **Who waits behind a held action.** Everyone sees it simulated, so a permitted user's later
  action on that connection waits behind it, unless staging is split per driving user. A split
  would need the view to name which staging it sees, as an addition to the interface.
- **Who may accept a chat built on it.** Merging into staging, above.

### Holding

There are two kinds, and they are deliberately different things.

**By choice: in a chat.** A `build` user who wants a gadget's actions held, to test or out of
caution, turns holding on in a chat (`AiChatMetadata.holding`).

- While it is on, every gadget opened in that chat runs on the chat's branch, whatever else is
  true of the chat. Its actions wait for that chat to be accepted.
- Any chat will do, including one with no agent (`newChat(message, null, mode)`), for a user who only
  wants somewhere to hold changes. The gadget view offers this directly: "Hold changes" creates
  such a chat, turns holding on, and opens the gadget in it.
- Turning it off sends the gadget back to mainline once the chat's branch is empty. Until then
  its pending actions keep it on the branch.
- A chat with holding on is never accepted automatically, whatever rules are enabled.

This is how code changes already work: each thread carries its own change, and one user's
caution holds nobody else's actions.

**Imposed: in staging.** When the kernel must hold what gadgets do outside any chat, staging
holds it (above). It is not a chat. Every request with no chat already submits to staging, so
nothing has to be routed anywhere or restarted, and there is no conversation for a chat to be.

### Gadgets

A gadget still has one facet. What changes is which variant a request selects, and that a variant
now means "code plus branch", not just code.

A request for gadget G in chat C's context runs **on C's branch** when any of these is true:

1. C proposes changes to G (today's rule).
2. C's branch has pending gatekeeper actions.
3. An agent turn in C has invoked G, until that turn ends.
4. Holding is on in C.

Otherwise it runs mainline code and submits to staging. A request with no chat context always
does.

- **Rule 2** is the request's "chat-specific instance when the chat has pending actions": the
  variant's env carries the chat, so its reads see the branch and its actions join it.
- **Rule 3** makes actions triggered through an agent's `env.GADGET.rpc` call part of the chat's
  branch even when the chat is otherwise clean. Once the turn ends, the variant persists only if
  another rule now applies.
- **Rule 4** is holding by choice.
- **Moving onto a chat's branch loses nothing.** The chat's view contains everything the mainline
  view did, plus the chat's own actions.
- **One predicate, computed by the kernel**, and delivered in chat metadata beside
  `proposedChangeWorkpieces`. `#resolveGadgetChatId()` and the frontend's `previewChatId` both use
  it, so the UI and the agent never ask for different variants in the same chat.
- **Restart on switch stays, and is now needed for a second reason.** An instance that has seen a
  chat's simulated state in memory must not go on to act outside that chat.
- **When a branch is denied into.** Denying an action restarts the variants on that branch when
  the gatekeeper asks (`restart`). Denying a staged action restarts every variant, since every
  view includes it.

Costs, until gadget facets fork (out of scope here):

- **More restarts.** A chat with pending actions, a gadget held in a chat, or an agent invoking a
  gadget displaces the mainline instance, and the next request outside that chat (a hook, another
  viewer) displaces it back.
- **Shared storage.** A variant on a chat's branch still writes the gadget's real storage. Its
  external effects wait for accept; its own data does not. This is the inconsistency the request
  sets aside.

### Client API (`workshop-shared/src/api.ts`)

| Change | Purpose |
|---|---|
| `mergeChanges(chatId, options?: {creations})`, outcome `"failed"` | accept code and actions |
| `revertChanges()` also rejects actions | discard |
| `AiChatMetadata.pendingActions?: number` | banner, chat-list badge, variant choice |
| chat metadata: the gadgets that run on the chat's branch | variant choice |
| `ActionLogEntry.applyError?` | show failures |
| `AiChatMetadata.holding?`, `setChatHolding(chatId, holding)` | holding by choice |
| `WorkspaceMetadata.stagedActions?: number` | staging is holding changes |
| `acceptStagedActions()` | accept what staging holds |
| `approveAction(id)` applies its connection's branch up to `id` | awaited actions; old callers |

`rejectAction()` is unchanged, except that it also marks rejected whatever the gatekeeper reports
it rejected along with the action. Every new member gets a doc comment and a `UseOverseerInterface`
decision (all denied).

## Workshop UI

- **Pending-changes banner** (`renderCodeDraftBar` in `ChatInterface.tsx`). Shown when the chat
  proposes code changes *or* has pending actions, and summarizes both. "Accept changes" calls
  `mergeChanges()`. Discard calls `revertChanges(chatId, 0)`. Both stay disabled while the agent
  runs. A `"failed"` outcome points at the failed action, which offers Retry (when it can be
  retried) and Deny; the actions after it on that connection show as waiting on it.
- **Pending actions above the prompt** (`PendingChangesTray`). Stays mostly as it is, with three
  changes:
  - It lists the open chat's branch only. Today it is workspace-wide and guesses each action's
    origin from the chat log; `ActionLogEntry.chatId` already carries it.
  - "Apply all" and "Discard all" go (`BulkResolveButtons`, `useBulkResolve`), including the
    per-group ones.
  - Each action keeps Deny and "Always approve". Approve remains only on an awaited action. A
    creation shows its account choice.
- **Transcript action cards.** An awaited action is decided inline, as now. Others read as pending
  until the changes are accepted, with Deny.
- **Holding.** A chat shows a holding toggle. The gadget view (`GadgetUseView`, `GadgetEditor`)
  offers "Hold changes" to `build` users, which creates an agentless chat with holding on and
  opens the gadget in it.
- **Staging.** When it holds changes, the gadget view shows `build` users the same banner and
  action list a chat has, for staging. A chat's action list shows the staged actions on its
  connections ahead of its own, marked as coming from gadgets, since accepting the chat applies
  them first.
- **Activity page.** The review tab lists what has pending changes, each chat and staging,
  instead of offering per-action approval. History and the rules tab are unchanged.
- **Notifications.** `permissionRequested` fires when a turn ends with the branch not accepted, or
  waits on an awaited action.

## gatekeeper-kit: where the complexity lives

The interface above asks a lot of a gatekeeper: an unconfirmed state, a view to filter by, a
list to apply in order. The audit shows what happens when authors carry that themselves. Every
kit-based gatekeeper handles submission correctly; of the eleven that simulate from their own
stores, ten do not.

So the rule is: **the kit carries all of it. A gatekeeper author never handles a branch, a view
or the unconfirmed state.** The raw interface stays public, but once gatekeepers have moved,
hand-rolling it stops being a supported way to write one.

This needs no assembly layer. It all fits in the existing `./actions` and `./simulation` leaves.

### Backward compatibility

Everything here is additive. In-repo gatekeepers pick up the new kit with no source change, and
must behave exactly as before.

- **Existing exports keep their signatures and behavior:** `stageAction()`,
  `BoundActionSet.submit(queue, …)`, `apply(id)`, `reject(id)`, `journal.listPending()` and
  `listUndecided()`.
- **A record written through them carries no view.** It is simulated to every session and applied
  by `apply(id)`. That is today's behavior.
- **The new behavior is opt-in**, through the session handle below, together with implementing
  `applyActions()`. The two go together: a gatekeeper that implements the method submits
  everything through the handle, because the kernel then treats every action it submits as
  being on its queue's branch (see "Knowing which gatekeepers have adopted branches"). The
  harness checks it.
- **Records with no view outlive the switch.** They are the leftovers: still simulated to every
  session, and applied when a list names them.
- **The kernel is upgraded before any gatekeeper**, as with observer tracking, so the new kit
  never meets an old kernel.

### What an author writes, once they opt in

```ts
// The facet: delegations.
async startSession(queue: RpcStub<ApprovalQueue>, branch: BranchView) {
  return new TaskSession(await this.#actions.session(queue, branch), /* … */);
}
applyActions(branch: BranchView, actions: number[], cache: RpcStub<GitCache>) {
  return this.#actions.applyList(branch, actions, {gitCache: cache, generation});
}
rejectAction(id: number) {
  return this.#actions.rejectAction(id);
}

// The session: submit, and overlay what is pending.
await this.actions.submit("createTask", task, {fence: read});
const tasks = replaySimulation(await api.listTasks(), this.actions.pending(), applyPending);
```

`session(queue, branch)` resolves to a handle bound to that view. It is the only way session code
reaches pending actions, so a session cannot read another branch's by mistake. The facet passes
`branch` straight through without looking inside it. The same call serves a hook firing's queue.

### Who owns what

| Obligation | Owner |
|---|---|
| Submission contract: unconfirmed state, promotion, rollback, recovery | kit |
| Recording each action's branch | kit |
| Showing a session only its own view's actions | kit, through the session handle |
| Dependencies, stranding and provisional IDs across branches | kit |
| `applyActions()`: confirming, stopping at a failure, idempotency, early return | kit |
| What else a denial rejects, and `restart` | kit, by default |
| Fork lineage | kit; stored with each record |
| Overlaying the pending actions onto a read | author, as today, from the handle's list |
| Coalescing actions into one provider call | author, optional hook |
| Not caching simulated state across branches | author; see below |

### Changes inside the kit

- **Records store the view they were submitted under** (branch and ancestors). The kit can then
  answer visibility at reject time, when no session is involved. A record with a null branch is
  staged.
- **Staging and leftovers are handled inside the kit.** `pending()` returns records with no
  view first, then staged actions, then the branch's, so an author replaying `pending()` gets it
  right without knowing either exists. The dependency check refuses a staged action that
  names something only a branch provides. A denial's `rejected` and `restart` look across every
  branch when the denied action was staged.
- **The session handle.** `BoundActionSet.session(queue, branch)` takes the view the facet was
  handed and resolves to `submit()` and `pending()` scoped to it. `submit()` tags the record with
  the view. Creating it makes no call, except after a crash (see the submission contract below).
- **Facet-wide lists are deprecated, not removed.** `journal.listPending()` and `listUndecided()`
  keep working for legacy call sites; kit-based gatekeepers use them in 37 places. They are
  renamed to say they cross branches, and kept for housekeeping such as pruning stored files,
  when the shims are removed.
- **Two helpers for code that runs outside a session.** The pending actions an action was built
  on, for apply-time guards such as Sheets' digest of cells "with the changes queued before it".
  And the pending actions built on an action, for a denial.
- **Denial reports its consequences**, through a new method. `rejectAction(id)` returns
  `{restart, rejected}`: the dependents it rejected along with the action (today the cascade marks
  them failed and leaves them for the user), and `restart` when any pending action was built on
  it. The kit cannot represent either today, and a dozen gatekeepers compute `restart` by hand.
  `reject(id)` keeps its `Promise<void>` signature: Sheets, Slides and Drive pass it where that
  exact type is required, and must go on compiling unchanged.
- **The submission contract.** `stage()` already implements rules 1 to 3. For records with a view
  it adds rule 4, recovery. A `staged` record found when a journal is constructed is kept.
  `session()` then asks `holdsAction()` through its queue and promotes or deletes the record
  before it resolves, so no session reads or submits while the record is unsettled. Sessions
  that start meanwhile wait on the same answer. This is why `session()` is async. With no such
  record it resolves at once.

  Records with no view keep today's behavior, where a later callback naming the ID promotes a
  `staged` record. The lane stays per journal.
- **Dependencies.** The `unmet` check and the stranding cascade consider only actions the
  dependent could see. A provisional ID minted on one branch does not resolve on another until it
  is bound to a real ID.
- **Apply.** `applyList(branch, actions, context)` backs `applyActions()`. It takes the records
  the list names, in the list's order, and confirms a `staged` one among them. It runs the
  existing per-record apply, stops at the first failure, and maps the three failure classes onto
  `ApplyActionsResult`. A named record it does not hold is left out of the result. A record with
  no view is applied like any other. A gatekeeper gets batch apply with no handler changes. An
  optional set-level hook receives consecutive actions of the kinds it names and makes one
  provider call.
- **Capacity.** `maxPending` (50 today, shared by the whole facet) becomes a per-branch cap for
  records with a view, and needs raising if large batches are a goal.

### What the kit cannot own

- **The overlay.** How a pending action changes a read is the gatekeeper's substance. The kit
  hands it the right list; the author still has to use it on every read path.
- **Caches of simulated state.** A cache that holds provider state is safe. One that holds state
  with pending actions already folded in (Docs keeps one) is wrong across branches unless keyed
  by branch. The rule for authors is the one the X gatekeeper already follows: cache what the
  provider said, and overlay on every read.
- **Coalescing.** Which actions can share a provider call is provider knowledge.

These are checked, not trusted. The kit gains a test harness (a `./testing` export) that drives
any gatekeeper through the cases an author could still get wrong, given a callback that submits
an action and one that reads its effect:

- two sessions on different branches do not see each other's pending action, and each sees it
  once applied;
- a queue that refuses leaves no trace;
- a queue that pauses shows a concurrent read nothing;
- a queue that applies before it replies leaves the action applied, not pending.

## Compatibility with existing gatekeepers

An unchanged gatekeeper sees nothing new. It ignores the view it is handed, it has no
`applyActions()`, and the kernel calls its `applyAction()` and `rejectAction()` as it does today.

**What works for it after this plan:**

- **The approval model.** The kernel knows each action's branch from its caller, without the
  gatekeeper's help. Accepting a chat applies that chat's actions and no others, by
  `applyAction()`, together with whatever staging holds on the same connections. These go in
  plain ID order, staged and chat actions interleaved, because that is the order an unchanged
  gatekeeper simulated them in. For the same reason, approving one awaited action applies the
  chat's actions up to it and only the staged actions with lower IDs. Deny, discard, end-of-turn
  auto-approval, awaited actions, staging and holding all work the same way.
- **Stopping at a failure.** An action that throws stops the accept, and the later ones wait on
  it.

**What does not, until it adopts branches:**

- **Isolation.** It still simulates one stream, so chats see each other's pending actions. They
  see staged actions too, which is the one part of the new model it already gets right.
- **In-order application.** The gatekeeper's stream interleaves several branches, so applying one
  branch skips over the others' earlier actions. Most gatekeepers accept that, as they do today
  when a user approves out of order. The ones that enforce order refuse:
  - Docs edits, across the whole document.
  - Sheets, Slides and Drive, per file.
  - Google Chat, per conversation.
  - GitHub and GitLab pushes, which chain on the previous queued push.

  For these, a chat's accept fails while another branch holds an earlier action on the same
  resource. Today the user resolves this by approving the earlier action from the workspace-wide
  tray; the tray is now per chat, so the kernel must point the way (shim 3).

  A staged action meets this more often, because it applies at once. It stays pending in
  staging, with the same pointer, until the earlier action is dealt with.
- **The submission race.** An apply that outruns the `submitAction()` reply is rare today and
  becomes routine for staged actions. Gatekeepers that mishandle it (GitHub and GitLab until
  their fix lands, and possibly ones outside this repository) will hit it more often. The kernel
  will start an at-once apply only after `submitAction()` has returned its reply. That makes the
  race unlikely, but the kernel cannot know the gatekeeper has processed the reply, so it cannot
  rule it out.

**The shims, and when each can go:**

| # | Shim | Where | Removable when |
|---|---|---|---|
| 1 | `Gatekeeper.applyAction()`, and applying an unconverted gatekeeper's actions one at a time | interface, kernel | every gatekeeper implements `applyActions()` |
| 2 | A queued push stays visible in every session's `GitCache` view, for an unconverted gatekeeper's actions and for leftovers | kernel | every gatekeeper implements `applyActions()` and no leftover is pending |
| 3 | When an action fails to apply and another branch holds an earlier pending action on that connection, the error names that chat. For unconverted gatekeepers and for leftovers. | kernel, UI | same |
| 4 | `stageAction()`, `submit(queue, …)`, `apply(id)`, facet-wide `listPending()` / `listUndecided()`, and records with no view | kit | no gatekeeper uses them and no such record is pending |
| 5 | The kernel's per-connection mark of where leftovers end, and listing leftovers first | kernel | no leftover is pending |

Everything else in this plan is permanent.

## Afterwards: updating gatekeepers

Not part of this plan, but it shapes the kit, so the intended path is recorded here.

**Kit-based gatekeepers** (Sheets, Slides, Drive, the three Microsoft ones, X, PagerDuty) need
four things: `session(queue, branch)` in `startSession()`, their direct journal reads switched
to the handle, the `applyActions()` delegation, and `rejectAction()` delegating to the kit's
`rejectAction(id)` so that a denial reports what else it rejected. The harness confirms the
rest. Google's `QueuedChanges` (per-file ordering) is rebuilt on the handle, so it orders per
file per branch.

**A gatekeeper moves as a whole** (see "Knowing which gatekeepers have adopted branches"). Docs
is the case to watch: its comments are on the kit and its edits are not, and both share one facet
and one ID counter. Comments wait for the edits to be ported.

A gatekeeper drops `applyAction()` in the same release that adds `applyActions()`. Actions left
pending from before are applied through the new method (see "Leftovers" in that section).

**Gatekeepers with their own store** are best ported onto the kit's journal (decision 10). This is
the follow-up `plans/gatekeeper-kit.md` already lists ("ports of the remaining gatekeepers"), and
the kit was built for it:

- `legacyKeys` and `upgradeRecord` let a journal read the records a store already wrote. Docs
  comments were ported this way.
- GitHub, GitLab, Linear, Spotify and Home Assistant keep a last-issued counter where the journal
  expects next-unused, so each needs a one-time counter fix.
- What moves is the record lifecycle. Payload types, apply handlers and overlays stay.

Porting costs more per gatekeeper than patching it. Gmail, GitHub and GitLab are the large ones.
In return the lifecycle, which is where the audit found the bugs, exists once.

**Suggested order**, by how much the interim costs each:

1. Stores that enforce order: Docs (edits and comments together), Google Chat, GitHub, GitLab,
   and the kit-based Sheets, Slides and Drive.
2. The other kit-based gatekeepers.
3. The remaining stores: Gmail, Google Calendar, Notion, Linear, Confluence, Spotify, Home
   Assistant.
4. Gatekeepers that simulate nothing (Supabase, ZoomInfo, MCP). Isolation is vacuous for them; the
   kit gives them `applyActions()`.

The `write-gatekeeper` skill and `SKELETON.md` are rewritten kit-first with the kit change, so
that gatekeepers written from then on start on the new path. Today they instruct that every chat
reads one shared simulation, and `SKELETON.md` says to store the action and then submit it, with
nothing about a throw or about when it may be simulated.

## Forking a chat (designed for, not built)

Forking chat A at a point in its history creates chat B. B sees A's actions from before the fork
point; each chat's later actions are its own.

- **The boundary is an action ID, per connection.** For each connection the kernel takes the
  highest gatekeeper action ID among A's actions recorded before the fork point. B's view on that
  connection is `{branch: B, ancestors: [{branch: A, through}]}`. Like every view, it also sees
  staging.
- **Deeper forks are flattened by the kernel.** If C forks from B, C's view lists B and A, each
  with the boundary C actually inherits. A gatekeeper never walks a tree and stores no lineage.
- **Accepting either branch applies the shared prefix.** Accepting B applies A's actions up to the
  boundary and then B's own. A's view then no longer contains those actions: they are real.
  Accepting A first works the same way in reverse. Nothing is applied twice, because a shared
  action is one record with one ID.
- **Discarding a branch rejects only what no other branch can still see.** The kernel calls
  `rejectAction()` for an inherited action only when the last branch that could see it goes.
- **Denying an inherited action rejects it for every branch that shares it.** There is one
  record, and an action is only ever skipped by being rejected. A fork cannot drop an inherited
  action for itself alone; the UI should say which other chats lose it.

The kernel then stores each chat's parent and fork point, and the branch of an action stops being
a pure function of its caller. The same lineage would let a spawned agent's chat start as a fork
of the chat that spawned it.

Because `BranchView.ancestors` exists from the first kernel PR and the kit implements visibility
against it, gatekeepers that adopt branches need no further change for forks.

## Sequencing

Kernel changes are split so `workshop-backend` and `workshop-shared` can be reviewed apart from
the rest. Each step leaves the system working, and none touches a gatekeeper.

1. **Kernel: branch identity.** `BranchId`, `BranchView`, the view passed to `startSession()` and
   returned by `startHook()`, `getBranch()`, `pendingByBranch`. No behavior change: nothing reads
   the view yet.
2. **Kernel: applying a branch.** `applyActions()` and detecting it, `applyAction()` made
   optional, `ApplyActionsResult`, the reconciliation mark, `applyError`, `rejectAction()`'s
   `rejected`, `buildPack(actions)`, the branch-scoped `GitCache` view, the per-connection mark
   of where leftovers end, and the submission contract's wording and kernel half, including
   `holdsAction()`. One routine that applies a list replaces the drainer and serves
   `approveAction()`. No shipping gatekeeper uses the new method yet, so it is exercised through
   the test fixture.
3. **Kit:** stored views, the session handle, recovery of an unconfirmed record, `applyList`,
   denial consequences, the test harness, and the skill and usage docs. Additive; existing
   consumers are untouched.
4. **Kernel and UI: the new approval model.** Accept and discard cover actions, end-of-turn
   auto-approval, awaited actions, creations at accept, the two cleanups, shim 3, and the banner
   and tray changes. This is the user-visible switch. It ships unflagged: a global setting
   could not be turned off again once actions were pending under it, so the model is tested on a
   staging/preview instance before merge instead.
5. **Kernel and UI: gadgets.** The widened variant rule, honoring `restart`, staged actions
   applying at once, staging holding when it must, and holding in a chat by choice.

After this plan: gatekeepers adopt branches, each on its own schedule, and then the shims go.

## Testing

No gatekeeper changes, so the branch-aware path is tested through fixtures and the kit.

- **Existing gatekeepers:** every gatekeeper's shipping code and test assertions pass unchanged
  against the new kit. That is the test of the kit's backward compatibility. The one edit tests
  may need is to their stand-ins for the queue, which must gain `getBranch()` and
  `holdsAction()` to keep type-checking. The same holds for gatekeepers outside this repository.
- **Fixture (`packages/integration-tests/fixtures/gatekeeper-test`):** it is test infrastructure,
  not a shipped gatekeeper, and gains a branch-aware mode beside its current legacy behavior.
- **Integration (`packages/integration-tests`):**
  - legacy mode: accept applies exactly one chat's actions through `applyAction()`, in order; a
    failure stops it; shim 3's hint;
  - branch-aware mode: two chats do not see each other's pending actions; an early-returning
    `applyActions()`; a failure mid-branch, then retry, and deny-then-retry with `rejected`; a
    lost `submitAction()` reply; an interrupted apply call; a named action the gatekeeper does
    not hold; approving one action of a chat while staging holds a newer one, in one list; a
    staged action submitted while a chat's accept is under way, which applies after it;
  - recovery: a facet restart between a submission's reply and its at-once apply, which must
    leave the action applied; a restart with the action left pending, which the next session
    must see simulated from its first read; a restart after a submission the kernel never
    received;
  - detection: a gatekeeper with and without `applyActions()`, read through the facet stub as
    the kernel holds it, and a read that fails for another reason, which must propagate;
  - leftovers: a connection whose gatekeeper converts with actions pending. They stay on their
    chats, are listed first in ID order, and are applied through `applyActions()` by a
    gatekeeper with no `applyAction()`.
- **Kit, Node:** visibility, including multi-level `ancestors`; per-branch capacity; dependency
  checks and cascades across branches; `applyList` order, staged confirmation, stopping, and a
  named record it does not hold; recovery of an unconfirmed record, held and not held by the
  kernel; records with no view simulated first and applied when named; old call sites
  unaffected by all of it.
- **Kit harness:** run against the fixture here, and by each gatekeeper when it adopts. GitHub,
  Docs edits, Chat, Supabase, ZoomInfo and MCP have no test with a throwing queue today.
- **`pnpm cf-os api`:** `new-chat`, `wait-for-agent`, `merge-changes`, `approve-action` end to
  end, checking stored action states, `applyError` and the audit attribution.
- **Kernel unit tests:** end-of-turn auto-approval (all eligible, one ineligible, code changes
  present, restricted mode, stopped turn); awaited actions with and without rules; discard by
  range; chat deletion; reconciliation of unreported actions; the gadget variant predicate;
  holding by choice; staging holding in restricted mode and behind a failure, retrying, and
  rejecting an action that cannot be retried; a chat's view including staging; a chat's accept
  applying staging on its connections first and stopping at a staged failure.
- **Frontend:** banner states, the tray without bulk controls, a failed action and those waiting
  on it, creation input before accept.

## Alternatives considered

- **A gatekeeper facet per branch.** Running a separate facet (and storage) per chat would isolate
  unchanged gatekeepers with no interface change, which is tempting now that this plan may not
  touch them. Rejected: a facet's storage also holds
  provisional-to-real ID bindings, retained applied records, observer state and hook registries,
  which must not fragment per chat; per-facet counters cannot express a fork point; and a fork
  would have to copy storage and then apply the shared prefix twice.
- **`applyActions()` taking a branch and an up-through action ID.** A draft of this plan had it,
  to give a gatekeeper nothing to validate. Rejected for three reasons. A boundary proves the
  kernel holds only the boundary action, so safety rested on every gatekeeper submitting
  strictly one action at a time across its whole facet. One boundary cannot cover a chat and
  the staging under it. And it cannot name an action the gatekeeper has no branch for. A list
  that is promised to be complete keeps what the boundary was for, and a gatekeeper may still
  work from its bounds.
- **Letting a gatekeeper apply past a failure** when it judges the later action unrelated. See
  "Applying a branch".
- **Storing the action only after `submitAction()` returns.** It would make a refusal leave
  nothing behind, but the ID must exist before the call and an apply can arrive before the reply.
  An unread `staged` record gives the same visible behavior. See "Submitting an action".
- **Deleting an unconfirmed record when the facet restarts.** Simpler than asking the kernel, and
  a draft of this plan had it. Rejected: one crash between a submission's reply and its at-once
  apply would drop an action the kernel then records as applied.
- **Settling an unconfirmed record only when a list names it or passes it by**, with no
  `holdsAction()`. Safe, but the gatekeeper would leave out of simulation an action the kernel
  shows as pending, possibly until its chat is accepted.
- **Adopting branches one code path at a time.** Rejected: actions with and without a branch are
  simulated in different orders, so a connection that kept producing both would have no sound
  order, and gatekeepers will be moved whole anyway.
- **Keeping `applyAction()` for the actions left pending when a gatekeeper converts.** Not needed
  once a list can name them, and every converted gatekeeper would carry two apply paths.
- **Moving those leftovers into staging**, since every session sees them. Sound, but a later
  staged action waits behind an earlier one, so gadget actions on that connection would stop
  applying at once until someone cleared them.
- **Moving them into their chat's branch.** The gatekeeper would have to be told each one's
  branch, and other chats that were built on them would see them vanish.
- **The kernel holds the pending actions.** The contract exists because two parties each keep a
  copy of the pending set and must keep them equal. The kernel could instead store each action's
  payload and hand a session its view's pending actions, and `applyActions()` the payloads. Then
  no gatekeeper has an unconfirmed state, a phantom is impossible, and branches and forks vanish
  from the gatekeeper interface. Not chosen: the kernel grows and takes on opaque payloads of
  unbounded shape; every simulated read starts with a kernel call where it is a synchronous
  storage scan today; and it rewrites the kit-based gatekeepers as well. The kit reaches the same
  place for authors without that. It remains the option if the kit proves not to be enough.
- **A standing reconciliation call**, in which the kernel regularly tells a gatekeeper which
  actions it holds. Unnecessary once the submission contract holds by construction; kept in
  reserve as a one-time cleanup of phantoms that past crashes left.
- **The view from `getBranch()` alone.** One method would cover every path, but at the price of a
  round trip at the start of every session. It is kept only as the fallback.
- **A `branchAware` flag on each action description, or a capability flag on
  `ResourceDescription`.** Unnecessary: the kernel can see whether `applyActions()` exists.
- **Treating awaited actions like any other.** See "Actions that cannot be simulated".
- **A workspace-wide hold a user switches on.** Rejected: one user's caution would hold everyone's
  actions in one shared stream. Holding by choice is done in a chat, which keeps each held change
  in its own thread, as code changes are.
- **An automatically created chat for imposed holding.** A draft of this plan had one per
  gadget, which broke consistency between gadgets on one connection, and then one per workspace,
  which every mainline gadget had to run in. See "Holding".
- **Chats that do not see staging.** A draft made what the kernel holds a peer of the chat
  branches, invisible to them. Rejected: a gadget moves from mainline onto the chat's branch when
  the agent first acts, and what the user was looking at would vanish.
- **Forking each chat from staging when it starts.** It would fix the vanishing at that moment
  only: later staged actions would still be missing, and running chats would need rebasing.
  Making staging part of every view does both without moving anything.
- **Staging as an ordinary branch**, named in each view as an ancestor with no bound. It kept
  staging out of the interface, but only by giving every gatekeeper two general mechanisms that
  exist for staging alone: unbounded ancestors, and ordering by ancestry instead of by ID. Saying
  that staged actions are special is simpler to specify and to implement. The cost is that
  splitting staging later would be an addition to the interface.
- **Merging an accepted chat into staging**, leaving its actions pending. See "Staging".
- **Rejecting every staged action that fails.** It keeps staging empty, but drops a user's action
  on a transient provider error.

## Out of scope

- Forking the gadget facet and its storage per branch.
- Implementing chat forks.
- Simulating hooks inside a chat's branch (the existing TODO in `overseer.ts`).
- Revoking actions queued by an agent step that never persisted (`plans/step-transactionality.md`).
- Provisional IDs that leak into another connection's action text, such as a not-yet-created
  issue's URL posted to Slack. This exists today and batching does not change it.
- Wiring up `revertAction()`.
- Batch rejection.
- Changing any gatekeeper, in or out of this repository, including fixing what the audit found.

# Part 2: Chat modes

Status: implemented. It was written as a proposal after part 1 was tried, and reads that way.

## Summary

Part 1 decides what is automatic from per-action-kind rules, and offers holding as a toggle. Part 2
replaces both with one choice the user makes in the prompt box: the chat's **mode**.

A chat is **forked** while its changes are being held for review. A forked chat holds every
action, whether the agent or a user driving a gadget submitted it, shows the held changes above
the prompt box with "Accept changes", and stays forked until it is accepted or discarded. A chat
that is not forked applies gadget actions at once, through staging.

| Mode | The chat forks | It is accepted |
|---|---|---|
| **Auto** | when the agent makes any change | automatically at the end of a turn, if every change is auto-approvable; otherwise by the user |
| **Review** (default) | when the agent makes any change | by the user only |
| **Fork** | at once, and again after every accept | by the user only |

- **Auto-approvable** now means the gatekeeper author's verdict alone (`autoApprovable: true`).
  Code changes count as auto-approvable. The user's per-kind rules are no longer consulted.
- **Fork** replaces holding.
- **A resource the agent creates is unsaved** until the user saves it to an account. It does not
  stand in the way of accepting. Changes to it are accepted like any others, and the user sees
  them as applied to a document that exists only in the workspace.
- Part 2 touches the kernel's approval policy, the client API and the UI. The gatekeeper interface
  gains one optional method, for unsaved resources, which the kit implements.

## Decisions

Settled:

- The three modes and their meaning, as in the table.
- Rules are moot but not removed. Removing their storage, API and settings UI is a later change.
- The chooser sits on the prompt box's bottom line, left of the model chooser, and always shows
  the mode's name.
- A follow-up defaults to the mode of the previous message. A new chat defaults to the mode the
  user last started a chat with, or Review. Auto was the first default, and was judged too
  risky while gatekeepers' `autoApprovable` verdicts are unreviewed (see "What Auto newly
  allows").
- In Auto, an awaited action (`awaitDecision`) that is `autoApprovable: true` is applied without
  asking. A prompt that needs input from the user still waits.
- **The mode is a property of the chat, changed the moment the chooser changes**, even mid-turn.
  It is not a parameter of each message. See "The mode".
- **A chat is forked as a whole.** It is forked when its branch is non-empty or its mode is Fork,
  where the branch includes proposed code and binding changes, and then every gadget in it runs on
  its branch. Gadgets in one chat are never in different states. See "Forked".
- **Binding changes go with the code**: auto-approvable, except where the user's input is needed.
  See "Auto-approvable".
- **Creating a resource needs no approval and no input.** Only saving it to an account does, and
  that is separate from accepting. Accepting never waits on a creation, by hand or automatically.
  See "Unsaved resources".
- **Auto trusts the agent.** An agent in Auto could get around `autoApprovable: false` by writing
  code that acts for it. Agents are expected not to be malicious, so this is accepted. See "What
  Auto newly allows".
- **Restricted-data mode does not permit Auto.** The chooser greys it out, and only Review and
  Fork can be selected. See "Restricted-data mode".
- **A chat started by an agent spawner runs in Auto.** An API for the gadget to choose is future
  work. See "Chats nobody starts".
- **No new migration.** Part 1 has been deployed nowhere, so its migrations are changed to produce
  part 2's state straight from main's. See "Migration".
- **The new-chat default is remembered in the browser, per user**, not on the server.
- **The controls that enable a rule are removed from action cards**, though the rules themselves
  stay.
- **Accepted changes to an unsaved resource move to staging, which holds them** until the
  resource is saved. The user is shown them as applied. Staging keeps ID order. See "Unsaved
  resources", as for the three below.
- **The gatekeeper interface gains an optional `stageActions(branch, actions)`**, which tells a
  gatekeeper that has adopted branches that a prefix of a branch is now staged. Like
  `applyActions()`, it names a complete range and never skips an action.
- **Saving is its own step, offered once the creation is accepted.** "Accept changes" no longer
  asks for an account, and `MergeChangesOptions.creations` goes.
- **An accepted change to an unsaved resource leaves the chat's review UI**, which is the
  requirement. It stays deniable from the action log, since hiding that would only add code.

## The mode

```ts
/** How a chat's changes are held and accepted; see AiChatMetadata.mode. */
export type ChatMode = "auto" | "review" | "fork";
```

- **Stored on the chat**, as `AiChatMetadata.mode`, replacing `holding`. Every chat has one.
- **Nothing defaults to a mode**, except one thing: the user's preference. A user who has
  never chosen starts chats in Review, which the client keeps (`DEFAULT_CHAT_MODE`). Everywhere
  else a mode is named for a reason of its own. A chat an agent spawner starts is in
  Auto because nobody attends it, and a blueprint update's chat is in Review because it exists
  to be reviewed.
- **Set two ways.** `newChat()` takes it as a required parameter, before its options, so every
  caller says which mode it means: the client passes the user's preference.
  `setChatMode(chatId, mode)` changes it afterwards and replaces `setChatHolding()`.
  `sendChatMessage()` is unchanged.
- **The chooser calls `setChatMode()` as soon as it changes.** The alternative, a
  mode sent with each message, has three problems:
  - Fork must take effect with no message: it exists for a user who wants a gadget's actions held,
    perhaps in a chat with no agent.
  - A message sent while the agent runs is a steer. It would be unclear whether its mode applies
    to the running turn.
  - The user could not change their mind mid-turn. With a chat property, switching Auto to Review
    while the agent works stops the automatic accept without stopping the agent.

  "Defaults to the mode of the previous message" then needs no mechanism: the chooser shows the
  chat's mode.
- **Read when it matters, not when the turn starts.** The end of a turn and the submission of an
  awaited action each read the mode then.
- **Changing it never accepts or discards anything.** Switching a forked chat to Auto leaves it
  forked until the user accepts it or a later turn completes. Switching an empty Fork chat to Auto
  or Review unforks it, and its gadgets return to mainline.
- **Permissions.** As `setChatHolding()` today: `build` users only.

## Forked

One predicate, in the kernel:

> A chat is forked when its mode is Fork, or its branch has a pending action, or it proposes a
> code or binding change.

- **It replaces rules 1, 2 and 4** of part 1's "Gadgets". A request for a gadget in a forked
  chat's context runs on the chat's branch. Rule 3 stays: a gadget an agent turn invokes runs on
  the branch until the turn ends, so that the first action it submits forks the chat instead of
  landing in staging.
- **What changes:** a chat that proposes code changes to gadget G, and nothing
  else, today runs only G as its variant; a click in gadget H applies at once. Under the
  definition, the chat holds H's actions too. The cost is part 1's: more restarts until gadget
  facets fork. The gain is one rule the user can predict from what the prompt box shows.
- **No new metadata.** `branchGadgets` already delivers the result. The UI shows the held-changes
  bar when `mode === "fork"`, `pendingActions` or `proposedChangeWorkpieces` says so.
- **Accept in Fork.** Accepting empties the branch and the mode keeps the chat forked. Nothing
  restarts, because the gadgets stay on the branch.

## Auto-approvable

A branch is auto-approvable when all of these hold:

- Every pending action on it has `autoApprovable: true`. A stored description without the verdict
  counts as no, as today.
- A creation does not count against it, and neither does the fact that an action's resource is
  unsaved. Each action on an unsaved resource is judged by its own verdict, like any other. See
  "Unsaved resources".
- Accepting it would release nothing staging is holding on its connections (part 1's rule).

Code and binding changes do not count against it. A binding edge the chat proposes gives a gadget
access to a connection the agent could already use. Reviewing the grant while not reviewing the
code that uses it would protect nothing. A binding that needs the user's input, such as a
connection request, waits for it as it does today.

`autoApprovalRule()` is replaced by this check. `autoApproveTags`, `setAutoApprovedActionKind()`
and the rules tab stay, and nothing reads them. `autoAcceptChatsOn()`, which applied what a newly
enabled rule covered, is deleted.

### At the end of a turn

`autoAcceptBranch()` keeps its place: the last phase of a turn that finished normally, before the
chat goes idle. It now accepts when the mode is Auto and the branch is auto-approvable.

- **Code merges too.** The accept is the same `acceptBranch()` the button calls: actions first,
  then code. If mainline has already moved it returns `"stale"` before applying anything. If
  mainline moves while the actions apply, they are applied and only the code is left, as in part
  1. Either way the chat stays forked for the user.
- **A stopped, failed or waiting turn accepts nothing**, as today. The chat stays forked, so the
  user can discard. A later turn that completes accepts whatever the branch then holds, including
  what earlier turns and the user's own gadget use left on it.
- **All or nothing.** One action that is not auto-approvable leaves the whole branch for the user.
- **Not after a denial**, as today.
- **Attribution.** Each action is recorded as approved automatically (`autoApproved: true`), on
  behalf of the user whose message started the turn. Today it is the user who enabled the rule.

### Awaited actions

Part 1's "Actions that cannot be simulated" stands, with the mode in place of rules. At submit, an
awaited action is applied at once when:

- the chat's mode is Auto;
- it, and every earlier pending action on that connection's branch, is `autoApprovable: true`;
- staging holds nothing on that connection.

Otherwise the turn waits for the user, whose Approve applies that connection's branch up to the
action, as now. In Review and Fork it always waits.

What an awaited action applied mid-turn stays applied if the turn is then stopped.

A connection request and a web-fetch request are not actions with a verdict. Each waits for the
user in every mode. A creation waits for nobody (see "Unsaved resources").

## Unsaved resources

`createExternalResource` mints a connection of its own for the new resource, with a pending
`"create"` action and the agent's later actions queued behind it. Part 1 treats that creation as
something an accept must wait for: the user chooses an account in the accept dialog, and Auto
never accepts a branch that holds one.

Part 2 separates the two. The user's picture:

- The agent has created a document. It exists in the workspace and is **unsaved**.
- Changes to it are held, accepted and auto-accepted exactly as changes to anything else are. Once
  accepted, they have happened, to a document that is not saved anywhere yet.
- At some point the user **saves** it to one of their accounts. That is when they choose the
  account, and where in it the resource goes.

Underneath, nothing can be applied before the resource exists. So the kernel keeps the accepted
actions and applies them when the resource is saved.

### Accepting

Accepting a chat **moves its actions on an unsaved connection into staging**, where they are held
until the resource is saved. Staging is already "pending actions on no branch, which every session
sees", so no new state is needed for what the user was told is applied.

- **`acceptBranch()` moves instead of applying**, on each unsaved connection: the creation and the
  branch's actions there. It calls no `applyActions()` for them. On every other connection it
  applies as now.
- **The kernel records the accept on each action**: who accepted it and whether that was
  automatic. From then on the action's branch is staging, whatever its caller says. This is the
  first case where an action's branch is not a function of its caller.
- **It has left the chat.** It no longer counts in the chat's `pendingActions`, so the chat is no
  longer forked by it and the held-changes bar does not list it.
- **Staging holds for a new reason.** Part 1's staging holds in restricted-data mode, behind a
  failure and for actions pending from before the upgrade. It now also holds everything on a
  connection whose resource is unsaved.
- **A gadget outside any fork** that acts on an unsaved resource submits to staging as always. The
  action is recorded as accepted for the workspace owner, automatically, as it would have been
  applied, and held with the rest. In restricted-data mode it waits for a user's accept first.
- **Order is ID order**, as everywhere in staging. An action with a lower ID that is accepted
  after a higher one was staged replays before it, though the chat previewed it after. If the two
  conflict, the resource shifts at the moment of accept. What is shown after the accept is still
  what gets saved, since simulation and save replay the same order. Keeping ID order means a
  bound in `applyActions()` keeps meaning "every staged action up to this ID".
- **These actions are not up for review.** What matters is that they no longer appear in the
  chat's review UI: neither as the chat's own, nor in the staged actions a chat lists ahead of its
  own. `WorkspaceMetadata.stagedActions`, `acceptStagedActions()` and `discardStagedActions()`
  pass over an action already accepted too, since accepting one again means nothing and the bar
  is for what awaits a decision.
- **They can still be denied elsewhere.** `rejectAction()` treats one like any pending action, and
  the action log offers Deny on it as it does on any. Nothing is added to prevent it.
- **Before the creation is accepted** the resource belongs to the chat that created it. Discarding
  the chat rejects the creation and removes the resource, as now.
- **Auto.** The end of a turn accepts a branch whatever creations it holds. An
  `autoApprovable: false` action on an unsaved resource still leaves the branch for the user: what
  is automatic should not depend on whether a resource happens to be saved yet.
- **Awaited actions.** An action that cannot be simulated cannot run against a resource that does
  not exist. On an unsaved connection it waits until the resource is saved, in every mode. No
  resource type that can be created is expected to submit one.

### Limits set by today's gatekeepers

Neither is addressed here, since no gatekeeper changes in this plan.

- **A type that takes no change before it is created.** The Sheets gatekeeper refuses every
  change to a spreadsheet not created yet. That is arguably a bug in it. Until it is fixed, an
  action on an unsaved spreadsheet fails as it does today, with the gatekeeper's error, and the
  resource has to be saved before it can be changed.
- **The kit's cap on pending actions.** `ActionJournal` refuses a new action once 50 are
  unresolved (`DEFAULT_MAX_PENDING`). Accepted actions on an unsaved resource stay unresolved, so
  a resource left unsaved through enough edits reaches the cap, and further changes fail until it
  is saved. The cap is arbitrary and is expected to be removed from the kit, which resolves this.

### Telling the gatekeeper

A gatekeeper that has not adopted branches simulates every pending action to every session, so
the move changes nothing it can see. One that has adopted them isolates the chat's actions, and
has to learn that they are now staged:

```ts
/**
 * Optional. `actions`, pending on `branch`'s branch, are staged from now on: every session sees
 * them, as it does any staged action (see `BranchView`), in ID order among the staged actions.
 * They are applied later, by `applyActions()`, like any other.
 *
 * The list is complete, as `applyActions()`'s is: it names every action the Workshop holds
 * pending on the branch and its ancestors with an ID up to the highest it names. A gatekeeper
 * may therefore work from the view and that bound instead of from each action. An action is
 * never passed over: one that is not to be staged was rejected first (`rejectAction()`).
 *
 * Naming an action confirms it, as in `applyActions()`. Calling again with the same actions
 * changes nothing. Throwing tells the Workshop nothing was staged, and it will call again.
 */
stageActions?(branch: BranchView, actions: number[]): Promise<void>;
```

- **A prefix of the branch, never a selection.** Like an apply, a move takes the branch's actions
  on the connection up to a bound and skips none. The accept's own bound
  (`MergeChangesOptions.through`) gives it: later actions stay on the branch.
- **General, though only unsaved resources use it here.** It is the "way to tell a gatekeeper that
  an action has changed branch" that part 1 left out, and would also serve merging an accepted
  chat into staging when the accepter may not release what staging holds.
- **No change to the view contract.** Staged actions stay in ID order.
- **The kit** rewrites the stored view of the records within the bound. Authors see nothing new.
- **A gatekeeper that has adopted branches but lacks the method** keeps the actions private to
  the chat. One that offers creation is expected to have it; the kit's harness checks.
- **Failure and interruption.** The kernel durably records the move it intends, per connection:
  the branch and the bound. Then it calls, and only once the call returns does it record the
  actions as staged and clear the intent. If the call throws, the accept stops as it does for a
  failed apply, with the actions still on the branch. While an intent is recorded, the kernel
  calls again, with the same list, before anything else it does on that connection: starting a
  session, applying, or another accept. The call is idempotent, so a gatekeeper that had already
  rewritten its records when the kernel was interrupted is brought back into agreement. This is
  the pattern of part 1's reconciliation mark.

### Saving

`approveAction(creationId, creation)` already applies a creation in the account the caller chose.
It becomes "save":

1. `applyCreation()` creates the resource and the connection switches to the real class, as now.
2. What staging holds on the connection is applied, in ID order, through the routine that applies
   any list, up to the first action no user has accepted yet. Each is recorded as approved by the
   user who accepted it, with `autoApproved` as it was accepted. The creation is recorded as
   approved by the user who saved.
3. **A failure stops there**, with the error on the action that failed. From here the connection
   is an ordinary one whose staging is held behind a failure, which part 1 already handles: the
   action can be retried or denied, and the next apply on the connection takes it first. The UI
   says the save did not finish.

- **Offered once the creation is accepted**. Until then the creation is part of a
  fork, and the user accepts first. This keeps one question per step: "accept these changes?",
  then "where does this go?".
- **`MergeChangesOptions.creations` goes**, with the refusal to accept while a creation has no
  account, and the creation dialog in the accept flow.
- **Removing the unsaved resource** discards it and everything accepted on it, through the
  existing cleanup for a removed connection.
- **Permissions.** As `approveAction()` today.

### What the client sees

- `ActionLogEntry` reports such an action as accepted: who accepted it and when, and that it
  waits on its resource being saved.
- A connection reports that its resource is unsaved, so the UI can list unsaved resources without
  scanning the action log.

### What Auto newly allows

Today code is never merged without a person accepting it. In Auto, which a user has to choose,
it is. Combined
with part 1's decision 5, that removes the last review between an agent and an
`autoApprovable: false` action:

1. The agent writes a gadget whose hook, alarm or button sends an email.
2. The turn ends. Nothing pending is `autoApprovable: false`, so the code merges.
3. The hook fires, or the user clicks. The action goes to staging and applies at once.

This is accepted. `autoApprovable: false` guards against an agent's mistake, not against an agent
working to get around it, and agents are expected not to be malicious. Auto means the user trusts
the agent with what its code can reach. Review is the mode for a user who does not.

### Restricted-data mode

Once the workspace has latched restricted-data mode, every action must be reviewed, so Auto is not
permitted.

- **Unsaved resources.** The latch does not stop a user accepting changes to one, or saving it.
- **Choosing it is refused.** `setChatMode()` and `newChat()` throw when asked for Auto. The
  chooser shows Auto greyed out, with the reason, and offers only Review and Fork.
- **A chat already in Auto reads as Review.** The latch can set at any time, including mid-turn,
  so the kernel does not rewrite chats when it does. Instead a chat whose stored mode is Auto
  has the mode Review while the latch is set: in what the kernel decides, and in the
  `mode` it delivers to clients. That covers spawned chats too.
- **The new-chat default is not overwritten.** A composer whose remembered mode is Auto starts on
  Review in such a workspace, and leaves the remembered value alone for other workspaces.

## Chats nobody starts

- **Spawned agents.** A chat an agent spawner creates has no chooser. It runs in Auto: its `autoApprovable: true` actions apply when its turn ends, and anything else
  waits, with the existing notification. Today such a chat applies only what the user's rules
  cover, so this widens what a spawned agent does unattended to every auto-approvable action. An
  API for the gadget to choose its agents' mode is future work.
- **Attribution** for a spawned turn is the user the spawner already resolves its model from.
- **Blueprint updates** (`applyBlueprint()`) start a chat for the user to review a merge. It is
  created in Review.
- **"Hold changes" in the gadget view** becomes `newChat(message, null, "fork")`: one call
  where there are two today.

## Migration

Part 1 has been deployed nowhere, so no stored state has `holding`, and nothing written by part
1's code needs converting. Part 2 adds no storage version. It changes part 1's migrations, which
run on main's data, to produce part 2's state directly:

- Every existing chat gets `mode: "review"`. Until the upgrade its user accepted its changes
  themselves, so no turn in it, one the upgrade interrupted included, may accept them unseen:
  less review than a user was used to is a bad surprise, and more is a small one until they
  find the mode chooser. This follows the ruling for staged actions pending at upgrade, and goes
  in the same migration (`migrateToHeldStaging`).
- A chat created after the upgrade is in the mode its creator names.

`holding` is deleted from the stored chat type outright.

## Client API (`workshop-shared/src/api.ts`)

| Change | Purpose |
|---|---|
| `ChatMode` | the three modes |
| `AiChatMetadata.mode: ChatMode`, replacing `holding` | the chat's mode |
| `newChat(message, modelId, mode, options?)` | a new chat's mode |
| `setChatMode(chatId, mode)`, replacing `setChatHolding()` | changing it |
| doc comments on `setAutoApprovedActionKind()` and the rule types | say the rules have no effect |
| `MergeChangesOptions.creations` removed | accepting never saves |
| `approveAction(creationId, creation)` also applies what staging holds there | saving a resource |
| `ActionLogEntry`: accepted, waiting on its resource | an accepted action on an unsaved resource |
| connection info: the resource is unsaved | listing unsaved resources |
| `Gatekeeper.stageActions?()` (`gatekeeper.ts`) | moving a branch's actions to staging |

`setChatMode()` is denied in `UseOverseerInterface`. `pnpm cf-os api new-chat` gains an optional
mode and otherwise behaves as now, in Auto.

## Workshop UI

- **Mode chooser** (`ComposerModeSelector`, beside `ComposerModelSelector` in `ChatComposer`). A
  dropdown on the prompt box's bottom line, left of the model chooser. The trigger always shows
  the name: "Auto", "Review" or "Fork". Each menu item carries one line saying what it does.
  - In an existing chat it shows the chat's mode and calls `setChatMode()` on change.
  - In the new-chat composer it starts on the user's last choice and passes it to `newChat()`.
  - It is shown with no agent selected too, since Fork is useful there.
  - A user who may not change the mode sees it read-only.
  - In a workspace in restricted-data mode, Auto is greyed out (see "Restricted-data mode").
- **The new-chat default** is kept in `localStorage` under the user's ID, the way
  `modelSelection.ts` keeps the model, and written when a chat is started. The model also has a
  server copy that follows the user between browsers. Giving the mode one means new
  `AuthenticatedApi` members for a small gain, so it is left out. "Hold changes" does not update
  it.
- **Held changes.** The bar above the prompt box shows whenever the chat is forked. In Fork with
  nothing pending it says so, with "Accept changes" disabled.
- **Unsaved resources.**
  - "Accept changes" no longer opens the account dialog (`CreationAccountModal`).
  - The creation's card in the transcript shows the resource as unsaved, with "Save to account"
    once the chat's changes are accepted. That opens the same account and configurator dialog.
  - The connection's entry wherever connections are listed carries the same state and button, so
    a resource can be saved without finding the chat.
  - Actions accepted on it leave the chat's held-changes list, and the staging bar does not
    count them. The action log shows them as accepted, waiting on the resource, with its usual
    Deny.
  - A save that did not finish shows the failed action with Retry and Deny, as a failed accept
    does.
- **The holding toggle goes** (`HoldingToggle`).
- **Rule controls.** "Always approve" on an action card and its confirmation dialog
  are removed, since enabling a rule now does nothing. The rules tab stays until the later
  cleanup, with a line saying modes have replaced it.
- **Notifications.** A turn that ends with its chat forked is waiting on the user, so it raises
  `permissionRequested`. Today the check (`#publishAgentTurnNotification()`) looks only at pending
  decisions and pending actions, so a turn that leaves only code or binding changes reports
  `taskCompleted`. That is a bug, fixed here by asking the forked predicate instead.

## Sequencing

1. **Kernel and API: modes.** `ChatMode`, `mode` on the chat, `newChat()`'s parameter,
   `setChatMode()`, the change to part 1's migration, the forked predicate, the notification fix,
   and the auto-approvable check in place of `autoApprovalRule()` at the end of a turn and for
   awaited actions. The
   frontend changes only as far as it must to compile: the holding toggle calls `setChatMode()`
   with Fork or Auto.
2. **Kernel and kit: unsaved resources.** Moving to staging at accept, staging holding an unsaved
   connection, saving, `stageActions()` and its kit support, and the removal of
   `MergeChangesOptions.creations`. The frontend again changes only as far as it must: the accept
   flow loses its account dialog, and the creation's card saves.
3. **UI: the mode chooser**, the new-chat default, the held-changes bar in Fork, unsaved
   resources where connections are listed, and removing the holding toggle and the rule controls.

## Testing

- **Kernel unit tests:**
  - Auto: a turn whose actions are all auto-approvable is accepted, code included; one that is not
    leaves everything pending; a stopped turn accepts nothing and the next completed turn accepts
    both turns' changes; a merge that is `"stale"` at the start applies nothing, and one
    that goes stale while actions apply leaves only the code;
    a branch built on held staging accepts nothing.
  - Review and Fork: never accepted automatically.
  - Fork: gadget actions join the branch with nothing pending; after an accept they still do.
  - Awaited actions: applied at once in Auto when auto-approvable; waiting behind an earlier
    action that is not; waiting in Review and Fork.
  - The mode changed mid-turn decides the turn's end.
  - The forked predicate for each cause, and that a chat with only code changes holds another
    gadget's actions.
  - Restricted-data mode: choosing Auto is refused; a chat in Auto reads as Review and is not
    accepted, including when the latch sets mid-turn.
  - The migration: every chat on main's data becomes Review.
  - Rules: enabling one applies nothing.
  - Notifications: a turn that ends forked by code changes alone raises `permissionRequested`; one
    that Auto accepted raises `taskCompleted`.
  - Unsaved resources: an accept moves the creation and its actions to staging and applies the
    rest; the chat is then not forked, and the staging count and discard pass them over; Auto
    accepts a branch with a creation; a gadget's action on an unsaved resource is held as
    accepted; saving applies in ID order with each action's own accepter, and stops before one
    not yet accepted; a failure at save leaves the rest pending and deniable; removing the
    resource rejects what was accepted; discarding the chat before accept removes the resource.
- **Integration, with the branch-aware fixture:** a session in another chat sees an accepted
  action on an unsaved resource and not an unaccepted one; `stageActions()` receives a complete
  prefix when the accept is bounded by `through`; a throw leaves the actions on the branch; an
  interruption after the gatekeeper's write is repaired by the repeated call before the next
  session; a
  lower-ID action accepted after a higher one replays in ID order, in simulation and at save.
- **Kit, Node:** records within the bound become staged, visible to every view; a repeated call
  changes nothing; `applyList` then takes them as staged actions.
- **`pnpm cf-os api`:** `new-chat` in each mode, then `wait-for-agent` and the stored action
  states and attribution.
- **Frontend:** the chooser's label and default in a new chat and a follow-up; the bar in an empty
  Fork chat; no rule controls on a card.
- **Live, on the preview:** a building turn in Auto that merges on its own, and the same in
  Review; an agent creating a document in Auto, a later turn editing it, then saving it.

## Out of scope

- Removing rule storage, `setAutoApprovedActionKind()` and the rules tab.
- An API for a gadget to choose the mode of the agents it spawns.
- A server copy of the new-chat default.
