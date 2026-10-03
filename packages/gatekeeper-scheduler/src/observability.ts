import { createObservabilityContext } from "@gadgets/observability/observability-context";

/** Bounded observability fields emitted by the Scheduler gatekeeper. */
export type SchedulerObservabilityFields = {
  accountId: string;
  workspaceId: string;
  scheduleId: string;
  runId: string;
  operation: string;
  durationMs: number;
  dueCount: number;
  batchSize: number;
  backlogCount: number;
  startHookRejectedCount: number;
  vendorId: string;
};

/** Ambient observability fields for one Scheduler operation. */
export const obsContext = createObservabilityContext<SchedulerObservabilityFields>();
