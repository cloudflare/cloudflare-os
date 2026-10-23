import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HookInitiator } from "@gadgets/workshop-shared/gatekeeper";
import { reportIssue } from "@gadgets/observability/error-reporting";
import type { ScheduledTaskHook } from "../src/types.js";
import type * as DriverState from "../src/driver-state.js";
import { ScheduleDriver } from "../src/schedule-driver.js";
import type { ScheduleActivation, StoredSchedule } from "../src/schedule-driver.js";

vi.mock("@gadgets/observability/error-reporting", () => ({ reportIssue: vi.fn() }));

// A delivery's lease runs RECOVERY_DELAY_MS past its start (five minutes in production), so
// shrink it here to make the deadline observable in a test. This file's own describe block; the
// main suite keeps the real constant, so its deliveries can never see a lease expire under them
// however slow the machine.
vi.mock("../src/driver-state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof DriverState>();
  return { ...actual, RECOVERY_DELAY_MS: 200 };
});

type ScheduleHookTarget = RpcTarget & ScheduledTaskHook;

type TestHooks = HookInitiator<ScheduleHookTarget> & {
  hangAt(point: "start" | "authorization" | "callback", scheduleId?: string): Promise<void>;
  read(): Promise<{ events: string[] }>;
  waitForDisposals(
    target: { approvalQueues: number; callbacks: number },
    budgetMs: number,
  ): Promise<void>;
  release(): Promise<void>;
  reset(): Promise<void>;
};

const testEnv = env as unknown as {
  SCHEDULE_DRIVER: DurableObjectNamespace<ScheduleDriver>;
  TEST_HOOKS: Fetcher<TestHooks>;
};

const gadgetId = 3;

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

async function makeActiveScheduleDue(
  driver: DurableObjectStub<ScheduleDriver>,
  workspaceId: string,
  scheduleId: string,
): Promise<void> {
  await runInDurableObject(driver, (_instance, state) => {
    const key = `schedule:${workspaceId}:${scheduleId}`;
    const stored = state.storage.kv.get<StoredSchedule>(key);
    if (!stored) throw new Error(`Missing test schedule: ${key}`);
    if (stored.state.status !== "active") throw new Error("Expected active schedule");
    state.storage.kv.put(key, { ...stored, state: { ...stored.state, nextFire: 1 } });
  });
}

/** Polls read() until the events include one matching `pattern`, so a parked stage is provable. */
async function waitForEvent(pattern: RegExp, budgetMs = 2_000): Promise<string> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const event = (await testEnv.TEST_HOOKS.read()).events.find((e) => pattern.test(e));
    if (event !== undefined) return event;
    if (Date.now() >= deadline) throw new Error(`event did not arrive: ${pattern}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function enableDueSchedule(driverName: string): Promise<DurableObjectStub<ScheduleDriver>> {
  const driver = testEnv.SCHEDULE_DRIVER.getByName(driverName);
  const activationTime = Date.now();
  await enableSchedule(
    driver,
    {
      workspaceId: "workspace-a",
      scheduleId: "schedule-a",
      spec: { kind: "interval", everyMs: 60_000, anchorMs: activationTime },
      title: "Hung task",
      description: "Test the delivery lease deadline.",
      gadgetId,
    },
    activationTime,
  );
  await makeActiveScheduleDue(driver, "workspace-a", "schedule-a");
  return driver;
}

describe("ScheduleDriver lease deadlines", () => {
  beforeEach(() => {
    vi.mocked(reportIssue).mockClear();
    return testEnv.TEST_HOOKS.reset();
  });
  afterEach(() => {
    return testEnv.TEST_HOOKS.release();
  });

  it("settles a hung admission at its lease deadline and skips the occurrence", async () => {
    const driver = await enableDueSchedule("lease-admission");
    await testEnv.TEST_HOOKS.hangAt("start");

    // The alarm handler returns once the lease expires and it has fenced the hung delivery.
    expect(await runDurableObjectAlarm(driver)).toBe(true);

    // Admission never resolved, so the run is abandoned like an admission rejection: the
    // occurrence is skipped and the interval goes back to active for its next fire.
    expect((await driver.getSchedule("workspace-a", "schedule-a"))?.state).toMatchObject({
      status: "active",
    });
    expect((await testEnv.TEST_HOOKS.read()).events).toEqual(["start"]);
    expect(reportIssue).toHaveBeenCalledWith(
      "scheduler.delivery.timeout",
      expect.any(Error),
      expect.objectContaining({ handled: true }),
    );

    // The late admission's only observable is producing nothing (the run is fenced), and the
    // parked RPC exposes no completion signal, so settle for one bounded window.
    await testEnv.TEST_HOOKS.release();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await testEnv.TEST_HOOKS.read()).events).toEqual(["start"]);
    expect((await driver.getSchedule("workspace-a", "schedule-a"))?.state).toMatchObject({
      status: "active",
    });
  });

  it("settles a hung callback at its lease deadline, consuming its attempt exactly once", async () => {
    const driver = await enableDueSchedule("lease-callback");
    await testEnv.TEST_HOOKS.hangAt("callback");

    const alarm = runDurableObjectAlarm(driver);
    await waitForEvent(/^callback:/);
    expect(await alarm).toBe(true);

    // The callback never settled, so its attempt is consumed like a callback failure and the
    // schedule retries later; the run is fenced, so the hung call's own late completion can
    // neither complete nor fail it a second time.
    expect((await driver.getSchedule("workspace-a", "schedule-a"))?.state).toMatchObject({
      status: "retrying",
      attempts: 1,
    });
    expect(reportIssue).toHaveBeenCalledWith(
      "scheduler.delivery.timeout",
      expect.any(Error),
      expect.objectContaining({ handled: true }),
    );

    await testEnv.TEST_HOOKS.release();
    // The parked session's capability disposals are the signal that the late settlement ran.
    await testEnv.TEST_HOOKS.waitForDisposals({ approvalQueues: 1, callbacks: 1 }, 2_000);
    expect((await driver.getSchedule("workspace-a", "schedule-a"))?.state).toMatchObject({
      status: "retrying",
      attempts: 1,
    });
    expect((await testEnv.TEST_HOOKS.read()).events.filter((e) => e.startsWith("callback:")))
      .toHaveLength(1);
  });
});
