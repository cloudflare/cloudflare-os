// This gatekeeper's upstream: what it is declared as, and that it is the one the account and the
// facet hand the shared MCP library, so that every request to the portal is guarded and counted
// under this vendor. Points are read back from a fake `METRICS` dataset.

import { env } from "cloudflare:workers";
import {
  COMMON_SLOTS, SUBSERVICE_V1_SLOTS, type BlobSlot, type DoubleSlot,
} from "@gadgets/observability/metrics";
import type { ConnectedServer } from "@gadgets/mcp-shared/account";
import { FetchNotStartedError } from "@gadgets/mcp-shared/fetch";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("capnweb-validate", () => ({
  validateRpc: () => (value: unknown) => value,
  skipRpcValidation: () => (value: unknown) => value,
}));

import { McpAccount, McpGatekeeperImpl } from "../src/portal.js";
import { portalUpstream } from "../src/upstream.js";

// A host no other suite of the package requests.
const ENDPOINT = "https://mcp.upstream-test.example/mcp";

const ambient = env as { METRICS?: AnalyticsEngineDataset; SUBSERVICE_METRICS?: string };
let points: AnalyticsEngineDataPoint[];

beforeEach(() => {
  points = [];
  ambient.METRICS = { writeDataPoint: point => { if (point) points.push(point); } };
  ambient.SUBSERVICE_METRICS = "true";
});

afterEach(() => {
  delete ambient.METRICS;
  delete ambient.SUBSERVICE_METRICS;
  vi.unstubAllGlobals();
});

// A written point's value in one column.
function column(point: AnalyticsEngineDataPoint, slot: BlobSlot | DoubleSlot) {
  const values = slot.startsWith("blob") ? point.blobs : point.doubles;
  return values?.[Number(slot.replace(/\D+/, "")) - 1];
}

// Each point written, as its source, service, operation and outcome.
function counted() {
  return points.map(point => [
    SUBSERVICE_V1_SLOTS.source, SUBSERVICE_V1_SLOTS.service, SUBSERVICE_V1_SLOTS.operation,
    COMMON_SLOTS.outcome,
  ].map(slot => column(point, slot)));
}

// An MCP server that answers every JSON-RPC request with an empty result and every notification
// with a 202, recording the URL of each request.
function mcpServer(): string[] {
  const urls: string[] = [];
  vi.stubGlobal("fetch", async (input: string | URL, init: RequestInit = {}) => {
    urls.push(String(input));
    const { id } = JSON.parse(String(init.body)) as { id?: string };
    if (id === undefined) return new Response(null, { status: 202 });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: {} }), {
      headers: { "Content-Type": "application/json" },
    });
  });
  return urls;
}

// The account's connect probe, which is protected.
class ProbingAccount extends McpAccount {
  run(server: ConnectedServer) {
    return this.probe(server, null);
  }
}

describe("the upstream of the MCP Server Portals gatekeeper", () => {
  it("is declared under the vendor id, with no service of its own", () => {
    expect(portalUpstream.vendorId).toBe("mcp_portal");
    expect(portalUpstream.source).toBe("gatekeeper.mcp_portal.api");
  });

  it("names no request by its URL: the library names each one", () => {
    expect(portalUpstream.operationOf("POST", ENDPOINT)).toBe("POST");
  });

  it("sends through the guard: a refused host is neither contacted nor counted", async () => {
    const urls = mcpServer();
    await expect(portalUpstream.request("http://169.254.169.254/latest/meta-data/"))
      .rejects.toBeInstanceOf(FetchNotStartedError);
    await expect(portalUpstream.request("http://mcp.upstream-test.example/mcp"))
      .rejects.toBeInstanceOf(FetchNotStartedError);
    expect(urls).toEqual([]);
    expect(points).toEqual([]);
  });

  it("counts the facet's calls under the vendor, never the server's host", async () => {
    const urls = mcpServer();
    const account = {
      getConnection: async () => ({ authorization: "token", sessionId: "session", generation: 1 }),
      assertConnectionCurrent: async () => {},
      setMcpSessionId: async () => true,
      noteCredentialsExpired: async () => {},
    };
    const facet = new McpGatekeeperImpl({
      props: {
        accountObjectId: "account-id", serverId: "portal", serverName: "Portal", endpoint: ENDPOINT,
        scope: { serverId: "jira" },
      },
      storage: { kv: {} },
      exports: { McpAccount: { idFromString: () => "account-id", get: () => account } },
    } as never, {} as never);

    await facet.call(client => client.callTool("create_issue", {}));

    expect(urls).toEqual([ENDPOINT]);
    expect(counted()).toEqual([["gatekeeper.mcp_portal.api", "mcp_portal", "tools.call", "success"]]);
  });

  it("counts the account's connect probe under the vendor", async () => {
    const urls = mcpServer();
    const account = new ProbingAccount({ storage: { kv: {} } } as never, {} as never);

    await account.run({
      endpoint: ENDPOINT, serverId: "example", serverName: "Example", provenance: "deployment",
      auth: "none",
    });

    expect(urls).toEqual([ENDPOINT, ENDPOINT]);
    expect(counted()).toEqual([
      ["gatekeeper.mcp_portal.api", "mcp_portal", "initialize", "success"],
      ["gatekeeper.mcp_portal.api", "mcp_portal", "notifications.initialized", "success"],
    ]);
  });
});
