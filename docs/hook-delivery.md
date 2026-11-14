# Hook delivery

How a push-driven hook driver delivers provider events to the gadgets' hooks, and what bounds each
delivery. The pieces: the **queue** (`HookDeliveryQueue` in
`packages/gatekeeper-kit/src/hook-delivery-queue.ts`), which stores, retries and reports; the
**registry** (`HookRegistry` in `packages/gatekeeper-kit/src/hook-registry.ts`), which holds each
hook's stubs and makes one delivery; the wait helpers both share (`deadline.ts` beside them); and
the drivers that own the Durable Object and its alarm (`github-hooks.ts`, `gmail-hooks.ts`,
`chat-hooks.ts`, `outlook-hooks.ts` and `pagerduty-hooks.ts`). The
scheduler and email call hooks their own way and are not covered here.

## Attempts and deadlines

A run attempts up to `MAX_DELIVERIES_PER_RUN` (20) due rows at once and waits for them all. One
attempt is `startHook()` on the hook's `HookInitiator`, then the binding's `deliver()` with the
firing it returned, and it has two deadlines:

- **Dispatch, 30 s** (the registry): the firing must arrive within it. One that misses it is never
  handed on, only disposed when it arrives. Counted as a `dispatchTimeouts`: the kernel is slow.
- **T_kit, 4 minutes** (the queue): the whole attempt. The queue races `deliver` itself, so the
  bound holds for any `Deliver`, and aborts the signal it passed with `DeliveryTimeout("deliver")`;
  the registry then stops waiting and disposes its stubs. Counted as a `deliverTimeouts`: the
  gatekeeper's preparation or the gadget is slow. Four minutes covers PagerDuty's worst preparation
  (about 2.5 minutes of sequential reads) plus the gadget.

Both are timers started with the attempt, not `Date.now()` arithmetic, so a test that jumps the
clock trips neither. A timeout is a failed attempt, retried with backoff. Nothing cancels the
gadget's call, since Worker RPC calls can't be cancelled by the caller: it may keep running, or be
cut off by eviction, while its retry runs.

An attempt's outcome is tagged (`{ ok: true }` or `{ ok: false, error }`), so no value `deliver`
rejects with can read as a delivery, and a synchronous throw is a failed attempt.

## Counting and dropping

`attempts` counts attempts started. The new count is stored before the call goes out (the output
gate holds the call until it is), and `at` doesn't move:

- A row cut off by a reset, a deploy or a kill is due again at once on the next run, already
  counted. A reset uses up one of the 8 attempts.
- A row whose 8 attempts have started is dropped without a call: its last attempt never reported
  back. A failure on the 8th attempt drops it too.
- A full database makes the count write throw before the call, so nothing is delivered that can't
  be recorded.
- Rows stored before attempts were counted this way count failures and are at 7 or below, so they
  still get 8 calls in all.

Retries back off from one minute, doubling up to an hour. When an attempt settles, its outcome is
applied only if the row is still the copy it counted (same `at` and `attempts`, not finished):
a hook disabled meanwhile, or a row deleted and queued again, is left as it is.

## The run report

The queue calls `onRunReport(report)` once at the end of a run in which anything failed, timed out
or was dropped; a clean run reports nothing. The report holds counts only, never an error, a
message or a hook id, since a hook's exception can quote the private message it failed on:

| Field | Counts |
|---|---|
| `started` | attempts that called `deliver` |
| `delivered` | attempts that resolved |
| `failed` | attempts that threw or rejected, timeouts aside |
| `dispatchTimeouts` | firings that missed the 30 s cutoff |
| `deliverTimeouts` | attempts that ran past T_kit; each is a call that may still be running |
| `dropped` | rows dropped after `MAX_DELIVERY_ATTEMPTS` |

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

Every driver follows the alarms API's documented pattern: schedule a retry, catch, and replace the
retry with the real next time.

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

- A handler that throws logs, returns and runs again in a minute; the platform's own retry never
  applies. One killed at 15 minutes finds its fallback already past and runs again at once.
- The fallback's `setAlarm` is outside the `try`: if storage refuses it, the handler throws and the
  platform's retry applies.
- `#reschedule` replaces the fallback unconditionally: it sets the earliest of `nextDue()` and the
  driver's own deadlines, or deletes the alarm.

## The hook author's contract

Each gatekeeper's agent-facing hook docs (`types.d.ts`) say the same:

- Return within a minute or two. After 4 minutes an attempt counts as failed and is retried while
  the first call may still be running.
- A hook may be called twice for one event, including twice at once, so it should deduplicate on
  the event's id.
- A hook that keeps failing is called up to 8 times for an event, then the event is dropped.

## What isn't bounded

- **The gadget's call.** It is never cancelled; T_kit only bounds the wait for it.
- **Work before `run()`:** Chat's account tracking, Gmail's and Outlook's sync, Outlook's
  subscriptions, GitHub's hourly webhook check. No driver's alarm has an overall worst case; the
  fallback alarm restarts one that is killed.
- **A hung hook's backlog.** A hook that hangs with 20 or more rows due fills every run, and each run
  waits T_kit, so hooks behind it wait about 4 minutes per 20 of its rows.
