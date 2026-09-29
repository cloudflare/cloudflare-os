// The JSON-RPC endpoint an open sidecar page talks to: one message in, one reply out.
//
// It is pure on purpose -- no Durable Object, no storage, no environment -- so the whole of the
// policy an app is subject to is in this file and can be exercised without a Worker. The policy
// exists because a sidecar window has no approval queue: anything a person would have had to approve
// in the chat is refused here with a sentence telling them to ask the agent, and what gets refused
// is decided by this binding's own classification, never by anything the app or the server can
// influence. An app therefore never gets a write, never gets a tool outside the grant, and never
// gets a tool the server reserved for the agent.
//
// Nothing thrown below is allowed to leave: every failure, including one this deployment caused, is
// framed as a JSON-RPC error the app can read.

import {
  APP_ERROR_NOT_PERMITTED,
  clampAppResult,
  isUiUri,
  toolVisibleToApp,
  type AppRpcReply,
} from "./apps.js";
import { isValidToolName, type McpClient } from "./client.js";
import type { WithClientOptions } from "./connection.js";
import type { ClassifiedTool } from "./tools.js";
import { safeServerText } from "./util.js";

/** What the app gateway needs from the binding it is answering for. */
export interface AppGatewayHost {
  /**
   * The granted tool, if this binding exposes it to apps at all.
   *
   * Scope is this method's business, since the gateway has none of its own: whatever it returns is
   * taken to be a tool the app is entitled to call.
   */
  findTool(name: string): Promise<ClassifiedTool | undefined>;
  /**
   * The URI this binding reads one app resource by, given the name the window asked for.
   *
   * A portal renames the resources it fronts, so the name an app knows its own document by is not
   * always the name the endpoint answers to; this is only how the read is addressed.
   */
  resourceUri(uri: string): string;
  /** Runs `fn` against an initialized client for this binding's endpoint. */
  call<T>(fn: (client: McpClient) => Promise<T>, options?: WithClientOptions): Promise<T>;
}

// JSON-RPC 2.0 framing codes. Spelled out rather than imported: they are part of this endpoint's own
// contract with the app, which switches on them.
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

/** Answers one JSON-RPC message from a sidecar page. Never throws for a caller error. */
export async function appRpcReply(message: unknown, host: AppGatewayHost): Promise<AppRpcReply> {
  let parsed = message;
  if (typeof message === "string") {
    try {
      parsed = JSON.parse(message);
    } catch {
      // Nothing parsed, so there is no id to echo; JSON-RPC requires null in that position.
      return failure(null, PARSE_ERROR, "The request was not valid JSON.");
    }
  }

  const request = record(parsed);
  const id = request !== undefined && "id" in request ? jsonRpcId(request.id) : undefined;
  if (request?.jsonrpc !== "2.0" || typeof request.method !== "string" || id === undefined) {
    // A notification (no id) is answered the same way as a malformed request. This endpoint only
    // serves requests, and the honest reply to something that expects none is that it is not one.
    return failure(id ?? null, INVALID_REQUEST, "Not a JSON-RPC 2.0 request.");
  }

  try {
    switch (request.method) {
      case "ping":
        return success(id, {});
      case "tools/call":
        return await callTool(id, request.params, host);
      case "resources/read":
        return await readResource(id, request.params, host);
      default:
        return failure(id, METHOD_NOT_FOUND, `Unknown method "${quoted(request.method)}".`);
    }
  } catch (err) {
    // The failure is this deployment's or the server's, and the app gets a sentence rather than a
    // stack: letting it throw would reach the app as an HTTP 500 it has no convention for.
    return failure(id, INTERNAL_ERROR, failureMessage(err));
  }
}

