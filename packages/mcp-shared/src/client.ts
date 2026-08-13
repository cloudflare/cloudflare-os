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
  FetchNotStartedError,
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

/** MCP revision this client speaks. Sent in `initialize` and the `MCP-Protocol-Version` header. */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

/**
 * A server's tool catalog, and whether listing it ran out of room.
 *
 * `truncated` has to travel with the tools because absence of evidence is not evidence of absence:
 * code that decides what an endpoint *is* from the tools it advertises (`looksLikePortal`) would
 * otherwise read a cut-short catalog as a complete one and conclude the endpoint lacks a tool that
 * is merely past the cut.
 */
export type ToolCatalog = {
  tools: McpTool[];
  truncated: boolean;
};

/** One tool identity retained to validate names or recover portal membership. */
export type IndexedTool = {
  /** Exact wire name advertised by the endpoint. */
  name: string;
};

/** A bounded survey of endpoint tool identities without schemas, descriptions, or policy claims. */
export type ToolIndex = {
  /** Retained tool identities. */
  tools: IndexedTool[];
  /** Whether count, byte, page, or scan limits cut the survey short. */
  truncated: boolean;
};

/** Longest tool name retained from a server or accepted from a Gadget. */
export const MAX_TOOL_NAME_CHARS = 512;

/** Whether a value is a non-empty tool name small enough to retain or look up. */
export function isValidToolName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_TOOL_NAME_CHARS;
}

// Independent bound for a non-terminating cursor that returns only tiny or empty pages.
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
// Search is a discovery hint; full schemas come from `listTools({ name })`. Keeping each text field small
// lets ordinary twenty-result searches stay well below the catalog byte budget.
const MAX_TOOL_SEARCH_SUMMARY_CHARS = 256;
const MAX_TOOL_SCHEMA_CHARS = 20_000;
const MAX_CATALOG_BYTES = 96 * 1024;
// Filtered discovery can skip every tool on a page, so its retained-result budget would otherwise
// permit fifty maximum-sized responses. Bound what was inspected independently of what matched.
const MAX_SCANNED_TOOL_BYTES = 4 * 1024 * 1024;
const MAX_SCANNED_TOOLS = 5000;
const encoder = new TextEncoder();

/** Content block returned by a tool call. */
export type McpContentBlock = ContentBlock;

/**
 * Per-tool behaviour hints from the server (MCP `ToolAnnotations`). Claims the server makes about
 * itself, not guarantees: `readOnlyHint` classifies reads on every server, but the remaining hints
 * influence auto-approval only for an administrator-configured endpoint. See `classifyTool()`.
 */
export type McpToolAnnotations = ToolAnnotations;

/** One entry of the server's `tools/list` response. */
export type McpWireTool = Tool;

/** Selects which wire tools count toward a bounded catalog. */
export type McpToolFilter = (tool: McpWireTool) => boolean;

export type McpTool = {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: JsonSchema;
  outputSchema?: JsonSchema;
  annotations?: McpToolAnnotations;
};

/** The subset of JSON Schema this gatekeeper understands when generating TypeScript. */
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

/** Result of `tools/call` as returned by the server. */
export type McpToolCallResult = CallToolResult;

/** Server identity and capabilities reported by `initialize`. */
export type McpServerInfo = Partial<Pick<
  InitializeResult, "protocolVersion" | "serverInfo" | "instructions" | "capabilities"
>>;

/** Thrown when the server demands OAuth. Carries the RFC 9728 resource-metadata URL if advertised. */
export class McpAuthRequiredError extends Error {
  readonly resourceMetadataUrl: string | null;
  constructor(message: string, resourceMetadataUrl: string | null) {
    super(message);
    this.name = "McpAuthRequiredError";
    this.resourceMetadataUrl = resourceMetadataUrl;
  }
}

/** Thrown when the server dropped our transport session; the caller should re-initialize. */
export class McpSessionExpiredError extends Error {
  constructor() {
    super("The MCP server no longer recognizes this session.");
    this.name = "McpSessionExpiredError";
  }
}

/** A connector-side failure that happened before the requested MCP tool was dispatched. */
export class McpCallNotDispatchedError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "McpCallNotDispatchedError";
  }
}

/**
 * What a failed call is known to have done to the server.
 *
 * Only two answers are useful, and the difference is not one the caller can work out afterwards. A
 * server that answered with a 401 or 403 told us it did not act. A generic HTTP or tools/call error,
 * connection that dropped, a reply that would not parse, or a body too large to read leaves no way
 * to tell whether the request arrived and was carried out before the failure. Retrying the second
 * kind is how one approval becomes two writes.
 */
