// How the library's requests reach the gatekeeper's upstream: the name each kind is counted under,
// what is counted where the status alone does not say, and what the guard, the deadline and the
// retry policy do to an attempt. Points are read back from a fake `METRICS` dataset.

import { env } from "cloudflare:workers";
import {
  COMMON_SLOTS, SUBSERVICE_V1_SLOTS, type BlobSlot, type DoubleSlot,
} from "@gadgets/observability/metrics";
import {
  IssuerMismatchError,
  OAuthError,
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  discoverOAuthServerInfo,
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
} from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CATALOG_TTL_MS, scopedCatalog, type CatalogRequest } from "../src/catalog.js";
import { McpClient, McpProtocolError } from "../src/client.js";
import type { ConnectionAccount } from "../src/connection.js";
import { FetchNotStartedError } from "../src/fetch.js";
import { revokeToken } from "../src/oauth.js";
import { toCallResult } from "../src/tools.js";
import {
  MCP_OPERATIONS,
  OAUTH_OPERATIONS,
  guardedUpstream,
  oauthOperation,
  rpcOperation,
  sdkFetch,
} from "../src/upstream.js";
import { upstream } from "./stubs/upstream.js";

// Hosts no other suite of the package requests.
const ENDPOINT = "https://mcp.upstream-test.example/mcp";
const AUTH = "https://auth.upstream-test.example";
const METADATA = {
  issuer: AUTH,
  authorization_endpoint: `${AUTH}/authorize`,
  token_endpoint: `${AUTH}/token`,
  registration_endpoint: `${AUTH}/register`,
  revocation_endpoint: `${AUTH}/revoke`,
  response_types_supported: ["code"],
};
const TOKENS = { access_token: "access", token_type: "Bearer", refresh_token: "refresh" };

const ambient = env as { METRICS?: AnalyticsEngineDataset; SUBSERVICE_METRICS?: string };
let points: AnalyticsEngineDataPoint[];

beforeEach(() => {
  points = [];
  ambient.METRICS = { writeDataPoint: point => { if (point) points.push(point); } };
  ambient.SUBSERVICE_METRICS = "true";
});

afterEach(() => {
  delete ambient.METRICS;
  delete ambient.SUBSERVICE_METRICS;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// A written point's value in one column.
function column(point: AnalyticsEngineDataPoint, slot: BlobSlot | DoubleSlot) {
  const values = slot.startsWith("blob") ? point.blobs : point.doubles;
  return values?.[Number(slot.replace(/\D+/, "")) - 1];
}

// Each point written, as its operation, outcome, reason and HTTP status.
function counted() {
  return points.map(point => [
    SUBSERVICE_V1_SLOTS.operation, COMMON_SLOTS.outcome, SUBSERVICE_V1_SLOTS.reason,
    SUBSERVICE_V1_SLOTS.httpStatus,
  ].map(slot => column(point, slot)));
}

// Each point written, as its outcome, reason, HTTP status and the requests it sums.
function summed() {
  return points.map(point => [
    COMMON_SLOTS.outcome, SUBSERVICE_V1_SLOTS.reason, SUBSERVICE_V1_SLOTS.httpStatus, SUBSERVICE_V1_SLOTS.calls,
  ].map(slot => column(point, slot)));
}

// The operation of each point written.
function operations() {
  return points.map(point => column(point, SUBSERVICE_V1_SLOTS.operation));
}

// One request as the platform `fetch` was handed it.
type Sent = {
  method: string;
  url: string;
  /** The JSON-RPC method and id of a JSON body. */
  rpc?: string;
  id?: string;
  signal: AbortSignal | undefined;
};

// A platform `fetch` that records each request and answers it with what `answer` returns.
function platform(answer: (sent: Sent) => Response | Promise<Response>): Sent[] {
  const requests: Sent[] = [];
  vi.stubGlobal("fetch", async (input: string | URL, init: RequestInit = {}) => {
    const message = typeof init.body === "string" && init.body.startsWith("{")
      ? JSON.parse(init.body) as { method?: string; id?: string } : undefined;
    const sent: Sent = {
      method: init.method ?? "GET",
      url: String(input),
      rpc: message?.method,
      id: message?.id,
      signal: init.signal ?? undefined,
    };
    requests.push(sent);
    return answer(sent);
  });
  return requests;
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init, headers: { "Content-Type": "application/json", ...init.headers },
  });
}

// An MCP server that answers every request: a result for a JSON-RPC request, 202 for a
// notification, 200 for the session's DELETE.
function mcpServer(result: (sent: Sent) => unknown = () => ({})): Sent[] {
  return platform(sent => {
    if (sent.method === "DELETE") return new Response(null, { status: 200 });
    if (sent.id === undefined) return new Response(null, { status: 202 });
    return json({ jsonrpc: "2.0", id: sent.id, result: result(sent) });
  });
}

// An authorization server and the protected resource's metadata, as the SDK asks for them.
function oauthServer(): Sent[] {
  return platform(sent => {
    if (sent.url.includes("oauth-protected-resource")) {
      return json({ resource: ENDPOINT, authorization_servers: [AUTH] });
    }
    if (sent.url.includes("oauth-authorization-server")) return json(METADATA);
    if (sent.url === `${AUTH}/register`) {
      return json({ client_id: "client", redirect_uris: ["https://gatekeeper.example/oauth"] });
    }
    if (sent.url === `${AUTH}/token`) return json(TOKENS);
    if (sent.url === `${AUTH}/revoke`) return new Response(null, { status: 200 });
    return new Response("", { status: 404 });
  });
}

function client(options?: ConstructorParameters<typeof McpClient>[4], sessionId?: string) {
  return new McpClient(upstream, ENDPOINT, async () => "token", sessionId, options);
}

