// Cloudflare Artifacts as this gatekeeper's upstream: the name of each call it makes there, and
// the client every such call is sent through and counted by (`subservice/v1` points under the
// source `gatekeeper.context.api`). A git-backed collection reaches Artifacts two ways: the
// optional `ARTIFACTS` binding, whose methods are counted through `artifactsCall`, and git
// smart-HTTP to the repository's remote, whose requests `artifact-sync.ts` sends through this
// upstream.

import { defineUpstream } from "@gadgets/gatekeeper-kit/upstream";
import { VENDOR_ID } from "./context-types.js";

/**
 * The methods of the Artifacts binding this gatekeeper calls, each by the name it is counted
 * under: `repos.*` are the binding's own, `tokens.*` those of a repository's handle.
 */
export const ARTIFACTS_OPERATIONS = [
  "repos.create", "repos.get", "repos.delete", "tokens.create", "tokens.list", "tokens.revoke",
] as const;

/** The name of one call to the Artifacts binding: a member of `ARTIFACTS_OPERATIONS`. */
export type ArtifactsOperation = (typeof ARTIFACTS_OPERATIONS)[number];

/**
 * The git smart-HTTP requests this gatekeeper sends to a repository's remote, each by the name it
 * is counted under: the advertisement of its refs, and the endpoint that lists refs and serves a
 * pack. The gatekeeper only reads a remote, so it sends nothing to the receiving endpoint.
 */
export const GIT_OPERATIONS = ["git.info-refs", "git.upload-pack"] as const;

/** The name of one git smart-HTTP request: a member of `GIT_OPERATIONS`. */
export type GitOperation = (typeof GIT_OPERATIONS)[number];

/** The name of every call this gatekeeper makes to Artifacts. */
export const CONTEXT_OPERATIONS = [...ARTIFACTS_OPERATIONS, ...GIT_OPERATIONS] as const;

/** A name of `CONTEXT_OPERATIONS`. */
export type ContextOperation = (typeof CONTEXT_OPERATIONS)[number];

/**
 * Names a git smart-HTTP request by the endpoint its path ends with, whatever remote and
 * repository the path leads to: nothing of the URL is part of a name.
 * @param method The HTTP method, in upper case.
 * @param url The request's URL.
 * @returns The name, or undefined for a request that is none of `GIT_OPERATIONS`, which is
 * counted under its method.
 */
export function gitOperation(method: string, url: URL): GitOperation | undefined {
  if (method === "GET" && url.pathname.endsWith("/info/refs")) return "git.info-refs";
  if (method === "POST" && url.pathname.endsWith("/git-upload-pack")) return "git.upload-pack";
  return undefined;
}

/**
 * Artifacts, as this gatekeeper calls it. Every call is counted under the source
 * `gatekeeper.context.api` and the service `context`. A git request has the defaults of
 * `Upstream`: 30 seconds an attempt, a GET sent again after a 429, 502, 503 or 504, a network
 * failure or a timeout, and no redirect followed. A clone and a fetch differ in one thing: their
 * requests have no timeout (`artifact-sync.ts`). The endpoint that lists refs and serves a pack
 * takes a POST, which is sent once. A list of refs is read inside its request, an advertisement
 * included: one that is cut off fails the request and is counted an error, with the reason
 * `timeout` where the timeout of its attempt cut it off and `parse` otherwise, and only an
 * advertisement that timed out is sent again. A call to the binding is made once and has no
 * timeout.
 */
export const contextUpstream = defineUpstream({
  vendorId: VENDOR_ID,
  operation: gitOperation,
  // isomorphic-git reads only a 200 of git's endpoints, and fails on any other status, a 2xx too.
  succeeded: (status, operation) =>
    (GIT_OPERATIONS as readonly string[]).includes(operation) ? status === 200 : undefined,
});

/**
 * Makes one call to the Artifacts binding, or to a repository's handle, and counts it.
 * @param operation The method's name.
 * @param work Makes the call.
 * @returns What the call returned; what it threw propagates.
 */
export function artifactsCall<T>(operation: ArtifactsOperation, work: () => T | Promise<T>): Promise<T> {
  return contextUpstream.call(operation, work);
}
