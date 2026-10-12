/**
 * The one place that speaks HTTP to UniFi. A request names an application on a console ("network"
 * or "protect") or Site Manager itself; this module turns it into a URL for the connection's mode,
 * attaches the credentials, and classifies the outcome.
 *
 * - **Cloud** connections reach Site Manager at `https://api.ui.com` and each console's local API
 *   through its Cloud Connector, `/v1/connector/consoles/{consoleId}/proxy/{app}/integration/...`.
 *   That is the base URL in UniFi's published Postman collections and in the Network and Protect
 *   OpenAPI servers, and the form of the connector's own `path` parameter examples. Only the
 *   connector's prose examples leave out `/proxy/`.
 * - **Direct** connections reach one console's local API at `{baseUrl}/proxy/{app}/integration/...`,
 *   optionally through Cloudflare Access with a service token.
 *
 * Redirects are never followed, so the key can't be carried to another host; every body is read
 * with a byte cap and every request has a deadline.
 *
 * Pure apart from `fetch`: imported by the Node tests, which pass their own.
 */

import { readBytesCapped, readTextCapped } from "@gadgets/gatekeeper-kit/response-body";
import {
  classifyFetchException, classifyHttpFailure, parseRetryAfterHeader, type UnifiFailure,
} from "./errors";

/** Site Manager's API, which also hosts the Cloud Connector. */
export const SITE_MANAGER_ORIGIN = "https://api.ui.com";

/** A connection's stored credentials. */
export type UnifiCredentials =
  | {
    mode: "cloud";
    /** A Site Manager API key, from unifi.ui.com. */
    apiKey: string;
  }
  | {
    mode: "direct";
    /** The console's origin, plus any path prefix a reverse proxy adds. No trailing slash. */
    baseUrl: string;
    /** An API key created on the console, under Integrations. */
    apiKey: string;
    /** A Cloudflare Access service token, when the console sits behind Access. */
    access?: { clientId: string; clientSecret: string };
  };

/** A UniFi application on a console. */
export type UnifiApp = "network" | "protect";

/** An HTTP method the integration APIs use. */
export type UnifiMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** One request to UniFi. */
export type UnifiRequest = {
  /** Site Manager itself (cloud only), or an application on a console. */
  target: { kind: "siteManager" } | { kind: "app"; app: UnifiApp; consoleId: string };
  method: UnifiMethod;
  /** The API path, e.g. `/v1/sites`. */
  path: string;
  /** Query parameters. */
  query?: Record<string, string>;
  /** A JSON request body. */
  body?: unknown;
  /** Whether to expect a JPEG instead of JSON. */
  accept?: "json" | "jpeg";
};

/** What a request returned. */
export type UnifiResponse =
  | { ok: true; status: number; json: unknown }
  | { ok: true; status: number; bytes: ArrayBuffer; contentType: string }
  | { ok: false; failure: UnifiFailure };

/** The Cloud Connector's own deadline is 25 s, so ours is a little longer. */
export const REQUEST_TIMEOUT_MS = 30_000;
/** The Cloud Connector caps responses at 10 MB; snapshots are well under it. */
export const MAX_BODY_BYTES = 10 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const PATH_PATTERN = /^\/v1(\/[A-Za-z0-9._~:-]+)*$/;

/**
 * The URL a request goes to.
 * @param credentials The connection's credentials.
 * @param request The request.
 * @returns Its absolute URL, query included.
 */
