# Hook delivery

How a push-driven hook driver delivers provider events to gadgets' hooks, and what bounds each
delivery. The pieces, in `packages/gatekeeper-kit/src/`: the **queue** (`HookDeliveryQueue`,
`hook-delivery-queue.ts`), which stores, retries and reports; the **registry** (`HookRegistry`,
`hook-registry.ts`), which holds each hook's stubs and makes one delivery; and their shared wait
helpers (`deadline.ts`). The drivers own the Durable Object and its alarm: `github-hooks.ts`,
`gmail-hooks.ts`, `chat-hooks.ts`, `outlook-hooks.ts` and `pagerduty-hooks.ts`.

## Attempts and deadlines

One attempt is `startHook()` on the hook's `HookInitiator`, then the binding's `deliver()` with the
firing it returned, and it has two deadlines:

- **Dispatch, 30 s** (the registry): the firing must arrive within it. One that misses it is never
  handed on, only disposed when it arrives. Counted as a `dispatchTimeouts`: the kernel is slow.
- **T_kit, 4 minutes** (the queue): the whole attempt. The queue races `deliver` itself, so the
  bound holds for any `Deliver`, and aborts the signal it passed with `DeliveryTimeout("deliver")`;
  the registry then stops waiting and disposes its stubs. Counted as a `deliverTimeouts`: the
  gatekeeper's preparation or the gadget is slow. Four minutes covers PagerDuty's worst preparation
  (about 2.5 minutes of sequential reads) plus the gadget.

Both are timers, not `Date.now()` arithmetic, so a test that jumps the clock trips neither. A
timeout is a failed attempt. Worker RPC calls can't be cancelled, so the gadget's call may keep
running, or be cut off by eviction, while its retry runs.

An attempt's outcome is tagged (`{ ok: true }` or `{ ok: false, error }`), so no value `deliver`
rejects with can read as a delivery, and a synchronous throw is a failed attempt.

## The pool

A run keeps up to 20 attempts in flight and refills a slot as each settles, so a hook that hangs
holds back only its own messages:

- **Slow-start.** A hook gets one slot until it delivers in the run, then 4, and none after a
  timeout of either stage. A hung hook holds one slot per run, and a hung `startHook()` can't
  refill its slot every 30 s.
- **One forward pass** over the due index, 200 entries a page, its end recomputed per page so rows
  that come due or are queued meanwhile are found; `enqueue()` wakes a run in flight to look. Rows
  a hook has no slot for yet are kept per hook and started as its slots free. A run reads at most
  50,000 entries.
- **Budgets.** A run starts attempts for 2 minutes and at most 200 of them, then waits for those in
  flight: about 6 minutes in all. The rest stays due for the next run.
- **The trim.** A hook whose `deliver` times out with no delivery in the run keeps only its newest
  1,000 passed-over rows, and a run trims at most 2,000. A never-tried row is deleted, so a
  duplicate push queues it again; a tried one is finished, as it may have reached the gadget. A
  dispatch timeout trims nothing: that is the kernel stalling, not the hook.

Each run starts with every count at zero and waits for its own attempts, so a run that ends with a
row due is followed by one that starts at least one. No timer wakes a full pool, so nothing spins.

## Counting and dropping

`attempts` counts attempts started. The new count is stored before the call goes out (the output
gate holds the call until it is), and `at` doesn't move:

- A row cut off by a reset, a deploy or a kill is due again at once on the next run, already
  counted. A reset uses up one of the 8 attempts.
- A row whose 8 attempts have started is dropped without a call: its last attempt never reported
  back. A failure on the 8th attempt drops it too.
- A full database makes the count write throw before the call, so nothing is delivered that can't
  be recorded. Rows stored before this counted failures, at 7 or below, so they still get 8 calls.

Retries back off from one minute, doubling up to an hour. When an attempt settles, its outcome is
applied only if the row is still the copy it counted (same `at` and `attempts`, not finished):
a hook disabled meanwhile, or a row deleted and queued again, is left as it is.

## The run report

The queue calls `onRunReport(report)` once at the end of a run in which anything failed, timed out
or was dropped or trimmed, or the read budget ran out; a clean run reports nothing. The report
holds counts only, never an error, a message or a hook id, since a hook's exception can quote the
private message it failed on:

| Field | Counts |
|---|---|
| `started` | attempts that called `deliver` |
| `delivered` | attempts that resolved |
| `failed` | attempts that threw or rejected, timeouts aside |
| `dispatchTimeouts` | firings that missed the 30 s cutoff |
| `deliverTimeouts` | attempts that ran past T_kit; each is a call that may still be running |
| `dropped` | rows dropped after `MAX_DELIVERY_ATTEMPTS` |
| `trimmed` | rows dropped from a hung hook's backlog |
| `readBudgetReached` | the scan stopped at 50,000 entries, so hooks behind them weren't reached |

Each driver logs it at `warn` as `<prefix>.delivery.report` (`hooks.` for GitHub and PagerDuty,
`gmail.hooks.`, `chat.hooks.`, `outlook.hooks.`). A run waits for every attempt to settle, even after
a storage write has thrown, then reports, then rethrows the first such error.

## Write order

Every write files the row's new index entry first, then the row, and deletes the old entry last. A
write that throws leaves at worst an extra entry, which is dropped when read, never a row without a
due entry, which `enqueue()` would then ignore for good. Finishing a row trusts its caller to have
checked the entry it holds is the row's own, so `cancel()` deletes an entry its row has outlived
instead of finishing the row again, which would move its dedupe window.

## The drivers' alarm

Every driver follows the alarms API's documented pattern:

```ts
async alarm(): Promise<void> {
  await this.ctx.storage.setAlarm(Date.now() + MINUTE_MS); // the retry if this handler fails or is killed
  try {
    // … the driver's own work, then await this.#hooks.run(Date.now()) …
    await this.#reschedule(); // sets the next time, or deletes the alarm when there is none
  } catch (error) {
    logger.error("…", { event: "<prefix>.alarm.failed", error }); // the fallback alarm stands
  }
}
```

- A handler that throws logs, returns and runs again in a minute; one killed at 15 minutes finds
  its fallback past and runs again at once. If storage refuses the fallback, the handler throws and
  the platform's retry applies.
- `#reschedule` replaces the fallback unconditionally with the earliest of `nextDue()` and the
  driver's own deadlines, or deletes the alarm.

## The hook author's contract

Each gatekeeper's agent-facing hook docs (`types.d.ts`) say: return within a minute or two, since
after 4 minutes an attempt counts as failed and is retried while the first call may still be
running; a hook may be called twice for one event, even at once, so it should deduplicate on the
event's id; one that keeps failing is called up to 8 times for an event, and one that keeps hanging
loses its older events.

## What isn't bounded

- **The gadget's call.** It is never cancelled; T_kit only bounds the wait for it.
- **Work before `run()`:** Chat's account tracking, Gmail's and Outlook's sync, Outlook's
  subscriptions, GitHub's hourly webhook check. No driver's alarm has an overall worst case; the
  fallback alarm restarts one that is killed.
- **What the pool can't see.** 20 hung hooks on one driver fill it. A row queued behind the scan
  in its current millisecond, or a retry coming due while no slot frees, waits for the next run. A
  slow hook within its deadline whose events outpace it has an unbounded backlog, and past 50,000
  due rows the hooks behind it go unreached until it catches up.
