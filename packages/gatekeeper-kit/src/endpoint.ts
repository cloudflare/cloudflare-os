/** Validation and normalization for operator-supplied provider endpoints. */

import { stripTrailingSlashes } from "@gadgets/workshop-shared/gatekeeper";

/**
 * Normalizes an operator-supplied vendor endpoint. Validation errors are display-safe and never echo
 * the raw input.
 * @param raw Endpoint URL.
 * @param options Host, label, and scheme policy.
 * @returns The origin and normalized path, preserving an explicit port and dropping query and
 * fragment.
 *
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
