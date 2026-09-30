import type { RpcStub } from "capnweb";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { AuthenticatedApi } from "@gadgets/workshop-shared/api";
import type { TestSession } from "../fixtures/gatekeeper-test/src/test-gatekeeper.js";
import {
  hookServer, startTestGatekeeperHarness, TEST_GATEKEEPER_WORKER, TEST_VENDOR_ID, testActionState,
  testControl, type Harness,
} from "../src/harness.js";
import { SCRIPTED_MODEL_ID, scriptedModelRouter } from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  accountLabel, connect, listConnectedAccounts, logIn, nextUsernames, signUp, waitFor,
  waitForIdleChat,
} from "../src/rpc-client.js";

const EXPIRED = "This connection attempt has expired. Please try again.";

const models = scriptedModelRouter();
const network = new NetworkInterceptor({ handlers: [models.handler] });
let harness: Harness;

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

/** Load a connect or reconnect flow's final page; the ticket is the one it hands the popup. */
async function handoffTicket(url: string): Promise<string> {
  const response = await harness.fetchWorker(TEST_GATEKEEPER_WORKER, url);
  expect(response.status).toBe(200);
  const literal = /var ticket = (".*?");\n/.exec(await response.text());
  if (literal === null) throw new Error("The handoff page carried no ticket");
  return JSON.parse(literal[1]!);
}

/** Run a connect flow to its handoff page. */
async function finishFlow(api: RpcStub<AuthenticatedApi>)
    : Promise<{ label: string; nonce: string; ticket: string }> {
  const { url, nonce } = await api.connectAccount(TEST_VENDOR_ID);
  const label = new URL(url).pathname.slice("/connect/".length);
  return { label, nonce, ticket: await handoffTicket(url) };
}

const testAccounts = async (api: RpcStub<AuthenticatedApi>) =>
  (await listConnectedAccounts(api)).filter(account => account.vendorId === TEST_VENDOR_ID);

/** A user-connected (so reconnectable) account, not an auto-provisioned one. */
async function connectConfirmed(api: RpcStub<AuthenticatedApi>) {
  const { label, nonce, ticket } = await finishFlow(api);
  await api.completeConnectHandoff(ticket, nonce);
  return await waitFor("the connected account", async () =>
    (await testAccounts(api)).find(account => accountLabel(account) === label) ?? null);
}

const credentialsValid = (api: RpcStub<AuthenticatedApi>, accountId: number, valid: boolean) =>
  waitFor(`the account's credentials to be ${valid ? "valid" : "expired"}`, async () =>
    (await testAccounts(api)).some(a => a.id === accountId && a.credentialsValid === valid) || null);

const control = <T>(route: string, body: object) => testControl<T>(harness, route, body);

const revocations = async (label: string) =>
  (await control<{ count: number }>("revocation-count", { label })).count;

const watchCode = (key: string) => `import { restore } from "cloudflare:workers";
export default async function(self, env) {
  await env.TEST_THING.watch(${JSON.stringify(key)}, await env.HOOKED[restore]({ type: "value-hook" }));
}`;

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

