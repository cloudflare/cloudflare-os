import { RpcTarget } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { ApprovalQueue, HookInitiator } from "@gadgets/workshop-shared/gatekeeper";
import {
  ScheduleSessionImpl,
  describeScheduleAccount,
  disableScheduleController,
  enableScheduleController,
} from "../src/scheduler.js";
import type { ScheduleActivation } from "../src/schedule-driver.js";
import type { ScheduleSummary, ScheduledTaskHook } from "../src/types.js";

type ScheduleHookTarget = RpcTarget & ScheduledTaskHook;

const callback = new (class extends RpcTarget {
  async onSchedule(): Promise<void> {}
})();

function activeSummary(scheduleId: string): ScheduleSummary {
  return {
    scheduleId,
    title: "Heartbeat",
    description: "Run the heartbeat callback.",
    cadence: { kind: "interval", everyMs: 60_000, anchorMs: 1_000 },
    status: "active",
    nextFire: 61_000,
  };
}

describe("ScheduleSessionImpl", () => {
  it("creates a UUID with the workerd crypto implementation by default", async () => {
    const bindHook = vi.fn(async () => {});
    const controllerFactory = vi.fn(() => ({}));
    const session = new ScheduleSessionImpl({
      accountId: "account-a",
      workspaceId: "workspace-a",
      approvalQueue: { bindHook } as unknown as RpcStub<ApprovalQueue>,
      controllerFactory,
      driver: { listWorkspace: vi.fn(async () => []) },
      now: () => 1_000,
    });

    const scheduleId = await session.every(60_000, callback, {
      title: "Heartbeat",
      description: "Run the heartbeat callback.",
    });

    expect(scheduleId).toMatch(/^[0-9a-f-]{36}$/);
    expect(controllerFactory).toHaveBeenCalledWith(expect.objectContaining({ scheduleId }));
  });

  it("binds a validated controller without writing driver state", async () => {
    const bindHook = vi.fn(async () => {});
    const enable = vi.fn();
    const controllerFactory = vi.fn(() => ({ enable }));
    const driver = {
      listWorkspace: vi.fn(async () => []),
    };
    const session = new ScheduleSessionImpl({
      accountId: "account-a",
      workspaceId: "workspace-a",
      approvalQueue: { bindHook } as unknown as RpcStub<ApprovalQueue>,
      controllerFactory,
      driver,
      now: () => 1_000,
      randomId: () => "schedule-a",
    });

    await expect(
      session.every(60_000, callback, {
        title: " Heartbeat ",
        description: " Run the heartbeat callback. ",
      }),
    ).resolves.toBe("schedule-a");

    expect(controllerFactory).toHaveBeenCalledWith({
      accountId: "account-a",
      workspaceId: "workspace-a",
      scheduleId: "schedule-a",
      spec: { kind: "interval", everyMs: 60_000, anchorMs: 1_000 },
      title: "Heartbeat",
      description: "Run the heartbeat callback.",
    });
    expect(bindHook).toHaveBeenCalledOnce();
    expect(driver.listWorkspace).not.toHaveBeenCalled();
    expect(enable).not.toHaveBeenCalled();
  });

  it("passes a normalized occurrence limit to the hook controller", async () => {
    const controllerFactory = vi.fn(() => ({}));
    const session = new ScheduleSessionImpl({
      accountId: "account-a",
      workspaceId: "workspace-a",
      approvalQueue: { bindHook: vi.fn(async () => {}) } as unknown as RpcStub<ApprovalQueue>,
      controllerFactory,
      driver: { listWorkspace: vi.fn(async () => []) },
      now: () => 1_000,
      randomId: () => "schedule-a",
    });

    await session.every(60_000, callback, {
      title: "Heartbeat",
      description: "Run the heartbeat callback.",
      occurrences: { count: 2 },
    });

    expect(controllerFactory).toHaveBeenCalledWith(
      expect.objectContaining({ occurrences: { count: 2 } }),
    );
  });

  it("resolves a calendar recurrence's until bound against its first occurrence", async () => {
    const controllerFactory = vi.fn(() => ({}));
    const registeredAt = Date.UTC(2026, 7, 2);
    const session = new ScheduleSessionImpl({
      accountId: "account-a",
      workspaceId: "workspace-a",
      approvalQueue: { bindHook: vi.fn(async () => {}) } as unknown as RpcStub<ApprovalQueue>,
      controllerFactory,
      driver: { listWorkspace: vi.fn(async () => []) },
      now: () => registeredAt,
      randomId: () => "schedule-a",
    });
    const rule = { timeZone: "America/New_York", freq: "daily", hour: 9, minute: 0 } as const;
    const options = { title: "Brief", description: "Send the brief." };

    await session.calendarAt(rule, callback, {
      ...options,
      occurrences: { until: Date.UTC(2026, 7, 10) },
    });
    expect(controllerFactory).toHaveBeenCalledWith(
      expect.objectContaining({ occurrences: { until: Date.UTC(2026, 7, 10) } }),
    );

    // A cutoff before the first 9am occurrence would enable a schedule that can never run.
    await expect(
      session.calendarAt(rule, callback, {
        ...options,
        occurrences: { until: registeredAt + 60_000 },
      }),
    ).rejects.toThrow("precedes the first occurrence");
  });

  it("rejects occurrence limits for one-shot schedules", async () => {
    const bindHook = vi.fn(async () => {});
    const controllerFactory = vi.fn(() => ({}));
    const session = new ScheduleSessionImpl({
      accountId: "account-a",
      workspaceId: "workspace-a",
      approvalQueue: { bindHook } as unknown as RpcStub<ApprovalQueue>,
      controllerFactory,
      driver: { listWorkspace: vi.fn(async () => []) },
      now: () => 1_000,
    });

    await expect(
      session.runAt(2_000, callback, {
        title: "Once",
        description: "Run once.",
        occurrences: { count: 2 },
      } as never),
    ).rejects.toThrow("recurring");
    expect(controllerFactory).not.toHaveBeenCalled();
    expect(bindHook).not.toHaveBeenCalled();
  });

  it("authorizes workspace-scoped listing, restricted by nothing, before returning schedules", async () => {
    const authorizeObservation = vi.fn(async () => {});
    const driver = {
      listWorkspace: vi.fn(async () => [activeSummary("schedule-a")]),
    };
    const session = new ScheduleSessionImpl({
      accountId: "account-a",
      workspaceId: "workspace-a",
      approvalQueue: { authorizeObservation } as unknown as RpcStub<ApprovalQueue>,
      controllerFactory: vi.fn(),
      driver,
    });

    await expect(session.list()).resolves.toEqual([activeSummary("schedule-a")]);
    expect(driver.listWorkspace).toHaveBeenCalledWith("workspace-a");
    expect(authorizeObservation).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ subresources: [] }),
    );
  });

  it("does not bind a hook when schedule validation fails", async () => {
    const bindHook = vi.fn(async () => {});
    const controllerFactory = vi.fn();
    const session = new ScheduleSessionImpl({
      accountId: "account-a",
      workspaceId: "workspace-a",
      approvalQueue: { bindHook } as unknown as RpcStub<ApprovalQueue>,
      controllerFactory,
      driver: { listWorkspace: vi.fn(async () => []) },
    });

    expect(() =>
      session.calendarAt({ timeZone: "", freq: "daily", hour: 9, minute: 0 }, callback, {
        title: "Invalid",
        description: "Missing timezone.",
      }),
    ).toThrow("Ask the user");
    expect(controllerFactory).not.toHaveBeenCalled();
    expect(bindHook).not.toHaveBeenCalled();
  });

  it("rejects a control character in the title before binding the hook", async () => {
    const bindHook = vi.fn(async () => {});
    const controllerFactory = vi.fn();
    const session = new ScheduleSessionImpl({
      accountId: "account-a",
      workspaceId: "workspace-a",
      approvalQueue: { bindHook } as unknown as RpcStub<ApprovalQueue>,
      controllerFactory,
      driver: { listWorkspace: vi.fn(async () => []) },
      now: () => 1_000,
    });

    await expect(
      session.every(60_000, callback, {
        title: "Heartbeat\nspoofed detail",
        description: "Run the heartbeat callback.",
      }),
    ).rejects.toThrow("control characters");
    expect(controllerFactory).not.toHaveBeenCalled();
    expect(bindHook).not.toHaveBeenCalled();
  });

  it("does not return schedules when observation authorization rejects", async () => {
    const authorizationError = new Error("authorization rejected");
    const authorizeObservation = vi.fn(async () => {
      throw authorizationError;
    });
    const session = new ScheduleSessionImpl({
      accountId: "account-a",
      workspaceId: "workspace-a",
      approvalQueue: { authorizeObservation } as unknown as RpcStub<ApprovalQueue>,
      controllerFactory: vi.fn(),
      driver: { listWorkspace: vi.fn(async () => [activeSummary("schedule-a")]) },
    });

    await expect(session.list()).rejects.toBe(authorizationError);
  });
});

