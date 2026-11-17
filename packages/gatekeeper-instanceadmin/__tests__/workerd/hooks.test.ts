// The three hooks, end to end inside the gatekeeper Worker: a session subscribes as an agent's code
// would, the test enables the hook and answers each firing as the Workshop would, and the issue
// report store's events arrive through the vendor entrypoint.

import { createExecutionContext, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { RpcStub, RpcTarget, env } from "cloudflare:workers";
import {
  MAX_DELIVERIES_PER_RUN, MAX_DELIVERY_ATTEMPTS, disposeStubs,
} from "@gadgets/gatekeeper-kit/hook-delivery-queue";
import { ADMIN_BINDING_SUBRESOURCE } from "@gadgets/workshop-shared/admin-agent";
import {
  ISSUE_REPORT_CHANGES, type IssueReportChange, type IssueReportEvent,
} from "@gadgets/workshop-shared/admin-gatekeeper";
import {
  ISSUE_REPORT_PRIORITIES, ISSUE_REPORT_STATUSES, type IssueReportStatus,
} from "@gadgets/workshop-shared/api";
import type {
  HookController, HookDescription, HookInitiator, ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  IssueReportHookDriver, type IssueReportHookEvent, type SentIssueReportEvent,
} from "../../src/hooks.js";
import { HOOK_CALLBACK_TIMEOUT_MS, SERVICES } from "../../src/surface.js";
import { ROOT, type Session, recordingTarget, rejection } from "./fakes.js";
import HAND_WRITTEN_TYPES from "../../src/types.txt";
import { type HookState, type TestFacet, hookState } from "./worker.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

const SUBSCRIBE_METHODS = [
  "subscribeIssueReported", "subscribeInvestigationComplete", "subscribeIssueReportChanged",
] as const;
type Subscribe = typeof SUBSCRIBE_METHODS[number];
type Controller = HookController<RpcTarget>;

/** The Worker's entrypoints, as the Workshop reaches them, and the test worker's beside them. */
const worker = () => createExecutionContext().exports as unknown as Cloudflare.Exports & {
  TestHookInitiator(options: { props: { hook: string } }): Fetcher<HookInitiator<RpcTarget>>;
};

const vendor = () => worker().GatekeeperVendor({});
const driver = () => env.ISSUE_REPORT_HOOK_DRIVER.getByName("");

/** The queue of the session that subscribes: it keeps what was bound, as the Workshop would. */
class BindingQueue extends RpcTarget {
  /** What the session asked of it and of the Admin API it lends, in order. */
  readonly log: string[] = [];
  readonly bound: { controller: Controller; description: HookDescription }[] = [];
  // The omitted name is served too, so a call that reached it would be seen.
  readonly #admin = recordingTarget(ROOT, [...SERVICES.get(ROOT)!, "setSiteName"], this.log,
      (name) => ({ answered: name }));

  async getAdminApi() {
    this.log.push("getAdminApi");
    return this.#admin;
  }

  async authorizeObservation(description: ObservationDescription): Promise<void> {
    this.log.push(`observe ${description.title}`);
  }

  async submitAction(): Promise<void> {
    this.log.push("submitAction");
  }

  async bindHook(controller: Controller, _callback: unknown, description: HookDescription): Promise<void> {
    this.log.push("bindHook");
    this.bound.push({ controller, description });
  }
}

/** A gadget's callback, which a subscription binds and never calls: a firing gets its own. */
class Callback extends RpcTarget {
  issueReported(): void {}
  investigationComplete(): void {}
  issueReportChanged(): void {}
}

/** The hooks a test enabled, disabled after it so that later tests' events don't reach them. */
const enabled: (() => Promise<void>)[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const disable of enabled.splice(0)) await disable();
});

/** A facet of its own whose `ctx.restore()` works in this pool, and a session over `queue`. */
async function open(queue: BindingQueue) {
  const name = crypto.randomUUID();
  const gatekeeper = env.INSTANCE_ADMIN_GATEKEEPER.getByName(name);
  await (gatekeeper as unknown as TestFacet).testRestoreThrough(name);
  const session = await gatekeeper.startSession(queue as never) as unknown as Session;
  return { gatekeeper, session };
}

/** Subscribes a hook through a session of the whole binding, as an agent's code would. */
async function subscribe(method: Subscribe, { enable = true } = {}) {
  const queue = new BindingQueue();
  const { gatekeeper, session } = await open(queue);
  try {
    using callback = new RpcStub(new Callback());
    await session[method]!(callback);
  } finally {
    session[Symbol.dispose]();
  }
  const hook = crypto.randomUUID();
  const { controller, description } = queue.bound[0]!;
  const subscription = {
    gatekeeper, queue, description,
    state: hookState(hook) as HookState,
    enable: () => controller.enable(worker().TestHookInitiator({ props: { hook } }), { workspaceId: "triage" }),
    disable: () => controller.disable(),
  };
  if (enable) {
    await subscription.enable();
    enabled.push(subscription.disable);
  }
  return subscription;
}

const FILED_AT = new Date("2026-03-04T05:06:07.000Z");
const ENDED_AT = new Date("2026-03-05T08:09:10.000Z");
const CHANGED_AT = new Date("2026-03-06T11:12:13.000Z");

const reported = (
  reportId: string, priority: "low" | "medium" | "high" = "high",
): IssueReportHookEvent =>
  ({ kind: "reported", id: crypto.randomUUID(), reportId, priority, at: FILED_AT });

/** The statuses an investigation can end with. */
const ENDS = ISSUE_REPORT_STATUSES.filter((status) => status !== "new" && status !== "investigating");

const ended = (
  reportId: string, status: typeof ENDS[number] = "answered",
): IssueReportHookEvent =>
  ({ kind: "investigationComplete", id: crypto.randomUUID(), reportId, status, at: ENDED_AT });

const changed = (
  reportId: string, change: IssueReportChange, status?: IssueReportStatus,
): IssueReportHookEvent => ({
  kind: "changed", id: crypto.randomUUID(), reportId, change, ...(status && { status }),
  at: CHANGED_AT,
});

/** What a changed hook's callback is called with for `event`, one that changed() made. */
const changedCall = ({ id: eventId, kind: _kind, ...rest }: IssueReportHookEvent) =>
  ({ method: "issueReportChanged", event: { eventId, ...rest } });

/**
 * An event of a kind the contract does not have, as a store released after this Worker sends
 * one. That it is a SentIssueReportEvent is what lets the vendor's argument check take it.
 */
const unknownKind = (reportId: string): SentIssueReportEvent =>
  ({ kind: "somethingNew", id: crypto.randomUUID(), reportId, at: ENDED_AT, status: "answered" });

