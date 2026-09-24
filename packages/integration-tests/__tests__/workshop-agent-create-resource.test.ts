// createExternalResource end to end against the fixture gatekeeper: tool → binding → action card
// → out-of-order refusal → in-order approval → class swap, plus the rejection path and replay
// across turns. (Provider depth is covered by per-vendor suites, e.g. gatekeeper-google's workerd
// tests.)

import { afterAll, beforeAll, expect, it } from "vitest";
import type { RpcStub } from "capnweb";
import type { AuthenticatedApi, Overseer, PublicApi } from "@gadgets/workshop-shared/api";
import {
  startTestGatekeeperHarness, TEST_GATEKEEPER_WORKER, TEST_VENDOR_ID, type Harness,
} from "../src/harness.js";
import {
  scriptedChatCompletions, SCRIPTED_MODEL_CONFIG, SCRIPTED_MODEL_ID, SCRIPTED_MODEL_PROFILE,
  type ScriptedChatCompletions,
} from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  accountLabel, connect, listConnectedAccounts, nextUsernames, signUp, waitFor,
} from "../src/rpc-client.js";


const RESOURCE_URL_PATTERN = "https://gadgets-test.example/things/*";

let harness: Harness;
// Each test owns its script (assigned before its first turn) so tests stay independently
// runnable; the interceptor delegates to whichever script is current.
let model: ScriptedChatCompletions;
const network = new NetworkInterceptor({
  handlers: [(url, method, headers, request) => model.handler(url, method, headers, request)],
});

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
  await authenticated.addModel(SCRIPTED_MODEL_PROFILE, SCRIPTED_MODEL_CONFIG);
  await authenticated.setQuickModel(null);
  await authenticated.setPreferredModel(SCRIPTED_MODEL_ID);
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

/** The hydrated action card for `actionId` in the chat history (what the UI renders from). */
async function actionCard(workspace: RpcStub<Overseer>, chatId: number, actionId: number) {
  const history = await workspace.getChatHistory(chatId);
  const message = history.messages.find(entry =>
    entry.type === "action" && entry.actionId === actionId);
  if (message?.type !== "action") throw new Error(`No action card for action ${actionId}`);
  return message;
}

/** Vendor-side action bookkeeping for `label` (the fixture control DO's view). */
async function actionState(label: string) {
  const response = await harness.fetchWorker(
      TEST_GATEKEEPER_WORKER, "http://gatekeeper-test.test/control/action-state",
      { method: "POST", body: JSON.stringify({ label }) });
  if (response.status !== 200) {
    throw new Error(`Reading test action state failed with ${response.status}`);
  }
  // Loose shape: the assertions pin the fields that matter.
  return await response.json() as { pending: unknown[]; value?: number; applyCount: number };
}

it("creates a resource the agent can use before the user approves it", async () => {
  model = scriptedChatCompletions([
    // Turn 1: a fixable rejection, then a successful creation, used immediately.
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
    // Turn 2: replay re-establishes the binding, and a write is queued against the
    // still-provisional resource. writeValue awaits a decision, so this turn suspends.
    {
      toolCall: {
        id: "write-new-thing",
        name: "executeCode",
        arguments: {
          code: "export default async function(self, env) { console.log(await env.NEW_THING.writeValue(9)); }",
        },
      },
    },
    // Resumed turn (after in-order approval): the write reached the provider path.
    {
      toolCall: {
        id: "read-after-write",
        name: "executeCode",
        arguments: {
          code: "export default async function(self, env) { console.log(await env.NEW_THING.readValue()); }",
        },
      },
    },
    { text: "The value is now 9." },
  ]);
  using publicApi = connect(harness.url);
  using authenticated = await signUpScriptedUser(publicApi, "createres");
  using workspace = await authenticated.newGadget();
  const chatId = await workspace.newChat("Create a new test thing and read it.", SCRIPTED_MODEL_ID);

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
  // The card in the chat history renders from the hydrated actionLog, not just the id.
  expect((await actionCard(workspace, chatId, pending.id)).actionLog)
      .toMatchObject({ state: "pending" });

  // Turn 2: the binding is re-established from the recorded tool output, and the write is
  // queued while the resource is still provisional. The turn suspends holding both actions.
  await workspace.sendChatMessage(chatId, "Now set its value to 9.", SCRIPTED_MODEL_ID);
  const queued = await waitFor("the creation and the write to be pending", async () => {
    const entries = (await workspace.listActions({ filter: "pending" })).entries;
    return entries.length === 2 ? entries : null;
  });
  const write = queued.find(action => action.description.title === "Set the test value to 9");
  if (write === undefined) throw new Error("No pending write action found");
  // Queue-time snapshot: the resource was still provisional when the write was queued.
  expect(write.resourceUrl).toContain("/things/provisional-");

  // Approving the dependent write before the creation is refused (the platform's in-order
  // guard) and the write stays pending.
  await expect(workspace.approveAction(write.id)).rejects.toThrow(/does not exist yet/);
  expect((await workspace.listActions({ filter: "pending" })).entries
      .some(action => action.id === write.id)).toBe(true);

  // In order: creation, then the write. The write approval resolving is the apply proof — the
  // platform awaits the vendor's applyAction before marking it approved, and the identical call
  // was just refused. The second approval resumes the suspended turn.
  await workspace.approveAction(pending.id);
  await workspace.approveAction(write.id);
  await waitForAgentSays(workspace, chatId, "The value is now 9.");

  // Both actions settled, and applyCreation's URL replaced the provisional one: the resumed
  // read's observation snapshots the created resource.
  const all = (await workspace.listActions({ filter: "all" })).entries;
  expect(all.find(action => action.id === pending.id)?.state).toBe("approved");
  expect(all.find(action => action.id === write.id)?.state).toBe("approved");
  expect(all.some(action =>
    action.type === "observation" && action.resourceUrl?.includes("/things/created-"))).toBe(true);

  // The facet restarted on the class applyCreation returned: describe() answers from the
  // created thing's props rather than the provisional ones.
  if (pending.gatekeeperId === undefined) throw new Error("Creation action has no gatekeeper");
  using created = await workspace.getGatekeeperById(pending.gatekeeperId);
  expect((await created.describe()).url).toContain("/things/created-");

  // actionLog hydrates at read time: the same card now carries the decision, and the creation
  // card's link was refreshed off the dead provisional URL.
  expect((await actionCard(workspace, chatId, pending.id)).actionLog).toMatchObject({
    state: "approved",
    resourceUrl: expect.stringContaining("/things/created-"),
  });

  // Vendor-side proof the write really landed. The fixture's creation touches no provider
  // state, so the write is the only apply.
  const account = (await listConnectedAccounts(authenticated))
      .find(entry => entry.vendorId === TEST_VENDOR_ID);
  if (!account) throw new Error("No connected test account");
  expect(await actionState(accountLabel(account)))
      .toMatchObject({ pending: [], value: 9, applyCount: 1 });

  // The decision reached the model as a durable nudge carrying the real URL — the recorded tool
  // result permanently says the resource doesn't exist yet, so without this the model's context
  // never learns it now does, or where.
  expect(userMessagesShownToModel().some(message =>
    /The user approved the creation of env\.NEW_THING\. The resource now exists at .*\/things\/created-/
        .test(message))).toBe(true);
  expect(model.remainingSteps()).toBe(0);
});

