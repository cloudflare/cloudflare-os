// Pure helpers shared by the registry Durable Object and the public receiver: token minting and
// hashing, request normalization, and the fixed policy limits. Nothing here touches storage or RPC,
// so it is directly unit-testable.

import type { ManagementListOptions, ManagementEndpoint, ManagementEndpointPage } from "./management-types.js";
import type { EndpointStatus, RegisterEndpointOptions, WebhookEvent } from "./types.js";

/** Largest body accepted from a third party; longer bodies are truncated, not rejected. */
export const MAX_BODY_BYTES = 128 * 1024;
/** Largest number of headers forwarded to a callback. */
export const MAX_HEADERS = 64;
/** Longest single header value forwarded to a callback. */
export const MAX_HEADER_VALUE_LENGTH = 1024;
/** Longest sub-path retained after the endpoint's own URL. */
export const MAX_SUBPATH_LENGTH = 256;
/** Largest number of query parameters forwarded to a callback. */
export const MAX_QUERY_PARAMS = 64;
/** Endpoints per workspace and per account. */
export const MAX_ENDPOINTS_PER_WORKSPACE = 50;
export const MAX_ENDPOINTS_PER_ACCOUNT = 200;
/** Delivery records retained per endpoint, newest first. */
export const MAX_RETAINED_DELIVERIES = 50;
/** Deliveries accepted per endpoint per rolling minute before the receiver answers 429. */
export const MAX_DELIVERIES_PER_MINUTE = 60;
/** Attempts per delivery, including the first. */
export const MAX_DELIVERY_ATTEMPTS = 8;
/** Endpoints per management page. */
export const MAX_MANAGEMENT_PAGE = 100;
/** Longest management search string honored. */
export const MAX_MANAGEMENT_QUERY_LENGTH = 200;

export const MAX_TITLE_LENGTH = 200;
export const MAX_DESCRIPTION_LENGTH = 2000;

/** Methods an endpoint may be registered for. */
const ALLOWED_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE", "GET"]);

/**
 * Headers never forwarded to a callback. `authorization` carries this endpoint's own bearer token,
 * and the other two carry ambient credentials the workspace has no business seeing. Service-specific
 * signature headers are deliberately *not* stripped: a gadget verifying `x-hub-signature-256` needs
 * them, and they authenticate the payload rather than granting access.
 */
const STRIPPED_HEADERS = new Set(["authorization", "cookie", "proxy-authorization"]);

/** Domain-separation key for endpoint bearer tokens, mirroring the Workshop's share-key HMAC. */
const TOKEN_HMAC_KEY = new Uint8Array([
  0x77, 0x65, 0x62, 0x68, 0x6f, 0x6f, 0x6b, 0x2d, 0x65, 0x6e, 0x64, 0x70, 0x6f, 0x69, 0x6e, 0x74,
  0x2d, 0x74, 0x6f, 0x6b, 0x65, 0x6e, 0x2d, 0x76, 0x31, 0x2e, 0x67, 0x61, 0x64, 0x67, 0x65, 0x74,
]);

/** Normalized registration input, with every bound already applied. */
export type NormalizedRegistration = {
  title: string;
  description: string;
  methods: string[];
};

/** Applies the registration bounds, rejecting input that cannot be repaired by truncation. */
export function normalizeRegisterOptions(options: RegisterEndpointOptions): NormalizedRegistration {
  const title = typeof options?.title === "string" ? options.title.trim() : "";
  if (!title) throw new TypeError("A webhook endpoint needs a title.");
  const description = typeof options?.description === "string" ? options.description.trim() : "";
  if (!description) throw new TypeError("A webhook endpoint needs a description.");

  let methods = ["POST"];
  if (options.methods !== undefined) {
    if (!Array.isArray(options.methods) || options.methods.length === 0) {
      throw new TypeError("`methods` must be a non-empty array of HTTP methods.");
    }
    const requested = options.methods.map((method) => String(method).toUpperCase());
    for (const method of requested) {
      if (!ALLOWED_METHODS.has(method)) {
        throw new TypeError(`Unsupported webhook method: ${method}`);
      }
    }
    methods = [...new Set(requested)].toSorted();
  }

  return {
    title: title.slice(0, MAX_TITLE_LENGTH),
    description: description.slice(0, MAX_DESCRIPTION_LENGTH),
    methods,
  };
}

/** Base64url without padding, used for both endpoint IDs and tokens. */
function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** Mints a 128-bit public endpoint ID. It appears in URLs and is not a secret. */
export function mintEndpointId(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(16)));
}

/** Mints a 256-bit bearer token. Returned to the caller once and never stored in the clear. */
export function mintToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/**
 * Hashes a raw bearer token for storage and comparison. Only the hash is persisted, so a storage
 * leak does not yield usable tokens.
 */
