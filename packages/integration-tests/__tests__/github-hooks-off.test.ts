// What a deployment that never set WEBHOOK_ORIGIN gets from the real GitHub gatekeeper through the
// real Workshop: connecting, reading and approved writes work as before, a gadget asking for a hook
// is told why it can't have one, and nothing is ever asked of GitHub's webhooks.

import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { GitHubRepo } from "../../gatekeeper-github/src/types.js";
import { startHarness, type Harness } from "../src/harness.js";
import { SCRIPTED_MODEL_ID, scriptedModelRouter } from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { connect, nextUsernames, signUp, waitFor, waitForIdleChat } from "../src/rpc-client.js";
import { FakeGitHub, GITHUB_BASE_URL, GITHUB_WORKER, connectGitHub, githubGatekeeper } from "./github-fake.js";

const github = new FakeGitHub();
const models = scriptedModelRouter();
const network = new NetworkInterceptor({ handlers: [models.handler, github.handler] });
let harness: Harness;

beforeAll(async () => {
  network.install();
  harness = await startHarness({
    gatekeepers: [githubGatekeeper({ hooks: false })], enableGadgetExecution: true,
  });
});

afterAll(async () => {
  try {
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
  }
});

const SERVER = `import { DurableObject, RpcTarget, restore } from "cloudflare:workers";
export class Gadget extends DurableObject {
  async [restore](params) { return new Triage(); }
}
class Triage extends RpcTarget {
  async receiveEvent(event) {}
}`;

const SUBSCRIBE = `import { restore } from "cloudflare:workers";
export default async function(self, env) {
  await env.GITHUB.subscribe(await env.TRIAGE[restore]({ type: "triage" }));
}`;

it("connects, reads and writes, but refuses hooks and never touches webhooks", async () => {
  using stack = new DisposableStack();
  const [username] = nextUsernames("githubnohooks");
  const model = models.script([
    { toolCall: { id: "server", name: "writeFile", arguments: { workpiece: "TRIAGE", filename: "server.js", content: SERVER } } },
    { text: "Built." },
    { toolCall: { id: "subscribe", name: "executeCode", arguments: { code: SUBSCRIBE } } },
    { text: "That was refused." },
  ]);
  const api = stack.use(await signUp(stack.use(connect(harness.url)), username!));
  await api.addModel(model.userModel.profile, model.userModel.config);
  const account = await connectGitHub(harness, api, username!);
  const repo = github.addRepository(`widgets-${username}`);
  const ws = stack.use(await api.newGadget());
  const connection = stack.use(await ws.newGatekeeper(account.id, `https://github.com/acme/${repo.name}`));
  if (!connection) throw new Error("Failed to connect the repository");
  const gadget = stack.use(await ws.createGadget("Triage", undefined, "TRIAGE"));
  await gadget.bind("GITHUB", await connection.getId());

  // Reads, and a write that waits for approval, as without hooks.
  const binding = stack.use((await gadget.getBinding("GITHUB"))!);
  const session = stack.use(await binding.openSession() as unknown as RpcStub<GitHubRepo>);
  using issue = await session.getIssue("42");
  expect(await issue.getDetails()).toMatchObject({ id: "42", title: "Crash on start" });
  await issue.postComment("Looking into it.");
  const [comment] = await waitFor("the comment to wait for approval", async () => {
    const { entries } = await ws.listActions({ filter: "pending" });
    return entries.length > 0 ? entries : null;
  });
  expect(comment!.description.title).toBe("Comment on #42");
  await ws.approveAction(comment!.id);
  expect(github.comments).toEqual([`${repo.name}#42: Looking into it.`]);

  // A hook, asked for as an agent would, is refused with the reason.
  const chatId = await ws.newChat("Build the triage gadget.", SCRIPTED_MODEL_ID);
  await waitFor("the build turn", async () => model.requests.length === 2 || null);
  await waitForIdleChat(ws, chatId);
  expect((await ws.mergeChanges(chatId)).outcome).toBe("merged");
  await ws.sendChatMessage(chatId, "Subscribe it.", SCRIPTED_MODEL_ID);
  await waitFor("the subscribe turn", async () => model.requests.length === 4 || null);
  await waitForIdleChat(ws, chatId);
  expect(model.requests[3]).toMatchObject({ messages: expect.arrayContaining([
    expect.objectContaining({
      role: "tool", tool_call_id: "subscribe",
      content: expect.stringContaining("GitHub hooks are not configured on this deployment."),
    }),
  ]) });
  expect(await ws.listHooks()).toEqual([]);

  // The webhook route is closed too, before it would reach a driver.
  const delivery = await harness.fetchWorker(GITHUB_WORKER, `${GITHUB_BASE_URL}/webhook/${"0".repeat(64)}`,
    { method: "POST", headers: { "X-GitHub-Event": "issues" }, body: "{}" });
  expect(delivery.status).toBe(404);
  expect(github.requests.filter(request => /\/hooks(\/|$)/.test(request))).toEqual([]);

  await api.disconnectAccount(account.id);
  expect(github.revokedTokens).toEqual([`token-${username}`]);
});
