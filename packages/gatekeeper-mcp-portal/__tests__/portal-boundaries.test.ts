import { beforeEach, describe, expect, it, vi } from "vitest";

import type { McpServerConfiguratorRpc } from
  "../src/configurator/server-configurator-types.js";

const mocks = vi.hoisted(() => ({ withClient: vi.fn() }));

vi.mock("capnweb-validate", () => ({
  validateRpc: () => (value: unknown) => value,
  skipRpcValidation: () => (value: unknown) => value,
}));

vi.mock("@gadgets/mcp-shared/connection", async importOriginal => ({
  ...await importOriginal<typeof import("@gadgets/mcp-shared/connection")>(),
  withClient: mocks.withClient,
}));

import { GatekeeperUserImpl, McpGatekeeperImpl } from "../src/portal.js";

const ENDPOINT = "https://gw.example.com/mcp";

type FakeClient = {
  callTool: ReturnType<typeof vi.fn>;
  listToolIndex: ReturnType<typeof vi.fn>;
  listMatchingToolSummaries: ReturnType<typeof vi.fn>;
};

function makeSubject(hiddenServerIds = "jira"): {
  user: GatekeeperUserImpl;
  client: FakeClient;
} {
  const client: FakeClient = {
    callTool: vi.fn(async () => ({
      isError: false,
      structuredContent: [
        { id: "jira", name: "Jira", enabled: true },
        { id: "gitlab", name: "GitLab", enabled: true },
      ],
    })),
    listToolIndex: vi.fn(),
    listMatchingToolSummaries: vi.fn(),
  };
  mocks.withClient.mockImplementation(async (...args: unknown[]) => {
    const callback = args[3] as (value: FakeClient) => unknown;
    return callback(client);
  });

  const account = {
    getServer: vi.fn(async () => ({
      endpoint: ENDPOINT,
      auth: "oauth",
      provenance: "deployment",
      serverId: "portal",
      serverName: "CF Portal",
    })),
  };
  const ctx = {
    props: { accountObjectId: "account-id" },
    exports: {
      McpAccount: {
        idFromString: vi.fn(() => "account-id"),
        get: vi.fn(() => account),
      },
      McpGatekeeperImpl: vi.fn(),
    },
  };
  const env = {
    MCP_PORTAL_URL: ENDPOINT,
    MCP_PORTAL_AUTH: "oauth",
    MCP_PORTAL_HIDDEN_SERVER_IDS: hiddenServerIds,
  };
  return { user: new GatekeeperUserImpl(ctx as never, env as never), client };
}

async function configuratorFor(user: GatekeeperUserImpl): Promise<McpServerConfiguratorRpc> {
  const frame = await user.startResourceConfigurator("https://gw.example.com/*");
  return (frame.ui as unknown as { target: McpServerConfiguratorRpc }).target;
}

beforeEach(() => {
  mocks.withClient.mockReset();
});

describe("hidden portal server boundaries", () => {
  it("removes hidden servers from the configurator RPC result", async () => {
    const { user } = makeSubject();

    await expect((await configuratorFor(user)).listServerOptions()).resolves.toEqual([{
      value: "gitlab",
      title: "GitLab",
      meta: undefined,
    }]);
  });

  it("does not fetch portal data for a hidden server's tool options", async () => {
    const { user } = makeSubject();

    await expect((await configuratorFor(user)).listToolOptions("jira")).resolves.toEqual([]);
    expect(mocks.withClient).not.toHaveBeenCalled();
  });

  it("rejects a crafted hidden-server URL before fetching portal data", async () => {
    const { user } = makeSubject();

    await expect(user.getGatekeeperClassFor(`${ENDPOINT}#server=jira`))
      .rejects.toThrow(/native connector/);
    expect(mocks.withClient).not.toHaveBeenCalled();
  });

  it("keeps an existing hidden-server facet usable", async () => {
    const ctx = {
      props: {
        accountObjectId: "account-id",
        endpoint: ENDPOINT,
        serverId: "portal",
        serverName: "CF Portal",
        scopeServerName: "Jira",
        scope: { serverId: "jira" },
      },
      storage: {
        kv: {
          get: vi.fn(() => ({
            tools: [{ name: "jira_search", annotations: { readOnlyHint: true } }],
            revision: "cached",
            fetchedAt: Date.now(),
            truncated: false,
          })),
          put: vi.fn(),
        },
        sql: {},
      },
      exports: {
        McpAccount: {
          idFromString: vi.fn(() => "account-id"),
          get: vi.fn(() => ({})),
        },
      },
    };
    const facet = new McpGatekeeperImpl(ctx as never, {
      MCP_PORTAL_HIDDEN_SERVER_IDS: "jira",
    } as never);

    await expect(facet.tools()).resolves.toMatchObject([{
      tool: { name: "jira_search" },
      mode: "read",
    }]);
    expect(mocks.withClient).not.toHaveBeenCalled();
  });
});