type Row = { message?: IssueReportEvent; attempts?: number; at?: number; deliveredAt?: number };

/** Everything the driver stores, by key; a hook's stubs as the names they are stored under. */
const stored = () => runInDurableObject(driver(), (_instance, state) =>
  new Map([...state.storage.kv.list<unknown>()].map(([key, value]) => {
    if (!key.startsWith("caps:")) return [key, value];
    disposeStubs(value as object);
    return [key, Object.keys(value as object).toSorted()];
  })));

/** The driver's queued deliveries, delivered or not. */
const rows = async () => [...await stored()]
    .filter(([key]) => key.startsWith("msg:")).map(([, row]) => row as Row);

/** Waits until the driver has no delivery due: its own alarm delivers them. */
const settled = () => vi.waitFor(async () => {
  const due = (await rows()).filter((row) => row.at !== undefined && row.at <= Date.now());
  if (due.length > 0) throw new Error(`${due.length} deliveries due`);
}, { timeout: 10_000, interval: 25 });

/** The driver's keys and rows that hold the event `id`: none once it was dropped. */
const holding = async (id: string) => [...await stored()]
    .filter(([key, row]) => key.includes(id) || (row as Row).message?.id === id);

/** Takes the store's events as the vendor does, and waits for what is due of them. */
async function ingest(...events: SentIssueReportEvent[]): Promise<void> {
  await vendor().issueReportEvents(events);
  await settled();
}

/**
 * A clock that runs ahead of the runtime's: each step moves it on and runs the driver's alarm
 * then, since the runtime never wakes the driver for a faked time. Only `Date.now()` is faked,
 * which is all the driver and the kit's queue read: with the whole `Date` replaced, an event's
 * real `at` would no longer pass for a Date where the delivery's arguments are validated.
 */
function clock() {
  let ahead = 0;
  return async (ms: number): Promise<void> => {
    ahead += ms;
    // Ahead of the runtime's clock as it is at this step: a retry is timed from its failure.
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + ahead);
    try {
      await runDurableObjectAlarm(driver());
    } finally {
      now.mockRestore();
    }
  };
}

describe("subscribing", () => {
  it("binds one hook for new reports, disabled until its controller enables it", async () => {
    const { queue, description, state, enable, disable } =
        await subscribe("subscribeIssueReported", { enable: false });

    // Nothing was read and nothing observed: subscribing does not mark the workspace.
    expect(queue.log).toEqual(["bindHook"]);
    expect(queue.bound).toHaveLength(1);
    expect(description.title).toBe("Watch for new issue reports");
    expect(description.description).toContain("the report's id, its priority and the time it was filed");
    expect(description.description).toContain("ids and labels only");

    // Bound is not enabled: an event reaches nothing.
    await ingest(reported("r-unbound"));
    expect(state.firings).toBe(0);
    expect([...(await stored()).keys()].filter((key) => key.startsWith("reg:"))).toEqual([]);

    await enable();
    enabled.push(disable);
    const registered = [...await stored()].filter(([key]) => key.startsWith("reg:"));
    expect(registered.map(([, registration]) => registration)).toEqual([{ kind: "reported" }]);
    await ingest(reported("r-enabled"));
    expect(state.received.map(({ event }) => (event as { reportId: string }).reportId))
        .toEqual(["r-enabled"]);

    await disable();
    const left = [...(await stored()).keys()];
    expect(left.filter((key) => key.startsWith("reg:") || key.startsWith("caps:"))).toEqual([]);
    await ingest(reported("r-disabled"));
    expect(state.firings).toBe(1);
  });

  it("binds one hook for investigations that end", async () => {
    const { queue, description } = await subscribe("subscribeInvestigationComplete");
    expect(queue.log).toEqual(["bindHook"]);
    expect(description.title).toBe("Watch for investigations that end");
    expect(description.description).toContain("the report's id, its new status and the time");
    expect(description.description).toContain("ids and labels only");
    const registered = [...await stored()].filter(([key]) => key.startsWith("reg:"));
    expect(registered.map(([, registration]) => registration)).toEqual([{ kind: "investigationComplete" }]);
  });

  it("binds one hook for changes to reports, disabled until its controller enables it", async () => {
    const { queue, description, state, enable, disable } =
        await subscribe("subscribeIssueReportChanged", { enable: false });

    expect(queue.log).toEqual(["bindHook"]);
    expect(queue.bound).toHaveLength(1);
    expect(description.title).toBe("Watch for changes to issue reports");
    expect(description.description).toContain(
        "each time an issue report is written to after it was filed: its status set, a claim or " +
        "a release, an entry added to its thread, or its links replaced");
    expect(description.description).toContain(
        "nothing of the report's text, its thread or who wrote");
    // What a person reads before enabling it: it answers to the subscriber's own writes too.
    expect(description.description).toContain(
        "It fires for changes this workspace's own agents and gadgets made too");
    expect(description.description).toContain("an action it queued was applied");
    expect(description.description).toContain("must not answer its own change");
    // Nor does it promise an order: the status on an event is not where the report stands.
    expect(description.description).toContain(
        "The events of one report can arrive in any order, so the status on one may no longer " +
        "be the report's.");

    await ingest(changed("r-unbound", "note"));
    expect(state.firings).toBe(0);
    expect([...(await stored()).keys()].filter((key) => key.startsWith("reg:"))).toEqual([]);

    await enable();
    enabled.push(disable);
    const registered = [...await stored()].filter(([key]) => key.startsWith("reg:"));
    expect(registered.map(([, registration]) => registration)).toEqual([{ kind: "changed" }]);
    const write = changed("r-enabled", "note");
    await ingest(write);
    expect(state.received).toEqual([changedCall(write)]);

    await disable();
    await ingest(changed("r-disabled", "note"));
    expect(state.firings).toBe(1);
  });

  it("refuses a hook that is no stub, and binds nothing", async () => {
    const queue = new BindingQueue();
    const { session } = await open(queue);
    using _session = session;
    for (const method of SUBSCRIBE_METHODS) {
      for (const hook of [undefined, "callback", 4]) {
        expect((await rejection(session[method]!(hook))).message).toBe(
            `Invalid arguments for AdminBinding.${method}: hook must be a persistent stub of the callback.`);
      }
    }
    expect(queue.log).toEqual([]);
  });

  it("leaves an omitted method refused on the session that subscribes", async () => {
    const queue = new BindingQueue();
    const { session } = await open(queue);
    using _session = session;
    using callback = new RpcStub(new Callback());
    await session.subscribeIssueReported!(callback);
    expect(await rejection(session.setSiteName!("Mine"))).not.toHaveProperty("message", "did not reject");
    expect(queue.log).toEqual(["bindHook"]);
  });
});

