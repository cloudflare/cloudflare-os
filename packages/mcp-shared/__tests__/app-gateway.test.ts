import { afterEach, expect, it, vi } from "vitest";

import { appRpcReply, type AppGatewayHost } from "../src/app-gateway.js";
import { MAX_APP_HTML_BYTES, type AppRpcReply } from "../src/apps.js";
import { McpClient } from "../src/client.js";
import { classifyTool, type ClassifiedTool } from "../src/tools.js";

// The read-only tool every case is built around, and the write that must never run from a window.
const READ_TOOL = classifyTool({ name: "get_weather", annotations: { readOnlyHint: true } }, "byo");
const WRITE_TOOL = classifyTool({ name: "delete_repo" }, "byo");
const MODEL_ONLY_TOOL = classifyTool({
  name: "get_weather",
  annotations: { readOnlyHint: true },
  ui: { visibility: ["model"] },
}, "byo");

/** One JSON-RPC request the stub endpoint received. */
type ServerRequest = { method: string; params: { name?: string; arguments?: unknown; uri?: string } };

/** The parsed body of one reply. */
type ReplyBody = {
  jsonrpc: string;
  id: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
};

/** One JSON-RPC message as the page's fetch would send it. */
function rpc(method: string, params?: unknown, id?: number): string {
  return JSON.stringify({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, params });
}

function bodyOf(reply: AppRpcReply): ReplyBody {
  return JSON.parse(reply.body) as ReplyBody;
}

/**
 * A host that records what the gateway asked of it, backed by a real client over a stubbed endpoint.
 *
 * `hostCalls` counts how far the gateway got: a refusal must leave it at zero, which is what "the
 * window never reached the server" means from here, and `requests` is what the server saw.
 */
function testHost(
  tool?: ClassifiedTool,
  answer?: (request: ServerRequest) => unknown,
  resourceUri: (uri: string) => string = uri => uri,
) {
  const requests: ServerRequest[] = [];
  let calls = 0;
  vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body));
    requests.push({ method: request.method, params: request.params });
    const result = answer ? answer(request) : { content: [{ type: "text", text: "ok" }] };
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: request.id, result }),
      { status: 200, headers: { "Content-Type": "application/json" } });
  });
  const client = new McpClient("https://mcp.example.com/mcp", async () => null, "session");
  const host: AppGatewayHost = {
    async findTool(name) {
      return tool?.tool.name === name ? tool : undefined;
    },
    resourceUri,
    async call<T>(fn: (client: McpClient) => Promise<T>): Promise<T> {
      calls++;
      return fn(client);
    },
  };
  return { host, requests, hostCalls: () => calls };
}

afterEach(() => vi.unstubAllGlobals());

it("runs a granted read-only tool and answers in the shape a View expects", async () => {
  const { host, requests } = testHost(READ_TOOL);
  const reply = await appRpcReply(
    rpc("tools/call", { name: "get_weather", arguments: { city: "Lagos" } }, 7), host);

  expect(reply.status).toBe(200);
  expect(bodyOf(reply)).toEqual({
    jsonrpc: "2.0",
    id: 7,
    result: { content: [{ type: "text", text: "ok" }] },
  });
  expect(requests).toEqual([
    { method: "tools/call", params: { name: "get_weather", arguments: { city: "Lagos" } } },
  ]);
});

it("refuses a write and never reaches the server", async () => {
  const { host, requests, hostCalls } = testHost(WRITE_TOOL);
  const reply = await appRpcReply(rpc("tools/call", { name: "delete_repo" }, 1), host);

  expect(bodyOf(reply).error).toEqual({
    code: -32001,
    message: expect.stringContaining("Ask the agent in the chat"),
  });
  expect(bodyOf(reply).error?.message).toContain("delete_repo");
  expect(hostCalls()).toBe(0);
  expect(requests).toEqual([]);
});

it("refuses a tool this binding does not grant", async () => {
  const { host, requests, hostCalls } = testHost(READ_TOOL);
  const reply = await appRpcReply(rpc("tools/call", { name: "send_email" }, 1), host);

  expect(bodyOf(reply).error?.code).toBe(-32001);
  expect(bodyOf(reply).error?.message).toContain("send_email");
  expect(hostCalls()).toBe(0);
  expect(requests).toEqual([]);
});

it("refuses a read-only tool the server did not offer to apps", async () => {
  const { host, requests, hostCalls } = testHost(MODEL_ONLY_TOOL);
  const reply = await appRpcReply(rpc("tools/call", { name: "get_weather" }, 1), host);

  expect(bodyOf(reply).error?.code).toBe(-32001);
  expect(hostCalls()).toBe(0);
  expect(requests).toEqual([]);
});

it("refuses a tool call whose arguments are not an object", async () => {
  const { host, hostCalls } = testHost(READ_TOOL);
  const reply = await appRpcReply(
    rpc("tools/call", { name: "get_weather", arguments: "city=Lagos" }, 1), host);

  expect(bodyOf(reply).error?.code).toBe(-32602);
  expect(hostCalls()).toBe(0);
});

it("refuses a resource read that is not a ui:// resource", async () => {
  const { host, requests, hostCalls } = testHost(READ_TOOL);
  const reply = await appRpcReply(
    rpc("resources/read", { uri: "https://mcp.example.com/notes.txt" }, 1), host);

  expect(bodyOf(reply).error?.code).toBe(-32001);
  expect(hostCalls()).toBe(0);
  expect(requests).toEqual([]);
});

