import { afterEach, describe, expect, it, vi } from "vitest";

import { callMayHaveTakenEffect, McpClient } from "../src/client.js";
import { describeCall } from "../src/tools.js";

// Answers every `tools/list` from `pages`, in order, repeating the last one forever.
//
// Counts requests so a test can prove the client stopped asking rather than merely stopped returning.
function stubPages(pages: { tools?: unknown[]; nextCursor?: string }[]): () => number {
  let calls = 0;
  vi.stubGlobal("fetch", async () => {
    const page = pages[Math.min(calls, pages.length - 1)];
    calls++;
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: calls, result: page }),
      { status: 200, headers: { "Content-Type": "application/json" } });
  });
  return () => calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("McpClient.listTools", () => {
  it("follows cursors until the server stops sending them", async () => {
    stubPages([
      { tools: [{ name: "a" }], nextCursor: "1" },
      { tools: [{ name: "b" }] },
    ]);
    const client = new McpClient("https://mcp.example.com/mcp", async () => null);
    const { tools, truncated } = await client.listTools(100);
    expect(tools.map(tool => tool.name)).toEqual(["a", "b"]);
    expect(truncated).toBe(false);
  });

  it("stops at maxTools even when the server has more", async () => {
    const calls = stubPages([{ tools: [{ name: "a" }, { name: "b" }, { name: "c" }], nextCursor: "1" }]);
    const client = new McpClient("https://mcp.example.com/mcp", async () => null);
    const { tools, truncated } = await client.listTools(2);
    expect(tools.map(tool => tool.name)).toEqual(["a", "b"]);
    expect(truncated).toBe(true);
    // One page was enough; it must not have kept paging to discover it was already full.
    expect(calls()).toBe(1);
  });

  it("gives up on a server that paginates forever without returning tools", async () => {
    // `maxTools` cannot stop this on its own: nothing is ever appended, so the tool count never grows
    // and the cursor never ends. Without a page cap the loop runs until the Worker is killed.
    const calls = stubPages([{ tools: [], nextCursor: "more" }]);
    const client = new McpClient("https://mcp.example.com/mcp", async () => null);
    await expect(client.listTools(200)).rejects.toThrow(/kept paginating/);
    expect(calls()).toBeLessThanOrEqual(50);
  });

  it("ignores nameless entries rather than counting them towards the cap", async () => {
    stubPages([{ tools: [{ name: "" }, { description: "no name" }, { name: "real" }] }]);
    const client = new McpClient("https://mcp.example.com/mcp", async () => null);
    expect((await client.listTools(10)).tools.map(tool => tool.name)).toEqual(["real"]);
  });

  it("drops a description the server did not send as a string", async () => {
    // A non-string passed the length cap untouched and reached the approval prompt, where
    // `quoteUntrusted` called `.replace` on it and took down every action call for the connection.
    stubPages([{ tools: [{ name: "odd", description: 42, title: { nested: true } }] }]);
    const client = new McpClient("https://mcp.example.com/mcp", async () => null);
    const [tool] = (await client.listTools(10)).tools;
    expect(tool.description).toBeUndefined();
    expect(tool.title).toBeUndefined();

    // The prompt every non-read call passes through.
    expect(() => describeCall({
      serverName: "Acme", endpoint: "https://mcp.example.com/mcp", tool,
      toolArgs: {}, mode: "action", classifiedBy: "default",
    })).not.toThrow();
  });

  it("clips a description no human or agent was going to read", async () => {
    // A count-only bound leaves the catalog unbounded in bytes: descriptions and schemas are
    // server-controlled, and the result is stored whole in a Durable Object and fed to the agent.
    stubPages([{ tools: [{ name: "a", description: "x".repeat(50_000) }] }]);
    const client = new McpClient("https://mcp.example.com/mcp", async () => null);
    const { tools: [tool] } = await client.listTools(10);
    expect(tool.description!.length).toBeLessThan(5000);
  });

  it("drops a schema too large to render, rather than storing half of one", async () => {
    const huge = { type: "object", properties: Object.fromEntries(
      Array.from({ length: 2000 }, (_, i) => [`field${i}`, { type: "string" }])) };
    stubPages([{ tools: [{ name: "a", inputSchema: huge }] }]);
    const client = new McpClient("https://mcp.example.com/mcp", async () => null);
    const { tools: [tool] } = await client.listTools(10);
    expect(tool.inputSchema).toBeUndefined();
  });

  it("refuses a response too large to buffer", async () => {
    // The catalog caps bound what is *kept*; the body still has to be read whole before anything can
    // parse it, and a `tools/call` result is not bounded at all. A server answering one request with
    // an enormous body would exhaust the Worker before any of the limits above applied.
    vi.stubGlobal("fetch", async () => new Response("x".repeat(2 * 1024 * 1024), {
      status: 200, headers: { "Content-Type": "application/json" },
    }));
    const client = new McpClient("https://mcp.example.com/mcp", async () => null);
    await expect(client.callTool("anything", {})).rejects.toThrow(/too large/);
  });

  it("returns an SSE response without waiting for the stream to close", async () => {
    let cancelled = false;
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const encoder = new TextEncoder();
    vi.stubGlobal("fetch", async () => new Response(new ReadableStream({
      start(controller) {
        streamController = controller;
        controller.enqueue(encoder.encode(
          'data: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n'));
        controller.enqueue(encoder.encode(
          'data: {"jsonrpc":"2.0","id":1,"result":{"content":['));
        controller.enqueue(encoder.encode('{"type":"text","text":"done"}]}}\n\r'));
      },
      cancel() { cancelled = true; },
    }), { status: 200, headers: { "Content-Type": "Text/Event-Stream" } }));

    const client = new McpClient("https://mcp.example.com/mcp", async () => null);
    const call = client.callTool("anything", {});
    let timer: ReturnType<typeof setTimeout>;
    const result = await Promise.race([
      call,
      new Promise<"timed out">(resolve => { timer = setTimeout(() => resolve("timed out"), 500); }),
    ]);
    clearTimeout(timer!);
    if (result === "timed out") {
      // Let the old EOF-based implementation finish so it does not leak work after this assertion.
      streamController?.close();
      await call;
    }
    expect(result).not.toBe("timed out");
    expect(cancelled).toBe(true);
  });

  it("stops taking tools once the catalog is too large, however many are left", async () => {
    // 200 tools carrying a megabyte each is a storage failure and a flooded context window, from a
    // server that only had to answer one request.
    const fat = Array.from({ length: 200 }, (_, i) => ({
      name: `tool_${i}`, description: "x".repeat(4000),
    }));
    stubPages([{ tools: fat }]);
    const client = new McpClient("https://mcp.example.com/mcp", async () => null);
    const { tools, truncated } = await client.listTools(200);
    expect(tools.length).toBeLessThan(200);
    expect(new TextEncoder().encode(JSON.stringify(tools)).byteLength).toBeLessThan(96 * 1024);
    // The byte budget stopped the listing well short of `maxTools`, so nothing about the returned
    // array reveals that tools were left behind. Callers that infer what an endpoint is from what it
    // advertises depend on being told.
    expect(truncated).toBe(true);
  });

  it("budgets UTF-8 bytes rather than JavaScript characters", async () => {
    // Each emoji is two UTF-16 code units but four UTF-8 bytes. A character budget can therefore
    // accept a catalog whose serialized storage value is far larger than it claims.
    const fat = Array.from({ length: 100 }, (_, i) => ({
      name: `tool_${i}`, description: "😀".repeat(2000),
    }));
    stubPages([{ tools: fat }]);
    const client = new McpClient("https://mcp.example.com/mcp", async () => null);
    const { tools, truncated } = await client.listTools(200);
    const bytes = new TextEncoder().encode(JSON.stringify(tools)).byteLength;
    expect(bytes).toBeLessThan(96 * 1024);
    expect(truncated).toBe(true);
  });

  it("drops unknown tool extensions before applying the storage budget", async () => {
    // The MCP type only names fields this gatekeeper uses, but parsed JSON can carry anything. A
    // spread here used to retain arbitrary extensions and let one field bypass every per-field cap.
    stubPages([{ tools: [{ name: "a", vendorBlob: "x".repeat(200_000) }] }]);
    const client = new McpClient("https://mcp.example.com/mcp", async () => null);
    const { tools, truncated } = await client.listTools(10);
    expect(tools).toHaveLength(1);
    expect(tools[0]).not.toHaveProperty("vendorBlob");
    expect(truncated).toBe(false);
  });
});

