// How the two MCP gatekeepers' requests reach the kit's upstream client
// (`@gadgets/gatekeeper-kit/upstream`), which counts each one as a subservice call.
//
// The library serves two vendors, so it declares no upstream of its own. Each gatekeeper declares
// one from its vendor id and `MCP_UPSTREAM_OPTIONS`, and hands it over through the `mcpUpstream`
// hook of its account and facet, or as the first argument of `withClient` and `fetchTools`. The
// library sends every request through it with `guardedFetch` as its `fetch`, so one guarded
// request, the redirects it follows included, is one counted attempt, under a name from the closed
// lists below. No name is read from a URL, a host or a tool: a word the server chose never reaches
// a point.

import { isSpecType, type FetchLike } from "@modelcontextprotocol/client";
import type { CallAnswer, Upstream, UpstreamOptions } from "@gadgets/gatekeeper-kit/upstream";

import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  FetchNotStartedError,
  guardedFetch,
  readTextCapped,
  type FetchOptions,
} from "./fetch.js";

/**
 * Symbol-named hook through which a connector's account and facet supply its upstream, so that
 * the upstream is not addressable as an RPC method or property.
 */
export const mcpUpstream = Symbol("mcpUpstream");

/**
 * What an MCP gatekeeper's upstream declares beside its vendor id:
 * `defineUpstream({ vendorId, ...MCP_UPSTREAM_OPTIONS })`.
 *
 * `fetch` is the guard with nothing relaxed, so the upstream as declared reaches nothing the guard
 * refuses; `guardedUpstream` puts the guard under one operation's options in its place. A refusal
 * by the guard is thrown before anything is sent, so it is no attempt: `thrown` leaves it
 * uncounted and the request is not sent again. An attempt the guard's own deadline timer cut off
 * is counted a `timeout`. No redirect mode is declared, because the guard hands `manual` to the
 * platform whatever mode it is given and follows the redirects it has checked itself: a 3xx it
 * answers is one it would not follow, which the upstream's default counts as an error.
 */
export const MCP_UPSTREAM_OPTIONS = {
  fetch: (input, init) => guardedFetch(String(input), init ?? {}),
  thrown: error => {
    if (error instanceof FetchNotStartedError) return null;
    return typeof error === "object" && error !== null && "name" in error
      && error.name === "TimeoutError" ? { outcome: "error", reason: "timeout" } : undefined;
  },
} satisfies Omit<UpstreamOptions, "vendorId">;

/**
 * A gatekeeper's upstream sending through the guard under one operation's options: its
 * development relaxation and its deadline.
 * @param upstream The gatekeeper's upstream.
 * @param options The operation's options, handed to `guardedFetch` with every request.
 * @returns The upstream, summing into the same running tally.
 */
export function guardedUpstream(upstream: Upstream, options: FetchOptions = {}): Upstream {
  return upstream.with({
    fetch: (input, init) => guardedFetch(String(input), init ?? {}, options),
  });
}

/**
 * The signal a request of an operation is sent with, so that the upstream reads the operation's
 * deadline as its caller's wait: an attempt the deadline cut off is counted a `timeout`, and
 * nothing is sent again once it has passed. The guard keeps its own check and timer of the same
 * deadline.
 * @param options The operation's options.
 * @param own A signal the request already has.
 * @returns `own` where the operation has no deadline, else a signal that aborts with a
 * `TimeoutError` at the deadline, or when `own` aborts.
 */
export function deadlineSignal(
  options: FetchOptions, own?: AbortSignal | null,
): AbortSignal | undefined {
  if (options.deadline === undefined) return own ?? undefined;
  const deadline = AbortSignal.timeout(Math.max(0, options.deadline - Date.now()));
  return own ? AbortSignal.any([own, deadline]) : deadline;
}

/**
 * The names of the requests `McpClient` sends: a JSON-RPC request by its method (`rpc.other` for
 * a method outside `rpcOperation`'s table), and the DELETE that ends a transport session.
 */
export const MCP_OPERATIONS = [
  "initialize", "notifications.initialized", "tools.list", "tools.call", "rpc.other",
  "session.close",
] as const;

/** One of `MCP_OPERATIONS`. */
export type McpOperation = typeof MCP_OPERATIONS[number];

// The JSON-RPC methods the client sends. A `Map`, so that no inherited property is a name.
const RPC_OPERATIONS: ReadonlyMap<string, McpOperation> = new Map([
  ["initialize", "initialize"],
  ["notifications/initialized", "notifications.initialized"],
  ["tools/list", "tools.list"],
  ["tools/call", "tools.call"],
]);

/**
 * The name a JSON-RPC request is counted under.
 * @param method The request's JSON-RPC method.
 * @returns The method's name from the closed table, or `rpc.other` for any other method.
 */
export function rpcOperation(method: string): McpOperation {
  return RPC_OPERATIONS.get(method) ?? "rpc.other";
}

/**
 * The names of the requests an OAuth operation makes: the two metadata documents, the client's
 * registration, the three token requests, and `oauth.other` for a request `oauthOperation` does
 * not know.
 */
export const OAUTH_OPERATIONS = [
  "metadata.resource", "metadata.server", "client.register", "token.exchange", "token.refresh",
  "token.revoke", "oauth.other",
] as const;

/** One of `OAUTH_OPERATIONS`. */
export type OAuthOperation = typeof OAUTH_OPERATIONS[number];

// The well-known paths of an authorization server's metadata (RFC 8414, OpenID Connect Discovery).
const OAUTH_METADATA_PATH = "/.well-known/oauth-authorization-server";
const SERVER_METADATA_PATHS = [OAUTH_METADATA_PATH, "/.well-known/openid-configuration"];

