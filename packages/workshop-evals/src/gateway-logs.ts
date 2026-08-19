import { z } from "zod";
import type { EvalUsage } from "./task.js";

const MetadataSchema = z.object({
  source: z.string().optional(),
  gadgetId: z.string().optional(),
  chatId: z.number().optional(),
}).loose();

const GatewayLogSchema = z.object({
  id: z.string(),
  success: z.boolean(),
  duration: z.number().finite().nonnegative(),
  tokens_in: z.number().finite().nonnegative(),
  tokens_out: z.number().finite().nonnegative(),
  cost: z.number().finite().nonnegative().nullish(),
  metadata: z.string().optional(),
});

const GatewayLogsResponseSchema = z.object({
  success: z.literal(true),
  result: z.array(GatewayLogSchema),
  result_info: z.object({
    total_count: z.number().int().nonnegative().optional(),
  }).loose(),
});

type GatewayLog = z.infer<typeof GatewayLogSchema>;
type GatewayMetadata = z.infer<typeof MetadataSchema>;

/** Credentials and Gateway identity used for inference and log reads. */
export type GatewayConfig = {
  /** Cloudflare account ID that owns the Gateway. */
  accountId: string;
  /** API token with AI Gateway run and read permissions. */
  apiToken: string;
  /** AI Gateway ID. */
  gatewayId: string;
};

const GatewayEnvironmentSchema = z.object({
  CLOUDFLARE_ACCOUNT_ID: z.string().min(1),
  CLOUDFLARE_API_TOKEN: z.string().min(1),
  WORKSHOP_EVAL_GATEWAY_ID: z.string().min(1).optional(),
});

// Direct mode never routes through the Gateway, but the Workshop still branches on CF_AI_GATEWAY
// being set, so it needs some non-empty value that will not be used.
const UNUSED_GATEWAY_ID = "direct";

/** Parses required live-eval credentials and fails with named environment diagnostics. */
export function parseGatewayEnvironment(environment: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const parsed = GatewayEnvironmentSchema.safeParse(environment);
  if (!parsed.success) {
    throw new Error(`Invalid Workshop eval environment: ${z.prettifyError(parsed.error)}`);
  }
  const gatewayId = parsed.data.WORKSHOP_EVAL_GATEWAY_ID;
  if (gatewayId === undefined && !usesDirectWorkersAi(environment)) {
    throw new Error("WORKSHOP_EVAL_GATEWAY_ID is required unless WORKSHOP_EVAL_WAI_DIRECT is true");
  }
  return {
    accountId: parsed.data.CLOUDFLARE_ACCOUNT_ID,
    apiToken: parsed.data.CLOUDFLARE_API_TOKEN,
    gatewayId: gatewayId ?? UNUSED_GATEWAY_ID,
  };
}

/** Whether a local smoke run should bypass AI Gateway data-plane routing and log collection. */
export function usesDirectWorkersAi(environment: NodeJS.ProcessEnv = process.env): boolean {
  const value = environment.WORKSHOP_EVAL_WAI_DIRECT;
  if (value !== undefined && value !== "true" && value !== "false") {
    throw new Error("WORKSHOP_EVAL_WAI_DIRECT must be true or false when set");
  }
  return value === "true";
}

/** Empty usage marker for an explicitly unobserved local direct-mode request set. */
export function incompleteGatewayUsage(): EvalUsage {
  return {
    complete: false,
    successfulRequests: 0,
    failedRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    durationMs: 0,
    costUsd: 0,
  };
}

/** Exact local filter identifying agent requests for one eval session. */
export type AgentLogFilter = {
  /** Workspace ID emitted as Gateway `gadgetId` metadata. */
  workspaceId: string;
  /** Chat ID emitted by interactive agent calls. */
  chatId: number;
};

/** Bounded eventual-consistency polling controls. */
export type GatewayPollOptions = {
  /** Maximum list attempts. Defaults to eight. */
  attempts?: number;
  /** Delay between attempts. Defaults to two seconds. */
  intervalMs?: number;
  /** Consecutive identical complete snapshots required before settling. Defaults to three. */
  stableAttempts?: number;
  /** Earliest log creation timestamp requested from the API. */
  startDate?: string;
};

type FetchBoundary = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type SleepBoundary = (milliseconds: number) => Promise<void>;

