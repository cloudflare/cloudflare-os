import { env } from "cloudflare:workers";
import {
  abortAllDurableObjects,
  reset,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HookInitiator } from "@gadgets/workshop-shared/gatekeeper";
import { reportIssue } from "@gadgets/backend-utils/error-reporting";
import type { ScheduledTaskHook } from "../src/types.js";
import { ScheduleDriver } from "../src/schedule-driver.js";
import type { ScheduleActivation, StoredSchedule } from "../src/schedule-driver.js";

vi.mock("@gadgets/backend-utils/error-reporting", () => ({ reportIssue: vi.fn() }));

type ScheduleHookTarget = RpcTarget & ScheduledTaskHook;

type TestHooks = HookInitiator<ScheduleHookTarget> & {
  configure(
    mode: "success" | "start-reject" | "authorization-reject" | "callback-reject",
  ): Promise<void>;
  blockAt(point: "start" | "authorization" | "callback"): Promise<void>;
  read(): Promise<{
    events: string[];
    callbackScheduleIds: string[];
    maxActiveCallbacks: number;
    disposedApprovalQueues: number;
    disposedCallbacks: number;
  }>;
  release(): Promise<void>;
  reset(): Promise<void>;
  waitUntilBlocked(): Promise<void>;
};

const testEnv = env as unknown as {
  SCHEDULE_DRIVER: DurableObjectNamespace<ScheduleDriver>;
  TEST_HOOKS: Fetcher<TestHooks>;
};

const gadgetId = 3;
const MAX_ENABLED_SCHEDULES_PER_ACCOUNT = 500;
const MAX_ENABLED_SCHEDULES_PER_WORKSPACE = 100;

function testInitiator(driver: ScheduleDriver): Fetcher<TestHooks> {
  // The pool wraps env capabilities, so mint the persistable entrypoint inside the Worker.
  const exports = driver.ctx.exports as unknown as {
    TestHooks(options: object): Fetcher<TestHooks>;
  };
  return exports.TestHooks({});
}

function enableSchedule(
  driver: DurableObjectStub<ScheduleDriver>,
  activation: ScheduleActivation,
  now = Date.now(),
): Promise<void> {
  return runInDurableObject(driver, (instance) =>
    instance.enable(activation, testInitiator(instance), now),
  );
}

async function updateSchedule(
  driver: DurableObjectStub<ScheduleDriver>,
  workspaceId: string,
  scheduleId: string,
  update: (stored: StoredSchedule) => StoredSchedule,
): Promise<void> {
  await runInDurableObject(driver, (_instance, state) => {
    const key = `schedule:${workspaceId}:${scheduleId}`;
    const stored = state.storage.kv.get<StoredSchedule>(key);
    if (!stored) throw new Error(`Missing test schedule: ${key}`);
    state.storage.kv.put(key, update(stored));
  });
}

async function makeActiveScheduleDue(
  driver: DurableObjectStub<ScheduleDriver>,
  workspaceId: string,
  scheduleId: string,
): Promise<void> {
  await updateSchedule(driver, workspaceId, scheduleId, (stored) => {
    if (stored.state.status !== "active") throw new Error("Expected active schedule");
    return { ...stored, state: { ...stored.state, nextFire: 1 } };
  });
}

async function putScheduleRows(
  driver: DurableObjectStub<ScheduleDriver>,
  count: number,
  workspaceIdFor: (index: number) => string,
  anchorMs: number,
): Promise<void> {
  await runInDurableObject(driver, (_instance, state) => {
    state.storage.transactionSync(() => {
      for (let index = 0; index < count; index++) {
        const workspaceId = workspaceIdFor(index);
        const scheduleId = `seed-${index}`;
        state.storage.kv.put<StoredSchedule>(`schedule:${workspaceId}:${scheduleId}`, {
          version: 1,
          state: {
            workspaceId,
            scheduleId,
            spec: { kind: "interval", everyMs: 60_000, anchorMs },
            status: "active",
            nextFire: anchorMs + 60_000,
          },
          title: "Seeded schedule",
          description: "Quota fixture.",
          gadgetId,
        });
      }
    });
  });
}

async function revokeWhileDeliveryIsBlocked(
  name: string,
  point: "start" | "authorization" | "callback",
): Promise<string[]> {
  const driver = testEnv.SCHEDULE_DRIVER.getByName(name);
  const activationTime = Date.now();
  await enableSchedule(
    driver,
    {
      workspaceId: "workspace-a",
      scheduleId: "schedule-a",
      spec: { kind: "interval", everyMs: 60_000, anchorMs: activationTime },
      title: "Blocked task",
      description: "Test revocation during delivery.",
      gadgetId,
    },
    activationTime,
  );
  await makeActiveScheduleDue(driver, "workspace-a", "schedule-a");
  await testEnv.TEST_HOOKS.blockAt(point);

  const alarm = runDurableObjectAlarm(driver);
  try {
    await testEnv.TEST_HOOKS.waitUntilBlocked();
    await driver.revoke();
  } finally {
    await testEnv.TEST_HOOKS.release();
  }
  await alarm;

  expect(await driver.getSchedule("workspace-a", "schedule-a")).toBeUndefined();
  return (await testEnv.TEST_HOOKS.read()).events;
}

