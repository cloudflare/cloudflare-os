import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { TestSession } from "../fixtures/gatekeeper-test/src/test-gatekeeper.js";
import {
  ADMIN_USERNAME, startTestGatekeeperHarness, TEST_VENDOR_ID, type Harness,
} from "../src/harness.js";
import { scriptedModelRouter } from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  connect, listConnectedAccounts, nextUsernames, signUp,
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

it("enforces deployment gatekeeper policy through the admin API", async () => {
  const [ordinaryName, bobName, carolName, daveName] =
    nextUsernames("ordinary", "bob", "carol", "dave");

  using ordinaryPublic = connect(harness.url);
  using ordinary = await signUp(ordinaryPublic, ordinaryName!);
  expect(await ordinary.getAdminApi()).toBeNull();

  using adminPublic = connect(harness.url);
  using adminApi = await signUp(adminPublic, ADMIN_USERNAME);
  using admin = await adminApi.getAdminApi();
  if (admin === null) throw new Error("The deployment admin API was unavailable");

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
