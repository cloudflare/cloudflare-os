# Plan: Step-transactional agent effects

## Goal

Make an agent tool call's chat-content side effects durable **iff** the tool call's
transcript record is durable — one transaction per model step.

Terminology: a **step** here is one model request plus its tool batch (pi calls this a
"turn"; agent.ts's `turn_end` is the per-step event). The chat-level *turn* is the
whole agent run, which may span many steps.

Today an agent edit becomes a durable, broadcast `chatChanges` row the moment the
tool executes (`#appendChatChangeRow`, overseer.ts:2539), while the `AiToolCall`
record that explains it persists only at the step's `turn_end` barrier, after the
rest of the tool batch (agent.ts:3008-3111). A crash in between leaves content the
transcript cannot account for; on resume the model re-runs the step against content
that already contains its edits — `writeFile` survives by idempotence, `editFile`
double-applies or fails on a missing find-string. This is a live bug. (The *other*
crash window — rows and step message durable, end-of-turn flush lost — is the one
today's replay-discharge machinery handles; this plan makes both windows impossible
and deletes that machinery.)

The fix is also the foundation the worktrees plan builds on: with effects buffered
until the barrier, worktree binding writes inherit transactional crash semantics for
free, and worktree `commit()` head advancements need no staging collection and no
vouching (see plans/worktrees.md, whose backend commits require this plan to land
first).

## Locked decisions

- **All agent-authored code changes buffer in memory until the step's persistence
  barrier.** That covers the writeFile/editFile tools (whatever workpiece they
  target — identical file-tool semantics across gadgets and worktrees is a core
  worktrees goal), blueprint file copies inside `createGadget`, and (once worktrees
  land) worktree binding writes and `commit()` head advancements. Within a step,
  later tools read through the buffer (session content already works this way);
  nothing is durable or broadcast mid-step.
- **The barrier is one `transactionSync()` block.** At `turn_end`, in one storage
  transaction: persist the step's tool-call message, append the buffered changes
  as rows, materialize them into the step's single `"changes"` message, retire
  the rows, and stamp pending gadget/binding records. Agent rows are thus **born and retired in
  the same transaction** — the *live* rows in `chatChanges` become user-authored
  only, and no crash or mid-barrier exception can strand an agent row without its
  transcript record or vice versa. (A DO's synchronous writes are already
  implicitly atomic against crashes; the explicit transaction adds rollback when
  an application exception escapes mid-block, which implicit atomicity does not.)
- **The wire protocol is unchanged.** Rows still go out as `changeApplied` (now in
  a burst at the barrier) and the message's watermark still covers them; zero
  frontend changes. Message-borne-only delivery was considered and rejected:
  caught-up clients ignore the message's `change` payload entirely (they prune by
  watermark — otClient.ts:378-396), client-side transform against a composed
  message change doesn't exist (a watermark gap triggers rebuild, discarding
  unacked local edits after 5s — otClient.ts:295-348), and rows must remain in the
  protocol regardless for user edits (multi-tab) and the server's resubmission
  transform window — so message-only delivery would *add* a client ingestion path
  while removing nothing.
- **Streaming is unaffected.** The live preview is the `editPreview*` stream fed
  from the model's raw tool-call input fragments as it generates
  (code-preview.ts:53-133, api.ts:3237-3286), not OT rows; the barrier's row
  broadcast supersedes previews at step end instead of per call. The stale "the row
  doubles as the streaming preview" comment (agent.ts:297) gets fixed —
  overseer.ts:2904-2906 already states the correct supersedes relationship.