describe("error text a server wrote", () => {
  // Answers every request with a JSON-RPC error carrying `message`.
  function stubError(message: string) {
    vi.stubGlobal("fetch", async () => new Response(
      JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message } }),
      { status: 200, headers: { "Content-Type": "application/json" } }));
  }

  it("redacts the credential this Worker just sent, if the server echoes it back", async () => {
    // A server that quotes the request's Authorization header inside an error -- carelessly or
    // deliberately -- would otherwise have this Worker copy its own bearer token into an error
    // message, which callers log wholesale and may forward to the issue reporter.
    const token = "sk-live-000111222333444555";
    stubError(`bad request: Authorization: Bearer ${token}`);
    const client = new McpClient("https://mcp.example.com/mcp", async () => token);

    const err = await client.callTool("anything", {}).catch(caught => caught);
    expect(err.message).not.toContain(token);
    expect(err.message).toContain("[redacted]");
  });

  it("redacts a credential that straddles the length cap", async () => {
    // Redaction used to run after `safeServerText` capped the text at 200 characters. A token
    // crossing that boundary lost the tail that made it matchable, so the head stayed in a message
    // that looked sanitized. Sized so the token starts inside the kept region and runs past it.
    // 152 characters of filler put the token's first 26 characters inside the kept region; filler
    // without spaces, since the sanitizer collapses whitespace and would move the boundary.
    const token = `sk-live-${"9".repeat(60)}`;
    stubError(`${"context-".repeat(19)}Authorization: Bearer ${token}`);
    const client = new McpClient("https://mcp.example.com/mcp", async () => token);

    const err = await client.callTool("send", {}).catch(caught => caught);
    expect(err.message).not.toContain(token);
    expect(err.message).not.toContain(token.slice(0, 24));
  });

  it("keeps the server's explanation, which is usually the only clue", async () => {
    stubError("unknown tool \"send\"");
    const client = new McpClient("https://mcp.example.com/mcp", async () => "tok-abcdefgh");
    const err = await client.callTool("send", {}).catch(caught => caught);
    expect(err.message).toContain('unknown tool "send"');
  });

  it("flattens text that could forge a second entry in a log line", async () => {
    stubError("denied\nERROR fabricated entry");
    const client = new McpClient("https://mcp.example.com/mcp", async () => null);
    const err = await client.callTool("send", {}).catch(caught => caught);
    expect(err.message).not.toContain("\n");
  });

  it("does not assume a tool failed before taking effect", async () => {
    stubError("write failed");
    const client = new McpClient("https://mcp.example.com/mcp", async () => null);
    const err = await client.callTool("send", {}).catch(caught => caught);
    expect(callMayHaveTakenEffect(err)).toBe(true);
  });
});

describe("HTTP error outcomes", () => {
  it("keeps a generic client error outcome unknown", async () => {
    vi.stubGlobal("fetch", async () => new Response("bad request", { status: 400 }));
    const client = new McpClient("https://mcp.example.com/mcp", async () => null);
    const err = await client.callTool("anything", {}).catch(caught => caught);
    expect(callMayHaveTakenEffect(err)).toBe(true);
  });

  it("keeps a server error outcome unknown", async () => {
    vi.stubGlobal("fetch", async () => new Response("failed", { status: 500 }));
    const client = new McpClient("https://mcp.example.com/mcp", async () => null);
    const err = await client.callTool("anything", {}).catch(caught => caught);
    expect(callMayHaveTakenEffect(err)).toBe(true);
  });
});
