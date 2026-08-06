import { expect, it } from "vite-plus/test";

import { McpSessionBase, type McpSessionHost, type StoredAction } from "../src/session.js";

it("reports an execution failure distinctly from a rejected approval", async () => {
  const failed: StoredAction = {
    id: 1,
    toolName: "send",
    args: {},
    state: "failed",
    submittedAt: 0,
    retryable: false,
    error: "The outcome is unknown.",
  };
  const host = {
    serverName: "Example",
    endpoint: "https://mcp.example.com",
    scope: {},
    lookupAction: () => failed,
  } as unknown as McpSessionHost;
  const session = new McpSessionBase(host, {} as never);

  await expect(session.getActionResult(1)).resolves.toEqual({
    status: "failed",
    message: "The outcome is unknown.",
  });
});