- **executeCode after any buffered edits throws.** Once the step buffer holds
  any change, executeCode fails with a retryable, agent-visible error ("changes
  land next step — retry") instead of running provisional code. Deliberately
  coarse — no per-gadget touched-set, no machinery in the gadget-loading path:
  editing code and then executing it in one step never worked (and agents don't
  try it), and worktrees keep the same rule (their writes happen *inside*
  executeCode, and a second executeCode in one step is never sensible — the
  agent writes one script that does both things). This replaces what the
  mid-tool flushes guaranteed, and closes by construction the historical
  corruption where a mid-turn flush materialized a `"changes"` message
  containing a not-yet-persisted step's changes.
- **User submissions stay rejected during agent turns** (reject + client-side
  buffering and retry: overseer.ts:3013-3017, otClient.ts:125-136). Restoring
  durable server-side drafts mid-turn — which the pre-git-storage
  `chatDraftUpdates` mechanism had, and which survives tab close — is a severable
  follow-up: it requires transforming live user rows against barrier messages,
  machinery that doesn't exist and isn't needed here.
- **Abort semantics stay: stop, don't revert.** Abort drops the in-flight step's
  buffer (nothing durable exists yet); completed steps' effects are ordinary
  message-recorded state that abort keeps, exactly like today's documented
  behavior (agent.ts:3157-3165). The user reverts explicitly if they want the
  turn's work gone.
- **Crash-mid-step loses the whole step, by design.** Even the effects of tools
  that completed earlier in the batch evaporate — correct, because the step's
  message is lost and the resumed model re-runs the whole step from the top.

## Current-state anchors (for orientation)

- Turn loop: pi's `runAgentLoopContinue` (agent.ts:3134) with
  `toolExecution: "sequential"` (agent.ts:3138); per step: stream assistant
  response → execute tool batch → `turn_end` emit.
- Persistence barrier: the `turn_end` case (agent.ts:3008-3111) — "one durable
  chat-log step per completed model turn" — calling `hooks.addChatMessages`
  (agent.ts:3103), which is synchronous end-to-end and already stamps pending
  gadget/binding records in the same step (overseer.ts:7013-7091, stamping at
  7035-7056). Errored/aborted model steps persist nothing (agent.ts:3013-3018); a
  step cancelled mid-batch persists, with pre-empted calls recorded as errors
  (agent.ts:3019-3024, 3050-3057).
- Agent edit path today: writeFile/editFile tools → `appendAgentEdit`
  (agent.ts:2067-2078) → `appendAgentCodeChange` (overseer.ts:2911-2957; prefetch,
  then a synchronous tail that throws if content moved) → `#appendChatChangeRow`
  (overseer.ts:2539-2573; durable row + `changeApplied` broadcast, per tool,
  mid-step).
- Flush: end-of-turn `flushPendingChanges` in the loop's `finally` (agent.ts:3164)
  → `flushAgentChanges` → `materializeChatChanges` (overseer.ts:2792-2875), which
  already guards against non-agent materialization during a turn
  (overseer.ts:2806-2809). Mid-tool flush call sites: setGadgetBinding
  (agent.ts:2630), createGadget (agent.ts:2690), blueprint copy (agent.ts:2740 —
  deliberately *before* the step message, with its residual crash window
  documented at 2731-2739), executeCode (agent.ts:2803), compaction early-return
  (agent.ts:2265).
- Crash recovery today: the rows-and-message-durable-but-flush-lost window is
  handled by replay discharge (`listUnmaterializedChatChanges`,
  agent.ts:1984-2000, overseer.ts:2893-2902) and by vouched re-adoption of
  creations/bindings (agent.ts:2002-2020; `reconcilePendingGadgets`,
  overseer.ts:2040-2118). The rows-durable-but-message-lost window is the bug.
- Agent reads: immutable turn-start `sessionContent` (agent.ts:989-993); unpinned
  gadgets read at a head fixed at first observation (`observeHead`,
  agent.ts:1000-1008). User submissions cannot interleave (rejected mid-turn),
  which is what makes `appendAgentCodeChange`'s staleness check a bug detector
  (overseer.ts:2922-2932).
- `ChatChangeRecord.source` is written but read by nothing; its "turn abort keys
  on 'agent'" comment (overseer.ts:642-643) is aspirational — today's abort keys
  on nothing and discards nothing.

## Design

1. **Step buffer.** The agent session accumulates the step's `CodeChange`s
   (ordered, keyed by workpiece) instead of calling `appendAgentCodeChange` per
   tool. `appendAgentEdit` becomes: compute the change (same prefetches), push to
   the buffer, update session content. The created-gadget/binding recordings that
   already accumulate turn-side (`pendingCreatedGadgets` etc.) keep working as
   they do — only the rows move to the barrier. The buffer is a small turn-owned
   object (created in `runAgent` beside the other per-step state, cleared at
   each barrier), **passed explicitly** wherever it's needed — to the barrier
   hook now, and into `executeCodeMode` when worktrees land so the worktree
   binding loopbacks can read/write it by reference (agent↔overseer is a
   same-isolate direct call; there is no marshalling boundary). No ambient
   buffer state on the overseer's live chat context.
   **Row granularity is one row per buffered tool change, in call order —
   never a pre-composed row.** The client resolves streaming previews by
   shifting the oldest pending preview per file as each `changeApplied` row
   arrives (GadgetCodeInterface.tsx:296-305), so the barrier's burst must
   preserve the per-call row↔preview correspondence.
2. **Barrier extension.** The `turn_end` handler passes the buffer to the overseer
   via a **new dedicated hook, `commitAgentStep`** (not an extended
   `addChatMessages`, which has six non-agent callers that would all be touched
   by a widened signature) which, inside one
   `transactionSync()` block (via typed-storage's `TypedStorage.transaction`,
   today a bare delegate to `transactionSync` but the natural place to later
   grow transaction-aware behavior, e.g. delaying subscription callbacks until
   commit): persists the step's tool-call
   message, validates and appends each buffered change as a `chatChanges` row
   (the same pin/codeBase bookkeeping as `appendAgentCodeChange`'s synchronous
   tail, with the prefetches hoisted before the block), materializes the rows
   into the step's single `"changes"` message carrying
   `createdGadgets`/`addedBindings` (exactly one message — see the no-chunking
   policy below), retires the rows, and stamps pending records. Broadcasts
   (`changeApplied`, message delivery) fire immediately from inside the block,
   as they always have. **This is an explicit, deliberate decision — do not
   "fix" it in passing**: the underlying collection subscription callbacks fire
   on write and ignore transactions, so deferring broadcasts to commit would
   mean rerouting the whole subscription path — convoluted, and out of scope.
   The trade, stated honestly: the transaction protects **server-side** storage
   only. If a bug throws mid-barrier, clients may receive broadcasts for
   rolled-back rows, and because rollback un-bumps the revision counter while
   the client dedupes rows first-seen-wins by `(generation, revision)`
   (otClient.ts:360-371), a later real row can be silently shadowed until the
   client refreshes or rebuilds — not merely transient flicker. We accept this
   because a mid-barrier exception is itself a bug (the transaction exists as a
   safeguard, not an expected path), and server-side consistency is what must
   survive it. If it ever bites in practice, the cheap hardening is a
   rollback-path resync signal (force-resubscribe or a generation bump) rather
   than transactional broadcasts — noted in future work.
   **Ordering within the step: the tool-call message first, then its changes
   message.** Reverts are suffix-only (`revertFrom` through end,
   overseer.ts:3684ff, api.ts:2664-2672), so this order makes it impossible for
   a revert to erase a call while keeping its edits — content can be reverted
   out from under a surviving call (today's turn-grouped revert, handled by the
   revert observation, agent.ts:1856-1879, and replay elision), but never the
   reverse, which would recreate exactly the content-without-transcript state
   this plan exists to kill. (The blueprint flush's changes-first precedent was
   motivated by crash ordering, which barrier atomicity dissolves.)
3. **Chunking removed: bound the input, don't split the output.** Today
   `materializeChatChanges` splits an over-budget composition into multiple
   `"changes"` messages (`CHAT_CHANGE_MESSAGE_BUDGET`, overseer.ts:821-842 — an
   anti-wedge valve: rows retire only on success, so an unstorable message
   would retry forever). Multi-message flushes have two soft spots: replay
   numbers each message as its own changeId while the live counter bumps once
   per flush (agent.ts:1837-1838 vs. agent.ts:2051-2059 — a pre-existing
   live/replay numbering drift), and the extras
   (`pins`/`createdGadgets`/`addedBindings`, overseer.ts:2854-2868) ride the
   first message only, so a suffix revert landing mid-flush would keep
   creations and earlier edits while discarding later ones. Rather than
   patching those with grouping metadata, delete the chunking loop — **one
   message per materialize call, always** — and make every composition fit by
   bounding what accumulates:
   - **User rows**: raise `CHAT_CHANGE_MATERIALIZE_THRESHOLD` from 128 to
     **1000** — its real job is compacting keystroke-granularity ops into few
     large ops (128 rows is only a line or two of typing) — and add a **byte
     trigger** beside it: materialize the pending rows *before* appending a row
     that would push the pending composition estimate past **1MB** (staying
     well clear of the 2MB record cap; the estimate is `codeChangeSerializedSize`
     — an O(entries) upper bound on the rows' V8-serialized storage footprint,
     2 bytes per UTF-16 code unit plus fixed structure overhead. DO storage
     V8-serializes records, so a JSON-text measure would overcount escapes and
     multi-byte text and cost a serialization per row; summing rows bounds
     their composition). Carve-out unchanged from today's
     lone-oversized-row chunk: a single change may reach `MAX_CODE_CHANGE_SIZE`
     (2MB, code-change.ts:144) and then travels alone in one oversized message
     — storage already held it as a row. Accepted, no migration: a live window
     whose rows predate this change and already sum past what one message
     record can hold would fail to materialize — but the deployment is in
     early testing and users almost never hand-edit code, so a multi-megabyte
     unmaterialized window does not plausibly exist.
   - **Step buffer**: a `STEP_CHANGE_BUDGET` (**~1.5MB**) on the buffer's total
     change size, enforced **at the write call** — the file-tool call or
     worktree `writeFile` RPC that would exceed it fails with an actionable,
     agent-visible error ("too many changes in one step; split the work across
     steps"), everything buffered before it persists normally, and the model
     can adapt mid-turn. Sizing rationale: the budget must admit one maximal
     single change, and the proxy is `codeChangeSerializedSize` (≤ 2 bytes per
     UTF-16 code unit plus fixed overhead), so a maximal whole-file `set`
     (`MAX_FILE_TEXT_LENGTH` is 512K units; worktrees'
     `MAX_WORKTREE_FILE_SIZE` respects the same cap) measures ≤ ~1MB — 1.5MB
     admits any valid single file write with margin, while keeping the step's
     single message, envelope included, below the 2MB record cap the estimate
     upper-bounds against. File tools can't realistically hit the budget
     (their content is model output); script-driven worktree writes can. A
     barrier-time transaction failure remains the backstop if anything slips
     through. Known, accepted gap: `createGadget`'s blueprint copy is a single
     multi-file change that may legally reach `MAX_CODE_CHANGE_SIZE` (2MB) —
     past the budget. **No carve-out**: no existing blueprint exceeds 1MB, and
     the planned Yjs→git blueprint format rework resolves this class of problem
     outright.
   The changeId drift dies by deletion (one message per flush — live and
   replay counting trivially agree), and a revert can never split a step's
   effects: extras and edits share the step's single message. This also
   resolves what an aggregate step-buffer bound is *for*: correctness (the one
   message must fit a record), with bounded memory as a side effect.
4. **Mid-tool flushes removed** (agent.ts:2630, 2690, 2740, 2803). The blueprint's
   copies ride the buffer and persist with their `createGadget` call — the
   2731-2739 crash window closes. The end-of-turn flush in the `finally`
   (agent.ts:3164) is deleted: every completed step barrier-commits its own
   effects, and an abort's in-flight buffer is memory only. **Exception, until
   the machinery deletion lands (commit 3): the compaction early-return keeps a
   flush** (`flushReadoptedChanges`, backed by the transitional
   `flushAgentChanges` hook) — a crashed *pre-barrier* turn's re-adopted
   rows/creations/bindings must be covered by a message before compaction
   removes the log tail replay re-adopts them from. It dies with the
   re-adoption machinery itself.
5. **executeCode guard.** The executeCode tool checks the step buffer before
   running: non-empty ⇒ throw the retryable error. One `if` in the tool, no
   changes to the gadget-loading path (see the locked decision).
6. **Machinery deletion.** With no live agent rows possible outside the barrier:
   delete the replay-discharge path and `listUnmaterializedChatChanges`; delete
   the vouched re-adoption scan (agent.ts:2002-2020); shrink
   `reconcilePendingGadgets` to "unstamped ⇒ reap (only a mid-step crash can
   produce one, and its step message is by construction lost),
   stamped-but-reverted ⇒ remove". Fix the stale comments (agent.ts:296-305
   preview claim; overseer.ts:642-643 abort claim).
