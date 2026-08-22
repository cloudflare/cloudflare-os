import { DurableObject, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type { ScheduleDriver } from "../src/schedule-driver.js";
import type { ScheduleSummary } from "../src/types.js";

export { default } from "../src/worker.js";
export * from "../src/worker.js";
// Vitest's ctx.exports analyzer does not follow the production barrel re-export.
export { ScheduleAccount, ScheduleVerifier } from "../src/scheduler.js";

type TestExports = {
  ScheduleDriver: DurableObjectNamespace<ScheduleDriver>;
  SchedulerScopeTestFacet: DurableObjectClass<SchedulerScopeTestFacet>;
};

type TestMode = "success" | "start-reject" | "authorization-reject" | "callback-reject";
type BlockPoint = "start" | "authorization" | "callback";

let mode: TestMode = "success";
let events: string[] = [];
let callbackScheduleIds: string[] = [];
let activeCallbacks = 0;
let maxActiveCallbacks = 0;
let disposedApprovalQueues = 0;
let disposedCallbacks = 0;
let blockPoint: BlockPoint | null = null;
let blockedPoint: BlockPoint | null = null;
let callbackBarrier = 1;
let callbackBarrierLimit = 0;

// Holds a callback until `callbackBarrier` of them are in flight, so a test observing peak
// concurrency measures the delivery bound rather than how RPC round-trips happened to interleave.
// It applies only to the first `callbackBarrierLimit` callbacks, which the caller sizes to a whole
// number of full rounds -- a partial round could never reach the barrier, and waiting on a count
// that will arrive keeps this free of any wall-clock assumption.
async function waitForCallbackBarrier(): Promise<void> {
  if (callbackScheduleIds.length > callbackBarrierLimit) return;
  // eslint-disable-next-line no-unmodified-loop-condition -- sibling callbacks mutate this.
  while (activeCallbacks < callbackBarrier) await new Promise((resolve) => setTimeout(resolve, 1));
}

async function pauseIfBlocked(point: BlockPoint): Promise<void> {
  if (blockPoint !== point) return;
  events.push(`blocked:${point}`);
  blockedPoint = point;
  // eslint-disable-next-line no-unmodified-loop-condition -- release() mutates this via RPC.
  while (blockPoint === point) await new Promise((resolve) => setTimeout(resolve, 1));
}

class TestApprovalQueue extends RpcTarget {
  async authorizeObservation(): Promise<void> {
    events.push("authorize");
    await pauseIfBlocked("authorization");
    if (mode === "authorization-reject") throw new Error("authorization rejected");
  }

  [Symbol.dispose](): void {
    disposedApprovalQueues++;
  }
}

class TestCallback extends RpcTarget {
  async onSchedule(firing: { runId: string; scheduleId: string }): Promise<void> {
    events.push(`callback:${firing.runId}`);
    callbackScheduleIds.push(firing.scheduleId);
    activeCallbacks++;
    maxActiveCallbacks = Math.max(maxActiveCallbacks, activeCallbacks);
    try {
      await pauseIfBlocked("callback");
      if (mode === "callback-reject") throw new Error("callback rejected");
      await waitForCallbackBarrier();
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      activeCallbacks--;
    }
  }

  [Symbol.dispose](): void {
    disposedCallbacks++;
  }
}

/** Test-only persistent hook initiator. */
export class TestHooks extends WorkerEntrypoint {
  async startHook(): Promise<{ callback: TestCallback; approvalQueue: TestApprovalQueue }> {
    events.push("start");
    await pauseIfBlocked("start");
    if (mode === "start-reject") throw new Error("opaque admission rejection");
    return { callback: new TestCallback(), approvalQueue: new TestApprovalQueue() };
  }

  configure(nextMode: TestMode): void {
    mode = nextMode;
  }

  blockAt(nextBlockPoint: BlockPoint): void {
    blockPoint = nextBlockPoint;
    blockedPoint = null;
  }

  setCallbackBarrier(size: number, limit: number): void {
    callbackBarrier = size;
    callbackBarrierLimit = limit;
  }

  async waitUntilBlocked(): Promise<void> {
    // eslint-disable-next-line no-unmodified-loop-condition -- pauseIfBlocked() mutates this via RPC.
    while (blockedPoint === null) await new Promise((resolve) => setTimeout(resolve, 1));
  }

  release(): void {
    blockPoint = null;
  }

  read() {
    return {
      events: [...events],
      callbackScheduleIds: [...callbackScheduleIds],
      maxActiveCallbacks,
      disposedApprovalQueues,
      disposedCallbacks,
    };
  }

  reset(): void {
    this.release();
    mode = "success";
    events = [];
    callbackScheduleIds = [];
    activeCallbacks = 0;
    maxActiveCallbacks = 0;
    disposedApprovalQueues = 0;
    disposedCallbacks = 0;
    blockedPoint = null;
    callbackBarrier = 1;
    callbackBarrierLimit = 0;
  }
}

/** Test-only parent used to exercise Scheduler scoping with real workerd facets. */
export class SchedulerScopeTestParent extends DurableObject<Cloudflare.Env> {
  /** Lists one shared account through the inherited scope of a named Scheduler facet. */
  async listThroughFacet(facetName: string, accountId: string): Promise<ScheduleSummary[]> {
    const exports = this.ctx.exports as unknown as TestExports;
    const facet = this.ctx.facets.get<SchedulerScopeTestFacet>(facetName, () => ({
      class: exports.SchedulerScopeTestFacet,
    }));
    return facet.listForAccount(accountId);
  }
}

/** Test-only facet that applies Scheduler's account-driver and inherited-workspace scoping. */
export class SchedulerScopeTestFacet extends DurableObject<Cloudflare.Env> {
  /** Lists the shared account driver through this facet's inherited parent ID. */
  listForAccount(accountId: string): Promise<ScheduleSummary[]> {
    const exports = this.ctx.exports as unknown as TestExports;
    return exports.ScheduleDriver.getByName(accountId).listWorkspace(this.ctx.id.toString());
  }
}
