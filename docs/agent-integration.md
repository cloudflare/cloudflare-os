# Agent integration on durable execution records

This is a fresh replacement for #779, stacked on #797. The existing `activeAgents`
row and chat/action logs still drive execution, decision readiness and resumption.
There is no continuation table, saved phase, wait list, ready flag or second driver.

## Scope

This first layer provides scoped lifecycle notifications and fresh contextual action
application. It deliberately excludes automatic effect replay, nested approval trees,
and keeping a completed model turn alive for non-awaited applications. Those need a
separate, receiver-deduplicated delivery contract; a generic retry is not safe.
No shipping gatekeeper is opted in or modified by this change.

`AGENT_INTEGRATION_GRANTS` is trusted deployment configuration, keyed by vendor ID:

```json
{"container":{"lifecycle":true,"contextualActions":true}}
```

The two permissions are independent and default to denied. Malformed or unknown
grant fields fail closed. Ambient provisioning grants neither permission.

## Lifecycle output, not another workflow

An execution gets an optional opaque turn/segment identity when an eligible binding
is minted. The turn identity survives #797's decision pauses and resets. The segment
rotates when inference re-enters, expiring old session capabilities. Binding props
capture their origin before async session lookup; opening a retained binding cannot
borrow a later prompt's authority.

`AgentContext.participate()` durably registers one persistent participant per turn
and connection. Registration is idempotent, never replaces the original target, and
acknowledges registration rather than waiting for a callback. This avoids callback
re-registration cycles. Integrations initialize lazily on first use; they must not
depend on a started callback arriving before the registering method returns.

One indexed outbox stores participants, pending events and retry deadlines. It holds
no copy of execution authority or progress. Execution removal/replacement and terminal
event writes share the storage transaction. #797's retained decision row produces a
suspended event; re-entry produces resumed. Finished means the row ended, whether by
completion, failure, Stop, deletion, denial or replacement.

Delivery is ordered and at-least-once, with stable binding-scoped event IDs. Receivers
must durably deduplicate them. A failed or lost ACK keeps the receipt and a 30-second
retry deadline; each invocation has a one-hour bound. The shared alarm retries without
a browser, including while it holds another long-running turn open. In-memory timers
and single-flight guards are conveniences, never recovery authority.

Predecessor cleanup and entry deliveries drain before inference. Failure leaves the
same runnable execution row for the existing alarm, not a new continuation state.
Cleanup contexts remain available after revocation or chat deletion, but authorize no
new commands. Delayed entry callbacks must inspect the context's current phase: they
may already be cleanup-only. Delivery contexts expire when that attempt ends.

Workspace deletion records a durable fence, cancels queued/existing turns, then drains
cleanup before deleting storage. Failed cleanup leaves both the fence and receipts;
the owner can retry deletion, and resets cannot restart inference in the meantime.

Version 6 adds the initially empty outbox and optional metadata without rewriting
existing executions or inventing historical callbacks. This replaces the unmerged
#773/#779 design; it is not a migration from their experimental continuation schema.

## Fresh action context

The dispatch choice and original turn are pinned when an action is queued. Opted-in
actions call `applyActionInContext()` with a fresh, action-scoped Git cache and the
original agent context. A paused original turn is allowed; an ended/replaced turn
returns null, never the approver's current turn. Action contexts expire with dispatch.
Non-awaited actions do not extend the model turn's lifetime.

There is no fallback to legacy application after contextual dispatch, and revocation
fails closed. Existing/ungranted actions keep legacy behavior even if a grant is later
added. This layer does not automatically reapply effects after a lost response: the
existing explicit retry and receiver idempotency requirements still apply. It does
not claim exactly-once execution across an unjournalled remote-effect boundary.

The workerd regressions cover real eviction/lost replies, #797's pause/resume/inference
path, registration cycles, revocation, stale capabilities, deletion cleanup, and
contextual dispatch without fallback or automatic replay.