7. **Hardening.** `materializeChatChanges` throws whenever a turn is active unless
   invoked by the barrier (tighten the existing guard at overseer.ts:2806-2809).
   Between turns it sweeps user rows exactly as today.

## Edge cases / watch-fors

- **`createGadget` record creation stays immediate.** The registry record (and its
  name reservation via the unique `byBindingName` index) is created mid-step as
  today, `pending` and unstamped; only its *stamping* is barrier-bound. Deferring
  creation to the barrier would surface name conflicts after the model already saw
  the tool succeed. The stamped⇔persisted-call equivalence is what lets the
  vouching scan die: an unstamped record now *always* means a mid-step crash.
- **Step-buffer size**: per-file and per-change caps bound each buffered item
  (`MAX_CODE_CHANGE_SIZE`, the file-size caps), and `STEP_CHANGE_BUDGET` bounds
  the step's total at write time (Design §3) — needed for correctness (the
  step's single message must fit a storage record), with bounded buffer memory
  falling out as a side effect rather than a goal.
- **Preview supersession timing**: `editPreview*` previews for completed calls now
  live until the barrier's row broadcast (or the step's failure withdraws them).
  Verify the client clears a preview on row arrival rather than on tool
  completion, and that `tool_execution_end` withdrawal (agent.ts:2994-3002) still
  covers failed calls.
