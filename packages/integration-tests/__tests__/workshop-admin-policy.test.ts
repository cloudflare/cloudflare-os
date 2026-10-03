import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { AdminApi } from "@gadgets/workshop-shared/api";
import type { TestSession } from "../fixtures/gatekeeper-test/src/test-gatekeeper.js";
import { openAgentSession } from "../src/agent-session.js";
import {
  ADMIN_USERNAME, startTestGatekeeperHarness, TEST_VENDOR_ID, type Harness,
} from "../src/harness.js";
import { SCRIPTED_MODEL_ID, scriptedModelRouter, systemPromptOf } from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  connect, listConnectedAccounts, logIn, nextUsernames, signUp,
} from "../src/rpc-client.js";

// Admin config is deployment-wide, so this file owns its harness and runs serially.
let harness: Harness;
let admin: RpcStub<AdminApi>;
const fileScope = new DisposableStack();
const models = scriptedModelRouter();
const network = new NetworkInterceptor({ handlers: [models.handler] });

beforeAll(async () => {
  network.install();
  harness = await startTestGatekeeperHarness();
  const adminApi = fileScope.use(await signUp(fileScope.use(connect(harness.url)), ADMIN_USERNAME));
  const adminStub = fileScope.use(await adminApi.getAdminApi());
  if (adminStub === null) throw new Error("The deployment admin API was unavailable");
  admin = adminStub;
});

afterAll(async () => {
  try {
    fileScope.dispose();
    await harness?.server.close();
    expect(network.getUnmockedCalls()).toEqual([]);
  } finally {
    network.uninstall();
  }
});

it("enforces deployment gatekeeper policy through the admin API", async () => {
  const [ordinaryName, bobName, carolName, daveName] =
    nextUsernames("ordinary", "bob", "carol", "dave");

  using ordinaryPublic = connect(harness.url);
  using ordinary = await signUp(ordinaryPublic, ordinaryName!);
  expect(await ordinary.getAdminApi()).toBeNull();

  using bobPublic = connect(harness.url);
  using bob = await signUp(bobPublic, bobName!);
  await bob.provisionAmbientAccount(TEST_VENDOR_ID);
  const account = (await listConnectedAccounts(bob))
      .find(candidate => candidate.vendorId === TEST_VENDOR_ID);
  if (account === undefined) throw new Error("Bob's test account was not provisioned");
  using workspace = await bob.newGadget();
  using bound = await workspace.newGatekeeper(
      account.id, "https://gadgets-test.example/things/bound");
  if (bound === null) throw new Error("The existing test connection was not created");
  using session = await bound.openSession() as RpcStub<TestSession>;

  try {
    await admin.setGatekeeperMode(TEST_VENDOR_ID, "disabled");

    using carolPublic = connect(harness.url);
    using carol = await signUp(carolPublic, carolName!);
    expect((await carol.listAddableGatekeepers()).map(vendor => vendor.id))
        .not.toContain(TEST_VENDOR_ID);
    await expect(carol.provisionAmbientAccount(TEST_VENDOR_ID)).rejects.toThrow(
        'The "test" gatekeeper is disabled on this deployment.');
    await expect(workspace.newGatekeeper(
        account.id, "https://gadgets-test.example/things/crafted")).rejects.toThrow(
        'The "test" gatekeeper is disabled on this deployment by an administrator.');
    await expect(session.readValue()).resolves.toBe(42);

    await admin.setGatekeeperMode(TEST_VENDOR_ID, "enabled");

    using davePublic = connect(harness.url);
    using dave = await signUp(davePublic, daveName!);
    await dave.listGatekeeperApps();
    const forcedAccount = (await listConnectedAccounts(dave, {
      includeForcedAutoProvisionedAccounts: true,
    })).find(candidate => candidate.vendorId === TEST_VENDOR_ID);
    if (forcedAccount === undefined) throw new Error("Dave's forced test account was not provisioned");
    await expect(dave.disconnectAccount(forcedAccount.id)).rejects.toThrow(
        "This account is provided automatically and can't be disconnected.");

    await admin.setGatekeeperMode(TEST_VENDOR_ID, "optional");
    await admin.setResourceEnabled(
        TEST_VENDOR_ID, "https://gadgets-test.example/things/*", false);
    await expect(workspace.newGatekeeper(
        account.id, "https://gadgets-test.example/things/after")).rejects.toThrow(
        'The "Test Thing" resource is disabled on this deployment by an administrator.');
  } finally {
    try {
      await admin.setGatekeeperMode(TEST_VENDOR_ID, "optional");
    } finally {
      await admin.setResourceEnabled(
          TEST_VENDOR_ID, "https://gadgets-test.example/things/*", true);
    }
  }
});

it("deployment instructions and format hints reach the agent but not the user", async () => {
  const marker = `instructions-${crypto.randomUUID()}`;
  const hint = `hint-${crypto.randomUUID()}`;
  const { instanceInstructions, formats } = await admin.getSettings();
  const document = formats.find(format => format.output?.id === "document" && format.enabled);
  if (document === undefined) throw new Error("The bundled document format is not offered");

  const model = models.script([{ text: "Noted." }, { text: "Noted again." }]);
  await using session = await openAgentSession(harness.url, {
    modelId: SCRIPTED_MODEL_ID,
    userModel: model.userModel,
    usernamePrefix: "settings",
  });
  using userPublic = connect(harness.url);
  using user = await logIn(userPublic, session.username);

  try {
    await admin.setInstanceInstructions(`Mention ${marker} in every reply.`);
    await admin.updateFormat(document.blueprintId, { agentHint: `Prefer it for ${hint}.` });

    expect((await session.runTurn("Hello.")).outcome).toEqual({ status: "completed" });
    const configured = systemPromptOf(model.requests[0]);
    expect(configured).toContain(marker);
    expect(configured).toContain(hint);
    const offers = await user.listOutputFormats();
    expect(offers.map(offer => offer.blueprintId)).toContain(document.blueprintId);
    expect(JSON.stringify(offers)).not.toContain(hint);

    await admin.setInstanceInstructions("");
    await admin.updateFormat(document.blueprintId, { agentHint: "" });

    expect((await session.runTurn("Hello again.")).outcome).toEqual({ status: "completed" });
    const cleared = systemPromptOf(model.requests[1]);
    expect(cleared).not.toContain(marker);
    expect(cleared).not.toContain(hint);
  } finally {
    await admin.setInstanceInstructions(instanceInstructions);
    await admin.updateFormat(document.blueprintId, { agentHint: document.agentHint });
  }
  expect(model.remainingSteps()).toBe(0);
});