describe("ScheduleDriver", () => {
  beforeEach(() => {
    vi.mocked(reportIssue).mockClear();
    return testEnv.TEST_HOOKS.reset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    return reset();
  });

  it("stores capabilities separately and delivers through an alarm after reconstruction", async () => {
    let driver = testEnv.SCHEDULE_DRIVER.getByName("reconstruction");
    const activationTime = Date.now();
    await enableSchedule(
      driver,
      {
        workspaceId: "workspace-a",
        scheduleId: "schedule-a",
        spec: { kind: "interval", everyMs: 60_000, anchorMs: activationTime },
        title: "Heartbeat",
        description: "Run the heartbeat callback.",
        gadgetId,
      },
      activationTime,
    );

    const keys = await runInDurableObject(driver, (_instance, state) =>
      [...state.storage.kv.list()].map(([key]) => key).toSorted(),
    );
    expect(keys).toContain("schedule:workspace-a:schedule-a");
    expect(keys).toContain("caps:workspace-a:schedule-a");

    await abortAllDurableObjects();
    driver = testEnv.SCHEDULE_DRIVER.getByName("reconstruction");
    await makeActiveScheduleDue(driver, "workspace-a", "schedule-a");
    expect(await runDurableObjectAlarm(driver)).toBe(true);

    const stored = await driver.getSchedule("workspace-a", "schedule-a");
    expect(stored?.state).toMatchObject({ status: "active" });
    expect((await testEnv.TEST_HOOKS.read()).events.map((event) => event.split(":")[0])).toEqual([
      "start",
      "authorize",
      "callback",
    ]);
  });

  it("completes consecutive Sunday and Wednesday deliveries for a weekly schedule", async () => {
    const driver = testEnv.SCHEDULE_DRIVER.getByName("weekly-deliveries");
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const daysUntilSunday = 7 - today.getUTCDay();
    const sundayMorning = today.getTime() + daysUntilSunday * 86_400_000 + 8 * 3_600_000;
    const sundayDelivery = sundayMorning + 3_600_000;
    const wednesdayDelivery = sundayDelivery + 3 * 86_400_000;
    const now = vi.spyOn(Date, "now").mockReturnValue(sundayMorning);
    await enableSchedule(
      driver,
      {
        workspaceId: "workspace-a",
        scheduleId: "weekly",
        spec: {
          kind: "calendar",
          timeZone: "UTC",
          rule: {
            freq: "weekly",
            interval: 1,
            byDay: ["SU", "WE"],
            hour: 9,
            minute: 0,
            anchorMs: sundayMorning,
          },
        },
        title: "Weekly task",
        description: "Run twice each week.",
        gadgetId,
      },
      sundayMorning,
    );

    now.mockReturnValue(sundayDelivery);
    await runDurableObjectAlarm(driver);
    expect((await driver.getSchedule("workspace-a", "weekly"))?.state).toMatchObject({
      status: "active",
      nextFire: wednesdayDelivery,
    });

    now.mockReturnValue(wednesdayDelivery);
    await runDurableObjectAlarm(driver);
    expect(
      (await testEnv.TEST_HOOKS.read()).events.filter((event) => event.startsWith("callback:")),
    ).toHaveLength(2);
  });

  it("expires a one-shot on any startHook rejection without authorization or attempt consumption", async () => {
    const driver = testEnv.SCHEDULE_DRIVER.getByName("admission-rejection");
    const activationTime = Date.now();
    await testEnv.TEST_HOOKS.configure("start-reject");
    await enableSchedule(
      driver,
      {
        workspaceId: "workspace-a",
        scheduleId: "one-shot",
        spec: { kind: "once", fireAt: activationTime + 60_000, timeZone: "UTC" },
        title: "One shot",
        description: "Run once.",
        gadgetId,
      },
      activationTime,
    );

    await makeActiveScheduleDue(driver, "workspace-a", "one-shot");
    await runDurableObjectAlarm(driver);

    expect((await driver.getSchedule("workspace-a", "one-shot"))?.state).toMatchObject({
      status: "expired",
    });
    expect((await testEnv.TEST_HOOKS.read()).events).toEqual(["start"]);
    expect(reportIssue).not.toHaveBeenCalled();
  });

  it("replaces and removes stored activation capabilities", async () => {
    const driver = testEnv.SCHEDULE_DRIVER.getByName("capability-lifecycle");
    const activationTime = Date.now();
    const activation = {
      workspaceId: "workspace-a",
      scheduleId: "schedule-a",
      spec: { kind: "interval" as const, everyMs: 60_000, anchorMs: activationTime },
      occurrences: { count: 2 },
      title: "Initial title",
      description: "Test capability replacement.",
      gadgetId,
    };
    await enableSchedule(driver, activation, activationTime);
    await enableSchedule(driver, { ...activation, gadgetId: 7 }, activationTime + 1);

    expect((await driver.getSchedule("workspace-a", "schedule-a"))?.gadgetId).toBe(7);
    expect(await driver.listWorkspace("workspace-a")).toEqual([
      {
        scheduleId: "schedule-a",
        title: "Initial title",
        description: "Test capability replacement.",
        cadence: { kind: "interval", everyMs: 60_000, anchorMs: activationTime },
        occurrences: { count: 2 },
        occurrenceCount: 0,
        status: "active",
        nextFire: activationTime + 60_000,
      },
    ]);
    expect(
      await driver.listAccount({ query: "capability replacement", statuses: ["active"] }),
    ).toEqual({
      schedules: [
        expect.objectContaining({
          scheduleId: "schedule-a",
          workspaceId: "workspace-a",
          gadgetId: 7,
        }),
      ],
    });

    await enableSchedule(driver, { ...activation, gadgetId: undefined }, activationTime + 2);
    expect((await driver.listAccount())[0]?.gadgetId).toBeUndefined();

    await makeActiveScheduleDue(driver, "workspace-a", "schedule-a");
    expect(await runDurableObjectAlarm(driver)).toBe(true);
    await makeActiveScheduleDue(driver, "workspace-a", "schedule-a");
    expect(await runDurableObjectAlarm(driver)).toBe(true);
    expect(
      (await testEnv.TEST_HOOKS.read()).events.filter((event) => event.startsWith("callback:")),
    ).toHaveLength(2);
    await vi.waitFor(async () => {
      expect(await testEnv.TEST_HOOKS.read()).toMatchObject({
        disposedApprovalQueues: 2,
        disposedCallbacks: 2,
      });
    }, { timeout: 5_000 });

    await driver.disable("workspace-a", "schedule-a");
    const keys = await runInDurableObject(driver, (_instance, state) =>
      [...state.storage.kv.list()].map(([key]) => key),
    );
    expect(keys).toEqual(["metadata"]);
    expect(await driver.getSchedule("workspace-a", "schedule-a")).toBeUndefined();
  });

  it("versions persisted rows and returns a cloned public weekly cadence", async () => {
    const driver = testEnv.SCHEDULE_DRIVER.getByName("versioned-cadence");
    const activationTime = Date.now();
    await enableSchedule(
      driver,
      {
        workspaceId: "workspace-a",
        scheduleId: "weekly",
        spec: {
          kind: "calendar",
          timeZone: "UTC",
          rule: {
            freq: "weekly",
            interval: 1,
            byDay: ["MO", "WE"],
            hour: 9,
            minute: 0,
            anchorMs: activationTime,
          },
        },
        title: "Weekly task",
        description: "Test public cadence projection.",
        gadgetId,
      },
      activationTime,
    );

    const persistedVersion = await runInDurableObject(driver, (_instance, state) =>
      state.storage.kv.get<{ version?: number }>("schedule:workspace-a:weekly"),
    );
    expect(persistedVersion?.version).toBe(1);

    const [first] = await driver.listWorkspace("workspace-a");
    if (first?.cadence.kind !== "calendar" || first.cadence.rule.freq !== "weekly") {
      throw new Error("Expected a weekly cadence");
    }
    first.cadence.rule.byDay.push("FR");

    const [second] = await driver.listWorkspace("workspace-a");
    expect(second?.cadence).toEqual({
      kind: "calendar",
      timeZone: "UTC",
      rule: {
        freq: "weekly",
        interval: 1,
        byDay: ["MO", "WE"],
        hour: 9,
        minute: 0,
        anchorMs: activationTime,
      },
    });
  });

  it("reports and rejects unsupported rows on direct reads and mutations", async () => {
    const driver = testEnv.SCHEDULE_DRIVER.getByName("unsupported-direct");
    await runInDurableObject(driver, (_instance, state) =>
      state.storage.kv.put("schedule:workspace-a:unsupported", { version: 2 }),
    );

    const messages = await runInDurableObject(driver, async (instance) => {
      const read = await rejectedMessage(() => instance.getSchedule("workspace-a", "unsupported"));
      const mutation = await rejectedMessage(() =>
        instance.enable(
          {
            workspaceId: "workspace-a",
            scheduleId: "unsupported",
            spec: { kind: "interval", everyMs: 60_000, anchorMs: Date.now() },
            title: "Replacement",
            description: "Must not replace an unsupported row.",
            gadgetId,
          },
          testInitiator(instance),
        ),
      );
      return { read, mutation };
    });
    expect(messages.read).toContain("Unsupported scheduler schedule row");
    expect(messages.mutation).toContain("Unsupported scheduler schedule row");
    expect(reportIssue).toHaveBeenCalledWith(
      "scheduler.schedule-row.unsupported",
      expect.any(Error),
      expect.objectContaining({ handled: true }),
    );
  });

  it("reports and skips unsupported rows in list and alarm scans", async () => {
    const driver = testEnv.SCHEDULE_DRIVER.getByName("unsupported-scan");
    const activationTime = Date.now();
    await enableSchedule(
      driver,
      {
        workspaceId: "workspace-a",
        scheduleId: "healthy",
        spec: { kind: "interval", everyMs: 60_000, anchorMs: activationTime },
        title: "Healthy task",
        description: "Continue past an unsupported sibling row.",
        gadgetId,
      },
      activationTime,
    );
    await makeActiveScheduleDue(driver, "workspace-a", "healthy");
    await runInDurableObject(driver, (_instance, state) =>
      state.storage.kv.put("schedule:workspace-a:unsupported", { version: 2 }),
    );

    await expect(driver.listWorkspace("workspace-a")).resolves.toEqual([
      expect.objectContaining({ scheduleId: "healthy" }),
    ]);
    await runDurableObjectAlarm(driver);
    expect((await testEnv.TEST_HOOKS.read()).callbackScheduleIds).toEqual(["healthy"]);
    const alarm = await runInDurableObject(driver, (_instance, state) => state.storage.getAlarm());
    expect(alarm).toBeGreaterThan(Date.now());
    expect(reportIssue).toHaveBeenCalledWith(
      "scheduler.schedule-row.unsupported",
      expect.any(Error),
      expect.objectContaining({ handled: true }),
    );
  });

  it("does not persist metadata when an empty account is read", async () => {
    const driver = testEnv.SCHEDULE_DRIVER.getByName("empty-account");
    await expect(driver.listAccount()).resolves.toEqual({ schedules: [], cursor: undefined });
    const keys = await runInDurableObject(driver, (_instance, state) => [
      ...state.storage.kv.list(),
    ]);
    expect(keys).toEqual([]);
  });

  it("persists a stable logical run and retry deadline after callback failure", async () => {
    const driver = testEnv.SCHEDULE_DRIVER.getByName("retry");
    const activationTime = Date.now();
    await testEnv.TEST_HOOKS.configure("callback-reject");
    await enableSchedule(
      driver,
      {
        workspaceId: "workspace-a",
        scheduleId: "schedule-a",
        spec: { kind: "interval", everyMs: 60_000, anchorMs: activationTime },
        title: "Retrying task",
        description: "Fail once and retry.",
        gadgetId,
      },
      activationTime,
    );

    await makeActiveScheduleDue(driver, "workspace-a", "schedule-a");
    await runDurableObjectAlarm(driver);

    const stored = await driver.getSchedule("workspace-a", "schedule-a");
    expect(stored?.state).toMatchObject({
      status: "retrying",
      attempts: 1,
      runId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    if (stored?.state.status !== "retrying") throw new Error("Expected retrying state");
    expect(stored.state.nextAttempt).toBeGreaterThan(Date.now());
    expect(await driver.listWorkspace("workspace-a")).toEqual([
      expect.objectContaining({
        status: "active",
        nextFire: stored.state.nextAttempt,
        retrying: true,
      }),
    ]);
    expect(reportIssue).not.toHaveBeenCalled();
  });

  it("retries authorization with the same run ID and completes a one-shot", async () => {
    const driver = testEnv.SCHEDULE_DRIVER.getByName("authorization-retry");
    const activationTime = Date.now();
    await testEnv.TEST_HOOKS.configure("authorization-reject");
    await enableSchedule(
      driver,
      {
        workspaceId: "workspace-a",
        scheduleId: "one-shot",
        spec: { kind: "once", fireAt: activationTime + 60_000, timeZone: "UTC" },
        title: "Authorized task",
        description: "Retry authorization before delivery.",
        gadgetId,
      },
      activationTime,
    );
    await makeActiveScheduleDue(driver, "workspace-a", "one-shot");
    await runDurableObjectAlarm(driver);

    const retrying = await driver.getSchedule("workspace-a", "one-shot");
    expect(retrying?.state).toMatchObject({ status: "retrying", attempts: 1 });
    if (retrying?.state.status !== "retrying") throw new Error("Expected retrying state");
    const { runId } = retrying.state;

    await testEnv.TEST_HOOKS.configure("success");
    await updateSchedule(driver, "workspace-a", "one-shot", (stored) => {
      if (stored.state.status !== "retrying") throw new Error("Expected retrying schedule");
      return { ...stored, state: { ...stored.state, nextAttempt: 1 } };
    });
    await runDurableObjectAlarm(driver);

    expect((await driver.getSchedule("workspace-a", "one-shot"))?.state).toEqual(
      expect.objectContaining({ status: "completed" }),
    );
    expect((await testEnv.TEST_HOOKS.read()).events).toEqual([
      "start",
      "authorize",
      "start",
      "authorize",
      `callback:${runId}`,
    ]);
    await vi.waitFor(async () => {
      expect(await testEnv.TEST_HOOKS.read()).toMatchObject({
        disposedApprovalQueues: 2,
        disposedCallbacks: 2,
      });
    }, { timeout: 5_000 });
    expect(reportIssue).not.toHaveBeenCalled();
  });

  it("recovers admission with the persisted run ID", async () => {
    const driver = testEnv.SCHEDULE_DRIVER.getByName("recover-admission");
    const activationTime = Date.now();
    await enableSchedule(
      driver,
      {
        workspaceId: "workspace-a",
        scheduleId: "schedule-a",
        spec: { kind: "interval", everyMs: 60_000, anchorMs: activationTime },
        title: "Recover admission",
        description: "Recover before admission completes.",
        gadgetId,
      },
      activationTime,
    );
    await updateSchedule(driver, "workspace-a", "schedule-a", (stored) => {
      if (stored.state.status !== "active") throw new Error("Expected active schedule");
      return {
        ...stored,
        state: {
          ...stored.state,
          status: "pending",
          stage: "admission",
          runId: "recovered-admission",
          scheduledTime: stored.state.nextFire,
          attempts: 0,
          leaseExpiresAt: 1,
          nextFire: undefined,
        },
      };
    });

    await runDurableObjectAlarm(driver);

    expect((await driver.getSchedule("workspace-a", "schedule-a"))?.state).toMatchObject({
      status: "active",
    });
    expect((await testEnv.TEST_HOOKS.read()).events).toContain("callback:recovered-admission");
  });

  it("recovers an abandoned delivery through callback backoff without invoking it again", async () => {
    const driver = testEnv.SCHEDULE_DRIVER.getByName("recover-delivery");
    const activationTime = Date.now();
    await enableSchedule(
      driver,
      {
        workspaceId: "workspace-a",
        scheduleId: "schedule-a",
        spec: { kind: "interval", everyMs: 60_000, anchorMs: activationTime },
        title: "Recover delivery",
        description: "Recover after admission completes.",
        gadgetId,
      },
      activationTime,
    );
    await updateSchedule(driver, "workspace-a", "schedule-a", (stored) => {
      if (stored.state.status !== "active") throw new Error("Expected active schedule");
      return {
        ...stored,
        state: {
          ...stored.state,
          status: "pending",
          stage: "delivery",
          runId: "recovered-delivery",
          scheduledTime: stored.state.nextFire,
          attempts: 1,
          leaseExpiresAt: 1,
          nextFire: stored.state.nextFire + 60_000,
        },
      };
    });

    await runDurableObjectAlarm(driver);

    expect((await driver.getSchedule("workspace-a", "schedule-a"))?.state).toMatchObject({
      status: "retrying",
      runId: "recovered-delivery",
      attempts: 1,
    });
    expect((await testEnv.TEST_HOOKS.read()).events).toEqual([]);
  });

  it("marks an abandoned eighth delivery attempt dead", async () => {
    const driver = testEnv.SCHEDULE_DRIVER.getByName("recover-eighth-delivery");
    const activationTime = Date.now();
    await enableSchedule(
      driver,
      {
        workspaceId: "workspace-a",
        scheduleId: "schedule-a",
        spec: { kind: "interval", everyMs: 60_000, anchorMs: activationTime },
        title: "Exhaust delivery",
        description: "Exhaust a delivery abandoned by the runtime.",
        gadgetId,
      },
      activationTime,
    );
    await updateSchedule(driver, "workspace-a", "schedule-a", (stored) => {
      if (stored.state.status !== "active") throw new Error("Expected active schedule");
      return {
        ...stored,
        state: {
          ...stored.state,
          status: "pending",
          stage: "delivery",
          runId: "exhausted-delivery",
          scheduledTime: stored.state.nextFire,
          attempts: 8,
          leaseExpiresAt: 1,
          nextFire: stored.state.nextFire + 60_000,
        },
      };
    });

    await runDurableObjectAlarm(driver);

    expect((await driver.getSchedule("workspace-a", "schedule-a"))?.state).toMatchObject({
      status: "dead",
      runId: "exhausted-delivery",
      attempts: 8,
      failureCode: "callback_failed",
    });
    expect((await testEnv.TEST_HOOKS.read()).events).toEqual([]);
  });

  // These input-gate interruption tests can deadlock vitest-pool-workers during teardown.
  // See https://github.com/cloudflare/workers-sdk/issues/14180.
  it.skip("stops before authorization when revoked during startHook", async () => {
    const events = await revokeWhileDeliveryIsBlocked("revoke-start", "start");
    expect(events).toEqual(["start", "blocked:start"]);
  });

  it.skip("stops before callback when revoked during authorization", async () => {
    const events = await revokeWhileDeliveryIsBlocked("revoke-authorization", "authorization");
    expect(events).toEqual(["start", "authorize", "blocked:authorization"]);
  });

  it.skip("does not persist completion when revoked during callback", async () => {
    const events = await revokeWhileDeliveryIsBlocked("revoke-callback", "callback");
    expect(events).toHaveLength(4);
    expect(events.slice(0, 3)).toEqual(["start", "authorize", expect.stringMatching(/^callback:/)]);
    expect(events[3]).toBe("blocked:callback");
  });

  it("bounds callback concurrency and immediately continues a due backlog", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const driver = testEnv.SCHEDULE_DRIVER.getByName("batching");
    const activationTime = Date.now();
    for (let index = 0; index < 21; index++) {
      await enableSchedule(
        driver,
        {
          workspaceId: "workspace-a",
          scheduleId: `schedule-${index}`,
          spec: { kind: "interval", everyMs: 60_000, anchorMs: activationTime },
          title: `Task ${index}`,
          description: "Test bounded alarm delivery.",
          gadgetId,
        },
        activationTime,
      );
    }
    await runInDurableObject(driver, async (_instance, state) => {
      state.storage.transactionSync(() => {
        for (const [key, stored] of state.storage.kv.list<StoredSchedule>({
          prefix: "schedule:",
        })) {
          if (stored.state.status !== "active") throw new Error("Expected active schedule");
          state.storage.kv.put<StoredSchedule>(key, {
            ...stored,
            state: { ...stored.state, nextFire: 1 },
          });
        }
      });
    });

    await runDurableObjectAlarm(driver);
    await vi.waitFor(async () => {
      const events = (await testEnv.TEST_HOOKS.read()).events;
      expect(events.filter((event) => event.startsWith("callback:"))).toHaveLength(21);
    });
    const delivery = await testEnv.TEST_HOOKS.read();
    expect(delivery.events.filter((event) => event.startsWith("callback:"))).toHaveLength(21);
    expect(delivery.maxActiveCallbacks).toBe(4);
    expect(debug).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "scheduler.alarm.completed",
        dueCount: 21,
        batchSize: 20,
        backlogCount: 1,
        startHookRejectedCount: 0,
      }),
    );
  });

  it("reports startHook rejections only as a batch count", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const driver = testEnv.SCHEDULE_DRIVER.getByName("rejection-count");
    const activationTime = Date.now();
    await testEnv.TEST_HOOKS.configure("start-reject");
    await enableSchedule(
      driver,
      {
        workspaceId: "workspace-a",
        scheduleId: "one-shot",
        spec: { kind: "once", fireAt: activationTime + 60_000, timeZone: "UTC" },
        title: "Rejected task",
        description: "Count opaque admission rejection.",
        gadgetId,
      },
      activationTime,
    );
    await makeActiveScheduleDue(driver, "workspace-a", "one-shot");

    await runDurableObjectAlarm(driver);

    expect(debug).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "scheduler.alarm.completed",
        dueCount: 1,
        batchSize: 1,
        backlogCount: 0,
        startHookRejectedCount: 1,
      }),
    );
  });

  it("uses a pending run's scheduled time in workspace summaries", async () => {
    const driver = testEnv.SCHEDULE_DRIVER.getByName("pending-summary");
    const activationTime = Date.now();
    await enableSchedule(
      driver,
      {
        workspaceId: "workspace-a",
        scheduleId: "one-shot",
        spec: { kind: "once", fireAt: activationTime + 60_000, timeZone: "UTC" },
        title: "Pending task",
        description: "Summarize pending delivery.",
        gadgetId,
      },
      activationTime,
    );
    await updateSchedule(driver, "workspace-a", "one-shot", (stored) => {
      if (stored.state.status !== "active") throw new Error("Expected active schedule");
      return {
        ...stored,
        state: {
          ...stored.state,
          status: "pending",
          stage: "delivery",
          runId: "pending-run",
          scheduledTime: stored.state.nextFire,
          attempts: 1,
          leaseExpiresAt: activationTime + 300_000,
          nextFire: undefined,
        },
      };
    });

    expect(await driver.listWorkspace("workspace-a")).toEqual([
      expect.objectContaining({
        scheduleId: "one-shot",
        status: "active",
        nextFire: activationTime + 60_000,
      }),
    ]);
  });

  it("isolates unexpected failures and settles sibling deliveries", async () => {
    const driver = testEnv.SCHEDULE_DRIVER.getByName("isolated-failure");
    const activationTime = Date.now();
    for (const scheduleId of ["broken", "healthy"]) {
      await enableSchedule(
        driver,
        {
          workspaceId: "workspace-a",
          scheduleId,
          spec: { kind: "interval", everyMs: 60_000, anchorMs: activationTime },
          title: scheduleId,
          description: "Test isolated alarm delivery failures.",
          gadgetId,
        },
        activationTime,
      );
      await makeActiveScheduleDue(driver, "workspace-a", scheduleId);
    }
    await updateSchedule(driver, "workspace-a", "broken", (stored) => ({
      ...stored,
      state: {
        ...stored.state,
        spec: { kind: "interval", everyMs: 0, anchorMs: activationTime },
      },
    }));

    await expect(runDurableObjectAlarm(driver)).resolves.toBe(true);
    await vi.waitFor(async () => {
      const healthy = await driver.getSchedule("workspace-a", "healthy");
      expect(healthy?.state.status === "active" ? healthy.state.nextFire : 0).toBeGreaterThan(
        activationTime,
      );
    });
    expect((await driver.getSchedule("workspace-a", "broken"))?.state.status).toBe("pending");
    expect(
      (await testEnv.TEST_HOOKS.read()).callbackScheduleIds.filter(
        (scheduleId) => scheduleId === "healthy",
      ),
    ).toHaveLength(1);
    expect(reportIssue).toHaveBeenCalledWith(
      "scheduler.delivery",
      expect.anything(),
      expect.objectContaining({
        attributes: expect.objectContaining({
          accountId: expect.any(String),
          operation: "alarm",
          workspaceId: "workspace-a",
          scheduleId: "broken",
          runId: expect.any(String),
        }),
      }),
    );
  });

  it("reports a missing capability record without exposing callback errors", async () => {
    const driver = testEnv.SCHEDULE_DRIVER.getByName("missing-capability");
    const activationTime = Date.now();
    await enableSchedule(
      driver,
      {
        workspaceId: "workspace-a",
        scheduleId: "schedule-a",
        spec: { kind: "interval", everyMs: 60_000, anchorMs: activationTime },
        title: "Missing capability",
        description: "Test infrastructure reporting.",
        gadgetId,
      },
      activationTime,
    );
    await makeActiveScheduleDue(driver, "workspace-a", "schedule-a");
    await runInDurableObject(driver, (_instance, state) =>
      state.storage.kv.delete("caps:workspace-a:schedule-a"),
    );

    await runDurableObjectAlarm(driver);

    expect(reportIssue).toHaveBeenCalledWith(
      "scheduler.capabilities.missing",
      expect.any(Error),
      expect.objectContaining({
        handled: true,
        attributes: expect.objectContaining({
          accountId: expect.any(String),
          workspaceId: "workspace-a",
          scheduleId: "schedule-a",
          runId: expect.any(String),
        }),
      }),
    );
  });

  it("reports and rethrows alarm infrastructure failures", async () => {
    const driver = testEnv.SCHEDULE_DRIVER.getByName("alarm-failure");
    await runInDurableObject(driver, (_instance, state) =>
      state.storage.kv.put("metadata", { schemaVersion: 999, revoked: false }),
    );

    const failure = await runInDurableObject(driver, async (instance) => {
      try {
        await instance.alarm();
        return "did not reject";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });

    expect(failure).toContain("Unsupported scheduler driver metadata");
    expect(reportIssue).toHaveBeenCalledWith(
      "scheduler.alarm",
      expect.any(Error),
      expect.objectContaining({
        attributes: expect.objectContaining({
          accountId: expect.any(String),
          operation: "alarm",
          durationMs: expect.any(Number),
        }),
      }),
    );
  });

  it("does not enable or revoke when the recovery alarm cannot be armed", async () => {
    const activationTime = Date.now();
    const activation = {
      workspaceId: "workspace-a",
      scheduleId: "schedule-a",
      spec: { kind: "interval" as const, everyMs: 60_000, anchorMs: activationTime },
      title: "Alarm ordering",
      description: "Require recovery before durable mutation.",
      gadgetId,
    };
    const enableDriver = testEnv.SCHEDULE_DRIVER.getByName("enable-arm-failure");
    const enableResult = await runInDurableObject(enableDriver, async (instance, state) => {
      vi.spyOn(state.storage, "setAlarm").mockRejectedValueOnce(new Error("alarm unavailable"));
      let message = "did not reject";
      try {
        await instance.enable(activation, testInitiator(instance), activationTime);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      return { message, keys: [...state.storage.kv.list()].map(([key]) => key) };
    });
    expect(enableResult).toEqual({ message: "alarm unavailable", keys: [] });

    const revokeDriver = testEnv.SCHEDULE_DRIVER.getByName("revoke-arm-failure");
    await enableSchedule(revokeDriver, activation, activationTime);
    const revokeResult = await runInDurableObject(revokeDriver, async (instance, state) => {
      vi.spyOn(state.storage, "setAlarm").mockRejectedValueOnce(new Error("alarm unavailable"));
      let message = "did not reject";
      try {
        await instance.revoke();
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      return {
        message,
        metadata: state.storage.kv.get("metadata"),
        scheduleExists: state.storage.kv.get("schedule:workspace-a:schedule-a") !== undefined,
      };
    });
    expect(revokeResult).toEqual({
      message: "alarm unavailable",
      metadata: { schemaVersion: 1, revoked: false },
      scheduleExists: true,
    });
  });

  it("does not replace an existing earlier alarm when enable validation fails", async () => {
    const driver = testEnv.SCHEDULE_DRIVER.getByName("failed-enable-alarm");
    const now = Date.now();
    const earlierAlarm = now + 1_000;

    const result = await runInDurableObject(driver, async (instance, state) => {
      await state.storage.setAlarm(earlierAlarm);
      let message = "did not reject";
      try {
        await instance.enable(
          {
            workspaceId: "workspace-a",
            scheduleId: "invalid",
            spec: { kind: "interval", everyMs: 0, anchorMs: now },
            title: "Invalid task",
            description: "Fail after recovery arming.",
            gadgetId,
          },
          testInitiator(instance),
          now,
        );
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      return { message, alarm: await state.storage.getAlarm() };
    });

    expect(result.message).toContain("positive safe integer");
    expect(result.alarm).toBe(earlierAlarm);
  });

  it("keeps a committed enable when precise alarm replanning fails", async () => {
    const driver = testEnv.SCHEDULE_DRIVER.getByName("best-effort-replan");
    const activationTime = Date.now();
    const result = await runInDurableObject(driver, async (instance, state) => {
      const setAlarm = state.storage.setAlarm.bind(state.storage);
      vi.spyOn(state.storage, "setAlarm")
        .mockImplementationOnce(setAlarm)
        .mockRejectedValueOnce(new Error("precise planning unavailable"));
      await instance.enable(
        {
          workspaceId: "workspace-a",
          scheduleId: "schedule-a",
          spec: { kind: "interval", everyMs: 60_000, anchorMs: activationTime },
          title: "Recoverable task",
          description: "Keep durable state after precise planning fails.",
          gadgetId,
        },
        testInitiator(instance),
        activationTime,
      );
      return state.storage.kv.get("schedule:workspace-a:schedule-a") !== undefined;
    });

    expect(result).toBe(true);
    expect(reportIssue).toHaveBeenCalledWith(
      "scheduler.alarm.plan",
      expect.any(Error),
      expect.objectContaining({
        attributes: expect.objectContaining({
          operation: "enable",
          workspaceId: "workspace-a",
          scheduleId: "schedule-a",
        }),
      }),
    );
  });

  it("counts schedule rows directly across repeated enable and disable", async () => {
    const driver = testEnv.SCHEDULE_DRIVER.getByName("row-lifecycle");
    const activationTime = Date.now();
    const activation = {
      workspaceId: "workspace-a",
      scheduleId: "schedule-a",
      spec: { kind: "interval" as const, everyMs: 60_000, anchorMs: activationTime },
      title: "Counted task",
      description: "Test direct schedule row counting.",
      gadgetId,
    };
    await enableSchedule(driver, activation, activationTime);
    await enableSchedule(driver, activation, activationTime + 1);
    await enableSchedule(
      driver,
      { ...activation, workspaceId: "workspace-b", scheduleId: "schedule-b" },
      activationTime,
    );

    expect(await driver.listWorkspace("workspace-a")).toHaveLength(1);
    expect(await driver.listWorkspace("workspace-b")).toHaveLength(1);
    expect((await driver.listAccount()).schedules).toHaveLength(2);

    await driver.disable("workspace-a", "schedule-a");
    await driver.disable("workspace-a", "schedule-a");
    expect(await driver.listWorkspace("workspace-a")).toEqual([]);
    expect(await driver.listWorkspace("workspace-b")).toHaveLength(1);
    expect((await driver.listAccount()).schedules).toHaveLength(1);
  });

  it("enforces account and workspace quotas from persisted schedule rows", async () => {
    const activationTime = Date.now();
    const activation = {
      workspaceId: "workspace-a",
      scheduleId: "schedule-a",
      spec: { kind: "interval" as const, everyMs: 60_000, anchorMs: activationTime },
      title: "Quota task",
      description: "Test durable quota enforcement.",
      gadgetId,
    };

    const accountDriver = testEnv.SCHEDULE_DRIVER.getByName("account-quota");
    await putScheduleRows(
      accountDriver,
      MAX_ENABLED_SCHEDULES_PER_ACCOUNT,
      (index) => `workspace-${index}`,
      activationTime,
    );
    const accountError = await runInDurableObject(accountDriver, async (instance) => {
      try {
        await instance.enable(activation, testInitiator(instance), activationTime);
        return "did not reject";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });
    expect(accountError).toContain("account");
    expect(reportIssue).not.toHaveBeenCalled();

    const workspaceDriver = testEnv.SCHEDULE_DRIVER.getByName("workspace-quota");
    await putScheduleRows(
      workspaceDriver,
      MAX_ENABLED_SCHEDULES_PER_WORKSPACE,
      () => "workspace-a",
      activationTime,
    );
    const workspaceError = await runInDurableObject(workspaceDriver, async (instance) => {
      try {
        await instance.enable(activation, testInitiator(instance), activationTime);
        return "did not reject";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });
    expect(workspaceError).toContain("workspace");
    expect(reportIssue).not.toHaveBeenCalled();
  });

  it("releases the delivery capability once a schedule reaches a terminal state", async () => {
    const driver = testEnv.SCHEDULE_DRIVER.getByName("terminal-capabilities");
    const activationTime = Date.now();
    await enableSchedule(driver, {
      workspaceId: "workspace-a",
      scheduleId: "one-shot",
      spec: { kind: "once", fireAt: activationTime + 60_000, timeZone: "UTC" },
      title: "Terminal task",
      description: "Releases its capability when it completes.",
      gadgetId,
    }, activationTime);

    const capsKey = "caps:workspace-a:one-shot";
    const before = await runInDurableObject(driver, (_i, state) => state.storage.kv.get(capsKey));
    expect(before).toBeDefined();

    await makeActiveScheduleDue(driver, "workspace-a", "one-shot");
    await runDurableObjectAlarm(driver);

    expect((await driver.getSchedule("workspace-a", "one-shot"))?.state.status).toBe("completed");
    // The schedule can never fire again, so its stored capability must not outlive it.
    const after = await runInDurableObject(driver, (_i, state) => state.storage.kv.get(capsKey));
    expect(after).toBeUndefined();
  });

  it("stores no delivery capability for a schedule that is terminal at enablement", async () => {
    const driver = testEnv.SCHEDULE_DRIVER.getByName("born-terminal-capabilities");
    const activationTime = Date.now();
    await enableSchedule(
      driver,
      {
        workspaceId: "workspace-a",
        scheduleId: "lapsed",
        spec: { kind: "interval", everyMs: 60_000, anchorMs: activationTime },
        // The cutoff precedes the first occurrence, so this recurrence is born expired.
        occurrences: { until: activationTime - 1 },
        title: "Lapsed task",
        description: "Its bound passed before it could run.",
        gadgetId,
      },
      activationTime,
    );

    expect((await driver.getSchedule("workspace-a", "lapsed"))?.state.status).toBe("expired");
    const stored = await runInDurableObject(driver, (_i, state) =>
      state.storage.kv.get("caps:workspace-a:lapsed"),
    );
    expect(stored).toBeUndefined();
  });

  it("permanently fences mutations and cleans revoked storage in bounded alarm passes", async () => {
    const driver = testEnv.SCHEDULE_DRIVER.getByName("revocation");
    const activationTime = Date.now();
    // Seeded through the real enable() path, so each schedule gets its capabilities row too, but
    // in a single Durable Object invocation: this fixture has to exceed the cleanup batch size,
    // and sixty separate round-trips spent most of the default test timeout on their own.
    await runInDurableObject(driver, async (instance) => {
      for (let index = 0; index < 60; index++) {
        await instance.enable(
          {
            workspaceId: "workspace-a",
            scheduleId: `schedule-${index}`,
            spec: { kind: "interval", everyMs: 60_000, anchorMs: activationTime },
            title: `Task ${index}`,
            description: "Test revocation cleanup.",
            gadgetId,
          },
          testInitiator(instance),
          activationTime,
        );
      }
    });

    await driver.revoke();
    await expect(driver.disable("workspace-a", "schedule-0")).resolves.toBeUndefined();
    const staleEnable = await runInDurableObject(driver, async (instance) => {
      try {
        await instance.enable(
          {
            workspaceId: "workspace-a",
            scheduleId: "stale-enable",
            spec: { kind: "interval", everyMs: 60_000, anchorMs: activationTime },
            title: "Stale task",
            description: "Must not recreate a revoked account.",
            gadgetId,
          },
          testInitiator(instance),
          activationTime,
        );
        return "did not reject";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });
    expect(staleEnable).toContain("permanently revoked");
    expect(reportIssue).not.toHaveBeenCalled();

    let keys: string[] = [];
    await vi.waitFor(async () => {
      keys = await runInDurableObject(driver, (_instance, state) =>
        [...state.storage.kv.list()].map(([key]) => key),
      );
      expect(keys).toEqual(["metadata"]);
    });
    expect(keys).toEqual(["metadata"]);
  });
});

async function rejectedMessage(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "did not reject";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