- **Cancel mid-batch**: completed calls' buffered effects persist with the step
  message (pre-empted calls record errors) — effects land iff their call's record
  lands, which is the invariant this plan exists to establish. Today's rationale
  comment ("the durable side effects already happened", agent.ts:3019-3024)
  inverts but the observable behavior is unchanged.
- **Read-your-writes**: session content already layers the buffer's effects;
  unpinned-gadget reads (`readCommitFiles(head)`) and the read-before-edit gate
  are unaffected.
- **Client compatibility**: subscribers see per-step `changeApplied` bursts
  followed by the watermark-bearing message — the same sequence as today's
  per-turn pattern, compressed in time and repeated per step. Revisions stay
  gapless; the retired-row transform window for post-turn user resubmissions is
  intact.

## Tests

(workshop-backend workerd suite)

- **Double-edit regression**: crash between a tool's execution and the barrier →
  no durable trace of the edit (no rows, no message); the resumed turn re-runs the
  step cleanly against unmodified content.
- **Barrier atomicity**: a persisted step message implies its changes message,
  row retirement, and stamps are persisted — assert the public invariant that
  every persisted writeFile/editFile/executeCode call's edits are message-covered,
  and that an unstamped pending record never coexists with its persisted creating
  call.
- **Barrier exception rollback**: an exception thrown mid-barrier (injected after
  the tool-call message put) leaves no partial durable state — no message, no
  rows, no stamps. (Broadcasts may have escaped; only server-side consistency is
  asserted.)
