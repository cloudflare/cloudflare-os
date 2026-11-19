import { afterEach, expect, it, vi } from "vitest";
import { SlackApi } from "./slack-api";

vi.mock("cloudflare:workers", () => ({ RpcTarget: class { [Symbol.dispose]() {} } }));
vi.mock("capnweb-validate", () => ({ validateRpc: () => (target: unknown) => target }));

const { ConversationConfiguratorUI } = await import("./slack-configurators");

afterEach(() => vi.unstubAllGlobals());

function mockSlack() {
  let calls: string[] = [];
  let failConversations = false;
  vi.stubGlobal("fetch", async (input: string) => {
    let method = new URL(input).pathname.split("/").pop()!;
    calls.push(method);
    switch (method) {
      case "auth.test": return Response.json({ ok: true, team_id: "TONE", user_id: "UONE" });
      case "team.info": return Response.json({ ok: true, team: { id: "TONE", name: "One", domain: "one" } });
      case "users.conversations": return Response.json(failConversations
          ? { ok: false, error: "ratelimited" }
          : { ok: true, channels: [{ id: "CONE", name: "groww-support" }, { id: "CTWO", name: "general" }] });
    }
    throw new Error(`Unexpected method ${method}`);
  });
  return { calls, setFailing: (failing: boolean) => { failConversations = failing; } };
}

it("reads each list from Slack once per picker, whatever the query", async () => {
  let slack = mockSlack();
  let ui = new ConversationConfiguratorUI(new SlackApi(async () => "token"));
  await ui.listWorkspaces("");
  await ui.listConversations("TONE", "");
  let loaded = slack.calls.length;

  for (let query of ["gr", "grow", "groww"]) {
    await ui.listWorkspaces(query);
    expect((await ui.listConversations("TONE", query)).map(option => option.title))
        .toEqual(["#groww-support"]);
  }
  expect(slack.calls).toHaveLength(loaded);
  expect(slack.calls.filter(method => method === "users.conversations")).toHaveLength(1);
});

it("retries a list whose read failed", async () => {
  let slack = mockSlack();
  let ui = new ConversationConfiguratorUI(new SlackApi(async () => "token"));
  slack.setFailing(true);
  await expect(ui.listConversations("TONE", "groww")).rejects.toThrow(/rate limit/);
  slack.setFailing(false);
  expect(await ui.listConversations("TONE", "groww")).toHaveLength(1);
});