// Each kind of request the library makes, driven through the code that makes it, with the names
// its requests are counted under, in the order they are sent.
const REQUESTS: [kind: string, make: () => Promise<unknown>, names: string[]][] = [
  ["the initialize handshake", async () => {
    mcpServer();
    await client().initialize("Gadgets");
  }, ["initialize", "notifications.initialized"]],
  ["a tools/list page", async () => {
    mcpServer(() => ({ tools: [] }));
    await client().listTools(10);
  }, ["tools.list"]],
  ["a tools/call", async () => {
    mcpServer(() => ({ content: [] }));
    await client().callTool("create_issue", {});
  }, ["tools.call"]],
  ["the DELETE that ends a session", async () => {
    mcpServer();
    await client(undefined, "session").closeSession();
  }, ["session.close"]],
  ["discovery of the resource's and the authorization server's metadata", async () => {
    oauthServer();
    await discoverOAuthServerInfo(ENDPOINT, { fetchFn: sdkFetch(upstream) });
  }, ["metadata.resource", "metadata.server"]],
  ["the client's registration", async () => {
    oauthServer();
    await registerClient(AUTH, {
      metadata: METADATA,
      clientMetadata: { redirect_uris: ["https://gatekeeper.example/oauth"] },
      fetchFn: sdkFetch(upstream),
    });
  }, ["client.register"]],
  ["the exchange of an authorization code", async () => {
    oauthServer();
    await exchangeAuthorization(AUTH, {
      metadata: METADATA,
      clientInformation: { client_id: "client" },
      authorizationCode: "code",
      codeVerifier: "verifier",
      redirectUri: "https://gatekeeper.example/oauth",
      fetchFn: sdkFetch(upstream),
    });
  }, ["token.exchange"]],
  ["a refresh the SDK makes inside its flow", async () => {
    oauthServer();
    await refreshAuthorization(AUTH, {
      metadata: METADATA,
      clientInformation: { client_id: "client" },
      refreshToken: "refresh",
      fetchFn: sdkFetch(upstream),
    });
  }, ["token.refresh"]],
  ["the account's own refresh, named by its call site", async () => {
    oauthServer();
    await refreshAuthorization(AUTH, {
      metadata: METADATA,
      clientInformation: { client_id: "client" },
      refreshToken: "refresh",
      fetchFn: sdkFetch(upstream, {}, "token.refresh"),
    });
  }, ["token.refresh"]],
  ["a revocation, named by its call site", async () => {
    oauthServer();
    await revokeToken(
      { authorizationServerUrl: AUTH, authorizationServerMetadata: METADATA },
      { client_id: "client" }, "refresh", "refresh_token",
      sdkFetch(upstream, {}, "token.revoke"));
  }, ["token.revoke"]],
];

describe("the names of the library's requests", () => {
  it.each(REQUESTS)("counts %s under its closed name", async (_kind, make, names) => {
    await make();
    expect(operations()).toEqual(names);
    for (const point of points) {
      expect(column(point, SUBSERVICE_V1_SLOTS.source)).toBe("gatekeeper.mcp.api");
      expect(column(point, SUBSERVICE_V1_SLOTS.service)).toBe("mcp");
      expect(column(point, COMMON_SLOTS.outcome)).toBe("success");
    }
  });

  it.each([
    ["initialize", "initialize"],
    ["notifications/initialized", "notifications.initialized"],
    ["tools/list", "tools.list"],
    ["tools/call", "tools.call"],
  ])("names the JSON-RPC method %s %s", (method, name) => {
    expect(rpcOperation(method)).toBe(name);
  });

  it.each([
    "resources/list", "create_issue", "tools/call/extra", "TOOLS/CALL", "", "constructor",
    "toString", "__proto__",
  ])("names the JSON-RPC method %j rpc.other", method => {
    expect(rpcOperation(method)).toBe("rpc.other");
  });

  it.each([
    ["GET", `${AUTH}/.well-known/oauth-authorization-server`, undefined, "metadata.server"],
    ["GET", `${AUTH}/.well-known/oauth-authorization-server/tenant`, undefined, "metadata.server"],
    ["GET", `${AUTH}/.well-known/openid-configuration`, undefined, "metadata.server"],
    ["GET", `${AUTH}/tenant/.well-known/openid-configuration`, undefined, "metadata.server"],
    ["GET", "https://mcp.example.com/.well-known/oauth-protected-resource/mcp", undefined,
      "metadata.resource"],
    // The URL a server's challenge names for its resource metadata has any path.
    ["GET", "https://mcp.example.com/metadata?tenant=one", undefined, "metadata.resource"],
    [undefined, "https://mcp.example.com/metadata", undefined, "metadata.resource"],
    ["POST", `${AUTH}/register`, "{}", "client.register"],
    ["POST", `${AUTH}/token`, new URLSearchParams({ grant_type: "authorization_code" }),
      "token.exchange"],
    ["post", `${AUTH}/token`, new URLSearchParams({ grant_type: "refresh_token" }),
      "token.refresh"],
    ["POST", `${AUTH}/token`, new URLSearchParams({ grant_type: "client_credentials" }),
      "oauth.other"],
    ["POST", `${AUTH}/token`, undefined, "oauth.other"],
    ["PUT", `${AUTH}/register`, "{}", "oauth.other"],
    ["GET", "not a url", undefined, "metadata.resource"],
  ] as const)("names the OAuth request %s %s", (method, url, body, name) => {
    expect(oauthOperation(method, url, body)).toBe(name);
  });

  it("uses every name of the two closed lists", async () => {
    const used = new Set<unknown>([rpcOperation("resources/list"), oauthOperation("PUT", AUTH)]);
    for (const [, make] of REQUESTS) await make();
    for (const operation of operations()) used.add(operation);
    expect(used).toEqual(new Set([...MCP_OPERATIONS, ...OAUTH_OPERATIONS]));
  });

  it("leaves naming to the library: the upstream names a request by its method alone", () => {
    expect(upstream.operationOf("POST", ENDPOINT)).toBe("POST");
    expect(upstream.operationOf("GET", `${AUTH}/.well-known/oauth-authorization-server`))
      .toBe("GET");
  });
});

describe("what a JSON-RPC request is counted as", () => {
  it("counts a JSON-RPC error inside a 200 as an api error", async () => {
    platform(sent => json({
      jsonrpc: "2.0", id: sent.id, error: { code: -32602, message: "bad arguments" },
    }));
    await expect(client().callTool("create_issue", {})).rejects.toBeInstanceOf(McpProtocolError);
    expect(counted()).toEqual([["tools.call", "error", "api", 200]]);
    expect(points.map(point => column(point, SUBSERVICE_V1_SLOTS.providerCode))).toEqual([0]);
  });

  it("counts a tool's own failure, which arrives as a result, as a success", async () => {
    mcpServer(() => ({ isError: true, content: [] }));
    await expect(client().callTool("create_issue", {})).resolves.toMatchObject({ isError: true });
    expect(counted()).toEqual([["tools.call", "success", "", 200]]);
  });

  it.each([
    [401, undefined],
    [403, undefined],
    [404, "session"],
    [500, undefined],
  ])("counts a %i by its status and sends the request once", async (status, sessionId) => {
    const requests = platform(() => new Response("refused", { status }));
    await expect(client(undefined, sessionId).callTool("create_issue", {})).rejects.toThrow();
    expect(requests).toHaveLength(1);
    expect(counted()).toEqual([["tools.call", "error", "http", status]]);
  });

  it.each([429, 502, 503, 504])("never sends a tools/call again after a %i", async status => {
    const requests = platform(() => new Response("", { status, headers: { "Retry-After": "0" } }));
    await expect(client().callTool("create_issue", {})).rejects.toThrow(`HTTP ${status}`);
    expect(requests).toHaveLength(1);
    expect(points).toHaveLength(1);
  });

  it("counts a failed connection as a network error and sends the request once", async () => {
    const requests = platform(() => { throw new TypeError("connection reset"); });
    await expect(client().listTools(10)).rejects.toThrow("connection reset");
    expect(requests).toHaveLength(1);
    expect(counted()).toEqual([["tools.list", "error", "network", 0]]);
  });

  it("counts a 200 that holds no JSON-RPC answer as a parse error", async () => {
    platform(() => new Response("<html>", { headers: { "Content-Type": "text/html" } }));
    await expect(client().callTool("create_issue", {})).rejects.toThrow(/non-JSON/);
    expect(counted()).toEqual([["tools.call", "error", "parse", 200]]);
  });

  it("writes the pages of one listing as one point", async () => {
    let page = 0;
    const requests = mcpServer(() => (++page < 3 ? { tools: [], nextCursor: `${page}` } : { tools: [] }));
    await client().listTools(10);
    expect(requests).toHaveLength(3);
    expect(counted()).toEqual([["tools.list", "success", "", 200]]);
    expect(points.map(point => column(point, SUBSERVICE_V1_SLOTS.calls))).toEqual([3]);
  });

  it("puts no timeout on a JSON-RPC request and the default on the session's DELETE", async () => {
    const requests = mcpServer(() => ({ content: [] }));
    const session = client(undefined, "session");
    await session.callTool("create_issue", {});
    await session.closeSession();
    expect(requests.map(sent => [sent.method, sent.signal !== undefined])).toEqual([
      ["POST", false], ["DELETE", true],
    ]);
  });
});

