// Validation for user-supplied MCP endpoint URLs, so the SSRF blocklist has one definition. A
// gatekeeper pointed at an administrator-configured URL has no untrusted input to check.

import { fetchOptions, type InsecureEnv } from "./fetch.js";

/** Result of validating a user-supplied endpoint. */
export type EndpointValidation = { ok: true; url: string } | { ok: false; reason: string };

// Hostnames that must never be reachable from a user-supplied endpoint.
//
// This is a literal/suffix check and is deliberately not the security boundary: a Worker cannot
// resolve DNS, so it cannot see through a public hostname that resolves -- or rebinds -- to a
// private address. Enforcement is `global_fetch_strictly_public` (set in each connector's
// wrangler.jsonc), which makes workerd reject reserved IP ranges after resolution, on every request
// and every redirect hop. What this list adds is a legible refusal at connect time, naming the
// problem while the user is still looking at the form they typed the URL into.
const BLOCKED_HOST_PATTERNS = [
  /^localhost$/i,
  /\.localhost$/i,
  /^127\./,
  /^0\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2[0-9]|3[01])\./,
  /^169\.254\./,
  /^\[?::1\]?$/,
  /^\[?f[cd][0-9a-f]{2}:/i,
  /^metadata\./i,
  /\.internal$/i,
];

// Rewrites a hostname into the form the blocklist is written against. `new URL()` accepts several
// spellings of the same address: `http://2130706433/` and `http://0x7f000001/` are both 127.0.0.1,
// and `[::ffff:127.0.0.1]` is its IPv4-mapped IPv6 form. Each becomes dotted-quad.
function normalizeHost(hostname: string): string {
  // `URL` rewrites an IPv4-mapped IPv6 address into hex groups, so `[::ffff:127.0.0.1]` arrives as
  // `[::ffff:7f00:1]` and the dotted-quad spelling is never what we see.
  const mapped = /^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/i.exec(hostname);
  if (mapped) {
    const [high, low] = [parseInt(mapped[1], 16), parseInt(mapped[2], 16)];
    return [high >>> 8, high & 0xff, low >>> 8, low & 0xff].join(".");
  }

  // A bare integer (decimal, hex, or octal) is a valid IPv4 address to most resolvers.
  const asInteger = /^(?:0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)$/.test(hostname)
    ? Number(hostname)
    : NaN;
  if (Number.isInteger(asInteger) && asInteger >= 0 && asInteger <= 0xffffffff) {
    return [24, 16, 8, 0].map(shift => (asInteger >>> shift) & 0xff).join(".");
  }
  return hostname;
}

/**
 * Whether a host must never be fetched on behalf of a user-supplied endpoint. Exported because the
 * endpoint the user typed is not the only URL its server can make us fetch: OAuth discovery follows
 * a `WWW-Authenticate` header and then an issuer, both chosen by the far side.
 */
export function isBlockedHost(hostname: string): boolean {
  const host = normalizeHost(hostname);
  return BLOCKED_HOST_PATTERNS.some(pattern => pattern.test(host));
}

/**
 * Validates and canonicalizes a user-supplied MCP endpoint.
 *
 * Requires HTTPS and rejects private/link-local/metadata hosts. `MCP_ALLOW_INSECURE` disables both
 * checks for local development, allowing HTTP and otherwise-blocked hosts.
 */
export function validateCustomEndpoint(env: InsecureEnv, input: string): EndpointValidation {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, reason: "Enter the MCP server's endpoint URL." };

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: "That is not a valid URL." };
  }

  const insecureAllowed = fetchOptions(env).allowInsecure === true;
  if (url.protocol !== "https:" && !(insecureAllowed && url.protocol === "http:")) {
    return { ok: false, reason: "The endpoint must use https://." };
  }
  if (!insecureAllowed && isBlockedHost(url.hostname)) {
    return { ok: false, reason: "That host is not reachable from Cloudflare OS." };
  }

  // Credentials in the URL would end up in logs and approval prompts.
  if (url.username || url.password) {
    return { ok: false, reason: "Remove the username and password from the URL." };
  }

  url.hash = "";
  return { ok: true, url: url.toString() };
}