it("relays a ui:// resource and nothing else the server returned", async () => {
  const { host, requests } = testHost(READ_TOOL, () => ({
    contents: [
      { uri: "https://mcp.example.com/notes.txt", mimeType: "text/plain", text: "private" },
      { uri: "ui://weather/current", mimeType: "text/html;profile=mcp-app", text: "<html></html>" },
    ],
  }));
  const reply = await appRpcReply(rpc("resources/read", { uri: "ui://weather/current" }, 3), host);

  expect(requests).toEqual([
    { method: "resources/read", params: { uri: "ui://weather/current" } },
  ]);
  expect(bodyOf(reply)).toEqual({
    jsonrpc: "2.0",
    id: 3,
    result: {
      contents: [
        { uri: "ui://weather/current", mimeType: "text/html;profile=mcp-app", text: "<html></html>" },
      ],
    },
  });
});

it("reads a renamed resource under the name the binding addresses it by", async () => {
  const { host, requests } = testHost(
    READ_TOOL,
    () => ({
      contents: [{
        uri: "ui://weather/current",
        mimeType: "text/html;profile=mcp-app",
        text: "<html></html>",
      }],
    }),
    uri => `portal-server_${uri}`,
  );
  const reply = await appRpcReply(rpc("resources/read", { uri: "ui://weather/current" }, 5), host);

  // The window asks by the name its own document knows, the endpoint is asked by the name it answers
  // to, and what comes back is relayed under the server's URI.
  expect(requests).toEqual([
    { method: "resources/read", params: { uri: "portal-server_ui://weather/current" } },
  ]);
  expect(bodyOf(reply).result).toEqual({
    contents: [
      { uri: "ui://weather/current", mimeType: "text/html;profile=mcp-app", text: "<html></html>" },
    ],
  });
});

it("decodes a document the server sent as base64", async () => {
  const html = "<html><body>héllo — ok</body></html>";
  const { host } = testHost(READ_TOOL, () => ({
    contents: [{
      uri: "ui://weather/current",
      mimeType: "text/html;profile=mcp-app",
      blob: btoa(String.fromCharCode(...new TextEncoder().encode(html))),
    }],
  }));
  const reply = await appRpcReply(rpc("resources/read", { uri: "ui://weather/current" }, 1), host);

  expect(bodyOf(reply).result).toEqual({
    contents: [{ uri: "ui://weather/current", mimeType: "text/html;profile=mcp-app", text: html }],
  });
});

it("never hands a window a document larger than it renders", async () => {
  const { host } = testHost(READ_TOOL, () => ({
    contents: [{
      uri: "ui://weather/huge",
      mimeType: "text/html;profile=mcp-app",
      blob: btoa("x".repeat(MAX_APP_HTML_BYTES + 1)),
    }],
  }));
  const reply = await appRpcReply(rpc("resources/read", { uri: "ui://weather/huge" }, 1), host);

  expect(bodyOf(reply).result).toEqual({ contents: [] });
});

it("answers ping without touching the server", async () => {
  const { host, hostCalls } = testHost(READ_TOOL);
  const reply = await appRpcReply(rpc("ping", undefined, 4), host);

  expect(bodyOf(reply)).toEqual({ jsonrpc: "2.0", id: 4, result: {} });
  expect(hostCalls()).toBe(0);
});

it("answers an unknown method with -32601", async () => {
  const { host, requests } = testHost(READ_TOOL);
  const reply = await appRpcReply(rpc("tools/list", {}, 9), host);

  expect(reply.status).toBe(200);
  expect(bodyOf(reply).error).toEqual({
    code: -32601,
    message: expect.stringContaining("tools/list"),
  });
  expect(requests).toEqual([]);
});

it("answers a body that is not JSON with -32700", async () => {
  const { host, hostCalls } = testHost(READ_TOOL);
  const reply = await appRpcReply("{not json", host);

  expect(reply.status).toBe(200);
  expect(bodyOf(reply)).toEqual({
    jsonrpc: "2.0",
    id: null,
    error: { code: -32700, message: expect.any(String) },
  });
  expect(hostCalls()).toBe(0);
});

it("answers a message that is not a JSON-RPC request with -32600", async () => {
  const { host, hostCalls } = testHost(READ_TOOL);
  const bodies = [
    JSON.stringify([]),
    JSON.stringify({ method: "ping" }),
    JSON.stringify({ jsonrpc: "2.0", id: 1 }),
    JSON.stringify({ jsonrpc: "1.0", id: 1, method: "ping" }),
  ];

  for (const body of bodies) {
    const reply = await appRpcReply(body, host);
    expect(bodyOf(reply).error?.code).toBe(-32600);
    expect(bodyOf(reply).jsonrpc).toBe("2.0");
  }
  expect(hostCalls()).toBe(0);
});

it("answers a failure with a frame rather than a throw", async () => {
  const { host } = testHost(READ_TOOL, () => {
    throw new Error("upstream is down");
  });
  const reply = await appRpcReply(rpc("tools/call", { name: "get_weather" }, 11), host);

  expect(reply.status).toBe(200);
  expect(bodyOf(reply).id).toBe(11);
  expect(bodyOf(reply).error?.code).toBe(-32603);
  expect(bodyOf(reply).error?.message).toEqual(expect.any(String));
});