/**
 * The restricted-data flag of the one observation of `state`'s hook, which is under the
 * binding's subresource: `true` marks the workspace as a read through the binding does, and
 * an event that marks nothing leaves the flag out.
 */
function flag({ observations }: HookState): boolean | undefined {
  expect(observations).toHaveLength(1);
  expect(observations[0]!.subresources).toEqual([ADMIN_BINDING_SUBRESOURCE]);
  return observations[0]!.containsRestrictedData;
}

describe("an event", () => {
  it("of a new report fires each issue-reported hook once, and no investigation hook", async () => {
    const first = await subscribe("subscribeIssueReported");
    const second = await subscribe("subscribeIssueReported");
    const investigation = await subscribe("subscribeInvestigationComplete");

    const filed = reported("r1", "medium");
    await ingest(filed);

    for (const { state } of [first, second]) {
      expect(state.firings).toBe(1);
      expect(state.received).toEqual([{
        method: "issueReported",
        event: { eventId: filed.id, reportId: "r1", priority: "medium", filedAt: FILED_AT },
      }]);
    }
    expect(investigation.state.firings).toBe(0);
    expect(investigation.state.received).toEqual([]);
  });

  it("of an investigation that ends fires each investigation hook once, and no issue-reported hook", async () => {
    const investigation = await subscribe("subscribeInvestigationComplete");
    const issues = await subscribe("subscribeIssueReported");

    const done = ended("r1", "waitingOnReporter");
    await ingest(done);

    expect(investigation.state.firings).toBe(1);
    expect(investigation.state.received).toEqual([{
      method: "investigationComplete",
      event: { eventId: done.id, reportId: "r1", status: "waitingOnReporter", at: ENDED_AT },
    }]);
    expect(issues.state.firings).toBe(0);
    expect(issues.state.received).toEqual([]);
  });

  it.each(ISSUE_REPORT_CHANGES)("of a write (%s) fires each changed hook once, and no other hook", async (change) => {
    const first = await subscribe("subscribeIssueReportChanged");
    const second = await subscribe("subscribeIssueReportChanged");
    const issues = await subscribe("subscribeIssueReported");
    const investigation = await subscribe("subscribeInvestigationComplete");

    const write = changed("r1", change);
    await ingest(write);

    for (const { state } of [first, second]) {
      expect(state.firings).toBe(1);
      expect(state.received).toEqual([{
        method: "issueReportChanged",
        event: { eventId: write.id, reportId: "r1", change, at: CHANGED_AT },
      }]);
    }
    for (const { state } of [issues, investigation]) {
      expect(state.firings).toBe(0);
      expect(state.received).toEqual([]);
    }
  });

  it("carries the status a write set, and none otherwise", async () => {
    const { state } = await subscribe("subscribeIssueReportChanged");
    const set = changed("r1", "status", "fixInProgress");
    const reopened = changed("r2", "reply", "withAdmin");
    const note = changed("r3", "note");

    await ingest(set, reopened, note);

    const events = state.received.map(({ event }) => event as { reportId: string })
        .toSorted((a, b) => a.reportId.localeCompare(b.reportId));
    expect(events).toEqual([
      { eventId: set.id, reportId: "r1", change: "status", status: "fixInProgress", at: CHANGED_AT },
      { eventId: reopened.id, reportId: "r2", change: "reply", status: "withAdmin", at: CHANGED_AT },
      { eventId: note.id, reportId: "r3", change: "note", at: CHANGED_AT },
    ]);
    // Left out, not sent as undefined.
    expect(events[2]).not.toHaveProperty("status");
  });

  it("of a report that leaves investigating fires the investigation hook and the changed hook once each, with their own event ids", async () => {
    const investigation = await subscribe("subscribeInvestigationComplete");
    const changes = await subscribe("subscribeIssueReportChanged");

    // What the store sends for one setStatus(): two events of one report, status and time.
    const done: IssueReportHookEvent =
        { kind: "investigationComplete", id: crypto.randomUUID(), reportId: "r1", status: "answered", at: CHANGED_AT };
    const write = changed("r1", "status", "answered");
    await ingest(done, write);

    expect(investigation.state.firings).toBe(1);
    expect(investigation.state.received).toEqual([{
      method: "investigationComplete",
      event: { eventId: done.id, reportId: "r1", status: "answered", at: CHANGED_AT },
    }]);
    expect(changes.state.firings).toBe(1);
    expect(changes.state.received).toEqual([changedCall(write)]);
    expect(write.id).not.toBe(done.id);
  });

  it("the store sends again fires once, and two events alike but for their ids fire twice", async () => {
    const { state } = await subscribe("subscribeInvestigationComplete");
    const first = ended("r1", "answered");

    await ingest(first);
    await ingest(first);
    await ingest(first, { ...first });
    expect(state.firings).toBe(1);

    // The report is investigated again, and that investigation ends with the same status in the
    // same millisecond: only the id says it is a second event, to the queue and to the callback.
    const second = ended("r1", "answered");
    expect({ ...second, id: first.id }).toEqual(first);
    await ingest(first, second);
    expect(state.received.map(({ event }) => event)).toEqual([
      { eventId: first.id, reportId: "r1", status: "answered", at: ENDED_AT },
      { eventId: second.id, reportId: "r1", status: "answered", at: ENDED_AT },
    ]);
    expect(second.id).not.toBe(first.id);
    expect(state.firings).toBe(2);
  });

  it("of a new report, and of an investigation that ended with a status its reporter reads, is observed with the binding's subresource and no restricted mark, before the callback", async () => {
    const { state } = await subscribe("subscribeIssueReported");
    const investigation = await subscribe("subscribeInvestigationComplete");

    await ingest(reported("r1", "low"), ended("r2", "withAdmin"));

    expect(state.order).toEqual(["observe", "call"]);
    expect(state.observations).toEqual([{
      title: "Receive an issue report event",
      description: "Receive the id, the priority and the filing time of a new issue report.",
      fields: [
        { label: "Event", kind: "inline", value: "reported" },
        { label: "Report", kind: "inline", value: "r1" },
      ],
      subresources: [ADMIN_BINDING_SUBRESOURCE],
    }]);
    expect(state.observations[0]).not.toHaveProperty("containsRestrictedData");

    expect(investigation.state.order).toEqual(["observe", "call"]);
    expect(investigation.state.observations).toEqual([{
      title: "Receive an issue report event",
      description: "Receive the id, the new status and the time of an issue report whose " +
        "investigation ended.",
      fields: [
        { label: "Event", kind: "inline", value: "investigationComplete" },
        { label: "Report", kind: "inline", value: "r2" },
      ],
      subresources: [ADMIN_BINDING_SUBRESOURCE],
    }]);
    expect(investigation.state.observations[0]).not.toHaveProperty("containsRestrictedData");
    // A firing is lent nothing and queues nothing.
    expect(state.other).toEqual([]);
    expect(investigation.state.other).toEqual([]);
  });

  it("of a write its reporter is not shown is observed with the binding's subresource and the restricted mark, before the callback", async () => {
    const { state } = await subscribe("subscribeIssueReportChanged");

    await ingest(changed("r3", "status", "closed"));

    expect(state.order).toEqual(["observe", "call"]);
    expect(state.observations).toEqual([{
      title: "Receive an issue report event",
      description: "Receive the id of an issue report that was written to, what the write was, " +
        "the status it set if it set one, and the time.",
      fields: [
        { label: "Event", kind: "inline", value: "changed" },
        { label: "Report", kind: "inline", value: "r3" },
      ],
      subresources: [ADMIN_BINDING_SUBRESOURCE],
      containsRestrictedData: true,
    }]);
    expect(state.other).toEqual([]);
  });

  it.each(ISSUE_REPORT_PRIORITIES)("of a new report (%s) marks nothing", async (priority) => {
    const { state } = await subscribe("subscribeIssueReported");
    await ingest(reported("r1", priority));
    expect(flag(state)).toBeUndefined();
  });

  // Only the two statuses the reporter reads as another say what the reporter is not shown.
  it.each(ENDS.map((status) => [status, status === "fixSuggested" || status === "fixInProgress"] as const))(
      "of an investigation that ended as %s marks the workspace: %s", async (status, marked) => {
    const { state } = await subscribe("subscribeInvestigationComplete");
    await ingest(ended("r1", status));
    expect(flag(state)).toBe(marked || undefined);
  });

  // A reply is public, as is the status a reopening one set. Every other write is for admins
  // alone, or, for a status, may be: the event does not say which.
  const WRITES: [IssueReportChange, IssueReportStatus | undefined, boolean][] = [
    ["status", "answered", true], ["status", "fixInProgress", true], ["assignment", undefined, true],
    ["note", undefined, true], ["links", undefined, true],
    ["reply", undefined, false], ["reply", "withAdmin", false],
  ];

  it.each(WRITES)("of a write (%s, status %s) marks the workspace: %s", async (change, status, marked) => {
    const { state } = await subscribe("subscribeIssueReportChanged");
    await ingest(changed("r1", change, status));
    expect(flag(state)).toBe(marked || undefined);
  });

  it("of each kind of write has its mark stated above", () => {
    expect(new Set(WRITES.map(([change]) => change))).toEqual(new Set(ISSUE_REPORT_CHANGES));
  });

  it("whose observation is refused calls no callback, and is tried again", async () => {
    const { state } = await subscribe("subscribeIssueReported");
    const tick = clock();
    state.refuseObservations = true;

    await ingest(reported("r1"));
    expect(state.order).toEqual(["observe"]);
    expect(state.received).toEqual([]);

    state.refuseObservations = false;
    await tick(MINUTE_MS);
    expect(state.order).toEqual(["observe", "observe", "call"]);
    expect(state.received).toHaveLength(1);
  });
});

