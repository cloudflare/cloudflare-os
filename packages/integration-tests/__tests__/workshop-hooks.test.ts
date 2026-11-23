import { afterAll, beforeAll, expect, it } from "vitest";
import type { RpcStub } from "capnweb";
import type { BoundHookInfo, Overseer } from "@gadgets/workshop-shared/api";
import type { HookTargetMetadata } from "@gadgets/workshop-shared/gatekeeper";
import {
  ADMIN_USERNAME, hookServer, startTestGatekeeperHarness, TEST_VENDOR_ID, testActionState,
  testControl, type Harness,
} from "../src/harness.js";
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

/** How a gadget binds its hook: fired by hand (`fire`), or kept in the kit's `HookRegistry` (`queue`). */
type Binding = "watch" | "subscribe";

const watchCode = (keys: string[], binding: Binding) => `import { restore } from "cloudflare:workers";
export default async function(self, env) {
  for (const key of ${JSON.stringify(keys)}) {
    await env.TEST_AMBIENT.${binding}(key, await env.HOOKED.rpc[restore]({ type: "value-hook" }));
  }
}`;

type HookState = { enabled: boolean; target?: HookTargetMetadata; disableCount: number };

const fire = (key: string, value: number) => testControl(harness, "fire-hook", { key, value });
const hookState = (key: string) => testControl<HookState>(harness, "hook-state", { key });
const queue = (name: string, id: string, value: number) =>
  testControl<{ hooks: number }>(harness, "queue-hook", { name, id, value });
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
async function armHooks(prefix: string, names: string[], binding: Binding = "watch"): Promise<ArmedHooks> {
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
      toolCall: { id: "watch", name: "executeCode", arguments: { code: watchCode(Object.values(keys), binding) } },
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

  const listed = await ws.listHooks();
  expect(listed.map(hook => hook.enabled)).toEqual(names.map(() => false));
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

  for (const hook of Object.values(hooks)) await ws.enableHook(hook.id);
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
  const { label, ws, keys: { admin: key }, hooks } = armed;
  await ws.enableHook(hooks.admin.id);

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

it("a hook kept in the kit's HookRegistry is delivered through its restored stub while enabled", async () => {
  using armed = await armHooks("hookqueue", ["queued"], "subscribe");
  const { label, ws, keys: { queued: name }, hooks } = armed;
  const delivered = async () => (await actionState(label)).pending.map(action => action.value);

  expect(await queue(name, "m0", 300)).toEqual({ hooks: 0 });

  await ws.enableHook(hooks.queued.id);
  expect(await queue(name, "m1", 301)).toEqual({ hooks: 1 });
  // The second delivery reads the stubs out of storage again, after the first disposed its own.
  expect(await queue(name, "m2", 302)).toEqual({ hooks: 1 });
  expect(await queue(name, "m2", 303)).toEqual({ hooks: 1 });
  expect(await delivered()).toEqual([301, 302]);
  const { entries: observations } = await ws.listActions({ filter: "observation" });
  expect(observations.map(({ description }) => description.title))
      .toEqual([`Hook ${name} requested 302`, `Hook ${name} requested 301`]);

  await ws.disableHook(hooks.queued.id);
  expect(await queue(name, "m3", 304)).toEqual({ hooks: 0 });

  await ws.enableHook(hooks.queued.id);
  expect(await queue(name, "m4", 305)).toEqual({ hooks: 1 });
  expect(await delivered()).toEqual([301, 302, 305]);
});