it.concurrent("reconnecting an expired account keeps its binding, enabled hook and pending action",
    async () => {
  using stack = new DisposableStack();
  const [username] = nextUsernames("reconnectowner");
  const api = stack.use(await signUp(stack.use(connect(harness.url)), username!));
  const key = `${username}:reconnected`;
  const model = models.script([
    { toolCall: { id: "server", name: "writeFile", arguments: {
      workpiece: "HOOKED", filename: "server.js", content: hookServer("TEST_THING"),
    } } },
    { text: "Built." },
    { toolCall: { id: "watch", name: "executeCode", arguments: { code: watchCode(key) } } },
    { text: "Watching." },
  ]);
  await api.addModel(model.userModel.profile, model.userModel.config);
  const account = await connectConfirmed(api);
  const label = accountLabel(account);

  const ws = stack.use(await api.newGadget());
  const connection = stack.use(
      await ws.newGatekeeper(account.id, "https://gadgets-test.example/things/reconnect"));
  if (!connection) throw new Error("Failed to create the test connection");
  const hooked = stack.use(await ws.createGadget("Hooked", undefined, "HOOKED"));
  // Bound before the chat opens: a permanent edge seeds a new chat's env under its name.
  await hooked.bind("TEST_THING", await connection.getId());
  const chatId = await ws.newChat("Build the hook.", SCRIPTED_MODEL_ID);
  await waitFor("the build turn", async () => model.requests.length === 2 || null);
  await waitForIdleChat(ws, chatId);
  expect((await ws.mergeChanges(chatId)).outcome).toBe("merged");
  await ws.sendChatMessage(chatId, "Watch the key.", SCRIPTED_MODEL_ID);
  await waitFor("the watch turn", async () => model.requests.length === 4 || null);
  await waitForIdleChat(ws, chatId);
  const hook = (await ws.listHooks()).find(h => h.description.title === `Test hook ${key}`);
  if (!hook) throw new Error(`No hook listed for ${key}`);
  await ws.enableHook(hook.id);

  const openSession = async () => {
    using binding = await hooked.getBinding("TEST_THING");
    if (!binding) throw new Error("HOOKED has no TEST_THING binding");
    return await binding.openSession() as RpcStub<TestSession>;
  };
  using session = await openSession();
  const fixtureId = await session.writeValue(701);
  const [held] = await waitFor("the pending pre-reconnect write", async () => {
    const { entries } = await ws.listActions({ filter: "pending" });
    return entries.length === 1 ? entries : null;
  });
  expect(await testActionState(harness, label))
    .toEqual({ pending: [{ id: fixtureId, value: 701 }], applyCount: 0 });

  await control("expire-credentials", { label });
  await credentialsValid(api, account.id, false);

  const { url, nonce } = await api.reconnectAccount(account.id);
  const ticket = await handoffTicket(url);
  // The handoff popup redeems over its own logged-in session (docs/connect-handoff.md).
  using popupPublic = connect(harness.url);
  using popup = await logIn(popupPublic, username!);
  await popup.completeConnectHandoff(ticket, nonce);

  await credentialsValid(api, account.id, true);
  expect(await testAccounts(api))
      .toEqual([expect.objectContaining({ id: account.id, credentialsValid: true })]);
  expect(await control("credential", { label })).toEqual({ credential: 2 });
  expect(await revocations(label)).toBe(1);

  using fresh = await openSession();
  expect(await fresh.readValue()).toBe(42);
  expect(await control("fire-hook", { key, value: 702 })).toEqual({ fired: true });
  const fired = await waitFor("the hook's write", async () =>
    (await ws.listActions({ filter: "pending" })).entries
        .find(entry => entry.description.title === "Set the test value to 702") ?? null);
  await ws.approveAction(held.id);
  await ws.approveAction(fired.id);
  expect(await testActionState(harness, label)).toEqual({ pending: [], value: 702, applyCount: 2 });
});

it.concurrent("another user cannot redeem a reconnect handoff", async () => {
  using stack = new DisposableStack();
  const [aliceName, bobName] = nextUsernames("alice", "bob");
  const alice = stack.use(await signUp(stack.use(connect(harness.url)), aliceName!));
  const bob = stack.use(await signUp(stack.use(connect(harness.url)), bobName!));
  const account = await connectConfirmed(alice);
  const label = accountLabel(account);
  await control("expire-credentials", { label });
  await credentialsValid(alice, account.id, false);

  const { url, nonce } = await alice.reconnectAccount(account.id);
  const ticket = await handoffTicket(url);
  await expect(bob.completeConnectHandoff(ticket, nonce)).rejects.toThrow(EXPIRED);

  expect(await testAccounts(alice))
      .toEqual([expect.objectContaining({ id: account.id, credentialsValid: false })]);
  expect(await control("credential", { label })).toEqual({ credential: 1 });
  expect(await revocations(label)).toBe(0);
});