function parseMetadata(log: GatewayLog): GatewayMetadata | undefined {
  if (log.metadata === undefined) return undefined;
  try {
    const parsed = MetadataSchema.safeParse(JSON.parse(log.metadata));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function aggregate(logs: readonly GatewayLog[], settled: boolean): EvalUsage {
  return logs.reduce<EvalUsage>((usage, log) => ({
    complete: usage.complete && log.cost !== undefined && log.cost !== null,
    successfulRequests: usage.successfulRequests + (log.success ? 1 : 0),
    failedRequests: usage.failedRequests + (log.success ? 0 : 1),
    inputTokens: usage.inputTokens + log.tokens_in,
    outputTokens: usage.outputTokens + log.tokens_out,
    totalTokens: usage.totalTokens + log.tokens_in + log.tokens_out,
    durationMs: usage.durationMs + log.duration,
    costUsd: usage.costUsd + (log.cost ?? 0),
  }), { ...incompleteGatewayUsage(), complete: settled && logs.length > 0 });
}

async function listLogPage(
    config: GatewayConfig,
    startDate: string | undefined,
    page: number,
    fetchBoundary: FetchBoundary): Promise<{ logs: GatewayLog[]; totalCount: number | undefined }> {
  const url = new URL(
      `/client/v4/accounts/${encodeURIComponent(config.accountId)}/ai-gateway/gateways/` +
      `${encodeURIComponent(config.gatewayId)}/logs`,
      "https://api.cloudflare.com");
  url.searchParams.set("direction", "desc");
  url.searchParams.set("per_page", "100");
  url.searchParams.set("page", String(page));
  if (startDate !== undefined) url.searchParams.set("start_date", startDate);
  const response = await fetchBoundary(url, {
    headers: { Authorization: `Bearer ${config.apiToken}` },
  });
  if (!response.ok) {
    throw new Error(`AI Gateway log listing failed with HTTP ${response.status}`);
  }
  const parsed = GatewayLogsResponseSchema.safeParse(JSON.parse(await response.text()));
  if (!parsed.success) {
    throw new Error(`AI Gateway returned malformed logs: ${z.prettifyError(parsed.error)}`);
  }
  return { logs: parsed.data.result, totalCount: parsed.data.result_info.total_count };
}

// The API's own page size is not guaranteed to match what was asked for, so the walk ends on an
// empty page or on reaching the reported total -- never on a short page, which would silently
// truncate collection and undercount usage while still reporting it as complete.
const MAX_PAGES = 100;

async function listLogs(
    config: GatewayConfig,
    startDate: string | undefined,
    fetchBoundary: FetchBoundary): Promise<GatewayLog[]> {
  const logs = new Map<string, GatewayLog>();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { logs: entries, totalCount } = await listLogPage(config, startDate, page, fetchBoundary);
    for (const entry of entries) {
      if (!logs.has(entry.id)) logs.set(entry.id, entry);
    }
    if (entries.length === 0) break;
    if (totalCount !== undefined && logs.size >= totalCount) break;
  }
  return [...logs.values()];
}

async function pollLogs(
    config: GatewayConfig,
    matches: (log: GatewayLog, metadata: GatewayMetadata | undefined) => boolean,
    options: GatewayPollOptions,
    fetchBoundary: FetchBoundary,
    sleep: SleepBoundary): Promise<{ logs: GatewayLog[]; settled: boolean }> {
  const attempts = options.attempts ?? 8;
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error("Gateway log polling attempts must be a positive integer");
  }
  const intervalMs = options.intervalMs ?? 2_000;
  const stableAttempts = options.stableAttempts ?? 3;
  if (!Number.isInteger(stableAttempts) || stableAttempts < 1) {
    throw new Error("Gateway stable attempts must be a positive integer");
  }
  let previousFingerprint = "";
  let stableCount = 0;
  let latest: GatewayLog[] = [];
  for (let attempt = 0; attempt < attempts; attempt++) {
    latest = (await listLogs(config, options.startDate, fetchBoundary))
        .filter(log => matches(log, parseMetadata(log)));
    const fingerprint = JSON.stringify(latest.map(log => ({
      id: log.id,
      success: log.success,
      duration: log.duration,
      tokensIn: log.tokens_in,
      tokensOut: log.tokens_out,
      cost: log.cost ?? null,
    })).toSorted((left, right) => left.id.localeCompare(right.id)));
    if (latest.length > 0 && fingerprint === previousFingerprint) stableCount++;
    else stableCount = 0;
    const costsAvailable = latest.every(log => log.cost !== undefined && log.cost !== null);
    if (costsAvailable && stableCount >= stableAttempts) return { logs: latest, settled: true };
    previousFingerprint = fingerprint;
    if (attempt + 1 < attempts) await sleep(intervalMs);
  }
  return { logs: latest, settled: false };
}

/** Polls and aggregates exact chat-agent requests, excluding title and model-binding traffic. */
export async function collectAgentGatewayUsage(
    config: GatewayConfig,
    filter: AgentLogFilter,
    options: GatewayPollOptions = {},
    fetchBoundary: FetchBoundary = fetch,
    sleep: SleepBoundary = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
): Promise<EvalUsage> {
  const { logs, settled } = await pollLogs(config, (log, metadata) =>
    metadata?.source === "chat" &&
    metadata.gadgetId === filter.workspaceId &&
    metadata.chatId === filter.chatId,
  options, fetchBoundary, sleep);
  return aggregate(logs, settled);
}
