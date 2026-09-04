// createExternalResource end to end against the fixture gatekeeper: tool → binding → action card
// → approve → describe refresh, plus the rejection path, replay across turns, and a vendor that
// fails after queueing its creation action. (Provider depth is covered by per-vendor suites,
// e.g. gatekeeper-google's workerd tests.)

import { afterAll, beforeAll, expect, it } from "vitest";
import type { RpcStub } from "capnweb";
import type {
  AiChatAuthorInfo, AiModelConfig, AuthenticatedApi, Overseer, PublicApi,
} from "@gadgets/workshop-shared/api";
import { startTestGatekeeperHarness, TEST_VENDOR_ID, type Harness } from "../src/harness.js";
import { scriptedChatCompletions } from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  connect, listConnectedAccounts, nextUsernames, signUp, waitFor,
} from "../src/rpc-client.js";

const MODEL_ID = "@cf/zai-org/glm-5.2";
const MODEL_PROFILE: AiChatAuthorInfo = { type: "agent", id: MODEL_ID, name: "Scripted model" };
const MODEL_CONFIG: AiModelConfig = {
  provider: "cloudflare",
  model: MODEL_ID,
  accountId: "test-account",
  apiToken: "test-token",
};

const RESOURCE_URL_PATTERN = "https://gadgets-test.example/things/*";

let harness: Harness;
const model = scriptedChatCompletions([
  // --- Test 1, turn 1: a fixable rejection, then a successful creation, used immediately.
  {
    toolCall: {
      id: "create-bad-type",
      name: "createExternalResource",
      arguments: {
        vendorId: TEST_VENDOR_ID,
        resourceUrlPattern: "https://gadgets-test.example/nope/*",
        title: "My Thing",
        bindingName: "NEW_THING",
      },
    },
  },
  {
    toolCall: {
      id: "create-thing",
      name: "createExternalResource",
      arguments: {
        vendorId: TEST_VENDOR_ID,
        resourceUrlPattern: RESOURCE_URL_PATTERN,
        title: "My Thing",
        bindingName: "NEW_THING",
      },
    },
  },
  {
    toolCall: {
      id: "read-new-thing",
      name: "executeCode",
      arguments: {
        code: "export default async function(self, env) { console.log(await env.NEW_THING.readValue()); }",
      },
    },
  },
  { text: "Created the thing and read 42 from it." },
  // --- Test 1, turn 2 (after approval): the replayed binding still works, and the write's
  // action snapshot shows the refreshed (created) resource URL. writeValue awaits a decision,
  // so this turn deliberately suspends.
  {
    toolCall: {
      id: "write-new-thing",
      name: "executeCode",
      arguments: {
        code: "export default async function(self, env) { console.log(await env.NEW_THING.writeValue(9)); }",
      },
    },
  },
  // --- Test 2, turn 1: create a thing whose creation the user will reject.
  {
    toolCall: {
      id: "create-doomed",
      name: "createExternalResource",
      arguments: {
        vendorId: TEST_VENDOR_ID,
        resourceUrlPattern: RESOURCE_URL_PATTERN,
        title: "Doomed Thing",
        bindingName: "DOOMED",
      },
    },
  },
  { text: "Created the doomed thing." },
  // --- Test 2, turn 2 (after rejection): the binding is dead, with an explanation.
  {
    toolCall: {
      id: "read-doomed",
      name: "executeCode",
      arguments: {
        code: "export default async function(self, env) {" +
            " try { console.log(await env.DOOMED.readValue()); }" +
            " catch (err) { console.log('DEAD: ' + (err && err.message)); } }",
      },
    },
  },
  { text: "The doomed thing is gone." },
  // --- Test 3: the vendor fails after durably queueing its creation action; the overseer must
  // settle the orphan instead of leaving it pending against a removed gatekeeper.
  {
    toolCall: {
      id: "create-orphan",
      name: "createExternalResource",
      arguments: {
        vendorId: TEST_VENDOR_ID,
        resourceUrlPattern: RESOURCE_URL_PATTERN,
        title: "fail-after-queue",
        bindingName: "ORPHAN",
      },
    },
  },
  { text: "The creation failed." },
]);
const network = new NetworkInterceptor({ handlers: [model.handler] });

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

/** Sign up a fresh user configured with the scripted model and an ambient test-vendor account. */
async function signUpScriptedUser(
    publicApi: RpcStub<PublicApi>, prefix: string): Promise<RpcStub<AuthenticatedApi>> {
  const [username] = nextUsernames(prefix);
  if (username === undefined) throw new Error("Failed to allocate a username");
  const authenticated = await signUp(publicApi, username);
  await authenticated.addModel(MODEL_PROFILE, MODEL_CONFIG);
  await authenticated.setQuickModel(null);
  await authenticated.setPreferredModel(MODEL_ID);
  await authenticated.completeOnboarding();
  await authenticated.provisionAmbientAccount(TEST_VENDOR_ID);
  await waitFor("the ambient test account to be provisioned", async () =>
    (await listConnectedAccounts(authenticated)).find(entry => entry.vendorId === TEST_VENDOR_ID)
      ?? null);
  return authenticated;
}

/** Wait for the agent's turn to end with `text` as its closing message, failing fast on errors. */
async function waitForAgentSays(
    workspace: RpcStub<Overseer>, chatId: number, text: string): Promise<void> {
  await waitFor(`the agent to say "${text}"`, async () => {
    const current = await workspace.getChatHistory(chatId);
    const error = current.messages.find(message => message.type === "error");
    if (error !== undefined) throw new Error(`The scripted agent failed: ${error.message}`);
    return current.messages.some(message =>
      message.type === "message" && message.author.type === "agent" &&
      message.message === text) ? current : null;
  });
}