export type CallOutcome = "declined" | "unknown";

/** Thrown for JSON-RPC error responses and transport-level failures. */
export class McpProtocolError extends Error {
  readonly code: number | undefined;
  /**
   * Defaults to `"unknown"`, so a throw site that has not thought about it is treated as unsafe to
   * retry rather than silently assumed harmless.
   */
  readonly outcome: CallOutcome;
  constructor(message: string, code?: number, outcome: CallOutcome = "unknown") {
    super(message);
    this.name = "McpProtocolError";
    this.code = code;
    this.outcome = outcome;
  }
}

/**
 * Whether a failed call might already have taken effect on the server.
 *
 * Fails safe: anything this cannot positively identify as declined is treated as possibly performed.
 * The cost of being wrong that way is a call the user has to stage again; the cost of being wrong
 * the other way is a duplicated write that MCP offers no way to undo.
 */
export function callMayHaveTakenEffect(err: unknown): boolean {
  if (err instanceof McpCallNotDispatchedError) return false;
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

function extractResponse(bodyText: string, id: number | string): JsonRpcResponse {
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
async function readSseResponse(
  response: Response,
  id: number | string,
): Promise<{ parsed: JsonRpcResponse; bytes: number }> {
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
        if (parsed) return { parsed, bytes: total };
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
        return { parsed, bytes: total };
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
// Keeps only the hints this gatekeeper understands, so a server cannot attach unbounded text to a
// tool under `annotations` and have it stored or rendered. Each retained field is a boolean or
// absent.
function clampAnnotations(
  annotations: McpToolAnnotations | undefined,
): McpToolAnnotations | undefined {
  return annotations && {
    readOnlyHint: typeof annotations.readOnlyHint === "boolean"
      ? annotations.readOnlyHint : undefined,
    destructiveHint: typeof annotations.destructiveHint === "boolean"
      ? annotations.destructiveHint : undefined,
    idempotentHint: typeof annotations.idempotentHint === "boolean"
      ? annotations.idempotentHint : undefined,
    openWorldHint: typeof annotations.openWorldHint === "boolean"
      ? annotations.openWorldHint : undefined,
  };
}

/** Reduces one untrusted wire tool to the bounded fields this gatekeeper understands. */
export function clampToolDefinition(tool: McpWireTool | McpTool): McpTool {
  const schema = tool.inputSchema && typeof tool.inputSchema === "object"
    ? tool.inputSchema as JsonSchema
    : undefined;
  const oversized = schema !== undefined &&
    JSON.stringify(schema).length > MAX_TOOL_SCHEMA_CHARS;
  return {
    // Pick known fields rather than spreading an untrusted JSON object. Unknown extensions are not
    // used anywhere, and retaining one would let it bypass every per-field cap before caching.
    name: tool.name,
    title: clampText(tool.title, MAX_TOOL_DESCRIPTION_CHARS),
    description: clampText(tool.description, MAX_TOOL_DESCRIPTION_CHARS),
    inputSchema: oversized ? undefined : schema,
    annotations: clampAnnotations(tool.annotations),
  };
}

// Reduces one tool to an index entry. Bounded by its already-validated name.
function indexTool(tool: McpWireTool): IndexedTool {
  return { name: tool.name };
}

/** Reduces one tool to the bounded, schema-free form returned by search. */
export function clampToolSummary(tool: McpWireTool | McpTool): McpTool {
  return {
    name: tool.name,
    title: clampText(tool.title, MAX_TOOL_SEARCH_SUMMARY_CHARS),
    description: clampText(tool.description, MAX_TOOL_SEARCH_SUMMARY_CHARS),
    annotations: clampAnnotations(tool.annotations),
  };
}

/** Supplies a bearer token for an MCP method, or null for a public server. */
export type AuthorizationProvider = (method: string) => Promise<string | null>;

/**
 * A stateless-per-instance MCP client. Construct one per operation; the only state worth keeping
 * across calls is the transport session id, which the caller owns (see `sessionId`).
 */
export class McpClient {
  #endpoint: string;
  #getAuthorization: AuthorizationProvider;
  #fetchOptions: FetchOptions;
  #requestPrefix = crypto.randomUUID();
  #requestId = 0;

  /** Transport session id, assigned by the server during `initialize`. Persist and pass it back. */
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
    this.#fetchOptions = fetchOptions.timeoutMs !== undefined && fetchOptions.deadline === undefined
      ? { ...fetchOptions, deadline: Date.now() + fetchOptions.timeoutMs }
      : fetchOptions;
  }

  // The credential most recently sent, kept only so it can be recognised if it comes back. See
  // `#quoteServerText`.
  #lastCredential: string | null = null;

  async #headers(method: string): Promise<Headers> {
    const headers = new Headers({
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
    });
    const authorization = await this.#getAuthorization(method);
    this.#lastCredential = authorization;
    if (authorization) headers.set("Authorization", `Bearer ${authorization}`);
    if (this.sessionId) headers.set("Mcp-Session-Id", this.sessionId);
    return headers;
  }

  async #post(body: unknown): Promise<Response> {
    let headers: Headers;
    try {
      const method = typeof body === "object" && body !== null && "method" in body
        ? String((body as { method: unknown }).method)
        : "unknown";
      headers = await this.#headers(method);
    } catch (err) {
      throw new McpCallNotDispatchedError(
        err instanceof Error ? err.message : String(err), err);
    }
    let response: Response;
    try {
      response = await guardedFetch(this.#endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }, this.#fetchOptions);
    } catch (err) {
      if (err instanceof FetchNotStartedError) {
        throw new McpCallNotDispatchedError(err.message, err);
      }
      throw err;
    }

    // Only 401 means the credentials are the problem. A 403 is an authenticated caller refused this
    // particular tool; treating it as an auth failure would mark the account expired and prompt a
    // reconnect that cannot help.
    if (response.status === 401) {
      await response.body?.cancel().catch(() => undefined);
      throw new McpAuthRequiredError(
        "The MCP server requires authorization.",
        parseResourceMetadataUrl(response.headers.get("WWW-Authenticate")));
    }
    if (response.status === 403) {
      await response.body?.cancel().catch(() => undefined);
      throw new McpProtocolError(
        "The MCP server refused this request. The connected account may not have access to it.",
        undefined, "declined");
    }
    if (response.status === 404 && this.sessionId) {
      await response.body?.cancel().catch(() => undefined);
      throw new McpSessionExpiredError();
    }
    return response;
  }

  async #callMeasured<T>(
    method: string,
    params?: unknown,
  ): Promise<{ result: T; responseBytes: number }> {
    // A transport session is persisted on the account and can be used by several short-lived client
    // instances concurrently. Prefixing IDs per instance prevents two active requests from both
    // being JSON-RPC id 1 and confusing the server's SSE response routing.
    const id = `${this.#requestPrefix}:${++this.#requestId}`;
    const response = await this.#post({ jsonrpc: "2.0", id, method, params });

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new McpProtocolError(
        `MCP server returned HTTP ${response.status} for "${method}".`);
    }

    const sessionId = response.headers.get("Mcp-Session-Id");
    if (sessionId) this.sessionId = sessionId;

    const contentType = (response.headers.get("Content-Type") ?? "").toLowerCase();
    let parsed: JsonRpcResponse;
    let responseBytes: number;
    if (contentType.includes("text/event-stream")) {
      const measured = await readSseResponse(response, id);
      parsed = measured.parsed;
      responseBytes = measured.bytes;
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
      responseBytes = encoder.encode(bodyText).byteLength;
      parsed = extractResponse(bodyText, id);
    }

    if (parsed.error) {
      throw new McpProtocolError(
        `MCP server rejected "${method}": ${this.#quoteServerText(parsed.error.message)}`,
        parsed.error.code, method === "tools/call" ? "unknown" : "declined");
    }
    return { result: parsed.result as T, responseBytes };
  }

  async #call<T>(method: string, params?: unknown): Promise<T> {
    return (await this.#callMeasured<T>(method, params)).result;
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

  /** Performs the `initialize` handshake and the follow-up `notifications/initialized`. */
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

  /** Best-effort termination for a transport session this client no longer owns. */
  async closeSession(): Promise<void> {
    if (!this.sessionId) return;
    const response = await guardedFetch(this.#endpoint, {
      method: "DELETE",
      headers: await this.#headers("DELETE"),
    }, this.#fetchOptions);
    await response.body?.cancel();
    this.sessionId = null;
  }

  /**
   * Lists tools the server offers, following pagination to exhaustion.
   *
   * `include`, when present, is applied before count and byte budgets so an aggregator's unrelated
   * tools cannot crowd the requested server or exact grant names out of the bounded result.
   */
  async listTools(maxTools: number, include?: McpToolFilter): Promise<ToolCatalog> {
    return this.#list(maxTools, include, clampToolDefinition);
  }

  /**
   * Surveys names without retaining descriptions, schemas, or policy annotations. Resolve a full
   * definition with `findTool` before use.
   */
  async listToolIndex(maxTools: number): Promise<ToolIndex> {
    return this.#list(maxTools, undefined, indexTool);
  }

  /** Collects at most `maxTools` matching index entries without scanning later pages. */
  async listMatchingToolIndex(maxTools: number, include: McpToolFilter): Promise<ToolIndex> {
    return this.#list(maxTools, include, indexTool, true);
  }

  /** Finds one exact tool without reading pages after the match. */
  async findTool(name: string): Promise<McpTool | undefined> {
    if (!isValidToolName(name)) return undefined;
    return (await this.#list(
      1, tool => tool.name === name, clampToolDefinition, true, true)).tools[0];
  }

  /** Collects at most `maxTools` bounded matching summaries without scanning later pages. */
  async listMatchingToolSummaries(maxTools: number, include: McpToolFilter): Promise<McpTool[]> {
    return (await this.#list(maxTools, include, clampToolSummary, true, true)).tools;
  }

  // The shared listing loop. `project` decides how much of each tool is retained, and therefore how
  // much of the byte budget each one costs; the budget itself is applied to whatever it returns.
  async #list<T extends { name: string }>(
    maxTools: number,
    include: McpToolFilter | undefined,
    project: (tool: McpWireTool) => T,
    stopWhenFull = false,
    failOnScanLimit = false,
  ): Promise<{ tools: T[]; truncated: boolean }> {
    const tools: T[] = [];
    let budget = MAX_CATALOG_BYTES;
    let scannedBytes = 0;
    let scannedTools = 0;
    let cursor: string | undefined;
    const scanLimit = (): { tools: T[]; truncated: boolean } => {
      if (failOnScanLimit) {
        throw new McpProtocolError(
          "MCP tool discovery exceeded its scan budget.", undefined, "declined");
      }
      return { tools, truncated: true };
    };

    for (let page = 0; page < MAX_TOOL_PAGES; page++) {
      const measured = await this.#callMeasured<{ tools?: McpWireTool[]; nextCursor?: string }>(
        "tools/list", cursor === undefined ? {} : { cursor });
      const body = measured.result;
      scannedBytes += measured.responseBytes;
      if (scannedBytes > MAX_SCANNED_TOOL_BYTES) return scanLimit();
      const pageTools = body.tools ?? [];
      const remainingTools = Math.max(0, MAX_SCANNED_TOOLS - scannedTools);
      const scanCount = Math.min(pageTools.length, remainingTools);
      scannedTools += scanCount;
      for (let index = 0; index < scanCount; index++) {
        const tool = pageTools[index];
        if (!isValidToolName(tool?.name)) continue;
        if (include && !include(tool)) continue;
        // A cap was reached with tools still arriving, so the catalog is known to be incomplete.
        // Reported rather than inferred from `tools.length`, since the byte budget can stop the
        // listing well short of `maxTools` and leaves no trace in the array itself.
        if (tools.length >= maxTools || budget <= 0) return { tools, truncated: true };
        const trimmed = project(tool);
        // Include a comma's byte for every array member. Brackets are covered by the 32 KiB storage
        // headroom. Refuse the whole next tool rather than storing half a schema or an invalid value.
        const bytes = encoder.encode(JSON.stringify(trimmed)).byteLength + 1;
        if (bytes > budget) return { tools, truncated: true };
        budget -= bytes;
        tools.push(trimmed);
        if (stopWhenFull && tools.length >= maxTools) {
          // Discovery only asks for a bounded prefix and does not need to prove whether another
          // match exists. The public discovery methods discard `truncated`; ordinary listings retain
          // the precise semantics above and still paginate to completion.
          return { tools, truncated: true };
        }
      }
      // Inspect the bounded prefix before reporting the scan limit: an exact requested tool may be
      // the first entry in a page whose remaining entries cross the aggregate tool budget.
      if (scanCount < pageTools.length) return scanLimit();
      const nextCursor = body.nextCursor;
      if (nextCursor === undefined) return { tools, truncated: false };
      if (typeof nextCursor !== "string") {
        throw new McpProtocolError('MCP server returned an invalid "tools/list" cursor.');
      }
      cursor = nextCursor;
    }
    return scanLimit();
  }

  /** Invokes one tool. A tool-level failure arrives as `isError`, not as a thrown error. */
  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    return this.#call<McpToolCallResult>("tools/call", { name, arguments: args });
  }
}
