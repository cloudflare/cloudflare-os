import { env, waitUntil, type WorkerEntrypoint } from "cloudflare:workers";
import { createLogger } from "./logger.js";
import {
  MAX_ATTRIBUTE_KEYS,
  MAX_STRING_CHARS,
  serializeException,
  type ErrorEventV1,
  type ErrorReporterProps,
  type ErrorReportOptions,
} from "@gadgets/error-reporting";

export {
  MAX_ATTRIBUTE_KEYS,
  MAX_MESSAGE_CHARS,
  MAX_STACK_CHARS,
  MAX_STRING_CHARS,
  type ErrorEventV1,
  type ErrorReporterProps,
  type ErrorReportOptions,
} from "@gadgets/error-reporting";

/** Log fields owned by this module. */
type ErrorReportingLogFields = { failureSite?: string };

const logger = createLogger<ErrorReportingLogFields>({ component: "observability.error-reporting" });

/** Native Workers RPC capability implemented by the private Reporter Worker. */
export interface ErrorReporter extends WorkerEntrypoint<unknown, ErrorReporterProps> {
  report(event: ErrorEventV1): Promise<void>;
}

declare global {
  namespace Cloudflare {
    interface Env {
      /** Optional private error Reporter service binding. */
      ERROR_REPORTER?: Service<ErrorReporter>;
    }
  }
}

type Scalar = string | number | boolean | null;

/** Builds a bounded error event without traversing arbitrary thrown objects. */
function createErrorEvent(
    failureSite: string, caught: unknown, options?: ErrorReportOptions): ErrorEventV1 {
  let truncated = false;
  const mark = () => { truncated = true; };
  const exception = serializeException(caught);
  if (exception.truncated) mark();
  const correlation = normalizeCorrelation(options?.correlation, mark);
  const http = normalizeHttp(options?.http, mark);
  const attributes = normalizeAttributes(options?.attributes, mark);

  return {
    schemaVersion: 1,
    occurrenceId: crypto.randomUUID(),
    occurredAt: new Date().toISOString(),
    failureSite: boundString(failureSite, MAX_STRING_CHARS, mark),
    severity: options?.severity ?? "error",
    handled: options?.handled ?? false,
    exception,
    ...(correlation && { correlation }),
    ...(http && { http }),
    ...(attributes && { attributes }),
    ...(truncated ? { truncated: true } : {}),
  };
}

/**
 * Reports an exception to the private Reporter without allowing reporting failures to affect
 * the caller. A no-op when the optional `ERROR_REPORTER` binding is absent (local dev and
 * deployments without an Issue destination).
 *
 * Unlike recordAnalytics() (which threads ctx/env through every call site), this reads the
 * ambient `env` and `waitUntil` from `cloudflare:workers` so a single line reports from any
 * Worker, DO method, or alarm without plumbing arguments to each capture site.
 *
 * Lifetime: `report()` is dispatched eagerly, so the outbound RPC is in flight before
 * `waitUntil` is consulted. In a stateless Worker `waitUntil` extends the event past the
 * response so the RPC can finish. In a Durable Object `waitUntil` has no effect, but the
 * in-flight RPC is pending I/O that keeps the object alive until it settles. Delivery holds
 * in both contexts; failures are logged at debug rather than swallowed silently.
 *
 * `attributes` records ambient context; spread an observability context's `get()` result and
 * augment it inline when the capture site has additional fields.
 */
export function reportIssue(
    failureSite: string,
    caught: unknown,
    options?: ErrorReportOptions): void {
  try {
    if (!env.ERROR_REPORTER) return;
    const event = createErrorEvent(failureSite, caught, options);
    const dispatch = env.ERROR_REPORTER.report(event);
    waitUntil(dispatch.catch((error) =>
      logger.debug("error report dispatch failed",
        { event: "error_report.dispatch.failed", failureSite, error })));
  } catch (error) {
    // Reporting must never disturb the caller; record the setup failure and move on.
    logger.debug("error report setup failed",
      { event: "error_report.setup.failed", failureSite, error });
  }
}

function normalizeCorrelation(
    correlation: ErrorReportOptions["correlation"],
    mark: () => void): ErrorEventV1["correlation"] | undefined {
  if (!correlation) return undefined;
  const rayId = boundOptionalString(correlation.rayId, mark);
  const requestId = boundOptionalString(correlation.requestId, mark);
  if (rayId === undefined && requestId === undefined) return undefined;
  return {
    ...(rayId !== undefined && { rayId }),
    ...(requestId !== undefined && { requestId }),
  };
}

function normalizeHttp(
    http: ErrorReportOptions["http"],
    mark: () => void): ErrorEventV1["http"] | undefined {
  if (!http) return undefined;
  const method = boundOptionalString(http.method, mark);
  const routeTemplate = boundOptionalString(http.routeTemplate, mark);
  return {
    // Normalize to the two literals; callers cross a JS trust boundary where the union
    // isn't enforced at runtime, so never pass an arbitrary string through.
    kind: http.kind === "server" ? "server" : "client",
    ...(method !== undefined && { method }),
    ...(routeTemplate !== undefined && { routeTemplate }),
    ...(Number.isFinite(http.responseStatusCode) && {
      responseStatusCode: http.responseStatusCode,
    }),
  };
}

function normalizeAttributes(
    attributes: ErrorReportOptions["attributes"],
    mark: () => void): ErrorEventV1["attributes"] | undefined {
  if (!attributes) return undefined;
  const output = Object.create(null) as Record<string, Scalar>;
  let count = 0;
  for (const rawKey of Object.getOwnPropertyNames(attributes)) {
    if (count >= MAX_ATTRIBUTE_KEYS) {
      mark();
      break;
    }
    const value = Object.getOwnPropertyDescriptor(attributes, rawKey)?.value;
    if (!isScalar(value)) {
      mark();
      continue;
    }
    const key = boundString(rawKey, MAX_STRING_CHARS, mark);
    if (Object.hasOwn(output, key)) {
      mark();
      continue;
    }
    output[key] = typeof value === "string"
      ? boundString(value, MAX_STRING_CHARS, mark)
      : value;
    count++;
  }
  return count ? { ...output } : undefined;
}

function isScalar(value: unknown): value is Scalar {
  return value === null
    || typeof value === "string"
    || typeof value === "number"
    || typeof value === "boolean";
}

function boundOptionalString(value: string | undefined, mark: () => void): string | undefined {
  return value === undefined ? undefined : boundString(value, MAX_STRING_CHARS, mark);
}

function boundString(value: string, max: number, mark: () => void): string {
  if (value.length <= max) return value;
  mark();
  return value.slice(0, max);
}