describe("a delivery that fails", () => {
  it("in the callback is retried from the alarm with the same event id, and then delivered once", async () => {
    const { state } = await subscribe("subscribeIssueReported");
    const tick = clock();
    state.failures = 2;

    const filed = reported("r1");
    await ingest(filed);
    expect(state.firings).toBe(1);
    expect(state.received).toEqual([]);

    // Not before its backoff.
    await tick(MINUTE_MS - 10_000);
    expect(state.firings).toBe(1);
    await tick(10_000);
    expect(state.firings).toBe(2);
    expect(state.received).toEqual([]);

    await tick(2 * MINUTE_MS);
    expect(state.firings).toBe(3);
    const event = { eventId: filed.id, reportId: "r1", priority: "high", filedAt: FILED_AT };
    expect(state.received).toEqual([{ method: "issueReported", event }]);
    // Each call that failed was given the event the last one was, under the same id.
    expect(state.failed).toEqual([event, event]);

    // Delivered, so nothing is left to retry.
    await tick(HOUR_MS);
    expect(state.firings).toBe(3);
  });

  it("of a changed event is retried from the alarm with the same event id, and then delivered once", async () => {
    const { state } = await subscribe("subscribeIssueReportChanged");
    const tick = clock();
    state.failures = 1;

    const write = changed("r1", "assignment");
    await ingest(write);
    expect(state.firings).toBe(1);
    expect(state.received).toEqual([]);

    await tick(MINUTE_MS);
    expect(state.firings).toBe(2);
    expect(state.received).toEqual([changedCall(write)]);
    expect(state.failed).toEqual([changedCall(write).event]);

    await tick(HOUR_MS);
    expect(state.firings).toBe(2);
  });

  it("of many changed events holds an issue-reported delivery back by whole runs, and never loses it", async () => {
    const changes = await subscribe("subscribeIssueReportChanged");
    const issues = await subscribe("subscribeIssueReported");
    changes.state.failures = Infinity;

    // More than two runs' worth, all due before the report's event: the driver's alarm attempts
    // MAX_DELIVERIES_PER_RUN of them a run, and each one that failed comes due a minute later,
    // behind the rest. No clock is moved, so none of them is retried here.
    const writes = Array.from({ length: 2 * MAX_DELIVERIES_PER_RUN + 1 },
        (_, index) => changed(`r${index}`, "note"));
    await vendor().issueReportEvents(writes);
    const filed = reported("r-filed", "medium");
    await vendor().issueReportEvents([filed]);
    await settled();

    // Delayed, never lost and never doubled.
    expect(issues.state.firings).toBe(1);
    expect(issues.state.received).toEqual([{
      method: "issueReported",
      event: { eventId: filed.id, reportId: "r-filed", priority: "medium", filedAt: FILED_AT },
    }]);
    const finished = (await holding(filed.id)).filter(([key]) => key.startsWith("msg:"));
    expect(finished.map(([, row]) => row)).toEqual([{ deliveredAt: expect.any(Number) }]);

    // Each write was attempted once, and waits for its retry.
    expect(changes.state.firings).toBe(writes.length);
    expect(changes.state.received).toEqual([]);
    const attempted = changes.state.failed.map((event) => (event as { eventId: string }).eventId);
    expect(attempted.toSorted()).toEqual(writes.map(({ id }) => id).toSorted());
    const ids = new Set(writes.map(({ id }) => id));
    const waiting = (await rows()).filter((row) => row.message && ids.has(row.message.id));
    expect(waiting).toHaveLength(writes.length);
    const now = Date.now();
    for (const row of waiting) {
      expect(row.attempts).toBe(1);
      expect(row.at).toBeGreaterThan(now);
    }
  });

  it("because its callback does not answer in time is given up on and retried, and holds back no other event", async () => {
    const slow = await subscribe("subscribeIssueReported");
    const other = await subscribe("subscribeInvestigationComplete");
    const tick = clock();
    // The delivery's own timer, shortened: every other timer keeps its time.
    const setTimer = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) =>
      setTimer(handler, ms === HOOK_CALLBACK_TIMEOUT_MS ? 50 : ms, ...args)) as typeof setTimeout);
    const answer = Promise.withResolvers<void>();
    slow.state.hold = answer.promise;

    // The delivery ends although the callback is still waiting, and counts as one failed attempt.
    await ingest(reported("r1"));
    expect(slow.state.firings).toBe(1);
    expect((await rows()).map(({ message, attempts }) => [message?.reportId, attempts]))
        .toContainEqual(["r1", 1]);

    // An event for another hook is delivered meanwhile.
    await ingest(ended("r2"));
    expect(other.state.received).toEqual([{
      method: "investigationComplete",
      event: { eventId: expect.any(String), reportId: "r2", status: "answered", at: ENDED_AT },
    }]);

    // The slow callback is called again after its backoff, and answers this time.
    slow.state.hold = undefined;
    await tick(MINUTE_MS);
    expect(slow.state.firings).toBe(2);
    expect(slow.state.received).toEqual([{
      method: "issueReported",
      event: { eventId: expect.any(String), reportId: "r1", priority: "high", filedAt: FILED_AT },
    }]);
    answer.resolve();
  });

  it("because its firing is refused is retried, dropped after the kit's attempts, and a later event delivered", async () => {
    const { state } = await subscribe("subscribeInvestigationComplete");
    const tick = clock();
    // The Workshop refuses a firing while the workspace's owner is not a deployment admin.
    state.refusals = Infinity;

    await ingest(ended("r1"));
    for (let attempt = 2; attempt <= MAX_DELIVERY_ATTEMPTS; attempt++) {
      expect(state.firings).toBe(attempt - 1);
      await tick(HOUR_MS);
    }
    expect(state.firings).toBe(MAX_DELIVERY_ATTEMPTS);

    // Given up on: the owner is an admin again, and the event is not delivered late.
    state.refusals = 0;
    await tick(HOUR_MS);
    expect(state.firings).toBe(MAX_DELIVERY_ATTEMPTS);
    expect(state.received).toEqual([]);

    // The hook was never unregistered: the next event reaches it.
    await ingest(ended("r2", "closed"));
    expect(state.received).toEqual([{
      method: "investigationComplete",
      event: { eventId: expect.any(String), reportId: "r2", status: "closed", at: ENDED_AT },
    }]);
  });

  it("for fewer than the kit's attempts delivers the same event once its firing is answered", async () => {
    const { state } = await subscribe("subscribeIssueReported");
    const tick = clock();
    state.refusals = 3;

    await ingest(reported("r1", "low"));
    await tick(MINUTE_MS);
    await tick(2 * MINUTE_MS);
    expect(state.firings).toBe(3);
    expect(state.received).toEqual([]);

    await tick(4 * MINUTE_MS);
    expect(state.firings).toBe(4);
    expect(state.received).toEqual([{
      method: "issueReported",
      event: { eventId: expect.any(String), reportId: "r1", priority: "low", filedAt: FILED_AT },
    }]);
  });

  it("ends when its hook is disabled, which then receives nothing", async () => {
    const { state, disable } = await subscribe("subscribeIssueReported");
    const tick = clock();
    state.failures = Infinity;

    await ingest(reported("r1"));
    expect(state.firings).toBe(1);

    await disable();
    state.failures = 0;
    await tick(HOUR_MS);
    await ingest(reported("r2"));
    expect(state.firings).toBe(1);
    expect(state.received).toEqual([]);
    // What was queued is finished, not pending.
    expect((await rows()).filter((row) => row.at !== undefined)).toEqual([]);
  });
});

