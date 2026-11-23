import { readTextCapped, ResponseTooLargeError } from "@gadgets/gatekeeper-kit/response-body";
import { obsContext } from "./observability";

const MAX_PROVIDER_ERROR_BYTES = 64 * 1024;
const MAX_PROVIDER_REASONS = 8;
const PROVIDER_ERROR_READ_TIMEOUT_MS = 2000;
const PROVIDER_CODE_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const logger = obsContext.createLogger({
  component: "gatekeeper.google.api", vendorId: "google",
});

/** Google's own codes for a failed request; never its prose. */
export type GoogleProviderDiagnostics = {
  providerCode?: number;
  providerStatus?: string;
  providerReasons?: string[];
  /**
   * Set only when Google's error body was read to the end and parsed as `{error: {...}}`, so that
   * reasons missing from it are reasons Google didn't give, not ones that were never read.
   */
  providerErrorRead?: true;
};

type GoogleJsonResponseOptions = {
  provider: string;
  operation: string;
  maxBytes: number;
};

/**
 * A failed Google API request, carrying Google's status code, its google.rpc status and the reasons
 * it gave, but none of its response prose.
 */
export class GoogleApiError extends Error {
  constructor(
    message: string,
    readonly providerStatus: string | undefined,
    readonly providerReasons: readonly string[] = [],
    /** Whether Google's error body was read and parsed; see `GoogleProviderDiagnostics`. */
    readonly providerErrorRead: boolean = false,
  ) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `value` when it is shaped like one of Google's machine-readable codes (`invalid_grant`,
 * `rateLimitExceeded`), which is safe to log and to show; prose, or anything else, is undefined.
 */
export function safeProviderCode(value: unknown): string | undefined {
  return typeof value === "string" && PROVIDER_CODE_PATTERN.test(value) ? value : undefined;
}

function addProviderReasons(value: unknown, reasons: Set<string>): void {
  if (!Array.isArray(value)) return;
  for (let entry of value) {
    if (reasons.size >= MAX_PROVIDER_REASONS) return;
    if (!isRecord(entry)) continue;
    let reason = safeProviderCode(entry.reason);
    if (reason !== undefined) reasons.add(reason);
  }
}

function parseProviderDiagnostics(text: string): GoogleProviderDiagnostics {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return {};
  }
  if (!isRecord(payload) || !isRecord(payload.error)) return {};

  let providerError = payload.error;
  let providerCode = typeof providerError.code === "number" &&
      Number.isSafeInteger(providerError.code) ? providerError.code : undefined;
  let providerStatus = safeProviderCode(providerError.status);
  let reasons = new Set<string>();
  addProviderReasons(providerError.errors, reasons);
  addProviderReasons(providerError.details, reasons);

  let diagnostics: GoogleProviderDiagnostics = {providerErrorRead: true};
  if (providerCode !== undefined) diagnostics.providerCode = providerCode;
  if (providerStatus !== undefined) diagnostics.providerStatus = providerStatus;
  if (reasons.size > 0) diagnostics.providerReasons = [...reasons];
  return diagnostics;
}

async function readProviderDiagnostics(
  response: Response, provider: string,
): Promise<GoogleProviderDiagnostics> {
  // Google's error bodies are small and arrive at once. One that never ends must not hold up the
  // failure it belongs to, so the body is cancelled after a short wait. It is cancelled through
  // the reader that holds it, which is what ends a read still waiting on the body in workerd. The
  // read then ends as if the body had, so what arrived before the deadline is not taken for all of
  // it, even when it parses.
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cutOff = false;
  try {
    let reader = response.body?.getReader();
    timer = setTimeout(() => {
      cutOff = true;
      void reader?.cancel().catch(() => undefined);
    }, PROVIDER_ERROR_READ_TIMEOUT_MS);
    let body = reader === undefined ? null : new ReadableStream<Uint8Array>({
      async pull(controller) {
        let { done, value } = await reader.read();
        if (done) controller.close(); else controller.enqueue(value);
      },
      cancel: reason => reader.cancel(reason),
    });
    let text = await readBoundedText(
      new Response(body, { headers: response.headers }), MAX_PROVIDER_ERROR_BYTES, provider);
    return cutOff ? {} : parseProviderDiagnostics(text);
  } catch {
    return {};
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Consume a failed Google response and log it as `google.api.request.failed`, at `level`. Returns
 * Google's status and reason codes, the only parts of its error body that are read: its prose can
 * repeat what the request carried.
 */
export async function reportGoogleRequestFailure(
  response: Response, provider: string, operation: string, level: "warn" | "info" = "warn",
): Promise<GoogleProviderDiagnostics> {
  let diagnostics = await readProviderDiagnostics(response, provider);
  logger[level]("Google provider request failed", {
    event: "google.api.request.failed", provider, operation, httpStatus: response.status,
    ...diagnostics,
  });
  return diagnostics;
}

async function readBoundedText(
  response: Response,
  maxBytes: number,
  provider: string,
): Promise<string> {
  try {
    return await readTextCapped(response, maxBytes);
  } catch (error) {
    if (error instanceof ResponseTooLargeError) {
      throw new Error(`${provider} response exceeded the ${maxBytes}-byte limit.`, { cause: error });
    }
    throw error;
  }
}

/** Read a size-bounded Google JSON response without exposing provider response prose in errors. */
export async function readGoogleJson<T>(
  response: Response,
  options: GoogleJsonResponseOptions,
): Promise<T> {
  let { provider, operation, maxBytes } = options;
  if (!response.ok) {
    let diagnostics = await reportGoogleRequestFailure(response, provider, operation);
    throw new GoogleApiError(`${provider} ${operation} failed [http=${response.status}]`,
      diagnostics.providerStatus, diagnostics.providerReasons,
      diagnostics.providerErrorRead === true);
  }

  let text = await readBoundedText(response, maxBytes, provider);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${provider} ${operation} returned invalid JSON.`);
  }
}
