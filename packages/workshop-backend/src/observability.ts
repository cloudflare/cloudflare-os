import { createObservabilityContext, type Logger } from "@gadgets/observability/observability-context";

/** Observability fields emitted by the Workshop backend. */
export type WorkshopObservabilityFields = {
  accountId: number;
  actionId: number | string;
  agentName: string;
  autoProvisioned: boolean;
  blueprintId: string;
  cacheLifetimeMs: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  callbackInitiated: boolean;
  chatId: number;
  changeStage: "buffer" | "persist";
  changeIndex: number;
  changeWorkpieceCount: number;
  changeFileCount: number;
  changeEmptyPathCount: number;
  claimedType: string;
  commitCount: number;
  /**
   * Why an idle chat's compaction (chat.cache_warm.compaction) didn't publish its
   * checkpoint: an unsupported model, too few own tokens, a running or starting turn, a turn that
   * didn't end with the model's answer, no valid cut, a request that wouldn't read the cached
   * prompt or would come too late, a failed request, or a change to the chat while it ran.
   */
  compactionSkip: "model" | "small" | "busy" | "unfinished" | "cut" | "mismatch" | "late" |
      "failed" | "changed";
  costUsd: number;
  credentialKind: "workshop" | "cloudflare-access";
  durableObjectId: string;
  durationMs: number;
  eventName: string;
  executionId: string;
  failureCount: number;
  gadgetId: string;
  gatekeeperId: number | string;
  handoffKind: "connect" | "restore";
  hookId: number;
  idleMs: number;
  logBytes: number;
  missCostUsd: number;
  modelId: string;
  observerId: string;
  oidCount: number;
  oidPrefix: string;
  operation: string;
  outcome: "ok" | "error" | "stopped" | "usage_limit" | "no_email" | "signups_disabled";
  ownTokens: number;
  path: string;
  pauseEnd: "turn" | "left" | "revert" | "deleted";
  recordedType: string;
  resourceTitle: string;
  resendCostUsd: number;
  sequence: number;
  size: number;
  status: number;
  statusCode: number;
  statusText: string;
  toolCallId: string;
  toolName: string;
  vendorId: string;
};

/** A logger restricted to the Workshop backend's field vocabulary. */
export type WorkshopLogger = Logger<WorkshopObservabilityFields>;

/** Ambient observability fields for one Workshop operation. */
export const obsContext = createObservabilityContext<WorkshopObservabilityFields>();

/** Creates a logger restricted to the Workshop backend's field vocabulary. */
export function createWorkshopLogger(component: string): WorkshopLogger {
  return obsContext.createLogger({ component });
}
