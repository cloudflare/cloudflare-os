import { readTextCapped, ResponseTooLargeError } from "@gadgets/gatekeeper-kit/response-body";
import { obsContext } from "./observability";

const MAX_PROVIDER_ERROR_BYTES = 64 * 1024;
const MAX_PROVIDER_REASONS = 8;
const PROVIDER_CODE_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const logger = obsContext.createLogger({
  component: "gatekeeper.google.api", vendorId: "google",
});

type GoogleProviderDiagnostics = {
  providerCode?: number;
  providerStatus?: string;
  providerReasons?: string[];
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
  ) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeProviderCode(value: unknown): string | undefined {
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

  let diagnostics: GoogleProviderDiagnostics = {};
  if (providerCode !== undefined) diagnostics.providerCode = providerCode;
  if (providerStatus !== undefined) diagnostics.providerStatus = providerStatus;
  if (reasons.size > 0) diagnostics.providerReasons = [...reasons];
  return diagnostics;
}

async function readProviderDiagnostics(
  response: Response, provider: string,
): Promise<GoogleProviderDiagnostics> {
  try {
    let text = await readBoundedText(response, MAX_PROVIDER_ERROR_BYTES, provider);
    return parseProviderDiagnostics(text);
  } catch {
    return {};
  }
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
    let diagnostics = await readProviderDiagnostics(response, provider);
    logger.warn("Google provider request failed", {
      event: "google.api.request.failed", provider, operation, httpStatus: response.status,
      ...diagnostics,
    });
    throw new GoogleApiError(`${provider} ${operation} failed [http=${response.status}]`,
      diagnostics.providerStatus, diagnostics.providerReasons);
  }

  let text = await readBoundedText(response, maxBytes, provider);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${provider} ${operation} returned invalid JSON.`);
  }
}
