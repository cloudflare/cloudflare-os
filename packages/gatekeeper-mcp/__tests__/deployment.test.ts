import { describe, expect, it } from "vitest";

import { readFixedMcpService } from "../src/deployment.js";

function env(values: Partial<Env>): Env {
  return values as Env;
}

describe("readFixedMcpService", () => {
  const service = { fetch: async () => new Response("ok") } as unknown as Fetcher;

  it("creates a fixed auto-provisioned resource only when a service binding is present", () => {
    const config = readFixedMcpService(env({
      MCP_SERVER_URL: "https://sop-agents.internal/mcp",
      MCP_SERVER_NAME: "SOP Agents",
      MCP_SERVER_ID: "sop-agents",
      MCP_SERVICE: service,
    }));

    expect(config).toMatchObject({
      endpoint: "https://sop-agents.internal/mcp",
      name: "SOP Agents",
      resource: { urlPattern: "https://sop-agents.internal/*", title: "SOP Agents" },
      server: {
        endpoint: "https://sop-agents.internal/mcp",
        serverId: "sop-agents",
        serverName: "SOP Agents",
        provenance: "deployment",
        auth: "none",
      },
    });
    expect(readFixedMcpService(env({
      MCP_SERVER_URL: "https://sop-agents.internal/mcp",
    }))).toBeNull();
  });

  it.each([
    "not a url",
    "http://sop-agents.internal/mcp",
    "https://user:password@sop-agents.internal/mcp",
    "https://sop-agents.internal/mcp#fragment",
  ])("refuses an unsafe resource identifier: %s", (url) => {
    expect(readFixedMcpService(env({ MCP_SERVER_URL: url, MCP_SERVICE: service }))).toBeNull();
  });
});
