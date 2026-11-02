import { createObservabilityContext } from "@gadgets/observability/observability-context";

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
  logBytes: number;
  missCostUsd: number;
  modelId: string;
  observerId: string;
  oidCount: number;
  oidPrefix: string;
  operation: string;
  outcome: "ok" | "error" | "usage_limit" | "no_email" | "signups_disabled";
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

/** Ambient observability fields for one Workshop operation. */
export const obsContext = createObservabilityContext<WorkshopObservabilityFields>();

/** Creates a logger restricted to the Workshop backend's field vocabulary. */
export function createWorkshopLogger(component: string) {
  return obsContext.createLogger({ component });
}