// What `call` threw, or undefined where it threw nothing.
async function thrownBy(call: () => Promise<unknown>): Promise<unknown> {
  try {
    await call();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("a page of tools the listing refuses", () => {
  it.each<[string, unknown]>([["a number", 7], ["null", null], ["an object", { after: "2" }]])(
    "counts a page whose cursor is %s as an api error, sent once and failing as the listing does", async (_kind, nextCursor) => {
      const requests = mcpServer(() => ({ tools: [{ name: "search" }], nextCursor }));

      const failure = await thrownBy(() => client().listTools(10));

      expect(Object.getPrototypeOf(failure)).toBe(McpProtocolError.prototype);
      expect(failure).toMatchObject({
        message: 'MCP server returned an invalid "tools/list" cursor.', code: undefined, outcome: "unknown",
      });
      expect(requests).toHaveLength(1);
      expect(counted()).toEqual([["tools.list", "error", "api", 200]]);
    });

  it("counts the page before it a success, and each page once", async () => {
    let page = 0;
    const requests = mcpServer(() => (++page === 1 ? { tools: [], nextCursor: "2" } : { tools: [], nextCursor: 3 }));

    await expect(client().listTools(10)).rejects.toThrow('MCP server returned an invalid "tools/list" cursor.');

    expect(requests).toHaveLength(2);
    expect(counted()).toEqual([["tools.list", "success", "", 200], ["tools.list", "error", "api", 200]]);
    expect(points.map(point => column(point, SUBSERVICE_V1_SLOTS.calls))).toEqual([1, 1]);
  });

  it("counts a page a success where the listing ends before it reads the page's cursor", async () => {
    const requests = mcpServer(() => ({ tools: [{ name: "search" }, { name: "fetch" }], nextCursor: 7 }));

    await expect(client().listMatchingToolIndex(1, () => true))
      .resolves.toEqual({ tools: [{ name: "search" }], truncated: true });

    expect(requests).toHaveLength(1);
    expect(counted()).toEqual([["tools.list", "success", "", 200]]);
  });

  it.each<[string, Record<string, unknown>, string]>([
    ["holds no result", {}, "Cannot read properties of undefined (reading 'tools')"],
    ["holds null for its result", { result: null }, "Cannot read properties of null (reading 'tools')"],
  ])("counts a page that %s as an api error, sent once and failing as the listing does", async (_kind, answer, message) => {
    const requests = platform(sent => json({ jsonrpc: "2.0", id: sent.id, ...answer }));

    const failure = await thrownBy(() => client().listTools(10));

    expect(Object.getPrototypeOf(failure)).toBe(TypeError.prototype);
    expect(failure).toMatchObject({ message });
    expect(requests).toHaveLength(1);
    expect(counted()).toEqual([["tools.list", "error", "api", 200]]);
  });

  it.each<[string, unknown]>([
    ["an object for its tools", { tools: {} }],
    ["one tool for its tools", { tools: { name: "search" } }],
    ["null for its tools", { tools: null }],
    ["no tools", {}],
    ["no tools beside a cursor", { nextCursor: "2" }],
  ])("counts a page whose result holds %s as an api error, sent once and failing as the listing does", async (_kind, result) => {
    const requests = mcpServer(() => result);

    const failure = await thrownBy(() => client().listTools(10));

    expect(Object.getPrototypeOf(failure)).toBe(McpProtocolError.prototype);
    expect(failure).toMatchObject({
      message: 'MCP server returned a "tools/list" result with no tools array.', code: undefined, outcome: "unknown",
    });
    expect(requests).toHaveLength(1);
    expect(counted()).toEqual([["tools.list", "error", "api", 200]]);
  });

  it("counts a page whose tools are an empty array as a success: a listing of no tools", async () => {
    const requests = mcpServer(() => ({ tools: [] }));

    await expect(client().listTools(10)).resolves.toEqual({ tools: [], truncated: false });

    expect(requests).toHaveLength(1);
    expect(counted()).toEqual([["tools.list", "success", "", 200]]);
  });

  it("fails the search for one tool as the listing does, where a page holds no array of tools", async () => {
    const requests = mcpServer(() => ({ tools: {} }));

    await expect(client().findTool("search"))
      .rejects.toThrow('MCP server returned a "tools/list" result with no tools array.');

    expect(requests).toHaveLength(1);
    expect(counted()).toEqual([["tools.list", "error", "api", 200]]);
  });

  it("counts the page before one that holds no array of tools a success, and each page once", async () => {
    let page = 0;
    const requests = mcpServer(() => (++page === 1 ? { tools: [{ name: "search" }], nextCursor: "2" } : { tools: {} }));

    await expect(client().listTools(10))
      .rejects.toThrow('MCP server returned a "tools/list" result with no tools array.');

    expect(requests).toHaveLength(2);
    expect(counted()).toEqual([["tools.list", "success", "", 200], ["tools.list", "error", "api", 200]]);
  });

  it("counts a page a success where the listing stops at its own scan limit", async () => {
    const tools = Array.from({ length: 5001 }, (_, index) => ({ name: `tool-${index}` }));
    const requests = mcpServer(() => ({ tools }));

    const failure = await thrownBy(() => client().findTool("absent"));

    expect(failure).toMatchObject({ message: "MCP tool discovery exceeded its scan budget.", outcome: "declined" });
    expect(requests).toHaveLength(1);
    expect(counted()).toEqual([["tools.list", "success", "", 200]]);
  });

  it("counts a page a success where the caller's filter throws on it, and throws what the filter threw", async () => {
    const requests = mcpServer(() => ({ tools: [{ name: "search" }] }));
    const refused = new RangeError("The filter takes no such tool.");

    expect(await thrownBy(() => client().listTools(10, () => { throw refused; }))).toBe(refused);

    expect(requests).toHaveLength(1);
    expect(counted()).toEqual([["tools.list", "success", "", 200]]);
  });

  it("counts a call an api error where its answer holds no result, which the client hands on", async () => {
    platform(sent => json({ jsonrpc: "2.0", id: sent.id }));

    await expect(client().callTool("create_issue", {})).resolves.toBeUndefined();

    expect(counted()).toEqual([["tools.call", "error", "api", 200]]);
  });

  it.each<[string, unknown]>([
    ["content that is no list", { content: {} }],
    ["content that holds what is no block", { content: [null] }],
  ])("counts a call an api error where its result has %s, and hands the result on for its reader to refuse", async (_name, result) => {
    const requests = platform(sent => json({ jsonrpc: "2.0", id: sent.id, result }));

    const handed = await client().callTool("create_issue", {});

    // The result as it came: the call was sent once, and what reads it throws as it did.
    expect(handed).toEqual(result);
    expect(() => toCallResult(handed)).toThrow(TypeError);
    expect(requests).toHaveLength(1);
    expect(counted()).toEqual([["tools.call", "error", "api", 200]]);
  });

  it.each<[string, unknown]>([
    ["a tool's own failure", { content: [{ type: "text", text: "no such issue" }], isError: true }],
    ["no content", {}],
  ])("counts a call a success where its result is %s", async (_name, result) => {
    platform(sent => json({ jsonrpc: "2.0", id: sent.id, result }));

    expect(await client().callTool("create_issue", {})).toEqual(result);

    expect(counted()).toEqual([["tools.call", "success", "", 200]]);
  });
});

// An answer whose body is `body`, as a JSON document.
function jsonDocument(body: string): Response {
  return new Response(body, { headers: { "Content-Type": "application/json" } });
}

// A JSON-RPC reply to the request `sent`, holding `members` beside the request's id.
function replyTo(sent: Sent, members: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: "2.0", id: sent.id, ...members });
}