- **No chunking / input bounds**: a write that would push the step buffer past
  `STEP_CHANGE_BUDGET` fails with the actionable error while earlier buffered
  writes persist normally at the barrier; user typing past the 1000-row
  threshold materializes; a user submission that would push the pending
  composition past 1MB materializes the pending rows first; a single
  `MAX_CODE_CHANGE_SIZE` change still lands (alone, in one oversized message);
  every materialize call writes exactly one message, and live vs. replay
  changeId numbering agree across a flush that would previously have chunked.
- **Blueprint createGadget**: crash before the barrier leaves no copied content
  and an unstamped record that reconciliation reaps; success persists copies,
  creation, and call atomically.
- **Abort mid-step**: buffer dropped, prior steps' messages intact, nothing
  reverted.
- **executeCode guard**: executeCode after any buffered edit throws the
  retryable error; the next step succeeds.
- **User submission mid-turn** still rejected; post-turn resubmission transforms
  against the turn's retired rows (window intact across multiple per-step
  flushes).
- **`reconcilePendingGadgets`**: an unstamped record (simulated mid-step crash) is
  reaped with no vouching scan; a stamped record whose message a revert covers is
  removed.

## Commit sequence

1. **Chunking removal + materialization bounds** — standalone; depends on
   nothing else here and fixes the changeId numbering drift on its own. Delete
   the chunking loop (one message per materialize call), raise the materialize
   threshold 128 → 1000, and add the 1MB byte trigger at row-append time on
   user submissions. The agent path gets a *transitional* equivalent — until
   commit 2, agent rows still append per-tool and compose over a whole turn
   (many steps), so a turn-spanning composition must be kept storable — but it
   lives **agent-side, not in the overseer**: `appendAgentEdit` tracks the
   turn's pending composed size and calls the agent's own
   `flushPendingChanges()` when an append would push it past 1MB. That reuses
   the existing mid-turn flush path (same one executeCode/createGadget already
   call), so `nextChangeId` increments with the flush as it always does and
   live/replay numbering stay in step — an overseer-side trigger would write a
   message behind the agent's counter. Live and replay changeId numbering agree
   from here on. Tests: the no-chunking/input-bounds bullets minus
   `STEP_CHANGE_BUDGET`.