/** A facet of its own, with the methods the test worker adds. */
const facet = () => env.INSTANCE_ADMIN_GATEKEEPER.getByName(crypto.randomUUID()) as unknown as TestFacet;

describe("the delivery stub", () => {
  class Queue extends RpcTarget {
    readonly observed: string[] = [];
    async authorizeObservation(description: ObservationDescription): Promise<void> {
      this.observed.push(description.title);
    }
  }

  class Hook extends RpcTarget {
    readonly calls: string[] = [];
    issueReported(): void {
      this.calls.push("issueReported");
    }
    investigationComplete(): void {
      this.calls.push("investigationComplete");
    }
    issueReportChanged(): void {
      this.calls.push("issueReportChanged");
    }
  }

  it("restores for the three kinds only", async () => {
    const queue = new Queue();
    const hook = new Hook();
    expect((await rejection(facet().testDeliver(
        { kind: "everything" as never }, new RpcStub(hook), new RpcStub(queue), reported("r1"))))
        .message).toBe("No such issue report hook.");
    expect(queue.observed).toEqual([]);
    expect(hook.calls).toEqual([]);
  });

  it("delivers events of its own kind and no other", async () => {
    const queue = new Queue();
    const hook = new Hook();
    await facet().testDeliver(
        { kind: "reported" }, new RpcStub(hook), new RpcStub(queue), ended("r1"));
    expect(queue.observed).toEqual([]);
    expect(hook.calls).toEqual([]);

    await facet().testDeliver(
        { kind: "reported" }, new RpcStub(hook), new RpcStub(queue), reported("r1"));
    expect(queue.observed).toEqual(["Receive an issue report event"]);
    expect(hook.calls).toEqual(["issueReported"]);

    // The third kind takes no other kind's event, and no other kind takes its own.
    const write = changed("r1", "links");
    await facet().testDeliver(
        { kind: "changed" }, new RpcStub(hook), new RpcStub(queue), reported("r1"));
    await facet().testDeliver(
        { kind: "changed" }, new RpcStub(hook), new RpcStub(queue), ended("r1"));
    await facet().testDeliver(
        { kind: "reported" }, new RpcStub(hook), new RpcStub(queue), write);
    await facet().testDeliver(
        { kind: "investigationComplete" }, new RpcStub(hook), new RpcStub(queue), write);
    expect(hook.calls).toEqual(["issueReported"]);

    await facet().testDeliver(
        { kind: "changed" }, new RpcStub(hook), new RpcStub(queue), write);
    expect(queue.observed).toHaveLength(2);
    expect(hook.calls).toEqual(["issueReported", "issueReportChanged"]);
  });
});

