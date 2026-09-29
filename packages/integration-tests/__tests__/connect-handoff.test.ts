import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { AuthenticatedApi } from "@gadgets/workshop-shared/api";
import {
  startTestGatekeeperHarness, TEST_GATEKEEPER_WORKER, TEST_VENDOR_ID, type Harness,
} from "../src/harness.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import { connect, listConnectedAccounts, nextUsernames, signUp } from "../src/rpc-client.js";

const EXPIRED = "This connection attempt has expired. Please try again.";

const network = new NetworkInterceptor();
let harness: Harness;

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

/** Run a connect flow to its handoff page; the ticket is the one that page hands the popup. */
async function finishFlow(api: RpcStub<AuthenticatedApi>)
    : Promise<{ label: string; nonce: string; ticket: string }> {
  const { url, nonce } = await api.connectAccount(TEST_VENDOR_ID);
  const response = await harness.fetchWorker(TEST_GATEKEEPER_WORKER, url);
  expect(response.status).toBe(200);
  const literal = /var ticket = (".*?");\n/.exec(await response.text());
  if (literal === null) throw new Error("The handoff page carried no ticket");
  const ticket = JSON.parse(literal[1]!);
  return { label: new URL(url).pathname.slice("/connect/".length), nonce, ticket };
}

const testAccounts = async (api: RpcStub<AuthenticatedApi>) =>
  (await listConnectedAccounts(api)).filter(account => account.vendorId === TEST_VENDOR_ID);

async function revocations(label: string): Promise<number> {
  const response = await harness.fetchWorker(
      TEST_GATEKEEPER_WORKER, "http://gatekeeper-test.test/control/revocation-count",
      { method: "POST", body: JSON.stringify({ label }) });
  if (response.status !== 200) {
    throw new Error(`Reading the revocation count failed with ${response.status}: ${await response.text()}`);
  }
  return (await response.json() as { count: number }).count;
}

it.concurrent("a connect flow adds the account only when its own session redeems the ticket, once",
    async () => {
  using stack = new DisposableStack();
  const [aliceName, bobName] = nextUsernames("alice", "bob");
  const alice = stack.use(await signUp(stack.use(connect(harness.url)), aliceName!));
  const bob = stack.use(await signUp(stack.use(connect(harness.url)), bobName!));

  const { label, nonce, ticket } = await finishFlow(alice);
  expect(await testAccounts(alice)).toEqual([]);

  await expect(bob.completeConnectHandoff(ticket, nonce)).rejects.toThrow(EXPIRED);
  await expect(alice.completeConnectHandoff("not-a-ticket", "not-a-nonce")).rejects.toThrow(EXPIRED);
  await alice.completeConnectHandoff(ticket, nonce);
  expect(await testAccounts(alice)).toHaveLength(1);
  expect(await testAccounts(bob)).toEqual([]);

  await expect(alice.completeConnectHandoff(ticket, nonce)).rejects.toThrow(EXPIRED);
  expect(await testAccounts(alice)).toHaveLength(1);
  expect(await revocations(label)).toBe(0);
});

it.concurrent("a ticket with another flow's nonce, or a malformed one, is refused, spent and revoked",
    async () => {
  using stack = new DisposableStack();
  const carol = stack.use(await signUp(stack.use(connect(harness.url)), nextUsernames("carol")[0]!));
  const a = await finishFlow(carol);
  const b = await finishFlow(carol);
  const c = await finishFlow(carol);

  await expect(carol.completeConnectHandoff(a.ticket, b.nonce)).rejects.toThrow(EXPIRED);
  await expect(carol.completeConnectHandoff(a.ticket, a.nonce)).rejects.toThrow(EXPIRED);
  await expect(carol.completeConnectHandoff(b.ticket, b.nonce)).rejects.toThrow(EXPIRED);
  await expect(carol.completeConnectHandoff(c.ticket, "not-a-nonce")).rejects.toThrow(EXPIRED);
  await expect(carol.completeConnectHandoff(c.ticket, c.nonce)).rejects.toThrow(EXPIRED);
  expect(await testAccounts(carol)).toEqual([]);
  expect(await Promise.all([a, b, c].map(flow => revocations(flow.label)))).toEqual([1, 1, 1]);
});
