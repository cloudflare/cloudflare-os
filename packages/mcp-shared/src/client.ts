// Minimal Model Context Protocol client over the Streamable HTTP transport. Implements
// `initialize`, `tools/list`, and `tools/call`; prompts, resources, sampling, and elicitation are
// out of scope (see README).
//
// The transport accepts either a single JSON response or an SSE stream for any POST, so responses
// are parsed both ways. Servers that hand out an `Mcp-Session-Id` get it echoed back on subsequent
// requests; a 404 on a session-bearing request means the server forgot us.
//
// Deliberately not the SDK's `StreamableHTTPClientTransport`, even though OAuth uses the official
// client: that transport carries a reconnect and SSE-resumption state machine built for a long-lived
// process, where this runs in a Durable Object that hibernates between calls and hands the session
// id back to the account. It also offers no hook to clamp a tool at parse time, which `clampTool`
// needs in order to stay inside the storage budget. `guardedFetch`, the capped body readers, and the
// 401/403/404 classification below are the SSRF and response-size boundary for this connector.

import {
  guardedFetch,
  MAX_RESPONSE_BYTES,
  readTextCapped,
  type FetchOptions,
} from "./fetch.js";
import { redactSecrets, safeServerText } from "./util.js";
import type {
  CallToolResult,
  ContentBlock,
  InitializeResult,
  Tool,
  ToolAnnotations,
} from "@modelcontextprotocol/client";

// MCP revision this client speaks. Sent in `initialize` and the `MCP-Protocol-Version` header.
export const MCP_PROTOCOL_VERSION = "2025-06-18";

// A server's tool catalog, and whether listing it ran out of room.
//
// `truncated` has to travel with the tools because absence of evidence is not evidence of absence:
// code that decides what an endpoint *is* from the tools it advertises (`looksLikePortal`) would
// otherwise read a cut-short catalog as a complete one and conclude the endpoint lacks a tool that
// is merely past the cut.
export type ToolCatalog = {
  tools: McpTool[];
  truncated: boolean;
};

// Only to make a non-terminating cursor terminate; generous next to MAX_TOOLS_PER_SERVER.
const MAX_TOOL_PAGES = 50;

// Caps on the size of a tool catalog, as opposed to its length. `maxTools` alone bounds nothing:
// descriptions and JSON Schemas are server-controlled and arbitrarily large, and the catalog is
// stored whole in one Durable Object value, rendered into a `.d.ts`, and fed to the agent.
//
// Durable Object values are limited to 128 KiB after serialization. Keep the tools' JSON below 96
// KiB so the cache wrapper, structured-clone metadata, and a future small field cannot push the
// stored value over that limit. This is a UTF-8 byte budget, not a JavaScript-character budget:
// server-controlled non-ASCII text can take up to four bytes per code point.
//
// Oversized text is truncated rather than the tool dropped, since the name is what a grant is made
// of and a callable tool with a clipped description beats one that vanished.
const MAX_TOOL_DESCRIPTION_CHARS = 4000;
const MAX_TOOL_SCHEMA_CHARS = 20_000;
const MAX_CATALOG_BYTES = 96 * 1024;

// Content block returned by a tool call.
export type McpContentBlock = ContentBlock;

// Per-tool behaviour hints from the server (MCP `ToolAnnotations`). Claims the server makes about
// itself, not guarantees: `readOnlyHint` classifies reads on every server, but the remaining hints
// influence auto-approval only for an administrator-configured endpoint. See `classifyTool()`.
export type McpToolAnnotations = ToolAnnotations;

// One entry of the server's `tools/list` response.
export type McpWireTool = Tool;

export type McpTool = {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: JsonSchema;
  outputSchema?: JsonSchema;
  annotations?: McpToolAnnotations;
};

// The subset of JSON Schema this gatekeeper understands when generating TypeScript.
export type JsonSchema = {
  type?: string | string[];
  description?: string;
  title?: string;
  enum?: unknown[];
  const?: unknown;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema | JsonSchema[];
  additionalProperties?: boolean | JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  format?: string;
  default?: unknown;
  [key: string]: unknown;
};

// Result of `tools/call` as returned by the server.
export type McpToolCallResult = CallToolResult;

// Server identity and capabilities reported by `initialize`.
export type McpServerInfo = Partial<Pick<
  InitializeResult, "protocolVersion" | "serverInfo" | "instructions" | "capabilities"
>>;