// The two forms a server answers a POST in.
const REPLY_FORMS: [form: string, answer: (reply: string) => Response][] = [
  ["a JSON document", reply => new Response(reply, { headers: { "Content-Type": "application/json" } })],
  ["an event stream", reply => new Response(`event: message\ndata: ${reply}\n\n`, {
    headers: { "Content-Type": "text/event-stream" },
  })],
];

// Replies with the request's id that hold neither a result nor an error, with what the client
// hands on for each and what a reader of that says it cannot read.
const EMPTY_REPLIES: [kind: string, members: Record<string, unknown>, handedOn: undefined | null, reads: string][] = [
  ["no result", {}, undefined, "undefined"],
  ["null for its result", { result: null }, null, "null"],
  ["null for its result and for its error", { result: null, error: null }, null, "null"],
];

describe.each(REPLY_FORMS)("a reply in %s that holds neither a result nor an error", (_form, answer) => {
  it.each(EMPTY_REPLIES)(
    "counts a tools/call answered %s as an api error, sent once and handed on as it came", async (_kind, members, handedOn, reads) => {
      const requests = platform(sent => answer(replyTo(sent, members)));

      const result = await client().callTool("create_issue", {});

      expect(result).toBe(handedOn);
      // What the reader of a tool's result then throws, for a read and for an applied write.
      const refusal = await thrownBy(async () => toCallResult(result));
      expect(Object.getPrototypeOf(refusal)).toBe(TypeError.prototype);
      expect(refusal).toMatchObject({ message: `Cannot read properties of ${reads} (reading 'content')` });
      expect(requests.map(sent => sent.rpc)).toEqual(["tools/call"]);
      expect(counted()).toEqual([["tools.call", "error", "api", 200]]);
    });

  it.each(EMPTY_REPLIES)(
    "counts an initialize answered %s as an api error, and sends its notification as after any answer", async (_kind, members, handedOn) => {
      const requests = platform(sent => (sent.id === undefined
        ? new Response(null, { status: 202 }) : answer(replyTo(sent, members))));

      await expect(client().initialize("Gadgets")).resolves.toBe(handedOn);

      expect(requests.map(sent => sent.rpc)).toEqual(["initialize", "notifications/initialized"]);
      expect(counted()).toEqual([
        ["initialize", "error", "api", 200], ["notifications.initialized", "success", "", 202],
      ]);
    });

  it.each<[string, unknown]>([
    ["a name that is no string", { serverInfo: { name: 42, version: "1.0" } }],
    ["a server that is no object", { serverInfo: "server" }],
    ["a result that is no object", 5],
  ])("counts an initialize whose result holds %s as an api error, and sends nothing more", async (_kind, result) => {
    const requests = platform(sent => (sent.id === undefined
      ? new Response(null, { status: 202 }) : answer(replyTo(sent, { result }))));

    await expect(client().initialize("Gadgets")).rejects.toMatchObject({
      name: "McpProtocolError", message: "MCP server returned an unusable initialize result.",
    });

    expect(requests.map(sent => sent.rpc)).toEqual(["initialize"]);
    expect(counted()).toEqual([["initialize", "error", "api", 200]]);
  });

  it("counts an initialize whose server names itself by nothing as a success", async () => {
    platform(sent => (sent.id === undefined
      ? new Response(null, { status: 202 }) : answer(replyTo(sent, { result: { protocolVersion: "2025-06-18", capabilities: {} } }))));

    await expect(client().initialize("Gadgets")).resolves.toMatchObject({ capabilities: {} });

    expect(counted()).toEqual([["initialize", "success", "", 200], ["notifications.initialized", "success", "", 202]]);
  });

  it.each<[string, unknown]>([["false", false], ["zero", 0], ["an empty string", ""], ["an empty object", {}]])(
    "counts a tools/call answered %s for its result as a success: the reply holds a result", async (_kind, result) => {
      const requests = platform(sent => answer(replyTo(sent, { result })));

      await expect(client().callTool("create_issue", {})).resolves.toEqual(result);

      expect(requests).toHaveLength(1);
      expect(counted()).toEqual([["tools.call", "success", "", 200]]);
    });

  it("counts a tool's own failure as a success: its reply holds a result", async () => {
    platform(sent => answer(replyTo(sent, { result: { isError: true, content: [] } })));

    await expect(client().callTool("create_issue", {})).resolves.toEqual({ isError: true, content: [] });

    expect(counted()).toEqual([["tools.call", "success", "", 200]]);
  });

  it("counts a reply that holds an error and no result as that error, with its code", async () => {
    platform(sent => answer(replyTo(sent, { error: { code: -32603, message: "internal" } })));

    const failure = await thrownBy(() => client().callTool("create_issue", {}));

    expect(failure).toMatchObject({ name: "McpProtocolError", code: -32603, outcome: "unknown" });
    expect(counted()).toEqual([["tools.call", "error", "api", 200]]);
  });
});

