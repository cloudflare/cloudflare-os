// What a deployment that never set WEBHOOK_ORIGIN gets from the real GitLab gatekeeper through the
// real Workshop: connecting, reading and approved writes work as before, a gadget asking for a hook
// is told why it can't have one, and nothing is ever asked of GitLab's webhooks.

import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { GitLabProject } from "../../gatekeeper-gitlab/src/types.js";
import { startHarness, type Harness } from "../src/harness.js";
import { SCRIPTED_MODEL_ID, scriptedModelRouter } from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { connect, nextUsernames, signUp, waitFor, waitForIdleChat } from "../src/rpc-client.js";
import { FakeGitLab, GITLAB, GITLAB_BASE_URL, GITLAB_WORKER, connectGitLab, gitlabGatekeeper } from "./gitlab-fake.js";

const gitlab = new FakeGitLab();
const models = scriptedModelRouter();
const network = new NetworkInterceptor({ handlers: [models.handler, gitlab.handler] });
let harness: Harness;

beforeAll(async () => {
  network.install();
  harness = await startHarness({
    gatekeepers: [gitlabGatekeeper({ hooks: false })], enableGadgetExecution: true,
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
  await env.GITLAB.subscribe(await env.TRIAGE[restore]({ type: "triage" }));
}`;

it("connects, reads and writes, but refuses hooks and never touches webhooks", async () => {
  using stack = new DisposableStack();
  const [username] = nextUsernames("gitlabnohooks");
  const model = models.script([
    { toolCall: { id: "server", name: "writeFile", arguments: { workpiece: "TRIAGE", filename: "server.js", content: SERVER } } },
    { text: "Built." },
    { toolCall: { id: "subscribe", name: "executeCode", arguments: { code: SUBSCRIBE } } },
    { text: "That was refused." },
  ]);
  const api = stack.use(await signUp(stack.use(connect(harness.url)), username!));
  await api.addModel(model.userModel.profile, model.userModel.config);
  const account = await connectGitLab(harness, api, username!);
  const project = gitlab.addProject(`widgets-${username}`);
  const ws = stack.use(await api.newGadget());
  const connection = stack.use(await ws.newGatekeeper(account.id, `${GITLAB}/${project.path}`));
  if (!connection) throw new Error("Failed to connect the project");
  const gadget = stack.use(await ws.createGadget("Triage", undefined, "TRIAGE"));
  await gadget.bind("GITLAB", await connection.getId());

  // Reads, and a write that waits for approval, as without hooks.
  const binding = stack.use((await gadget.getBinding("GITLAB"))!);
  const session = stack.use(await binding.openSession() as unknown as RpcStub<GitLabProject>);
  using issue = await session.getIssue("42");
  expect(await issue.getDetails()).toMatchObject({ title: "Crash on start" });
  await issue.postComment("Looking into it.");
  const [comment] = await waitFor("the comment to wait for approval", async () => {
    const { entries } = await ws.listActions({ filter: "pending" });
    return entries.length > 0 ? entries : null;
  });
  expect(comment!.description.title).toBe("Comment on #42");
  await ws.approveAction(comment!.id);
  expect(gitlab.comments).toEqual([`${project.path}#42: Looking into it.`]);

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
      content: expect.stringContaining("GitLab hooks are not configured on this deployment."),
    }),
  ]) });
  expect(await ws.listHooks()).toEqual([]);

  // The webhook route is closed too, before it would reach a driver.
  const delivery = await harness.fetchWorker(GITLAB_WORKER, `${GITLAB_BASE_URL}/webhook/${"0".repeat(64)}`,
    { method: "POST", headers: { "X-Gitlab-Event": "Issue Hook" }, body: "{}" });
  expect(delivery.status).toBe(404);
  expect(gitlab.requests.filter(request => /\/hooks(\/|$)/.test(request))).toEqual([]);

  await api.disconnectAccount(account.id);
  expect(gitlab.revokedTokens).toEqual([`refresh-${username}`, `token-${username}`]);
});