// Thrown when the server demands OAuth. Carries the RFC 9728 resource-metadata URL if advertised.
export class McpAuthRequiredError extends Error {
  readonly resourceMetadataUrl: string | null;
  constructor(message: string, resourceMetadataUrl: string | null) {
    super(message);
    this.name = "McpAuthRequiredError";
    this.resourceMetadataUrl = resourceMetadataUrl;
  }
}

// Thrown when the server dropped our transport session; the caller should re-initialize.
export class McpSessionExpiredError extends Error {
  constructor() {
    super("The MCP server no longer recognizes this session.");
    this.name = "McpSessionExpiredError";
  }
}

// What a failed call is known to have done to the server.
//
// Only two answers are useful, and the difference is not one the caller can work out afterwards. A
// server that answered with a 401 or 403 told us it did not act. A generic HTTP or tools/call error,
// connection that dropped, a reply that would not parse, or a body too large to read leaves no way
// to tell whether the request arrived and was carried out before the failure. Retrying the second
// kind is how one approval becomes two writes.
export type CallOutcome = "declined" | "unknown";

// Thrown for JSON-RPC error responses and transport-level failures.
export class McpProtocolError extends Error {
  readonly code: number | undefined;
  // Defaults to `"unknown"`, so a throw site that has not thought about it is treated as unsafe to
  // retry rather than silently assumed harmless.
  readonly outcome: CallOutcome;
  constructor(message: string, code?: number, outcome: CallOutcome = "unknown") {
    super(message);
    this.name = "McpProtocolError";
    this.code = code;
    this.outcome = outcome;
  }
}

// Whether a failed call might already have taken effect on the server.
//
// Fails safe: anything this cannot positively identify as declined is treated as possibly performed.
// The cost of being wrong that way is a call the user has to stage again; the cost of being wrong
// the other way is a duplicated write that MCP offers no way to undo.
export function callMayHaveTakenEffect(err: unknown): boolean {
  // The server demanded authorization, so it never reached the tool.
  if (err instanceof McpAuthRequiredError) return false;
  // A genuine MCP session-expiry response means the server rejected the request before dispatch,
  // but a fronting proxy can synthesize the same 404 after the upstream accepted it. Reads are
  // retried inside `withClient`; a write that escapes from there must therefore remain unknown.
  if (err instanceof McpSessionExpiredError) return true;
  if (err instanceof McpProtocolError) return err.outcome !== "declined";
  return true;
}

// Parses the `resource_metadata` parameter out of a `WWW-Authenticate: Bearer ...` header.
function parseResourceMetadataUrl(wwwAuthenticate: string | null): string | null {
  if (!wwwAuthenticate) return null;
  const match = /resource_metadata\s*=\s*"([^"]+)"/i.exec(wwwAuthenticate)
    ?? /resource_metadata\s*=\s*([^\s,]+)/i.exec(wwwAuthenticate);
  return match ? match[1] : null;
}

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

function extractResponse(bodyText: string, id: number): JsonRpcResponse {
  let parsed: JsonRpcResponse;
  try {
    parsed = JSON.parse(bodyText) as JsonRpcResponse;
  } catch {
    throw new McpProtocolError("MCP server returned a non-JSON response.");
  }
  if (parsed.id !== id && parsed.id !== null && parsed.id !== undefined) {
    throw new McpProtocolError("MCP server answered a different request.");
  }
  return parsed;
}