describe("a reply with no result, by what the request asks for", () => {
  // Bodies that the client takes for the reply to its request though they name no request: none
  // holds an id of another request, and none holds a result or an error.
  const UNADDRESSED: [kind: string, body: string][] = [
    ["an object that holds no id, result or error", "{}"],
    ["an object whose id is null", JSON.stringify({ jsonrpc: "2.0", id: null })],
    ["a list", "[]"],
    ["a number", "5"],
  ];

  it.each(UNADDRESSED)("counts a JSON document that is %s as an api error of the call, sent once and handed on as no result", async (_kind, body) => {
    const requests = platform(() => jsonDocument(body));

    await expect(client().callTool("create_issue", {})).resolves.toBeUndefined();

    expect(requests.map(sent => sent.rpc)).toEqual(["tools/call"]);
    expect(counted()).toEqual([["tools.call", "error", "api", 200]]);
  });

  it.each(UNADDRESSED)("counts a JSON document that is %s as an api error of the handshake, which goes on to its notification", async (_kind, body) => {
    const requests = platform(sent => (sent.id === undefined ? new Response(null, { status: 202 }) : jsonDocument(body)));

    await expect(client().initialize("Gadgets")).resolves.toBeUndefined();

    expect(requests.map(sent => sent.rpc)).toEqual(["initialize", "notifications/initialized"]);
    expect(counted()).toEqual([
      ["initialize", "error", "api", 200], ["notifications.initialized", "success", "", 202],
    ]);
  });

  it.each(UNADDRESSED)("takes an event stream whose only event is %s for one with no reply, which fails the call unread", async (_kind, body) => {
    const requests = platform(() => new Response(`event: message\ndata: ${body}\n\n`, {
      headers: { "Content-Type": "text/event-stream" },
    }));

    const failure = await thrownBy(() => client().callTool("create_issue", {}));

    expect(Object.getPrototypeOf(failure)).toBe(McpProtocolError.prototype);
    expect(failure).toMatchObject({ message: "MCP server's event stream contained no response to the request." });
    expect(requests).toHaveLength(1);
    expect(counted()).toEqual([["tools.call", "error", "parse", 200]]);
  });

  it("counts a notification by its status alone: it asks for no reply, so a body with no result is none refused", async () => {
    const requests = platform(sent => (sent.id === undefined
      ? json({ jsonrpc: "2.0" }) : json({ jsonrpc: "2.0", id: sent.id, result: {} })));

    await client().initialize("Gadgets");

    expect(requests.map(sent => sent.rpc)).toEqual(["initialize", "notifications/initialized"]);
    expect(counted()).toEqual([
      ["initialize", "success", "", 200], ["notifications.initialized", "success", "", 200],
    ]);
  });

  describe("a page that takes a listing past the bytes it scans", () => {
    const MIB = 1024 * 1024;

    // A page of the listing whose reply is a mebibyte long and names a page after it.
    function mebibyte(sent: Sent): Response {
      const reply = (padding: string) => replyTo(sent, { result: { tools: [], nextCursor: "next", padding } });
      return jsonDocument(reply("x".repeat(MIB - reply("").length)));
    }

    // A server whose first four pages fill the four mebibytes a listing scans to the byte, and
    // whose fifth page, which takes the listing past them, holds `members`.
    const pastTheScan = (members: Record<string, unknown>) => {
      let page = 0;
      return platform(sent => (++page === 5 ? jsonDocument(replyTo(sent, members)) : mebibyte(sent)));
    };

    it.each<[string, Record<string, unknown>]>([["no result", {}], ["null for its result", { result: null }]])(
      "counts one that holds %s as an api error, though the listing ends at its scan limit before it reads the page", async (_kind, members) => {
        const requests = pastTheScan(members);

        await expect(client().listTools(10)).resolves.toEqual({ tools: [], truncated: true });

        expect(requests.map(sent => sent.rpc)).toEqual(Array.from({ length: 5 }, () => "tools/list"));
        expect(operations()).toEqual(["tools.list", "tools.list"]);
        expect(summed()).toEqual([["success", "", 200, 4], ["error", "api", 200, 1]]);
      });

    it("counts one that holds no result as an api error where the listing must scan to its end, and fails as at its scan limit", async () => {
      const requests = pastTheScan({});

      const failure = await thrownBy(() => client().findTool("absent"));

      expect(failure).toMatchObject({ message: "MCP tool discovery exceeded its scan budget.", outcome: "declined" });
      expect(requests).toHaveLength(5);
      expect(summed()).toEqual([["success", "", 200, 4], ["error", "api", 200, 1]]);
    });

    it("counts one that holds a result as a success: the scan limit is the listing's own", async () => {
      const requests = pastTheScan({ result: { tools: [{ name: "search" }] } });

      await expect(client().listTools(10)).resolves.toEqual({ tools: [], truncated: true });

      expect(requests).toHaveLength(5);
      expect(summed()).toEqual([["success", "", 200, 5]]);
    });
  });

  it("counts each page of a listing by its own reply: one with no result after one with tools", async () => {
    let page = 0;
    const requests = platform(sent => (++page === 1
      ? json({ jsonrpc: "2.0", id: sent.id, result: { tools: [], nextCursor: "2" } })
      : json({ jsonrpc: "2.0", id: sent.id })));

    const failure = await thrownBy(() => client().listTools(10));

    expect(Object.getPrototypeOf(failure)).toBe(TypeError.prototype);
    expect(failure).toMatchObject({ message: "Cannot read properties of undefined (reading 'tools')" });
    expect(requests).toHaveLength(2);
    expect(counted()).toEqual([["tools.list", "success", "", 200], ["tools.list", "error", "api", 200]]);
  });
});

// What resolving a binding's catalog is handed: a store of its own, and a log that keeps the
// event of each warning.
function binding() {
  const stored = new Map<string, unknown>();
  const warned: unknown[] = [];
  const log: CatalogRequest["log"] = {
    debug() {}, info() {}, error() {}, with() { return log; },
    warn(_message, fields) { warned.push(fields?.event); },
  };
  const account: ConnectionAccount = {
    async getConnection() { return { authorization: "token", sessionId: "session", generation: 1 }; },
    async assertConnectionCurrent() {},
    async setMcpSessionId() { return true; },
    async noteCredentialsExpired() {},
  };
  const request: CatalogRequest = {
    store: {
      get: <T>(key: string) => stored.get(key) as T | undefined,
      put: (key, value) => { stored.set(key, value); },
    },
    log, upstream, env: {}, account, endpoint: ENDPOINT, scope: {}, trust: "byo",
  };
  return { request, stored, warned };
}

