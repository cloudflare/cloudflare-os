import {
  normalizeFrontendErrorReport,
  type FrontendErrorReportV1,
} from "@gadgets/error-reporting";
import type { ErrorEventV1, ErrorReporter } from "@gadgets/backend-utils/error-reporting";
import { createLogger } from "@gadgets/backend-utils/logger";
import type { JWTPayload } from "jose";
import {
  accessRateLimitKey,
  verifyCfAccessJwt,
  type CfAccessEnv,
} from "./access.js";

// The bounded string fields can expand when encoded as UTF-8 or JSON escapes.
const MAX_BODY_BYTES = 128 * 1024;

type ClientErrorLogFields = { failureSite?: string };
const logger = createLogger<ClientErrorLogFields>({ component: "workshop.client-errors" });

/** Optional bindings needed to forward browser reports. */
export type ClientErrorEnv = Readonly<{
  FRONTEND_ERROR_REPORTER?: Pick<ErrorReporter, "report">;
  FRONTEND_ERROR_RATE_LIMITER?: Pick<RateLimit, "limit">;
}> & CfAccessEnv;

type WaitUntilContext = Pick<ExecutionContext, "waitUntil">;
type AccessVerifier = (
  request: Request,
  env: CfAccessEnv,
) => Promise<JWTPayload | null>;

async function readBoundedJson(request: Request): Promise<unknown | "too-large" | "invalid"> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) return "too-large";
  if (!request.body) return "invalid";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) {
        await reader.cancel();
        return "too-large";
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return "invalid";
  } finally {
    reader.releaseLock();
  }
}

function toReporterEvent(report: FrontendErrorReportV1): ErrorEventV1 {
  const attributes: Record<string, string | boolean> = {
    captureMechanism: report.captureMechanism,
    surface: report.surface,
    ...(report.sessionId && { sessionId: report.sessionId }),
    ...(report.pageLocation && { pageLocation: report.pageLocation }),
    ...(report.reportedUserId && { reportedUserId: report.reportedUserId }),
    ...(report.gadgetId && { gadgetId: report.gadgetId }),
    ...(report.gatekeeperVendorId && { gatekeeperVendorId: report.gatekeeperVendorId }),
    ...(report.browser?.family && { browserFamily: report.browser.family }),
    ...(report.browser?.platform && { browserPlatform: report.browser.platform }),
    ...(report.browser?.mobile !== undefined && { browserMobile: report.browser.mobile }),
  };
  return {
    schemaVersion: 1,
    occurrenceId: crypto.randomUUID(),
    occurredAt: new Date().toISOString(),
    failureSite: report.failureSite,
    severity: report.severity,
    handled: report.handled,
    ...(report.exception && { exception: report.exception }),
    attributes,
    ...(report.truncated && { truncated: true }),
  };
}

/** Handles the non-RPC browser-report endpoint. Reporting failures never affect the UI response. */
export async function handleClientErrorRequest(
    request: Request,
    env: ClientErrorEnv,
    ctx: WaitUntilContext,
    verifyAccess: AccessVerifier = verifyCfAccessJwt): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
  }
  const url = new URL(request.url);
  if (request.headers.get("origin") !== url.origin) {
    return new Response("Cross-origin API access not allowed.", { status: 403 });
  }
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    return new Response("Expected application/json.", { status: 415 });
  }

  const reporter = env.FRONTEND_ERROR_REPORTER;
  const limiter = env.FRONTEND_ERROR_RATE_LIMITER;
  if (!reporter || !limiter) return new Response(null, { status: 204 });

  try {
    let key: string;
    if (env.CF_ACCESS_AUD) {
      const payload = await verifyAccess(request, env);
      if (!payload) return new Response("Invalid CF access JWT.", { status: 403 });
      const accessKey = await accessRateLimitKey(payload);
      if (!accessKey) {
        return new Response("Access JWT didn't specify a user identity.", { status: 403 });
      }
      key = accessKey;
    } else {
      key = request.headers.get("cf-connecting-ip") ?? "unknown";
    }
    const outcome = await limiter.limit({ key });
    if (!outcome.success) return new Response(null, { status: 204 });
  } catch (error) {
    logger.debug("frontend error report rate limit failed", {
      event: "frontend_error_report.rate_limit.failed", error,
    });
    return new Response(null, { status: 204 });
  }

  const input = await readBoundedJson(request);
  if (input === "too-large") return new Response("Payload Too Large", { status: 413 });
  if (input === "invalid") return new Response("Invalid JSON", { status: 400 });
  const report = normalizeFrontendErrorReport(input);
  if (!report) return new Response("Invalid frontend error report", { status: 400 });

  try {
    const dispatch = reporter.report(toReporterEvent(report));
    ctx.waitUntil(dispatch.catch((error) => {
      logger.debug("frontend error report dispatch failed", {
        event: "frontend_error_report.dispatch.failed", failureSite: report.failureSite, error,
      });
    }));
  } catch (error) {
    logger.debug("frontend error report setup failed", {
      event: "frontend_error_report.setup.failed", failureSite: report.failureSite, error,
    });
  }
  return new Response(null, { status: 204 });
}
