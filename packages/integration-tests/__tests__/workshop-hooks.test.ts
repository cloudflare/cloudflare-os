import { afterAll, beforeAll, expect, it } from "vitest";
import type { RpcStub } from "capnweb";
import type { BoundHookInfo, Overseer } from "@gadgets/workshop-shared/api";
import type { HookTargetMetadata } from "@gadgets/workshop-shared/gatekeeper";
import {
  ADMIN_USERNAME, hookServer, startTestGatekeeperHarness, TEST_VENDOR_ID, testActionState,
  testControl, type Harness,
} from "../src/harness.js";
import { loadAllChatHistory } from "../src/agent-session.js";
import { SCRIPTED_MODEL_ID, scriptedModelRouter } from "../src/mock-model.js";
import { NetworkInterceptor } from "../src/network-interceptor.js";
import {
  accountLabel, connect, listConnectedAccounts, logIn, nextUsernames, restartWorkspace, signUp,
  streamGeneration, waitFor, waitForIdleChat,
} from "../src/rpc-client.js";

// Serial: the admin test flips deployment-wide gatekeeper policy.
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

const watchCode = (keys: string[]) => `import { restore } from "cloudflare:workers";
export default async function(self, env) {
  for (const key of ${JSON.stringify(keys)}) {
    await env.TEST_AMBIENT.watch(key, await env.HOOKED.rpc[restore]({ type: "value-hook" }));
  }
}`;

type HookState = { enabled: boolean; target?: HookTargetMetadata; disableCount: number };

const fire = (key: string, value: number) => testControl(harness, "fire-hook", { key, value });
const hookState = (key: string) => testControl<HookState>(harness, "hook-state", { key });
const actionState = (label: string) => testActionState(harness, label);

type ArmedHooks = Disposable & {
  username: string;
  label: string;
  workspaceId: string;
  ws: RpcStub<Overseer>;
  keys: Record<string, string>;
  hooks: Record<string, BoundHookInfo>;
};

/** A workspace whose HOOKED gadget watched `${username}:${name}` for each name, all public calls. */
async function armHooks(prefix: string, names: string[]): Promise<ArmedHooks> {
  const [username] = nextUsernames(prefix);
  const keys = Object.fromEntries(names.map(name => [name, `${username}:${name}`]));
  const model = models.script([
    {
      toolCalls: [
        { id: "create", name: "createGadget", arguments: { title: "Hooked", bindingName: "HOOKED" } },
        {
          id: "write",
          name: "writeFile",
          arguments: { workpiece: "HOOKED", filename: "server.js", content: hookServer("TEST_AMBIENT") },
        },
        {
          id: "bind",
          name: "setGadgetBinding",
          arguments: { gadget: "HOOKED", source: "TEST_AMBIENT", name: "TEST_AMBIENT" },
        },
      ],
    },
    { text: "Built." },
    {
      toolCall: { id: "watch", name: "executeCode", arguments: { code: watchCode(Object.values(keys)) } },
    },
    { text: "Watching." },
  ]);

  using stack = new DisposableStack();
  const publicApi = stack.use(connect(harness.url));
  const api = stack.use(await signUp(publicApi, username));
  await api.addModel(model.userModel.profile, model.userModel.config);
  await api.provisionAmbientAccount(TEST_VENDOR_ID);
  const account = await waitFor("the ambient account", async () =>
    (await listConnectedAccounts(api)).find(a => a.vendorId === TEST_VENDOR_ID) ?? null);
  const ws = stack.use(await api.newWorkspace());
  const { id: workspaceId } = await ws.getMetadata();

  const chatId = await ws.newChat("Build a hooked gadget.", SCRIPTED_MODEL_ID);
  await waitFor("the build turn", async () => model.requests.length === 2 || null);
  await waitForIdleChat(ws, chatId);
  expect((await ws.mergeChanges(chatId)).outcome).toBe("merged");
  await ws.sendChatMessage(chatId, "Watch the keys.", SCRIPTED_MODEL_ID);
  await waitFor("the watch turn", async () => model.requests.length === 4 || null);
  await waitForIdleChat(ws, chatId);
  expect(model.remainingSteps()).toBe(0);

  // Bound in a turn the user started, each hook turns on by itself.
  const listed = await waitFor("the hooks to turn on", async () => {
    const hooks = await ws.listHooks();
    return hooks.length === names.length && hooks.every(hook => hook.enabled) ? hooks : null;
  });
  const hooks = Object.fromEntries(names.map(name => {
    const hook = listed.find(h => h.description.title === `Test hook ${keys[name]}`);
    if (!hook) throw new Error(`No hook listed for ${keys[name]}`);
    return [name, hook];
  }));

  const resources = stack.move();
  return {
    username,
    label: accountLabel(account),
    workspaceId,
    ws,
    keys,
    hooks,
    [Symbol.dispose]: () => resources.dispose(),
  };
}

const DEAD_HOOK = { error: expect.stringContaining("Hook has been deleted or disabled.") };