// The names of the tools a binding's catalog resolves to.
const names = async (request: CatalogRequest) => (await scopedCatalog(request)).tools.map(({ tool }) => tool.name);

describe("a binding's catalog whose refresh the listing refuses", () => {
  afterEach(() => vi.useRealTimers());

  it.each<[string, unknown]>([
    ["an object for its tools", { tools: {} }],
    ["no tools", {}],
  ])("keeps the catalog it has cached where the refresh is answered a result that holds %s", async (_kind, refused) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { request, stored, warned } = binding();
    let result: unknown = { tools: [{ name: "search" }, { name: "fetch" }] };
    const requests = mcpServer(() => result);
    expect(await names(request)).toEqual(["search", "fetch"]);
    const cached = structuredClone(stored.get("catalog"));

    vi.setSystemTime(Date.now() + CATALOG_TTL_MS + 1);
    result = refused;

    expect(await names(request)).toEqual(["search", "fetch"]);
    expect(stored.get("catalog")).toEqual(cached);
    expect(warned).toEqual(["catalog.refresh.failed"]);
    expect(requests).toHaveLength(2);
    expect(counted()).toEqual([["tools.list", "success", "", 200], ["tools.list", "error", "api", 200]]);
  });

  it("adopts a refresh answered an empty array of tools: the endpoint lists none", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { request, warned } = binding();
    let result: unknown = { tools: [{ name: "search" }] };
    mcpServer(() => result);
    expect(await names(request)).toEqual(["search"]);

    vi.setSystemTime(Date.now() + CATALOG_TTL_MS + 1);
    result = { tools: [] };

    expect(await names(request)).toEqual([]);
    expect(warned).toEqual([]);
    expect(counted()).toEqual([["tools.list", "success", "", 200], ["tools.list", "success", "", 200]]);
  });

  it("throws the listing's refusal where there is no catalog cached to keep", async () => {
    const { request, stored } = binding();
    mcpServer(() => ({ tools: {} }));

    await expect(scopedCatalog(request))
      .rejects.toThrow('MCP server returned a "tools/list" result with no tools array.');

    expect(stored.has("catalog")).toBe(false);
    expect(counted()).toEqual([["tools.list", "error", "api", 200]]);
  });
});

describe("the operation's deadline as the only limit", () => {
  it("puts no timeout of the client's on the session's DELETE or on an OAuth request", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    mcpServer();
    await client({ timeoutMs: 120_000 }, "session").closeSession();
    await sdkFetch(upstream, { timeoutMs: 120_000 })(`${AUTH}/metadata`);
    const waits = timeout.mock.calls.map(([ms]) => ms);
    // Each request's signals wait for the deadline two minutes away, and none for 30 seconds.
    expect(waits.length).toBeGreaterThanOrEqual(2);
    expect(Math.min(...waits)).toBeGreaterThan(100_000);
  });

  it("counts an answer the deadline cut off while it was read as a timeout", async () => {
    // The signals that wait for the deadline, in the order they are made: the request's, which
    // the upstream reads as its caller's wait, then the guard's.
    const waits: AbortController[] = [];
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      const wait = new AbortController();
      waits.push(wait);
      return wait.signal;
    });
    const requests = platform(sent => new Response(new ReadableStream({
      start(controller) {
        sent.signal?.addEventListener("abort", () => controller.error(sent.signal?.reason), { once: true });
      },
    }), { headers: { "Content-Type": "application/json" } }));

    const failed = expect(client({ timeoutMs: 60_000 }).callTool("create_issue", {})).rejects.toThrow();
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    waits[0]?.abort(new DOMException("The operation timed out.", "TimeoutError"));
    await failed;

    expect(waits).toHaveLength(2);
    expect(counted()).toEqual([["tools.call", "error", "timeout", 200]]);
  });

  it("counts an attempt the guard's own timer cut off as a timeout, sent once", async () => {
    const requests = platform(sent => new Promise<Response>((_resolve, reject) => {
      sent.signal?.addEventListener("abort", () => reject(sent.signal?.reason), { once: true });
    }));
    // No signal of the request's own: only the guard waits for the deadline.
    await expect(guardedUpstream(upstream, { timeoutMs: 20 }).request(ENDPOINT, {
      method: "POST", operation: "tools.call", timeoutMs: null,
    })).rejects.toThrow(/timeout/i);
    expect(requests).toHaveLength(1);
    expect(counted()).toEqual([["tools.call", "error", "timeout", 0]]);
  });
});

describe("the guard as the upstream's fetch", () => {
  it("neither counts nor sends a request the guard refuses", async () => {
    const requests = mcpServer();
    const refused = new McpClient(upstream, "http://169.254.169.254/mcp", async () => null);
    await expect(refused.callTool("create_issue", {})).rejects.toThrow(/Refusing to contact/);
    await expect(sdkFetch(upstream)("http://169.254.169.254/latest/meta-data/"))
      .rejects.toBeInstanceOf(FetchNotStartedError);
    await expect(upstream.request("http://localhost:8787/mcp"))
      .rejects.toBeInstanceOf(FetchNotStartedError);
    expect(requests).toHaveLength(0);
    expect(points).toHaveLength(0);
  });

  it("counts a guarded request once, the redirect it followed included", async () => {
    const requests = platform(sent => (sent.url === ENDPOINT
      ? new Response("", { status: 307, headers: { Location: `${ENDPOINT}/v2` } })
      : json({ jsonrpc: "2.0", id: sent.id, result: { content: [] } })));
    await client().callTool("create_issue", {});
    expect(requests.map(sent => sent.url)).toEqual([ENDPOINT, `${ENDPOINT}/v2`]);
    expect(counted()).toEqual([["tools.call", "success", "", 200]]);
  });

  it("counts a redirect the guard would not follow as an error", async () => {
    const requests = platform(() => new Response("", {
      status: 307, headers: { Location: "http://169.254.169.254/" },
    }));
    await expect(client().callTool("create_issue", {})).rejects.toThrow("HTTP 307");
    expect(requests).toHaveLength(1);
    expect(counted()).toEqual([["tools.call", "error", "http", 307]]);
  });

  it("counts a request its operation's deadline cut off as a timeout, sent once", async () => {
    const requests = platform(sent => new Promise<Response>((_resolve, reject) => {
      sent.signal?.addEventListener("abort", () => reject(sent.signal?.reason), { once: true });
    }));
    await expect(client({ timeoutMs: 20 }).listTools(10)).rejects.toThrow(/timeout/i);
    await expect(sdkFetch(upstream, { timeoutMs: 20 })(`${AUTH}/metadata`))
      .rejects.toThrow(/timeout/i);
    expect(requests.map(sent => sent.method)).toEqual(["POST", "GET"]);
    expect(counted()).toEqual([
      ["tools.list", "error", "timeout", 0], ["metadata.resource", "error", "timeout", 0],
    ]);
  });
});