describe("the vendor's issueReportEvents()", () => {
  it("resolves once each event is stored for delivery", async () => {
    const { state } = await subscribe("subscribeIssueReported");
    // Kept from being delivered, so the row is read as it was stored.
    state.refusals = Infinity;
    const event = reported("r1", "medium");

    await vendor().issueReportEvents([event, ended("r2")]);

    const queued = (await rows()).filter((row) => row.message !== undefined);
    expect(queued.map((row) => row.message)).toEqual([event]);
    await settled();
  });

  it("rejects when the driver cannot store them, so the store sends them again", async () => {
    const { state } = await subscribe("subscribeIssueReported");
    const event = reported("r1");
    vi.spyOn(IssueReportHookDriver.prototype, "ingest").mockRejectedValueOnce(new Error("The disk is full."));

    expect((await rejection(vendor().issueReportEvents([event]))).message).toContain("The disk is full.");
    expect(state.firings).toBe(0);

    // Sent again with the same `id`, it is taken and delivered once.
    await ingest(event);
    await ingest(event);
    expect(state.firings).toBe(1);
  });

  it("resolves with no subscriber, storing nothing", async () => {
    await expect(vendor().issueReportEvents([reported("r1"), ended("r1")])).resolves.toBeUndefined();
    await expect(vendor().issueReportEvents([])).resolves.toBeUndefined();
    expect((await rows()).filter((row) => row.message !== undefined)).toEqual([]);
  });

  it("takes a batch that mixes kinds it knows with one it does not, and delivers the known ones", async () => {
    const issues = await subscribe("subscribeIssueReported");
    const investigations = await subscribe("subscribeInvestigationComplete");
    const changes = await subscribe("subscribeIssueReportChanged");
    const filed = reported("r1", "medium");
    const unknown = unknownKind("r2");
    const done = ended("r3", "closed");
    const write = changed("r4", "status", "fixSuggested");

    await expect(vendor().issueReportEvents([filed, unknown, done, write])).resolves.toBeUndefined();
    await settled();

    expect(issues.state.firings).toBe(1);
    expect(issues.state.received).toEqual([{
      method: "issueReported",
      event: { eventId: filed.id, reportId: "r1", priority: "medium", filedAt: FILED_AT },
    }]);
    expect(investigations.state.firings).toBe(1);
    expect(investigations.state.received).toEqual([{
      method: "investigationComplete",
      event: { eventId: done.id, reportId: "r3", status: "closed", at: ENDED_AT },
    }]);
    expect(changes.state.firings).toBe(1);
    expect(changes.state.received).toEqual([changedCall(write)]);
    expect(await holding(unknown.id)).toEqual([]);
    expect(await holding(filed.id)).not.toEqual([]);
  });

  it("takes a known kind whose label it does not know, and drops that event alone", async () => {
    const issues = await subscribe("subscribeIssueReported");
    const investigations = await subscribe("subscribeInvestigationComplete");
    const filed = reported("r1");
    const dropped: SentIssueReportEvent[] = [
      { ...ended("r2"), status: "somethingNew" },
      // A status this build knows, and never one an investigation ends with.
      { ...ended("r3"), status: "investigating" },
      { ...ended("r4"), status: "new" },
      { kind: "investigationComplete", id: crypto.randomUUID(), reportId: "r5", at: ENDED_AT },
      { ...reported("r6"), priority: "somethingNew" },
    ];

    await expect(vendor().issueReportEvents([...dropped.slice(0, 3), filed, ...dropped.slice(3)]))
        .resolves.toBeUndefined();
    await settled();

    expect(issues.state.received).toEqual([{
      method: "issueReported",
      event: { eventId: filed.id, reportId: "r1", priority: "high", filedAt: FILED_AT },
    }]);
    expect(issues.state.firings).toBe(1);
    expect(investigations.state.firings).toBe(0);
    for (const { id } of dropped) expect(await holding(id)).toEqual([]);
  });

  it("takes a changed event whose label it does not know, and drops that event alone", async () => {
    const changes = await subscribe("subscribeIssueReportChanged");
    const write = changed("r1", "reply", "withAdmin");
    const dropped: SentIssueReportEvent[] = [
      { ...changed("r2", "note"), change: "somethingNew" },
      { ...changed("r3", "status"), status: "somethingNew" },
      { kind: "changed", id: crypto.randomUUID(), reportId: "r4", at: CHANGED_AT },
    ];

    await expect(vendor().issueReportEvents([dropped[0]!, write, ...dropped.slice(1)]))
        .resolves.toBeUndefined();
    await settled();

    expect(changes.state.received).toEqual([changedCall(write)]);
    expect(changes.state.firings).toBe(1);
    for (const { id } of dropped) expect(await holding(id)).toEqual([]);
  });

  it("takes an unknown kind when nothing is subscribed", async () => {
    const unknown = unknownKind("r1");
    await expect(vendor().issueReportEvents([unknown])).resolves.toBeUndefined();
    expect(await holding(unknown.id)).toEqual([]);
    expect((await rows()).filter((row) => row.message !== undefined)).toEqual([]);
  });

  it("still refuses an event that is not ids and labels, a broken sender's and not a newer one's", async () => {
    const { state } = await subscribe("subscribeIssueReported");
    const filed = reported("r1");
    const { id: _id, ...noId } = reported("r2");

    for (const broken of [
      noId,
      { kind: "reported" },
      { ...reported("r2"), at: FILED_AT.toISOString() },
      { ...reported("r2"), kind: 4 },
      { ...reported("r2"), priority: 4 },
      { ...ended("r2"), status: { is: "answered" } },
      { ...changed("r2", "note"), change: 4 },
    ]) {
      const refused = await rejection(vendor().issueReportEvents([filed, broken as never]));
      expect(refused.message, JSON.stringify(broken)).not.toBe("did not reject");
    }

    // Nothing of a refused call is stored, the event beside the broken one included.
    expect(state.firings).toBe(0);
    expect(await holding(filed.id)).toEqual([]);
  });

  it("validates the rest of the vendor as before", async () => {
    expect((await vendor().describe()).autoProvisionsAccount).toBe(true);
    expect((await vendor().getSupportedResources()).map(({ id }) => id)).toEqual(["deployment"]);
    expect(await vendor().getTypeScriptTypes()).toContain("subscribeIssueReported");
    expect((await rejection(vendor().getSupportedResources({ userId: 4 } as never))).message)
        .not.toBe("did not reject");
    expect((await rejection(vendor().issueReportEvents("r1" as never))).message)
        .not.toBe("did not reject");
  });
});

