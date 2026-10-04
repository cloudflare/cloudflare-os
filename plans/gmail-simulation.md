# Plan: Simulate pending Gmail actions

## Summary

Today the Gmail gatekeeper stops the agent's turn whenever it archives, labels, marks, stars,
trashes, or sends mail. It does this because later reads can't show those changes until the user
approves them. This plan makes the gatekeeper simulate those actions instead. The agent keeps
working, and the user approves the whole batch at the end. The work lands as one PR with two
commits: label changes first, then sends.

## Background

### Approvals and simulation

An *action* is anything an agent does through a gatekeeper that changes the outside world. The
gatekeeper records the action and submits it to the approval queue. It carries the action out only
when the user approves it (`applyAction()`); until then the action is *pending*.

Mostly the agent doesn't see any of this. A well-behaved gatekeeper *simulates* pending actions,
meaning every later read reflects them as if they had already happened. If the agent archives a
thread and then lists the inbox, the thread is gone, even though Gmail still has it in the inbox.
The agent works against a consistent picture of the world, and the user reviews and approves many
actions at once.

If a gatekeeper can't simulate an action, it can mark the action `awaitDecision`. The agent's turn
then stops once the action is submitted, and resumes after the user decides. This keeps the agent
from being confused by reads that contradict its own actions ("I archived this, so why is it still
in the inbox?", and then it archives it again). The cost is that the user has to babysit the agent
through every step. `awaitDecision` is meant for actions that genuinely can't be simulated: paid
lookups whose result the agent needs, opaque MCP tool calls, arbitrary SQL.

### The Gmail gatekeeper in brief

- **Bindings.** A Gmail connection is one of three kinds:
  - the whole mailbox;
  - one label ("everything labeled Receipts");
  - one search ("from:boss@example.com").

  Label and search bindings are *restricted*. They can only see messages that match, and they can't
  compose new mail or manage labels. Each binding is its own Durable Object with its own storage,
  including its own list of pending actions. Pending actions in one binding never affect another.
- **Capabilities.** The agent gets a session object, and from it *thread*, *message* and *draft*
  objects. Each object reaches only what its binding admits. For example, a restricted binding's
  thread object carries the list of message IDs in that thread it is allowed to show.
- **Everything is a label.** Gmail represents a message's state as labels: `INBOX`, `UNREAD`,
  `STARRED`, `TRASH`, `SPAM`, plus custom labels.
  - Archiving removes `INBOX`, marking read removes `UNREAD`, and trashing adds `TRASH`.
  - A thread has no labels of its own. Its "labels" and its "unread" flag summarize its messages'
    labels.
- **Two kinds of message ID.**
  - Gmail gives each stored message an opaque ID (`18c3f…`).
  - Separately, every email has an RFC Message-ID header (`<…@…>`).

  When the gatekeeper composes outbound mail, it chooses the Message-ID itself at submit time
  (`<uuid@gadgets.invalid>`) and returns it to the agent as a `GmailMessageId`. Gmail's own ID only
  exists after the message is sent. `getMessage()` accepts either kind.

### What's simulated today

Drafts and label definitions are already simulated:
- **Drafts.** Creating, editing, deleting or sending a draft shows up in `listDrafts()`,
  `getDraft()` and the draft's own reads (`overlayGmailDraft`, gmail-state.ts:146).
- **Labels.** Creating, renaming or deleting a label shows up in `listLabels()` and in the labels
  shown on messages (`overlayGmailLabels`, gmail-state.ts:224).

Two things are not simulated:
- **Label changes on messages:** archive, trash, mark read or unread, star or unstar, apply or
  remove a label. Message and thread reads come straight from Gmail.
- **Sends:** send, reply, reply all, forward, and sending a draft.
  - Opening the returned `GmailMessageId` throws "This Gmail send is pending".
  - A reply doesn't appear in its thread.
  - Sending a draft is half-simulated: the draft disappears, but the sent message doesn't exist.

These five call sites set `awaitDecision: true`:
- `submitMutation()`, gmail.ts:2458
- `send()`, gmail.ts:2197
- `#reply()`, gmail.ts:2770
- `forward()`, gmail.ts:2804
- `GmailDraftStub.send()`, gmail.ts:3430

Sends are never auto-approvable. Label changes are auto-approved only when the user turns that on.
So in practice most Gmail workflows stop after every step. Inbox triage is the worst case: dozens
of archives and label changes, each needing a round trip to the user.

## Design

### Principles

1. **Overlay at read time.** Pending actions stay in the gatekeeper's existing action store. Each
   read fetches Gmail's current data and then adjusts it for the pending actions. Nothing is cached
   or changed ahead of time. When the user approves an action, the next read simply sees Gmail's
   real state. When they reject one, the next read simply stops adjusting for it. The existing draft
   and label overlays and the Google Chat gatekeeper (`chat-state.ts`) already work this way.

2. **The overlay can change or hide what Gmail returned, but never adds Gmail messages.** If Gmail
   didn't return a message for a query, the overlay doesn't invent one. This keeps restricted
   bindings safe by construction: a simulated change can only make a binding see *less* than Gmail
   would show it, never more. The one addition is mail the binding is sending itself, and the
   binding wrote that.

3. **What the agent reads back is what will be sent.** A pending message is rendered by the same
   code `applyAction()` uses to build the email. Reading it back shows the recipients, headers,
   body and attachments the user is being asked to approve. There are two small exceptions:
   - the `Date` header is stamped when the email is actually sent, so the read-back shows the
     submission time instead;
   - a draft's attachments are read from the Gmail draft, not stored with the action. If someone
     edits the draft in Gmail while its send is pending, the read-back shows the edit. The send
     then fails when approved, because `applyAction()` still checks the draft against what was
     approved.

4. **Where exact simulation isn't possible, show the agent's change and document the gap.** In some
   places Gmail's data can't be reconciled with a pending action, mostly free-text search. There the
   agent still sees its own change on every result it gets, and the agent-facing docs describe the
   limitation. Where possible, the limitation is one Gmail itself plausibly has: its search index
   lags behind label changes anyway.

### Part 1: Label changes

Every message mutation means "add these labels to, and remove those labels from, exactly these
messages". Mutations already store exact message IDs rather than "the whole thread", so mail that
arrives later isn't touched. The table mapping each operation to the labels it adds and removes
also already exists, because apply uses it (`mutationLabelChanges`, gmail.ts:3552).

The simulation works like this:

- **Messages.** Whenever a message's metadata is read, its label list gets each pending mutation
  that names the message, applied in submission order. This covers the message's own
  `getMetadata()` and its entry in any message list. Mark a message read, read it back, and
  `UNREAD` is gone.
- **Threads.** A thread's summary (`labels` and `unread`) is recomputed from its messages after
  their labels are patched. Archiving every message in a thread removes `INBOX` from the thread's
  labels. Marking them all read makes `unread` false.
- **Lists that drop entries.** Some lists filter by label, and an entry the agent just moved out of
  that label shouldn't still be listed:
  - the inbox (`listThreads()` and `listMessages()` on a whole-mailbox binding) drops what the agent
    archived or trashed;
  - a label binding drops messages the agent removed that label from;
  - every list except explicit trash or spam searches drops what the agent trashed, because Gmail
    leaves trash and spam out of results by default.

  The overlay only drops entries; it never adds them (principle 2). A message the agent moves *into*
  the inbox won't appear in the inbox list until the move is approved.
- **Searches.** Gmail's search syntax is too rich to evaluate locally. Search results therefore stay
  Gmail's, with labels patched.

  On its own that causes a real problem. Picture an agent working through unread mail in a loop:
  search `is:unread`, mark each result read, search again until the search comes back empty. It
  never would come back empty, so the agent would loop forever.

  So the gatekeeper understands a small set of label terms: `is:unread`, `is:read`, `is:starred`,
  `in:inbox`, `in:trash`, `in:spam`, and their negations. It only does this for a query that is a
  plain list of terms, with no `OR` and no grouping. If a message fails one of those terms after
  the overlay, it's dropped. A thread is dropped if none of its messages satisfies one of the
  terms.

  Other terms (`from:`, `subject:`, plain words, dates) can't change when labels change, so Gmail's
  verdict on them still holds. Dropping only on terms the gatekeeper understands exactly means it
  never hides a result that should be there.

### Part 2: Sends

Sending creates a **pending message**. This covers send, reply, reply all, forward and sending a
draft.

- **Opening it.** `getMessage(id)` with the returned `GmailMessageId` opens it immediately:
  - its metadata, headers, body and attachments are those of the email as it will be sent
    (principle 3 lists the exceptions);
  - its labels are `SENT`;
  - its timestamp is when it was submitted;
  - its `id` is the `GmailMessageId`, because Gmail's own ID doesn't exist yet;
  - its thread ID is the source thread for a reply, or the draft's thread when sending a draft that
    already exists in Gmail. It is absent for new mail and forwards, because Gmail assigns those
    threads when it sends.
- **Replies appear in their thread.** They show up in `messages()`, in `messagesVisibleTo()`, and in
  the thread's summary: message count, latest message, participants and timestamp.
- **Sending a draft** also hides the draft's own message from its thread. Gmail lists drafts inside
  threads, so without this the thread would show both the sent reply and the draft.
- **After approval**, the same capability and the same `GmailMessageId` become Gmail's real copy
  without the agent doing anything. The store already records which Gmail ID each sent Message-ID
  maps to when a send completes.
- **After rejection**, the message reports that it was not sent.

A pending message is read-only. The gatekeeper refuses the following, with an error saying they
become available once the message has been delivered:
- labeling, replying to or forwarding the pending message;
- getting the thread of a new message or a forward.

These are rare; an agent seldom stars its own outgoing mail. Supporting them means chaining actions
onto a message whose Gmail ID doesn't exist yet (see Future work).

### What stays unsimulated

- **Search results don't gain new matches.** A pending label change can make a message newly match
  a search (`label:Receipts` after applying Receipts, `in:inbox` after moving a message to the
  inbox). Such messages don't appear.
- **Search only drops on the recognized label terms.** Custom-label terms (`label:name`) aren't
  evaluated, because Gmail matches label names loosely.
- **Pending sent mail doesn't appear in search results or message lists** (for example `in:sent`).
  The agent opens it with `getMessage(id)` instead.
- **Pending messages are read-only.** They can't be labeled, replied to or forwarded. New mail and
  forwards have no thread until they're delivered.
- **Pending reply drafts don't appear in their thread** while the draft itself is still waiting to
  be created. This gap exists today and doesn't change.

### Rejections

The overlay is recomputed on every read, so rejecting an action needs no cleanup beyond what
`rejectAction()` already does. The action leaves the store, and the next read no longer reflects it.

An agent may have built on an action that the user later rejects; for example, it archived a thread
after sending a reply that then gets rejected. It learns of the rejection the same way it does for
any other gatekeeper.

`rejectAction()` can return `restart: true` to ask for a restart. Gmail returns it today when
dependent actions exist. Chat returns it when later actions are pending in the same conversation,
since those were written against a simulation that included the rejected one. The overseer doesn't
currently act on it (overseer.ts:11446), so this plan doesn't rely on it.

### Approval order

The overlay applies pending label changes in the order they were submitted, so it predicts the
result of approving them in that order. Today a user can approve pending actions in any order. If
an agent queues two opposing changes to the same message (`markRead()` then `markUnread()`) and
the user approves the second before the first, Gmail ends up read, not unread as simulated.

This plan doesn't guard against that. Separate work is changing the gatekeeper interface so that
approvals are always applied in order, which closes the gap for every gatekeeper. Until then the
case needs both an agent that contradicts itself and a user who approves out of order. If that
work slips, the stopgap is the check Chat uses (`requireOldestChange`, chat.ts:288): refuse to
apply a mutation while an older pending one makes the opposite change to the same label on an
overlapping message.

## Implementation

Line numbers below are as of this writing.

### New module: `gmail-overlay.ts`

This module holds pure functions with no Durable Object or network access, so they can be unit
tested in Node. It sits next to `gmail-state.ts`, which keeps the draft and label overlays. Message
and thread state is a separate concern.

```ts
/** A pending label change, with label IDs already in the form provider reads use. */
export type PendingLabelChange = {
  actionId: number;
  target: {kind: "messages"; messageIds: readonly string[]} | {kind: "thread"; threadId: string};
  add: readonly string[];
  remove: readonly string[];
};

/** A message this binding has queued for sending, as later reads should show it. (commit 2) */
export type PendingSentMessage = {
  actionId: number;
  /** The GmailMessageId the outbound method returned. */
  rfcMessageId: string;
  /** Replies and drafts that have a thread. */
  threadId?: string;
  /** For draftSend: the provider draft message this send supersedes. */
  supersedesMessageId?: string;
  /** id = rfcMessageId, labelIds = ["SENT"], timestamp = submittedAt. */
  info: GmailMessageInfoRaw;
};

export type GmailOverlay = {
  /** `store.actionGeneration()` when this overlay was loaded. */
  generation: number;
  labelChanges: readonly PendingLabelChange[];  // submission order
  sent: readonly PendingSentMessage[];          // commit 2
  hiddenMessageIds: ReadonlySet<string>;        // commit 2
};

export function overlayMessageInfo(overlay: GmailOverlay, info: GmailMessageInfoRaw): GmailMessageInfoRaw;
export function overlayThreadMessages(
    overlay: GmailOverlay, threadId: string, messages: readonly GmailMessageInfoRaw[],
    admitsPending: (sent: PendingSentMessage) => boolean): GmailMessageInfoRaw[];

/** Label conditions a list's results must satisfy, from the filters Gmail was asked for. */
export type LabelPredicate = {labelId: string; present: boolean};
export function compileListFilter(input: {
  labelIds?: readonly string[];
  queries: readonly string[];
  includeSpamTrash: boolean;
}): LabelPredicate[];
export function messageMayMatch(labelIds: readonly string[], predicates: readonly LabelPredicate[]): boolean;
export function threadMayMatch(
    messages: readonly {labelIds: readonly string[]}[], predicates: readonly LabelPredicate[]): boolean;
```

Commit 1 introduces `generation`, `labelChanges` and the filter functions. Commit 2 adds `sent` and
`hiddenMessageIds`.

### Building the overlay (`gmail.ts`)

`loadGmailOverlay(store)` reads `store.listActions()` and `store.decisions()` once. Both are
synchronous KV reads. Each read path builds the overlay once per call or per cursor page, next to
the existing `currentLabels(ctx)` snapshot (gmail.ts:1537), so a page is internally consistent.

How it builds the label changes:

- **Which actions.** It includes `messageMutation` actions. It also includes the legacy `archive`,
  `trash`, `markRead` and `markUnread` thread actions, which are still applyable and so still
  worth showing; they target every message in their thread.
- **What it skips.** It skips an action whose `dependsOn` includes a rejected decision, or whose
  label resource is `rejected` or `deleted`. This is the same rule `overlayGmailLabels` uses.
- **Label IDs.** A mutation stores a label's *logical* ID.
  - If the label exists in Gmail, map it to the label's provider ID.
  - Otherwise keep the provisional logical ID.

  Provider metadata uses provider IDs. `publicLabels()` (gmail.ts:1475) already resolves both forms:
  provider IDs through the label resource table, provisional IDs through the overlaid label list.
  So the patched list renders correctly with no further change.
- **Actions in the middle of being applied** (`isApplying`) stay in the overlay. Either Gmail has
  already done them or it is about to.
  - For label changes this is harmless: patching a label Gmail has already changed does nothing.
  - For a send (commit 2) it can show the reply twice in its thread, once as Gmail's copy and once
    as the pending message. That lasts for the instant between Gmail accepting the send and the
    store recording it, or, after a send whose outcome is unknown, until the approval is retried.
    This is accepted and not fixed.

### Part 1 steps

1. **Per-message thread metadata.** `GmailApi.getThreadInfo()` (google-api.ts:2383) summarizes the
   thread inside the API layer, which throws away each message's labels.
   - Replace it with `getThreadMetadata(threadId)`. It makes the same `format=metadata` request and
     returns `{id, snippet, messages: GmailMessageInfoRaw[]}`.
   - Call `summarizeGmailThread()` in gmail.ts after the overlay.
   - Callers to update: `gmailFullThreadCursor` (gmail.ts:1930), `getThread()` (2162) and
     `GmailThreadStub.#loadInfo()` (2486).
   - The restricted paths already fetch per-message metadata and summarize in gmail.ts
     (`gmailRestrictedThreadCursor` 2042, `#loadInfo` 2496).
   - No new requests.

2. **Message chokepoint.** Apply `overlayMessageInfo()` inside `messageInfo()` (gmail.ts:1552).
   Every message metadata read goes through it: `GmailMessageStub.getMetadata()` and
   `gmailMessageCursor`. Give it an optional overlay argument, like its existing `labels` snapshot.

3. **Thread chokepoint.** Add one helper that turns per-message metadata into a `GmailThreadInfo`:
   `overlayThreadMessages()`, then `summarizeGmailThread()`, then `threadInfo()`. Use it at all five
   summary sites listed in step 1.

   **The cached summary.** A thread capability from a list or from `getThread()` carries the
   summary computed when it was created, and `#loadInfo()` returns that once without fetching
   (gmail.ts:2480). Left alone, it would skip the overlay: get a thread from a list, archive one of
   its messages through `messages()`, then call `getMetadata()`, and the thread would still show
   `INBOX`.
   - Keep the overlay's `generation` with the cached summary. It is `store.actionGeneration()`,
     a counter that already exists and changes on every submit, apply and reject.
   - `#loadInfo()` uses the cached summary only if the counter is unchanged. Otherwise it drops the
     cache and takes the normal path.

4. **List pruning.** Give each cursor its filter alongside its query:
   - the `listLabelIds()` result (gmail.ts:1841);
   - the binding query and the caller query, *separately*, rather than `effectiveListQuery()`'s
     combined string, so each can be checked as a list of terms;
   - whether spam and trash are included. Export `shouldIncludeSpamTrash()` (google-api.ts:1695) and
     evaluate it on the effective query, exactly as the request does.

   `compileListFilter()` turns that into label predicates:
   - each `labelIds` entry becomes "has this label";
   - if spam and trash are excluded, add "lacks `TRASH`" and "lacks `SPAM`";
   - each query part that is a plain list of terms contributes the terms it recognizes. A plain list
     has no `OR`, `{}`, `()` or `AROUND` outside quotes, and balanced quotes. It can share tokenizing
     with `shouldIncludeSpamTrash()` and `validateGmailQueryForGrouping()`.
     - Recognized terms are `is:unread`, `is:read`, `is:starred`, `in:inbox`, `in:trash`, `in:spam`,
       their `-` negations, and their upper- and mixed-case forms.
     - Unrecognized terms contribute nothing.
     - A part that isn't a plain list contributes nothing at all.

   Then, in each cursor's `buildEntries`:
   - **Message cursor.** Drop entries for which `messageMayMatch()` is false, and dispose their
     stubs. `CursorPager` already walks past pages that end up empty (cursor.ts:26-34).
   - **Full thread cursor.** Drop threads for which `threadMayMatch()` is false. That means *some*
     predicate fails on *every* message in the thread. The API doesn't document whether Gmail
     matches a thread when one message satisfies the whole query, or when each term is satisfied by
     some message. This rule is sound under either reading.
   - **Restricted thread cursor.** Its groups are messages Gmail matched, grouped by thread. Once
     each group's metadata has been fetched, prune the group's messages one at a time before
     building the thread's summary and scope. Drop groups that end up empty. Narrowing a restricted
     scope is always safe.

   Pruning checks every returned entry, not only those with pending changes. That also hides stale
   results Gmail's search index returns shortly after an approved change, which is the same
   correction.

5. **Remove `awaitDecision`** from `submitMutation()` (gmail.ts:2458), along with its comment.

6. **Remove the pending-action limit.** `submitAction()` refuses more than 100 pending Gmail
   actions (gmail.ts:1513). Delete that check. Today an agent rarely gets near 100, because it stops
   after each action. A triage agent working through a large inbox without auto-approval now will.
   - The limit isn't protecting storage. A pending send stays under about 100 KB: text and HTML
     share one 64 KB cap (gmail-validate.ts:119), and a draft's stored state is capped at 96 KB
     (`validateDraftState()`). A label change is a few hundred bytes, and forward snapshots keep
     their own 50 MB cap.
   - A very large queue does cost memory and time, because read paths and `GmailStore`'s
     constructor list every pending action. That isn't a security concern: a binding's storage
     belongs to one workspace's Durable Object, so a runaway queue only hurts that workspace.
   - We don't try to cap it in advance. If large queues cause trouble in practice, fix what
     actually breaks. The likely fix is a lightweight index of what the overlay needs, with send
     bodies loaded only when a pending message is opened.

7. **Agent docs** (types.d.ts). Under `searchThreads()` and `searchMessages()`, note that which
   messages match may not yet reflect very recent label changes, although each result shows its
   current labels. Nothing else changes for the agent in this commit.

Left unchanged:
- approval descriptions and auto-approval metadata;
- `applyMessageMutation()` (see "Approval order" above);
- the admission checks for restricted bindings (`messageStillAvailable()` and its relatives). These
  stay provider-based: they are security checks, and the overlay only ever narrows.

### Part 2 steps

1. **Record submission time.** Add `submittedAt: number` to `GmailSendAction` and
   `GmailDraftSendAction`. Actions stored before this change don't have it, so fall back to the
   time of the read. Their turns were suspended under the old behavior, so it barely matters.

   Also add an optional `submittedAt` to `GmailSentMessageReceipt`, copied from the action when
   `completeSentAction()` records the receipt. Step 7 needs it after the send has been delivered.
   The receipt conflict check in `#recordSentMessage()` keeps comparing only its three existing
   fields.

2. **One outbound builder.** Move the code in `applyAction()` that turns a stored send into the
   final email into a new function, `buildPendingOutbound(api, store, action, date?):
   Promise<GmailOutboundMessage>`.
   - `send`: call `exactSpecWithSource(api, store, action.spec, sendSourceSnapshot(action),
     inline)`, then `api.buildOutbound(spec)` (gmail.ts:3822-3824).
   - `draftSend`: the `approvedSpec` computation (gmail.ts:4105-4111). For a draft that already
     exists in Gmail, this reads the provider draft's attachments.

   `applyAction()` and the pending message both call it. Fingerprinting and reconciliation stay in
   `applyAction()`, so the pending message doesn't check the draft against what was approved
   (principle 3).

   Two details for the pending-message caller:
   - **`Date`.** A plain send or reply stores no date, and the MIME library fills in the current
     time on every build. So the pending message passes `submittedAt` as `date`, which the builder
     uses only when the stored spec has no date of its own. Repeated reads then agree with each
     other and with the message's timestamp. `applyAction()` passes nothing, so the real email is
     still dated when it is sent.
   - **Missing draft.** If the Gmail draft can't be read, `getHeaders()`, `getContent()` and
     `attachments()` throw. This happens after a draft send whose outcome is unknown, where Gmail
     may already have consumed the draft. `getMetadata()` still works, because it doesn't build
     the email.

3. **Pending sent messages in the overlay.** `loadGmailOverlay()` adds a `PendingSentMessage` for
   each `send` and `draftSend` action. Legacy outbound actions are excluded; they fail closed.
   Metadata comes from the stored spec or the approved draft state, without building MIME:
   - from, to, cc and bcc via `emailRecipientToAddress()`;
   - subject;
   - `submittedAt` as the timestamp;
   - labels `["SENT"]`;
   - `threadId` from `action.threadId` (reply) or `approved.threadId` (draft).

   For `draftSend`, `supersedesMessageId` is `action.expectedProviderMessageId ??
   action.approved.messageId`, and it goes into `hiddenMessageIds`. It is absent for a draft still
   waiting to be created. The order matters:
   - `approved.messageId` is the draft's Gmail message ID when the send was submitted. It is never
     updated afterwards.
   - Gmail gives a draft a new message ID each time it is created or updated. When a pending
     create or update is approved, `#completeDraftWrite()` writes the new ID into the next pending
     action's `expectedProviderMessageId` (gmail.ts:704-709).
   - So after "create a reply draft, then send it" with the create approved first, only
     `expectedProviderMessageId` names the draft message Gmail now has. This is the usual sequence
     when draft actions are auto-approved, since sends never are.

   A pending `draftDelete` also hides its draft's message when that ID is known
   (`expectedProviderMessageId`).

4. **`GmailPendingMessageStub`** implements `GmailMessage` and holds the `GmailMessageId`. Each call
   first works out where the message currently stands, like Chat's `resolveMessage()`
   (chat.ts:378):
   - if a sent receipt exists (`store.sentMessageByRfcMessageId()`), delegate to a
     `GmailMessageStub` for the provider ID, scoped the way `getMessage()` scopes sent mail today;
   - if the send is still pending, serve the simulation;
   - otherwise, throw "This message was not sent."

   The simulated methods:
   - **`getMetadata()`** returns the overlay's info, passed through `messageInfo()` so the labels
     render normally.
   - **`getHeaders()`, `getContent()` and `attachments()`** build the outbound message once (step 2)
     and wrap it as a `GmailMessageRaw`. They then parse it with the existing parsers:
     `api.parseMessageHeaders()`, `api.parseMessage()`, and `parseSafeGmailDraft()` for attachment
     bytes (as `sentMessageFingerprint()` already does).
   - **`thread()`** returns the thread capability for `threadId` when the message has one (a reply,
     or a draft that already exists in Gmail). That thread includes this message (step 6). For new
     mail and forwards it throws.
   - **Mutations, `reply()`, `replyAll()`, `forward()` and the `create*Draft()` methods** throw
     "available once the message has been delivered".

   Each read authorizes an observation, the same way the provider-backed stub does.

5. **`getMessage()`** (gmail.ts:2118-2139). At the point where it now throws "This Gmail send is
   pending", return a `GmailPendingMessageStub` instead. Drop `GmailStore.hasPendingSend()` if
   nothing else uses it.

6. **Replies in threads.** `overlayThreadMessages()` drops `hiddenMessageIds`, and appends pending
   sent messages whose `threadId` matches, ordered by timestamp.

   A pending message is visible wherever the delivered message would be:
   - **Whole-mailbox scope:** always.
   - **Restricted scope:** only in the thread capability obtained from the pending message itself
     (`pendingMessage.thread()`). This matches how a delivered reply is admitted today, through
     `getMessage(id).thread()` (gmail.ts:2703-2711; see the test "admits a sent message created
     through a restricted binding"). To implement it, put the `GmailMessageId` in that capability's
     `admittedMessageIds`, and resolve it to the provider ID once a receipt exists. It must be kept
     apart from provider IDs wherever the scope is turned into Gmail requests or `GmailMessageStub`s.

   Apply this in three places, returning `GmailPendingMessageStub`s for the pending entries:
   - thread metadata (`#loadInfo()`);
   - `messages()`;
   - `messagesVisibleTo()`, matching on the spec's From, To, Cc and Bcc.

   Message cursors also drop hidden draft messages, which can turn up in search results.

   Thread *lists* need nothing added. A delivered reply joins a thread that is already there, so it
   changes that thread's summary rather than which threads are listed. A reply also carries only
   `SENT`, so it doesn't bring an archived thread back into the inbox. A search that the reply
   itself would newly match falls under the "search results don't gain new matches" gap.
   Restricted thread lists leave pending replies out of their summaries too, because a restricted
   binding counts a delivered reply there only if the reply matches the binding's restriction, and
   that isn't evaluated locally.

7. **Mutations that name a message this binding sent.** A thread summary now reports a pending
   reply as its `latestMessageId` when that reply is the newest message. Agents are told to pass
   `latestMessageId` to `archive()` and the other mutations, so `gmailThreadMutationTarget()`
   (gmail-scope.ts:39) must accept it.

   A caller may hold that ID for a while, for example while a gadget shows the thread to a user.
   The user can approve the send in the meantime. The same ID must then keep working, and keep
   meaning "the messages I saw".

   So when `lastMessageId` is a `GmailMessageId` rather than a Gmail ID, `#mutate()` looks it up
   first as a pending send in this thread, then as a sent receipt for this thread:
   - **The cutoff is the send's `submittedAt`,** from the pending action or from the receipt
     (step 1). Target the provider messages whose timestamps are at or before it. That is what the
     agent saw, because any provider message newer than that would itself have been the latest
     message.
   - **The cutoff doesn't move when the send is delivered.** Gmail timestamps the delivered reply
     at approval. Mail that arrived between submission and approval was never seen, and stays out
     of the target.
   - **The reply itself** is never in the target while pending, because it has no Gmail ID yet.
     Once delivered, it is included if the capability's scope admits it.
   - **A receipt with no `submittedAt`** (a send completed before this change) falls back to the
     existing rule, with the reply's Gmail ID as `lastMessageId`.
   - **A send that was rejected, or an unknown ID,** gets the existing "not a message of this
     thread" error.

   One imprecision is accepted: mail imported into the thread later with an older date falls under
   the cutoff.

   `#mutate()` needs each message's timestamp for this. Use the per-message metadata from Part 1
   step 1, or keep `internalDate` from the `format=minimal` thread read if Gmail returns it there.
   It resolves the boundary from the store and passes it in, so `gmailThreadMutationTarget()` stays
   a pure function.

8. **Remove `awaitDecision`** from `send()`, `#reply()`, `forward()` and `GmailDraftStub.send()`.
   Also remove the now-unused `awaitDecision` field from `submitAction()`'s parameter type
   (gmail.ts:1511).

9. **Agent docs** (types.d.ts):
   - `GmailMessageId`, `send()`, `reply()`, `replyAll()`, `forward()` and `GmailDraft.send()`: the
     message can be opened with `getMessage()` immediately. Drop "once sent".
   - `GmailMessageInfo.id`: for a message this binding just sent, it is the `GmailMessageId` until
     Gmail assigns its own ID. `getMessage()` accepts both.
   - `searchMessages()`: replace "retry a query such as `in:sent`" with "mail you've just sent may
     not appear in search results; open it with `getMessage(id)`". With simulation in place, the
     current advice would make an agent poll search until the user approves.
   - A short note on what a just-sent message can't do yet: labels, reply and forward, and `thread()`
     for new mail. The Chat gatekeeper documents its pending messages in the same spirit
     (chat-types.d.ts:137-147).

### Tests

Unit tests (Node, new `__tests__/gmail-overlay.test.ts`):
- Label changes:
  - they apply in submission order, and a later remove cancels an earlier add;
  - actions with a rejected prerequisite or a rejected label are skipped;
  - both provisional and provider label IDs work;
  - legacy thread-targeted actions apply to every message in their thread.
- Thread summaries: `unread`, labels, count, latest message and participants, with messages both
  patched and appended, and with draft messages hidden.
- Filter compilation:
  - recognized terms, their negations, and case-insensitivity;
  - quoted values;
  - `OR`, grouping or `AROUND` switching a part off;
  - unrecognized terms ignored.
- `messageMayMatch()` and `threadMayMatch()` drop only when a recognized term fails. For threads, the
  rule is "one predicate fails on every message".
- `gmailThreadMutationTarget()` with a `lastMessageId` this binding sent:
  - pending: targets the messages at or before the cutoff, and not the reply;
  - delivered: same cutoff, plus the delivered reply, and not a message that arrived between
    submission and approval;
  - a receipt with no `submittedAt` uses the existing rule.

Workerd tests (`__tests__/workerd/gmail-actions.test.ts`):
- **Mark read.** Message and thread metadata show the change before apply. After apply, and after
  reject, they show the provider state. Extend the existing test at line 2874.
- **Cached thread summary.** Take a thread from a list, archive one of its messages through
  `messages()`, then call the thread's `getMetadata()` for the first time. It reflects the archive.
- **No action limit.** More than 100 label changes can be pending at once.
- **Lists.**
  - Archive removes the thread from `listThreads()` and the message from `listMessages()`.
  - Trash removes the message from search results.
  - `searchThreads("is:unread")` comes back empty after each result is marked read (the loop case).
- **Label binding.** Removing the binding's label drops the message from the binding's lists. No
  list ever gains messages.
- **Descriptions.** No Gmail action description includes `awaitDecision`. The fake queue records
  full descriptions (`__tests__/workerd/worker.ts:112-123`).
- **Opening a pending message.** `getMessage(id)` returns metadata, headers, content and attachments
  for each kind of send:
  - a new message;
  - a reply;
  - a forward, including the source's attachments;
  - a draft send, including an inline-forward draft and an imported draft with attachments.

  A pending reply's `Date` header is the same on every read.
- **Threads with a pending message.**
  - A reply shows up in its thread's metadata, `messages()` and `messagesVisibleTo()`.
  - A draft send hides the draft message.
  - Create a reply draft, send it, then approve only the create. The thread still hides the draft
    message Gmail now has.
  - `archive(latestMessageId)` works when the latest message is pending.
  - The same call with the same ID works after the reply is approved. It leaves alone a message
    that arrived between submission and approval.
- **Lifecycle.**
  - After apply, the same capability resolves to the provider message.
  - After reject, it throws.
  - Mutations and replies on a pending message throw.
  - Restricted bindings follow the visibility rule.
- **Existing tests to update.** Two assertions check that a pending send can't be opened
  (gmail-actions.test.ts:743 and 2071-2072).

### Rollout and compatibility

- **No storage migration.** Actions already pending when this deploys lack `submittedAt`, and so
  do sent receipts recorded before it. Both are handled. The overseer already holds the pending
  actions' descriptions with `awaitDecision`, so turns they suspended still resume as before.
- **One PR, two commits.** Commit 1 (label changes) stands alone: it builds, passes tests, and
  removes `awaitDecision` from mutations. Commit 2 (sends) builds on commit 1's overlay module and
  thread chokepoint. Keep each commit's agent docs and tests with its code, so either can be
  reviewed or reverted on its own.
- One PR is fine because everything is in `gatekeeper-google`. The repo's guidance to split large
  changes into PRs is about kernel code (`workshop-backend` and `workshop-shared`).
- **No changes to `workshop-backend` or `workshop-shared`.**

## Open questions

To check against a live account:
- whether `format=minimal` thread reads include `internalDate` (Part 2 step 7);
- whether adding `TRASH` through `batchModify` also removes `INBOX`. This affects which labels a
  simulated trashed message shows, not which lists drop it;
- that drafts appear in `threads.get` results, and that `drafts.send` keeps the draft's thread ID
  (Part 2 steps 3 and 6);
- whether a message sent to the connected address gets `INBOX` and `UNREAD`. If so, a pending send
  addressed to the connected address should carry them too.

## Future work

- **Actions on pending messages.** Let a mutation, reply or forward name a pending message. Store
  `dependsOn: [sendActionId]`, and look up the Gmail ID from the sent receipt at apply time. The
  existing dependency handling (`gmailDependencyError`) already covers a rejected prerequisite.
- **A single-message pending thread** for new mail and forwards, so `thread()` works on them.
- **Pending reply drafts shown in their thread.**
- **Hiding a draft's message while more than one write to that draft is still pending.** The ID a
  pending `draftSend` or `draftDelete` holds is brought up to date only when the write directly
  before it is approved. With two writes ahead of it (create, update, send), the draft message is
  visible between the first approval and the second. A `draftDelete` queued behind even one
  pending update holds no ID until that update is approved, so the draft message stays visible
  until then. Closing this means matching on the draft's Message-ID header rather than its Gmail
  message ID.
- **Custom-label terms (`label:name`) in search pruning.**