export async function hashToken(raw: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    TOKEN_HMAC_KEY,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Compares two hex digests without leaking their first differing position through timing. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Extracts the raw bearer token from an `Authorization` header, or null when absent/malformed. */
export function readBearer(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer[ \t]+([A-Za-z0-9._~+/-]+=*)$/.exec(header.trim());
  return match ? match[1] : null;
}

/** Forwarded headers: credentials stripped, count and value length bounded. */
export function sanitizeHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  let count = 0;
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    if (STRIPPED_HEADERS.has(lower)) continue;
    if (count >= MAX_HEADERS) break;
    result[lower] = value.slice(0, MAX_HEADER_VALUE_LENGTH);
    count++;
  }
  return result;
}

/** Forwarded query parameters, bounded in count. Repeated keys keep the last value. */
export function sanitizeQuery(searchParams: URLSearchParams): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of searchParams) {
    if (Object.keys(result).length >= MAX_QUERY_PARAMS && !Object.hasOwn(result, key)) break;
    result[key] = value.slice(0, MAX_HEADER_VALUE_LENGTH);
  }
  return result;
}

/** True when a content type declares JSON, including `+json` structured suffixes. */
export function isJsonContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const essence = contentType.split(";", 1)[0].trim().toLowerCase();
  return essence === "application/json" || essence === "text/json" || essence.endsWith("+json");
}

/** Truncates a body to the byte cap, cutting on a character boundary. */
export function truncateBody(body: string): { body: string; truncated: boolean } {
  const encoded = new TextEncoder().encode(body);
  if (encoded.length <= MAX_BODY_BYTES) return { body, truncated: false };
  // `fatal: false` replaces the partial trailing code point rather than throwing.
  const decoded = new TextDecoder().decode(encoded.subarray(0, MAX_BODY_BYTES));
  return { body: decoded, truncated: true };
}

/** Builds the event a callback receives, applying every forwarding bound. */
export function buildEvent(input: {
  deliveryId: string;
  endpointId: string;
  receivedAt: number;
  attempt: number;
  method: string;
  subPath: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: string;
  truncated: boolean;
}): WebhookEvent {
  const contentType = input.headers["content-type"];
  const event: WebhookEvent = {
    deliveryId: input.deliveryId,
    endpointId: input.endpointId,
    receivedAt: input.receivedAt,
    attempt: input.attempt,
    method: input.method,
    subPath: input.subPath.slice(0, MAX_SUBPATH_LENGTH),
    query: input.query,
    headers: input.headers,
    body: input.body,
  };
  if (contentType !== undefined) event.contentType = contentType;
  if (input.truncated) event.truncated = true;
  // A truncated body is no longer valid JSON, so parsing it would produce a misleading `json`.
  if (!input.truncated && isJsonContentType(contentType)) {
    try {
      event.json = JSON.parse(input.body);
    } catch {
      // Malformed JSON stays available as `body`; the callback decides what to do with it.
    }
  }
  return event;
}

/** Backoff before the given attempt number (1-based), capped at one hour. */
export function retryDelayMs(nextAttempt: number): number {
  const schedule = [30_000, 60_000, 300_000, 900_000, 1_800_000, 3_600_000, 3_600_000];
  return schedule[Math.min(Math.max(nextAttempt - 2, 0), schedule.length - 1)];
}

/** Bounds a management search string the same way the app does. */
export function normalizeManagementQuery(query: string | undefined): string {
  return (query ?? "").trim().slice(0, MAX_MANAGEMENT_QUERY_LENGTH).toLowerCase();
}

/**
 * Filters, sorts, and pages endpoints for the management app. Cursors are the last returned
 * endpoint ID, so a page is weakly consistent if the underlying set changes between requests.
 */
export function paginateManagementEndpoints(
  endpoints: ManagementEndpoint[],
  options?: ManagementListOptions,
): ManagementEndpointPage {
  const query = normalizeManagementQuery(options?.query);
  const statuses = options?.statuses?.length ? new Set<EndpointStatus>(options.statuses) : undefined;
  const filtered = endpoints
    .filter((endpoint) => !statuses || statuses.has(endpoint.status))
    .filter(
      (endpoint) =>
        !query ||
        endpoint.title.toLowerCase().includes(query) ||
        endpoint.description.toLowerCase().includes(query),
    )
    .toSorted(
      (a, b) => b.createdAt - a.createdAt || (a.endpointId < b.endpointId ? -1 : 1),
    );

  const start = options?.cursor
    ? filtered.findIndex((endpoint) => endpoint.endpointId === options.cursor) + 1
    : 0;
  // A cursor whose endpoint disappeared restarts the listing rather than silently returning nothing.
  const from = start > 0 ? start : 0;
  const page = filtered.slice(from, from + MAX_MANAGEMENT_PAGE);
  const next = from + page.length < filtered.length ? page.at(-1)?.endpointId : undefined;
  return next === undefined ? { endpoints: page } : { endpoints: page, cursor: next };
}
