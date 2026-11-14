/** Validation and encoding for provider URLs: operator-supplied endpoints, agent-supplied path segments. */

import { stripTrailingSlashes } from "@gadgets/workshop-shared/gatekeeper";

/**
 * Normalizes an operator-supplied vendor endpoint. Validation errors are display-safe and never echo
 * the raw input.
 *
 * This validates one URL; it is not a fetch policy. Following redirects by default can leave the
 * allowlisted host and carry `Authorization` with it, so fetch with `redirect: "manual"`, or
 * re-validate each `Location` and drop origin-scoped headers whenever the origin changes.
 * @param raw Endpoint URL.
 * @param options Host, label, and scheme policy.
 * @returns The origin and normalized path, preserving an explicit port and dropping query and
 * fragment.
 * @example
 * ```ts
 * const endpoint = normalizeVendorEndpoint(String(form.get("endpoint") ?? ""), {
 *   hostPattern: /^[a-z0-9-]+\.mktorest\.com$/,
 *   label: "Marketo REST endpoint",
 * });
 * ```
 */
export function normalizeVendorEndpoint(raw: string, options: {
  /** Neither global nor sticky -- both carry `lastIndex` between calls. */
  hostPattern: RegExp;
  /** Names the endpoint in error messages, e.g. "Marketo REST endpoint". */
  label: string;
  /** Default true. */
  requireHttps?: boolean;
}): string {
  // Stateful regular expressions would alternate between accepting and rejecting the same host.
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

/**
 * Encodes one agent-supplied URL path segment. `encodeURIComponent` leaves `.` and `..` literal,
 * and URL parsing resolves them, so an encoded segment could still climb out of the route prefix
 * it is interpolated into; an empty segment changes the route too. Those three are refused. The
 * provider's own id grammar (length, charset) remains the caller's to check.
 * @param value One path segment, unencoded.
 * @returns The percent-encoded segment.
 * @throws Error naming the refused segment, which is at most two characters.
 * @example
 * ```ts
 * const url = `${API_BASE}/files/${pathSegment(fileId)}`;
 * ```
 */
export function pathSegment(value: string): string {
  if (value === "" || value === "." || value === "..") {
    throw new Error(`Refusing the path segment "${value}": empty and dot segments change the route.`);
  }
  return encodeURIComponent(value);
}

/**
 * Encodes a `/`-separated hierarchical name, such as `group/sub/project`, segment by segment with
 * `pathSegment`, keeping the slashes. A leading, trailing, or doubled slash makes an empty segment,
 * so it is refused along with any `.` or `..` segment.
 * @param value Slash-separated name, unencoded.
 * @returns The encoded segments joined by `/`.
 * @throws Error from `pathSegment` for an empty or dot segment.
 */
export function pathSegments(value: string): string {
  return value.split("/").map(pathSegment).join("/");
}