/**
 * The name a request of the SDK's OAuth flow is counted under, read from what the protocol fixes
 * and never from a host: the method, the well-known path of a metadata document, and a token
 * request's grant type.
 * @param method The request's HTTP method; GET where none is given.
 * @param url The request's URL.
 * @param body The request's body.
 * @returns `metadata.server` for a GET of an authorization server's well-known metadata and
 * `metadata.resource` for any other GET, which is the protected resource's metadata at its
 * well-known path or at the URL the server's challenge named; `token.exchange` or `token.refresh`
 * for a form POST by its grant type; `client.register` for a POST of a JSON document; and
 * `oauth.other` for anything else. Never throws.
 */
export function oauthOperation(
  method: string | undefined, url: string | URL, body?: unknown,
): OAuthOperation {
  const verb = (method ?? "GET").toUpperCase();
  if (verb === "GET") {
    const path = URL.parse(String(url))?.pathname ?? "";
    return SERVER_METADATA_PATHS.some(known => path.includes(known))
      ? "metadata.server" : "metadata.resource";
  }
  if (verb !== "POST") return "oauth.other";
  if (typeof body === "string") return "client.register";
  if (!(body instanceof URLSearchParams)) return "oauth.other";
  const grant = body.get("grant_type");
  if (grant === "authorization_code") return "token.exchange";
  return grant === "refresh_token" ? "token.refresh" : "oauth.other";
}

// The SDK's own guard of the document it reads from a 2xx answer to a request of each name: the
// schema the SDK parses that answer with, so that the SDK rejects whatever the guard refuses.
// A revocation is answered with no document, and neither is a request `oauthOperation` does not
// know: those have no guard.
function documentGuard(
  operation: OAuthOperation, url: string | URL,
): ((document: unknown) => boolean) | undefined {
  switch (operation) {
    case "token.exchange":
    case "token.refresh":
      return isSpecType.OAuthTokens;
    case "client.register":
      return isSpecType.OAuthClientInformationFull;
    case "metadata.resource":
      return isSpecType.OAuthProtectedResourceMetadata;
    case "metadata.server": {
      // The SDK reads the document under the RFC 8414 path as OAuth metadata, and the one at an
      // OpenID Connect path as a provider's, which has more required members.
      const server = (URL.parse(String(url))?.pathname ?? "").startsWith(OAUTH_METADATA_PATH)
        ? isSpecType.OAuthMetadata : isSpecType.OpenIdProviderDiscoveryMetadata;
      // A server may name any URL for its protected resource's metadata, one whose path holds a
      // well-known path of an authorization server's included, and the SDK reads the resource's
      // document there. The URL does not say which the SDK asked for, so a document is refused
      // only where the SDK would read it as neither.
      return document => server(document) || isSpecType.OAuthProtectedResourceMetadata(document);
    }
    default:
      return undefined;
  }
}

// How a 2xx answer is counted where the SDK reads a document from it, which its status does not
// say: one that is no JSON as the upstream counts an answer that cannot be parsed, and JSON that
// is not the document (an authorization server may refuse a grant with a 200 whose body carries an
// `error`) as an error of the API. Undefined counts the answer by its status. What the SDK makes
// of a document it has read, such as whether the issuer is the one it asked, is not read here.
async function documentAnswer(
  operation: OAuthOperation, url: string | URL, status: number, body: string,
): Promise<CallAnswer | undefined> {
  if (status < 200 || status >= 300) return undefined;
  const reads = documentGuard(operation, url);
  if (!reads) return undefined;
  let document: unknown;
  try {
    // Read as the SDK reads the answer it is handed: by `Response.json`.
    document = await new Response(body).json();
  } catch {
    return { outcome: "error", reason: "parse" };
  }
  try {
    if (reads(document)) return undefined;
  } catch {
    // A guard that throws refuses the document: the SDK's parse of it throws as well.
  }
  return { outcome: "error", reason: "api" };
}

/**
 * Gives SDK OAuth helpers the same redirect and response-size policy as the local MCP transport,
 * with each request sent and counted through the gatekeeper's upstream. A 2xx answer to a token
 * request, a registration or a metadata GET is counted an error where the SDK can read from it no
 * document that it asks for at that URL; the SDK is handed the answer as it came either way.
 * @param upstream The gatekeeper's upstream.
 * @param options The operation's options. Its requests share one deadline: the one given, else
 * `timeoutMs` (30 seconds by default) from this call.
 * @param operation The name of every request, for an operation that makes one kind
 * (`token.refresh`, `token.revoke`). Without it each request is named by `oauthOperation`.
 * @returns The fetch to hand the SDK.
 */
export function sdkFetch(
  upstream: Upstream, options: FetchOptions = {}, operation?: OAuthOperation,
): FetchLike {
  const operationOptions: FetchOptions = {
    ...options,
    deadline: options.deadline
      ?? Date.now() + (options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
  };
  const guarded = guardedUpstream(upstream, operationOptions);
  return async (url, init) => {
    const name = operation ?? oauthOperation(init?.method, url, init?.body);
    const { answered } = await guarded.read(String(url), {
      ...init,
      operation: name,
      // The operation's deadline is the only limit of each of its requests.
      timeoutMs: null,
      // Each is sent once: the SDK reads an answer such as a 502 to a metadata probe as its cue
      // to ask at another URL, which a failure of a second send would take from it.
      retry: null,
      signal: deadlineSignal(operationOptions, init?.signal),
    }, async response => {
      const body = await readTextCapped(response);
      return {
        verdict: await documentAnswer(name, url, response.status, body),
        answered: new Response(body || null, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        }),
      };
    }, ({ verdict }) => verdict);
    return answered;
  };
}
