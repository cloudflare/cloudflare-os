// A GitHub hook's whole life through the real Workshop and the real GitHub gatekeeper, with only
// GitHub itself faked (github-fake.ts): a gadget subscribes, the user enables the hook, a signed
// webhook delivery runs the gadget, its write waits for approval, and disabling the hook, removing
// the connection and disconnecting the account each clean up after it.

import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { AuthenticatedApi, Overseer } from "@gadgets/workshop-shared/api";
import { startHarness, type Harness } from "../src/harness.js";
import { SCRIPTED_MODEL_ID, scriptedModelRouter } from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { connect, nextUsernames, signUp, waitFor, waitForIdleChat } from "../src/rpc-client.js";
import { FakeGitHub, connectGitHub, githubGatekeeper } from "./github-fake.js";

const github = new FakeGitHub();
const models = scriptedModelRouter();
const network = new NetworkInterceptor({ handlers: [models.handler, github.handler] });
let harness: Harness;

beforeAll(async () => {
  network.install();
  harness = await startHarness({ gatekeepers: [githubGatekeeper()], enableGadgetExecution: true });
});

afterAll(async () => {
  try {
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
  }
});

/** A gadget whose `triage` hook comments on each issue opened. */
const TRIAGE_SERVER = `import { DurableObject, RpcTarget, restore } from "cloudflare:workers";
export class Gadget extends DurableObject {
  async [restore](params) {
    if (params.type !== "triage") throw new TypeError("Unknown restore type: " + params.type);
    return new Triage();
  }
}
class Triage extends RpcTarget {
  async receiveEvent(event) {
    if (event.kind === "issue" && event.action === "opened") await event.issue.postComment("Thanks, on it.");
  }
}`;

const SUBSCRIBE = `import { restore } from "cloudflare:workers";
export default async function(self, env) {
  await env.GITHUB.subscribe(await env.HOOKED[restore]({ type: "triage" }), { events: ["issue"] });
}`;

/**
 * A workspace whose HOOKED gadget is bound to repository `repo` as GITHUB, and has subscribed a
 * hook there, built and subscribed through chat turns as the agent would.
 */
async function subscribedWorkspace(api: RpcStub<AuthenticatedApi>, accountId: number, repo: string) {
  const model = models.script([
    { toolCall: { id: "server", name: "writeFile", arguments: {
      workpiece: "HOOKED", filename: "server.js", content: TRIAGE_SERVER,
    } } },
    { text: "Built." },
    { toolCall: { id: "subscribe", name: "executeCode", arguments: { code: SUBSCRIBE } } },
    { text: "Subscribed." },
  ]);
  await api.addModel(model.userModel.profile, model.userModel.config);
  const ws = await api.newGadget();
  const connection = await ws.newGatekeeper(accountId, `https://github.com/acme/${repo}`);
  if (!connection) throw new Error("Failed to connect the repository");
  using hooked = await ws.createGadget("Hooked", undefined, "HOOKED");
  // Bound before the chat opens: a permanent edge seeds a new chat's env under its name.
  await hooked.bind("GITHUB", await connection.getId());
  const chatId = await ws.newChat("Build the triage hook.", SCRIPTED_MODEL_ID);
  await waitFor("the build turn", async () => model.requests.length === 2 || null);
  await waitForIdleChat(ws, chatId);
  expect((await ws.mergeChanges(chatId)).outcome).toBe("merged");
  await ws.sendChatMessage(chatId, "Subscribe it.", SCRIPTED_MODEL_ID);
  await waitFor("the subscribe turn", async () => model.requests.length === 4 || null);
  await waitForIdleChat(ws, chatId);
  expect(model.remainingSteps()).toBe(0);
  return { ws, connection };
}

const pendingTitles = async (ws: RpcStub<Overseer>) =>
  (await ws.listActions({ filter: "pending" })).entries.map(entry => entry.description.title);

it("runs a hook from enabling, through a delivery and its approved write, to its removal", async () => {
  using stack = new DisposableStack();
  const [username] = nextUsernames("githubhooks");
  const api = stack.use(await signUp(stack.use(connect(harness.url)), username!));
  const account = await connectGitHub(harness, api, username!);
  const repo = github.addRepository(`widgets-${username}`);
  const { ws, connection } = await subscribedWorkspace(api, account.id, repo.name);
  stack.use(ws);
  stack.use(connection);

  // Bound disabled: nothing changes on GitHub until the user enables it.
  const [hook] = await ws.listHooks();
  expect(hook).toMatchObject({ enabled: false, description: { title: `Watch acme/${repo.name} on GitHub` } });
  const ownWebhooks = () => [...github.webhooks.values()].filter(webhook => webhook.repo === repo.name);
  expect(ownWebhooks()).toEqual([]);
  await ws.enableHook(hook!.id);
  const [webhook] = ownWebhooks();
  expect(webhook).toMatchObject({ events: ["issues"], active: true });
  expect(webhook!.url).toMatch(/^https:\/\/workshop\.test\/gatekeeper\/github\/webhook\/[0-9a-f]{64}$/);

  // A delivery signed with another secret is refused; GitHub's own runs the gadget, whose
  // comment waits for approval.
  expect(await github.deliver(harness, "issues", github.issueEvent("opened", repo.name, 42),
    { to: [{ ...webhook!, secret: "not-the-secret" }] })).toEqual([401]);
  expect(await github.deliver(harness, "issues", github.issueEvent("opened", repo.name, 42))).toEqual([204]);
  await waitFor("the hook's comment to wait for approval", async () =>
    (await pendingTitles(ws)).includes("Comment on #42") || null);
  const { entries: observations } = await ws.listActions({ filter: "observation" });
  expect(observations.map(entry => entry.description.title))
    .toContain(`GitHub issue #42 opened: Crash on start`);
  expect(github.comments).toEqual([]);
  const [comment] = (await ws.listActions({ filter: "pending" })).entries;
  await ws.approveAction(comment!.id);
  expect(github.comments).toEqual([`${repo.name}#42: Thanks, on it.`]);

  // Disabled, the hook's webhook goes, and a late delivery to it is refused.
  await ws.disableHook(hook!.id);
  expect(github.deletedWebhooks).toContain(webhook!.id);
  expect(await github.deliver(harness, "issues", github.issueEvent("opened", repo.name, 43), { to: [webhook!] }))
    .toEqual([404]);

  // Enabled again, then removed with the connection: its webhook goes again.
  await ws.enableHook(hook!.id);
  const [again] = ownWebhooks();
  await connection.remove();
  expect(await ws.listHooks()).toEqual([]);
  await waitFor("the removed connection's webhook to be deleted", async () =>
    github.deletedWebhooks.includes(again!.id) || null);
  expect(await github.deliver(harness, "issues", github.issueEvent("opened", repo.name, 44), { to: [again!] }))
    .toEqual([404]);
  expect(await pendingTitles(ws)).toEqual([]);

  // Disconnecting the account revokes its token.
  await api.disconnectAccount(account.id);
  expect(github.revokedTokens).toEqual([`token-${username}`]);
});