/** Wait until exactly one action is pending and return it. */
function onlyPendingAction(workspace: RpcStub<Overseer>, what: string) {
  return waitFor(what, async () => {
    const entries = (await workspace.listActions({ filter: "pending" })).entries;
    return entries.length === 1 ? entries[0] : null;
  });
}

/** The most recent tool result the mock model was shown for `toolCallId`. */
function toolResultShownToModel(toolCallId: string): string {
  for (let i = model.requests.length - 1; i >= 0; i--) {
    const request = model.requests[i] as {
      messages?: Array<{ role: string; tool_call_id?: string; content?: string }>;
    };
    const result = request.messages?.find(
        message => message.role === "tool" && message.tool_call_id === toolCallId);
    if (result?.content !== undefined) return result.content;
  }
  throw new Error(`The model never saw a tool result for ${toolCallId}`);
}

/** All user-role message contents in the model's most recent request. */
function userMessagesShownToModel(): string[] {
  const request = model.requests[model.requests.length - 1] as {
    messages?: Array<{ role: string; content?: string }>;
  };
  return (request.messages ?? [])
      .filter(message => message.role === "user")
      .map(message => message.content ?? "");
}

it("creates a resource the agent can use before the user approves it", async () => {
  using publicApi = connect(harness.url);
  using authenticated = await signUpScriptedUser(publicApi, "createres");
  using workspace = await authenticated.newGadget();
  const chatId = await workspace.newChat("Create a new test thing and read it.", MODEL_ID);

  // The turn runs to completion: creation does not suspend the agent the way requestConnection
  // or an awaitDecision action does.
  await waitForAgentSays(workspace, chatId, "Created the thing and read 42 from it.");

  // The bad resource type was a fixable rejection: the model retried within the same turn.
  expect(toolResultShownToModel("create-bad-type")).toMatch(/can create/i);
  // The successful creation told the agent the binding is live and approval is still pending.
  expect(toolResultShownToModel("create-thing")).toContain("env.NEW_THING");
  // The binding worked from executeCode before any approval: the read reached the simulated
  // resource (the fixture session answers 42).
  expect(toolResultShownToModel("read-new-thing")).toContain("42");

  // The creation action rode the normal approval flow into the chat and the action log.
  const pending = await onlyPendingAction(workspace, "the creation action to be pending");
  expect(pending).toMatchObject({
    type: "action",
    state: "pending",
    description: { title: 'Create test thing "My Thing"' },
  });
  expect(pending.resourceUrl).toContain("/things/provisional-");
  const history = await workspace.getChatHistory(chatId);
  expect(history.messages.some(message =>
    message.type === "action" && message.actionId === pending.id)).toBe(true);

  await workspace.approveAction(pending.id);

  // A second turn proves both replay (the binding is re-established from the recorded tool
  // output) and the post-apply describe refresh (the new action's snapshot carries the real,
  // no-longer-provisional resource URL).
  await workspace.sendChatMessage(chatId, "Now set its value to 9.", MODEL_ID);
  const write = await onlyPendingAction(workspace, "the write action to be pending");
  expect(write).toMatchObject({
    type: "action",
    state: "pending",
    description: { title: "Set the test value to 9" },
  });
  expect(write.resourceUrl).toContain("/things/created-");
  expect(write.resourceUrl).not.toContain("provisional");

  // Replay told the model about the approval — the recorded tool result permanently says the
  // resource doesn't exist yet, so without this the model's context never learns it now does.
  const approval = userMessagesShownToModel().find(message =>
    message.includes("The user approved the creation of env.NEW_THING"));
  expect(approval).toContain(write.resourceUrl);
});

it("kills the binding when the user rejects the creation", async () => {
  using publicApi = connect(harness.url);
  using authenticated = await signUpScriptedUser(publicApi, "createrej");
  using workspace = await authenticated.newGadget();
  const chatId = await workspace.newChat("Create a doomed test thing.", MODEL_ID);
  await waitForAgentSays(workspace, chatId, "Created the doomed thing.");

  const pending = await onlyPendingAction(workspace, "the creation action to be pending");
  await workspace.rejectAction(pending.id);

  // The next turn's use of the binding fails with the gatekeeper's dead-binding explanation
  // rather than silently simulating against nothing.
  await workspace.sendChatMessage(chatId, "Read the doomed thing.", MODEL_ID);
  await waitForAgentSays(workspace, chatId, "The doomed thing is gone.");
  expect(toolResultShownToModel("read-doomed")).toContain("DEAD:");
  expect(toolResultShownToModel("read-doomed")).toMatch(/rejected/);

  // Replay told the model about the rejection too.
  expect(userMessagesShownToModel().some(message =>
    message.includes("The user rejected the creation of env.DOOMED"))).toBe(true);
});

it("settles the queued action when the vendor fails after queueing it", async () => {
  using publicApi = connect(harness.url);
  using authenticated = await signUpScriptedUser(publicApi, "createfail");
  using workspace = await authenticated.newGadget();
  const chatId = await workspace.newChat("Create a failing test thing.", MODEL_ID);
  await waitForAgentSays(workspace, chatId, "The creation failed.");

  // The tool reported a fixable rejection carrying the vendor's error...
  expect(toolResultShownToModel("create-orphan")).toContain("Simulated post-queue failure");

  // ...and the action the vendor had already queued was settled with the removed gatekeeper,
  // not left pending forever (approve/reject would both fail on the missing facet).
  const actions = (await workspace.listActions({ filter: "all" })).entries;
  expect(actions.filter(action => action.state === "pending")).toEqual([]);
  expect(actions.some(action => action.type === "action" && action.state === "rejected"))
      .toBe(true);
  expect(model.remainingSteps()).toBe(0);
});
