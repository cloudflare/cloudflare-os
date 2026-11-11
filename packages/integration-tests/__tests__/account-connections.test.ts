// Overseer.listAccountConnections() names the account behind a connection to that account's
// owner, and to nobody else.

import { afterAll, beforeAll, expect, it } from "vitest";
import {
  startTestGatekeeperHarness, TEST_VENDOR_ID, type Harness,
} from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  connect, listConnectedAccounts, MAX_OBSERVER_PROMPTS, nextUsernames, ObserverConfigRecorder,
  signUp, stubFor, waitFor,
} from "../src/rpc-client.js";

let harness: Harness;
const network = new NetworkInterceptor();

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

const THING_URL = "https://gadgets-test.example/things/account-connections";

async function provisionAccount(api: Awaited<ReturnType<typeof signUp>>) {
  await api.provisionAmbientAccount(TEST_VENDOR_ID);
  return waitFor("the test account to be provisioned", async () =>
    (await listConnectedAccounts(api)).find(a => a.vendorId === TEST_VENDOR_ID) ?? null);
}

it("lists a connection with its account for the user who made it, and not for a collaborator",
    async () => {
  using publicApi = connect(harness.url);
  const [alice, bob] = nextUsernames("alice", "bob");
  using aliceApi = await signUp(publicApi, alice);
  const aliceAccount = await provisionAccount(aliceApi);
  using overseer = await aliceApi.newWorkspace();

  // An unbound connection, as a chat's pasted link makes: no gadget's listBindings() shows it.
  using gatekeeper = await overseer.newGatekeeper(aliceAccount.id, THING_URL);
  if (!gatekeeper) throw new Error("Failed to create the test connection");
  const target = await gatekeeper.getId();

  const listed = await overseer.listAccountConnections();
  expect(listed).toEqual([
    { target, resourceTitle: expect.any(String), accountId: aliceAccount.id },
  ]);

  using bobApi = await signUp(publicApi, bob);
  const bobAccount = await provisionAccount(bobApi);
  const { id: workspaceId } = await overseer.getMetadata();
  if (!await overseer.addCollaborator(bob, "workspace")) {
    throw new Error("Failed to share the workspace");
  }
  using callback =
      stubFor(new ObserverConfigRecorder().alwaysChoose(bobAccount.id, MAX_OBSERVER_PROMPTS));
  using bobOverseer = await bobApi.openWorkspace(workspaceId, undefined, callback);
  expect(await bobOverseer.listAccountConnections()).toEqual([]);
});
