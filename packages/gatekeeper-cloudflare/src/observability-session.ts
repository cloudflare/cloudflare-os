// The agent-facing read session for one granted observability binding.
//
// Every method funnels through `#observe`, which records the read on the approval queue before
// returning it. That is the capability-audit guarantee for this gatekeeper: a read that reaches the
// agent but not the queue would be an unaudited disclosure, so the wrapper is the invariant worth
// testing rather than any individual method.

import { RpcStub, RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { ApprovalQueue } from "@gadgets/workshop-shared/gatekeeper";
import type { CloudflareObservabilityApi } from "./observability-api.js";
import type {
  CloudflareObservabilityCalculationQuery,
  CloudflareObservabilityCalculationResult,
  CloudflareObservabilityDiscoveryOptions,
  CloudflareObservabilityEventsPage,
  CloudflareObservabilityEventsQuery,
  CloudflareObservabilityFilter,
  CloudflareObservabilityInvocationsPage,
  CloudflareObservabilityInvocationsQuery,
  CloudflareObservabilityKey,
  CloudflareObservabilitySession,
  CloudflareObservabilityStatistics,
  CloudflareObservabilityTrace,
  CloudflareObservabilityTraceOptions,
  CloudflareObservabilityTracesPage,
  CloudflareObservabilityTracesQuery,
  CloudflareObservabilityValue,
  CloudflareObservabilityValueType,
} from "./types.js";

// The approval queue is the security surface for a read, so an entry has to say what was read.
// Field names and operations are the gatekeeper's own grammar and safe to show; filter *values* are
// caller text and stay out, which keeps a queue entry from becoming an exfiltration channel.
const MAX_SUMMARIZED_CONDITIONS = 5;
const MAX_TARGET_LENGTH = 120;

/** A bounded, value-free description of a filter, for an approval-queue entry. */
export function summarizeFilter(filter?: CloudflareObservabilityFilter): string {
  if (!filter) return "none";
  const conditions: string[] = [];
  const pending = [filter];
  let combination = "";
  while (pending.length > 0 && conditions.length <= MAX_SUMMARIZED_CONDITIONS) {
    const current = pending.shift()!;
    if (current.kind === "group") {
      combination = current.filterCombination;
      pending.push(...current.filters);
    } else {
      conditions.push(`${current.key} ${current.operation}`);
    }
  }
  const shown = conditions.slice(0, MAX_SUMMARIZED_CONDITIONS);
  const overflow = conditions.length > shown.length || pending.length > 0;
  return `${shown.join(combination === "or" ? " or " : ", ")}${overflow ? ", ..." : ""}`;
}

@validateRpc()
export class CloudflareObservabilitySessionImpl extends RpcTarget
    implements CloudflareObservabilitySession {
  readonly #api: CloudflareObservabilityApi;
  readonly #queue: RpcStub<ApprovalQueue>;
  readonly #target: string;

  constructor(
    api: CloudflareObservabilityApi,
    queue: RpcStub<ApprovalQueue>,
    target: string,
  ) {
    super();
    this.#api = api;
    this.#queue = queue;
    this.#target = target.slice(0, MAX_TARGET_LENGTH);
  }

  [Symbol.dispose](): void { this.#queue[Symbol.dispose](); }

  #queryDescription(options?: CloudflareObservabilityDiscoveryOptions): string {
    const timeframe = options?.timeframe
      ? `${options.timeframe.from.toISOString()} to ${options.timeframe.to.toISOString()}`
      : "the last hour";
    return `${this.#target}; timeframe ${timeframe}; ` +
      `filter ${summarizeFilter(options?.filter)}; search ${options?.search ? "yes" : "no"}`;
  }

  #resultDescription(
    count: number,
    noun: string,
    statistics?: CloudflareObservabilityStatistics,
  ): string {
    return `returned ${count} ${noun}` +
      (statistics ? `; ${statistics.rowsRead} rows and ${statistics.bytesRead} bytes scanned` : "");
  }

  async #observe<T>(
    title: string,
    options: CloudflareObservabilityDiscoveryOptions | undefined,
    read: () => Promise<T>,
    description: (result: T) => string,
  ): Promise<T> {
    const result = await read();
    await this.#queue.authorizeObservation({
      title,
      description: `${this.#queryDescription(options)}; ${description(result)}.`,
    });
    return result;
  }

  async listKeys(options?: CloudflareObservabilityDiscoveryOptions): Promise<CloudflareObservabilityKey[]> {
    return this.#observe("Discover Workers telemetry fields", options,
      () => this.#api.listKeys(options),
      result => this.#resultDescription(result.length, "fields"));
  }

  async listValues(key: string, type: CloudflareObservabilityValueType,
                   options?: CloudflareObservabilityDiscoveryOptions): Promise<CloudflareObservabilityValue[]> {
    return this.#observe("Discover Workers telemetry values", options,
      () => this.#api.listValues(key, type, options),
      result => this.#resultDescription(result.length, "values"));
  }

  async listEvents(query?: CloudflareObservabilityEventsQuery): Promise<CloudflareObservabilityEventsPage> {
    return this.#observe("Read Workers events", query, () => this.#api.listEvents(query), result =>
      this.#resultDescription(result.events.length, "events", result.statistics));
  }

  async listInvocations(query?: CloudflareObservabilityInvocationsQuery): Promise<CloudflareObservabilityInvocationsPage> {
    return this.#observe("Read Worker invocations", query, () => this.#api.listInvocations(query), result =>
      this.#resultDescription(result.invocations.length, "invocations", result.statistics));
  }

  async listTraces(query?: CloudflareObservabilityTracesQuery): Promise<CloudflareObservabilityTracesPage> {
    return this.#observe("Read Worker traces", query, () => this.#api.listTraces(query), result =>
      this.#resultDescription(result.traces.length, "trace summaries", result.statistics));
  }

  async getTrace(traceId: string, options?: CloudflareObservabilityTraceOptions): Promise<CloudflareObservabilityTrace> {
    return this.#observe("Read Worker trace", options, () => this.#api.getTrace(traceId, options), result =>
      this.#resultDescription(
        result.count, `trace events${result.truncated ? " (truncated)" : ""}`, result.statistics,
      ));
  }

  async calculate(query: CloudflareObservabilityCalculationQuery): Promise<CloudflareObservabilityCalculationResult> {
    return this.#observe("Calculate Workers metrics", query, () => this.#api.calculate(query), result =>
      this.#resultDescription(result.calculations.length, "calculations", result.statistics));
  }
}