describe("schedule hook controller", () => {
  it("enables the driver with the controller's activation", async () => {
    const initiator = {} as unknown as Fetcher<HookInitiator<ScheduleHookTarget>>;
    const enable = vi.fn(async (_activation: ScheduleActivation) => {});
    const props = {
      accountId: "account-a",
      workspaceId: "workspace-a",
      scheduleId: "schedule-a",
      spec: { kind: "interval", everyMs: 60_000, anchorMs: 1_000 } as const,
      title: "Heartbeat",
      description: "Run the heartbeat callback.",
    };

    await enableScheduleController(props, initiator, { enable });

    const { accountId: _accountId, ...activation } = props;
    expect(enable).toHaveBeenCalledWith(activation, initiator);
  });

  it("disables only its immutable workspace schedule", async () => {
    const disable = vi.fn(async () => {});

    await disableScheduleController(
      {
        accountId: "account-a",
        workspaceId: "workspace-a",
        scheduleId: "schedule-a",
        spec: { kind: "interval", everyMs: 60_000, anchorMs: 1_000 },
        title: "Heartbeat",
        description: "Run the heartbeat callback.",
      },
      { disable },
    );

    expect(disable).toHaveBeenCalledWith("workspace-a", "schedule-a");
  });
});

describe("Scheduler account", () => {
  it("advertises its ambient session", () => {
    expect(describeScheduleAccount()).toEqual({
      displayName: "Scheduled Tasks",
      avatar: expect.any(Object),
      singleton: { tsType: "ScheduleSession" },
    });
  });
});
