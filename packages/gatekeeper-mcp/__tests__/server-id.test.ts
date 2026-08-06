import { describe, expect, it } from "vite-plus/test";

import { serverIdFromEndpoint } from "../src/server-id.js";

// `serverId` names the suggested binding (`MCP_LINEAR`) and the generated session type
// (`McpLinearSession`). It is display only -- the action-kind tag uses the whole endpoint, via
// `endpointTag` -- so these cases are about readability, plus the guarantee that the result is
// always a usable identifier.
describe("serverIdFromEndpoint", () => {
  it("skips host labels that name no service", () => {
    expect(serverIdFromEndpoint("https://mcp.linear.app/mcp")).toBe("linear");
    expect(serverIdFromEndpoint("https://api.notion.com/mcp")).toBe("notion");
    expect(serverIdFromEndpoint("https://www.example.com/mcp")).toBe("example");
  });

  it("uses the first label when none are generic", () => {
    expect(serverIdFromEndpoint("https://wiki.internal.corp/mcp")).toBe("wiki");
    expect(serverIdFromEndpoint("https://my-server.workers.dev/mcp")).toBe("my-server");
  });

  it("ignores the path, port, and query", () => {
      expect(serverIdFromEndpoint("https://linear.app:8443/a/b?x=1#tool=a")).toBe("linear");
  });

  it("normalizes case and stray characters into a slug", () => {
    expect(serverIdFromEndpoint("https://ACME_CRM.example.com/mcp")).toBe("acme-crm");
    expect(serverIdFromEndpoint("https://xn--caf-dma.example/mcp")).toBe("xn--caf-dma");
  });

  it("never returns an empty string, so the generated type name stays valid", () => {
    // Every label generic: falls back to the first rather than yielding nothing.
    expect(serverIdFromEndpoint("https://mcp.api.www/mcp")).toBe("mcp");
    expect(serverIdFromEndpoint("https://localhost:3000/mcp")).toBe("localhost");
  });

  it("collapses hosts that a tag must keep apart, which is why tags use the endpoint", () => {
    // Both collapse to "acme" -- documented in `ConnectedServer.serverId` and the reason `scopeTag`
    // exists. If this ever stops being true, the comment there is wrong.
    expect(serverIdFromEndpoint("https://mcp.acme.com/mcp"))
      .toBe(serverIdFromEndpoint("https://mcp.acme.io/mcp"));
  });
});