// Reads completed SSE events until this request's response arrives. Streamable HTTP servers may
// keep the stream open after responding, so waiting for EOF would hang an otherwise-complete call.
async function readSseResponse(response: Response, id: number): Promise<JsonRpcResponse> {
  if (!response.body) {
    throw new McpProtocolError("MCP server's event stream contained no response to the request.");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let total = 0;

  const consume = (): JsonRpcResponse | undefined => {
    for (;;) {
      const boundary = /(?:\r\n|\r(?!\n)|(?<!\r)\n)(?:\r\n|\r(?!\n)|(?<!\r)\n)/.exec(buffered);
      if (!boundary) return undefined;
      const block = buffered.slice(0, boundary.index);
      buffered = buffered.slice(boundary.index + boundary[0].length);
      const data = block.split(/\r\n|\r|\n/)
        .filter(line => line.startsWith("data:"))
        .map(line => line.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      try {
        const parsed = JSON.parse(data) as JsonRpcResponse;
        if (parsed.id === id) return parsed;
      } catch {
        // Ignore malformed and unrelated events while waiting for this request's response.
      }
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        buffered += `${decoder.decode()}\n\n`;
        const parsed = consume();
        if (parsed) return parsed;
        throw new McpProtocolError(
          "MCP server's event stream contained no response to the request.");
      }
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new McpProtocolError(
          `MCP server's event stream exceeded ${MAX_RESPONSE_BYTES} bytes.`);
      }
      buffered += decoder.decode(value, { stream: true });
      const parsed = consume();
      if (parsed) {
        await reader.cancel().catch(() => undefined);
        return parsed;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// `unknown` because the wire types describe a well-behaved server: a non-string here would pass the
// length cap untouched and surface later as a `TypeError` in a consumer that expected a string.
function clampText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.length > max ? `${value.slice(0, max)}\u2026` : value;
}

// Trims one tool down to what is worth keeping, before it reaches storage or the agent. A schema too
// large to render is dropped rather than clipped, so the generated method degrades to
// `Record<string, unknown>`.
function clampTool(tool: McpWireTool): McpTool {
  const schema = tool.inputSchema && typeof tool.inputSchema === "object"
    ? tool.inputSchema as JsonSchema
    : undefined;
  const oversized = schema !== undefined &&
    JSON.stringify(schema).length > MAX_TOOL_SCHEMA_CHARS;
  const annotations = tool.annotations;
  return {
    // Pick known fields rather than spreading an untrusted JSON object. Unknown extensions are not
    // used anywhere, and retaining one would let it bypass every per-field cap before caching.
    name: tool.name,
    title: clampText(tool.title, MAX_TOOL_DESCRIPTION_CHARS),
    description: clampText(tool.description, MAX_TOOL_DESCRIPTION_CHARS),
    inputSchema: oversized ? undefined : schema,
    annotations: annotations && {
      readOnlyHint: annotations.readOnlyHint,
      destructiveHint: annotations.destructiveHint,
      idempotentHint: annotations.idempotentHint,
      openWorldHint: annotations.openWorldHint,
    },
  };
}

// Bearer token supplier; returns null for servers that need no authorization.
export type AuthorizationProvider = () => Promise<string | null>;

// A stateless-per-instance MCP client. Construct one per operation; the only state worth keeping
// across calls is the transport session id, which the caller owns (see `sessionId`).
export class McpClient {
  #endpoint: string;
  #getAuthorization: AuthorizationProvider;
  #fetchOptions: FetchOptions;
  #requestId = 0;

  // Transport session id, assigned by the server during `initialize`. Persist and pass it back.
  sessionId: string | null;

  constructor(
    endpoint: string,
    getAuthorization: AuthorizationProvider,
    sessionId?: string | null,
    fetchOptions: FetchOptions = {},
  ) {
    this.#endpoint = endpoint;
    this.#getAuthorization = getAuthorization;
    this.sessionId = sessionId ?? null;
    this.#fetchOptions = fetchOptions;
  }

  // The credential most recently sent, kept only so it can be recognised if it comes back. See
  // `#quoteServerText`.
  #lastCredential: string | null = null;

  async #headers(): Promise<Headers> {
    const headers = new Headers({
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
    });
    const authorization = await this.#getAuthorization();
    this.#lastCredential = authorization;
    if (authorization) headers.set("Authorization", `Bearer ${authorization}`);
    if (this.sessionId) headers.set("Mcp-Session-Id", this.sessionId);
    return headers;
  }

  async #post(body: unknown): Promise<Response> {
    const response = await guardedFetch(this.#endpoint, {
      method: "POST",
      headers: await this.#headers(),
      body: JSON.stringify(body),
    }, this.#fetchOptions);

    // Only 401 means the credentials are the problem. A 403 is an authenticated caller refused this
    // particular tool; treating it as an auth failure would mark the account expired and prompt a
    // reconnect that cannot help.
    if (response.status === 401) {
      throw new McpAuthRequiredError(
        "The MCP server requires authorization.",
        parseResourceMetadataUrl(response.headers.get("WWW-Authenticate")));
    }
    if (response.status === 403) {
      throw new McpProtocolError(
        "The MCP server refused this request. The connected account may not have access to it.",
        undefined, "declined");
    }
    if (response.status === 404 && this.sessionId) throw new McpSessionExpiredError();
    return response;
  }

  async #call<T>(method: string, params?: unknown): Promise<T> {
    const id = ++this.#requestId;
    const response = await this.#post({ jsonrpc: "2.0", id, method, params });

    if (!response.ok) {
      throw new McpProtocolError(
        `MCP server returned HTTP ${response.status} for "${method}".`);
    }

    const sessionId = response.headers.get("Mcp-Session-Id");
    if (sessionId) this.sessionId = sessionId;

    const contentType = (response.headers.get("Content-Type") ?? "").toLowerCase();
    let parsed: JsonRpcResponse;
    if (contentType.includes("text/event-stream")) {
      parsed = await readSseResponse(response, id);
    } else {
      // Capped: a JSON tool result is server-controlled and unbounded, and has to be buffered whole
      // before it can be parsed. The catalog limits above bound what is kept, not what arrives.
      let bodyText: string;
      try {
        bodyText = await readTextCapped(response);
      } catch (err) {
        throw new McpProtocolError(
          `MCP server's response to "${method}" was too large to read: ` +
          `${err instanceof Error ? err.message : String(err)}`);
      }
      parsed = extractResponse(bodyText, id);
    }

    if (parsed.error) {
      throw new McpProtocolError(
        `MCP server rejected "${method}": ${this.#quoteServerText(parsed.error.message)}`,
        parsed.error.code, method === "tools/call" ? "unknown" : "declined");
    }
    return parsed.result as T;
  }

  // Prepares text the server wrote for inclusion in an error message.
  //
  // These messages are logged and may be dispatched to the issue reporter, so beyond the shaping
  // `safeServerText` does, the credential just sent is redacted if it appears. A server that echoes
  // the request's `Authorization` back inside an error -- whether carelessly or deliberately -- would
  // otherwise have this Worker copy its own bearer token into an indexed log field. The token is the
  // one secret whose value is known here, so it is the one that can be removed with certainty.
  //
  // Redacted before shaping, never after: `safeServerText` caps the text, and a token straddling
  // that cap would lose the tail that made it matchable while the head stayed in the message.
  #quoteServerText(text: unknown): string {
    if (typeof text !== "string") return "no reason given";
    return safeServerText(redactSecrets(text, [this.#lastCredential])) ?? "no reason given";
  }

  async #notify(method: string, params?: unknown): Promise<void> {
    // Notifications carry no id and expect no body; failures here are not worth surfacing.
    await this.#post({ jsonrpc: "2.0", method, params }).catch(() => undefined);
  }

  // Performs the `initialize` handshake and the follow-up `notifications/initialized`.
  async initialize(clientName: string): Promise<McpServerInfo> {
    const info = await this.#call<InitializeResult>("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      // No client capabilities: this gatekeeper never serves roots, sampling, or elicitation, so
      // advertising them would invite requests it cannot honour.
      capabilities: {},
      clientInfo: { name: clientName, version: "1.0.0" },
    });
    await this.#notify("notifications/initialized");
    return info;
  }

  // Lists every tool the server offers, following `nextCursor` pagination to exhaustion. Bounded by
  // pages, tool count, and bytes: a server answering with empty pages and a fresh cursor each time
  // would otherwise loop until the Worker's limits killed it.
  async listTools(maxTools: number): Promise<ToolCatalog> {
    const tools: McpTool[] = [];
    let budget = MAX_CATALOG_BYTES;
    let cursor: string | undefined;

    for (let page = 0; page < MAX_TOOL_PAGES; page++) {
      const body = await this.#call<{ tools?: McpWireTool[]; nextCursor?: string }>(
        "tools/list", cursor ? { cursor } : {});
      for (const tool of body.tools ?? []) {
        // A cap was reached with tools still arriving, so the catalog is known to be incomplete.
        // Reported rather than inferred from `tools.length`, since the byte budget can stop the
        // listing well short of `maxTools` and leaves no trace in the array itself.
        if (tools.length >= maxTools || budget <= 0) return { tools, truncated: true };
        if (typeof tool?.name !== "string" || tool.name.length === 0) continue;
        const trimmed = clampTool(tool);
        // Include a comma's byte for every array member. Brackets are covered by the 32 KiB storage
        // headroom. Refuse the whole next tool rather than storing half a schema or an invalid value.
        const bytes = new TextEncoder().encode(JSON.stringify(trimmed)).byteLength + 1;
        if (bytes > budget) return { tools, truncated: true };
        budget -= bytes;
        tools.push(trimmed);
      }
      cursor = body.nextCursor;
      if (!cursor) return { tools, truncated: false };
    }
    throw new McpProtocolError(
      `MCP server kept paginating "tools/list" past ${MAX_TOOL_PAGES} pages.`);
  }

  // Invokes one tool. A tool-level failure arrives as `isError`, not as a thrown error.
  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    return this.#call<McpToolCallResult>("tools/call", { name, arguments: args });
  }
}