2. **Buffer + barrier**: step buffer, barrier extension (transactional, tool
   message first), `STEP_CHANGE_BUDGET` enforced at the write call — which
   supersedes commit 1's transitional agent-side flush trigger (removed along
   with the per-tool append path) — mid-tool flush removal, executeCode
   guard, materialize hardening, and the remaining behavior tests. One
   reviewable commit — these pieces are not independently shippable.
3. **Deletions + comment fixes**: replay-discharge path,
   `listUnmaterializedChatChanges`, vouched re-adoption,
   `reconcilePendingGadgets` simplification, stale comments. Green on its own;
   separated so the kernel reviewer sees the semantic change and the cleanup
   apart (AGENTS.md kernel bar).

## Punted / future work (deliberately kept open)

- Durable server-side user drafts during agent turns (restores the tab-close
  survival the Yjs-era `chatDraftUpdates` had; needs live-row-vs-barrier-message
  transform machinery).
- Delivery-time elision of the `"changes"` message's `change` payload for
  caught-up subscribers — they ignore it today, so eliding it removes the
  redundant second copy of each turn's edits on the wire without touching the OT
  model (rebuild and late-subscribe paths still fetch it).
- Message-borne-only agent change delivery (rejected above; recorded for
  context).
- A rollback-path client resync signal (force-resubscribe or generation bump
  after a rolled-back barrier), if the accepted
  broadcasts-before-commit-can-shadow-a-revision trade (Design §2) ever bites
  in practice.
- Extending step rollback to gatekeeper effects: a gatekeeper must not apply
  side effects before approval, so actions queued by an unpersisted step could in
  principle be revoked at reconciliation. Out of scope here.
