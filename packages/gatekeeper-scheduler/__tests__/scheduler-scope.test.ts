import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import type { ScheduleDriver, StoredSchedule } from "../src/schedule-driver.js";
import type { ScheduleSummary } from "../src/types.js";

interface SchedulerScopeTestParent {
  listThroughFacet(facetName: string, accountId: string): Promise<ScheduleSummary[]>;
}

const testEnv = env as unknown as {
  SCHEDULE_DRIVER: DurableObjectNamespace<ScheduleDriver>;
  SCHEDULER_SCOPE_TEST_PARENT: DurableObjectNamespace<SchedulerScopeTestParent>;
};

describe("SchedulerGatekeeper facet scope", () => {
  it("isolates parent IDs while sibling facet names inherit the same parent scope", async () => {
    const accountId = "shared-account";
    const parentAId = testEnv.SCHEDULER_SCOPE_TEST_PARENT.idFromName("parent-a");
    const parentBId = testEnv.SCHEDULER_SCOPE_TEST_PARENT.idFromName("parent-b");
    const parentA = testEnv.SCHEDULER_SCOPE_TEST_PARENT.get(parentAId);
    const parentB = testEnv.SCHEDULER_SCOPE_TEST_PARENT.get(parentBId);
    const driver = testEnv.SCHEDULE_DRIVER.getByName(accountId);
    const activationTime = Date.now();

    await runInDurableObject(driver, (_instance, state) => {
      for (const [workspaceId, scheduleId] of [
        [parentAId.toString(), "parent-a-task"],
        [parentBId.toString(), "parent-b-task"],
      ] as const) {
        state.storage.kv.put<StoredSchedule>(`schedule:${workspaceId}:${scheduleId}`, {
          version: 1,
          state: {
            workspaceId,
            scheduleId,
            spec: { kind: "interval", everyMs: 60_000, anchorMs: activationTime },
            status: "active",
            nextFire: activationTime + 60_000,
          },
          title: scheduleId,
          description: "Test inherited facet scope.",
          gadgetId: 3,
        });
      }
    });

    await expect(parentA.listThroughFacet("scheduler-one", accountId)).resolves.toEqual([
      expect.objectContaining({ scheduleId: "parent-a-task" }),
    ]);
    await expect(parentA.listThroughFacet("scheduler-two", accountId)).resolves.toEqual([
      expect.objectContaining({ scheduleId: "parent-a-task" }),
    ]);
    await expect(parentB.listThroughFacet("scheduler-one", accountId)).resolves.toEqual([
      expect.objectContaining({ scheduleId: "parent-b-task" }),
    ]);
  });
});