it("an enabled hook fires into a restarted workspace; disabled and deleted hooks refuse", async () => {
  using armed = await armHooks("hookowner", ["live", "paused", "removed"]);
  const { username, label, workspaceId, ws, keys, hooks } = armed;

  expect(await hookState(keys.live)).toEqual({
    enabled: true,
    target: { workspaceId, gadgetId: hooks.live.gadgetId },
    disableCount: 0,
  });

  await ws.disableHook(hooks.paused.id);
  await ws.deleteHook(hooks.removed.id);
  expect((await hookState(keys.paused)).disableCount).toBe(1);
  expect((await hookState(keys.removed)).disableCount).toBe(1);

  let restarted = false;
  ws.onRpcBroken(() => { restarted = true; });
  const generation = await streamGeneration(ws);
  await restartWorkspace(harness.url, ws);
  await waitFor("the workspace restart", async () => restarted || null);

  using publicApi = connect(harness.url);
  using api = await logIn(publicApi, username);
  using reopened = await api.openWorkspace(workspaceId);
  expect(await streamGeneration(reopened)).not.toBe(generation);

  expect(await fire(keys.live, 101)).toEqual({ fired: true });
  expect(await fire(keys.paused, 102)).toEqual(DEAD_HOOK);
  expect(await fire(keys.removed, 103)).toEqual(DEAD_HOOK);
  expect((await actionState(label)).pending.map(action => action.value)).toEqual([101]);
  const { entries: observations } = await reopened.listActions({ filter: "observation" });
  expect(observations.map(({ description }) => description.title))
      .toEqual([`Hook ${keys.live} requested 101`]);

  const { entries } = await reopened.listActions({ filter: "pending" });
  expect(entries).toEqual([
    expect.objectContaining({
      type: "action", description: expect.objectContaining({ title: "Set the test value to 101" }),
    }),
  ]);
  await reopened.approveAction(entries[0].id);
  expect(await actionState(label)).toEqual({ pending: [], value: 101, applyCount: 1 });
});

it("an administratively disabled gatekeeper's hook refuses to fire", async () => {
  using armed = await armHooks("hookadmin", ["admin"]);
  const { label, keys: { admin: key } } = armed;

  using publicApi = connect(harness.url);
  using adminApi = await signUp(publicApi, ADMIN_USERNAME);
  using admin = await adminApi.getAdminApi();
  if (!admin) throw new Error("The admin user has no AdminApi");
  try {
    await admin.setGatekeeperMode(TEST_VENDOR_ID, "disabled");
    expect(await fire(key, 201)).toEqual({ error: expect.stringContaining("Gatekeeper is disabled.") });
    expect((await actionState(label)).pending).toEqual([]);
  } finally {
    await admin.setGatekeeperMode(TEST_VENDOR_ID, "optional");
  }

  expect(await fire(key, 202)).toEqual({ fired: true });
  expect((await actionState(label)).pending.map(action => action.value)).toEqual([202]);
});

it("a hook a chat binds to itself wakes that chat; one bound by such a run waits to be turned on", async () => {
  const [username] = nextUsernames("hookself");
  const [first, second] = [`${username}:first`, `${username}:second`];
  const watchSelf = (key: string) =>
    `export default async function(self, env) { await env.TEST_AMBIENT.watch(${JSON.stringify(key)}, self); }`;
  const model = models.script([
    { toolCall: { id: "watch", name: "executeCode", arguments: { code: watchSelf(first) } } },
    { text: "Watching." },
    // The firing's own turn binds another hook, with no user there to have asked for it.
    { toolCall: { id: "again", name: "executeCode", arguments: { code: watchSelf(second) } } },
    { text: "Saw it." },
    { text: "It is paused." },
  ]);

  using publicApi = connect(harness.url);
  using api = await signUp(publicApi, username);
  await api.addModel(model.userModel.profile, model.userModel.config);
  await api.provisionAmbientAccount(TEST_VENDOR_ID);
  await waitFor("the ambient account", async () =>
    (await listConnectedAccounts(api)).find(a => a.vendorId === TEST_VENDOR_ID) ?? null);
  using ws = await api.newWorkspace();

  const chatId = await ws.newChat("Tell me whenever a value is requested.", SCRIPTED_MODEL_ID);
  await waitFor("the watch turn", async () => model.requests.length === 2 || null);
  await waitForIdleChat(ws, chatId);
  const hook = await waitFor("the hook to turn on", async () =>
    (await ws.listHooks()).find(h => h.description.title === `Test hook ${first}` && h.enabled) ?? null);
  expect(hook.chatId).toBe(chatId);

  expect(await fire(first, 7)).toEqual({ fired: true });
  await waitFor("the firing's turn", async () => model.requests.length === 4 || null);
  await waitForIdleChat(ws, chatId);
  const history = await loadAllChatHistory(beforeSequence => ws.getChatHistory(chatId, beforeSequence));
  expect(history.filter(message => message.type === "agentCallback"))
      .toMatchObject([{ methodName: "onValueRequested", argsSummary: expect.stringContaining("7") }]);

  const later = (await ws.listHooks()).find(h => h.description.title === `Test hook ${second}`);
  expect(later).toMatchObject({ chatId, enabled: false });

  // The agent learns what the user has since done with them.
  await ws.disableHook(hook.id);
  await ws.sendChatMessage(chatId, "Is it still running?", SCRIPTED_MODEL_ID);
  await waitFor("the question's turn", async () => model.requests.length === 5 || null);
  expect(JSON.stringify(model.requests[4])).toContain(
    `\\"Test hook ${first}\\" is paused by the user`);
});
