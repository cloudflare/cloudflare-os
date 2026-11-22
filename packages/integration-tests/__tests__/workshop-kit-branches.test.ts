// gatekeeper-kit's branch support (plans/forking-reality.md) against the real Workshop, through the
// fixture's KitTestGatekeeper, which is built the way a gatekeeper adopting branches is: a kit
// session handle per session, and applyActions() and rejectAction() delegated to the kit. The
// kit's own suites cover its cases one by one; these show its half and the kernel's fit.

import { afterAll, beforeAll, expect, it } from "vitest";
import type { RpcStub } from "capnweb";
import type { ActionLogEntry, AiChatMessage, Overseer } from "@gadgets/workshop-shared/api";
import type { TestSession } from "../fixtures/gatekeeper-test/src/test-gatekeeper.js";
import { loadAllChatHistory, openAgentSession } from "../src/agent-session.js";
import {
  startTestGatekeeperHarness, TEST_VENDOR_ID, testActionState, testControl, type Harness,
} from "../src/harness.js";
import { SCRIPTED_MODEL_ID, scriptedModelRouter } from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  accountLabel, connect, listConnectedAccounts, nextUsernames, signUp, waitFor, withOwnerWorkspace,
} from "../src/rpc-client.js";

let harness: Harness;
const models = scriptedModelRouter();
const network = new NetworkInterceptor({ handlers: [models.handler] });

beforeAll(async () => {
  network.install();
  harness = await startTestGatekeeperHarness({ enableGadgetExecution: true });
});

afterAll(async () => {
  try {
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
  }
});

const kitThing = () => `https://gadgets-test.example/things/kit-${crypto.randomUUID()}`;

async function writes(overseer: RpcStub<Overseer>, gatekeeperId: number) {
  const { entries } = await overseer.listActions({ filter: "action" });
  return entries.filter((entry): entry is ActionLogEntry & { type: "action" } =>
    entry.type === "action" && entry.gatekeeperId === gatekeeperId).toSorted((a, b) => a.id - b.id);
}

it.concurrent("passes the kit's branch harness", async () => {
  await testControl(harness, "kit-harness", { label: `harness-${crypto.randomUUID()}@gadgets-test.example` });
});

it.concurrent("applies a list through the kit, and a denial rejects what it reports", async () => {
  using publicApi = connect(harness.url);
  const api = await signUp(publicApi, nextUsernames("kitlists")[0]!);
  await api.provisionAmbientAccount(TEST_VENDOR_ID);
  const account = await waitFor("the test account", async () =>
    (await listConnectedAccounts(api)).find(a => a.vendorId === TEST_VENDOR_ID) ?? null);
  const label = accountLabel(account);
  using overseer = await api.newWorkspace();
  using gatekeeper = await overseer.newGatekeeper(account.id, kitThing());
  if (!gatekeeper) throw new Error("Failed to create the test connection");
  const gatekeeperId = await gatekeeper.getId();
  using session = await gatekeeper.openSession() as RpcStub<TestSession>;
  // Staged writes apply at once unless staging holds them, as it does once the workspace has read
  // restricted data, which a plain test thing's session can report.
  using latch = await overseer.newGatekeeper(
      account.id, `https://gadgets-test.example/things/latch-${crypto.randomUUID()}`);
  using latchSession = await latch!.openSession() as RpcStub<TestSession>;
  await latchSession.readValue(true);

  for (const value of [1, 2, 3]) await session.writeValue(value);
  expect(await session.readValue()).toBe(3);
  const ids = (await writes(overseer, gatekeeperId)).map(write => write.id);
  // A staged list: everything up to the approved action, in one call.
  await overseer.approveAction(ids[1]!);
  expect((await writes(overseer, gatekeeperId)).map(write => write.state))
      .toEqual(["approved", "approved", "pending"]);
  expect(await testActionState(harness, label)).toEqual({ pending: [], value: 2, applyCount: 2 });

  await overseer.rejectAction(ids[2]!);
  expect(await session.readValue()).toBe(2);
  expect((await writes(overseer, gatekeeperId)).at(-1)?.state).toBe("rejected");
});

it.concurrent("keeps a chat's pending write on its branch until the chat's action applies", async () => {
  const resourceUrl = kitThing();
  const model = models.script([
    { toolCall: { id: "request-kit", name: "requestConnection", arguments: {
      vendorId: TEST_VENDOR_ID, resourceUrl, reason: "Set the kit value.", bindingName: "KIT",
    } } },
    { toolCall: { id: "write-kit", name: "executeCode", arguments: {
      code: "export default async function(self, env) { " +
          "console.log(await env.KIT.writeValue(7), await env.KIT.readValue()); }",
    } } },
    { text: "Written." },
  ]);
  await using agent = await openAgentSession(harness.url, {
    modelId: SCRIPTED_MODEL_ID, mode: "review", userModel: model.userModel,
    ambientVendorIds: [TEST_VENDOR_ID], usernamePrefix: "kitchat",
  });
  const label = accountLabel(agent.connectedAccount(TEST_VENDOR_ID));
  const { history } = await agent.runTurn("Set the kit value to 7.");
  const request = history.find(message => message.type === "connectionRequest");
  if (request?.type !== "connectionRequest") throw new Error("The agent did not request a connection");

  await withOwnerWorkspace(harness.url, agent.username, async overseer => {
    using gatekeeper = await overseer.newGatekeeper(agent.connectedAccount(TEST_VENDOR_ID).id, resourceUrl);
    if (!gatekeeper) throw new Error("Failed to create the kit connection");
    const gatekeeperId = await gatekeeper.getId();
    await overseer.acceptConnectionRequest(request.requestId, { gatekeeperId });
    await waitFor("the resumed turn to finish", async () =>
      model.remainingSteps() === 0 && !(await overseer.listChats())[0]?.activeAgent || null);

    // The chat read its own write; a session outside the chat does not see it.
    const chatId = (await overseer.listChats())[0]!.id;
    const messages = await loadAllChatHistory(before => overseer.getChatHistory(chatId, before));
    expect(codeOutputs(messages).join("\n")).toContain("1 7");
    using staging = await gatekeeper.openSession() as RpcStub<TestSession>;
    expect(await staging.readValue()).toBe(0);

    const [chatWrite] = await writes(overseer, gatekeeperId);
    expect(chatWrite?.chatId).toBe(chatId);
    await overseer.approveAction(chatWrite!.id);
    expect(await staging.readValue()).toBe(7);
    expect(await testActionState(harness, label)).toEqual({ pending: [], value: 7, applyCount: 1 });
  });
});

// The output of every executeCode call the agent made, in order.
const codeOutputs = (messages: AiChatMessage[]) => messages.flatMap(message =>
  message.type === "message" ? message.toolCalls ?? [] : []).flatMap(call =>
    call.toolName === "executeCode" ? [String(call.output)] : []);