describe("what an OAuth request is counted as", () => {
  // The SDK reads such an answer as its cue to ask at another URL.
  it.each([429, 502, 503, 504])("hands the SDK a metadata GET answered %i as it came, sent once", async status => {
    const requests = platform(() => new Response("", { status, headers: { "Retry-After": "0" } }));
    const response = await sdkFetch(upstream)(`${AUTH}/.well-known/oauth-authorization-server`);
    expect(response.status).toBe(status);
    expect(requests).toHaveLength(1);
    expect(operations()).toEqual(["metadata.server"]);
  });

  it("sends a metadata GET that gets no answer once, and throws what it met", async () => {
    const requests = platform(() => { throw new TypeError("connection reset"); });
    await expect(sdkFetch(upstream)(`${AUTH}/.well-known/oauth-authorization-server`)).rejects.toThrow();
    expect(requests).toHaveLength(1);
  });

  it.each([429, 502, 503, 504])("never sends a token request again after a %i", async status => {
    const requests = platform(() => new Response("", { status, headers: { "Retry-After": "0" } }));
    const response = await sdkFetch(upstream)(`${AUTH}/token`, {
      method: "POST", body: new URLSearchParams({ grant_type: "refresh_token" }),
    });
    expect(response.status).toBe(status);
    expect(requests).toHaveLength(1);
    expect(operations()).toEqual(["token.refresh"]);
  });

  it("counts an OAuth error inside a 200 as an api error", async () => {
    platform(() => json({ error: "invalid_grant" }));
    const response = await sdkFetch(upstream)(`${AUTH}/token`, {
      method: "POST", body: new URLSearchParams({ grant_type: "authorization_code" }),
    });
    expect(await response.json()).toEqual({ error: "invalid_grant" });
    expect(counted()).toEqual([["token.exchange", "error", "api", 200]]);
  });

  it("counts an OAuth error with its own status by that status", async () => {
    platform(() => json({ error: "invalid_grant" }, { status: 400 }));
    await sdkFetch(upstream, {}, "token.refresh")(`${AUTH}/token`, {
      method: "POST", body: new URLSearchParams({ grant_type: "refresh_token" }),
    });
    expect(counted()).toEqual([["token.refresh", "error", "http", 400]]);
  });

  it("counts an answer larger than the response limit as a parse error", async () => {
    platform(() => new Response("x".repeat(2 * 1024 * 1024 + 1)));
    await expect(sdkFetch(upstream)(`${AUTH}/metadata`)).rejects.toThrow(/response exceeded/i);
    expect(counted()).toEqual([["metadata.resource", "error", "parse", 200]]);
  });
});

// The SDK's own exchange of an authorization code, through the adapter.
function exchange(): Promise<unknown> {
  return exchangeAuthorization(AUTH, {
    metadata: METADATA,
    clientInformation: { client_id: "client" },
    authorizationCode: "code",
    codeVerifier: "verifier",
    redirectUri: "https://gatekeeper.example/oauth",
    fetchFn: sdkFetch(upstream),
  });
}

// The SDK's own refresh, through the adapter, named as the account names its refresh.
function refresh(): Promise<unknown> {
  return refreshAuthorization(AUTH, {
    metadata: METADATA,
    clientInformation: { client_id: "client" },
    refreshToken: "refresh",
    fetchFn: sdkFetch(upstream, {}, "token.refresh"),
  });
}

const TOKEN_REQUESTS: [operation: string, request: () => Promise<unknown>][] = [
  ["token.exchange", exchange], ["token.refresh", refresh],
];

// Bodies a token endpoint may answer a 200 with, and the reason each is counted an error under:
// none for one the SDK takes tokens from.
const TOKEN_REPLIES: [kind: string, body: string, reason: "" | "parse" | "api"][] = [
  ["a token response", JSON.stringify(TOKENS), ""],
  ["a token response whose lifetime is a string of digits",
    JSON.stringify({ ...TOKENS, expires_in: "3600" }), ""],
  ["a token response beside an error member",
    JSON.stringify({ ...TOKENS, error: "temporarily_unavailable" }), ""],
  ["a token response behind two byte order marks", `\uFEFF\uFEFF${JSON.stringify(TOKENS)}`, ""],
  ["a page that is no JSON", "<html>Sign in</html>", "parse"],
  ["no body", "", "parse"],
  ["JSON that is cut short", '{"access_token":"acc', "parse"],
  ["an empty object", "{}", "api"],
  ["no access token", JSON.stringify({ token_type: "Bearer", refresh_token: "refresh" }), "api"],
  ["no token type", JSON.stringify({ access_token: "access" }), "api"],
  ["an access token that is no string",
    JSON.stringify({ access_token: 1, token_type: "Bearer" }), "api"],
  ["a lifetime that is no number", JSON.stringify({ ...TOKENS, expires_in: "soon" }), "api"],
  ["an array", "[]", "api"],
  ["null", "null", "api"],
  ["an OAuth error", JSON.stringify({ error: "invalid_grant" }), "api"],
];

// A 200 with `body`, declared JSON as a token endpoint declares it.
function answered(body: string): Response {
  return new Response(body, { headers: { "Content-Type": "application/json" } });
}

// Whether the SDK's call was rejected.
function rejected(call: Promise<unknown>): Promise<boolean> {
  return call.then(() => false, () => true);
}

describe.each(TOKEN_REQUESTS)("a 200 that answers the SDK's %s", (operation, request) => {
  it.each(TOKEN_REPLIES)("counts %s as the SDK reads it", async (_kind, body, reason) => {
    const requests = platform(() => answered(body));
    expect(await rejected(request())).toBe(reason !== "");
    expect(requests).toHaveLength(1);
    expect(counted()).toEqual([[operation, reason === "" ? "success" : "error", reason, 200]]);
  });
});