// One app call, under the whole of the app policy: granted, classified `read`, and offered to apps.
//
// The retry is on: every tool that gets this far is a read, which is exactly what `withClient`'s
// re-initialize-and-retry is safe for. The chat path turns it off only for a write that may already
// have taken effect, and no write reaches here.
async function callTool(
  id: JsonRpcId,
  params: unknown,
  host: AppGatewayHost,
): Promise<AppRpcReply> {
  // Params that are absent or unreadable are the same as empty ones: either way there is no tool
  // name, which is what the check below reports.
  const request = record(params) ?? {};
  const name = request.name;
  if (!isValidToolName(name)) {
    return failure(id, INVALID_PARAMS, '"tools/call" needs a tool name.');
  }
  const args = record(request.arguments);
  if (request.arguments !== undefined && args === undefined) {
    return failure(id, INVALID_PARAMS, '"tools/call" arguments must be an object.');
  }

  const entry = await host.findTool(name);
  if (!entry) return notPermitted(id, name, "this binding does not grant it");
  if (entry.mode !== "read") return notPermitted(id, name, "it is not a read-only tool");
  if (!toolVisibleToApp(entry.tool)) {
    return notPermitted(id, name, "the server did not offer it to apps");
  }

  const result = await host.call(
    client => client.callTool(name, args ?? {}), { retryOnExpiry: true });
  return success(id, clampAppResult(result));
}

// A window may read a `ui://` resource and nothing else, for the same reason it may call a read and
// nothing else: it exists to render one app, and every other resource on the endpoint belongs to the
// conversation the window is not part of. What it asks for is the resource's own name; the name that
// reaches the endpoint is the binding's (`resourceUri`).
async function readResource(
  id: JsonRpcId,
  params: unknown,
  host: AppGatewayHost,
): Promise<AppRpcReply> {
  const uri = record(params)?.uri;
  if (typeof uri !== "string" || uri.length === 0) {
    return failure(id, INVALID_PARAMS, '"resources/read" needs a uri.');
  }
  if (!isUiUri(uri)) {
    return failure(id, APP_ERROR_NOT_PERMITTED,
      "This window can only read ui:// resources. Ask the agent in the chat for anything else.");
  }

  const contents = await host.call(
    client => client.readResource(host.resourceUri(uri)),
    { retryOnExpiry: true },
  );
  // MCP-shaped, because the View is an MCP client, and only the three fields one reads: the CSP the
  // resource declared was applied when the page was built and is the host's business.
  return success(id, {
    contents: contents.map(content => ({
      uri: content.uri, mimeType: content.mimeType, text: content.text,
    })),
  });
}

// The refusal an app gets for anything it is not allowed to do, phrased for the person reading the
// window: a bare "forbidden" would leave them with no idea that the chat can still do it.
function notPermitted(id: JsonRpcId, name: string, reason: string): AppRpcReply {
  return failure(id, APP_ERROR_NOT_PERMITTED,
    `"${quoted(name)}" cannot be called from here: ${reason}. ` +
    "Ask the agent in the chat to run it.");
}

/** A JSON-RPC id, as the reply echoes it back. */
type JsonRpcId = string | number | null;

// Only a string or a number identifies a request. Anything else -- an object, an explicit null, or a
// notification's absent id -- leaves nothing to echo, so the reply carries null.
function jsonRpcId(value: unknown): JsonRpcId | undefined {
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

// Both reply shapes are HTTP 200, including a failure: framing errors belong to the JSON-RPC layer,
// so the route above stays a transport and the View reads `error` out of the body rather than from a
// status code it has no convention for.
function success(id: JsonRpcId, result: unknown): AppRpcReply {
  return { body: JSON.stringify({ jsonrpc: "2.0", id, result }), status: 200 };
}

function failure(id: JsonRpcId, code: number, message: string): AppRpcReply {
  return { body: JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }), status: 200 };
}

// The connector's own errors are already written for a person ("The MCP server rejected this
// connection's credentials. Please reconnect the account."), so one is passed through the shaping
// every server-quoted string gets. Anything else gets this deployment's own sentence.
function failureMessage(err: unknown): string {
  const message = err instanceof Error ? safeServerText(err.message) : undefined;
  return message ?? "This window could not complete the request.";
}

// Names and methods reach error messages from the app and from the server, so each is shaped before
// it is quoted: an unbounded or multi-line value would forge the rest of the message.
function quoted(value: string): string {
  return safeServerText(value) ?? "unknown";
}

// Untrusted JSON arrives as `unknown` at every entry point here -- a parsed body, params, arguments
// -- so one narrowing serves them all.
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
