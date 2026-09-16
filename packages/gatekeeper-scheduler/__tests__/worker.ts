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
// Bumped by reset(). A capability minted under an earlier generation belongs to a previous test, so
// its disposer, which runs asynchronously and may land after the reset, is not counted.
let generation = 0;
// Relative-ms timeline of hook lifecycle events, reported when a disposal wait fails.
let timelineStart = Date.now();
let timeline: string[] = [];
function mark(label: string): void {
  timeline.push(`${label}@${Date.now() - timelineStart}`);
}

type DisposalCounts = { approvalQueues: number; callbacks: number };

function disposalsReached(target: DisposalCounts): boolean {
  return disposedApprovalQueues >= target.approvalQueues && disposedCallbacks >= target.callbacks;
}

function disposalsExact(target: DisposalCounts): boolean {
  return disposedApprovalQueues === target.approvalQueues && disposedCallbacks === target.callbacks;
}

function describeDisposals(target: DisposalCounts): string {
  return (
    `approvalQueues=${disposedApprovalQueues}/${target.approvalQueues} ` +
    `callbacks=${disposedCallbacks}/${target.callbacks}; timeline: ${timeline.join(" ")}`
  );
}

/** Longest a hook session is held open waiting for the driver to release its capabilities. */
const HOOK_SESSION_HOLD_MS = 5_000;

// workerd runs an RpcTarget's disposer as a task of the execution context that created it (the
// `startHook` RPC session here) and aborts a non-actor context as "hung" as soon as its last pending
// I/O event is gone and the thread goes idle (IoContext::PendingEvent in io-context.c++). The
// capabilities returned from `startHook` are that session's only pending events, so the moment the
// driver releases them the abort is armed and races the disposer task, which still has to take the
// isolate lock; when the abort wins the disposer never runs. A pending timer is a pending event, so
// holding one until both disposers have run keeps the session alive exactly long enough for them.
async function holdSessionUntilDisposed(disposals: Promise<void>[]): Promise<void> {
  let hold: ReturnType<typeof setTimeout> | undefined;
  const capped = new Promise<void>((resolve) => {
    hold = setTimeout(resolve, HOOK_SESSION_HOLD_MS);
  });
  try {
    await Promise.race([Promise.all(disposals), capped]);
  } finally {
    clearTimeout(hold);
  }
}

async function pauseIfBlocked(point: BlockPoint): Promise<void> {
  if (blockPoint !== point) return;
  events.push(`blocked:${point}`);
  blockedPoint = point;
  // eslint-disable-next-line no-unmodified-loop-condition -- release() mutates this via RPC.
  while (blockPoint === point) await new Promise((resolve) => setTimeout(resolve, 1));
}

class TestApprovalQueue extends RpcTarget {
  readonly #generation = generation;
  #markDisposed!: () => void;
  readonly disposed = new Promise<void>((resolve) => {
    this.#markDisposed = resolve;
  });

  async authorizeObservation(): Promise<void> {
    events.push("authorize");
    await pauseIfBlocked("authorization");
    if (mode === "authorization-reject") throw new Error("authorization rejected");
  }

  [Symbol.dispose](): void {
    if (this.#generation === generation) {
      disposedApprovalQueues++;
      mark("dispose-aq");
    }
    this.#markDisposed();
  }
}

class TestCallback extends RpcTarget {
  readonly #generation = generation;
  #markDisposed!: () => void;
  readonly disposed = new Promise<void>((resolve) => {
    this.#markDisposed = resolve;
  });

  async onSchedule(firing: { runId: string; scheduleId: string }): Promise<void> {
    events.push(`callback:${firing.runId}`);
    callbackScheduleIds.push(firing.scheduleId);
    activeCallbacks++;
    maxActiveCallbacks = Math.max(maxActiveCallbacks, activeCallbacks);
    try {
      await pauseIfBlocked("callback");
      if (mode === "callback-reject") throw new Error("callback rejected");
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      activeCallbacks--;
      mark("callback-done");
    }
  }

  [Symbol.dispose](): void {
    if (this.#generation === generation) {
      disposedCallbacks++;
      mark("dispose-cb");
    }
    this.#markDisposed();
  }
}

/** Test-only persistent hook initiator. */
export class TestHooks extends WorkerEntrypoint {
  async startHook(): Promise<{ callback: TestCallback; approvalQueue: TestApprovalQueue }> {
    events.push("start");
    mark("start");
    await pauseIfBlocked("start");
    if (mode === "start-reject") throw new Error("opaque admission rejection");
    const callback = new TestCallback();
    const approvalQueue = new TestApprovalQueue();
    this.ctx.waitUntil(holdSessionUntilDisposed([callback.disposed, approvalQueue.disposed]));
    return { callback, approvalQueue };
  }

  configure(nextMode: TestMode): void {
    mode = nextMode;
  }

  blockAt(nextBlockPoint: BlockPoint): void {
    blockPoint = nextBlockPoint;
    blockedPoint = null;
  }

  async waitUntilBlocked(): Promise<void> {
    // eslint-disable-next-line no-unmodified-loop-condition -- pauseIfBlocked() mutates this via RPC.
    while (blockedPoint === null) await new Promise((resolve) => setTimeout(resolve, 1));
  }

  release(): void {
    blockPoint = null;
  }

  /**
   * Resolves once exactly `target` hook capabilities from this generation have run their
   * server-side disposers; rejects after `budgetMs` without them, or as soon as the counts overshoot,
   * naming the counts reached and the hook timeline either way. Polled in-Worker like
   * `waitUntilBlocked`, so the test awaits one RPC instead of racing a 50ms `vi.waitFor`.
   */
  async waitForDisposals(target: DisposalCounts, budgetMs: number): Promise<void> {
    const deadline = Date.now() + budgetMs;
    while (!disposalsReached(target)) {
      if (Date.now() >= deadline) {
        throw new Error(
          `hook capabilities not disposed within ${budgetMs}ms: ${describeDisposals(target)}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    if (!disposalsExact(target)) {
      throw new Error(`hook capabilities disposed more than once: ${describeDisposals(target)}`);
    }
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
    generation++;
    timelineStart = Date.now();
    timeline = [];
    mode = "success";
    events = [];
    callbackScheduleIds = [];
    activeCallbacks = 0;
    maxActiveCallbacks = 0;
    disposedApprovalQueues = 0;
    disposedCallbacks = 0;
    blockedPoint = null;
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
