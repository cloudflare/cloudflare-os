/**
 * How a UniFi request failed. Failures cross the account Durable Object's RPC boundary as plain
 * `UnifiFailure` values -- an Error's class doesn't survive RPC -- and become `UnifiError`s again on
 * the side that throws them. Messages are shown to agents and users, so they never carry the API
 * key, and quote the provider only where the provider is describing the caller's own input.
 *
 * Pure: imported by the Node tests.
 */

/**
 * - `auth`: UniFi rejected the API key.
 * - `forbidden`: the key works but can't reach this console or application.
 * - `notFound`: the console, application, or item doesn't exist.
 * - `badRequest`: UniFi rejected the request's content.
 * - `rateLimited`: too many requests to the console.
 * - `unreachable`: the console didn't respond, or couldn't be reached.
 * - `timeout`: the request took too long; it may still have been carried out.
 * - `tls`: the console's certificate isn't trusted (direct connections).
 * - `redirect`: the console URL redirected (direct connections), e.g. to a login page.
 * - `server`: UniFi reported an internal error.
 * - `protocol`: UniFi answered with something this gatekeeper doesn't understand.
 */
export type UnifiErrorKind =
  | "auth" | "forbidden" | "notFound" | "badRequest" | "rateLimited" | "unreachable" | "timeout"
  | "tls" | "redirect" | "server" | "protocol";

/** A failed request, as a value that survives RPC. */
export type UnifiFailure = {
  kind: UnifiErrorKind;
  /** Display-safe explanation. */
  message: string;
  /** HTTP status, when UniFi answered. */
  status?: number;
  /** For `rateLimited`: how long to wait before retrying. */
  retryAfterMs?: number;
};

/** A failed UniFi request. */
export class UnifiError extends Error {
  override name = "UnifiError";
  readonly kind: UnifiErrorKind;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(failure: UnifiFailure) {
    super(failure.message);
    this.kind = failure.kind;
    this.status = failure.status;
    this.retryAfterMs = failure.retryAfterMs;
  }

  /** This error as a value that survives RPC. */
  toFailure(): UnifiFailure {
    return {
      kind: this.kind, message: this.message,
      ...(this.status !== undefined && { status: this.status }),
      ...(this.retryAfterMs !== undefined && { retryAfterMs: this.retryAfterMs }),
    };
  }
}

/**
 * Whether a failure proves UniFi refused the request before acting on it, so retrying it later is
 * safe whatever it was.
 */
export function refusedBeforeDispatch(error: unknown): boolean {
  return error instanceof UnifiError &&
    (error.kind === "auth" || error.kind === "forbidden" || error.kind === "rateLimited" ||
     error.kind === "tls" || error.kind === "redirect");
}

/** Whether a failure proves the request had no effect: the target is gone, or it was invalid. */
export function provablyNoEffect(error: unknown): boolean {
  return error instanceof UnifiError && (error.kind === "notFound" || error.kind === "badRequest");
}

/** The longest provider message quoted back. */
const MAX_PROVIDER_MESSAGE = 300;

/**
 * Classifies an HTTP error response.
 * @param status The response status, not 2xx or 3xx.
 * @param providerMessage The provider's own message, if its body carried one.
 * @param retryAfterMs A parsed `Retry-After`, if any.
 * @returns The failure.
 */
export function classifyHttpFailure(
  status: number, providerMessage: string | undefined, retryAfterMs: number | undefined,
): UnifiFailure {
  const detail = providerMessage ? truncate(providerMessage) : undefined;
  switch (status) {
    case 401:
      return { kind: "auth", status, message: "UniFi didn't accept the API key." };
    case 403:
      return {
        kind: "forbidden", status,
        message: "The UniFi API key can't access this console or application" +
          (detail ? `: ${detail}` : "."),
      };
    case 404:
      return { kind: "notFound", status, message: detail ? `Not found: ${detail}` : "Not found." };
    case 400: case 409: case 422:
      return {
        kind: "badRequest", status,
        message: detail ? `UniFi rejected the request: ${detail}` : "UniFi rejected the request.",
      };
    case 408: case 502: case 503: case 504:
      return {
        kind: "unreachable", status,
        message: "The UniFi console didn't respond; it may be offline or unreachable.",
      };
    case 429: {
      const wait = retryAfterMs ?? parseRetryAfterMessage(providerMessage);
      return {
        kind: "rateLimited", status,
        message: "The UniFi console is getting too many requests" +
          (wait !== undefined ? `; retry in ${Math.max(1, Math.ceil(wait / 1000))} seconds.` : "; retry shortly."),
        ...(wait !== undefined && { retryAfterMs: wait }),
      };
    }
    default:
      return status >= 500
        ? { kind: "server", status, message: `UniFi reported an internal error (status ${status}).` }
        : {
          kind: "badRequest", status,
          message: `UniFi refused the request (status ${status})` + (detail ? `: ${detail}` : "."),
        };
  }
}

/**
 * Classifies an exception thrown by `fetch` itself.
 * @param error What `fetch` threw.
 * @returns The failure.
 */
export function classifyFetchException(error: unknown): UnifiFailure {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  if (name === "TimeoutError" || name === "AbortError") {
    return {
      kind: "timeout",
      message: "The UniFi console took too long to respond. The request may still have been carried out.",
    };
  }
  if (/certificate|tls|ssl|handshake/i.test(message)) {
    return {
      kind: "tls",
      message: "The console's TLS certificate isn't trusted, so the connection was refused. " +
        "Give the console a certificate this deployment trusts, or reach it through a reverse " +
        "proxy or Cloudflare Tunnel that has one.",
    };
  }
  return { kind: "unreachable", message: "Couldn't reach the UniFi console." };
}

/** Parses Site Manager's "rate limit exceeded, retry after 5.372786998s" message. */
export function parseRetryAfterMessage(message: string | undefined): number | undefined {
  const match = message?.match(/retry after (\d+(?:\.\d+)?)s/i);
  return match ? Math.ceil(Number(match[1]) * 1000) : undefined;
}

/** Parses a `Retry-After` header given in seconds. HTTP dates are ignored. */
export function parseRetryAfterHeader(value: string | null): number | undefined {
  if (value === null || !/^\d+(\.\d+)?$/.test(value.trim())) return undefined;
  return Math.ceil(Number(value.trim()) * 1000);
}

function truncate(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= MAX_PROVIDER_MESSAGE ? oneLine : `${oneLine.slice(0, MAX_PROVIDER_MESSAGE - 1)}…`;
}
