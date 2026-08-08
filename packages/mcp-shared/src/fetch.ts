// Every outbound request this gatekeeper makes on behalf of a connected MCP server.
//
// Validating the URL is not enough: `fetch` follows redirects by default, so a server that passed
// validation can answer 307 and send the next request to a host `validateCustomEndpoint` exists to
// refuse, after every check has run. Redirects are therefore followed here, re-checking each hop,
// with `Authorization` dropped when a hop leaves the original origin. Unconditional rather than
// opt-in, since a caller forgetting to opt in is the failure mode.

import { isBlockedHost } from "./endpoint.js";
import type { FetchLike } from "@modelcontextprotocol/client";

// Enough for the http->https and apex->www hops real deployments use. Discovery already tries
// several candidate URLs, so a longer chain is more likely a loop than a working server.
const MAX_REDIRECTS = 3;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// Set by local development against an MCP server on localhost, which is otherwise refused.
export type FetchOptions = { allowInsecure?: boolean };

// The one environment variable this package reads. Each Worker's own `Env` satisfies it structurally.
export type InsecureEnv = {
  // When `"true"`, permits plain HTTP and private hosts. Local development only.
  MCP_ALLOW_INSECURE?: string;
};

// Reads the local-development escape hatch. One definition, since this switch turns off the SSRF
// checks and copies of it would be copies of that.
export function fetchOptions(env: InsecureEnv): FetchOptions {
  return { allowInsecure: (env.MCP_ALLOW_INSECURE ?? "").toLowerCase() === "true" };
}

// Cap on any single response body this gatekeeper buffers.
//
// Every response here is parsed whole -- JSON-RPC frames and SSE streams alike -- so the body is in
// memory before any higher-level limit can apply. `listTools` bounds the catalog it *keeps*, which
// bounds nothing about what arrives, and a `tools/call` result is not bounded at all: a server
// answering one request with a gigabyte exhausts the Worker.
export const MAX_RESPONSE_BYTES = 1024 * 1024;

// Reads a response body as text, refusing one larger than `maxBytes`.
//
// Refused rather than truncated: half a JSON document does not parse, and a clipped SSE stream can
// lose the very event carrying the response, which would surface as a confusing protocol error
// instead of the size problem it is. The body is cancelled on refusal so the transfer stops rather
// than running to completion unread.
export async function readTextCapped(
  response: Response, maxBytes: number = MAX_RESPONSE_BYTES,
): Promise<string> {
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`The server's response exceeded ${maxBytes} bytes.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

// Gives SDK OAuth helpers the same redirect and response-size policy as the local MCP transport.
export function sdkFetch(options: FetchOptions = {}): FetchLike {
  return async (url, init) => {
    const response = await guardedFetch(String(url), init ?? {}, options);
    const body = await readTextCapped(response);
    return new Response(body || null, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

// Whether a URL may be requested at all. Fails closed: an unparseable URL is refused rather than
// handed to `fetch` to find out.
export function isAllowedUrl(url: string, options: FetchOptions = {}): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (options.allowInsecure) return true;
  if (parsed.protocol !== "https:") return false;
  return !isBlockedHost(parsed.hostname);
}

// Fetches `url`, following redirects manually so each hop is checked.
//
// Throws if the first URL is not allowed; a redirect to a refused host returns the 3xx response
// itself, which every caller already treats as a failure.
export async function guardedFetch(
  url: string, init: RequestInit, options: FetchOptions = {},
): Promise<Response> {
  if (!isAllowedUrl(url, options)) {
    throw new Error(`Refusing to contact ${hostForMessage(url)}.`);
  }

  let current = url;
  let headers = new Headers(init.headers);
  let method = init.method ?? "GET";
  let body = init.body;
  const origin = new URL(url).origin;

  for (let hop = 0; ; hop++) {
    const response = await fetch(current, { ...init, method, body, headers, redirect: "manual" });
    if (!REDIRECT_STATUSES.has(response.status)) return response;

    const location = response.headers.get("Location");
    if (!location || hop >= MAX_REDIRECTS) return response;

    const next = new URL(location, current).toString();
    if (!isAllowedUrl(next, options)) return response;

    const crossOrigin = new URL(next).origin !== origin;
    const becomesGet = response.status === 303
      || (response.status < 307 && method !== "GET" && method !== "HEAD");

    // A 307/308 preserves the request method and body. Following one across origins from an OAuth
    // token endpoint would hand its authorization code, PKCE verifier, refresh token, and client id
    // to a host those credentials were never intended for. Dropping Authorization is not enough:
    // the secrets are in the form body. Return the redirect response rather than changing its
    // semantics to GET or forwarding the body. The same check also covers an unusual GET-with-body.
    if (crossOrigin && body != null && !becomesGet) return response;

    // Credentials and transport sessions are scoped to the origin they were issued for. A
    // cross-origin hop still happens when it can be made without replaying a body, since it may be a
    // legitimate CDN or login host, but it carries neither the bearer nor the origin's MCP session
    // capability.
    if (crossOrigin) {
      headers = new Headers(headers);
      headers.delete("Authorization");
      headers.delete("Mcp-Session-Id");
    }

    // 303 means "fetch the result of this with GET", and browsers downgrade 301/302 on POST too.
    // Replaying the body would resend it to a host that only said "look over there". At the token
    // endpoint that body carries the authorization code, PKCE verifier, and client secret.
    if (becomesGet) {
      method = "GET";
      body = undefined;
      headers = new Headers(headers);
      headers.delete("Content-Type");
      headers.delete("Content-Length");
    }
    current = next;
  }
}

function hostForMessage(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "that address";
  }
}
