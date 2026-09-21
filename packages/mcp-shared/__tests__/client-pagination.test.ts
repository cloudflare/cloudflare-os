import { afterEach, describe, expect, it, vi } from "vitest";

import {
  callMayHaveTakenEffect,
  MAX_TOOL_NAME_CHARS,
  McpClient,
} from "../src/client.js";
import { describeCall } from "../src/tools.js";

// Answers every `tools/list` from `pages`, in order, repeating the last one forever.
//
// Counts requests so a test can prove the client stopped asking rather than merely stopped returning.
function stubPages(pages: { tools?: unknown[]; nextCursor?: string }[]): () => number {
  let calls = 0;
  vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
    const page = pages[Math.min(calls, pages.length - 1)];
    calls++;
    const id = JSON.parse(String(init?.body)).id;
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id, result: page }),
      { status: 200, headers: { "Content-Type": "application/json" } });
  });
  return () => calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("McpClient.listTools", () => {
  it("uses distinct request ids across concurrent client instances", async () => {
    const ids: string[] = [];
    vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      ids.push(request.id);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { tools: [] } }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    });
    const first = new McpClient("https://mcp.example.com/mcp", async () => null);
    const second = new McpClient("https://mcp.example.com/mcp", async () => null);

    await Promise.all([first.listTools(10), second.listTools(10)]);
    expect(new Set(ids).size).toBe(2);
  });

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

  it("treats an empty cursor as an opaque continuation token", async () => {
    const cursors: unknown[] = [];
    vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      cursors.push(request.params.cursor);
      const result = cursors.length === 1
        ? { tools: [{ name: "a" }], nextCursor: "" }
        : { tools: [{ name: "b" }] };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    });
    const client = new McpClient("https://mcp.example.com/mcp", async () => null);

    const { tools, truncated } = await client.listTools(100);

    expect(tools.map(tool => tool.name)).toEqual(["a", "b"]);
    expect(truncated).toBe(false);
    expect(cursors).toEqual([undefined, ""]);
  });

  it("shares one deadline across every page", async () => {
    let now = 0;
    let calls = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
      calls++;
      now += 20;
      const id = JSON.parse(String(init?.body)).id;
      return new Response(JSON.stringify({
        jsonrpc: "2.0", id, result: { tools: [], nextCursor: "more" },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const client = new McpClient(
      "https://mcp.example.com/mcp", async () => null, null, { timeoutMs: 30 });

    await expect(client.listTools(10)).rejects.toThrow(/timed out|timeout/i);
    expect(calls).toBe(2);
  });

  it("does not impose a deadline when the caller did not configure one", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
      now += 60_000;
      const request = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        result: now === 60_000
          ? { tools: [{ name: "a" }], nextCursor: "more" }
          : { tools: [{ name: "b" }] },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const client = new McpClient("https://mcp.example.com/mcp", async () => null);

    await expect(client.listTools(10)).resolves.toMatchObject({
      tools: [{ name: "a" }, { name: "b" }],
    });
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

  it("applies the tool count limit after filtering", async () => {
    stubPages([{ tools: [
      ...Array.from({ length: 250 }, (_, i) => ({ name: `other_${i}` })),
      { name: "jira_search" },
      { name: "jira_create" },
    ] }]);
    const client = new McpClient("https://mcp.example.com/mcp", async () => null);
    const { tools, truncated } = await client.listTools(
      200,
      tool => tool.name.startsWith("jira_"),
    );
    expect(tools.map(tool => tool.name)).toEqual(["jira_search", "jira_create"]);
    expect(truncated).toBe(false);
  });

  it("continues paging until matching tools are found", async () => {
    const calls = stubPages([
      { tools: [{ name: "other_a" }], nextCursor: "1" },
      { tools: [{ name: "jira_search" }] },
    ]);
    const client = new McpClient("https://mcp.example.com/mcp", async () => null);
    const { tools, truncated } = await client.listTools(
      200,
      tool => tool.name.startsWith("jira_"),
    );
    expect(tools.map(tool => tool.name)).toEqual(["jira_search"]);
    expect(truncated).toBe(false);
    expect(calls()).toBe(2);
  });

  it("can filter on descriptions before applying catalog budgets", async () => {
    stubPages([{ tools: [
      ...Array.from({ length: 250 }, (_, i) => ({ name: `other_${i}` })),
      { name: "jira_create_issue", description: "File a ticket in Jira" },
    ] }]);
    const client = new McpClient("https://mcp.example.com/mcp", async () => null);
    const { tools, truncated } = await client.listTools(
      20,
      tool => typeof tool.description === "string" && tool.description.includes("ticket"),
    );
    expect(tools.map(tool => tool.name)).toEqual(["jira_create_issue"]);
    expect(truncated).toBe(false);
  });

  it("stops paging as soon as an exact tool is found", async () => {
    const calls = stubPages([
      { tools: [{ name: "other_a" }], nextCursor: "1" },
      { tools: [{ name: "jira_search" }, { name: "other_b" }], nextCursor: "2" },
      { tools: [{ name: "other_c" }] },
    ]);
    const client = new McpClient("https://mcp.example.com/mcp", async () => null);

    await expect(client.findTool("jira_search")).resolves.toMatchObject({ name: "jira_search" });
    expect(calls()).toBe(2);
  });

  it("stops paging when a bounded search has enough matches", async () => {
    const calls = stubPages([{
      tools: Array.from({ length: 25 }, (_, i) => ({ name: `jira_tool_${i}` })),
      nextCursor: "more",
    }]);
    const client = new McpClient("https://mcp.example.com/mcp", async () => null);

    const tools = await client.listMatchingToolSummaries(
      20, tool => tool.name.startsWith("jira_"));
    expect(tools).toHaveLength(20);
    expect(calls()).toBe(1);
  });

  it("returns twenty schema-free search summaries across pages", async () => {
    const wireTools = Array.from({ length: 20 }, (_, i) => ({
      name: `jira_tool_${i}`,
      title: `Jira tool ${i}`,
      description: "x".repeat(4000),
      inputSchema: { type: "object", description: "y".repeat(19_000) },
    }));
    const calls = stubPages([
      { tools: wireTools.slice(0, 10), nextCursor: "more" },
      { tools: wireTools.slice(10) },
    ]);
    const client = new McpClient("https://mcp.example.com/mcp", async () => null);

    const tools = await client.listMatchingToolSummaries(20, () => true);

    expect(tools).toHaveLength(20);
    expect(tools[0]).toMatchObject({ name: "jira_tool_0", title: "Jira tool 0" });
    expect(tools.every(tool => tool.inputSchema === undefined)).toBe(true);
    expect(calls()).toBe(2);
  });

  it("does not charge filtered-out tools against the byte budget", async () => {
    stubPages([{ tools: [
      ...Array.from({ length: 100 }, (_, i) => ({
        name: `other_${i}`, description: "x".repeat(4000),
      })),
      { name: "jira_search", description: "Search Jira" },
    ] }]);
    const client = new McpClient("https://mcp.example.com/mcp", async () => null);
    const { tools, truncated } = await client.listTools(
      200,
      tool => tool.name.startsWith("jira_"),
    );
    expect(tools.map(tool => tool.name)).toEqual(["jira_search"]);
    expect(truncated).toBe(false);
  });

  it("can index far more tools than a catalog holds by retaining only names", async () => {
    // A catalog of these would exhaust the byte budget long before 400 tools. The index drops
    // descriptions, schemas, and annotations.
    stubPages([{ tools: Array.from({ length: 400 }, (_, i) => ({
      name: `server_tool_${i}`,
      description: "x".repeat(1000),
      inputSchema: { type: "object", description: "y".repeat(1000) },
      annotations: { readOnlyHint: i % 2 === 0 },
    })) }]);
    const client = new McpClient("https://mcp.example.com/mcp", async () => null);
    const { tools, truncated } = await client.listToolIndex(500);
    expect(tools).toHaveLength(400);
    expect(truncated).toBe(false);
    expect(tools[399]).toEqual({ name: "server_tool_399" });
    // The point of the index: no policy or display metadata survives to consume the survey budget.
    expect(tools[0]).not.toHaveProperty("annotations");
    expect(tools[0]).not.toHaveProperty("description");
    expect(tools[0]).not.toHaveProperty("inputSchema");
  });

  it("can validate selected names after their definitions exhaust the catalog budget", async () => {
    const wireTools = Array.from({ length: 8 }, (_, i) => ({
      name: `server_tool_${i}`,
      description: "x".repeat(4000),
      inputSchema: { type: "object", description: "y".repeat(19_000) },
    }));
    stubPages([{ tools: wireTools }]);
    const client = new McpClient("https://mcp.example.com/mcp", async () => null);
    const selected = new Set(wireTools.map(tool => tool.name));
    const include = (tool: { name: string }) => selected.has(tool.name);

    const catalog = await client.listTools(200, include);
    expect(catalog.truncated).toBe(true);
    expect(catalog.tools.length).toBeLessThan(wireTools.length);

    const index = await client.listMatchingToolIndex(selected.size, include);
    // Stopping once every requested name is found leaves the overall endpoint index incomplete,
    // but the returned names are enough to validate this exact grant.
    expect(index.truncated).toBe(true);
    expect(index.tools.map(tool => tool.name)).toEqual([...selected]);
  });

  it("stops paging once every requested index entry is found", async () => {
    const calls = stubPages([{
      tools: [{ name: "jira_search" }, { name: "jira_create" }],
      nextCursor: "more",
    }]);
    const client = new McpClient("https://mcp.example.com/mcp", async () => null);
    const requested = new Set(["jira_search", "jira_create"]);

    const index = await client.listMatchingToolIndex(
      requested.size,
      tool => requested.has(tool.name),
    );

    expect(index.tools.map(tool => tool.name)).toEqual([...requested]);
    expect(calls()).toBe(1);
  });

  it("returns a truncated catalog when small pages reach the page limit", async () => {
    // One tool per page stays below both the result and scan-tool caps after fifty requests. Without
    // a separate page cap, a cursor that never ends would keep the Worker walking indefinitely.
    const calls = stubPages([{ tools: [{ name: "other" }], nextCursor: "more" }]);
    const client = new McpClient("https://mcp.example.com/mcp", async () => null);
    const catalog = await client.listTools(200);
    expect(catalog.tools).toHaveLength(50);
    expect(catalog.truncated).toBe(true);
    expect(calls()).toBe(50);
  });

  it("reports page exhaustion as a scan limit for exact discovery", async () => {
    const calls = stubPages([{ tools: [{ name: "other" }], nextCursor: "more" }]);
    const client = new McpClient("https://mcp.example.com/mcp", async () => null);

    const error = await client.findTool("missing").catch(caught => caught);
    expect(error).toMatchObject({ message: expect.stringMatching(/scan budget/i) });
    expect(callMayHaveTakenEffect(error)).toBe(false);
    expect(calls()).toBe(50);
  });

  it("returns a truncated matching index when small pages reach the page limit", async () => {
    const calls = stubPages([{ tools: [{ name: "match" }], nextCursor: "more" }]);
    const client = new McpClient("https://mcp.example.com/mcp", async () => null);

    const index = await client.listMatchingToolIndex(1000, () => true);
    expect(index.tools).toHaveLength(50);
    expect(index.truncated).toBe(true);
    expect(calls()).toBe(50);
  });

  it("bounds tools scanned while looking for a missing exact name", async () => {
    const pages = Array.from({ length: 6 }, (_pageValue, page) => ({
      tools: Array.from(
        { length: 1000 }, (_toolValue, i) => ({ name: `other_${page}_${i}` })),
      nextCursor: String(page + 1),
    }));
    const calls = stubPages(pages);
    const client = new McpClient("https://mcp.example.com/mcp", async () => null);

    await expect(client.findTool("missing")).rejects.toThrow(/scan budget/i);
    expect(calls()).toBe(6);
  });

  it("finds an exact tool before an oversized page crosses the scan limit", async () => {
    const calls = stubPages([{
      tools: [
        { name: "target" },
        ...Array.from({ length: 5000 }, (_, i) => ({ name: `other_${i}` })),
      ],
    }]);
    const client = new McpClient("https://mcp.example.com/mcp", async () => null);

    await expect(client.findTool("target")).resolves.toMatchObject({ name: "target" });
    expect(calls()).toBe(1);
  });

  it("bounds bytes scanned from filtered-out tool pages", async () => {
    const pages = Array.from({ length: 5 }, (_, page) => ({
      tools: [{ name: `other_${page}`, description: "x".repeat(900_000) }],
      nextCursor: String(page + 1),
    }));
    const calls = stubPages(pages);
    const client = new McpClient("https://mcp.example.com/mcp", async () => null);

    await expect(client.findTool("missing")).rejects.toThrow(/scan budget/i);
    expect(calls()).toBe(5);
  });

  it("counts ignored JSON-RPC envelope bytes against the scan budget", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
      calls++;
      const id = JSON.parse(String(init?.body)).id;
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id,
        padding: "x".repeat(900_000),
        result: { tools: [], nextCursor: "more" },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const client = new McpClient("https://mcp.example.com/mcp", async () => null);

    await expect(client.findTool("missing")).rejects.toThrow(/scan budget/i);
    expect(calls).toBe(5);
  });

  it("bounds an unfiltered portal index survey", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
      calls++;
      const id = JSON.parse(String(init?.body)).id;
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id,
        padding: "x".repeat(900_000),
        result: { tools: [], nextCursor: "more" },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const client = new McpClient("https://mcp.example.com/mcp", async () => null);

    await expect(client.listToolIndex(1000)).resolves.toEqual({ tools: [], truncated: true });
    expect(calls).toBe(5);
  });

  it("returns a truncated index when pagination reaches the page limit", async () => {
    const calls = stubPages([{ tools: [], nextCursor: "more" }]);
    const client = new McpClient("https://mcp.example.com/mcp", async () => null);

    await expect(client.listToolIndex(1000))
      .resolves.toEqual({ tools: [], truncated: true });
    expect(calls()).toBe(50);
  });

  it("returns collected catalog matches when later pages exceed the scan budget", async () => {
    const pages = [
      { tools: [{ name: "jira_search" }], nextCursor: "1" },
      ...Array.from({ length: 5 }, (_, page) => ({
        tools: [{ name: `other_${page}`, description: "x".repeat(900_000) }],
        nextCursor: String(page + 2),
      })),
    ];
    stubPages(pages);
    const client = new McpClient("https://mcp.example.com/mcp", async () => null);

    await expect(client.listTools(200, tool => tool.name.startsWith("jira_")))
      .resolves.toEqual({ tools: [{ name: "jira_search" }], truncated: true });
  });

  it("fails search rather than presenting a scan-limited prefix as complete", async () => {
    const pages = [
      { tools: [{ name: "jira_search" }], nextCursor: "1" },
      ...Array.from({ length: 5 }, (_, page) => ({
        tools: [{ name: `other_${page}`, description: "x".repeat(900_000) }],
        nextCursor: String(page + 2),
      })),
    ];
    stubPages(pages);
    const client = new McpClient("https://mcp.example.com/mcp", async () => null);

    await expect(client.listMatchingToolSummaries(
      20, tool => tool.name.startsWith("jira_")))
      .rejects.toThrow(/scan budget/i);
  });

  it("ignores nameless entries rather than counting them towards the cap", async () => {
    stubPages([{ tools: [{ name: "" }, { description: "no name" }, { name: "real" }] }]);
    const client = new McpClient("https://mcp.example.com/mcp", async () => null);
    expect((await client.listTools(10)).tools.map(tool => tool.name)).toEqual(["real"]);
  });

  it("ignores tool names too large to retain or accept back from a Gadget", async () => {
    stubPages([{ tools: [
      { name: "x".repeat(MAX_TOOL_NAME_CHARS + 1) },
      { name: "real" },
    ] }]);
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
    vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
      const id = JSON.parse(String(init?.body)).id;
      return new Response(new ReadableStream({
      start(controller) {
        streamController = controller;
        controller.enqueue(encoder.encode(
          'data: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n'));
        controller.enqueue(encoder.encode(
          `data: ${JSON.stringify({ jsonrpc: "2.0", id }).slice(0, -1)},"result":{"content":[`));
        controller.enqueue(encoder.encode('{"type":"text","text":"done"}]}}\n\r'));
      },
      cancel() { cancelled = true; },
      }), { status: 200, headers: { "Content-Type": "Text/Event-Stream" } });
    });

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
    vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
      const id = JSON.parse(String(init?.body)).id;
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } }),
        { status: 200, headers: { "Content-Type": "application/json" } });
    });
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
