# Scheduled Tasks

Scheduled Tasks is an ambient Gatekeeper that lets workspace code register persistent callbacks for
elapsed intervals, wall-clock recurrences, and one-time runs. Each account also gets a read-only
management app at `/gatekeepers/scheduler`.

## User flow

1. Ask the agent to create a scheduled task, or open **Scheduled** and choose a starter prompt.
2. Confirm what the task should do, the workspace and resources it may use, its cadence, and its
   IANA timezone when it uses wall-clock time.
3. The agent registers a persistent callback. Registration creates a disabled hook and returns its
   schedule ID; it does not start the schedule.
4. Enable the hook in the Workshop's Connections UI.
5. Use **Scheduled** to search and inspect schedules across the account. Select a schedule row to
   open its workspace.

The Scheduler app is intentionally read-only. Enabling and disabling remain in Connections; the app
does not provide editing, pausing, deletion, run history, or a second hook toggle.

## Agent API

The ambient binding exposes `ScheduleSession`. The exact agent-facing contract and examples live in
[`src/types.d.ts`](src/types.d.ts).

```ts
const callback = await ctx.restore({ type: "dailyBrief" });

const scheduleId = await SCHEDULER.calendarAt(
  {
    timeZone: "America/Chicago",
    freq: "weekly",
    byDay: ["MO", "TU", "WE", "TH", "FR"],
    hour: 8,
    minute: 0,
  },
  callback,
  {
    title: "Daily brief",
    description: "Prepare the morning calendar and inbox brief.",
    occurrences: { count: 10 },
  },
);
```

Use the three registration methods according to the user's intent:

- `every(everyMs, callback, options)` uses elapsed UTC time. The minimum interval is 60 seconds.
- `calendarAt(rule, callback, options)` follows local wall-clock time and requires an explicit IANA
  timezone. It supports hourly, daily, and weekly rules.
- `runAt(when, callback, options)` runs once at an absolute epoch-millisecond timestamp or an
  explicit timezone-aware wall-clock time.

Recurring `every()` and `calendarAt()` calls may stop after a finite bound. Give one or the other,
never both; `runAt()` accepts neither.

- `occurrences: { count: 10 }` allows ten logical scheduled occurrences.
- `occurrences: { until: { timeZone, year, month, day, hour, minute } }` allows occurrences through
  that instant, inclusively. An absolute epoch-millisecond `until` is also accepted. Registration
  rejects a cutoff that precedes the schedule's first occurrence.

The count bounds *due slots*, not successful runs. A slot consumes one count as soon as it becomes
due and takes a `runId`, even if admission or callback delivery then fails; admission failures skip
the slot without retrying it. Retries reuse the same `runId` and do not consume another count.
Missed occurrences remain skipped and do not count.

A bound is checked against live state, so a schedule that reaches it reports `completed`. A schedule
whose cutoff already passed by the time its hook is enabled reports `expired` instead: it never got
a slot. A schedule whose callback exhausts its eight attempts reports `dead` and stops there,
whether or not the bound was reached — a `count: 10` schedule that dies on its third occurrence
never reaches the fourth. Disabling a hook drops its driver state, so re-enabling the same schedule
restarts the count — treat `count` as a bound per enablement, not a lifetime guarantee.

`list()` returns active and terminal schedules for enabled hooks in the current workspace only. It
does not expose schedules from other workspaces in the account.

## Persistent callbacks and retries

Callbacks implement `ScheduledTaskHook.onSchedule()` and must be made persistent with
`ctx.restore()` before registration. Each firing contains:

- `scheduleId`, the stable registration ID;
- `runId`, stable across retries of one logical occurrence;
- `scheduledTime`, the planned Unix epoch time;
- `actualTime`, the current delivery-attempt time; and
- `timeZone`, the schedule's display timezone (`UTC` for elapsed intervals and numeric one-shots).

Callback delivery is best-effort within a bounded retry window and may occur more than once. Callback
code should use `runId` as an idempotency key. Authorization or callback failures retry up to eight
total attempts with exponential delays beginning at one minute and capped at one hour. Exhausted
schedules enter the **Needs attention** state.

The Workshop admission check runs before every attempt. If the hook, gatekeeper, or account is no
longer allowed, the occurrence is skipped without consuming a callback attempt. Recurring schedules
advance to their next future occurrence; a due one-shot expires.

## Cadence behavior

- Recurrences preserve the phase established at registration.
- Missed occurrences are skipped, not replayed or caught up.
- Fixed intervals measure elapsed time and therefore shift relative to local clocks across DST.
- Calendar schedules retain their requested local wall-clock cadence across DST.
- A nonexistent spring-forward time moves forward by the transition gap.
- An ambiguous fall-back time uses the earlier instant and fires once.
- Date-less wall-clock one-shots resolve to the next future occurrence of that local time.

Always ask the user for the timezone of a wall-clock schedule. Do not infer it from locale or silently
choose UTC.

## Lifecycle

Registration only binds a disabled Workshop hook; it writes no schedule row. Enabling records the
target workspace ID and optional gadget ID, then creates the account-driver row and arms its alarm.
Disabling removes the row and its stored capabilities. Re-enabling creates fresh active state,
preserves the original recurrence phase, and does not replay missed work. A repeated enable while
the row still exists instead preserves its current schedule state and refreshes its activation details.