describe("a reply the SDK cannot use, as the SDK is handed it", () => {
  it("hands the SDK a 200 that is no JSON with its status, headers and body", async () => {
    platform(() => new Response("<html>Sign in</html>", {
      status: 200, statusText: "OK", headers: { "Content-Type": "text/html", "X-Request": "one" },
    }));
    const response = await sdkFetch(upstream)(`${AUTH}/token`, {
      method: "POST", body: new URLSearchParams({ grant_type: "refresh_token" }),
    });
    expect([response.status, response.statusText]).toEqual([200, "OK"]);
    expect(Object.fromEntries(response.headers)).toEqual({
      "content-type": "text/html", "x-request": "one",
    });
    expect(await response.text()).toBe("<html>Sign in</html>");
    expect(counted()).toEqual([["token.refresh", "error", "parse", 200]]);
  });

  it("leaves the SDK its own error for each reply it rejects", async () => {
    platform(() => answered(JSON.stringify({ error: "invalid_grant" })));
    const refused = await refresh().catch((error: unknown) => error);
    expect(OAuthError.isInstance(refused) && refused.code).toBe("invalid_grant");

    platform(() => answered("<html>Sign in</html>"));
    await expect(refresh()).rejects.toBeInstanceOf(SyntaxError);

    platform(() => answered("{}"));
    await expect(refresh()).rejects.toThrow(/access_token/);
  });

  it("counts a token reply of any other status by that status, whatever its body", async () => {
    platform(() => new Response("<html>Bad request</html>", { status: 400 }));
    expect(await rejected(refresh())).toBe(true);
    expect(counted()).toEqual([["token.refresh", "error", "http", 400]]);
  });

  it("counts a revocation by its status, whatever its body", async () => {
    platform(() => new Response("<html>Revoked</html>"));
    await revokeToken(
      { authorizationServerUrl: AUTH, authorizationServerMetadata: METADATA },
      { client_id: "client" }, "refresh", "refresh_token",
      sdkFetch(upstream, {}, "token.revoke"));
    expect(counted()).toEqual([["token.revoke", "success", "", 200]]);
  });
});

// The documents the SDK's discovery and registration read, each asked for as the SDK asks.
const REGISTRATION = { redirect_uris: ["https://gatekeeper.example/oauth"] };
const OPENID_METADATA = {
  ...METADATA,
  jwks_uri: `${AUTH}/keys`,
  subject_types_supported: ["public"],
  id_token_signing_alg_values_supported: ["RS256"],
};
const DOCUMENTS: [operation: string, request: () => Promise<unknown>, document: unknown][] = [
  ["metadata.resource",
    () => discoverOAuthProtectedResourceMetadata(ENDPOINT, undefined, sdkFetch(upstream)),
    { resource: ENDPOINT, authorization_servers: [AUTH] }],
  ["metadata.server",
    () => discoverAuthorizationServerMetadata(AUTH, { fetchFn: sdkFetch(upstream) }), METADATA],
  ["client.register", () => registerClient(AUTH, {
    metadata: METADATA, clientMetadata: REGISTRATION, fetchFn: sdkFetch(upstream),
  }), { client_id: "client", ...REGISTRATION }],
];

describe.each(DOCUMENTS)("a 200 that answers the SDK's %s", (operation, request, document) => {
  it.each([
    ["the document", JSON.stringify(document), ""],
    ["a page that is no JSON", "<html>Not found</html>", "parse"],
    ["no body", "", "parse"],
    ["JSON that is not the document", "{}", "api"],
    ["an OAuth error", JSON.stringify({ error: "server_error" }), "api"],
    ["an array", "[]", "api"],
  ])("counts %s as the SDK reads it", async (_kind, body, reason) => {
    const requests = platform(() => answered(body));
    expect(await rejected(request())).toBe(reason !== "");
    expect(requests).toHaveLength(1);
    expect(counted()).toEqual([[operation, reason === "" ? "success" : "error", reason, 200]]);
  });
});

describe("a registration answered 201, the status a server creates a client with", () => {
  it.each([
    ["the client's information", JSON.stringify({ client_id: "client", ...REGISTRATION }), ""],
    ["a page that is no JSON", "<html>Created</html>", "parse"],
    ["JSON that is no client's information", "{}", "api"],
  ])("counts %s as the SDK reads it", async (_kind, body, reason) => {
    platform(() => new Response(body, { status: 201 }));
    const registration = registerClient(AUTH, {
      metadata: METADATA, clientMetadata: REGISTRATION, fetchFn: sdkFetch(upstream),
    });
    expect(await rejected(registration)).toBe(reason !== "");
    expect(counted()).toEqual([
      ["client.register", reason === "" ? "success" : "error", reason, 201],
    ]);
  });
});

// A server whose OAuth well-known URL answers 404, so that the SDK goes on to the OpenID Connect
// one, which answers a 200 with `body`.
function openIdServer(body: string): Sent[] {
  return platform(sent => (sent.url.includes("openid-configuration")
    ? answered(body) : new Response("", { status: 404 })));
}

describe("the metadata of an authorization server, by the document its URL names", () => {
  it.each([
    ["an OpenID Connect provider's metadata", JSON.stringify(OPENID_METADATA), ""],
    ["OAuth metadata that is no OpenID Connect provider's", JSON.stringify(METADATA), "api"],
    ["a page that is no JSON", "<html>Not found</html>", "parse"],
  ])("counts %s at the OpenID Connect URL as the SDK reads it", async (_kind, body, reason) => {
    const requests = openIdServer(body);
    const discovery = discoverAuthorizationServerMetadata(AUTH, { fetchFn: sdkFetch(upstream) });
    expect(await rejected(discovery)).toBe(reason !== "");
    expect(requests.map(sent => sent.url)).toEqual([
      `${AUTH}/.well-known/oauth-authorization-server`, `${AUTH}/.well-known/openid-configuration`,
    ]);
    expect(counted()).toEqual([
      ["metadata.server", "error", "http", 404],
      ["metadata.server", reason === "" ? "success" : "error", reason, 200],
    ]);
  });

  it("counts a document the SDK reads and its flow then refuses as a success", async () => {
    platform(() => answered(JSON.stringify({ ...METADATA, issuer: "https://other.example" })));
    await expect(discoverAuthorizationServerMetadata(AUTH, { fetchFn: sdkFetch(upstream) }))
      .rejects.toBeInstanceOf(IssuerMismatchError);
    expect(counted()).toEqual([["metadata.server", "success", "", 200]]);
  });
});

// A server names the URL of its protected resource's metadata itself, and may give it a path
// that holds a well-known path of an authorization server's: the URL does not say which document
// the SDK asked for.
describe.each([
  ["OpenID Connect", "/.well-known/openid-configuration/mcp"],
  ["OAuth", "/.well-known/oauth-authorization-server/mcp"],
])("a protected resource's metadata at a URL the server named under the %s path", (_kind, path) => {
  const named = new URL(path, ENDPOINT);

  it.each([
    ["the resource's metadata", JSON.stringify({ resource: ENDPOINT, authorization_servers: [AUTH] }), ""],
    ["JSON that is no metadata", "{}", "api"],
    ["a page that is no JSON", "<html>Not found</html>", "parse"],
  ])("counts %s as the SDK reads it", async (_document, body, reason) => {
    const requests = platform(() => answered(body));
    const discovery = discoverOAuthProtectedResourceMetadata(
      ENDPOINT, { resourceMetadataUrl: named }, sdkFetch(upstream));
    expect(await rejected(discovery)).toBe(reason !== "");
    expect(requests.map(sent => sent.url)).toEqual([named.href]);
    expect(counted()).toEqual([
      ["metadata.server", reason === "" ? "success" : "error", reason, 200],
    ]);
  });
});
