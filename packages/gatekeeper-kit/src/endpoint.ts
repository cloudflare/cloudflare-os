// A per-instance vendor host pasted by an operator needs an anchored allowlist, not just a scheme
// check: Home Assistant's scheme-only check is the shipped gap this closes. mcp-shared's
// MCP-scoped blocklist stays local -- it guards arbitrary untrusted URLs, and re-checks every hop.

import { stripTrailingSlashes } from "@gadgets/workshop-shared/gatekeeper";

/**
 * Normalizes an operator-pasted vendor endpoint, or throws a display-safe error.
 * The host pattern is anchored and tested against the hostname, while a non-default port and the
 * path are preserved. The thrown messages never echo the input.
 */
export function normalizeVendorEndpoint(raw: string, options: {
  /** Neither global nor sticky -- both carry `lastIndex` between calls. */
  hostPattern: RegExp;
  /** Names the endpoint in error messages, e.g. "Marketo REST endpoint". */
  label: string;
  /** Default true. */
  requireHttps?: boolean;
}): string {
  // A `g` or `y` pattern advances `lastIndex` on every match, so the same endpoint would alternate
  // between accepted and refused. A programming error rather than bad input: fail on every call,
  // not on every other one.
  if (options.hostPattern.global || options.hostPattern.sticky) {
    throw new Error(`${options.label} host pattern must not be global or sticky.`);
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${options.label} is not a valid URL.`);
  }

  const allowHttp = options.requireHttps === false;
  if (url.protocol !== "https:" && (!allowHttp || url.protocol !== "http:")) {
    throw new Error(`${options.label} must use ${allowHttp ? "http or https" : "https"}.`);
  }
  if (url.username || url.password) {
    throw new Error(`${options.label} must not include credentials.`);
  }

  const hostPattern = new RegExp(`^(?:${options.hostPattern.source})$`, options.hostPattern.flags);
  if (!hostPattern.test(url.hostname)) {
    throw new Error(`That is not a recognized ${options.label} host.`);
  }

  return `${url.origin}${stripTrailingSlashes(url.pathname)}`;
}
