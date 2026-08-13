import { afterEach, expect, it, vi } from "vitest";

import {
  callMayHaveTakenEffect,
  McpCallNotDispatchedError,
  McpClient,
} from "../src/client.js";
import { withClient, type ConnectionAccount } from "../src/connection.js";

afterEach(() => vi.unstubAllGlobals());

it("keeps a direct credential rejection classified as not dispatched", async () => {
  vi.stubGlobal("fetch", async () => new Response(null, { status: 401 }));
  let expired = 0;
  const account: ConnectionAccount = {
    async getConnection() {
      return { authorization: "token", sessionId: "session", generation: 1 };
    },
    async assertConnectionCurrent() {},
    async setMcpSessionId() { return true; },
    async noteCredentialsExpired() { expired++; },
  };

  const error = await withClient({}, account, "https://mcp.example.com",
    client => client.callTool("send", {}), { retryOnExpiry: false }).catch(err => err);

  expect(error).toBeInstanceOf(McpCallNotDispatchedError);
  expect(callMayHaveTakenEffect(error)).toBe(false);
  expect(expired).toBe(1);
});

it("keeps credential rejection classified when expiry notification fails", async () => {
  vi.stubGlobal("fetch", async () => new Response(null, { status: 401 }));
  const account: ConnectionAccount = {
    async getConnection() {
      return { authorization: "token", sessionId: "session", generation: 1 };
    },
    async assertConnectionCurrent() {},
    async setMcpSessionId() { return true; },
    async noteCredentialsExpired() { throw new Error("callback unavailable"); },
  };

  const error = await withClient({}, account, "https://mcp.example.com",
    client => client.callTool("send", {}), { retryOnExpiry: false }).catch(err => err);

  expect(error).toBeInstanceOf(McpCallNotDispatchedError);
  expect(callMayHaveTakenEffect(error)).toBe(false);
});

it("classifies credential lookup failure as not dispatched", async () => {
  const account: ConnectionAccount = {
    async getConnection() { throw new Error("credential store unavailable"); },
    async assertConnectionCurrent() {},
    async setMcpSessionId() { return true; },
    async noteCredentialsExpired() {},
  };

  const error = await withClient({}, account, "https://mcp.example.com",
    client => client.callTool("send", {}), { retryOnExpiry: false }).catch(err => err);

  expect(error).toBeInstanceOf(McpCallNotDispatchedError);
  expect(callMayHaveTakenEffect(error)).toBe(false);
});

it("classifies initialization failure as not dispatched", async () => {
  vi.stubGlobal("fetch", async () => new Response(null, { status: 500 }));
  const account: ConnectionAccount = {
    async getConnection() {
      return { authorization: "token", sessionId: null, generation: 1 };
    },
    async assertConnectionCurrent() {},
    async setMcpSessionId() { return true; },
    async noteCredentialsExpired() {},
  };

  const error = await withClient({}, account, "https://mcp.example.com",
    client => client.callTool("send", {}), { retryOnExpiry: false }).catch(err => err);

  expect(error).toBeInstanceOf(McpCallNotDispatchedError);
  expect(callMayHaveTakenEffect(error)).toBe(false);
});

it("classifies an expired pre-fetch deadline as not dispatched", async () => {
  const client = new McpClient(
    "https://mcp.example.com", async () => "token", null, { deadline: 0 });

  const error = await client.callTool("send", {}).catch(err => err);

  expect(error).toBeInstanceOf(McpCallNotDispatchedError);
  expect(callMayHaveTakenEffect(error)).toBe(false);
});

it("rechecks account generation immediately before the tool request", async () => {
  let current = true;
  let requests = 0;
  vi.stubGlobal("fetch", async () => {
    requests++;
    return new Response("{}");
  });
  const account: ConnectionAccount = {
    async getConnection() {
      return { authorization: "token", sessionId: "session", generation: 1 };
    },
    async assertConnectionCurrent() {
      if (!current) throw new Error("connection replaced");
    },
    async setMcpSessionId() { return true; },
    async noteCredentialsExpired() {},
  };

  const error = await withClient({}, account, "https://mcp.example.com", async client => {
    current = false;
    return client.callTool("send", {});
  }, { retryOnExpiry: false }).catch(err => err);

  expect(error).toBeInstanceOf(McpCallNotDispatchedError);
  expect(requests).toBe(0);
});

it("persists a successful initialization before running the requested operation", async () => {
  const writes: Array<string | null> = [];
  vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body));
    if (request.method === "initialize") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }), {
        headers: { "Content-Type": "application/json", "Mcp-Session-Id": "new-session" },
      });
    }
    return new Response(null, { status: 202 });
  });
  const account: ConnectionAccount = {
    async getConnection() {
      return { authorization: "token", sessionId: null, generation: 1 };
    },
    async assertConnectionCurrent() {},
    async setMcpSessionId(_endpoint, _generation, _previous, sessionId) {
      writes.push(sessionId);
      return true;
    },
    async noteCredentialsExpired() {},
  };

  await expect(withClient({}, account, "https://mcp.example.com", async () => {
    throw new Error("operation failed");
  })).rejects.toThrow(/operation failed/);

  expect(writes).toEqual(["new-session"]);
});

it("does not persist a transport session changed after the requested operation", async () => {
  const account: ConnectionAccount = {
    async getConnection() {
      return { authorization: "token", sessionId: "old-session", generation: 1 };
    },
    async assertConnectionCurrent() {},
    async setMcpSessionId() { throw new Error("unexpected persistence"); },
    async noteCredentialsExpired() {},
  };

  await expect(withClient({}, account, "https://mcp.example.com", async client => {
    client.sessionId = "rotated-session";
    return "completed";
  }, { retryOnExpiry: false })).resolves.toBe("completed");
});

it("reports credentials expired when session recovery is rejected", async () => {
  let requests = 0;
  let expired = 0;
  vi.stubGlobal("fetch", async () => {
    requests++;
    return new Response(null, { status: requests === 1 ? 404 : 401 });
  });
  const account: ConnectionAccount = {
    async getConnection() {
      return { authorization: "token", sessionId: "expired-session", generation: 1 };
    },
    async assertConnectionCurrent() {},
    async setMcpSessionId() { return true; },
    async noteCredentialsExpired() { expired++; },
  };

  const error = await withClient({}, account, "https://mcp.example.com",
    client => client.listTools(1)).catch(err => err);

  expect(error).toBeInstanceOf(McpCallNotDispatchedError);
  expect(expired).toBe(1);
});
