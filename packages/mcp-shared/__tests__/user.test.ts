import { expect, it } from "vitest";

import {
  McpGatekeeperUserBase,
  mcpGatekeeperUserContext,
} from "../src/user.js";

const server = {
  endpoint: "https://mcp.example/rpc",
  serverId: "mcp-example",
  serverName: "Example MCP",
  provenance: "user" as const,
  auth: "oauth" as const,
};

class TestUser extends McpGatekeeperUserBase<object> {
  revoked = false;
  committed: string | undefined;
  reconnectNonce: string | undefined;

  protected [mcpGatekeeperUserContext]() {
    return {
      avatar: { url: "data:image/svg+xml,test" },
      baseUrl: "https://workshop.example/gatekeeper/mcp",
      account: {
        getServer: async () => server,
        revoke: async () => { this.revoked = true; },
        prepareReconnect: async (nonce: string) => { this.reconnectNonce = nonce; },
        commitReconnect: async (stageId: string) => { this.committed = stageId; },
      },
    };
  }
}

function user() {
  return new TestUser({ props: { accountObjectId: "account-id" } } as never, {});
}

it("provides the common MCP account lifecycle", async () => {
  const subject = user();

  expect(await subject.describe()).toEqual({
    displayName: "Example MCP",
    uniqueName: "https://mcp.example/rpc",
    avatar: { url: "data:image/svg+xml,test" },
  });
  expect(await subject.getAuthenticatedEmail()).toBeNull();
  expect(await subject.ensureResources([])).toEqual({});

  await subject.revoke();
  expect(subject.revoked).toBe(true);

  const { url } = await subject.reconnect();
  expect(url).toBe(
    `https://workshop.example/gatekeeper/mcp/account-id/${subject.reconnectNonce}`,
  );
  expect(subject.reconnectNonce).toHaveLength(64);

  await subject.commitReconnect("5".repeat(64));
  expect(subject.committed).toBe("5".repeat(64));
});

it("does not expose connector hooks as string-named methods", () => {
  expect(Object.getOwnPropertyNames(TestUser.prototype)).toEqual(["constructor"]);
});
