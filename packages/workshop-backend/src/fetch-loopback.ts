// The one place outbound web requests from the workspace's untrusted callers are policed: the
// agent's `webFetch` tool sends every hop through a FetchLoopback, and the workspace decides each
// request in OverseerImpl.authorizeFetch().
//
// SSRF protection is workerd's, as for webFetch (see web-fetch.ts): this entrypoint runs in
// workshop-backend, so its fetch() keeps `global_fetch_strictly_public`.

import { WorkerEntrypoint } from "cloudflare:workers";
import type { GatekeeperCaller } from "./storage-schema/overseer-storage";
import {
  FETCH_REFUSED_HEADER, FETCH_URL_HEADER, WEB_FETCH_ACCEPT, fetchFollowingRedirects,
  validateWebFetchUrl,
} from "./web-fetch";

/** Whose requests a FetchLoopback sends, minted through `ctx.exports.FetchLoopback({props})`. */
export type FetchLoopbackProps = {
  overseerId: string;
  caller: GatekeeperCaller;

  /** The executeCode call the fetcher was minted for, for an agent caller. */
  executionId?: string;
};

/** The fetch policy a workspace applies to its untrusted callers' requests. */
export type FetchPolicy = {
  /** The only hosts reachable, or undefined for any public host. */
  allowedHosts?: string[];

  /** Whether a user may approve a URL the policy refuses. */
  approvals: boolean;
};

/** OverseerImpl.authorizeFetch()'s answer for one request. */
export type FetchAuthorization = {
  allowed: true;

  /** Whether the workspace has observed restricted data, so the request carries no caller headers. */
  restricted: boolean;

  /** Whether a user's approval is what allowed the URL, which then covers its redirects too. */
  approved: boolean;
} | {
  allowed: false;
  message: string;

  /** Whether the user was asked to approve the URL, which ends the agent's turn. */
  approvalRequested?: boolean;
};

const USER_AGENT = "Cloudflare-OS/1.0";

// The caller headers an unrestricted request carries. Anything else, `authorization`, `cookie` and
// `upgrade` included, is dropped: no credentials and no WebSockets.
const FORWARDED_HEADERS = [
  "accept", "accept-language", "range", "if-range", "if-none-match", "if-modified-since",
];

// Headers only this entrypoint may set on a response, so a site can neither fake a refusal nor
// name a final URL.
const RESERVED_HEADER_PREFIX = "cloudflare-os-fetch-";

/**
 * A Fetcher that sends GET and HEAD requests under the workspace's fetch policy, for the caller
 * named in its props. A refused request is answered with a synthetic 403 (405 for the method)
 * whose `Cloudflare-OS-Fetch-Refused` header says why (see sendFetch).
 */
export class FetchLoopback extends WorkerEntrypoint<Cloudflare.Env, FetchLoopbackProps> {
  fetch(request: Request): Promise<Response> {
    let { overseerId, caller, executionId } = this.ctx.props;
    let ns = this.ctx.exports.OverseerDurableObject;
    let overseer = ns.get(ns.idFromString(overseerId));
    return sendFetch(request,
        href => overseer.authorizeFetch(caller, executionId, request.method, href));
  }
}

/**
 * The body of FetchLoopback.fetch(), with the workspace's decision behind `authorize`: checks
 * `request`, asks `authorize` about its URL, and sends a request built from the method, the URL
 * and an allowlist of `request`'s headers.
 */
export async function sendFetch(
    request: Request, authorize: (href: string) => Promise<FetchAuthorization>)
    : Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return refusal(405, "denied", `Only GET and HEAD requests are allowed, not ${request.method}.`);
  }
  let url: URL;
  try {
    url = validateWebFetchUrl(request.url);
  } catch (err) {
    return refusal(403, "denied", errorMessage(err));
  }

  let decision = await authorize(url.href);
  if (!decision.allowed) {
    return refusal(403, decision.approvalRequested ? "approval-requested" : "denied",
                   decision.message);
  }

  // In a restricted workspace a header's value is a channel for the data the policy holds back,
  // and a user's approval names a URL, not what travels with it.
  let headers = new Headers({ "user-agent": USER_AGENT });
  if (decision.restricted) {
    headers.set("accept", WEB_FETCH_ACCEPT);
  } else {
    for (let name of FORWARDED_HEADERS) {
      let value = request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
  }
  let send = (hop: URL) => fetch(hop, { method: request.method, headers, redirect: "manual" });

  // A redirect goes back to the caller, whose next hop comes back here to be checked, except an
  // approved URL's: the site picks those knowing only the URL the user approved.
  let response: Response;
  let finalUrl: URL | undefined;
  if (decision.approved) {
    try {
      ({ response, url: finalUrl } = await fetchFollowingRedirects(url, send));
    } catch (err) {
      return refusal(403, "denied", errorMessage(err));
    }
  } else {
    response = await send(url);
  }

  // Respect the Content-Signal header (https://contentsignals.org/): a site that sets
  // `ai-input=no` does not want its content fed to an AI agent, which any caller may be.
  if (contentSignalDenies(response, "ai-input")) {
    await response.body?.cancel();
    return refusal(403, "denied",
        `The site at ${(finalUrl ?? url).href} sets Content-Signal: ai-input=no, indicating ` +
        `that it does not permit its content to be used as AI input.`);
  }

  response = new Response(response.body, response);
  let reserved = Array.from(response.headers.keys())
      .filter(name => name.startsWith(RESERVED_HEADER_PREFIX));
  for (let name of reserved) response.headers.delete(name);
  if (finalUrl !== undefined) response.headers.set(FETCH_URL_HEADER, finalUrl.href);
  return response;
}

function refusal(status: 403 | 405, reason: "denied" | "approval-requested", message: string)
    : Response {
  let headers = new Headers({
    "content-type": "text/plain; charset=utf-8",
    [FETCH_REFUSED_HEADER]: reason,
  });
  if (status === 405) headers.set("allow", "GET, HEAD");
  return new Response(message, { status, headers });
}

// Whether the Content-Signal response header sets `signal` to "no". The header is a
// comma-separated list of key=value pairs, e.g. `ai-train=yes, search=yes, ai-input=no`.
function contentSignalDenies(response: Response, signal: string): boolean {
  let header = response.headers.get("content-signal");
  if (!header) return false;
  for (let part of header.split(",")) {
    let [key, value] = part.split("=").map(s => s.trim().toLowerCase());
    if (key === signal && value === "no") return true;
  }
  return false;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
