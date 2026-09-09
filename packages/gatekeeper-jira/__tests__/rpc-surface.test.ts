import { afterEach, expect, it, vi } from "vitest";
import { newMessagePortRpcSession } from "capnweb";
import { JiraIssueGatekeeperImpl, JiraProjectGatekeeperImpl, JiraSiteGatekeeperImpl } from "../src/jira";
import type { JiraIssue } from "../src/types";

// Exercise actual Cap'n Web dispatch in the Node suite, not property calls on the empty
// Workers RpcTarget stub. Native workerd dispatch is not exercised by this harness.
vi.mock("cloudflare:workers", async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  RpcTarget: (await import("capnweb")).RpcTarget,
}));

afterEach(() => vi.unstubAllGlobals());

it.each(["site", "project", "issue"] as const)("does not expose issue staging over RPC through a %s binding", async kind => {
  const gatekeeper = kind === "site" ? new JiraSiteGatekeeperImpl() : kind === "project" ? new JiraProjectGatekeeperImpl() : new JiraIssueGatekeeperImpl();
  const values = new Map<string, unknown>();
  Object.assign(gatekeeper, { ctx: {
    props: { cloudId: "cloud-1", webBase: "https://one.atlassian.net", userObjectId: "owner", projectKey: "ENG", issueKey: "ENG-1" },
    exports: { UserAccount: { idFromString: (s: string) => s, get: () => ({ getAccessTokenForSite: async () => "token" }) } },
    storage: { kv: { get: (key: string) => values.get(key), put: (key: string, value: unknown) => values.set(key, value) } },
  } });
  const queue = {
    authorizeObservation: vi.fn(async () => {}),
    submitAction: vi.fn(async () => {}),
    dup() { return this; },
    [Symbol.dispose]: vi.fn(),
  };
  const fetchMock = vi.fn(async () => Response.json({ id: "1", key: "ENG-1", fields: { project: { key: "ENG" } } }));
  vi.stubGlobal("fetch", fetchMock);
  const session = await gatekeeper.startSession(queue as never);
  const issue = "getIssue" in session ? await session.getIssue("ENG-1") : session;
  fetchMock.mockClear();

  const channel = new MessageChannel();
  try {
    using _server = newMessagePortRpcSession(channel.port1, issue);
    // Deliberately forge the client's type to send methods absent from the public API.
    using client = newMessagePortRpcSession<JiraIssue & {
      stage(...args: unknown[]): Promise<void>;
      "#stage"(...args: unknown[]): Promise<void>;
    }>(channel.port2);
    const foreignAction = { kind: "update", issue: "PAY-1", fields: { summary: "Outside the issue capability" } };
    await expect(client.stage(foreignAction, "Update", "Update", true)).rejects.toThrow(/stage/);
    await expect(client["#stage"](foreignAction, "Update", "Update", true)).rejects.toThrow(/stage/);
    expect(queue.submitAction).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(values.size).toBe(0);

    // The supported operation still stages a write, with the issue fixed by the capability.
    await client.update({ summary: "Legitimate edit" });
    expect(queue.submitAction).toHaveBeenCalledTimes(1);
    expect(values.get("action:1")).toMatchObject({ state: "pending", action: { kind: "update", issue: "ENG-1", fields: { summary: "Legitimate edit" } } });
    expect(fetchMock).not.toHaveBeenCalled();
  } finally {
    channel.port1.close();
    channel.port2.close();
    if (session !== issue && Symbol.dispose in session && typeof session[Symbol.dispose] === "function") session[Symbol.dispose]();
  }
});
