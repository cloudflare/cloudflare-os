// The portal facet's observer contract: every read through a binding reports the upstream server
// its grant names as `server/<upstreamServerId>`, and both `addObserver()` and
// `verifyObserverAccess()` admit only the account the binding reads with, refusing any ID the
// binding did not report. The endpoint is faked at `withClient`, and the catalog is served from the
// facet's cache. Approved-call results take the session's same reporting path, covered against the
// session alone in mcp-shared, since the action store needs SQLite.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Connection from "@gadgets/mcp-shared/connection";
import type { ToolScope } from "@gadgets/mcp-shared/scope";

const mocks = vi.hoisted(() => ({ withClient: vi.fn() }));

vi.mock("capnweb-validate", () => ({
  validateRpc: () => (value: unknown) => value,
  skipRpcValidation: () => (value: unknown) => value,
}));

vi.mock("@gadgets/mcp-shared/connection", async importOriginal => ({
  ...await importOriginal<typeof Connection>(),
  withClient: mocks.withClient,
}));

import { McpGatekeeperImpl, McpPortalVerifier } from "../src/portal.js";

const ENDPOINT = "https://gw.example.com/mcp?tenant=a";

/** The portal's tools: its own control tool, and tools of two upstream servers. */
const CATALOG = [
  { name: "portal_list_servers", annotations: { readOnlyHint: true } },
  { name: "jira_search", description: "Search issues", annotations: { readOnlyHint: true } },
  { name: "jira_create_issue", description: "Create an issue" },
  { name: "gitlab_list", annotations: { readOnlyHint: true } },
];

/**
 * A portal facet as `getGatekeeperClassFor` mints it: the portal's own `serverId` is `portal`, the
 * upstream server is the scope's. `scopeServerName` is left out, as on bindings minted before it
 * was persisted.
 */
function portalFacet(scope: ToolScope & { serverId: string }) {
  const ctx = {
    props: {
      accountObjectId: "account-id", endpoint: ENDPOINT, serverId: "portal", serverName: "CF Portal", scope,
    },
    storage: {
      kv: {
        get: () => ({ tools: CATALOG, revision: "cached", fetchedAt: Date.now(), truncated: false }),
        put() {},
      },
    },
    exports: { McpAccount: { idFromString: () => "account-id", get: () => ({}) } },
  };
  return new McpGatekeeperImpl(ctx as never, {} as never);
}

type Observation = { title: string; subresources?: string[] };

function recordingQueue() {
  const observations: Observation[] = [];
  return {
    observations,
    dup() { return this; },
    authorizeObservation(description: Observation) { observations.push(description); },
  };
}

/** An observer whose verifier, as `getVerifier()` mints it, stands for portal account `account`. */
const observer = (id: string, account: string) => ({
  id,
  verifier: new McpPortalVerifier({ props: { accountObjectId: account } } as never, {} as never) as never,
});

beforeEach(() => {
  mocks.withClient.mockReset();
  // The endpoint answers every call with one line of text.
  mocks.withClient.mockImplementation(async (...args: unknown[]) => {
    const fn = args[3] as (client: object) => unknown;
    return fn({
      callTool: async () => ({ content: [{ type: "text", text: "PROJ-1" }] }),
    });
  });
});

describe("portal observations", () => {
  it("report the upstream server, not the portal, on every read, empty and cached ones included", async () => {
    const facet = portalFacet({ serverId: "jira" });
    const queue = recordingQueue();
    const session = await facet.startSession(queue as never);

    expect(await session.listTools()).toHaveLength(2);
    expect(await session.listTools({ name: "jira_search" })).toHaveLength(1);
    expect(await session.listTools({ name: "jira_missing" })).toEqual([]);
    expect(await session.listTools({ search: "issue" })).toHaveLength(2);
    expect(await session.callTool("jira_search", {})).toMatchObject({ status: "ok", text: "PROJ-1" });

    expect(queue.observations).toHaveLength(5);
    for (const observation of queue.observations) {
      expect(observation.subresources, observation.title).toEqual(["server/jira"]);
    }
  });

  it("keep a selected-tool grant to its tools and away from the portal's own", async () => {
    const facet = portalFacet({ serverId: "jira", tools: ["jira_search"] });
    const queue = recordingQueue();
    const session = await facet.startSession(queue as never);

    expect((await session.listTools()).map(tool => tool.name)).toEqual(["jira_search"]);
    for (const name of ["jira_create_issue", "gitlab_list", "portal_list_servers"]) {
      await expect(session.callTool(name, {}), name).rejects.toThrow(/does not grant/);
    }
    expect(queue.observations.map(observation => observation.subresources)).toEqual([["server/jira"]]);
  });
});

describe("portal observer admission", () => {
  it("allows only observers through the account the binding reads with", async () => {
    const facet = portalFacet({ serverId: "jira" });

    await expect(facet.verifyObserverAccess([
      observer("connector", "account-id"),
      // The same person or portal user, through another connected account.
      observer("connector-elsewhere", "account-id-2"),
      observer("colleague", "colleague-account"),
    ], ["server/jira", "server/jira"])).resolves.toEqual({ allowedObserverIds: ["connector"] });
  });

  it("admits the binding's account at every open, and refuses everyone else", async () => {
    const facet = portalFacet({ serverId: "jira" });
    const { verifier } = observer("connector", "account-id");

    await expect(facet.addObserver("connector", verifier)).resolves.toBeUndefined();
    // The refusal says who can open it, since the collaborator who added the connection can.
    await expect(facet.addObserver("colleague", observer("colleague", "colleague-account").verifier))
      .rejects.toThrow(/only be opened by its owner and by whoever added this connection/);
  });

  it("refuses the whole call for any ID the binding did not report", async () => {
    const facet = portalFacet({ serverId: "jira" });
    const connector = observer("connector", "account-id");
    for (const id of [
      "server/gitlab",
      // The portal's own id, which no read reports.
      "server/portal",
      "server/jira/tool/jira_search",
      "mcp/server/jira",
      "tool/jira",
      "server/%6Aira",
      "server/",
      "server",
      "",
    ]) {
      await expect(facet.verifyObserverAccess([connector], ["server/jira", id]), id)
        .rejects.toThrow(/subresource ID/);
    }
    await expect(facet.verifyObserverAccess([connector], [])).rejects.toThrow(/no subresources/);
  });

  it("fails the whole call when an observer's account cannot be read", async () => {
    const facet = portalFacet({ serverId: "jira" });
    const unreachable = {
      id: "unreachable",
      verifier: { getAccountObjectId: async () => { throw new Error("verifier unavailable"); } } as never,
    };

    await expect(facet.verifyObserverAccess(
      [observer("connector", "account-id"), unreachable], ["server/jira"],
    )).rejects.toThrow("verifier unavailable");
  });
});
