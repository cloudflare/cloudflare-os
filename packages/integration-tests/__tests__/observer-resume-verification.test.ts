// A collaborator's agent turn that resumes after a decision re-verifies its initiator before
// inference, through the same authorizer open() uses but non-interactively: the resume has no
// configuration channel, so a connection the initiator has chosen no account for denies them, and
// the turn ends with an error rather than reading the connection's data on their behalf.
//
// This lives in its own file -- with its own harness, like every suite here -- because accepting
// the connection widens collaborators' verification scope, which can restart the workspace.

import { afterAll, beforeAll, expect, it } from "vitest";
import type { RpcStub } from "capnweb";
import type { AuthenticatedApi } from "@gadgets/workshop-shared/api";
import { loadAllChatHistory } from "../src/agent-session.js";
import { startTestGatekeeperHarness, TEST_VENDOR_ID, type Harness } from "../src/harness.js";
import { SCRIPTED_MODEL_ID, scriptedModelRouter } from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  connect, listConnectedAccounts, nextUsernames, signUp, waitFor, waitForIdleChat,
  type ConnectedAccount,
} from "../src/rpc-client.js";

let harness: Harness;
const models = scriptedModelRouter();
const network = new NetworkInterceptor({ handlers: [models.handler] });

beforeAll(async () => {
  network.install();
  harness = await startTestGatekeeperHarness();
});

afterAll(async () => {
  try {
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
  }
});

async function provisionAccount(api: RpcStub<AuthenticatedApi>): Promise<ConnectedAccount> {
  await api.provisionAmbientAccount(TEST_VENDOR_ID);
  return waitFor("the test account to be provisioned", async () => {
    const accounts = await listConnectedAccounts(api);
    return accounts.find(a => a.vendorId === TEST_VENDOR_ID) ?? null;
  });
}

it("a collaborator's resumed turn ends with an error when a new connection needs their account",
    async () => {
  const THING_URL = "https://gadgets-test.example/things/resume-verification";
  const model = models.script([
    { toolCall: { id: "request", name: "requestConnection", arguments: {
      vendorId: TEST_VENDOR_ID, resourceUrl: THING_URL, reason: "Read the thing.",
      bindingName: "THING",
    } } },
    // Reached only if the resumed turn were admitted.
    { text: "Read it." },
  ]);
  const [alice, bob] = nextUsernames("resumeowner", "resumecollab");
  using publicApi = connect(harness.url);

  // Bob, a build collaborator, opens Alice's workspace and starts a turn without any prompt: the
  // workspace's only connection is the test vendor's ambient one, which verification covers with
  // his own provisioned account automatically.
  using aliceApi = await signUp(publicApi, alice);
  const aliceAccount = await provisionAccount(aliceApi);
  using ws = await aliceApi.newWorkspace();
  const { id: workspaceId } = await ws.getMetadata();
  using bobApi = await signUp(publicApi, bob);
  await provisionAccount(bobApi);
  await bobApi.addModel(model.userModel.profile, model.userModel.config);
  await bobApi.setQuickModel(null);
  if (!await ws.addCollaborator(bob, "workspace")) throw new Error(`Failed to share with ${bob}`);

  // Bob's agent asks for a connection, which pauses his turn on the owner's decision.
  const chatId = await (async () => {
    using bobWs = await bobApi.openWorkspace(workspaceId);
    const id = await bobWs.newChat("Read the thing.", SCRIPTED_MODEL_ID);
    await waitForIdleChat(bobWs, id);
    return id;
  })();
  expect(model.requests).toHaveLength(1);
  const history = () => loadAllChatHistory(before => ws.getChatHistory(chatId, before));
  const card = (await history()).find(message => message.type === "connectionRequest");
  if (card?.type !== "connectionRequest") throw new Error("The agent did not request a connection");
  expect(card.state).toBe("pending");

  // Alice grants it with a new, ordinary connection on her own account. Bob is in its verification
  // scope, but no account is chosen for him automatically on an ordinary connection, and the
  // resume cannot ask him to choose one.
  using gatekeeper = await ws.newGatekeeper(aliceAccount.id, THING_URL);
  if (!gatekeeper) throw new Error("Failed to create the connection");
  await ws.acceptConnectionRequest(card.requestId, { gatekeeperId: await gatekeeper.getId() });

  // Waits for either outcome, so a turn wrongly admitted fails here rather than timing out.
  const ended = await waitFor("the resumed turn to end", async () =>
    (await history()).find(message => message.sequence > card.sequence && (message.type === "error" ||
        (message.type === "message" && message.author.type === "agent"))) ?? null);
  expect(ended).toMatchObject({
    type: "error",
    message: expect.stringMatching(/could not be resumed.*choose connected accounts/s),
  });
  await waitForIdleChat(ws, chatId);
  expect(model.requests).toHaveLength(1);
  expect(model.remainingSteps()).toBe(1);
});