describe("the driver's storage", () => {
  const KEY = "[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}";

  it("holds each hook's kind and stubs, and ids and labels of events: no report's text or reporter", async () => {
    const delivered = await subscribe("subscribeIssueReported");
    const pending = await subscribe("subscribeInvestigationComplete");
    pending.state.failures = Infinity;
    const filed = reported("r1", "low");
    const done = ended("r1", "answered");
    await ingest(filed, done);
    expect(delivered.state.received).toHaveLength(1);
    expect(pending.state.firings).toBe(1);

    const entries = [...await stored()];
    const of = (pattern: RegExp) => entries.filter(([key]) => pattern.test(key)).map(([, value]) => value);
    // Every key is one of these, so nothing else is stored.
    const known = [
      new RegExp(`^reg:${KEY}$`), new RegExp(`^caps:${KEY}$`), new RegExp(`^msg:${KEY}:${KEY}$`),
      new RegExp(`^queue:(due|finished):\\d{15}:${KEY}:${KEY}$`), /^queue:indexed$/,
    ];
    expect(entries.map(([key]) => key).filter((key) => !known.some((pattern) => pattern.test(key))))
        .toEqual([]);

    expect(of(known[0]!).toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))
        .toEqual([{ kind: "investigationComplete" }, { kind: "reported" }]);
    expect(of(known[1]!)).toEqual([["delivery", "initiator"], ["delivery", "initiator"]]);
    expect(new Set(of(known[3]!))).toEqual(new Set([true]));

    // Of the two hooks enabled here (earlier tests' rows stay until their day has passed): a
    // delivered event leaves a time; one still to deliver is the event as the store sent it.
    const hooks = entries.map(([key]) => key).filter((key) => key.startsWith("reg:"))
        .map((key) => key.slice("reg:".length));
    const queued = entries
        .filter(([key]) => hooks.some((hook) => key.startsWith(`msg:${hook}:`)))
        .map(([, row]) => row as Row);
    expect(queued.filter((row) => row.message === undefined)).toEqual([{ deliveredAt: expect.any(Number) }]);
    expect(queued.filter((row) => row.message !== undefined)).toEqual([
      { message: done, attempts: 1, at: expect.any(Number) },
    ]);
  });

  it("holds an event's declared fields and no other the sender added", async () => {
    const issues = await subscribe("subscribeIssueReported");
    const investigations = await subscribe("subscribeInvestigationComplete");
    // Kept from being delivered, so each row is read as it was stored.
    issues.state.refusals = Infinity;
    investigations.state.refusals = Infinity;
    const filed = reported("r1", "low");
    const done = ended("r2", "closed");
    // The vendor's argument check lets a property the type does not declare through.
    const extra = { text: "WHAT WENT WRONG", reporter: { id: "u1", name: "THE REPORTER" } };

    // Each also carries the other kind's label.
    await vendor().issueReportEvents([
      { ...filed, ...extra, status: "closed" },
      { ...done, ...extra, priority: "high" },
    ]);

    const entries = [...await stored()];
    const messages = entries.map(([, row]) => (row as Row).message)
        .filter((message) => message?.id === filed.id || message?.id === done.id);
    expect(messages.toSorted((a, b) => a!.reportId.localeCompare(b!.reportId))).toEqual([filed, done]);
    expect(messages.map((message) => Object.keys(message!).toSorted()).toSorted()).toEqual([
      ["at", "id", "kind", "priority", "reportId"],
      ["at", "id", "kind", "reportId", "status"],
    ]);
    const everything = JSON.stringify(entries);
    expect(everything).toContain('"r1"');
    expect(everything).not.toContain("WHAT WENT WRONG");
    expect(everything).not.toContain("THE REPORTER");
    await settled();
  });

  it("holds a changed event's ids, what the write was, its time and its status when set, and nothing a sender added", async () => {
    const { state } = await subscribe("subscribeIssueReportChanged");
    state.refusals = Infinity;
    const set = changed("r1", "status", "closed");
    const note = changed("r2", "note");
    const extra = {
      text: "WHAT THE NOTE SAYS", author: { id: "u1", name: "THE AUTHOR" }, visibility: "admins",
    };

    // The second also carries another kind's label.
    await vendor().issueReportEvents([{ ...set, ...extra }, { ...note, ...extra, priority: "high" }]);

    const entries = [...await stored()];
    const messages = entries.map(([, row]) => (row as Row).message)
        .filter((message) => message?.id === set.id || message?.id === note.id);
    expect(messages.toSorted((a, b) => a!.reportId.localeCompare(b!.reportId))).toEqual([set, note]);
    expect(messages.map((message) => Object.keys(message!).toSorted()).toSorted()).toEqual([
      ["at", "change", "id", "kind", "reportId"],
      ["at", "change", "id", "kind", "reportId", "status"],
    ]);
    const everything = JSON.stringify(entries);
    expect(everything).toContain('"r1"');
    expect(everything).not.toContain("WHAT THE NOTE SAYS");
    expect(everything).not.toContain("THE AUTHOR");
    expect(everything).not.toContain("visibility");
    await settled();
  });
});

/** The doc comment that ends just before `signature`, as one line. */
function docOf(types: string, signature: string): string {
  const before = types.slice(0, types.indexOf(signature));
  return before.slice(before.lastIndexOf("/**")).replace(/\n\s*\*\s?/g, " ");
}

/** `labels` as a union of string literals. */
const union = (labels: readonly string[]) => labels.map((label) => `"${label}"`).join(" | ");