export function requestUrl(credentials: UnifiCredentials, request: UnifiRequest): string {
  // A `.` or `..` segment would be resolved away by URL parsing, climbing out of where the path
  // was built to point.
  if (!PATH_PATTERN.test(request.path) || request.path.split("/").some(s => s === "." || s === "..")) {
    throw new Error(`Not a UniFi API path: ${request.path}`);
  }
  const query = request.query && Object.keys(request.query).length > 0
    ? `?${new URLSearchParams(request.query).toString()}`
    : "";
  if (request.target.kind === "siteManager") {
    if (credentials.mode !== "cloud") throw new Error("Site Manager is only reachable from a cloud connection.");
    return `${SITE_MANAGER_ORIGIN}${request.path}${query}`;
  }
  const appPath = `/proxy/${request.target.app}/integration${request.path}${query}`;
  if (credentials.mode === "direct") return `${credentials.baseUrl}${appPath}`;
  // Host IDs are hex with one colon, which the connector expects as-is.
  if (!/^[A-Za-z0-9:]+$/.test(request.target.consoleId)) throw new Error("Not a UniFi console ID.");
  return `${SITE_MANAGER_ORIGIN}/v1/connector/consoles/${request.target.consoleId}${appPath}`;
}

/** The headers a request carries. */
export function requestHeaders(credentials: UnifiCredentials, request: UnifiRequest): Headers {
  const headers = new Headers({
    "X-API-KEY": credentials.apiKey,
    Accept: request.accept === "jpeg" ? "image/jpeg" : "application/json",
  });
  if (request.body !== undefined) headers.set("Content-Type", "application/json");
  if (credentials.mode === "direct" && credentials.access) {
    headers.set("CF-Access-Client-Id", credentials.access.clientId);
    headers.set("CF-Access-Client-Secret", credentials.access.clientSecret);
  }
  return headers;
}

/**
 * Sends one request. Never throws for a failure UniFi or the network reports; those come back as
 * `{ ok: false }`.
 * @param credentials The connection's credentials.
 * @param request The request.
 * @param fetchImpl `fetch`, replaceable in tests.
 * @returns The outcome.
 */
export async function sendUnifiRequest(
  credentials: UnifiCredentials, request: UnifiRequest, fetchImpl: typeof fetch = fetch,
): Promise<UnifiResponse> {
  const url = requestUrl(credentials, request);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: request.method,
      headers: requestHeaders(credentials, request),
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    return { ok: false, failure: classifyFetchException(error) };
  }

  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined);
    return {
      ok: false,
      failure: {
        kind: "redirect", status: response.status,
        message: credentials.mode === "direct"
          ? "The console URL redirected the request. Check the URL, and if the console is behind " +
            "Cloudflare Access, that the service token is right."
          : `UniFi redirected the request (status ${response.status}).`,
      },
    };
  }

  if (!response.ok) {
    const text = await readTextCapped(response, MAX_ERROR_BODY_BYTES).catch(() => "");
    return {
      ok: false,
      failure: classifyHttpFailure(
        response.status, providerMessage(text), parseRetryAfterHeader(response.headers.get("Retry-After"))),
    };
  }

  try {
    if (request.accept === "jpeg") {
      const bytes = await readBytesCapped(response, MAX_BODY_BYTES);
      return {
        ok: true, status: response.status,
        bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
        contentType: response.headers.get("Content-Type") ?? "image/jpeg",
      };
    }
    const text = await readTextCapped(response, MAX_BODY_BYTES);
    return { ok: true, status: response.status, json: text.trim() === "" ? undefined : JSON.parse(text) };
  } catch (error) {
    return {
      ok: false,
      failure: {
        kind: "protocol", status: response.status,
        message: error instanceof SyntaxError
          ? "UniFi returned a response that isn't valid JSON."
          : "UniFi's response was too large or couldn't be read.",
      },
    };
  }
}

/**
 * The provider's own message from an error body: the Network API's `{message}`, the Cloud
 * Connector's and Site Manager's `{message}`, or Protect's `{error}`.
 */
export function providerMessage(text: string): string | undefined {
  try {
    const body: unknown = JSON.parse(text);
    if (body && typeof body === "object") {
      for (const key of ["message", "error", "description"]) {
        const value = (body as Record<string, unknown>)[key];
        if (typeof value === "string" && value.trim() !== "") return value;
      }
    }
  } catch {
    // Not JSON: an HTML error page or similar, which is not worth quoting.
  }
  return undefined;
}
