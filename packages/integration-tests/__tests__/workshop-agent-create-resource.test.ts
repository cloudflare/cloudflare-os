import { afterAll, beforeAll, expect, it } from "vitest";
import { openAgentSession, type WorkshopAgentSession } from "../src/agent-session.js";
import {
  startTestGatekeeperHarness, TEST_VENDOR_ID, testActionState, type Harness,
} from "../src/harness.js";
import {
  SCRIPTED_MODEL_ID, scriptedModelRouter, type ChatCompletionStep,
} from "../src/mock-model.js";
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

const CREATE_NOTES: ChatCompletionStep = {
  toolCall: {
    id: "create-notes",
    name: "createExternalResource",
    arguments: {
      vendorId: TEST_VENDOR_ID,
      resourceUrlPattern: "https://gadgets-test.example/things/*",
      title: "Notes",
      bindingName: "NOTES",
    },
  },
};

const runCode = (id: string, logged: string): ChatCompletionStep => ({
  toolCall: {
    id,
    name: "executeCode",
    arguments: { code: `export default async function(self, env) { console.log(${logged}); }` },
  },
});

/** The creation and the write queued behind it, oldest first. */
async function creationAndWrite(session: WorkshopAgentSession) {
  const [creation, write] = await waitFor("the creation and the write to be pending", async () => {
    const { entries } = await session.listActions({ filter: "pending" });
    return entries.length === 2 ? entries.toSorted((a, b) => a.id - b.id) : null;
  });
  expect(creation).toMatchObject(
      { creation: true, description: { title: 'Create the test thing "Notes"' } });
  expect(write).toMatchObject({ gatekeeperId: creation!.gatekeeperId });
  return { creation: creation!, write: write! };
}

async function actionStates(session: WorkshopAgentSession, ids: number[]) {
  const { entries } = await session.listActions({ filter: "action" });
  return ids.map(id => entries.find(entry => entry.id === id));
}

it.concurrent("a created resource is made in the approver's account, and edits apply through it",
    async () => {
  const model = models.script([
    CREATE_NOTES,
    runCode("use-notes", "await env.NOTES.readValue(), await env.NOTES.writeValue(9)"),
    // The resumed turn replays the creation to re-bind NOTES, now to the created thing.
    runCode("read-created", "await env.NOTES.readValue()"),
    { text: "The notes are set." },
  ]);
  // The initiator, who owns the workspace, has no account for the vendor: creating needs none.
  await using session = await openAgentSession(harness.url, {
    modelId: SCRIPTED_MODEL_ID, userModel: model.userModel, usernamePrefix: "createres",
  });

  // Nothing waits on the creation: NOTES is usable at once, and only the write suspends the turn.
  expect((await session.runTurn("Create a notes thing and set it to 9.")).outcome)
      .toEqual({ status: "completed" });
  const { creation, write } = await creationAndWrite(session);

  // A collaborator with no account for the vendor opens the workspace: the pending creation
  // simulates its resource, so there is nothing to verify them against yet.
  const [approver] = nextUsernames("createapprover");
  using publicApi = connect(harness.url);
  using api = await signUp(publicApi, approver);
  const workspaceId = await withOwnerWorkspace(harness.url, session.username, async ws => {
    await ws.addCollaborator(approver, "build");
    return (await ws.getMetadata()).id;
  });
  using ws = await api.openGadget(workspaceId);
  await expect(ws.approveAction(write.id)).rejects.toThrow("Approve its creation first.");
  await expect(ws.approveAction(creation.id)).rejects.toThrow("Choose one of your accounts");

  // They approve the creation, into an account of their own.
  await api.provisionAmbientAccount(TEST_VENDOR_ID);
  const account = (await listConnectedAccounts(api)).find(a => a.vendorId === TEST_VENDOR_ID)!;
  await ws.approveAction(creation.id, account.id);
  // Collaborators are now verified against a real resource, so approving restarts the workspace.
  await waitFor("the restart to drop the session", async () => session.connectionDrops > 0 || null);
  expect((await session.approveActionsAndWait([write.id])).outcome)
      .toEqual({ status: "completed" });

  // The simulated class refuses to apply, so the write went through the created one, which
  // lives in the approver's account.
  expect(await testActionState(harness, accountLabel(account)))
      .toEqual({ pending: [], value: 9, applyCount: 1 });
  expect(await actionStates(session, [creation.id, write.id])).toMatchObject([
    { state: "approved", resourceUrl: "https://gadgets-test.example/things/Notes" },
    { state: "approved" },
  ]);
  expect(model.requests.at(-1)).toMatchObject({ messages: expect.arrayContaining([
    expect.objectContaining(
        { role: "tool", tool_call_id: "read-created", content: expect.stringContaining("42") }),
  ]) });
  expect(model.remainingSteps()).toBe(0);
});

it.concurrent("rejecting a creation rejects the edits queued on it and removes the connection",
    async () => {
  const model = models.script([
    CREATE_NOTES,
    runCode("write-notes", "await env.NOTES.writeValue(5)"),
    { text: "This must not run." },
  ]);
  await using session = await openAgentSession(harness.url, {
    modelId: SCRIPTED_MODEL_ID, userModel: model.userModel, usernamePrefix: "createrej",
  });

  await session.runTurn("Create a notes thing and set it to 5.");
  const { creation, write } = await creationAndWrite(session);

  await withOwnerWorkspace(harness.url, session.username, async ws => {
    await ws.rejectAction(creation.id);
    await expect(ws.getGatekeeperById(creation.gatekeeperId!)).rejects.toThrow("No such gatekeeper");
  });
  expect(await actionStates(session, [creation.id, write.id])).toMatchObject([
    { state: "rejected" },
    { state: "rejected" },
  ]);
  expect(model.remainingSteps()).toBe(1);
});