describe("the declarations", () => {
  const NOT_YET = "its images and the grant its reporter may give with it are attached by later " +
    "calls, so a subscriber that reads at once may find no image and be refused content, and " +
    "reads again later rather than concluding there is none.";
  it("say, where a hook for new reports is subscribed and called, that images and the grant come later", async () => {
    const types = await env.INSTANCE_ADMIN_GATEKEEPER.getByName("types").getTypeScriptTypes();
    for (const signature of [
      "  subscribeIssueReported(hook: IssueReportedHook): Promise<void>;",
      "  issueReported(event: {",
    ]) {
      expect(types).toContain(`\n${signature}\n`);
      expect(docOf(types, signature), signature).toContain(NOT_YET);
    }
    expect(types).toContain("\n  subscribeInvestigationComplete(hook: InvestigationCompleteHook): Promise<void>;\n");
    expect(docOf(types, "  subscribeIssueReported(hook: IssueReportedHook)")).toContain("persistent stub");
  });

  it("declare a hook for every write to a report, called for the subscriber's own writes too", async () => {
    const types = await env.INSTANCE_ADMIN_GATEKEEPER.getByName("types").getTypeScriptTypes();
    const signature = "  subscribeIssueReportChanged(hook: IssueReportChangedHook): Promise<void>;";
    expect(types).toContain(`\n${signature}\n`);
    const doc = docOf(HAND_WRITTEN_TYPES, signature);
    expect(doc).toContain("each time an issue report is written to after it was filed");
    expect(doc).toContain("YOUR OWN agents and gadgets too");
    expect(doc).toContain("That is how code learns that an action it queued was applied");
    expect(doc).toContain("must not answer its own change");
    expect(doc).toContain("persistent stub");

    expect(HAND_WRITTEN_TYPES).toMatch(/^export interface IssueReportChangedHook \{$/m);
    const callback = docOf(HAND_WRITTEN_TYPES, "export interface IssueReportChangedHook {");
    expect(callback).toContain("never the text of an entry, a name or who made the write");
    expect(callback).toContain("It is called for a write this workspace's own agents and gadgets made too.");
    expect(callback).toContain("calls this and InvestigationCompleteHook, with an event id each");
  });

  it("say that a report's events keep no order and that an event's status can be stale", () => {
    expect(docOf(HAND_WRITTEN_TYPES, "export interface IssueReportChangedHook {")).toContain(
        "The events of one report can arrive in any order, and two calls for it can run at once: " +
        "never keep the last event's `status` as the report's, and never take two calls for one " +
        "report to run one after the other.");
    expect(docOf(HAND_WRITTEN_TYPES, "    status?: ")).toContain(
        "A later write may have set another by the time this arrives, in an event that arrived " +
        "first: read the report for the status it has.");
  });

  it("say what sends no event, and to read the report rather than wait for one", () => {
    const doc = docOf(HAND_WRITTEN_TYPES,
        "  subscribeIssueReportChanged(hook: IssueReportChangedHook): Promise<void>;");
    for (const said of [
      "changed nothing", "denied", "refused where it lands", "`assigned`", "`threadFull`",
      "never waits on the event alone",
    ]) {
      expect(doc, said).toContain(said);
    }
  });

  it("declare a changed event's own id, what the write was and the status it set", () => {
    const from = HAND_WRITTEN_TYPES.slice(HAND_WRITTEN_TYPES.indexOf("  issueReportChanged(event: {"));
    // A union wraps after a bar where the line is full.
    const event = from.slice(0, from.indexOf("}): void;")).replace(/ \|\n +/g, " | ");
    expect(event).toContain("\n    eventId: string;\n");
    expect(event).toContain("\n    reportId: string;\n");
    expect(event).toContain(`\n    change: ${union(ISSUE_REPORT_CHANGES)};\n`);
    expect(event).toContain(`\n    status?: ${union(ISSUE_REPORT_STATUSES)};\n`);
    expect(event).toContain("\n    at: Date;\n");
  });

  it("name one exported interface a hook's callback can implement, which covers the three callbacks", async () => {
    const description = await env.INSTANCE_ADMIN_GATEKEEPER.getByName("types").describe();
    expect(description.hookTsType).toBe("IssueReportHook");
    // An interface, since a class cannot implement a union of the three.
    expect(HAND_WRITTEN_TYPES).toContain("\nexport interface IssueReportHook\n" +
        "  extends Partial<IssueReportedHook>, Partial<InvestigationCompleteHook>,\n" +
        "    Partial<IssueReportChangedHook> {}\n");
    const doc = docOf(HAND_WRITTEN_TYPES, "export interface IssueReportHook\n");
    expect(doc).toContain("One callback can serve all three hooks.");
    expect(doc).toContain("RpcTarget");
    expect(doc).toContain("[restore]()");
    expect(doc).not.toContain("entrypoint");
    expect(HAND_WRITTEN_TYPES).toMatch(/^export interface IssueReportedHook \{$/m);
    expect(HAND_WRITTEN_TYPES).toMatch(/^export interface InvestigationCompleteHook \{$/m);
    expect(HAND_WRITTEN_TYPES).toContain('priority: "low" | "medium" | "high";');
    // Every status an investigation can end with, wrapped after a bar where the line is full.
    expect(HAND_WRITTEN_TYPES.replace(/ \|\n +/g, " | ")).toContain(
        'status: "answered" | "waitingOnReporter" | "withAdmin" | "fixSuggested" | ' +
        '"fixInProgress" | "fixProposed" | "closed";');
  });

  it("say which events mark the workspace that receives them, and what follows", () => {
    const MARKS = "marks THIS workspace as holding restricted data, as reading the report through " +
      "this binding does: from then on nothing here is applied without a person, a reply " +
      "through a report session included.";
    expect(docOf(HAND_WRITTEN_TYPES, "  subscribeInvestigationComplete(hook: ")).toContain(
        "An event whose status is \"fixSuggested\" or \"fixInProgress\", which the report's " +
        `reporter reads as "withAdmin", ${MARKS}`);
    expect(docOf(HAND_WRITTEN_TYPES, "  subscribeIssueReportChanged(hook: ")).toContain(
        `Every event but a "reply" tells what the report's reporter is not shown, and ${MARKS}`);
    expect(docOf(HAND_WRITTEN_TYPES, "export interface InvestigationCompleteHook {")).toContain(
        "Receiving an event whose `status` is \"fixSuggested\" or \"fixInProgress\" marks this " +
        "workspace as holding restricted data");
    expect(docOf(HAND_WRITTEN_TYPES, "export interface IssueReportChangedHook {")).toContain(
        "Receiving an event of any `change` but \"reply\" marks this workspace as holding " +
        "restricted data");
  });

  it("give each callback's event its own id, and say to key the work by it since an event can repeat", () => {
    for (const hook of ["IssueReportedHook", "InvestigationCompleteHook", "IssueReportChangedHook"]) {
      const doc = docOf(HAND_WRITTEN_TYPES, `export interface ${hook} {`);
      expect(doc, hook).toContain("can be called more than once for the same event");
      expect(doc, hook).toContain("key the work by `eventId`, which is the same each time one event is delivered");
      // No other key is offered: a report's id and a time are shared by two ends of one millisecond.
      expect(doc, hook).not.toMatch(/by the report's id/);
    }
    for (const method of ["issueReported", "investigationComplete", "issueReportChanged"]) {
      const event = HAND_WRITTEN_TYPES.slice(HAND_WRITTEN_TYPES.indexOf(`  ${method}(event: {`));
      expect(event.slice(0, event.indexOf("}): void;")), method).toContain("\n    eventId: string;\n");
    }
  });
});
