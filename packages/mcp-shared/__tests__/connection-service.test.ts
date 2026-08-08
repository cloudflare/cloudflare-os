import { describe, expect, it, vi } from "vitest";

import { connectionFetch } from "../src/connection.js";

describe("connectionFetch", () => {
  it("forwards the MCP request through the configured Workers service binding", async () => {
    const fetch = vi.fn(async (request: Request) => {
      expect(request.url).toBe("https://sop-agents.internal/mcp");
      expect(request.method).toBe("POST");
      expect(await request.text()).toBe('{"jsonrpc":"2.0"}');
      return new Response("ok");
    });
    const transport = connectionFetch({ MCP_SERVICE: { fetch } as unknown as Fetcher });

    const response = await transport!("https://sop-agents.internal/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"jsonrpc":"2.0"}',
    });

    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("uses guarded HTTP when no service binding exists", () => {
    expect(connectionFetch({})).toBeUndefined();
  });
});