Successful one-shots become **Finished**. Past or rejected one-shots become expired. Terminal rows
remain visible and consume enabled-schedule quota until their hook is disabled in Connections.
Creating a workspace from a blueprint does not copy schedules or capabilities: the new workspace must
register its callback and receive fresh enablement.

Disconnecting the Scheduler account revokes its driver, deletes schedule state, and leaves a permanent
tombstone so retained stale controllers cannot recreate the account.

## Management app

The account advertises its UI through the generic `AccountDescription.providesUi` mechanism, the same
mechanism used by other Gatekeeper management apps. The Workshop discovers it dynamically and hosts
the single-file app in an opaque-origin, network-isolated `srcDoc` frame.

The app can only call its account-scoped, read-only `list()` capability plus bounded host methods for
theme updates, workspace-title resolution, navigation, and starter prompts. Pages contain at most 100
schedules. Search is case-insensitive over title and description and is limited to 200 characters.
Cursors are opaque, bounded, and tied to the normalized search and status filters.

The **All**, **Active**, **Needs attention**, and **Finished** tabs map to the projected
`active`, `dead`, and `completed`/`expired` statuses. Target metadata is presentation data only;
opening its validated internal route grants no new authority. Create and starter actions place fixed
editable text in the Home composer and never submit it automatically.

## Architecture and security

Each Scheduler account owns one SQLite-backed `ScheduleDriver` Durable Object and one alarm for all of
its workspaces. Workspace sessions inherit their opaque scope from the containing Overseer facet;
callers cannot supply an account or workspace ID. Plain schedule metadata and reconstructable RPC
capabilities are stored under separate keys and changed transactionally.

The alarm persists state before crossing an RPC boundary. It processes at most 20 due schedules per
pass with four concurrent deliveries, then arms an immediate continuation when a backlog remains.
Stable `runId` fencing prevents late completion or retry continuations from mutating a disabled,
re-enabled, or revoked schedule.

One account-wide driver keeps management and revocation simple, but it is also a shared failure domain:
a user callback that never settles can delay other schedules in that account until the runtime aborts
the alarm. Bounded batches limit ordinary load; they do not eliminate that tradeoff.

The Scheduler is capability-authorized. It does not receive Workshop user identity, assert its own
ambient policy, expose external network authority, or implement actions. The Workshop's existing hook
admission and observation authorization remain the security boundaries.

## Limits

- 500 enabled or terminal schedule rows per account.
- 100 enabled or terminal schedule rows per workspace.
- 100 rows per management page.
- 20 due schedules per alarm pass and four concurrent deliveries.
- Eight callback attempts per logical occurrence.
- Schedule titles: 200 characters; descriptions: 2,000 characters.

These are fixed policy limits rather than deployment settings.

## Development

Install and build from the repository root:

```sh
pnpm install
pnpm --filter @gadgets/gatekeeper-scheduler test:run
pnpm --filter @gadgets/gatekeeper-scheduler build
pnpm run dev-server
pnpm run dev-client
```

The development server discovers `gatekeeper-*` packages, builds `app/` into the generated single-file
asset, and creates the local `GATEKEEPER_SCHEDULER` service binding. Do not edit generated local
Wrangler configuration.

Worker code gets its runtime and `Cloudflare.Env` types from generated
[`worker-configuration.d.ts`](worker-configuration.d.ts), referenced by `tsconfig.json`. Regenerate it
with Wrangler after changing Worker configuration; do not hand-maintain a parallel `Env` interface.
The browser app uses the separate DOM-only `tsconfig.app.json` and imports only environment-neutral
management DTOs.

## Deployment

Before exposing Scheduler:

1. Deploy the Workshop hook target-metadata contract and the `startHook()` admission backstop.
2. Deploy this Worker so its `ScheduleDriver` and `SchedulerGatekeeper` SQLite migration exists.
3. Add `GATEKEEPER_SCHEDULER` to the deployment's Workshop service bindings.

Scheduler declares only that it can auto-provision an account. Workshop provisioning policy defaults
the `scheduler` vendor to **optional**; an administrator can explicitly choose disabled, optional, or
enabled. Production service bindings are site-specific and are not generated by this package.

The `allow_irrevocable_stub_storage` compatibility flag is required while stored callback capabilities
exist and must not be removed from an existing deployment.

## Troubleshooting

- **Scheduled is missing from navigation:** confirm the Scheduler binding exists, the vendor is enabled
  or optional with a connected account, and account discovery returns `providesUi`.
- **A new schedule is not listed or running:** registration starts disabled. Enable its hook in the
  workspace Connections UI.
- **A schedule says Needs attention:** callback authorization or execution exhausted its retry budget.
  Fix the callback or resource access, then disable and re-enable the hook.
- **A one-shot says Expired:** its firing time passed without admission or it was already past when
  enabled. Register a new future one-shot.
- **A recurrence appears an hour off:** use `calendarAt()` for local wall-clock intent and `every()` for
  elapsed time; verify the explicit IANA timezone.
- **A blueprint-created workspace has no schedules:** schedules are deliberately not copied. Register
  them again in the new workspace.

## Non-goals

V1 does not provide schedule editing, local pause/toggle/delete controls, recurring run history,
`lastRunAt`, account default timezones, actor attribution, blueprint schedule cloning, catch-up delivery,
or collaborator-owned schedule routing. Hook lifecycle remains in the Workshop Connections UI.
