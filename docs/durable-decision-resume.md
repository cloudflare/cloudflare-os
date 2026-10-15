# Durable decision resumption

The existing execution row is the durable job; the existing chat log is its progress.
This implementation starts from `main`, independently of #773. It adds no table,
schema field, migration, continuation ID, or stored wait/phase machine.

## Handoff

An execution that ends waiting for approval retains its `activeAgents` row, including
the original initiator, user DO, model, and callback status. Its `chatMeta.activeAgent`
is unset, so the chat is idle while the user decides. The requests and outcomes are
already in the chat/action logs; the wait is derived from those records.

When all awaited actions and connection requests are approved, one synchronous span
appends an existing `agentNudge` message, sets the busy marker, and arms the shared
alarm, using the retained execution row. Only then does it look up the model. Both
live handoffs and constructor recovery run the existing `#resumeAgent` path.

The nudge consumes the old decision segment. A new prompt, callback, explicit Retry,
or Stop is also a boundary: recovery must not borrow predecessor decision cards.
Denial leaves the turn ended. A final assistant response consumes inline approvals
that did not suspend inference.

Approval can arrive while the old execution is still reconciling gadgets. The
decision handler leaves that execution alone; teardown rechecks readiness after its
last await and claims the handoff synchronously as it releases the old execution.
Model lookup and cleanup check ownership after awaits, so Stop, deletion, and newer
executions cannot be overwritten by a stale task.
Non-owner user resumption re-verifies the original collaborator's build access and
keeps a build-session lease until that execution ends; approval does not substitute
the approver's authority for a revoked original caller.

## Recovery and limits

The alarm covers a claim whose initiating browser disappears. Retryable model lookup
failures retain the same row; only that pure read is retried. The alarm rethrows the
failure for platform backoff and ends the execution with a visible error at retry
count 3. Constructor recovery preserves the scheduled alarm, and a failed alarm does
not reschedule itself and reset its retry budget. Missing/disabled models and live
objects shedding load fail without this retry loop.

This does **not** make external effects exactly-once. Gatekeeper application keeps its
existing idempotency contract; a crash after a remote effect but before the approval
receipt is persisted is not solved by replaying that effect here. Agent inference
and effects are not automatically retried by the model-lookup policy.

Older paused chats written by `main` have no retained execution row, so their original
user DO cannot be recovered. An explicit approval adopts the approver's identity and
model account, matching the old behavior, before recording the decision. New pauses
retain their original authority and never replace it with the approver's.

## Regression coverage

`packages/workshop-backend/__tests__/durable-decision-resume.test.ts` runs the real
Overseer Durable Object and inference loop with controlled model responses. It covers
eviction around decision persistence and teardown, forced resets after claim and
Retry, early approval during reconciliation, mixed decisions, duplicate wake-ups,
manual/automatic application, stale lookups, Stop/deletion, and bounded alarm retries.
The existing callback/alarm and production RPC integration suites cover the shared
paths as well.