it("kills the binding and cascades to queued edits when the user rejects the creation",
    async () => {
  model = scriptedChatCompletions([
    // Turn 1: create a thing, queue an edit against it, then suspend on the edit's
    // awaitDecision. The user rejects the creation, which must cascade to the queued edit.
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
    {
      toolCall: {
        id: "write-doomed",
        name: "executeCode",
        arguments: {
          code: "export default async function(self, env) { console.log(await env.DOOMED.writeValue(5)); }",
        },
      },
    },
    // Turn 2 (after rejection): the binding is dead, with an explanation.
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
  ]);
  using publicApi = connect(harness.url);
  using authenticated = await signUpScriptedUser(publicApi, "createrej");
  using workspace = await authenticated.newGadget();
  const chatId = await workspace.newChat(
      "Create a doomed test thing and write to it.", SCRIPTED_MODEL_ID);

  // The write awaits a decision, so the turn suspends holding two pending actions: the
  // creation and an edit that depends on it.
  const pending = await waitFor("the creation and its edit to be pending", async () => {
    const entries = (await workspace.listActions({ filter: "pending" })).entries;
    return entries.length === 2 ? entries : null;
  });
  const creation = pending.find(action =>
    action.description.title.startsWith("Create test thing"));
  if (creation === undefined) throw new Error("No pending creation action found");
  await workspace.rejectAction(creation.id);

  // Rejecting the creation settled the dependent edit too — nothing left to decide one by one.
  const all = (await workspace.listActions({ filter: "all" })).entries;
  expect(all.filter(action => action.state === "pending")).toEqual([]);
  expect(all.filter(action => action.type === "action" && action.state === "rejected"))
      .toHaveLength(2);

  // The next turn's use of the binding fails with the platform's rejected-creation refusal
  // rather than silently simulating against nothing.
  await workspace.sendChatMessage(chatId, "Read the doomed thing.", SCRIPTED_MODEL_ID);
  await waitForAgentSays(workspace, chatId, "The doomed thing is gone.");
  expect(toolResultShownToModel("read-doomed")).toContain("DEAD:");
  expect(toolResultShownToModel("read-doomed")).toMatch(/rejected/);

  // The rejection nudge reached the model.
  expect(userMessagesShownToModel().some(message =>
    message.includes("The user rejected the creation of env.DOOMED"))).toBe(true);
  expect(model.remainingSteps()).toBe(0);
});

it("settles an undecided creation when its chat is deleted", async () => {
  model = scriptedChatCompletions([
    {
      toolCall: {
        id: "create-abandoned",
        name: "createExternalResource",
        arguments: {
          vendorId: TEST_VENDOR_ID,
          resourceUrlPattern: RESOURCE_URL_PATTERN,
          title: "Abandoned Thing",
          bindingName: "ABANDONED",
        },
      },
    },
    { text: "Created the abandoned thing." },
  ]);
  using publicApi = connect(harness.url);
  using authenticated = await signUpScriptedUser(publicApi, "createdel");
  using workspace = await authenticated.newGadget();
  const chatId = await workspace.newChat("Create a thing I will abandon.", SCRIPTED_MODEL_ID);
  await waitForAgentSays(workspace, chatId, "Created the abandoned thing.");
  const pending = await onlyPendingAction(workspace, "the creation action to be pending");
  if (pending.gatekeeperId === undefined) throw new Error("Creation action has no gatekeeper");

  await workspace.deleteChat(chatId);

  // The deleted log was the only thing that could ever bind the resource, so the card must not
  // stay approvable: approving it would mint a provider resource nothing can address.
  const all = (await workspace.listActions({ filter: "all" })).entries;
  expect(all.find(action => action.id === pending.id)?.state).toBe("rejected");
  await expect(workspace.getGatekeeperById(pending.gatekeeperId)).rejects.toThrow();
  expect(model.remainingSteps()).toBe(0);
});
